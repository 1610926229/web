import type { PageResult } from "@/lib/types/common";
import type { OrderReview, ReviewRange } from "@/lib/types/review";
import { mockReviewRepository } from "./mockReviewRepository";

/**
 * 评价的可替换仓储。
 *
 * 与退款仓储同一套路：**写入侧**保证原子性与幂等，读取侧只按用户 / 订单查。
 *
 * 一条约束由本层负责，不能靠调用方自觉：
 *
 * **一笔订单只能有一条评价**（「用户 + 订单」是业务唯一键）。「检查是否已存在」与
 * 「写入新记录」在同一段同步代码里完成，因此快速连点、网络重试、并发提交都不会
 * 产生第二条——按钮禁用只是提示，真正兜底的是这里。
 *
 * ⚠️ 本层**不判断**「这一单能不能评价」「是不是你的订单」：那是业务规则，
 * 在 `lib/services/reviews.ts` 里做。仓储只保证自己这份数据的一致性。
 *
 * 时间筛选（`range`）在仓储里完成而不是在服务层筛完再分页：先分页再过滤会让某一页
 * 恰好被过滤空、列表凭空变短，这是偏移量分页最容易踩的坑。判定用的纯函数
 * `isWithinReviewRange` 由 `lib/constants/reviews.ts` 提供，两侧共用同一份实现。
 *
 * 当前实现是进程内内存存储，将来由数据库的唯一索引与事务替换——
 * 替换时这份契约不变（服务层不用改）。
 */

export type ReviewListQuery = {
  /** 查询条件的一部分，不是可选的过滤项：本方法只可能返回该用户的评价 */
  userId: string;
  range: ReviewRange;
  page: number;
  pageSize: number;
  /** 时间筛选的基准时刻，由服务层传入（测试里可以钉死） */
  now: Date;
};

/** 创建结果：要么成功（含幂等命中），要么这笔订单已经评价过了。 */
export type CreateReviewOutcome =
  | { ok: true; review: OrderReview; created: boolean }
  | { ok: false; reason: "order_already_reviewed"; existing: OrderReview };

export type ReviewRepository = {
  /** 某个用户已评价的记录，按时间筛选 + 分页（倒序）。 */
  queryReviews(query: ReviewListQuery): Promise<PageResult<OrderReview>>;

  /** 某个用户的评价总数（不限时间范围），用于 Tab 角标。 */
  countReviews(userId: string): Promise<number>;

  /** 某一笔订单有没有被这个用户评价过；没有返回 null。 */
  findReviewByOrderId(userId: string, orderId: string): Promise<OrderReview | null>;

  /** 按「用户 + 幂等键」查已提交过的评价；不存在返回 null。 */
  findReviewByKey(userId: string, idempotencyKey: string): Promise<OrderReview | null>;

  /**
   * 创建评价。
   *
   * 幂等：同「用户 + 幂等键」已存在时返回既有记录并把 `created` 置为 false；
   * 同一「用户 + 订单」已有评价时**拒绝创建**，并把已存在的那条返回给调用方，
   * 服务层据此返回第一次的结果而不是报错。
   */
  createReview(review: OrderReview, idempotencyKey: string): Promise<CreateReviewOutcome>;
};

export function getReviewRepository(): ReviewRepository {
  return mockReviewRepository;
}
