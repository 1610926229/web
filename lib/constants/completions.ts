import type { ComplaintStatus } from "@/lib/types/complaint";
import type { CompanionCompletionInfo, CompletionSubmission, CompletionSubmissionStatus } from "@/lib/types/completion";
import type { OrderStatus } from "@/lib/types/order";
import { countCharacters } from "@/lib/utils/text";

/**
 * 完成材料（CompletionSubmission）的状态、校验与展示规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type` 与纯函数，没有任何运行时依赖（`countCharacters` 也是纯函数）：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 这里只描述**规则**，不读写数据。判断「能不能提交」「要不要自动通过」的权威仍然是服务端：
 * 页面用同一套函数渲染入口，写接口时在伪事务里再校验一次。
 */

// ——————————————————————————— 完成说明 ———————————————————————————

/** 完成说明长度下限：**5 字**。 */
export const COMPLETION_SUMMARY_MIN_LENGTH = 5;

/** 完成说明长度上限：**50 字**。 */
export const COMPLETION_SUMMARY_MAX_LENGTH = 50;

export const COMPLETION_SUMMARY_EMPTY_MESSAGE = "请填写完成说明";
export const COMPLETION_SUMMARY_TOO_SHORT_MESSAGE =
  `完成说明至少需要 ${COMPLETION_SUMMARY_MIN_LENGTH} 个字`;
export const COMPLETION_SUMMARY_TOO_LONG_MESSAGE =
  `完成说明不能超过 ${COMPLETION_SUMMARY_MAX_LENGTH} 个字`;

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 完成说明的校验。
 *
 * ⚠️ 长度按**字符数**（`countCharacters`，Emoji 算 1 个）而不是 UTF-16 码元数：
 * 一个手写 Emoji 不该被算成两个字。规则只在服务端生效一次，但实现写在这里两端共用。
 */
