import {
  REVIEW_STATUSES,
  canTransitionReviewStatus,
  reviewRangeStart,
} from "@/lib/constants/reviews";
import { BEIJING_OFFSET_MINUTES } from "@/lib/utils/format";
import type { PageResult } from "@/lib/types/common";
import type { SupportEvidence } from "@/lib/types/evidence";
import type { OrderCompanionSnapshot } from "@/lib/types/order";
import type {
  OrderReview,
  ReviewDimension,
  ReviewRange,
  ReviewStatus,
} from "@/lib/types/review";
import type {
  AdminReviewListQuery,
  CreateReviewOutcome,
  ResubmitReviewOutcome,
  ReviewRepository,
  ReviewStatusPatch,
} from "../reviewRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
import { jsonbParam } from "./w1Rows";

/**
 * `ReviewRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**（`lib/data/reviewRepository.ts`）：接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 这一版真正要消灭的东西：Mock 的「读—判断—写」原子区段
 *
 * `mockReviewRepository.createReview` 先查业务键、再查幂等键、都查空才写，
 * 靠的是「Node 单线程 + 区段内没有 await」。换成数据库后同样的写法会在两个并发
 * 提交之间留下空档 —— 连点两次会得到两条评价。这里改成**单条
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`**：判重交给两个唯一索引
 * （`order_reviews_user_order_key` / `order_reviews_idempotency_key`），冲突后回读。
 *
 * ## 时间与 JSON
 *
 * `created_at` 等 `timestamptz` 经 `pool.ts` 统一还原成 ISO 字符串（定长 + UTC，
 * 字典序即时间序），因此领域对象上的时间字段仍是 `string`，与 Mock 完全一致。
 * `product_review` / `companion_review` / `evidence` / `companion` 是 `jsonb`，
 * 驱动**直接返回已解析的值**，映射时直接赋值，**不做 `JSON.parse`**；
 * 写入用 `jsonbParam`（`null` 原样交给驱动，不 `JSON.stringify`）。
 *
 * ## 排序必须完全确定
 *
 * Mock 用稳定排序的 JS `Array.prototype.sort`，SQL 的 `ORDER BY` 不是。
 * 每个排序都补了 id 兜底 tie-break，并与 `compareReviewsNewestFirst` 逐字段对齐：
 * **`created_at` 降序，同一时间按 `id` 降序**。`id` 列在表上声明为 `COLLATE "C"`，
 * 因此 `ORDER BY id DESC` 的字节序与 JS 的 `a.id < b.id` 字符串比较一致。
 *
 * ## 时间窗（`range`）不在这里重写
 *
 * 下界由 `reviewRangeStart`（`lib/constants/reviews.ts`）算出 —— 它是 Mock 侧
 * `isWithinReviewRange` 用的**同一个函数**，两侧共用一份实现，不可能漂移。
 * 详见 `reviewRangeBoundary` 的注释。
 */

