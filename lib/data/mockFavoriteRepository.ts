import { favoriteSeed } from "@/lib/mocks/fixtures/favoriteSeed";
import type { Favorite } from "@/lib/types/favorite";
import { getMockStore } from "./mockStore";
import type { AddFavoriteOutcome, FavoriteRepository } from "./favoriteRepository";

/**
 * 商品收藏的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`(userId, productId)` 唯一索引），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置收藏与用户新点的收藏因此进的是**同一个 Map、同一套查询方法**，
 * 不会出现「刚收藏的商品在列表里看不到」。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 *
 * ⚠️ 收藏记录里**不存商品快照**，只存商品 id：商品改名改价后列表展示的是当前信息。
 */

type MockFavoriteStore = {
  /** `${userId}:${productId}` → 收藏记录。这个键本身就是「同一用户同一商品只有一条」的保证 */
  favorites: Map<string, Favorite>;
};

function createStore(): MockFavoriteStore {
  const favorites = new Map<string, Favorite>();

  for (const seed of favoriteSeed) {
    const key = keyOf(seed.userId, seed.productId);
    // 预置数据重复收藏同一商品时在这里就会暴露出来，而不是留到线上出现两条
    if (favorites.has(key)) {
      throw new Error(`预置收藏数据重复：${key}`);
    }
    // 逐字段复制，避免后续修改污染模块级的 seed 常量
    favorites.set(key, {
      id: seed.id,
      userId: seed.userId,
      productId: seed.productId,
      createdAt: seed.createdAt,
    });
  }

  return { favorites };
}

function store(): MockFavoriteStore {
  return getMockStore("favorite", createStore);
}

function keyOf(userId: string, productId: string): string {
  return `${userId}:${productId}`;
}

/** 收藏时间倒序；同一时间用记录 id 兜底，保证排序完全确定。 */
function compareFavoritesNewestFirst(a: Favorite, b: Favorite): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export const mockFavoriteRepository: FavoriteRepository = {
  async findFavorite(userId, productId) {
    return store().favorites.get(keyOf(userId, productId)) ?? null;
  },

  async queryFavorites({ userId, page, pageSize }) {
    // 只取当前用户的：仓储层就把归属过滤掉，上层拿不到别人的收藏
    const mine = [...store().favorites.values()]
      .filter((favorite) => favorite.userId === userId)
      .sort(compareFavoritesNewestFirst);

    const start = (page - 1) * pageSize;
    const items = mine.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: mine.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < mine.length,
    };
  },

  async addFavorite(favorite): Promise<AddFavoriteOutcome> {
    const current = store();
    const key = keyOf(favorite.userId, favorite.productId);

    // —— 原子区段开始（无 await）——
    const existing = current.favorites.get(key);
    if (existing) return { ok: true, favorite: existing, created: false };

    current.favorites.set(key, favorite);
    // —— 原子区段结束 ——

    return { ok: true, favorite, created: true };
  },

  async removeFavorite(userId, productId) {
    const current = store();
    const key = keyOf(userId, productId);

    // —— 原子区段开始（无 await）——
    const removed = current.favorites.delete(key);
    // —— 原子区段结束 ——

    return { removed };
  },
};
