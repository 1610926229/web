import {
  addonSeed,
  gameSeed,
  homeSeed,
  productSeed,
  toCard,
  toDetail,
} from "@/lib/mocks/fixtures/seed";
import { getCompanionRepository } from "./companionRepository";
import type { DataSource } from "./source";
import { getUserRepository, toSessionUser } from "./userRepository";

/**
 * Mock 数据源：直接读取进程内的种子数据，不经过任何网络。
 *
 * ⚠️ 仅服务端使用，仅供开发阶段；接入真实后端时整个文件删除。
 * 这里不做故障注入（那属于传输层，由 `lib/mocks/debug.ts` 统一处理），
 * 也不做数据加工——数据源只负责「把数据取出来」。
 *
 * ⚠️ **陪玩名单从这里开始委派给 `companionRepository`**（P8A）：
 * 名单自本阶段起可写（审核通过会加记录、后台会改资料），而 `DataSource` 是只读契约，
 * 写不进一个「取数」接口里。委派之后，用户端列表 / 详情 / 结算页与后台读的
 * **仍然是同一份 Map**——不是「同步过去」，而是本来就是同一条记录。
 * 公开列表的可见性口径（下架与已移除不出现）也随之下沉到仓储，
 * 数据源这一层只是转发，不再自己 `filter(enabled)`——两处各写一遍迟早会分叉。
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
    // 用户数据只有**一份**：登录态也从这个仓储读，用户在编辑资料页改完昵称后
    // 会话里读到的是新值，不会出现「资料页显示新昵称、会话还是旧昵称」两份真相。
    const record = await getUserRepository().findUserById(id);
    return record ? toSessionUser(record) : null;
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

  async getGame(id) {
    return gameSeed.find((game) => game.id === id) ?? null;
  },

  async listAddons() {
    return addonSeed;
  },

  async listCompanions() {
    return getCompanionRepository().listCompanions();
  },

  async getCompanion(id) {
    return getCompanionRepository().findCompanionById(id);
  },

  async queryCompanions(query) {
    const { page, pageSize } = query;

    // 过滤与排序全部在仓储里（含「下架与已移除不出现」这一条）；这里只切页。
    // 之前过滤写在这一层、排序写在这一层，后台再写一份的话，
    // 「后台停用了一位护航，前台列表什么时候消失」就会有两套答案。
    const filtered = await getCompanionRepository().queryCompanions(query);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由数据层算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async listCompanionGames() {
    // 只列出**真的有在架陪玩**的游戏：筛选栏里出现一个永远筛不出结果的选项没有意义。
    // 「在架」的判定与前台列表同源（这里调的是同一个方法），不另写一遍 `enabled` 判断。
    const listed = await getCompanionRepository().queryCompanions({
      keyword: "",
      gameId: "",
      availability: "all",
    });
    const usedIds = new Set(listed.flatMap((companion) => companion.gameIds));

    return gameSeed.filter((game) => usedIds.has(game.id));
  },
};
