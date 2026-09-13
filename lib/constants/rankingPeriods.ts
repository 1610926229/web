/**
 * 消费排行榜的周期定义、UTC+8 时间边界与相关文案（**纯逻辑，服务端与浏览器共用**）。
 *
 * 为什么单独一个文件：周期这件事有两处会用——服务端按周期聚合订单、页面上按周期切换页签。
 * 如果「本周从哪天开始」在两边各写一遍，两边就一定会在某个周一或某个月底对不上。
 * 因此周期的**定义、解析与时间范围计算只在这里出现一次**。
 *
 * 三条必须写死的规则：
 *
 * 1. **一律按北京时间（UTC+8）自然时间划分**，不看浏览器本地时区，也不受服务器部署时区影响。
 *    用户在 UTC+8 看到的「今天」，与榜单算出来的「今天」必须是同一个区间。
 *    实现上只用 `Date.UTC` + 固定偏移做换算，任何机器上结果都一样
 *    （与 `formatDateTime` 是同一套偏移常量）。
 * 2. **区间左闭右开**：`[start, end)`。相邻周期正好首尾相接，一条订单不会同时属于「昨日」和「今日」，
 *    也不会两边都不属于。「今日 / 本周 / 本月」的结束时间是**取数那一刻**，因为未来还不存在。
 * 3. **纯函数**，当前时间由调用方显式传入（`now`）。这里不调用 `new Date()`：
 *    月末、跨年、闰年这些边界只有传入固定时间才测得出来。
 */

import { BEIJING_OFFSET_MINUTES, formatDateTime } from "@/lib/utils/format";

const MS_PER_MINUTE = 60_000;
const BEIJING_OFFSET_MS = BEIJING_OFFSET_MINUTES * MS_PER_MINUTE;

/** 榜单周期。`all` 是「累计」，即不限起始时间。 */
export type RankingPeriod = "today" | "yesterday" | "week" | "month" | "lastMonth" | "all";

/**
 * 页签顺序。原型顶部是「今日 / 昨日 / 本周 / 本月 / 上月」，本实现把「累计」接在最后：
 * 前五档都是周期榜，累计是它们之外的另一种口径，放在末尾比插在中间更好解释。
 */
export const RANKING_PERIOD_TABS: readonly { key: RankingPeriod; label: string }[] = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "all", label: "累计" },
];

/**
 * 默认周期：**本周**。
 *
 * 依据是原型：`docs/prototype/RankPage.jpg` 里「本周」是唯一的选中态页签
 * （另外四档为未选中），并显示了「更新于 …」。累计没有被原型选中，
 * 因此默认跟随原型取「本周」。
 */
export const DEFAULT_RANKING_PERIOD: RankingPeriod = "week";

/** 是否有有效消费时「我的排名」区域的说明（累计口径下与周期口径下说法不同）。 */
export function rankingMeEmptyMessage(period: RankingPeriod): string {
  return period === "all"
    ? "你还没有有效消费，完成订单后即可上榜。"
    : `你在${rankingPeriodLabel(period)}没有已完成的有效消费，完成订单后即可上榜。`;
}

/* ────────────────────────────── 解析与标签 ────────────────────────────── */

/** 是不是一个合法的周期值。用于接口侧区分「没传」与「传了非法值」。 */
export function isRankingPeriod(value: unknown): value is RankingPeriod {
  return (
    typeof value === "string" && RANKING_PERIOD_TABS.some((tab) => tab.key === value)
  );
}

/**
 * 宽松解析：**非法值或缺失一律返回 null**，由调用方决定怎么处理。
 *
 * 分开一个宽松版本是为了让两种调用方各自守住自己的契约：
 * 页面把非法值规范化成默认周期（用户不该因为地址栏里一个乱写的参数看到报错页），
 * 接口对非法值返回 400（静默返回一份「含义不明」的榜单更糟）。
 */
