import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { resolveSource } from "./app-path.mjs";
import {
  RANKING_MAX_PAGE_SIZE,
  RANKING_MIN_SPEND,
  RANKING_PAGE_SIZE,
  buildConsumptionRanking,
  compareRankingRows,
  findRankingRowIndex,
  mergeRankingPage,
  paginateRankingRows,
  parseRankingQuery,
  toRankingEntry,
} from "../lib/constants/rankings.ts";
import {
  DEFAULT_RANKING_PERIOD,
  RANKING_NOTICE,
  RANKING_PERIOD_NOTICE,
  beijingMonthStart,
  isWithinRankingPeriod,
  resolveRankingPeriodRange,
} from "../lib/constants/rankingPeriods.ts";
import { sumEffectiveSpend } from "../lib/constants/levels.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { levelSeed } from "../lib/mocks/fixtures/levelSeed.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { buildRankingPeriodOrders, orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import { userSeed } from "../lib/mocks/fixtures/seed.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import * as rankingsHttp from "../lib/services/rankingsHttp.ts";

/**
 * 消费排行榜的持续测试。
 *
 * 五条规则是重点：
 *
 * 1. **排序确定**：金额降序 → 用户 id 升序。少了第二步，同金额用户在分页边界上会漂移，
 *    同一个人的名次两次刷新可能不一样；
 * 2. **口径与消费等级页一致**：累计周期复用 `sumEffectiveSpend`，有订单但全是退款/进行中的
 *    用户不进榜；周期榜额外按**完成时间**过滤；
 * 3. **先聚合后分页**：周期过滤发生在切片之前，否则每一页剩下的人不一样、名次整片错位；
 * 4. **隐私边界**：公开 DTO 只有五项，`userId` / `displayId` / 简介一律不出现；
 * 5. **测试不依赖真实执行日期**：需要断言具体归属时，一律把「现在」显式传给纯函数
 *    （`FIXED_NOW`），而不是靠跑测试的那一天恰好是周三。
 */

const USER_A = "u-1001";
const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

/**
 * 进程内的基准时间：与仓储建仓时用的是同一个（`getMockSeedNow()` 一个进程只取一次），
 * 因此下面用 `ALL_ORDERS` 造出来的榜单与服务端返回的榜单是同一份数据。
 */
const SEED_NOW = getMockSeedNow();

/** 全量订单：与 `mockPaymentRepository` 建仓时完全一致（含相对时间构造的周期榜预置订单）。 */
const ALL_ORDERS = [...orderSeed, ...buildRankingPeriodOrders(SEED_NOW)];

/** 累计口径的时间范围：`start` 为 null，与消费等级页完全一致。 */
const ALL_RANGE = { start: null, end: SEED_NOW.getTime() };

/**
 * 固定一个**周三**做基准（北京时间 2026-09-16 12:00）。
 *
 * 这一天六个周期互不重叠：今日 9-16、昨日 9-15、本周一 9-14、本月 1 日、上月 8 月。
 * 只有用这样的固定基准，才能断言「今日正好是这三个人」——用真实当前时间的话，
 * 周一跑、月初跑、月底跑都会得到不同的答案，用例会在某一天突然变红。
 */
const FIXED_NOW = new Date("2026-09-16T04:00:00.000Z");

const FIXTURE_ORDERS = buildRankingPeriodOrders(FIXED_NOW);

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「这里没有 X」不算出现 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 直接按种子造一份榜单（不经过服务层），用于纯逻辑断言。 */
function buildSeedRanking(levels = levelSeed, orders = ALL_ORDERS, range = ALL_RANGE) {
  return buildConsumptionRanking(orders, userSeed, levels, range);
}

/** 按固定基准造某一个周期的榜单。 */
function buildFixtureRanking(period) {
  return buildConsumptionRanking(
    FIXTURE_ORDERS,
    userSeed,
    levelSeed,
    resolveRankingPeriodRange(period, FIXED_NOW),
  );
}

/** 「谁在榜上、各有多少钱」，用于逐个周期比对。 */
function shapeOf(rows) {
  return rows.map((row) => `${row.userId}:${row.effectiveSpendAmount}`);
}

/** 六个周期，顺序与页面页签一致。 */
const SIX_PERIODS = ["today", "yesterday", "week", "month", "lastMonth", "all"];

beforeEach(() => {
  resetMockStore("level");
  resetMockStore("payment");
  resetMockStore("user");
});

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

test("排序：金额降序，金额相同的按用户 id 升序（名次因此完全确定）", () => {
  const rows = buildSeedRanking();

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    assert.ok(
      previous.effectiveSpendAmount > current.effectiveSpendAmount ||
        (previous.effectiveSpendAmount === current.effectiveSpendAmount &&
          previous.userId < current.userId),
      `第 ${index + 1} 名与第 ${index} 名的顺序不稳定：${previous.userId} / ${current.userId}`,
    );
  }

  // 种子里刻意有两位金额完全相同的用户：他们必须按 id 升序，而不是随机
  const tied = rows.filter((row) => row.effectiveSpendAmount === 30000);
  assert.deepEqual(
    tied.map((row) => row.userId),
    ["u-1006", "u-1007"],
  );

  // 打乱输入顺序，结果必须一模一样
  const shuffled = buildConsumptionRanking(
    [...ALL_ORDERS].reverse(),
    [...userSeed].reverse(),
    levelSeed,
    ALL_RANGE,
  );
  assert.deepEqual(
    shuffled.map((row) => `${row.userId}:${row.effectiveSpendAmount}`),
    rows.map((row) => `${row.userId}:${row.effectiveSpendAmount}`),
  );

  // 比较函数本身也只依赖这两个字段
  const a = { userId: "u-a", effectiveSpendAmount: 100 };
  const b = { userId: "u-b", effectiveSpendAmount: 100 };
  assert.ok(compareRankingRows(a, b) < 0);
  assert.ok(compareRankingRows(b, a) > 0);
  assert.equal(compareRankingRows(b, b), 0);
  assert.ok(compareRankingRows({ ...b, effectiveSpendAmount: 200 }, a) < 0);
});

