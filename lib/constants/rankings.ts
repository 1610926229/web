/**
 * 消费排行榜的聚合、排序、分页与 DTO 转换规则（**纯逻辑，服务端与浏览器共用**）。
 *
 * ⚠️ 本文件只有 `import type` 与 `lib/constants/pagination.ts`、`lib/constants/levels.ts`、
 * `lib/constants/rankingPeriods.ts` 这几个纯模块，没有任何运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三条硬规则：
 *
 * 1. **排序必须稳定**。金额降序，金额相同时用用户 id 升序兜底。少了第二步，
 *    同金额的用户在两次请求里可能换位置，翻页时会出现「同一个人在第一页出现过、
 *    第二页又出现一次」。
 * 2. **只有有效消费金额大于 0 的用户进入榜单**。这是本阶段明确选择的规则：
 *    榜单回答的是「谁消费得多」，把 0 元用户排进来既没有信息量，也会把
 *    真实名次往后挤。规则只在这里定义一次。
 * 3. **先按周期聚合、再分页**。周期过滤发生在聚合之前（传入的就是已经算好的时间范围），
 *    绝不能先切出累计榜的一页再过滤——那样每一页的人数都不一样，名次也会跟着错。
 */

import type { PageResult } from "@/lib/types/common";
import type { ConsumptionLevel } from "@/lib/types/level";
import type { ConsumptionRankingRow, RankingEntry } from "@/lib/types/ranking";
import type { UserRecord } from "@/lib/data/userRepository";
import type { Order } from "@/lib/types/order";
import type { RankingPeriodRange } from "./rankingPeriods";
import { isWithinRankingPeriod } from "./rankingPeriods";
import { resolveLevelName, sumEffectiveSpend } from "./levels";
import { mergePageResultBy } from "./pagination";

/** 默认每页条数。 */
export const RANKING_PAGE_SIZE = 20;

/** 每页条数上限。 */
export const RANKING_MAX_PAGE_SIZE = 50;

/** 页码上限。 */
export const RANKING_MAX_PAGE = 1000;

/** 前三名单独突出展示，因此这个数量在服务端与页面之间是同一个约定。 */
export const RANKING_TOP_COUNT = 3;

/**
 * 只有**有效消费金额大于 0** 的用户进入榜单。
 *
 * 公开成常量而不是写死在过滤里：页面需要照这个规则解释「为什么我没上榜」。
 */
export const RANKING_MIN_SPEND = 1;

/* ────────────────────────────── 页面文案 ────────────────────────────── */

export const RANKING_PAGE_TITLE = "消费排行榜";
export const RANKING_ME_TITLE = "我的排名";
export const RANKING_LIST_TITLE = "完整榜单";
/** 榜单没有名次可显示时的等级占位（等级配置不可用）。不编一个等级名。 */
export const RANKING_LEVEL_PLACEHOLDER = "等级待配置";
/** 顶部三名之外的名次前缀。 */
export function formatRankNumber(rank: number): string {
  return `No.${rank}`;
}

