import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";

import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE,
  DIRECT_REFUND_NOT_ALLOWED_MESSAGE,
  DIRECT_REFUND_NOT_STARTED_MESSAGE,
  DIRECT_REFUNDABLE_ORDER_STATUSES,
  REFUND_AMOUNT_INVALID_MESSAGE,
  REFUND_NOTIFICATION_COMPANION_REFUNDED,
  REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  REFUNDABLE_ORDER_STATUSES,
  canDirectRefund,
  canRequestRefund,
} from "../lib/constants/refunds.ts";
import { canTransitionOrder } from "../lib/constants/orders.ts";
import { acceptDispatch, sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import { directRefundOrder } from "../lib/data/directRefundTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getEarningRepository } from "../lib/data/earningRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { getConsumptionLevelForUser } from "../lib/services/levels.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import {
  createRefundForOrder,
  directRefundOrderForUser,
  getOrderRefundSummary,
} from "../lib/services/refunds.ts";
import { hasAppFile, resolveSource } from "./app-path.mjs";

/**
 * P0-12「`paid` / `accepted` 用户免审批全额退款」的持续测试。
 *
 * ## 这一批真正要钉住的四件事
 *
 * 1. **钱只退一次、且退的是订单实付那么多**。重复请求（用户连点、超时清扫、
 *    管理员退款之后再点一次）都不得重复出款、不得刷新退款时刻；
 * 2. **退款之后这一单的派单不能再被接单**，否则会有打手去做一件不存在的活；
 * 3. **`accepted` 退款保留 `actualCompanionId` 与打手快照**——需求把这条与
 *    cancel / ban / re-pool「清绑定」刻意分开（批次 §历史语义：「不得为代码统一抹平」）。
 *    退款后订单仍然指得到当初接单的人，但**不写履约退出历史**：他没被换掉，是这一单结束了；
 * 4. **不产生 Earning**。这不是「记得不要去建」，而是结构性的：收益只在完成结算时产生，
 *    而 `paid` / `accepted` 从未进入过 `serving`（用例直接断言退款后查不到收益记录）。
 *
 * ## 为什么每个用例都重建订单数据
 *
 * 直接退款**会改订单**（与「提交退款申请不改订单」正好相反），因此本文件不能像
 * `refunds.test.mjs` 那样只重建退款那一份 store——一笔被退掉的订单会污染后面所有用例。
 * `beforeEach` 把六份 store 全部重建：订单 / 派单 / 通知 / 退款申请 / 履约退出 / 收益。
 *
 * ## 时间怎么控制
 *
 * 预置的「等待接单」订单，截止时间是**相对进程基准时间**给出的
 * （`dispatchSeed.ts` 的说明），因此 `plusMinutes(getMockSeedNow(), 61)` 就是
 * 「这一刻之后 61 分钟」——超过默认 60 分钟的公共池时长，且不依赖任何真实等待。
 */

/** 预置普通用户；下单、退款都以他为订单本人。 */
const USER_A = "u-1001";

/** 一启动就已经是有效打手、**且资料关联了用户账号**的那位（`cp-10` / `u-1022`）。 */
const COMPANION_WITH_ACCOUNT = "cp-10";
const COMPANION_USER = "u-1022";
/** 预置早期护航：`userId` 为 `null`，**不存在能收信的地址**。 */
const COMPANION_WITHOUT_ACCOUNT = "cp-2";

/** 预置订单（状态 / 归属由 `orderSeed` 给出，探测结果见交付记录）。 */
const PAID_ORDER = "ord-seed-1001-02"; // paid · u-1001 · 派单在公共池
const ACCEPTED_ORDER = "ord-seed-1001-11"; // accepted · u-1001 · 实际打手 cp-2（无账号）
const SERVING_ORDER = "ord-seed-1001-10"; // serving · u-1001
const COMPLETED_ORDER = "ord-seed-1001-05"; // completed · u-1001
const REFUNDED_ORDER = "ord-seed-1001-13"; // refunded · u-1001
/** 别人（u-1002）的已付款订单：验证归属校验没有因为「免审批」一起放开 */
const OTHER_USER_PAID_ORDER = "ord-seed-1002-01";

/** P0-12 之前才会出现、且**真实存在于预置数据**里的两种存量形态（见交付记录 §追认项）。 */
const PAID_WITH_REJECTED_REFUND = "ord-seed-1001-01"; // paid + 一条已拒绝的退款申请
const ACCEPTED_WITH_PENDING_REFUND = "ord-seed-1001-03"; // accepted + 一条待审核的退款申请

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

let userSeq = 0;
/** 每个用例一个全新用户：订单与通知都按用户隔离，用例之间不互相看见。 */
function uniqueUser() {
  userSeq += 1;
  return `u-p012-${process.pid}-${userSeq}`;
}

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `p012-key-${process.pid}-${keySeq}`;
}

