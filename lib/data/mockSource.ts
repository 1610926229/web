import {
  gameSeed,
  homeSeed,
  productSeed,
  toCard,
  toDetail,
  userSeed,
} from "@/lib/mocks/fixtures/seed";
import type { DataSource } from "./source";

/**
 * Mock 数据源：直接读取进程内的种子数据，不经过任何网络。
 *
 * ⚠️ 仅服务端使用，仅供开发阶段；接入真实后端时整个文件删除。
 * 这里不做故障注入（那属于传输层，由 `lib/mocks/debug.ts` 统一处理），
 * 也不做数据加工——数据源只负责「把数据取出来」。
 */

const DEFAULT_PAGE_SIZE = 4;

/** 名称匹配：去首尾空格、忽略大小写。商品名称与价格是两个独立字段，这里只按名称匹配。 */
function matchesKeyword(title: string, keyword: string): boolean {
  return title.toLowerCase().includes(keyword.toLowerCase());
}

export const mockDataSource: DataSource = {
  async getHomeData() {
    return homeSeed;
  },

  async findUserById(id) {
    return userSeed.find((user) => user.id === id) ?? null;
  },

  async getGames() {
    return gameSeed;
  },

  async queryProducts(query) {
    const { gameId, categoryId, keyword, page = 1, pageSize = DEFAULT_PAGE_SIZE } = query;
    const trimmed = keyword?.trim() ?? "";

    const filtered = productSeed.filter((record) => {
      if (record.gameId !== gameId) return false;
      // 下架商品不出现在任何列表中，只能通过详情直链访问
      if (record.status !== "on") return false;
      // categoryId 为 null 的是调试专用商品，不进入任何类目列表
      if (record.categoryId === null) return false;
      if (categoryId && record.categoryId !== categoryId) return false;
      if (trimmed && !matchesKeyword(record.title, trimmed)) return false;
      return true;
    });

    const safePage = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
    const safeSize =
      Number.isFinite(pageSize) && pageSize >= 1 ? Math.trunc(pageSize) : DEFAULT_PAGE_SIZE;

    const start = (safePage - 1) * safeSize;
    const items = filtered.slice(start, start + safeSize).map(toCard);

    return {
      items,
      page: safePage,
      pageSize: safeSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async getProductDetail(id) {
    const record = productSeed.find((item) => item.id === id);
    return record ? toDetail(record) : null;
  },
};
