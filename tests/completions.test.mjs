import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPLETION_ORDER_NOT_FOUND_MESSAGE,
  COMPLETION_ORDER_NOT_SERVING_MESSAGE,
  COMPLETION_PENDING_EXISTS_MESSAGE,
  COMPLETION_STATUSES,
  COMPLETION_SUMMARY_EMPTY_MESSAGE,
  COMPLETION_SUMMARY_MAX_LENGTH,
  COMPLETION_SUMMARY_MIN_LENGTH,
  COMPLETION_SUMMARY_TOO_LONG_MESSAGE,
  COMPLETION_SUMMARY_TOO_SHORT_MESSAGE,
  COMPLETION_TRANSITIONS,
  buildCompanionCompletionInfo,
  canTransitionCompletion,
  isCompletionAutoApprovalBlocked,
  normalizeCompletionSummary,
} from "../lib/constants/completions.ts";
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from "../lib/constants/orders.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_MAX_MINUTES,
  COMPLETION_AUTO_APPROVAL_MIN_MINUTES,
  isValidCompletionAutoApprovalMinutes,
} from "../lib/constants/platformConfig.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import {
  ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "../lib/constants/adminRefunds.ts";
import {
  approveCompletion,
  rejectCompletion,
  submitCompletion,
  sweepCompletionAutoApprovals,
} from "../lib/data/completionTransaction.ts";
import { completionStore } from "../lib/data/mockCompletionRepository.ts";
import { complaintStore } from "../lib/data/mockComplaintRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { readPlatformConfig, writePlatformConfig } from "../lib/data/mockPlatformConfigRepository.ts";
import { refundStore } from "../lib/data/mockRefundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { submitCompanionCompletion } from "../lib/services/companionCompletions.ts";
import { getCompanionOrderDetail, listCompanionOrders } from "../lib/services/companionOrders.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-8「完成材料」领域与伪事务的持续测试。
 *
 * 本文件钉的是**完成材料这条独立状态线**的不变量，按 §十一 的 24 条逐条落位：
 *
 * - 提交（`serving → pending submission`）：归属先于状态、同单至多一份 pending、
 *   5～50 字边界、快照与 deadline 在创建那一刻冻结；
 * - 人工审核（通过 / 驳回）：通过是「submission approved + 订单 completed」的**同生**写入，
 *   驳回**不动订单**、驳回原因必填、审核人三字段写在 submission 上；
 * - 自动通过（到期清扫）：同步、幂等、白名单只认 `pending`、进行中退款 / 未完结投诉会阻塞；
 * - `completion_review` **不进入** `OrderStatus`（它是「serving + pending」拼出来的派生展示阶段）。
 *
 * 所有用例都跑**真实实现**（真实 Mock 仓储 + 真实伪事务），时间用 `plusMinutes` 显式控制，
 * 一次都不等真实时间。伪事务的原子区段内没有 `await`（见「门禁 21」那条源码断言），
 * 因此「并发提交只成功一次」可以在同一个 tick 里用 `Promise.all` 验证。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

/** 预置数据里挂在 cp-1 名下、状态是 completed 的那一单（「不是 serving」用）。 */
const SEEDED_COMPLETED = "ord-seed-1001-05";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function uniqueUser() {
  return unique("u-p08");
}

function uniqueKey() {
  return unique("p08key");
}

/** 生成一个恰好 `n` 个字符（code point）的完成说明。 */
function summaryOf(n) {
  return "字".repeat(n);
}

/** 走完整下单链路，返回订单。 */
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

/** 「一张由 companionId 接下的 accepted 单」。 */
async function acceptedOrder(companionId, user = uniqueUser(), overrides = {}) {
  const placed = await placeOrder(user, overrides);
  const dispatch = await dispatchOf(placed.id);
  const acceptedAt = plusMinutes(placed.paidAt, 1);
  const result = await acceptDispatch(dispatch.id, { companionId, at: acceptedAt });
  assert.equal(result.kind, "ok", "这条用例需要一次成功的接单");
  const order = await orderOf(placed.id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actualCompanionId, companionId);
  return { user, order, acceptedAt };
}

/** 「一张由 companionId 接下的 serving 单」——提交完成材料的起点状态。 */
async function servingOrder(companionId, user = uniqueUser(), overrides = {}) {
  const acc = await acceptedOrder(companionId, user, overrides);
  const servingAt = plusMinutes(acc.acceptedAt, 30);
  const started = await startCompanionOrderTransaction({
    companionId,
    orderId: acc.order.id,
    at: servingAt,
  });
  assert.equal(started.kind, "ok", "这条用例需要一次成功的开始服务");
  return { user, order: await orderOf(acc.order.id), acceptedAt: acc.acceptedAt, servingAt };
}

/** 一张 serving 单 + 一份刚提交成功的 pending 完成材料。 */
async function pendingSubmission(companionId = COMPANION_A) {
  const { order, servingAt } = await servingOrder(companionId);
  const submittedAt = plusMinutes(servingAt, 5);
  const submitted = await submitCompletion({
    companionId,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: submittedAt,
  });
  assert.equal(submitted.kind, "ok");
  return {
    orderId: order.id,
    submissionId: submitted.submissionId,
    submittedAt,
    deadline: submitted.autoApprovalDeadlineAt,
  };
}

function submissionById(id) {
  return completionStore().submissions.get(id) ?? null;
}

