import type { ActorRole } from "@/lib/types/actor";
import type { SupportEvidence } from "@/lib/types/evidence";
import type {
  RefundDecision,
  RefundReasonKey,
  RefundRequest,
  RefundStatus,
} from "@/lib/types/refund";
import type {
  AdminRefundQueryFilter,
  CancelRefundOutcome,
  CreateRefundOutcome,
  RefundRepository,
} from "../refundRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `RefundRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/refundRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。这是 PROD-1B 对 W1 写闭包的等价翻译。
 *
 * ## 这一版真正要消灭的东西：Mock 的「读—判断—写」原子区段
 *
 * `mockRefundRepository.createRefundRequest` 靠的是「Node 单线程 + 区段内没有 await」：
 * 它先查幂等键、再查这一单有没有申请，两次都查空才写。换成数据库后同样的写法
 * （先 `SELECT`、没有再 `INSERT`）会在两个并发请求之间留下空档，两边都查到「没有」
 * 然后都写 —— 一个订单会冒出两条退款申请。
 *
 * 这里改成**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**：判重的职责从
 * 「先读一次再决定」搬到了**唯一索引**上（`refund_requests_order_key` /
 * `refund_requests_user_idempotency_key` / `refund_requests_refund_no_key`）。
 * 冲突时再回读，读到的已经是索引替我们保住的那一行。
 *
 * ## 时间与 JSON
 *
 * `created_at` 等 `timestamptz` 经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串，
 * 因此领域对象上的时间字段仍然是 `string`，Mock 里那套字典序比较原样成立。
 * `decision` / `evidence` 是 `jsonb`，驱动**直接返回已解析的 JS 对象**，
 * 所以映射时直接赋值，**不做 `JSON.parse`**。
 *
 * ## 排序必须完全确定
 *
 * Mock 用 JS `Array.prototype.sort`（稳定排序），SQL 的 `ORDER BY` 不是。
 * 每个 `ORDER BY` 都补了 id 兜底 tie-break，与 `compareRefundsForAdmin` 逐字段对齐。
 */

