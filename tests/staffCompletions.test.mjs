import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
} from "../lib/constants/adminRefunds.ts";
import { buildCompanionCompletionInfo } from "../lib/constants/completions.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  DEFAULT_STAFF_COMPLETION_STATUS_FILTER,
  STAFF_COMPLETION_BLOCKED_BY_COMPLAINT_MESSAGE,
  STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE,
  STAFF_COMPLETION_LIST_FIELDS_NOTE,
  STAFF_COMPLETION_LIST_NOTICE,
  STAFF_COMPLETION_NOT_FOUND_MESSAGE,
  STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE,
  STAFF_COMPLETION_STALE_SUBMISSION_MESSAGE,
  STAFF_COMPLETION_STATUS_FILTERS,
  STAFF_COMPLETION_STATUS_INVALID_MESSAGE,
  readStaffCompletionStatusFilter,
  staffCompletionAllowedActions,
  staffCompletionAutoApprovalBlockedReason,
  staffCompletionMatchesKeyword,
  staffCompletionTransitionMessage,
  toStaffCompletionDetail,
  toStaffCompletionListItem,
} from "../lib/constants/staffCompletions.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import {
  approveCompletion,
  rejectCompletion,
  submitCompletion,
} from "../lib/data/completionTransaction.ts";
import { completionStore } from "../lib/data/mockCompletionRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  approveStaffCompletion,
  getStaffCompletionDetail,
  listStaffCompletions,
  rejectStaffCompletion,
  resolveStaffCompletionListQuery,
} from "../lib/services/staffCompletions.ts";

/**
 * P0-8 客服工作台「完成材料审核」的持续测试 —— 服务层 + DTO 隐私。
 *
 * 领域与伪事务的不变量在 `tests/completions.test.mjs`（28 条），本文件只管
 * **客服侧**的两类事实：
 *
 * 1. 服务层把事务结论翻译成**对外错误**（404 / 400 / 500）与 `StaffCompletionWriteResult`；
 * 2. DTO 的**字段边界**：客服列表项不泄露凭证与审核人，打手摘要不泄露 `reviewedByStaffId`。
 *
 * 写身份只来自会话（`requireStaff()`），服务层收到的是 `StaffSessionUser`；
 * 这里直接用 `{ id, displayName }` 构造会话对象（`.mjs` 不做类型收窄，服务层也只读这两个字段）。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const COMPANION_A = "cp-1";

/** 客服会话。身份只由 `requireStaff()` 产生，服务层只读 id 与 displayName。 */
const STAFF = { id: "staff-1", displayName: "客服小雨" };

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}
function uniqueUser() {
  return unique("u-p08s");
}
function uniqueKey() {
  return unique("p08skey");
}

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

async function servingOrder(companionId = COMPANION_A, user = uniqueUser()) {
  const placed = await placeOrder(user);
  const dispatch = await dispatchOf(placed.id);
  const acceptedAt = plusMinutes(placed.paidAt, 1);
  const accepted = await acceptDispatch(dispatch.id, { companionId, at: acceptedAt });
  assert.equal(accepted.kind, "ok");
  const servingAt = plusMinutes(acceptedAt, 30);
  const started = await startCompanionOrderTransaction({ companionId, orderId: placed.id, at: servingAt });
  assert.equal(started.kind, "ok");
  return { order: await orderOf(placed.id), user, servingAt };
}

/** 一张 serving 单 + 一份 pending 完成材料（提交时刻可显式指定）。 */
async function pendingSubmission(atOffsetMinutes = 5, summary = "已完成护航服务") {
  const { order, servingAt } = await servingOrder();
  const submittedAt = plusMinutes(servingAt, atOffsetMinutes);
  const out = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary,
    evidence: [],
    at: submittedAt,
  });
  assert.equal(out.kind, "ok");
  return { order, orderId: order.id, submissionId: out.submissionId, submittedAt, deadline: out.autoApprovalDeadlineAt };
}

function submissionById(id) {
  return completionStore().submissions.get(id) ?? null;
}

function listQuery(overrides = {}) {
  return { status: "all", keyword: "", page: 1, pageSize: 20, ...overrides };
}

// ——————————————————————————— DTO 样本 ———————————————————————————