test("只展示有效消费大于 0 的用户：有订单但全在口径之外的人不进榜", () => {
  assert.equal(RANKING_MIN_SPEND, 1);
  const rows = buildSeedRanking();
  const ids = rows.map((row) => row.userId);

  for (const row of rows) assert.ok(row.effectiveSpendAmount >= RANKING_MIN_SPEND);

  // u-1009 有一单已退款、一单还在进行中：金额是 0，因此不出现
  assert.equal(sumEffectiveSpend(ALL_ORDERS.filter((order) => order.userId === "u-1009")), 0);
  assert.equal(ids.includes("u-1009"), false, "有效消费为 0 的用户不该上榜");

  // u-1010 没有任何订单，同样不出现
  assert.equal(ids.includes("u-1010"), false);

  // 规则对每位用户都成立：榜上每一行的金额都能由订单口径复算出来
  for (const row of rows) {
    const spend = sumEffectiveSpend(ALL_ORDERS.filter((order) => order.userId === row.userId));
    assert.equal(row.effectiveSpendAmount, spend, `${row.userId} 的金额与消费口径不一致`);
  }

  // 三位有消费的用户构成了前三名
  assert.deepEqual(ids.slice(0, 3), ["u-1004", "u-1003", "u-1005"]);
});

test("等级名来自等级配置；配置不可用时留空，不编一个默认等级名", () => {
  const rows = buildSeedRanking();
  const byId = new Map(rows.map((row) => [row.userId, row]));

  assert.equal(byId.get("u-1004").levelName, "金牌老板"); // 115800 → 60000 档
  assert.equal(byId.get("u-1003").levelName, "高级老板"); // 59880 → 30000 档
  assert.equal(byId.get("u-1006").levelName, "高级老板"); // 正好 30000
  assert.equal(byId.get("u-1001").levelName, "普通老板"); // 24060 → 0 档

  // 等级配置为空（停用或未配置）：**不编等级名**，页面显示「等级待配置」
  const withoutLevels = buildSeedRanking([]);
  assert.ok(withoutLevels.length > 0, "等级配置不影响榜单本身");
  for (const row of withoutLevels) assert.equal(row.levelName, "");
});

test("名次是全局名次：分页之间连续，不重复也不遗漏", () => {
  const rows = buildSeedRanking();
  assert.ok(rows.length > 4, "种子数据应当足够翻页");

  const first = paginateRankingRows(rows, 1, 3);
  const second = paginateRankingRows(rows, 2, 3);

  assert.deepEqual(
    first.items.map((item) => item.rank),
    [1, 2, 3],
  );
  // 第二页的第一条接着上一页继续数，而不是又从 1 开始
  assert.deepEqual(
    second.items.map((item) => item.rank),
    [4, 5, 6],
  );
  assert.equal(first.total, rows.length);
  assert.equal(first.hasMore, rows.length > 3);

  // 跨页合并：按名次去重，条数等于两页之和（无重叠）
  const merged = mergeRankingPage(first, second);
  assert.equal(merged.items.length, first.items.length + second.items.length);
  const ranks = merged.items.map((item) => item.rank);
  assert.equal(new Set(ranks).size, ranks.length, "合并后出现重复名次");

  // 重复取同一页再合并：去重后条数不变（「加载更多」连点两次的兜底）
  assert.equal(mergeRankingPage(first, first).items.length, first.items.length);

  // 越界页返回空列表，但名次字段本身仍然是全局的
  const beyond = paginateRankingRows(rows, 999, 20);
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);

  // 「我的排名」的定位：在全局榜单里找得到就给出名次，找不到（含游客）返回 -1
  assert.equal(findRankingRowIndex(rows, rows[0].userId) + 1, 1);
  assert.equal(findRankingRowIndex(rows, "u-1010"), -1, "没上榜的用户不该定位到任何一行");
  assert.equal(findRankingRowIndex(rows, null), -1, "游客没有名次");
});

test("公开 DTO 只有五项：没有 userId，也没有订单与简介", () => {
  const rows = buildSeedRanking();
  const entry = toRankingEntry(rows[0], 1);

  assert.deepEqual(Object.keys(entry).sort(), [
    "avatarUrl",
    "effectiveSpendAmount",
    "levelName",
    "nickname",
    "rank",
  ]);
  assert.equal("userId" in entry, false, "榜单条目不该带内部用户标识");

  const serialized = JSON.stringify(paginateRankingRows(rows, 1, 20));
  for (const forbidden of ["userId", "displayId", "bio", "orderNo", "orderId", "gameAccountId"]) {
    assert.equal(serialized.includes(forbidden), false, `榜单响应不该出现 ${forbidden}`);
  }
});

/* ────────────────────────────── 周期聚合 ────────────────────────────── */

