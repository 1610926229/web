import { createHash } from "node:crypto";
import { toCategoryAuditSnapshot, toProductAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  adminCategoryActionFromPatch,
  isCategoryProfileUnchanged,
} from "@/lib/constants/adminCategories";
import {
  adminProductActionFromPatch,
  effectiveSpecCount,
  isProductProfileUnchanged,
} from "@/lib/constants/adminProducts";
import type { CategoryRecord, GameRecord } from "@/lib/types/catalog";
import type { CatalogProductRecord } from "@/lib/types/product";
import { buildAuditEntry } from "../adminWriteSupport";
import {
  categoryFailure,
  hasDuplicateCategoryName,
  resolveSpecs,
  type AdminCategoryWriteOutcome,
  type AdminProductWriteOutcome,
  type AdminWriteContext,
  type CategoryDraft,
  type ProductDraft,
} from "../adminCatalogTransaction";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeCreateReplayTx, takeReplayTx } from "./adminWriteTx";
import { createCatalogRepository } from "./catalogRepository";
import { getPgExecutor, type TxHandle } from "./executor";

/**
 * 商品目录管理端写闭包（**类目 + 商品/规格**）的 PostgreSQL 事务 ——
 * `lib/data/adminCatalogTransaction.ts` 八个入口的**等价翻译**（PROD-1E · Wave C）。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 类目、商品与规格的写入入口只有一处（Mock 的伪事务），判定、快照与审计都在那里定义。
 * 它与订单闭包共用一条跨领域不变式：
 *
 * > 目录的**业务写入**与它的那一条管理审计必须**同生共死**。
 *
 * Mock 靠「同一段无 `await` 的同步代码」成立：`createCategoryRecord` / `applyProductPatch`
 * 写完，`writeAudit` 紧接着写在同一个区段里。换成数据库之后，两件事各自是一条 SQL，
 * 中间必然让出执行权；若审计还写 `globalThis`，就会出现本仓反复拒绝的半套事务——
 * 那次事务一提交，进程内的账本已经把「管理员改过这条类目」记下来了。因此审计必须在
 * **同一个事务**里 `INSERT`（`appendAuditEntryTx`），审计失败则业务写入一起回滚。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、`nothingChanged` / no-op 判据、replay / conflict 分支的返回值、写入的字段
 * 集合、审计的 before / after 快照，**逐条对齐** `adminCatalogTransaction.ts`。
 * 业务规则一个字节都没改，规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 「同一游戏内未移除类目不可重名」 | `adminCatalogTransaction.ts` 的 `hasDuplicateCategoryName`（**import 共用**） |
 * | 「类目必须属于所选游戏且启用、未移除」 | `adminCatalogTransaction.ts` 的 `categoryFailure`（**import 共用**） |
 * | 「规格整份替换 + 发 id + 拒绝伪造 id + 金额/排序校验」 | `adminCatalogTransaction.ts` 的 `resolveSpecs`（**import 共用**） |
 * | 「在架商品至少一个有效规格」 | `adminProducts.ts` 的 `effectiveSpecCount` |
 * | 编辑该记哪个动作 | `adminCategories.ts` 的 `adminCategoryActionFromPatch` / `adminProducts.ts` 的 `adminProductActionFromPatch` |
 * | 「什么都没改」的判据 | `adminCategories.ts` 的 `isCategoryProfileUnchanged` / `adminProducts.ts` 的 `isProductProfileUnchanged` |
 * | 审计记什么 | `adminAudit.ts` 的 `toCategoryAuditSnapshot` / `toProductAuditSnapshot` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay` / `evaluateCreateReplay`（经 `adminWriteTx`） |
 *
 * ⚠️ **`resolveSpecs` / `hasDuplicateCategoryName` / `categoryFailure` 是从 Mock 模块
 * import 的，不是在这里再抄一份**。三个函数里各写着一条业务规则（见上表），
 * 在 Pg 侧复制一份，等于让「两条同名类目算不算重复」「伪造 specId 会不会被收下」
 * 这类判定在两个存储上各自演化。导出它们、两边读同一份，是**共用**，不是复制。
 *
 * ## 幂等账本要读**两次**（与 `pg/couponTemplateTransactions.ts` 同一条设计）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 前置读为什么必要：Mock 把「键冲突」排在**一切业务判定之前**（编辑 / 启停 / 移除的
 * 第一行都是 `takeReplay`）。若把整段账本读推到锁后，一次「复用了别人的幂等键」
 * 就可能先撞上「目标不存在」或「已移除」，报出来的原因与 Mock 不同。前置读
 * **只回答 `conflict`**，它读到的 `replay` **不被采信**（那会导向写入，必须留给权威读）。
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，
 * 会双双读空、双双进入写入段，最后撞在 `admin_audit_entries_operation_key`
 * 唯一索引上（`23505`）——那**不是重放，是一次失败**。排在竞争锁之后，第二个请求会等待、
 * 等第一个提交之后再读账本，于是看到那一行、正确重放。
 *
 * ⚠️ 因此有两条**不可合并**的判据，别把前置读的结果直接当结论用。
 *
 * ## 新建**没有可锁的行**：`operationId` 派生的顾问锁
 *
 * 编辑 / 启停 / 移除都能把幂等判定挂在「这一行」上（`FOR UPDATE`），而**新建没有这样一行**——
 * 目标 id 是在事务里当场生成的，两个并发的新建请求不存在任何共享的行可以串行化。
 * 若照搬「先读账本、再写」，两个**同键**的新建会双双读到空账本、双双 `INSERT`，
 * 第二个撞 `admin_audit_entries_operation_key`（`23505`）→ 两个请求都失败。
 * 因此新建在**事务最前面**取一把由 `operationId` 派生的 bigint **事务级顾问锁**
 * （`pg_advisory_xact_lock`）——与 `pg/couponTemplateTransactions.ts` 的
 * `couponCreateLockKey()` 是**同一个 idiom**，这里不发明第二套机制。
 *
 * ## 加锁顺序
 *
 * 全库不变量是「`orders` 永远是第一把锁」。本条路径**一行都不碰 `orders`**，
 * 用的是两类锁：
 *
 * 1. **顾问锁**（仅新建）：按 `operationId`，不指向任何行；
 * 2. **行锁**（编辑 / 启停 / 移除）：`SELECT … FROM categories|products WHERE id = $1 FOR UPDATE`，
 *    锁的正是本函数要修改的那一行。
 *
 * 本文件在持锁期间只**普通读** `games` / `categories`（无锁 `SELECT`），
 * 不取第二把行锁，因此不与任何「先锁订单、再锁目录」的路径形成环——
 * 事实上本仓根本不存在「锁目录又锁订单」的路径（目录写入与订单闭包互不相干）。
 *
 * ## 本轮**不激活**（与 PROD-1B / 1C / 1D 同一条裁定）
 *
 * `DATA_SOURCE` 未设置时应用照旧走 Mock 伪事务。`lib/data/adminCatalogTransaction.ts`
 * 顶层的公开函数按 `isPostgresDataSourceEnabled()` 路由到本模块（D3），
 * 因此这两个存储**不会**在同一个原子闭包里各写一半。
 *
 * ## 事务内**绝不**调 Mock 的 `writeAudit`
 *
 * `lib/data/adminWriteSupport.ts` 的 `writeAudit` 末尾会写**进程内的** Mock 账本。
 * 这里复用同一个**拼装函数** `buildAuditEntry`（纯函数），把结果交给
 * `appendAuditEntryTx` 的 `INSERT`。拼装规则一字未改，因此「审计记了些什么」
 * 在两个存储上仍然只有一处定义。
 */

