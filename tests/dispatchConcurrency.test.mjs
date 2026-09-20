import assert from "node:assert/strict";
import test from "node:test";

import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  acceptDispatch,
  sweepExpiredDispatches,
} from "../lib/data/companionDispatchTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { updateAdminPlatformConfig } from "../lib/services/adminPlatformConfig.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";

/**
 * P0-5 的**并发**用例：同一张单一瞬间被多方抢。
 *
 * ## 为什么单独一个文件
 *
 * 这里测的不是「业务规则对不对」，而是「规则在**同一个瞬间**被多方触发时还成不成立」。
 * 它与 `dispatch.test.mjs` 的区别是断言的对象：那边看的是状态迁移，这边看的是
 * **不变量**——无论谁先谁后、无论触发多少次，下面两条永远成立：
 *
 * 1. 同一张单最终只有**一个**实际打手：`Order.actualCompanionId`
 *    与 `Dispatch.acceptedByCompanionId` 永远是同一个人，且只被写过一次；
 * 2. 到点之后的任何抢单都失败，**哪怕清扫还没跑**——业务事实由 deadline 决定，
 *    不由「有没有运行 sweep」决定。
 *
 * ## 原子性是怎么被验证的
 *
 * 伪事务（`lib/data/companionDispatchTransaction.ts`）里**没有一个 `await`**：
 * Node 单线程，只要不让出执行权，别的请求就插不进「读—判断—写」之间。
 * 因此这里用 `Promise.all` 把多个接单请求同时发出去，断言其中一个成功、其余全部失败，
 * 并且**落库结果与赢家一致**。
 *
 * ⚠️ 这条测试**证明不了**「将来换成真实数据库也原子」——那时要靠事务与唯一索引。
 * 它证明的是：这段代码现在没有把原子性交给运气（区段里没有 `await`）。
 * 区段里被人加一个 `await` 就会红，这正是它存在的意义。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const COMPANIONS = ["cp-1", "cp-2", "cp-3", "cp-4"];

let userSeq = 0;
function uniqueUser() {
  userSeq += 1;
  return `u-p05c-${process.pid}-${userSeq}`;
}

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `p05c-key-${process.pid}-${keySeq}`;
}

let adminSeq = 0;
function uniqueAdmin() {
  adminSeq += 1;
  return `adm-p05c-${process.pid}-${adminSeq}`;
}

async function placeOrder(user, companionId = null) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId,
      idempotencyKey: uniqueKey(),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok && confirmed.orderCreated, true);
  return confirmed.order;
}

async function setPublicTimeoutMinutes(minutes) {
  const result = await updateAdminPlatformConfig(uniqueAdmin(), {
    publicPoolTimeoutMinutes: minutes,
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true);
}

async function orderOf(id) {
  const order = await getPaymentRepository().findOrderById(id);
  assert.ok(order);
  return order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record);
  return record;
}

/**
 * 断言「订单与派单说的是同一个人」这条不变量。
 *
 * 这是 P0-5 唯一一条**绝不能破**的一致性要求：破了之后，管理端会显示
 * 「实际接单：A」而打手端看到的是 B 在负责，而两条记录谁也没错——错的是它们不是同一次写入。
 */
async function assertSingleAcceptInvariant(orderId) {
  const order = await orderOf(orderId);
  const dispatch = await dispatchOf(orderId);

  assert.equal(
    order.actualCompanionId,
    dispatch.acceptedByCompanionId,
    "Order.actualCompanionId 必须与 Dispatch.acceptedByCompanionId 是同一个人",
  );
  assert.equal(order.status, "accepted");
  assert.equal(dispatch.state, "accepted");
  assert.equal(order.acceptedAt, dispatch.acceptedAt, "两次写入共用同一个时间戳");
  assert.ok(order.actualCompanionId, "成功接单之后实际打手不能为空");
}

test("并发接单：四名打手同时抢同一张公共池订单，只有一个成功", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const results = await Promise.all(
    COMPANIONS.map((companionId) => acceptDispatch(dispatch.id, { companionId, at })),
  );

  const winners = results.filter((item) => item.kind === "ok");
  assert.equal(winners.length, 1, "同一张单只能有一个人接走");
  assert.equal(
    results.filter((item) => item.kind === "not-open").length,
    COMPANIONS.length - 1,
    "其余的人拿到的必须是明确的「已被接走」",
  );

  const winner = winners[0].dispatch.acceptedByCompanionId;
  await assertSingleAcceptInvariant(order.id);
  assert.equal((await orderOf(order.id)).actualCompanionId, winner);

  // 赢家只收到一次通知（收件人是下单用户），且只有一条
  const notifications = await getNotificationRepository().listNotifications(user);
  assert.equal(notifications.filter((item) => item.title === "订单已被接单").length, 1);
});

test("并发接单：同一个人同时点两次（重放）只算接过一次", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const [first, second] = await Promise.all([
    acceptDispatch(dispatch.id, { companionId: COMPANIONS[0], at }),
    acceptDispatch(dispatch.id, { companionId: COMPANIONS[0], at }),
  ]);

  assert.equal(first.kind, "ok");
  assert.equal(second.kind, "ok");
  // 一个是真的接单，另一个是同一次意图的重放——两种结果对使用者是同一件事。
  // 先执行的那一次必定是真的（伪事务里没有 `await`，调用即执行完），后到的才是重放
  assert.equal(first.replayed, false, "先到的那一次是真的接单");
  assert.equal(second.replayed, true, "后到的那一次是重放，不重写任何字段");

  await assertSingleAcceptInvariant(order.id);
  const notifications = await getNotificationRepository().listNotifications(user);
  assert.equal(
    notifications.filter((item) => item.title === "订单已被接单").length,
    1,
    "重放不得重复通知",
  );
});

