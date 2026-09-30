import type { CategoryRecord, Game, GameRecord } from "@/lib/types/catalog";
import type {
  CatalogProductRecord,
  ProductProfilePatch,
  ProductSpecRecord,
  ProductStatus,
} from "@/lib/types/product";
import { mockCatalogRepository } from "./mockCatalogRepository";

/**
 * 商品目录（游戏 / 类目 / 商品 / 规格）的**可替换仓储**（读写）。
 *
 * ⚠️ **全站只有这一份目录数据**。首页、分类页、商品详情、结算页与管理后台读的都是这里，
 * 因此「后台改完价格，用户端立刻是新价」不是靠任何同步动作做到的，
 * 而是因为两边读的本来就是同一条记录。**禁止再建第二份商品名单**。
 *
 * 本层只负责存取与「一份数据」的一致性，**不判断业务规则**：
 * 「同一游戏内类目不能重名」「有未移除商品的类目不能删除」「上架商品至少要有一个有效规格」
 * 都在 `lib/constants/adminCategories.ts` / `adminProducts.ts` 与
 * `lib/data/adminCatalogTransaction.ts` 里做。仓储只保证自己这份数据自洽。
 *
 * 四组查询口径刻意分开，因为它们的可见范围完全不同：
 * - `listPublicGames()` / `listPublicProducts()`：**用户端**口径。类目要启用且未移除，
 *   商品要上架、未移除、且挂在一个可见的类目下；
 * - `findProductById()`：**直链**口径。下架商品仍然取得到（详情页要显示「已下架」），
 *   软删除的商品取不到（它已经不在用户端了）；
 * - `listCategories()` / `queryCategoriesForAdmin()` / `queryProductsForAdmin()`：
 *   **后台**口径，全部记录都能查，且能按启用 / 上下架 / 是否已移除筛选
 *   ——后台要能看见前台看不见的那些。
 */

/**
 * 后台类目筛选条件（已解析、已校验；**不含分页**）。
 *
 * 分页不在这里，与公开列表同一套分工：仓储负责「哪些记录入选」，
 * 分页由服务层按 `page` / `pageSize` 切片。两边各切一半的话，
 * 「总数」与「本页条数」迟早会来自两次不同的过滤。
 */
export type AdminCategoryFilter = {
  keyword: string;
  /** `""` 表示全部游戏 */
  gameId: string;
  /** `""` 表示不限启用状态 */
  enabled: "" | "enabled" | "disabled";
  /**
   * 是否包含已移除的类目。
   *
   * 没有「全部」这个取值，与护航名单同一个理由：默认视图是「未移除的类目」，
   * 要看已移除的必须显式选——否则一条被移除的类目会混在正常列表里，
   * 看起来就像移除根本没生效。
   */
  removal: "active" | "removed";
};

/** 后台商品筛选条件（已解析、已校验；**不含分页**）。 */
export type AdminProductFilter = {
  keyword: string;
  /** `""` 表示全部游戏 */
  gameId: string;
  /** `""` 表示全部类目 */
  categoryId: string;
  /** `""` 表示不限上下架状态 */
  status: "" | "on" | "off";
  /** `""` 表示不限推荐状态 */
  recommended: "" | "recommended" | "normal";
  removal: "active" | "removed";
};

/**
 * 后台可编辑的商品字段。与 `ProductProfilePatch` 只差 `specs`：
 * 这里收的是**已经解析成记录**的规格数组（新规格的 id 已经生成、`removedAt` 已经算好）。
 *
 * 分成两层不是多此一举：id 生成必须是同步的、且必须发生在原子区段内
 * （见 `lib/data/adminCatalogTransaction.ts`），而服务层在此之前还要做 `await`
 * 取游戏与类目目录。让服务层直接产出最终记录，事务里就只剩「写」这一件事。
 */
export type CatalogProductPatch = Omit<
  ProductProfilePatch,
  "specs" | "companionRatePercent"
> & {
  /**
   * 分账比例，**整数基点**。
   *
   * 线上入参里没有这个键（那一份是 `companionRatePercent` 百分比文本），
   * 因此这里不能直接从 `ProductProfilePatch` 继承：到了仓储这一层，
   * 「界面单位」已经全部换成了存储单位（金额是分、比例是基点），
   * 记录里绝不允许出现百分比字符串。
   */
  companionRateBp: number;
  specs: ProductSpecRecord[];
};

