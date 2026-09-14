import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { ADMIN_REVIEW_NOTE_MAX_LENGTH } from "../lib/constants/adminApplications.ts";
import {
  ADMIN_REFUND_STATUS_INVALID_MESSAGE,
  ADMIN_REFUND_TRANSITIONS,
  adminRefundAllowedActions,
  canTransitionRefund,
  refundMatchesAdminKeyword,
} from "../lib/constants/adminRefunds.ts";
import { CONSUMPTION_ORDER_STATUS, sumEffectiveSpend } from "../lib/constants/levels.ts";
import { beijingDayStart } from "../lib/constants/rankingPeriods.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { getUserRepository } from "../lib/data/userRepository.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import {
  approveAdminRefund,
  getAdminRefundDetail,
  queryAdminRefundList,
  rejectAdminRefund,
  resolveAdminRefundListQuery,
  startReviewAdminRefund,
} from "../lib/services/adminRefunds.ts";
import { getConsumptionLevelForUser } from "../lib/services/levels.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import { createRefundForOrder } from "../lib/services/refunds.ts";

/**
 * 管理端退款审核的持续测试（P8C）。
 *
 * 跑的是**真实实现**：真实的 Mock 退款 / 支付仓储 + 真实的伪事务 +
 * 真实的 `lib/services/adminRefunds.ts`。因此状态机、金额不可改、
 * 「拒绝不动订单」「通过原子改退款与订单」「幂等与审计恰好一次」这些规则
 * 每次提交都会被重新验证。
 *
 * 后半部分专门覆盖**已完成订单的退款**：消费口径只认已完成，所以已完成的订单必须能退，
 * 否则那笔已计入累计消费的钱永远退不掉。这里端到端地验证「提交 / 审核中 / 拒绝都不动
 * 订单与消费，只有通过才同时改两边，并且六个周期榜按完成时间归属准确扣减」——
 * 不是断言「可退款状态与已完成不相交」那种把缺口写成门禁的话。
 *
 * 每个用例开始前重建退款、审计与订单三个仓储：退款与订单要干净（通过会真的改订单），
 * 审计要**空**——「恰好一次」只有在从零开始时才数得清。
 */
const ADMIN = "admin-1";
const SURFACE = "server";

/** 待审核、且订单处于「已接单」的预置退款 */
const PENDING_REFUND = "rf-seed-1001-01";
/** 审核中、订单处于「护航中」的预置退款 */
const REVIEWING_REFUND = "rf-seed-1001-02";
/** 已通过（终态） */
const APPROVED_REFUND = "rf-seed-1001-03";
/** 已拒绝（终态） */
const REJECTED_REFUND = "rf-seed-1001-04";
/** 已撤销（终态） */
const CANCELLED_REFUND = "rf-seed-1001-05";

function key() {
  return crypto.randomUUID();
}

async function refundOf(id) {
  return getRefundRepository().findRefundById(id);
}

async function orderOf(id) {
  const refund = await refundOf(id);
  return getPaymentRepository().findOrderById(refund.orderId);
}

async function auditCount() {
  return adminAuditStore().audits.size;
}

async function auditsFor(targetId) {
  return [...adminAuditStore().audits.values()].filter((entry) => entry.targetId === targetId);
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
  resetMockStore("adminAudit");
  // ⚠️ **订单仓储也要重建**，与用户端的 `refunds.test.mjs` 不同：
  // 那边的退款流程一行订单代码都不碰，靠不重建来抓「偷偷改了订单」；
  // 这里「通过」本来就要把订单改成已退款，不重建就会让上一个用例的退款状态漏到下一个。
  resetMockStore("payment");
});

// ——————————————————————————— 状态机 ———————————————————————————

test("状态机：终态没有出边，撤销没有入边（管理端不能替用户撤销）", () => {
  assert.deepEqual(ADMIN_REFUND_TRANSITIONS.pending, ["reviewing", "approved", "rejected"]);
  assert.deepEqual(ADMIN_REFUND_TRANSITIONS.reviewing, ["approved", "rejected"]);
  for (const terminal of ["approved", "rejected", "cancelled"]) {
    assert.deepEqual(ADMIN_REFUND_TRANSITIONS[terminal], [], `${terminal} 必须是终态`);
  }

  // `cancelled` 的入边是空的：撤销只由用户在用户端点，管理端没有这个动作
  for (const from of ["pending", "reviewing", "approved", "rejected"]) {
    assert.equal(canTransitionRefund(from, "cancelled"), false, `${from} 不该能迁到已撤销`);
  }
  // 原地不动不是迁移
  for (const status of ["pending", "reviewing", "approved", "rejected", "cancelled"]) {
    assert.equal(canTransitionRefund(status, status), false);
  }
});

test("可执行动作由状态推导：终态三项全 false，页面因此没有灰按钮", () => {
  assert.deepEqual(adminRefundAllowedActions("pending"), {
    canStartReview: true,
    canApprove: true,
    canReject: true,
  });
  assert.deepEqual(adminRefundAllowedActions("reviewing"), {
    canStartReview: false,
    canApprove: true,
    canReject: true,
  });
  for (const terminal of ["approved", "rejected", "cancelled"]) {
    assert.deepEqual(
      adminRefundAllowedActions(terminal),
      { canStartReview: false, canApprove: false, canReject: false },
      `${terminal} 不该有可执行动作`,
    );
  }
});

