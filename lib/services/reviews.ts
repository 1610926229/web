import { ApiError } from "@/lib/api/ApiError";
import {
  parseEvidenceInput,
  toStoredEvidence,
  type EvidenceDraft,
} from "@/lib/constants/evidence";
import {
  REVIEW_EVIDENCE_KINDS,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_ORDER_NOT_FOUND_MESSAGE,
  REVIEW_RATING_REQUIRED_MESSAGE,
  canReviewOrder,
  comparePendingNewestFirst,
  isPendingReview,
  isReviewRating,
  isWithinReviewRange,
  normalizeReviewContent,
  parseReviewListQuery,
  toReviewListItem,
  toReviewPendingItem,
} from "@/lib/constants/reviews";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getReviewRepository } from "@/lib/data/reviewRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type { RefundStatus } from "@/lib/types/refund";
import type {
  OrderReview,
  ReviewCreateResult,
  ReviewListPage,
  ReviewPendingItem,
  ReviewRating,
  ReviewSummary,
  ReviewTabCounts,
  ReviewTarget,
} from "@/lib/types/review";

/**
 * 评价服务 —— 评价列表、评价表单与评价接口共用的唯一入口。
 *
 * 五条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只处理当前用户的数据**。所有函数都要求传入会话里读到的 `userId`，
 *    仓储把它当成查询条件；接口不接受任何「查谁的订单 / 评价」参数。
 * 2. **能不能评价由服务端判定**（`canReviewOrder`）。列表里的每个待评价订单都带上
 *    `allowedActions`，表单页也按同一份判定显示或拦住——前端不拿订单状态自己推断，
 *    因为「能不能评价」还取决于这一单有没有评价、有没有退款。
 * 3. **一单一评，重复提交不报错但不会产生第二条**。业务唯一键是「用户 + 订单」，
 *    幂等键是通用兜底；命中时返回第一次的结果（`created: false`）。
 * 4. **身份与状态字段一律由服务端写**。请求体只按白名单取「评分 / 正文 / 凭证」，
 *    客户端塞进来的 `userId` / `orderStatus` / `companionId` / 评价时间都不会被读取。
 * 5. **评价不改变订单**。这里不写任何订单字段、不碰金额，也不参与消费等级计算。
 *
 * 时间筛选依赖当前时间，因此 `queryReviewsForUser` 把 `now` 作为可注入的参数
 * （默认取当前时间）：测试必须能把时间钉死，否则用例会在某一天突然变红。
 */

/** 待评价订单的取数：取该用户**全部**已完成订单，再逐条排除已评价的。 */
async function loadPendingOrders(userId: string): Promise<Order[]> {
  const repository = getPaymentRepository();
  const reviewRepository = getReviewRepository();

  // Mock 阶段数据量很小，这里一次取全再过滤；将来换成数据库时，
  // 这一步是一条 `LEFT JOIN review ... WHERE review.id IS NULL` 的分页查询。
  // 关键是**不能**先按页取订单再过滤：某一页可能整页都被过滤掉，列表会凭空变短。
  const completed = await repository.queryOrders({
    userId,
    status: "completed",
    keyword: "",
    page: 1,
    pageSize: Number.MAX_SAFE_INTEGER,
  });

  const pending: Order[] = [];
  for (const order of completed.items) {
    if (await reviewRepository.findReviewByOrderId(userId, order.id)) continue;
    if (!isPendingReview(order, false)) continue;
    pending.push(order);
  }

  return pending.sort(comparePendingNewestFirst);
}

/** 待评价订单的时间筛选口径：按**订单完成时间**（与列表上显示的时间一致）。 */
function pendingAnchor(order: Order): string {
  return order.completedAt ?? order.paidAt;
}

/** 两个 Tab 的数量：已评价 = 评价总数；待评价 = 未评价的已完成订单数（都不受时间筛选影响）。 */
async function loadCounts(userId: string): Promise<ReviewTabCounts> {
  return {
    reviewed: await getReviewRepository().countReviews(userId),
    pending: (await loadPendingOrders(userId)).length,
  };
}

