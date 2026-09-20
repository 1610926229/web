import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXCLUSIVE_WAIT_MINUTES, plusMinutes } from "../lib/constants/dispatch.ts";
import { PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES } from "../lib/constants/platformConfig.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import {
  acceptDispatch,
  sweepExpiredDispatches,
  toDispatchProgress,
} from "../lib/data/companionDispatchTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { updateAdminPlatformConfig } from "../lib/services/adminPlatformConfig.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  acceptDispatchForCompanion,
  listCompanionPools,
} from "../lib/services/companionDispatch.ts";
import { getOrderDetailForUser, queryOrdersForUser } from "../lib/services/orders.ts";
import { hasAppFile, resolveSource } from "./app-path.mjs";

/**
 * P0-5「订单生命周期：专属池 / 公共池 / 接单 / 超时退款」的持续测试。
 *
 * ## 这一批真正要钉住的是什么
 *
 * 不是「页面上有没有这张卡片」，而是四条**一旦破掉就无法事后补救**的事实：
 *
 * 1. **用户指定的人** 与 **实际接单的人** 是两个永不互相覆盖的事实
 *    （`exclusiveCompanionId` / `acceptedByCompanionId`）；
 * 2. **业务事实由 deadline 决定，不由「有没有跑过清扫」决定**。
 *    数据库里的 `state` 还是 `public` 只是因为清扫还没跑到，那不代表还能抢；
 * 3. **接单是原子的**：派单说被 A 接了、订单说实际打手是 A，两者必须永远一致，
 *    且同一张单最终只能有一个人接走；
 * 4. **超时退款不需要任何人点头**：公共池到点自动全额退款，而且重复清扫不重复退
 *    （退回的钱、退款时间、发给用户的通知，跑 20 次与跑 1 次完全相同）。
 *
 * ## 时间怎么控制
 *
 * 一次都不等真实时间。订单的 `paidAt` 来自真实的 `new Date()`，因此截止时间由它
 * 推算；判定用的 `at` 一律由测试显式传入（`plusMinutes(order.paidAt, n)`）。
 * 清扫本身就是「把已经到点的事实写成记录」，所以「跑到未来一刻」是一次普通函数调用，
 * 而不是 `setTimeout`。
 *
 * ## 用例之间怎么隔离
 *
 * 进程内的 Mock 仓储在同一份文件里是共享的（node 给每个测试文件起一个子进程），
 * 而预置数据里本来就有在池中的订单。因此：**每个用例用自己的 `uniqueUser()`**，
 * 断言一律落在「我这一单」上，不去断言全局列表的长度。
 * 平台参数是单例，所以每个关心超时时长的用例都会先把它显式恢复/设成自己需要的值。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的两位，`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

let userSeq = 0;
/** 每个用例一个全新用户 id：订单、通知都按用户隔离，用例之间不会互相看见。 */
function uniqueUser() {
  userSeq += 1;
  return `u-p05-${process.pid}-${userSeq}`;
}

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `p05-key-${process.pid}-${keySeq}`;
}

let adminSeq = 0;
function uniqueAdmin() {
  adminSeq += 1;
  return `adm-p05-${process.pid}-${adminSeq}`;
}

/** 结算选择。默认不指定护航（直接进公共池）。 */
function selection(overrides = {}) {
  return {
    ...PRODUCT,
    specId: "s-400w",
    quantity: 1,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
    ...overrides,
  };
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
async function placeOrder(user, overrides = {}) {
  const created = await createPaymentRequest(
    { ...selection(overrides), idempotencyKey: uniqueKey() },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
  return { order: confirmed.order, request: confirmed.request };
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function notificationsOf(userId) {
  return getNotificationRepository().listNotifications(userId);
}

/** 把平台参数恢复成预置值（平台参数是单例，前一个用例可能改过它）。 */
function restoreDefaultTimeout() {
  resetMockStore("platformConfig");
}

/** 管理端改公共池超时。走真实服务，因此幂等键与取值校验都是真的。 */
async function setPublicTimeoutMinutes(minutes) {
  const result = await updateAdminPlatformConfig(uniqueAdmin(), {
    publicPoolTimeoutMinutes: minutes,
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true, "这条用例需要配置真的被改动");
  assert.equal(result.config.publicPoolTimeoutMinutes, minutes);
}

// ——————————————————————————— 一、专属池（1~7）———————————————————————————

test("专属池 1：下单指定 A → 派单进专属池，exclusiveCompanionId 是 A", async () => {
  restoreDefaultTimeout();
  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });

  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "exclusive");
  assert.equal(dispatch.exclusiveCompanionId, COMPANION_A);
  assert.equal(dispatch.exclusiveEnteredAt, order.paidAt);
  assert.equal(
    dispatch.exclusiveDeadlineAt,
    plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES),
    "专属池的等待时长是固定的 10 分钟，不是平台参数",
  );

  // 还没进过公共池：那三个字段此刻都必须是空的，否则「什么时候进的公共池」就说不清了
  assert.equal(dispatch.publicPoolEnteredAt, null);
  assert.equal(dispatch.publicDeadlineAt, null);
  assert.equal(dispatch.publicTimeoutMinutesSnapshot, null);
});