test("非法迁移一律 400 且带上当前状态：重复通过、拒绝之后再通过都不行", async () => {
  // 终态：三个动作全部拒绝
  for (const [id, status] of [
    [APPROVED_REFUND, "已通过"],
    [REJECTED_REFUND, "已拒绝"],
    [CANCELLED_REFUND, "已撤销"],
  ]) {
    for (const call of [
      () => startReviewAdminRefund(id, ADMIN, { idempotencyKey: key() }),
      () => approveAdminRefund(id, ADMIN, { idempotencyKey: key() }),
      () => rejectAdminRefund(id, ADMIN, { idempotencyKey: key(), reviewNote: "不行" }),
    ]) {
      await assert.rejects(call(), (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.ok(error.message.includes(status), `提示里要说清当前状态是「${status}」`);
        return true;
      });
    }
  }

  // 审核中不能回到待审核（没有这个迁移），但可以直接通过或拒绝
  await expectApiError(
    startReviewAdminRefund(REVIEWING_REFUND, ADMIN, { idempotencyKey: key() }),
    "BAD_REQUEST",
  );
  const approved = await approveAdminRefund(REVIEWING_REFUND, ADMIN, { idempotencyKey: key() });
  assert.equal(approved.status, "approved");

  // 不存在的退款：404，且与「状态不对」区分开
  await expectApiError(
    approveAdminRefund("rf-nope", ADMIN, { idempotencyKey: key() }),
    "NOT_FOUND",
  );
  await expectApiError(
    startReviewAdminRefund("", ADMIN, { idempotencyKey: key() }),
    "NOT_FOUND",
  );
});

// ——————————————————————————— 开始审核 ———————————————————————————

test("开始审核只改退款申请：订单状态、金额与用户消费一个都不动", async () => {
  const before = await orderOf(PENDING_REFUND);
  const levelBefore = await getConsumptionLevelForUser(before.userId, undefined, SURFACE);

  const result = await startReviewAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key() });

  assert.equal(result.status, "reviewing");
  assert.equal(result.changed, true);
  assert.equal(result.orderChanged, false, "开始审核不该动订单");
  assert.equal(result.orderStatus, before.status);

  const refund = await refundOf(PENDING_REFUND);
  assert.equal(refund.status, "reviewing");
  assert.ok(refund.reviewingAt, "开始审核要记下开始时间");
  assert.equal(refund.reviewedAt, null, "开始审核不是结论，不该有完成时间");
  assert.equal(refund.reviewedBy, null, "开始审核不产生审核人——谁开始看的由审计回答");
  assert.equal(refund.reviewNote, "", "开始审核不写审核意见");

  const after = await orderOf(PENDING_REFUND);
  assert.deepEqual(after, before, "订单必须一字未改");

  const levelAfter = await getConsumptionLevelForUser(before.userId, undefined, SURFACE);
  assert.deepEqual(levelAfter, levelBefore, "消费等级与累计金额不该被动过");
});

// ——————————————————————————— 拒绝 ———————————————————————————

test("拒绝必须填写审核意见：空、只有空格、超长都是 400", async () => {
  for (const note of ["", "   ", "\n\t", "x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH + 1)]) {
    await assert.rejects(
      rejectAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key(), reviewNote: note }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }

  // 上限之内可以：等于上限这一条也要能过
  const ok = await rejectAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH),
  });
  assert.equal(ok.status, "rejected");
});

test("拒绝不改订单状态，也不改消费金额：两条状态线各走各的", async () => {
  // 这一笔的订单正处在「护航中」——被拒绝之后它必须还是「护航中」
  const before = await orderOf(REVIEWING_REFUND);
  const levelBefore = await getConsumptionLevelForUser(before.userId, undefined, SURFACE);

  const result = await rejectAdminRefund(REVIEWING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核对服务记录，本次申请不符合同意条件。",
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.orderChanged, false);
  assert.equal(result.orderStatus, before.status, "被拒绝的那一单订单状态必须原样");
  assert.notEqual(before.status, "refunded");

  const refund = await refundOf(REVIEWING_REFUND);
  assert.equal(refund.status, "rejected");
  assert.equal(refund.reviewNote, "已核对服务记录，本次申请不符合同意条件。");
  assert.ok(refund.reviewedAt);
  assert.equal(refund.reviewedBy, ADMIN);

  const after = await orderOf(REVIEWING_REFUND);
  assert.deepEqual(after, before, "被拒绝的那一单订单状态必须原样");

  const levelAfter = await getConsumptionLevelForUser(before.userId, undefined, SURFACE);
  assert.deepEqual(levelAfter, levelBefore);
});

// ——————————————————————————— 通过（原子） ———————————————————————————

test("通过：退款与订单在同一次写入里改到位，审核人 / 意见 / 时间一次记全", async () => {
  const before = await orderOf(PENDING_REFUND);
  assert.notEqual(before.status, "refunded");

  const result = await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核实服务未按约定开始。",
  });

  assert.equal(result.status, "approved");
  assert.equal(result.changed, true);
  assert.equal(result.orderChanged, true, "通过是唯一会动订单的动作");
  assert.equal(result.orderStatus, "refunded");
  assert.ok(result.reviewedAt);

  const refund = await refundOf(PENDING_REFUND);
  assert.equal(refund.status, "approved");
  assert.equal(refund.reviewedBy, ADMIN);
  assert.equal(refund.reviewNote, "已核实服务未按约定开始。");
  assert.equal(refund.amount, before.totalAmount, "退款金额取自订单实付快照");

  const after = await orderOf(PENDING_REFUND);
  assert.equal(after.status, "refunded");
  assert.ok(after.refundedAt, "订单要记下退款时间");
  assert.equal(after.totalAmount, before.totalAmount, "订单金额一个字都不改");
  assert.equal(after.productTitle, before.productTitle, "商品快照不动");
  assert.equal(after.userId, before.userId);
});