type ReviewRow = {
  id: string;
  user_id: string;
  order_id: string;
  order_no: string;
  product_id: string;
  spec_id: string;
  /** jsonb：驱动已解析成对象或 null。 */
  product_review: ReviewDimension | null;
  /** jsonb：驱动已解析成对象或 null。 */
  companion_review: ReviewDimension | null;
  /** jsonb：驱动已解析成数组。 */
  evidence: SupportEvidence[];
  status: ReviewStatus;
  reject_reason: string | null;
  hide_reason: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  product_title: string;
  product_cover_url: string;
  spec_name: string;
  quantity: number;
  completed_at: string;
  /** jsonb：实际履约打手快照，未绑定时为 SQL NULL。 */
  companion: OrderCompanionSnapshot | null;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ **不含 `idempotency_key`**：它不是实体字段，Mock 里只活在 `reviewIdByKey`
 * 索引上（见 `mockReviewRepository.ts`）。读侧把它带出来会让「幂等键是索引、
 * 不是数据」这件事在类型上说不清。
 */
const COLUMNS =
  "id, user_id, order_id, order_no, product_id, spec_id, product_review, companion_review, " +
  "evidence, status, reject_reason, hide_reason, reviewed_by, reviewed_by_name, reviewed_at, " +
  "created_at, updated_at, product_title, product_cover_url, spec_name, quantity, " +
  "completed_at, companion";

/** 写入侧的列：相比 `COLUMNS` 多一个幂等键。 */
const INSERT_COLUMNS = `${COLUMNS}, idempotency_key`;

const INSERT_VALUE_COUNT = 24;

function toReview(row: ReviewRow): OrderReview {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    productId: row.product_id,
    specId: row.spec_id,
    // jsonb 已由驱动解析，直接赋值（不 JSON.parse）
    productReview: row.product_review,
    companionReview: row.companion_review,
    evidence: row.evidence,
    status: row.status,
    rejectReason: row.reject_reason,
    hideReason: row.hide_reason,
    reviewedBy: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    productTitle: row.product_title,
    productCoverUrl: row.product_cover_url,
    specName: row.spec_name,
    quantity: row.quantity,
    completedAt: row.completed_at,
    // jsonb：未绑定的打手是 SQL NULL，映射后仍是领域里的 null
    companion: row.companion,
  };
}

/**
 * 取值顺序**必须**与 `INSERT_COLUMNS` 逐位对应。
 *
 * ⚠️ `idempotencyKey` 在 `INSERT_COLUMNS` 里是**最后一个**（`COLUMNS` 的 23 列之后），
 * 因此这里也必须放最后。写成更靠前的值不会在类型检查上暴露 —— PG 会在运行时
 * 把字符串往 `timestamptz` 里塞并抛 `22007`，而**只比读的契约测试看不见**。
 */
function insertValues(review: OrderReview, idempotencyKey: string): unknown[] {
  return [
    review.id,
    review.userId,
    review.orderId,
    review.orderNo,
    review.productId,
    review.specId,
    jsonbParam(review.productReview),
    jsonbParam(review.companionReview),
    jsonbParam(review.evidence),
    review.status,
    review.rejectReason,
    review.hideReason,
    review.reviewedBy,
    review.reviewedByName,
    review.reviewedAt,
    review.createdAt,
    review.updatedAt,
    review.productTitle,
    review.productCoverUrl,
    review.specName,
    review.quantity,
    review.completedAt,
    jsonbParam(review.companion),
    idempotencyKey,
  ];
}

/**
 * 时间筛选的下界，换算成**真实 UTC 时刻**的 ISO 字符串，用于 SQL 的
 * `created_at >= $n`。`all`（无下界）返回 `null`。
 *
 * ⚠️ 边界算法**不在这里重写**：直接复用 `reviewRangeStart` —— 它是 Mock 侧
 * `isWithinReviewRange` 用的同一个纯函数（含「自然月回退、超月收尾、今年取自然年」
 * 三套规则），两侧共用一份实现，因此不可能出现「Mock 筛掉、SQL 留下」的漂移。
 *
 * ⚠️ 为什么还要**减一次**偏移：`reviewRangeStart` 的返回值处于「按 UTC 字段读出
 * 即北京时间」的**偏移坐标系**（见 `lib/constants/reviews.ts` 的 `beijingTime`）。
 * `isWithinReviewRange` 的判据是 `Date.parse(iso) + offset >= start`，
 * 移项即 `Date.parse(iso) >= start - offset` —— 这里计算的正是右边那个**真实时刻**，
 * 于是 SQL 的 `created_at >= $n` 与 Mock 的 `time >= start` 逐值等价（**闭区间**，
 * 没有上界，因此未来的时间同样落在范围内，与 Mock 一致）。
 */
function reviewRangeBoundary(range: ReviewRange, now: Date): string | null {
  const start = reviewRangeStart(range, now);
  if (start === null) return null;
  return new Date(start - BEIJING_OFFSET_MINUTES * 60_000).toISOString();
}

