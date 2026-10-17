import type {
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryIcon,
  QuickEntryRecord,
} from "@/lib/types/content";
import type {
  ContentAnnouncementPatch,
  ContentBannerPatch,
  ContentQuickEntryPatch,
  ContentRepository,
} from "../contentRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `ContentRepository` 的 PostgreSQL 实现（公告 / Banner / 快捷入口）。
 *
 * ## 为什么要有这一份
 *
 * PROD-1E Phase 1 要把首页运营内容的真值从 `globalThis` Mock store 搬到 PostgreSQL。
 * 上层（`lib/services/adminContent.ts`、页面、用户端首页）读的是同一个接口，
 * `lib/data/contentRepository.ts` 一个字都不改——两个实现在同一份输入下必须给出
 * 逐字段相同的输出（Phase 4：Mock 行为是迁移的语义基线）。
 *
 * ## 三张表，一套语义
 *
 * 三张表形状几乎相同，只是正文列不同（公告 / Banner 是「图片 + alt」，
 * 快捷入口是「图标枚举 + 站内路径」，见 `db/migrations/0012_operations_content.sql`）。
 * 因此下面把「读一条 / 列全部 / 插一条 / 覆盖式更新 / 只改 enabled / 软移除」
 * 六种动作抽成六个泛型 helper，每个表复用；`table` / `columns` 都是本文件内的
 * 字面量常量，**不存在 SQL 注入面**。
 *
 * ## 排序：与 Mock 逐条对齐
 *
 * Mock 的 `list*Records()` 是「遍历 Map 的插入顺序」，SQL 表是无序集合——
 * 同一份数据两次查询完全可能给出不同顺序。因此每个列表都补 `ORDER BY id`
 * （主键天然唯一，是最稳的兜底），与 `pgCompanionRepository.listCompanions()` 同一条理由。
 *
 * ⚠️ **业务排序不在这里**：`compareContentOrder`（`sortOrder` 升序、相同按 `id` 升序，
 * 用户端与管理端同一个全序）是纯函数，由调用方在拿到记录后做。仓储只保证
 * 「同一份数据每次返回的顺序是确定的」，不替调用方挑顺序——这正是
 * `contentRepository.ts` 里「未排序。排序在纯函数里做」那句话的落点。
 *
 * ## 时间与 JSON
 *
 * `created_at` / `updated_at` / `removed_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子
 * 统一还原成 ISO 字符串，因此实体里的时间字段仍然是 `string`（与 Mock 一致）。
 * 三张表都没有 jsonb 列。
 *
 * ## 「移除后还能不能改」不在这一层
 *
 * Mock 的 `applyProfile()`（本文件 `applyProfileRow` 的对齐对象）**不判断** `removedAt`：
 * 一条已移除的记录照样能被子层覆盖式更新并返回 `{ previous, updated }`；
 * 「已移除的不再接受编辑」是**事务层**的原子区段判的
 * （`lib/data/adminContentTransaction.ts` 的 `existing.removedAt !== null → removed`）。
 * 这里照抄同一行为，**不**自行加一条 removed 判断——加了就是业务漂移。
 */

/** 三类运营内容共有的列（`ManagedContentFields` 的落库形态）。 */
type ManagedRow = {
  id: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
};

type AnnouncementRow = ManagedRow & {
  title: string;
  image_url: string;
  alt: string;
};

type BannerRow = ManagedRow & {
  title: string;
  image_url: string;
  alt: string;
};

type QuickEntryRow = ManagedRow & {
  label: string;
  icon: QuickEntryIcon;
  path: string;
};

/** 公告列清单。`COLLATE "C"` 定义在列上，`ORDER BY id` 因此是字节序、跨环境一致。 */
const ANNOUNCEMENT_COLUMNS =
  "id, title, image_url, alt, enabled, sort_order, created_at, updated_at, removed_at";

/** Banner 与公告形状完全相同（迁移 0012 里两张表逐列同构）。 */
const BANNER_COLUMNS =
  "id, title, image_url, alt, enabled, sort_order, created_at, updated_at, removed_at";

/** 快捷入口：正文列是 `label` / `icon` / `path`。 */
const QUICK_ENTRY_COLUMNS =
  "id, label, icon, path, enabled, sort_order, created_at, updated_at, removed_at";

// ——————————————————————————— 行 → 实体 ———————————————————————————

function toAnnouncement(row: AnnouncementRow): ContentAnnouncementRecord {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    alt: row.alt,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

function toBanner(row: BannerRow): ContentBannerRecord {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    alt: row.alt,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

function toQuickEntry(row: QuickEntryRow): QuickEntryRecord {
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    path: row.path,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

// ——————————————————————————— 泛型读写原语 ———————————————————————————

/**
 * 新记录的 id。
 *
 * ⚠️ 契约（`lib/data/contentRepository.ts`：`createAnnouncement` 等）写明
 * **id 由调用方在原子区段内生成**，Mock 也是原样存 `record.id`
 * （`mockContentRepository.createAnnouncement` 的 `store().announcements.set(record.id, { ...record })`）。
 * 正常路径**必须原样采用**：仓储在这里换一个 id，调用方写进审计的 `targetId`
 * 就会与真实记录分叉，而契约测试（同一份输入问两个实现）也会立刻不一致。
 *
 * 只有调用方递进来一个空 id 时才按前缀现取兜底（类型上不可能，运行时存在）：
 * 公告 `an_`、Banner `bn_`、快捷入口 `qe_`（与 `adminContentTransaction.ts` 的
 * `ID_PREFIX` 同源）。空 id 在 Mock 里会被原样存成一个空字符串，
 * 那是一条坏记录，宁可现取一个合法 id。
 */
function resolveNewId(providedId: string, prefix: string): string {
  return providedId.length > 0 ? providedId : `${prefix}_${crypto.randomUUID()}`;
}

/**
 * 按 id 取一条，**含已移除的**（对齐 Mock 的 `Map.get`）。
 *
 * `table` / `columns` 来自本文件内的常量，不是外部输入。
 */
async function selectContentRow<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
  id: string,
): Promise<R | null> {
  // `WHERE id = $1`：与 Mock 的 `map.get(id)` 对齐——按主键精确命中，不做任何可见性过滤
  // （已移除的记录也要能取到，见 `find*ById` 的接口注释）。
  const rows = await db.query<R>(`SELECT ${columns} FROM ${table} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * 列全部记录，含停用与已移除，**不做任何过滤**（对齐 Mock 的 `[...map.values()]`）。
 *
 * `ORDER BY id` 是**确定性的兜底**：Mock 用的是 Map 插入顺序，SQL 表没有那层含义；
 * 不补排序则同一份数据两次查询顺序可能不同，测试也不可复现。
 * 业务排序（`compareContentOrder`）由调用方的纯函数做，不在这里。
 */
