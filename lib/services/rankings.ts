import {
  buildConsumptionRanking,
  findRankingRowIndex,
  paginateRankingRows,
  parseRankingQuery,
  toRankingEntry,
} from "@/lib/constants/rankings";
import {
  DEFAULT_RANKING_PERIOD,
  rankingNotice,
  rankingPeriodLabel,
  readRankingPeriod,
  resolveRankingPeriodRange,
} from "@/lib/constants/rankingPeriods";
import { ApiError } from "@/lib/api/ApiError";
import { getLevelRepository } from "@/lib/data/levelRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { ConsumptionRankingPage } from "@/lib/types/ranking";

/**
 * 消费排行榜服务 —— **只读**，且**服务端聚合**。
 *
 * 四件必须在服务端完成、不能交给浏览器的事：
 *
 * 1. **按周期过滤**：只有服务端知道全部订单的完成时间。把订单发给浏览器让它筛，
 *    等于把所有人的订单明细送出去，筛出来的名次也没人敢信；
 * 2. **聚合**：要算名次就得看全部用户的订单；
 * 3. **排序**：金额降序 + 用户 id 升序（`compareRankingRows`），保证同金额用户在
 *    分页边界上不会漂移；浏览器端排序会随数据量变化而产生不同的名次；
 * 4. **挑字段**：`toRankingEntry` 显式只挑五项，`userId` / `displayId` 到此为止。
 *
 * `viewerUserId` 为 null 表示游客。游客**照常拿到完整榜单**，只是不显示「我的排名」，
 * 也不会被要求登录——排行榜是公开内容。
 */

/**
 * 取消费排行榜一页。
 *
 * 分页参数非法值时走规范化（第一页 / 默认页长）而不是报错：多翻一页不是业务错误，
 * 与 `parseTipListQuery` 的取舍一致。`period` 则**不走规范化**：
 *
 * - **没传** → 用默认周期（「本周」，见 `DEFAULT_RANKING_PERIOD`）。
 *   接口裸调也应该能拿到一份榜单，这与页面打开时没有 `?period=` 是同一件事；
 * - **传了非法值** → 抛 400。这里必须与「缺省」区分开：把 `?period=lastWeek`
 *   静默当成默认周期返回，调用方会拿到一份「含义不明」的榜单而不自知。
 *
 * 当前时间在本函数入口取一次，之后整个请求都用这一个 `now`：
 * 区间上下界、响应里的 `generatedAt` 与 `rangeEnd` 必须来自同一个瞬间，
 * 否则「今日」的结束时间会比榜单的生成时间还晚。
 */
export async function getConsumptionRanking(
  viewerUserId: string | null,
  params: URLSearchParams,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<ConsumptionRankingPage> {
  const { page, pageSize } = parseRankingQuery(params);

  const rawPeriod = params.get("period");
  const parsedPeriod = readRankingPeriod(rawPeriod);
  if (rawPeriod !== null && parsedPeriod === null) {
    throw new ApiError("BAD_REQUEST", `不支持的榜单周期：${rawPeriod}`);
  }
  const period = parsedPeriod ?? DEFAULT_RANKING_PERIOD;

  const range = resolveRankingPeriodRange(period, now);

  return withMockDebug(params, surface, async () => {
    const orders = await getPaymentRepository().listAllOrders();
    const users = await getUserRepository().listUsers();
    const levels = await getLevelRepository().listLevels();

    // `?mockEmpty=rankings` 用于验收「无人上榜」的空态：真实数据里已经有人有消费，
    // 除了删预置数据没有别的办法造出空榜单。
    const rows = mockEmptyApplies(params, "rankings")
      ? []
      : buildConsumptionRanking(orders, users, levels, range);

    const result = paginateRankingRows(rows, page, pageSize);
    const meIndex = findRankingRowIndex(rows, viewerUserId);

    return {
      ...result,
      generatedAt: now.toISOString(),
      // 名次即使不在当前页也照常给出：这是「我的排名」区域存在的意义
      me: meIndex >= 0 ? toRankingEntry(rows[meIndex], meIndex + 1) : null,
      // 「游客」与「登录了但没上榜」的空态文案不同，因此两者都要告诉页面
      viewerLoggedIn: viewerUserId !== null,
      notice: rankingNotice(period),
      period,
      periodLabel: rankingPeriodLabel(period),
      rangeStart: range.start === null ? null : new Date(range.start).toISOString(),
      rangeEnd: new Date(range.end).toISOString(),
    };
  });
}
