import {
  compareCategoriesForList,
  compareProductsForList,
  isCategoryVisible,
  isProductPubliclyListed,
  productMatchesKeyword,
  toPublicGame,
} from "@/lib/constants/catalog";
import { categorySeed, gameSeed, productSeed } from "@/lib/mocks/fixtures/catalogSeed";
import type { CategoryRecord, GameRecord } from "@/lib/types/catalog";
import type { CatalogProductRecord } from "@/lib/types/product";
import type { CatalogProductPatch, CatalogRepository } from "./catalogRepository";
import { getMockStore } from "./mockStore";

/**
 * 商品目录的**进程内** Mock 存储（P8B 起这里成为唯一的可写目录）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`(game_id, name)` 唯一索引 + 软删除 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * 建仓时把预置数据**逐字段复制**进 Map（商品的 `tags` / `detailImages` 数组与
 * `specs` 数组都再复制一层），而不是把 `catalogSeed` 里的对象直接放进去：
 * 后台会改这些记录，如果 Map 里存的就是模块级常量里的那个对象，
 * 一次编辑就把常量改了——测试之间互相污染，热更新后也再也回不到初始数据。
 *
 * 并发安全的前提：Node 是单线程的，下面「读—判断—写」的**原子区段内没有 `await`**。
 *
 * ⚠️ `catalogStore()` 是**导出**的：后台编辑要在一段不可打断的同步区段里
 * 同时写「商品 + 规格 + 审计」，那段伪事务在 `lib/data/adminCatalogTransaction.ts`。
 * 除它以外不要从别处取这个 store。
 */

type MockCatalogStore = {
  /** 游戏是**只读目录**（本阶段不做游戏管理），但仍然放进 store：它与类目、商品同源 */
  games: Map<string, GameRecord>;
  categories: Map<string, CategoryRecord>;
  products: Map<string, CatalogProductRecord>;
};

/** 复制一条商品记录（连规格一起）：仓储对外给的一律是快照。 */
function cloneProduct(record: CatalogProductRecord): CatalogProductRecord {
  return {
    ...record,
    tags: [...record.tags],
    detailImages: [...record.detailImages],
    specs: record.specs.map((spec) => ({ ...spec })),
  };
}

function createStore(): MockCatalogStore {
  const games = new Map<string, GameRecord>();
  for (const seed of gameSeed) {
    games.set(seed.id, { ...seed, regions: [...seed.regions] });
  }

  const categories = new Map<string, CategoryRecord>();
  for (const seed of categorySeed) {
    categories.set(seed.id, { ...seed });
  }

  const products = new Map<string, CatalogProductRecord>();
  for (const seed of productSeed) {
    products.set(seed.id, cloneProduct(seed));
  }

  return { games, categories, products };
}

