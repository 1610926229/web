/**
 * 分类页（浏览链路）类型。
 *
 * 层级：游戏 → 类目 → 商品。
 *
 * ⚠️ **公开 DTO 与内部实体是两组类型**（P8B 起）：
 *
 * - `Category` / `Game` 是**公开 DTO**：只带用户端渲染需要的两个字段。
 *   类目从 P8B 起由后台管理（有排序、启用状态、软删除），那些字段一律不进公开 DTO——
 *   用户端既不需要，也不该拿到「这个类目在后台被停用了」这类内部状态。
 * - `CategoryRecord` 是**内部实体**：后台列表 / 详情 / 校验读的是它。
 *
 * 两组类型分开写、靠 `toCategory()` 一处转换，而不是给 `Category` 加可选字段：
 * 后者会让「这个字段到底有没有」在整条链路上都变成不确定的。
 */

/** 商品类目（左侧竖向栏的一项）。**公开 DTO**：只有 id 与名称。 */
export type Category = {
  id: string;
  name: string;
};

/**
 * 游戏及其类目。**公开 DTO**。
 *
 * `categories` 只包含**在架且未移除**的类目：停用与已移除的类目不进入用户端导航。
 * 过滤发生在数据层（`mockCatalogRepository`），页面不自己筛——
 * 「哪些类目用户能看到」因此只有一处答案。
 */
export type Game = {
  id: string;
  name: string;
  categories: Category[];
  /**
   * 可选的游戏大区／平台（结算页的「大区选择」）。
   * 取值属于游戏本身而不是商品：商品只是恰好标了其中一个平台。
   */
  regions: string[];
};

/**
 * 游戏记录（内部实体）。
 *
 * ⚠️ 游戏本身**不由后台管理**（P8B 明确不做游戏管理），因此这里没有软删除与排序字段，
 * 它就是一份只读目录。类目通过 `gameId` 依附在它上面。
 */
export type GameRecord = {
  id: string;
  name: string;
  regions: string[];
};

/**
 * 类目记录（内部实体）。
 *
 * `removedAt` 为软删除标记：**不做物理删除**，因为类目 id 是商品归属的一部分，
 * 硬删会让「这条商品原本属于哪个类目」永久查不到。已移除的类目在后台可用
 * 「已移除」筛选查到，在用户端完全不可达。
 */
export type CategoryRecord = {
  id: string;
  /** 所属游戏。必须指向真实存在的游戏 */
  gameId: string;
  name: string;
  /** 展示排序。同游戏内按它升序，相同则按 id 兜底，保证分页稳定 */
  sortOrder: number;
  /** 停用后不进入用户端导航，也不能用于新建 / 编辑归属 / 上架商品 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 软删除时间；`null` 表示未移除 */
  removedAt: string | null;
};

/**
 * 增值服务。
 *
 * ⚠️ 原型结算页没有给出增值服务的价格，这里的名称与价格是**开发阶段的 Mock 规则**，
 * 不是最终业务定价，也不参与任何真实结算。
 */
export type Addon = {
  id: string;
  name: string;
  /** 单位：分。按单计费，不随购买数量变化 */
  price: number;
};

// ——————————————————————————— 管理端 ———————————————————————————

/** 管理端类目列表项 / 详情。**显式挑字段**，实体不外流。 */
export type AdminCategoryListItem = {
  id: string;
  gameId: string;
  gameName: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  /**
   * 该类目下**未移除**的商品数。
   *
   * ⚠️ 这个数字是「能不能删」的**展示**，不是判断依据：真正的删除校验在
   * `lib/data/adminCatalogTransaction.ts` 的原子区段里重新数一遍。
   * 页面拿这个数字把删除按钮标成不可用只是提前说明后果——
   * 列表刷新与点击之间别人刚好加了一件商品，服务端仍然会拒绝（§原子性）。
   */
  productCount: number;
};

/** 一页类目 + 筛选栏选项 + 各状态角标。页面首屏与接口返回的是同一个形状。 */
export type AdminCategoryListData = {
  items: AdminCategoryListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  games: { id: string; name: string }[];
  counts: { all: number; enabled: number; disabled: number; removed: number };
  notice: string;
};

/** 写操作的返回：界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export type AdminCategoryWriteResult = {
  categoryId: string;
  enabled: boolean;
  removedAt: string | null;
  changed: boolean;
};

/**
 * 类目编辑白名单 —— 后台能改的字段就是这些，多一个都没有。
 *
 * ⚠️ **不在这个类型里**的字段：`createdAt`、`updatedAt`、`removedAt`、`id`。
 * 客户端多传一个不会有任何效果，因为服务层**根本没有读取它们的位置**
 * （§九：客户端伪造 ID、状态、时间必须被忽略）。
 *
 * 注意 `enabled` 在这里、而 `removedAt` 不在：「停用」是编辑，「移除」是另一个动作，
 * 后者不能被一次普通保存顺带触发——反过来也一样，编辑永远不能把一条已移除的类目
 * 改回未移除。
 */
export type AdminCategoryProfilePatch = {
  gameId: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
};

/** 商品列表查询条件。 */
export type ProductListQuery = {
  gameId: string;
  /** 不传表示该游戏下的全部类目 */
  categoryId?: string;
  /** 按商品名称搜索；为空表示不搜索 */
  keyword?: string;
  /** 从 1 开始 */
  page?: number;
  pageSize?: number;
};
