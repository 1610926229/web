import type { Category, CategoryRecord, Game, GameRecord } from "@/lib/types/catalog";
import type {
  CatalogProductRecord,
  Product,
  ProductDetail,
  ProductSpecRecord,
} from "@/lib/types/product";

/**
 * 浏览链路的**可见性规则与 DTO 转换**（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type`（编译后完全消失）与纯函数，没有运行时依赖，
 * 因此既有客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 这一层存在的唯一理由：**「哪些记录用户端看得到」只有一处答案**。
 * 类目的启用 / 移除、商品的上下架 / 移除、规格的启用 / 移除，三处判断如果散在
 * 数据源、服务、页面里各写一遍，迟早会出现「列表看不到、搜索能搜到」
 * 或者「详情说已下架、结算还能付」这类自相矛盾的状态。
 *
 * ⚠️ 判定的**位置**也很重要：这些函数由数据层（`mockCatalogRepository`）调用，
 * 页面与组件只消费转换结果，不自己 `filter(enabled)`。
 */

// ——————————————————————————— 类目 ———————————————————————————

/** 类目是否对用户端可见：启用且未移除。两个条件缺一不可。 */
export function isCategoryVisible(record: Pick<CategoryRecord, "enabled" | "removedAt">): boolean {
  return record.enabled && record.removedAt === null;
}

/** 类目记录 → 公开 DTO。**只带 id 与名称**，运营状态一律不外传。 */
export function toCategory(record: CategoryRecord): Category {
  return { id: record.id, name: record.name };
}

/**
 * 类目排序：`sortOrder` 升序，相同则按 id。
 *
 * ⚠️ id 兜底不是装饰：两条类目排到同一个 `sortOrder` 是完全合法的数据，
 * 少了兜底，它们的先后就取决于 `Array.prototype.sort` 的实现细节与数组当前顺序，
 * 于是「刷新两次顺序不一样」——而且只在分页边界上看得出来。
 */
