import { ApiError } from "@/lib/api/ApiError";
import { normalizeAdminReviewNote } from "@/lib/constants/adminRefunds";
import { COMPLETION_STATUS_LABELS, isUnresolvedComplaintStatus } from "@/lib/constants/completions";
import { isActiveRefundStatus } from "@/lib/constants/refunds";
import {
  DEFAULT_STAFF_COMPLETION_STATUS_FILTER,
  STAFF_COMPLETION_LIST_FIELDS_NOTE,
  STAFF_COMPLETION_LIST_NOTICE,
  STAFF_COMPLETION_NOT_FOUND_MESSAGE,
  STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE,
  STAFF_COMPLETION_STALE_SUBMISSION_MESSAGE,
  STAFF_COMPLETION_STATUS_INVALID_MESSAGE,
  buildStaffCompletionsListQuery,
  compareStaffCompletions,
  readStaffCompletionStatusFilter,
  staffCompletionAutoApprovalBlockedReason,
  staffCompletionMatchesKeyword,
  staffCompletionTransitionMessage,
  toStaffCompletionDetail,
  toStaffCompletionListItem,
  type StaffCompletionListQuery,
} from "@/lib/constants/staffCompletions";
import { readTrimmedString } from "@/lib/constants/writes";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getCompletionRepository } from "@/lib/data/completionRepository";
import {
  approveCompletion as approveCompletionTransaction,
  rejectCompletion as rejectCompletionTransaction,
  sweepCompletionAutoApprovals,
} from "@/lib/data/completionTransaction";
import {
  ADMIN_ORDER_UNFILTERED_QUERY,
  getPaymentRepository,
} from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  CompletionSubmission,
  CompletionSubmissionStatus,
  StaffCompletionApproveOutcome,
  StaffCompletionDetail,
  StaffCompletionListData,
  StaffCompletionRejectOutcome,
  StaffCompletionWriteResult,
} from "@/lib/types/completion";
import type { Order } from "@/lib/types/order";
import type { StaffSessionUser, StaffUserSummary } from "@/lib/types/staff";

/**
 * 客服工作台「完成材料审核」服务 —— 列表、详情与两个审核动作的唯一入口（P0-8）。
 *
 * ⚠️ 本文件**只服务客服端**，每一个调用它的接口都先经过 `requireStaff()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/staffRoute.ts`）。
 *
 * ⚠️ **两个动作没有幂等键、没有 `operationId`、不写审计**：完成材料的审核结果是
 * 终态（approved / rejected），幂等判据是**状态本身**（已经是目标状态就是重放）；
 * 审核人三个字段直接写在 submission 上，那本身就是审计踪迹。与
 * `staffRefunds`（幂等键 + 审计）是两条刻意不同的机制。
 *
 * ⚠️ 写操作的身份**只从 `requireStaff()` 返回的会话拼**：`reviewedByStaffId` =
 * 客服 id、`reviewedByName` = 客服显示名快照。请求体里的 actor 字段没有任何进入路径。
 */

// ——————————————————————————— 订单索引 ———————————————————————————

/** orderId → 订单。关键词里含订单号，而订单号在订单上、不在完成材料上。 */
async function staffOrderIndex(): Promise<Map<string, Order>> {
  const orders = await getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
  return new Map(orders.map((order) => [order.id, order]));
}

/**
 * userId → 用户摘要。与客服退款列表同一做法：一次取回全部用户，避免逐条查询。
 *
 * ⚠️ 字段表就是边界：`StaffUserSummary` 只有 id / 昵称 / 头像，
 * 没有平台展示 ID，也没有任何支付 / 凭据字段。
 */
async function staffUserIndex(): Promise<Map<string, StaffUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [
      user.id,
      { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
    ]),
  );
}

