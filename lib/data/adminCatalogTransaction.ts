import { toCategoryAuditSnapshot, toProductAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  adminCategoryActionFromPatch,
  isCategoryProfileUnchanged,
} from "@/lib/constants/adminCategories";
import {
  PRODUCT_SORT_ORDER_MAX,
  PRODUCT_SORT_ORDER_MIN,
  adminProductActionFromPatch,
  effectiveSpecCount,
  isProductProfileUnchanged,
} from "@/lib/constants/adminProducts";
import type { AdminCategoryProfilePatch, CategoryRecord } from "@/lib/types/catalog";
import type {
  AdminProductSpecPatch,
  CatalogProductRecord,
  ProductProfileDraft,
  ProductSpecRecord,
  ProductStatus,
} from "@/lib/types/product";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import {
  nextRecordId,
  takeCreateReplay,
  takeReplay,
  writeAudit,
  type AdminWriteCommonFailure,
  type AdminWriteContext,
} from "./adminWriteSupport";
import {
  applyCategoryEnabled,
  applyCategoryPatch,
  applyCategoryRemoval,
  applyProductPatch,
  applyProductRemoval,
  applyProductStatus,
  catalogStore,
  createCategoryRecord,
  createProductRecord,
} from "./mockCatalogRepository";

/**
 * 商品目录写操作的**伪事务** —— 本阶段所有类目、商品与规格改动的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * §一致性 要求「商品与规格保存为一次原子写入」，「上架校验、类目删除校验与写入
 * 不能被并发穿透」，「重复或并发请求不得产生重复实体或审计」。这几件事分属
 * 「类目」「商品」「审计」三张表，仓库里没有事务可用，于是这里用一件事替代：
 * **把读—判断—写的全过程放进一段没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「停用最后一个规格」请求，第二个进来时第一个已经全部写完，
 * 它读到的是**已经保存过**的那份规格，于是同样被规则挡住。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。所有 store 句柄都在区段之外（函数开头）取好，
 * 区段内只做同步的读写。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份
 * 存储，缓存下来的 Map 会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * **先校验再写入**：每个操作都先确认目标存在、前置条件成立，然后才动手；
 * 任何一个前置条件不满足都在写入之前返回，因此失败不会留下半完成的数据。
 * 尤其是商品保存：规格数组在写入之前就已经完全解析好（含新 id 的生成与
 * 伪造 id 的拒绝），不存在「商品改了、规格没改」的中间状态。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + 唯一索引），
 * 上层的 service 与接口一行都不用改。
 */

// ——————————————————————————— 类型 ———————————————————————————

/**
 * 写上下文（管理者 id、幂等键、服务端时间戳）。
 *
 * 定义在 `./adminWriteSupport`，这里再导出一次是为了让服务层只从**一个**模块
 * 导入事务相关的东西：`AdminWriteContext` 是调用事务必需的参数，
 * 让调用方去第二个文件里找它，只会让人以为它属于另一个层次。
 */
export type { AdminWriteContext };

/**
 * 新建 / 编辑类目的入参（**已通过字段校验**，这里只管业务前置条件）。
 *
 * 直接复用类型层定义的编辑白名单，而不是在这里另写一份：两处各写一份的话，
 * 「后台能改什么」迟早会有两个答案。
 */
export type CategoryDraft = AdminCategoryProfilePatch;

/**
 * 新建 / 编辑商品的入参（**已通过字段校验**）。
 *
 * 复用类型层的编辑白名单 `ProductProfilePatch`，只把规格的金额换成整数分
 * （`ProductProfileDraft`）：`specs` 是**完整的目标状态**，
 * `id` 为空串表示新增，非空必须是该商品已有的规格 id。规格的增、删、改、排序、启停
 * 全部通过这一份数组表达，因此不存在「商品改了、规格没改」这种半完成的状态。
 */
export type ProductDraft = ProductProfileDraft;