test("通过的意见选填：不填也能通过，且不会把空字符串当成结论写进去", async () => {
  const result = await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "",
  });
  assert.equal(result.status, "approved");

  const refund = await refundOf(PENDING_REFUND);
  assert.equal(refund.reviewNote, "");
  // 空意见不写审核人之外的任何东西，但结论仍然是完整的
  assert.equal(refund.reviewedBy, ADMIN);
});

test("退款金额不可篡改：请求体里的 amount / status 等字段一律被白名单忽略", async () => {
  const before = await refundOf(PENDING_REFUND);
  const order = await orderOf(PENDING_REFUND);

  await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    // 客户端伪造：金额、状态、审核人、审核时间、订单状态、退款单号
    amount: 1,
    status: "rejected",
    reviewedBy: "admin-999",
    reviewedAt: "2000-01-01T00:00:00.000Z",
    orderStatus: "completed",
    refundNo: "FAKE",
    orderId: "ord-nope",
  });

  const after = await refundOf(PENDING_REFUND);
  assert.equal(after.amount, before.amount, "金额必须还是申请时的快照");
  assert.equal(after.amount, order.totalAmount);
  assert.equal(after.status, "approved", "状态由服务端的状态机决定，不由请求体决定");
  assert.equal(after.reviewedBy, ADMIN, "审核人来自服务端会话");
  assert.notEqual(after.reviewedAt, "2000-01-01T00:00:00.000Z");
  assert.equal(after.refundNo, before.refundNo);
  assert.equal(after.orderId, before.orderId);

  const orderAfter = await getPaymentRepository().findOrderById(before.orderId);
  assert.equal(orderAfter.status, "refunded", "订单状态由通过决定，不由请求体决定");
});

test("纯口径：已退款订单在任何计入口径里都是零", async () => {
  const userId = (await orderOf(PENDING_REFUND)).userId;

  // 机制：口径只认「已完成」。把它改成已退款，累计金额必须正好少掉它的实付金额。
  const completed = (await getPaymentRepository().listOrdersByUser(userId)).find(
    (order) => order.status === "completed",
  );
  assert.ok(completed, "这位用户应当有已完成订单，否则这条对照做不了");
  assert.equal(sumEffectiveSpend([completed]), completed.totalAmount);
  assert.equal(sumEffectiveSpend([{ ...completed, status: "refunded" }]), 0);

  // 预置的已退款订单一分都不进累计——它的金额不为零，才说明它确实是被排除的
  const refundedOrders = (await getPaymentRepository().listAllOrders()).filter(
    (order) => order.status === "refunded",
  );
  assert.ok(refundedOrders.length > 0, "预置数据里应当有已退款订单，否则这条断言没有说服力");
  for (const order of refundedOrders) {
    assert.ok(order.totalAmount > 0);
    assert.equal(sumEffectiveSpend([order]), 0);
  }
});

// ———————————————— 已完成订单的退款：已计入消费的钱真的会回退 ————————————————
//
// 这一节回答 P8C 报告暴露的缺口：消费口径只认「已完成」，那么已完成的订单就必须能退，
// 否则那笔已计入的钱永远退不掉。**能退**不等于**好退**——退款与订单始终是两条独立的
// 状态机：提交、审核中、被拒绝三条路上，订单与消费都一动不动；只有「通过」会同时改动
// 退款状态、订单状态与消费口径的结果。

/**
 * 已完成、因而**被计入消费**的订单。
 *
 * 它由 `buildRankingPeriodOrders` 相对进程内基准时间生成，完成时间落在「今日」区间内
 * （因此也落在本周、本月、累计），不在昨日与上月——下面那张周期表就是照着这个事实写的。
 */
const COUNTED_ORDER = "ord-rank-today-1001";
const COUNTED_USER = "u-1001";
/** 同一用户的另一笔已完成订单：用来验证「拒绝」这条路不动消费 */
const OTHER_COUNTED_ORDER = "ord-seed-1001-05";

/**
 * 六个周期各自的**语义**预期：这一单的完成时间在不在这个周期里。
 *
 * 这张表是手写的断言目标，不是从实现里读出来的：如果周期过滤坏掉（例如所有周期都
 * 变成了累计），下面「不该受影响的周期一字不变」立刻失败。
 */
const PERIOD_EXPECTATION = [
  ["today", true],
  ["yesterday", false],
  ["week", true],
  ["month", true],
  ["lastMonth", false],
  ["all", true],
];

async function orderById(id) {
  return getPaymentRepository().findOrderById(id);
}

/** 累计有效消费金额（分）。 */
async function spendOf(userId) {
  return (await getConsumptionLevelForUser(userId, undefined, SURFACE)).effectiveSpendAmount;
}

/** 取某个周期的一页榜单。`now` 用进程内基准时间，与本文件预置订单的构造时间一致。 */
function rankingPage(period, viewerUserId = COUNTED_USER) {
  return getConsumptionRanking(
    viewerUserId,
    new URLSearchParams({ period }),
    SURFACE,
    getMockSeedNow(),
  );
}