export function catalogStore(): MockCatalogStore {
  return getMockStore("catalog", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockCatalogStore {
  return catalogStore();
}

export const mockCatalogRepository: CatalogRepository = {
  // ——————————————————————————— 游戏 ———————————————————————————

  async listGames() {
    return [...store().games.values()].map((game) => ({ ...game, regions: [...game.regions] }));
  },

  async findGameById(id) {
    const found = store().games.get(id);
    return found ? { ...found, regions: [...found.regions] } : null;
  },

  async listPublicGames() {
    const current = store();
    const categories = [...current.categories.values()];
    // 全部游戏都返回，即使某个游戏下一个可见类目都没有：游戏切换器是导航的一部分，
    // 让一个游戏因为类目被停用而整个消失，会把正在浏览它的用户甩到一个不存在的位置上。
    // 空类目由分类页自己渲染空态。
    return [...current.games.values()]
      .map((game) => toPublicGame(game, categories))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  },

  // ——————————————————————————— 类目 ———————————————————————————

  async listCategories() {
    // 已移除的类目**照样返回**：后台详情、商品归属校验与「这个商品原本属于哪个类目」
    // 都要读得到它。把可见性判断留在调用方，是因为公开与后台两套口径完全不同。
    return [...store().categories.values()]
      .sort(compareCategoriesForList)
      .map((category) => ({ ...category }));
  },

  async findCategoryById(id) {
    const found = store().categories.get(id);
    return found ? { ...found } : null;
  },

  async queryCategoriesForAdmin(filter) {
    const { keyword, gameId, enabled, removal } = filter;
    const needle = keyword.trim().toLowerCase();

    return [...store().categories.values()]
      .filter((category) =>
        removal === "removed" ? category.removedAt !== null : category.removedAt === null,
      )
      .filter((category) => {
        if (enabled === "") return true;
        return enabled === "enabled" ? category.enabled : !category.enabled;
      })
      .filter((category) => !gameId || category.gameId === gameId)
      .filter((category) => !needle || category.name.toLowerCase().includes(needle))
      .sort(compareCategoriesForList)
      .map((category) => ({ ...category }));
  },

  // ——————————————————————————— 商品 ———————————————————————————

  async findProductById(id) {
    const found = store().products.get(id);
    // ⚠️ 软删除的商品在这里返回 null，与类目的处理**刻意不同**：
    // 类目被移除之后仍然要能回答「这条商品属于哪个类目」，而商品被移除之后
    // 用户端就不该再看到它——直链也应当是一个干净的 404，而不是一页「已删除」的详情。
    // 后台要读已移除的商品，走 `findProductForAdmin()`。
    if (!found || found.removedAt !== null) return null;
    return cloneProduct(found);
  },

  async findProductForAdmin(id) {
    const found = store().products.get(id);
    return found ? cloneProduct(found) : null;
  },

  async listPublicProducts() {
    const current = store();
    const visibleCategoryIds = new Set(
      [...current.categories.values()]
        .filter(isCategoryVisible)
        .map((category) => category.id),
    );

    return [...current.products.values()]
      .filter(isProductPubliclyListed)
      // 挂在不可见类目下的商品用户端没有任何入口能走到，因此不进列表。
      // 它的直链仍然可用（商品自己是上架的），这是有意的：商品被下架是一个独立动作，
      // 不该因为类目被停用而连带失效。
      .filter(
        (product) => product.categoryId !== null && visibleCategoryIds.has(product.categoryId),
      )
      .sort(compareProductsForList)
      .map(cloneProduct);
  },

  async queryProductsForAdmin(filter) {
    const { keyword, gameId, categoryId, status, recommended, removal } = filter;

    return [...store().products.values()]
      .filter((product) =>
        removal === "removed" ? product.removedAt !== null : product.removedAt === null,
      )
      .filter((product) => {
        if (status === "") return true;
        return product.status === status;
      })
      .filter((product) => {
        if (recommended === "") return true;
        return recommended === "recommended" ? product.recommended : !product.recommended;
      })
      .filter((product) => !gameId || product.gameId === gameId)
      .filter((product) => !categoryId || product.categoryId === categoryId)
      .filter((product) => productMatchesKeyword(product, keyword))
      .sort(compareProductsForList)
      .map(cloneProduct);
  },

  async countProductsInCategory(categoryId) {
    let count = 0;
    for (const product of store().products.values()) {
      if (product.categoryId === categoryId && product.removedAt === null) count += 1;
    }
    return count;
  },

  // ——————————————————————————— 写入（仓储接口） ———————————————————————————

  async createCategory(record) {
    return createCategoryRecord(record);
  },

  async updateCategory(id, patch) {
    return applyCategoryPatch(id, patch);
  },

  async setCategoryEnabled(id, enabled, at) {
    return applyCategoryEnabled(id, enabled, at);
  },

  async markCategoryRemoved(id, at) {
    return applyCategoryRemoval(id, at);
  },

  async createProduct(record) {
    return createProductRecord(record);
  },

  async updateProduct(id, patch) {
    return applyProductPatch(id, patch);
  },

  async setProductStatus(id, status, at) {
    return applyProductStatus(id, status, at);
  },

  async markProductRemoved(id, at) {
    return applyProductRemoval(id, at);
  },
};

// ——————————————————————————— 同步写入器 ———————————————————————————

/**
 * 下面六个函数是**同步**的，并且是这份目录唯一的写入实现。
 *
 * 为什么要把写入抽成同步函数：后台的一次保存要求「商品 + 规格 + 审计」在
 * 同一段**没有 `await`** 的区段里完成（§原子性）。如果那段伪事务直接操作 Map，
 * 它就得自己维护「规格数组怎么替换」「`updatedAt` 谁来写」这些约定——
 * 一旦有两处维护，迟早出现「商品改了、规格没跟上」这种查不出来的脏数据。
 *
 * 因此：仓储方法只是把它们包成 `async`（对外接口不变），
 * 伪事务（`lib/data/adminCatalogTransaction.ts`）直接调用同步版本。
 * 两者共用同一份实现，行为不可能分叉。
 */

export function createCategoryRecord(record: CategoryRecord): CategoryRecord {
  const current = store();

  // —— 原子区段开始（无 await）——
  current.categories.set(record.id, { ...record });
  // —— 原子区段结束 ——

  return { ...record };
}

/**
 * 编辑类目。
 *
 * ⚠️ 只覆盖 `patch` 里那些字段：`id`、`createdAt`、`removedAt` 一律原样保留。
 * 「顺手把一条已移除的类目改回未移除」在 `patch` 类型里没有位置可写——
 * 要让人回来必须走新的流程，而不是靠编辑把软删除的记录重新点亮。
 */
export function applyCategoryPatch(
  id: string,
  patch: Pick<CategoryRecord, "gameId" | "name" | "sortOrder" | "enabled"> & { at: string },
): { previous: CategoryRecord; updated: CategoryRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.categories.get(id);
  if (!existing) return null;

  const { at, ...fields } = patch;
  const updated: CategoryRecord = { ...existing, ...fields, updatedAt: at };
  current.categories.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

/**
 * 只改类目的启用状态。
 *
 * ⚠️ 单独开一个窄写入器，而不是复用 `applyCategoryPatch()`：后台的「停用」按钮
 * 只应当改这一个字段，**绝不能**顺带把名称、所属游戏、排序一起写回去——
 * 那需要调用方先把整条记录读出来再拼一个完整 patch，而那份读取发生在原子区段之外。
 * 窄写入器让这种覆盖在结构上不可能发生。
 */
export function applyCategoryEnabled(
  id: string,
  enabled: boolean,
  at: string,
): { previous: CategoryRecord; updated: CategoryRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.categories.get(id);
  if (!existing) return null;

  const updated: CategoryRecord = { ...existing, enabled, updatedAt: at };
  current.categories.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

/**
 * 软移除类目。**不删除记录**：商品归属要靠它才说得清「这条商品原本属于哪个类目」，
 * 硬删会让这个信息永久消失。
 *
 * 已经移除时原样返回（`previous === updated`）且**不刷新时间戳**：
 * 重复移除不产生第二次变更，因此调用方据此就不该写第二条审计。
 */
export function applyCategoryRemoval(
  id: string,
  at: string,
): { previous: CategoryRecord; updated: CategoryRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.categories.get(id);
  if (!existing) return null;

  if (existing.removedAt !== null) {
    return { previous: { ...existing }, updated: { ...existing } };
  }

  const updated: CategoryRecord = { ...existing, removedAt: at, updatedAt: at };
  current.categories.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

export function createProductRecord(record: CatalogProductRecord): CatalogProductRecord {
  const current = store();

  // —— 原子区段开始（无 await）——
  current.products.set(record.id, cloneProduct(record));
  // —— 原子区段结束 ——

  return cloneProduct(record);
}

/**
 * 编辑商品**与它的全部规格**。
 *
 * ⚠️ 规格是**整份替换**（`patch.specs` 就是目标状态），不是逐条打补丁。
 * 这一点很关键：「新增一条规格、同时把另一条停用、再把第三条移除」如果拆成三个写操作，
 * 中途失败就会留下半完成的数据；而整份替换只有「全成」与「全不成」两种结果，
 * 且这一次 `set` 是同步的，中间不可能被别的请求插入。
 *
 * `updatedAt` 由调用方给的 `at` 决定（业务写入与审计共用同一个时间戳）。
 */
export function applyProductPatch(
  id: string,
  patch: CatalogProductPatch & { at: string },
): { previous: CatalogProductRecord; updated: CatalogProductRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.products.get(id);
  if (!existing) return null;

  const { at, specs, ...fields } = patch;
  const updated: CatalogProductRecord = {
    ...existing,
    ...fields,
    tags: [...fields.tags],
    detailImages: [...fields.detailImages],
    specs: specs.map((spec) => ({ ...spec })),
    updatedAt: at,
  };
  current.products.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: cloneProduct(existing), updated: cloneProduct(updated) };
}

/**
 * 只改商品的上下架状态。
 *
 * 窄写入器，理由同 `applyCategoryEnabled()`：上下架只该动这一个字段，
 * 不该顺带把标题、封面、规格覆盖成调用方读到时的旧值。
 */
export function applyProductStatus(
  id: string,
  status: CatalogProductRecord["status"],
  at: string,
): { previous: CatalogProductRecord; updated: CatalogProductRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.products.get(id);
  if (!existing) return null;

  const updated: CatalogProductRecord = { ...existing, status, updatedAt: at };
  current.products.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: cloneProduct(existing), updated: cloneProduct(updated) };
}

/**
 * 软移除商品。**不删除记录**：历史订单、收藏记录与评价都要继续指得到它。
 *
 * 已经移除时原样返回且不刷新时间戳，理由同 `applyCategoryRemoval()`。
 */
export function applyProductRemoval(
  id: string,
  at: string,
): { previous: CatalogProductRecord; updated: CatalogProductRecord } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.products.get(id);
  if (!existing) return null;

  if (existing.removedAt !== null) {
    return { previous: cloneProduct(existing), updated: cloneProduct(existing) };
  }

  const updated: CatalogProductRecord = { ...existing, removedAt: at, updatedAt: at };
  current.products.set(id, cloneProduct(updated));
  // —— 原子区段结束 ——

  return { previous: cloneProduct(existing), updated: cloneProduct(updated) };
}

/** 供事务内生成 id 用：某个商品 id 是否已被占用。 */
export function hasProductId(id: string): boolean {
  return store().products.has(id);
}

/** 供事务内生成 id 用：某个类目 id 是否已被占用。 */
export function hasCategoryId(id: string): boolean {
  return store().categories.has(id);
}