export function readRankingPeriod(value: string | null | undefined): RankingPeriod | null {
  return isRankingPeriod(value) ? value : null;
}

/** 页面侧规范化：非法值或缺失一律回落到默认周期。 */
export function normalizeRankingPeriod(value: string | null | undefined): RankingPeriod {
  return readRankingPeriod(value) ?? DEFAULT_RANKING_PERIOD;
}

/** 周期的中文名（页签文字与空态文案共用）。 */
export function rankingPeriodLabel(period: RankingPeriod): string {
  return RANKING_PERIOD_TABS.find((tab) => tab.key === period)?.label ?? period;
}

/* ────────────────────────────── 时间边界 ────────────────────────────── */

/**
 * 时间范围（毫秒时间戳）。
 *
 * `start === null` 表示**不限起始时间**（累计）——它同时意味着「不做完成时间过滤」，
 * 见 `isWithinRankingPeriod`。
 */
export type RankingPeriodRange = {
  /** 起始时刻（含） */
  start: number | null;
  /** 结束时刻（**不含**） */
  end: number;
};

/**
 * 北京时间某一天的 00:00 对应的 UTC 毫秒时间戳。
 *
 * `dayOffset` 直接加在「日」上，`Date.UTC` 会自行处理跨月、跨年、闰年
 * （`2026-03-01 + (-1) 天` = `2026-02-28`，闰年则落在 02-29）。
 */
export function beijingDayStart(now: Date, dayOffset = 0): number {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() + dayOffset,
    ) - BEIJING_OFFSET_MS
  );
}

/** 北京时间某个月 1 日 00:00 的 UTC 毫秒时间戳。1 月减一个月自动落到上一年 12 月。 */
export function beijingMonthStart(now: Date, monthOffset = 0): number {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + monthOffset, 1) - BEIJING_OFFSET_MS;
}

/** 本周（**周一为一周的第一天**）周一 00:00 的 UTC 毫秒时间戳。 */
export function beijingWeekStart(now: Date): number {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  // getUTCDay()：0 = 周日。往回退到周一：周一退 0 天、周二退 1 天……周日退 6 天
  const backToMonday = (shifted.getUTCDay() + 6) % 7;
  return beijingDayStart(now, -backToMonday);
}

/**
 * 周期 → 时间范围。
 *
 * | 周期 | 起始（含） | 结束（不含） |
 * | --- | --- | --- |
 * | 今日 | 今天 00:00 | 现在 |
 * | 昨日 | 昨天 00:00 | 今天 00:00 |
 * | 本周 | 本周一 00:00 | 现在 |
 * | 本月 | 本月 1 日 00:00 | 现在 |
 * | 上月 | 上月 1 日 00:00 | 本月 1 日 00:00 |
 * | 累计 | 不限 | 现在 |
 */
export function resolveRankingPeriodRange(
  period: RankingPeriod,
  now: Date,
): RankingPeriodRange {
  const end = now.getTime();

  switch (period) {
    case "today":
      return { start: beijingDayStart(now), end };
    case "yesterday":
      return { start: beijingDayStart(now, -1), end: beijingDayStart(now) };
    case "week":
      return { start: beijingWeekStart(now), end };
    case "month":
      return { start: beijingMonthStart(now), end };
    case "lastMonth":
      return { start: beijingMonthStart(now, -1), end: beijingMonthStart(now) };
    case "all":
      return { start: null, end };
  }
}

/**
 * 订单的完成时间是否落在周期内。
 *
 * **累计（`start === null`）不做完成时间过滤**，这是刻意的：累计口径必须与消费等级页
 * 完全一致（`sumEffectiveSpend` 只看「已完成且未退款」），否则同一个人会在
 * `/rights` 与 `/rank` 上看到两个累计金额。因此累计**不要求** `completedAt` 存在。
 *
 * 周期榜则相反：拿不到有效完成时间就不计入——**不猜**一个时间（例如拿支付时间顶上），
 * 猜出来的归属会让两个周期同时出错。
 */