function makeSubmission(overrides = {}) {
  return {
    id: "cs_test_1",
    orderId: "ord_test_1",
    companionId: "cp-1",
    summary: "已完成护航服务",
    evidence: [],
    status: "pending",
    submittedAt: "2026-09-24T10:00:00.000Z",
    autoApprovalMinutesSnapshot: 10,
    autoApprovalDeadlineAt: "2026-09-24T10:10:00.000Z",
    reviewSource: null,
    reviewedByStaffId: null,
    reviewedByName: null,
    reviewedAt: null,
    rejectReason: null,
    invalidatedAt: null,
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    id: "ord_test_1",
    orderNo: "YM20260924000001",
    productTitle: "机密400万",
    status: "serving",
    companion: { name: "陪玩小名" },
    ...overrides,
  };
}

const USER = { id: "u-1", nickname: "用户昵称", avatarUrl: "/mock/avatar.svg" };

beforeEach(() => {
  resetMockStore("completion");
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("platformConfig");
  resetMockStore("refund");
  resetMockStore("complaint");
});

// ——————————————————————————— 纯逻辑 ———————————————————————————

test("状态筛选：五个取值、默认 pending、非法值严格模式返回 null（接口据此 400）", () => {
  assert.deepEqual([...STAFF_COMPLETION_STATUS_FILTERS], [
    "all",
    "pending",
    "approved",
    "rejected",
    "invalidated",
  ]);

  assert.equal(readStaffCompletionStatusFilter(null), DEFAULT_STAFF_COMPLETION_STATUS_FILTER);
  assert.equal(readStaffCompletionStatusFilter(""), DEFAULT_STAFF_COMPLETION_STATUS_FILTER);
  assert.equal(readStaffCompletionStatusFilter("  "), DEFAULT_STAFF_COMPLETION_STATUS_FILTER);
  assert.equal(readStaffCompletionStatusFilter("pending"), "pending");
  assert.equal(readStaffCompletionStatusFilter("approved"), "approved");
  assert.equal(readStaffCompletionStatusFilter("bogus"), null, "非法枚举必须返回 null，不能静默回退");
});

test("可执行动作：只有 pending 两个动作都可点，终态两个都是 false", () => {
  assert.deepEqual(staffCompletionAllowedActions("pending"), { canApprove: true, canReject: true });
  for (const status of ["approved", "rejected", "invalidated"]) {
    assert.deepEqual(staffCompletionAllowedActions(status), { canApprove: false, canReject: false });
  }
});

test("关键词：只搜订单号 / 打手名 / 用户昵称，大小写不敏感，空串恒真", () => {
  const input = { orderNo: "YM20260924000001", companionName: "陪玩小名", userNickname: "老板A" };

  assert.equal(staffCompletionMatchesKeyword(input, ""), true);
  assert.equal(staffCompletionMatchesKeyword(input, "   "), true);
  assert.equal(staffCompletionMatchesKeyword(input, "000001"), true, "订单号部分匹配");
  assert.equal(staffCompletionMatchesKeyword(input, "ym2026"), true, "大小写不敏感");
  assert.equal(staffCompletionMatchesKeyword(input, "陪玩"), true, "打手名匹配");
  assert.equal(staffCompletionMatchesKeyword(input, "老板"), true, "用户昵称匹配");
  assert.equal(staffCompletionMatchesKeyword(input, "不存在的词"), false);
  assert.equal(staffCompletionMatchesKeyword(input, "完成说明内容"), false, "完成说明不是搜索对象");
});

test("自动通过阻塞文案：退款 / 投诉两句不同，同时存在取退款文案，无阻塞为 null", () => {
  assert.equal(
    staffCompletionAutoApprovalBlockedReason({ hasActiveRefund: true, hasUnresolvedComplaint: false }),
    STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE,
  );
  assert.equal(
    staffCompletionAutoApprovalBlockedReason({ hasActiveRefund: false, hasUnresolvedComplaint: true }),
    STAFF_COMPLETION_BLOCKED_BY_COMPLAINT_MESSAGE,
  );
  assert.notEqual(
    STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE,
    STAFF_COMPLETION_BLOCKED_BY_COMPLAINT_MESSAGE,
    "两句必须不同：一个让客服看退款单、一个看投诉单",
  );
  assert.equal(
    staffCompletionAutoApprovalBlockedReason({ hasActiveRefund: true, hasUnresolvedComplaint: true }),
    STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE,
    "两者同时存在取退款文案（资金事实更急）",
  );
  assert.equal(
    staffCompletionAutoApprovalBlockedReason({ hasActiveRefund: false, hasUnresolvedComplaint: false }),
    null,
  );
});