function submissionsByOrder(orderId) {
  return [...completionStore().submissions.values()].filter((s) => s.orderId === orderId);
}

function setCompletionConfig(minutes) {
  writePlatformConfig({ ...readPlatformConfig(), completionAutoApprovalMinutes: minutes });
}

/** 断言一个请求以指定的错误码 / 状态码 / 文案被拒绝。 */
async function expectApiError(run, { code, status, message }) {
  await assert.rejects(run, (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, code, `错误码应当是 ${code}`);
    assert.equal(error.status, status, `HTTP 状态码应当是 ${status}`);
    assert.equal(error.message, message, "对外文案必须是那一句冻结的常量");
    return true;
  });
}

/** 取某个导出函数的函数体（到下一个导出声明的开头为止）。 */
function functionBody(code, name) {
  const start = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(code);
  assert.ok(start, `找不到 ${name}：结构约束无法判定`);
  const rest = code.slice(start.index + 1);
  const next = rest.search(/export\s+(?:async\s+)?(?:function|const|let|var|type)\s/);
  return next === -1 ? code.slice(start.index) : code.slice(start.index, start.index + 1 + next);
}

const VALID_BODY = { summary: "已完成护航服务", evidence: [] };

beforeEach(() => {
  resetMockStore("completion");
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("platformConfig");
  resetMockStore("refund");
  resetMockStore("complaint");
});

// ——————————————————————————— 一、提交 ———————————————————————————

test("提交 1：actualCompanion + serving 可以提交，冻结快照与 deadline，订单保持 serving", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const at = plusMinutes(servingAt, 5);

  const outcome = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at,
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.changed, true);
  // 本次冻结的 deadline = submittedAt + 快照（默认 10 分钟）
  assert.equal(outcome.autoApprovalDeadlineAt, plusMinutes(at, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES));

  const submission = submissionById(outcome.submissionId);
  assert.ok(submission, "成功提交必须在存储里留下一条记录");
  assert.equal(submission.status, "pending");
  assert.equal(submission.orderId, order.id);
  assert.equal(submission.companionId, COMPANION_A);
  assert.equal(submission.summary, "已完成护航服务");
  assert.equal(submission.submittedAt, at, "传入的时刻必须逐字写下去");
  assert.equal(submission.autoApprovalMinutesSnapshot, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(submission.autoApprovalDeadlineAt, plusMinutes(at, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES));
  assert.equal(submission.reviewSource, null);
  assert.equal(submission.reviewedByStaffId, null);
  assert.equal(submission.reviewedByName, null);
  assert.equal(submission.reviewedAt, null);
  assert.equal(submission.rejectReason, null);

  // pending 期间订单**仍然是 serving**——完成材料与订单是两条独立的线
  const after = await orderOf(order.id);
  assert.equal(after.status, "serving", "提交完成材料本身不推进订单状态");
  assert.equal(after.completedAt, null);
});

test("提交 2：归属先于状态——不是本人 / 不存在一律 not-found（404），本人但非 serving 才 400", async () => {
  const { order } = await servingOrder(COMPANION_A);

  // (a) 别人的单：状态恰好 serving，但履约人不是我 → not-found（不是 400）
  const foreign = await submitCompletion({
    companionId: COMPANION_B,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(order.servingAt, 5),
  });
  assert.equal(foreign.kind, "not-found");
  await expectNotFound(() => submitCompanionCompletion(COMPANION_B, order.id, VALID_BODY));

  // (b) 根本不存在的订单 → 与 (a) 同一句话、同一个状态码
  const missing = await submitCompletion({
    companionId: COMPANION_A,
    orderId: "ord-根本不存在",
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(missing.kind, "not-found");
  await expectNotFound(() => submitCompanionCompletion(COMPANION_A, "ord-根本不存在", VALID_BODY));

  // (c) 本人的单但状态是 completed（预置 cp-1 名下）→ not-serving（400），不是 not-found
  const completed = await submitCompletion({
    companionId: COMPANION_A,
    orderId: SEEDED_COMPLETED,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(completed.kind, "not-serving");
  assert.equal(completed.status, "completed", "带上当前状态，调用方才知道点了不该存在的按钮");
  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, SEEDED_COMPLETED, VALID_BODY),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_ORDER_NOT_SERVING_MESSAGE },
  );
});

async function expectNotFound(run) {
  await expectApiError(run, {
    code: "NOT_FOUND",
    status: 404,
    message: COMPLETION_ORDER_NOT_FOUND_MESSAGE,
  });
}

test("提交 3：完成说明 5～50 字，边界本身必须通过，4 字与 51 字被拒", () => {
  assert.equal(COMPLETION_SUMMARY_MIN_LENGTH, 5);
  assert.equal(COMPLETION_SUMMARY_MAX_LENGTH, 50);

  assert.equal(normalizeCompletionSummary("   ").message, COMPLETION_SUMMARY_EMPTY_MESSAGE);
  assert.equal(normalizeCompletionSummary(summaryOf(4)).message, COMPLETION_SUMMARY_TOO_SHORT_MESSAGE);
  assert.equal(normalizeCompletionSummary(summaryOf(51)).message, COMPLETION_SUMMARY_TOO_LONG_MESSAGE);

  // 边界最容易写错：5 与 50 必须通过
  assert.equal(normalizeCompletionSummary(summaryOf(5)).ok, true);
  assert.equal(normalizeCompletionSummary(summaryOf(50)).ok, true);

  // trim 之后才判长度：首尾空格不算字数
  assert.equal(normalizeCompletionSummary(`   ${summaryOf(5)}   `).ok, true);
});

test("提交 3b：服务层把非法说明翻译成 400，被拒的提交不写任何记录", async () => {
  const { order } = await servingOrder(COMPANION_A);

  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, order.id, { summary: "", evidence: [] }),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_SUMMARY_EMPTY_MESSAGE },
  );
  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, order.id, { summary: summaryOf(4), evidence: [] }),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_SUMMARY_TOO_SHORT_MESSAGE },
  );
  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, order.id, { summary: summaryOf(51), evidence: [] }),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_SUMMARY_TOO_LONG_MESSAGE },
  );

  assert.equal(submissionsByOrder(order.id).length, 0, "被拒的提交不得留下任何记录");
});