beforeEach(() => {
  // 直接退款一次改三份数据（订单 / 派单 / 通知），另三份是它不该碰的对照组
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("notification");
  resetMockStore("refund");
  resetMockStore("companionRelease");
  resetMockStore("earning");
});

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
      idempotencyKey: uniqueKey(),
      ...overrides,
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
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

/**
 * 发给某个用户、且是**退款这件事**的通知。**按 kind 与 href 双重收窄**，不数全局条数。
 *
 * ⚠️ 只按 href 收窄是不够的：`acceptDispatch` 会合法地给下单用户发一条
 * 「订单已被接单」（`kind: "dispatch"`，同样指向 `/orders/<id>`），
 * 那条通知与退款无关，混进来会让「退款没有惊动下单用户」这条断言变成假的。
 */
async function refundNotificationsFor(userId, orderId) {
  const list = await getNotificationRepository().listNotifications(userId);
  return list.filter(
    (item) =>
      item.kind === "refund" &&
      (item.href === `/companion/orders/${orderId}` || item.href === `/orders/${orderId}`),
  );
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 造一张**已被有账号的打手接单**的订单（走真实的接单伪事务）。 */
async function placeAcceptedOrder(user, companionId = COMPANION_WITH_ACCOUNT) {
  const order = await placeOrder(user);
  const record = await dispatchOf(order.id);
  const accepted = await acceptDispatch(record.id, {
    companionId,
    at: new Date().toISOString(),
  });
  assert.equal(accepted.kind, "ok", "接单必须成功");

  const after = await orderOf(order.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.actualCompanionId, companionId);
  return after;
}

// ———————————————————— 一、纯规则：两条路径互斥 ————————————————————

test("两个状态集合互不相交：同一档订单不可能同时有两条退款路径", () => {
  const direct = new Set(DIRECT_REFUNDABLE_ORDER_STATUSES);
  const applied = new Set(REFUNDABLE_ORDER_STATUSES);

  assert.deepEqual([...direct].sort(), ["accepted", "paid"], "免审批直接退款只有这两档");
  assert.deepEqual([...applied].sort(), ["completed", "serving"], "售后申请只剩「已开始服务」之后的两档");

  for (const status of direct) {
    assert.equal(applied.has(status), false, `${status} 同时出现在两个集合里，等于同一档有两条退款路径`);
    assert.equal(canDirectRefund(status), true);
    assert.equal(canRequestRefund(status, false), false, `${status} 不该再给出「申请退款」入口`);
  }

  // 其余状态一条路都没有
  for (const status of ["refunded", "pending_payment", "cancelled"]) {
    assert.equal(canDirectRefund(status), false, `${status} 不是「尚未开始服务」，不能直接退`);
  }
});

test("直退放行的每一档，在订单状态表里都必须真的有一条 → refunded 的边", () => {
  // ⚠️ 直退**刻意不调** `canTransitionOrder`：那样「这一档能不能退」就有两个真值源
  //    （状态表 + 状态集合），而两份判断迟早会不一致——仓库对这类重复的立场见
  //    `lib/constants/dispatch.ts` 开头那段。状态集合是**更窄**的那一个，因此由它把关。
  //
  //    这条不变式改为在**测试里**钉住：一旦有人把 `DIRECT_REFUNDABLE_ORDER_STATUSES`
  //    放宽到某个**没有** `→ refunded` 边的状态，这里立刻变红——用断言代替重复的运行时校验。
  for (const status of DIRECT_REFUNDABLE_ORDER_STATUSES) {
    assert.equal(
      canTransitionOrder(status, "refunded"),
      true,
      `${status} → refunded 不在 ORDER_TRANSITIONS 里，直退会写出一个状态机不允许的落点`,
    );
  }
  // 反过来也要成立：状态表里**有边**不等于可以直退（`serving` / `completed` 都有边，
  // 但它们必须走售后），因此不能用状态表替换状态集合
  assert.equal(canTransitionOrder("serving", "refunded"), true);
  assert.equal(canDirectRefund("serving"), false);
});

test("旧路径不再接受 paid / accepted：接口与纯函数同时拒绝，且不留下任何退款记录", async () => {
  for (const orderId of [PAID_ORDER, ACCEPTED_ORDER]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.equal(detail.allowedActions.canDirectRefund, true, `${orderId} 必须给出直接退款入口`);
    assert.equal(detail.allowedActions.canRequestRefund, false, `${orderId} 不该再有申请退款入口`);

    await expectApiError(
      createRefundForOrder(
        orderId,
        USER_A,
        {
          reasonKey: "other",
          description: "想走人工审核那条路",
          evidence: [],
          idempotencyKey: uniqueKey(),
        },
        undefined,
        "server",
      ),
      "BAD_REQUEST",
      REFUND_ORDER_NOT_ALLOWED_MESSAGE,
    );
    // 被拒之后一笔没写：这一单仍然干干净净
    assert.equal(await getOrderRefundSummary(orderId), null);
  }
});

// ———————————————————— 二、paid 单：退成什么样 ————————————————————

test("paid 单直接退款：订单、金额、退款时刻、派单关闭都对，且不产生通知与收益", async () => {
  const before = await orderOf(PAID_ORDER);
  const dispatchBefore = await dispatchOf(PAID_ORDER);
  assert.notEqual(dispatchBefore.state, "timed_out", "这一条需要一张还没关闭的派单");
  const at = new Date().toISOString();

  const result = await directRefundOrder(PAID_ORDER, at);

  assert.equal(result.kind, "ok");
  assert.equal(result.refundedAmount, before.actualPaidAmount, "全额退款就是订单实付");
  assert.equal(result.refundedAt, at, "第一次退款写的就是本次时刻");
  assert.equal(result.previousStatus, "paid");
  assert.equal(result.dispatchClosed, true);
  assert.equal(result.notifiedCompanionUserId, null, "还没人接单，没有通知对象");

  const after = await orderOf(PAID_ORDER);
  assert.equal(after.status, "refunded");
  assert.equal(after.refundedAmount, before.actualPaidAmount);
  assert.equal(after.refundedAt, at);
  assert.equal(after.actualCompanionId, null, "没人接过，不该凭空多出一个履约人");

  // 派单关闭：不能再被接单，而且**不是因为「清扫还没跑到」**
  const dispatchAfter = await dispatchOf(PAID_ORDER);
  assert.equal(dispatchAfter.state, "timed_out");
  assert.equal(dispatchAfter.timedOutAt, at, "关闭时刻就是退款时刻");
  const late = await acceptDispatch(dispatchAfter.id, {
    companionId: COMPANION_WITH_ACCOUNT,
    at: new Date().toISOString(),
  });
  assert.equal(late.kind, "not-open");
  assert.equal(late.state, "timed_out");

  // 没有收益、没有退出历史、没有通知
  assert.equal(await getEarningRepository().findEarningByOrderId(PAID_ORDER), null);
  assert.deepEqual(await getCompanionReleaseRepository().listReleasesByOrderId(PAID_ORDER), []);
  assert.deepEqual(await refundNotificationsFor(USER_A, PAID_ORDER), []);
});

test("重复直接退款：第二次如实说「已全额退款」，退款事实一个字节都不变", async () => {
  const first = await directRefundOrder(PAID_ORDER, new Date().toISOString());
  assert.equal(first.kind, "ok");

  const afterFirst = await orderOf(PAID_ORDER);
  const dispatchAfterFirst = await dispatchOf(PAID_ORDER);

  // 第二次用一个**更晚**的时刻：如果实现刷新了退款事实，时间就会跟着变
  const later = plusMinutes(new Date().toISOString(), 5);
  const second = await directRefundOrder(PAID_ORDER, later);

  assert.equal(second.kind, "already-refunded");
  assert.equal(second.refundedAt, first.refundedAt, "退款时刻以第一次为准");
  assert.deepEqual(await orderOf(PAID_ORDER), afterFirst, "第二次退款不得改动订单任何字段");
  assert.deepEqual(await dispatchOf(PAID_ORDER), dispatchAfterFirst, "也不得刷新派单的关闭时刻");
  assert.deepEqual(await refundNotificationsFor(USER_A, PAID_ORDER), [], "更不得重复发通知");

  // 服务层把同一种情况翻译成一句人话
  await expectApiError(
    directRefundOrderForUser(PAID_ORDER, USER_A, undefined, "server"),
    "BAD_REQUEST",
    DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE,
  );
});

// ———————————————————— 三、accepted 单：保留历史、通知打手 ————————————————————

test("accepted 单直接退款：保留 actualCompanionId 与打手快照，通知打手，但不写履约退出历史", async () => {
  const user = uniqueUser();
  const order = await placeAcceptedOrder(user);
  const at = new Date().toISOString();

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");

  assert.equal(result.refundedAmount, order.actualPaidAmount);
  // 退款时刻由服务层取「本次请求的时刻」，测试不预知那个值，只要求三处说的是同一个时刻
  assert.ok(Number.isFinite(Date.parse(result.refundedAt)), `退款时刻必须是合法时间：${result.refundedAt}`);
  assert.ok(result.refundedAt >= at, "退款时刻不早于发起退款之前记下的时刻");

  const after = await orderOf(order.id);
  assert.equal(after.refundedAt, result.refundedAt, "回读到的退款时刻必须与返回的一致");
  assert.equal(after.status, "refunded");
  // ⚠️ 这一条是批次 §历史语义 明文要求的「不得为代码统一抹平」：
  // cancel / ban / re-pool 清绑定，退款**不清**——退款不是「换个人接着做」，是这一单结束了
  assert.equal(after.actualCompanionId, COMPANION_WITH_ACCOUNT, "退款后仍然指得到当初接单的人");
  assert.deepEqual(after.companion, order.companion, "打手快照也不能被清掉");
  assert.equal(after.servingAt, null, "这一单从没开始服务过");

  // 退出历史是「换人 / 被换下」的记录，这一单没换人
  assert.deepEqual(await getCompanionReleaseRepository().listReleasesByOrderId(order.id), []);
  // 收益是完成结算才产生的东西
  assert.equal(await getEarningRepository().findEarningByOrderId(order.id), null);

  // 派单关闭
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "timed_out");
  assert.equal(dispatch.timedOutAt, result.refundedAt);

  // 通知：收件人是**打手的用户账号**，不是下单用户；指向打手端订单页
  const toCompanion = await getNotificationRepository().listNotifications(COMPANION_USER);
  const mine = toCompanion.filter((item) => item.href === `/companion/orders/${order.id}`);
  assert.equal(mine.length, 1, "必须给被退单的打手发一条通知，且只有一条");
  assert.equal(mine[0].kind, "refund");
  assert.equal(mine[0].title, REFUND_NOTIFICATION_COMPANION_REFUNDED.title);
  assert.equal(mine[0].summary, REFUND_NOTIFICATION_COMPANION_REFUNDED.summary);
  assert.equal(mine[0].body, REFUND_NOTIFICATION_COMPANION_REFUNDED.body);
  assert.equal(mine[0].createdAt, result.refundedAt, "通知的时间就是退款发生的时间");
  assert.equal(mine[0].readAt, null);

  // 下单用户**没有**收到这条通知：退款结果在他自己的订单页上，需求里没有「通知用户」这一条
  assert.deepEqual(await refundNotificationsFor(user, order.id), []);
});

