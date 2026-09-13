import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RANKING_PERIOD,
  RANKING_NOTICE,
  RANKING_PERIOD_NOTICE,
  RANKING_PERIOD_TABS,
  beijingDayStart,
  beijingMonthStart,
  beijingWeekStart,
  formatRankingRangeLabel,
  isRankingPeriod,
  isWithinRankingPeriod,
  normalizeRankingPeriod,
  rankingEmptyDescription,
  rankingEmptyTitle,
  rankingMeEmptyMessage,
  rankingNotice,
  rankingPeriodLabel,
  readRankingPeriod,
  resolveRankingPeriodRange,
  shouldApplyRankingResponse,
  withRankingPeriod,
} from "../lib/constants/rankingPeriods.ts";
import { buildConsumptionRanking } from "../lib/constants/rankings.ts";

/**
 * 榜单周期与时间边界的持续测试。
 *
 * 这里只跑**纯函数**：当前时间一律由用例显式传入，不读真实时钟。
 * 时间边界的用例如果在实现里直接 `new Date()`，就只有恰好在那个时刻跑才会红——
 * 这类 bug 会一直藏着，直到某个月底或某个周一才发作。
 *
 * UCT+8 的换算只用 `Date.UTC` + 固定偏移，因此下面所有期望值都是**绝对**的毫秒/ISO 值，
 * 在任何时区的机器上跑都一样（跑在 UTC 的 CI 上也不会偏移一天）。
 */

/** 北京时间 = UTC+8。写用例时用它把「北京时间几点」换算成 UTC。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间某时刻 → ISO 字符串。 */
function beijing(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - BEIJING_OFFSET_MS).toISOString();
}

function at(iso) {
  return new Date(iso);
}

/** 北京时间某时刻是星期几（0 = 周日）。注意不能直接看 UTC 的星期：北京日期可能已经是第二天。 */
function beijingWeekday(iso) {
  return new Date(Date.parse(iso) + BEIJING_OFFSET_MS).getUTCDay();
}

/** 最小订单对象：聚合与周期过滤只读这几个字段。 */
function order({ id, userId = "u-test", completedAt, status = "completed", totalAmount = 1000 }) {
  return { id, userId, completedAt, status, totalAmount };
}

const USERS = [{ id: "u-test", nickname: "测试（占位）", avatarUrl: "/mock/avatar-1.svg", bio: "" }];

/* ────────────────────────── 六档周期与默认值 ────────────────────────── */

test("六档周期都在：今日 / 昨日 / 本周 / 本月 / 上月 / 累计，默认是原型选中的「本周」", () => {
  assert.deepEqual(
    RANKING_PERIOD_TABS.map((tab) => tab.key),
    ["today", "yesterday", "week", "month", "lastMonth", "all"],
  );
  assert.deepEqual(
    RANKING_PERIOD_TABS.map((tab) => tab.label),
    ["今日", "昨日", "本周", "本月", "上月", "累计"],
  );
  // 默认周期跟随原型：`docs/prototype/RankPage.jpg` 里「本周」是唯一的选中态
  assert.equal(DEFAULT_RANKING_PERIOD, "week");
  assert.equal(rankingPeriodLabel(DEFAULT_RANKING_PERIOD), "本周");
});

test("周期解析：合法值原样、缺失与非法值交给调用方处理", () => {
  for (const tab of RANKING_PERIOD_TABS) {
    assert.equal(isRankingPeriod(tab.key), true);
    assert.equal(readRankingPeriod(tab.key), tab.key);
  }

  for (const bad of ["lastWeek", "TODAY", "", "cumulative", "1", null, undefined]) {
    assert.equal(isRankingPeriod(bad), false, `${String(bad)} 不该被当成合法周期`);
    assert.equal(readRankingPeriod(bad), null);
    // 页面侧一律规范化到默认周期：地址里乱写一个值不该让人看到错误页
    assert.equal(normalizeRankingPeriod(bad), DEFAULT_RANKING_PERIOD);
  }
});