/** 这些操作独有的失败情形。公共的三种（不存在 / 已移除 / 幂等键冲突）见 `AdminWriteCommonFailure`。 */
export type AdminCatalogWriteFailure =
  | AdminWriteCommonFailure
  /**
   * 同一游戏内已有**未移除**的同名类目。
   *
   * 判定在事务里而不是服务层：服务层的「先查有没有、再创建」中间隔着 `await`，
   * 两个同时到达的同名创建请求完全可能都查到「没有」。
   */
  | { kind: "duplicate-name" }
  /** 类目下还有未移除的商品，不能删除（**不级联删除商品**）。 */
  | { kind: "has-products"; count: number }
  /**
   * 上架商品至少要有一个有效规格。
   *
   * 一条规则覆盖三个入口：新建时就上架、把商品上架、以及保存一份会让在架商品
   * 失去最后一个有效规格的规格列表——它们说的本来就是同一件事。
   */
  | { kind: "no-effective-spec" }
  /**
   * 所选游戏不存在。
   *
   * 与下面两条一起构成 §商品规则 的「**类目必须属于所选游戏且启用、未移除**」。
   * 三条判定全在原子区段里做，因此「服务层查过没问题、写入时类目刚被停用」
   * 这种并发穿透不会发生——类目被停用的那一次写入与这里读到的，是同一个区段前后的顺序。
   */
  | { kind: "game-invalid" }
  /** 类目不存在，或不属于所选游戏。 */
  | { kind: "category-invalid" }
  /** 类目存在且属于所选游戏，但已停用或已移除。 */
  | { kind: "category-unavailable" }
  /** 提交了一个**不属于该商品**的规格 id（伪造或过期的表单）。 */
  | { kind: "unknown-spec"; specId: string }
  /** 同一份提交里同一个规格 id 出现了两次。 */
  | { kind: "duplicate-spec-id"; specId: string }
  /**
   * 单价不是**正整数分**。
   *
   * ⚠️ 这是「禁止浮点金额进入实体」的最后一道，也是唯一一道**数据层**的关口：
   * 界面上输入的是元，转换在 `lib/constants/adminProducts.ts` 里用字符串完成，
   * 但转换本身也不是凭据——只要有一条路径漏掉了转换（或者将来有人直接调写接口），
   * 一个 `29.9` 就会进到商品记录里，而结算金额是按分算的，`29.9` 分是 0.299 元。
   * 与其相信调用方，不如让写入本身不接受。
   */
  | { kind: "price-invalid"; specId: string }
  /**
   * 规格的组内排序不是合法整数。
   *
   * 与 `price-invalid` 同一个理由：`NaN` 写进实体不会报错，只会让排序比较**永远为假**，
   * 于是规格顺序变成随机的——而且从数据上看不出任何异常，事后无从排查。
   * 区间边界取自 `lib/constants/adminProducts.ts`，不在数据层另写一套数字。
   */
  | { kind: "spec-order-invalid"; specId: string };

export type AdminCategoryWriteOutcome =
  | {
      kind: "ok";
      value: {
        /** 新建时为 null（当时还不存在「更新前」） */
        previous: CategoryRecord | null;
        updated: CategoryRecord;
        action: AdminAuditAction;
      };
      changed: boolean;
      replayed: boolean;
    }
  | AdminCatalogWriteFailure;

export type AdminProductWriteOutcome =
  | {
      kind: "ok";
      value: {
        previous: CatalogProductRecord | null;
        updated: CatalogProductRecord;
        action: AdminAuditAction;
      };
      changed: boolean;
      replayed: boolean;
    }
  | AdminCatalogWriteFailure;

// ——————————————————————————— 内部工具 ———————————————————————————

/**
 * 同一游戏内是否已有**未移除**的同名类目。
 *
 * 两条口径写在这里一处：
 * - 比较的是**未移除**的类目，与启用状态无关——一条停用的类目随时可能被启用，
 *   不占用名字的话，启用之后就会冒出两条同名类目；
 * - 名称按**去首尾空格后的完全相同**比较，不做大小写或全半角折叠：
 *   「机密单」与「机密 单」是两条不同的类目，规则不替运营猜。
 */
function hasDuplicateCategoryName(
  categories: Map<string, CategoryRecord>,
  gameId: string,
  name: string,
  excludeId: string | null,
): boolean {
  for (const category of categories.values()) {
    if (category.id === excludeId) continue;
    if (category.gameId !== gameId) continue;
    if (category.removedAt !== null) continue;
    if (category.name === name) return true;
  }
  return false;
}