/**
 * 把关键词转成 `LIKE` 模式，**转义** `\` `%` `_` 三个元字符。
 *
 * Mock 用的是 `String.prototype.includes`（纯子串），而 SQL 的 `LIKE` 默认把
 * `%` / `_` 当通配符 —— 不转义的话，管理员搜「100%」会命中一堆无关记录。
 */
function likeContains(needle: string): string {
  const escaped = needle.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

/**
 * 管理端列表的 WHERE 片段与参数（状态 + 关键词）。
 *
 * 列表与越界页计数**共用这一份**：两处各拼一次迟早会分叉，而分叉的表现是
 * `total` 与 `items` 口径不一致 —— 只有翻到某一页才会看出来。
 *
 * 关键词匹配字段与 `matchesAdminReviewKeyword`（`lib/constants/adminReviews.ts`）
 * **逐条对齐**：订单号 / 评价 id / 商品名 / 规格名 / 打手名，**不含作者 id 与昵称**。
 * 打手名为 NULL 时 `lower(companion ->> 'name')` 也是 NULL，`NULL LIKE …` 不为真，
 * 与 Mock 的 `review.companion?.name ?? ""` 行为一致。
 */
function adminReviewFilter(query: AdminReviewListQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.status !== "all") {
    // 状态筛选：`all` 表示不限（Mock：`status === "all" || review.status === status`）
    clauses.push(`status = $${params.length + 1}`);
    params.push(query.status);
  }

  const needle = query.keyword.trim().toLowerCase();
  if (needle) {
    const placeholder = `$${params.length + 1}`;
    params.push(likeContains(needle));
    clauses.push(
      `(lower(order_no) LIKE ${placeholder} ESCAPE '\\'` +
        ` OR lower(id) LIKE ${placeholder} ESCAPE '\\'` +
        ` OR lower(product_title) LIKE ${placeholder} ESCAPE '\\'` +
        ` OR lower(spec_name) LIKE ${placeholder} ESCAPE '\\'` +
        ` OR lower(companion ->> 'name') LIKE ${placeholder} ESCAPE '\\')`,
    );
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * 重新提交允许的**起始状态**，由状态机推导（`REVIEW_STATUS_TRANSITIONS`）。
 *
 * ⚠️ 刻意**不写死** `status = 'rejected'`：与 Mock 的 `canTransitionReviewStatus`
 * 同源。将来放宽/收紧「谁能重提」只改状态机一处，这里与 Mock 会一起跟上。
 */
const RESUBMIT_SOURCE_STATUSES: readonly ReviewStatus[] = REVIEW_STATUSES.filter((status) =>
  canTransitionReviewStatus(status, "pending"),
);

/**
 * 用任意可执行 SQL 的对象造一个评价仓储。
 *
 * 与收藏 / 反馈 / 退款 / 投诉同构：**一个工厂同时产出普通仓储与事务内仓储**。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「创建评价」与同一事务里的
 * 其它写入共享同一条连接、同一个提交点。
 */
export function createReviewRepository(db: PgQueryable): ReviewRepository {
  async function findReviewByOrderId(
    userId: string,
    orderId: string,
  ): Promise<OrderReview | null> {
    const rows = await db.query<ReviewRow>(
      `SELECT ${COLUMNS} FROM order_reviews WHERE user_id = $1 AND order_id = $2`,
      [userId, orderId],
    );
    return rows[0] ? toReview(rows[0]) : null;
  }

  async function findReviewByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<OrderReview | null> {
    // `idempotency_key = $2` 永远匹配不到 NULL，因此预置数据（若写 NULL）与 Mock 一致：
    // 按任何幂等键都查不到（Mock 的 `reviewIdByKey` 同样只索引运行时新建的记录）。
    const rows = await db.query<ReviewRow>(
      `SELECT ${COLUMNS} FROM order_reviews WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toReview(rows[0]) : null;
  }

  /**
   * 某个用户在**同一时间窗**内的评价总数。
   *
   * 只在翻到越界页（窗口函数拿不到 total）时补一次。筛选条件必须与
   * `queryReviews` 的列表查询**逐条一致**（`user_id` + 时间窗），否则 `total` 会分叉。
   */
  async function countReviewsWithin(userId: string, boundary: string | null): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM order_reviews
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)`,
      [userId, boundary],
    );
    return rows[0]?.total ?? 0;
  }

  /** 管理端列表的越界页计数。筛选条件复用 `adminReviewFilter`，与列表查询同口径。 */
  async function countReviewsForAdmin(filter: AdminReviewListQuery): Promise<number> {
    const { where, params } = adminReviewFilter(filter);
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM order_reviews ${where}`,
      params,
    );
    return rows[0]?.total ?? 0;
  }

  return {
    async queryReviews({ userId, range, page, pageSize, now }): Promise<PageResult<OrderReview>> {
      const start = (page - 1) * pageSize;
      const boundary = reviewRangeBoundary(range, now);

      // total 与当前页在**同一条语句**里取（窗口函数），因此看到的是同一个快照——
      // 分两条语句查 count 与列表，中间被并发插入插一脚，hasMore 就会算错。
      const rows = await db.query<ReviewRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM order_reviews
          WHERE user_id = $1
            AND ($2::timestamptz IS NULL OR created_at >= $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4`,
        [userId, boundary, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total =
        rows.length > 0 ? rows[0].total : page > 1 ? await countReviewsWithin(userId, boundary) : 0;
      const items = rows.map(toReview);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    async countReviews(userId) {
      // 不含时间筛选、不含状态筛选：Tab 角标数的是「这个用户写下的全部评价」
      const rows = await db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM order_reviews WHERE user_id = $1`,
        [userId],
      );
      return rows[0]?.total ?? 0;
    },

    findReviewByOrderId,

    findReviewByKey,

    async listReviewsByProduct(productId) {
      // 与 Mock 同：**不筛状态**（过滤 `approved` 是 `buildReviewAggregate` 的职责，
      // 见接口注释）。聚合身份是 `product_id`（R4），不是 spec、也不是订单。
      // Mock 没有显式排序（Map 插入序），这里按统一口径 `created_at DESC, id DESC`
      // 给出一个确定顺序；`buildReviewAggregate` 内部会再按同一比较器排序，因此不影响聚合结果。
      const rows = await db.query<ReviewRow>(
        `SELECT ${COLUMNS} FROM order_reviews
          WHERE product_id = $1
          ORDER BY created_at DESC, id DESC`,
        [productId],
      );
      return rows.map(toReview);
    },

    async listReviewsByCompanion(companionId) {
      // 与 Mock 同：**不筛状态**。打手维度指向实际履约打手的 id（`companion ->> 'id'`，
      // 对应 `reviewDimensionOwnerId(review, "companion")`）；companion 为 SQL NULL 时
      // 该表达式为 NULL，`NULL = $1` 不为真，因此未绑定打手的评价不会被误计入。
      const rows = await db.query<ReviewRow>(
        `SELECT ${COLUMNS} FROM order_reviews
          WHERE (companion ->> 'id') = $1
          ORDER BY created_at DESC, id DESC`,
        [companionId],
      );
      return rows.map(toReview);
    },

    async queryReviewsForAdmin(query) {
      const { where, params } = adminReviewFilter(query);
      const start = (query.page - 1) * query.pageSize;

      // `LIMIT` / `OFFSET` 追加在筛选参数之后，占位符编号按已有参数个数顺延。
      // 与 `compareReviewsNewestFirst` 对齐：`created_at` 降序，同时间按 `id` 降序。
      const limitPlaceholder = `$${params.length + 1}`;
      const offsetPlaceholder = `$${params.length + 2}`;
      const rows = await db.query<ReviewRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM order_reviews ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
        [...params, query.pageSize, start],
      );

      const total =
        rows.length > 0
          ? rows[0].total
          : query.page > 1
            ? await countReviewsForAdmin(query)
            : 0;
      const items = rows.map(toReview);

      return {
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: start + items.length < total,
      };
    },

    async countReviewsByStatus() {
      // 四个状态都要出现在返回里（没有记录的补 0），与 Mock 的 `EMPTY_STATUS_COUNTS` 同口径
      const counts: Record<ReviewStatus, number> = {
        pending: 0,
        approved: 0,
        rejected: 0,
        hidden: 0,
      };
      const rows = await db.query<{ status: ReviewStatus; total: number }>(
        `SELECT status, count(*)::int AS total FROM order_reviews GROUP BY status`,
      );
      for (const row of rows) counts[row.status] = row.total;
      return counts;
    },

    async findReviewById(id) {
      const rows = await db.query<ReviewRow>(
        `SELECT ${COLUMNS} FROM order_reviews WHERE id = $1`,
        [id],
      );
      return rows[0] ? toReview(rows[0]) : null;
    },

    async applyReviewStatus(id, patch: ReviewStatusPatch) {
      // 单条语句同时拿到「旧行」与「写入是否发生」：`target` 锁住并读出旧行，
      // `updated` 做**窄写入**（只写这六个字段），主查询把旧行返回给调用方。
      // 单语句因此是**原子**的 —— Mock 的原子区段在这里由一条语句取代。
      //
      // ⚠️ 窄写入，不是整行 UPDATE：`product_review` / `companion_review` / `evidence` /
      // `updated_at` 都**不在这条语句里**（D12：审核不改用户写下的内容，也不改
      // 「最后一次内容变更」的时间）。整行写会把它们覆盖成锁下读到的那一份，
      // 而现在恰好没人在两条语句之间插第三写者 —— 那种「今天正确」的假设正是要避免的。
      const rows = await db.query<ReviewRow & { updated_count: number }>(
        `WITH target AS (
           SELECT ${COLUMNS} FROM order_reviews WHERE id = $1 FOR UPDATE
         ),
         updated AS (
           UPDATE order_reviews r
              SET status = $2,
                  reject_reason = $3,
                  hide_reason = $4,
                  reviewed_by = $5,
                  reviewed_by_name = $6,
                  reviewed_at = $7
             FROM target t
            WHERE r.id = $1
            RETURNING 1
         )
         SELECT t.*, (SELECT count(*)::int FROM updated) AS updated_count
           FROM target t`,
        [
          id,
          patch.status,
          patch.rejectReason,
          patch.hideReason,
          patch.reviewedBy,
          patch.reviewedByName,
          patch.reviewedAt,
        ],
      );

      const row = rows[0];
      if (!row) return null;

      const previous = toReview(row);
      // 与 Mock 的 `applyStatusSync` 逐字段相同：只替换 patch 里给出的六个字段，
      // 其余（内容与 `updatedAt`）保持原值 —— 这里用「根本不出现这两个字段」的方式保证。
      const updated: OrderReview = {
        ...previous,
        status: patch.status,
        rejectReason: patch.rejectReason,
        hideReason: patch.hideReason,
        reviewedBy: patch.reviewedBy,
        reviewedByName: patch.reviewedByName,
        reviewedAt: patch.reviewedAt,
      };

      return { previous, updated };
    },

    async createReview(review, idempotencyKey): Promise<CreateReviewOutcome> {
      const placeholders = Array.from(
        { length: INSERT_VALUE_COUNT },
        (_, index) => `$${index + 1}`,
      ).join(", ");
      const values = insertValues(review, idempotencyKey);

      // 最多两轮：第二轮只在「冲突命中后、读回之前，那行被并发删掉」时发生
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<ReviewRow>(
          `INSERT INTO order_reviews (${INSERT_COLUMNS})
           VALUES (${placeholders})
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          values,
        );
        if (inserted[0]) return { ok: true, review: toReview(inserted[0]), created: true };

        // 冲突命中后回读。判据与 Mock 的检查顺序**一致**：
        // 1) 业务唯一键「一单一评」命中 → 拒绝创建，并把已存在的那条返回给调用方
        //    （服务层据此返回第一次的结果，而不是报错）
        const byOrder = await findReviewByOrderId(review.userId, review.orderId);
        if (byOrder) return { ok: false, reason: "order_already_reviewed", existing: byOrder };

        // 2) 幂等键命中 → 同一次提交重复到达，返回既有记录（`created: false`）。
        //    含「同键换订单」的 bug：这里如实返回既有记录，由服务层比对 orderId 后报冲突
        //    （`REVIEW_OPERATION_CONFLICT_MESSAGE`），不在这里静默吞掉。
        const byKey = await findReviewByKey(review.userId, idempotencyKey);
        if (byKey) return { ok: true, review: byKey, created: false };

        // 走到这里说明既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `评价写入在并发下未能收敛（用户 ${review.userId} / 订单 ${review.orderId} / 幂等键 ${idempotencyKey}）。`,
      );
    },

    async resubmitReview(id, input): Promise<ResubmitReviewOutcome> {
      // 单条语句完成「读旧行 + 判状态 + 窄写 + 回读」：
      // `target` 锁住并读出旧行；`updated` 只在旧行状态**允许迁移到 pending**
      // 时才写（`t.status = ANY($6)`，集合由状态机推导），并通过引用 `target`
      // 强制它在 target 之后求值；主查询据 `updated_count` 区分三种结果。
      const rows = await db.query<ReviewRow & { updated_count: number }>(
        `WITH target AS (
           SELECT ${COLUMNS} FROM order_reviews WHERE id = $1 FOR UPDATE
         ),
         updated AS (
           UPDATE order_reviews r
              SET product_review = $2,
                  companion_review = $3,
                  evidence = $4,
                  status = 'pending',
                  reject_reason = NULL,
                  hide_reason = NULL,
                  reviewed_by = NULL,
                  reviewed_by_name = NULL,
                  reviewed_at = NULL,
                  updated_at = $5
             FROM target t
            WHERE r.id = $1 AND t.status = ANY($6::text[])
            RETURNING 1
         )
         SELECT t.*, (SELECT count(*)::int FROM updated) AS updated_count
           FROM target t`,
        [
          id,
          jsonbParam(input.productReview),
          jsonbParam(input.companionReview),
          jsonbParam(input.evidence),
          input.at,
          [...RESUBMIT_SOURCE_STATUSES],
        ],
      );

      const row = rows[0];
      // 记录不存在。与「状态不允许」分开，是因为两者的对外表现不同：
      // 前者要报 404（这条评价真的没了），后者是 400（它在，只是不能改）。
      if (!row) return { ok: false, reason: "not_found" };

      const previous = toReview(row);
      // 状态不是允许重提的状态（在此期间被管理员通过或隐藏了）→ 不改任何字段
      if (row.updated_count === 0) {
        return { ok: false, reason: "not_rejected", existing: previous };
      }

      // 与 Mock 的 `resubmitReview` 逐字段相同：`createdAt` **不重置**（它是「这条评价
      // 最初提交于何时」，不是「这一版内容写于何时」），`updatedAt` 前进到本次提交时刻。
      const updated: OrderReview = {
        ...previous,
        productReview: input.productReview,
        companionReview: input.companionReview,
        evidence: input.evidence,
        status: "pending",
        rejectReason: null,
        hideReason: null,
        reviewedBy: null,
        reviewedByName: null,
        reviewedAt: null,
        updatedAt: input.at,
      };

      return { ok: true, review: updated, previous };
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgReviewRepository: ReviewRepository = createReviewRepository(lazyPgExecutor());