test("周期文案：空态、我的排名与口径说明都带周期语义", () => {
  assert.equal(rankingEmptyTitle("today"), "今日暂无有效消费");
  assert.equal(rankingEmptyTitle("lastMonth"), "上月暂无有效消费");
  // 累计用的是原来那句，不硬套「X 暂无有效消费」
  assert.equal(rankingEmptyTitle("all"), "榜单暂时还没有数据");
  assert.ok(rankingEmptyDescription("today").includes("这个周期"));
  assert.ok(rankingEmptyDescription("all").includes("完成订单后即可上榜"));

  assert.ok(rankingMeEmptyMessage("today").includes("今日"));
  assert.equal(rankingMeEmptyMessage("all"), "你还没有有效消费，完成订单后即可上榜。");

  // 周期榜的口径必须写明「完成时间」与「北京时间」，否则用户没法核对边界
  assert.ok(RANKING_PERIOD_NOTICE.includes("完成时间"));
  assert.ok(RANKING_PERIOD_NOTICE.includes("北京时间"));
  assert.equal(rankingNotice("all"), RANKING_NOTICE);
  assert.equal(rankingNotice("week"), RANKING_PERIOD_NOTICE);
  assert.notEqual(RANKING_NOTICE, RANKING_PERIOD_NOTICE);
});

/* ────────────────────────── UTC+8 的时间边界 ────────────────────────── */

test("边界换算：日期起点按北京时间，不受机器时区影响", () => {
  // 北京时间 2026-09-13 00:00 = UTC 2026-09-12 16:00
  const now = at(beijing(2026, 9, 13, 12));
  assert.equal(beijingDayStart(now), Date.parse(beijing(2026, 9, 13)));
  assert.equal(beijingDayStart(now, -1), Date.parse(beijing(2026, 9, 12)));
  assert.equal(beijingMonthStart(now), Date.parse(beijing(2026, 9, 1)));
  assert.equal(beijingMonthStart(now, -1), Date.parse(beijing(2026, 8, 1)));

  // 北京时间 2026-09-13 是周日，本周一 = 2026-09-07
  assert.equal(beijingWeekday(beijing(2026, 9, 13, 12)), 0, "用例前提：这一天是周日");
  assert.equal(beijingWeekStart(now), Date.parse(beijing(2026, 9, 7)));
});

test("UTC 与 UTC+8 的自然日不同：UTC 还在 13 日，北京已经是 14 日", () => {
  // UTC 2026-09-13 20:00 = 北京 2026-09-14 04:00
  const now = at("2026-09-13T20:00:00.000Z");
  assert.equal(now.getUTCDate(), 13, "用例前提：UTC 日期还是 13 日");

  const range = resolveRankingPeriodRange("today", now);
  assert.equal(range.start, Date.parse("2026-09-13T16:00:00.000Z"), "今日起点应是北京 14 日 00:00");

  // UTC 13 日 17:00（= 北京 14 日 01:00）算「今日」；UTC 13 日 15:59（= 北京 13 日 23:59）不算
  assert.equal(isWithinRankingPeriod("2026-09-13T17:00:00.000Z", range), true);
  assert.equal(isWithinRankingPeriod("2026-09-13T15:59:00.000Z", range), false);
});

test("今日：起点含、起点前 1 毫秒不含、现在含、未来不含", () => {
  const now = at(beijing(2026, 9, 13, 20));
  const range = resolveRankingPeriodRange("today", now);

  assert.equal(range.start, Date.parse(beijing(2026, 9, 13)));
  assert.equal(range.end, now.getTime());

  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 13, 0, 0, 0, 0), range), true, "起点含");
  assert.equal(
    isWithinRankingPeriod(beijing(2026, 9, 12, 23, 59, 59, 999), range),
    false,
    "起点前 1 毫秒不该计入",
  );
  assert.equal(
    isWithinRankingPeriod(beijing(2026, 9, 13, 19, 59, 59, 999), range),
    true,
    "现在之前的最后一毫秒含",
  );
  // 区间是左闭右开 `[start, now)`：正好等于「现在」的那一毫秒不计入。
  // 这一条与「昨日结束于今日起点」是同一个规则的两面——右端若取闭区间，
  // 正好落在午夜的订单会同时属于昨日与今日。
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 13, 20), range), false, "右端开区间");
  assert.equal(
    isWithinRankingPeriod(beijing(2026, 9, 13, 20, 0, 0, 1), range),
    false,
    "完成时间在未来不该计入",
  );
});