export function normalizeCompletionSummary(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: COMPLETION_SUMMARY_EMPTY_MESSAGE };
  const length = countCharacters(value);
  if (length < COMPLETION_SUMMARY_MIN_LENGTH) {
    return { ok: false, message: COMPLETION_SUMMARY_TOO_SHORT_MESSAGE };
  }
  if (length > COMPLETION_SUMMARY_MAX_LENGTH) {
    return { ok: false, message: COMPLETION_SUMMARY_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

// ——————————————————————————— 提交失败文案（打手端） ———————————————————————————

/** 订单不存在，或不是本人实际履约。对外 404，不泄露存在性。 */
export const COMPLETION_ORDER_NOT_FOUND_MESSAGE = "订单不存在或不属于你";

/** 是本人的单，但状态不是 serving。对外 400。 */
export const COMPLETION_ORDER_NOT_SERVING_MESSAGE = "只有护航中的订单才能提交完成材料";

/** 该订单已有一份 pending。对外 400。 */
export const COMPLETION_PENDING_EXISTS_MESSAGE =
  "该订单已有一份待审核的完成材料，请等待审核结果";

// ——————————————————————————— 状态机 ———————————————————————————

/** 四个完成材料状态，顺序与筛选栏一致。 */
export const COMPLETION_STATUSES: readonly CompletionSubmissionStatus[] = [
  "pending",
  "approved",
  "rejected",
  "invalidated",
];

export const COMPLETION_STATUS_LABELS: Record<CompletionSubmissionStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  invalidated: "已失效",
};

/**
 * 完成材料状态迁移表。**这是 `CompletionSubmission` 状态机唯一的定义处。**
 *
 * `pending` 可以走向 `approved`（人工或 System）、`rejected`（人工驳回）
 * 与 `invalidated`（P0-11：当前履约被打手**之外**的力量解除时立即作废）；
 * `approved` / `rejected` / `invalidated` 都是终态。
 *
 * ## `pending → invalidated`（P0-11 新增，本轮第一次有写入路径）
 *
 * 它此前只在表里占位、零调用。本轮补上这条边，是因为**作废必须走中央状态机**
 * （`P0-9/02-decisions.md` D15 的既定约束：不得复用 `applyCompletionReview`），
 * 而补之前那条边根本不存在，作废在结构上就是非法的。
 *
 * ⚠️ **它只由释放路径触发**（封禁回池 / 客服换人），入口只有一个：
 * `invalidatePendingCompletionForOrder()`（`lib/data/completionTransaction.ts`）。
 * 「不提供按钮」这条在这里是靠**没有第二个调用方**成立的，不是靠注释。
 *
 * ⚠️ 补上这条边**不会**让 `invalidated` 变成可审核状态：
 * `approveCompletion` / `rejectCompletion` 的领域 Guard 要求恰好 `pending`，
 * `sweepCompletionAutoApprovals` 的白名单也只认 `pending`。三道门都不看这条边。
 */
export const COMPLETION_TRANSITIONS: Record<
  CompletionSubmissionStatus,
  readonly CompletionSubmissionStatus[]
> = {
  pending: ["approved", "rejected", "invalidated"],
  approved: [],
  rejected: [],
  invalidated: [],
};

/** 这次迁移在结构上是否允许。`from === to` 一律 false（自环不是迁移）。 */
export function canTransitionCompletion(
  from: CompletionSubmissionStatus,
  to: CompletionSubmissionStatus,
): boolean {
  return COMPLETION_TRANSITIONS[from].includes(to);
}

// ——————————————————————————— 自动通过的阻塞判据 ———————————————————————————

/**
 * 投诉是否「未完结」。
 *
 * ⚠️ 这是 D4 记录的一处按现有语义推导的取舍：EX-COMPLETE-05 只说「有投诉时不得自动通过」，
 * 未区分投诉是否已完结。本轮取「未完结（`pending` / `processing`）才算阻塞」，
 * 理由是 `Complaint.handledAt` 把「处理完成」当成事情已经决定的分界线；
 * 若已 `resolved` 的投诉永久阻塞自动审核，「保持人工处理」会退化成「此单永不自动通过」。
 */
export function isUnresolvedComplaintStatus(status: ComplaintStatus): boolean {
  return status === "pending" || status === "processing";
}

/**
 * 是否存在「有效售后 / 未完结投诉」阻塞自动通过。
 *
 * 两个布尔值由调用方（`sweepCompletionAutoApprovals`）按既有语义算好传入：
 * - `hasActiveRefund` —— 该订单存在进行中的退款申请（`isActiveRefundStatus`）；
 * - `hasUnresolvedComplaint` —— 该订单存在未完结的投诉（`isUnresolvedComplaintStatus`）。
 *
 * 纯函数不接触仓储，因此能直接做纯逻辑测试；将来产品若裁定「历史上出现过投诉就永久转人工」，
 * 改动点只有这一处。
 */
export function isCompletionAutoApprovalBlocked(input: {
  hasActiveRefund: boolean;
  hasUnresolvedComplaint: boolean;
}): boolean {
  return input.hasActiveRefund || input.hasUnresolvedComplaint;
}

// ——————————————————————————— 打手端展示 ———————————————————————————

/**
 * 订单 + 最近一次提交 → 打手订单详情上的完成材料摘要。
 *
 * `canSubmit` 由**服务端算好**：`serving` + 无 pending + 最近一次不是 approved。
 * 三条里缺任何一条都不能提交——`pending` 期间禁止第二份，approved 后不得再改 completed 事实。
 */
export function buildCompanionCompletionInfo(
  order: { status: OrderStatus },
  submission: CompletionSubmission | null,
): CompanionCompletionInfo {
  if (!submission) {
    return {
      status: null,
      canSubmit: order.status === "serving",
      autoApprovalDeadlineAt: null,
      rejectReason: null,
    };
  }

  return {
    status: submission.status,
    canSubmit:
      order.status === "serving" &&
      submission.status !== "pending" &&
      submission.status !== "approved",
    autoApprovalDeadlineAt:
      submission.status === "pending" ? submission.autoApprovalDeadlineAt : null,
    rejectReason: submission.status === "rejected" ? submission.rejectReason : null,
  };
}