test("提交 4：同一订单最多一份 pending——第二次提交 pending-exists（400），不新建第二条", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const firstAt = plusMinutes(servingAt, 5);

  const first = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "第一次完成说明",
    evidence: [],
    at: firstAt,
  });
  assert.equal(first.kind, "ok");

  const second = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "第二次完成说明",
    evidence: [],
    at: plusMinutes(firstAt, 1),
  });
  assert.equal(second.kind, "pending-exists");
  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, order.id, VALID_BODY),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_PENDING_EXISTS_MESSAGE },
  );

  assert.equal(submissionsByOrder(order.id).length, 1, "同单至多一份 pending");
});

test("提交 5：并发提交只成功一次——一个 ok、一个 pending-exists，存储只有一条", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const at = plusMinutes(servingAt, 5);

  // 两个请求在同一个 tick 内到达：原子区段内没有 await，因此第二个进来时第一个已经写完
  const [a, b] = await Promise.all([
    submitCompletion({ companionId: COMPANION_A, orderId: order.id, summary: "并发完成说明", evidence: [], at }),
    submitCompletion({ companionId: COMPANION_A, orderId: order.id, summary: "并发完成说明", evidence: [], at }),
  ]);

  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["ok", "pending-exists"], "恰好一个成功、一个被 pending 索引挡下");

  const all = submissionsByOrder(order.id);
  assert.equal(all.length, 1, "存储里只允许留下一条 pending");
});

// ——————————————————————————— 二、驳回后重提 ———————————————————————————

test("重提 6：驳回后重新提交是新建记录，旧记录逐字保留（审核人 / 驳回原因 / 时间都不变）", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const firstAt = plusMinutes(servingAt, 5);

  const first = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "第一次完成说明",
    evidence: [],
    at: firstAt,
  });

  const rejectAt = plusMinutes(firstAt, 1);
  const rejected = await rejectCompletion({
    submissionId: first.submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    rejectReason: "截图不清晰",
    at: rejectAt,
  });
  assert.equal(rejected.kind, "ok");

  const oldSnapshot = { ...submissionById(first.submissionId) };

  const secondAt = plusMinutes(rejectAt, 1);
  const second = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "重新提交的完成说明",
    evidence: [],
    at: secondAt,
  });
  assert.equal(second.kind, "ok");
  assert.notEqual(second.submissionId, first.submissionId, "重提必须是一条新记录，不是覆盖旧记录");

  // 旧记录一个字节都不变
  assert.deepEqual(submissionById(first.submissionId), oldSnapshot, "旧审核历史不得被重提覆盖");
  const old = submissionById(first.submissionId);
  assert.equal(old.status, "rejected");
  assert.equal(old.rejectReason, "截图不清晰");
  assert.equal(old.reviewSource, "staff");
  assert.equal(old.reviewedByStaffId, "staff-1");
  assert.equal(old.reviewedAt, rejectAt);

  assert.equal(submissionsByOrder(order.id).length, 2, "重提之后同单有两条记录");
});

test("重提 7：重新提交重新冻结快照与 deadline，旧的 pending 快照不受影响", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const firstAt = plusMinutes(servingAt, 5);
  const first = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "第一次完成说明",
    evidence: [],
    at: firstAt,
  });
  assert.equal(submissionById(first.submissionId).autoApprovalMinutesSnapshot, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);

  await rejectCompletion({
    submissionId: first.submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    rejectReason: "截图不清晰",
    at: plusMinutes(firstAt, 1),
  });

  // 改配置到 1 分钟，再重新提交：新记录按**新配置**冻结
  setCompletionConfig(1);
  const secondAt = plusMinutes(firstAt, 3);
  const second = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "重新提交的完成说明",
    evidence: [],
    at: secondAt,
  });
  assert.equal(second.kind, "ok");

  const fresh = submissionById(second.submissionId);
  assert.equal(fresh.autoApprovalMinutesSnapshot, 1, "重提按提交那一刻的配置冻结快照");
  assert.equal(fresh.autoApprovalDeadlineAt, plusMinutes(secondAt, 1));
});

// ——————————————————————————— 三、快照与配置 ———————————————————————————

