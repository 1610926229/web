import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE,
  COMPANION_ORDER_NOT_FOUND_MESSAGE,
  COMPANION_ORDER_NOT_STARTABLE_MESSAGE,
  DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
  plusMinutes,
} from "../lib/constants/dispatch.ts";
import { ORDER_STATUS_LABELS, canTransitionOrder } from "../lib/constants/orders.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import {
  cancelAcceptedOrder,
  startCompanionOrder as startCompanionOrderTransaction,
} from "../lib/data/companionOrderTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getAdminOrderDetail } from "../lib/services/adminOrders.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  cancelCompanionOrder,
  getCompanionOrderDetail,
  listCompanionOrders,
  startCompanionOrder,
} from "../lib/services/companionOrders.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-7「打手开始服务（`accepted → serving`）」的持续测试。
 *
 * ## 这一批真正要钉住的是什么
 *
 * 与 P0-6 的「主动取消」**刻意相反**：一次成功开始服务**只有一件事**要写——
 * 订单从 `accepted` 推进到 `serving`，并冻结 `servingAt`。
 *
 * 因此本文件最重的那条断言不是「状态变对了」，而是：
 *
 * > **变化的键集合恰好是 `["servingAt", "status"]`。**
 *
 * 少一个（没写开始时间）是需求没满足；多一个（顺手碰了 `acceptedAt` / `actualCompanionId` /
 * `companion` / 金额域）就是本轮「不碰绑定、不碰历史、不碰钱」这句话被破坏——
 * 而后者在页面上**看不出来**：清掉 `acceptedAt` 之后一切照常渲染，只是打手再也答不出
 * 「我是几点接的单」。这类静默回退正是自动化测试存在的理由。
 *
 * ## 三条「本轮不做」的边界，各自有一条负向断言
 *
 * - **不发通知**（D6）：需求没有为「开始服务」冻结任何生命周期通知，因此本轮
 *   一个字节都不许写进用户收件箱，也不许新增通知常量；
 * - **不写退出历史**：`serving` 不是一次退出，历史表必须还是空的；
 * - **不动派单**：打手开始服务与「这一单在哪个池子里等人接」毫无关系（它本来就
 *   已经不在任何池子里），派单记录必须逐字不变。
 *
 * 另外两条：**幂等靠状态本身**（D2，因此没有 `idempotencyKey`，也不许有第二套幂等框架）
 * 与 **状态机不是权限**（`canTransitionOrder("accepted","serving")` 为真，但别人 / 非
 * `accepted` 的单照样被拒）。
 *
 * ## 时间怎么控制
 *
 * 一次都不等真实时间。需要精确时刻的用例直接调伪事务 `startCompanionOrder` 并显式传入
 * `at`；走完整服务链路的用例用服务层的 `startCompanionOrder`，只断言「这一个时刻」这类
 * 相对性质（订单上存的与返回给调用方的必须是**同一个**）。
 *
 * ## 用例之间怎么隔离
 *
 * Mock 仓储在同一进程内共享，而预置数据里本来就有挂在 `cp-1` 名下、处于 `serving` /
 * `completed` / `refunded` 的订单。因此：写操作一律落在**自己新下的单**上，
 * 断言一律不依赖全局列表长度；只读用例才用预置订单（那三种状态在本轮里造不出来，
 * 因为推进状态的入口正是本轮唯一新增的东西）。
 *
 * 不调用 `resetMockStore()`：本文件没有任何一条用例需要「一份干净的预置数据」，
 * 而重置会连带丢掉同一进程里前一条用例建好的数据——那会让下面的断言变得不可复现。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的两位，`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

/** 预置数据里挂在 `cp-1` 名下、且**不能**开始服务的那三种状态。 */
const SEEDED_SERVING = "ord-seed-1001-10"; // serving（重放路径用）
const SEEDED_COMPLETED = "ord-seed-1001-05"; // completed
const SEEDED_REFUNDED = "ord-seed-1009-01"; // refunded

/** 预置数据里挂在 `cp-2` 名下、**状态恰好是 accepted** 的一张单（HTTP「不是本人」用）。 */
const SEEDED_ACCEPTED_OF_B = "ord-seed-1001-11";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function uniqueUser() {
  return unique("u-p07");
}

/**
 * 一个合法且唯一的幂等键。
 *
 * `start` 本身**没有**幂等键（幂等判据是状态本身，见 D2），但「开始服务之后取消被拒」
 * 那条用例走的是 P0-6 的取消接口，那里仍然需要键——而且必须每次都不一样：
 * 用同一个键去测两条不同的取消，第二次会被当成重放。
 */
function uniqueKey() {
  return unique("p07key");
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
async function placeOrder(user, overrides = {}) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      ...overrides,
      idempotencyKey: uniqueKey(),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return confirmed.order;
}

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

async function releasesOf(orderId) {
  return getCompanionReleaseRepository().listReleasesByOrderId(orderId);
}

/** 下单用户的收件箱。通知是逐字比较的对象——条数与内容都必须一模一样。 */
async function notificationsOf(userId) {
  return getNotificationRepository().listNotifications(userId);
}

/**
 * 「一张由 `companionId` 接下的新订单」——本文件几乎所有用例的起点。
 *
 * 返回的 `order` 是**接单之后**的那一份（`status: accepted`），因为下面要比较的
 * 「开始服务前后差了哪几个键」必须从 accepted 态起算。
 */
async function acceptedOrder(companionId, user = uniqueUser(), overrides = {}) {
  const placed = await placeOrder(user, overrides);
  const dispatch = await dispatchOf(placed.id);
  const acceptedAt = plusMinutes(placed.paidAt, 1);

  const result = await acceptDispatch(dispatch.id, { companionId, at: acceptedAt });
  assert.equal(result.kind, "ok", "这条用例需要一次成功的接单");

  const order = await orderOf(placed.id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actualCompanionId, companionId);
  assert.equal(order.acceptedAt, acceptedAt, "接单时间就是这一步传入的时刻，用例据此推算后续时刻");
  return { user, order, dispatchId: dispatch.id, acceptedAt };
}

/**
 * 一次写入前后**真正变了的键**。
 *
 * 逐值 JSON 比较而不是逐字段手写断言：手写的那串字段名永远只覆盖到「想得到的那些」，
 * 而「写入器顺手多改了一个字段」恰恰是想不到的那一类。订单里全是原始值与快照对象，
 * 因此 JSON 比较在这里是准确的。
 */
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/** 断言一个请求以指定的错误码 / 状态码 / 文案被拒绝，并返回那个错误。 */
async function expectApiError(run, { code, status, message }) {
  await assert.rejects(run, (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, code, `错误码应当是 ${code}`);
    assert.equal(error.status, status, `HTTP 状态码应当是 ${status}`);
    assert.equal(error.message, message, "对外文案必须是那一句冻结的常量，不能另写一句");
    return true;
  });
}

/** 非本人 / 不存在 → 404（同一句话，不泄露存在性）。 */
function expectNotFound(run) {
  return expectApiError(run, {
    code: "NOT_FOUND",
    status: 404,
    message: COMPANION_ORDER_NOT_FOUND_MESSAGE,
  });
}

/** 是本人的单但状态不是 `accepted` → 400（不是重放，是「点了此刻不该存在的按钮」）。 */
function expectNotStartable(run) {
  return expectApiError(run, {
    code: "BAD_REQUEST",
    status: 400,
    message: COMPANION_ORDER_NOT_STARTABLE_MESSAGE,
  });
}

/** 开始服务的结果字段集：多一个字段就是往调用方手里多塞一样它没要的东西。 */
const START_OUTCOME_KEYS = ["changed", "kind", "orderId", "orderNo", "servingAt", "status"];

// ——————————————————— 一、一次成功开始服务的全部事实 ———————————————————

test("开始 1：本人 start 自己的 accepted 单——订单进入 serving，且**只改了 status 与 servingAt 两个键**", async () => {
  const { user, order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const before = await orderOf(order.id);
  const dispatchBefore = await dispatchOf(order.id);
  const inboxBefore = await notificationsOf(user);

  const startedAt = plusMinutes(acceptedAt, 30);
  const outcome = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: order.id,
    at: startedAt,
  });

  // (1) 事务层返回的是一份**可核对**的结果：用的是打手认得的订单号，不是内部 id
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.changed, true, "这一次真的改了东西");
  assert.equal(outcome.status, "serving");
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.orderNo, order.orderNo);
  assert.equal(outcome.servingAt, startedAt, "传进来的那一刻必须**逐字**写下去");
  assert.deepEqual(Object.keys(outcome).sort(), START_OUTCOME_KEYS);

  // (2) 本轮的核心证据：**变化的键恰好两个**。
  //     这是「不碰绑定、不碰历史、不碰钱」唯一能被自动化看见的形式——
  //     多改一个字段在页面上完全看不出来，只有这里会对不上。
  const after = await orderOf(order.id);
  assert.equal(after.status, "serving");
  assert.equal(after.servingAt, startedAt);
  assert.deepEqual(
    changedKeys(before, after),
    ["servingAt", "status"],
    "开始服务只能动这两个字段：多一个就是本轮明确不做的事被顺手做了",
  );
  assert.deepEqual(Object.keys(after), Object.keys(before), "写入器不得增删字段");

  // (3) 三条「本轮不做」的边界各自点名一次，不靠上面那条集合断言代言——
  //     集合对不上的报错很难指向「是哪件事被破坏了」
  assert.equal(after.acceptedAt, acceptedAt, "`acceptedAt` 是历史事实：打手要能答出「几点接的」");
  assert.equal(after.actualCompanionId, COMPANION_A, "进入 serving 恰恰是履约绑定成立的证明");
  assert.deepEqual(after.companion, before.companion, "履约快照跟着绑定一起不动");
  assert.equal(after.paidAt, before.paidAt);
  for (const money of [
    "unitPrice",
    "itemsAmount",
    "addonsAmount",
    "totalAmount",
    "originalAmount",
    "couponDiscountAmount",
    "actualPaidAmount",
    "companionRateSnapshot",
    "companionBaseIncome",
    "clubNetIncome",
    "refundedAmount",
  ]) {
    assert.equal(after[money], before[money], `开始服务不是一个资金事件：${money} 不得被改动`);
  }

  // (4) 不发通知（D6）：收件箱条数与内容逐字不变
  assert.deepEqual(
    await notificationsOf(user),
    inboxBefore,
    "需求没有为「开始服务」冻结任何通知：用户收件箱必须一个字节都不变",
  );

  // (5) 不写退出历史：serving 不是一次退出
  assert.deepEqual(await releasesOf(order.id), [], "开始服务不产生退出历史");

  // (6) 不动派单：这一单早就不在任何池子里了，开始服务与派单无关
  assert.deepEqual(
    await dispatchOf(order.id),
    dispatchBefore,
    "派单记录必须逐字不变（state 仍 accepted、acceptedByCompanionId 仍是本人）",
  );
  assert.equal(dispatchBefore.state, "accepted");
  assert.equal(dispatchBefore.acceptedByCompanionId, COMPANION_A);
});

test("开始 2：走完整服务链路时 `servingAt` 是**同一个**时刻——订单上存的与返回给调用方的必须相等", async () => {
  const { order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const before = await orderOf(order.id);

  const t0 = new Date().toISOString();
  const outcome = await startCompanionOrder(COMPANION_A, order.id);
  const t1 = new Date().toISOString();

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.status, "serving");

  // 「取一次时刻并贯穿整段」只能这样验：两处分别取 `new Date()` 的话，
  // 页面显示的与接口返回的会是两个时刻，而它们描述的是同一件事
  const after = await orderOf(order.id);
  assert.equal(outcome.servingAt, after.servingAt, "接口返回的时刻与写进订单的时刻必须是同一个");
  assert.ok(
    outcome.servingAt >= t0 && outcome.servingAt <= t1,
    `servingAt 应当是本次调用的时刻，实际是 ${outcome.servingAt}`,
  );
  assert.deepEqual(changedKeys(before, after), ["servingAt", "status"], "服务层与事务层是同一条写入路径");
  assert.ok(after.servingAt !== acceptedAt, "开始时间与接单时间是两个事实，不能是同一个值");
});

test("开始 3：重复点击是重放——不报错、**不刷新 `servingAt`**、不产生任何新写入", async () => {
  const { user, order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const firstAt = plusMinutes(acceptedAt, 30);
  const laterAt = plusMinutes(acceptedAt, 90);

  const first = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: order.id,
    at: firstAt,
  });
  assert.equal(first.kind, "ok");

  const snapshot = await orderOf(order.id);
  const inboxAfterFirst = await notificationsOf(user);

  // 第二次用一个**明显不同**的时刻：重放如果读了「现在」，这条就会抓到
  const second = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: order.id,
    at: laterAt,
  });

  assert.equal(second.kind, "replayed", "已经是我的 serving 单就是重放，不是错误");
  assert.equal(second.changed, false);
  assert.equal(second.servingAt, firstAt, "返回的是**第一次**的时刻，不是现在");
  assert.notEqual(laterAt, firstAt, "用例素材本身要先成立：两次传的时刻确实不同");
  assert.notEqual(second.servingAt, laterAt);
  assert.deepEqual(Object.keys(second).sort(), START_OUTCOME_KEYS);

  // 一个字节都没写：deepEqual 比的是整条记录，连快照对象都不得被换掉
  assert.deepEqual(await orderOf(order.id), snapshot, "重放不得刷新 servingAt，也不得动任何其它字段");
  assert.deepEqual(await notificationsOf(user), inboxAfterFirst);
  assert.deepEqual(await releasesOf(order.id), []);

  // 走服务链路的那一次也必须报「重放」而不是 400：幂等判据是状态本身，
  // 因此 `serving → serving` 这条不在状态表里的边不会把重复点击判成非法迁移
  const viaService = await startCompanionOrder(COMPANION_A, order.id);
  assert.equal(viaService.kind, "replayed");
  assert.equal(viaService.changed, false);
  assert.equal(viaService.servingAt, firstAt);
  assert.deepEqual(await orderOf(order.id), snapshot);
});

test("开始 3b：预置的 serving 单走同一条重放路径——`servingAt` 保留原值，订单一个字节不变", async () => {
  // 这一条走的是**预置数据**那条路：它的 `serving` 不由本轮任何一次点击产生，
  // 是「历史遗留」的样子（就像真实数据库迁移过来的老单）。重放必须对它同样成立，
  // 否则第一张真的老单会因为「没有经过我们的写入器」而被当成可以重新开始
  const before = await orderOf(SEEDED_SERVING);
  assert.equal(before.status, "serving");
  assert.equal(before.actualCompanionId, COMPANION_A);
  assert.ok(before.servingAt, "预置的 serving 单本来就带着一个开始时间");

  const laterAt = plusMinutes(before.servingAt, 999);
  const outcome = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: SEEDED_SERVING,
    at: laterAt,
  });

  assert.equal(outcome.kind, "replayed");
  assert.equal(outcome.changed, false);
  assert.equal(outcome.servingAt, before.servingAt, "重放不得把开始时间改成「现在」");
  assert.notEqual(outcome.servingAt, laterAt);

  const viaService = await startCompanionOrder(COMPANION_A, SEEDED_SERVING);
  assert.equal(viaService.kind, "replayed");
  assert.equal(viaService.servingAt, before.servingAt);

  assert.deepEqual(await orderOf(SEEDED_SERVING), before, "重放不写任何字段");
  assert.deepEqual(await releasesOf(SEEDED_SERVING), []);
});

// ————————————————————————— 二、谁不能开始 —————————————————————————

test("开始 4：不是当前实际履约人的一律 not-found——别人接的单、不存在的单、只是「用户指定给我」", async () => {
  // (a) 别人接的单：订单存在、状态也恰好是 accepted，但履约人不是我
  const mine = await acceptedOrder(COMPANION_A);
  const before = await orderOf(mine.order.id);
  const inboxBefore = await notificationsOf(mine.user);

  const byOther = await startCompanionOrderTransaction({
    companionId: COMPANION_B,
    orderId: mine.order.id,
    at: plusMinutes(mine.acceptedAt, 30),
  });
  assert.equal(byOther.kind, "not-found", "状态对不构成理由：归属才是第一道门");
  await expectNotFound(() => startCompanionOrder(COMPANION_B, mine.order.id));

  // 订单一个字节没变
  assert.deepEqual(await orderOf(mine.order.id), before, "被拒的开始服务不得动订单");

  // (b) 根本不存在的订单：与 (a) **同一句话、同一个状态码**
  await expectNotFound(() => startCompanionOrder(COMPANION_A, "ord-根本不存在"));

  // (c) 用户结算时指定了我，但我从没接：`exclusiveCompanionId === 我` **不等于**订单归我。
  //     ⚠️ 这一条同时钉住了**判定顺序**：这张单的状态是 `paid`（一个结构上不允许
  //     `→ serving` 的起点），如果先判状态就会得到 400；正确答案是 404，
  //     因为「这一单与我无关」先于「这一单现在能不能开始」成立
  const specified = await placeOrder(uniqueUser(), { companionId: COMPANION_A });
  assert.equal((await orderOf(specified.id)).actualCompanionId, null, "指定不等于接单");
  assert.equal((await dispatchOf(specified.id)).exclusiveCompanionId, COMPANION_A);
  const specifiedResult = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: specified.id,
    at: plusMinutes(specified.paidAt, 1),
  });
  assert.equal(
    specifiedResult.kind,
    "not-found",
    "归属判定必须先于状态判定：反过来的话，拿别人的订单 id 就能从 404 与 400 的差别里试探出它是否存在",
  );
  await expectNotFound(() => startCompanionOrder(COMPANION_A, specified.id));

  // (d) 别人手里**已经开始服务**的单：归属仍然先于重放，
  //     否则「这一单已经开始服务了」会顺着 200 泄露给任何拿着这个 id 的人
  const serving = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: mine.order.id,
    at: plusMinutes(mine.acceptedAt, 30),
  });
  assert.equal(serving.kind, "ok");
  const servingSnapshot = await orderOf(mine.order.id);
  const foreign = await startCompanionOrderTransaction({
    companionId: COMPANION_B,
    orderId: mine.order.id,
    at: plusMinutes(mine.acceptedAt, 60),
  });
  assert.equal(foreign.kind, "not-found", "别人拿到的不是「重放」，是「与你无关」");
  await expectNotFound(() => startCompanionOrder(COMPANION_B, mine.order.id));
  assert.deepEqual(await orderOf(mine.order.id), servingSnapshot);

  // 三次失败都不得留下写入痕迹
  assert.deepEqual(await releasesOf(mine.order.id), []);
  assert.deepEqual(await notificationsOf(mine.user), inboxBefore, "被拒的开始服务不得发通知");
});

test("开始 5：paid / completed / refunded 都不能开始服务——本人也不行，且订单一个字段都不回退", async () => {
  // (a) 预置的 completed / refunded：确实是挂在 cp-1 名下的那两种状态
  const blocked = [
    [SEEDED_COMPLETED, "completed"],
    [SEEDED_REFUNDED, "refunded"],
  ];

  for (const [orderId, expected] of blocked) {
    const before = await orderOf(orderId);
    assert.equal(before.status, expected, `${orderId} 的预置状态应当是 ${expected}`);
    assert.equal(before.actualCompanionId, COMPANION_A);

    const result = await startCompanionOrderTransaction({
      companionId: COMPANION_A,
      orderId,
      at: plusMinutes(before.paidAt, 500),
    });
    assert.equal(result.kind, "not-startable");
    assert.equal(result.status, expected, "带上**当前**状态，调用方才知道自己点了一个不该存在的按钮");
    await expectNotStartable(() => startCompanionOrder(COMPANION_A, orderId));

    // 服务端旗标也必须为假：**入口是否出现**是另一条路径（页面只读这个旗标，
    // 不自己用状态推断），只断言事务层被拒是不够的——旗标写错的话，
    // 页面上会先渲染出一个点下去必然失败的按钮，而那正是「前端自己判权限」的反面
    assert.equal(
      (await getCompanionOrderDetail(COMPANION_A, orderId)).canStart,
      false,
      `${expected} 的单不得出现「开始服务」入口`,
    );

    // 把 completed / refunded 拉回 serving 是状态回退，不是重放
    assert.deepEqual(await orderOf(orderId), before, `${expected} 的订单不得被这次请求改动`);
    assert.deepEqual(await releasesOf(orderId), [], `${expected} 不该留下退出历史`);
  }

  // (b) `paid` 的两条来源各验一次。它**不可能**与「实际打手是我」同时成立：
  //     `applyOrderAccepted` 是唯一写入 `actualCompanionId` 的地方，而它必然把状态写成
  //     `accepted`；`applyOrderAcceptanceReleased` 清人时又必然把状态写回 `paid`。
  //     因此一张 paid 的单对被开始者而言只可能是「与我无关」，走 404 而不是 400
  const neverAccepted = await placeOrder(uniqueUser());
  assert.equal((await orderOf(neverAccepted.id)).status, "paid");
  assert.equal((await orderOf(neverAccepted.id)).actualCompanionId, null);
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_A,
        orderId: neverAccepted.id,
        at: plusMinutes(neverAccepted.paidAt, 1),
      })
    ).kind,
    "not-found",
  );
  await expectNotFound(() => startCompanionOrder(COMPANION_A, neverAccepted.id));

  const cancelled = await acceptedOrder(COMPANION_A);
  const cancelledOut = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: cancelled.order.id,
    reason: "临时有事无法服务",
    idempotencyKey: uniqueKey(),
    at: plusMinutes(cancelled.acceptedAt, 5),
  });
  assert.equal(cancelledOut.kind, "ok");
  assert.equal((await orderOf(cancelled.order.id)).status, "paid");
  const afterCancel = await orderOf(cancelled.order.id);
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_A,
        orderId: cancelled.order.id,
        at: plusMinutes(cancelled.acceptedAt, 30),
      })
    ).kind,
    "not-found",
    "取消之后这一单不再属于他：开始服务不会成为把它抢回来的第二条路",
  );
  assert.deepEqual(await orderOf(cancelled.order.id), afterCancel);
  assert.equal(afterCancel.servingAt, null, "被拒的开始服务不得在订单上留下开始时间");
});

// ————————————————————————— 三、开始之后 —————————————————————————

test("开始 6：开始服务之后「取消接单」这条路就关了——400、状态不被拉回 paid、历史与收件箱都不动", async () => {
  const { user, order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const startedAt = plusMinutes(acceptedAt, 30);
  const started = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: order.id,
    at: startedAt,
  });
  assert.equal(started.kind, "ok");

  const snapshot = await orderOf(order.id);
  const inboxBefore = await notificationsOf(user);

  // 服务链路：与「点了此刻不该存在的按钮」同一个 400（不是 404——这一单确实还是他的）
  await expectApiError(() => cancelCompanionOrder(COMPANION_A, order.id, { reason: "想取消", idempotencyKey: uniqueKey() }), {
    code: "BAD_REQUEST",
    status: 400,
    message: COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE,
  });

  // 事务层：`not-accepted` 且带上当前状态
  const transaction = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason: "想取消",
    idempotencyKey: uniqueKey(),
    at: plusMinutes(startedAt, 10),
  });
  assert.equal(transaction.kind, "not-accepted");
  assert.equal(transaction.status, "serving");

  // 这是**状态回退**，不是重放：订单、历史、收件箱三者都必须一个字节不变
  assert.deepEqual(await orderOf(order.id), snapshot, "serving 不得被拉回 paid 或 accepted");
  assert.deepEqual(await releasesOf(order.id), [], "被拒的取消不得写退出历史");
  assert.deepEqual(await notificationsOf(user), inboxBefore, "被拒的取消不得发通知");
});

test("开始 7：开始服务之后这一单**仍然属于他**——列表、详情都还返回，两个动作旗标同时变假", async () => {
  const { order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const startedAt = plusMinutes(acceptedAt, 30);
  await startCompanionOrderTransaction({ companionId: COMPANION_A, orderId: order.id, at: startedAt });

  // (1) 列表仍然返回它（item 16：本文件不重复 P0-6.1 的排序用例，只钉「归属没丢」）
  const item = (await listCompanionOrders(COMPANION_A)).items.find((entry) => entry.id === order.id);
  assert.ok(item, "开始服务之后这一单还在他自己的列表里");
  assert.equal(item.status, "serving");
  assert.equal(item.statusLabel, ORDER_STATUS_LABELS.serving);
  assert.equal(item.acceptedAt, acceptedAt, "列表也要答得出「几点接的」");
  assert.equal("servingAt" in item, false, "servingAt 只属于详情：列表由状态名「护航中」表达");

  // (2) 两个动作旗标都由服务端算好，serving 上同时为假——这正是页面上两个入口一起消失的依据
  assert.equal(item.canStart, false, "serving 不能再开始服务");
  assert.equal(item.canCancel, false, "serving 没有普通主动取消");

  // (3) 详情仍然取得到，并且把两个历史节点都带上
  const detail = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(detail, "开始服务之后详情仍然返回这一单（刷新页面不该变成 404）");
  assert.equal(detail.status, "serving");
  assert.equal(detail.servingAt, startedAt);
  assert.equal(detail.acceptedAt, acceptedAt, "两个节点都要在：打手要能答出「我是几点接的、几点开始的」");
  assert.equal(detail.canStart, false);
  assert.equal(detail.canCancel, false);

  // (4) 归属没有变松也没有变紧：别人照样取不到
  assert.equal(await getCompanionOrderDetail(COMPANION_B, order.id), null);
  assert.equal(
    (await listCompanionOrders(COMPANION_B)).items.some((entry) => entry.id === order.id),
    false,
  );
});

test("开始 7b：用户端与后台也看到 serving——时间轴同时保留「已接单」与「护航中」两个节点", async () => {
  const { user, order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const startedAt = plusMinutes(acceptedAt, 30);
  await startCompanionOrderTransaction({ companionId: COMPANION_A, orderId: order.id, at: startedAt });

  // 用户端读的是 `Order`，因此「开始服务」不需要任何通知也能让用户看到进度（D6 的依据之一）
  const userDetail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.ok(userDetail);
  assert.equal(userDetail.status, "serving");
  assert.deepEqual(
    userDetail.timeline.map((node) => [node.key, node.at]),
    [
      ["paid", order.paidAt],
      ["accepted", acceptedAt],
      ["serving", startedAt],
    ],
    "时间轴只展示**已经发生**的节点，且进入 serving 不抹掉「已接单」那一格",
  );

  const admin = await getAdminOrderDetail(order.id, undefined, "server");
  assert.ok(admin);
  assert.equal(admin.status, "serving");
  assert.deepEqual(
    admin.timeline.map((node) => node.key),
    ["paid", "accepted", "serving"],
  );
});

// ————————————————————— 四、状态机允许不等于权限 —————————————————————
// 用例 14（指令 §八）的落点。结构校验与领域 Guard 是**两道语义不同的门**：
// 前者回答「这条边存在吗」，后者回答「这一单此刻就站在这条边的起点上吗」。

test("开始 8：`canTransitionOrder(accepted→serving)` 为真，但这**不是**权限——非本人 / 非起点仍然被拒", async () => {
  // (1) 这条边在中央状态表里：结构上完全讲得通
  assert.equal(canTransitionOrder("accepted", "serving"), true);

  // (2) 表里没有的那几条边，正面证明「结构校验真的在跑」而不是恒为真的摆设：
  //     `serving → serving` 不在表里，所以重放只能靠状态判定（用例 3），
  //     而 paid / completed / refunded 都到不了 serving（用例 5）
  assert.equal(canTransitionOrder("serving", "serving"), false, "重放不是一次迁移");
  for (const from of ["paid", "completed", "refunded"]) {
    assert.equal(canTransitionOrder(from, "serving"), false, `${from} 到不了 serving`);
  }

  // (3) 表允许 `serving → completed`（P0-8 起由「提交完成材料」打开入口），
  //     也允许 `serving → paid`——但后者至今没有任何入口。打手端的写入口恰好
  //     三个（见「开始 11」）。状态机允许不等于该动作存在入口
  assert.equal(canTransitionOrder("serving", "completed"), true);
  assert.equal(canTransitionOrder("serving", "paid"), true);

  // (4) 而 `accepted → serving` 这条**在表里为真**的边，对不满足 Guard 的调用照样被拒：
  //     —— 别人的单（accepted 起点，但不是我的）
  const mine = await acceptedOrder(COMPANION_A);
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_B,
        orderId: mine.order.id,
        at: plusMinutes(mine.acceptedAt, 30),
      })
    ).kind,
    "not-found",
  );
  //     —— 我的单，但起点不是 accepted
  const cancelled = await acceptedOrder(COMPANION_A);
  await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: cancelled.order.id,
    reason: "临时有事",
    idempotencyKey: uniqueKey(),
    at: plusMinutes(cancelled.acceptedAt, 5),
  });
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_A,
        orderId: cancelled.order.id,
        at: plusMinutes(cancelled.acceptedAt, 30),
      })
    ).kind,
    "not-found",
    "归属已经解除：`canTransitionOrder` 回答得了这条边，回答不了「这一张单」",
  );
});

// ———————————————————— 五、P0-6 / P0-6.1 不回归 ————————————————————

test("开始 9：P0-6 主动取消链不回归——取消之前照旧能取消，两条路径互不干扰", async () => {
  const { user, order, acceptedAt } = await acceptedOrder(COMPANION_A);
  const cancelledAt = plusMinutes(acceptedAt, 10);

  // 取消**之前**：走完整服务链路的取消照旧成功，四件事一件不少
  const cancelled = await cancelCompanionOrder(COMPANION_A, order.id, {
    reason: "临时有事无法服务",
    idempotencyKey: uniqueKey(),
  });
  assert.equal(cancelled.kind, "ok");
  assert.equal(cancelled.changed, true);

  const after = await orderOf(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.acceptedAt, null);
  assert.equal(after.actualCompanionId, null);
  assert.equal(after.companion, null);
  assert.equal(after.servingAt, null, "一次取消不得留下开始时间");
  assert.equal((await dispatchOf(order.id)).state, "public", "取消把这一单送回公共池");
  assert.equal((await releasesOf(order.id)).length, 1, "退出历史恰好一条");

  // 取消**之后**：开始服务不会成为绕回这条单的第二条路（用例 5 也从另一个角度钉了它），
  // 而且这一次失败不再产生任何副作用
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_A,
        orderId: order.id,
        at: cancelledAt,
      })
    ).kind,
    "not-found",
  );
  assert.equal((await releasesOf(order.id)).length, 1, "被拒的开始服务不得添第二条退出历史");
  assert.equal(
    (await notificationsOf(user)).filter(
      (item) => item.title === DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED.title,
    ).length,
    1,
    "取消那条通知与开始服务无关，仍然只有一条",
  );

  // 反过来也一样：已经开始的单，取消那条路上不会留下任何东西（用例 6 的结论在这里复用一句）
  const other = await acceptedOrder(COMPANION_A);
  await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: other.order.id,
    at: plusMinutes(other.acceptedAt, 30),
  });
  assert.equal(
    (
      await cancelAcceptedOrder({
        companionId: COMPANION_A,
        orderId: other.order.id,
        reason: "想取消",
        idempotencyKey: uniqueKey(),
        at: plusMinutes(other.acceptedAt, 60),
      })
    ).kind,
    "not-accepted",
  );
  assert.equal((await orderOf(other.order.id)).status, "serving", "取消不得把 serving 拉回 paid");
  assert.deepEqual(await releasesOf(other.order.id), []);
});

// ——————————————— 六、结构约束与批次禁令（源码门禁） ———————————————

/**
 * 取某个导出函数的函数体（到下一个导出声明的开头为止）。
 *
 * 文件级的 `includes` 是不够的：一个文件里同时住着「发通知的取消」与「不发通知的
 * 开始服务」，只扫整串就等于让前者的调用替后者背书——而这两条路径的差异
 * 恰恰是本轮要钉住的东西。因此必须先切出函数体再断言。
 *
 * 同步与异步、`function` 与 `const` 三种写法都要认（浏览器端的 `startCompanionOrderRequest`
 * 就是同步的 `export function`）。
 */
function functionBody(code, name) {
  const start = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(code);
  assert.ok(start, `找不到 ${name}：结构约束无法判定`);

  const rest = code.slice(start.index + 1);
  const next = rest.search(/export\s+(?:async\s+)?(?:function|const|let|var|type)\s/);
  return next === -1 ? code.slice(start.index) : code.slice(start.index, start.index + 1 + next);
}

/**
 * 调用点里的**顶层实参**个数。
 *
 * 直接数逗号是不行的：调用点是多行格式，**单个实参后面的尾随逗号**也是逗号，
 * 而它是排版不是实参。因此判据是「顶层（括号外）逗号切出来的非空片段数」——
 * 尾随逗号后面没有内容，那一段是空的。
 */
function argumentCount(call) {
  const content = call.slice(call.indexOf("(") + 1);
  const segments = [];
  let current = "";
  let depth = 0;

  for (const ch of content) {
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) break; // 调用结束
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.filter((segment) => segment.trim() !== "").length;
}

/** Next.js 只把 HTTP 方法名导出当路由处理函数；别的导出名不是方法。 */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * 这个文件**导出**的 HTTP 方法（去重、排序）。
 *
 * 与 `tests/companion.test.mjs` 的同名 helper 同一判据（三种导出写法都要认，
 * 缺一种就是一个可以被绕过的洞）。这里保留一份本地实现，是因为**测试文件之间不互相
 * import**：import 一个测试文件会把它里面的用例再注册一遍。
 * 清单本身（地址 × 方法 × 守卫）的门禁在那里，本文件只判**写入口的集合**。
 */
function exportedMethods(source) {
  const code = stripComments(source);
  const found = new Set();
  const add = (name) => {
    if (HTTP_METHODS.has(name)) found.add(name);
  };

  for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1]);
  }
  for (const match of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/g)) {
    add(match[1]);
  }
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const clause of match[1].split(",")) {
      const raw = clause.trim();
      if (!raw) continue;
      const parts = raw.split(/\s+as\s+/);
      add((parts[1] ?? parts[0]).trim());
    }
  }

  return [...found].sort();
}

/** 相对 `app/api/companion/` 的路径，统一用 `/`，Windows 与 POSIX 下结果一致。 */
function relativeCompanionRoute(file) {
  return path.relative(path.join(ROOT, "app", "api", "companion"), file).replace(/\\/g, "/");
}

test("开始 10：身份只可能来自会话——服务层没有 body，事务层的身份输入只有 `companionId` 一个", () => {
  const serviceCode = stripComments(readSource(path.join(ROOT, "lib", "services", "companionOrders.ts")));
  const serviceBody = functionBody(serviceCode, "startCompanionOrder");
  const routeCode = stripComments(
    readSource(path.join(ROOT, "app", "api", "companion", "orders", "[id]", "start", "route.ts")),
  );

  // (1) 服务层：没有 body 可读，因此也没有「哪些字段合法」这一类规则要维护
  assert.equal(serviceBody.includes("idempotencyKey"), false, "开始服务没有幂等键：幂等判据是状态本身（D2）");
  assert.equal(serviceBody.includes("body"), false, "开始服务不接受任何请求体字段");
  assert.equal(
    startCompanionOrder.length,
    2,
    "服务层只收「会话身份 + 订单 id」两个参数：多一个就是给调用方多一个可以声明的东西",
  );
  assert.ok(serviceBody.includes("new Date().toISOString()"));

  // (2) 接口：守卫是第一个动作，订单 id 只来自路径，身份只来自 requireCompanion()
  assert.ok(routeCode.includes("requireCompanion()"), "守卫必须真的被调用，而不只是被 import");
  assert.ok(
    routeCode.includes("startCompanionOrder(companion.companionId, id)"),
    "身份只能来自会话身份对象，订单 id 只能来自路径参数",
  );
  assert.equal(routeCode.includes("readJsonBody"), false, "调它会把「空体」判成非法，等于给这个接口发明一条必填体规则");
  assert.equal(routeCode.includes("request.json("), false);
  assert.equal(routeCode.includes("companionId:"), false, "接口里不得出现「从请求里取 companionId」这种写法");

  // (3) 事务层：归属判据是订单上的**事实**字段，不是调用方给的任何东西
  const txCode = stripComments(
    readSource(path.join(ROOT, "lib", "data", "companionOrderTransaction.ts")),
  );
  const txBody = functionBody(txCode, "startCompanionOrder");
  assert.equal(
    startCompanionOrderTransaction.length,
    1,
    "事务层只收一个上下文对象（对象解构的形参只有一个）",
  );
  assert.ok(
    txBody.includes("order.actualCompanionId !== ctx.companionId"),
    "归属必须比的是订单上的实际履约人",
  );
  assert.equal(
    /\bawait\b/.test(txBody),
    false,
    "原子区段里出现任何一个 await 就是把「读—判断—写」拆到两个 tick 上",
  );
});

test("开始 11：写入口门禁——`orders/**` 下恰好三个，且 start 的接口与浏览器端都不发明幂等键", () => {
  // (1) 一个 route 文件导出 POST 就说明「打手点一下能推进订单」。到 P0-8 为止有三个：
  //     `accepted → paid`（取消）、`accepted → serving`（开始服务）与
  //     `serving → completed` 的入口（提交完成材料，P0-8）。
  //     状态表里还允许的其它边都是后续 Round，有人提前落地时这条会先变红，
  //     于是同时更新档案与进度表。
  const writeEntries = collectFiles(path.join(ROOT, "app", "api", "companion", "orders"))
    .filter((file) => file.endsWith("route.ts"))
    .filter((file) => exportedMethods(readSource(file)).includes("POST"))
    .map(relativeCompanionRoute)
    .sort();

  assert.deepEqual(
    writeEntries,
    ["orders/[id]/cancel/route.ts", "orders/[id]/completion/route.ts", "orders/[id]/start/route.ts"],
    "orders 下多了一个写入口：其余动作（确认完成等）都是后续 Round 的范围",
  );

  // (2) start 这条路自己只导出 POST（多一个方法就是多一种调用方式）
  assert.deepEqual(
    exportedMethods(readSource(path.join(ROOT, "app", "api", "companion", "orders", "[id]", "start", "route.ts"))),
    ["POST"],
  );

  // (3) 浏览器端不生成任何键：D2 明确本轮**不引入新的幂等键字段**，
  //     给这个请求编一个键等于替服务端发明一条它并不要求的规则
  const httpCode = stripComments(readSource(path.join(ROOT, "lib", "services", "companionHttp.ts")));
  const requestBody = functionBody(httpCode, "startCompanionOrderRequest");
  assert.equal(requestBody.includes("idempotencyKey"), false, "开始服务的请求里不该有任何幂等键");
  assert.ok(requestBody.includes("/start"), "请求打的是本轮冻结的那个地址");

  // 调用点**只有一个实参**：`apiPost(url)`。第二个实参就是请求体，
  // 也就等于替服务端发明一条它并不要求的规则（取消那条路就带着 `input`）
  assert.equal(
    argumentCount(requestBody.slice(requestBody.indexOf("apiPost<"))),
    1,
    "开始服务不带请求体：`apiPost(url)` 只有一个实参",
  );
});

test("开始 12：start 路径上不引用任何通知常量；通知常量集合共七条，每条都有自己的主人（P0-11 起）", () => {
  const txCode = stripComments(
    readSource(path.join(ROOT, "lib", "data", "companionOrderTransaction.ts")),
  );
  const txBody = functionBody(txCode, "startCompanionOrder");

  // (1) 事务层的 start 路径上不得出现任何通知写入或通知常量。
  //     只在整个文件的源码串上 `includes` 是不够的：那会让取消路径上的通知调用
  //     替开始服务背书——而这两条路径「发不发通知」恰恰是相反的。
  //     ⚠️ 这一半**不随时间放宽**：P0-11 一次加了三条通知，start 路径仍然一条都没碰。
  for (const forbidden of ["Notification", "appendNotification", "planNotification", "DISPATCH_NOTIFICATION"]) {
    assert.equal(
      txBody.includes(forbidden),
      false,
      `开始服务不发通知（需求未冻结任何开始服务的生命周期通知）：不得出现 ${forbidden}`,
    );
  }

  const serviceCode = stripComments(readSource(path.join(ROOT, "lib", "services", "companionOrders.ts")));
  assert.equal(functionBody(serviceCode, "startCompanionOrder").includes("Notification"), false);

  // (2) 通知常量集合是一份**可清点的名册**：每一条都要说得出它属于哪条路径。
  //
  // ⚠️ P0-7 时这里断言的是「四条，一条都不许长大」，理由是「开始服务」不在其中。
  // P0-11 按 `cmd_p0-11.md` 加了三条，名册因此长大——但**长法是有方向的**：
  // 新增的三条全都属于「这一单失去了当前履约人」这一类事件
  // （客服退回公共池 / 客服指定换人 / 封禁回池），与「开始服务」无关。
  // 所以这里不是把数字改大，而是改成逐条点名 + 断言 start 的那一条仍然不在名册里。
  const notificationConstants = [
    ...stripComments(readSource(path.join(ROOT, "lib", "constants", "dispatch.ts"))).matchAll(
      /export const (DISPATCH_NOTIFICATION_[A-Z_]+)/g,
    ),
  ]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(notificationConstants, [
    // P0-7：打手取消接单 → 告诉下单用户「你的护航不再接这一单了」
    "DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED",
    // P0-7：打手接单 → 告诉下单用户「有人接了」
    "DISPATCH_NOTIFICATION_ACCEPTED",
    // P0-11：封禁护航时批量回池 → 逐单告诉下单用户
    "DISPATCH_NOTIFICATION_COMPANION_DISABLED",
    // P0-7：独占期超时 → 回公共池
    "DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT",
    // P0-7：公共池无人接单超时
    "DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT",
    // P0-11：客服退回公共池 / 客服指定换人 → 都告诉下单用户「你的护航换了」
    "DISPATCH_NOTIFICATION_STAFF_REASSIGNED",
    "DISPATCH_NOTIFICATION_STAFF_REPLACED",
  ]);

  // 名册里**没有**「开始服务」。将来产品真的要求补一条，那是新增一条产品通知，
  // 必须在那一轮里单独确认，不得顺手加——这条断言就是那个「顺手」的刹车。
  assert.equal(
    notificationConstants.includes("DISPATCH_NOTIFICATION_SERVING_STARTED"),
    false,
    "开始服务仍然没有生命周期通知；要加必须先有产品确认，不能顺手",
  );
});

test("开始 13：UI 只按服务端旗标显示入口，且开始服务成功后刷新、取消成功后不刷新（D7）", () => {
  const pageCode = stripComments(
    readSource(path.join(ROOT, "app", "companion", "(console)", "orders", "[id]", "page.tsx")),
  );
  const panelCode = stripComments(
    readSource(path.join(ROOT, "components", "companion", "CompanionOrderStartPanel.tsx")),
  );
  const cancelPanelCode = stripComments(
    readSource(path.join(ROOT, "components", "companion", "CompanionOrderCancelPanel.tsx")),
  );

  // (1) 两个入口都由服务端算好的旗标决定，页面不自己用状态推断
  assert.ok(pageCode.includes("detail.canStart"), "「开始服务」入口必须读服务端的 canStart");
  assert.ok(pageCode.includes("detail.canCancel"), "「取消接单」入口必须读服务端的 canCancel");

  // (2) 面板只负责交互：没有本地状态判定，也没有幂等键（它没有键可带）
  assert.ok(panelCode.includes("startCompanionOrderRequest"));
  assert.equal(panelCode.includes("idempotencyKey"), false);
  assert.equal(/status\s*===/.test(panelCode), false, "前端不得自己用订单状态推断能不能点");

  // (3) 两处**刻意相反**：开始服务之后这一单仍然是他的，刷新正是让页面反映 serving、
  //     让两个入口一起消失的正确做法；取消之后这一单已经不属于他，刷新会把成功反馈
  //     换成「订单不存在」。方向反了就会出现「点完说成功、页面说订单不存在」
  assert.ok(panelCode.includes("router.refresh()"), "开始服务成功后必须刷新页面");
  assert.equal(cancelPanelCode.includes("router.refresh("), false, "取消成功后不得刷新页面");
});

test("开始 14：本轮不做 `completion_review`——状态集合与迁移表仍然恰好是那五个状态", () => {
  // (1) 标签表恰好五个键：`completed` 的完成材料 / 完成审核属于 P0-8，
  //     提前加一个状态会让「订单状态」这件事在两个 Round 里各有一半定义
  assert.deepEqual(Object.keys(ORDER_STATUS_LABELS).sort(), [
    "accepted",
    "completed",
    "paid",
    "refunded",
    "serving",
  ]);

  // (2) 全仓（`lib/` 与 `app/`）代码里不出现 `completion_review`。
  //     注释先剥掉：那句标识符作为**代码**出现才是「偷偷实现了下一轮」，
  //     而注释里写「P0-8 会加 completion_review」是无害的
  const offenders = [
    ...collectFiles(path.join(ROOT, "lib")),
    ...collectFiles(path.join(ROOT, "app")),
  ]
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .filter((file) => stripComments(readSource(file)).includes("completion_review"))
    .map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));

  assert.deepEqual(offenders, [], "`completion_review` 属于 P0-8：本轮不得出现在任何代码里");
});

// ——————————————— 七、HTTP 权限矩阵（需要 APP_BASE_URL） ———————————————

/**
 * 未登录 / 不是打手这两种拒绝**只有真跑服务才能验证**：
 * 守卫建立在用户会话（`cookies()`）之上，进程内的数据层测试拿不到会话。
 * 因此这一节与 `http-smoke.test.mjs` 同一取舍：没设 `APP_BASE_URL` 时自动跳过，
 * 而不是伪装成通过。
 */