test("accepted 单的打手没有账号时：退款照常成功，只是无人可通知（不是失败）", async () => {
  const user = uniqueUser();
  const order = await placeAcceptedOrder(user, COMPANION_WITHOUT_ACCOUNT);

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");

  assert.equal(result.refundedAmount, order.actualPaidAmount);
  // ⚠️ 这里断言的是**派单真的关了**，不是 DTO 里的 `dispatchClosed`：
  // 服务层返回的是显式挑过的四个字段，`dispatchClosed` 只存在于事务层的 outcome，
  // 拿 DTO 去断言它只会得到 `undefined === false` 这种恒假的假绿灯
  assert.equal((await dispatchOf(order.id)).state, "timed_out", "派单必须关闭");
  assert.equal((await orderOf(order.id)).status, "refunded");
  assert.equal((await orderOf(order.id)).actualCompanionId, COMPANION_WITHOUT_ACCOUNT);

  // 这位护航没有关联用户，通知收件人在数据上就不存在——因此没有通知，而不是「通知功能坏了」
  const all = await getNotificationRepository().listNotifications(COMPANION_USER);
  assert.equal(all.filter((item) => item.href === `/companion/orders/${order.id}`).length, 0);
});

test("退款后打手端仍然看得到这一单（保留绑定）——通知里的链接指向的是真页面", () => {
  // 这一条是**源码断言**，与 P0-10 / P0-11 的同类断言一致：路由存在性不是行为，
  // 但它一旦被删掉，上面那条通知就会变成一条点不开的死链接
  assert.equal(hasAppFile("companion/orders/[id]/page.tsx"), true, "打手端订单详情页必须存在");
  assert.equal(hasAppFile("api/orders/[id]/direct-refund/route.ts"), true, "直接退款接口必须存在");
  assert.equal(hasAppFile("orders/[id]/direct-refund/route.ts"), false, "它不是页面，别长的像页面");
});