test("并发：接单与专属池超时同时发生——到点那一刻两个人都接不到", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(10);

  const user = uniqueUser();
  const order = await placeOrder(user, COMPANIONS[0]);
  const dispatch = await dispatchOf(order.id);
  const deadline = dispatch.exclusiveDeadlineAt;

  // 两个请求在**同一刻**到达：一个是原指定人 A，一个是路人 B。
  // 此时清扫还没跑，数据库里这一单仍然写着 `exclusive`——但事实已经成立了
  const [byA, byB] = await Promise.all([
    acceptDispatch(dispatch.id, { companionId: COMPANIONS[0], at: deadline }),
    acceptDispatch(dispatch.id, { companionId: COMPANIONS[1], at: deadline }),
  ]);

  assert.equal(byA.kind, "expired", "到点就是到点，与「清扫跑没跑」无关");
  assert.equal(
    byB.kind,
    "expired",
    "时限先于资格判定：B 连「这不是指定给你的」都轮不到，先被告知已经超时",
  );

  // 两次拒绝都不得留下写入痕迹
  const untouched = await dispatchOf(order.id);
  assert.equal(untouched.state, "exclusive");
  assert.equal(untouched.acceptedByCompanionId, null);
  assert.equal((await orderOf(order.id)).status, "paid");

  // 清扫把事实物化之后，公共池重新开始计时，谁先来谁接
  const moved = sweepExpiredDispatches(deadline);
  assert.ok(moved.movedToPublicDispatchIds.includes(dispatch.id));

  const byBAfterMove = await acceptDispatch(dispatch.id, {
    companionId: COMPANIONS[1],
    at: plusMinutes(deadline, 1),
  });
  assert.equal(byBAfterMove.kind, "ok");
  await assertSingleAcceptInvariant(order.id);
  assert.equal((await orderOf(order.id)).actualCompanionId, COMPANIONS[1]);
  assert.equal(
    (await dispatchOf(order.id)).exclusiveCompanionId,
    COMPANIONS[0],
    "指定事实不因接单人变化",
  );
});

test("并发：接单与公共池超时同时发生——两种到达顺序最终状态必须一样", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(2);

  // 顺序一：清扫先跑，接单后到
  const orderFirst = await placeOrder(uniqueUser());
  const dispatchFirst = await dispatchOf(orderFirst.id);
  const atFirst = plusMinutes(dispatchFirst.publicDeadlineAt, 1);

  const [, late] = await Promise.all([
    Promise.resolve(sweepExpiredDispatches(atFirst)),
    acceptDispatch(dispatchFirst.id, { companionId: COMPANIONS[0], at: atFirst }),
  ]);
  assert.equal(late.kind, "not-open", "清扫先跑：这一单已经关闭");
  assert.equal(late.state, "timed_out");

  // 顺序二：接单先到（正好到点），清扫后跑
  const orderSecond = await placeOrder(uniqueUser());
  const dispatchSecond = await dispatchOf(orderSecond.id);
  const atSecond = dispatchSecond.publicDeadlineAt;

  const early = await acceptDispatch(dispatchSecond.id, {
    companionId: COMPANIONS[0],
    at: atSecond,
  });
  assert.equal(early.kind, "expired", "接单先跑：到点就拒，不等清扫");
  sweepExpiredDispatches(plusMinutes(atSecond, 1));

  // 两种顺序的最终状态必须完全一样：钱退回去了、没有人接走、关闭时刻都是到点那一刻
  for (const [order, dispatch] of [
    [orderFirst, dispatchFirst],
    [orderSecond, dispatchSecond],
  ]) {
    const finalOrder = await orderOf(order.id);
    const finalDispatch = await dispatchOf(order.id);
    assert.equal(finalOrder.status, "refunded");
    assert.equal(finalOrder.actualCompanionId, null, "退款的单没有实际打手");
    assert.equal(finalOrder.refundedAmount, finalOrder.actualPaidAmount, "全额退款");
    assert.equal(finalOrder.refundedAt, dispatch.publicDeadlineAt, "退款时刻取到点那一刻");
    assert.equal(finalDispatch.state, "timed_out");
    assert.equal(finalDispatch.acceptedByCompanionId, null);
    assert.equal(finalDispatch.timedOutAt, dispatch.publicDeadlineAt);
  }
});

test("并发：连续清扫与接单交错，清扫不会把已被接走的单退掉", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const deadline = dispatch.publicDeadlineAt;

  // 先在 deadline 之前接走
  const accepted = await acceptDispatch(dispatch.id, {
    companionId: COMPANIONS[0],
    at: plusMinutes(order.paidAt, 1),
  });
  assert.equal(accepted.kind, "ok");

  // 之后再反复清扫：已接单的记录不是「当前池」，一次都不该被它扫到
  for (let round = 0; round < 10; round += 1) {
    const swept = sweepExpiredDispatches(plusMinutes(deadline, round + 1));
    assert.equal(
      swept.refundedOrderIds.includes(order.id),
      false,
      `第 ${round + 1} 次清扫不该退这一单`,
    );
    assert.equal(
      swept.movedToPublicDispatchIds.includes(dispatch.id),
      false,
      "已接单的记录不该被转池",
    );
  }

  const finalOrder = await orderOf(order.id);
  assert.equal(finalOrder.status, "accepted", "接单成功后不因超时而退款");
  assert.equal(finalOrder.refundedAmount, 0);
  await assertSingleAcceptInvariant(order.id);
});