/** 用户记录缺失时的占位摘要（缺一条用户记录不该让整页打不开）。与 staffRefunds 同一写法。 */
function missingUser(userId: string): StaffUserSummary {
  return { id: userId, nickname: "", avatarUrl: "" };
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 */
export function resolveStaffCompletionListQuery(
  params: URLSearchParams,
  strict: boolean,
): StaffCompletionListQuery {
  const status = readStaffCompletionStatusFilter(params.get("status"));
  if (strict && status === null) {
    throw new ApiError("BAD_REQUEST", STAFF_COMPLETION_STATUS_INVALID_MESSAGE, 400);
  }

  return buildStaffCompletionsListQuery({
    params,
    status: status ?? DEFAULT_STAFF_COMPLETION_STATUS_FILTER,
  });
}

/**
 * 客服端完成材料列表。
 *
 * ⚠️ **不接 `mockEmpty`**（`MockEmptyScope` 没有 completion 这一档），
 * `?mockError=…` 由 `withMockDebug` 统一处理，仅在 `ENABLE_MOCK_DEBUG=true` 时生效。
 *
 * ⚠️ 读之前先做一次自动审核清扫（幂等）：列表里的状态必须与业务事实一致——
 * 一份已经到点的 pending 材料不该还显示成「待审核」。
 */
export async function listStaffCompletions(
  query: StaffCompletionListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffCompletionListData> {
  // 惰性物化自动通过事实（幂等）：到期且无阻塞的 pending 材料在读取时被写成 approved
  sweepCompletionAutoApprovals(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    const [rows, orders, users] = await Promise.all([
      getCompletionRepository().listCompletionsForStaff({
        status: query.status === "all" ? null : query.status,
      }),
      staffOrderIndex(),
      staffUserIndex(),
    ]);

    const matched = rows
      .map((submission) => ({ submission, order: orders.get(submission.orderId) }))
      .filter((row): row is { submission: CompletionSubmission; order: Order } => row.order !== undefined)
      .map(({ submission, order }) => ({
        submission,
        order,
        user: users.get(order.userId) ?? missingUser(order.userId),
      }))
      .filter(({ submission, order, user }) =>
        staffCompletionMatchesKeyword(
          {
            orderNo: order.orderNo,
            companionName: order.companion?.name ?? submission.companionId,
            userNickname: user.nickname,
          },
          query.keyword,
        ),
      )
      .sort((a, b) => compareStaffCompletions(a.submission, b.submission));

    const start = (query.page - 1) * query.pageSize;
    const items = matched
      .slice(start, start + query.pageSize)
      .map(({ submission, order, user }) => toStaffCompletionListItem(submission, order, user));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      hasMore: start + items.length < matched.length,
      notice: `${STAFF_COMPLETION_LIST_NOTICE} ${STAFF_COMPLETION_LIST_FIELDS_NOTE}`,
    };
  });
}

// ——————————————————————————— 详情 ———————————————————————————

/**
 * 客服端完成材料详情。不存在（或它的订单不可读）返回 null，由页面 `notFound()`。
 *
 * 详情里补齐凭证、审核信息、订单现状与服务端判定的 `allowedActions`。
 * 读之前同样先做一次自动审核清扫，保证状态与业务事实一致。
 */
export async function getStaffCompletionDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffCompletionDetail | null> {
  if (!id) return null;

  sweepCompletionAutoApprovals(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    const submission = await getCompletionRepository().findCompletionById(id);
    if (!submission) return null;

    const order = await getPaymentRepository().findOrderById(submission.orderId);
    if (!order) return null;

    const users = await staffUserIndex();
    const user = users.get(order.userId) ?? missingUser(order.userId);

    // 自动通过的阻塞原因（EX-COMPLETE-05）只对 pending 有意义：approved / rejected 已经
    // 出过结论，auto approval 不再适用。判定复用纯函数（isActiveRefundStatus /
    // isUnresolvedComplaintStatus），这里只做数据读取与文案映射。
    let autoApprovalBlockedReason: string | null = null;
    if (submission.status === "pending") {
      const refund = await getRefundRepository().findRefundByOrderId(order.id);
      const hasActiveRefund = refund ? isActiveRefundStatus(refund.status) : false;

      const complaints = await getComplaintRepository().listComplaintsByOrderId(order.id);
      const hasUnresolvedComplaint = complaints.some((complaint) =>
        isUnresolvedComplaintStatus(complaint.status),
      );

      autoApprovalBlockedReason = staffCompletionAutoApprovalBlockedReason({
        hasActiveRefund,
        hasUnresolvedComplaint,
      });
    }

    return toStaffCompletionDetail(submission, order, user, autoApprovalBlockedReason);
  });
}

