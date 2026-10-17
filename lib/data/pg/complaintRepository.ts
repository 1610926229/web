import type { ActorRole } from "@/lib/types/actor";
import type { PageResult } from "@/lib/types/common";
import type {
  Complaint,
  ComplaintStatus,
  ComplaintTypeKey,
} from "@/lib/types/complaint";
import type {
  AdminComplaintQueryFilter,
  ComplaintOrderStats,
  ComplaintRepository,
} from "../complaintRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `ComplaintRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/complaintRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 这一版真正要消灭的东西：Mock 的「读—判断—写」原子区段
 *
 * `mockComplaintRepository.createComplaint` 先查幂等键、查空才写。换成数据库后
 * 同样的写法会在两个并发请求之间留下空档 —— 用户连点两次「提交」会得到两条投诉。
 * 这里改成**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**：判重交给唯一索引
 * `complaints_user_idempotency_key` / `complaints_complaint_no_key`，冲突后回读。
 *
 * ## 时间与 JSON
 *
 * `created_at` 等 `timestamptz` 经 `pool.ts` 统一还原成 ISO 字符串，时间字段仍是 `string`。
 * `evidence` 是 `jsonb`，驱动**直接返回已解析的数组**，映射时直接赋值，**不做 `JSON.parse`**。
 *
 * ## 排序必须完全确定
 *
 * Mock 用稳定排序的 JS `Array.prototype.sort`，SQL 的 `ORDER BY` 不是。
 * 每个 `ORDER BY` 都补了 id 兜底 tie-break，并与两份比较器逐字段对齐：
 * 用户列表 / 订单联动用 `compareComplaintsNewestFirst`（时间倒序，id **降序**），
 * 管理端用 `compareComplaintsForAdmin`（时间倒序，id **升序**）。
 */

