import {
  DEFAULT_COMPANION_RANKING_BOARD,
  buildCompanionRankingRows,
  companionRankingBoardLabel,
  companionRankingMetricName,
  companionRankingNotice,
  mergeAcceptEvents,
  paginateCompanionRankingRows,
  parseCompanionRankingQuery,
  readCompanionRankingBoard,
  type CompanionRankingSources,
} from "@/lib/constants/companionRankings";
import {
  DEFAULT_RANKING_PERIOD,
  rankingPeriodLabel,
  readRankingPeriod,
  resolveRankingPeriodRange,
} from "@/lib/constants/rankingPeriods";
import { ApiError } from "@/lib/api/ApiError";
import { getCompanionAcceptRepository } from "@/lib/data/companionAcceptRepository";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { sweepMaturedEarnings } from "@/lib/data/earningTransaction";
import { getEarningRepository } from "@/lib/data/earningRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { CompanionRankingPage } from "@/lib/types/companionRanking";

/**
 * 打手排行榜服务 —— **只读**，且**服务端聚合**（P1-5）。
 *
 * ## 四件必须在服务端完成、不能交给浏览器的事
 *
 * 1. **按周期过滤**：只有服务端知道全部订单、收益与接单事件的时刻。
 *    把这些明细发给浏览器让它筛，等于把所有人的订单与收益送出去，
 *    筛出来的名次也没人敢信；
 * 2. **聚合**：要算名次就得看全部打手的数据；
 * 3. **排序与名次**：指标降序 + `companionId` 升序兜底 + **竞赛排名**。
 *    名次必须在全表上算完再切片，客户端做不到（它只有一页）；
 * 4. **挑字段**：`toCompanionRankingEntry` 显式只挑六项，裁定 §9 的白名单到此为止——
 *    `userId` / `applicationId` / `intro` / `companionRate` 等等**根本没有进入本函数的返回值**。
 *
 * ## 与消费榜服务的三处**刻意**不同
 *
 * | | `getConsumptionRanking` | 本函数 |
 * |---|---|---|
 * | 会话 | 收 `viewerUserId`，用来算「我的排名」 | **完全不读会话**（裁定 §10：第一版不做「我的排名」） |
 * | 榜单 | 一张（按下单用户聚合） | **三张**（`board` 参数），口径各自独立 |
 * | 空榜调试 | `?mockEmpty=rankings` | `?mockEmpty=companionRankings`（**另一个键**，互不干扰） |
 *
 * ⚠️ **不读会话**这件事是**结构上**的隔离：本模块不 import `@/lib/auth/session`，
 * 也不接受任何用户标识。因此「打手榜会不会泄露某个用户看到了什么」这个问题
 * 在本文件里连一个可以出错的输入都没有。
 *
 * ## 当前时间只取一次
 *
 * 与本文件之外的一切「现在」无关：区间上下界、响应里的 `generatedAt` 与 `rangeEnd`
 * 必须来自同一个瞬间，否则「今日」的结束时间会比榜单的生成时间还晚。
 */
/**
 * 到期解冻事实的**惰性物化**（幂等）。
 *
 * ⚠️ **为什么收入榜的读路径必须扫这一步**：裁定 §5 规定收入榜**只统计
 * `Earning.status === "available"`**，而一笔收益在 `availableAt` 到点之后
 * **就已经是**可提现的了——还没被写下来，只是因为还没有人走过会触发清扫的路径。
 * 本仓既有的做法就是把 sweep 挂在读取路径上（`architecture-rules.md` §392：
 * 派单超时 / 完成自动审核 / 收益解冻三条都是这样），收益页那条在
 * `lib/services/companionEarnings.ts` 的 `materializeEarningReleases()`。
 *
 * ⚠️ **不扫的后果不是「晚一点才对」，而是直接少算**：打手完成订单、窗口到期之后，
 * 打开自己的收益页会看到那笔钱**已经可提现**，而打开打手榜收入榜却仍然是 0 ——
 * 同一个事实在两个页面上给出两个答案，且**榜单那一个是错的**。
 * 「谁碰巧先看了一眼」不能决定一个数字对不对。
 *
 * ⚠️ 用注入的 `now` 而不是 `new Date()`：周期范围也是按 `now` 算的，
 * 两处用不同的时刻会出现「范围说这一天、清扫按另一天」——测试也无法复现。
 */