export type CatalogRepository = {
  /** 全部游戏（只读目录）。后台筛选栏与类目表单都用它。 */
  listGames(): Promise<GameRecord[]>;

  /** 按 id 取游戏；不存在返回 null。类目归属校验用它。 */
  findGameById(id: string): Promise<GameRecord | null>;

  /** 用户端口径的游戏及其**可见**类目（启用且未移除，已排序）。 */
  listPublicGames(): Promise<Game[]>;

  /** 全部类目（含停用与已移除），已排序。后台聚合与校验用。 */
  listCategories(): Promise<CategoryRecord[]>;

  /** 按 id 取类目；不存在返回 null。**已移除的类目仍然取得到**（后台详情与历史归属要看它）。 */
  findCategoryById(id: string): Promise<CategoryRecord | null>;

  /** 后台列表查询：全部类目，按游戏 / 启用状态 / 是否已移除筛选。 */
  queryCategoriesForAdmin(filter: AdminCategoryFilter): Promise<CategoryRecord[]>;

  /**
   * 按 id 取商品。**下架商品取得到**（详情直链要显示「已下架」而非 404），
   * **软删除商品取不到**（它已经不在用户端了）。
   *
   * ⚠️ 与 `findCategoryById()` 的处理**刻意不同**：类目被移除之后仍然要能回答
   * 「这条商品属于哪个类目」，而商品被移除之后用户端就该看不到它，
   * 直链也应当是一个干净的 404，而不是一页「已删除」的详情。
   */
  findProductById(id: string): Promise<CatalogProductRecord | null>;

  /**
   * 按 id 取商品，**含已移除的**。
   *
   * 只服务后台（列表与详情要能查到「这件商品被移除过」）。与 `findProductById()`
   * 分开而不是加一个 `includeRemoved` 参数：一个布尔参数会让调用点看不出
   * 「这次到底拿不拿得到已移除的记录」，而这两件事的用途完全不同。
   */
  findProductForAdmin(id: string): Promise<CatalogProductRecord | null>;

  /**
   * 用户端列表口径的商品：上架、未移除、挂在可见类目下，已排序。
   *
   * ⚠️ 「类目可见」这一条在这里而不是在调用方：一个类目被停用之后，
   * 它下面的商品仍然上架着（停用类目不要求先清空商品），但用户端已经没有任何
   * 入口能走到它们。这条过滤如果不在这里，就会出现「导航里没有这个类目，
   * 但搜索能搜到它下面的商品」这种自相矛盾的状态。
   */
  listPublicProducts(): Promise<CatalogProductRecord[]>;

  /** 后台列表查询：全部商品（含已下架与已移除），按条件筛选。 */
  queryProductsForAdmin(filter: AdminProductFilter): Promise<CatalogProductRecord[]>;

  /**
   * 某个类目下**未移除**的商品数。
   *
   * 类目删除校验用它：「类目存在未移除商品时禁止删除」。
   * 只数未移除的：已移除的商品在用户端本来就不可见，让它们把类目锁死说不通。
   */
  countProductsInCategory(categoryId: string): Promise<number>;

  /** 新建一条类目。id 由调用方在原子区段内生成。 */
  createCategory(record: CategoryRecord): Promise<CategoryRecord>;

  /** 覆盖式更新类目；记录不存在返回 null。 */
  updateCategory(
    id: string,
    patch: Pick<CategoryRecord, "gameId" | "name" | "sortOrder" | "enabled"> & { at: string },
  ): Promise<{ previous: CategoryRecord; updated: CategoryRecord } | null>;

  /**
   * 只改类目的启用状态（启用 / 停用走同一条路径）。
   *
   * ⚠️ 单独开一个窄写入器，而不是复用 `updateCategory()`：后台的「停用」按钮
   * 只应当改这一个字段，**绝不能**顺带把名称、所属游戏、排序一起写回去——
   * 那需要调用方先把整条记录读出来再拼一个完整 patch，而那份读取发生在原子区段之外，
   * 两位管理员同时操作时后写入的那次会把另一位刚改好的名称覆盖回旧值。
   */
  setCategoryEnabled(
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<{ previous: CategoryRecord; updated: CategoryRecord } | null>;

  /**
   * 软移除类目：只写 `removedAt`，**不删除记录**。
   *
   * 类目 id 是商品归属的一部分，硬删会让「这条商品原本属于哪个类目」永久查不到。
   * 已经移除的返回 `previous === updated`（幂等，不刷新时间戳）。
   */
  markCategoryRemoved(
    id: string,
    at: string,
  ): Promise<{ previous: CategoryRecord; updated: CategoryRecord } | null>;

  /** 新建一条商品（含它的全部规格）。 */
  createProduct(record: CatalogProductRecord): Promise<CatalogProductRecord>;

  /**
   * 覆盖式更新商品**与它的全部规格**（一次写入，见 §原子性）。
   *
   * ⚠️ `patch.specs` 是**完整的目标状态**（含已移除的行）：规格的增删改都通过
   * 这一份数组表达，因此不存在「商品改了、规格没改」这种半完成的状态。
   */
  updateProduct(
    id: string,
    patch: CatalogProductPatch & { at: string },
  ): Promise<{ previous: CatalogProductRecord; updated: CatalogProductRecord } | null>;

  /**
   * 只改商品的上下架状态（上架 / 下架走同一条路径）。
   *
   * 窄写入器，理由同 `setCategoryEnabled()`：上下架不该顺带覆盖标题、封面、规格。
   */
  setProductStatus(
    id: string,
    status: ProductStatus,
    at: string,
  ): Promise<{ previous: CatalogProductRecord; updated: CatalogProductRecord } | null>;

  /** 软移除商品：只写 `removedAt`，**不删除记录**。历史订单与收藏要指得到它。 */
  markProductRemoved(
    id: string,
    at: string,
  ): Promise<{ previous: CatalogProductRecord; updated: CatalogProductRecord } | null>;
};

export function getCatalogRepository(): CatalogRepository {
  return mockCatalogRepository;
}