// ———————————————————— 四、与超时自动退款并发 ————————————————————

test("用户先退 → 超时清扫不得重复退款、不得重复通知", async () => {
  const at = new Date().toISOString();
  const first = await directRefundOrder(PAID_ORDER, at);
  assert.equal(first.kind, "ok");

  const afterRefund = await orderOf(PAID_ORDER);
  const notificationsAfterRefund = await refundNotificationsFor(USER_A, PAID_ORDER);

  // 跑到公共池截止之后：这一单的派单已经关闭，清扫**根本不该再看它**
  const swept = sweepExpiredDispatches(plusMinutes(getMockSeedNow(), 61));

  assert.equal(swept.refundedOrderIds.includes(PAID_ORDER), false, "清扫不得重复退款");
  assert.deepEqual(await orderOf(PAID_ORDER), afterRefund, "退款事实与退款时刻都不能被改写");
  assert.deepEqual(
    await refundNotificationsFor(USER_A, PAID_ORDER),
    notificationsAfterRefund,
    "不得因为清扫多出一条退款通知",
  );
});

test("超时清扫先退 → 用户再点只得「已全额退款」，且退款时刻仍是清扫写的那个", async () => {
  const dispatch = await dispatchOf(PAID_ORDER);
  assert.equal(dispatch.state, "public", "这一条需要一张在公共池里等到期的单");

  const swept = sweepExpiredDispatches(plusMinutes(getMockSeedNow(), 61));
  assert.equal(swept.refundedOrderIds.includes(PAID_ORDER), true, "清扫必须真的退掉这一单");
  const afterSweep = await orderOf(PAID_ORDER);
  assert.equal(afterSweep.status, "refunded");
  assert.equal(afterSweep.refundedAt, dispatch.publicDeadlineAt, "自动退款写的是到点那一刻");

  // 用户此刻点「直接退款」：不能重复出款，也不能把退款时刻改成本次请求的时刻
  const at = plusMinutes(getMockSeedNow(), 90);
  const result = await directRefundOrder(PAID_ORDER, at);

  assert.equal(result.kind, "already-refunded");
  assert.equal(result.refundedAt, dispatch.publicDeadlineAt);
  assert.deepEqual(await orderOf(PAID_ORDER), afterSweep, "订单一个字段都不能动");
});

