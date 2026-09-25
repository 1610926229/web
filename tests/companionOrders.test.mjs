import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
  DISPATCH_NOTIFICATION_ACCEPTED,
  COMPANION_ACCEPT_NOTICE,
  COMPANION_CANCEL_REASON_REQUIRED_MESSAGE,
  COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE,
  COMPANION_ORDER_NOT_FOUND_MESSAGE,
  plusMinutes,
} from "../lib/constants/dispatch.ts";
import { canEnterAdminConsole } from "../lib/constants/admin.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, IDEMPOTENCY_KEY_PATTERN } from "../lib/constants/writes.ts";
import { acceptDispatch, sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import { cancelAcceptedOrder } from "../lib/data/companionOrderTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { updateAdminPlatformConfig } from "../lib/services/adminPlatformConfig.ts";
import { getAdminOrderDetail } from "../lib/services/adminOrders.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  acceptDispatchForCompanion,
  listCompanionPools,
} from "../lib/services/companionDispatch.ts";
import {
  cancelCompanionOrder,
  getCompanionOrderDetail,
  listCompanionOrders,
} from "../lib/services/companionOrders.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-6「打手在 accepted 阶段主动取消接单 + 订单重新进入公共池」的持续测试。
 *
 * ## 这一批真正要钉住的是什么
 *
 * 一次成功取消必须**同时**成立四件事（`lib/data/companionOrderTransaction.ts` 头部）：
 *
 * 1. 退出历史写一条（谁退的、为什么、什么时候）；
 * 2. 订单履约绑定解除（`status: paid` / `acceptedAt` / `actualCompanionId` / `companion`）；
 * 3. 派单回到公共池，并按**此刻**的平台配置重冻三个 public 字段；
 * 4. 下单用户收到一条通知。
 *
 * 少任何一件都会留下自相矛盾的状态：「订单没主了但派单还说被 A 接了」、
 * 「派单空着但订单还挂在 A 名下」、「客服再也答不出刚才那个人为什么走了」、
 * 「用户以为还有人给他做」。因此下面每一条用例都尽量**一次断言四件事**，
 * 而不是各自只看一个字段。
 *
 * 另外两条不变量单独钉：
 *
 * - **归属判定先于状态判定**（`not-found` 在 `not-accepted` 之前）：顺序反了的话，
 *   拿别人的订单 id 就能从「404」与「400」的差别里试探出这一单是否存在；
 * - **幂等索引只认「同一打手 + 同一个键」**：它是让「连点两次」返回第一次结果的那条
 *   路径，而真正的安全边界始终是状态与归属（键是调用方给的一个串，状态是事实）。
 *
 * ## 时间怎么控制
 *
 * 一次都不等真实时间。需要精确时刻的用例直接调伪事务 `cancelAcceptedOrder`
 * 并显式传入 `at`（它本来就是服务层的入参来源）；需要走完整服务链路的用例
 * 用 `cancelCompanionOrder`，只断言「第一次的时刻」这类相对性质。
 *
 * ## 用例之间怎么隔离
 *
 * Mock 仓储在同一进程内共享，而预置数据里本来就有挂在 `cp-1` 名下的订单。
 * 因此：写操作一律落在**自己新下的单**上，断言一律不依赖全局列表长度；
 * 平台参数是单例，关心超时时长的用例先把它设成自己需要的值。
 * 少数只读用例会用到预置订单（`serving` / `completed` / `refunded` 无法在 P0-6 里造出来，
 * 因为推进状态的入口正是本轮明确不做的东西）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的两位，`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

/** 预置数据里挂在 `cp-1` 名下、且**不能**走主动取消的那三种状态。 */
const SEEDED_SERVING = "ord-seed-1001-10"; // serving
const SEEDED_COMPLETED = "ord-seed-1001-05"; // completed
const SEEDED_REFUNDED = "ord-seed-1009-01"; // refunded

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

/**
 * 一个合法且唯一的幂等键。
 *
 * 形如 `p06key-12345`（字母 + 数字 + 连字符），因此同时满足
 * `IDEMPOTENCY_KEY_PATTERN` 与「每次调用都不一样」两个条件——
 * 后者是必须的：用同一个键去测两条不同的取消，第二次会被当成重放。
 */
function uniqueKey() {
  return unique("p06key");
}

function uniqueUser() {
  return unique("u-p06");
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

async function notificationsOf(userId) {
  return getNotificationRepository().listNotifications(userId);
}

/** 这一次取消产生的用户通知（按标题认，不按条数——接单成功也会发通知）。 */
async function releaseNotifications(userId) {
  return (await notificationsOf(userId)).filter(
    (item) => item.title === DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED.title,
  );
}

/** 管理端改公共池超时。走真实服务，因此取值校验与幂等键都是真的。 */
async function setPublicTimeoutMinutes(minutes) {
  const result = await updateAdminPlatformConfig(unique("p06adm"), {
    publicPoolTimeoutMinutes: minutes,
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true, "这条用例需要配置真的被改动");
  assert.equal(result.config.publicPoolTimeoutMinutes, minutes);
}

/**
 * 「一张由 `companionId` 接下的新订单」——本文件几乎所有用例的起点。
 *
 * 返回 `acceptedAt`，调用方据此推算取消、重新接单等后续时刻，
 * 从而整条链路都不依赖真实执行时间。
 */
async function acceptedOrder(companionId, user = uniqueUser(), overrides = {}) {
  const order = await placeOrder(user, overrides);
  const dispatch = await dispatchOf(order.id);
  const acceptedAt = plusMinutes(order.paidAt, 1);

  const result = await acceptDispatch(dispatch.id, { companionId, at: acceptedAt });
  assert.equal(result.kind, "ok", "这条用例需要一次成功的接单");

  const after = await orderOf(order.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.actualCompanionId, companionId);
  return { user, order, dispatchId: dispatch.id, acceptedAt };
}

/** 断言一个取消请求以指定的错误码 / 状态码 / 文案被拒绝，并返回那个错误。 */
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
  return expectApiError(run, { code: "NOT_FOUND", status: 404, message: COMPANION_ORDER_NOT_FOUND_MESSAGE });
}

/** 是本人的单但状态不对 → 400（不是重放，是「点了此刻不该存在的按钮」）。 */
function expectNotCancellable(run) {
  return expectApiError(run, {
    code: "BAD_REQUEST",
    status: 400,
    message: COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE,
  });
}

/** 参数本身非法（原因或幂等键）→ 400。 */
function expectBadRequest(run, message) {
  return expectApiError(run, { code: "BAD_REQUEST", status: 400, message });
}

// ——————————————————————— 一、一次成功取消的四件事 ———————————————————————

test("取消 1：本人取消 accepted 订单——订单退回 paid、履约绑定全清、派单回公共池、退出历史恰好一条", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  const cancelledAt = plusMinutes(order.paidAt, 5);
  const reason = "临时有事无法服务";

  const outcome = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason,
    idempotencyKey: uniqueKey(),
    at: cancelledAt,
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.changed, true, "这一次真的改了东西");
  assert.equal(outcome.status, "paid");
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.orderNo, order.orderNo, "回给打手的是他会认得的那个订单号");
  assert.equal(outcome.cancelledAt, cancelledAt);

  // (2) Order：四个字段同进同退（D2）。只回写其中一个，就成了一条永远对不齐的不变量
  const after = await orderOf(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.acceptedAt, null, "残留的 acceptedAt 会让用户详情页显示「已接单」");
  assert.equal(after.actualCompanionId, null);
  assert.equal(after.companion, null, "残留的履约快照会让列表出现一个并不在履约的打手");

  // (3) Dispatch：回公共池，且**当前接单**的绑定被清空（state=public 却留着接单人是自相矛盾）
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.acceptedByCompanionId, null);
  assert.equal(dispatch.acceptedAt, null);

  // (1) 退出历史：恰好一条，七个字段逐个核（`database-schema.md` T4 的字段表）
  const releases = await releasesOf(order.id);
  assert.equal(releases.length, 1, "一次成功取消恰好写一条历史");
  const [release] = releases;
  assert.equal(release.id, outcome.releaseRecordId, "返回的 id 就是写下去的那一条");
  assert.equal(release.orderId, order.id);
  assert.equal(release.companionId, COMPANION_A, "记的是退出时正在履约的人");
  assert.equal(release.source, "companion_cancel");
  assert.equal(release.reason, reason);
  assert.equal(release.actorId, COMPANION_A, "主动取消的触发者就是打手本人");
  assert.equal(release.createdAt, cancelledAt);
  assert.deepEqual(
    Object.keys(release).sort(),
    ["actorId", "companionId", "createdAt", "id", "orderId", "reason", "source"],
    "历史只有七个字段：幂等键是 store 级索引，不是记录上的字段",
  );
});

test("取消 2：回池按**当下**平台配置重冻三个 public 字段，exclusive 三个字段一个都不动", async () => {
  // 指定 A → 专属池。到点转公共池后由 B 接走，这样 exclusive 与 accepted 两个事实同时存在
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(23);

  const user = uniqueUser();
  const order = await placeOrder(user, { companionId: COMPANION_A });
  const initial = await dispatchOf(order.id);

  sweepExpiredDispatches(initial.exclusiveDeadlineAt);
  const entered = await dispatchOf(order.id);
  const acceptedAt = plusMinutes(entered.publicPoolEnteredAt, 1);
  const accepted = await acceptDispatch(entered.id, { companionId: COMPANION_B, at: acceptedAt });
  assert.equal(accepted.kind, "ok");

  // 接单之后管理员把公共池超时改成 4 分钟：改的是**之后重新进池**那一刻的规则
  await setPublicTimeoutMinutes(4);

  const cancelledAt = plusMinutes(acceptedAt, 1);
  const outcome = await cancelAcceptedOrder({
    companionId: COMPANION_B,
    orderId: order.id,
    reason: "临时有事",
    idempotencyKey: uniqueKey(),
    at: cancelledAt,
  });
  assert.equal(outcome.kind, "ok");

  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.publicPoolEnteredAt, cancelledAt, "重新进池的时刻就是取消那一刻");
  assert.equal(
    dispatch.publicTimeoutMinutesSnapshot,
    4,
    "用的是取消那一刻的配置，不是下单时那份 23——否则就是第二套 timeout 算法",
  );
  assert.equal(dispatch.publicDeadlineAt, plusMinutes(cancelledAt, 4));

  // exclusive 是「用户当初指定了谁」的历史事实：转池、被接单、被退出都不许改它
  assert.equal(dispatch.exclusiveCompanionId, COMPANION_A);
  assert.equal(dispatch.exclusiveEnteredAt, initial.exclusiveEnteredAt);
  assert.equal(dispatch.exclusiveDeadlineAt, initial.exclusiveDeadlineAt);
});

// ——————————————————————— 二、幂等 ———————————————————————

test("取消 3：同一幂等键第二次到达返回第一次的结果——不新增记录、不重复通知、不刷新 deadline", async () => {
  const { user, order } = await acceptedOrder(COMPANION_A);
  const key = uniqueKey();

  const first = await cancelCompanionOrder(COMPANION_A, order.id, { reason: "临时有事", idempotencyKey: key });
  assert.equal(first.kind, "ok");
  const dispatchAfterFirst = await dispatchOf(order.id);

  const second = await cancelCompanionOrder(COMPANION_A, order.id, { reason: "临时有事", idempotencyKey: key });
  assert.equal(second.kind, "replayed", "同一次意图第二次到达是重放，不是错误");
  assert.equal(second.changed, false);
  assert.equal(second.releaseRecordId, first.releaseRecordId);
  assert.equal(second.cancelledAt, first.cancelledAt, "返回的是**第一次**的时刻，不是现在");
  assert.equal(second.status, "paid");
  assert.equal(second.orderNo, order.orderNo);

  // 一个字节都没写：连 `updatedAt` 都不该动（deepEqual 比的是整条记录）
  assert.deepEqual(
    await dispatchOf(order.id),
    dispatchAfterFirst,
    "重放不得刷新 publicPoolEnteredAt / publicDeadlineAt，也不得动任何其它字段",
  );
  assert.equal((await releasesOf(order.id)).length, 1, "重放不得写第二条退出历史");
  assert.equal((await releaseNotifications(user)).length, 1, "重放不得重复通知用户");
  assert.equal((await orderOf(order.id)).status, "paid");
});

test("取消 4：幂等键的作用域是**打手**——别人拿同一个键重放不到我的取消", async () => {
  const { order: orderA } = await acceptedOrder(COMPANION_A);
  const sharedKey = uniqueKey();
  const byA = await cancelCompanionOrder(COMPANION_A, orderA.id, { reason: "有事", idempotencyKey: sharedKey });
  assert.equal(byA.kind, "ok");

  const { order: orderB } = await acceptedOrder(COMPANION_B);
  // B 用**同样的键字符串**提交**另一张自己的单**：这不是重放，是一次真的取消。
  // 若索引按「键」而不是「打手 + 键」作用域，B 会收到 A 那一次的结果，
  // 而系统里那张单根本没被取消——用户看到的是别人订单的状态
  const byB = await cancelCompanionOrder(COMPANION_B, orderB.id, { reason: "他也有事", idempotencyKey: sharedKey });
  assert.equal(byB.kind, "ok");
  assert.equal(byB.changed, true);
  assert.notEqual(byB.releaseRecordId, byA.releaseRecordId);

  assert.equal((await orderOf(orderB.id)).status, "paid");
  assert.equal((await releasesOf(orderB.id)).length, 1);
  assert.equal((await releasesOf(orderA.id)).length, 1, "A 那一条不受影响");
});

test("取消 5：归属判定先于状态判定——取消之后换个新键再取消同一单是 404，不是 400", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  await cancelCompanionOrder(COMPANION_A, order.id, { reason: "有事", idempotencyKey: uniqueKey() });

  // 新键 ⇒ 幂等索引未命中 ⇒ 走到订单判定。此时 `actualCompanionId` 已被清空，
  // 「不是本人实际履约」先于「状态不是 accepted」成立，因此结果必须是 404。
  //
  // 这条顺序是冻结的（`cancelAcceptedOrder` 的判定次序 + D5）：反过来的话，
  // 同一个订单 id 在「曾经属于我」与「从来不属于我」两种情况下会给出不同的错误码，
  // 那本身就是一个可以用别人的订单 id 探测存在性的通道。
  await expectNotFound(() =>
    cancelCompanionOrder(COMPANION_A, order.id, { reason: "再取消一次", idempotencyKey: uniqueKey() }),
  );
  assert.equal((await releasesOf(order.id)).length, 1, "被 404 的那次一个字节都没写");
});

// ——————————————————————— 三、谁不能取消 ———————————————————————

test("取消 6：不是本人实际履约的一律 404——别人接的单、不存在的单、以及只是「用户指定给我」", async () => {
  // (a) 别人接的单
  const mine = await acceptedOrder(COMPANION_A);
  await expectNotFound(() =>
    cancelCompanionOrder(COMPANION_B, mine.order.id, { reason: "想取消", idempotencyKey: uniqueKey() }),
  );

  // (b) 根本不存在的订单：与 (a) **同一句话、同一个状态码**
  await expectNotFound(() =>
    cancelCompanionOrder(COMPANION_A, "ord-根本不存在", { reason: "想取消", idempotencyKey: uniqueKey() }),
  );

  // (c) 用户结算时指定了我，但我从没接：`exclusiveCompanionId === 我` **不等于**订单归我
  const specified = await placeOrder(uniqueUser(), { companionId: COMPANION_A });
  const beforeSpecified = await orderOf(specified.id);
  assert.equal(beforeSpecified.actualCompanionId, null, "指定不等于接单");
  assert.equal((await dispatchOf(specified.id)).exclusiveCompanionId, COMPANION_A);
  await expectNotFound(() =>
    cancelCompanionOrder(COMPANION_A, specified.id, { reason: "想取消", idempotencyKey: uniqueKey() }),
  );

  // 三次失败都不得留下写入痕迹
  for (const orderId of [mine.order.id, specified.id]) {
    assert.deepEqual(await releasesOf(orderId), []);
  }
  assert.equal((await orderOf(mine.order.id)).status, "accepted", "别人的单仍然是他的");
  assert.equal((await orderOf(mine.order.id)).actualCompanionId, COMPANION_A);
  assert.deepEqual(await releaseNotifications(mine.user), [], "被拒的取消不得发出通知");
});

test("取消 7：serving / completed / refunded 都不是「可取消」——本人也拿 400，且订单一个字段都不回退", async () => {
  const cases = [
    [SEEDED_SERVING, "serving"],
    [SEEDED_COMPLETED, "completed"],
    [SEEDED_REFUNDED, "refunded"],
  ];

  for (const [orderId, expected] of cases) {
    const before = await orderOf(orderId);
    // 用例素材本身要先成立：这三单确实是挂在 cp-1 名下的那三种状态
    assert.equal(before.status, expected, `${orderId} 的预置状态应当是 ${expected}`);
    assert.equal(before.actualCompanionId, COMPANION_A);

    await expectNotCancellable(() =>
      cancelCompanionOrder(COMPANION_A, orderId, { reason: "想取消", idempotencyKey: uniqueKey() }),
    );

    // 把 serving / completed / refunded 拉回 paid 是绝对错误的：这不是重放，是状态回退
    assert.deepEqual(await orderOf(orderId), before, `${expected} 的订单不得被这次请求改动`);
    assert.deepEqual(await releasesOf(orderId), [], `${expected} 不该留下退出历史`);
  }

  // 第四种「不该能用这个动作」的状态是 `paid`——但它**不可能同时属于某位打手**：
  // `applyOrderAccepted` 是唯一写入 `actualCompanionId` 的地方，而它必然把状态写成
  // `accepted`；`applyOrderAcceptanceReleased` 清人时又必然把状态写回 `paid`。
  // 因此「paid + 实际打手是我」是一个数据模型上产生不出来的组合，
  // 一张 `paid` 的单对被取消者而言只可能是「与我无关」，走的是 404（见「取消 6」），
  // 而不是 400。这一条断言把这个结构事实钉住，免得将来有人为它编一条 400 分支
  const neverAccepted = await placeOrder(uniqueUser());
  assert.equal((await orderOf(neverAccepted.id)).status, "paid");
  assert.equal((await orderOf(neverAccepted.id)).actualCompanionId, null);
  await expectNotFound(() =>
    cancelCompanionOrder(COMPANION_A, neverAccepted.id, { reason: "想取消", idempotencyKey: uniqueKey() }),
  );
});

// ——————————————————————— 四、参数校验 ———————————————————————

test("取消 8：原因必填（缺失 / 空串 / 只有空白 / 非字符串都 400），但**没有**长度上限", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  const invalidReasons = [undefined, null, "", "   ", "\n\t  ", 123, {}, []];

  for (const reason of invalidReasons) {
    const body = { idempotencyKey: uniqueKey() };
    if (reason !== undefined) body.reason = reason;
    await expectBadRequest(() => cancelCompanionOrder(COMPANION_A, order.id, body), COMPANION_CANCEL_REASON_REQUIRED_MESSAGE);
  }

  assert.deepEqual(await releasesOf(order.id), [], "参数非法时一个字节都不该写");
  assert.equal((await orderOf(order.id)).status, "accepted", "校验失败不得动订单");
  assert.equal((await dispatchOf(order.id)).state, "accepted", "校验失败不得动派单");

  // 需求没有冻结字数（`01-prompt.md` §2.2 明令不许自造 5～50 / 10～200），
  // 因此一个很长的原因必须照收——拒绝它就是在实现一条没人定过的规则
  const long = "临时有事无法服务".repeat(150);
  const outcome = await cancelCompanionOrder(COMPANION_A, order.id, {
    reason: `  ${long}  `,
    idempotencyKey: uniqueKey(),
  });
  assert.equal(outcome.kind, "ok");
  assert.equal(
    (await releasesOf(order.id))[0].reason,
    long,
    "存的是 trim 之后的原文：没有被截断，也没有被改写",
  );
});

test("取消 9：幂等键必需且必须合法——用的是全站现有格式，不发明第二种", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  const invalidKeys = [
    undefined,
    null,
    "",
    "   ",
    "abc1234", // 7 位：差一位
    "a".repeat(65), // 65 位：多一位
    "带空格的 key",
    "键-中文",
    "key/with/slash",
  ];

  for (const key of invalidKeys) {
    // 用例素材本身要先成立：这些串确实过不了现有格式
    assert.equal(
      IDEMPOTENCY_KEY_PATTERN.test(typeof key === "string" ? key.trim() : ""),
      false,
      `${JSON.stringify(key)} 本来就不该是一个合法幂等键`,
    );
    const body = { reason: "临时有事" };
    if (key !== undefined) body.idempotencyKey = key;
    await expectBadRequest(() => cancelCompanionOrder(COMPANION_A, order.id, body), IDEMPOTENCY_KEY_MISSING_MESSAGE);
  }

  assert.deepEqual(await releasesOf(order.id), []);

  // 客户端实际会用的那种键（`crypto.randomUUID()`，形如带连字符的 36 位）必须合法：
  // 若服务端发明了一个更窄的格式，真实页面上的每一次取消都会 400
  const uuid = crypto.randomUUID();
  assert.equal(IDEMPOTENCY_KEY_PATTERN.test(uuid), true, "randomUUID 必须满足现有格式");
  const outcome = await cancelCompanionOrder(COMPANION_A, order.id, { reason: "临时有事", idempotencyKey: uuid });
  assert.equal(outcome.kind, "ok");
});

// ——————————————————————— 五、别的打手与用户能看到什么 ———————————————————————

test("取消 10：取消之后原打手的列表与详情都没有这一单，另一位合法打手能从公共池重新接走", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  const reason = `只该留在后台的原因-${process.pid}`;

  // 取消之前：详情取得到，且 `canCancel` 由服务端算好
  const before = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(before);
  assert.equal(before.status, "accepted");
  assert.equal(before.canCancel, true);

  const outcome = await cancelCompanionOrder(COMPANION_A, order.id, { reason, idempotencyKey: uniqueKey() });
  assert.equal(outcome.kind, "ok");

  // 原打手：列表与详情都取不到了。详情是**服务端重新校验**，不是「列表入口隐藏了」
  assert.equal(await getCompanionOrderDetail(COMPANION_A, order.id), null);
  assert.equal(
    (await listCompanionOrders(COMPANION_A)).items.some((item) => item.id === order.id),
    false,
    "退出之后这一单不再属于他",
  );
  // 别人一样取不到（不泄露存在性）
  assert.equal(await getCompanionOrderDetail(COMPANION_B, order.id), null);

  // 另一位合法打手：先能在公共池里看到，再真的把它接走（不是只断言派单 state）
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(dispatch.publicPoolEnteredAt, 1);
  const pools = await listCompanionPools(COMPANION_B, at);
  const poolItem = pools.public.find((item) => item.orderId === order.id);
  assert.ok(poolItem, "回池后的单必须重新出现在公共池里，否则这一单就没人能接了");
  assert.equal(
    JSON.stringify(poolItem).includes(reason),
    false,
    "公共池卡片不得带上一位打手为什么退出：那是内部信息",
  );

  const accepted = await acceptDispatchForCompanion(COMPANION_B, dispatch.id, at);
  assert.equal(accepted.kind, "ok");
  assert.equal(accepted.replayed, false);

  const finalOrder = await orderOf(order.id);
  const finalDispatch = await dispatchOf(order.id);
  assert.equal(finalOrder.status, "accepted");
  assert.equal(finalOrder.actualCompanionId, COMPANION_B);
  assert.equal(
    finalOrder.actualCompanionId,
    finalDispatch.acceptedByCompanionId,
    "订单与派单必须永远说的是同一个人",
  );
  assert.equal(await getCompanionOrderDetail(COMPANION_A, order.id), null, "原打手仍然不拥有它");
});

test("取消 11：打手端 DTO 是显式挑字段的——canCancel 由服务端算，金额域与归属内部字段一个都不在", async () => {
  const { order } = await acceptedOrder(COMPANION_A);

  const item = (await listCompanionOrders(COMPANION_A)).items.find((entry) => entry.id === order.id);
  assert.ok(item);
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "acceptedAt",
      "canCancel",
      "canStart",
      "gameName",
      "id",
      "orderNo",
      "paidAt",
      "productCoverUrl",
      "productTitle",
      "quantity",
      "region",
      "specName",
      "status",
      "statusLabel",
    ],
    "列表字段集变了：多出来的可能是隐私与账目，少掉的是接单要用的信息",
  );
  assert.equal(item.canCancel, true);
  // P0-7 的动作旗标与 canCancel 成对：`accepted` 上两者都为真
  assert.equal(item.canStart, true);
  assert.equal(item.statusLabel, "已接单");

  const detail = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(detail);
  assert.deepEqual(
    Object.keys(detail).sort(),
    [
      "acceptedAt",
      "addons",
      "addonsAmount",
      "canCancel",
      "canStart",
      "completion",
      "customerNickname",
      "gameAccountId",
      "gameName",
      "id",
      "itemsAmount",
      "orderNo",
      "paidAt",
      "productCoverUrl",
      "productTitle",
      "quantity",
      "region",
      "remark",
      "servingAt",
      "specName",
      "status",
      "statusLabel",
      "totalAmount",
      "unitPrice",
    ],
    "详情只比列表多「履约必需」的那几项",
  );

  // ⚠️ `servingAt` 是 P0-7 唯一新增的**详情**字段：还没开始服务时为 null，
  // 而它**不进列表项**（列表由状态名「护航中」表达，见 CompanionOrderDetail 注释）。
  // 上面两份白名单已经钉住了这一点，这里点名是为了说明**为什么**列表里不该有它
  assert.equal(detail.servingAt, null, "accepted 的单还没开始服务");
  assert.equal("servingAt" in item, false, "servingAt 只属于详情，不属于列表项");

  // 白名单已经覆盖了这一点，逐个点名是为了说明**为什么**它们不该在
  for (const leaked of [
    "clubNetIncome",
    "companionBaseIncome",
    "companionRateSnapshot",
    "refundedAmount",
    "actualPaidAmount",
    "originalAmount",
    "couponDiscountAmount",
    "userId",
    "exclusiveCompanionId",
    "releaseHistory",
  ]) {
    assert.equal(Object.hasOwn(detail, leaked), false, `打手端订单 DTO 不该带 ${leaked}`);
  }

  // 履约必需的两项必须在：没有账号与备注就打不了这一单
  assert.equal(detail.gameAccountId, order.gameAccountId);
  assert.equal(detail.remark, order.remark);

  // P0-8：详情带上完成材料摘要，形状由服务端算好（4 个字段的契约见 staffCompletions.test.mjs）。
  // accepted（还没开始服务）的单：从未提交过 → status 为 null、canSubmit 为 false、其余两项为 null
  assert.deepEqual(
    Object.keys(detail.completion).sort(),
    ["autoApprovalDeadlineAt", "canSubmit", "rejectReason", "status"],
    "打手详情里的完成材料摘要字段集变了",
  );
  assert.equal(detail.completion.status, null);
  assert.equal(detail.completion.canSubmit, false);

  // `canCancel` 不是「看状态猜」：serving 的单也看得到，但这里必须是 false
  const serving = (await listCompanionOrders(COMPANION_A)).items.find((entry) => entry.id === SEEDED_SERVING);
  assert.ok(serving, "预置里 cp-1 有一张 serving 的单");
  assert.equal(serving.status, "serving");
  assert.equal(serving.canCancel, false, "serving 之后没有普通主动取消入口");
});

test("取消 12：通知只发给下单用户、恰好一条、不重复，也不带订单隐私", async () => {
  const account = `p06_${process.pid}_acct`;
  const remark = `p06_${process.pid}_note`;
  const bystander = uniqueUser();
  const { user, order } = await acceptedOrder(COMPANION_A, uniqueUser(), {
    gameAccountId: account,
    remark,
  });
  const key = uniqueKey();

  await cancelCompanionOrder(COMPANION_A, order.id, { reason: "临时有事", idempotencyKey: key });

  // 这一次接单本身也发过一条通知，因此按标题收窄——重放不得再添一条
  await cancelCompanionOrder(COMPANION_A, order.id, { reason: "临时有事", idempotencyKey: key });

  const mine = await notificationsOf(user);
  assert.equal(
    mine.filter((item) => item.title === DISPATCH_NOTIFICATION_ACCEPTED.title).length,
    1,
    "接单那条通知与取消无关，仍然只有一条",
  );

  const released = mine.filter((item) => item.title === DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED.title);
  assert.equal(released.length, 1, "一次成功取消恰好产生一条通知");
  const [notice] = released;
  assert.equal(notice.userId, user, "收件人是**下单用户**，不是打手本人");
  assert.equal(notice.kind, "dispatch");
  assert.equal(notice.href, `/orders/${order.id}`, "详情入口只带订单 id，不带任何说明或理由");
  assert.equal(notice.readAt, null);

  assert.deepEqual(await notificationsOf(bystander), [], "别的用户收件箱必须为空");

  const serialized = JSON.stringify(notice);
  for (const secret of [account, remark]) {
    assert.equal(
      serialized.includes(secret),
      false,
      "通知是只读展示：要看细节进订单详情页，那里会重新校验归属",
    );
  }
});

// ——————————————————————— 六、客服 / 管理员能看到什么 ———————————————————————

test("取消 13：同一单退出两次就是两条历史——按时间正序、旧记录不被覆盖，后台看得见完整经过", async () => {
  const { order } = await acceptedOrder(COMPANION_A);
  const firstAt = plusMinutes(order.paidAt, 2);
  const first = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason: "第一次退出",
    idempotencyKey: uniqueKey(),
    at: firstAt,
  });
  assert.equal(first.kind, "ok");

  // 第二个人从公共池接走，然后他也退出：同一张单上出现过两次退出
  const dispatch = await dispatchOf(order.id);
  const secondAcceptedAt = plusMinutes(firstAt, 1);
  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_B, at: secondAcceptedAt });
  assert.equal(accepted.kind, "ok");
  const secondAt = plusMinutes(secondAcceptedAt, 1);
  const second = await cancelAcceptedOrder({
    companionId: COMPANION_B,
    orderId: order.id,
    reason: "第二次退出",
    idempotencyKey: uniqueKey(),
    at: secondAt,
  });
  assert.equal(second.kind, "ok");

  const releases = await releasesOf(order.id);
  assert.equal(releases.length, 2, "退出过两次就是两条，历史不做合并");
  assert.deepEqual(
    releases.map((item) => item.companionId),
    [COMPANION_A, COMPANION_B],
    "按 createdAt 正序：先退的人在前",
  );
  assert.deepEqual(releases.map((item) => item.reason), ["第一次退出", "第二次退出"]);
  assert.deepEqual(releases.map((item) => item.createdAt), [firstAt, secondAt]);
  assert.equal(releases[0].id, first.releaseRecordId, "旧记录没有被新记录顶掉");

  // 订单本身的归属只反映**现在**：没有任何实际打手
  const finalOrder = await orderOf(order.id);
  assert.equal(finalOrder.status, "paid");
  assert.equal(finalOrder.actualCompanionId, null);
  assert.equal(finalOrder.acceptedAt, null);

  // 后台看到的就是同样两条：客服要回答的正是「我明明看到有人接过，怎么又回到等待接单了」
  const admin = await getAdminOrderDetail(order.id, undefined, "server");
  assert.ok(admin);
  assert.deepEqual(
    admin.releaseHistory.map((item) => [item.companionId, item.reason]),
    [
      [COMPANION_A, "第一次退出"],
      [COMPANION_B, "第二次退出"],
    ],
  );
});

test("取消 14：Admin 订单详情含 releaseHistory，而用户端整个 DTO 里都找不到这条内部历史", async () => {
  const reason = `内部原因-${process.pid}-只该在后台`;
  const { user, order } = await acceptedOrder(COMPANION_A);
  const outcome = await cancelCompanionOrder(COMPANION_A, order.id, { reason, idempotencyKey: uniqueKey() });
  assert.equal(outcome.kind, "ok");

  // 管理端：唯一能看到「谁曾经接过、为什么退出、什么时候退出」的地方
  const admin = await getAdminOrderDetail(order.id, undefined, "server");
  assert.ok(admin);
  assert.equal(admin.releaseHistory.length, 1);
  const [entry] = admin.releaseHistory;
  assert.equal(entry.id, outcome.releaseRecordId);
  assert.equal(entry.orderId, order.id);
  assert.equal(entry.companionId, COMPANION_A);
  assert.equal(entry.source, "companion_cancel");
  assert.equal(entry.reason, reason);
  assert.equal(entry.actorId, COMPANION_A);
  assert.equal(entry.createdAt, outcome.cancelledAt);

  // 下单用户：`OrderDetail` 上根本没有这个字段，而且整个响应里不该出现那段原因
  const userDetail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.ok(userDetail);
  assert.equal(Object.hasOwn(userDetail, "releaseHistory"), false);
  assert.equal(
    JSON.stringify(userDetail).includes(reason),
    false,
    "内部取消历史不得顺着用户端订单详情流出去",
  );

  // 用户看到的是一致的事实：回到「已付款等待接单」，而不是「已接单」
  assert.equal(userDetail.status, "paid");
  assert.equal(userDetail.companion, null, "残留的履约快照会让列表出现一个并不在履约的打手");
  assert.equal(
    userDetail.timeline.some((node) => node.key === "accepted"),
    false,
    "时间轴只展示**已经发生**的节点：acceptedAt 被清空之后就不该再有「已接单」",
  );
  // 而且这一单重新有了池子进度（等待接单的摘要块自动以正确内容出现）
  assert.equal(userDetail.dispatchProgress?.pool, "public");
  assert.ok(userDetail.dispatchProgress.remainingSeconds > 0);
});

/**
 * §十一.23「Admin / **Staff** 可以看到取消历史」的两半都在。
 *
 * 这条用例原先是一条**缺口记录**：当时 `02-decisions.md` 的 D6 认为
 * 「客服与管理员进的是同一个后台」，只落地了 `AdminOrderDetail.releaseHistory`；
 * 而 `canEnterAdminConsole()` 只放行 `admin`，客服进不了 `/admin`——
 * 于是权限表 §7.1 给客服的「查看打手 accepted 后主动取消的原因、时间与原打手记录」
 * 实际没有兑现。
 *
 * P0-6 的 D6 **V3**（2026-09-23 用户裁定）补上了这一半：把退出历史挂到客服已经在用的
 * 三个只读详情 DTO 上，并**不为此新增任何 Staff API 路由**。因此这条用例守的是
 * 「这一半不许再掉回去」。
 *
 * ⚠️ **P0-10（2026-09-24）取代了那条「不开新路由」的表述**：本批指令明确要求新增
 * `/staff/orders` 与 `/staff/orders/[id]` 两个**只读**查询地址（`cmd_p0-10.md`）。
 * 按协议 §十三 的优先级（**用户最新裁定 > 现有代码行为**），新指令胜出。
 * 被取代的是**手段**（「靠不开路由来守住唯一入口」），不是**目的**：客服端仍然
 * 只有一个 `requireStaff()` 入口、仍然**没有任何改订单的能力**。所以这里改成断言
 * 「订单段接口恰好是那两个只读地址、且不导出任何写方法」——比原来的
 * 「一个都不能有」更贴近那条规则真正要守的东西。
 *
 * 四个事实：客服仍进不了 /admin、客服端订单段只有两个只读地址、
 * 客服端恰好这四处页面渲染退出历史、管理端那一处也还在。
 */
test("§十一.23 两半都在：客服在四个详情页看得到取消历史，订单段接口仍全是只读", () => {
  // 事实一：两个后台是**两套账号**，客服进不了 /admin（这条规则没变，客服侧
  // 的可见性因此必须落在工作台自己的三个详情页上，而不是靠跳转 /admin）
  assert.equal(canEnterAdminConsole("admin"), true);
  assert.equal(
    canEnterAdminConsole("customer_service"),
    false,
    "客服进不了管理后台：这条规则在 lib/constants/admin.ts 里冻结，本用例只是引用它",
  );

  // 事实二：客服端的订单段有**五个**地址——两个只读（列表 / 详情）与
  // **三个 P0-11 的处置入口**（退回公共池 / 换人 / 换人候选名单）。
  // ⚠️ P0-6 时这里断言的是「一个都没有」（当时的做法是只挂既有详情 DTO）；
  // P0-10 按要求开了两个只读地址；P0-11 又开了三个写地址。
  // ⚠️ 那三个写的**不是订单记录**：它们改的是这一单**当前的履约绑定**
  // （退回公共池 / 指定新护航），不改金额、不改商品、不写退款，也不改订单状态本身
  // 除「回到 paid」或「回到 accepted」之外的东西。逐条列出而不是只数数量：
  // 多出任何一个地址都要先回答「它写什么」。
  const staffOrderRoutes = collectFiles(path.join(ROOT, "app", "api", "staff"))
    .map((file) => path.relative(path.join(ROOT, "app"), file).replace(/\\/g, "/"))
    .filter((route) => route.split("/").includes("orders"))
    .sort();
  assert.deepEqual(
    staffOrderRoutes,
    [
      "api/staff/orders/[id]/release/route.ts",
      "api/staff/orders/[id]/replace-candidates/route.ts",
      "api/staff/orders/[id]/replace/route.ts",
      "api/staff/orders/[id]/route.ts",
      "api/staff/orders/route.ts",
    ],
    "客服端订单段只有这五个地址；多出任何一个都要先回答「它写什么」",
  );

  // 两个只读的：一个写方法都不许有
  for (const route of ["api/staff/orders/[id]/route.ts", "api/staff/orders/route.ts"]) {
    // 上一步的路径是相对 `app/` 的，读文件要补回去
    assert.equal(
      /export\s+(async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/.test(
        readSource(path.join(ROOT, "app", route)),
      ),
      false,
      `${route} 是只读接口，不该导出任何写方法`,
    );
  }

  // P0-11 的三个：两个写入的只有 POST，候选名单只有 GET；
  // 三个都不导出 PATCH / PUT / DELETE——「处置」只有「退回」与「换人」两种动作，
  // 没有「改这一单的其它东西」这种入口
  for (const [route, expectedMethod] of [
    ["api/staff/orders/[id]/release/route.ts", "POST"],
    ["api/staff/orders/[id]/replace/route.ts", "POST"],
    ["api/staff/orders/[id]/replace-candidates/route.ts", "GET"],
  ]) {
    const source = stripComments(readSource(path.join(ROOT, "app", route)));
    const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(methods, [expectedMethod], `${route} 只应导出 ${expectedMethod}`);
    for (const forbidden of ["PATCH", "PUT", "DELETE"]) {
      assert.equal(
        source.includes(`function ${forbidden}`),
        false,
        `${route} 不得导出 ${forbidden}：订单处置没有「就地改字段」这种动作`,
      );
    }
  }

  // 事实三：客服工作台**恰好**这四处页面渲染退出历史。
  // 按路由组无关的方式收集（`(console)` 不产生 URL 段），因此断言的是源码位置，
  // 与 URL 无关——这一层要防的是「渲染点悄悄少了一个」。
  // ⚠️ 第四处是 P0-10 的全量订单详情（`cmd_p0-10.md` 的详情必列项里有
  // `CompanionReleaseRecord` 历史）。前三处**不许因此被删掉**：同一个事实在
  // 客服顺手打开的那个页面上缺一块，比它压根没有更糟。
  const staffPagesWithHistory = collectFiles(path.join(ROOT, "app", "staff"))
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => readSource(file).includes("releaseHistory"))
    .map((file) => path.relative(ROOT, file).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(staffPagesWithHistory, [
    "app/staff/(console)/complaints/[id]/page.tsx",
    "app/staff/(console)/conversations/[orderId]/page.tsx",
    "app/staff/(console)/orders/[id]/page.tsx",
    "app/staff/(console)/refunds/[id]/page.tsx",
  ], "客服的四个详情页各自有订单区，退出历史必须同时出现在这四处；少一处就有客服看到的与别人不一致");

  // 事实四：管理端那一处也还在——两半同时在线，不许按下葫芦浮起瓢
  assert.ok(
    readSource(path.join(ROOT, "app", "admin", "(console)", "orders", "[id]", "page.tsx")).includes(
      "releaseHistory",
    ),
    "管理端订单详情仍要展示取消历史",
  );
});

// ——————————————————————— 七、P0-5 规则不回归 + 结构约束 ———————————————————————

test("兼容：P0-5 的派单规则不回归——自己不能接自己下的单，取消能力也不给它开后门", async () => {
  resetMockStore("platformConfig");
  await setPublicTimeoutMinutes(30);

  // 造一位「既是下单用户、又是打手」的人：预置护航的 userId 全是 null，
  // 自我接单这条 Guard 只有自己造数据才验得到（与 dispatchSelfOrder 同一条思路）
  const bothId = uniqueUser();
  const created = await getCompanionRepository().createCompanion({
    id: `cp-p06-${process.pid}-${seq}`,
    userId: bothId,
    applicationId: null,
    removedAt: null,
    displayName: "既是用户又是护航（占位）",
    avatarUrl: "/mock/avatars/companion-1.svg",
    rankLabel: "钻石打手",
    intro: "",
    gameIds: [],
    regions: [],
    serviceTags: [],
    available: true,
    unavailableReason: "",
    completedOrderCount: 0,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 999,
    enabled: true,
    reviews: [],
  });
  assert.equal(created.kind, "created");

  const order = await placeOrder(bothId);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  // 自己下的单不进自己的池子（诚实性）
  const pools = await listCompanionPools(created.companion.id, at);
  assert.equal(
    pools.public.some((item) => item.orderId === order.id),
    false,
    "自己下的单不该出现在自己的公共池里",
  );

  // 真正的保护在原子区段里（EX-DISPATCH-08）
  const self = await acceptDispatch(dispatch.id, { companionId: created.companion.id, at });
  assert.equal(self.kind, "self-order");
  assert.equal((await orderOf(order.id)).status, "paid");

  // 取消能力不会成为绕过它的后门：这一单既不是他接的，状态也不是 accepted
  await expectNotFound(() =>
    cancelCompanionOrder(created.companion.id, order.id, { reason: "想取消", idempotencyKey: uniqueKey() }),
  );
  assert.deepEqual(await releasesOf(order.id), []);
});

/**
 * 取某个导出函数的函数体（从它的 `export ... function NAME` 到下一个导出函数之前）。
 *
 * 这个文件里每个导出函数都要单独看「自己那条路径上有没有领域 Guard」，
 * 因此不能只在整个文件的源码串上 `includes`——那会让 A 函数的 Guard 替 B 函数背书。
 *
 * ⚠️ 边界曾经只认 `export async function`。P0-11 新增的
 * `releaseOrdersForCompanion` 是**同步**导出（它必须在 `setCompanionFlags` 的
 * 原子区段里被直接调用），于是「下一个 export async function」会跳过它，
 * 把它的函数体算进上一个函数的边界里——切片一长，别人的 Guard 就又替它背书了。
 * 所以边界改成认 **任意** `export`：这不改变 `cancelAcceptedOrder` /
 * `startCompanionOrder` 两个既有切片的范围（它们后面的邻居都是 async 导出），
 * 但把新来的同步函数关在自己的范围里。
 */
function functionBody(code, name) {
  const start = code.indexOf(`export function ${name}`);
  const asyncStart = code.indexOf(`export async function ${name}`);
  const from = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  assert.notEqual(from, -1, `找不到 ${name}：结构约束无法判定`);

  const next = code.indexOf("\nexport ", from + 1);
  return next === -1 ? code.slice(from) : code.slice(from, next);
}

/** 领域 Guard 的**字面**判据：动作必须自己看订单此刻的状态，而不是只问状态机表。 */
const STATUS_GUARD = 'order.status !== "accepted"';

test("结构约束：打手订单伪事务全程无 await，四个动作路径各自保留领域 Guard，对外只有五个入口", () => {
  const code = stripComments(readSource(path.join(ROOT, "lib", "data", "companionOrderTransaction.ts")));

  // 原子性不是靠运气：区段里出现任何一个 `await`，就等于把「读—判断—写」拆到两个 tick 上，
  // 别的请求会在「订单已回 paid、派单还写着 accepted」那一瞬插进来
  assert.equal(
    /\bawait\b/.test(code),
    false,
    "两个伪事务必须全程同步：加一个 await 就是 bug，哪怕加的是 await Promise.resolve()",
  );

  // 四件事写在同一段同步代码里
  for (const writer of [
    "appendCompanionRelease",
    "bindCompanionReleaseKey",
    "applyOrderAcceptanceReleased",
    "applyDispatchToPublic",
    "appendNotification",
  ]) {
    assert.ok(code.includes(writer), `取消必须调用 ${writer}，否则四件事里少了一件`);
  }

  // 幂等走的是 store 级索引，**不是**管理操作审计表（D1）
  assert.equal(code.includes("adminWriteSupport"), false, "打手取消不是管理行为，不该写进管理审计表");

  // —— 状态机表只能当**结构校验之一**，不能替代领域 Guard ——
  //
  // ⚠️ P0-6 时这里断言的是「本文件不得出现 canTransitionOrder」。P0-7 的「开始服务」
  // 按指令 §三 **必须**用中央状态机做一道结构校验，因此那条断言**不是被删掉，
  // 而是被改写成更精确的两条**：
  //   1. 每条动作路径上都必须有一句直接看 `order.status` 的领域 Guard
  //      （「表允许」不等于「这一单此刻能这么做」——状态机不是权限）；
  //   2. 结构校验必须排在领域 Guard **之前**，两道门都真的在跑；
  //   3. 取消路径**不得**引用状态机（把原来那条全文件级禁令收窄后的那一半补回来）。
  for (const name of ["cancelAcceptedOrder", "startCompanionOrder"]) {
    assert.ok(
      functionBody(code, name).includes(STATUS_GUARD),
      `${name} 缺少直接看 ${STATUS_GUARD} 的领域 Guard：表允许不等于这一单此刻能这么做`,
    );
  }

  const startBody = functionBody(code, "startCompanionOrder");
  assert.ok(
    startBody.includes("canTransitionOrder("),
    "开始服务必须用中央状态机（canTransitionOrder）做一道结构校验：这条边存不存在由状态表回答",
  );

  // ⚠️ 上面那条「start 必须含结构校验」在逻辑上**隐含**「这条断言不能对全文件成立」——
  // 因此原来那条全文件级禁令收窄成逐函数判断后，取消路径必须**单独**把它的那一半钉回来：
  // 取消只需要领域 Guard（`accepted → paid` 这条边在表里，问了也是白问），
  // 不该顺带引用状态机。少了这一条，将来给取消路径加一句
  // `if (!canTransitionOrder(...)) return not-accepted` 不会变红——
  // 权限仍然是对的，但 P0-6「状态表只出现在真正需要它的动作路径上」这个判断就没人守了。
  assert.equal(
    functionBody(code, "cancelAcceptedOrder").includes("canTransitionOrder("),
    false,
    "取消接单不需要结构校验：它有直接看状态的领域 Guard，引用状态机属于多余的判断",
  );
  assert.ok(
    startBody.indexOf("canTransitionOrder(") < startBody.indexOf(STATUS_GUARD),
    "结构校验必须在领域 Guard 之前：先问「这条边存在吗」，再问「这一单站在它的起点上吗」",
  );

  // —— 对外导出的动作入口：**恰好这五个** ——
  //
  // ⚠️ P0-6 时这里是一条禁令：「回池写入能力不导出，另外两个 source（封禁回池 /
  // 客服换人）是后续 Round，提前导出一个『谁都能调的回池函数』等于给它们留一扇
  // 没有 Guard 的门」。P0-11 把这两扇门正式装上了，因此那条禁令**不是被删掉**，
  // 而是被换成正面断言：每扇门自己带 Guard，且各自的调用条件能被单独看见。
  //
  // 五个入口：打手侧两个（取消接单 / 开始服务）+ 客服侧两个（退回公共池 / 指定换人）
  // + 封禁回池一个（同步）。逐条列出而不是只数数量——多一个就要先回答「它的 Guard 是什么」。
  const exported = [...code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(exported, [
    "cancelAcceptedOrder",
    "releaseOrderByStaff",
    "releaseOrdersForCompanion",
    "replaceOrderCompanionByStaff",
    "startCompanionOrder",
  ]);

  // 客服的两个入口：**自己**直接看 `order.status`（与打手侧同一条领域 Guard）。
  // 「订单不在履约中」既不该被退回公共池，也不该被换人——状态机表管不了这件事，
  // 因为客服退回走的是 `accepted → paid` 这个表里本来就有的边。
  for (const name of ["releaseOrderByStaff", "replaceOrderCompanionByStaff"]) {
    assert.ok(
      functionBody(code, name).includes(STATUS_GUARD),
      `${name} 缺少直接看 ${STATUS_GUARD} 的领域 Guard：客服也不该照着一张表就把单退回或换人`,
    );
  }

  // 封禁回池**必须是同步函数**：它被 `setCompanionFlags` 的原子区段直接调用，
  // 写成 `async` 之后正确性就只剩「调用方记得不要 await」这一条口头约定，
  // 而这条约定没有任何东西在守
  assert.equal(
    /export async function releaseOrdersForCompanion/.test(code),
    false,
    "封禁回池必须同步导出：它跑在 setCompanionFlags 的原子区段里，async 等于把原子性交给调用方的自觉",
  );
  assert.ok(
    code.includes("export function releaseOrdersForCompanion"),
    "封禁回池要真的导出，否则 setCompanionFlags 没法在同一段同步代码里调用它",
  );

  // 三个新 source 的**触发原因**都要在文件里留下字面痕迹：
  // 封禁回池（companion_disabled）、客服退回公共池与客服换人（staff_reassign）。
  // P0-6 时禁令断言的是「这两个词不该出现」——那时它们确实是「还没有写入路径」的
  // 未来词。现在反过来了：**出现**才是对的，因为它们各自真的有一条写入路径。
  for (const source of ["companion_disabled", "staff_reassign"]) {
    assert.ok(code.includes(source), `${source} 已有写入路径，退出历史的 source 应当记下它`);
  }
});

test("D10 同步：公共池页面的接单承诺语不再说「不能自行退回」", () => {
  // 这句话是打手**点接单之前**看到的承诺。P0-6 之后「不能自行退回」已不成立，
  // 留着它等于在页面上承诺一条被改掉的规则——而同一个页面上还会出现「取消接单」入口
  assert.equal(COMPANION_ACCEPT_NOTICE.includes("不能自行退回"), false);
  assert.ok(COMPANION_ACCEPT_NOTICE.includes("取消接单"), "要写清新规则的措辞，不能只删掉旧的那半句");

  // 卡片显示的必须是这一份常量，而不是页面上另写一句
  const card = readSource(path.join(ROOT, "components", "companion", "CompanionDispatchCard.tsx"));
  assert.ok(card.includes("COMPANION_ACCEPT_NOTICE"));
});

// ——————————————————————— 八、HTTP 权限矩阵（需要 APP_BASE_URL） ———————————————————————

/**
 * 未登录 / 不是打手这两种拒绝**只有真跑服务才能验证**：
 * 守卫建立在用户会话（`cookies()`）之上，进程内的数据层测试拿不到会话。
 * 因此这一节与 `http-smoke.test.mjs` 同一取舍：没设 `APP_BASE_URL` 时自动跳过，
 * 而不是伪装成通过。
 */
const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过打手订单接口的权限矩阵";

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
 * （`cp-*` 大多为 null，有关联的只有 `cp-10` / `cp-11` → u-1022 / u-1023，
 * 它们是 DEV-1 为验收链路预置的**有效打手**，不是「谁都还不是打手」）。
 */
const SESSION_PLAIN = BASE ? await loginAs("u-1001") : null;
const SKIP_SESSION =
  SKIP || (SESSION_PLAIN ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

/**
 * 四个打手订单接口（P0-7 起把 `start` 也纳进来）。路径里刻意不用中文，
 * 避免编码问题把 404 与 403 混起来。
 *
 * ⚠️ `start` 与另外三个不同：它**没有请求体**。下面这个 helper 仍然给它发了一个
 * cancel 形状的体——刻意如此：守卫必须**先于**请求体的任何解读，因此带着什么体到达
 * 都只能得到 401 / 403，而不是 400。
 */
const COMPANION_ORDER_ROUTES = [
  ["GET", "/api/companion/orders"],
  ["GET", "/api/companion/orders/ord-not-exist"],
  ["POST", "/api/companion/orders/ord-not-exist/cancel"],
  ["POST", "/api/companion/orders/ord-not-exist/start"],
];

function requestRoute(method, url, cookie) {
  return fetch(new URL(url, BASE), {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: method === "POST" ? JSON.stringify({ reason: "临时有事", idempotencyKey: "p06-http-key-1" }) : undefined,
  });
}

test("权限矩阵：未登录打这四个接口都是 401（不是 403，也不是 200）", { skip: SKIP }, async () => {
  for (const [method, url] of COMPANION_ORDER_ROUTES) {
    const response = await requestRoute(method, url);
    assert.equal(response.status, 401, `${method} ${url} 未登录应当 401`);
    const payload = await response.json();
    assert.equal(payload.error.code, "UNAUTHORIZED", `${method} ${url} 的错误码`);
    assert.ok(payload.error.message, "错误信封必须有可展示的文案");
  }
});

test("权限矩阵：登录了但不是打手的普通用户拿到 403", { skip: SKIP_SESSION }, async () => {
  for (const [method, url] of COMPANION_ORDER_ROUTES) {
    const response = await requestRoute(method, url, SESSION_PLAIN);
    assert.equal(response.status, 403, `${method} ${url} 非打手应当 403`);
    const payload = await response.json();
    assert.equal(payload.error.code, "FORBIDDEN", `${method} ${url} 的错误码`);
  }
});