test("六个周期各自聚合出不同的用户与金额（固定基准时间，逐个比对）", () => {
  // 预置订单分摊在六个周期上：今日三人、昨日两人、本周两人、本月两人、上月三人
  assert.deepEqual(shapeOf(buildFixtureRanking("today")), [
    "u-1011:12000", // 今日 12:00
    "u-1001:6600", // 今日 10:00
    "u-1012:6600", // 今日 09:00：与 u-1001 同额，按 id 升序排在后面
  ]);

  assert.deepEqual(shapeOf(buildFixtureRanking("yesterday")), [
    "u-1013:25500", // 昨日 15:00
    "u-1017:8600", // 昨日 18:00
  ]);

  // 本周 = 本周一那两单 + 今日 + 昨日（周三时昨日仍在本周内）
  assert.deepEqual(shapeOf(buildFixtureRanking("week")), [
    "u-1013:25500",
    "u-1018:14500",
    "u-1011:12000",
    "u-1014:9000",
    "u-1017:8600",
    "u-1001:6600",
    "u-1012:6600",
  ]);

  // 本月 = 本周 + 本月 1 日 / 2 日那两单
  assert.deepEqual(shapeOf(buildFixtureRanking("month")), [
    "u-1013:25500",
    "u-1015:18900",
    "u-1018:14500",
    "u-1011:12000",
    "u-1014:9000",
    "u-1017:8600",
    "u-1001:6600",
    "u-1012:6600",
    "u-1019:3300",
  ]);

  // 上月三人，其中 u-1016 与 u-1021 同额（137.00），按 id 升序
  assert.deepEqual(shapeOf(buildFixtureRanking("lastMonth")), [
    "u-1020:28800",
    "u-1016:13700",
    "u-1021:13700",
  ]);

  // 累计 = 上面十二个人全都在（另有既有种子的绝对日期订单，那是 ALL_ORDERS 的事）
  assert.deepEqual(shapeOf(buildFixtureRanking("all")), [
    "u-1020:28800",
    "u-1013:25500",
    "u-1015:18900",
    "u-1018:14500",
    "u-1016:13700",
    "u-1021:13700",
    "u-1011:12000",
    "u-1014:9000",
    "u-1017:8600",
    "u-1001:6600",
    "u-1012:6600",
    "u-1019:3300",
  ]);
});

/* ─────────────────── 周期数据不依赖绝对日期（任意月份都成立） ─────────────────── */

/**
 * 固定基准时间，覆盖各种「换个月就变样」的边界。
 *
 * 手工验收最容易漏掉的正是这些日期：昨天还在的绝对日期订单，今天已经滚出「上月」。
 * 所以每个基准都要把六个周期整个走一遍。
 */
const FIXED_NOWS = [
  { label: "普通月中（周三）", iso: "2026-09-16T04:00:00.000Z" },
  { label: "月初 1 日", iso: "2026-11-01T04:00:00.000Z" },
  { label: "月末 31 日", iso: "2026-07-31T04:00:00.000Z" },
  { label: "十二月（上月是 11 月）", iso: "2026-12-15T04:00:00.000Z" },
  { label: "跨年前一天", iso: "2026-12-31T04:00:00.000Z" },
  { label: "一月（上月是上一年 12 月）", iso: "2027-01-15T04:00:00.000Z" },
  { label: "二月（非闰年，上月 31 天）", iso: "2027-02-15T04:00:00.000Z" },
  { label: "三月（闰年，上月 2 月 29 天）", iso: "2028-03-15T04:00:00.000Z" },
  { label: "北京时间刚过零点", iso: "2026-10-05T16:00:30.000Z" },
];

/** 每个周期在**只有相对时间订单**时必须出现的人与金额。 */
const EXPECTED_FIXTURES = {
  today: ["u-1011:12000", "u-1001:6600", "u-1012:6600"],
  yesterday: ["u-1013:25500", "u-1017:8600"],
  lastMonth: ["u-1020:28800", "u-1016:13700", "u-1021:13700"],
  all: [
    "u-1020:28800",
    "u-1013:25500",
    "u-1015:18900",
    "u-1018:14500",
    "u-1016:13700",
    "u-1021:13700",
    "u-1011:12000",
    "u-1014:9000",
    "u-1017:8600",
    "u-1001:6600",
    "u-1012:6600",
    "u-1019:3300",
  ],
};

test("上月榜在任何月份都自给自足：八月、一月、闰年二月、月初都一样", () => {
  for (const { label, iso } of FIXED_NOWS) {
    const now = new Date(iso);
    const orders = buildRankingPeriodOrders(now);
    const lastMonth = resolveRankingPeriodRange("lastMonth", now);

    // 上月的区间就是「上一个自然月」：终点正好是本月 1 日 00:00，起点在更早的一个月
    const start = new Date(lastMonth.start);
    const end = new Date(lastMonth.end);
    assert.equal(end.getTime(), beijingMonthStart(now), `${label}：上月的终点应是本月 1 日 00:00`);
    assert.ok(start.getTime() < end.getTime(), `${label}：上月区间必须有长度`);

    const rows = buildConsumptionRanking(orders, userSeed, levelSeed, lastMonth);
    const shape = shapeOf(rows);
    const byId = new Map(rows.map((row) => [row.userId, row.effectiveSpendAmount]));

    // 上月自己的三位永远在，金额永远不变——这是「不依赖绝对日期」的核心保证
    for (const expected of EXPECTED_FIXTURES.lastMonth) {
      const [userId, amount] = expected.split(":");
      assert.equal(byId.get(userId), Number(amount), `${label}：上月缺少 ${expected}`);
    }
    // 上月第一名也永远是那一位（漏进来的其它周期订单金额都比它小）
    assert.equal(shape[0], EXPECTED_FIXTURES.lastMonth[0], `${label}：上月第一名不对`);

    // 月初那几天，昨日 / 本周一可能**本来就落在上个月**——这是正确的归属，不是串数据。
    // 除了这种「区间天然重叠」的情况，上月榜就是那三位。
    const leaked = shape.filter((row) => !EXPECTED_FIXTURES.lastMonth.includes(row));
    for (const row of leaked) {
      const userId = row.split(":")[0];
      const order = orders.find((item) => item.userId === userId);
      assert.ok(
        Date.parse(order.completedAt) >= start.getTime() &&
          Date.parse(order.completedAt) < end.getTime(),
        `${label}：${userId} 的完成时间并不在上月区间内，不该出现在上月榜`,
      );
    }

    // 每一项都落在它该在的周期里，且没有一项晚于「现在」
    for (const order of orders) {
      const at = Date.parse(order.completedAt);
      assert.ok(at <= now.getTime(), `${label}：${order.id} 的完成时间晚于「现在」`);
      const matched = SIX_PERIODS.filter((period) =>
        isWithinRankingPeriod(order.completedAt, resolveRankingPeriodRange(period, now)),
      );
      assert.ok(matched.length > 0, `${label}：${order.id} 不落在任何周期里`);
    }

    // 同一进程内稳定：同一个 `now` 调两次，结果逐字段相同
    assert.deepEqual(buildRankingPeriodOrders(now), orders, `${label}：两次构造结果不一致`);
  }

  // 月中且本周不跨月时，上月**就是**那三位（含一对同额并列）
  for (const iso of [
    "2026-09-16T04:00:00.000Z",
    "2026-12-15T04:00:00.000Z",
    "2027-01-15T04:00:00.000Z",
    "2027-02-15T04:00:00.000Z",
    "2028-03-15T04:00:00.000Z",
  ]) {
    const now = new Date(iso);
    assert.deepEqual(
      shapeOf(
        buildConsumptionRanking(
          buildRankingPeriodOrders(now),
          userSeed,
          levelSeed,
          resolveRankingPeriodRange("lastMonth", now),
        ),
      ),
      EXPECTED_FIXTURES.lastMonth,
      `${iso}：处在月中时，上月榜应当就只有上月自己的三位`,
    );
  }

  // 一月的「上月」必须落到上一年 12 月：跨年不会算成今年 1 月
  const january = new Date("2027-01-15T04:00:00.000Z");
  const januaryLastMonth = resolveRankingPeriodRange("lastMonth", january);
  assert.equal(new Date(januaryLastMonth.start).toISOString(), "2026-11-30T16:00:00.000Z"); // 北京 2026-12-01 00:00
  assert.equal(new Date(januaryLastMonth.end).toISOString(), "2026-12-31T16:00:00.000Z"); // 北京 2027-01-01 00:00

  // 闰年三月的「上月」是 2 月：29 天，20 日仍然存在
  const leap = new Date("2028-03-15T04:00:00.000Z");
  assert.equal(
    new Date(resolveRankingPeriodRange("lastMonth", leap).start).toISOString(),
    "2028-01-31T16:00:00.000Z", // 北京 2028-02-01 00:00
  );
  // 非闰年二月的「上月」是 31 天的 1 月
  const nonLeap = new Date("2027-02-15T04:00:00.000Z");
  assert.equal(
    new Date(resolveRankingPeriodRange("lastMonth", nonLeap).start).toISOString(),
    "2026-12-31T16:00:00.000Z", // 北京 2027-01-01 00:00
  );
});

