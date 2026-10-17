import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";

import {
  BOSS_COMPANION_NOTICE,
  BOSS_GAME_NOTICE,
  BOSS_LIST_EMPTY_MESSAGE,
  BOSS_SPEND_NOTICE,
  BOSS_STATS_TOP_N,
  buildBossStatsSummary,
  buildCompanionUsage,
  buildGameUsage,
  formatUsageCount,
  sumSpendWithinRange,
} from "../lib/constants/bossStats.ts";
import {
  CONSUMPTION_CALCULATION_NOTICE,
  countEffectiveOrders,
  countLifetimeOrders,
  effectiveSpendOf,
  sumEffectiveSpend,
} from "../lib/constants/levels.ts";
import {
  RECENT_30D_DAYS,
  beijingDayStart,
  isWithinRankingPeriod,
  recent30DayRange,
} from "../lib/constants/rankingPeriods.ts";
import {
  appendCompanionService,
  deriveLegacyServiceEvents,
  mockCompanionServiceRepository,
} from "../lib/data/mockCompanionServiceRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { setMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { getBossStatsForUser } from "../lib/services/bossStats.ts";
import { resolveSource } from "./app-path.mjs";
import { readSource, stripComments } from "./source-text.mjs";

/**
 * P1-7「老板数据面板 + 消费累计口径统一」的持续测试。
 *
 * ## 这一批真正要钉住的三件事
 *
 * 1. **「钱」与「行为历史」是两条独立的规则**（总规则 `R1`）。
 *    退款**实时**改金额（净额 `max(0, 实付 − 已退)`），但**不抹掉**「我曾经下过这一单 /
 *    玩过这个游戏 / 这位打手服务过我」。这两条规则方向相反，因此本文件里
 *    「全额退款」这个场景会**同时**断言「金额为 0」与「计数仍为 1」——
 *    只测其中一边，就正好漏掉另一边的静默回退。
 * 2. **金额口径只有一份**（总规则 `R2`）。面板不得自己写第二份减法：
 *    本文件末尾有一条源码扫描，断言 `lib/constants/bossStats.ts` 与
 *    `lib/services/bossStats.ts` 在**去掉注释后**不出现 `refundedAmount` 标识符。
 *    改动若在那里塞进一份自己的减法，这条会立刻红。
 * 3. **「最近 30 天」是 UTC+8 自然日窗口，不是滚动 30×24h**（产品裁定 `D2`）。
 *    因此边界用例钉的是「北京时间 00:00 分界」，而不是「now − 720 小时」。
 *
 * ## 为什么大部分用例不碰 HTTP
 *
 * 口径函数（`lib/constants/bossStats.ts`）是纯的，且 node 能直接加载 `.ts`。
 * 把口径测在纯逻辑层、只在文件末尾用 HTTP 钉住「接口只读会话、DTO 键固定」，
 * 失败时才知道是**算错了**还是**传错了**——混在一条用例里两个都可能。
 */

/* ────────────────────────────── 造数据 ────────────────────────────── */

/**
 * 造一条订单。
 *
 * 只填聚合真正读的字段——但**填全**：`countLifetimeOrders` 读 `id`，金额口径读
 * `status` / `actualPaidAmount` / `refundedAmount`，30 天窗口与常玩游戏读
 * `completedAt` / `gameName`。少写一个字段就会让对应用例变成「函数没读到所以通过」。
 */
function order(id, status, options = {}) {
  const { totalAmount, couponDiscountAmount = 0, actualPaidAmount, refundedAmount = 0, completedAt = null, gameName = "三角洲行动", userId = "u-x" } = options;
  const paid = actualPaidAmount ?? (totalAmount ?? 0) - couponDiscountAmount;
  return {
    id,
    userId,
    status,
    totalAmount: totalAmount ?? paid + couponDiscountAmount,
    couponDiscountAmount,
    actualPaidAmount: paid,
    refundedAmount,
    completedAt,
    gameName,
  };
}

/** 造一条服务历史（真事件与存量派生都满足这个形状）。 */
function service(orderId, companionId, servingAt, name = "打手", avatarUrl = "/mock/avatar.svg") {
  return { orderId, companionId, servingAt, companionName: name, companionAvatarUrl: avatarUrl };
}

/** 北京时间某个时刻的 ISO 串，写成 `2026-10-01 12:00 +08:00` 便于核对边界。 */
function beijing(time) {
  return new Date(`${time}+08:00`).toISOString();
}

/** 本文件所有时间断言共用的「现在」：2026-10-01 12:00（北京时间）。 */
const NOW = new Date("2026-10-01T12:00:00+08:00");

beforeEach(() => {
  // ⚠️ **必须在 `resetMockStore` 之前**把基准时间钉成本文件的 `NOW`：
  // 预置订单里有一批是**相对基准时间**构造的（`buildRankingPeriodOrders`），其中
  // u-1001 的「今日」那一单会落在**真实当天**。不钉的话，「预置数据下最近 30 天消费」
  // 就随执行日历变化——§八 那条断言（14780）写完当天绿，跨过 `NOW` 那一刻起必红，
  // 而红的原因与业务规则无关（与 CRLF 假失败同源：测试的时钟与数据的时钟不同源）。
  // 钉住之后订单数据与断言同源：同一份数据、同一个窗口，结果不随日期漂移。
  setMockSeedNow(NOW);

  // 进程内的存储：每个用例从预置数据重新出发
  resetMockStore("payment");
  resetMockStore("companionService");
});

/* ══════════════════════════ 一、空数据与 DTO 形状 ══════════════════════════ */