/** 榜单上这个人的金额。没上榜就是 0——金额不足下限的人不占榜位。 */
function myAmount(page) {
  return page.me?.effectiveSpendAmount ?? 0;
}

/** 走用户端服务提交一笔整单退款，返回退款 id。 */
async function submitRefund(orderId, userId = COUNTED_USER) {
  const { refundId } = await createRefundForOrder(
    orderId,
    userId,
    {
      reasonKey: "other",
      description: "打手临时有事没打成，这一单麻烦帮我退掉，谢谢。",
      evidence: [],
      idempotencyKey: key(),
    },
    undefined,
    SURFACE,
  );
  return refundId;
}

/** 提交前把等级与六个周期的榜单都记下来，供「一点都没变」的断言使用。 */
async function snapshotConsumption(userId = COUNTED_USER) {
  const boards = new Map();
  for (const [period] of PERIOD_EXPECTATION) boards.set(period, await rankingPage(period, userId));
  return {
    level: await getConsumptionLevelForUser(userId, undefined, SURFACE),
    spend: await spendOf(userId),
    user: await getUserRepository().findUserById(userId),
    boards,
  };
}

test("已完成订单可以申请退款；提交与审核中订单都仍是已完成，消费与六个周期榜一点不变", async () => {
  const before = await orderById(COUNTED_ORDER);
  assert.equal(before.status, CONSUMPTION_ORDER_STATUS, "这一单必须是已完成，才谈得上「已计入的钱」");
  assert.ok(before.completedAt, "周期榜按完成时间归属，这一单必须有完成时间");
  // 语义自检：这一单确实完成于「今日」（北京时间），上面那张周期表才有意义
  assert.ok(
    Date.parse(before.completedAt) >= beijingDayStart(getMockSeedNow()),
    "这一单的完成时间应当落在今日区间里",
  );

  const snapshot = await snapshotConsumption();
  assert.ok(snapshot.spend >= before.totalAmount, "这一单必须真的被计入过消费");

  // ① 提交：只多出一条待审核的退款记录，订单一字未改
  const refundId = await submitRefund(COUNTED_ORDER);
  assert.equal((await refundOf(refundId)).status, "pending");
  assert.deepEqual(await orderById(COUNTED_ORDER), before, "提交退款仍不立即修改订单");

  // ② 开始审核：退款进入审核中，订单还是那条已完成
  const started = await startReviewAdminRefund(refundId, ADMIN, { idempotencyKey: key() });
  assert.equal(started.status, "reviewing");
  assert.equal(started.orderChanged, false, "开始审核不该动订单");
  assert.equal(started.orderStatus, "completed");
  assert.deepEqual(await orderById(COUNTED_ORDER), before, "审核中订单仍是已完成，一个字段都没变");

  // ③ 消费侧：等级、累计金额、用户记录、六个周期的榜单，两处都不该有任何变化
  assert.deepEqual(await getConsumptionLevelForUser(COUNTED_USER, undefined, SURFACE), snapshot.level);
  assert.equal(await spendOf(COUNTED_USER), snapshot.spend);
  assert.deepEqual(await getUserRepository().findUserById(COUNTED_USER), snapshot.user);
  for (const [period] of PERIOD_EXPECTATION) {
    const board = await rankingPage(period);
    assert.deepEqual(
      board.rows,
      snapshot.boards.get(period).rows,
      `${period} 榜不该因为「退款在审核」而变`,
    );
  }

  // ④ 用户端：订单详情仍是已完成，入口消失只是因为已经有了一条退款记录
  const detail = await getOrderDetailForUser(COUNTED_ORDER, COUNTED_USER, undefined, SURFACE);
  assert.equal(detail.status, "completed");
  assert.equal(detail.allowedActions.canRequestRefund, false);
  assert.equal(detail.refundSummary.status, "reviewing");
});

test("拒绝已完成的退款：订单仍是已完成，累计消费与六个周期榜一个都不动", async () => {
  const refundId = await submitRefund(OTHER_COUNTED_ORDER);
  await startReviewAdminRefund(refundId, ADMIN, { idempotencyKey: key() });

  const before = await orderById(OTHER_COUNTED_ORDER);
  assert.equal(before.status, CONSUMPTION_ORDER_STATUS);
  const snapshot = await snapshotConsumption();

  const result = await rejectAdminRefund(refundId, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核对服务记录，本次申请不符合同意条件。",
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.orderChanged, false, "拒绝不是会动订单的那条路");
  assert.equal(result.orderStatus, "completed");

  assert.deepEqual(await orderById(OTHER_COUNTED_ORDER), before, "被拒绝的那一单必须原样");
  assert.equal((await orderById(OTHER_COUNTED_ORDER)).status, "completed");
  assert.equal(await spendOf(COUNTED_USER), snapshot.spend, "有效消费金额保持不变");
  assert.deepEqual(await getConsumptionLevelForUser(COUNTED_USER, undefined, SURFACE), snapshot.level);
  for (const [period] of PERIOD_EXPECTATION) {
    const board = await rankingPage(period);
    assert.deepEqual(board.rows, snapshot.boards.get(period).rows, `${period} 榜必须原样`);
  }

  // 用户端：订单仍是已完成，但入口不会回来——本阶段一笔订单只有一条退款记录
  const detail = await getOrderDetailForUser(OTHER_COUNTED_ORDER, COUNTED_USER, undefined, SURFACE);
  assert.equal(detail.status, "completed");
  assert.equal(detail.allowedActions.canRequestRefund, false, "已结束的退款记录仍然挡着重复申请");
  assert.equal(detail.refundSummary.status, "rejected");
});