async function listContentRows<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
): Promise<R[]> {
  return db.query<R>(`SELECT ${columns} FROM ${table} ORDER BY id`);
}

/**
 * 插入一条（对齐 Mock 的 `map.set(record.id, { ...record })`）。
 *
 * 硬 `INSERT`，没有 `ON CONFLICT`：Mock 的 `nextRecordId()` 保证 id 不冲突，
 * 而那个写法要求一个同步的 `taken()` 回调，Pg 侧判存在性是异步的、没法照搬。
 * 因此改成「主键冲突即硬失败」——宁可失败，也**不静默改写**一条既有记录
 * （`ON CONFLICT DO UPDATE` 会把「新建」变成「改写」，是本轮明令禁止的语义）。
 *
 * `RETURNING` 回读一次，返回的是**库里的那一行**：列名与字段名的对应只有此处一处定义，
 * 少写一列会在这里暴露，而不是变成一个静默的 `undefined`。
 */
async function insertContentRow<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
  values: readonly unknown[],
): Promise<R> {
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  const rows = await db.query<R>(
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING ${columns}`,
    values,
  );
  if (!rows[0]) throw new Error(`${table} 插入未返回任何行`);
  return rows[0];
}

/**
 * 覆盖式更新（`mockContentRepository.applyProfile` 的 Pg 版本）——**窄写入**。
 *
 * 只写 `assignments` 里出现的列 + `updated_at`，其余列（`id` / `created_at` / `removed_at`）
 * 一律不动。整行写会把这次动作根本不碰的列也写一遍，一旦将来多出一个写者，
 * 就会把别人的改动覆盖回去且不报错。
 *
 * ⚠️ `previous` 必须在 `UPDATE` **之前**读出来：写完之后再读，读到的已经是新值，
 * 而审计快照的 before 要回答的是「改动前是什么」。
 *
 * ⚠️ 与 Mock 一样**不判断** `removedAt`：已移除的记录照样更新并返回结果。
 * 「已移除的不再接受编辑」由事务层判（见文件头）。
 */
async function applyProfileRow<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
  id: string,
  assignments: readonly { column: string; value: unknown }[],
  at: string,
): Promise<{ previous: R; updated: R } | null> {
  const existing = await selectContentRow<R>(db, table, columns, id);
  if (!existing) return null;

  const sets = assignments.map((item, index) => `${item.column} = $${index + 2}`);
  sets.push(`updated_at = $${assignments.length + 2}`);
  const values: unknown[] = [id, ...assignments.map((item) => item.value), at];

  // `WHERE id = $1`：主键精确命中，与 Mock 的 map.set(id, …) 对齐
  const rows = await db.query<R>(
    `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING ${columns}`,
    values,
  );
  // 行在「读」与「写」之间被并发删掉：Mock 里不存在这种状态，这里返回 null。
  // ⚠️ 这也是本方法**不是单语句原子**的地方——并发正确性由上层事务持有行锁后调用保证。
  if (!rows[0]) return null;
  return { previous: existing, updated: rows[0] };
}

/**
 * 只改启用状态（`mockContentRepository.applyEnabled` 的 Pg 版本）——**窄写入**。
 *
 * ⚠️ 幂等：已经是目标状态时**不写库、不刷新 `updated_at`**，原样返回两份**值相等但互相独立**
 * 的副本（Mock 返回 `previous` 与 `updated` 两个各自 `{ ...existing }` 的副本）。
 * 「点了一次已经停用的停用按钮」不该在记录上留下一次改动痕迹。
 */
async function applyEnabledRow<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
  id: string,
  enabled: boolean,
  at: string,
): Promise<{ previous: R; updated: R } | null> {
  const existing = await selectContentRow<R>(db, table, columns, id);
  if (!existing) return null;

  if (existing.enabled === enabled) {
    // 不变：不写、不刷新 updated_at。两份副本独立，与 Mock 的两次 { ...existing } 一致
    return { previous: existing, updated: { ...existing } };
  }

  // `WHERE id = $1`：主键精确命中；只写 enabled 与 updated_at 两列
  const rows = await db.query<R>(
    `UPDATE ${table} SET enabled = $2, updated_at = $3 WHERE id = $1 RETURNING ${columns}`,
    [id, enabled, at],
  );
  if (!rows[0]) return null;
  return { previous: existing, updated: rows[0] };
}

/**
 * 软移除（`mockContentRepository.applyRemoved` 的 Pg 版本）——**只写两个时间列，不删记录**。
 *
 * ⚠️ 幂等：已移除的不刷新 `removed_at` / `updated_at`，原样返回两份值相等的副本。
 */
async function applyRemovedRow<R extends ManagedRow>(
  db: PgQueryable,
  table: string,
  columns: string,
  id: string,
  at: string,
): Promise<{ previous: R; updated: R } | null> {
  const existing = await selectContentRow<R>(db, table, columns, id);
  if (!existing) return null;

  if (existing.removed_at !== null) {
    // 已移除：不写、不刷新时间戳（`applyRemoved` 的幂等分支）
    return { previous: existing, updated: { ...existing } };
  }

  // `WHERE id = $1`：主键精确命中；`removed_at` 与 `updated_at` 同取这一次的 `at`
  const rows = await db.query<R>(
    `UPDATE ${table} SET removed_at = $2, updated_at = $3 WHERE id = $1 RETURNING ${columns}`,
    [id, at, at],
  );
  if (!rows[0]) return null;
  return { previous: existing, updated: rows[0] };
}

// ——————————————————————————— 仓储工厂 ———————————————————————————

/**
 * 用任意可执行 SQL 的对象造一个运营内容仓储。
 *
 * 与其它 Pg 仓储同构：**一个工厂同时产出普通仓储与事务内仓储**。传
 * `withTransaction` 给出的 `TxHandle` 进来，就能让这些读写与同一事务里的
 * 审计写入共享同一条连接、同一个提交点；接口完全一样，调用方不必换 API。
 */
export function createContentRepository(db: PgQueryable): ContentRepository {
  return {
    // ——————————————————— 图片公告 ———————————————————

    async listAnnouncementRecords() {
      const rows = await listContentRows<AnnouncementRow>(db, "announcements", ANNOUNCEMENT_COLUMNS);
      return rows.map(toAnnouncement);
    },

    async findAnnouncementById(id) {
      const row = await selectContentRow<AnnouncementRow>(
        db,
        "announcements",
        ANNOUNCEMENT_COLUMNS,
        id,
      );
      return row ? toAnnouncement(row) : null;
    },

    async createAnnouncement(record) {
      const row = await insertContentRow<AnnouncementRow>(
        db,
        "announcements",
        ANNOUNCEMENT_COLUMNS,
        [
          resolveNewId(record.id, "an_"),
          record.title,
          record.imageUrl,
          record.alt,
          record.enabled,
          record.sortOrder,
          record.createdAt,
          record.updatedAt,
          record.removedAt,
        ],
      );
      return toAnnouncement(row);
    },

    async updateAnnouncement(id, patch: ContentAnnouncementPatch) {
      // 与 Mock 的 `applyProfile(..., ["title","imageUrl","alt","sortOrder","enabled"])` 逐字段对齐
      const result = await applyProfileRow<AnnouncementRow>(
        db,
        "announcements",
        ANNOUNCEMENT_COLUMNS,
        id,
        [
          { column: "title", value: patch.title },
          { column: "image_url", value: patch.imageUrl },
          { column: "alt", value: patch.alt },
          { column: "sort_order", value: patch.sortOrder },
          { column: "enabled", value: patch.enabled },
        ],
        patch.at,
      );
      return result
        ? { previous: toAnnouncement(result.previous), updated: toAnnouncement(result.updated) }
        : null;
    },

    async setAnnouncementEnabled(id, enabled, at) {
      const result = await applyEnabledRow<AnnouncementRow>(
        db,
        "announcements",
        ANNOUNCEMENT_COLUMNS,
        id,
        enabled,
        at,
      );
      return result
        ? { previous: toAnnouncement(result.previous), updated: toAnnouncement(result.updated) }
        : null;
    },

    async markAnnouncementRemoved(id, at) {
      const result = await applyRemovedRow<AnnouncementRow>(
        db,
        "announcements",
        ANNOUNCEMENT_COLUMNS,
        id,
        at,
      );
      return result
        ? { previous: toAnnouncement(result.previous), updated: toAnnouncement(result.updated) }
        : null;
    },

    // ——————————————————— 活动 Banner ———————————————————

    async listBannerRecords() {
      const rows = await listContentRows<BannerRow>(db, "banners", BANNER_COLUMNS);
      return rows.map(toBanner);
    },

    async findBannerById(id) {
      const row = await selectContentRow<BannerRow>(db, "banners", BANNER_COLUMNS, id);
      return row ? toBanner(row) : null;
    },

    async createBanner(record) {
      const row = await insertContentRow<BannerRow>(db, "banners", BANNER_COLUMNS, [
        resolveNewId(record.id, "bn_"),
        record.title,
        record.imageUrl,
        record.alt,
        record.enabled,
        record.sortOrder,
        record.createdAt,
        record.updatedAt,
        record.removedAt,
      ]);
      return toBanner(row);
    },

    async updateBanner(id, patch: ContentBannerPatch) {
      // Banner 的可编辑字段与公告完全相同（`AdminBannerProfilePatch` 就是公告 patch 的别名）
      const result = await applyProfileRow<BannerRow>(
        db,
        "banners",
        BANNER_COLUMNS,
        id,
        [
          { column: "title", value: patch.title },
          { column: "image_url", value: patch.imageUrl },
          { column: "alt", value: patch.alt },
          { column: "sort_order", value: patch.sortOrder },
          { column: "enabled", value: patch.enabled },
        ],
        patch.at,
      );
      return result
        ? { previous: toBanner(result.previous), updated: toBanner(result.updated) }
        : null;
    },

    async setBannerEnabled(id, enabled, at) {
      const result = await applyEnabledRow<BannerRow>(
        db,
        "banners",
        BANNER_COLUMNS,
        id,
        enabled,
        at,
      );
      return result
        ? { previous: toBanner(result.previous), updated: toBanner(result.updated) }
        : null;
    },

    async markBannerRemoved(id, at) {
      const result = await applyRemovedRow<BannerRow>(db, "banners", BANNER_COLUMNS, id, at);
      return result
        ? { previous: toBanner(result.previous), updated: toBanner(result.updated) }
        : null;
    },

    // ——————————————————— 快捷入口 ———————————————————

    async listQuickEntryRecords() {
      const rows = await listContentRows<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
      );
      return rows.map(toQuickEntry);
    },

    async findQuickEntryById(id) {
      const row = await selectContentRow<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
        id,
      );
      return row ? toQuickEntry(row) : null;
    },

    async createQuickEntry(record) {
      const row = await insertContentRow<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
        [
          resolveNewId(record.id, "qe_"),
          record.label,
          record.icon,
          record.path,
          record.enabled,
          record.sortOrder,
          record.createdAt,
          record.updatedAt,
          record.removedAt,
        ],
      );
      return toQuickEntry(row);
    },

    async updateQuickEntry(id, patch: ContentQuickEntryPatch) {
      // 与 Mock 的 `applyProfile(..., ["label","icon","path","sortOrder","enabled"])` 逐字段对齐
      const result = await applyProfileRow<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
        id,
        [
          { column: "label", value: patch.label },
          { column: "icon", value: patch.icon },
          { column: "path", value: patch.path },
          { column: "sort_order", value: patch.sortOrder },
          { column: "enabled", value: patch.enabled },
        ],
        patch.at,
      );
      return result
        ? { previous: toQuickEntry(result.previous), updated: toQuickEntry(result.updated) }
        : null;
    },

    async setQuickEntryEnabled(id, enabled, at) {
      const result = await applyEnabledRow<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
        id,
        enabled,
        at,
      );
      return result
        ? { previous: toQuickEntry(result.previous), updated: toQuickEntry(result.updated) }
        : null;
    },

    async markQuickEntryRemoved(id, at) {
      const result = await applyRemovedRow<QuickEntryRow>(
        db,
        "quick_entries",
        QUICK_ENTRY_COLUMNS,
        id,
        at,
      );
      return result
        ? { previous: toQuickEntry(result.previous), updated: toQuickEntry(result.updated) }
        : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgContentRepository: ContentRepository = createContentRepository(lazyPgExecutor());