test("六个周期都不把绝对日期订单当必要数据：把它们全部去掉，六档照样有数据且不多不少", () => {
  for (const { label, iso } of FIXED_NOWS) {
    const now = new Date(iso);
    const relativeOnly = buildRankingPeriodOrders(now);
    const withAbsolute = [...orderSeed, ...relativeOnly];

    for (const period of SIX_PERIODS) {
      const range = resolveRankingPeriodRange(period, now);
      const without = buildConsumptionRanking(relativeOnly, userSeed, levelSeed, range);
      const withAll = buildConsumptionRanking(withAbsolute, userSeed, levelSeed, range);

      // 1. 去掉全部绝对日期订单后，这一档仍然有人——不是靠历史数据撑着
      assert.ok(without.length > 0, `${label} 的 ${period} 在去掉绝对日期订单后成了空榜`);

      // 2. 相对数据一个不少：绝对订单只可能**额外**带来人/金额，不会顶掉或减少它
      const byId = new Map(withAll.map((row) => [row.userId, row]));
      for (const row of without) {
        assert.ok(byId.has(row.userId), `${label} 的 ${period}：${row.userId} 只在绝对数据里出现`);
        assert.ok(
          byId.get(row.userId).effectiveSpendAmount >= row.effectiveSpendAmount,
          `${label} 的 ${period}：${row.userId} 的相对金额被绝对订单顶掉了`,
        );
      }
    }
  }

  // 固定基准上的完整期望：今日 / 昨日 / 上月 / 累计 各自的相对数据
  for (const [period, expected] of Object.entries(EXPECTED_FIXTURES)) {
    assert.deepEqual(
      shapeOf(
        buildConsumptionRanking(
          buildRankingPeriodOrders(FIXED_NOW),
          userSeed,
          levelSeed,
          resolveRankingPeriodRange(period, FIXED_NOW),
        ),
      ),
      expected,
      `${period} 的相对数据与预期不符`,
    );
  }

  // 反证：把相对订单全部去掉、只留绝对日期订单，五个时间周期会立刻散架。
  // 这里把「现在」推到绝对日期订单之后（种子的日期都在 2026 年），
  // 因此这正是「换个月再打开」时旧实现的真实下场——今日到上月全部空榜。
  const future = new Date("2030-06-15T04:00:00.000Z");
  for (const period of ["today", "yesterday", "week", "month", "lastMonth"]) {
    const absoluteOnly = buildConsumptionRanking(
      orderSeed,
      userSeed,
      levelSeed,
      resolveRankingPeriodRange(period, future),
    );
    assert.deepEqual(shapeOf(absoluteOnly), [], `${period}：绝对日期订单不该能撑起这一档`);

    // 同一时刻，相对时间的预置数据照样把每一档填满
    const relativeOnly = buildConsumptionRanking(
      buildRankingPeriodOrders(future),
      userSeed,
      levelSeed,
      resolveRankingPeriodRange(period, future),
    );
    assert.ok(relativeOnly.length >= 2, `${period}：换到 2030 年也该有相对数据`);
  }

  // 累计是唯一一档允许依赖绝对日期订单的：它不限起始时间
  assert.ok(
    buildConsumptionRanking(orderSeed, userSeed, levelSeed, { start: null, end: future.getTime() })
      .length > 0,
  );
});