type RefundRow = {
  id: string;
  refund_no: string;
  user_id: string;
  order_id: string;
  status: RefundStatus;
  amount: number;
  /** jsonb：未决策时为 SQL NULL，映射后仍是领域里的 `null`（不是零值决策）。 */
  decision: RefundDecision | null;
  reason_key: RefundReasonKey;
  reason_label: string;
  description: string;
  /** jsonb：驱动已解析成数组，直接取值。 */
  evidence: SupportEvidence[];
  created_at: string;
  updated_at: string;
  reviewing_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewed_by_role: ActorRole | null;
  reviewed_by_name: string | null;
  review_note: string;
  cancelled_at: string | null;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ **不含 `idempotency_key`**：它不是实体字段，Mock 里只活在
 * `refundIdByKey` 索引上（见 `mockRefundRepository.ts`）。读侧把它带出来
 * 会让「幂等键是索引、不是数据」这件事在类型上说不清。
 */
const COLUMNS =
  "id, refund_no, user_id, order_id, status, amount, decision, reason_key, reason_label, " +
  "description, evidence, created_at, updated_at, reviewing_at, reviewed_at, reviewed_by, " +
  "reviewed_by_role, reviewed_by_name, review_note, cancelled_at";

/** 写入侧的列：相比 `COLUMNS` 多一个幂等键。 */
const INSERT_COLUMNS = `${COLUMNS}, idempotency_key`;

const INSERT_VALUE_COUNT = 21;

function toRefund(row: RefundRow): RefundRequest {
  return {
    id: row.id,
    refundNo: row.refund_no,
    userId: row.user_id,
    orderId: row.order_id,
    status: row.status,
    amount: row.amount,
    // jsonb 已由驱动解析：`decision` 直接就是 RefundDecision 或 null
    decision: row.decision,
    reasonKey: row.reason_key,
    reasonLabel: row.reason_label,
    description: row.description,
    // jsonb 同上，直接赋值
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewingAt: row.reviewing_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewedByRole: row.reviewed_by_role,
    reviewedByName: row.reviewed_by_name,
    reviewNote: row.review_note,
    cancelledAt: row.cancelled_at,
  };
}

/**
 * jsonb 列的入参。
 *
 * ⚠️ `null` 必须**原样**交给驱动，不能 `JSON.stringify(null)`：后者得到字符串
 * `"null"`，PG 会解析成 JSON 的 null 值而不是 SQL NULL，两者在 `IS NULL` 下结果相反。
 */
function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * 取值顺序**必须**与 `INSERT_COLUMNS` 逐位对应。
 *
 * ⚠️ `idempotencyKey` 在 `INSERT_COLUMNS` 里是**最后一个**（`COLUMNS` 的 20 列之后），
 * 因此这里也必须放最后。把它写成第 12 个值（正好是 `created_at` 的位置）不会报错在
 * 类型检查上——PG 会在运行时把字符串 `"idem-1"` 塞进 `timestamptz` 并抛 `22007`，
 * 而**只比读的契约测试看不见**。`tests/pgContract.test.mjs` 的写侧用例是本条唯一护栏。
 */
function insertValues(refund: RefundRequest, idempotencyKey: string): unknown[] {
  return [
    refund.id,
    refund.refundNo,
    refund.userId,
    refund.orderId,
    refund.status,
    refund.amount,
    jsonbParam(refund.decision),
    refund.reasonKey,
    refund.reasonLabel,
    refund.description,
    jsonbParam(refund.evidence),
    refund.createdAt,
    refund.updatedAt,
    refund.reviewingAt,
    refund.reviewedAt,
    refund.reviewedBy,
    refund.reviewedByRole,
    refund.reviewedByName,
    refund.reviewNote,
    refund.cancelledAt,
    idempotencyKey,
  ];
}

/**
 * 用任意可执行 SQL 的对象造一个退款仓储。
 *
 * 与 `createFavoriteRepository` 同构：**一个工厂同时产出普通仓储与事务内仓储**。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「创建退款申请」与同一事务里的
 * 其它写入共享同一条连接、同一个提交点。
 */
export function createRefundRepository(db: PgQueryable): RefundRepository {
  async function findRefundByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<RefundRequest | null> {
    // `idempotency_key = $2` 永远匹配不到 NULL，因此预置数据（写 NULL）在 PG 里
    // 与 Mock 行为一致：按任何幂等键都查不到。
    const rows = await db.query<RefundRow>(
      `SELECT ${COLUMNS} FROM refund_requests WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toRefund(rows[0]) : null;
  }

  return {
    async findRefundById(id) {
      const rows = await db.query<RefundRow>(
        `SELECT ${COLUMNS} FROM refund_requests WHERE id = $1`,
        [id],
      );
      return rows[0] ? toRefund(rows[0]) : null;
    },

    findRefundByKey,

    async findRefundByOrderId(orderId) {
      // Mock 取列表尾（= 最新一条）。P0-15 之后一单最多一条（`UNIQUE (order_id)`），
      // 「最新」与「唯一那条」是同一个元素；这里按时间倒序取一条并补 id tie-break。
      const rows = await db.query<RefundRow>(
        `SELECT ${COLUMNS} FROM refund_requests
          WHERE order_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [orderId],
      );
      return rows[0] ? toRefund(rows[0]) : null;
    },

    async listRefundsByOrderId(orderId) {
      // Mock 的 `refundIdsByOrder` 按创建先后排列，这里按 `created_at ASC, id ASC`
      // 对齐。P0-15 之后长度恒为 0 或 1，顺序只是把契约写死。
      const rows = await db.query<RefundRow>(
        `SELECT ${COLUMNS} FROM refund_requests
          WHERE order_id = $1
          ORDER BY created_at ASC, id ASC`,
        [orderId],
      );
      return rows.map(toRefund);
    },

    async createRefundRequest(refund, idempotencyKey): Promise<CreateRefundOutcome> {
      const placeholders = Array.from(
        { length: INSERT_VALUE_COUNT },
        (_, index) => `$${index + 1}`,
      ).join(", ");
      const values = insertValues(refund, idempotencyKey);

      // 最多两轮。第二轮只在「冲突命中后、读回之前，那行被并发删掉」时才会发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<RefundRow>(
          `INSERT INTO refund_requests (${INSERT_COLUMNS})
           VALUES (${placeholders})
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          values,
        );
        if (inserted[0]) return { ok: true, refund: toRefund(inserted[0]), created: true };

        // 冲突命中后回读。判据与 Mock 的检查顺序**一致**：
        // 1) 幂等键命中 → 幂等返回既有记录（快速连点 / 网络重试）
        const byKey = await findRefundByKey(refund.userId, idempotencyKey);
        if (byKey) return { ok: true, refund: byKey, created: false };

        // 2) 这一单已有申请 → 拒绝创建（P0-15：一单一退，任何状态都挡）。
        //    唯一索引 `refund_requests_order_key` 才是这条规则的真正守护者，
        //    服务层那次同口径检查只是提前给出可读的错误信息。
        const existingForOrder = await db.query<RefundRow>(
          `SELECT ${COLUMNS} FROM refund_requests
            WHERE order_id = $1
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
          [refund.orderId],
        );
        if (existingForOrder[0]) {
          return {
            ok: false,
            reason: "order_already_has_refund",
            existing: toRefund(existingForOrder[0]),
          };
        }

        // 走到这里说明既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `退款写入在并发下未能收敛（用户 ${refund.userId} / 订单 ${refund.orderId}）。`,
      );
    },

    async cancelRefund(id, userId, cancelledAt): Promise<CancelRefundOutcome> {
      // 一条语句完成「归属 + 状态」判定与写入：WHERE 里同时要求
      // `user_id` 与 `status = 'pending'`，因此不存在「先查到是你的、写之前状态变了」的窗口。
      // 不属于当前用户的申请一律按 not_found 处理，避免用来试探别人退款申请的存在。
      const updated = await db.query<RefundRow>(
        `UPDATE refund_requests
            SET status = 'cancelled', cancelled_at = $3, updated_at = $3
          WHERE id = $1 AND user_id = $2 AND status = 'pending'
          RETURNING ${COLUMNS}`,
        [id, userId, cancelledAt],
      );
      if (updated[0]) return { ok: true, refund: toRefund(updated[0]) };

      // 没更新到行：区分「不存在 / 不属于你」（not_found）与「状态不允许撤销」（not_cancellable）。
      // 只读一列，诊断失败原因，不参与任何写入决策。
      const found = await db.query<{ status: RefundStatus }>(
        `SELECT status FROM refund_requests WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (found[0]) return { ok: false, reason: "not_cancellable" };
      return { ok: false, reason: "not_found" };
    },

    async queryRefundsForAdmin(filter: AdminRefundQueryFilter) {
      const { statuses } = filter;
      // 与 `compareRefundsForAdmin` 对齐：申请时间倒序，同一时间按 **id 升序** 兜底。
      if (statuses === null) {
        const rows = await db.query<RefundRow>(
          `SELECT ${COLUMNS} FROM refund_requests ORDER BY created_at DESC, id ASC`,
        );
        return rows.map(toRefund);
      }

      const rows = await db.query<RefundRow>(
        `SELECT ${COLUMNS} FROM refund_requests
          WHERE status = ANY($1::text[])
          ORDER BY created_at DESC, id ASC`,
        [[...statuses]],
      );
      return rows.map(toRefund);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgRefundRepository: RefundRepository = createRefundRepository(lazyPgExecutor());
