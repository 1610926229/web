import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  REFUND_ALREADY_ACTIVE_MESSAGE,
  REFUND_NOT_CANCELLABLE_MESSAGE,
  REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  REFUND_RECORD_EXISTS_MESSAGE,
  canRequestRefund,
  isOrderRefundable,
} from "../lib/constants/refunds.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { refundSeed } from "../lib/mocks/fixtures/refundSeed.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import {
  cancelRefundForUser,
  createRefundForOrder,
  getOrderRefundSummary,
  getRefundDetailForUser,
} from "../lib/services/refunds.ts";
import { getConsumptionLevelForUser } from "../lib/services/levels.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";

/**
 * 退款业务的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/refunds.ts`，
 * 因此「哪些订单能退」「提交不改订单状态与累计消费」「一笔订单只有一条申请」
 * 「只有待审核能撤销」「看不到别人的退款」这些规则每次提交都会被重新验证。
 *
 * ⚠️ 四条可退款状态里包含**已完成**：它才是唯一计入消费的状态，不能退就等于
 * 那笔已计入的钱永远退不掉（口径见 `lib/constants/levels.ts`）。放开的是入口，
 * 不是流程——提交仍然只产生一条待审核记录，订单要等管理者审核通过才会变。
 *
 * 每个用例开始前重建退款 store（拿到干净的预置数据）。订单 store 不重建：
 * **退款本来就不该改动订单**，任何用例把订单改了都应当在这里暴露出来。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/**
 * 没有预置退款记录、且状态可退的订单（每个用例用不同的一单，互不干扰）。
 *
 * 四条各对应一种可退款状态，其中 `FREE_COMPLETED_ORDER` 是**唯一会被计入消费**的那种：
 * 消费口径只认已完成（`CONSUMPTION_ORDER_STATUS`），所以「已完成能不能退」是
 * 「已计入的钱能不能退」这个问题的全部。
 */
const FREE_PAID_ORDER = "ord-seed-1001-02";
const FREE_ACCEPTED_ORDER = "ord-seed-1001-11";
const FREE_SERVING_ORDER = "ord-seed-1001-10";
const FREE_COMPLETED_ORDER = "ord-seed-1001-05";
/** 已退款但**没有**退款记录的订单：用来验证「状态本身不可退」这条，而不是「已有记录」那条 */
const REFUNDED_ORDER = "ord-seed-1001-13";
/** 别人（u-1002）的已完成订单：验证「能退」没有把归属校验一起放开 */
const OTHER_USER_COMPLETED_ORDER = "ord-seed-1002-02";
/** 预置了「已拒绝」退款的订单：状态可退，但已有记录，本阶段不支持重复申请 */
const REJECTED_PRESET_ORDER = "ord-seed-1001-01";
/** 预置了「待审核」退款的订单 */
const PENDING_PRESET_ORDER = "ord-seed-1001-03";

function key() {
  return crypto.randomUUID();
}

function refundBody(overrides = {}) {
  return {
    reasonKey: "other",
    description: "临时有事，这一单打不了了，麻烦帮我退掉。",
    evidence: [],
    idempotencyKey: key(),
    ...overrides,
  };
}

async function orderStatus(orderId, userId = USER_A) {
  const detail = await getOrderDetailForUser(orderId, userId, undefined, "server");
  return detail?.status ?? null;
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("refund");
});

test("可退款状态：已付款 / 已接单 / 护航中 / 已完成的订单都能提交退款申请", async () => {
  for (const orderId of [
    FREE_PAID_ORDER,
    FREE_ACCEPTED_ORDER,
    FREE_SERVING_ORDER,
    FREE_COMPLETED_ORDER,
  ]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.ok(isOrderRefundable(detail.status), `${orderId} 应当是可退款状态`);
    assert.equal(
      detail.allowedActions.canRequestRefund,
      true,
      `${orderId}（${detail.status}）的订单详情必须给出申请退款入口`,
    );

    const result = await createRefundForOrder(orderId, USER_A, refundBody(), undefined, "server");
    assert.ok(result.refundId);
    assert.equal(result.created, true);
  }
});