test("空数据：数值指标给 0、榜单给空数组，不返回 NaN、也不隐藏整块", () => {
  const summary = buildBossStatsSummary([], [], NOW);

  assert.deepEqual(Object.keys(summary).sort(), [
    "companionNotice",
    "gameNotice",
    "orderCount",
    "recent30dSpendAmount",
    "recentCompanions",
    "recentGames",
    "spendNotice",
    "totalSpendAmount",
  ]);

  // 产品裁定 D12：数值指标无数据时是 0（不是 null / 不是 "—"）
  assert.equal(summary.orderCount, 0);
  assert.equal(summary.totalSpendAmount, 0);
  assert.equal(summary.recent30dSpendAmount, 0);
  assert.equal(Number.isInteger(summary.totalSpendAmount), true);
  assert.equal(Number.isNaN(summary.totalSpendAmount), false);

  // 列表指标无数据时是空数组——空列表的**展示文案**由页面决定，口径层不塞占位行
  assert.deepEqual(summary.recentGames, []);
  assert.deepEqual(summary.recentCompanions, []);
});

test("空列表文案是「暂无数据」，不是 —（D12）", () => {
  assert.equal(BOSS_LIST_EMPTY_MESSAGE, "暂无数据");
  assert.notEqual(BOSS_LIST_EMPTY_MESSAGE, "—");
  // 次数指标的写法单独成函数：Top 榜行里的「12 单」不允许各处自己拼
  assert.equal(formatUsageCount(12), "12 单");
  assert.equal(formatUsageCount(1), "1 单");
  assert.equal(formatUsageCount(0), "0 单");
});

test("三个口径说明与消费等级页的说明不冲突（都要求原样展示）", () => {
  for (const notice of [BOSS_SPEND_NOTICE, BOSS_GAME_NOTICE, BOSS_COMPANION_NOTICE]) {
    assert.equal(typeof notice, "string");
    assert.ok(notice.length > 0, "口径说明不能是空串");
  }
  // 金额口径必须写明「已完成」「退款后净额」，否则用户会自己脑补成「下单就算」
  assert.ok(BOSS_SPEND_NOTICE.includes("已完成"));
  assert.ok(BOSS_SPEND_NOTICE.includes("退还"));
  // 打手口径必须写明「真实开始服务」这一判据（D7）
  assert.ok(BOSS_COMPANION_NOTICE.includes("开始服务"));
  // 与消费等级页的说明是**两份文案**（一个讲等级、一个讲面板），但都不许出现旧口径
  assert.equal(CONSUMPTION_CALCULATION_NOTICE.includes("且未退款"), false);
  assert.equal(BOSS_SPEND_NOTICE.includes("且未退款"), false);
});

/* ══════════════════════════ 二、累计订单数（D1） ══════════════════════════ */

/*
 * ⚠️ 这一节直接测的是 **`lib/constants/levels.ts` 的 `countLifetimeOrders()`**，
 * 也就是**全仓唯一**的那份实现（`lib/constants/bossStats.ts` 的汇总调用它）。
 * 这很重要：它曾经在 `bossStats.ts` 里另有一份逐字相同的副本，两份都在时
 * 「改了一处、面板不动」是一个**不会红**的静默回退。因此这里断言两件事：
 * 口径函数本身的行为，以及面板的 `orderCount` **确实来自它**。
 */

test("累计订单数：paid / accepted / serving / completed / refunded 各计 1，退款不减少（D1）", () => {
  const orders = [
    order("o1", "paid"),
    order("o2", "accepted"),
    order("o3", "serving"),
    order("o4", "completed"),
    // 全额退款：金额归 0，但「我曾经下过这一单」是历史事实（R1）
    order("o5", "refunded", { actualPaidAmount: 10000, refundedAmount: 10000 }),
  ];

  assert.equal(countLifetimeOrders(orders), 5);
  // 面板读的就是这一个函数：口径改了面板必须跟着动（防「两份实现」回退）
  assert.equal(buildBossStatsSummary(orders, [], NOW).orderCount, countLifetimeOrders(orders));
  assert.equal(buildBossStatsSummary(orders, [], NOW).orderCount, 5);

  // 与「有效消费订单数」是两个不同的数：这张全额退款单不计消费、但计订单
  assert.equal(sumEffectiveSpend(orders), 0);
  // 同一条数据上，「历史总量」与「参与消费统计的有效量」必须**不相等**——
  // 5 单里只有 o4 是 completed，若哪天有人把它们合并成一份实现，这条会红
  assert.equal(countEffectiveOrders(orders), 1);
  assert.notEqual(countLifetimeOrders(orders), countEffectiveOrders(orders));
});

test("累计订单数：同一订单重复出现只算一次，且不看金额是否有限", () => {
  const duplicated = [order("o1", "paid"), order("o1", "paid")];
  assert.equal(countLifetimeOrders(duplicated), 1);

  // 金额读不出来的脏数据仍然算「下过这一单」：订单能被创建出来就意味着付过款
  const broken = [order("o2", "completed", { actualPaidAmount: Number.NaN })];
  assert.equal(countLifetimeOrders(broken), 1);
  // 而金额侧必须当 0，不能算出 NaN 污染整块面板
  assert.equal(buildBossStatsSummary(broken, [], NOW).totalSpendAmount, 0);
});

/* ══════════════════════════ 三、累计消费金额（F1 / R1 / R2） ══════════════════════════ */

test("累计消费：只看 completed，进行中与未接单的一分都不算", () => {
  const orders = [
    order("o1", "paid", { actualPaidAmount: 2000 }),
    order("o2", "accepted", { actualPaidAmount: 3000 }),
    order("o3", "serving", { actualPaidAmount: 4000 }),
    order("o4", "completed", { actualPaidAmount: 1000 }),
  ];

  assert.equal(buildBossStatsSummary(orders, [], NOW).totalSpendAmount, 1000);
});