/* ─────────────────────── 事务内私有原语 ─────────────────────── */

/**
 * 新建路径的顾问锁键 —— 由 `operationId` 派生（`sha256` 取前 64 bit，映射进 int64）。
 *
 * 与 `pg/couponTemplateTransactions.ts` 的 `couponCreateLockKey()` **逐字同构**：
 * 同一个幂等键 ⇒ 同一把锁 ⇒ 两个同键新建串行；不同键 ⇒ 不同锁 ⇒ 互不阻塞；
 * 哈希碰撞只会让两个无关请求**串行**一下，既不报错也不改结果。
 */
function catalogCreateLockKey(operationId: string): bigint {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
}

/**
 * 锁住一行类目并读出它（含已移除）——**事务内**，`FOR UPDATE`。
 *
 * 为什么是私有 helper 而不是 `pg/catalogRepository.ts` 的一个方法：仓储接口
 * （`CatalogRepository`）里**没有**「取行锁」这个概念——它的读方法是给只读调用方用的，
 * 不该让它们默认带上写锁。行锁是**事务编排**的需要（「先锁、再判、再写」的顺序），
 * 因此留在事务层。先 `SELECT id … FOR UPDATE` 拿到锁，再用仓储的读方法把整行读出来；
 * 两条语句在同一条连接、同一个事务里，行锁一直握在手上。
 */
