import type { Companion } from "@/lib/types/companion";
import type { CompanionRepository } from "../companionRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `companions` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，**不在这里再写一份**：
// 本轮接单事务（`w1Transactions.ts`）也要读这张表。列名要的是**数组**——
// 下面生成 `UPDATE … RETURNING prev.x AS previous_x` 的成对列名时只能从数组来。
import {
  COMPANION_COLUMN_NAMES as COLUMN_NAMES,
  toCompanion,
  type CompanionRow,
} from "./w1Rows";

/**
 * `CompanionRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/companionRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 这一版真正要消灭的东西：SELECT-then-INSERT
 *
 * `mockCompanionRepository.createCompanion` 靠 `companionIdByUser` 这个 Map 保证
 * 「一名用户最多关联一条**有效**护航」。换成数据库后，「先查有没有、再 INSERT」
 * 会在两个并发请求之间留下空档：两边都查到「没有」，于是建出两条——而这正是
 * 重复审核通过、并发审核通过会走的路径。
 *
 * 这里改成**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**，判重的职责从
 * 「先读一次再决定」搬到了**部分唯一索引** `companions_user_active_key` 上
 * （`ON CONFLICT (user_id) WHERE removed_at IS NULL`）。冲突时读回既有记录，
 * 读到的已经是索引替我们选定并保住的那一行。
 *
 * ## 读方法的口径与索引严格对应
 *
 * | 方法 | 口径 | 对应 |
 * |---|---|---|
 * | `listCompanions` / `listCompanionsForAdmin` | 完整名单，含下架、含已移除 | 无 WHERE |
 * | `findCompanionByUser` | **有效**护航（已移除的不算） | 部分唯一索引的 WHERE |
 * | `queryCompanions` | 公开列表，下架与已移除都不出现 | `isCompanionListed()` |
 * | `queryCompanionsForAdmin` | 后台口径，全部记录都能查 | 无 |
 *
 * ⚠️ 分页**不在本层**：`queryCompanions` / `queryCompanionsForAdmin` 返回的是
 * 「哪些记录入选」，切片由服务层按 `page` / `pageSize` 做（与 Mock 一致，接口参数里
 * 也刻意不含分页）。
 *
 * ## 排序
 *
 * Mock 的列表查询用 JS `sort(compareCompanionsForList)`（稳定排序）：
 * `sortOrder` 升序、相等按 `id` 兜底。SQL 的 `ORDER BY` 不是稳定排序，
 * 因此这里**显式写出两级** `sort_order ASC, id ASC`——少写 `id` 兜底，
 * 同一条护航可能在第一页出现过、翻到第二页又出现一次。
 *
 * ## 时间类型
 *
 * `removed_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串
 * 或 null，因此 `Companion.removedAt` 仍然是 `string | null`，与 Mock 完全一致。
 */

const COLUMNS = COLUMN_NAMES.join(", ");

/** 三个字符串数组列。写入时用 `::jsonb` 转，读取时驱动直接解析成 JS 数组。 */
const JSONB_COLUMNS: ReadonlySet<string> = new Set(["game_ids", "regions", "service_tags"]);

const INSERT_COLUMNS = COLUMN_NAMES.join(", ");
const INSERT_PLACEHOLDERS = COLUMN_NAMES.map((name, index) => {
  const placeholder = `$${index + 1}`;
  return JSONB_COLUMNS.has(name) ? `${placeholder}::jsonb` : placeholder;
}).join(", ");

/**
 * 「改动前 / 改动后」两行在**同一条语句**里返回时，列名要加前缀区分。
 *
 * 为什么必须同一条语句：`updateCompanion` / `markCompanionRemoved` 的返回类型是
 * `{ previous, updated }`，两条语句（先查后改）中间隔着一次让出执行权，
 * 另一位管理员可以在那之间改掉同一行。用 `UPDATE … FROM companions AS prev` 自连，
 * 两条路径读的是**同一个命令快照**，因此 `prev.*` 必然是改动前的值。
 */
type PrefixedCompanionRow<Prefix extends "previous" | "updated"> = {
  [K in keyof CompanionRow as `${Prefix}_${K}`]: CompanionRow[K];
};

type CompanionPairRow = PrefixedCompanionRow<"previous"> & PrefixedCompanionRow<"updated">;

function prefixedReturning(alias: string, prefix: "previous" | "updated"): string {
  return COLUMN_NAMES.map((name) => `${alias}.${name} AS ${prefix}_${name}`).join(", ");
}