test("昨日：左闭右开，正好接上今日的起点", () => {
  const now = at(beijing(2026, 9, 13, 10));
  const range = resolveRankingPeriodRange("yesterday", now);

  assert.equal(range.start, Date.parse(beijing(2026, 9, 12)));
  assert.equal(range.end, Date.parse(beijing(2026, 9, 13)));

  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 12, 0, 0), range), true, "昨日起点含");
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 12, 23, 59), range), true);
  // 右开：正好落在今日起点的订单属于今日，不属于昨日。少了这条，一条订单会被两个周期
  // 同时计入（或者两边都不计）
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 13, 0, 0), range), false, "今日起点不含于昨日");
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 11, 23, 59), range), false);
});

test("周日到周一的跨越：本周从周一开始，周日属于上一周", () => {
  const sunday = at(beijing(2026, 9, 13, 23));
  const monday = at(beijing(2026, 9, 14, 0, 30));

  assert.equal(beijingWeekStart(sunday), Date.parse(beijing(2026, 9, 7)));
  assert.equal(beijingWeekStart(monday), Date.parse(beijing(2026, 9, 14)), "周一 00:00 起算新的一周");

  const sundayRange = resolveRankingPeriodRange("week", sunday);
  // 上周日（9-06）不在本周里
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 6, 23), sundayRange), false);
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 7, 0, 0), sundayRange), true, "本周起点含");

  // 周一凌晨：本周只剩这一瞬间开始的一小段，昨日（周日）已经落在上一周
  const mondayRange = resolveRankingPeriodRange("week", monday);
  assert.equal(mondayRange.start, Date.parse(beijing(2026, 9, 14)));
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 13, 23), mondayRange), false, "周日不属于新的本周");
});

test("本月与上月：月末、月首与「上月只含完整的上一个月」", () => {
  const endOfMonth = at(beijing(2026, 9, 30, 23, 59, 59, 999));
  const range = resolveRankingPeriodRange("month", endOfMonth);
  assert.equal(range.start, Date.parse(beijing(2026, 9, 1)));
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 1, 0, 0), range), true);
  assert.equal(isWithinRankingPeriod(beijing(2026, 8, 31, 23, 59), range), false);

  const lastMonth = resolveRankingPeriodRange("lastMonth", endOfMonth);
  assert.equal(lastMonth.start, Date.parse(beijing(2026, 8, 1)));
  assert.equal(lastMonth.end, Date.parse(beijing(2026, 9, 1)), "上月结束于本月起点");
  assert.equal(isWithinRankingPeriod(beijing(2026, 8, 1, 0, 0), lastMonth), true, "上月起点含");
  assert.equal(isWithinRankingPeriod(beijing(2026, 8, 31, 23, 59), lastMonth), true);
  // 本月第一天不在上月里：这是「本月不含上月」的另一面
  assert.equal(isWithinRankingPeriod(beijing(2026, 9, 1, 0, 0), lastMonth), false);

  // 月初查询：本月只有刚刚过去的一小段
  const startOfMonth = at(beijing(2026, 9, 1, 8));
  const fresh = resolveRankingPeriodRange("month", startOfMonth);
  assert.equal(fresh.start, Date.parse(beijing(2026, 9, 1)));
  assert.equal(fresh.end, startOfMonth.getTime());
});