test("累计消费：部分退款按净额计入，退款实时改金额（F1 / R1）", () => {
  const before = order("o1", "completed", { actualPaidAmount: 10000, refundedAmount: 0 });
  const after = order("o1", "completed", { actualPaidAmount: 10000, refundedAmount: 3000 });

  assert.equal(buildBossStatsSummary([before], [], NOW).totalSpendAmount, 10000);
  assert.equal(buildBossStatsSummary([after], [], NOW).totalSpendAmount, 7000);

  // 订单数不受退款影响（D1）：钱变了，历史没变
  assert.equal(buildBossStatsSummary([after], [], NOW).orderCount, 1);
});

test("累计消费：全额退款订单金额为 0，不会变成负数", () => {
  // refundedAmount >= actualPaidAmount 在真实路径上必然成立（applyOrderRefund 的判据），
  // 但口径函数**不信任调用方**：即使数据把已退写得比实付还多，也只能夹到 0
  const over = order("o1", "refunded", { actualPaidAmount: 10000, refundedAmount: 12000 });
  assert.equal(effectiveSpendOf(over), 0);
  assert.equal(buildBossStatsSummary([over], [], NOW).totalSpendAmount, 0);
});

test("累计消费：优惠券订单按实付计入，不按优惠前应付", () => {
  // 原价 100 元、满减券抵 10 元 → 实付 90 元。两个数必须**不相等**，否则测不出读错字段
  const withCoupon = order("o1", "completed", { totalAmount: 10000, couponDiscountAmount: 1000 });
  assert.equal(withCoupon.totalAmount, 10000);
  assert.equal(withCoupon.actualPaidAmount, 9000);

  assert.equal(buildBossStatsSummary([withCoupon], [], NOW).totalSpendAmount, 9000);

  // 全额抵扣（实付 0）的已完成订单：金额 0，但它仍是一笔订单、也仍算「玩过这个游戏」
  const fullyDiscounted = order("o2", "completed", {
    totalAmount: 10000,
    couponDiscountAmount: 10000,
    completedAt: beijing("2026-09-25 10:00:00.000"),
    gameName: "无畏契约",
  });
  const summary = buildBossStatsSummary([fullyDiscounted], [], NOW);
  assert.equal(summary.totalSpendAmount, 0);
  assert.equal(summary.orderCount, 1);
  assert.deepEqual(summary.recentGames, [{ name: "无畏契约", orderCount: 1 }]);
});

test("金额口径只有一份：面板自己的两个文件都不出现 refundedAmount（R2）", () => {
  // 断言的正是「没有第二份减法」这件事：一旦有人在面板侧自己写
  // `actualPaidAmount - refundedAmount`，这两个文件里就会冒出 refundedAmount
  for (const file of ["lib/constants/bossStats.ts", "lib/services/bossStats.ts"]) {
    const code = stripComments(readSource(resolveSource(file)));
    assert.equal(
      code.includes("refundedAmount"),
      false,
      `${file} 不得自己读退款字段——金额必须经 effectiveSpendOf / sumEffectiveSpend`,
    );
  }
});

/* ══════════════════════════ 四、最近 30 天消费（D2 / D3 / D4） ══════════════════════════ */