function materializeEarningReleases(at: Date): void {
  sweepMaturedEarnings(at.toISOString());
}

export async function getCompanionRanking(
  params: URLSearchParams,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<CompanionRankingPage> {
  const { page, pageSize } = parseCompanionRankingQuery(params);
  /*
   * `board` 与 `period` 走**同一种**契约（与消费榜对 `period` 的取舍一致）：
   * - **没传** → 用默认值（接口裸调也应该能拿到一份榜单）；
   * - **传了非法值** → 抛 400。
   *
   * 把 `?board=revenue` 静默当成接单榜返回，调用方（或人）会拿着一份
   * 「含义不明」的榜单继续往下用——比报错难查得多。这两个字段都必须与「缺省」区分开。
   */
  const rawBoard = params.get("board");
  const parsedBoard = readCompanionRankingBoard(rawBoard);
  if (rawBoard !== null && parsedBoard === null) {
    throw new ApiError("BAD_REQUEST", `不支持的榜单：${rawBoard}`);
  }
  const board = parsedBoard ?? DEFAULT_COMPANION_RANKING_BOARD;

  const rawPeriod = params.get("period");
  const parsedPeriod = readRankingPeriod(rawPeriod);
  if (rawPeriod !== null && parsedPeriod === null) {
    throw new ApiError("BAD_REQUEST", `不支持的榜单周期：${rawPeriod}`);
  }
  const period = parsedPeriod ?? DEFAULT_RANKING_PERIOD;

  const range = resolveRankingPeriodRange(period, now);

  return withMockDebug(params, surface, async () => {
    // 必须在读收益**之前**：收益榜读的是清扫后的状态
    materializeEarningReleases(now);

    const acceptRepository = getCompanionAcceptRepository();
    const [events, legacy, orders, earnings, companions] = await Promise.all([
      acceptRepository.listAcceptEvents(),
      acceptRepository.listLegacyAcceptEvents(),
      getPaymentRepository().listAllOrders(),
      getEarningRepository().listAllEarnings(),
      getCompanionRepository().listCompanions(),
    ]);

    /*
     * 接单事件 = **真的被记下来的历史** ∪ **存量数据里仍然可读的那一次**。
     *
     * 合并（去重）规则在常量层，只有一处实现；这里只负责把两份取出来。
     * ⚠️ 注意 `listLegacyAcceptEvents()` 对**其它两张榜没有任何作用**——
     * 完成榜读订单、收入榜读收益。这里无条件取它，是因为它是一次内存遍历，
     * 而按榜分支取数会让「哪张榜读了什么」多出一个分叉。
     */
    const sources: CompanionRankingSources = {
      acceptEvents: mergeAcceptEvents(events, legacy),
      orders,
      earnings,
      companions,
    };

    // `?mockEmpty=companionRankings` 用于验收「无人上榜」的空态。
    // ⚠️ key 与消费榜的 `rankings` **不同**，两者互不影响。
    const rows = mockEmptyApplies(params, "companionRankings")
      ? []
      : buildCompanionRankingRows(board, sources, range);

    return {
      ...paginateCompanionRankingRows(rows, board, page, pageSize),
      board,
      boardLabel: companionRankingBoardLabel(board),
      metricName: companionRankingMetricName(board),
      period,
      periodLabel: rankingPeriodLabel(period),
      generatedAt: now.toISOString(),
      rangeStart: range.start === null ? null : new Date(range.start).toISOString(),
      rangeEnd: new Date(range.end).toISOString(),
      notice: companionRankingNotice(board),
    };
  });
}
