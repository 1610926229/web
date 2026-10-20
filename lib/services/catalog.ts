import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Game, ProductListQuery } from "@/lib/types/catalog";
import type { PageResult } from "@/lib/types/common";
import type { Product, ProductDetailView } from "@/lib/types/product";
import { loadReviewAggregate } from "./reviewAggregates";

/**
 * 浏览链路（分类页 + 商品详情页）数据服务 —— 服务端与接口共用的唯一取数入口。
 *
 * 分类页首屏由 Server Component 以 `"server"` 直接取数；切换类目、搜索、加载更多
 * 由浏览器经 `/api/catalog/products` 以 `"http"` 调用同一个 `queryProducts`。
 * 详情页完全由服务端渲染，没有对应的接口，也不为它造一个空接口。
 */

/** 游戏与类目。数据量小且不随筛选变化，一次取回后左侧竖栏切换无需再请求。 */
export function getGames(): Promise<Game[]> {
  return getDataSource().getGames();
}

/** 商品列表查询：只返回上架商品，支持按名称搜索与分页。 */
export function queryProducts(
  query: ProductListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<PageResult<Product>> {
  return withMockDebug(params, surface, () => getDataSource().queryProducts(query));
}

/**
 * 商品详情；不存在时返回 null，由页面转为「不存在」状态。
 *
 * ⚠️ 返回的是 `ProductDetailView`：在商品详情之上**贴上了公开评分聚合**（P1-8）。
 * 聚合由这里贴、不放进数据源，理由见 `ProductDetailView` 的注释——
 * 简单说，评价不是商品的属性，数据源不该去读评价仓储。
 *
 * ⚠️ 商品不存在时**不查评价**：先确认商品在，再聚合。反过来会让「一个被删掉的商品 id」
 * 也走一遍评价查询，而结果是要被丢掉的。
 *
 * 与打手详情（`getCompanionDetail`）走的是**同一个** `loadReviewAggregate()`（`R3`）：
 * 商品页与打手页的评分口径只可能一起变，不可能各自漂移。
 */
export function getProductDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<ProductDetailView | null> {
  return withMockDebug(params, surface, async () => {
    const product = await getDataSource().getProductDetail(id);
    if (!product) return null;

    return { ...product, reviews: await loadReviewAggregate("product", product.id) };
  });
}
