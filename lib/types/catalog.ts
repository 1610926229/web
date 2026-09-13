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
