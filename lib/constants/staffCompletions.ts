import {
  COMPLETION_STATUSES,
  COMPLETION_STATUS_LABELS,
  canTransitionCompletion,
} from "@/lib/constants/completions";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import {
  STAFF_MAX_PAGE,
  STAFF_MAX_PAGE_SIZE,
  STAFF_PAGE_SIZE,
} from "@/lib/constants/staff";
import type {
  CompletionSubmission,
  CompletionSubmissionStatus,
  StaffCompletionAllowedActions,
  StaffCompletionDetail,
  StaffCompletionListItem,
} from "@/lib/types/completion";
import type { OrderStatus } from "@/lib/types/order";
import type { StaffUserSummary } from "@/lib/types/staff";

/**
 * 客服端「完成材料审核」的筛选规则、状态机结论与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与另外几个纯逻辑常量模块外没有运行时依赖：客户端组件引用它
 * 不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ 状态机**只从 `lib/constants/completions.ts` 的 `canTransitionCompletion` 推导**：
 * 这里不另写一张迁移表。客服的两个动作（通过、驳回）是「迁移到某个状态」的别名。
 */

export const STAFF_COMPLETION_DETAIL_TITLE = "完成材料审核";

/**
 * 列表顶部的说明：讲清楚这张列表的口径与动作后果。
 *
 * 通过会**同时**把订单改成「已完成」；驳回保持订单「护航中」并允许打手重新提交。
 * 两件事都要说清楚，否则客服会以为「通过」只是给材料盖章。
 */
export const STAFF_COMPLETION_LIST_NOTICE =
  "列表按提交时间倒序，涵盖全部打手提交的完成材料。通过会把订单同时改为「已完成」，" +
  "驳回保持订单「护航中」并允许打手重新提交。";

/** 列表为空时的提示。 */
export const STAFF_COMPLETION_EMPTY_MESSAGE = "当前筛选下没有完成材料。";

/**
 * 列表底部的字段边界与动作位置说明。
 *
 * 两件事都要说：列表看不到证明材料与审核信息，而且**动作不在这里**——
 * 通过与驳回都要到详情页看全证明材料与说明之后才能动手。
 */
export const STAFF_COMPLETION_LIST_FIELDS_NOTE =
  "列表不展示证明材料与审核信息；这些内容只在详情页可见，通过与驳回两个动作也在详情页执行。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const STAFF_COMPLETION_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / approved / rejected / invalidated";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type StaffCompletionStatusFilter = CompletionSubmissionStatus | "all";

export const STAFF_COMPLETION_STATUS_FILTERS: readonly StaffCompletionStatusFilter[] = [
  "all",
  ...COMPLETION_STATUSES,
];

export const STAFF_COMPLETION_STATUS_FILTER_LABELS: Record<StaffCompletionStatusFilter, string> = {
  all: "全部",
  ...COMPLETION_STATUS_LABELS,
};

/** 默认筛选：**待审核**。这个页面的主要用途是处理待办，打开就是全部历史并不好用。 */
export const DEFAULT_STAFF_COMPLETION_STATUS_FILTER: StaffCompletionStatusFilter = "pending";

