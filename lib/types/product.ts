/**
 * 商品相关类型。
 *
 * 金额一律以「分」为单位存整数，展示时经 lib/utils/format.ts 转换（统一两位小数）。
 * 商品名称与价格是相互独立的字段，名称中不得包含价格。
 */

/** 商品规格选项（如「机密400万」）。当前为**单组规格、单选**，暂不支持多属性组合 SKU。 */
export type ProductSpec = {
  id: string;
  /** 规格名，同时作为下单时的规格快照来源 */
  name: string;
  /** 单位：分。不同规格可以有不同价格 */
  price: number;
};

/**
 * 商品卡片数据（首页、分类页列表使用）。
 *
 * 列表只需要展示所需的字段，**不含规格明细**：规格只在详情页使用，
 * 放进列表类型会让列表接口返回大量用不上的数据。详情类型见 `ProductDetail`。
 */
export type Product = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  /** 列表展示价格（起售价），单位：分 */
  price: number;
};

/** 商品状态。下架商品不出现在任何列表里，但可通过直链访问并显示下架状态。 */
export type ProductStatus = "on" | "off";

/** 商品详情：在卡片字段之外，补充详情页独有的展示字段与规格。 */
export type ProductDetail = Product & {
  /** 月售数量，展示时经 abbreviateNumber 缩写 */
  monthlySales: number;
  /** 游戏标签（如「手游」） */
  gameTag: string;
  status: ProductStatus;
  /** 单组规格，单选；至少一项。默认选中第一项 */
  specs: ProductSpec[];
};
