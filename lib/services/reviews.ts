import { ApiError } from "@/lib/api/ApiError";
import {
  parseEvidenceInput,
  toStoredEvidence,
  type EvidenceDraft,
} from "@/lib/constants/evidence";
import {
  REVIEW_DIMENSION_MISSING_MESSAGE,
  REVIEW_EVIDENCE_KINDS,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_OPERATION_CONFLICT_MESSAGE,
  REVIEW_ORDER_NOT_FOUND_MESSAGE,
  REVIEW_RATING_REQUIRED_MESSAGE,
  REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  REVIEW_STATUS_LABELS,
  canReviewOrder,
  canTransitionReviewStatus,
  comparePendingNewestFirst,
  isPendingReview,
  isReviewRating,
  isWithinReviewRange,
  normalizeReviewContent,
  parseReviewListQuery,
  toReviewListItem,
  toReviewPendingItem,
} from "@/lib/constants/reviews";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getReviewRepository } from "@/lib/data/reviewRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  OrderReview,
  ReviewCreateResult,
  ReviewDimension,
  ReviewListPage,
  ReviewPendingItem,
  ReviewSummary,
  ReviewTabCounts,
  ReviewTarget,
} from "@/lib/types/review";

/**
 * 评价服务 —— 评价列表、评价表单与评价接口共用的唯一入口（用户侧）。
 *
 * 六条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只处理当前用户的数据**。所有函数都要求传入会话里读到的 `userId`，
 *    仓储把它当成查询条件；接口不接受任何「查谁的订单 / 评价」参数。
 * 2. **能不能评价由服务端判定**（`canReviewOrder`），且判据是 `completedAt`（`D19`）。
 *    列表里的每个待评价订单都带上 `allowedActions`，表单页也按同一份判定显示或拦住——
 *    前端不拿订单状态自己推断，因为「能不能评价」与「订单现在什么状态」会分叉：
 *    全额退款的订单状态是 `refunded`，但它**照样可以评价**。
 * 3. **一单一评，重复提交不报错但不会产生第二条**。业务唯一键是「用户 + 订单」，
 *    幂等键是通用兜底；命中时返回第一次的结果（`created: false`）。
 * 4. **被驳回的评价走重新提交，不新建第二条**（`D9`）：同一条记录从 `rejected`
 *    回到 `pending`，id 与 `createdAt` 都不变（`R2`：状态变化不通过删除历史完成）。
 * 5. **身份与状态字段一律由服务端写**。请求体只按白名单取「两个维度 / 凭证」，
 *    客户端塞进来的 `userId` / `orderStatus` / `companionId` / `status` / 评价时间都不会被读取。
 * 6. **评价不改变订单**。这里不写任何订单字段、不碰金额，也不参与消费等级计算。
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
  //
  // ⚠️ 这里**不按 `status: "completed"` 过滤**（`D19`）：一条已完成的订单后来全额退款，
  // 状态会变成 `refunded`，但它**仍然可以评价**。用状态筛会把这类订单漏掉，
  // 而漏掉的表现是「列表里没有这一单」，用户只会以为评价入口没了。
  // 真正的判据 `isPendingReview` 只看 `completedAt`，它在这里逐条执行。
  const orders = await repository.listOrdersByUser(userId);

  const pending: Order[] = [];
  for (const order of orders) {
    if (!isPendingReview(order, false)) continue;
    if (await reviewRepository.findReviewByOrderId(userId, order.id)) continue;
    pending.push(order);
  }

  return pending.sort(comparePendingNewestFirst);
}

/** 待评价订单的时间筛选口径：按**订单完成时间**（与列表上显示的时间一致）。 */
function pendingAnchor(order: Order): string {
  return order.completedAt ?? order.paidAt;
}

/** 两个 Tab 的数量：已评价 = 评价总数（含全部状态，`D8`）；待评价 = 未评价的已完成订单数。 */
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
 * 待评价订单的可执行动作。
 *
 * 列表里的订单都是「还没评价」的，但**判定仍然照常走一遍**：入口显不显示由这个结果决定，
 * 而不是由「它出现在这个列表里」这件事决定——将来放开过滤条件时不会出现两套口径。
 */
