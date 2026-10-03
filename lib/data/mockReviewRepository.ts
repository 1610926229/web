import { matchesAdminReviewKeyword } from "@/lib/constants/adminReviews";
import {
  canTransitionReviewStatus,
  compareReviewsNewestFirst,
  isWithinReviewRange,
  reviewDimensionOwnerId,
} from "@/lib/constants/reviews";
import { reviewSeed } from "@/lib/mocks/fixtures/reviewSeed";
import type { OrderReview, ReviewStatus } from "@/lib/types/review";
import { getMockStore } from "./mockStore";
import type {
  CreateReviewOutcome,
  ResubmitReviewOutcome,
  ReviewRepository,
  ReviewStatusPatch,
} from "./reviewRepository";

/**
 * 评价的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（「用户 + 订单」唯一索引 + 幂等键唯一索引
 * + 事务），本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置评价与用户新提交的评价因此进的是**同一个 Map、同一套查询方法**，
 * 「刚提交的评价立刻出现在列表里」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 *
 * ⚠️ 管理端的审核写入不在本文件，而在 `lib/data/adminReviewTransaction.ts`：
 * 那里的写入跨「评价 + 审计」两张表，需要自己的一段原子区段与幂等判定
 * （单表的 `createReview` / `resubmitReview` 则不需要）。本文件只向它暴露
 * `reviewStore()` 这一个句柄。
 */

type MockReviewStore = {
  reviews: Map<string, OrderReview>;
  /** `${userId}:${orderId}` → 评价 id（业务唯一键：一单一评） */
  reviewIdByOrder: Map<string, string>;
  /** `${userId}:${idempotencyKey}` → 评价 id（通用幂等索引） */
  reviewIdByKey: Map<string, string>;
};

function orderKey(userId: string, orderId: string): string {
  return `${userId}:${orderId}`;
}

function idempotencyKeyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

function createStore(): MockReviewStore {
  const reviews = new Map(reviewSeed.map((review) => [review.id, review]));
  const reviewIdByOrder = new Map<string, string>();

  for (const review of reviewSeed) {
    const key = orderKey(review.userId, review.orderId);
    // 预置数据同样要满足「一单一评」，重复的种子在这里就会暴露出来
    if (reviewIdByOrder.has(key)) {
      throw new Error(`预置评价数据重复关联同一订单：${review.orderId}`);
    }
    reviewIdByOrder.set(key, review.id);
  }

  return { reviews, reviewIdByOrder, reviewIdByKey: new Map() };
}

function store(): MockReviewStore {
  return getMockStore("review", createStore);
}

/**
 * 存储句柄 —— 供 `lib/data/adminReviewTransaction.ts` 在自己的原子区段里使用。
 *
 * ⚠️ **每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的对象会变成孤儿，写入看不见、读到的还是旧数据。
 */
export function reviewStore(): MockReviewStore {
  return store();
}

const EMPTY_STATUS_COUNTS: Record<ReviewStatus, number> = {
  pending: 0,
  approved: 0,
  rejected: 0,
  hidden: 0,
};