/**
 * 查询评价列表（已评价 / 待评价）。
 *
 * Tab 与时间筛选取值非法抛 `BAD_REQUEST`：这是**明确的业务条件写错了**，
 * 静默回退会让调用方以为自己在看另一份数据。分页参数的非法值走规范化，区别是刻意的。
 *
 * 两个 Tab 都返回 `counts`：角标与列表来自同一份数据，前端不自己累加，
 * 提交一条评价后角标也不会与列表漂移。
 */
export async function queryReviewsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<ReviewListPage> {
  const parsed = parseReviewListQuery(params);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  const { tab, range, page, pageSize } = parsed.query;

  if (tab === "reviewed") {
    const result = await withMockDebug(params, surface, () =>
      getReviewRepository().queryReviews({ userId, range, page, pageSize, now }),
    );

    return {
      ...result,
      // 转换只在这里发生：仓储实体（含 userId）不会直接出现在接口响应里
      items: result.items.map(toReviewListItem),
      tab: "reviewed",
      counts: await withMockDebug(params, surface, () => loadCounts(userId)),
    };
  }

  const pending = await withMockDebug(params, surface, () => loadPendingOrders(userId));
  const filtered = pending.filter((order) => isWithinReviewRange(pendingAnchor(order), range, now));

  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  const items: ReviewPendingItem[] = [];
  for (const order of slice) {
    items.push(toReviewPendingItem(order, await buildPendingActions(userId, order)));
  }

  return {
    items,
    page,
    pageSize,
    total: filtered.length,
    hasMore: start + items.length < filtered.length,
    tab: "pending",
    counts: await withMockDebug(params, surface, () => loadCounts(userId)),
  };
}

/**
 * 待评价订单的可执行动作：这一单有没有评价 + 有没有退款。
 *
 * 列表里的订单都是「还没评价」的，但**判定仍然照常走一遍**：入口显不显示由这个结果决定，
 * 而不是由「它出现在这个列表里」这件事决定——将来放开过滤条件时不会出现两套口径。
 */
async function buildPendingActions(userId: string, order: Order) {
  const refund = await getRefundRepository().findRefundByOrderId(order.id);
  return canReviewOrder(order.status, {
    hasReview: (await getReviewRepository().findReviewByOrderId(userId, order.id)) !== null,
    refundStatus: refund?.status ?? null,
  });
}

// ——————————————————————————— 评价表单 ———————————————————————————

/**
 * 读取「给这一单写评价」需要的全部信息。
 *
 * 页面据此决定显示表单还是说明，四种结果**互斥且完整**：
 * 订单不存在（或不属于你）、已经评价过、当前不可评价（带原因）、可以评价。
 *
 * 判定与列表共用同一套规则（`canReviewOrder`），因此不会出现「列表里有入口、
 * 点进来却说不能评」这种前后不一致。
 */