/** 更新语句固定返回「改动前（prev）+ 改动后（c）」两套列。 */
const UPDATE_RETURNING = `${prefixedReturning("prev", "previous")}, ${prefixedReturning("c", "updated")}`;

function toRowFromPair(pair: CompanionPairRow, prefix: "previous" | "updated"): CompanionRow {
  const row: Record<string, unknown> = {};
  for (const name of COLUMN_NAMES) {
    // 列名由同一个 COLUMN_NAMES 生成，因此不会漏列、也不会与 ALIAS 错位
    row[name] = pair[`${prefix}_${name}` as keyof CompanionPairRow];
  }
  return row as unknown as CompanionRow;
}

function pairFrom(pair: CompanionPairRow): { previous: Companion; updated: Companion } {
  return {
    previous: toCompanion(toRowFromPair(pair, "previous")),
    updated: toCompanion(toRowFromPair(pair, "updated")),
  };
}

/** 关键词命中的 SQL 等价式：昵称 / 自我介绍 / 服务标签三处任一**包含**即可。 */
function keywordCondition(param: string): string {
  // ⚠️ 用 `strpos` 而不是 `LIKE`：Mock 是纯子串包含，`LIKE` 会把关键词里的
  //    `%` / `_` 当成通配符，语义就变了。`strpos(x, '')` 恒为 1（命中），
  //    因此空关键词也会自然返回全部，与 Mock 的提前 return true 一致。
  // ⚠️ `btrim` 对齐 Mock 的 `keyword.trim()`：只去掉关键词首尾空格，字段侧不动。
  const needle = `lower(btrim(${param}))`;
  return `(strpos(lower(display_name), ${needle}) > 0
         OR strpos(lower(intro), ${needle}) > 0
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(service_tags) AS tag
               WHERE strpos(lower(tag), ${needle}) > 0
            ))`;
}

/**
 * 取值顺序**必须**与 `COMPANION_COLUMN_NAMES` 逐位对应（`INSERT_COLUMNS` 就是它 join 出来的）。
 *
 * ⚠️ 这里曾按**建表 DDL 的列序**写（`enabled` 在 `completed_order_count` 之前），
 * 而列清单用的是 `w1Rows.ts` 的顺序（`enabled` 在**最后**）。两者不一致的后果不是编译错，
 * 而是运行时把布尔值往 `integer` 列里塞 → `42804`；而**只比读的契约测试看不见**。
 * 顺序真值源只有一个：`COMPANION_COLUMN_NAMES`。
 */
function insertValues(companion: Companion): unknown[] {
  return [
    companion.id,
    companion.userId,
    companion.applicationId,
    companion.removedAt,
    companion.displayName,
    companion.avatarUrl,
    companion.rankLabel,
    companion.intro,
    JSON.stringify(companion.gameIds),
    JSON.stringify(companion.regions),
    JSON.stringify(companion.serviceTags),
    companion.available,
    companion.unavailableReason,
    companion.completedOrderCount,
    companion.tipsCount,
    companion.sortOrder,
    companion.enabled,
  ];
}

/**
 * 用任意可执行 SQL 的对象造一个护航仓储。
 *
 * 与收藏 / 反馈 / 派单同构：**一个工厂产出普通仓储与事务内仓储两种**，接口完全相同。
 * 审核通过要在一段事务里同时写「护航 + 申请 + 资格 + 审计」，那时把 `tx` 传进来即可，
 * 调用方不需要换一套 API。
 */