// ———————————————————— 五、不属于这两档的一律拒绝 ————————————————————

test("serving / completed / refunded 三档都拒绝，而且一句话说得清是哪一种", async () => {
  // 已经开始服务：还有路可走（走售后找客服），因此文案与「退不了」不同
  await expectApiError(
    directRefundOrderForUser(SERVING_ORDER, USER_A, undefined, "server"),
    "BAD_REQUEST",
    DIRECT_REFUND_NOT_STARTED_MESSAGE,
  );
  await expectApiError(
    directRefundOrderForUser(COMPLETED_ORDER, USER_A, undefined, "server"),
    "BAD_REQUEST",
    DIRECT_REFUND_NOT_ALLOWED_MESSAGE,
  );
  await expectApiError(
    directRefundOrderForUser(REFUNDED_ORDER, USER_A, undefined, "server"),
    "BAD_REQUEST",
    DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE,
  );

  // 三次拒绝之后订单数据一动没动
  assert.equal((await orderOf(SERVING_ORDER)).status, "serving");
  assert.equal((await orderOf(COMPLETED_ORDER)).status, "completed");
  assert.equal((await orderOf(REFUNDED_ORDER)).status, "refunded");

  for (const orderId of [SERVING_ORDER, COMPLETED_ORDER, REFUNDED_ORDER]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.equal(detail.allowedActions.canDirectRefund, false, `${orderId} 不该出现直接退款入口`);
  }
});

test("实付为 0 的订单：退无可退时说的是「金额异常」，不是「已全额退款」", async () => {
  const user = uniqueUser();
  const order = await placeOrder(user);

  // 构造一张「实付为 0」的订单。这不是正常数据：它来自商品配置异常
  // （某个规格价被改成 0 之后再下单）。今天预置数据里不可达，因此**直接改存储**——
  // 要验的正是这条防御性分支本身（reviewer 复核 M-2 的落点）。
  paymentStore().orders.get(order.id).actualPaidAmount = 0;
  assert.equal((await orderOf(order.id)).status, "paid", "这一条用例需要一张仍可直退的 paid 单");

  // ⚠️ 关键断言：**不能**落到 `refundedAmount >= actualPaidAmount`（`0 >= 0` 成立）那一支上。
  //    那一支说的是「该订单已全额退款」，而这里一分钱都没退、订单还停在 paid —— 那是假话。
  await expectApiError(
    directRefundOrderForUser(order.id, user, undefined, "server"),
    "BAD_REQUEST",
    REFUND_AMOUNT_INVALID_MESSAGE,
  );

  // 被拒绝之后一个字节都没写：状态、金额、退款时刻、退款记录、通知
  const after = await orderOf(order.id);
  assert.equal(after.status, "paid", "金额异常的订单不得被改成已退款");
  assert.equal(after.refundedAmount, 0);
  assert.equal(after.refundedAt, null);
  assert.equal(await getOrderRefundSummary(order.id), null, "金额异常不得留下退款记录");
  assert.deepEqual(await refundNotificationsFor(user, order.id), []);
});

test("归属：别人的单与不存在的单是同一个 404，且不泄露「这单存在」", async () => {
  await expectApiError(
    directRefundOrderForUser(OTHER_USER_PAID_ORDER, USER_A, undefined, "server"),
    "NOT_FOUND",
    "订单不存在",
  );
  await expectApiError(
    directRefundOrderForUser("ord-does-not-exist", USER_A, undefined, "server"),
    "NOT_FOUND",
    "订单不存在",
  );

  // 被拒绝之后，那张别人的单还是「已付款」
  assert.equal((await orderOf(OTHER_USER_PAID_ORDER)).status, "paid");
});

// ———————————————————— 六、存量数据：P0-12 之前留下的退款申请 ————————————————————

