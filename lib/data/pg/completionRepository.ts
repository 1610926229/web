import type { CompletionRepository } from "../completionRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `completion_submissions` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，
// **不在这里再写一份**：本轮完成材料事务（`w1Transactions.ts`）也要读写这张表。
import {
  COMPLETION_COLUMNS as COLUMNS,
  toCompletionSubmission as toCompletion,
  type CompletionSubmissionRow as CompletionRow,
} from "./w1Rows";

/**
 * `CompletionRepository` 的 PostgreSQL 实现（PROD-1B · W1）。
 *
 * ## 为什么这里只有读方法，没有写方法
 *
 * 与契约文件 `lib/data/completionRepository.ts` 说的是同一件事，这里再说一遍，
 * 是因为**实现文件才是下一个改代码的人最先打开的地方**：完成材料的写入必须与
 * 订单写入**同生共死**（`submission approved` 而订单仍 `serving` 是明确禁止出现的
 * 一致性状态），因此写入入口只有 `lib/data/completionTransaction.ts` 一处，
 * 用的是 Mock 侧的同步写原语，**不经过本接口**。若在本文件里加一个 `updateStatus()`，
 * 就等于开出第二条写入路径——它没有「同一订单最多一份 pending」的判定，
 * 也没有与订单的原子一致，而它与伪事务的差别只在「有人绕过服务层直接调仓储」时
 * 才会暴露。
 *
 * ## 排序必须完全确定
 *
 * Mock 用的是 JS 的 `Array.prototype.sort`（稳定排序），相同 `submittedAt` 的两条
 * 会保持插入顺序。SQL 的 `ORDER BY` **没有这条保证**，所以每一个排序键都要补
 * `id` 兜底——否则同刻的两条材料在两次查询之间的先后可以不同，
 * 「最近一次提交」这个答案会随时间漂移。
 *
 * ## 时间与 JSON
 *
 * `submitted_at` / `auto_approval_deadline_at` / `reviewed_at` / `invalidated_at`
 * 都是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串（或 null），
 * 因此领域对象上的时间字段仍然是 `string`，与 Mock 完全一致。
 * `evidence` 是 `jsonb`，驱动直接解析成 JS 值。
 */

/** 与 `compareStaffCompletions` 一字不差：提交时间倒序，同刻 id 倒序兜底。 */
const ORDER_BY_LATEST = "submitted_at DESC, id DESC";

/**
 * 用任意可执行 SQL 的对象造一个完成材料仓储。
 *
 * 与收藏 / 反馈同构：**同一个工厂同时产出「进程级仓储」与「事务内仓储」**——
 * 传 `withTransaction` 给出的 `TxHandle` 进来，它就和同一事务里的其它读共享
 * 同一条连接、同一个快照，调用方**不需要换一套 API**。
 */
export function createCompletionRepository(db: PgQueryable): CompletionRepository {
  return {
    async findCompletionById(id) {
      const rows = await db.query<CompletionRow>(
        `SELECT ${COLUMNS} FROM completion_submissions WHERE id = $1`,
        [id],
      );
      return rows[0] ? toCompletion(rows[0]) : null;
    },

    async findLatestCompletionByOrderId(orderId) {
      // 「最近一次」= 排序后取第一条，而不是「LIMIT 1 随便取一条」；
      // Mock 的 `[...values()].filter().sort()[0]` 就是这个语义。
      const rows = await db.query<CompletionRow>(
        `SELECT ${COLUMNS} FROM completion_submissions
          WHERE order_id = $1
          ORDER BY ${ORDER_BY_LATEST}
          LIMIT 1`,
        [orderId],
      );
      return rows[0] ? toCompletion(rows[0]) : null;
    },

    async findLatestCompletionByOrderIdAndCompanionId(orderId, companionId) {
      // ⚠️ 与上一个方法刻意分成两次查询，不是重复：打手详情的摘要必须只回
      // **当前履约人自己**的那一份，否则换人之后新打手会看到上一位打手的驳回原因。
      const rows = await db.query<CompletionRow>(
        `SELECT ${COLUMNS} FROM completion_submissions
          WHERE order_id = $1 AND companion_id = $2
          ORDER BY ${ORDER_BY_LATEST}
          LIMIT 1`,
        [orderId, companionId],
      );
      return rows[0] ? toCompletion(rows[0]) : null;
    },

    async listCompletionsForStaff(filter) {
      // `status === null` 表示不限状态。把 null 当参数传进去、用 `$1::text IS NULL`
      // 短路，而不是在 JS 里拼两段 SQL——两段 SQL 迟早会在其中一段漏掉排序兜底。
      const rows = await db.query<CompletionRow>(
        `SELECT ${COLUMNS}
           FROM completion_submissions
          WHERE $1::text IS NULL OR status = $1
          ORDER BY ${ORDER_BY_LATEST}`,
        [filter.status],
      );
      return rows.map(toCompletion);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、
 * 不建池。理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCompletionRepository: CompletionRepository = createCompletionRepository(
  lazyPgExecutor(),
);
