import {
  REVIEW_MAX_PAGE,
  REVIEW_MAX_PAGE_SIZE,
  REVIEW_PAGE_SIZE,
  REVIEW_MODERATION_ACTION_LABELS,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  canApplyReviewModeration,
  isReviewStatus,
  reviewDimensionOwnerId,
} from "@/lib/constants/reviews";
import type { ReviewModerationAction } from "@/lib/constants/reviews";
import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import type { AdminReviewListQuery } from "@/lib/data/reviewRepository";
import type { AdminUserSummary } from "@/lib/types/user";
import type {
  AdminReviewAllowedActions,
  AdminReviewListItem,
  AdminReviewWriteResult,
  OrderReview,
  ReviewStatus,
} from "@/lib/types/review";

/**
 * 管理端评价审核的**规则层**（P1-8）：列表筛选、关键词、DTO 与可执行动作。
 *
 * ⚠️ 本文件只有纯函数与常量，没有运行时依赖，因此前后台与测试可以用同一份实现。
 *
 * ## 状态机不在这里重写
 *
 * 四个动作可不可用**完全由** `canTransitionReviewStatus()` 决定（它在
 * `lib/constants/reviews.ts`，与写入侧的伪事务用的是同一个函数）。
 * 本文件只是把它的答案翻译成界面用的四个布尔值——
 * 因此不可能出现「按钮亮着但点下去被拒」或者「按钮灰着但其实可以做」。
 *
 * ⚠️ 这四个布尔值**只是提示**：真正的拦截在服务端（`D21`：权限必须在服务端强制，
 * 不能只靠隐藏按钮）。前端拿着 `canApprove: true` 直接构造请求去改一条不该改的评价，
 * 一样会收到 400。
 */

/** 评价不存在（或不属于任何可审核对象）。与其它后台列表同一口径：对外不区分。 */
export const ADMIN_REVIEW_NOT_FOUND_MESSAGE = "评价不存在";

/** 同一个幂等键被用在了另一个动作上。 */
export const ADMIN_REVIEW_OPERATION_CONFLICT_MESSAGE = "该幂等键已用于另一个操作";

/**
 * 状态筛选取值非法。
 *
 * ⚠️ 与分页参数的区别是刻意的：页码写错回到第 1 页，而状态写错**必须报错**——
 * 它是明确的业务条件，静默回退到「全部」会让调用方以为自己在看一个筛选后的结果。
 */
export const ADMIN_REVIEW_STATUS_INVALID_MESSAGE = "评价状态筛选无效";

/** 列表页顶部的审核口径说明。前后台共用一份文案，不各写一遍。 */
export const ADMIN_REVIEW_LIST_NOTICE =
  "评价提交后为「审核中」，只有「已通过」的评价会展示在商品页与打手页并计入评分。";

/**
 * 状态筛选：`all` 表示不限。**默认只看 `pending`**（待审核是这个页面的主用途），
 * 但默认值不在这里给——`buildAdminReviewListQuery` 的调用方决定，
 * 页面与接口的默认值因此可以不同。
 */
export type AdminReviewStatusFilter = ReviewStatus | "all";

/** 解析状态筛选；非法值返回 `null`（由调用方决定报错还是回退）。 */
export function readAdminReviewStatusFilter(raw: string | null): AdminReviewStatusFilter | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw === "all") return "all";
  return isReviewStatus(raw) ? raw : null;
}

/** 组装管理端列表查询条件。筛选与分页都在仓储里完成，服务层不二次过滤。 */
export function buildAdminReviewListQuery(input: {
  params: URLSearchParams;
  status: AdminReviewStatusFilter;
}): AdminReviewListQuery {
  const keyword = input.params.get("keyword");

  return {
    status: input.status,
    keyword: typeof keyword === "string" ? keyword.trim() : "",
    page: clampPage(input.params.get("page"), REVIEW_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), REVIEW_PAGE_SIZE, REVIEW_MAX_PAGE_SIZE),
  };
}

/**
 * 关键词命中：订单号 / 评价 id / 商品名 / 规格名 / 打手名。
 *
 * ⚠️ **不按作者昵称匹配**：作者昵称可能重名，而订单号与 id 唯一。
 * 管理员手上通常拿着用户截图里的订单号来找一条评价，这条路径必须命中；
 * 而「找某某人写的评价」用昵称筛出来的结果他无法确认对不对。
 * 与其它后台列表一样：**大小写不敏感**（订单号里有字母）。
 */
export function matchesAdminReviewKeyword(review: OrderReview, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    review.orderNo,
    review.id,
    review.productTitle,
    review.specName,
    review.companion?.name ?? "",
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

/** 一个状态各有多少条。**必须传全部待审记录**（不受分页影响），否则角标会随翻页变化。 */
export function countAdminReviewStates(
  reviews: readonly OrderReview[],
): Record<ReviewStatus, number> {
  const counts = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0])) as Record<
    ReviewStatus,
    number
  >;

  for (const review of reviews) counts[review.status] += 1;
  return counts;
}

