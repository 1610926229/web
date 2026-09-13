import { apiDelete, apiGet, apiPost } from "@/lib/api/client";
import { FAVORITE_PAGE_SIZE } from "@/lib/constants/favorites";
import type { PageResult } from "@/lib/types/common";
import type { FavoriteListItem } from "@/lib/types/favorite";

/**
 * 商品收藏的**浏览器端**调用（详情页的收藏按钮、收藏列表的加载更多与移除）。
 *
 * 与服务端模块 `lib/services/favorites.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 首屏与详情页的收藏状态由 Server Component 直接取数，不经过本文件。
 */

export function fetchFavorites(page = 1, pageSize = FAVORITE_PAGE_SIZE): Promise<PageResult<FavoriteListItem>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiGet<PageResult<FavoriteListItem>>(`/api/favorites?${params.toString()}`);
}

/** 收藏结果：`favorited` 是服务端确认的最终状态，页面直接按它渲染。 */
export type FavoriteMutationResult = {
  productId: string;
  favorited: boolean;
  created: boolean;
};

export function addFavorite(productId: string): Promise<FavoriteMutationResult> {
  return apiPost<FavoriteMutationResult>("/api/favorites", { productId });
}

export function removeFavorite(productId: string): Promise<FavoriteMutationResult> {
  return apiDelete<FavoriteMutationResult>(`/api/favorites/${encodeURIComponent(productId)}`);
}
