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
import { refundSeed } from "../lib/mocks/fixtures/refundSeed.ts";
import {
  cancelRefundForUser,
  createRefundForOrder,
  getOrderRefundSummary,
  getRefundDetailForUser,
} from "../lib/services/refunds.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";

/**
 * 退款业务的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/refunds.ts`，
 * 因此「哪些订单能退」「提交不改订单状态」「一笔订单只有一条申请」「只有待审核能撤销」
 * 「看不到别人的退款」这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * 每个用例开始前重建退款 store（拿到干净的预置数据）。订单 store 不重建：
 * **退款本来就不该改动订单**，任何用例把订单改了都应当在这里暴露出来。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 没有预置退款记录、且状态可退的订单（每个用例用不同的一单，互不干扰）。 */
const FREE_PAID_ORDER = "ord-seed-1001-02";
const FREE_ACCEPTED_ORDER = "ord-seed-1001-11";
const FREE_SERVING_ORDER = "ord-seed-1001-10";
const COMPLETED_ORDER = "ord-seed-1001-05";
/** 已退款但**没有**退款记录的订单：用来验证「状态本身不可退」这条，而不是「已有记录」那条 */
const REFUNDED_ORDER = "ord-seed-1001-13";
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

test("可退款状态：已付款 / 已接单 / 护航中的订单都能提交退款申请", async () => {
  for (const orderId of [FREE_PAID_ORDER, FREE_ACCEPTED_ORDER, FREE_SERVING_ORDER]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.ok(isOrderRefundable(detail.status), `${orderId} 应当是可退款状态`);
    assert.equal(detail.allowedActions.canRequestRefund, true);

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

test("已完成 / 已退款的订单不能申请退款", async () => {
  for (const orderId of [COMPLETED_ORDER, REFUNDED_ORDER]) {
    await expectApiError(
      createRefundForOrder(orderId, USER_A, refundBody(), undefined, "server"),
      "BAD_REQUEST",
      REFUND_ORDER_NOT_ALLOWED_MESSAGE,
    );
    // 失败的提交不能留下任何记录
    assert.equal(await getOrderRefundSummary(orderId), null);
  }
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
  const clean = "ord-seed-1002-02";
  const withRecord = "ord-seed-1002-01";

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
  assert.equal(canRequestRefund("paid", false), true);
  assert.equal(canRequestRefund("accepted", false), true);
  assert.equal(canRequestRefund("serving", false), true);
  assert.equal(canRequestRefund("completed", false), false);
  assert.equal(canRequestRefund("refunded", false), false);
  // 有记录（无论是否进行中）都不再出现入口
  assert.equal(canRequestRefund("paid", true), false);
});