test("通过已完成的退款：订单变已退款，累计消费正好扣掉这一单，周期榜按完成时间归属扣减", async () => {
  const before = await orderById(COUNTED_ORDER);
  const snapshot = await snapshotConsumption();

  const refundId = await submitRefund(COUNTED_ORDER);
  const result = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核实本次服务未按约定完成，同意整单退款。",
  });

  // ① 只有「通过」这一刻，退款与订单两边才同时变
  assert.equal(result.status, "approved");
  assert.equal(result.changed, true);
  assert.equal(result.orderChanged, true);
  assert.equal(result.orderStatus, "refunded");
  const after = await orderById(COUNTED_ORDER);
  assert.equal(after.status, "refunded");
  assert.ok(after.refundedAt, "订单要记下退款时间");

  // ② 累计消费正好少掉这一单的实付金额（不是「少一点」，也不是「全都清掉」）
  const spendAfter = await spendOf(COUNTED_USER);
  assert.equal(spendAfter, snapshot.spend - before.totalAmount, "累计消费必须正好扣掉这一单");
  assert.ok(spendAfter >= 0);
  // 平台没有去改用户记录：金额与等级都是从订单派生的
  assert.deepEqual(await getUserRepository().findUserById(COUNTED_USER), snapshot.user);

  // ③ 六个周期榜：包含这一单完成时间的周期扣掉它，不包含的**一字不变**
  for (const [period, inPeriod] of PERIOD_EXPECTATION) {
    const boardBefore = snapshot.boards.get(period);
    const boardAfter = await rankingPage(period);
    const expected = myAmount(boardBefore) - (inPeriod ? before.totalAmount : 0);

    assert.equal(
      myAmount(boardAfter),
      Math.max(0, expected),
      `${period} 榜的金额扣得不对（这一单${inPeriod ? "属于" : "不属于"}这个周期）`,
    );
    if (!inPeriod) {
      assert.deepEqual(boardAfter.rows, boardBefore.rows, `${period} 不含这一单，榜单必须一字不变`);
    }
  }

  // ④ 累计榜与消费等级必须给出同一个金额（同一批订单、同一个口径）
  assert.equal(myAmount(await rankingPage("all")), spendAfter);

  // ⑤ 「今日」原本只有这一单：退掉之后这个人今天直接不在榜上，不会被一个 0 占着名次
  assert.equal(myAmount(snapshot.boards.get("today")), before.totalAmount, "今日榜上应当只有这一单");
  assert.equal(myAmount(await rankingPage("today")), 0);
  assert.equal(
    (await rankingPage("today")).me,
    null,
    "金额归零的人不占榜位",
  );

  // ⑥ 用户端随之变成已退款，退款入口不会再出现
  const detail = await getOrderDetailForUser(COUNTED_ORDER, COUNTED_USER, undefined, SURFACE);
  assert.equal(detail.status, "refunded");
  assert.equal(detail.allowedActions.canRequestRefund, false);
  assert.equal(detail.refundSummary.status, "approved");
  assert.equal(detail.refundSummary.amount, before.totalAmount);
});

test("幂等重放「通过」不会重复扣减：同一个键提交两次，消费只少一次", async () => {
  const before = await orderById(COUNTED_ORDER);
  const spendBefore = await spendOf(COUNTED_USER);
  const refundId = await submitRefund(COUNTED_ORDER);
  const operationId = key();

  const first = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "同意整单退款。",
  });
  const spendAfterFirst = await spendOf(COUNTED_USER);
  assert.equal(spendAfterFirst, spendBefore - before.totalAmount);

  const replay = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "第二次提交（不该生效）",
  });
  assert.equal(replay.status, "approved");
  assert.equal(replay.changed, false);
  assert.equal(replay.orderChanged, false);
  assert.equal(replay.reviewedAt, first.reviewedAt, "重放返回的是第一次的结果");

  assert.equal(await spendOf(COUNTED_USER), spendAfterFirst, "重放不能再扣一次");
  assert.equal(await auditCount(), 1, "重放不能再写一条审计");
  assert.equal((await orderById(COUNTED_ORDER)).status, "refunded");
});

test("并发通过只执行一次：两笔同时到达，消费只扣一次、审计只有一条", async () => {
  const before = await orderById(COUNTED_ORDER);
  const spendBefore = await spendOf(COUNTED_USER);
  const refundId = await submitRefund(COUNTED_ORDER);

  const results = await Promise.allSettled([
    approveAdminRefund(refundId, ADMIN, { idempotencyKey: key() }),
    approveAdminRefund(refundId, ADMIN, { idempotencyKey: key() }),
  ]);

  assert.equal(
    results.filter((item) => item.status === "fulfilled").length,
    1,
    "只能有一次通过",
  );
  assert.equal(await auditCount(), 1, "审计恰好一条");
  assert.equal(
    await spendOf(COUNTED_USER),
    spendBefore - before.totalAmount,
    "并发下也只能扣一次",
  );
  assert.equal((await orderById(COUNTED_ORDER)).status, "refunded");
});

