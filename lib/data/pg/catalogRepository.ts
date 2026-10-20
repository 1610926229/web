import type { CategoryRecord, GameRecord } from "@/lib/types/catalog";
import type { CatalogProductRecord, ProductSpecRecord, ProductStatus } from "@/lib/types/product";
import { toPublicGame } from "@/lib/constants/catalog";
import type {
  AdminCategoryFilter,
  AdminProductFilter,
  CatalogRepository,
} from "../catalogRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CatalogRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/catalogRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。语义基线是
 * `lib/data/mockCatalogRepository.ts`，下面每个方法都逐字段对齐它。
 *
 * ## 一、软删除：`removed_at IS NULL` 才是「在架 / 存在」
 *
 * 目录里两类记录都能被软移除，但**可见口径刻意不同**（与 Mock 一字不差）：
 *
 * | 查询 | 已移除的记录 |
 * |---|---|
 * | `findCategoryById` / `listCategories` / 各种后台查询 | **取得到**（类目 id 是商品归属的一部分） |
 * | `findProductById` | **取不到**（返回 `null`，直链就是干净的 404） |
 * | `findProductForAdmin` | **取得到**（后台要看见「它被移除过」） |
 * | `countProductsInCategory` | **不计入**（已移除商品在用户端本来就不可见） |
 *
 * 这些差异全部落在各自的 `WHERE` / `removed_at IS NULL` 上，是**同一张表的读法不同**，
 * 不是两套数据。
 *
 * ## 二、规格独立成表，读取时组装回内嵌数组
 *
 * 迁移 `0011_catalog.sql` 把规格拆成 `product_specs`（单独成表的理由：`specId` 是
 * 被订单快照引用的稳定身份）。而 `CatalogProductRecord.specs` 在 Mock 里是商品对象上
 * 的一个数组，因此本文件的每个读方法都要把规格**组装回**那个形状。
 *
 * 顺序真值源是 `compareSpecsForList`：`ORDER BY sort_order ASC, id ASC`。
 * Mock 存的是数组、读时不排序；但那份数组在上游由 `sortOrder` 组织（展示顺序也按同一
 * 比较器算），因此按 `sort_order` 规范化的结果与 Mock 的可观察顺序一致，且**完全确定**
 * ——SQL 的 `ORDER BY` 不是稳定排序，少写 `id` 兜底，同一条规格会在分页边界上重复出现。
 *
 * ## 三、规格的「整份替换」怎么写，以及为什么与 Mock 等价
 *
 * Mock 的 `applyProductPatch` 是 `specs: patch.specs.map(spec => ({ ...spec }))`——
 * **整份替换**，`patch.specs` 就是目标状态（含 `removedAt` 已算好的被移除行）。
 *
 * 落库时**不能**先 `DELETE` 该商品的旧规格再 `INSERT` 新的：`specId` 被历史订单引用，
 * 物理删除会让「这一单买的是哪个规格」永久查不到，`0011` 的软删除设计正是为此。
 * 因此映射成两条语句：
 *
 * 1. **按 id upsert**（`INSERT … FROM jsonb_to_recordset … ON CONFLICT (id) DO UPDATE`）：
 *    出现在目标数组里的规格，逐字段写成目标值（`removed_at` 也照写）。
 *    这意味着「把一条已移除的规格重新启用」= 目标它的 `removedAt` 为 `null`，自动恢复。
 * 2. **未出现在目标数组里的旧规格软删除**（`removed_at = at`）。
 *
 * **等价性论证**：管理端表单**从不删除整行规格**——标记移除只是勾一个
 * `removed`（表单字段说明见 `lib/types/product.ts` 的 `ProductSpecInput`），
 * 上游 `resolveSpecs` 会把提交的每一行（含被移除的行）都放进目标数组。
 * 因此正常路径下「未出现」的规格集合恒为空，第 2 条不产生任何差异，
 * 结果与 Mock 的整份替换逐字段相同。
 *
 * 只有「提交里少了一个既有规格 id」这种表单走不到的路径上，两者才有别：
 * Mock 会把它从数组里抹掉（等于硬删掉那一行），本实现把它标记为已移除、行继续存在。
 * 后者才是迁移明令的语义（`specId` 不能被物理删除），因此这里选**保行 + 软删**，
 * 而不是复刻一个会把订单快照指向悬空 id 的行为。此类差异只在不可达路径上出现，
 * 已在交付说明里列出。
 *
 * ## 四、时间与 JSON
 *
 * `created_at` 等 `timestamptz` 经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串，
 * 领域对象上的时间字段因此仍是 `string`。
 * `tags` / `detail_images` / `regions` 是 `jsonb`，驱动**直接返回已解析的数组**，
 * 映射时直接赋值、**不做 `JSON.parse`**；写入用 `JSON.stringify`。
 */