// ——————————————————————————— 两个审核动作 ———————————————————————————

/** 伪事务结果 → 接口返回。客服的两个动作里只有通过会动订单，这里只回 submission 结论。 */
function toWriteResult(submission: CompletionSubmission, changed: boolean): StaffCompletionWriteResult {
  return {
    submissionId: submission.id,
    status: submission.status,
    statusLabel: COMPLETION_STATUS_LABELS[submission.status],
    changed,
  };
}

/** 状态机拒绝这次迁移时的 400（文案取自常量层，带上当前状态）。 */
function invalidTransition(status: CompletionSubmissionStatus): ApiError {
  return new ApiError("BAD_REQUEST", staffCompletionTransitionMessage(status), 400);
}

/** 「通过」的失败翻译。 */
function toApproveError(
  outcome: Exclude<StaffCompletionApproveOutcome, { kind: "ok" } | { kind: "replayed" }>,
): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", STAFF_COMPLETION_NOT_FOUND_MESSAGE, 404);
    case "invalid-status":
      return invalidTransition(outcome.status);
    case "order-missing":
      // 完成材料挂着的订单不见了，属于服务端数据问题，报 500 而不是 404
      return new ApiError("SERVER_ERROR", "完成材料对应的订单不存在，请联系技术支持", 500);
    case "order-not-serving":
      return new ApiError("BAD_REQUEST", STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE, 400);
    case "stale-submission":
      return new ApiError("BAD_REQUEST", STAFF_COMPLETION_STALE_SUBMISSION_MESSAGE, 400);
  }
}

/** 「驳回」的失败翻译。 */
function toRejectError(
  outcome: Exclude<StaffCompletionRejectOutcome, { kind: "ok" } | { kind: "replayed" }>,
): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", STAFF_COMPLETION_NOT_FOUND_MESSAGE, 404);
    case "invalid-status":
      return invalidTransition(outcome.status);
  }
}

/**
 * 客服通过完成材料：`pending submission + serving order → approved + completed`。
 *
 * ⚠️ **没有请求体、没有幂等键**：幂等判据是状态本身（已经是 approved 就是重放）。
 * 因此本函数不接收 body，也就没有「参数非法」这一类失败——少一个参数就是少一条
 * 「哪些字段合法」的规则要维护。审核人三个字段写在这条 submission 上。
 */
export async function approveStaffCompletion(
  id: string,
  staff: StaffSessionUser,
): Promise<StaffCompletionWriteResult> {
  if (!id) throw new ApiError("NOT_FOUND", STAFF_COMPLETION_NOT_FOUND_MESSAGE, 404);

  const at = new Date().toISOString();

  const outcome = await approveCompletionTransaction({
    submissionId: id,
    staffId: staff.id,
    staffName: staff.displayName,
    at,
  });

  if (outcome.kind === "ok" || outcome.kind === "replayed") {
    return toWriteResult(outcome.submission, outcome.changed);
  }
  throw toApproveError(outcome);
}

/**
 * 客服驳回完成材料：`pending submission → rejected`，**订单不动**。
 *
 * ⚠️ **必须填写驳回原因**，规则复用 `normalizeAdminReviewNote`（与入驻审核、管理端退款
 * 同一份）。**没有幂等键**：已经是 rejected 就是重放（不覆盖第一次的驳回原因）。
 */
export async function rejectStaffCompletion(
  id: string,
  staff: StaffSessionUser,
  body: Record<string, unknown>,
): Promise<StaffCompletionWriteResult> {
  if (!id) throw new ApiError("NOT_FOUND", STAFF_COMPLETION_NOT_FOUND_MESSAGE, 404);

  const note = normalizeAdminReviewNote(readTrimmedString(body, "reviewNote"));
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);

  const at = new Date().toISOString();

  const outcome = await rejectCompletionTransaction({
    submissionId: id,
    staffId: staff.id,
    staffName: staff.displayName,
    rejectReason: note.value,
    at,
  });

  if (outcome.kind === "ok" || outcome.kind === "replayed") {
    return toWriteResult(outcome.submission, outcome.changed);
  }
  throw toRejectError(outcome);
}