export function compareCategoriesForList(a: CategoryRecord, b: CategoryRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 游戏记录 + 该类目的**可见**类目 → 公开 DTO。 */
export function toPublicGame(game: GameRecord, categories: readonly CategoryRecord[]): Game {
  return {
    id: game.id,
    name: game.name,
    categories: categories
      .filter((category) => category.gameId === game.id && isCategoryVisible(category))
      .sort(compareCategoriesForList)
      .map(toCategory),
    regions: [...game.regions],
  };
}

// ——————————————————————————— 规格 ———————————————————————————

/** 规格是否有效：启用且未移除。「有效」= 用户可以选它、可以按它结算。 */
export function isSpecEffective(spec: Pick<ProductSpecRecord, "enabled" | "removedAt">): boolean {
  return spec.enabled && spec.removedAt === null;
}

/**
 * 规格排序：`sortOrder` 升序，相同则按 id。理由与类目完全相同。
 *
 * ⚠️ 排序是**展示顺序**，不是身份。规格的身份永远是 `id`——
 * 用数组下标当身份的话，删掉中间一项就会让后面所有项的身份错位，
 * 而订单快照里记的正是这个 id。
 */
export function compareSpecsForList(a: ProductSpecRecord, b: ProductSpecRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 该商品**有效**的规格，已排序。停用与已移除的不在其中。 */
export function listEffectiveSpecs(record: CatalogProductRecord): ProductSpecRecord[] {
  return record.specs.filter(isSpecEffective).sort(compareSpecsForList);
}

/**
 * 商品的展示价（起售价），单位：分。
 *
 * 取有效规格里的最低价。没有有效规格时退回**未移除**的规格，再没有才返回 0：
 *
 * - 上架商品**必然**至少有一个有效规格（上架校验与服务端保存校验双重保证），
 *   因此那条退回路径对能买的商品不会生效；
 * - 已下架商品允许没有有效规格（下架之后停用最后一个规格是合法的），
 *   此时列表价只是详情页上的一行只读文字，用一个「曾经的价格」比显示 0 分更如实。
 */
export function productDisplayPrice(record: CatalogProductRecord): number {
  const effective = listEffectiveSpecs(record);
  if (effective.length > 0) return Math.min(...effective.map((spec) => spec.price));

  const kept = record.specs
    .filter((spec) => spec.removedAt === null)
    .sort(compareSpecsForList);
  if (kept.length > 0) return Math.min(...kept.map((spec) => spec.price));

  return 0;
}

// ——————————————————————————— 商品 ———————————————————————————

/**
 * 商品是否出现在用户端**列表**里。
 *
 * 三个条件：上架、未移除、有类目。
 * 「有类目」这一条是把 `categoryId === null` 的调试商品挡在外面——
 * 它不属于任何类目，出现在任何列表里都会让「这个商品是从哪点进来的」说不清。
 *
 * ⚠️ 这里**不判断类目本身是否启用**：那条规则需要拿到类目记录，
 * 由数据层在拼公开列表时一起判断（见 `mockCatalogRepository.listPublicProducts`）。
 */
export function isProductPubliclyListed(record: CatalogProductRecord): boolean {
  return record.status === "on" && record.removedAt === null && record.categoryId !== null;
}

/** 商品是否可以被用户端**看到**（详情直链的口径）：未移除即可。下架商品仍然看得到。 */
export function isProductViewable(record: CatalogProductRecord): boolean {
  return record.removedAt === null;
}

/** 商品列表排序：`sortOrder` 升序，相同则按 id。 */
export function compareProductsForList(a: CatalogProductRecord, b: CatalogProductRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 商品记录 → 列表卡片。按名称搜索的匹配规则也在这里，前后台共用同一套。 */
export function toProductCard(record: CatalogProductRecord): Product {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    coverUrl: record.coverUrl,
    price: productDisplayPrice(record),
  };
}

/**
 * 商品记录 → 对外详情。**显式挑字段**，避免把 Mock 内部字段整体泄漏到接口响应里。
 *
 * ⚠️ `specs` 只含**有效规格**。这不是显示层的取舍，而是「停用规格不能用于新结算」
 * 这条规则的落点：结算页在自己的入参里找不到那个规格 id，因此它在结构上就不可能被下单。
 * 靠在结算流程里加一句 `if (!spec.enabled) throw` 的话，任何一条绕过它的新路径
 * （比如将来加个「再来一单」）都会漏。
 */
export function toProductDetail(record: CatalogProductRecord): ProductDetail {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    coverUrl: record.coverUrl,
    price: productDisplayPrice(record),
    monthlySales: record.monthlySales,
    gameTag: record.gameTag,
    status: record.status,
    // 分账比例随详情一起给出：结算页要在**下单那一刻**把它冻结进支付请求与订单快照，
    // 而支付成功后的建单是同步的（`buildOrderFromRequest` 在原子区段里跑，不能再取商品）。
    // 与价格来自同一次读取，因此不可能出现「按这一次读到的价格收款、
    // 按另一次读到的比例分账」
    companionRateBp: record.companionRateBp,
    specs: listEffectiveSpecs(record).map((spec) => ({
      id: spec.id,
      name: spec.name,
      price: spec.price,
    })),
    tags: [...record.tags],
    detailText: record.detailText,
    detailImages: [...record.detailImages],
    // 结算页需要据此取大区列表；categoryId 这类只服务于列表筛选的字段仍然不外传
    gameId: record.gameId,
  };
}

/**
 * 名称匹配：去首尾空格、忽略大小写。
 *
 * 商品名称与价格是两个独立字段，这里只按名称匹配——不做「按用户输入的价格区间搜索」
 * 那种把两个字段混起来的解析。
 */
export function productMatchesKeyword(record: CatalogProductRecord, keyword: string): boolean {
  const needle = keyword.trim();
  if (!needle) return true;
  return record.title.toLowerCase().includes(needle.toLowerCase());
}