test("一月查「上月」跨到上一年 12 月", () => {
  const now = at(beijing(2026, 1, 15, 12));
  const range = resolveRankingPeriodRange("lastMonth", now);

  assert.equal(range.start, Date.parse(beijing(2025, 12, 1)));
  assert.equal(range.end, Date.parse(beijing(2026, 1, 1)));
  assert.equal(isWithinRankingPeriod(beijing(2025, 12, 31, 23), range), true);
  assert.equal(isWithinRankingPeriod(beijing(2026, 1, 1, 0, 0), range), false);

  // 往前推一天也跨年：1 月 1 日的昨天在 12 月 31 日
  assert.equal(beijingDayStart(now, -14), Date.parse(beijing(2026, 1, 1)));
  assert.equal(beijingDayStart(at(beijing(2026, 1, 1, 0, 30)), -1), Date.parse(beijing(2025, 12, 31)));
});

test("闰年与非闰年的二月：按天/按月回退都不会掉到错误的一天", () => {
  // 2028 是闰年：3 月 1 日的前一天是 2 月 29 日
  assert.equal(beijingDayStart(at(beijing(2028, 3, 1, 12)), -1), Date.parse(beijing(2028, 2, 29)));
  // 2026 不是闰年：3 月 1 日的前一天是 2 月 28 日
  assert.equal(beijingDayStart(at(beijing(2026, 3, 1, 12)), -1), Date.parse(beijing(2026, 2, 28)));

  // 3 月的「上月」在闰年是 2 月 1 日～3 月 1 日（含 2 月 29 日）
  const leap = resolveRankingPeriodRange("lastMonth", at(beijing(2028, 3, 10)));
  assert.equal(leap.start, Date.parse(beijing(2028, 2, 1)));
  assert.equal(leap.end, Date.parse(beijing(2028, 3, 1)));
  assert.equal(isWithinRankingPeriod(beijing(2028, 2, 29, 12), leap), true, "闰日属于 2 月");

  const plain = resolveRankingPeriodRange("lastMonth", at(beijing(2026, 3, 10)));
  assert.equal(isWithinRankingPeriod(beijing(2026, 2, 28, 12), plain), true);
});

test("累计：不限起始时间，也不按完成时间过滤（与消费等级页同一套口径）", () => {
  const now = at(beijing(2026, 9, 13, 12));
  const range = resolveRankingPeriodRange("all", now);

  assert.equal(range.start, null);
  assert.equal(range.end, now.getTime());

  assert.equal(isWithinRankingPeriod(beijing(2020, 1, 1), range), true, "多年以前的订单照样计入");
  assert.equal(isWithinRankingPeriod(null, range), true, "累计不要求完成时间存在");
  assert.equal(isWithinRankingPeriod("", range), true);
  assert.equal(isWithinRankingPeriod("不是时间", range), true);
});

test("完成时间异常：周期榜不计入、不抛错，整张榜也不会因此打不开", () => {
  const now = at(beijing(2026, 9, 13, 12));
  const today = resolveRankingPeriodRange("today", now);

  for (const bad of [null, undefined, "", "2026-13-45", "not-a-date"]) {
    assert.equal(isWithinRankingPeriod(bad, today), false, `${String(bad)} 不该被算进周期榜`);
  }

  // 混进一条坏数据，榜单照常算得出来（不能因为一条数据把整张榜打成 500）
  const orders = [
    order({ id: "ok-1", completedAt: beijing(2026, 9, 13, 9), totalAmount: 500 }),
    order({ id: "bad-1", completedAt: null, totalAmount: 999 }),
    order({ id: "bad-2", completedAt: "not-a-date", totalAmount: 999 }),
  ];
  const rows = buildConsumptionRanking(orders, USERS, [], today);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effectiveSpendAmount, 500, "坏数据不该被算进金额");
});