async function buildPendingActions(userId: string, order: Order) {
  return canReviewOrder(order, {
    hasReview: (await getReviewRepository().findReviewByOrderId(userId, order.id)) !== null,
  });
}

// ——————————————————————————— 评价表单 ———————————————————————————

/**
 * 读取「给这一单写评价」需要的全部信息。
 *
 * 页面据此决定显示表单还是说明，五种结果**互斥且完整**：
 * 订单不存在（或不属于你）、可以评价、已经评价过、**被驳回可以重提**、当前不可评价（带原因）。
 *
 * `rejected` 单独一态（`D9`）：它是唯一允许用户回到表单的状态，页面据此预填上次的内容
 * 并把按钮改成「重新提交」。
 *
 * 判定与列表共用同一套规则（`canReviewOrder` / `isPendingReview`），
 * 因此不会出现「列表里有入口、点进来却说不能评」这种前后不一致。
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
  if (review) {
    const dto = toReviewListItem(review);
    // 被驳回与被通过/隐藏是**两种页面**：前者回到表单，后者只读展示
    return review.status === "rejected"
      ? { status: "rejected", review: dto }
      : { status: "reviewed", review: dto };
  }

  const actions = canReviewOrder(order, { hasReview: false });
  if (!actions.canReview) {
    return { status: "blocked", reason: actions.reason, orderStatus: order.status };
  }

  return { status: "ready", order: toReviewPendingItem(order, actions) };
}

// ——————————————————————————— 与订单详情的衔接 ———————————————————————————

/**
 * 评价 → 订单详情里的摘要。
 *
 * ⚠️ **不带星级**：一条评价最多有两个星级（商品 / 打手），在订单详情上挑一个显示，
 * 等于替用户决定「哪个星级代表这次消费」。订单详情只需要回答「评价这件事走到哪一步了」。
 */
export function toReviewSummary(review: OrderReview): ReviewSummary {
  return {
    id: review.id,
    status: review.status,
    statusLabel: reviewStatusLabelOf(review),
    createdAt: review.createdAt,
    canResubmit: review.status === "rejected",
  };
}

/** 状态文案由常量表提供；这里绕一层只是为了让 `toReviewSummary` 不必再引一个常量。 */
function reviewStatusLabelOf(review: OrderReview): string {
  return REVIEW_STATUS_LABELS[review.status];
}

/**
 * 订单详情里的「能不能评价」。
 *
 * 与退款一样，这个判断需要订单之外的数据（有没有评价），因此统一由本模块给出，
 * 订单服务只负责把它拼进 `allowedActions`。
 *
 * ⚠️ 签名里**没有退款参数**（`D18` / `D19`）：退款不影响评价资格，因此调用方
 * 不必再为这件事查一次退款仓储——少一个参数，就少一处将来被重新加回去的地方。
 */