test("已有「已拒绝」退款记录的已付款订单：仍可直接全额退款，那条记录原样不动", async () => {
  // P0-12 之前，paid / accepted 走的是人工审核，因此预置数据里存在这两种组合。
  // 新规的前置条件只有「状态属尚未开始服务」与「未全额退款」，与有没有申请记录无关
  const before = await orderOf(PAID_WITH_REJECTED_REFUND);
  assert.equal(before.status, "paid");
  assert.equal((await getOrderRefundSummary(PAID_WITH_REJECTED_REFUND)).status, "rejected");

  const result = await directRefundOrderForUser(
    PAID_WITH_REJECTED_REFUND,
    USER_A,
    undefined,
    "server",
  );

  assert.equal(result.refundedAmount, before.actualPaidAmount);
  assert.equal((await orderOf(PAID_WITH_REJECTED_REFUND)).status, "refunded");
  assert.equal(
    (await getOrderRefundSummary(PAID_WITH_REJECTED_REFUND)).status,
    "rejected",
    "已结束的申请不该被退款顺手改掉状态",
  );
});

test("已有「待审核」退款申请的已接单订单：直接退款不受它阻挡，那条申请留在原处等客服处置", async () => {
  const before = await orderOf(ACCEPTED_WITH_PENDING_REFUND);
  assert.equal(before.status, "accepted");
  assert.equal((await getOrderRefundSummary(ACCEPTED_WITH_PENDING_REFUND)).status, "pending");

  const result = await directRefundOrderForUser(
    ACCEPTED_WITH_PENDING_REFUND,
    USER_A,
    undefined,
    "server",
  );

  assert.equal(result.refundedAmount, before.actualPaidAmount);
  assert.equal((await orderOf(ACCEPTED_WITH_PENDING_REFUND)).status, "refunded");
  // ⚠️ 这条待审核的申请是**存量数据**（新规之后这两档已经开不出申请了）。
  // 本轮**不替它作决定**：既不作废它、也不把它标成通过——那两条都是新的财务规则。
  // 客服仍可在既有审核界面通过或拒绝它（见交付记录 §追认项）
  assert.equal(
    (await getOrderRefundSummary(ACCEPTED_WITH_PENDING_REFUND)).status,
    "pending",
    "直接退款不得顺手改写这条申请的状态",
  );
});

// ———————————————————— 七、金额与 DTO 边界 ————————————————————

test("退款金额恒等于订单实付，且不影响累计消费", async () => {
  const user = uniqueUser();
  const order = await placeOrder(user);
  const levelBefore = await getConsumptionLevelForUser(user, undefined, "server");

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");

  assert.equal(result.refundedAmount, order.actualPaidAmount);
  // 已经退款的订单不计入有效消费（`CONSUMPTION_ORDER_STATUS` 只认已完成），
  // 而 paid / accepted 本来也从没计入过——因此这里断言的是「退款没有把它算进去」
  const levelAfter = await getConsumptionLevelForUser(user, undefined, "server");
  assert.equal(levelAfter.effectiveSpendAmount, levelBefore.effectiveSpendAmount);
  assert.deepEqual(levelAfter.currentLevel, levelBefore.currentLevel);
});

test("退款接口的返回只有四个字段：订单号、金额、时刻，不多带任何内部字段", async () => {
  const user = uniqueUser();
  const order = await placeAcceptedOrder(user);

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");

  assert.deepEqual(
    Object.keys(result).sort(),
    ["orderId", "orderNo", "refundedAmount", "refundedAt"],
    "DTO 是显式挑字段的：分账比例、平台净收入、打手 id 都不该出现在这里",
  );
  assert.equal(result.orderNo, order.orderNo);

  // 订单详情里的四份摘要与动作：退款之后申请入口与直接退款入口都消失
  const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.equal(detail.allowedActions.canDirectRefund, false);
  assert.equal(detail.allowedActions.canRequestRefund, false);
  assert.equal(detail.refundedAmount, order.actualPaidAmount);
});

// ———————————————————— 八、接线：页面与接口都指向同一处规则 ————————————————————