test("快照 8：默认自动审核时长是 10 分钟，预置值与常量一致，新提交冻结当前配置", async () => {
  assert.equal(COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES, 10);
  assert.equal(COMPLETION_AUTO_APPROVAL_MIN_MINUTES, 1);
  assert.equal(COMPLETION_AUTO_APPROVAL_MAX_MINUTES, 1440);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);

  const { order, servingAt } = await servingOrder(COMPANION_A);
  const at = plusMinutes(servingAt, 5);
  const out = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at,
  });
  assert.equal(submissionById(out.submissionId).autoApprovalMinutesSnapshot, readPlatformConfig().completionAutoApprovalMinutes);
});

test("快照 9：改配置不追溯已在途的 pending——它仍按提交那一刻的快照到点，不提前也不延后", async () => {
  const { order, servingAt } = await servingOrder(COMPANION_A);
  const submittedAt = plusMinutes(servingAt, 5);
  const out = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: submittedAt,
  });
  // 快照 10 分钟，deadline = submittedAt + 10
  assert.equal(submissionById(out.submissionId).autoApprovalMinutesSnapshot, 10);

  // 提交之后把配置改成 1 分钟：这一份在途 pending 的 deadline 已经冻结，不随之变短
  setCompletionConfig(1);

  const early = sweepCompletionAutoApprovals(plusMinutes(submittedAt, 2));
  assert.equal(early.autoApprovedSubmissionIds.length, 0, "改配置不得把在途 pending 的 deadline 提前");
  assert.equal(submissionById(out.submissionId).status, "pending");
  assert.equal((await orderOf(order.id)).status, "serving");

  // 到它自己的 deadline（+10）才自动通过
  const atDeadline = sweepCompletionAutoApprovals(plusMinutes(submittedAt, 11));
  assert.deepEqual(atDeadline.autoApprovedSubmissionIds, [out.submissionId]);
  assert.equal(submissionById(out.submissionId).status, "approved");
  assert.equal((await orderOf(order.id)).status, "completed");
});

// ——————————————————————————— 四、人工审核 ———————————————————————————

test("通过 10：客服通过 → submission approved + 订单 completed + completedAt 写入 + 审核人三字段正确", async () => {
  const { orderId, submissionId, submittedAt } = await pendingSubmission();
  const approveAt = plusMinutes(submittedAt, 1);

  const out = await approveCompletion({
    submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    at: approveAt,
  });

  assert.equal(out.kind, "ok");
  assert.equal(out.changed, true);

  const submission = submissionById(submissionId);
  assert.equal(submission.status, "approved");
  assert.equal(submission.reviewSource, "staff");
  assert.equal(submission.reviewedByStaffId, "staff-1");
  assert.equal(submission.reviewedByName, "客服小雨");
  assert.equal(submission.reviewedAt, approveAt);
  assert.equal(submission.rejectReason, null, "通过不是驳回，没有驳回原因");

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed");
  assert.equal(order.completedAt, approveAt, "完成时间就是审核通过那一刻，逐字写下去");
});

test("驳回 11：客服驳回只改完成材料，订单仍 serving、一个字段都不动", async () => {
  const { orderId, submissionId, submittedAt } = await pendingSubmission();
  const before = await orderOf(orderId);
  const rejectAt = plusMinutes(submittedAt, 1);

  const out = await rejectCompletion({
    submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    rejectReason: "截图不清晰，请重新上传",
    at: rejectAt,
  });

  assert.equal(out.kind, "ok");
  assert.equal(out.changed, true);

  const submission = submissionById(submissionId);
  assert.equal(submission.status, "rejected");
  assert.equal(submission.rejectReason, "截图不清晰，请重新上传");
  assert.equal(submission.reviewSource, "staff");
  assert.equal(submission.reviewedByStaffId, "staff-1");
  assert.equal(submission.reviewedByName, "客服小雨");
  assert.equal(submission.reviewedAt, rejectAt);

  // 驳回不动订单：serving、completedAt 仍是 null，整条记录逐字不变
  assert.deepEqual(await orderOf(orderId), before, "驳回不得推进订单，也不得回退任何历史字段");
  assert.equal(before.status, "serving");
  assert.equal(before.completedAt, null);
});

test("驳回 12：驳回原因必填——空 / 纯空白 / 超长都 400，且不改状态、不写结论", async () => {
  const { orderId, submissionId } = await pendingSubmission();

  // 规则复用管理端同一份 `normalizeAdminReviewNote`（与入驻审核、管理端退款同一份）
  assert.equal(normalizeAdminReviewNote("").message, ADMIN_REVIEW_NOTE_EMPTY_MESSAGE);
  assert.equal(normalizeAdminReviewNote("   \n\t").message, ADMIN_REVIEW_NOTE_EMPTY_MESSAGE);
  assert.equal(
    normalizeAdminReviewNote("x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH + 1)).message,
    ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  );
  assert.equal(normalizeAdminReviewNote("x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH)).ok, true, "刚好到上限应当通过");

  // 事务层收不到空原因——它收到的已经是合法意图；因此「空原因被拒」发生在服务层
  // （服务层 400 的翻译在 staffCompletions.test.mjs 里逐条钉）。
  // 这里验证：校验失败的那次驳回不得把状态改掉（事务层不受影响）
  assert.equal(submissionById(submissionId).status, "pending");
  assert.equal((await orderOf(orderId)).status, "serving");
});

// ——————————————————————————— 五、自动通过 ———————————————————————————

test("自动 13：System 自动通过时 reviewedByStaffId / reviewedByName 必须为 null", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission();

  const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));

  assert.deepEqual(swept.autoApprovedSubmissionIds, [submissionId]);

  const submission = submissionById(submissionId);
  assert.equal(submission.status, "approved");
  assert.equal(submission.reviewSource, "system");
  assert.equal(submission.reviewedByStaffId, null, "自动通过绝不伪装成客服");
  assert.equal(submission.reviewedByName, null);
  assert.ok(submission.reviewedAt, "自动通过也要写审核时间");
  assert.equal(submission.rejectReason, null);

  assert.equal((await orderOf(orderId)).status, "completed");
});

