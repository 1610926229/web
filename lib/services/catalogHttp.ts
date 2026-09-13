import { apiGet } from "@/lib/api/client";
import type { ProductListQuery } from "@/lib/types/catalog";
import type { PageResult } from "@/lib/types/common";
import type { Product } from "@/lib/types/product";

/**
 * 浏览器端的商品列表读取。
 *
 * 与 `lib/services/catalog.ts` 分成两个模块**不是**为了分类好看，而是必须：
 * 服务端那个模块依赖 `lib/mocks/debug` 与 `lib/data/source`，一旦被客户端组件引用，
 * 整个 Mock 层就会被打进浏览器产物。客户端只能引用只依赖 `lib/api/client` 的模块。
 *
 * 服务端与服务端接口共用 `lib/services/catalog.ts`，浏览器共用本文件，
 * 两边的取数结果由同一份 `DataSource` 决定，不会分叉。
 */
export function fetchProducts(query: ProductListQuery): Promise<PageResult<Product>> {
  const search = new URLSearchParams({ gameId: query.gameId });

  if (query.categoryId) search.set("categoryId", query.categoryId);
  if (query.keyword) search.set("keyword", query.keyword);
  if (query.page) search.set("page", String(query.page));

  return apiGet<PageResult<Product>>(`/api/catalog/products?${search.toString()}`);
}