export function isWithinRankingPeriod(
  completedAt: string | null | undefined,
  range: RankingPeriodRange,
): boolean {
  if (range.start === null) return true;

  const at = completedAt ? Date.parse(completedAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;

  return at >= range.start && at < range.end;
}

/* ────────────────────────────── 文案 ────────────────────────────── */

/** 累计榜的口径与隐私说明。 */
export const RANKING_NOTICE =
  "榜单按累计有效消费金额降序排列，只统计本人「已完成」且未退款的订单实付金额；金额相同按用户编号升序排列，名次稳定。榜单展示用户昵称、头像与消费等级，不匿名、不脱敏。";

/** 周期榜的口径说明：统计的是**完成时间**落在该周期内的订单。 */
export const RANKING_PERIOD_NOTICE =
  "周期榜按所选周期内「已完成」且未退款的订单实付金额聚合，时间以订单的完成时间为准，边界按北京时间（UTC+8）自然日划分；金额相同按用户编号升序排列，名次稳定。榜单展示用户昵称、头像与消费等级，不匿名、不脱敏。";

export function rankingNotice(period: RankingPeriod): string {
  return period === "all" ? RANKING_NOTICE : RANKING_PERIOD_NOTICE;
}

/** 空榜文案带上周期语义：用户能看出「是这个周期没有」而不是「榜单坏了」。 */
export function rankingEmptyTitle(period: RankingPeriod): string {
  return period === "all" ? "榜单暂时还没有数据" : `${rankingPeriodLabel(period)}暂无有效消费`;
}

export function rankingEmptyDescription(period: RankingPeriod): string {
  return period === "all"
    ? "还没有用户产生有效消费，完成订单后即可上榜。"
    : `还没有用户在这个周期内完成订单，换个周期看看。`;
}

/**
 * 时间范围的展示文案（北京时间）。给用户一个可核对的边界，
 * 也给人工验收留下「确实按周期查了」的凭据。
 *
 * 端点不是有效时间时返回占位符而不是抛错：这个函数跑在浏览器里，
 * 一个坏掉的时间戳不该把整页榜单打挂。
 */
export function formatRankingRangeLabel(range: RankingPeriodRange): string {
  if (!Number.isFinite(range.end)) return "—";

  const end = formatDateTime(new Date(range.end).toISOString());
  if (range.start === null) return `不限起始时间 ~ ${end}`;
  if (!Number.isFinite(range.start)) return `— ~ ${end}`;

  const start = formatDateTime(new Date(range.start).toISOString());
  return `${start} ~ ${end}`;
}

/* ────────────────────────────── 客户端：地址与竞态 ────────────────────────────── */

/**
 * 在查询串上写入周期，**保留其它查询参数**（调试参数、分页参数不能被切周期弄丢）。
 * 传入可以带或不带 `?`，返回的一定带 `?`。
 */
export function withRankingPeriod(search: string, period: RankingPeriod): string {
  const params = new URLSearchParams(search);
  params.set("period", period);
  return `?${params.toString()}`;
}

/** 一次榜单请求的身份：序号 + 周期。 */
export type RankingRequest = {
  /** 自增序号，每次发起请求时更新 */
  id: number;
  period: RankingPeriod;
};

/**
 * 响应是否可以写入界面。
 *
 * 快速连点页签时，先发的请求可能后到。只比对序号是不够稳的（序号是自增的，
 * 但「当前该显示哪个周期」是界面的状态，应由状态说话），因此两个条件都要满足：
 * **序号是最新的** 且 **周期仍是当前选中项**。这样迟到的响应既不会覆盖新数据，
 * 也不会把已经切走的周期条目留在屏幕上。
 */
export function shouldApplyRankingResponse(
  response: RankingRequest,
  current: RankingRequest,
): boolean {
  return response.id === current.id && response.period === current.period;
}