/* ─────────────────────────────── 列清单与行类型 ─────────────────────────────── */

const GAME_COLUMNS = "id, name, regions";

/**
 * 类别列名用**数组**（不只是拼好的字符串）：`UPDATE … RETURNING prev.x, c.x`
 * 的成对列名只能从数组生成，避免手写 2×N 个列名时错位。
 */
const CATEGORY_COLUMN_NAMES = [
  "id",
  "game_id",
  "name",
  "sort_order",
  "enabled",
  "created_at",
  "updated_at",
  "removed_at",
] as const;
const CATEGORY_COLUMNS = CATEGORY_COLUMN_NAMES.join(", ");

const PRODUCT_COLUMN_NAMES = [
  "id",
  "title",
  "subtitle",
  "cover_url",
  "game_id",
  "category_id",
  "tags",
  "detail_text",
  "detail_images",
  "sort_order",
  "recommended",
  "status",
  "monthly_sales",
  "game_tag",
  "companion_rate_bp",
  "created_at",
  "updated_at",
  "removed_at",
] as const;
const PRODUCT_COLUMNS = PRODUCT_COLUMN_NAMES.join(", ");

/** `listPublicProducts` 里带表别名的列清单（它要 join 类目表）。 */
const PRODUCT_COLUMNS_QUALIFIED = PRODUCT_COLUMN_NAMES.map((name) => `p.${name}`).join(", ");

const SPEC_COLUMN_NAMES = [
  "id",
  "product_id",
  "name",
  "price",
  "sort_order",
  "enabled",
  "removed_at",
] as const;
const SPEC_COLUMNS = SPEC_COLUMN_NAMES.join(", ");

type GameRow = {
  id: string;
  name: string;
  /** jsonb：驱动已解析成数组。 */
  regions: unknown;
};

type CategoryRow = {
  id: string;
  game_id: string;
  name: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
};

type ProductRow = {
  id: string;
  title: string;
  subtitle: string;
  cover_url: string;
  game_id: string;
  category_id: string | null;
  /** jsonb：驱动已解析成数组。 */
  tags: unknown;
  detail_text: string;
  /** jsonb：驱动已解析成数组。 */
  detail_images: unknown;
  sort_order: number;
  recommended: boolean;
  status: string;
  monthly_sales: number;
  game_tag: string;
  companion_rate_bp: number;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
};

type SpecRow = {
  id: string;
  product_id: string;
  name: string;
  price: number;
  sort_order: number;
  enabled: boolean;
  removed_at: string | null;
};

/** `UPDATE … RETURNING prev.*, c.*` 的行：键名形如 `previous_title` / `updated_title`。 */
type PairedRow = Record<string, unknown>;

/* ────────────────────────────────── 映射 ────────────────────────────────── */

/** jsonb 数组列：驱动已解析；万一手工改库把这一列写坏，宁可退化成空数组也不打崩列表。 */
function toTextArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function toGameRecord(row: GameRow): GameRecord {
  return { id: row.id, name: row.name, regions: toTextArray(row.regions) };
}

function toCategoryRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    name: row.name,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

function toSpecRecord(row: SpecRow): ProductSpecRecord {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    removedAt: row.removed_at,
  };
}

/** 商品行 + 它的全部规格 → 领域记录。规格数组由调用方组装（见文件头 §二）。 */
function toProductRecord(row: ProductRow, specs: readonly ProductSpecRecord[]): CatalogProductRecord {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    coverUrl: row.cover_url,
    gameId: row.game_id,
    categoryId: row.category_id,
    tags: toTextArray(row.tags),
    detailText: row.detail_text,
    detailImages: toTextArray(row.detail_images),
    sortOrder: row.sort_order,
    recommended: row.recommended,
    status: row.status as ProductStatus,
    monthlySales: row.monthly_sales,
    gameTag: row.game_tag,
    companionRateBp: row.companion_rate_bp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    specs: specs.map((spec) => ({ ...spec })),
  };
}