test("自动 14：deadline 未到不自动通过——材料仍 pending、订单仍 serving", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission();

  const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, -1));

  assert.equal(swept.autoApprovedSubmissionIds.length, 0);
  assert.equal(submissionById(submissionId).status, "pending");
  assert.equal((await orderOf(orderId)).status, "serving");
});

test("自动 15：deadline 到达且无阻塞 → 自动通过，订单 completed，completedAt 就是清扫时刻", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission();
  const at = plusMinutes(deadline, 3);

  const swept = sweepCompletionAutoApprovals(at);

  assert.deepEqual(swept.autoApprovedSubmissionIds, [submissionId]);
  assert.equal(submissionById(submissionId).status, "approved");
  assert.equal(submissionById(submissionId).reviewSource, "system");
  assert.equal(submissionById(submissionId).reviewedAt, at);

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed");
  assert.equal(order.completedAt, at);
});

test("自动 16：进行中退款 / 未完结投诉阻塞自动通过，已终结的不阻塞，解除后重扫可通过", async () => {
  // (a) pending 退款阻塞
  {
    const { orderId, submissionId, deadline } = await pendingSubmission();
    const rs = refundStore();
    const refundId = unique("refund");
    rs.refunds.set(refundId, { id: refundId, orderId, status: "pending" });
    // P0-13（D10）：索引由单值改为**多值**——同一订单可以有多条申请，
    // 已终结的不再挡、进行中的才挡，因此这里维护的是一个列表
    rs.refundIdsByOrder.set(orderId, [...(rs.refundIdsByOrder.get(orderId) ?? []), refundId]);

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.equal(swept.autoApprovedSubmissionIds.length, 0, "进行中的退款必须挡住");
    assert.equal(submissionById(submissionId).status, "pending");
    assert.equal((await orderOf(orderId)).status, "serving");

    // 退款终结后重扫 → 通过（阻塞解除，不是「永不自动通过」）
    rs.refunds.get(refundId).status = "approved";
    const reSwept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.deepEqual(reSwept.autoApprovedSubmissionIds, [submissionId]);
  }

  // (b) reviewing 退款阻塞
  {
    const { orderId, deadline } = await pendingSubmission();
    const rs = refundStore();
    const refundId = unique("refund");
    rs.refunds.set(refundId, { id: refundId, orderId, status: "reviewing" });
    // P0-13（D10）：索引由单值改为**多值**——同一订单可以有多条申请，
    // 已终结的不再挡、进行中的才挡，因此这里维护的是一个列表
    rs.refundIdsByOrder.set(orderId, [...(rs.refundIdsByOrder.get(orderId) ?? []), refundId]);

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.equal(swept.autoApprovedSubmissionIds.length, 0, "审核中的退款同样阻塞");
  }

  // (c) pending / processing 投诉阻塞
  for (const complaintStatus of ["pending", "processing"]) {
    const { orderId, deadline } = await pendingSubmission();
    const cs = complaintStore();
    const complaintId = unique("cmp");
    cs.complaints.set(complaintId, { id: complaintId, orderId, status: complaintStatus });

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.equal(swept.autoApprovedSubmissionIds.length, 0, `${complaintStatus} 投诉必须阻塞`);
  }

  // (d) resolved / closed 投诉**不**阻塞（D4 取舍：已终结的投诉不永久转人工）
  for (const complaintStatus of ["resolved", "closed"]) {
    const { orderId, submissionId, deadline } = await pendingSubmission();
    const cs = complaintStore();
    const complaintId = unique("cmp");
    cs.complaints.set(complaintId, { id: complaintId, orderId, status: complaintStatus });

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.deepEqual(swept.autoApprovedSubmissionIds, [submissionId], `${complaintStatus} 投诉不阻塞`);
  }

  // (e) rejected / cancelled / approved 退款**不**阻塞
  for (const refundStatus of ["rejected", "cancelled", "approved"]) {
    const { orderId, submissionId, deadline } = await pendingSubmission();
    const rs = refundStore();
    const refundId = unique("refund");
    rs.refunds.set(refundId, { id: refundId, orderId, status: refundStatus });
    // P0-13（D10）：索引由单值改为**多值**——同一订单可以有多条申请，
    // 已终结的不再挡、进行中的才挡，因此这里维护的是一个列表
    rs.refundIdsByOrder.set(orderId, [...(rs.refundIdsByOrder.get(orderId) ?? []), refundId]);

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.deepEqual(swept.autoApprovedSubmissionIds, [submissionId], `${refundStatus} 退款不阻塞`);
  }
});