test("接线：页面按服务端的 canDirectRefund 显示按钮，退款页对这两档不给申请表", () => {
  const read = (relative) => readFileSync(resolveSource(relative), "utf8");

  // 订单详情页：渲染条件是服务端给的那个布尔值，而不是「订单状态是不是某两档」
  const detailPage = read("app/orders/[id]/page.tsx");
  assert.match(detailPage, /\{allowedActions\.canDirectRefund\s*\?/, "按钮必须由服务端的值把守");
  for (const status of ["paid", "accepted"]) {
    assert.equal(
      detailPage.includes(`"${status}"`),
      false,
      `订单详情页自己认出了 "${status}"——「哪两档免审批」是服务端的规则，页面只该读布尔值`,
    );
  }

  // 退款表单页：必须先处理「可直接退款」这一支，否则用户会去看一条**永远等不到**的审批进度
  // （存量申请挂在 paid / accepted 单上时，两支会同时成立）
  const refundPage = read("app/orders/[id]/refund/page.tsx");
  assert.ok(
    refundPage.indexOf("canDirectRefund") < refundPage.indexOf("detail.refundSummary"),
    "「可直接全额退款」那一支必须排在「已有退款申请」之前",
  );

  // 按钮组件不认识订单状态：它只拿到 orderId 与金额，显隐由上面那个值决定
  const button = read("components/refunds/DirectRefundButton.tsx");
  assert.doesNotMatch(button, /status\s*===/, "退款按钮不该自己判断订单状态");
  assert.doesNotMatch(button, /OrderStatus/, "退款按钮不该认识订单状态类型");
});

/* ───────────────────────────── HTTP 契约 ───────────────────────────── */

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过直接退款的 HTTP 用例";

const HTTP_ORDER_USER = "u-1001";
/** 一启动就已经是有效打手、且资料关联了账号的那位（`cp-10`）。 */
const HTTP_COMPANION_USER = "u-1022";

/** 一个不可能存在的订单 id。 */
const MISSING_ORDER = "ord-does-not-exist";

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

/** 发一次请求并把 JSON 解开（失败响应也解——错误体的形状本身是要断言的东西）。 */
async function send(pathname, { cookie, method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, raw: text, json: text ? JSON.parse(text) : null };
}

/** 两套会话各拿一次，整组共用；拿不到就返回 null（服务端没开 Mock 登录）。 */
let httpSessionsPromise = null;
function httpSessions() {
  httpSessionsPromise ??= (async () => {
    const order = await loginAs(HTTP_ORDER_USER);
    const companion = await loginAs(HTTP_COMPANION_USER);
    if (!order || !companion) return null;
    return { order, companion };
  })();
  return httpSessionsPromise;
}

test("HTTP 守卫矩阵：未登录 401、别人的单 404、不存在的单 404、方法不对 405", { skip: SKIP_HTTP }, async () => {
  const sessions = await httpSessions();

  // (1) 未登录：无论请求体长什么样都是 401，且**不写任何数据**
  for (const body of [undefined, "{}", JSON.stringify({ amount: 1 })]) {
    const anonymous = await send(`/api/orders/${PAID_ORDER}/direct-refund`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.parse(body) }),
    });
    assert.equal(anonymous.status, 401, `未登录必须是 401：${anonymous.raw}`);
  }
  assert.equal((await orderOf(PAID_ORDER)).status, "paid", "401 的请求一个字段都不该写");

  if (!sessions) return; // 服务端没开 Mock 登录：与其它几条一样，如实不跑

  // (2) 别人的单与不存在的单：对外完全一样
  const other = await send(`/api/orders/${OTHER_USER_PAID_ORDER}/direct-refund`, {
    cookie: sessions.order,
    method: "POST",
  });
  assert.equal(other.status, 404, `别人的订单必须 404：${other.raw}`);
  const missing = await send(`/api/orders/${MISSING_ORDER}/direct-refund`, {
    cookie: sessions.order,
    method: "POST",
  });
  assert.equal(missing.status, 404, `不存在的订单必须 404：${missing.raw}`);
  assert.equal(
    other.json.error.message,
    missing.json.error.message,
    "两种情况的文案必须一样，否则能拿它试探别人有哪些订单",
  );
  assert.equal((await orderOf(OTHER_USER_PAID_ORDER)).status, "paid", "别人的单必须原封不动");

  // (3) 只认 POST。方法用错时 Next 在进入路由处理器**之前**就回 405
  const wrong = await send(`/api/orders/${PAID_ORDER}/direct-refund`, { cookie: sessions.order });
  assert.equal(wrong.status, 405);
});