test("最近 30 天：UTC+8 自然日窗口，含今天共 30 天（D2）", () => {
  assert.equal(RECENT_30D_DAYS, 30);

  const range = recent30DayRange(NOW);
  // 今天 10-01 ⇒ 起点 09-02 00:00 (+08:00)，终点是「现在」
  assert.equal(new Date(range.start).toISOString(), "2026-09-01T16:00:00.000Z");
  assert.equal(range.start, beijingDayStart(NOW, -29));
  assert.equal(range.end, NOW.getTime());

  // ⚠️ 若有人把它写成「now − 30×24h」，起点会落在 09-01 12:00 而不是 09-02 00:00
  assert.notEqual(range.start, NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(range.start, Date.parse("2026-09-02T00:00:00+08:00"));
});

test("最近 30 天：北京时间 00:00 含、前一天 23:59:59.999 不含（30 天边界）", () => {
  const range = recent30DayRange(NOW);

  const onBoundary = beijing("2026-09-02 00:00:00.000");
  const justBefore = beijing("2026-09-01 23:59:59.999");

  assert.equal(isWithinRankingPeriod(onBoundary, range), true, "边界当天 00:00 必须计入");
  assert.equal(isWithinRankingPeriod(justBefore, range), false, "前一天 23:59:59.999 不该计入");

  // 时刻相同的两张单，只有窗口内的那张进金额：边界是**可断言**的，不是「大概」
  const summary = buildBossStatsSummary(
    [
      order("in", "completed", { actualPaidAmount: 1000, completedAt: onBoundary }),
      order("out", "completed", { actualPaidAmount: 9999, completedAt: justBefore }),
    ],
    [],
    NOW,
  );
  assert.equal(summary.recent30dSpendAmount, 1000);
  assert.equal(summary.totalSpendAmount, 10999, "窗口外的单仍然计入累计");
});

test("最近 30 天：UTC+8 与 UTC 的分界不同——UTC 的最后一天在窗口外（UTC+8 边界）", () => {
  const range = recent30DayRange(NOW);

  // 边界本身在 UTC 里是 09-01T16:00Z（= 北京 09-02 00:00）。
  // 再往前 1 毫秒在北京仍是 09-01，必须排除；若实现按 UTC 自然日切，这条会翻。
  assert.equal(isWithinRankingPeriod("2026-09-01T15:59:59.999Z", range), false);
  assert.equal(isWithinRankingPeriod("2026-09-01T16:00:00.000Z", range), true);
});

test("最近 30 天：窗口只看完成时间，窗口外订单今天的退款不会变成负数（D4 示例 1）", () => {
  // 40 天前完成、今天全额退款：窗口贡献恒为 0，不会冒出 -100
  const completedAt = beijing("2026-08-22 10:00:00.000");
  assert.equal(isWithinRankingPeriod(completedAt, recent30DayRange(NOW)), false);

  const before = order("o1", "completed", { actualPaidAmount: 10000, completedAt });
  const after = order("o1", "refunded", { actualPaidAmount: 10000, refundedAmount: 10000, completedAt });

  const s1 = buildBossStatsSummary([before], [], NOW);
  const s2 = buildBossStatsSummary([after], [], NOW);

  assert.equal(s1.recent30dSpendAmount, 0);
  assert.equal(s2.recent30dSpendAmount, 0, "窗口外的订单退款后仍然是 0，不是 -10000");
  assert.equal(s2.totalSpendAmount, 0, "累计侧同样归 0");
  assert.equal(s2.orderCount, 1, "但订单数与玩法记录仍在（R1）");
});

test("最近 30 天：窗口内订单的退款实时反映为净额（D4 示例 2）", () => {
  // 5 天前完成 100 元，今天退 30 元
  const completedAt = beijing("2026-09-26 11:00:00.000");

  const before = order("o1", "completed", { actualPaidAmount: 10000, completedAt });
  const after = order("o1", "completed", { actualPaidAmount: 10000, refundedAmount: 3000, completedAt });

  assert.equal(buildBossStatsSummary([before], [], NOW).recent30dSpendAmount, 10000);
  assert.equal(buildBossStatsSummary([after], [], NOW).recent30dSpendAmount, 7000);
});

test("不变量：最近 30 天消费永远不会大于累计消费（两者同一份公式，只是窗口不同）", () => {
  const orders = [
    order("o1", "completed", { actualPaidAmount: 10000, completedAt: beijing("2026-09-26 11:00:00.000") }),
    order("o2", "completed", { actualPaidAmount: 5000, completedAt: beijing("2026-01-01 11:00:00.000") }),
    order("o3", "completed", { actualPaidAmount: 8000, refundedAmount: 2000, completedAt: beijing("2026-09-30 09:00:00.000") }),
  ];

  const summary = buildBossStatsSummary(orders, [], NOW);
  assert.equal(summary.totalSpendAmount, 10000 + 5000 + 6000);
  assert.equal(summary.recent30dSpendAmount, 10000 + 6000);
  assert.ok(summary.recent30dSpendAmount <= summary.totalSpendAmount);

  // 直接对纯函数再钉一次：窗口外的订单永远贡献 0
  assert.equal(sumSpendWithinRange([orders[1]], recent30DayRange(NOW)), 0);
});

/* ══════════════════════════ 五、常玩游戏（D5 / D6） ══════════════════════════ */

test("常玩游戏：按订单上的 gameName 快照归组，只 trim、不合并别名（D5）", () => {
  const orders = [
    order("o1", "completed", { completedAt: beijing("2026-09-10 10:00:00.000"), gameName: "英雄联盟" }),
    order("o2", "completed", { completedAt: beijing("2026-09-11 10:00:00.000"), gameName: " 英雄联盟 " }),
    // ⚠️ 名字不同就是不同游戏：不做模糊匹配、不按目录 productId 重新解释历史
    order("o3", "completed", { completedAt: beijing("2026-09-12 10:00:00.000"), gameName: "英雄联盟手游" }),
  ];

  assert.deepEqual(buildGameUsage(orders), [
    { name: "英雄联盟", orderCount: 2 },
    { name: "英雄联盟手游", orderCount: 1 },
  ]);
});

test("常玩游戏：只算真正完成过的单，退款不删除已发生的记录（D6 / R1）", () => {
  const orders = [
    // 完成过、后来全额退款：completedAt 还在（applyOrderRefund 只改状态与退款金额）
    order("o1", "refunded", { actualPaidAmount: 10000, refundedAmount: 10000, completedAt: beijing("2026-09-10 10:00:00.000"), gameName: "无畏契约" }),
    // 从未完成：不进榜
    order("o2", "serving", { completedAt: null, gameName: "无畏契约" }),
    order("o3", "paid", { completedAt: null, gameName: "无畏契约" }),
  ];

  assert.deepEqual(buildGameUsage(orders), [{ name: "无畏契约", orderCount: 1 }]);

  const summary = buildBossStatsSummary(orders, [], NOW);
  assert.equal(summary.totalSpendAmount, 0, "钱归 0");
  assert.equal(summary.recentGames[0].orderCount, 1, "行为历史不归 0");
});

test("常玩游戏：并列时按最近完成时间、再按名称排出稳定顺序（D6）", () => {
  const orders = [
    order("o1", "completed", { completedAt: beijing("2026-09-10 10:00:00.000"), gameName: "B游戏" }),
    order("o2", "completed", { completedAt: beijing("2026-09-20 10:00:00.000"), gameName: "B游戏" }),
    order("o3", "completed", { completedAt: beijing("2026-09-15 10:00:00.000"), gameName: "A游戏" }),
    order("o4", "completed", { completedAt: beijing("2026-09-25 10:00:00.000"), gameName: "A游戏" }),
    order("o5", "completed", { completedAt: beijing("2026-09-18 10:00:00.000"), gameName: "C游戏" }),
    order("o6", "completed", { completedAt: beijing("2026-09-19 10:00:00.000"), gameName: "C游戏" }),
  ];

  // 三者都是 2 单 → 比「最近一次完成时间」降序：A(09-25) > B(09-20) > C(09-19)
  assert.deepEqual(buildGameUsage(orders), [
    { name: "A游戏", orderCount: 2 },
    { name: "B游戏", orderCount: 2 },
    { name: "C游戏", orderCount: 2 },
  ]);

  // 最近完成时间也一样时，按名称升序——顺序必须**确定**，不能随遍历顺序漂移。
  // ⚠️ 这里比的是**码位序**（`<`），不是拼音/`localeCompare`：它是一条稳定性保证，
  // 不是「按中文读音排」的承诺（`D6` 只要求 `gameName` 升序，没指定排序规则）。
  // 用 `localeCompare` 会把结果绑到运行环境的 ICU 版本上——那才是真正的不确定。
  const tied = [
    order("t1", "completed", { completedAt: beijing("2026-09-20 10:00:00.000"), gameName: "B" }),
    order("t2", "completed", { completedAt: beijing("2026-09-20 10:00:00.000"), gameName: "A" }),
  ];
  assert.deepEqual(buildGameUsage(tied).map((g) => g.name), ["A", "B"]);
  // 输入顺序反过来，结果必须一样——「稳定」指的是这个
  assert.deepEqual(buildGameUsage([...tied].reverse()).map((g) => g.name), ["A", "B"]);
});

test("常玩游戏：Top3 截断，空名字不成行（D6）", () => {
  const orders = [];
  for (let i = 0; i < 5; i += 1) {
    // 「游戏 i」被完成 (5 − i) 次，因此排序应为 游戏0 > 游戏1 > 游戏2 > …
    for (let n = 0; n < 5 - i; n += 1) {
      orders.push(order(`o${i}-${n}`, "completed", { completedAt: beijing("2026-09-10 10:00:00.000"), gameName: `游戏${i}` }));
    }
  }

  const top = buildGameUsage(orders);
  assert.equal(BOSS_STATS_TOP_N, 3);
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((g) => g.name), ["游戏0", "游戏1", "游戏2"]);

  // 空 / 全空白名字：数据缺陷，不编「未知游戏」占位
  const blank = [
    order("b1", "completed", { completedAt: beijing("2026-09-10 10:00:00.000"), gameName: "   " }),
    order("b2", "completed", { completedAt: beijing("2026-09-10 10:00:00.000"), gameName: "" }),
  ];
  assert.deepEqual(buildGameUsage(blank), []);
});