export async function getReviewTargetForUser(
  orderId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<ReviewTarget> {
  if (!orderId) return { status: "missing" };

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  // 不存在与不属于当前用户对外表现完全相同：页面给出同一个「订单不存在」
  if (!order || order.userId !== userId) return { status: "missing" };

  const review = await getReviewRepository().findReviewByOrderId(userId, order.id);
  if (review) return { status: "reviewed", review: toReviewListItem(review) };

  const refund = await getRefundRepository().findRefundByOrderId(order.id);
  const actions = canReviewOrder(order.status, {
    hasReview: false,
    refundStatus: refund?.status ?? null,
  });
  if (!actions.canReview) {
    return { status: "blocked", reason: actions.reason, orderStatus: order.status };
  }

  return { status: "ready", order: toReviewPendingItem(order, actions) };
}

// ——————————————————————————— 与订单详情的衔接 ———————————————————————————

/** 评价 → 订单详情里的摘要。**显式挑字段**：正文与凭证都不进摘要。 */
export function toReviewSummary(review: OrderReview): ReviewSummary {
  return {
    id: review.id,
    rating: review.rating,
    createdAt: review.createdAt,
  };
}

/**
 * 订单详情里的「能不能评价」。
 *
 * 与退款一样，这个判断需要订单之外的数据（有没有评价、有没有退款），
 * 因此统一由本模块给出，订单服务只负责把它拼进 `allowedActions`。
 */
export function buildReviewActions(
  order: Order,
  review: OrderReview | null,
  refund: { status: RefundStatus } | null,
): { canReview: boolean } {
  return {
    canReview: canReviewOrder(order.status, {
      hasReview: review !== null,
      refundStatus: refund?.status ?? null,
    }).canReview,
  };
}

// ——————————————————————————— 提交 ———————————————————————————

type ReviewInput = {
  rating: ReviewRating;
  content: string;
  evidence: EvidenceDraft[];
};

/**
 * 按**白名单**解析评价表单。
 *
 * 只有评分、正文、凭证三类字段会被读取——`userId` / `orderId` / `orderStatus` /
 * `companionId` / `createdAt` 即便塞进请求体也会被直接丢弃。这不是「检查一下状态对不对」，
 * 而是根本不存在接收这些字段的位置。
 */
export function parseReviewInput(body: Record<string, unknown>): ReviewInput {
  const rawRating = typeof body.rating === "number" ? body.rating : Number(body.rating);
  if (!isReviewRating(rawRating)) throw new ApiError("BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);

  const content = normalizeReviewContent(readTrimmedString(body, "content"));
  if (!content.ok) throw new ApiError("BAD_REQUEST", content.message);

  const evidence = parseEvidenceInput(
    body.evidence,
    REVIEW_EVIDENCE_MAX_COUNT,
    REVIEW_EVIDENCE_KINDS,
  );
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  return { rating: rawRating, content: content.content, evidence: evidence.items };
}

/**
 * 提交评价。
 *
 * 顺序刻意如此：
 *
 * 1. 幂等键格式不对直接拒绝——没有键就无法防重，宁可不做；
 * 2. **快速路径**：这个键提交过就返回上一次的结果，连校验都不重来
 *    （重试要的是「和上次一样的结果」，而不是按现在的状态重新算一遍）；
 * 3. 订单不存在 / 不属于当前用户 → 404（对外与「不存在」无差别）；
 * 4. 已经评价过 → **不是错误**，返回第一次的结果（`created: false`）：
 *    重复点击、刷新后重发、并发提交都不会产生第二条；
 * 5. 业务校验：只有已完成、且没有进行中/已通过退款的订单可以评价；
 * 6. 写入评价：订单号、商品、打手、完成时间都从订单**抄一份快照**，
 *    评价时间与 id 由服务端生成。**不修改订单**。
 */
export async function createReviewForOrder(
  orderId: string,
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<ReviewCreateResult> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getReviewRepository();

  const byKey = await repository.findReviewByKey(userId, idempotencyKey);
  if (byKey) return { reviewId: byKey.id, orderId: byKey.orderId, created: false };

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) {
    throw new ApiError("NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
  }

  const existing = await repository.findReviewByOrderId(userId, order.id);
  if (existing) return { reviewId: existing.id, orderId: order.id, created: false };

  const refund = await getRefundRepository().findRefundByOrderId(order.id);
  const actions = canReviewOrder(order.status, {
    hasReview: false,
    refundStatus: refund?.status ?? null,
  });
  if (!actions.canReview) {
    // 不能评价的原因直接告诉调用方（未完成 / 退款中 / 已退款），而不是一句笼统的「不可评价」。
    // 四条判定分支各自带了理由文案，因此这里不会出现空字符串。
    throw new ApiError("BAD_REQUEST", actions.reason);
  }

  const input = parseReviewInput(body);

  const outcome = await repository.createReview(
    {
      id: `rev_${crypto.randomUUID()}`,
      userId,
      orderId: order.id,
      orderNo: order.orderNo,

      rating: input.rating,
      content: input.content,
      // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
      evidence: toStoredEvidence(input.evidence),
      // 评价时间由服务端写，客户端说什么都不算
      createdAt: now.toISOString(),

      productTitle: order.productTitle,
      productCoverUrl: order.productCoverUrl,
      specName: order.specName,
      quantity: order.quantity,
      completedAt: order.completedAt ?? order.paidAt,
      companion: order.companion,
    },
    idempotencyKey,
  );

  if (!outcome.ok) {
    // 走到这里说明上面查过之后、写入之前有另一个请求先进来了（并发提交）。
    // 仓储的原子区段挡住了第二条记录，这里把结果翻译成「和上一次一样的结果」。
    return { reviewId: outcome.existing.id, orderId: order.id, created: false };
  }

  return { reviewId: outcome.review.id, orderId: order.id, created: outcome.created };
}
