import { compareReviewsNewestFirst, isWithinReviewRange } from "@/lib/constants/reviews";
import { reviewSeed } from "@/lib/mocks/fixtures/reviewSeed";
import type { OrderReview } from "@/lib/types/review";
import { getMockStore } from "./mockStore";
import type { CreateReviewOutcome, ReviewRepository } from "./reviewRepository";

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
};
