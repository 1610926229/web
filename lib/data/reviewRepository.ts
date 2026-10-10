import type { PageResult } from "@/lib/types/common";
import type {
  OrderReview,
  ReviewDimension,
  ReviewRange,
  ReviewStatus,
} from "@/lib/types/review";
import { mockReviewRepository } from "./mockReviewRepository";

/**
 * 评价的可替换仓储。
 *
 * 与退款仓储同一套路：**写入侧**保证原子性与幂等，读取侧按用户 / 订单 / 目标对象查。
 *
 * ## 本层负责的两条不变量
 *
 * 1. **一笔订单只能有一条评价**（「用户 + 订单」是业务唯一键）。「检查是否已存在」与
 *    「写入新记录」在同一段同步代码里完成，因此快速连点、网络重试、并发提交都不会
 *    产生第二条——按钮禁用只是提示，真正兜底的是这里。
 *    ⚠️ 「驳回后重新提交」**走的是同一条记录的状态迁移**（`D9`），不是再插一条：
 *    它同样受这个唯一键保护——即使重提的实现写错了，唯一键也会挡住第二条。
 * 2. **状态迁移只走 `applyReviewStatus`**。任何「顺手改一下 status」的写法都会绕开
 *    管理端事务里的审计与前置校验，因此本层不提供通用的字段更新方法。
 *
 * ⚠️ 本层**不判断**「这一单能不能评价」「是不是你的订单」「这条评价能不能被通过」：
 * 那是业务规则，在 `lib/services/reviews.ts` 与 `lib/services/adminReviews.ts` 里做。
 * 仓储只保证自己这份数据的一致性。
 *
 * ## 关于公开聚合（`R3`）
 *
 * 聚合需要**跨用户**读取（一条评价的读者不是它的作者），因此有两个按目标对象查的方法：
 * `listReviewsByProduct` / `listReviewsByCompanion`。
 *
 * ⚠️ **它们返回的是完整实体，包含 `userId` 与用户提交的正文**——调用方**必须**
 * 立刻交给 `buildReviewAggregate()`（`lib/constants/reviews.ts`）做 `approved` 过滤、
 * 维度切分与昵称脱敏，**不得**把这些实体直接放进任何响应。
 * 把「过滤 + 脱敏」放在纯函数里而不是仓储里，是为了让商品侧与打手侧
 * **共用同一段代码**（`R3`）：仓储层能过滤，就能出现「一边过滤了、一边忘了」。
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

/** 管理端列表的查询条件。**不加时间筛选**：审核是清队列，不是翻历史。 */
export type AdminReviewListQuery = {
  /** `all` 表示不限状态。默认只看 `pending`（待审核是这个页面的主用途） */
  status: ReviewStatus | "all";
  /** 关键词：订单号 / 商品名 / 评价 id。空串表示不限 */
  keyword: string;
  page: number;
  pageSize: number;
};

/** 创建结果：要么成功（含幂等命中），要么这笔订单已经评价过了。 */
export type CreateReviewOutcome =
  | { ok: true; review: OrderReview; created: boolean }
  | { ok: false; reason: "order_already_reviewed"; existing: OrderReview };

/** 重新提交的结果。 */
export type ResubmitReviewOutcome =
  | { ok: true; review: OrderReview; previous: OrderReview }
  /** 记录还在，但当前状态不允许重提（在此期间被管理员通过或隐藏了） */
  | { ok: false; reason: "not_rejected"; existing: OrderReview }
  /** 记录不存在。调用方按 404 处理，与「不能重提」区分开 */
  | { ok: false; reason: "not_found" };

/**
 * `applyReviewStatus` 的入参：**只改审核相关的字段**。
 *
 * ⚠️ 刻意不接收 `productReview` / `companionReview` / `status` 以外的任何东西——
 * `D12` 明文「管理员不能改星级与文字」，一个能改内容的入参就足以让那条规则在
 * 某一次「顺手修个错别字」里失守。写在这里的字段，就是审核动作**允许**触碰的全部字段。
 */
export type ReviewStatusPatch = {
  status: ReviewStatus;
  /** 驳回原因；非 `rejected` 时必须为 `null`（由调用方按动作决定） */
  rejectReason: string | null;
  hideReason: string | null;
  reviewedBy: string;
  reviewedByName: string | null;
  reviewedAt: string;
};