/** 对外一律给快照，不把驱动行对象本身交出去（与 Mock 的 `cloneProduct` 同义）。 */
function cloneProduct(record: CatalogProductRecord): CatalogProductRecord {
  return {
    ...record,
    tags: [...record.tags],
    detailImages: [...record.detailImages],
    specs: record.specs.map((spec) => ({ ...spec })),
  };
}

/**
 * `UPDATE … FROM t AS prev WHERE c.id = $1 AND prev.id = $1` 的成对返回列。
 *
 * 改动前 / 改动后必须在**同一条语句**里返回：分两条（先查后改）中间隔着一次让出
 * 执行权，另一位管理员可以在那之间改掉同一行。自连读的是**同一个命令快照**，
 * 因此 `prev.*` 必然是改动前的值。（与 `companionRepository` 同一种做法。）
 */
function pairReturning(columns: readonly string[]): string {
  const previous = columns.map((name) => `prev.${name} AS previous_${name}`).join(", ");
  const updated = columns.map((name) => `c.${name} AS updated_${name}`).join(", ");
  return `${previous}, ${updated}`;
}

/** 从成对行里还原出某一侧（`previous` / `updated`）的行。 */
function rowFromPair(pair: PairedRow, columns: readonly string[], prefix: "previous" | "updated"): PairedRow {
  const row: PairedRow = {};
  for (const name of columns) row[name] = pair[`${prefix}_${name}`];
  return row;
}

/**
 * `jsonb` 列的入参。`null` **原样**交给驱动，绝不 `JSON.stringify(null)`——后者得到
 * 字符串 `"null"`，PG 会把它解析成 JSON 的 null 值而不是 SQL NULL，两者在 `IS NULL`
 * 下结果相反（理由见 `w1Rows.ts` 的同名函数）。
 */
function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * 关键词筛选用 `strpos` 而不是 `LIKE`：Mock 是纯子串包含，`LIKE` 会把关键词里的
 * `%` / `_` 当成通配符。`lower(btrim($n))` 对齐 Mock 的 `keyword.trim().toLowerCase()`。
 */
function keywordCondition(column: string, param: string): string {
  return `strpos(lower(${column}), lower(btrim(${param}))) > 0`;
}

/* ──────────────────────────────── 工厂 ──────────────────────────────── */

/**
 * 用任意可执行 SQL 的对象造一个目录仓储。
 *
 * 与收藏 / 投诉 / 退款同构：**一个工厂同时产出普通仓储与事务内仓储**。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，「商品 + 规格 + 审计」就能共享
 * 同一条连接、同一个提交点。多语句写入的原子边界由调用方的事务提供
 * （`adminCatalogTransaction` 的 Pg 版），本层只保证每条语句正确。
 */
