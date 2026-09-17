import {
  productMatchesKeyword,
  toProductCard,
  toProductDetail,
  toPublicGame,
} from "@/lib/constants/catalog";
import {
  selectActivityImageUrl,
  selectPublicAnnouncements,
  selectPublicShortcuts,
} from "@/lib/constants/homeContent";
import { addonSeed, homeSectionSeed } from "@/lib/mocks/fixtures/catalogSeed";
import { getCatalogRepository } from "./catalogRepository";
import { getCompanionRepository } from "./companionRepository";
import { getContentRepository } from "./contentRepository";
import type { DataSource } from "./source";
import { getUserRepository, toSessionUser } from "./userRepository";

/**
 * Mock 数据源：直接读取进程内的数据，不经过任何网络。
 *
 * ⚠️ 仅服务端使用，仅供开发阶段；接入真实后端时整个文件删除。
 * 这里不做故障注入（那属于传输层，由 `lib/mocks/debug.ts` 统一处理），
 * 也不做数据加工——数据源只负责「把数据取出来」。
 *
 * ⚠️ **本文件已经不再持有任何商品数据**（P8B）。游戏 / 类目 / 商品 / 规格 / 增值服务
 * 全部委派给 `catalogRepository`，陪玩名单委派给 `companionRepository`（P8A）。
 *
 * 这不是重构偏好，而是本阶段的核心要求：后台能改商品之后，「数据源里那份种子」
 * 和「后台在改的那份数据」会立刻变成两份。首页显示旧价、后台显示新价，
 * 而两边都觉得自己是对的——这类 bug 只有在用户投诉时才会被发现。
 *
 * 委派之后，用户端首页、分类页、商品详情、结算页与后台读的是**同一份 Map**：
 * 后台改完价格，用户端下一个请求就是新价，不需要任何同步动作。
 * 公开口径（哪些类目可见、哪些商品上架）也随之下沉到仓储与 `lib/constants/catalog.ts`，
 * 数据源这一层只负责转发与拼接，不再自己 `filter(enabled)`——两处各写一遍迟早会分叉。
 */

const DEFAULT_PAGE_SIZE = 4;