/* ══════════════════════════ 六、常用打手（D7 / D8 / D9） ══════════════════════════ */

test("常用打手：只接过单、从未开始服务的打手不计入（D7）", () => {
  const orders = [
    order("o1", "accepted", { completedAt: null }),
    order("o2", "paid", { completedAt: null }),
  ];

  // accepted → cancel / release 只留下接单事件，没有服务事件
  assert.deepEqual(buildCompanionUsage(orders, []), []);
  assert.deepEqual(buildBossStatsSummary(orders, [], NOW).recentCompanions, []);
});

test("常用打手：一单换人，A 与 B 各记一次服务（D7 / D10 第 9 条）", () => {
  const orders = [order("o1", "completed", { completedAt: beijing("2026-09-20 10:00:00.000") })];
  const events = [
    service("o1", "cp-a", beijing("2026-09-18 10:00:00.000"), "小A"),
    // Staff replace 之后新打手真实开始服务 → 新的独立记录，旧记录不删
    service("o1", "cp-b", beijing("2026-09-19 10:00:00.000"), "小B"),
  ];

  assert.deepEqual(
    buildCompanionUsage(orders, events).map((c) => [c.companionId, c.serviceCount]),
    [
      ["cp-b", 1],
      ["cp-a", 1],
    ],
  );
});

test("常用打手：退款 / 换人 / 封禁都不减少已发生的服务次数（D8 补充 / R1）", () => {
  const orders = [
    // 服务过、后来全额退款
    order("o1", "refunded", { actualPaidAmount: 10000, refundedAmount: 10000, completedAt: beijing("2026-09-20 10:00:00.000") }),
  ];
  const events = [service("o1", "cp-a", beijing("2026-09-18 10:00:00.000"), "小A")];

  const companions = buildCompanionUsage(orders, events);
  assert.equal(companions.length, 1);
  assert.equal(companions[0].serviceCount, 1);
});

test("常用打手：按服务次数、再按最近服务时间、再按 id 排出稳定顺序（D8）", () => {
  const orders = [
    order("o1", "completed", { completedAt: beijing("2026-09-20 10:00:00.000") }),
    order("o2", "completed", { completedAt: beijing("2026-09-21 10:00:00.000") }),
    order("o3", "completed", { completedAt: beijing("2026-09-22 10:00:00.000") }),
  ];
  const events = [
    service("o1", "cp-a", beijing("2026-09-18 10:00:00.000"), "小A"),
    service("o2", "cp-a", beijing("2026-09-19 10:00:00.000"), "小A"),
    service("o1", "cp-b", beijing("2026-09-17 10:00:00.000"), "小B"),
    service("o3", "cp-c", beijing("2026-09-16 10:00:00.000"), "小C"),
  ];

  assert.deepEqual(
    buildCompanionUsage(orders, events).map((c) => [c.companionId, c.serviceCount]),
    [
      ["cp-a", 2],
      ["cp-b", 1],
      ["cp-c", 1],
    ],
  );

  // 次数与最近时间都相同 → companionId 升序（稳定键，不随遍历顺序漂移）
  const tied = [
    service("o1", "cp-z", beijing("2026-09-18 10:00:00.000"), "小Z"),
    service("o2", "cp-y", beijing("2026-09-18 10:00:00.000"), "小Y"),
  ];
  assert.deepEqual(buildCompanionUsage(orders, tied).map((c) => c.companionId), ["cp-y", "cp-z"]);
});