// ——————————————————————————— DTO 字段边界 ———————————————————————————

test("客服列表项：恰好 11 个键，且不泄露凭证 / 审核人 / 驳回原因 / 内部 companionId", () => {
  const item = toStaffCompletionListItem(makeSubmission(), makeOrder(), USER);

  assert.deepEqual(Object.keys(item).sort(), [
    "autoApprovalDeadlineAt",
    "companionName",
    "id",
    "orderId",
    "orderNo",
    "productTitle",
    "status",
    "statusLabel",
    "submittedAt",
    "summary",
    "user",
  ]);

  // 列表一次返回多条，凭证与审核信息只在详情页可见；审核人 / 驳回原因属于「结果」，也去详情
  for (const forbidden of [
    "evidence",
    "reviewSource",
    "reviewedByStaffId",
    "reviewedByName",
    "reviewedAt",
    "rejectReason",
    "autoApprovalMinutesSnapshot",
    "orderStatus",
    "orderStatusLabel",
    "allowedActions",
    "autoApprovalBlockedReason",
    "companionId",
    "invalidatedAt",
  ]) {
    assert.equal(forbidden in item, false, `列表项不得暴露 ${forbidden}`);
  }
});

test("客服详情：在列表项之上恰好补 11 个键，审核人 / 驳回原因 / 订单现状 / 可执行动作都在", () => {
  const detail = toStaffCompletionDetail(
    makeSubmission({
      status: "rejected",
      reviewSource: "staff",
      reviewedByStaffId: "staff-1",
      reviewedByName: "客服小雨",
      reviewedAt: "2026-09-24T10:11:00.000Z",
      rejectReason: "截图不清晰",
      evidence: [{ id: "ev_1", url: "/mock/evidence-placeholder.svg" }],
    }),
    makeOrder({ status: "serving" }),
    USER,
    null,
  );

  assert.deepEqual(Object.keys(detail).sort(), [
    "allowedActions",
    "autoApprovalBlockedReason",
    "autoApprovalDeadlineAt",
    "autoApprovalMinutesSnapshot",
    "companionName",
    "evidence",
    "id",
    "orderId",
    "orderNo",
    "orderStatus",
    "orderStatusLabel",
    "productTitle",
    "rejectReason",
    "reviewSource",
    "reviewedAt",
    "reviewedByName",
    "reviewedByStaffId",
    "status",
    "statusLabel",
    "submittedAt",
    "summary",
    "user",
  ]);

  assert.equal(detail.rejectReason, "截图不清晰");
  assert.equal(detail.reviewedByStaffId, "staff-1");
  assert.equal(detail.orderStatus, "serving");
  assert.deepEqual(detail.allowedActions, { canApprove: false, canReject: false }, "rejected 是终态");
});

test("打手摘要：`CompanionCompletionInfo` 恰好 4 个键，绝不泄露 `reviewedByStaffId`", () => {
  // 即使 submission 上已经写了审核人（approved），打手摘要也一个字都不回
  const info = buildCompanionCompletionInfo(
    { status: "completed" },
    makeSubmission({
      status: "approved",
      reviewSource: "staff",
      reviewedByStaffId: "staff-1",
      reviewedByName: "客服小雨",
      reviewedAt: "2026-09-24T10:11:00.000Z",
    }),
  );

  assert.deepEqual(Object.keys(info).sort(), [
    "autoApprovalDeadlineAt",
    "canSubmit",
    "rejectReason",
    "status",
  ]);
  assert.equal("reviewedByStaffId" in info, false, "打手摘要不得泄露客服审核人 id");
  assert.equal("reviewedByName" in info, false);
  assert.equal(info.status, "approved");
  assert.equal(info.canSubmit, false, "approved 之后不得再提交");
});

// ——————————————————————————— 列表服务 ———————————————————————————