test("通过之后历史快照与退款金额仍原样：商品、实付、完成时间、退款单号都不被改写", async () => {
  const before = await orderById(COUNTED_ORDER);
  const refundId = await submitRefund(COUNTED_ORDER);
  const refundBefore = await refundOf(refundId);
  assert.equal(refundBefore.amount, before.totalAmount, "退款金额取订单服务端实付快照");

  await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核实，同意整单退款。",
    // 客户端伪造：金额、订单快照、退款单号、完成时间——一律被白名单忽略
    amount: 1,
    totalAmount: 1,
    refundNo: "FAKE",
    completedAt: "2000-01-01T00:00:00.000Z",
    status: "rejected",
  });

  const after = await orderById(COUNTED_ORDER);
  assert.equal(after.totalAmount, before.totalAmount, "订单实付金额一个字都不改");
  assert.equal(after.productTitle, before.productTitle, "商品快照不动");
  assert.equal(after.quantity, before.quantity);
  assert.equal(after.unitPrice, before.unitPrice);
  assert.equal(after.completedAt, before.completedAt, "完成时间必须保留：周期榜靠它归属");
  assert.equal(after.userId, before.userId);
  assert.equal(after.status, "refunded", "状态由服务端的状态机决定，不由请求体决定");

  const refundAfter = await refundOf(refundId);
  assert.equal(refundAfter.amount, before.totalAmount, "退款金额仍是申请时的快照");
  assert.notEqual(refundAfter.amount, 1);
  assert.equal(refundAfter.refundNo, refundBefore.refundNo);
});

// ——————————————————————————— 幂等与审计 ———————————————————————————

test("幂等：同一个键重复提交返回同一次结果，不迁移两次状态、不写第二条审计", async () => {
  const operationId = key();

  const first = await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "第一次提交",
  });
  assert.equal(first.changed, true);
  assert.equal(first.orderChanged, true);
  assert.equal(await auditCount(), 1);

  const replay = await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "第二次提交（不该生效）",
  });
  assert.equal(replay.status, "approved");
  assert.equal(replay.changed, false, "重放不算改动");
  assert.equal(replay.orderChanged, false, "重放不该再动一次订单");
  assert.equal(replay.reviewedAt, first.reviewedAt, "重放返回的是第一次的结果");
  assert.equal(await auditCount(), 1, "重放不能再写一条审计");

  const refund = await refundOf(PENDING_REFUND);
  assert.equal(refund.reviewNote, "第一次提交", "重放不改写任何字段");
});

test("并发：两个同时到达的「通过」只有一个成功，另一个被判为非法迁移", async () => {
  const results = await Promise.allSettled([
    approveAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key() }),
    approveAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key() }),
  ]);

  const ok = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1, "只能有一次通过");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, "BAD_REQUEST", "第二次进来看到的是「已通过」");
  assert.equal(await auditCount(), 1, "审计恰好一条");

  const order = await orderOf(PENDING_REFUND);
  assert.equal(order.status, "refunded");
});

test("幂等键被别的对象用过时报 400，而不是安静地返回别人的结果", async () => {
  const operationId = key();
  await startReviewAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: operationId });

  await expectApiError(
    approveAdminRefund(REVIEWING_REFUND, ADMIN, { idempotencyKey: operationId }),
    "BAD_REQUEST",
  );

  // 被拒绝的那一笔没有被这次冲突改到
  assert.equal((await refundOf(REVIEWING_REFUND)).status, "reviewing");
});

test("缺少或格式不对的幂等键一律 400：防重不能靠按钮禁用", async () => {
  for (const bad of [undefined, "", "short", "带空格的 key", "a".repeat(65), 12345]) {
    await assert.rejects(
      startReviewAdminRefund(REVIEWING_REFUND, ADMIN, { idempotencyKey: bad }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }
  assert.equal(await auditCount(), 0, "失败的请求不该留下审计");
});

test("审计恰好一次，且不保存退款说明、凭证地址与联系方式", async () => {
  const refund = await refundOf(PENDING_REFUND);

  await startReviewAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key() });
  await approveAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "已核实，同意退款。",
  });

  const entries = await auditsFor(PENDING_REFUND);
  assert.equal(entries.length, 2, "两个动作各一条审计");
  assert.deepEqual(
    entries.map((entry) => entry.action),
    ["refund.start-review", "refund.approve"],
  );
  assert.equal(entries[0].actorId, ADMIN);
  assert.equal(entries[0].actorRole, "admin");
  assert.ok(entries[0].before && entries[0].after, "每条审计都要有前后快照");

  const serialized = JSON.stringify(entries);
  for (const forbidden of [
    refund.description,
    refund.refundNo === "" ? "____" : "/mock/evidence-placeholder.svg",
    "cookie",
    "openId",
    "sessionId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `审计里出现了不该留档的内容：${forbidden}`);
  }

  // 凭证只记「几份」，不记文件名与地址
  assert.equal(serialized.includes(refund.evidence[0]?.name ?? "____"), false);
  assert.equal(typeof entries[1].after.evidenceCount, "number");

  // 审核意见（管理者写的结论）截断后留下——「当时怎么批的」必须查得到
  assert.ok(entries[1].after.reviewNote.startsWith("已核实"));
  // 业务状态与订单状态同时留档，这是「通过会动订单」唯一的痕迹
  assert.equal(entries[1].after.orderStatus, "refunded");
  assert.equal(entries[0].after.orderStatus, "accepted");
});

test("三个动作失败时都不留审计，业务数据也一个字不改", async () => {
  const before = await refundOf(APPROVED_REFUND);
  await expectApiError(
    startReviewAdminRefund(APPROVED_REFUND, ADMIN, { idempotencyKey: key() }),
    "BAD_REQUEST",
  );
  assert.equal(await auditCount(), 0);
  assert.deepEqual(await refundOf(APPROVED_REFUND), before);
});

