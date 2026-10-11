import type { PageResult } from "@/lib/types/common";
import type { TipPaymentStatus, TipRecord, TipStatusFilter } from "@/lib/types/tip";
import type { TipListQuery, TipRepository } from "../tipRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `TipRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）—— **只读**。
 *
 * ⚠️ 接口本来就只有 `queryTips` / `countTipsByStatus` 两个方法，这里也**只实现它们**：
 * 鸡腿的价格、兑换比例、支付方式与打手结算规则都还没有确认，提供一个「创建鸡腿记录」
 * 的入口会顺带定下价格与结算口径。写它们的是预置数据，不是业务路径。
 *
 * ## 排序：与 `compareTipsNewestFirst` 一字不差
 *
 * `lib/constants/tips.ts:117-124` 的比较器是 `createdAt` **降序**，相同则 `id` **降序**。
 * 这里用 `ORDER BY created_at DESC, id DESC`：不补 id 兜底的话，`ORDER BY` 不稳定，
 * 同一条记录可能在第一页出现过、第二页又出现一次。索引
 * `tip_records_user_created_idx` 也是 `(user_id, created_at DESC, id DESC)`，同序。
 *
 * ## 分页口径照抄 `complaintRepository.queryComplaints`
 *
 * `total` 与当前页在**同一条语句**里用窗口函数 `count(*) OVER ()` 取，看到的是
 * 同一个快照——分两条语句查 count 与列表，中间被并发插入插一脚，`hasMore` 就会算错。
 * 翻到超出末页时窗口函数没有行可依附，补一次计数即可。
 *
 * ## 状态计数在 SQL 里算
 *
 * Mock 的 `countTipsByStatus` 把该用户全部记录取出来调 `countTipStatuses`
 * （`lib/constants/tips.ts:160-164`）。Pg 版在同一条语句里用 `count(*) FILTER (…)`
 * 一次算出四个数——这是本层既有的一致做法（`favoriteRepository` / `complaintRepository`
 * 的 count 也都是 SQL 聚合），**结果形状与 `countTipStatuses` 相同**。这是实现口径的
 * 迁移，不是新的业务规则。
 *
 * ## jsonb 与时间
 *
 * `companion` 是 `jsonb`（可空），驱动**直接返回已解析的对象**（或 null），
 * 映射时直接赋值，**不做 `JSON.parse`**。`created_at` 经 `pool.ts` 的解析器钩子
 * 还原成 ISO 字符串，时间字段仍是 `string`。
 */

type TipRow = {
  id: string;
  user_id: string;
  order_id: string;
  order_no: string;
  product_title: string;
  product_cover_url: string;
  /** jsonb：驱动已解析成对象，未绑定时为 null。 */
  companion: TipRecord["companion"];
  quantity: number;
  payment_status: TipPaymentStatus;
  created_at: string;
};

/** 领域对象会读到的列。显式列清单，不用 `SELECT *`——将来新增列不会自动外泄。 */
const COLUMNS =
  "id, user_id, order_id, order_no, product_title, product_cover_url, " +
  "companion, quantity, payment_status, created_at";

/** 与 `compareTipsNewestFirst` 一字不差：创建时间倒序，同刻 id 倒序兜底。 */
const ORDER_BY_NEWEST = "created_at DESC, id DESC";

type TipStatusCountRow = {
  all: number;
  paid: number;
  pending: number;
  failed: number;
};

function toTipRecord(row: TipRow): TipRecord {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    productTitle: row.product_title,
    productCoverUrl: row.product_cover_url,
    // jsonb 已由驱动解析，直接赋值
    companion: row.companion,
    quantity: row.quantity,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
  };
}

/**
 * `status` 过滤条件：`all` 表示不限状态，对应 SQL 里传 `null`。
 *
 * 与 `complaintRepository.queryComplaints` 同形——用 `$n::text IS NULL OR …`
 * 而不是按需拼接 `WHERE`，空分支不存在、也就不可能拼出恒真的条件。
 */
function statusParam(status: TipStatusFilter): TipPaymentStatus | null {
  return status === "all" ? null : status;
}

/**
 * 用任意可执行 SQL 的对象造一个鸡腿记录仓储。
 *
 * 与其它仓储同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储。
 */
export function createTipRepository(db: PgQueryable): TipRepository {
  /** 越界页补一次计数。筛选条件必须与列表查询**逐条一致**，否则 total 会与 items 分叉。 */
  async function countTips(userId: string, status: TipPaymentStatus | null): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM tip_records
        WHERE user_id = $1 AND ($2::text IS NULL OR payment_status = $2)`,
      [userId, status],
    );
    return rows[0]?.total ?? 0;
  }

  return {
    async queryTips({ userId, status, page, pageSize }: TipListQuery): Promise<PageResult<TipRecord>> {
      const start = (page - 1) * pageSize;
      const statusFilter = statusParam(status);

      // total 与当前页在**同一条语句**里取（窗口函数），因此看到的是同一个快照——
      // 分两条语句查 count 与列表，中间被并发插入插一脚，hasMore 就会算错。
      const rows = await db.query<TipRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM tip_records
          WHERE user_id = $1 AND ($2::text IS NULL OR payment_status = $2)
          ORDER BY ${ORDER_BY_NEWEST}
          LIMIT $3 OFFSET $4`,
        [userId, statusFilter, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total =
        rows.length > 0 ? rows[0].total : page > 1 ? await countTips(userId, statusFilter) : 0;
      const items = rows.map(toTipRecord);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    async countTipsByStatus(userId): Promise<Record<TipStatusFilter, number>> {
      // 一条语句一次拿到四个数：`all` 就是该用户的全部记录数，
      // 三个状态用 `FILTER` 分别计数。返回形状与 Mock 的 `countTipStatuses` 逐字段相同。
      const rows = await db.query<TipStatusCountRow>(
        `SELECT
            count(*)::int AS all,
            count(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
            count(*) FILTER (WHERE payment_status = 'pending')::int AS pending,
            count(*) FILTER (WHERE payment_status = 'failed')::int AS failed
           FROM tip_records
          WHERE user_id = $1`,
        [userId],
      );

      // 聚合查询恒返回一行；取不到时（理论上不会）按全 0 处理
      const row = rows[0];
      return {
        all: row?.all ?? 0,
        paid: row?.paid ?? 0,
        pending: row?.pending ?? 0,
        failed: row?.failed ?? 0,
      };
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgTipRepository: TipRepository = createTipRepository(lazyPgExecutor());