export function createCompanionRepository(db: PgQueryable): CompanionRepository {
  async function readActiveCompanionByUser(userId: string | null): Promise<Companion | null> {
    // `user_id = NULL` 永远匹配不到行；userId 为空的护航不占用「一人一条有效」的名额
    if (!userId) return null;
    const rows = await db.query<CompanionRow>(
      `SELECT ${COLUMNS} FROM companions WHERE user_id = $1 AND removed_at IS NULL`,
      [userId],
    );
    return rows[0] ? toCompanion(rows[0]) : null;
  }

  return {
    async listCompanions() {
      // 完整名单（含下架、含已移除）。`ORDER BY id` 是兜底：Mock 这里是 Map 插入顺序，
      // SQL 没有那层含义，不补排序则同一份数据两次查询顺序可能不同。
      const rows = await db.query<CompanionRow>(`SELECT ${COLUMNS} FROM companions ORDER BY id`);
      return rows.map(toCompanion);
    },

    async findCompanionById(id) {
      // ⚠️ **已移除的记录仍然取得到**（后台详情要看它），因此没有 removed_at 条件
      const rows = await db.query<CompanionRow>(`SELECT ${COLUMNS} FROM companions WHERE id = $1`, [
        id,
      ]);
      return rows[0] ? toCompanion(rows[0]) : null;
    },

    async findCompanionByUser(userId) {
      // 与 Mock 的 `companionIdByUser` 索引严格对应：只登记**未移除**的记录，
      // 移除时索引要消失（否则「移除后重新入驻」会被自己的历史记录挡住）。
      return readActiveCompanionByUser(userId);
    },

    async queryCompanions(query) {
      const { keyword, gameId, availability } = query;

      // 公开列表口径：下架与已移除都不出现（`isCompanionListed()` 的 SQL 等价式）
      const conditions = ["enabled = true", "removed_at IS NULL"];
      const params: unknown[] = [];

      if (gameId) {
        params.push(gameId);
        // jsonb 数组是否含某个字符串：`?` 是 jsonb 的「顶层键/元素存在」运算符
        conditions.push(`game_ids ? $${params.length}`);
      }

      if (availability === "available") conditions.push("available = true");
      else if (availability === "unavailable") conditions.push("available = false");

      if (keyword) {
        params.push(keyword);
        conditions.push(keywordCondition(`$${params.length}`));
      }

      const rows = await db.query<CompanionRow>(
        `SELECT ${COLUMNS} FROM companions
          WHERE ${conditions.join(" AND ")}
          ORDER BY sort_order ASC, id ASC`,
        params,
      );
      return rows.map(toCompanion);
    },

    async queryCompanionsForAdmin(query) {
      const { keyword, gameId, enabled, availability, removal } = query;

      // 后台口径：默认视图是「未移除的护航」，要看已移除的必须显式选
      const conditions: string[] = [
        removal === "removed" ? "removed_at IS NOT NULL" : "removed_at IS NULL",
      ];
      const params: unknown[] = [];

      if (enabled === "enabled") conditions.push("enabled = true");
      else if (enabled === "disabled") conditions.push("enabled = false");

      if (availability === "available") conditions.push("available = true");
      else if (availability === "unavailable") conditions.push("available = false");

      if (gameId) {
        params.push(gameId);
        conditions.push(`game_ids ? $${params.length}`);
      }

      if (keyword) {
        params.push(keyword);
        conditions.push(keywordCondition(`$${params.length}`));
      }

      const rows = await db.query<CompanionRow>(
        `SELECT ${COLUMNS} FROM companions
          WHERE ${conditions.join(" AND ")}
          ORDER BY sort_order ASC, id ASC`,
        params,
      );
      return rows.map(toCompanion);
    },

    async listCompanionsForAdmin() {
      const rows = await db.query<CompanionRow>(
        `SELECT ${COLUMNS} FROM companions ORDER BY sort_order ASC, id ASC`,
      );
      return rows.map(toCompanion);
    },

    async createCompanion(companion) {
      // 最多两轮。第二轮只在「冲突命中后、读回之前，那条有效记录被软移除」时才会发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<CompanionRow>(
          `INSERT INTO companions (${INSERT_COLUMNS})
           VALUES (${INSERT_PLACEHOLDERS})
           ON CONFLICT (user_id) WHERE removed_at IS NULL DO NOTHING
           RETURNING ${COLUMNS}`,
          insertValues(companion),
        );
        if (inserted[0]) return { kind: "created", companion: toCompanion(inserted[0]) };

        // 冲突：这位用户已经有一条**有效**护航。把索引替我们保住的那一行读回来，
        // 原样返回 `already-linked`——重复 / 并发审核通过走到这里都只会复用同一条。
        const existing = await readActiveCompanionByUser(companion.userId);
        if (existing) return { kind: "already-linked", companion: existing };

        // 那条记录在两步之间被软移除了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `护航写入在并发下未能收敛（用户 ${companion.userId ?? "null"} / 护航 ${companion.id}）。`,
      );
    },

    async updateCompanion(id, patch) {
      // 只覆盖 `patch` 里那些字段：统计、关联用户、来源申请、评价一律原样保留。
      // `userId` / `applicationId` / `removedAt` 不在 `CompanionProfilePatch` 里，
      // 因此「顺手改一下关联用户」在这里没有位置可写。
      //
      // `prev` 自连读的是同一个命令快照，因此 `RETURNING prev.*` 就是改动前的值；
      // `RETURNING c.*` 是改动后的值。两条一起返回，不需要第二次查询。
      const rows = await db.query<CompanionPairRow>(
        `UPDATE companions AS c
            SET display_name = $2,
                avatar_url = $3,
                intro = $4,
                game_ids = $5::jsonb,
                regions = $6::jsonb,
                service_tags = $7::jsonb,
                enabled = $8,
                available = $9,
                unavailable_reason = $10,
                sort_order = $11
           FROM companions AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${UPDATE_RETURNING}`,
        [
          id,
          patch.displayName,
          patch.avatarUrl,
          patch.intro,
          JSON.stringify(patch.gameIds),
          JSON.stringify(patch.regions),
          JSON.stringify(patch.serviceTags),
          patch.enabled,
          patch.available,
          patch.unavailableReason,
          patch.sortOrder,
        ],
      );
      return rows[0] ? pairFrom(rows[0]) : null;
    },

    async markCompanionRemoved(id, at) {
      // 软移除：只写 `removed_at`，**不删除记录**（历史订单、评价、鸡腿记录要指得到它）。
      //
      // `COALESCE(c.removed_at, $2)` 让「已经移除」成为**幂等**操作：
      // 原值非空时写回它自己（不刷新时间戳），此时 `previous` 与 `updated` 逐字段相同，
      // 调用方据此就不会写第二条审计——与 Mock 的 `previous === updated` 口径一致。
      // 行不存在时 UPDATE 命中 0 行，返回 null。
      const rows = await db.query<CompanionPairRow>(
        `UPDATE companions AS c
            SET removed_at = COALESCE(c.removed_at, $2)
           FROM companions AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${UPDATE_RETURNING}`,
        [id, at],
      );
      return rows[0] ? pairFrom(rows[0]) : null;
    },
  };
}