// ——————————————————————————— 列表与详情 ———————————————————————————

test("列表：关键词命中退款单号 / 订单号 / 用户昵称 / 平台 ID，不命中退款说明", async () => {
  const refund = await refundOf(PENDING_REFUND);
  const detail = await getAdminRefundDetail(PENDING_REFUND, undefined, SURFACE);

  for (const keyword of [
    refund.refundNo,
    detail.orderNo,
    detail.user.nickname,
    detail.user.displayId,
  ]) {
    const query = await resolveAdminRefundListQuery(
      new URLSearchParams({ status: "all", keyword }),
      false,
    );
    const data = await queryAdminRefundList(query, undefined, SURFACE);
    assert.ok(
      data.items.some((item) => item.id === PENDING_REFUND),
      `按「${keyword}」没有搜到这笔退款`,
    );
  }

  // 退款说明是内容不是标识：用它搜不出来，否则等于给了一个探测入口
  const byDescription = await resolveAdminRefundListQuery(
    new URLSearchParams({ status: "all", keyword: refund.description.slice(0, 12) }),
    false,
  );
  assert.equal(
    (await queryAdminRefundList(byDescription, undefined, SURFACE)).items.length,
    0,
    "关键词不该能搜到退款说明",
  );

  // 关键词匹配函数本身：四处任一命中即可
  assert.equal(
    refundMatchesAdminKeyword(
      { refundNo: "RF1", orderNo: "ORD1", nickname: "老板A", displayId: "ID-1" },
      "ord1",
    ),
    true,
  );
  assert.equal(
    refundMatchesAdminKeyword(
      { refundNo: "RF1", orderNo: "ORD1", nickname: "老板A", displayId: "ID-1" },
      "zzz",
    ),
    false,
  );
});

test("列表 DTO 只有摘要：没有原因、说明、凭证、审核意见与身份标识", async () => {
  const query = await resolveAdminRefundListQuery(new URLSearchParams({ status: "all" }), false);
  const data = await queryAdminRefundList(query, undefined, SURFACE);
  assert.ok(data.items.length > 0);

  const allowed = new Set([
    "id",
    "refundNo",
    "status",
    "statusLabel",
    "amount",
    "createdAt",
    "updatedAt",
    "user",
    "orderId",
    "orderNo",
    "orderStatus",
    "orderStatusLabel",
    "productTitle",
  ]);

  for (const item of data.items) {
    assert.deepEqual(new Set(Object.keys(item)), allowed, "列表项字段集合变了");
    assert.deepEqual(
      new Set(Object.keys(item.user)),
      new Set(["id", "displayId", "nickname"]),
    );
  }

  const serialized = JSON.stringify(data);
  const seed = await refundOf(PENDING_REFUND);
  for (const forbidden of [
    seed.description.slice(0, 10),
    "evidence",
    "reviewNote",
    "reasonKey",
    "reviewingAt",
    "reviewedAt",
    "reviewedBy",
    "reviewedByRole",
    "reviewedByName",
    "cancelledAt",
    "/mock/evidence-placeholder.svg",
    "openId",
    "cookie",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `列表 DTO 出现了 ${forbidden}`);
  }
});

test("列表筛选与分页：状态筛得住，非法状态在接口是 400、在页面回到默认值", async () => {
  const query = await resolveAdminRefundListQuery(
    new URLSearchParams({ status: "pending", pageSize: "100" }),
    false,
  );
  const data = await queryAdminRefundList(query, undefined, SURFACE);
  assert.ok(data.items.length > 0);
  for (const item of data.items) assert.equal(item.status, "pending");

  // 默认筛选是「待审核」：这个页面的用途是处理待办
  const defaults = await resolveAdminRefundListQuery(new URLSearchParams(), false);
  assert.equal(defaults.status, "pending");
  assert.equal(defaults.keyword, "");
  assert.equal(defaults.page, 1);

  await assert.rejects(
    resolveAdminRefundListQuery(new URLSearchParams({ status: "whatever" }), true),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, ADMIN_REFUND_STATUS_INVALID_MESSAGE);
      return true;
    },
  );

  // 分页：翻页不重不漏
  const first = await queryAdminRefundList(
    await resolveAdminRefundListQuery(new URLSearchParams({ status: "all", pageSize: "1" }), false),
    undefined,
    SURFACE,
  );
  const second = await queryAdminRefundList(
    await resolveAdminRefundListQuery(
      new URLSearchParams({ status: "all", pageSize: "1", page: "2" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.equal(first.total, second.total);
  assert.notEqual(first.items[0]?.id, second.items[0]?.id, "第二页不该重复第一页");
  assert.equal(first.hasMore, true);
});

test("详情带上原因、说明、凭证、审核信息与服务端判定的 allowedActions", async () => {
  const detail = await getAdminRefundDetail(PENDING_REFUND, undefined, SURFACE);
  assert.ok(detail);
  assert.equal(detail.status, "pending");
  assert.ok(detail.description.length > 0, "详情必须给出用户写的说明");
  assert.ok(detail.reasonLabel.length > 0);
  assert.deepEqual(detail.allowedActions, {
    canStartReview: true,
    canApprove: true,
    canReject: true,
  });
  assert.equal(detail.timeline[0].key, "pending");
  assert.equal(detail.orderStatus, (await orderOf(PENDING_REFUND)).status);
  assert.equal(detail.amount, (await orderOf(PENDING_REFUND)).totalAmount);

  // 已撤销的：时间轴说的是「用户自己撤销」，而不是「你撤销」
  const cancelled = await getAdminRefundDetail(CANCELLED_REFUND, undefined, SURFACE);
  assert.ok(cancelled);
  assert.deepEqual(cancelled.allowedActions, {
    canStartReview: false,
    canApprove: false,
    canReject: false,
  });
  assert.ok(
    cancelled.timeline.some((entry) => entry.note.includes("用户自己撤销")),
    "管理端读到的撤销必须是「用户撤销了」",
  );

  assert.equal(await getAdminRefundDetail("rf-nope", undefined, SURFACE), null);
  assert.equal(await getAdminRefundDetail("", undefined, SURFACE), null);
});

test("审核之后详情与列表读到的是新状态：通过的那一单订单状态也变成已退款", async () => {
  await approveAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: key(), reviewNote: "" });

  const detail = await getAdminRefundDetail(PENDING_REFUND, undefined, SURFACE);
  assert.equal(detail.status, "approved");
  assert.equal(detail.orderStatus, "refunded");
  assert.equal(detail.reviewedBy, ADMIN);
  assert.equal(detail.reviewedByRole, "admin", "P8C 路径下来的审核人一定是管理员");
  assert.equal(detail.reviewedByName, null, "管理端写入不带名称快照");
  assert.deepEqual(detail.allowedActions, {
    canStartReview: false,
    canApprove: false,
    canReject: false,
  });

  const query = await resolveAdminRefundListQuery(
    new URLSearchParams({ status: "approved" }),
    false,
  );
  const data = await queryAdminRefundList(query, undefined, SURFACE);
  const row = data.items.find((item) => item.id === PENDING_REFUND);
  assert.ok(row, "通过之后应当能在「已通过」里筛到");
  assert.equal(row.orderStatus, "refunded", "列表里的订单状态列也要是已退款");
});

