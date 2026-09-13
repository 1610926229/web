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