/** store 的形状，只为下面几个校验函数签名用。 */
type CatalogStore = ReturnType<typeof catalogStore>;

/**
 * 商品归属是否成立：游戏真实存在，类目属于该游戏、且**启用、未移除**。
 *
 * ⚠️ 这条规则（§商品规则）在服务层已经查过一遍——那里查是为了给表单**字段级**的错误，
 * 让运营看到「所属类目这一栏不对」。这里再查一遍是为了**并发**：
 * 服务层的检查与写入之间隔着 `await`，正好够另一个请求把那个类目停用掉。
 * 两次检查针对的是同一件事，但只有这一次是权威的。
 *
 * 返回 `null` 表示没问题。三种失败分开报，是因为处置完全不同：
 * 游戏选错了要改游戏，类目选错了要改类目，类目被停用了要么换一个、要么先启用它。
 */
function categoryFailure(
  catalog: CatalogStore,
  gameId: string,
  categoryId: string,
): AdminCatalogWriteFailure | null {
  if (!catalog.games.has(gameId)) return { kind: "game-invalid" };

  const category = catalog.categories.get(categoryId);
  if (!category || category.gameId !== gameId) return { kind: "category-invalid" };
  if (category.removedAt !== null || !category.enabled) return { kind: "category-unavailable" };
  return null;
}

type SpecResolution =
  | { ok: true; specs: ProductSpecRecord[] }
  | { ok: false; failure: AdminCatalogWriteFailure };

/**
 * 把提交的规格数组解析成**可写入的记录数组**。
 *
 * 三件事在这里一次做完，且全部是同步的：
 * 1. **新规格发 id**（`sp_` 前缀）：id 必须稳定，因为它会被写进订单快照；
 * 2. **拒绝认不出来的 id**：非空 id 必须属于这个商品现有的规格。把一个陌生 id
 *    当成新规格收下，会让一次手误悄悄多出一条重复规格，而「商品里为什么有两行
 *    一模一样的规格」事后很难追；
 * 3. **算 `removedAt`**：本次要求移除的，本来没移除过就记本次操作的时间；
 *    本来就已经移除的**保留原时间**——「什么时候被移除的」应当指向第一次，
 *    而不是每一次保存都刷新一遍。
 *
 * ⚠️ 完整解析之后再交给写入器：规格数组是整份替换的，因此不存在
 * 「前两条改了、第三条没写进去」这种半完成状态。
 */
function resolveSpecs(
  drafts: readonly AdminProductSpecPatch[],
  existing: readonly ProductSpecRecord[] | null,
  at: string,
): SpecResolution {
  const existingById = new Map<string, ProductSpecRecord>();
  for (const spec of existing ?? []) existingById.set(spec.id, spec);

  const seen = new Set<string>();
  const specs: ProductSpecRecord[] = [];

  for (const draft of drafts) {
    let id = draft.id;
    if (id === "") {
      id = nextRecordId("sp_", (candidate) => seen.has(candidate), "规格");
    } else if (!existingById.has(id)) {
      return { ok: false, failure: { kind: "unknown-spec", specId: id } };
    }

    if (seen.has(id)) return { ok: false, failure: { kind: "duplicate-spec-id", specId: id } };
    seen.add(id);

    // 金额只以**整数分**进入实体，且必须大于 0。这条检查在数据层而不是服务层，
    // 因此没有任何一条路径绕得过它（见 `price-invalid` 的说明）
    if (!Number.isInteger(draft.price) || draft.price <= 0) {
      return { ok: false, failure: { kind: "price-invalid", specId: id } };
    }

    // 排序同样只接受区间内的整数：`NaN` 一旦落库，排序比较永远为假，
    // 规格顺序会变得随机且查不出原因（见 `spec-order-invalid` 的说明）
    if (
      !Number.isInteger(draft.sortOrder) ||
      draft.sortOrder < PRODUCT_SORT_ORDER_MIN ||
      draft.sortOrder > PRODUCT_SORT_ORDER_MAX
    ) {
      return { ok: false, failure: { kind: "spec-order-invalid", specId: id } };
    }

    const previous = existingById.get(id);
    specs.push({
      id,
      name: draft.name,
      price: draft.price,
      sortOrder: draft.sortOrder,
      enabled: draft.enabled,
      removedAt: draft.removed ? (previous?.removedAt ?? at) : null,
    });
  }

  return { ok: true, specs };
}