export const mockReviewRepository: ReviewRepository = {
  async queryReviews(query) {
    const { userId, range, page, pageSize, now } = query;

    const filtered = [...store().reviews.values()]
      .filter((review) => review.userId === userId)
      .filter((review) => isWithinReviewRange(review.createdAt, range, now))
      .sort(compareReviewsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async countReviews(userId) {
    return [...store().reviews.values()].filter((review) => review.userId === userId).length;
  },

  async findReviewByOrderId(userId, orderId) {
    const id = store().reviewIdByOrder.get(orderKey(userId, orderId));
    return id ? (store().reviews.get(id) ?? null) : null;
  },

  async findReviewByKey(userId, idempotencyKey) {
    const id = store().reviewIdByKey.get(idempotencyKeyOf(userId, idempotencyKey));
    return id ? (store().reviews.get(id) ?? null) : null;
  },

  async listReviewsByProduct(productId) {
    return [...store().reviews.values()].filter(
      (review) => reviewDimensionOwnerId(review, "product") === productId,
    );
  },

  async listReviewsByCompanion(companionId) {
    return [...store().reviews.values()].filter(
      (review) => reviewDimensionOwnerId(review, "companion") === companionId,
    );
  },

  async queryReviewsForAdmin(query) {
    const { status, keyword, page, pageSize } = query;

    const filtered = [...store().reviews.values()]
      .filter((review) => status === "all" || review.status === status)
      .filter((review) => matchesAdminReviewKeyword(review, keyword))
      .sort(compareReviewsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      hasMore: start + items.length < filtered.length,
    };
  },

  async countReviewsByStatus() {
    const counts: Record<ReviewStatus, number> = { ...EMPTY_STATUS_COUNTS };
    for (const review of store().reviews.values()) {
      counts[review.status] += 1;
    }
    return counts;
  },

  async findReviewById(id) {
    return store().reviews.get(id) ?? null;
  },

  async applyReviewStatus(id, patch: ReviewStatusPatch) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const previous = current.reviews.get(id);
    if (!previous) return null;

    const updated: OrderReview = {
      ...previous,
      status: patch.status,
      rejectReason: patch.rejectReason,
      hideReason: patch.hideReason,
      reviewedBy: patch.reviewedBy,
      reviewedByName: patch.reviewedByName,
      reviewedAt: patch.reviewedAt,
      // ⚠️ 内容与 updatedAt **都不动**：审核不修改用户写下的东西，
      // 也不该让「用户最后一次改这条评价是什么时候」跟着审核动作前进。
      // 这条规则由 `D12` 要求，且在这里用「根本不出现这两个字段」的方式保证。
    };

    current.reviews.set(id, updated);
    // —— 原子区段结束 ——

    return { previous, updated };
  },

  async createReview(review, idempotencyKey): Promise<CreateReviewOutcome> {
    const current = store();
    const businessKey = orderKey(review.userId, review.orderId);
    const requestKey = idempotencyKeyOf(review.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // ① 业务唯一键：一单一评
    const existingId = current.reviewIdByOrder.get(businessKey);
    if (existingId) {
      const existing = current.reviews.get(existingId);
      if (existing) return { ok: false, reason: "order_already_reviewed", existing };
    }

    // ② 幂等键：同一次提交意图重复到达时返回上一次的结果
    const byRequest = current.reviewIdByKey.get(requestKey);
    if (byRequest) {
      const existing = current.reviews.get(byRequest);
      if (existing) return { ok: true, review: existing, created: false };
    }

    current.reviews.set(review.id, review);
    current.reviewIdByOrder.set(businessKey, review.id);
    current.reviewIdByKey.set(requestKey, review.id);
    // —— 原子区段结束 ——

    return { ok: true, review, created: true };
  },

  async resubmitReview(id, input): Promise<ResubmitReviewOutcome> {
    const current = store();

    // —— 原子区段开始（无 await）——
    const previous = current.reviews.get(id);
    // 记录不存在。与「状态不允许」分开，是因为两者的对外表现不同：
    // 前者要报 404（这条评价真的没了），后者是 400（它在，只是不能改）。
    if (!previous) return { ok: false, reason: "not_found" };

    // 只有被驳回的评价可以重提（D9）。其余状态一律拒绝，且**不改任何字段**——
    // 尤其不能把一条已经公开的评价打回待审核：那等于用「重提」绕过了隐藏动作。
    //
    // ⚠️ 判据读**状态机**（`REVIEW_STATUS_TRANSITIONS`）而不是写死 `status === "rejected"`：
    // 状态机是唯一真值源，写死起点会让「将来放宽/收紧重提」变成一处漏改就静默生效的改动。
    if (!canTransitionReviewStatus(previous.status, "pending")) {
      return { ok: false, reason: "not_rejected", existing: previous };
    }

    const updated: OrderReview = {
      ...previous,
      productReview: input.productReview,
      companionReview: input.companionReview,
      evidence: input.evidence,
      // 重提后回到待审核：内容变了，必须重新看一遍（D9）
      status: "pending",
      // 上一轮的驳回原因随状态一起清掉：它描述的是**已被替换掉的那一版**内容，
      // 留着会让作者在待审核状态下看到一条已经不适用的理由。
      rejectReason: null,
      hideReason: null,
      // 审核人字段同样清空：这条内容还没有被任何人审过
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,
      // ⚠️ `createdAt` **不重置**：它是「这条评价最初提交于何时」，不是「这一版内容写于何时」。
      // 重置它会让作者列表按一个假的顺序重排，也让审计里那条转瞬即逝的历史失去时间锚点。
      updatedAt: input.at,
    };

    current.reviews.set(id, updated);
    // —— 原子区段结束 ——

    return { ok: true, review: updated, previous };
  },
};