export function isStaffCompletionStatusFilter(value: string): value is StaffCompletionStatusFilter {
  return (STAFF_COMPLETION_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readStaffCompletionStatusFilter(
  raw: string | null,
): StaffCompletionStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_STAFF_COMPLETION_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_STAFF_COMPLETION_STATUS_FILTER;
  return isStaffCompletionStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeStaffCompletionStatusFilter(raw: string | null): StaffCompletionStatusFilter {
  return readStaffCompletionStatusFilter(raw) ?? DEFAULT_STAFF_COMPLETION_STATUS_FILTER;
}

// ——————————————————————————— 状态机结论 ———————————————————————————

/**
 * 客服可执行的完成材料动作。
 *
 * 从 `COMPLETION_TRANSITIONS` 推导：只有 pending 可以 approve / reject，
 * approved / rejected / invalidated 三项都是 false。
 */
export function staffCompletionAllowedActions(
  status: CompletionSubmissionStatus,
): StaffCompletionAllowedActions {
  return {
    canApprove: canTransitionCompletion(status, "approved"),
    canReject: canTransitionCompletion(status, "rejected"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const STAFF_COMPLETION_TERMINAL_NOTICE = "这份完成材料已出结果，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const STAFF_COMPLETION_NOT_FOUND_MESSAGE = "完成材料不存在";

/** 通过时订单已不在护航中（例如已被退款），无法推进到已完成。 */
export const STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE = "该订单已不在护航中，无法通过完成材料";

/** 通过时完成材料的打手与订单当前实际履约打手不一致（换人后旧材料失效）。 */
export const STAFF_COMPLETION_STALE_SUBMISSION_MESSAGE = "这份完成材料已失效，无法通过";

/**
 * 幂等重放（`changed:false`）时的提示。
 *
 * ⚠️ **不能报成功**：重放意味着服务端**这一次什么都没改**。文案与
 * `STAFF_REFUND_REPLAY_NOTICE` 对齐——两个工作台对同一件事说同一句话。
 */
export const STAFF_COMPLETION_REPLAY_NOTICE = "这份完成材料已经按这个操作处理过了，没有重复执行。";

/**
 * 写操作**已经生效**、但随后的详情刷新失败时的提示。
 *
 * ⚠️ 这一句不能说成「操作失败」：写是真的成功了，把它报成失败会诱导客服再点一次。
 */
export const STAFF_COMPLETION_REFRESH_FAILED_NOTICE =
  "操作已生效，但详情刷新失败。请重新加载页面确认最新状态。";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**。 */
export function staffCompletionTransitionMessage(status: CompletionSubmissionStatus): string {
  return `当前状态是「${COMPLETION_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。 */
export const STAFF_COMPLETION_ACTION_LABELS = {
  approve: "通过",
  reject: "驳回",
} as const;

/**
 * 两个动作的二次确认文案。
 *
 * 通过那条要**说清楚会发生什么**：它会同时改动完成材料与订单两处。
 * 驳回那条要说明打手会看到什么、订单会怎样。
 */
export const STAFF_COMPLETION_CONFIRM_TEXTS = {
  approve: "通过后会把完成材料改为「已通过」、订单改为「已完成」。确定通过？",
  reject: "驳回后打手会看到驳回原因，订单保持「护航中」，打手可重新提交。确定驳回？",
} as const;

// ——————————————————————————— 自动通过的阻塞文案 ———————————————————————————

/** 有进行中退款时，这份 pending 材料不会自动通过（客服要去看退款单）。 */
export const STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE = "该订单有进行中的退款申请，需先处理退款";

/** 有未完结投诉时，这份 pending 材料不会自动通过（客服要去看投诉单）。 */
export const STAFF_COMPLETION_BLOCKED_BY_COMPLAINT_MESSAGE = "该订单有未完结的投诉，需先处理投诉";

/**
 * 自动通过的阻塞 → 客服可读文案（EX-COMPLETE-05 在客服界面的落点）。
 *
 * 两个布尔值由服务层用 `isActiveRefundStatus` / `isUnresolvedComplaintStatus` 算好传入
 * （判定**复用** `lib/constants/completions.ts` 的纯函数，这里不另写一份），本函数只做
 * 「哪一句文案」的映射。`pending` 之外的终态不经过这里（DTO 层只在 status === "pending"
 * 时才调用）。为 null = 无阻塞。
 *
 * 两种阻塞文案**必须不同**：一个要客服去看退款单、一个去看投诉单，处置完全不同。
 * 两者同时存在时取退款文案——退款是资金事实、处置更急，而且「同一订单一笔退款」
 * 比「可能有若干条投诉」更确定，优先给那条最明确的路径。
 */
export function staffCompletionAutoApprovalBlockedReason(input: {
  hasActiveRefund: boolean;
  hasUnresolvedComplaint: boolean;
}): string | null {
  if (input.hasActiveRefund) return STAFF_COMPLETION_BLOCKED_BY_REFUND_MESSAGE;
  if (input.hasUnresolvedComplaint) return STAFF_COMPLETION_BLOCKED_BY_COMPLAINT_MESSAGE;
  return null;
}

// ——————————————————————————— 列表查询 ———————————————————————————

/** 客服端完成材料列表查询条件（已解析、已校验）。 */
export type StaffCompletionListQuery = {
  /** `all` 表示不限状态 */
  status: StaffCompletionStatusFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它列表一致）。
 *
 * ⚠️ **只搜「订单号 / 打手名」**，不搜完成说明与驳回原因：那两段是内容不是标识，
 * 用它们搜出来的结果没人能预期；而完成说明可能含打手写的隐私信息，
 * 把它当搜索对象等于给了一个探测入口。
 */
export function readStaffCompletionKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildStaffCompletionsListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: StaffCompletionStatusFilter;
}): StaffCompletionListQuery {
  return {
    status: input.status,
    keyword: readStaffCompletionKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), STAFF_PAGE_SIZE, STAFF_MAX_PAGE_SIZE),
  };
}

/**
 * 默认排序：提交时间倒序，同一时间按 id 倒序兜底。
 *
 * 兜底不是可有可无的：时间相同时顺序不确定，会让同一条在第一页出现过、
 * 翻到第二页又出现一次。
 */
export function compareStaffCompletions(
  a: Pick<CompletionSubmission, "submittedAt" | "id">,
  b: Pick<CompletionSubmission, "submittedAt" | "id">,
): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** 关键词是否命中：订单号 / 打手名 / 用户昵称 三处任一包含即可（大小写不敏感）。 */
export function staffCompletionMatchesKeyword(
  input: { orderNo: string; companionName: string; userNickname: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.orderNo.toLowerCase().includes(needle) ||
    input.companionName.toLowerCase().includes(needle) ||
    input.userNickname.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 完成材料 + 订单摘要 + 用户摘要 → 客服端列表项。**显式挑字段**。 */
export function toStaffCompletionListItem(
  submission: CompletionSubmission,
  order: {
    id: string;
    orderNo: string;
    productTitle: string;
    companion: { name: string } | null;
  },
  user: StaffUserSummary,
): StaffCompletionListItem {
  return {
    id: submission.id,
    status: submission.status,
    statusLabel: COMPLETION_STATUS_LABELS[submission.status],
    orderId: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    // 打手名来自订单的陪伴快照；查不到（历史数据）回落到 companionId，**不许留空串**
    companionName: order.companion?.name ?? submission.companionId,
    // 用户摘要字段表照抄 StaffUserSummary，占位由服务层用与 staffRefunds 一致的写法处理
    user,
    summary: submission.summary,
    submittedAt: submission.submittedAt,
    autoApprovalDeadlineAt: submission.autoApprovalDeadlineAt,
  };
}

/**
 * 内部实体 → 客服端详情。在列表项之上补齐凭证、审核信息、订单现状与可执行动作。
 *
 * ⚠️ 本层不碰 `lib/data`（它同时被浏览器端引用）：订单与 submission 由服务层查好传进来。
 */
export function toStaffCompletionDetail(
  submission: CompletionSubmission,
  order: {
    id: string;
    orderNo: string;
    productTitle: string;
    status: OrderStatus;
    companion: { name: string } | null;
  },
  user: StaffUserSummary,
  autoApprovalBlockedReason: string | null,
): StaffCompletionDetail {
  return {
    ...toStaffCompletionListItem(submission, order, user),
    evidence: submission.evidence,
    autoApprovalMinutesSnapshot: submission.autoApprovalMinutesSnapshot,
    reviewSource: submission.reviewSource,
    reviewedByStaffId: submission.reviewedByStaffId,
    reviewedByName: submission.reviewedByName,
    reviewedAt: submission.reviewedAt,
    rejectReason: submission.rejectReason,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status],
    allowedActions: staffCompletionAllowedActions(submission.status),
    autoApprovalBlockedReason,
  };
}
