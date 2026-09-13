/**
 * 分类页（浏览链路）类型。
 *
 * 层级：游戏 → 类目 → 商品。
 * 类目直接内嵌在游戏上：类目数量少且不单独分页，一次取回后左侧竖栏切换无需再请求，
 * 只需重新拉取右侧商品列表。
 */

/** 商品类目（左侧竖向栏的一项）。 */
export type Category = {
  id: string;
  name: string;
};

/** 游戏及其类目。 */
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