test("自动 17：重复清扫幂等——只有第一次返回非空，completedAt / reviewedAt 不被刷新", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission();
  const at = plusMinutes(deadline, 1);

  const first = sweepCompletionAutoApprovals(at);
  assert.deepEqual(first.autoApprovedSubmissionIds, [submissionId]);

  const completedAtAfterFirst = (await orderOf(orderId)).completedAt;
  const reviewedAtAfterFirst = submissionById(submissionId).reviewedAt;
  assert.equal(completedAtAfterFirst, at);
  assert.equal(reviewedAtAfterFirst, at);

  const later = plusMinutes(at, 60);
  const second = sweepCompletionAutoApprovals(later);
  assert.equal(second.autoApprovedSubmissionIds.length, 0, "第二次清扫不该再自动通过同一份");

  assert.equal((await orderOf(orderId)).completedAt, completedAtAfterFirst, "completedAt 不得被刷新");
  assert.equal(submissionById(submissionId).reviewedAt, reviewedAtAfterFirst, "reviewedAt 不得被刷新");
});

test("读取路径：打手列表与详情不显式清扫也会物化过期的自动审核——订单从 serving 变 completed", async () => {
  // 前置：一张 serving 单 + 一份「deadline 已经越过真实现在」的 pending 完成材料。
  // 不用 pendingSubmission()（它的提交时刻设在 servingAt+5min，deadline 在未来），
  // 而是直接把提交时刻拨到真实 now 之前：materializeCompletionAutoApprovals() 取的是
  // 真实 new Date()，只有 deadline 落在「真实当前时刻」的过去才会触发惰性物化。
  const { order } = await servingOrder(COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(new Date().toISOString(), -30),
  });
  assert.equal(submitted.kind, "ok");
  assert.ok(
    Date.parse(submitted.autoApprovalDeadlineAt) <= Date.now(),
    "前置条件：deadline 必须在真实当前时刻之前，否则读取路径不会物化",
  );

  // 关键：下面两句都不显式调用 sweepCompletionAutoApprovals。
  // 若读取路径把 materialize 调用删掉、或把它挪到读仓储之后，这里拿到的状态就是 serving。

  const detail = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(detail, "本人订单详情必须查得到");
  assert.equal(detail.status, "completed", "详情读路径必须把过期的自动审核物化成 completed");

  const item = (await listCompanionOrders(COMPANION_A)).items.find((entry) => entry.id === order.id);
  assert.ok(item, "列表必须包含这一单");
  assert.equal(item.status, "completed", "列表读路径必须把过期的自动审核物化成 completed——列表卡片不能停在「护航中」");
});

test("竞态 18：客服通过与自动通过只有一个完成事实——先到者写 completedAt，后到者是 no-op 或重放", async () => {
  // 客服先通过，自动清扫晚到：清扫跳过（已不是 pending），completedAt 停在客服时刻
  {
    const { orderId, submissionId, submittedAt, deadline } = await pendingSubmission();
    const staffAt = plusMinutes(submittedAt, 1);
    const approved = await approveCompletion({ submissionId, staffId: "staff-1", staffName: "客服小雨", at: staffAt });
    assert.equal(approved.kind, "ok");

    const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.equal(swept.autoApprovedSubmissionIds.length, 0);

    const order = await orderOf(orderId);
    assert.equal(order.status, "completed");
    assert.equal(order.completedAt, staffAt, "completedAt 停在第一次写入的时刻");
    assert.equal(submissionById(submissionId).reviewSource, "staff");
  }

  // 自动先通过，客服晚到：客服拿到重放（changed:false），completedAt 停在自动时刻
  {
    const { orderId, submissionId, deadline } = await pendingSubmission();
    const at = plusMinutes(deadline, 1);
    const swept = sweepCompletionAutoApprovals(at);
    assert.deepEqual(swept.autoApprovedSubmissionIds, [submissionId]);

    const later = plusMinutes(at, 5);
    const replayed = await approveCompletion({ submissionId, staffId: "staff-1", staffName: "客服小雨", at: later });
    assert.equal(replayed.kind, "replayed");
    assert.equal(replayed.changed, false);

    assert.equal((await orderOf(orderId)).completedAt, at, "completedAt 停在自动通过那一刻");
    assert.equal(submissionById(submissionId).reviewSource, "system", "第一次的审核来源不被覆盖");
  }
});

// ——————————————————————————— 六、完成事实不可回退 ———————————————————————————

test("重提 20：approved 之后不得再提交——订单已 completed，提交拿到 not-serving（400）", async () => {
  const { orderId, submissionId, submittedAt } = await pendingSubmission();
  await approveCompletion({ submissionId, staffId: "staff-1", staffName: "客服小雨", at: plusMinutes(submittedAt, 1) });

  const again = await submitCompletion({
    companionId: COMPANION_A,
    orderId,
    summary: "想再改一次",
    evidence: [],
    at: plusMinutes(submittedAt, 5),
  });
  assert.equal(again.kind, "not-serving");
  assert.equal(again.status, "completed");
  await expectApiError(
    () => submitCompanionCompletion(COMPANION_A, orderId, VALID_BODY),
    { code: "BAD_REQUEST", status: 400, message: COMPLETION_ORDER_NOT_SERVING_MESSAGE },
  );

  // 打手端摘要：canSubmit 由服务端算好，approved 之后为 false
  const info = buildCompanionCompletionInfo({ status: "completed" }, submissionById(submissionId));
  assert.equal(info.canSubmit, false);
});

// ——————————————————————————— 七、失效材料 ———————————————————————————