export const mockDataSource: DataSource = {
  /**
   * 首页数据。
   *
   * ⚠️ **两部分都是每次请求现取的**，本文件不持有任何首页内容：
   *
   * - 商品分组：种子 `homeSectionSeed` 里存的是商品 id，这里拿 id 去商品仓储取当下的记录；
   * - 公告 / 活动图 / 快捷入口：全部委派给 `contentRepository`（P8E-1）。
   *
   * 为什么不把商品直接写进种子：写进去的话，首页拿到的是「种子被复制那一刻」的价格与封面，
   * 后台改价之后首页还显示旧价。不这么做的话还有一个更糟的后果——后台把一件商品下架或
   * 软删除之后，首页那天晚上还在推它，而这是用户一眼就能看到的。
   *
   * 公告 / 活动图 / 快捷入口是**同一个理由的另一半**：P8E-1 之前它们就是写在这里的
   * 静态数据（`...homeSeed`），后台没有能力改动；现在后台能改了，静态数据必须消失，
   * 否则「后台改了公告、用户端没变」——管理员会以为自己没保存成功。
   *
   * 取不到的商品（已下架 / 已移除 / 挂在不可见类目下）**直接跳过**，
   * 不占位、不留空卡片：首页出现一张点不进去的图比少一张更糟。
   */
  async getHomeData() {
    const listed = await getCatalogRepository().listPublicProducts();
    const byId = new Map(listed.map((record) => [record.id, record]));

    // 三组运营内容各取一次：仓储返回**全部**记录（含停用与已移除），
    // 「哪些用户端看得到」由 `lib/constants/homeContent.ts` 的纯函数回答——
    // 那是业务规则，不该随存储实现改变。
    const content = getContentRepository();
    const [announcements, banners, quickEntries] = await Promise.all([
      content.listAnnouncementRecords(),
      content.listBannerRecords(),
      content.listQuickEntryRecords(),
    ]);

    return {
      announcements: selectPublicAnnouncements(announcements),
      activityImageUrl: selectActivityImageUrl(banners),
      shortcuts: selectPublicShortcuts(quickEntries),
      sections: homeSectionSeed.map((section) => ({
        id: section.id,
        title: section.title,
        moreHref: section.moreHref,
        products: section.productIds
          .map((id) => byId.get(id))
          .filter((record) => record !== undefined)
          .map(toProductCard),
      })),
    };
  },

  async findUserById(id) {
    // 用户数据只有**一份**：登录态也从这个仓储读，用户在编辑资料页改完昵称后
    // 会话里读到的是新值，不会出现「资料页显示新昵称、会话还是旧昵称」两份真相。
    const record = await getUserRepository().findUserById(id);
    return record ? toSessionUser(record) : null;
  },

  async getGames() {
    // 用户端口径：只带**可见**类目（启用且未移除）。
    // ⚠️ 全部游戏都会返回，即使某个游戏下一个可见类目都没有——游戏切换器是导航的一部分，
    // 让一个游戏因为类目被停用而整个消失，会把正在浏览它的用户甩到一个不存在的位置上。
    // 空类目由分类页自己渲染空态。
    return getCatalogRepository().listPublicGames();
  },

  /**
   * 分类页的商品列表。
   *
   * 过滤与排序**全部在仓储里**（`listPublicProducts()`：上架、未移除、挂在可见类目下），
   * 这里只补上「这一个游戏 / 这一个类目 / 这个关键词」，然后切页。
   * 可见性判断不在这层重写一遍，否则「后台停用了一个类目，前台列表什么时候变空」
   * 就会有两套答案。
   */
  async queryProducts(query) {
    const { gameId, categoryId, keyword, page = 1, pageSize = DEFAULT_PAGE_SIZE } = query;
    const trimmed = keyword?.trim() ?? "";

    const listed = await getCatalogRepository().listPublicProducts();
    const filtered = listed.filter((record) => {
      if (record.gameId !== gameId) return false;
      if (categoryId && record.categoryId !== categoryId) return false;
      return productMatchesKeyword(record, trimmed);
    });

    const safePage = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
    const safeSize =
      Number.isFinite(pageSize) && pageSize >= 1 ? Math.trunc(pageSize) : DEFAULT_PAGE_SIZE;

    const start = (safePage - 1) * safeSize;
    const items = filtered.slice(start, start + safeSize).map(toProductCard);

    return {
      items,
      page: safePage,
      pageSize: safeSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  /**
   * 商品详情。
   *
   * ⚠️ 下架商品**取得到**（详情页要显示「已下架」而不是 404），软删除商品**取不到**
   * ——它已经不在用户端了。这条分界写在仓储里（`findProductById()`），这里不重判。
   */
  async getProductDetail(id) {
    const record = await getCatalogRepository().findProductById(id);
    return record ? toProductDetail(record) : null;
  },

  /** 单个游戏（含可见类目）。结算页据此校验大区取值。 */
  async getGame(id) {
    const catalog = getCatalogRepository();
    const [game, categories] = await Promise.all([
      catalog.findGameById(id),
      catalog.listCategories(),
    ]);
    // 不存在返回 null；存在但一个可见类目都没有时仍然返回这个游戏（regions 仍要能用）
    return game ? toPublicGame(game, categories) : null;
  },

  async listAddons() {
    return addonSeed.map((addon) => ({ ...addon }));
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

    // 游戏名单同样取自商品目录：护航与商品认的是同一份游戏表，
    // 两处各存一份的话，新加一个游戏时会出现「陪玩筛选栏里没有它」这种半生效状态。
    const games = await getCatalogRepository().listPublicGames();
    return games.filter((game) => usedIds.has(game.id));
  },
};