test("列表 1：按提交时间倒序，状态筛选生效，分页 hasMore 正确", async () => {
  const a = await pendingSubmission(5, "第一份完成说明");
  const b = await pendingSubmission(6, "第二份完成说明");
  const c = await pendingSubmission(7, "第三份完成说明");

  // 全部：三条，倒序（提交最晚的在前）
  const all = await listStaffCompletions(listQuery(), undefined, "server");
  assert.equal(all.total, 3);
  const orderIds = all.items.map((item) => item.orderId);
  assert.deepEqual(orderIds, [c.orderId, b.orderId, a.orderId], "按提交时间倒序");
  assert.equal(all.hasMore, false);
  assert.ok(all.notice.includes(STAFF_COMPLETION_LIST_NOTICE));
  assert.ok(all.notice.includes(STAFF_COMPLETION_LIST_FIELDS_NOTE));

  // 状态筛选：只回 pending
  const pendingOnly = await listStaffCompletions(listQuery({ status: "pending" }), undefined, "server");
  assert.equal(pendingOnly.total, 3);

  // 分页：pageSize 2 的第一页两条 + hasMore，第二页一条 + 不再有
  const page1 = await listStaffCompletions(listQuery({ pageSize: 2, page: 1 }), undefined, "server");
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  const page2 = await listStaffCompletions(listQuery({ pageSize: 2, page: 2 }), undefined, "server");
  assert.equal(page2.items.length, 1);
  assert.equal(page2.hasMore, false);
});

test("列表 2：关键词按订单号精确命中，列表项字段表不泄露凭证", async () => {
  const mine = await pendingSubmission(5, "我的完成说明");
  // 别人的完成材料：**必须真的建出来**（它是列表里的干扰项），但本用例不引用它的返回值
  await pendingSubmission(6, "别人的完成说明");

  const found = await listStaffCompletions(
    listQuery({ keyword: mine.order.orderNo }),
    undefined,
    "server",
  );
  assert.equal(found.total, 1, "订单号唯一，只命中一单");
  assert.equal(found.items[0].orderId, mine.orderId);
  assert.equal(found.items[0].orderNo, mine.order.orderNo);

  // 列表项字段表：就是那 11 个键（已在纯逻辑里钉过），这里再确认真实行不夹带
  const keys = Object.keys(found.items[0]).sort();
  assert.equal(keys.includes("evidence"), false);
  assert.equal(keys.includes("reviewedByStaffId"), false);
  assert.equal(keys.includes("rejectReason"), false);
});

test("列表 3：空结果——fresh store 上 pending 筛选为空，total 0", async () => {
  const result = await listStaffCompletions(listQuery({ status: "pending" }), undefined, "server");
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
});

test("列表 4：严格解析非法 status 抛 400，不静默回退", () => {
  // `resolveStaffCompletionListQuery` 是同步函数，直接 `assert.throws`
  assert.throws(
    () => resolveStaffCompletionListQuery(new URLSearchParams("status=bogus"), true),
    (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, STAFF_COMPLETION_STATUS_INVALID_MESSAGE);
      return true;
    },
  );
});

// ——————————————————————————— 详情服务 ———————————————————————————

test("详情 1：不存在的 id（含空串）返回 null，由页面 notFound()", async () => {
  assert.equal(await getStaffCompletionDetail("cs_不存在", undefined, "server"), null);
  assert.equal(await getStaffCompletionDetail("", undefined, "server"), null);
});

test("详情 2：真实详情带凭证 / 审核信息 / 订单现状 / allowedActions / 阻塞原因", async () => {
  const { submissionId } = await pendingSubmission();

  const detail = await getStaffCompletionDetail(submissionId, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.id, submissionId);
  assert.equal(detail.status, "pending");
  assert.equal(detail.orderStatus, "serving");
  assert.equal(detail.autoApprovalMinutesSnapshot, 10);
  assert.deepEqual(detail.allowedActions, { canApprove: true, canReject: true });
  assert.equal(detail.autoApprovalBlockedReason, null, "无阻塞时阻塞原因为 null");
  assert.equal(detail.reviewedByStaffId, null, "还没出审核结果，审核人为 null");
  assert.equal(detail.rejectReason, null);
});

// ——————————————————————————— 通过 / 驳回服务 ———————————————————————————

test("通过 1：成功通过返回 submissionId / approved / changed，订单 completed", async () => {
  const { orderId, submissionId } = await pendingSubmission();

  const out = await approveStaffCompletion(submissionId, STAFF);
  assert.equal(out.submissionId, submissionId);
  assert.equal(out.status, "approved");
  assert.equal(out.statusLabel, "已通过");
  assert.equal(out.changed, true);

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed");
});

