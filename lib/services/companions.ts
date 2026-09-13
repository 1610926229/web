import { ApiError } from "@/lib/api/ApiError";
import {
  COMPANION_AVAILABILITY_INVALID_MESSAGE,
  COMPANION_GAME_INVALID_MESSAGE,
  buildCompanionListQuery,
  readCompanionAvailability,
  readCompanionGameId,
  toCompanionDetail,
  toCompanionListItem,
  type CompanionListQuery,
} from "@/lib/constants/companions";
import { getDataSource } from "@/lib/data/source";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { CompanionDetail, CompanionGameTag, CompanionPage } from "@/lib/types/companion";

/**
 * 陪玩服务 —— 公开列表与陪玩详情共用的唯一入口。
 *
 * **游客可访问**：陪玩名单是浏览型内容，因此这里不读会话、不做归属判断，
 * 也没有任何「查谁的」参数。
 *
 * 三条规则：
 *
 * 1. **一份数据**。这里只读 `DataSource`，与结算页的「推荐陪玩」面板是同一个来源，
 *    因此同一位陪玩在列表 / 详情 / 结算页的昵称、头像与可用状态必然一致。
 * 2. **筛选与分页在数据层完成**，页面与接口都不自己过滤（否则两侧会慢慢长出两套行为）。
 * 3. **DTO 在这里生成**：仓储实体不会流到浏览器，内部字段（排序权重、上架开关、
 *    结算页用的等级标签、评价明细）都止步于 `toCompanionListItem` / `toCompanionDetail`。
 *
 * 本阶段的边界：**详情页没有任何下单能力**。选择陪玩与订单的绑定规则尚未确认，
 * 因此这里没有创建订单、创建支付请求或写入陪玩关系的函数——不是「暂时没接上」，
 * 而是这条路还没有定论。
 */

/** 陪玩筛选栏的游戏选项：取自真实游戏数据，不写死第二份名单。 */
export async function listCompanionGameOptions(): Promise<CompanionGameTag[]> {
  const games = await getDataSource().listCompanionGames();
  return games.map((game) => ({ id: game.id, name: game.name }));
}

/**
 * 解析列表查询条件。
 *
 * 两种调用方共用这一个函数，差别只在 `strict`：
 * - **接口**（`strict: true`）：非法枚举直接 400。调用方拿着「不知道筛了什么」的列表
 *   继续往下用，比报错难查得多。
 * - **页面**（`strict: false`）：非法值规范化到默认值。地址栏里的一个坏参数
 *   不该把整页变成错误页。
 */
export async function resolveCompanionListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<CompanionListQuery> {
  const knownGameIds = (await getDataSource().listCompanionGames()).map((game) => game.id);

  const availability = readCompanionAvailability(params.get("availability"));
  const gameId = readCompanionGameId(params.get("gameId"), knownGameIds);

  if (strict) {
    if (availability === null) {
      throw new ApiError("BAD_REQUEST", COMPANION_AVAILABILITY_INVALID_MESSAGE, 400);
    }
    if (gameId === null) throw new ApiError("BAD_REQUEST", COMPANION_GAME_INVALID_MESSAGE, 400);
  }

  return buildCompanionListQuery({
    params,
    availability: availability ?? "all",
    gameId: gameId ?? "",
  });
}

/** 内部实体 → 列表项时需要「游戏 id → 名称」的映射，这里取一次给整页用。 */
async function gameNameById(): Promise<Record<string, string>> {
  const games = await getDataSource().getGames();
  return Object.fromEntries(games.map((game) => [game.id, game.name]));
}

/**
 * 公开陪玩列表。
 *
 * `?mockEmpty=companions` 演示空名单（**空数据不是错误**，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两个参数都只在
 * `ENABLE_MOCK_DEBUG=true` 时生效。
 */
export async function queryCompanionPage(
  query: CompanionListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CompanionPage> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "companions")) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0, hasMore: false };
    }

    const [page, names] = await Promise.all([getDataSource().queryCompanions(query), gameNameById()]);

    return { ...page, items: page.items.map((companion) => toCompanionListItem(companion, names)) };
  });
}

/**
 * 陪玩详情。
 *
 * 不存在返回 null，由页面 `notFound()`（与商品详情同一套 404 处理）。
 * **已下架的陪玩仍然返回详情**：直链打开要能看到一页只读资料与「当前不可提供服务」的说明，
 * 而不是一个 404——那位陪玩确实存在过，页面只是没有选择入口。
 */
export async function getCompanionDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CompanionDetail | null> {
  return withMockDebug(params, surface, async () => {
    const [companion, names] = await Promise.all([
      getDataSource().getCompanion(id),
      gameNameById(),
    ]);

    return companion ? toCompanionDetail(companion, names) : null;
  });
}