async function lockCategoryForUpdateTx(
  tx: TxHandle,
  id: string,
): Promise<CategoryRecord | null> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM categories WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!locked[0]) return null;
  return createCatalogRepository(tx).findCategoryById(id);
}

/** 锁住一行商品并读出它（含已移除，含全部规格）——事务内，`FOR UPDATE`。 */
async function lockProductForUpdateTx(
  tx: TxHandle,
  id: string,
): Promise<CatalogProductRecord | null> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM products WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!locked[0]) return null;
  return createCatalogRepository(tx).findProductForAdmin(id);
}

/** 类目数组 → `id → 类目` 的索引（`hasDuplicateCategoryName` 收的是 Map）。 */
function indexCategories(categories: readonly CategoryRecord[]): Map<string, CategoryRecord> {
  const map = new Map<string, CategoryRecord>();
  for (const category of categories) map.set(category.id, category);
  return map;
}

/**
 * 把「类目归属校验」需要的两个目录读进 Mock 侧的 store 形状，好**原样复用**
 * `categoryFailure()`（`adminCatalogTransaction.ts`）。
 *
 * 那个函数只读 `catalog.games.has()` 与 `catalog.categories.get()`；`products`
 * 只为满足 store 的形状。硬抄一份判定树才是错的——那正是「类目必须属于所选游戏
 * 且启用、未移除」这条规则出现第二个答案的起点。
 */
async function loadCatalogStoreTx(
  tx: TxHandle,
): Promise<Parameters<typeof categoryFailure>[0]> {
  const repo = createCatalogRepository(tx);

  const games = new Map<string, GameRecord>();
  for (const game of await repo.listGames()) games.set(game.id, game);

  const categories = new Map<string, CategoryRecord>();
  for (const category of await repo.listCategories()) categories.set(category.id, category);

  // `products` 只为满足 store 的形状：`categoryFailure` 一行都不读它。
  return { games, categories, products: new Map<string, CatalogProductRecord>() };
}

/** 商品的防御性深拷贝（`tags` / `detailImages` / `specs` 各复制一层）。 */
function cloneProductRecord(record: CatalogProductRecord): CatalogProductRecord {
  return {
    ...record,
    tags: [...record.tags],
    detailImages: [...record.detailImages],
    specs: record.specs.map((spec) => ({ ...spec })),
  };
}

/* ─────────────────────────── 类目：新建 ─────────────────────────── */

/**
 * 新建类目 —— `createCategory` 的 Pg 实现。
 *
 * ⚠️ 「同一个幂等键第二次到达」靠**操作类型**识别（`takeCreateReplayTx`），而不是靠
 * 目标 id：新建的目标 id 是在事务里当场生成的，第二次调用会生成一个不同的 id。
 * 「账本里有、记录却没有」是数据被清过，返回 `not-found`，绝不照着账本编一条出来。
 *
 * ⚠️ 不用 Mock 的 `nextRecordId()`：它要求一个**同步**的 `taken()` 回调，而 Pg 判存在性
 * 是异步的。改成 `c_${randomUUID()}` + 「主键冲突即硬失败」——与
 * `pg/couponTemplateTransactions.ts` 的 `cpn_` 同一条取舍，恰好保住了「绝不覆盖既有记录」。
 */