test("专属池 2：指定 A 之后 Order.actualCompanionId 仍是空的——指定不等于接单", async () => {
  restoreDefaultTimeout();
  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });

  assert.equal(order.status, "paid");
  assert.equal(order.actualCompanionId, null, "还没有人接单，实际打手必须为空");
  assert.equal(order.companion, null, "接单快照同理不该提前写");

  const dispatch = await dispatchOf(order.id);
  assert.equal(
    dispatch.acceptedByCompanionId,
    null,
    "「用户想要 A」不是「A 接了单」，派单上也不能写",
  );
});

test("专属池 3：10 分钟以内只有 A 能接，接单后订单与派单同段写完", async () => {
  restoreDefaultTimeout();
  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatchId = (await dispatchOf(order.id)).id;
  const at = plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES - 1);

  // 走服务层入口：接口拿到的就是它返回的 `kind`
  const outcome = await acceptDispatchForCompanion(COMPANION_A, dispatchId, at);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.dispatchId, dispatchId);
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.replayed, false);

  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "accepted");
  assert.equal(dispatch.acceptedByCompanionId, COMPANION_A);
  assert.equal(dispatch.acceptedAt, at);

  const updated = await orderOf(order.id);
  assert.equal(updated.status, "accepted");
  assert.equal(updated.acceptedAt, at);
  assert.equal(updated.actualCompanionId, COMPANION_A);
  assert.equal(updated.companion?.id, COMPANION_A, "接单快照写的是真正的接单人");

  // 接单之后不再出现在任何池子里
  const progress = toDispatchProgress(dispatch, at);
  assert.equal(progress, null, "已被接走的派单不该还有池子进度");
});

test("专属池 4：10 分钟整（deadline <= now）A 就不能再接了", async () => {
  restoreDefaultTimeout();
  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);

  // 边界取「正好到点」：`deadline <= now` 即已过期，不是「严格超过」
  const result = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES),
  });
  assert.equal(result.kind, "expired");

  // 被拒之后不得留下任何写入痕迹
  const after = await dispatchOf(order.id);
  assert.equal(after.state, "exclusive");
  assert.equal(after.acceptedByCompanionId, null);
  assert.equal((await orderOf(order.id)).status, "paid");
});

test("专属池 5：到点自动进公共池，并**按进入那一刻**的平台配置重新冻结快照", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(4);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);

  // 专属池等待期间管理员又改了参数：改的是**之后**进公共池的规则
  await setPublicTimeoutMinutes(9);

  const deadline = dispatch.exclusiveDeadlineAt;
  const swept = sweepExpiredDispatches(deadline);
  assert.ok(swept.movedToPublicDispatchIds.includes(dispatch.id));

  const moved = await dispatchOf(order.id);
  assert.equal(moved.state, "public");
  assert.equal(moved.publicPoolEnteredAt, deadline, "进公共池的时刻就是专属池到点那一刻");
  assert.equal(
    moved.publicTimeoutMinutesSnapshot,
    9,
    "公共池的快照取「真正进入公共池时」的配置，不是下单时的",
  );
  assert.equal(moved.publicDeadlineAt, plusMinutes(deadline, 9));

  // 转池不进退款、不进售后：订单还在等人接
  assert.equal((await orderOf(order.id)).status, "paid");
});

