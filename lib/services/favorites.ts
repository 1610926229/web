import { ApiError } from "@/lib/api/ApiError";
import {
  FAVORITE_OFF_SHELF_MESSAGE,
  FAVORITE_PRODUCT_NOT_FOUND_MESSAGE,
  FAVORITE_PRODUCT_REQUIRED_MESSAGE,
  FAVORITE_STATE_LABELS,
  parseFavoriteListQuery,
} from "@/lib/constants/favorites";
import { readTrimmedString } from "@/lib/constants/writes";
import { getFavoriteRepository } from "@/lib/data/favoriteRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { PageResult } from "@/lib/types/common";
import type { Favorite, FavoriteListItem, FavoriteState } from "@/lib/types/favorite";
import type { ProductDetail } from "@/lib/types/product";

/**
 * 商品收藏服务 —— 详情页的收藏按钮、收藏列表与 `/api/favorites*` 共用的唯一入口。
 *
 * 四条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只能看到、只能操作自己的收藏**。每个函数都要求 `userId`，仓储查询本身按用户过滤，
 *    接口不接受任何「查谁的收藏」参数，改参数也读不到别人的数据。
 * 2. **同一商品只有一条记录**。同「用户 + 商品」重复提交返回第一次的结果（幂等），
 *    快速连点不会多出收藏。取消同理：不存在也返回成功。
 *    这里刻意**不用**退款 / 投诉那套幂等键——那个键解决的是「同一意图产生多条不同记录」
 *    （两条退款申请），而收藏天然有业务主键（用户 + 商品），不需要额外发一个键。
 * 3. **下架商品不能被新增收藏**，但**已经收藏的下架商品仍然能看**（显示「已下架」、不可购买）。
 * 4. **商品被删除也能安全展示**。列表项带 `state` 与可空的 `product`，
 *    页面按状态渲染而不是假设商品一定存在——一条脏数据不会把整页打成白屏。
 *
 * ⚠️ 收藏列表刻意**不带商品快照**：展示的是商品**当前**的名称、封面与价格。
 * 这是收藏与订单的区别——订单要留交易证据，收藏只是一个入口。
 */

/**
 * 收藏记录 + 商品当前详情 → 列表项 DTO。
 *
 * 商品只挑卡片需要的五项（与 `Product` 一致）：规格、月售这些详情页字段不进列表。
 * 商品状态通过 `state` 表达，不把 `status` 直接透出去，避免页面对两个字段各判断一次。
 *
 * 详情为 null 表示商品已被删除（后台移除，或 id 本来就不存在）——此时 `product` 为 null、
 * 状态为 `missing`，页面据此渲染「商品已删除」与一个「移除」按钮，而不是白屏。
 */
export function toFavoriteListItem(
  favorite: Favorite,
  detail: ProductDetail | null,
): FavoriteListItem {
  const state: FavoriteState = !detail
    ? "missing"
    : detail.status === "off"
      ? "off_shelf"
      : "available";

  return {
    id: favorite.id,
    productId: favorite.productId,
    createdAt: favorite.createdAt,
    product: detail
      ? {
          id: detail.id,
          title: detail.title,
          subtitle: detail.subtitle,
          coverUrl: detail.coverUrl,
          price: detail.price,
        }
      : null,
    state,
    stateLabel: FAVORITE_STATE_LABELS[state],
  };
}

/**
 * 查询当前用户的收藏列表，按收藏时间倒序。
 *
 * 收藏**没有筛选条件**，因此这里不会出现「状态取值非法」这类业务错误：
 * 分页参数一律规范化（与订单列表的口径一致）。
 */
export async function queryFavoritesForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<PageResult<FavoriteListItem>> {
  const query = parseFavoriteListQuery(params);

  const page = await withMockDebug(params, surface, () =>
    getFavoriteRepository().queryFavorites({ ...query, userId }),
  );

  // 商品信息逐个取当前值：商品改名改价后列表跟着变，不做快照
  const items = await Promise.all(
    page.items.map(async (favorite) => {
      const detail = await getDataSource().getProductDetail(favorite.productId);
      return toFavoriteListItem(favorite, detail);
    }),
  );

  return { ...page, items };
}

/**
 * 当前用户是否收藏了这件商品。
 *
 * 商品 id 为空时直接返回 false（而不是报错）：详情页在极端情况下拿不到 id 时，
 * 收藏按钮显示为「未收藏」是安全且正确的，不该让整页进入错误态。
 */
export async function isFavoritedForUser(
  userId: string,
  productId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<boolean> {
  if (!userId || !productId) return false;

  const favorite = await withMockDebug(params, surface, () =>
    getFavoriteRepository().findFavorite(userId, productId),
  );
  return favorite !== null;
}

/** 收藏 / 取消收藏的结果：`favorited` 是操作后的确定状态，页面直接按它渲染。 */
export type FavoriteMutationResult = {
  productId: string;
  favorited: boolean;
  created: boolean;
};

/**
 * 新增收藏。
 *
 * 商品不存在 → 404；商品已下架 → 400（下架商品不能再被收藏）。
 * 已经收藏过则幂等返回，不产生第二条记录。
 *
 * 商品 id 只从请求体读，用户身份只从参数（会话）来——伪造不了「替别人收藏」。
 */
export async function addFavoriteForUser(
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<FavoriteMutationResult> {
  const productId = readTrimmedString(body, "productId");
  if (!productId) throw new ApiError("BAD_REQUEST", FAVORITE_PRODUCT_REQUIRED_MESSAGE);

  const product = await withMockDebug(params, surface, () =>
    getDataSource().getProductDetail(productId),
  );
  if (!product) throw new ApiError("NOT_FOUND", FAVORITE_PRODUCT_NOT_FOUND_MESSAGE);
  if (product.status === "off") throw new ApiError("BAD_REQUEST", FAVORITE_OFF_SHELF_MESSAGE);

  const result = await getFavoriteRepository().addFavorite({
    id: `fav_${crypto.randomUUID()}`,
    userId,
    productId,
    createdAt: new Date().toISOString(),
  });

  return { productId, favorited: true, created: result.created };
}

/**
 * 取消收藏。
 *
 * **不校验商品是否存在**：商品被删除后，用户更需要能把这条收藏清掉。
 * 重复取消同样返回成功（幂等）。
 */
export async function removeFavoriteForUser(
  userId: string,
  productId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<FavoriteMutationResult> {
  if (!productId) throw new ApiError("BAD_REQUEST", FAVORITE_PRODUCT_REQUIRED_MESSAGE);

  const result = await withMockDebug(params, surface, () =>
    getFavoriteRepository().removeFavorite(userId, productId),
  );

  return { productId, favorited: false, created: result.removed };
}