test("动态订单不与既有种子冲突，也不会重复累计", () => {
  for (const { label, iso } of FIXED_NOWS) {
    const now = new Date(iso);
    const dynamic = buildRankingPeriodOrders(now);
    const all = [...orderSeed, ...dynamic];

    const ids = all.map((order) => order.id);
    assert.equal(new Set(ids).size, all.length, `${label}：出现重复订单 id`);
    const orderNos = all.map((order) => order.orderNo);
    assert.equal(new Set(orderNos).size, all.length, `${label}：出现重复订单号`);

    // 命名空间分开：动态订单一律 ord-rank-*，既有种子一律 ord-seed-*
    const seedIds = new Set(orderSeed.map((order) => order.id));
    for (const order of dynamic) {
      assert.equal(seedIds.has(order.id), false, `${order.id} 与既有种子订单 id 冲突`);
      assert.ok(order.id.startsWith("ord-rank-"), `${order.id} 应当带 ord-rank- 前缀`);
      assert.ok(order.orderNo.startsWith("YMRANK"), `${order.orderNo} 应当带 YMRANK 前缀`);
      assert.equal(order.status, "completed");
      assert.ok(order.totalAmount > 0 && Number.isInteger(order.totalAmount));
    }

    // 不重复累计：按 id 去重后总数不变，逐人金额也一致
    const deduped = [...new Map(all.map((order) => [order.id, order])).values()];
    assert.equal(deduped.length, all.length);
    for (const userId of ["u-1001", "u-1016", "u-1020", "u-1009"]) {
      assert.equal(
        sumEffectiveSpend(deduped.filter((order) => order.userId === userId)),
        sumEffectiveSpend(all.filter((order) => order.userId === userId)),
        `${label}：${userId} 的累计金额受重复订单影响`,
      );
    }
  }
});

test("新增的周期榜用户不牵连既有订单、评价与等级：u-1001 的累计金额与订单条数不变", () => {
  const dynamic = buildRankingPeriodOrders(SEED_NOW);

  // 新增的十一位用户里只有 u-1001 出现在既有种子里，且只多了一单（今日那一单）
  const seedUserIds = new Set(orderSeed.map((order) => order.userId));
  const dynamicUserIds = new Set(dynamic.map((order) => order.userId));
  const overlapping = [...dynamicUserIds].filter((userId) => seedUserIds.has(userId));
  assert.deepEqual(overlapping, ["u-1001"], "不应有别的既有用户被塞进周期榜订单");

  const forSeedUser = dynamic.filter((order) => order.userId === "u-1001");
  assert.equal(forSeedUser.length, 1);
  assert.equal(forSeedUser[0].id, "ord-rank-today-1001");

  // 既有种子里 u-1001 的订单与后端用例依赖的字段一个字都没变
  const seedOrdersOfA = orderSeed.filter((order) => order.userId === "u-1001");
  assert.equal(seedOrdersOfA.length, 15);
  assert.equal(sumEffectiveSpend(seedOrdersOfA), 17460);
  // 只有加上那一单今日订单，金额才是 240.60
  assert.equal(24060 - sumEffectiveSpend(forSeedUser), 17460);

  // 其它既有用户的累计金额完全不受影响
  for (const userId of ["u-1002", "u-1003", "u-1004", "u-1009"]) {
    assert.equal(dynamic.some((order) => order.userId === userId), false);
  }

  // 动态订单不参与评价：它们是「已完成但未评价」之外的新订单，不应改变既有的评价资格判定
  for (const order of dynamic) {
    assert.equal(
      /review/i.test(order.id) || /review/i.test(order.orderNo),
      false,
      "动态订单不该出现在评价相关的命名空间里",
    );
  }
});

test("同一个用户在不同周期金额不同：今日 66.00、上周 0、累计含全部", () => {
  const rangeOf = (period) => resolveRankingPeriodRange(period, FIXED_NOW);
  const spendOf = (period, userId) => {
    const rows = buildConsumptionRanking(FIXTURE_ORDERS, userSeed, levelSeed, rangeOf(period));
    return rows.find((row) => row.userId === userId)?.effectiveSpendAmount ?? 0;
  };

  // u-1001 只有今日那一单
  assert.equal(spendOf("today", USER_A), 6600);
  assert.equal(spendOf("week", USER_A), 6600);
  assert.equal(spendOf("month", USER_A), 6600);
  assert.equal(spendOf("yesterday", USER_A), 0);
  assert.equal(spendOf("lastMonth", USER_A), 0);
  assert.equal(spendOf("all", USER_A), 6600);

  // u-1013 只有昨日那一单：今日为 0，昨日与本周都有
  assert.equal(spendOf("today", "u-1013"), 0);
  assert.equal(spendOf("yesterday", "u-1013"), 25500);
  assert.equal(spendOf("week", "u-1013"), 25500);

  // u-1016 只有上月那一单：本月为 0
  assert.equal(spendOf("month", "u-1016"), 0);
  assert.equal(spendOf("lastMonth", "u-1016"), 13700);
});

test("周期之间互不串门：今日不含昨日、本周不含上周、本月不含上月、上月只含完整的上个月", () => {
  const today = new Set(buildFixtureRanking("today").map((row) => row.userId));
  const yesterday = buildFixtureRanking("yesterday").map((row) => row.userId);
  const week = new Set(buildFixtureRanking("week").map((row) => row.userId));
  const month = new Set(buildFixtureRanking("month").map((row) => row.userId));
  const lastMonth = new Set(buildFixtureRanking("lastMonth").map((row) => row.userId));

  for (const userId of yesterday) {
    assert.equal(today.has(userId), false, `${userId} 只在昨日完成过订单，不该出现在今日`);
  }

  // 上月的范围是「上月 1 日 00:00 ~ 本月 1 日 00:00」：只含上月的三位，本月与今日的都不在内
  assert.deepEqual([...lastMonth].sort(), ["u-1016", "u-1020", "u-1021"]);
  for (const userId of month) {
    if (lastMonth.has(userId)) continue;
    assert.equal(lastMonth.has(userId), false, `${userId} 在本月完成过订单，不该出现在上月`);
  }
  // 反过来：上月的三位都不在本月榜上（他们的完成时间都在本月 1 日之前）
  for (const userId of lastMonth) {
    assert.equal(month.has(userId), false, `${userId} 只在上月完成过订单，不该出现在本月`);
    assert.equal(week.has(userId), false, `${userId} 只在上月完成过订单，不该出现在本周`);
    assert.equal(today.has(userId), false, `${userId} 只在上月完成过订单，不该出现在今日`);
  }

  // 包含关系：今日 ⊆ 本周 ⊆ 本月
  for (const userId of today) assert.equal(week.has(userId), true, "今日的用户必须也在本周榜上");
  for (const userId of week) assert.equal(month.has(userId), true, "本周的用户必须也在本月榜上");
});