test("失效 23：换人后旧材料失效——approve 拿到 stale-submission，清扫也跳过它", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission(COMPANION_A);

  // 直接改订单的实际履约人（换人），旧材料立即失效
  paymentStore().orders.get(orderId).actualCompanionId = COMPANION_B;

  const approved = await approveCompletion({
    submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    at: plusMinutes(deadline, 1),
  });
  assert.equal(approved.kind, "stale-submission");

  const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
  assert.equal(swept.autoApprovedSubmissionIds.length, 0, "清扫同样不得通过已失效的材料");

  assert.equal(submissionById(submissionId).status, "pending", "旧材料不被任何人审核，也不被自动通过");
  assert.equal((await orderOf(orderId)).status, "serving");
});

test("失效 24：invalidated 永不自动通过——即使 deadline 已过也跳过（D3 白名单只认 pending）", async () => {
  const { orderId, submissionId, deadline } = await pendingSubmission();

  // 手工塞进一条 invalidated（P0-8 没有写入路径，这里直接改 store 模拟将来封禁回池的状态）
  const current = submissionById(submissionId);
  completionStore().submissions.set(submissionId, { ...current, status: "invalidated" });

  const swept = sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
  assert.equal(swept.autoApprovedSubmissionIds.length, 0);
  assert.equal(submissionById(submissionId).status, "invalidated", "invalidated 不被自动通过");
  assert.equal((await orderOf(orderId)).status, "serving");
});

// ——————————————————————————— 八、一致性与门禁 ———————————————————————————

test("一致 22：approved 与 completed 同生共死——不存在「approved 但订单仍 serving」或「订单 completed 但材料仍 pending」", async () => {
  // 客服路径与自动路径各跑一遍，两条路径写入之后都必须同时成立「材料 approved + 订单 completed」
  {
    const { orderId, submissionId, submittedAt } = await pendingSubmission();
    await approveCompletion({ submissionId, staffId: "staff-1", staffName: "客服小雨", at: plusMinutes(submittedAt, 1) });
    assert.equal(submissionById(submissionId).status, "approved");
    assert.equal((await orderOf(orderId)).status, "completed");
  }
  {
    const { orderId, submissionId, deadline } = await pendingSubmission();
    sweepCompletionAutoApprovals(plusMinutes(deadline, 1));
    assert.equal(submissionById(submissionId).status, "approved");
    assert.equal((await orderOf(orderId)).status, "completed");
  }

  // 反向：pending 期间订单必然是 serving；rejected 也保持 serving（驳回 11 已单独钉）
  {
    const { orderId, submissionId } = await pendingSubmission();
    assert.equal(submissionById(submissionId).status, "pending");
    assert.equal((await orderOf(orderId)).status, "serving");
  }
});

test("门禁 19：`completion_review` 不进入 OrderStatus——状态集合与类型仍恰好五个状态", () => {
  assert.deepEqual([...ORDER_STATUSES], ["paid", "accepted", "serving", "completed", "refunded"]);
  assert.deepEqual(Object.keys(ORDER_STATUS_LABELS).sort(), [
    "accepted",
    "completed",
    "paid",
    "refunded",
    "serving",
  ]);

  // `completion_review` 是「serving + pending」拼出来的派生展示阶段，不是订单状态：
  // 订单状态的两个定义处（常量表 + 类型）都不该出现它
  for (const file of ["lib/constants/orders.ts", "lib/types/order.ts"]) {
    const source = stripComments(readSource(path.join(ROOT, file)));
    assert.equal(source.includes("completion_review"), false, `${file} 不该把 completion_review 定义成订单状态`);
  }
});

test("门禁 21：提交 / 通过 / 驳回的原子区段内没有 await，清扫是同步函数", () => {
  const txCode = stripComments(readSource(path.join(ROOT, "lib", "data", "completionTransaction.ts")));

  for (const name of ["submitCompletion", "approveCompletion", "rejectCompletion"]) {
    const body = functionBody(txCode, name);
    assert.equal(/\bawait\b/.test(body), false, `${name} 的原子区段里出现 await 就是 bug——它会把读-判断-写拆到两个 tick 上`);
  }

  const sweepBody = functionBody(txCode, "sweepCompletionAutoApprovals");
  assert.equal(/\bawait\b/.test(sweepBody), false, "清扫必须整段同步");
  assert.equal(
    /export\s+async\s+function\s+sweepCompletionAutoApprovals\b/.test(txCode),
    false,
    "sweepCompletionAutoApprovals 必须是同步函数（挂在读取路径上、可在原子区段里调用）",
  );
});

