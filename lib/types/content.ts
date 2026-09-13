/**
 * 首页内容类型。
 */
import type { Product } from "./product";

/** 公告图片。公告区仅做图片滚动展示，**不含跳转字段、不响应点击**。 */
export type AnnouncementImage = {
  id: string;
  imageUrl: string;
  alt: string;
};

/** 首页快捷入口。 */
export type HomeShortcut = {
  id: string;
  label: string;
  href: string;
};

/** 首页商品分组（如「亏本单」）。 */
export type ProductSection = {
  id: string;
  title: string;
  moreHref: string;
  products: Product[];
};

/** 首页聚合数据。 */
export type HomeData = {
  announcements: AnnouncementImage[];
  activityImageUrl: string;
  shortcuts: HomeShortcut[];
  sections: ProductSection[];
};

// ——————————————————————————— 种子形状（P8B） ———————————————————————————

/**
 * 首页里**不随商品变化**的部分（公告、活动图、快捷入口）。
 *
 * 拆出来是因为另一半——商品分组——从 P8B 起必须在每次请求时**从商品仓储现取**：
 * 后台把一件商品下架或软删除之后，首页那天晚上还在推它，是一个能被用户一眼看到的
 * 线上事故，而写死的分组数组恰好会造成这个后果。内容部分没有这个问题，照旧静态。
 */
export type HomeContentSeed = Omit<HomeData, "sections">;

/**
 * 首页商品分组的**种子形状**：存的是商品 id，不是商品。
 *
 * ⚠️ 存 id 而不是 `Product` 对象，是「首页与后台读同一份数据」这条要求的落点。
 * 存对象的话，首页拿到的就是种子被复制那一刻的价格与封面，
 * 后台改价之后首页还显示旧价——而且是那种「只有对比两个页面才发现」的不一致。
 */
export type HomeSectionSeed = {
  id: string;
  title: string;
  moreHref: string;
  productIds: string[];
};