test("常用打手：超过 3 位打手时截断到 Top3，且截断处仍按三级排序（D8）", () => {
  // ⚠️ 这条用例的价值在**截断路径本身**：其余用例的夹具都恰好 ≤ 3 位打手，
  // 于是 `slice(0, topN)` 那一步从来没被执行过——写错（少 slice / 排序比较器接错）
  // 不会有任何测试变红。这里刻意造 5 位，且**在截断边界上制造并列**：
  // cp-b / cp-c / cp-d 都是 2 次，只有前两位能进榜，第三名的取舍完全由第二级
  // （最近服务时间）决定，最后一级（id 升序）留给完全并列的情况。
  const orders = ["o1", "o2", "o3", "o4", "o5"].map((id) =>
    order(id, "completed", { completedAt: beijing("2026-09-25 10:00:00.000") }),
  );
  const events = [
    // cp-a：3 次，稳居第一
    service("o1", "cp-a", beijing("2026-09-10 10:00:00.000"), "小A"),
    service("o2", "cp-a", beijing("2026-09-11 10:00:00.000"), "小A"),
    service("o3", "cp-a", beijing("2026-09-12 10:00:00.000"), "小A"),
    // cp-b / cp-c / cp-d：各 2 次，靠最近服务时间排次序（b 最新 → d 最旧）
    service("o1", "cp-b", beijing("2026-09-13 10:00:00.000"), "小B"),
    service("o4", "cp-b", beijing("2026-09-20 10:00:00.000"), "小B"),
    service("o1", "cp-c", beijing("2026-09-14 10:00:00.000"), "小C"),
    service("o5", "cp-c", beijing("2026-09-19 10:00:00.000"), "小C"),
    service("o2", "cp-d", beijing("2026-09-15 10:00:00.000"), "小D"),
    service("o4", "cp-d", beijing("2026-09-18 10:00:00.000"), "小D"),
    // cp-e：1 次，必然落榜
    service("o3", "cp-e", beijing("2026-09-22 10:00:00.000"), "小E"),
  ];

  const rows = buildCompanionUsage(orders, events);
  assert.equal(rows.length, 3, "5 位打手必须截到 3 位");
  assert.deepEqual(
    rows.map((c) => [c.companionId, c.serviceCount]),
    [
      ["cp-a", 3],
      ["cp-b", 2],
      ["cp-c", 2],
    ],
    "第三名由「最近服务时间」决定：cp-b(09-20) > cp-c(09-19) > cp-d(09-18)，cp-d 落榜",
  );

  // 稳定键不是可选的：同一份数据换个遍历顺序必须排出**完全一样**的结果，
  // 否则名次会随仓储的迭代顺序漂移
  assert.deepEqual(buildCompanionUsage(orders, [...events].reverse()), rows);

  // 截断是参数化的，不是写死的 3：验收与将来放宽 Top N 都靠它
  assert.deepEqual(
    buildCompanionUsage(orders, events, 5).map((c) => c.companionId),
    ["cp-a", "cp-b", "cp-c", "cp-d", "cp-e"],
  );
  assert.deepEqual(
    buildCompanionUsage(orders, events, 1).map((c) => c.companionId),
    ["cp-a"],
  );
});

test("常用打手：只统计当前用户订单上的服务，别人的事件不算（隐私）", () => {
  const mine = [order("o-mine", "completed", { completedAt: beijing("2026-09-20 10:00:00.000") })];
  const events = [
    service("o-mine", "cp-a", beijing("2026-09-18 10:00:00.000"), "小A"),
    // 别人的订单：listServiceEvents() 返回的是**全量**事件，事件本身不带 userId，
    // 因此收窄必须发生在聚合里——漏掉就会把别人的打手算进「我的常用打手」
    service("o-other", "cp-z", beijing("2026-09-18 10:00:00.000"), "小Z"),
  ];

  assert.deepEqual(buildCompanionUsage(mine, events).map((c) => c.companionId), ["cp-a"]);
});

test("常用打手：展示的是事件里的历史快照，不读打手当前资料（D9）", () => {
  const orders = [order("o1", "completed", { completedAt: beijing("2026-09-20 10:00:00.000") })];
  // 打手后来改名、被停用（enabled=false）、被移除（removedAt != null）——
  // 聚合输入里根本没有这些字段，因此历史统计**必然**不受影响
  const events = [service("o1", "cp-a", beijing("2026-09-18 10:00:00.000"), "当年叫小A", "/mock/old-avatar.svg")];

  const [entry] = buildCompanionUsage(orders, events);
  assert.equal(entry.companionId, "cp-a");
  assert.equal(entry.name, "当年叫小A");
  assert.equal(entry.avatarUrl, "/mock/old-avatar.svg");
});

test("常用打手：同一打手多次服务时展示最近一次的快照（D9）", () => {
  const orders = [
    order("o1", "completed", { completedAt: beijing("2026-09-20 10:00:00.000") }),
    order("o2", "completed", { completedAt: beijing("2026-09-22 10:00:00.000") }),
  ];
  const events = [
    service("o1", "cp-a", beijing("2026-09-18 10:00:00.000"), "旧名字", "/mock/old.svg"),
    service("o2", "cp-a", beijing("2026-09-21 10:00:00.000"), "新名字", "/mock/new.svg"),
  ];

  const [entry] = buildCompanionUsage(orders, events);
  assert.equal(entry.serviceCount, 2);
  assert.equal(entry.name, "新名字");
  assert.equal(entry.avatarUrl, "/mock/new.svg");
  // 快照里没有开关字段，disabled / removed 无从泄漏
  assert.deepEqual(Object.keys(entry).sort(), ["avatarUrl", "companionId", "name", "serviceCount"]);
});