export async function createCategoryPg(
  draft: CategoryDraft,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：顾问锁。新建没有行可锁，同键串行只能靠它 —— */
    await tx.query("SELECT pg_advisory_xact_lock($1)", [catalogCreateLockKey(ctx.operationId)]);

    /* —— 第 2 步：读账本（锁已在最前，前置读与权威读合一，与券模板新建同构）—— */
    const replay = await takeCreateReplayTx(tx, ctx, "category");
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay") {
      const existing = await createCatalogRepository(tx).findCategoryById(replay.targetId);
      // 审计里有、记录却没有：数据被清过。宁可报「不存在」，也不编一条出来
      if (!existing) return { kind: "not-found" };
      return {
        kind: "ok",
        value: { previous: null, updated: { ...existing }, action: "category.create" },
        changed: false,
        replayed: true,
      };
    }

    // 同名判定复用 Mock 的 `hasDuplicateCategoryName`（只比未移除的、同游戏、去空格后完全相同）。
    // 数据库的 `categories_game_active_name_key` 部分唯一索引是**第二道网**：走到 INSERT
    // 说明这一处漏判了，那时 23505 会让整段回滚——但正常路径应当在这里返回 `duplicate-name`。
    const categories = await createCatalogRepository(tx).listCategories();
    if (hasDuplicateCategoryName(indexCategories(categories), draft.gameId, draft.name, null)) {
      return { kind: "duplicate-name" };
    }

    const created: CategoryRecord = {
      id: `c_${crypto.randomUUID()}`,
      gameId: draft.gameId,
      name: draft.name,
      sortOrder: draft.sortOrder,
      enabled: draft.enabled,
      // 建档与最后改动是同一个时刻：这条记录就是现在产生的
      createdAt: ctx.at,
      updatedAt: ctx.at,
      removedAt: null,
    };

    await createCatalogRepository(tx).createCategory(created);

    // 审计与业务写入同一个提交点：审计失败 ⇒ 这条类目也回滚
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "category.create",
        targetType: "category",
        targetId: created.id,
        before: null,
        after: toCategoryAuditSnapshot(created),
      }),
    );

    return {
      kind: "ok",
      value: { previous: null, updated: created, action: "category.create" },
      changed: true,
      replayed: false,
    };
  });
}

/* ────────────────── 类目：编辑 / 启停 / 移除 ────────────────── */

/**
 * 编辑类目（名称 / 所属游戏 / 排序 / 启用状态）—— `updateCategory` 的 Pg 实现。
 *
 * 判定顺序（与 Mock 逐条相同）：
 *
 * ```
 * 1. 幂等键冲突                 → operation-conflict（前置读）
 * 2. 取锁；目标不存在            → not-found
 * 3. 已移除                      → removed
 * 4. 权威读：重放 / 什么都没改    → ok / changed:false
 * 5. 同游戏内未移除同名          → duplicate-name
 * 6. 窄 UPDATE + 审计
 * ```
 */