/** 解析排行榜的查询条件。 */
export function parseRankingQuery(params: URLSearchParams): { page: number; pageSize: number } {
  const rawPage = Number(params.get("page"));
  const rawSize = Number(params.get("pageSize"));

  const page =
    Number.isFinite(rawPage) && rawPage >= 1
      ? Math.min(Math.trunc(rawPage), RANKING_MAX_PAGE)
      : 1;

  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(Math.trunc(rawSize), RANKING_MAX_PAGE_SIZE)
      : RANKING_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * 排序：有效消费金额降序 → 用户 id 升序。
 *
 * 第二步不是可有可无的「美化」：没有它，同金额用户在 `Array.prototype.sort`
 * 之外的不稳定顺序下会漂移，分页就会出现重复或遗漏。
 */
export function compareRankingRows(
  a: ConsumptionRankingRow,
  b: ConsumptionRankingRow,
): number {
  if (a.effectiveSpendAmount !== b.effectiveSpendAmount) {
    return b.effectiveSpendAmount - a.effectiveSpendAmount;
  }
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

/**
 * 聚合榜单（**服务端**）。
 *
 * 输入是「全部用户的订单」、「全部用户」与**已经算好的时间范围**，输出是按名次排好的行。
 * 四件事在这里一次做完：
 *
 * 1. 先按 `range` 过滤订单（完成时间是否落在周期内，规则见 `isWithinRankingPeriod`）；
 * 2. 把剩下的订单按用户分组，各自算有效消费金额（规则复用 `sumEffectiveSpend`，
 *    与消费等级页**同一套口径**）；
 * 3. 丢掉金额为 0 的用户；
 * 4. 排序并写入等级名称。
 *
 * 注意第 1 步在聚合**之前**：只有整批订单先按周期过滤，名次才是这个周期的真实名次。
 * 先取累计榜的一页再过滤，每一页剩下的人数都不一样，名次会整片错位。
 *
 * `range` 是必填参数而不是可选项：漏传就会静默回退成某一种口径，周期榜最容易出的
 * 事故正是「这个页签其实返回的是累计」。累计期传入 `{ start: null }`，
 * 此时不做完成时间过滤，与消费等级页完全一致（包括「已完成但没有完成时间的订单」）。
 */
export function buildConsumptionRanking(
  orders: readonly Order[],
  users: readonly UserRecord[],
  levels: readonly ConsumptionLevel[],
  range: RankingPeriodRange,
): ConsumptionRankingRow[] {
  const ordersByUser = new Map<string, Order[]>();
  for (const order of orders) {
    if (!isWithinRankingPeriod(order.completedAt, range)) continue;

    const bucket = ordersByUser.get(order.userId);
    if (bucket) bucket.push(order);
    else ordersByUser.set(order.userId, [order]);
  }

  const rows: ConsumptionRankingRow[] = [];
  for (const user of users) {
    const spend = sumEffectiveSpend(ordersByUser.get(user.id) ?? []);
    if (spend < RANKING_MIN_SPEND) continue;

    rows.push({
      userId: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      levelName: resolveLevelName(spend, levels),
      effectiveSpendAmount: spend,
    });
  }

  return rows.sort(compareRankingRows);
}

/**
 * 行 → 公开 DTO。
 *
 * **显式挑字段**：`userId` 到此为止，不会进入响应。客户端需要稳定 key 时用 `rank`
 * ——同一份榜单内名次唯一，因此不需要再下发一个内部标识。
 */
export function toRankingEntry(row: ConsumptionRankingRow, rank: number): RankingEntry {
  return {
    rank,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    levelName: row.levelName,
    effectiveSpendAmount: row.effectiveSpendAmount,
  };
}

/** 从排好序的行里按页切片，并转成公开 DTO。 */
export function paginateRankingRows(
  rows: readonly ConsumptionRankingRow[],
  page: number,
  pageSize: number,
): PageResult<RankingEntry> {
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  return {
    // 名次是**全局名次**，不是页内序号：第二页的第一条接着上一页继续数
    items: slice.map((row, index) => toRankingEntry(row, start + index + 1)),
    page,
    pageSize,
    total: rows.length,
    hasMore: start + slice.length < rows.length,
  };
}

/**
 * 找出某个用户在榜单里的**下标**；游客或不在榜单里（没有有效消费）返回 -1。
 *
 * 返回下标而不是名次：名次是「下标 + 1」，调用方拿到下标即可同时得到两者。
 */
export function findRankingRowIndex(
  rows: readonly ConsumptionRankingRow[],
  userId: string | null,
): number {
  if (!userId) return -1;
  return rows.findIndex((row) => row.userId === userId);
}

/**
 * 「加载更多」的合并：追加 + **按名次去重**。
 *
 * 通用实现是 `lib/constants/pagination.ts` 的 `mergePageResultBy`——默认那个按 `id` 去重，
 * 而榜单 DTO 刻意不带 id（见 `lib/types/ranking.ts`），因此这里显式给出「哪一项算同一条」。
 * 复用通用实现而不是另写一份，是为了让「追加而不是替换」这条规则只有一处实现。
 */
export function mergeRankingPage<P extends PageResult<RankingEntry>>(current: P, next: P): P {
  // `T` 只出现在 `P` 的约束里，推断不出来，因此显式写出类型参数（同 `mergePageResult`）
  return mergePageResultBy<RankingEntry, P>(current, next, (item) => String(item.rank));
}