const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过打手 start 接口的权限矩阵";

async function loginAs(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

/**
 * u-1001 是预置普通用户：预置护航里没有一条的 userId 指向它
 * （`cp-*` 大多为 null，有关联的只有 `cp-10` / `cp-11` → u-1022 / u-1023）。
 * u-1022 名下是 `cp-10`（`enabled` / `available` 都为 true），一个**有效打手**。
 */
const SESSION_PLAIN = BASE ? await loginAs("u-1001") : null;
const SESSION_COMPANION = BASE ? await loginAs("u-1022") : null;
const SKIP_SESSION =
  SKIP || (SESSION_PLAIN ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

/**
 * 开始服务**没有请求体**。下面三个调用点刻意发出三种不同的「体」：
 * `none`（什么都不发）、`{}`、以及一个伪造了身份与幂等键的体。
 *
 * 三者必须得到**完全相同**的结果——守卫先于请求体的任何解读，
 * 而「体里塞了 companionId」必须一点作用都没有（身份只来自会话）。
 */
const START_BODIES = [
  ["none", undefined],
  ["empty", "{}"],
  ["forged", JSON.stringify({ companionId: "cp-2", idempotencyKey: "p07-http-key-1" })],
];

function startRequest(orderId, { cookie, body } = {}) {
  return fetch(new URL(`/api/companion/orders/${encodeURIComponent(orderId)}/start`, BASE), {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body,
  });
}

test("权限矩阵：未登录调开始服务接口是 401（不是 403，也不是 200）", { skip: SKIP }, async () => {
  for (const [label, body] of START_BODIES) {
    const response = await startRequest("ord-p07-not-exist", { body });
    assert.equal(response.status, 401, `未登录（体：${label}）应当 401`);
    const payload = await response.json();
    assert.equal(payload.error.code, "UNAUTHORIZED", `体：${label} 的错误码`);
    assert.ok(payload.error.message, "错误信封必须有可展示的文案");
  }
});

test("权限矩阵：登录了但不是打手的普通用户拿到 403", { skip: SKIP_SESSION }, async () => {
  for (const [label, body] of START_BODIES) {
    const response = await startRequest("ord-p07-not-exist", { cookie: SESSION_PLAIN, body });
    assert.equal(response.status, 403, `非打手（体：${label}）应当 403`);
    const payload = await response.json();
    assert.equal(payload.error.code, "FORBIDDEN", `体：${label} 的错误码`);
  }
});

test("权限矩阵：有效打手也只能拿到 404——身份塞不进请求体，别人的单一个字段都不动", { skip: SKIP_SESSION }, async () => {
  assert.ok(SESSION_COMPANION, "DEV-1 预置的有效打手账号 u-1022 必须能登录");

  // (a) 不存在的订单：三种体都必须得到 404 与**那一句冻结的文案**
  for (const [label, body] of START_BODIES) {
    const response = await startRequest("ord-p07-not-exist", { cookie: SESSION_COMPANION, body });
    assert.equal(response.status, 404, `不存在的订单（体：${label}）应当 404`);
    const payload = await response.json();
    assert.equal(payload.error.code, "NOT_FOUND", `体：${label} 的错误码`);
    assert.equal(payload.error.message, COMPANION_ORDER_NOT_FOUND_MESSAGE);
  }

  // (b) **真实存在、状态恰好是 accepted** 但归另一位打手（cp-2）的单：
  //     请求体里把 `companionId` 写成 cp-2 也一点用都没有——身份只来自会话
  const forged = await startRequest(SEEDED_ACCEPTED_OF_B, {
    cookie: SESSION_COMPANION,
    body: JSON.stringify({ companionId: "cp-2" }),
  });
  assert.equal(forged.status, 404, "不是本人实际履约 → 404，与「订单不存在」同一句话");
  const forgedPayload = await forged.json();
  assert.equal(forgedPayload.error.code, "NOT_FOUND");

  // (c) 订单没有被改动：它的所有者（u-1001）看到的状态与时间轴都没变
  const ownerView = await fetch(new URL(`/api/orders/${SEEDED_ACCEPTED_OF_B}`, BASE), {
    headers: { cookie: SESSION_PLAIN },
  });
  assert.equal(ownerView.status, 200);
  const ownerPayload = await ownerView.json();
  assert.equal(ownerPayload.data.status, "accepted", "被拒的开始服务不得把别人的单推进到 serving");
  assert.equal(
    ownerPayload.data.timeline.some((node) => node.key === "serving"),
    false,
    "时间轴上不得凭空多出「护航中」",
  );
});