/**
 * 只改「能不能接单」那三个字段（**事务内窄写入器**，T8 用）。
 *
 * ⚠️ PROD-1C 新增，是 `mockCompanionRepository.applyCompanionFlags` 的 Pg 等价物。
 * 它**不是** `CompanionRepository` 上的方法：那个接口一个字没改，本函数只对
 * `adminAuditTransactions.ts` 的 T8 开放。
 *
 * ## 为什么不能复用上面的 `updateCompanion`
 *
 * `updateCompanion` 写的是**整份资料**（昵称、介绍、游戏、排序……）。
 * 「暂停接单」只应当改这三个字段——如果改成「先把整条记录读出来、拼一个完整 patch
 * 再调用编辑」，两位管理员同时操作时，后写的那次会把另一位刚改好的昵称**覆盖回旧值**，
 * 而那个读取发生在事务之外。窄写入器让这种覆盖在结构上不可能发生
 * （Mock 侧 `applyCompanionFlags` 的注释同此）。
 *
 * ## 为什么也要锁
 *
 * T8 的「这个幂等键做过没有」判定排在**取到这一行的锁之后**（见
 * `adminAuditTransactions.ts` 的说明）。不锁的话，两个并发请求会双双读空账本、
 * 双双写入，撞的是 `23505` 而不是正确地重放。因此这里先 `FOR UPDATE` 读一次当前行，
 * 由调用方在**这一步之后**再回读审计账本。
 *
 * 返回 `null` = 这一行不存在（调用方按不可能状态处理）。
 */
export async function lockCompanionForFlagsTx(
  db: PgQueryable,
  id: string,
): Promise<Companion | null> {
  const rows = await db.query<CompanionRow>(
    `SELECT ${COLUMNS} FROM companions WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toCompanion(rows[0]) : null;
}

/**
 * 写那三个字段。`previous` / `updated` 由同一条语句一起返回（理由见 `UPDATE_RETURNING`）。
 */
export async function applyCompanionFlagsTx(
  db: PgQueryable,
  id: string,
  flags: { enabled: boolean; available: boolean; unavailableReason: string },
): Promise<{ previous: Companion; updated: Companion } | null> {
  const rows = await db.query<CompanionPairRow>(
    `UPDATE companions AS c
        SET enabled = $2,
            available = $3,
            unavailable_reason = $4
       FROM companions AS prev
      WHERE c.id = $1 AND prev.id = $1
     RETURNING ${UPDATE_RETURNING}`,
    [id, flags.enabled, flags.available, flags.unavailableReason],
  );
  return rows[0] ? pairFrom(rows[0]) : null;
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgCompanionRepository: CompanionRepository =
  createCompanionRepository(lazyPgExecutor());