type ComplaintRow = {
  id: string;
  complaint_no: string;
  user_id: string;
  /** 可为 NULL：平台服务类投诉不关联订单。 */
  order_id: string | null;
  /** 订单号快照；与 order_id 一起可为 NULL。 */
  order_no: string | null;
  status: ComplaintStatus;
  type_key: ComplaintTypeKey;
  type_label: string;
  description: string;
  /** jsonb：驱动已解析成数组，直接取值。 */
  evidence: Complaint["evidence"];
  contact: string;
  created_at: string;
  updated_at: string;
  processing_at: string | null;
  handled_at: string | null;
  handled_by_id: string | null;
  handled_by_role: ActorRole | null;
  handled_by_name: string | null;
  result: string;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ **不含 `idempotency_key`**：它不是实体字段，Mock 里只活在 `complaintIdByKey`
 * 索引上（见 `mockComplaintRepository.ts`）。
 */
const COLUMNS =
  "id, complaint_no, user_id, order_id, order_no, status, type_key, type_label, " +
  "description, evidence, contact, created_at, updated_at, processing_at, handled_at, " +
  "handled_by_id, handled_by_role, handled_by_name, result";

/** 写入侧的列：相比 `COLUMNS` 多一个幂等键。 */
const INSERT_COLUMNS = `${COLUMNS}, idempotency_key`;

const INSERT_VALUE_COUNT = 20;

function toComplaint(row: ComplaintRow): Complaint {
  return {
    id: row.id,
    complaintNo: row.complaint_no,
    userId: row.user_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    status: row.status,
    typeKey: row.type_key,
    typeLabel: row.type_label,
    description: row.description,
    // jsonb 已由驱动解析，直接赋值
    evidence: row.evidence,
    contact: row.contact,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processingAt: row.processing_at,
    handledAt: row.handled_at,
    handledById: row.handled_by_id,
    handledByRole: row.handled_by_role,
    handledByName: row.handled_by_name,
    result: row.result,
  };
}

/**
 * jsonb 列的入参。`null` 原样交给驱动，不 `JSON.stringify`（理由见
 * `refundRepository.ts` 的同名函数）。`evidence` 是 NOT NULL 数组，这里只是保持通用。
 */
function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * 取值顺序**必须**与 `INSERT_COLUMNS` 逐位对应。
 *
 * ⚠️ `idempotencyKey` 在 `INSERT_COLUMNS` 里是**最后一个**（`COLUMNS` 的 19 列之后），
 * 因此这里也必须放最后。写成第 12 个值（`created_at` 的位置）不会在类型上暴露——
 * PG 运行时把 `"idem-1"` 往 `timestamptz` 里塞并抛 `22007`，而**只比读的契约测试看不见**。
 * `tests/pgContract.test.mjs` 的写侧用例是本条唯一护栏。
 */
function insertValues(complaint: Complaint, idempotencyKey: string): unknown[] {
  return [
    complaint.id,
    complaint.complaintNo,
    complaint.userId,
    complaint.orderId,
    complaint.orderNo,
    complaint.status,
    complaint.typeKey,
    complaint.typeLabel,
    complaint.description,
    jsonbParam(complaint.evidence),
    complaint.contact,
    complaint.createdAt,
    complaint.updatedAt,
    complaint.processingAt,
    complaint.handledAt,
    complaint.handledById,
    complaint.handledByRole,
    complaint.handledByName,
    complaint.result,
    idempotencyKey,
  ];
}

/**
 * 用任意可执行 SQL 的对象造一个投诉仓储。
 *
 * 与收藏 / 反馈 / 退款同构：**一个工厂同时产出普通仓储与事务内仓储**。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「创建投诉」与同一事务里的
 * 其它写入共享同一条连接、同一个提交点。
 */
export function createComplaintRepository(db: PgQueryable): ComplaintRepository {
  async function findComplaintByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<Complaint | null> {
    // `idempotency_key = $2` 永远匹配不到 NULL，预置数据（写 NULL）因此与 Mock 一致
    const rows = await db.query<ComplaintRow>(
      `SELECT ${COLUMNS} FROM complaints WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toComplaint(rows[0]) : null;
  }

  /** 越界页补一次计数。筛选条件必须与列表查询**逐条一致**，否则 total 会与 items 分叉。 */
  async function countComplaints(
    userId: string,
    status: ComplaintStatus | null,
  ): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM complaints
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)`,
      [userId, status],
    );
    return rows[0]?.total ?? 0;
  }

  return {
    async queryComplaints({ userId, status, page, pageSize }): Promise<PageResult<Complaint>> {
      const start = (page - 1) * pageSize;

      // total 与当前页在**同一条语句**里取（窗口函数），因此看到的是同一个快照——
      // 分两条语句查 count 与列表，中间被并发插入插一脚，hasMore 就会算错。
      const rows = await db.query<ComplaintRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM complaints
          WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4`,
        [userId, status, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total =
        rows.length > 0 ? rows[0].total : page > 1 ? await countComplaints(userId, status) : 0;
      const items = rows.map(toComplaint);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    async findComplaintById(id) {
      const rows = await db.query<ComplaintRow>(
        `SELECT ${COLUMNS} FROM complaints WHERE id = $1`,
        [id],
      );
      return rows[0] ? toComplaint(rows[0]) : null;
    },

    findComplaintByKey,

    async createComplaint(complaint, idempotencyKey) {
      const placeholders = Array.from(
        { length: INSERT_VALUE_COUNT },
        (_, index) => `$${index + 1}`,
      ).join(", ");
      const values = insertValues(complaint, idempotencyKey);

      // 最多两轮：第二轮只在「冲突命中后、读回之前，那行被并发删掉」时发生
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<ComplaintRow>(
          `INSERT INTO complaints (${INSERT_COLUMNS})
           VALUES (${placeholders})
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          values,
        );
        if (inserted[0]) return { complaint: toComplaint(inserted[0]), created: true };

        const existing = await findComplaintByKey(complaint.userId, idempotencyKey);
        if (existing) return { complaint: existing, created: false };

        // 既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `投诉写入在并发下未能收敛（用户 ${complaint.userId} / 幂等键 ${idempotencyKey}）。`,
      );
    },

    async summarizeComplaintsByOrder(orderId): Promise<ComplaintOrderStats> {
      // 与 Mock 同构：把这一单的投诉全取出来按最新在前排，count = 行数、latest = 第一行。
      // 用窗口函数在**同一条语句**里拿到总数，不必再发一次 count 查询。
      const rows = await db.query<ComplaintRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM complaints
          WHERE order_id = $1
          ORDER BY created_at DESC, id DESC`,
        [orderId],
      );

      return {
        count: rows[0]?.total ?? 0,
        latest: rows[0] ? toComplaint(rows[0]) : null,
      };
    },

    async listComplaintsByOrderId(orderId) {
      const rows = await db.query<ComplaintRow>(
        `SELECT ${COLUMNS} FROM complaints
          WHERE order_id = $1
          ORDER BY created_at DESC, id DESC`,
        [orderId],
      );
      return rows.map(toComplaint);
    },

    async queryComplaintsForAdmin(filter: AdminComplaintQueryFilter) {
      const { statuses } = filter;
      // 与 `compareComplaintsForAdmin` 对齐：提交时间倒序，同一时间按 **id 升序** 兜底。
      // 筛选条件按需拼接，避免为「不限」造一个恒真分支。
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (statuses !== null) {
        clauses.push(`status = ANY($${params.length + 1}::text[])`);
        params.push([...statuses]);
      }
      if (filter.type !== null) {
        clauses.push(`type_key = $${params.length + 1}`);
        params.push(filter.type);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

      const rows = await db.query<ComplaintRow>(
        `SELECT ${COLUMNS} FROM complaints ${where} ORDER BY created_at DESC, id ASC`,
        params,
      );
      return rows.map(toComplaint);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgComplaintRepository: ComplaintRepository =
  createComplaintRepository(lazyPgExecutor());

// ——————————————————————— 事务内原语（PROD-1D） ———————————————————————

/**
 * 取一条投诉并**锁住它**（`SELECT … FOR UPDATE`），供管理端处理事务使用。
 *
 * ⚠️ 与 `adminAuditTransactions.ts` 的 `lockRefund` 同形：这是投诉处理路径的
 * **唯一一把锁**。状态机判定、写入与审计全部发生在持有这把锁的区间里，
 * 因此两个管理员同时点「开始处理」时，第二个会先等第一个提交，
 * 再看到 `processing` 而不是也把它推一遍。
 *
 * ⚠️ 返回 `null` 表示这条投诉不存在，调用方据此返回 `not-found`——
 * **不是**「锁拿到了但是空的」。
 *
 * ⚠️ 复用本文件的 `COLUMNS` / `ComplaintRow` / `toComplaint`，不在事务模块里
 * 另写一份行映射：列名与字段名的对应只有一处定义，少写一列会在读侧暴露，
 * 而不是变成一个静默的 `undefined`。
 */
export async function lockComplaintTx(
  db: PgQueryable,
  id: string,
): Promise<Complaint | null> {
  const rows = await db.query<ComplaintRow>(
    `SELECT ${COLUMNS} FROM complaints WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toComplaint(rows[0]) : null;
}

/** 处理动作写入器的入参。含义与 `mockComplaintRepository.applyComplaintStatus` 的同名入参逐条相同。 */
export type ComplaintStatusWriteInput = {
  at: string;
  result: string;
  actorId: string;
  actorRole: ActorRole;
  actorName: string | null;
};

/**
 * 「开始处理 / 解决 / 关闭」三个动作的投诉写入器 ——
 * `mockComplaintRepository.applyComplaintStatus` 的 Pg 版本。
 *
 * ## 写哪几列，逐条照抄 Mock
 *
 * | 目标状态 | 这次**写**的列 | 其余列 |
 * |---|---|---|
 * | `processing` | `status` / `updated_at` / `processing_at` | 一律保持原值 |
 * | `resolved` / `closed` | `status` / `updated_at` / `handled_at` / `handled_by_id` / `handled_by_role` / `handled_by_name` / `result` | `processing_at` 保持原值 |
 *
 * ⚠️ **`result` 只在后两个动作写**。`start-processing` 分支里连 `result` 这个 SQL
 * 参数都不存在——这不是「传进来但没写」，而是那一条语句里根本没有这一列。
 * 与 Mock 的「`start-processing` 时连读都不读 `result`」结构上等价：
 * 提交上来的文本不可能变成一条「处理中但已经有结果」的记录。
 *
 * ⚠️ **窄写入，不是整行 `UPDATE`**。整行写会把 `description` / `evidence` /
 * `contact` / `orderId` / `userId` / `complaintNo` 这些**本次动作根本不碰**的列
 * 也写一遍，而它们的值来自锁下读到的那一份——一旦将来有人在这两条语句之间插进
 * 第三个写者（今天没有），整行写就会把别人的改动覆盖回去，且**不会报错**。
 * 用户提交的原始材料因此结构上不可被这条路径覆盖（§投诉处理）。
 *
 * ⚠️ 入参 `complaint` 必须是**取锁之后读到的**那一份：`processing_at` 在
 * `resolved` / `closed` 分支是「保持原值」，传一个陈旧快照进来，那个「原值」就是错的。
 *
 * ⚠️ 与 Mock 一样**只负责写**，不判断这次迁移合不合法——合法性由调用方在
 * 同一把锁下判（`canTransitionComplaint`）。
 */
export async function applyComplaintStatusTx(
  db: PgQueryable,
  complaint: Complaint,
  to: Extract<ComplaintStatus, "processing" | "resolved" | "closed">,
  input: ComplaintStatusWriteInput,
): Promise<{ previous: Complaint; updated: Complaint }> {
  const previous = { ...complaint };
  const settled = to === "resolved" || to === "closed";

  // 与 Mock 逐字段相同：`settled` 为假时六个字段都取「原值」——
  // 它们的值正是锁下读到的那一份，因此「保持原值」在这里是精确的
  const updated: Complaint = {
    ...complaint,
    status: to,
    updatedAt: input.at,
    processingAt: to === "processing" ? input.at : complaint.processingAt,
    handledAt: settled ? input.at : complaint.handledAt,
    handledById: settled ? input.actorId : complaint.handledById,
    handledByRole: settled ? input.actorRole : complaint.handledByRole,
    handledByName: settled ? input.actorName : complaint.handledByName,
    result: settled ? input.result : complaint.result,
  };

  if (settled) {
    await db.query(
      `UPDATE complaints
          SET status = $2,
              updated_at = $3,
              handled_at = $4,
              handled_by_id = $5,
              handled_by_role = $6,
              handled_by_name = $7,
              result = $8
        WHERE id = $1`,
      [
        complaint.id,
        updated.status,
        updated.updatedAt,
        updated.handledAt,
        updated.handledById,
        updated.handledByRole,
        updated.handledByName,
        updated.result,
      ],
    );
  } else {
    // 开始处理：只有这三列。`handled_*` 与 `result` 不出现在这条语句里，
    // 因此「处理中」的记录不可能带着处理人或处理结果（与 Mock 同）
    await db.query(
      `UPDATE complaints
          SET status = $2,
              updated_at = $3,
              processing_at = $4
        WHERE id = $1`,
      [complaint.id, updated.status, updated.updatedAt, updated.processingAt],
    );
  }

  return { previous, updated };
}
