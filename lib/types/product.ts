/**
 * 商品相关类型。
 *
 * 金额一律以「分」为单位存整数，展示时经 lib/utils/format.ts 转换（统一两位小数）。
 * 商品名称与价格是相互独立的字段，名称中不得包含价格。
 */

/** 商品规格选项（如「机密400万」）。后续可扩展为多组规格，此处先按单组单选处理。 */
export type ProductSpec = {
  id: string;
  name: string;
  /** 单位：分 */
  price: number;
};

/** 商品（列表展示所需字段）。 */
export type Product = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  /** 列表展示价格，单位：分 */
  price: number;
  specs: ProductSpec[];
};