export type ReviewRepository = {
  /* ————————————————— 用户侧读取 ————————————————— */

  /** 某个用户已评价的记录，按时间筛选 + 分页（倒序）。**含全部状态**（`D8`）。 */
  queryReviews(query: ReviewListQuery): Promise<PageResult<OrderReview>>;

  /** 某个用户的评价总数（不限时间范围、不限状态），用于 Tab 角标。 */
  countReviews(userId: string): Promise<number>;

  /** 某一笔订单有没有被这个用户评价过；没有返回 null。 */
  findReviewByOrderId(userId: string, orderId: string): Promise<OrderReview | null>;

  /** 按「用户 + 幂等键」查已提交过的评价；不存在返回 null。 */
  findReviewByKey(userId: string, idempotencyKey: string): Promise<OrderReview | null>;

  /* ————————————————— 公开聚合读取（R3）————————————————— */

  /**
   * 某件商品的全部评价（**任意状态**）。
   *
   * ⚠️ 调用方**必须**接 `buildReviewAggregate()`。本方法的返回值里带着
   * `pending` / `rejected` / `hidden` 的记录与未脱敏的 `userId`——
   * 它存在的意义是「把数据凑齐给那个纯函数」，不是一个可以直接回到响应里的结果集。
   */
  listReviewsByProduct(productId: string): Promise<OrderReview[]>;

  /** 某个打手的全部评价（**任意状态**）。⚠️ 同上，必须接 `buildReviewAggregate()`。 */
  listReviewsByCompanion(companionId: string): Promise<OrderReview[]>;

  /* ————————————————— 管理端 ————————————————— */

  queryReviewsForAdmin(query: AdminReviewListQuery): Promise<PageResult<OrderReview>>;

  /** 管理端列表上的状态角标。 */
  countReviewsByStatus(): Promise<Record<ReviewStatus, number>>;

  findReviewById(id: string): Promise<OrderReview | null>;

  /**
   * **审核状态写入**（管理端事务专用）。
   *
   * 只改 `ReviewStatusPatch` 里列出的字段，其余字段一律保持原值——
   * 尤其是 `productReview` / `companionReview`：管理员改不了内容（`D12`）。
   *
   * ⚠️ 前置校验（当前状态是否允许这个迁移）**不在这里**：本方法只负责写。
   * 判断在 `lib/data/adminReviewTransaction.ts` 的原子区段内完成——
   * 那里读到的才是写入那一刻的状态，本层方法是它写下去的最后一笔。
   */
  applyReviewStatus(id: string, patch: ReviewStatusPatch): Promise<
    { previous: OrderReview; updated: OrderReview } | null
  >;

  /* ————————————————— 用户侧写入 ————————————————— */

  /**
   * 创建评价。
   *
   * 幂等：同「用户 + 幂等键」已存在时返回既有记录并把 `created` 置为 false；
   * 同一「用户 + 订单」已有评价时**拒绝创建**，并把已存在的那条返回给调用方，
   * 服务层据此返回第一次的结果而不是报错。
   */
  createReview(review: OrderReview, idempotencyKey: string): Promise<CreateReviewOutcome>;

  /**
   * 重新提交被驳回的评价（`D9`：`rejected → pending`）。
   *
   * ⚠️ **保持同一条记录**：id、`userId`、`orderId`、`orderNo`、`productId`、`specId`
   * 与全部订单快照都不变，`createdAt` 也不变——变的只有两个维度的内容、
   * 凭证、`updatedAt`（内容确实被改过了）与状态。
   *
   * 这既满足 `D9`「不新建第二条」，也满足 `R2`「状态变化不通过删除历史记录完成」：
   * 被驳回的那一版会消失，但**谁能证明它存在过**——答案是同一 id 上的审计记录，
   * 与 `createdAt` 这个「这条评价最初提交于何时」的字段。因此这里**不重置 `createdAt`**。
   *
   * 状态不是 `rejected` 时返回 `not_rejected` 并带回当前记录：
   * 服务层据此给出明确提示，而不是静默覆盖一条已经被管理员通过的评价（`D9`：其余状态不可改）。
   */
  resubmitReview(
    id: string,
    input: {
      productReview: ReviewDimension | null;
      companionReview: ReviewDimension | null;
      evidence: OrderReview["evidence"];
      at: string;
    },
  ): Promise<ResubmitReviewOutcome>;
};

export function getReviewRepository(): ReviewRepository {
  return mockReviewRepository;
}