export function buildReviewActions(order: Order, review: OrderReview | null): { canReview: boolean } {
  return { canReview: canReviewOrder(order, { hasReview: review !== null }).canReview };
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 解析后的评价输入。
 *
 * ⚠️ **两个维度都是可空的**（`D3`：不强迫两维度都评），但**不能同时为空**
 * ——那个校验在 `parseReviewInput` 里，因为它是「这一整份输入」的性质，
 * 不是任何一个维度的性质。
 */
export type ReviewInput = {
  productReview: ReviewDimension | null;
  companionReview: ReviewDimension | null;
  evidence: EvidenceDraft[];
};

/**
 * 解析**一个**评价维度。
 *
 * 三条规则（`D2` / `D3`）：
 *
 * - `null` / 缺省 ⇒ 这个维度没评，返回 `{ present: false }`；
 * - 给了对象就**必须**有合法星级——星级是这个维度存在的标志，「只打了字没给星」
 *   不构成一个维度（否则聚合时它没有可计入的分）；
 * - 正文可选：空串与缺省都收敛成 `null`，有内容才校验长度。
 *
 * ⚠️ 传了对象但 `rating` 非法时**直接报错**，而不是当成「这个维度没评」：
 * 后者会把一个前端 bug（比如把 `rating` 写成了字符串）静默变成「用户只评了另一个维度」，
 * 用户看到的是一条少了一半的评价，而没有任何地方报错。
 */
function parseDimension(
  raw: unknown,
  label: string,
): { present: false } | { present: true; dimension: ReviewDimension } {
  if (raw === null || raw === undefined) return { present: false };
  if (typeof raw !== "object") {
    throw new ApiError("BAD_REQUEST", `${label}评价格式不正确`);
  }

  const body = raw as Record<string, unknown>;
  const rating = typeof body.rating === "number" ? body.rating : Number(body.rating);
  if (!isReviewRating(rating)) throw new ApiError("BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);

  const content = normalizeReviewContent(typeof body.content === "string" ? body.content : "");
  if (!content.ok) throw new ApiError("BAD_REQUEST", content.message);

  return { present: true, dimension: { rating, content: content.content } };
}

/**
 * 按**白名单**解析评价表单。
 *
 * 只有两个维度与凭证三类字段会被读取——`userId` / `orderId` / `orderStatus` /
 * `companionId` / `status` / `createdAt` 即便塞进请求体也会被直接丢弃。
 * 这不是「检查一下状态对不对」，而是根本不存在接收这些字段的位置。
 *
 * ⚠️ `status` 尤其重要：管理员才改状态（`D12`），用户提交的评价**永远是** `pending`
 * ——提交后必须经过审核才公开。让请求体能带 `status` 就等于让用户自己把自己审过。
 */
export function parseReviewInput(body: Record<string, unknown>): ReviewInput {
  const product = parseDimension(body.productReview, "商品");
  const companion = parseDimension(body.companionReview, "打手");

  // `D3`：至少一个维度有效。「两个都没评」不是一条空评价，而是一次无效提交，
  // 必须在写入前挡住——否则会留下一份什么都表达不了的记录，且它还会占用「一单一评」的名额。
  if (!product.present && !companion.present) {
    throw new ApiError("BAD_REQUEST", REVIEW_DIMENSION_MISSING_MESSAGE);
  }

  const evidence = parseEvidenceInput(
    body.evidence,
    REVIEW_EVIDENCE_MAX_COUNT,
    REVIEW_EVIDENCE_KINDS,
  );
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  return {
    productReview: product.present ? product.dimension : null,
    companionReview: companion.present ? companion.dimension : null,
    evidence: evidence.items,
  };
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
 *    ⚠️ 被驳回的那一条也走这里——它需要的是**重新提交**（另一个接口步骤），不是再提交一次；
 * 5. 业务校验：这一单的服务完成过（`completedAt`）才能评价；
 * 6. 写入评价：`productId` / `specId` / 订单号 / 商品 / 实际履约打手 / 完成时间
 *    都从订单**抄一份快照**，评价时间与 id 由服务端生成，状态固定为 `pending`。
 *    **不修改订单**。
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
  if (byKey) {
    // ⚠️ 重放必须**同一张订单**才算重放。同一个键换一张单是调用方复用了键（真 bug），
    // 不能安静地返回第一张单的评价——那样第二张单永远评不上，而且没有任何报错。
    // 与管理端 `takeReplayForAction`（比对 targetId）同口径。
    if (byKey.orderId !== orderId) {
      throw new ApiError("BAD_REQUEST", REVIEW_OPERATION_CONFLICT_MESSAGE, 400);
    }
    return { reviewId: byKey.id, orderId: byKey.orderId, created: false, status: byKey.status };
  }

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) {
    throw new ApiError("NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
  }

  const existing = await repository.findReviewByOrderId(userId, order.id);
  if (existing) {
    return { reviewId: existing.id, orderId: order.id, created: false, status: existing.status };
  }

  const actions = canReviewOrder(order, { hasReview: false });
  if (!actions.canReview) {
    // 不能评价的原因直接告诉调用方（服务还没完成），而不是一句笼统的「不可评价」
    throw new ApiError("BAD_REQUEST", actions.reason);
  }

  const input = parseReviewInput(body);

  const outcome = await repository.createReview(
    {
      id: `rev_${crypto.randomUUID()}`,
      userId,
      orderId: order.id,
      orderNo: order.orderNo,

      // 聚合身份（R4）：从订单抄，不从商品名反推
      productId: order.productId,
      specId: order.specId,

      productReview: input.productReview,
      companionReview: input.companionReview,
      // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
      evidence: toStoredEvidence(input.evidence),

      // 新提交的评价一律是待审核（D7）：提交后不是立即公开，必须经过管理员审核
      status: "pending",
      rejectReason: null,
      hideReason: null,
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,

      // 评价时间由服务端写，客户端说什么都不算
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),

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
    return {
      reviewId: outcome.existing.id,
      orderId: order.id,
      created: false,
      status: outcome.existing.status,
    };
  }

  return {
    reviewId: outcome.review.id,
    orderId: order.id,
    created: outcome.created,
    status: outcome.review.status,
  };
}

/**
 * **重新提交**被驳回的评价（`D9`）。
 *
 * 与 `createReviewForOrder` 是两条不同的路，刻意不合并：
 *
 * - 新建是「这一单还没评过」，落点是**订单**（`POST /api/orders/[id]/review`）；
 * - 重提是「这条评价被驳回了」，落点是**评价**（`POST /api/reviews/[id]/resubmit`）。
 *
 * 合成一个接口的话，调用方要传两个 id，而服务端必须先猜「用户到底想新建还是想重提」——
 * 那个猜测在「订单有评价但状态不是 rejected」时必然猜错，而猜错的后果是两个人都以为
 * 对方知道该怎么办。
 *
 * 三条校验，顺序即优先级：
 * 1. 评价不存在 / 不属于当前用户 → 404（对外与「不存在」无差别，避免被用来试探 id）；
 * 2. 状态不是 `rejected` → 400（`D9`：其余状态不可改）；
 * 3. 内容校验与新提交**完全共用**（`parseReviewInput`）：重提同样是「至少一个维度」，
 *    同样只收星级与正文。没有「重提可以少填一点」这种例外。
 *
 * ⚠️ **保持同一条记录**：id 与 `createdAt` 都不变（`R2`）。仓储那一层写死了这件事。
 */
export async function resubmitReviewForUser(
  reviewId: string,
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<ReviewCreateResult> {
  const repository = getReviewRepository();

  const review = await withMockDebug(params, surface, () => repository.findReviewById(reviewId));
  // 不属于当前用户的评价，对外表现与「不存在」相同
  if (!review || review.userId !== userId) {
    throw new ApiError("NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
  }
  // ⚠️ 判据读状态机而不是写死 `status === "rejected"`：这是**读侧的友好预检**，
  // 真正的闸门在仓储的原子区段里；两处必须同一个真值源，否则放宽状态机时
  // 会出现「仓储放行、服务层先一步拦掉」这种只在并发下才看得出来的错配。
  if (!canTransitionReviewStatus(review.status, "pending")) {
    throw new ApiError("BAD_REQUEST", REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE);
  }

  const input = parseReviewInput(body);

  const outcome = await repository.resubmitReview(reviewId, {
    productReview: input.productReview,
    companionReview: input.companionReview,
    evidence: toStoredEvidence(input.evidence),
    at: now.toISOString(),
  });

  if (!outcome.ok) {
    if (outcome.reason === "not_found") {
      // 查到了、写的时候没了：只有并发删除会造成，按不存在处理
      throw new ApiError("NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
    }
    // 上面刚查过是 rejected，写的时候已经不是了——另一位管理员在此期间把它通过/隐藏了。
    // 这不是用户的错，但也不能让他的修改覆盖掉管理员的裁定
    throw new ApiError("BAD_REQUEST", REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE);
  }

  return {
    reviewId: outcome.review.id,
    orderId: outcome.review.orderId,
    // 重提**真的写下了新内容**，因此是 true。它不是「新建」，但调用方要的语义是
    // 「这次调用有没有作出改动」——新建与重提在这一点上一致
    created: true,
    status: outcome.review.status,
  };
}