test("常用打手：真事件与存量派生描述的是同一次服务——必须合并，不能算两次（D10）", () => {
  const orders = [order("o1", "serving", { completedAt: null })];
  const servingAt = beijing("2026-09-18 10:00:00.000");

  // P1-7 之后真实写入的事件
  const real = service("o1", "cp-a", servingAt, "小A");
  // 同一订单的 servingAt / actualCompanionId 都还在 → 读时还会派生出一条**同样**的记录
  const derived = service("o1", "cp-a", servingAt, "小A");

  const [entry] = buildCompanionUsage(orders, [real, derived]);
  assert.equal(entry.serviceCount, 1, "派生是「读时补上」，不是「又服务了一次」");

  // 但 A 被换走、B 接手后，A 与 B 的 servingAt 不同 → 两条，各自算一次
  const two = buildCompanionUsage(orders, [
    service("o1", "cp-a", servingAt, "小A"),
    service("o1", "cp-b", beijing("2026-09-19 10:00:00.000"), "小B"),
  ]);
  assert.equal(two.length, 2);
  assert.equal(two.reduce((sum, c) => sum + c.serviceCount, 0), 2);
});

/* ══════════════════════════ 七、服务历史仓储（D10 附加要求） ══════════════════════════ */

test("服务历史：同一 assignment 只记一次，重复写入不新增（D10 第 5 条）", () => {
  const event = {
    orderId: "o1",
    companionId: "cp-a",
    dispatchId: "d1",
    servingAt: beijing("2026-09-18 10:00:00.000"),
    companionName: "小A",
    companionAvatarUrl: "/mock/a.svg",
  };

  const first = appendCompanionService(event);
  assert.equal(first.created, true);
  assert.ok(first.event.id.startsWith("svc_"));

  // 重放同一条：返回既有记录，不新增
  const again = appendCompanionService(event);
  assert.equal(again.created, false);
  assert.equal(again.event.id, first.event.id);

  // 同一订单同一打手，但**时刻不同** → 两次真实服务，必须留两条
  const later = appendCompanionService({ ...event, servingAt: beijing("2026-09-19 10:00:00.000") });
  assert.equal(later.created, true);
  assert.notEqual(later.event.id, first.event.id);
});

test("服务历史：写入器不覆盖已有 id，事件表只增不改（D10 第 6 / 7 条）", async () => {
  appendCompanionService({
    orderId: "o1",
    companionId: "cp-a",
    dispatchId: null,
    servingAt: beijing("2026-09-18 10:00:00.000"),
    companionName: "小A",
    companionAvatarUrl: "/mock/a.svg",
  });

  const stored = await mockCompanionServiceRepository.listServiceEvents();
  assert.equal(stored.length, 1);
  const snapshot = { ...stored[0] };

  // 再写一条别的（模拟换人 / 后续服务）：旧记录逐字不变
  appendCompanionService({
    orderId: "o1",
    companionId: "cp-b",
    dispatchId: null,
    servingAt: beijing("2026-09-19 10:00:00.000"),
    companionName: "小B",
    companionAvatarUrl: "/mock/b.svg",
  });

  const after = await mockCompanionServiceRepository.listServiceEvents();
  assert.equal(after.length, 2);
  assert.deepEqual(
    after.find((e) => e.id === snapshot.id),
    snapshot,
    "旧的服务记录必须原样保留",
  );
});

test("存量派生：只派生 servingAt 与 actualCompanionId 都在的订单，且不按状态过滤（D10）", async () => {
  const store = paymentStore();
  // 预置数据里本来就有服务过的订单；本用例只关心**派生规则**，
  // 因此先清空，避免断言被预置数据的数量绑住
  store.orders.clear();

  const base = {
    id: "",
    orderNo: "",
    userId: "u-1",
    status: "serving",
    createdAt: beijing("2026-09-18 09:00:00.000"),
    paidAt: beijing("2026-09-18 09:00:00.000"),
    acceptedAt: beijing("2026-09-18 09:30:00.000"),
    servingAt: beijing("2026-09-18 10:00:00.000"),
    completedAt: null,
    refundedAt: null,
    actualCompanionId: "cp-a",
    companion: { id: "cp-a", name: "小A", avatarUrl: "/mock/a.svg" },
    actualPaidAmount: 1000,
    refundedAmount: 0,
    gameName: "三角洲行动",
  };

  store.orders.set("o-live", { ...base, id: "o-live" });
  // 服务过、后来全额退款：servingAt / actualCompanionId 都还在 → **照常派生**
  store.orders.set("o-refunded", {
    ...base,
    id: "o-refunded",
    status: "refunded",
    refundedAmount: 1000,
    refundedAt: beijing("2026-09-20 10:00:00.000"),
  });
  // 已换人：servingAt 被清空 → 存量数据里这次服务已经不可考，不猜、不 backfill
  store.orders.set("o-released", { ...base, id: "o-released", status: "paid", servingAt: null, actualCompanionId: null, companion: null });

  const derived = deriveLegacyServiceEvents();
  assert.deepEqual(derived.map((e) => e.orderId).sort(), ["o-live", "o-refunded"]);

  const refunded = derived.find((e) => e.orderId === "o-refunded");
  assert.equal(refunded.companionId, "cp-a");
  assert.equal(refunded.servingAt, base.servingAt);

  // 派生是**读时**算的：不写事件表，读两次结果一致、事件表仍然是空的
  assert.deepEqual(deriveLegacyServiceEvents(), derived);
  assert.deepEqual(await mockCompanionServiceRepository.listServiceEvents(), []);
});

/* ══════════════════════════ 八、服务层：预置数据端到端 ══════════════════════════ */

