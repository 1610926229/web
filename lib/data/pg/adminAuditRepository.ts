import type { ActorRole } from "@/lib/types/actor";
import type {
  AdminAuditAction,
  AdminAuditEntry,
  AdminAuditSnapshot,
  AdminAuditTargetType,
} from "@/lib/types/adminAudit";
import type { AdminAuditQuery, AdminAuditRepository } from "../adminAuditRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
import { jsonbParam } from "./w1Rows";

/**
 * `AdminAuditRepository` 的 PostgreSQL 实现（PROD-1C）。
 *
 * ## 与其它仓储不同的一点：它**既读又写**
 *
 * `lib/data/adminAuditRepository.ts` 的接口上仍然**一个写方法都没有**——
 * 那条纪律是对的，写入口只有一处。但与 Mock 侧不同的是，Pg 侧的写入口
 * `appendAuditEntryTx` **在这个文件里**，而不是在某个事务模块里：它必须与
 * 「读账本做重放判定」住在同一个文件，因为两者操作的是同一张表、同一组列，
 * 分散两处迟早会让 `SELECT` 的列与 `INSERT` 的列各自演化。
 *
 * ## 重放判定是**事务内**的读
 *
 * `readAuditEntryByOperationIdTx` 与 `appendAuditEntryTx` 都收 `PgQueryable`，
 * 因此它们既能在 `withTransaction` 的 `TxHandle` 上跑，也能在进程级执行器上跑。
 * 事务内那一条才是要紧的：**判定与写入必须共享同一条连接、同一个提交点**，
 * 否则读到的账本可能是另一个事务尚未提交的状态。
 *
 * ## 驱动**不能**调 `writeAudit`
 *
 * `lib/data/adminWriteSupport.ts` 的 `writeAudit` 末尾会 `appendAuditEntry(...)`，
 * 即写进**进程内的 Mock store**。Pg 事务里调它等于同一件事被同时写进两个存储。
 * 因此这里复用同一份**拼装函数** `buildAuditEntry`（纯函数），
 * 把结果交给 `INSERT INTO admin_audit_entries`。
 *
 * ## 排序必须完全确定
 *
 * Mock 按 Map 的插入顺序读出（= 发生顺序）。SQL 的 `ORDER BY` 没有稳定排序保证，
 * 同刻的两条必须由 `id` 兜底——否则「这份申请经历过什么」两次问出不同顺序。
 *
 * ## 时间与 jsonb
 *
 * `created_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成 ISO 字符串，
 * 因此 `AdminAuditEntry.createdAt` 仍然是 `string`，与 Mock 一致。
 * `before` / `after` 是 `jsonb`，驱动**直接返回已解析的 JS 对象**，
 * 因此映射时直接赋值，**不做 `JSON.parse`**。
 */

export type AdminAuditRow = {
  id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_name: string | null;
  action: AdminAuditAction;
  target_type: AdminAuditTargetType;
  target_id: string;
  /** jsonb：可为 SQL NULL（新建类动作在写入前没有「之前」）。 */
  before: AdminAuditSnapshot | null;
  /** jsonb：同上。 */
  after: AdminAuditSnapshot | null;
  operation_id: string;
  created_at: string;
};

export const ADMIN_AUDIT_COLUMNS =
  "id, actor_id, actor_role, actor_name, action, target_type, target_id, before, after, " +
  "operation_id, created_at";

export function toAdminAuditEntry(row: AdminAuditRow): AdminAuditEntry {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    // jsonb 已由驱动解析，直接赋值
    before: row.before,
    // 同上
    after: row.after,
    operationId: row.operation_id,
    createdAt: row.created_at,
  };
}

/**
 * jsonb 列的入参。**真值源在 `w1Rows.ts`**（那里写着为什么 `null` 不能
 * `JSON.stringify` 成 `"null"`）。PROD-1C 收拢过去，免得同一个坑在两个文件里
 * 各有一份「注意别写错」的注释、各自演化。
 */

// ——————————————————————— 事务内原语（读写各一） ———————————————————————

/**
 * 按幂等键读一条审计（**事务内**）。
 *
 * ⚠️ 这是 `takeReplay` / `takeReplayForAction` 在 Pg 侧的**唯一**读点，
 * 与 Mock 侧 `findAuditEntryByOperationId` 一一对应。
 *
 * ⚠️ **必须在取到竞争行锁之后调用**：两个并发请求若都先读账本，会双双读空、
 * 双双写入，撞的就不是「重放」而是 `23505`。取锁之后读，第二个事务看到的是
 * 第一个已提交的账本——并发语义因此与 Mock 的单线程串行化一致。
 */