export async function updateCategoryPg(
  id: string,
  draft: CategoryDraft,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "category", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这条类目自己。判定与写入都围着这一行 —— */
    const existing = await lockCategoryForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    // 已移除的类目不再接受编辑：它已经不在导航里，改名称与排序没有任何去向
    if (existing.removedAt !== null) return { kind: "removed" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "category", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = adminCategoryActionFromPatch(existing, draft);

    // 两种「什么都没发生」都不写数据、不写审计、**也不刷新 updatedAt**，且都不是错误
    if (replay?.kind === "replay" || isCategoryProfileUnchanged(existing, draft)) {
      return {
        kind: "ok",
        // 两份互不相关的副本，而不是同一个对象的两个别名
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const categories = await createCatalogRepository(tx).listCategories();
    if (hasDuplicateCategoryName(indexCategories(categories), draft.gameId, draft.name, id)) {
      return { kind: "duplicate-name" };
    }

    const written = await createCatalogRepository(tx).updateCategory(id, {
      ...draft,
      at: ctx.at,
    });
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；
    // 当作失败返回，绝不继续写审计（与 Mock 的 `if (!written) return { kind: "not-found" }` 同）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "category",
        targetId: id,
        before: toCategoryAuditSnapshot(written.previous),
        after: toCategoryAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/**
 * 启用 / 停用类目（**窄写入**：只改这一个字段）—— `setCategoryEnabled` 的 Pg 实现。
 *
 * ⚠️ 与 `updateCategoryPg()` 分开，是因为它**不该碰名称、所属游戏与排序**：
 * 列表页上的启用开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的名称覆盖回旧值。
 */
export async function setCategoryEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const pre = await takeReplayTx(tx, ctx, "category", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockCategoryForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    if (existing.removedAt !== null) return { kind: "removed" };

    const replay = await takeReplayTx(tx, ctx, "category", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = enabled ? "category.enable" : "category.disable";

    // 已经是那个状态：不写数据、不写审计、不刷新时间戳，且**不是错误**
    if (replay?.kind === "replay" || existing.enabled === enabled) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await createCatalogRepository(tx).setCategoryEnabled(id, enabled, ctx.at);
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "category",
        targetId: id,
        before: toCategoryAuditSnapshot(written.previous),
        after: toCategoryAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/**
 * 移除类目（软删除）—— `removeCategory` 的 Pg 实现。
 *
 * ⚠️ **有未移除商品时禁止删除，且不级联删除商品**：计数与写入在同一个事务、
 * 且在**持有类目行锁**期间，因此「先数了是 0、写的时候已经有商品了」不会发生。
 * 计数口径复用仓储的 `countProductsInCategory`（只数未移除的）。
 */
export async function removeCategoryPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const pre = await takeReplayTx(tx, ctx, "category", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockCategoryForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };

    const replay = await takeReplayTx(tx, ctx, "category", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // 已经移除了：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误
    if (replay?.kind === "replay" || existing.removedAt !== null) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action: "category.remove" },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const count = await createCatalogRepository(tx).countProductsInCategory(id);
    if (count > 0) return { kind: "has-products", count };

    const written = await createCatalogRepository(tx).markCategoryRemoved(id, ctx.at);
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "category.remove",
        targetType: "category",
        targetId: id,
        before: toCategoryAuditSnapshot(written.previous),
        after: toCategoryAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { ...written, action: "category.remove" },
      changed: true,
      replayed: false,
    };
  });
}

/* ─────────────────────────── 商品：新建 ─────────────────────────── */

/**
 * 新建商品（含它的全部规格，一次写入）—— `createProduct` 的 Pg 实现。
 *
 * 判定顺序（与 Mock 逐条相同）：
 *
 * ```
 * 1. 幂等键用在别的对象上        → operation-conflict
 * 2. 重放（账本有、记录无）      → not-found
 * 3. 归属校验（游戏 / 类目）     → game-invalid / category-invalid / category-unavailable
 * 4. 规格解析（发 id / 拒伪造 / 金额与排序校验）
 * 5. 上架却无有效规格            → no-effective-spec
 * 6. 写入商品 + 规格 + 审计
 * ```
 *
 * ⚠️ `draft.specs` 的解析（发新 id、拒绝伪造 id、算 `removedAt`、校验金额与排序）
 * 完全交给 Mock 的 `resolveSpecs()`——**那条规则只有一处定义**。
 */
export async function createProductPg(
  draft: ProductDraft,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [catalogCreateLockKey(ctx.operationId)]);

    const replay = await takeCreateReplayTx(tx, ctx, "product");
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay") {
      const existing = await createCatalogRepository(tx).findProductForAdmin(replay.targetId);
      if (!existing) return { kind: "not-found" };
      return {
        kind: "ok",
        value: { previous: null, updated: cloneProductRecord(existing), action: "product.create" },
        changed: false,
        replayed: true,
      };
    }

    const category = categoryFailure(
      await loadCatalogStoreTx(tx),
      draft.gameId,
      draft.categoryId,
    );
    if (category) return category;

    const resolved = resolveSpecs(draft.specs, null, ctx.at);
    if (!resolved.ok) return resolved.failure;

    if (draft.status === "on" && effectiveSpecCount(resolved.specs) === 0) {
      return { kind: "no-effective-spec" };
    }

    const created: CatalogProductRecord = {
      // 与类目同理：不用 Mock 的同步 `nextRecordId()`，改「主键冲突即硬失败」
      id: `p_${crypto.randomUUID()}`,
      ...draft,
      tags: [...draft.tags],
      detailImages: [...draft.detailImages],
      // 销量与平台标签**不由后台写入**：前者是统计、后者是平台侧展示字段，
      // 新建商品从 0 与空开始，等真实数据填上。
      monthlySales: 0,
      gameTag: "",
      createdAt: ctx.at,
      updatedAt: ctx.at,
      removedAt: null,
      specs: resolved.specs,
    };

    await createCatalogRepository(tx).createProduct(created);

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "product.create",
        targetType: "product",
        targetId: created.id,
        before: null,
        after: toProductAuditSnapshot(created),
      }),
    );

    return {
      kind: "ok",
      value: { previous: null, updated: created, action: "product.create" },
      changed: true,
      replayed: false,
    };
  });
}

/* ─────────────────────────── 商品：编辑 ─────────────────────────── */

/**
 * 编辑商品与它的全部规格（**一次原子写入**）—— `updateProduct` 的 Pg 实现。
 *
 * ⚠️ **判定顺序与 Mock 完全一致**：归属与规格校验排在 replay / no-op 判定**之前**，
 * 因此即便这次是重放，一份非法的提交仍然会被拒绝。别把权威读提到这些校验之前。
 *
 * ⚠️ 保存**不会改变已下过的订单**：订单读的是下单那一刻的快照。
 */