export function createCatalogRepository(db: PgQueryable): CatalogRepository {
  /** 某个商品的**全部**规格（含停用与已移除），按 `compareSpecsForList` 排。 */
  async function readSpecs(productId: string): Promise<ProductSpecRecord[]> {
    // ORDER BY 对齐 `compareSpecsForList`：sort_order 升序、id 升序兜底。
    const rows = await db.query<SpecRow>(
      `SELECT ${SPEC_COLUMNS} FROM product_specs
        WHERE product_id = $1
        ORDER BY sort_order ASC, id ASC`,
      [productId],
    );
    return rows.map(toSpecRecord);
  }

  /** 批量取规格，避免列表查询 N+1。返回 `productId → 规格数组`。 */
  async function readSpecsForMany(
    productIds: readonly string[],
  ): Promise<Map<string, ProductSpecRecord[]>> {
    const map = new Map<string, ProductSpecRecord[]>();
    if (productIds.length === 0) return map;

    const rows = await db.query<SpecRow>(
      // ORDER BY 对齐 `compareSpecsForList`：sort_order 升序、id 升序兜底。
      `SELECT ${SPEC_COLUMNS} FROM product_specs
        WHERE product_id = ANY($1::text[])
        ORDER BY sort_order ASC, id ASC`,
      [[...productIds]],
    );
    for (const row of rows) {
      const list = map.get(row.product_id) ?? [];
      list.push(toSpecRecord(row));
      map.set(row.product_id, list);
    }
    return map;
  }

  /** 商品行 + 规格 → 领域记录（不查库，规格由调用方先取好）。 */
  async function hydrateProduct(row: ProductRow): Promise<CatalogProductRecord> {
    return toProductRecord(row, await readSpecs(row.id));
  }

  /**
   * 规格整份替换（文件头 §三）：按 id upsert + 未出现者软删。
   *
   * `removed_at` 的写入值来自目标记录自己（`spec.removedAt`）——上游 `resolveSpecs`
   * 已经算好「本次要求移除 → 本次时间 / 本来就移除 → 保留原时间 / 恢复 → null」，
   * 仓储不再重复这条规则。
   */
  async function replaceSpecs(
    productId: string,
    specs: readonly ProductSpecRecord[],
    at: string,
  ): Promise<void> {
    // 目标规格映射成 snake_case 记录集。用 `jsonb_to_recordset` 而不是逐条 INSERT：
    // 一条语句写完，且列名与取值在同一个 AS 子句里，错位只可能发生在同一处。
    const payload = JSON.stringify(
      specs.map((spec) => ({
        id: spec.id,
        name: spec.name,
        price: spec.price,
        sort_order: spec.sortOrder,
        enabled: spec.enabled,
        removed_at: spec.removedAt,
      })),
    );

    await db.query(
      `INSERT INTO product_specs (id, product_id, name, price, sort_order, enabled, removed_at)
       SELECT s.id, $1, s.name, s.price, s.sort_order, s.enabled, s.removed_at
         FROM jsonb_to_recordset($2::jsonb)
           AS s(id text, name text, price integer, sort_order integer, enabled boolean, removed_at timestamptz)
       ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              price = EXCLUDED.price,
              sort_order = EXCLUDED.sort_order,
              enabled = EXCLUDED.enabled,
              removed_at = EXCLUDED.removed_at`,
      [productId, payload],
    );

    // 本次目标里没出现的旧规格 → 软删除（行保留，历史订单仍指得到它）。
    // 只动「当前未移除」的行：已经移除的不刷新时间戳，重复保存是幂等的。
    await db.query(
      `UPDATE product_specs
          SET removed_at = $2
        WHERE product_id = $1
          AND removed_at IS NULL
          AND NOT (id = ANY($3::text[]))`,
      [productId, at, specs.map((spec) => spec.id)],
    );
  }

  return {
    // ————————————————————————— 游戏 —————————————————————————

    async listGames() {
      // Mock 返回 Map 插入顺序（= 种子顺序）。游戏是**只读目录**、没有排序字段，
      // SQL 没有插入顺序可言，因此钉 `id` 升序：对种子而言它恰好等于插入顺序
      // （g-delta < g-valorant），且与其它所有列表的兜底口径一致。
      const rows = await db.query<GameRow>(`SELECT ${GAME_COLUMNS} FROM games ORDER BY id ASC`);
      return rows.map(toGameRecord);
    },

    async findGameById(id) {
      const rows = await db.query<GameRow>(
        `SELECT ${GAME_COLUMNS} FROM games WHERE id = $1`,
        [id],
      );
      return rows[0] ? toGameRecord(rows[0]) : null;
    },

    async listPublicGames() {
      // 全部游戏都返回，即使某个游戏下一个可见类目都没有（理由见 Mock 的同名注释：
      // 游戏切换器是导航的一部分，不能因为类目被停用而整个消失）。
      const games = await db.query<GameRow>(
        `SELECT ${GAME_COLUMNS} FROM games ORDER BY id ASC`,
      );
      // 可见性判断**不在这里**：整份类目交给 `toPublicGame`，它按
      // `isCategoryVisible`（启用且未移除）过滤，并顺带排序。
      // 复用共享的纯函数，避免「哪些类目用户看得到」出现第二个答案。
      const categories = (await db.query<CategoryRow>(`SELECT ${CATEGORY_COLUMNS} FROM categories`))
        .map(toCategoryRecord);
      // `ORDER BY id` 已给出升序，`toPublicGame` 是 map、不改变游戏顺序。
      return games.map((row) => toPublicGame(toGameRecord(row), categories));
    },

    // ————————————————————————— 类目 —————————————————————————

    async listCategories() {
      // 已移除的类目**照样返回**（后台详情、商品归属校验要读得到它）。
      // 排序对齐 `compareCategoriesForList`：`sort_order` 升序、`id` 升序兜底。
      const rows = await db.query<CategoryRow>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories ORDER BY sort_order ASC, id ASC`,
      );
      return rows.map(toCategoryRecord);
    },

    async findCategoryById(id) {
      // ⚠️ 已移除的类目仍然取得到（与商品刻意不同，见接口注释）。
      const rows = await db.query<CategoryRow>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = $1`,
        [id],
      );
      return rows[0] ? toCategoryRecord(rows[0]) : null;
    },

    async queryCategoriesForAdmin(filter: AdminCategoryFilter) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      // 与 Mock 逐条对齐：默认视图是「未移除的类目」，要看已移除的必须显式选。
      conditions.push(
        filter.removal === "removed" ? "removed_at IS NOT NULL" : "removed_at IS NULL",
      );

      if (filter.enabled === "enabled") conditions.push("enabled = true");
      else if (filter.enabled === "disabled") conditions.push("enabled = false");

      // Mock 的 `!gameId || category.gameId === gameId`：空串表示全部游戏。
      if (filter.gameId) {
        params.push(filter.gameId);
        conditions.push(`game_id = $${params.length}`);
      }

      // Mock 用 `keyword.trim().toLowerCase()` 与 `name.toLowerCase()` 比子串。
      if (filter.keyword.trim()) {
        params.push(filter.keyword);
        conditions.push(keywordCondition("name", `$${params.length}`));
      }

      // ORDER BY 对齐 `compareCategoriesForList`：sort_order 升序、id 升序兜底。
      const rows = await db.query<CategoryRow>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories
          WHERE ${conditions.join(" AND ")}
          ORDER BY sort_order ASC, id ASC`,
        params,
      );
      return rows.map(toCategoryRecord);
    },

    // ————————————————————————— 商品 —————————————————————————

    async findProductById(id) {
      // ⚠️ 软删除的商品在这里返回 null（直链就是干净的 404），与类目刻意不同。
      // 下架商品仍然取得到——status 不参与这里的过滤。
      const rows = await db.query<ProductRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1 AND removed_at IS NULL`,
        [id],
      );
      return rows[0] ? hydrateProduct(rows[0]) : null;
    },

    async findProductForAdmin(id) {
      // 含已移除：后台要能查到「这件商品被移除过」。
      const rows = await db.query<ProductRow>(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1`,
        [id],
      );
      return rows[0] ? hydrateProduct(rows[0]) : null;
    },

    async listPublicProducts() {
      // 用户端列表口径 = `isProductPubliclyListed()` + 「类目可见」：
      // 上架、未移除、挂了类目，且那个类目启用且未移除。
      // join 类目表即 `visibleCategoryIds.has(categoryId)` 的等价式；
      // 顺序对齐 `compareProductsForList`：`sort_order` 升序、`id` 升序兜底。
      const rows = await db.query<ProductRow>(
        `SELECT ${PRODUCT_COLUMNS_QUALIFIED}
           FROM products AS p
           JOIN categories AS c ON c.id = p.category_id
          WHERE p.status = 'on'
            AND p.removed_at IS NULL
            AND c.enabled = true
            AND c.removed_at IS NULL
          ORDER BY p.sort_order ASC, p.id ASC`,
      );

      const specsByProduct = await readSpecsForMany(rows.map((row) => row.id));
      return rows.map((row) => toProductRecord(row, specsByProduct.get(row.id) ?? []));
    },

    async queryProductsForAdmin(filter: AdminProductFilter) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      // 与 Mock 逐条对齐，顺序也一致：removal → status → recommended → gameId
      // → categoryId → keyword。默认视图是「未移除的商品」。
      conditions.push(
        filter.removal === "removed" ? "p.removed_at IS NOT NULL" : "p.removed_at IS NULL",
      );

      if (filter.status) {
        params.push(filter.status);
        conditions.push(`p.status = $${params.length}`);
      }

      if (filter.recommended === "recommended") conditions.push("p.recommended = true");
      else if (filter.recommended === "normal") conditions.push("p.recommended = false");

      if (filter.gameId) {
        params.push(filter.gameId);
        conditions.push(`p.game_id = $${params.length}`);
      }

      if (filter.categoryId) {
        params.push(filter.categoryId);
        conditions.push(`p.category_id = $${params.length}`);
      }

      // Mock 的 `productMatchesKeyword`：只按标题、去首尾空格、忽略大小写。
      if (filter.keyword.trim()) {
        params.push(filter.keyword);
        conditions.push(keywordCondition("p.title", `$${params.length}`));
      }

      // ORDER BY 对齐 `compareProductsForList`：sort_order 升序、id 升序兜底。
      const rows = await db.query<ProductRow>(
        `SELECT ${PRODUCT_COLUMNS_QUALIFIED} FROM products AS p
          WHERE ${conditions.join(" AND ")}
          ORDER BY p.sort_order ASC, p.id ASC`,
        params,
      );

      const specsByProduct = await readSpecsForMany(rows.map((row) => row.id));
      return rows.map((row) => toProductRecord(row, specsByProduct.get(row.id) ?? []));
    },

    async countProductsInCategory(categoryId) {
      // 只数**未移除**的商品：已移除的件在用户端本来就不可见，让它们把类目锁死说不通。
      const rows = await db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM products
          WHERE category_id = $1 AND removed_at IS NULL`,
        [categoryId],
      );
      return rows[0]?.total ?? 0;
    },

    // ————————————————————————— 写入 —————————————————————————

    async createCategory(record) {
      // 平铺 INSERT，不做 `ON CONFLICT`：重名（部分唯一索引）与 id 冲突都应当
      // 当场报错，而不是被静默吞掉。合法性由调用方在事务里判，这里只负责写。
      await db.query(
        `INSERT INTO categories (${CATEGORY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.id,
          record.gameId,
          record.name,
          record.sortOrder,
          record.enabled,
          record.createdAt,
          record.updatedAt,
          record.removedAt,
        ],
      );
      // 返回调用方给的这一份（与 Mock 的 `{ ...record }` 同义）：
      // 时间戳不做一次非必要的往返，避免格式被驱动重写而与输入不一致。
      return { ...record };
    },

    async updateCategory(id, patch) {
      // 窄写入：只覆盖 patch 里那些字段 + `updated_at`。
      // `id` / `created_at` / `removed_at` 一律原样保留——「顺手把一条已移除的类目
      // 改回未移除」在 patch 类型里没有位置可写。
      const rows = await db.query<PairedRow>(
        `UPDATE categories AS c
            SET game_id = $2,
                name = $3,
                sort_order = $4,
                enabled = $5,
                updated_at = $6
           FROM categories AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(CATEGORY_COLUMN_NAMES)}`,
        [id, patch.gameId, patch.name, patch.sortOrder, patch.enabled, patch.at],
      );
      if (!rows[0]) return null;
      const pair = rows[0];
      return {
        previous: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "previous") as CategoryRow),
        updated: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "updated") as CategoryRow),
      };
    },

    async setCategoryEnabled(id, enabled, at) {
      // 窄写入：只改 `enabled` + `updated_at`，绝不顺带覆盖名称 / 所属游戏 / 排序
      // （那需要一次发生在原子区段之外的读取，两位管理员会互相覆盖）。
      const rows = await db.query<PairedRow>(
        `UPDATE categories AS c
            SET enabled = $2, updated_at = $3
           FROM categories AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(CATEGORY_COLUMN_NAMES)}`,
        [id, enabled, at],
      );
      if (!rows[0]) return null;
      const pair = rows[0];
      return {
        previous: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "previous") as CategoryRow),
        updated: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "updated") as CategoryRow),
      };
    },

    async markCategoryRemoved(id, at) {
      // 软移除：只写 `removed_at`，**不删除记录**（类目 id 是商品归属的一部分）。
      //
      // 幂等：`removed_at = COALESCE(c.removed_at, $2)` 让「已经移除」写回它自己
      // （不刷新时间戳）；`updated_at` 用 CASE 只在**本次真的移除**时才刷新，
      // 否则保持原值——与 Mock 的 `previous === updated` 口径一致。
      // 行不存在时 UPDATE 命中 0 行，返回 null。
      const rows = await db.query<PairedRow>(
        `UPDATE categories AS c
            SET removed_at = COALESCE(c.removed_at, $2),
                updated_at = CASE WHEN c.removed_at IS NULL THEN $2 ELSE c.updated_at END
           FROM categories AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(CATEGORY_COLUMN_NAMES)}`,
        [id, at],
      );
      if (!rows[0]) return null;
      const pair = rows[0];
      return {
        previous: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "previous") as CategoryRow),
        updated: toCategoryRecord(rowFromPair(pair, CATEGORY_COLUMN_NAMES, "updated") as CategoryRow),
      };
    },

    async createProduct(record) {
      // 商品与规格一次写入。原子边界由调用方的事务提供；这里保证两条语句都正确。
      await db.query(
        `INSERT INTO products (${PRODUCT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18)`,
        [
          record.id,
          record.title,
          record.subtitle,
          record.coverUrl,
          record.gameId,
          record.categoryId,
          jsonbParam(record.tags),
          record.detailText,
          jsonbParam(record.detailImages),
          record.sortOrder,
          record.recommended,
          record.status,
          record.monthlySales,
          record.gameTag,
          record.companionRateBp,
          record.createdAt,
          record.updatedAt,
          record.removedAt,
        ],
      );

      // 新建时目标数组就是全部规格，不会命中「未出现者软删」那条分支；
      // 传 `createdAt` 只是让签名完整。
      await replaceSpecs(record.id, record.specs, record.createdAt);

      return cloneProduct(record);
    },

    async updateProduct(id, patch) {
      const { at, specs, ...fields } = patch;

      // 1) 商品行：窄写入，只写 patch 里出现的列 + `updated_at`。
      //    `monthly_sales` / `game_tag` / `created_at` / `removed_at` 不在 patch 里，
      //    因此**这条语句里根本没有它们**——整行写会把它们也写一遍且不报错。
      //    同一条语句返回改动前 / 后两套列。
      const rows = await db.query<PairedRow>(
        `UPDATE products AS c
            SET title = $2,
                subtitle = $3,
                cover_url = $4,
                game_id = $5,
                category_id = $6,
                tags = $7::jsonb,
                detail_text = $8,
                detail_images = $9::jsonb,
                sort_order = $10,
                recommended = $11,
                status = $12,
                companion_rate_bp = $13,
                updated_at = $14
           FROM products AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(PRODUCT_COLUMN_NAMES)}`,
        [
          id,
          fields.title,
          fields.subtitle,
          fields.coverUrl,
          fields.gameId,
          fields.categoryId,
          jsonbParam(fields.tags),
          fields.detailText,
          jsonbParam(fields.detailImages),
          fields.sortOrder,
          fields.recommended,
          fields.status,
          fields.companionRateBp,
          at,
        ],
      );
      if (!rows[0]) return null;

      // 2) 规格改动前的状态：此时规格尚未被动过（商品行 UPDATE 不碰 `product_specs`）。
      const previousSpecs = await readSpecs(id);

      // 3) 规格整份替换（见文件头 §三）。
      await replaceSpecs(id, specs, at);

      // 4) 规格改动后的状态。
      const updatedSpecs = await readSpecs(id);

      const pair = rows[0];
      return {
        previous: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "previous") as ProductRow,
          previousSpecs,
        ),
        updated: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "updated") as ProductRow,
          updatedSpecs,
        ),
      };
    },

    async setProductStatus(id, status, at) {
      // 窄写入：只改 `status` + `updated_at`，绝不顺带覆盖标题 / 封面 / 规格。
      const rows = await db.query<PairedRow>(
        `UPDATE products AS c
            SET status = $2, updated_at = $3
           FROM products AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(PRODUCT_COLUMN_NAMES)}`,
        [id, status, at],
      );
      if (!rows[0]) return null;

      // 上下架不改规格，改动前后共用同一份规格快照（与 Mock 的 cloneProduct 同义）。
      const specs = await readSpecs(id);
      const pair = rows[0];
      return {
        previous: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "previous") as ProductRow,
          specs,
        ),
        updated: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "updated") as ProductRow,
          specs,
        ),
      };
    },

    async markProductRemoved(id, at) {
      // 软移除：只写 `removed_at`，**不删除记录**（历史订单、收藏、评价要指得到它）。
      // 幂等口径与 `markCategoryRemoved` 相同。
      const rows = await db.query<PairedRow>(
        `UPDATE products AS c
            SET removed_at = COALESCE(c.removed_at, $2),
                updated_at = CASE WHEN c.removed_at IS NULL THEN $2 ELSE c.updated_at END
           FROM products AS prev
          WHERE c.id = $1 AND prev.id = $1
         RETURNING ${pairReturning(PRODUCT_COLUMN_NAMES)}`,
        [id, at],
      );
      if (!rows[0]) return null;

      const specs = await readSpecs(id);
      const pair = rows[0];
      return {
        previous: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "previous") as ProductRow,
          specs,
        ),
        updated: toProductRecord(
          rowFromPair(pair, PRODUCT_COLUMN_NAMES, "updated") as ProductRow,
          specs,
        ),
      };
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCatalogRepository: CatalogRepository = createCatalogRepository(lazyPgExecutor());