test("HTTP 正例（paid）：真的把这一单退成 refunded，第二次点如实说「已全额退款」", { skip: SKIP_HTTP }, async () => {
  const sessions = await httpSessions();
  if (!sessions) return;

  // 全程 HTTP 造一张新订单：不碰预置数据，因此这条用例在同一个服务进程里可重复跑
  const pay = await send("/api/orders/pay", {
    cookie: sessions.order,
    method: "POST",
    body: { ...PRODUCT, quantity: 1, addonIds: [], gameAccountId: "moyu_test", remark: "", companionId: null, idempotencyKey: uniqueKey() },
  });
  assert.equal(pay.status, 200, `HTTP 下单必须成功：${pay.raw}`);
  const confirm = await send("/api/payments/mock-confirm", {
    cookie: sessions.order,
    method: "POST",
    body: { paymentRequestId: pay.json.data.id, result: "success" },
  });
  assert.equal(
    confirm.status,
    200,
    `HTTP 支付确认必须成功（需要服务端开着 ENABLE_MOCK_PAYMENT）：${confirm.raw}`,
  );
  const orderId = confirm.json.data.orderId;
  assert.ok(orderId, "支付成功后必须拿到 orderId");

  const before = await send(`/api/orders/${orderId}`, { cookie: sessions.order });
  assert.equal(before.status, 200, `订单详情必须能读到：${before.raw}`);
  assert.equal(before.json.data.status, "paid");
  assert.equal(before.json.data.allowedActions.canDirectRefund, true, "刚付款的单必须有直接退款入口");
  assert.equal(before.json.data.allowedActions.canRequestRefund, false);

  const refunded = await send(`/api/orders/${orderId}/direct-refund`, {
    cookie: sessions.order,
    method: "POST",
  });
  assert.equal(refunded.status, 200, `直接退款必须成功：${refunded.raw}`);
  assert.deepEqual(Object.keys(refunded.json.data).sort(), [
    "orderId",
    "orderNo",
    "refundedAmount",
    "refundedAt",
  ]);
  assert.equal(refunded.json.data.refundedAmount, before.json.data.actualPaidAmount);

  // ⚠️ 只看 200 是不够的：必须回到读接口确认真被改了（P0-11 的教训）
  const after = await send(`/api/orders/${orderId}`, { cookie: sessions.order });
  assert.equal(after.json.data.status, "refunded");
  assert.equal(after.json.data.refundedAmount, before.json.data.actualPaidAmount);
  assert.equal(after.json.data.allowedActions.canDirectRefund, false, "退过之后入口必须收起");

  // 再点一次：如实告知已经退过了，且订单的退款时刻没有被刷新
  const again = await send(`/api/orders/${orderId}/direct-refund`, {
    cookie: sessions.order,
    method: "POST",
  });
  assert.equal(again.status, 400, `重复退款必须被拒：${again.raw}`);
  assert.equal(again.json.error.message, DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE);
  const stillRefunded = await send(`/api/orders/${orderId}`, { cookie: sessions.order });
  assert.equal(stillRefunded.json.data.refundedAt, after.json.data.refundedAt);
});

test("HTTP 正例（accepted）：接单后退款，通知真的落到了打手账号上", { skip: SKIP_HTTP }, async () => {
  const sessions = await httpSessions();
  if (!sessions) return;

  // 下单 → 支付 → 打手接单，全程 HTTP
  const pay = await send("/api/orders/pay", {
    cookie: sessions.order,
    method: "POST",
    body: { ...PRODUCT, quantity: 1, addonIds: [], gameAccountId: "moyu_test", remark: "", companionId: null, idempotencyKey: uniqueKey() },
  });
  assert.equal(pay.status, 200, `HTTP 下单必须成功：${pay.raw}`);
  const confirm = await send("/api/payments/mock-confirm", {
    cookie: sessions.order,
    method: "POST",
    body: { paymentRequestId: pay.json.data.id, result: "success" },
  });
  assert.equal(confirm.status, 200, `HTTP 支付确认必须成功：${confirm.raw}`);
  const orderId = confirm.json.data.orderId;

  const pool = await send("/api/companion/dispatches", { cookie: sessions.companion });
  assert.equal(pool.status, 200, `打手会话必须能读到订单池：${pool.raw}`);
  const item = [...pool.json.data.exclusive, ...pool.json.data.public].find(
    (each) => each.orderId === orderId,
  );
  assert.ok(item, `刚支付成功的单必须出现在 ${HTTP_COMPANION_USER} 的池子里，否则这一条空转`);
  const accept = await send(`/api/companion/dispatches/${item.dispatchId}/accept`, {
    cookie: sessions.companion,
    method: "POST",
  });
  assert.equal(accept.status, 200, `接单必须成功：${accept.raw}`);

  const refunded = await send(`/api/orders/${orderId}/direct-refund`, {
    cookie: sessions.order,
    method: "POST",
  });
  assert.equal(refunded.status, 200, `已接单的单也必须能直接退款：${refunded.raw}`);

  // 订单侧：已退款，但**仍然指得到当初接单的人**（历史事实不抹平）
  const detail = await send(`/api/orders/${orderId}`, { cookie: sessions.order });
  assert.equal(detail.json.data.status, "refunded");
  assert.ok(detail.json.data.companion, "退款后打手快照必须还在");

  // 打手侧：收件箱里真的有一条指向这一单的通知
  const inbox = await send("/api/notifications", { cookie: sessions.companion });
  assert.equal(inbox.status, 200, `打手必须能读到自己的通知：${inbox.raw}`);
  const mine = inbox.json.data.items.filter((each) => each.href === `/companion/orders/${orderId}`);
  assert.equal(mine.length, 1, "必须恰好一条「订单已退款」通知");
  assert.equal(mine[0].kind, "refund");
  assert.equal(mine[0].title, REFUND_NOTIFICATION_COMPANION_REFUNDED.title);
});
