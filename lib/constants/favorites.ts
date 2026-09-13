import type { PageResult } from "@/lib/types/common";
import type { FavoriteListItem, FavoriteState } from "@/lib/types/favorite";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 商品收藏的列表规则，服务端与浏览器共用。
 *
 * ⚠️ 本文件只有 `import type`（编译后完全消失），没有任何运行时依赖，
 * 因此可以被客户端组件引用，也可以被 node 直接加载做纯逻辑测试。
 *
 * 收藏**没有筛选条件**：列表就是「当前用户收藏的全部商品，按收藏时间倒序」，
 * 因此这里只有分页参数与合并规则，没有状态解析——不像订单 / 投诉那样会因非法取值报错。
 */

/** 列表默认每页条数。 */
export const FAVORITE_PAGE_SIZE = 10;

/** 每页条数上限。 */
export const FAVORITE_MAX_PAGE_SIZE = 20;

/** 页码上限。 */
export const FAVORITE_MAX_PAGE = 1000;

/** 商品当前状态的文案。`available` 不需要文案，用空串占位。 */
export const FAVORITE_STATE_LABELS: Record<FavoriteState, string> = {
  available: "",
  off_shelf: "已下架",
  missing: "商品已不存在",
};

/** 收藏列表为空时的文案。 */
export const FAVORITE_EMPTY_TITLE = "还没有收藏商品";
export const FAVORITE_EMPTY_DESCRIPTION = "在商品详情页点「收藏」，就能在这里快速找到它";

/** 已下架商品在收藏列表里的说明：能看，但不能买。 */
export const FAVORITE_OFF_SHELF_NOTE = "该商品已下架，暂不可购买";

/** 商品已不存在时的说明：收藏记录还在，可以移除。 */
export const FAVORITE_MISSING_NOTE = "该商品已不存在，可以移除这条收藏";

export const FAVORITE_PRODUCT_REQUIRED_MESSAGE = "缺少商品";
export const FAVORITE_PRODUCT_NOT_FOUND_MESSAGE = "商品不存在";
export const FAVORITE_OFF_SHELF_MESSAGE = "该商品已下架，暂不能收藏";

/** 收藏 / 取消收藏失败时的兜底提示。 */
export const FAVORITE_FAILED_MESSAGE = "操作失败，请稍后重试";

/** 规范化后的查询条件：分页已收敛到安全范围。 */
export type FavoriteListQuery = {
  page: number;
  pageSize: number;
};

/**
 * 解析收藏列表的查询条件。
 *
 * 只有分页参数，且一律**规范化**而不是报错：页码不是用户填写的业务内容，
 * 一个坏掉的页码让整页报错没有意义（与订单列表的分页口径一致）。
 */
export function parseFavoriteListQuery(params: URLSearchParams): FavoriteListQuery {
  return {
    page: clampPage(params.get("page"), FAVORITE_MAX_PAGE),
    pageSize: clampPageSize(params.get("pageSize"), FAVORITE_PAGE_SIZE, FAVORITE_MAX_PAGE_SIZE),
  };
}

/** 收藏列表的「加载更多」合并：追加 + 按收藏记录 id 去重（见 `mergePageResult`）。 */
export function mergeFavoritePage(
  current: PageResult<FavoriteListItem>,
  next: PageResult<FavoriteListItem>,
): PageResult<FavoriteListItem> {
  return mergePageResult(current, next);
}