export async function readAuditEntryByOperationIdTx(
  db: PgQueryable,
  operationId: string,
): Promise<AdminAuditEntry | null> {
  const rows = await db.query<AdminAuditRow>(
    `SELECT ${ADMIN_AUDIT_COLUMNS} FROM admin_audit_entries WHERE operation_id = $1`,
    [operationId],
  );
  return rows[0] ? toAdminAuditEntry(rows[0]) : null;
}

/**
 * 写一条审计（**事务内**）。返回写入的那一条，便于调用方把它串进返回值。
 *
 * ⚠️ **不写 `ON CONFLICT DO NOTHING`**（与 `appendNotification` 同一条纪律）：
 * 同一个 `operation_id` 第二次到达在 PostgreSQL 里是 `23505` = **整段回滚**。
 * Mock 的 `appendAuditEntry` 会覆盖索引指向，这里**刻意更严**——
 * 一次审计被另一条记录顶掉，等于把「当时发生了什么」改写成另一件事。
 * 走到这里说明业务侧的幂等判定漏了一次，那正是应该当场炸出来的 bug。
 */
export async function appendAuditEntryTx(
  db: PgQueryable,
  entry: AdminAuditEntry,
): Promise<AdminAuditEntry> {
  await db.query(
    `INSERT INTO admin_audit_entries (${ADMIN_AUDIT_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
    [
      entry.id,
      entry.actorId,
      entry.actorRole,
      entry.actorName,
      entry.action,
      entry.targetType,
      entry.targetId,
      jsonbParam(entry.before),
      jsonbParam(entry.after),
      entry.operationId,
      entry.createdAt,
    ],
  );
  return entry;
}

// ————————————————————————— 只读仓储 —————————————————————————

/**
 * 查询条件 → `WHERE` 片段。三个轴都可选，可同时给。
 *
 * ⚠️ 与 Mock 的 `matches()` 逐条对齐：`targetType` / `targetId` / `action`
 * 各自独立，**互相不隐含**（例如只给 `targetId` 不带 `targetType` 是合法的）。
 */
function whereOf(query: AdminAuditQuery): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (query.targetType) {
    values.push(query.targetType);
    conditions.push(`target_type = $${values.length}`);
  }
  if (query.targetId) {
    values.push(query.targetId);
    conditions.push(`target_id = $${values.length}`);
  }
  if (query.action) {
    values.push(query.action);
    conditions.push(`action = $${values.length}`);
  }

  return {
    clause: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个审计仓储。
 *
 * 与其它 Pg 仓储同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储。
 */
export function createAdminAuditRepository(db: PgQueryable): AdminAuditRepository {
  return {
    async listAudits(query = {}) {
      const { clause, values } = whereOf(query);
      const rows = await db.query<AdminAuditRow>(
        `SELECT ${ADMIN_AUDIT_COLUMNS} FROM admin_audit_entries${clause}
          ORDER BY created_at ASC, id ASC`,
        values,
      );
      return rows.map(toAdminAuditEntry);
    },

    async findAuditByOperationId(operationId) {
      const rows = await db.query<AdminAuditRow>(
        `SELECT ${ADMIN_AUDIT_COLUMNS} FROM admin_audit_entries WHERE operation_id = $1`,
        [operationId],
      );
      return rows[0] ? toAdminAuditEntry(rows[0]) : null;
    },

    async countAudits() {
      // `count(*)` 在 PG 里返回 `bigint`，驱动默认解析成**字符串**。
      // 接口上 `countAudits` 承诺的是 `number`，因此这里显式转换——
      // 让一个字符串 `"3"` 漏出去，`assert.equal(await countAudits(), 3)` 会静默失败。
      const rows = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM admin_audit_entries`,
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 *
 * ⚠️ `lib/data/adminAuditRepository.ts` 的 `getAdminAuditRepository()`
 * **本轮仍然返回 Mock**：PROD-1C 不切数据源（见 Round 的 02-decisions）。
 * 这个常量因此**只有测试**在引用。
 */
export const pgAdminAuditRepository: AdminAuditRepository =
  createAdminAuditRepository(lazyPgExecutor());