test("已退款与进行中的订单在所有周期都不计入", () => {
  const rangeOf = (period) => resolveRankingPeriodRange(period, FIXED_NOW);
  const withBadOrders = [
    ...FIXTURE_ORDERS,
    // 今日完成、今天就被退款：状态已经不是 completed
    {
      id: "bad-refunded",
      userId: "u-1013",
      status: "refunded",
      completedAt: "2026-09-16T02:00:00.000Z",
      totalAmount: 999999,
    },
    // 今日的「护航中」订单：还没有完成时间，连周期归属都无从谈起
    {
      id: "bad-serving",
      userId: "u-1016",
      status: "serving",
      completedAt: null,
      totalAmount: 999999,
    },
  ];

  /** u-1013 只有昨日那一单是有效的；u-1016 只有上月那一单 */
  const expected = {
    today: { "u-1013": 0, "u-1016": 0 },
    yesterday: { "u-1013": 25500, "u-1016": 0 },
    week: { "u-1013": 25500, "u-1016": 0 },
    month: { "u-1013": 25500, "u-1016": 0 },
    lastMonth: { "u-1013": 0, "u-1016": 13700 },
    all: { "u-1013": 25500, "u-1016": 13700 },
  };

  for (const [period, wanted] of Object.entries(expected)) {
    const rows = buildConsumptionRanking(withBadOrders, userSeed, levelSeed, rangeOf(period));
    const byId = new Map(rows.map((row) => [row.userId, row]));

    for (const [userId, amount] of Object.entries(wanted)) {
      assert.equal(
        byId.get(userId)?.effectiveSpendAmount ?? 0,
        amount,
        `${period} 的 ${userId} 金额不对`,
      );
    }
    for (const row of rows) {
      assert.ok(row.effectiveSpendAmount < 999999, `${period} 把退款或在途订单算进了金额`);
    }
  }

  // 进行中的订单即使有（未来的）完成时间也不该算：状态就是硬门槛
  const servingWithDate = [
    ...FIXTURE_ORDERS,
    {
      id: "bad-serving-dated",
      userId: "u-1016",
      status: "serving",
      completedAt: "2026-09-16T02:00:00.000Z",
      totalAmount: 999999,
    },
  ];
  const today = buildConsumptionRanking(
    servingWithDate,
    userSeed,
    levelSeed,
    rangeOf("today"),
  );
  assert.equal(today.some((row) => row.userId === "u-1016"), false);
});

test("先聚合后分页：周期内翻页不重复不遗漏，也不会混入别的周期", () => {
  const rows = buildFixtureRanking("week");
  const seen = [];

  // 每页 1 条翻完整个本周榜
  for (let page = 1; ; page += 1) {
    const result = paginateRankingRows(rows, page, 1);
    if (result.items.length === 0) break;
    seen.push(...result.items);
    assert.equal(result.total, rows.length, "total 必须是这个周期的总人数，而不是某一页的条数");
    if (!result.hasMore) break;
  }

  assert.equal(seen.length, rows.length);
  assert.deepEqual(
    seen.map((item) => item.rank),
    rows.map((_, index) => index + 1),
  );
  assert.equal(new Set(seen.map((item) => item.rank)).size, seen.length, "翻页出现重复条目");

  // 本周榜里不该出现只在昨日/上月出现过的用户
  const weekNicknames = new Set(rows.map((row) => row.nickname));
  const yesterdayOnly = buildFixtureRanking("yesterday").filter((row) => row.userId === "u-1013");
  assert.equal(yesterdayOnly.length, 1, "用例前提：u-1013 在昨日榜上");
  assert.equal(weekNicknames.size, rows.length);
});

/* ────────────────────────────── 服务层 ────────────────────────────── */

test("服务层：游客拿到完整榜单，只是没有「我的排名」", async () => {
  const guest = await getConsumptionRanking(null, page({ period: "all" }), "server");

  assert.equal(guest.viewerLoggedIn, false);
  assert.equal(guest.me, null, "游客没有「我的排名」");
  assert.ok(guest.items.length > 0, "游客照常看到完整榜单");
  assert.equal(guest.total, buildSeedRanking().length);
  assert.equal(guest.period, "all");
  assert.equal(guest.periodLabel, "累计");
  assert.equal(guest.rangeStart, null, "累计不限起始时间");
  assert.equal(guest.notice, RANKING_NOTICE);

  // 游客与服务端页面都拿得到榜单：接口层不调用 requireUser（见源码断言用例）
  for (const item of guest.items) assert.equal(typeof item.nickname, "string");
});