test("周期过滤发生在聚合之前：跨越两个周期的订单各归各的", () => {
  const now = at(beijing(2026, 9, 13, 12));
  const orders = [
    order({ id: "t-1", completedAt: beijing(2026, 9, 13, 1), totalAmount: 100 }),
    order({ id: "t-2", completedAt: beijing(2026, 9, 13, 11), totalAmount: 200 }),
    order({ id: "y-1", completedAt: beijing(2026, 9, 12, 23, 59, 59, 999), totalAmount: 400 }),
    // 已退款：即使完成时间落在今日也不算
    order({ id: "r-1", completedAt: beijing(2026, 9, 13, 2), totalAmount: 800, status: "refunded" }),
    // 进行中：没有完成时间
    order({ id: "p-1", completedAt: null, totalAmount: 1600, status: "serving" }),
  ];

  const today = buildConsumptionRanking(
    orders,
    USERS,
    [],
    resolveRankingPeriodRange("today", now),
  );
  assert.equal(today[0].effectiveSpendAmount, 300, "今日只算今日的两单");

  const yesterday = buildConsumptionRanking(
    orders,
    USERS,
    [],
    resolveRankingPeriodRange("yesterday", now),
  );
  assert.equal(yesterday[0].effectiveSpendAmount, 400, "昨日那一单不落在今日");

  const all = buildConsumptionRanking(orders, USERS, [], resolveRankingPeriodRange("all", now));
  assert.equal(all[0].effectiveSpendAmount, 700, "累计含跨周期的全部有效订单");
});

test("同一订单只计一次：重复喂进来不会把金额翻倍", () => {
  const now = at(beijing(2026, 9, 13, 12));
  const one = order({ id: "dup-1", completedAt: beijing(2026, 9, 13, 9), totalAmount: 1234 });
  const range = resolveRankingPeriodRange("today", now);

  const once = buildConsumptionRanking([one], USERS, [], range);
  const twice = buildConsumptionRanking([one, { ...one }], USERS, [], range);
  assert.equal(once[0].effectiveSpendAmount, 1234);
  assert.equal(twice[0].effectiveSpendAmount, 1234);
});

/* ────────────────────────── 客户端：地址与竞态 ────────────────────────── */

test("地址规范化：写入 period 时保留其它查询参数", () => {
  assert.equal(withRankingPeriod("", "week"), "?period=week");
  assert.equal(withRankingPeriod("?", "today"), "?period=today");
  assert.equal(
    withRankingPeriod("?period=bogus&mockEmpty=rankings", "lastMonth"),
    "?period=lastMonth&mockEmpty=rankings",
  );
  assert.equal(withRankingPeriod("?page=2", "all"), "?page=2&period=all");
});

test("迟到的响应不写入界面：序号与周期都要对得上", () => {
  const current = { id: 3, period: "yesterday" };

  assert.equal(shouldApplyRankingResponse({ id: 3, period: "yesterday" }, current), true);
  // 先发的请求后到：序号已经落后
  assert.equal(shouldApplyRankingResponse({ id: 2, period: "today" }, current), false);
  // 序号对得上、但周期已经被切走（例如响应里的 period 与当前页签不符）
  assert.equal(shouldApplyRankingResponse({ id: 3, period: "today" }, current), false);
  // 更旧的请求恰好也返回了当前周期：仍然不许写入，否则会把新的一页覆盖掉
  assert.equal(shouldApplyRankingResponse({ id: 1, period: "yesterday" }, current), false);
});

test("时间范围的展示文案：累计写「不限起始时间」，其余写两端", () => {
  const now = at(beijing(2026, 9, 13, 12, 34));
  const label = formatRankingRangeLabel(resolveRankingPeriodRange("week", now));
  // 北京时间 2026-09-07 00:00 ~ 2026-09-13 12:34
  assert.equal(label, "2026-09-07 00:00 ~ 2026-09-13 12:34");

  assert.equal(
    formatRankingRangeLabel(resolveRankingPeriodRange("all", now)),
    "不限起始时间 ~ 2026-09-13 12:34",
  );

  // 坏时间戳不炸：只给占位符
  assert.equal(formatRankingRangeLabel({ start: null, end: Number.NaN }), "—");
});