test("提交退款后订单状态不变，退款自身是「待审核」且金额等于订单实付", async () => {
  const before = await getOrderDetailForUser(FREE_SERVING_ORDER, USER_A, undefined, "server");

  const { refundId } = await createRefundForOrder(
    FREE_SERVING_ORDER,
    USER_A,
    refundBody({ reasonKey: "schedule_conflict" }),
    undefined,
    "server",
  );

  // 1. 订单状态一个字段都没变
  const after = await getOrderDetailForUser(FREE_SERVING_ORDER, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.notEqual(after.status, "refunded");

  // 2. 订单详情里多出的是「退款摘要」，不是订单状态的变化
  assert.equal(after.refundSummary.id, refundId);
  assert.equal(after.refundSummary.status, "pending");
  // 已经有退款记录了，入口随之消失（能不能退由服务端给，前端不推断）
  assert.equal(after.allowedActions.canRequestRefund, false);

  // 3. 退款金额取订单实付金额，退款状态是用户唯一能提交出来的「待审核」
  const refund = await getRefundDetailForUser(refundId, USER_A, undefined, "server");
  assert.equal(refund.status, "pending");
  assert.equal(refund.amount, before.totalAmount);
  assert.equal(refund.reasonKey, "schedule_conflict");
  assert.equal(refund.orderStatus, before.status);
});

test("金额由服务端决定：请求体里塞 amount 也不会被采纳", async () => {
  const detail = await getOrderDetailForUser(FREE_PAID_ORDER, USER_A, undefined, "server");
  const { refundId } = await createRefundForOrder(
    FREE_PAID_ORDER,
    USER_A,
    refundBody({ amount: 1, totalAmount: 1 }),
    undefined,
    "server",
  );

  const refund = await getRefundDetailForUser(refundId, USER_A, undefined, "server");
  assert.equal(refund.amount, detail.totalAmount);
  assert.notEqual(refund.amount, 1);
});

test("已完成与已付款一样能提交；已退款是真不能申请的那一种", async () => {
  // 已完成是**唯一计入消费**的状态，因此它必须能退：不能退就等于那笔已计入的钱退不掉
  const submitted = await createRefundForOrder(
    FREE_COMPLETED_ORDER,
    USER_A,
    refundBody(),
    undefined,
    "server",
  );
  assert.equal(submitted.created, true);
  assert.equal((await getOrderRefundSummary(FREE_COMPLETED_ORDER)).status, "pending");

  // 已退款：钱已经退过了，状态本身就不该再有入口
  await expectApiError(
    createRefundForOrder(REFUNDED_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  );
  // 失败的提交不能留下任何记录
  assert.equal(await getOrderRefundSummary(REFUNDED_ORDER), null);
});

test("提交已完成订单的退款：订单仍是已完成，消费等级与排行榜一点都不变", async () => {
  const before = await getOrderDetailForUser(FREE_COMPLETED_ORDER, USER_A, undefined, "server");
  assert.equal(before.status, "completed");

  // 等级摘要（含累计有效消费金额）与累计榜的「我的排名」都先记下来
  const levelBefore = await getConsumptionLevelForUser(USER_A, undefined, "server");
  const rankingBefore = await getConsumptionRanking(
    USER_A,
    new URLSearchParams({ period: "all" }),
    "server",
    getMockSeedNow(),
  );
  assert.ok(levelBefore.effectiveSpendAmount > 0, "这一单必须真的被计入过消费，否则这条断言没有说服力");

  await createRefundForOrder(FREE_COMPLETED_ORDER, USER_A, refundBody(), undefined, "server");

  // 1. 订单状态一个字段都没变，多出来的只是一条待审核的退款摘要
  const after = await getOrderDetailForUser(FREE_COMPLETED_ORDER, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.notEqual(after.status, "refunded");
  assert.deepEqual(Object.keys(after.refundSummary).sort(), ["amount", "createdAt", "id", "status"]);
  assert.equal(after.refundSummary.status, "pending");
  assert.equal(after.refundSummary.amount, before.totalAmount);

  // 2. 消费等级：金额一分不少（提交退款不立即修改累计消费）
  const levelAfter = await getConsumptionLevelForUser(USER_A, undefined, "server");
  assert.deepEqual(levelAfter, levelBefore, "提交退款不该动累计消费与等级");

  // 3. 排行榜：整张榜一字不变（名次、金额、上榜的人都不能因为「有人提交了退款」而变）
  const rankingAfter = await getConsumptionRanking(
    USER_A,
    new URLSearchParams({ period: "all" }),
    "server",
    getMockSeedNow(),
  );
  assert.deepEqual(rankingAfter.rows, rankingBefore.rows, "提交退款不该影响任何一期的排行榜");
  assert.deepEqual(rankingAfter.me, rankingBefore.me);
});

test("一笔订单不能有两条进行中的退款申请", async () => {
  // 先提交一条，再用另一个幂等键提交第二条：应当被挡住，且只有一条记录
  const first = await createRefundForOrder(FREE_PAID_ORDER, USER_A, refundBody(), undefined, "server");
  await expectApiError(
    createRefundForOrder(FREE_PAID_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ALREADY_ACTIVE_MESSAGE,
  );

  const summary = await getOrderRefundSummary(FREE_PAID_ORDER);
  assert.equal(summary.id, first.refundId);
  assert.equal(summary.status, "pending");
});

test("预置的进行中退款挡住新申请；已结束的退款记录给出不同的提示", async () => {
  await expectApiError(
    createRefundForOrder(PENDING_PRESET_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ALREADY_ACTIVE_MESSAGE,
  );
  await expectApiError(
    createRefundForOrder(REJECTED_PRESET_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_RECORD_EXISTS_MESSAGE,
  );
});

test("同一个幂等键重复提交只产生一条记录", async () => {
  const body = refundBody();
  const first = await createRefundForOrder(FREE_ACCEPTED_ORDER, USER_A, body, undefined, "server");
  const second = await createRefundForOrder(FREE_ACCEPTED_ORDER, USER_A, body, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.refundId, first.refundId);
});

test("只有待审核的退款可以撤销；撤销不改动订单状态", async () => {
  const before = await orderStatus(FREE_PAID_ORDER);
  const { refundId } = await createRefundForOrder(FREE_PAID_ORDER, USER_A, refundBody(), undefined, "server");

  const cancelled = await cancelRefundForUser(refundId, USER_A);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await orderStatus(FREE_PAID_ORDER), before);

  // 撤销后再次撤销：状态已经不是待审核
  await expectApiError(cancelRefundForUser(refundId, USER_A), "BAD_REQUEST", REFUND_NOT_CANCELLABLE_MESSAGE);
});

test("审核中 / 已通过 / 已拒绝的退款都不能由用户撤销", async () => {
  const reviewing = refundSeed.find((refund) => refund.status === "reviewing");
  const approved = refundSeed.find((refund) => refund.status === "approved");
  const rejected = refundSeed.find((refund) => refund.status === "rejected");

  for (const refund of [reviewing, approved, rejected]) {
    await expectApiError(
      cancelRefundForUser(refund.id, USER_A),
      "BAD_REQUEST",
      REFUND_NOT_CANCELLABLE_MESSAGE,
    );
  }

  // 撤销失败不能留下任何状态变化
  const stillReviewing = await getRefundDetailForUser(reviewing.id, USER_A, undefined, "server");
  assert.equal(stillReviewing.status, "reviewing");
});

test("用户隔离：看不到、也撤销不了别人的退款申请", async () => {
  const otherPending = refundSeed.find((refund) => refund.userId === USER_B && refund.status === "pending");

  // 对方看 u-1001 的退款：不存在与不属于自己表现完全一致
  assert.equal(await getRefundDetailForUser(refundSeed[0].id, USER_B, undefined, "server"), null);
  // u-1001 看 u-1002 的退款同样拿不到
  assert.equal(await getRefundDetailForUser(otherPending.id, USER_A, undefined, "server"), null);

  // 撤销别人的申请：NOT_FOUND，而不是「不是你的」
  await expectApiError(cancelRefundForUser(otherPending.id, USER_A), "NOT_FOUND");

  // 撤销失败后对方的数据完好
  const intact = await getRefundDetailForUser(otherPending.id, USER_B, undefined, "server");
  assert.equal(intact.status, "pending");
});

test("给别人订单提交退款：404，且不产生记录", async () => {
  // 一笔是干净订单（没有退款记录），一笔本来就有记录：两种都不该被改动
  const clean = OTHER_USER_COMPLETED_ORDER;
  const withRecord = "ord-seed-1002-01";

  // 归属校验在「能不能退」之前：放开了已完成可退，也**没有**放开「能退别人的已完成订单」
  assert.equal(
    (await getOrderDetailForUser(clean, USER_B, undefined, "server")).status,
    "completed",
    "这一单必须是已完成，才谈得上「放开已完成可退没把归属一起放开」",
  );
  await expectApiError(
    createRefundForOrder(clean, USER_A, refundBody(), undefined, "server"),
    "NOT_FOUND",
  );
  await expectApiError(
    createRefundForOrder(withRecord, USER_A, refundBody(), undefined, "server"),
    "NOT_FOUND",
  );

  assert.equal(await getOrderRefundSummary(clean), null);
  const untouched = await getOrderRefundSummary(withRecord);
  assert.equal(untouched.id, "rf-seed-1002-01");
  assert.equal(untouched.status, "pending");
});

test("预置数据自洽：已通过的退款对应已退款的订单，进行中的退款不改变订单状态", () => {
  for (const refund of refundSeed) {
    const order = orderSeed.find((item) => item.id === refund.orderId);
    assert.ok(order, `预置退款 ${refund.id} 关联的订单不存在`);
    assert.equal(order.userId, refund.userId, `预置退款 ${refund.id} 与订单归属不一致`);
    assert.equal(refund.amount, order.totalAmount);

    if (refund.status === "approved") {
      assert.equal(order.status, "refunded", `已通过的退款 ${refund.id} 对应订单必须是已退款`);
    } else {
      assert.notEqual(order.status, "refunded", `未通过的退款 ${refund.id} 对应订单不能是已退款`);
    }
    if (refund.status === "pending" || refund.status === "reviewing") {
      assert.ok(isOrderRefundable(order.status), `进行中的退款 ${refund.id} 对应订单必须仍可退款`);
    }
  }

  // 五种状态在预置数据里都能看到（页面才能被完整验收）
  const statuses = new Set(refundSeed.map((refund) => refund.status));
  for (const status of ["pending", "reviewing", "approved", "rejected", "cancelled"]) {
    assert.ok(statuses.has(status), `预置数据缺少 ${status} 状态的退款`);
  }
});

test("DTO 边界：退款摘要不含原因、说明与凭证", async () => {
  const summary = await getOrderRefundSummary(PENDING_PRESET_ORDER);
  assert.deepEqual(Object.keys(summary).sort(), ["amount", "createdAt", "id", "status"]);
});

test("纯规则函数：canRequestRefund 同时看订单状态与有无退款记录", () => {
  // 四种业务状态都可退——包含**已完成**：它是唯一计入消费的状态，不能退就等于钱退不掉
  assert.equal(canRequestRefund("paid", false), true);
  assert.equal(canRequestRefund("accepted", false), true);
  assert.equal(canRequestRefund("serving", false), true);
  assert.equal(canRequestRefund("completed", false), true);
  // 已退款是真不可退：钱已经退过了
  assert.equal(canRequestRefund("refunded", false), false);

  // 有记录（无论进行中、已通过还是已结束）都不再出现入口：本阶段仍是一笔订单一条记录
  for (const status of ["paid", "accepted", "serving", "completed"]) {
    assert.equal(canRequestRefund(status, true), false, `${status} 已有退款记录时不该再出现入口`);
  }
});
