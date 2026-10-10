import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { REVIEW_PAGE_SIZE } from "@/lib/constants/reviews";
import type { ReviewDimension, ReviewRange } from "@/lib/types/review";
import type {
  PendingReviewPage,
  ReviewCreateResult,
  ReviewedReviewPage,
} from "@/lib/types/review";

/**
 * 评价的**浏览器端**取数（切 Tab / 换时间筛选 / 加载更多 / 提交 / 重新提交）。
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

/**
 * 一次评价提交的内容（`D1` / `D2` / `D3`）。
 *
 * ⚠️ **两个维度各自独立**，任意一个可以为 `null`（表示这一项没评），
 * 但**不能同时为 `null`**——「至少评一项」由服务端判定，界面只是提前拦一道。
 *
 * ⚠️ 这里**没有** `orderId` / `userId` / `status` / 时间的字段，它们是服务端的事；
 * 也没有「商品星级 / 打手星级」以外的含义：两个维度用的是同一个形状，
 * 因为它们在数据模型里是对称的。
 */
export type ReviewSubmitInput = {
  /** 商品维度；没评商品时传 `null` */
  productReview: ReviewDimension | null;
  /** 打手维度；没评打手、或这一单没有实际履约打手时传 `null` */
  companionReview: ReviewDimension | null;
  evidence: EvidenceDraft[];
  idempotencyKey: string;
};

/**
 * 提交评价（新建）。
 *
 * 请求体里**只有**两个维度、凭证与幂等键：`userId` / `orderId` / 订单状态 /
 * 打手信息 / 评价时间 / `status` 都由服务端写，客户端塞什么都不算。
 * 重复提交不会报错，返回第一次的结果（`created: false`）。
 *
 * ⚠️ 新提交的评价一律是 `pending`（审核中）：提交后不是立即公开。
 */
export function submitReview(
  orderId: string,
  input: ReviewSubmitInput,
): Promise<ReviewCreateResult> {
  return apiPost<ReviewCreateResult>(`/api/orders/${encodeURIComponent(orderId)}/reviews`, {
    productReview: input.productReview,
    companionReview: input.companionReview,
    evidence: input.evidence,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * 重新提交被驳回的评价（`D9`）。
 *
 * ⚠️ 落点是**评价**而不是订单：这条评价已经存在，重提是让同一条记录从
 * `rejected` 回到 `pending`（id 与首次提交时间都不变，`R2`）。
 * 用订单 id 调用会变成「新建」，而那一单已经有一条评价，服务端会把它当成重复提交
 * 直接返回那条旧的——用户会以为自己的修改提交成功了，其实一个字都没变。
 *
 * 内容按同一套规则校验（至少一个维度、星级必填、正文可选）：
 * 重提**没有**「可以少填一点」的例外。
 *
 * ⚠️ **不带幂等键**，这不是漏了：重提的守卫就是状态本身——`rejected` 是唯一的入口，
 * 而它第一次成功后就关上了。重复提交会收到 400「该评价当前不可重新提交」，
 * 那句话**是准确的**（这条评价确实已经不在可重提状态了），而不是一个需要靠重放
 * 机制去掩盖的假错误。给它加幂等键反而要引入一张「这次重提对应哪次操作」的表，
 * 而那张表在「被再次驳回后又重提」时会给出错的答案。
 */
export function resubmitReview(
  reviewId: string,
  input: Omit<ReviewSubmitInput, "idempotencyKey">,
): Promise<ReviewCreateResult> {
  return apiPost<ReviewCreateResult>(`/api/reviews/${encodeURIComponent(reviewId)}/resubmit`, {
    productReview: input.productReview,
    companionReview: input.companionReview,
    evidence: input.evidence,
  });
}
