import type { PageResult } from "@/lib/types/common";
import type { Suggestion } from "@/lib/types/suggestion";
import type { CreateSuggestionOutcome, SuggestionRepository } from "../suggestionRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `SuggestionRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**，服务层 `createSuggestionForUser` 一个字都不用改。
 *
 * ## 这一版真正要消灭的东西：服务层的「先查幂等键、再创建」
 *
 *     const byKey = await repository.findSuggestionByKey(userId, idempotencyKey);
 *     if (byKey) return { suggestionId: byKey.id, created: false };
 *     const outcome = await repository.createSuggestion(…);
 *
 * 那个 `await` 就是竞态窗口：快速连点、网络重试、并发提交都会双双查空、双双创建。
 * 服务层那次查询**本来只是快路径**（命中就直接返回上一次的结果），
 * 真正的防重必须落在数据库上——`UNIQUE (user_id, idempotency_key)`。
 *
 * 写入侧因此是**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**：
 * 由索引决定这次是新建还是命中，代码不参与判断。
 *
 * ## 预置数据没有幂等键（与 Mock 严格对齐）
 *
 * `idempotency_key` 可空，预置数据写 NULL——`mockSuggestionRepository.createStore()`
 * 也不把种子放进 `suggestionIdByKey`。两个实现对同一份种子的行为因此**完全一致**：
 * 用任何键去查都查不到预置的那几条。理由详见 `db/migrations/0002_suggestions.sql`。
 *
 * ## 时间与 JSON
 *
 * `replied_at` / `created_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成
 * ISO 字符串或 null；`evidence` 是 `jsonb`，驱动直接解析成 JS 值。
 */

type SuggestionRow = {
  id: string;
  user_id: string;
  type_key: Suggestion["typeKey"];
  type_label: string;
  content: string;
  contact: string;
  evidence: unknown;
  status: Suggestion["status"];
  reply: string;
  replied_at: string | null;
  created_at: string;
};

const COLUMNS =
  "id, user_id, type_key, type_label, content, contact, evidence, status, reply, replied_at, created_at";

const INSERT_COLUMNS =
  "id, user_id, type_key, type_label, content, contact, evidence, status, reply, replied_at, created_at, idempotency_key";

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    userId: row.user_id,
    typeKey: row.type_key,
    typeLabel: row.type_label,
    content: row.content,
    contact: row.contact,
    // jsonb 由驱动解析；万一手工改库把这一列写成了对象，宁可退化成空数组，
    // 也不要让一条脏数据在 DTO 层把整个列表打崩（收藏列表的 `missing` 是同一种态度）
    evidence: Array.isArray(row.evidence) ? (row.evidence as Suggestion["evidence"]) : [],
    status: row.status,
    reply: row.reply,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
  };
}

function insertValues(suggestion: Suggestion, idempotencyKey: string | null): unknown[] {
  return [
    suggestion.id,
    suggestion.userId,
    suggestion.typeKey,
    suggestion.typeLabel,
    suggestion.content,
    suggestion.contact,
    JSON.stringify(suggestion.evidence),
    suggestion.status,
    suggestion.reply,
    suggestion.repliedAt,
    suggestion.createdAt,
    idempotencyKey,
  ];
}

/**
 * 用任意可执行 SQL 的对象造一个反馈仓储。
 *
 * 与收藏同构：**一个工厂产出普通仓储与事务内仓储两种**，接口完全相同。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「提交反馈」与同一事务里的
 * 其它写入共享同一个提交点。
 */
export function createSuggestionRepository(db: PgQueryable): SuggestionRepository {
  async function findSuggestionByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<Suggestion | null> {
    // `idempotency_key = $2` 永远匹配不到 NULL，预置数据因此与 Mock 行为一致
    const rows = await db.query<SuggestionRow>(
      `SELECT ${COLUMNS} FROM suggestions WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toSuggestion(rows[0]) : null;
  }

  async function countSuggestions(userId: string): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM suggestions WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.total ?? 0;
  }

  return {
    findSuggestionByKey,

    async querySuggestions({ userId, page, pageSize }): Promise<PageResult<Suggestion>> {
      const start = (page - 1) * pageSize;

      // 与收藏同理：total 与当前页在同一条语句里取，共用一个快照
      const rows = await db.query<SuggestionRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM suggestions
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, pageSize, start],
      );

      const total = rows.length > 0 ? rows[0].total : page > 1 ? await countSuggestions(userId) : 0;
      const items = rows.map(toSuggestion);

      return {
        items,
        page,
        pageSize,
        total,
        hasMore: start + items.length < total,
      };
    },

    async createSuggestion(suggestion, idempotencyKey): Promise<CreateSuggestionOutcome> {
      const placeholders = Array.from({ length: 12 }, (_, index) => `$${index + 1}`).join(", ");
      const values = insertValues(suggestion, idempotencyKey);

      // 最多两轮：第二轮只在「冲突命中后、读回之前，那行被并发删掉」时发生
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<SuggestionRow>(
          `INSERT INTO suggestions (${INSERT_COLUMNS})
           VALUES (${placeholders})
           ON CONFLICT (user_id, idempotency_key) DO NOTHING
           RETURNING ${COLUMNS}`,
          values,
        );
        if (inserted[0]) return { suggestion: toSuggestion(inserted[0]), created: true };

        const existing = await findSuggestionByKey(suggestion.userId, idempotencyKey);
        if (existing) return { suggestion: existing, created: false };

        // 既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `反馈写入在并发下未能收敛（用户 ${suggestion.userId} / 幂等键 ${idempotencyKey}）。`,
      );
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgSuggestionRepository: SuggestionRepository =
  createSuggestionRepository(lazyPgExecutor());
