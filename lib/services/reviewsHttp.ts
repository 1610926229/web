import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { REVIEW_PAGE_SIZE } from "@/lib/constants/reviews";
import type { ReviewRange } from "@/lib/types/review";
import type {
  PendingReviewPage,
  ReviewCreateResult,
  ReviewedReviewPage,
} from "@/lib/types/review";

/**
 * 评价的**浏览器端**取数（切 Tab / 换时间筛选 / 加载更多 / 提交）。
 *
 * 与服务端模块 `lib/services/reviews.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 列表首屏由 Server Component 直接取数，不经过本文件。
 */

export type ReviewListRequest = {
  range: ReviewRange;
  page?: number;
  pageSize?: number;
};

/** 已评价记录。 */
export function fetchReviewedReviews(input: ReviewListRequest): Promise<ReviewedReviewPage> {
  return fetchReviewPage<ReviewedReviewPage>("reviewed", input);
}

/** 待评价订单。 */
export function fetchPendingReviews(input: ReviewListRequest): Promise<PendingReviewPage> {
  return fetchReviewPage<PendingReviewPage>("pending", input);
}

function fetchReviewPage<T>(tab: "reviewed" | "pending", input: ReviewListRequest): Promise<T> {
  const params = new URLSearchParams();
  params.set("tab", tab);
  params.set("range", input.range);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? REVIEW_PAGE_SIZE));

  return apiGet<T>(`/api/reviews?${params.toString()}`);
}

/** 提交评价时提交给服务端的字段。`orderId` 走路径，其余都是用户填写的内容。 */
export type ReviewSubmitInput = {
  rating: number;
  content: string;
  evidence: EvidenceDraft[];
  idempotencyKey: string;
};

/**
 * 提交评价。
 *
 * 请求体里**只有**评分、正文、凭证与幂等键：`userId` / `orderId` / 订单状态 /
 * 打手信息 / 评价时间都由服务端写，客户端塞什么都不算。
 * 重复提交不会报错，返回第一次的结果（`created: false`）。
 */
export function submitReview(
  orderId: string,
  input: ReviewSubmitInput,
): Promise<ReviewCreateResult> {
  return apiPost<ReviewCreateResult>(`/api/orders/${encodeURIComponent(orderId)}/reviews`, {
    rating: input.rating,
    content: input.content,
    evidence: input.evidence,
    idempotencyKey: input.idempotencyKey,
  });
}