test("专属池 6：转公共池不覆盖 exclusiveCompanionId，它是历史事实", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(3);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);
  sweepExpiredDispatches(dispatch.exclusiveDeadlineAt);

  const moved = await dispatchOf(order.id);
  assert.equal(moved.exclusiveCompanionId, COMPANION_A, "用户当初指定的是 A，这件事发生过");
  assert.equal(moved.exclusiveEnteredAt, dispatch.exclusiveEnteredAt);
  assert.equal(moved.exclusiveDeadlineAt, dispatch.exclusiveDeadlineAt);

  // 真正接单的是 B：两个事实必须同时留得住
  const at = plusMinutes(dispatch.exclusiveDeadlineAt, 1);
  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_B, at });
  assert.equal(accepted.kind, "ok");

  const finalDispatch = await dispatchOf(order.id);
  assert.equal(finalDispatch.exclusiveCompanionId, COMPANION_A, "指定值不因为别人接单被清掉");
  assert.equal(finalDispatch.acceptedByCompanionId, COMPANION_B);

  const updated = await orderOf(order.id);
  assert.equal(updated.actualCompanionId, COMPANION_B, "订单写的是实际履约的人");
  assert.equal(updated.companion?.id, COMPANION_B);
});

test("专属池 7：仓库里不存在任何「拒绝 / 放弃 / 主动退回」的能力", () => {
  // 扫描的是**生产代码**（注释去掉），不含 tests/ 与 docs/——本文件与整改计划里
  // 必须写出这些标识才能禁止它们，把它们纳入扫描等于让门禁自己把自己判红。
  const FORBIDDEN_TOKENS = [
    "declineExclusiveDispatch",
    "declineDispatch",
    "rejectDispatch",
    "abandonDispatch",
    "returnToPublicPool",
    "declinedByCompanionIds",
    "declinedAt",
  ];

  const offenders = [];
  for (const dir of ["app", "lib", "components"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const token of FORBIDDEN_TOKENS) {
        if (source.includes(token)) offenders.push(`${path.relative(ROOT, file)} → ${token}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "「不接」本身就是拒绝：不该存在主动退回公共池的写入路径",
  );

  // 接口层：`api/companion/**` 下不允许出现 decline / reject / abandon / refuse 段。
  // 按路由扫描而不是写死路径，改个目录名躲不过去。
  const APP_DIR = path.join(ROOT, "app");
  const REFUSAL_SEGMENTS = ["decline", "declined", "reject", "abandon", "refuse", "giveup"];
  const routes = [];
  for (const file of walk(APP_DIR)) {
    const route = path
      .relative(APP_DIR, file)
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
      .join("/");
    if (!route.startsWith("api/companion/")) continue;
    const segments = route.split("/").map((segment) => segment.toLowerCase());
    if (segments.some((segment) => REFUSAL_SEGMENTS.includes(segment))) routes.push(route);
  }
  assert.deepEqual(routes, [], "打手端不该有「拒绝 / 放弃」接口");

  assert.equal(
    hasAppFile("api/companion/dispatches/[id]/decline/route.ts"),
    false,
    "计划里曾出现的 declineExclusiveDispatch 已被产品规则删除，不该留下路由",
  );

  // 打手端页面也不该长出那个按钮：文案常量里没有它，卡片组件也不该有对应交互
  const cardSource = stripComments(
    readFileSync(path.join(ROOT, "components", "companion", "CompanionDispatchCard.tsx"), "utf8"),
  );
  for (const token of ["拒绝", "放弃", "不接"]) {
    assert.equal(cardSource.includes(token), false, `接单卡片不该出现「${token}」这类动作`);
  }
});

// ——————————————————————————— 二、公共池（8~14）———————————————————————————

test("公共池 8：未指定打手 → 直接进公共池，快照就是进入时的配置", async () => {
  restoreDefaultTimeout();
  const user = uniqueUser();
  const { order } = await placeOrder(user);

  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.exclusiveCompanionId, null, "没指定人就没有「指定」这个事实");
  assert.equal(dispatch.exclusiveEnteredAt, null);
  assert.equal(dispatch.exclusiveDeadlineAt, null);
  assert.equal(dispatch.publicPoolEnteredAt, order.paidAt);
  assert.equal(dispatch.publicTimeoutMinutesSnapshot, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(
    dispatch.publicDeadlineAt,
    plusMinutes(order.paidAt, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES),
  );
});

test("公共池 9：超时时长在**进入公共池那一刻**冻结成快照", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(7);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);

  assert.equal(dispatch.publicTimeoutMinutesSnapshot, 7);
  assert.equal(dispatch.publicDeadlineAt, plusMinutes(order.paidAt, 7));
});

test("公共池 10：后台改了参数，已经入池的订单截止时间不变", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(7);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const before = await dispatchOf(order.id);

  // 管理员此刻把参数改成 30 分钟
  await setPublicTimeoutMinutes(30);

  const after = await dispatchOf(order.id);
  assert.equal(after.publicTimeoutMinutesSnapshot, 7, "用户被承诺的是进入池子时的那条规则");
  assert.equal(after.publicDeadlineAt, before.publicDeadlineAt, "已入池订单的截止时间不变");
});

test("公共池 11：两名打手同时抢同一单，只能有一个人成功", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const [first, second] = await Promise.all([
    acceptDispatch(dispatch.id, { companionId: COMPANION_A, at }),
    acceptDispatch(dispatch.id, { companionId: COMPANION_B, at }),
  ]);

  const outcomes = [first, second];
  const winners = outcomes.filter((item) => item.kind === "ok");
  assert.equal(winners.length, 1, "同一张单最终只能有一个实际打手");
  assert.equal(
    outcomes.filter((item) => item.kind === "not-open").length,
    1,
    "另一个人拿到的必须是「已被接走」，不是含糊的失败",
  );

  const winner = winners[0].dispatch.acceptedByCompanionId;
  assert.ok([COMPANION_A, COMPANION_B].includes(winner));

  const finalDispatch = await dispatchOf(order.id);
  const finalOrder = await orderOf(order.id);
  assert.equal(finalDispatch.acceptedByCompanionId, winner);
  assert.equal(finalOrder.actualCompanionId, winner);
  assert.equal(
    finalOrder.actualCompanionId,
    finalDispatch.acceptedByCompanionId,
    "派单与订单必须永远说的是同一个人",
  );
});

test("公共池 12：接单成功后 Order.actualCompanionId 与 Dispatch.acceptedByCompanionId 一致", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 2);

  const outcome = await acceptDispatchForCompanion(COMPANION_B, dispatch.id, at);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.replayed, false);

  const finalDispatch = await dispatchOf(order.id);
  const finalOrder = await orderOf(order.id);
  assert.equal(finalDispatch.acceptedByCompanionId, COMPANION_B);
  assert.equal(finalOrder.actualCompanionId, finalDispatch.acceptedByCompanionId);
  assert.equal(finalOrder.status, "accepted");
  assert.equal(finalOrder.companion?.id, COMPANION_B);
});

test("公共池 13：指定 A 超时转公共后 B 抢到 → 指定 A、实际 B，A 再也接不了", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(5);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);

  // 专属池到点 → 公共池
  const exclusiveDeadline = dispatch.exclusiveDeadlineAt;
  sweepExpiredDispatches(exclusiveDeadline);

  // 公共池里没有「指定」这回事，谁先来谁接——A 这十分钟没接，就轮到 B 了
  const byB = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_B,
    at: plusMinutes(exclusiveDeadline, 1),
  });
  assert.equal(byB.kind, "ok");

  // A 迟到的重试必须被挡在门外：他迟到的那一下不能把 B 挤掉
  const lateByA = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(exclusiveDeadline, 2),
  });
  assert.equal(lateByA.kind, "not-open");

  const finalDispatch = await dispatchOf(order.id);
  const finalOrder = await orderOf(order.id);
  assert.equal(finalDispatch.exclusiveCompanionId, COMPANION_A, "指定事实不因接单人变化");
  assert.equal(finalDispatch.acceptedByCompanionId, COMPANION_B);
  assert.equal(finalOrder.actualCompanionId, COMPANION_B);
  assert.equal(finalOrder.companion?.id, COMPANION_B, "订单上显示的是真正履约的那位");
});

test("公共池 14：公共池到点后任何人都抢不到——事实由 deadline 决定，不由 sweep 决定", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(5);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const deadline = dispatch.publicDeadlineAt;

  // 到点，但还没有跑过清扫：数据库里 state 仍是 public，那不代表还能抢
  const withoutSweep = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: deadline,
  });
  assert.equal(withoutSweep.kind, "expired", "到点就是到点，与清扫跑没跑无关");
  assert.equal((await dispatchOf(order.id)).state, "public", "清扫前状态确实还没变");

  // 清扫之后连「过期」都不再是正确答案：这一单已经关闭
  sweepExpiredDispatches(deadline);
  const afterSweep = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_B,
    at: plusMinutes(deadline, 1),
  });
  assert.equal(afterSweep.kind, "not-open");
  assert.equal(afterSweep.state, "timed_out");
});

// ——————————————————————————— 三、自动退款（15~18）———————————————————————————

test("自动退款 15：公共池超时 → 自动全额退款，不需要任何人点一下", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const paid = order.actualPaidAmount;

  const swept = sweepExpiredDispatches(dispatch.publicDeadlineAt);
  assert.ok(swept.refundedOrderIds.includes(order.id));

  const refunded = await orderOf(order.id);
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.refundedAmount, paid, "全额退款：退的就是这一单实付的钱");
  assert.equal(
    refunded.refundedAt,
    dispatch.publicDeadlineAt,
    "退款时间取「到点那一刻」，不是「谁碰巧来看了一眼」的时刻",
  );

  const closed = await dispatchOf(order.id);
  assert.equal(closed.state, "timed_out");
  assert.equal(closed.timedOutAt, dispatch.publicDeadlineAt);
});

test("自动退款 16：清扫跑 20 次也不重复退款、不重复改时间", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(dispatch.publicDeadlineAt, 1);

  const first = sweepExpiredDispatches(at);
  assert.ok(first.refundedOrderIds.includes(order.id));
  const afterFirst = await orderOf(order.id);

  for (let round = 0; round < 19; round += 1) {
    const again = sweepExpiredDispatches(at);
    assert.equal(
      again.refundedOrderIds.includes(order.id),
      false,
      `第 ${round + 2} 次清扫不该再退这一单`,
    );
  }

  const afterMany = await orderOf(order.id);
  assert.equal(afterMany.refundedAt, afterFirst.refundedAt);
  assert.equal(afterMany.refundedAmount, afterFirst.refundedAmount);
  assert.equal(afterMany.status, "refunded");
});

test("自动退款 17：超时退款不创建售后单，也不产生退款申请", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  sweepExpiredDispatches(dispatch.publicDeadlineAt);

  assert.equal(
    await getRefundRepository().findRefundByOrderId(order.id),
    null,
    "自动退款不是「用户申请退款」，不该凭空生成一条申请",
  );
  const complaints = await getComplaintRepository().summarizeComplaintsByOrder(order.id);
  assert.equal(complaints.count, 0, "自动退款不进售后、不等客服审核");
  assert.equal(complaints.latest, null);
});

test("自动退款 18：自动退款之后订单不可再次被接单", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  sweepExpiredDispatches(plusMinutes(dispatch.publicDeadlineAt, 1));

  const attempt = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(dispatch.publicDeadlineAt, 2),
  });
  assert.equal(attempt.kind, "not-open", "钱已经退给用户了，不该再有人把它接走");
  assert.equal((await orderOf(order.id)).status, "refunded");
  assert.equal((await orderOf(order.id)).actualCompanionId, null);
});

// ——————————————————————————— 四、通知（19~22）———————————————————————————

test("通知 19：专属池超时转公共池，通知只发一条（清扫 20 次也一样）", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);
  const deadline = dispatch.exclusiveDeadlineAt;

  for (let round = 0; round < 20; round += 1) sweepExpiredDispatches(deadline);

  const mine = await notificationsOf(user);
  const matched = mine.filter((item) => item.title === "指定护航未接单");
  assert.equal(matched.length, 1, "同一订单 + 同一业务事件只通知一次");
  assert.equal(matched[0].userId, user, "通知属于下单的用户");
  assert.equal(matched[0].href, `/orders/${order.id}`, "详情入口只带订单 id，不带任何说明");
  assert.equal(matched[0].readAt, null);
});

test("通知 20：公共池超时自动退款，通知只发一条", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(dispatch.publicDeadlineAt, 1);

  for (let round = 0; round < 20; round += 1) sweepExpiredDispatches(at);

  const matched = (await notificationsOf(user)).filter((item) => item.title === "订单已自动退款");
  assert.equal(matched.length, 1, "重复清扫不得重复产生同一业务事件的通知");
  assert.equal(matched[0].href, `/orders/${order.id}`);
});

test("通知 21：接单成功通知只发一条，重复接单（重放）不再发", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const first = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at });
  assert.equal(first.kind, "ok");
  // 网络重试 / 重复点击：同一个人再提交一次，是重放而不是「又接了一单」
  const replay = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at });
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);

  const matched = (await notificationsOf(user)).filter((item) => item.title === "订单已被接单");
  assert.equal(matched.length, 1, "一次接单只通知一次");
  assert.equal((await dispatchOf(order.id)).acceptedAt, at, "重放不改写接单时间");
});

test("通知 22：通知只发给下单用户，不会串给别人", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const owner = uniqueUser();
  const bystander = uniqueUser();
  const { order } = await placeOrder(owner);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(dispatch.publicDeadlineAt, 1);

  sweepExpiredDispatches(at);

  assert.equal((await notificationsOf(owner)).length, 1, "下单用户收到超时退款通知");
  assert.deepEqual(await notificationsOf(bystander), [], "别的用户收件箱必须为空");
});

// ——————————————————————————— 五、兼容（23~25）———————————————————————————

test("兼容 23：普通用户的订单列表与详情仍然正常，并显示池子进度", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user);

  const list = await queryOrdersForUser(user, new URLSearchParams(), "server");
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, order.id);
  assert.equal(list.items[0].status, "paid");
  assert.equal(list.items[0].companion, null, "还没人接，列表显示「等待接单」");

  const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.dispatchProgress?.pool, "public");
  assert.equal(detail.dispatchProgress?.poolLabel, "公共订单池");
  assert.ok(detail.dispatchProgress.remainingSeconds > 0);

  // 被人接走之后：进度消失，状态与快照一起变
  const dispatch = await dispatchOf(order.id);
  await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(order.paidAt, 1),
  });

  const accepted = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.dispatchProgress, null, "已接单时订单状态已经说明一切");
  assert.equal(accepted.companion?.id, COMPANION_A);

  const acceptedList = await queryOrdersForUser(user, new URLSearchParams(), "server");
  assert.equal(acceptedList.items[0].status, "accepted");
});

test("兼容 24：P0-3 的金额域不回归——整数分、口径不变、全额退款写进累计已退", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(2);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { quantity: 2 });

  for (const [name, value] of Object.entries({
    originalAmount: order.originalAmount,
    couponDiscountAmount: order.couponDiscountAmount,
    actualPaidAmount: order.actualPaidAmount,
    companionRateSnapshot: order.companionRateSnapshot,
    companionBaseIncome: order.companionBaseIncome,
    clubNetIncome: order.clubNetIncome,
  })) {
    assert.ok(Number.isInteger(value), `${name} 必须是整数分`);
  }
  assert.equal(
    order.companionBaseIncome + order.clubNetIncome,
    order.originalAmount,
    "分账基数拆分后必须回到原价",
  );
  assert.equal(order.refundedAmount, 0, "还没退款时累计已退是 0");

  const dispatch = await dispatchOf(order.id);
  sweepExpiredDispatches(dispatch.publicDeadlineAt);

  const refunded = await orderOf(order.id);
  const paid = order.actualPaidAmount;
  assert.equal(refunded.refundedAmount, paid);
  assert.equal(
    refunded.companionBaseIncome + refunded.clubNetIncome,
    refunded.originalAmount,
    "退款不改变这一单的分账快照",
  );
});

test("兼容 25：P0-4 的权限模型不回归——打手身份仍来自用户会话，且接口不读请求体", () => {
  // 接口侧：两个打手接口的**第一个动作**都是 requireCompanion()，
  // 而 requireCompanion() 建立在 requireUser() 之上（用户会话），不是第二套身份
  const guard = stripComments(
    readFileSync(path.join(ROOT, "lib", "api", "companionRoute.ts"), "utf8"),
  );
  assert.ok(guard.includes("requireUser()"), "打手守卫必须建立在用户会话之上");
  assert.ok(guard.includes("resolveCompanionAccess"), "资格判定只有一处");
  assert.equal(guard.includes("cookies("), false, "守卫不自己读 Cookie");

  const listRoute = stripComments(
    readFileSync(resolveSource("app/api/companion/dispatches/route.ts"), "utf8"),
  );
  assert.ok(listRoute.includes("requireCompanion()"), "池子接口必须先过守卫");
  assert.equal(listRoute.includes("cookies("), false);
  assert.equal(listRoute.includes("request.json()"), false);

  const acceptRoute = stripComments(
    readFileSync(resolveSource("app/api/companion/dispatches/[id]/accept/route.ts"), "utf8"),
  );
  assert.ok(acceptRoute.includes("requireCompanion()"), "接单接口必须先过守卫");
  assert.equal(
    acceptRoute.includes("request.json()"),
    false,
    "接单接口不读请求体：以谁的身份接单只能由会话决定",
  );

  // 服务层：打手 id 是**入参**，只能由守卫的会话身份给出；调用方无法从请求体声明自己是谁
  const service = stripComments(
    readFileSync(path.join(ROOT, "lib", "services", "companionDispatch.ts"), "utf8"),
  );
  assert.match(
    service,
    /acceptDispatchForCompanion\(\s*companionId: string/,
    "接单服务的第一个参数必须是由会话取得的 companionId",
  );
});

test("兼容 25b：身份参数会被真的校验——不在名单里的 id 接不到单", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);

  const result = await acceptDispatch(dispatch.id, {
    companionId: "cp-不存在",
    at: plusMinutes(order.paidAt, 1),
  });
  assert.equal(result.kind, "companion-unavailable", "不在架的打手接不到单");
  assert.equal((await dispatchOf(order.id)).state, "public");
  assert.equal((await orderOf(order.id)).actualCompanionId, null);
});

// ——————————————————————————— 六、池子 DTO ———————————————————————————

test("池子 DTO：专属池只对指定的人可见，字段里没有游戏账号与备注", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const poolsForA = await listCompanionPools(COMPANION_A, at);
  const itemForA = poolsForA.exclusive.find((item) => item.dispatchId === dispatch.id);
  assert.ok(itemForA, "指定给 A 的单必须出现在 A 的专属池里");
  assert.equal(itemForA.pool, "exclusive");
  assert.equal(itemForA.poolLabel, "专属订单池");
  assert.equal(itemForA.orderNo, order.orderNo);
  assert.ok(itemForA.remainingSeconds > 0);
  assert.ok(itemForA.remainingSeconds <= EXCLUSIVE_WAIT_MINUTES * 60);

  // 字段是显式挑出来的：私人与资金信息一个都不该在池子卡片里
  for (const leaked of ["gameAccountId", "remark", "userId", "actualPaidAmount", "companionBaseIncome"]) {
    assert.equal(
      Object.hasOwn(itemForA, leaked),
      false,
      `池子卡片不该带 ${leaked}`,
    );
  }

  const poolsForB = await listCompanionPools(COMPANION_B, at);
  assert.equal(
    poolsForB.exclusive.find((item) => item.dispatchId === dispatch.id),
    undefined,
    "不是指定给他的单，不该出现在他的专属池里",
  );
  assert.equal(
    poolsForB.public.find((item) => item.dispatchId === dispatch.id),
    undefined,
    "专属池还没到点的单不进公共池",
  );
});

test("池子 DTO：到点的单不会以「还能接」的样子留在池子里", async () => {
  restoreDefaultTimeout();
  await setPublicTimeoutMinutes(30);

  const user = uniqueUser();
  const { order } = await placeOrder(user, { companionId: COMPANION_A });
  const dispatch = await dispatchOf(order.id);

  // 读取时传入「专属池已经到点」的时刻：读取前的那次清扫必须先把它挪走
  const pools = await listCompanionPools(COMPANION_A, dispatch.exclusiveDeadlineAt);
  assert.equal(
    pools.exclusive.find((item) => item.dispatchId === dispatch.id),
    undefined,
    "到点的单不该再出现在专属池里（点下去必然被拒）",
  );
  assert.equal((await dispatchOf(order.id)).state, "public", "它已经被挪进公共池");
});

/* ───────────────────────── 小工具 ───────────────────────── */

/** 去掉注释后的源码。门禁断言看的是**代码**，注释里说明「没有 X」是允许的。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