export async function updateProductPg(
  id: string,
  draft: ProductDraft,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const pre = await takeReplayTx(tx, ctx, "product", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockProductForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    // 已移除的商品不再接受编辑：它已经不在用户端了，改标题与价格没有任何去向
    if (existing.removedAt !== null) return { kind: "removed" };

    const category = categoryFailure(
      await loadCatalogStoreTx(tx),
      draft.gameId,
      draft.categoryId,
    );
    if (category) return category;

    const resolved = resolveSpecs(draft.specs, existing.specs, ctx.at);
    if (!resolved.ok) return resolved.failure;

    // 上架商品不能停用或删除最后一个有效规格 —— 这次保存之后它仍要在架，
    // 因此目标状态必须至少留一个有效规格
    if (draft.status === "on" && effectiveSpecCount(resolved.specs) === 0) {
      return { kind: "no-effective-spec" };
    }

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "product", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = adminProductActionFromPatch(existing, draft.status);
    const target = { ...draft, specs: resolved.specs };

    // 两种「什么都没发生」都不写数据、不写审计、也不刷新时间戳，且都不是错误
    if (replay?.kind === "replay" || isProductProfileUnchanged(existing, target)) {
      return {
        kind: "ok",
        value: {
          previous: cloneProductRecord(existing),
          updated: cloneProductRecord(existing),
          action,
        },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await createCatalogRepository(tx).updateProduct(id, {
      ...target,
      at: ctx.at,
    });
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "product",
        targetId: id,
        before: toProductAuditSnapshot(written.previous),
        after: toProductAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/* ────────────────── 商品：上下架 / 移除 ────────────────── */

/**
 * 上架 / 下架（**窄写入**：只改 `status`）—— `setProductStatus` 的 Pg 实现。
 *
 * ⚠️ 与 `updateProductPg()` 分开，理由同 `setCategoryEnabledPg()`：列表页上的上下架按钮
 * 只应当改状态，不该顺带覆盖标题 / 封面 / 规格。
 *
 * ⚠️ **判定顺序与 Mock 一致**：replay / 状态未变 先返回，**之后**才在转向 `on` 时
 * 做归属与有效规格校验——重复上架一条已在架的商品不该报错。
 */
export async function setProductStatusPg(
  id: string,
  status: CatalogProductRecord["status"],
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const pre = await takeReplayTx(tx, ctx, "product", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockProductForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    if (existing.removedAt !== null) return { kind: "removed" };

    const replay = await takeReplayTx(tx, ctx, "product", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = status === "on" ? "product.publish" : "product.unpublish";

    if (replay?.kind === "replay" || existing.status === status) {
      return {
        kind: "ok",
        value: {
          previous: cloneProductRecord(existing),
          updated: cloneProductRecord(existing),
          action,
        },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    if (status === "on") {
      // §类目规则：**停用或删除类目不能用于上架商品**。下架则不校验。
      if (existing.categoryId === null) return { kind: "category-invalid" };
      const category = categoryFailure(
        await loadCatalogStoreTx(tx),
        existing.gameId,
        existing.categoryId,
      );
      if (category) return category;

      if (effectiveSpecCount(existing.specs) === 0) return { kind: "no-effective-spec" };
    }

    const written = await createCatalogRepository(tx).setProductStatus(id, status, ctx.at);
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "product",
        targetId: id,
        before: toProductAuditSnapshot(written.previous),
        after: toProductAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/**
 * 移除商品（软删除）—— `removeProduct` 的 Pg 实现。
 *
 * ⚠️ **不删除记录**：历史订单、收藏记录与评价都要继续指得到它。
 */
export async function removeProductPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const pre = await takeReplayTx(tx, ctx, "product", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockProductForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };

    const replay = await takeReplayTx(tx, ctx, "product", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // 已经移除了：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误
    if (replay?.kind === "replay" || existing.removedAt !== null) {
      return {
        kind: "ok",
        value: {
          previous: cloneProductRecord(existing),
          updated: cloneProductRecord(existing),
          action: "product.remove",
        },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await createCatalogRepository(tx).markProductRemoved(id, ctx.at);
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "product.remove",
        targetType: "product",
        targetId: id,
        before: toProductAuditSnapshot(written.previous),
        after: toProductAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { ...written, action: "product.remove" },
      changed: true,
      replayed: false,
    };
  });
}
