import type { EarningAdjustment, EarningAdjustmentType } from "@/lib/types/earning";
import type { EarningRepository } from "../earningRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `earnings` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，**不在这里再写一份**：
// 本轮结算事务（`w1Transactions.ts`）也要读这张表，两份映射会各自演化。
import { EARNING_COLUMNS, toEarning, type EarningRow } from "./w1Rows";

/**
 * `EarningRepository` 的 PostgreSQL 实现（PROD-1B · W1）。
 *
 * ## 为什么这里只有读方法，没有写方法
 *
 * 与完成材料（`completionRepository.ts`）是同一套结构：**写入不经过本接口**。
 * 一条收益的创建必须与「订单写成 completed + 冻结投诉窗口快照」发生在**同一段
 * 没有 `await` 的同步代码**里（`lib/data/earningTransaction.ts` 的伪事务），
 * 而异步的仓储方法做不到这件事——在它前后让出执行权，就会出现「订单已 completed、
 * 收益还没建」的半写状态。冲回、解冻同理，都在伪事务的同步写原语里。
 *
 * ## 排序必须完全确定
 *
 * Mock 用 JS 的 `Array.prototype.sort`（稳定排序），同刻记录靠 `id` 稳定兜底。
 * SQL 的 `ORDER BY` 没有这条保证，因此每一个排序键都补 `id`：
 *
 * - 收益列表：`frozen_at DESC, id ASC`（**与 `compareEarningsNewestFirst` 一字不差**；
 *   `0006_settlement.sql` 上的索引写的是 `id DESC`，那只是索引方向，排序口径以 Mock 为准）；
 * - 调整明细：`created_at ASC, id ASC`（`compareAdjustmentsOldestFirst`）。
 *
 * ## 总量与明细是「读用总数、审计用明细」
 *
 * `listAdjustmentsForEarning` 返回的是 `Earning.reversedAmount` 背后的明细，
 * 两者在同一次原子写入里落库，不是两份各自维护的账。页面上没人读明细，
 * 它服务的是对账与测试。
 *
 * ## 时间
 *
 * `frozen_at` / `available_at` / `withdrawn_at` 都是 `timestamptz`，经 `pool.ts`
 * 的解析器钩子统一还原成 ISO 字符串（或 null）。`available_at` 是**计划**解冻时刻，
 * 本查询只如实读出，不做任何「是否到期」的判断——那是业务层的事。
 */

type EarningAdjustmentRow = {
  id: string;
  earning_id: string;
  order_id: string;
  refund_id: string;
  type: EarningAdjustmentType;
  amount: number;
  created_at: string;
  admin_id: string;
};

const ADJUSTMENT_COLUMNS =
  "id, earning_id, order_id, refund_id, type, amount, created_at, admin_id";

/** 与 `compareEarningsNewestFirst` 一字不差：冻结时间倒序，同刻 id 正序兜底。 */
const ORDER_BY_NEWEST = "frozen_at DESC, id ASC";

/** 与 `compareAdjustmentsOldestFirst` 一字不差：发生时间正序，同刻 id 正序兜底。 */
const ORDER_BY_OLDEST = "created_at ASC, id ASC";

function toEarningAdjustment(row: EarningAdjustmentRow): EarningAdjustment {
  return {
    id: row.id,
    earningId: row.earning_id,
    orderId: row.order_id,
    refundId: row.refund_id,
    type: row.type,
    amount: row.amount,
    createdAt: row.created_at,
    adminId: row.admin_id,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个收益仓储。
 *
 * 与收藏 / 反馈同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储——
 * 事务内的读（例如结算阻塞判定）因此与写入共享同一条连接与同一个快照。
 */
export function createEarningRepository(db: PgQueryable): EarningRepository {
  return {
    async listEarningsForCompanion(companionId) {
      // 归属是**查询条件**，不是过滤项：结果里不可能出现别的打手，
      // 调用方拿到之后不需要（也不应该）再过滤一次。
      const rows = await db.query<EarningRow>(
        `SELECT ${EARNING_COLUMNS} FROM earnings
          WHERE companion_id = $1
          ORDER BY ${ORDER_BY_NEWEST}`,
        [companionId],
      );
      return rows.map(toEarning);
    },

    async listAllEarnings() {
      // 与 `listEarningsForCompanion` 同一种排序，只是不收窄归属。
      // 跨打手聚合需要一个**确定**的行序，否则同一份数据两次查询可能不同，
      // 而调用方虽然会自己排序，测试却会因此变得不可复现。
      const rows = await db.query<EarningRow>(
        `SELECT ${EARNING_COLUMNS} FROM earnings ORDER BY ${ORDER_BY_NEWEST}`,
      );
      return rows.map(toEarning);
    },

    async findEarningByOrderId(orderId) {
      // `earnings_order_key UNIQUE (order_id)` 保证这里至多一行——
      // 「一个订单最多一条收益」这条约束的读取侧入口。
      const rows = await db.query<EarningRow>(
        `SELECT ${EARNING_COLUMNS} FROM earnings WHERE order_id = $1`,
        [orderId],
      );
      return rows[0] ? toEarning(rows[0]) : null;
    },

    async listAdjustmentsForEarning(earningId) {
      const rows = await db.query<EarningAdjustmentRow>(
        `SELECT ${ADJUSTMENT_COLUMNS} FROM earning_adjustments
          WHERE earning_id = $1
          ORDER BY ${ORDER_BY_OLDEST}`,
        [earningId],
      );
      return rows.map(toEarningAdjustment);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、
 * 不建池。理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgEarningRepository: EarningRepository = createEarningRepository(lazyPgExecutor());