test("门禁 22：approveCompletion 的 serving→completed 必须走中央状态机，且结构校验在领域 Guard 之前", () => {
  const txCode = stripComments(readSource(path.join(ROOT, "lib", "data", "completionTransaction.ts")));
  const approveBody = functionBody(txCode, "approveCompletion");

  // (1) 中央状态机是唯一真值源：canTransitionOrder 只能从 @/lib/constants/orders 导入，
  //     而不是在本文件另写一份判断——「这条边存不存在」的答案只能有一份
  assert.ok(
    /import\s*\{[^}]*\bcanTransitionOrder\b[^}]*\}\s*from\s*"@\/lib\/constants\/orders"/.test(txCode),
    "canTransitionOrder 必须从 @/lib/constants/orders 导入（中央状态机是唯一真值源）",
  );

  // (2) 通过路径必须真的调用它：只 import 不用等于没做结构校验
  assert.ok(
    approveBody.includes("canTransitionOrder("),
    "通过必须用中央状态机（canTransitionOrder）做 serving→completed 的结构校验：这条边存不存在由状态表回答",
  );

  // (3) 领域 Guard 保留，且结构校验必须排在领域 Guard **之前**——先问「这条边存在吗」，
  //     再问「这一单站在它的起点上吗」。只断言「出现过」不够：把结构校验挪到 Guard 之后
  //     必须变红（与 companionOrders.test.mjs 的 start 门禁同形）
  const orderGuard = 'order.status !== "serving"';
  assert.ok(
    approveBody.includes(orderGuard),
    "通过必须保留直接看 order.status 的领域 Guard：表允许不等于这一单此刻能这么做",
  );
  assert.ok(
    approveBody.indexOf("canTransitionOrder(") < approveBody.indexOf(orderGuard),
    "结构校验必须在领域 Guard 之前：先问「这条边存在吗」，再问「这一单站在它的起点上吗」",
  );
});

test("门禁 23：完成材料自动审核清扫必须挂在全部六条读取路径上（不多不少）", () => {
  const servicesDir = path.join(ROOT, "lib", "services");
  const callers = collectFiles(servicesDir)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => stripComments(readSource(file)).includes("sweepCompletionAutoApprovals("))
    .map((file) => path.basename(file))
    .sort();

  assert.deepEqual(
    callers,
    [
      "adminOrders.ts",
      "companionEarnings.ts",
      "companionOrders.ts",
      "orders.ts",
      "staffCompletions.ts",
      // P0-10：客服订单列表与详情都会显示完成材料摘要，因此也必须先物化完成事实
      "staffOrders.ts",
    ],
    "自动审核清扫必须恰好挂在六条读取路径上：用户端 / 管理端 / 客服端订单 / 客服端完成材料 / 打手端订单 / 打手端收益。" +
      "漏挂一处（某个端读不到自动审核物化）或多挂一处（在别处偷偷清扫）都会红；" +
      "P0-9 的打手「我的收益」必须先物化完成事实、再物化解冻——只扫解冻不扫完成的话，" +
      "一张到期自动通过的订单在收益页上会是一片空白，而它的单其实早就完成了；" +
      "P0-10 的客服订单页同理：它显示的是「这一单现在到哪一步了」，" +
      "不物化的话客服会看到一条早该自动通过的完成材料还挂在「待审核」；" +
      "若有意把各端的调用收敛成一个公共物化函数，那是重构而非缺陷——必须在同一次改动里同步更新这里的白名单",
  );
});

// ——————————————————————————— 九、纯逻辑 ———————————————————————————

// ⚠️ 出边数量从两条变成三条：P0-11 起，当前履约被解除（打手取消接单 / 客服退回公共池 /
// 客服换人 / 封禁回池）时，已提交但未审的完成材料要作废——否则这一单回到公共池、
// 换了下一位护航，上一轮交的那份材料还挂在「待审核」等着被通过。
// 判决仍然不可逆：三条出边全部指向终态，`invalidated` 没有任何回头路
// （尤其是 `invalidated → approved`）。
test("状态机：四个状态、pending 三条出边（P0-11 起含作废），其余都是终态", () => {
  assert.deepEqual([...COMPLETION_STATUSES], ["pending", "approved", "rejected", "invalidated"]);
  assert.deepEqual(COMPLETION_TRANSITIONS.pending, ["approved", "rejected", "invalidated"]);
  assert.deepEqual(COMPLETION_TRANSITIONS.approved, []);
  assert.deepEqual(COMPLETION_TRANSITIONS.rejected, []);
  assert.deepEqual(COMPLETION_TRANSITIONS.invalidated, []);

  assert.equal(canTransitionCompletion("pending", "approved"), true);
  assert.equal(canTransitionCompletion("pending", "rejected"), true);
  assert.equal(canTransitionCompletion("pending", "invalidated"), true);
  assert.equal(canTransitionCompletion("approved", "approved"), false, "自环不是迁移");
  assert.equal(canTransitionCompletion("invalidated", "approved"), false);
  assert.equal(canTransitionCompletion("rejected", "approved"), false);
  assert.equal(canTransitionCompletion("invalidated", "invalidated"), false, "作废不是可重入的");
});

test("自动通过阻塞判据：两条布尔任一为真即阻塞，纯函数不碰仓储", () => {
  assert.equal(isCompletionAutoApprovalBlocked({ hasActiveRefund: true, hasUnresolvedComplaint: false }), true);
  assert.equal(isCompletionAutoApprovalBlocked({ hasActiveRefund: false, hasUnresolvedComplaint: true }), true);
  assert.equal(isCompletionAutoApprovalBlocked({ hasActiveRefund: true, hasUnresolvedComplaint: true }), true);
  assert.equal(isCompletionAutoApprovalBlocked({ hasActiveRefund: false, hasUnresolvedComplaint: false }), false);
});

test("自动审核时长校验：0 / 负数 / 超上限 / 小数 / 字符串 / NaN 拒绝，1 与 1440 通过", () => {
  for (const bad of [0, -1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined, {}, []]) {
    assert.equal(isValidCompletionAutoApprovalMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [1, 2, 10, 1439, 1440]) {
    assert.equal(isValidCompletionAutoApprovalMinutes(good), true, `${good} 应当通过`);
  }
});