// ——————————————————————————— 类目：新建 ———————————————————————————

/**
 * 新建类目。
 *
 * 「同一个幂等键第二次到达」在这里必须靠**操作类型**识别，而不是靠目标 id：
 * 新建的目标 id 是在原子区段里当场生成的，第二次调用会生成一个不同的 id，
 * 按 id 比对只会把它误判成「幂等键被别的对象用了」。`takeCreateReplay()` 因此
 * 只认「这个键已经被同类型的对象用过」，再拿审计里记下的 id 把当时那条记录找回来。
 */
export async function createCategory(
  draft: CategoryDraft,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeCreateReplay(ctx.operationId, "category");
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  if (replay) {
    const existing = catalog.categories.get(replay.targetId);
    // 审计里有、记录却没有：数据被清过。宁可报「不存在」，也不编一条出来
    if (!existing) return { kind: "not-found" };
    return {
      kind: "ok",
      value: { previous: null, updated: { ...existing }, action: "category.create" },
      changed: false,
      replayed: true,
    };
  }

  if (hasDuplicateCategoryName(catalog.categories, draft.gameId, draft.name, null)) {
    return { kind: "duplicate-name" };
  }

  const created = createCategoryRecord({
    id: nextRecordId("c_", (candidate) => catalog.categories.has(candidate), "类目"),
    gameId: draft.gameId,
    name: draft.name,
    sortOrder: draft.sortOrder,
    enabled: draft.enabled,
    createdAt: ctx.at,
    updatedAt: ctx.at,
    removedAt: null,
  });

  writeAudit({
    ctx,
    action: "category.create",
    targetType: "category",
    targetId: created.id,
    before: null,
    after: toCategoryAuditSnapshot(created),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous: null, updated: created, action: "category.create" },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 类目：编辑 / 启停 / 移除 ———————————————————————————

/**
 * 编辑类目（名称 / 所属游戏 / 排序）。
 *
 * `enabled` 也在 `CategoryDraft` 里，因此编辑表单可以一次把三个字段与启用状态一起提交。
 * 变化的是启用状态时，审计动作由 `adminCategoryActionFromPatch()` 推导成
 * 「启用类目 / 停用类目」——不管这次改动是来自 `PATCH` 还是 `POST /disable`，
 * 记的都是同一件事。
 */
export async function updateCategory(
  id: string,
  draft: CategoryDraft,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "category", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.categories.get(id);
  if (!existing) return { kind: "not-found" };
  // 已移除的类目不再接受编辑：它已经不在导航里，改名称与排序没有任何去向
  if (existing.removedAt !== null) return { kind: "removed" };

  const action = adminCategoryActionFromPatch(existing, draft);

  // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**
  if (replay?.kind === "replay" || isCategoryProfileUnchanged(existing, draft)) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  if (hasDuplicateCategoryName(catalog.categories, draft.gameId, draft.name, id)) {
    return { kind: "duplicate-name" };
  }

  const written = applyCategoryPatch(id, { ...draft, at: ctx.at });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "category",
    targetId: id,
    before: toCategoryAuditSnapshot(written.previous),
    after: toCategoryAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

/**
 * 启用 / 停用类目（窄写入：只改这一个字段）。
 *
 * ⚠️ 与 `updateCategory()` 分开，是因为它**不该碰名称、所属游戏与排序**：
 * 列表页上的启用开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的名称覆盖回旧值。
 */
export async function setCategoryEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "category", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.categories.get(id);
  if (!existing) return { kind: "not-found" };
  if (existing.removedAt !== null) return { kind: "removed" };

  const action: AdminAuditAction = enabled ? "category.enable" : "category.disable";

  if (replay?.kind === "replay" || existing.enabled === enabled) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyCategoryEnabled(id, enabled, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "category",
    targetId: id,
    before: toCategoryAuditSnapshot(written.previous),
    after: toCategoryAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

/**
 * 移除类目（软删除）。
 *
 * ⚠️ **有未移除商品时禁止删除，且不级联删除商品**。两类错误做法都被挡在门外：
 * - 级联把商品一起删掉，等于一次点击静默下架了一批还在卖的东西；
 * - 不校验直接删，类目消失后那些商品会变成「挂在一条不可见类目下」，
 *   用户端搜不到、后台又要靠人肉比对才发现。
 *
 * 计数与写入在同一个原子区段里，因此「先数了是 0、写的时候已经有商品了」
 * 这种并发穿透不会发生。
 *
 * 「未移除」是唯一的计数条件：已经软删除的商品在用户端本来就不可见，
 * 让它们把类目锁死说不通。
 */
export async function removeCategory(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminCategoryWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "category", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.categories.get(id);
  if (!existing) return { kind: "not-found" };

  // 已经移除了：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误
  if (replay?.kind === "replay" || existing.removedAt !== null) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action: "category.remove" },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  let productCount = 0;
  for (const product of catalog.products.values()) {
    if (product.categoryId === id && product.removedAt === null) productCount += 1;
  }
  if (productCount > 0) return { kind: "has-products", count: productCount };

  const written = applyCategoryRemoval(id, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "category.remove",
    targetType: "category",
    targetId: id,
    before: toCategoryAuditSnapshot(written.previous),
    after: toCategoryAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { ...written, action: "category.remove" },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 商品：新建 ———————————————————————————

/**
 * 新建商品（含它的全部规格，一次写入）。
 *
 * 「上架前至少有一个有效规格」在这里就生效：以 `on` 状态新建、却一条有效规格都没有，
 * 会建出一条买不了的商品——它出现在列表里、点进去却没有任何可选项。
 */
export async function createProduct(
  draft: ProductDraft,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeCreateReplay(ctx.operationId, "product");
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  if (replay) {
    const existing = catalog.products.get(replay.targetId);
    if (!existing) return { kind: "not-found" };
    return {
      kind: "ok",
      value: {
        previous: null,
        updated: {
          ...existing,
          tags: [...existing.tags],
          detailImages: [...existing.detailImages],
          specs: existing.specs.map((spec) => ({ ...spec })),
        },
        action: "product.create",
      },
      changed: false,
      replayed: true,
    };
  }

  const category = categoryFailure(catalog, draft.gameId, draft.categoryId);
  if (category) return category;

  const resolved = resolveSpecs(draft.specs, null, ctx.at);
  if (!resolved.ok) return resolved.failure;

  if (draft.status === "on" && effectiveSpecCount(resolved.specs) === 0) {
    return { kind: "no-effective-spec" };
  }

  const created = createProductRecord({
    id: nextRecordId("p_", (candidate) => catalog.products.has(candidate), "商品"),
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
  });

  writeAudit({
    ctx,
    action: "product.create",
    targetType: "product",
    targetId: created.id,
    before: null,
    after: toProductAuditSnapshot(created),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous: null, updated: created, action: "product.create" },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 商品：编辑 ———————————————————————————

/**
 * 编辑商品与它的全部规格（**一次原子写入**）。
 *
 * 三件事在同一段无 `await` 的代码里完成：解析规格（含发新 id、拒绝伪造 id）、
 * 校验「在架商品至少一个有效规格」、写入商品与规格。因此不可能出现
 * 「商品保存了、规格没保存」或者「规格删空了、商品还在架上」这两种坏状态。
 *
 * ⚠️ 保存**不会改变已下过的订单**：订单读的是下单那一刻的快照
 * （`PaymentRequestSnapshot` → `OrderRecord`），与这条商品记录没有任何关联。
 * 改价只影响之后的试算与支付。
 */
export async function updateProduct(
  id: string,
  draft: ProductDraft,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "product", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.products.get(id);
  if (!existing) return { kind: "not-found" };
  // 已移除的商品不再接受编辑：它已经不在用户端了，改标题与价格没有任何去向
  if (existing.removedAt !== null) return { kind: "removed" };

  const category = categoryFailure(catalog, draft.gameId, draft.categoryId);
  if (category) return category;

  const resolved = resolveSpecs(draft.specs, existing.specs, ctx.at);
  if (!resolved.ok) return resolved.failure;

  // 上架商品不能停用或删除最后一个有效规格 —— 这次保存之后它仍要在架，
  // 因此目标状态必须至少留一个有效规格
  if (draft.status === "on" && effectiveSpecCount(resolved.specs) === 0) {
    return { kind: "no-effective-spec" };
  }

  const action = adminProductActionFromPatch(existing, draft.status);
  const target = { ...draft, specs: resolved.specs };

  // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**
  if (replay?.kind === "replay" || isProductProfileUnchanged(existing, target)) {
    return {
      kind: "ok",
      value: { previous: cloneRecord(existing), updated: cloneRecord(existing), action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyProductPatch(id, { ...target, at: ctx.at });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "product",
    targetId: id,
    before: toProductAuditSnapshot(written.previous),
    after: toProductAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

// ——————————————————————————— 商品：上下架 / 移除 ———————————————————————————

/**
 * 上架 / 下架（窄写入：只改 `status`）。
 *
 * ⚠️ 与 `updateProduct()` 分开，理由同 `setCategoryEnabled()`：列表页上的上下架按钮
 * 只应当改状态。走「读出整条商品、拼一个完整 patch 再保存」的话，两位管理员同时操作时，
 * 后写的那次会把另一位刚改好的价格覆盖回旧值——而价格正是最不能被静默覆盖的字段。
 *
 * **上架前必须有至少一个有效规格**：一条没有可选规格的商品出现在列表里，
 * 点进去是一页买不了的东西。已下架商品允许没有有效规格（下架之后停用最后一个规格
 * 是合法的），因此这个校验只在**转向 `on`** 时生效，而且放在「状态没变」判断之后
 * ——重复上架一条已在架的商品不该报错。
 */
export async function setProductStatus(
  id: string,
  status: ProductStatus,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "product", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.products.get(id);
  if (!existing) return { kind: "not-found" };
  if (existing.removedAt !== null) return { kind: "removed" };

  const action: AdminAuditAction = status === "on" ? "product.publish" : "product.unpublish";

  if (replay?.kind === "replay" || existing.status === status) {
    return {
      kind: "ok",
      value: { previous: cloneRecord(existing), updated: cloneRecord(existing), action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  if (status === "on") {
    // §类目规则：**停用或删除类目不能用于上架商品**。上架意味着它要出现在用户端列表里，
    // 而列表是按类目组织的——挂在一个用户端看不到的类目下，等于上架了一件谁也找不到的商品。
    // 下架则不校验：把一件本就挂在停用类目下的商品下架，是收拾局面，不该被拦。
    if (existing.categoryId === null) return { kind: "category-invalid" };
    const category = categoryFailure(catalog, existing.gameId, existing.categoryId);
    if (category) return category;

    if (effectiveSpecCount(existing.specs) === 0) return { kind: "no-effective-spec" };
  }

  const written = applyProductStatus(id, status, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "product",
    targetId: id,
    before: toProductAuditSnapshot(written.previous),
    after: toProductAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

/**
 * 移除商品（软删除）。
 *
 * ⚠️ **不删除记录**：历史订单、收藏记录与评价都要继续指得到它。
 * 移除之后商品从用户端完全消失（直链也是 404），后台可以用「已移除」筛选查到。
 */
export async function removeProduct(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminProductWriteOutcome> {
  const catalog = catalogStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "product", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = catalog.products.get(id);
  if (!existing) return { kind: "not-found" };

  // 已经移除了：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误
  if (replay?.kind === "replay" || existing.removedAt !== null) {
    return {
      kind: "ok",
      value: {
        previous: cloneRecord(existing),
        updated: cloneRecord(existing),
        action: "product.remove",
      },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyProductRemoval(id, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "product.remove",
    targetType: "product",
    targetId: id,
    before: toProductAuditSnapshot(written.previous),
    after: toProductAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { ...written, action: "product.remove" },
    changed: true,
    replayed: false,
  };
}

/** 本文件内部给「没有变化」的返回复制一份记录，避免把 store 里的对象交出去。 */
function cloneRecord(record: CatalogProductRecord): CatalogProductRecord {
  return {
    ...record,
    tags: [...record.tags],
    detailImages: [...record.detailImages],
    specs: record.specs.map((spec) => ({ ...spec })),
  };
}
