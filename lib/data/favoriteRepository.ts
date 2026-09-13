import type { PageResult } from "@/lib/types/common";
import type { Favorite } from "@/lib/types/favorite";
import { mockFavoriteRepository } from "./mockFavoriteRepository";

/**
 * 商品收藏的可替换仓储。
 *
 * 与退款 / 投诉仓储同一套路：**写入侧**保证原子性与幂等，读取侧只按用户查。
 *
 * 两条约束由本层负责，不能靠调用方自觉：
 *
 * 1. **同一用户对同一商品只有一条收藏记录**。「查是否已收藏」与「写入」在同一段同步代码里，
 *    因此快速连点两次收藏不会产生两条。
 * 2. **取消收藏天然幂等**：记录不在也返回成功——用户想达到的状态已经达到了。
 *    这比「第二次点取消报错」更符合直觉，也挡住网络重试。
 *
 * ⚠️ 本层**不判断**「这个商品存不存在、有没有下架」：那是业务规则，
 * 在 `lib/services/favorites.ts` 里做。
 *
 * 当前实现是进程内内存存储，将来由数据库替换（`(userId, productId)` 唯一索引）——
 * 替换时这份契约不变。
 */

/** 收藏结果：要么成功（含幂等命中），`created` 表示这次是否真的新增了记录。 */
export type AddFavoriteOutcome = { ok: true; favorite: Favorite; created: boolean };

export type FavoriteRepository = {
  /** 按「用户 + 商品」取收藏记录；不存在返回 null。 */
  findFavorite(userId: string, productId: string): Promise<Favorite | null>;

  /**
   * 按收藏时间**倒序**分页取某个用户的收藏。
   *
   * 排序必须完全确定（时间相同时用记录 id 兜底），否则同一份数据两次取出来的顺序可能不同，
   * 分页时会出现某条收藏在第一页出现过、第二页又出现一次。
   */
  queryFavorites(query: {
    userId: string;
    page: number;
    pageSize: number;
  }): Promise<PageResult<Favorite>>;

  /**
   * 新增收藏。
   *
   * 幂等：该用户已经收藏过这件商品时返回既有记录并把 `created` 置为 false，
   * 快速连点或网络重试都不会多出一条。
   */
  addFavorite(favorite: Favorite): Promise<AddFavoriteOutcome>;

  /** 取消收藏。记录本来就不存在时返回 `{ removed: false }`，不报错。 */
  removeFavorite(userId: string, productId: string): Promise<{ removed: boolean }>;
};

export function getFavoriteRepository(): FavoriteRepository {
  return mockFavoriteRepository;
}
