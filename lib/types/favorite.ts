import type { Product } from "./product";

/**
 * 商品收藏。
 *
 * 存的是**商品 id 的引用**，不是下单时的交易快照：商品改名、改价、换封面后，
 * 收藏列表展示的应当是当前信息（这是收藏与订单的本质区别——订单要留证据，收藏只是入口）。
 * 因此收藏记录里只有「谁、收藏了哪件商品、什么时候」三个事实。
 */
export type Favorite = {
  id: string;
  userId: string;
  productId: string;
  /** 收藏时间，ISO 字符串。列表按它倒序 */
  createdAt: string;
};

/**
 * 收藏项对应的商品当前状态。
 *
 * - `available`：商品在售，正常展示并可下单；
 * - `off_shelf`：商品已下架，可以看历史收藏，但**不能购买**；
 * - `missing`：商品已从数据源删除（或 id 变更）。收藏记录还在，列表必须安全展示，
 *   不能因为一条脏数据把整页打成白屏或错误页。
 */
export type FavoriteState = "available" | "off_shelf" | "missing";

/**
 * 收藏列表项 DTO。
 *
 * 与订单列表项同样**显式挑字段**：商品只带卡片展示需要的五项（见 `Product`），
 * 规格、月售、商品状态等详情字段不进列表；`state` 单独给出，页面不自行推断。
 */
export type FavoriteListItem = {
  /** 收藏记录 id（不是商品 id），列表合并去重按它做 */
  id: string;
  productId: string;
  createdAt: string;
  /** 商品当前信息；`missing` 时为 null */
  product: Product | null;
  state: FavoriteState;
  /** 状态文案，`available` 时为空串 */
  stateLabel: string;
};