// ——————————————————————————— 九、幂等键的意图绑定（P8D-2） ———————————————————————————

/**
 * 「同一个键只能指向同一个意图」。
 *
 * 幂等键原本只在「操作者 × 目标」两轴上收窄（见 `lib/data/adminWriteSupport.ts`）。
 * 对退款这种**同一目标在同一状态下有多个合法意图**的记录，那还不够：
 * 开始审核与驳回都能作用于一笔待审核的退款，于是
 *
 *   带键 K 开始审核 → 带同一个 K 驳回
 *
 * 的第二次请求会因为 target 与 actor 都匹配而被判成「重放」，服务端什么都不做却回 200，
 * 退款停在「审核中」——调用方拿到的是一个与事实相反的成功。
 *
 * P8D-2 起客服也能写这批记录，两个意图分属客服与管理员两侧，这条路才真正走得通，
 * 因此在这里把它钉死：**宁可回一个明确的 400，也不回一个没做事的 200**。
 */
test("幂等的意图绑定：同一个键先「开始审核」再「驳回」，第二次必须报冲突而不是静默成功", async () => {
  const operationId = key();

  const first = await startReviewAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: operationId });
  assert.equal(first.status, "reviewing");
  assert.equal(first.changed, true);
  assert.equal(await auditCount(), 1);

  // 同一个键、同一个目标、同一位管理员，但意图不同 → 冲突
  await expectApiError(
    rejectAdminRefund(PENDING_REFUND, ADMIN, {
      idempotencyKey: operationId,
      reviewNote: "换了个意图，但复用了同一个键",
    }),
    "BAD_REQUEST",
  );

  // 关键断言：退款**不能**因为这次请求而变成已拒绝，也不能被静默当成「已处理」
  assert.equal((await refundOf(PENDING_REFUND)).status, "reviewing", "状态不该被这次请求改变");
  assert.equal(await auditCount(), 1, "被拒的请求不写审计");
  assert.equal((await auditsFor(PENDING_REFUND)).length, 1);
});

test("幂等的意图绑定：换一个键，同一笔退款的另一个意图就能正常执行", async () => {
  const reviewKey = key();
  await startReviewAdminRefund(PENDING_REFUND, ADMIN, { idempotencyKey: reviewKey });

  // 换键之后必须能正常驳回——上面那条约束不该把正常工作流一起挡掉
  const rejected = await rejectAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: key(),
    reviewNote: "核实后不同意退款。",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.changed, true);

  assert.equal(await auditCount(), 2, "两次不同意图各写一条审计");
  const actions = (await auditsFor(PENDING_REFUND)).map((entry) => entry.action).sort();
  assert.deepEqual(actions, ["refund.reject", "refund.start-review"]);
});

test("幂等的意图绑定不影响**同意图**重放：同一个键重复驳回仍然返回第一次的结果", async () => {
  const operationId = key();

  const first = await rejectAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "第一次驳回",
  });
  assert.equal(first.changed, true);

  const replay = await rejectAdminRefund(PENDING_REFUND, ADMIN, {
    idempotencyKey: operationId,
    reviewNote: "第二次提交（同一意图，应当被判为重放）",
  });
  assert.equal(replay.changed, false, "同一意图的重复提交仍然是重放");
  assert.equal(replay.status, "rejected");
  assert.equal(await auditCount(), 1, "重放不写第二条审计");
  assert.equal((await refundOf(PENDING_REFUND)).reviewNote, "第一次驳回", "重放不改写字段");
});