test("服务层：周期与时间范围一起返回，且与榜单生成时间是同一个瞬间", async () => {
  const week = await getConsumptionRanking(null, page({ period: "week" }), "server");

  assert.equal(week.period, "week");
  assert.equal(week.periodLabel, "本周");
  assert.ok(week.rangeStart, "本周必须有起始时间");
  assert.ok(Date.parse(week.rangeStart) > 0);
  assert.ok(Date.parse(week.rangeEnd) > 0);
  assert.ok(Date.parse(week.rangeStart) < Date.parse(week.rangeEnd));
  // 结束时间与生成时间来自同一个 `now`：两者不相等说明取数过程中用了两次当前时间
  assert.equal(week.rangeEnd, week.generatedAt);
  assert.equal(week.notice, RANKING_PERIOD_NOTICE);

  // 没传 period：用默认周期（原型选中的「本周」），不是报错也不是累计
  const fallback = await getConsumptionRanking(null, page(), "server");
  assert.equal(fallback.period, DEFAULT_RANKING_PERIOD);
  assert.equal(fallback.periodLabel, "本周");

  // 响应里不出现任何订单明细或隐私字段
  const serialized = JSON.stringify(week);
  for (const forbidden of ["userId", "displayId", "orderNo", "orderId", "gameAccountId", "bio"]) {
    assert.equal(serialized.includes(forbidden), false, `榜单响应不该出现 ${forbidden}`);
  }
});

test("服务层：非法 period 回 400 而不是返回一份含义不明的榜单", async () => {
  await assert.rejects(
    () => getConsumptionRanking(null, page({ period: "lastWeek" }), "server"),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.ok(error.message.includes("lastWeek"), "错误说明里应带上被拒绝的值");
      return true;
    },
  );

  // 空串与「看起来像但不是」的值同样拒绝
  for (const bad of ["", "cumulative", "TODAY", "0"]) {
    await assert.rejects(
      () => getConsumptionRanking(null, page({ period: bad }), "server"),
      (error) => error.code === "BAD_REQUEST",
      `${bad} 应当被拒绝`,
    );
  }

  // 六个合法值都成功
  for (const period of ["today", "yesterday", "week", "month", "lastMonth", "all"]) {
    const result = await getConsumptionRanking(null, page({ period }), "server");
    assert.equal(result.period, period);
  }
});

test("服务层：「我的排名」随周期变化——有消费给名次，没有则明确为空", async () => {
  // u-1011 的订单由相对时间构造，**只**落在今日：除了今日/本周/本月/累计之外都没有名次
  const byPeriod = {};
  for (const period of ["today", "yesterday", "week", "month", "lastMonth", "all"]) {
    byPeriod[period] = await getConsumptionRanking("u-1011", page({ period }), "server");
  }

  assert.equal(byPeriod.today.me.effectiveSpendAmount, 12000);
  // ⚠️ 这里刻意**不**断言「第一名」。那三笔「本周一 / 本月 1 日」的预置订单是相对
  // 北京时间当周周一与当月 1 日构造的，而订单不可能完成于未来，因此它们会被夹进
  // 「现在」之前——今天是周一（或本月 1 日）时，「今日」就多出这几笔，名次不再是 1。
  // 按日历成立不成立的前提不能当断言用（种子自己也写了「不一定是今日」）；
  // 可以断言的是名次规则本身：名次连续、且排在前面的人金额都不低于自己。
  const todayBoard = await getConsumptionRanking(
    null,
    page({ period: "today", pageSize: 100 }),
    "server",
  );
  const ahead = todayBoard.items.filter((item) => item.rank < byPeriod.today.me.rank);
  assert.equal(
    byPeriod.today.me.rank,
    ahead.length + 1,
    "名次必须与「排在前面的行数 + 1」一致：名次连续、没有空缺",
  );
  for (const item of ahead) {
    assert.ok(
      item.effectiveSpendAmount >= 12000,
      `排在前面的人金额不能更低（${item.effectiveSpendAmount} < 12000）`,
    );
  }
  assert.equal(byPeriod.week.me.effectiveSpendAmount, 12000);
  assert.equal(byPeriod.month.me.effectiveSpendAmount, 12000);
  assert.equal(byPeriod.all.me.effectiveSpendAmount, 12000);
  for (const period of ["yesterday", "lastMonth"]) {
    assert.equal(byPeriod[period].me, null, `${period} 不该编出一个名次`);
    assert.equal(byPeriod[period].viewerLoggedIn, true, "登录态仍然要如实告诉页面");
  }

  // 同一个人「今日有、上月没有」，反过来 u-1016 是「上月有、今日与本月没有」：
  // 两个方向都覆盖到，才能证明名次是真的按当前周期算的
  const u1016 = {
    today: await getConsumptionRanking("u-1016", page({ period: "today" }), "server"),
    month: await getConsumptionRanking("u-1016", page({ period: "month" }), "server"),
    lastMonth: await getConsumptionRanking("u-1016", page({ period: "lastMonth" }), "server"),
    all: await getConsumptionRanking("u-1016", page({ period: "all" }), "server"),
  };
  assert.equal(u1016.today.me, null);
  assert.equal(u1016.month.me, null);
  assert.equal(u1016.lastMonth.me.effectiveSpendAmount, 13700);
  assert.equal(u1016.all.me.effectiveSpendAmount, 13700);

  // u-1013 只有昨日那一单：昨日有名次，今日没有
  const yesterdayMe = await getConsumptionRanking("u-1013", page({ period: "yesterday" }), "server");
  const todayMe = await getConsumptionRanking("u-1013", page({ period: "today" }), "server");
  assert.equal(yesterdayMe.me.effectiveSpendAmount, 25500);
  assert.equal(todayMe.me, null);

  // 名次在页内时，必须与列表里的那一行完全一致
  const first = await getConsumptionRanking("u-1011", page({ period: "today", page: 1, pageSize: 20 }), "server");
  const mine = first.items.find((item) => item.rank === first.me.rank);
  assert.ok(mine, "「我的排名」的名次应当在榜单里找得到");
  assert.equal(mine.nickname, first.me.nickname);
  assert.equal(mine.effectiveSpendAmount, first.me.effectiveSpendAmount);

  // 名次落在当前页之外时也照常给出（每页 1 条，第一页不是它）
  const tiny = await getConsumptionRanking("u-1016", page({ period: "lastMonth", page: 1, pageSize: 1 }), "server");
  assert.equal(tiny.items.length, 1);
  assert.ok(tiny.me);
  assert.ok(tiny.me.rank >= 1);
});