/**
 * 服务端判定的四个审核动作。
 *
 * **唯一的判据是** `canApplyReviewModeration()`——管理端事务写下去之前用的是同一个函数。
 * 这里刻意不写 `status === "pending"` 这类判断：那等于把状态机在界面这一侧再抄一遍，
 * 抄漏的那一条会表现为「某个动作永远点不了」，而它在数据层其实是合法的；
 * 反过来抄宽了，就会出现「按钮亮着、点下去被拒」。
 */
export function toAdminReviewAllowedActions(status: ReviewStatus): AdminReviewAllowedActions {
  return {
    canApprove: canApplyReviewModeration(status, "approve"),
    canReject: canApplyReviewModeration(status, "reject"),
    canHide: canApplyReviewModeration(status, "hide"),
    canUnhide: canApplyReviewModeration(status, "unhide"),
  };
}

/**
 * 仓储实体 → 管理端列表项。
 *
 * ⚠️ **两个维度都带上**（`D2`）：只给一个维度会让管理员看不见用户实际写的另一半，
 * 而「该不该公开」恰恰要看全部内容。
 *
 * ⚠️ `user` 是完整的管理侧作者摘要（与订单 / 退款 / 投诉三张后台列表同一套），
 * **不是**公开面的脱敏昵称——`D13` 管的是公开面，理由见 `AdminReviewListItem` 的注释。
 */
export function toAdminReviewListItem(
  review: OrderReview,
  user: AdminUserSummary,
): AdminReviewListItem {
  return {
    id: review.id,
    orderId: review.orderId,
    orderNo: review.orderNo,
    user,

    productId: review.productId,
    productTitle: review.productTitle,
    productCoverUrl: review.productCoverUrl,
    specName: review.specName,
    quantity: review.quantity,
    companion: review.companion,
    completedAt: review.completedAt,

    productReview: review.productReview,
    companionReview: review.companionReview,
    evidence: review.evidence,

    status: review.status,
    statusLabel: REVIEW_STATUS_LABELS[review.status],
    rejectReason: review.rejectReason,
    hideReason: review.hideReason,

    reviewedBy: review.reviewedBy,
    reviewedByName: review.reviewedByName,
    reviewedAt: review.reviewedAt,

    createdAt: review.createdAt,
    updatedAt: review.updatedAt,

    allowedActions: toAdminReviewAllowedActions(review.status),
  };
}

/**
 * 审核写入结果 → 接口返回。
 *
 * 只回状态字段：界面据此就地更新那一行，不需要为了刷新一条评价重新拉一整页。
 * `changed` 区分「真的改了」与「本来就是目标状态 / 重放」——
 * 两者都是成功，但界面上的提示不同。
 */
export function toAdminReviewWriteResult(
  reviewId: string,
  status: ReviewStatus,
  changed: boolean,
): AdminReviewWriteResult {
  return {
    reviewId,
    status,
    statusLabel: REVIEW_STATUS_LABELS[status],
    changed,
  };
}

/**
 * 「当前状态不允许这个动作」的提示。
 *
 * ⚠️ 必须带上**当前状态的中文说法**，而且要给**下一步**：只说「操作失败」会让管理员
 * 以为是自己点错了，于是反复重试同一个动作。告诉他一「这条现在是『已通过』」不够，
 * 还要告诉他该去点「隐藏」。
 *
 * ⚠️ 三条路会走到这里，文案刻意分开——它们的原因完全不同，
 * 补救动作也不同，合成一句话就等于让管理员自己去猜：
 *
 * 1. 从 `approved` 点「驳回」：**不是**权限问题，而是正确动作叫「隐藏」
 *    （`R2`：把一条已公开的评价「驳回」等于让它凭空消失）。
 * 2. 从 `rejected` 点任何审核动作：驳回后只能由**用户**重新提交回到待审核（`D9`），
 *    管理员在这里做不了任何事，只能等。
 * 3. 其余（例如从 `pending` 点「隐藏」）：状态不对，说清楚当前状态即可。
 */
export function adminReviewInvalidTransitionMessage(
  current: ReviewStatus,
  action: ReviewModerationAction,
): string {
  const currentLabel = REVIEW_STATUS_LABELS[current];

  if (current === "approved" && action === "reject") {
    return `该评价当前为「${currentLabel}」，已公开的评价不能驳回，请改用「隐藏」`;
  }
  if (current === "rejected") {
    return `该评价当前为「${currentLabel}」，需等待用户重新提交后才能审核`;
  }
  return `该评价当前为「${currentLabel}」，无法执行「${REVIEW_MODERATION_ACTION_LABELS[action]}」`;
}

/**
 * `reviewDimensionOwnerId` 的再导出：管理端要按维度显示「这条评价计入谁」时用它。
 *
 * 直接把 `lib/constants/reviews.ts` 里那个函数暴露出去，而不是在管理端重写一遍
 * 「商品维度看 productId、打手维度看 companion.id」——两边各写一份，
 * 迟早会出现「用户侧算进去了、后台显示的却不是同一个对象」。
 */
export { reviewDimensionOwnerId };