test("服务层：预置数据下五个指标都算得出来，且最近 30 天 ≤ 累计", async () => {
  const summary = await getBossStatsForUser("u-1001", NOW);

  // ⚠️ **五个值全部逐一钉死**，不用 `> 0` 这类松断言：
  // 五个指标里任何一个变成空数组 / 变 0，页面上都只是「少一块」或「显示暂无数据」，
  // 不会报错。`> 0` 挡不住它——空数组时下面那些 `for` 循环一次都不执行，用例照样绿。
  // 这几个数在 http-smoke 的消费等级用例里也被钉过（24060），两处必须一致；
  // 采集口径见 `03-delivery.md` §2.2 与 `04-acceptance.md` §〇 的预置数据表。
  assert.equal(summary.orderCount, 16);
  assert.equal(summary.totalSpendAmount, 24060);
  // `14780` = 3590 + 4590 + 6600，三单都是「已完成」且落在 `[NOW - 29 天, NOW)` 里：
  // 前两单是种子里**写死绝对日期**的订单，第三单是周期榜的「今日」那一单。
  // 这个数之所以**不随执行日期变化**，是因为 `beforeEach` 把 Mock 基准时间钉成了 `NOW`
  // （`setMockSeedNow`）——否则第三单会跟着真实当天走，本断言就变成「跨过 NOW 必红」。
  assert.equal(summary.recent30dSpendAmount, 14780);
  assert.ok(
    summary.recent30dSpendAmount <= summary.totalSpendAmount,
    "最近 30 天是累计的子集，不可能更大",
  );

  // 常玩游戏：Top3 截断、次数降序、名字与次数都定死
  assert.deepEqual(
    summary.recentGames.map((game) => [game.name, game.orderCount]),
    [
      ["三角洲行动", 3],
      ["无畏契约", 2],
    ],
  );
  assert.ok(summary.recentGames.length <= BOSS_STATS_TOP_N);

  // 常用打手：**必须先断言非空**，否则下面的 `for` 在空数组上是空转（= 没测）
  assert.equal(summary.recentCompanions.length, 3);
  assert.deepEqual(
    summary.recentCompanions.map((companion) => [companion.companionId, companion.serviceCount]),
    [
      ["cp-1", 3],
      ["cp-3", 3],
      ["cp-4", 1],
    ],
  );
  for (const companion of summary.recentCompanions) {
    assert.equal(typeof companion.name, "string");
    assert.ok(Number.isInteger(companion.serviceCount) && companion.serviceCount > 0);
  }

  // 另一个用户各自算各自的，不会读串
  const other = await getBossStatsForUser("u-1002", NOW);
  assert.equal(other.orderCount, 3);
  assert.equal(other.totalSpendAmount, 3990);
  assert.notEqual(other.orderCount, summary.orderCount);
});

/* ══════════════════════════ 九、HTTP：只读会话用户、DTO 键固定 ══════════════════════════ */

const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过需要服务的用例";

// 第一个请求之前先把**服务端**存储丢回预置（见 tests/httpReset.mjs）
await resetServerStores();

/**
 * 模拟登录一次并拿到会话 Cookie。服务端未开启 `ENABLE_MOCK_AUTH` 时返回 null，
 * 需要登录态的用例会说明原因并跳过，而不是伪装成通过。
 */
async function loginAs(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;

  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

const SESSION = BASE ? await loginAs("u-1001") : null;
const SKIP_SESSION = SKIP || (SESSION ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

test("老板数据接口要求登录", { skip: SKIP }, async () => {
  const anonymous = await fetch(new URL("/api/me/boss-stats", BASE));
  assert.equal(anonymous.status, 401);
});

test("老板数据接口的 DTO 键固定，且没有订单明细", { skip: SKIP_SESSION }, async () => {
  const response = await fetch(new URL("/api/me/boss-stats", BASE), { headers: { cookie: SESSION } });
  assert.equal(response.status, 200);

  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), [
    "companionNotice",
    "gameNotice",
    "orderCount",
    "recent30dSpendAmount",
    "recentCompanions",
    "recentGames",
    "spendNotice",
    "totalSpendAmount",
  ]);

  assert.ok(Number.isInteger(data.orderCount));
  assert.ok(Number.isInteger(data.totalSpendAmount));
  assert.ok(Number.isInteger(data.recent30dSpendAmount));
  assert.ok(data.recent30dSpendAmount <= data.totalSpendAmount);

  // 面板是聚合结果，不是订单列表：明细字段一个都不许出现在响应里
  const serialized = JSON.stringify(data);
  for (const forbidden of ["orderId", "orderNo", "gameAccountId", "remark", "refundReason", "userId"]) {
    assert.equal(serialized.includes(forbidden), false, `老板数据摘要不该出现 ${forbidden}`);
  }

  // 金额与消费等级页同口径（R2 的对外表现）
  const levels = await fetch(new URL("/api/me/consumption-level", BASE), { headers: { cookie: SESSION } });
  const levelData = (await levels.json()).data;
  assert.equal(data.totalSpendAmount, levelData.effectiveSpendAmount);
});

test("老板数据接口忽略查询参数，只返回会话用户自己的数据", { skip: SKIP_SESSION }, async () => {
  // 接口不接受「查谁的数据」这类参数；带上别人的 id 也必须原样返回自己的
  const response = await fetch(new URL("/api/me/boss-stats?userId=u-1002", BASE), {
    headers: { cookie: SESSION },
  });
  assert.equal(response.status, 200);

  const { data } = await response.json();
  const mine = await fetch(new URL("/api/me/boss-stats", BASE), { headers: { cookie: SESSION } });
  assert.deepEqual(data, (await mine.json()).data);

  // 换个身份必须拿到**不同**的一份（证明读的是会话，而不是一个写死的种子）
  const otherSession = await loginAs("u-1002");
  if (otherSession) {
    const otherResponse = await fetch(new URL("/api/me/boss-stats", BASE), {
      headers: { cookie: otherSession },
    });
    const otherData = (await otherResponse.json()).data;
    assert.notEqual(otherData.orderCount, data.orderCount);
    // 对方的数据里也不许夹带自己这条会话的痕迹
    assert.equal(JSON.stringify(otherData).includes(SESSION.split("=")[1]), false);
  }
});