test("通过 2：不存在的 id（含空串）404，文案是那一句冻结的常量", async () => {
  await assert.rejects(() => approveStaffCompletion("cs_不存在", STAFF), expectStaff404());
  await assert.rejects(() => approveStaffCompletion("", STAFF), expectStaff404());
});

function expectStaff404() {
  return (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.status, 404);
    assert.equal(error.message, STAFF_COMPLETION_NOT_FOUND_MESSAGE);
    return true;
  };
}

test("通过 3：终态再通过是 400（带上当前状态），不是重放、也不是 404", async () => {
  const { submissionId } = await pendingSubmission();
  await rejectCompletion({
    submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    rejectReason: "截图不清晰",
    at: new Date().toISOString(),
  });

  await assert.rejects(() => approveStaffCompletion(submissionId, STAFF), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.message, staffCompletionTransitionMessage("rejected"));
    return true;
  });
});

test("通过 4：订单已不在 serving（被退款）时 400，订单一个字段都不动", async () => {
  const { orderId, submissionId } = await pendingSubmission();
  const before = await orderOf(orderId);

  // 直接改状态模拟「客服审核前订单已被退款」
  paymentStore().orders.get(orderId).status = "refunded";

  await assert.rejects(() => approveStaffCompletion(submissionId, STAFF), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.message, STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE);
    return true;
  });

  assert.equal(submissionById(submissionId).status, "pending", "被拒的通过不得改材料状态");
  assert.equal((await orderOf(orderId)).status, "refunded");
  assert.deepEqual(await orderOf(orderId), { ...before, status: "refunded" });
});

test("通过 5：换人后旧材料失效 → 400（stale），订单仍 serving", async () => {
  const { orderId, submissionId } = await pendingSubmission();
  paymentStore().orders.get(orderId).actualCompanionId = "cp-2";

  await assert.rejects(() => approveStaffCompletion(submissionId, STAFF), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.message, STAFF_COMPLETION_STALE_SUBMISSION_MESSAGE);
    return true;
  });

  assert.equal(submissionById(submissionId).status, "pending");
  assert.equal((await orderOf(orderId)).status, "serving");
});

test("驳回 1：成功驳回返回 rejected + changed，驳回原因与审核人写入，订单不动", async () => {
  const { orderId, submissionId } = await pendingSubmission();
  const before = await orderOf(orderId);

  const out = await rejectStaffCompletion(submissionId, STAFF, { reviewNote: "截图不清晰，请重新上传" });
  assert.equal(out.submissionId, submissionId);
  assert.equal(out.status, "rejected");
  assert.equal(out.statusLabel, "已驳回");
  assert.equal(out.changed, true);

  const submission = submissionById(submissionId);
  assert.equal(submission.rejectReason, "截图不清晰，请重新上传");
  assert.equal(submission.reviewedByStaffId, STAFF.id);
  assert.equal(submission.reviewedByName, STAFF.displayName);
  assert.equal(submission.reviewSource, "staff");

  assert.deepEqual(await orderOf(orderId), before, "驳回不动订单");
  assert.equal(before.status, "serving");
});

test("驳回 2：驳回原因空 / 纯空白 / 超长都 400，不改状态", async () => {
  const { submissionId } = await pendingSubmission();

  await assert.rejects(
    () => rejectStaffCompletion(submissionId, STAFF, { reviewNote: "" }),
    (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, ADMIN_REVIEW_NOTE_EMPTY_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    () => rejectStaffCompletion(submissionId, STAFF, { reviewNote: "   \n\t" }),
    (error) => {
      assert.equal(error.message, ADMIN_REVIEW_NOTE_EMPTY_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    () => rejectStaffCompletion(submissionId, STAFF, { reviewNote: "x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH + 1) }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE);
      return true;
    },
  );

  assert.equal(submissionById(submissionId).status, "pending", "被拒的驳回不得改状态");
});

test("驳回 3：不存在的 id 404", async () => {
  await assert.rejects(() => rejectStaffCompletion("cs_不存在", STAFF, { reviewNote: "有原因" }), expectStaff404());
});

test("驳回 4：approved 之后再驳回是 400（带上当前状态），不是重放", async () => {
  const { submissionId } = await pendingSubmission();
  await approveCompletion({
    submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    at: new Date().toISOString(),
  });

  await assert.rejects(() => rejectStaffCompletion(submissionId, STAFF, { reviewNote: "想反悔" }), (error) => {
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.message, staffCompletionTransitionMessage("approved"));
    return true;
  });
});