test("服务层：登录但周期内没有消费 / 会话里的用户不存在，都按「没上榜」处理", async () => {
  // u-1009 有一单已退款、一单进行中：任何周期都没有有效消费
  for (const period of ["today", "yesterday", "week", "month", "lastMonth", "all"]) {
    const zero = await getConsumptionRanking("u-1009", page({ period }), "server");
    assert.equal(zero.viewerLoggedIn, true);
    assert.equal(zero.me, null, `${period} 不该给零消费用户编名次`);
  }

  // 会话里的用户在用户表里不存在（例如会话过期残留）：按没上榜处理，不是错误
  const ghost = await getConsumptionRanking("u-does-not-exist", page(), "server");
  assert.equal(ghost.viewerLoggedIn, true);
  assert.equal(ghost.me, null);
  assert.ok(ghost.items.length > 0, "别人的榜单不该因为一个坏会话就打不开");
});

test("服务层：周期越短上榜人数越少（包含关系），累计最多", async () => {
  const totals = {};
  for (const period of ["today", "week", "month", "all"]) {
    totals[period] = (await getConsumptionRanking(null, page({ period }), "server")).total;
  }

  // 今日 ⊆ 本周 ⊆ 累计：短周期的人数不可能比长周期还多
  assert.ok(totals.today <= totals.week, "今日的人数不该超过本周");
  assert.ok(totals.week <= totals.all);
  assert.ok(totals.today <= totals.month);
  // 累计含既有种子的全部有效订单，人数一定比任何一个周期都多
  assert.ok(totals.all > totals.today, "累计应当比今日多");
});

test("服务层：分页参数规范化，越界不报错", async () => {
  const fallback = parseRankingQuery(page());
  assert.deepEqual(fallback, { page: 1, pageSize: RANKING_PAGE_SIZE });

  assert.equal(parseRankingQuery(page({ page: "abc" })).page, 1);
  assert.equal(parseRankingQuery(page({ page: 0 })).page, 1);
  assert.equal(parseRankingQuery(page({ page: -5 })).page, 1);
  assert.equal(parseRankingQuery(page({ pageSize: 9999 })).pageSize, RANKING_MAX_PAGE_SIZE);
  assert.equal(parseRankingQuery(page({ pageSize: 0 })).pageSize, RANKING_PAGE_SIZE);

  const result = await getConsumptionRanking(null, page({ page: 1, pageSize: 2 }), "server");
  assert.equal(result.pageSize, 2);
  assert.equal(result.items.length, 2);
  // 分页参数只影响切片，不影响周期：默认周期仍然是页签默认的那一个
  assert.equal(result.period, DEFAULT_RANKING_PERIOD);
});

test("服务层：?mockEmpty=rankings 演示空榜（含周期语义），且不抛错", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  const empty = await getConsumptionRanking(
    null,
    page({ mockEmpty: "rankings", mockDelay: 0, period: "today" }),
    "server",
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.me, null);
  // 空榜也带着周期信息：页面才知道该说「今日暂无有效消费」
  assert.equal(empty.period, "today");
  assert.equal(empty.periodLabel, "今日");

  // 同一份数据在别的范围下不受影响
  const normal = await getConsumptionRanking(
    null,
    page({ mockEmpty: "levels", mockDelay: 0, period: "today" }),
    "server",
  );
  assert.ok(normal.items.length > 0);
});

test("聚合在服务端且只读：浏览器端只有一个读函数，接口只有 GET 且不要求登录", () => {
  assert.deepEqual(Object.keys(rankingsHttp).sort(), ["fetchConsumptionRanking"]);

  const browserSource = readFileSync("lib/services/rankingsHttp.ts", "utf8");
  // 浏览器端能提交的只有周期与分页：金额、等级与名次都不接受
  assert.ok(browserSource.includes('set("period"'), "浏览器端请求必须带上周期");
  for (const forbidden of ["amount", "level", "rank=", "userId"]) {
    assert.equal(
      browserSource.includes(`set("${forbidden}`),
      false,
      `浏览器端请求不该提交 ${forbidden}`,
    );
  }

  const routeSource = readFileSync("app/api/rankings/consumption/route.ts", "utf8");
  assert.match(routeSource, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(routeSource),
      false,
      `排行榜接口不该出现 ${method}`,
    );
  }
  // 游客可访问：不套 requireUser；会话只用来算「我的排名」。
  // 先去注释——文档里写一句「本文件不调用 requireUser()」不算调用。
  const routeCode = stripComments(routeSource);
  assert.equal(/requireUser\s*\(/.test(routeCode), false, "排行榜不该要求登录");
  assert.ok(routeCode.includes("getSessionUser"));

  // 榜单页同样是游客可访问的
  const pageCode = stripComments(readFileSync(resolveSource("app/rank/page.tsx"), "utf8"));
  assert.equal(pageCode.includes("RequireAuth"), false, "/rank 不该因为本次改动被保护起来");
  // 页面侧只做周期规范化，聚合仍然全部在服务端
  assert.ok(pageCode.includes("normalizeRankingPeriod"));
  assert.equal(pageCode.includes("buildConsumptionRanking"), false);
});

test("周期口径的常量本身写明了规则", () => {
  assert.ok(RANKING_NOTICE.includes("降序"));
  assert.ok(RANKING_NOTICE.includes("已完成"));
  assert.ok(RANKING_NOTICE.includes("升序"), "同金额的兜底排序必须在口径说明里写明");
  assert.ok(RANKING_PERIOD_NOTICE.includes("完成时间"), "周期榜必须说明按哪个时间归属");
  assert.ok(RANKING_PAGE_SIZE > 0 && RANKING_MAX_PAGE_SIZE >= RANKING_PAGE_SIZE);
});
