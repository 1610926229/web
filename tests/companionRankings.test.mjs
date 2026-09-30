import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

// 全树扫描只能用这一个 `collectFiles` / `readSource`：`tests/` 下已经抄了十几份，
// 再抄一份只会让下一次改动需要改更多地方（`tests/source-text.mjs` 的文件头）
import { collectFiles, readSource } from "./source-text.mjs";

import {
  COMPANION_RANKING_MIN_METRIC,
  COMPANION_RANKING_PAGE_SIZE,
  COMPANION_RANKING_TOP_COUNT,
  DEFAULT_COMPANION_RANKING_BOARD,
  assignCompanionRanks,
  buildCompanionRankingRows,
  companionRankingBoardLabel,
  companionRankingMetricName,
  companionRankingNotice,
  formatCompanionMedal,
  formatCompanionMetricLabel,
  mergeAcceptEvents,
  mergeCompanionRankingPage,
  normalizeCompanionRankingBoard,
  paginateCompanionRankingRows,
  readCompanionRankingBoard,
  shouldApplyCompanionRankingResponse,
  toCompanionRankingEntry,
  withCompanionRankingBoard,
} from "../lib/constants/companionRankings.ts";
import { compareCompanionRankingRows } from "../lib/constants/companionRankings.ts";
import { DEFAULT_RANKING_PERIOD, resolveRankingPeriodRange } from "../lib/constants/rankingPeriods.ts";
import { MINE_GRID_ENTRIES } from "../lib/constants/mine.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { getCompanionAcceptRepository } from "../lib/data/companionAcceptRepository.ts";
import { companionStore } from "../lib/data/mockCompanionRepository.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getEarningRepository } from "../lib/data/earningRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getCompanionRanking } from "../lib/services/companionRankings.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";

/**
 * 打手排行榜（P1-5）的持续测试。
 *
 * 这个文件钉的是**三张榜各自的口径**，而不是页面上有没有那张卡片。裁定
 * （`docs/03-dev/rounds/P1-5/02-decisions.md` §七–§十）把三张榜定成三种不同的东西，
 * 而它们最容易在实现里被合并成一种：
 *
 * | 榜 | 数什么 | 最容易被写错的地方 |
 * |---|---|---|
 * | 接单榜 | 打手**自己**成功接单的事件 | 改去读订单的当前归属 ⇒ A→B→A 只剩 1 次 |
 * | 完成榜 | 实际完成且**没有任何已批准退款**的有效订单 | 只判 `status === "refunded"` ⇒ 部分退款漏算 |
 * | 收入榜 | `available` 的**净额** | 用 `incomeAmount` ⇒ 被冲回的钱继续上榜 |
 *
 * 另外三条同样不可退让：
 *
 * - **名次是同值并列的竞赛排名**（100 / 80 / 80 / 50 ⇒ 1 / 2 / 2 / 4），
 *   而稳定键只决定显示先后、不改变名次（§6）；
 * - **与消费榜是两个独立维度**：两条取数路径不共享任何状态，也不共享空榜调试键；
 * - **接单榜只数「打手自己接的」**（产品裁定 §九-F）：客服**直接换人 / 直接指定**
 *   同样让订单进入 `accepted`、同样复用 `applyDispatchAccepted()`，
 *   但**不是**打手的主动接单行为 ⇒ 接单榜 +0。⚠️ 「订单进入 accepted」与
 *   「产生接单事件」是**两个概念**，不得因为共用一个状态迁移函数就混为一谈。
 *   存量派生通道同样要认得出这一点：`acceptedVia = "staff"` 不派生，
 *   `acceptedVia = null`（认不出来源）**也不派生**——宁可保持历史下界，不凭空补。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";
const COMPANION_C = "cp-3";

/** 一个显式的一日窗口，用来测周期边界（不依赖跑测试的那一天）。 */
const DAY_START = Date.parse("2026-03-01T00:00:00.000Z");
const DAY_END = DAY_START + 24 * 60 * 60 * 1000;
const IN_DAY = new Date(DAY_START + 60 * 60 * 1000).toISOString();
const BEFORE_DAY = new Date(DAY_START - 1).toISOString();
const AFTER_DAY = new Date(DAY_END).toISOString();

/** 累计周期：`start === null` 时 `isWithinRankingPeriod` 恒真。 */
const ALL_TIME = { start: null, end: DAY_END };
const THE_DAY = { start: DAY_START, end: DAY_END };

beforeEach(() => {
  // 三张榜的取数来源全部回到预置状态：顺序无所谓，两个 store 各自从同一份种子重建
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("companion");
  resetMockStore("earning");
  resetMockStore("companionAccept");
  resetMockStore("completion");
  resetMockStore("notification");
  resetMockStore("platformConfig");
});

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

/* ────────────────────────────── 造样本（纯函数用） ────────────────────────────── */

/** 一位打手：`enabled` / `removedAt` 是上榜资格的两个字段（`isCompanionListed`）。 */
function companion(id, overrides = {}) {
  return {
    id,
    displayName: `${id}（占位）`,
    avatarUrl: `/mock/${id}.svg`,
    enabled: true,
    removedAt: null,
    ...overrides,
  };
}

/**
 * 一条接单事件。
 *
 * `dispatchId` 显式给，因为「同一派单只算已记录的那几条」是去重键；
 * `orderId` 也允许显式给，用来构造「这一单**后来**归了别人」的样本——
 * 那是「不回写历史」这条规则唯一能真正被考到的形状。
 */
function acceptEvent(companionId, acceptedAt, dispatchId, orderId) {
  return {
    dispatchId: dispatchId ?? `d-${companionId}-${acceptedAt}`,
    orderId: orderId ?? `ord-${dispatchId ?? companionId}`,
    companionId,
    acceptedAt,
  };
}

/** 一张订单。只填本榜读得到的字段。 */
function order(overrides) {
  return {
    id: "ord-x",
    status: "completed",
    actualCompanionId: COMPANION_A,
    completedAt: IN_DAY,
    refundedAmount: 0,
    ...overrides,
  };
}

/** 一条收益。`reversedAmount` 与 `incomeAmount` 分开给：净额是算出来的。 */
function earning(overrides) {
  return {
    id: "earn-x",
    orderId: "ord-x",
    companionId: COMPANION_A,
    incomeAmount: 10000,
    reversedAmount: 0,
    status: "available",
    frozenAt: IN_DAY,
    availableAt: IN_DAY,
    withdrawnAt: null,
    fineAmount: 0,
    ...overrides,
  };
}

function sources({ companions, acceptEvents = [], orders = [], earnings = [] }) {
  return { companions, acceptEvents, orders, earnings };
}

function rowsOf(board, source, range = ALL_TIME) {
  return buildCompanionRankingRows(board, source, range);
}

function metricOf(board, source, companionId, range = ALL_TIME) {
  const row = rowsOf(board, source, range).find((item) => item.companionId === companionId);
  return row ? row.metricValue : 0;
}

const THREE_COMPANIONS = [companion(COMPANION_A), companion(COMPANION_B), companion(COMPANION_C)];

/* ────────────────────────────── 1. 排序与并列名次 ────────────────────────────── */

test("排序：指标降序；指标相同的按 companionId 升序（名次因此完全确定）", () => {
  const rows = rowsOf(
    "dispatch",
    sources({
      companions: THREE_COMPANIONS,
      acceptEvents: [
        // A 两次、C 一次、B 一次 ⇒ 80 / 50 / 50 的三档结构里没有并列最大项
        acceptEvent(COMPANION_A, IN_DAY, "d-a-1"),
        acceptEvent(COMPANION_A, IN_DAY, "d-a-2"),
        acceptEvent(COMPANION_B, IN_DAY, "d-b-1"),
        acceptEvent(COMPANION_C, IN_DAY, "d-c-1"),
      ],
    }),
  );

  assert.deepEqual(
    rows.map((row) => row.companionId),
    [COMPANION_A, COMPANION_B, COMPANION_C],
  );
  assert.deepEqual(
    rows.map((row) => row.metricValue),
    [2, 1, 1],
  );

  // 同值的两个人（B / C）顺序由 id 决定，与输入顺序无关
  const reversed = rowsOf(
    "dispatch",
    sources({
      companions: [...THREE_COMPANIONS].reverse(),
      acceptEvents: [
        acceptEvent(COMPANION_A, IN_DAY, "d-a-1"),
        acceptEvent(COMPANION_A, IN_DAY, "d-a-2"),
        acceptEvent(COMPANION_B, IN_DAY, "d-b-1"),
        acceptEvent(COMPANION_C, IN_DAY, "d-c-1"),
      ],
    }),
  );
  assert.deepEqual(
    reversed.map((row) => row.companionId),
    [COMPANION_A, COMPANION_B, COMPANION_C],
    "输入顺序不同的同一份数据必须排出同一个顺序",
  );
});

test("并列名次：100 / 80 / 80 / 50 ⇒ 1 / 2 / 2 / 4（不得显示成 1/2/3/4）", () => {
  const rows = [
    { companionId: "cp-a", nickname: "A", avatarUrl: "", metricValue: 100 },
    { companionId: "cp-b", nickname: "B", avatarUrl: "", metricValue: 80 },
    { companionId: "cp-c", nickname: "C", avatarUrl: "", metricValue: 80 },
    { companionId: "cp-d", nickname: "D", avatarUrl: "", metricValue: 50 },
  ];

  const entries = assignCompanionRanks(rows, "dispatch");

  assert.deepEqual(
    entries.map((entry) => entry.rank),
    [1, 2, 2, 4],
  );
  // 「不得显示成 1/2/3/4」的直白形式：并列时名次集合里必须出现重复
  assert.equal(new Set(entries.map((entry) => entry.rank)).size, 3);
  // 并列影响的是名次，不是指标值——指标值一个字都不能为了「看起来整齐」被改写
  assert.deepEqual(
    entries.map((entry) => entry.metricValue),
    [100, 80, 80, 50],
  );
});

test("并列名次：全体员工同值 ⇒ 全体并列第 1；单人 ⇒ 第 1", () => {
  const allTied = assignCompanionRanks(
    [
      { companionId: "cp-a", nickname: "A", avatarUrl: "", metricValue: 7 },
      { companionId: "cp-b", nickname: "B", avatarUrl: "", metricValue: 7 },
      { companionId: "cp-c", nickname: "C", avatarUrl: "", metricValue: 7 },
    ],
    "income",
  );
  assert.deepEqual(
    allTied.map((entry) => entry.rank),
    [1, 1, 1],
  );

  const single = assignCompanionRanks(
    [{ companionId: "cp-a", nickname: "A", avatarUrl: "", metricValue: 1 }],
    "completion",
  );
  assert.deepEqual(
    single.map((entry) => entry.rank),
    [1],
  );
});

test("稳定键只决定同值记录的显示先后，不改变名次", () => {
  const rows = rowsOf(
    "dispatch",
    sources({
      companions: THREE_COMPANIONS,
      acceptEvents: [
        acceptEvent(COMPANION_B, IN_DAY, "d-b-1"),
        acceptEvent(COMPANION_C, IN_DAY, "d-c-1"),
        acceptEvent(COMPANION_A, IN_DAY, "d-a-1"),
      ],
    }),
  );

  const entries = assignCompanionRanks(rows, "dispatch");

  // 三条同值：显示顺序按 id 升序，但名次**全是 1**
  assert.deepEqual(
    entries.map((entry) => entry.companionId),
    [COMPANION_A, COMPANION_B, COMPANION_C],
  );
  assert.deepEqual(
    entries.map((entry) => entry.rank),
    [1, 1, 1],
    "稳定键如果改变了 rank，并列就不再是并列",
  );
});

test("compareCompanionRankingRows：指标降序 → id 升序（同一个函数是排序的唯一出处）", () => {
  const low = { companionId: "cp-a", nickname: "", avatarUrl: "", metricValue: 1 };
  const high = { companionId: "cp-z", nickname: "", avatarUrl: "", metricValue: 2 };
  const sameLowOtherId = { companionId: "cp-b", nickname: "", avatarUrl: "", metricValue: 1 };

  assert.ok(compareCompanionRankingRows(low, high) > 0, "指标大的排前面");
  assert.ok(compareCompanionRankingRows(high, low) < 0);
  assert.ok(compareCompanionRankingRows(low, sameLowOtherId) < 0, "同值按 id 升序");
  assert.equal(
    compareCompanionRankingRows(low, { ...low }),
    0,
    "同一行与它自己比较必须为 0",
  );
});

/* ────────────────────────────── 2. 分页：名次是全局的 ────────────────────────────── */

test("分页：名次是全局竞赛排名，第二页的第一条不是「第 1 名」", () => {
  const rows = rowsOf(
    "dispatch",
    sources({
      companions: THREE_COMPANIONS,
      acceptEvents: [
        acceptEvent(COMPANION_A, IN_DAY, "d-a-1"),
        acceptEvent(COMPANION_A, IN_DAY, "d-a-2"),
        acceptEvent(COMPANION_A, IN_DAY, "d-a-3"),
        acceptEvent(COMPANION_B, IN_DAY, "d-b-1"),
        acceptEvent(COMPANION_B, IN_DAY, "d-b-2"),
        acceptEvent(COMPANION_C, IN_DAY, "d-c-1"),
      ],
    }),
  );

  const first = paginateCompanionRankingRows(rows, "dispatch", 1, 2);
  const second = paginateCompanionRankingRows(rows, "dispatch", 2, 2);

  assert.deepEqual(
    first.items.map((entry) => entry.rank),
    [1, 2],
  );
  assert.deepEqual(
    second.items.map((entry) => entry.rank),
    [3],
    "第二页的名次接着全表算，不是页内序号",
  );
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});

test("分页：每页条数默认 20，且与前三名约定一致", () => {
  assert.equal(COMPANION_RANKING_PAGE_SIZE, 20);
  assert.equal(COMPANION_RANKING_TOP_COUNT, 3);
});

test("加载更多：按 companionId 去重（名次会并列，因此名次不是唯一键）", () => {
  const pageOne = {
    items: [
      { rank: 1, companionId: "cp-a", nickname: "A", avatarUrl: "", metricValue: 5, metricLabel: "5 单" },
      { rank: 1, companionId: "cp-b", nickname: "B", avatarUrl: "", metricValue: 5, metricLabel: "5 单" },
    ],
    page: 1,
    pageSize: 2,
    total: 3,
    hasMore: true,
  };
  const pageTwo = {
    items: [
      // 并列让第二页的第一条**也是 rank 1**：按名次去重会把它当成重复项丢掉
      { rank: 1, companionId: "cp-c", nickname: "C", avatarUrl: "", metricValue: 5, metricLabel: "5 单" },
    ],
    page: 2,
    pageSize: 2,
    total: 3,
    hasMore: false,
  };

  const merged = mergeCompanionRankingPage(pageOne, pageTwo);
  assert.deepEqual(
    merged.items.map((entry) => entry.companionId),
    ["cp-a", "cp-b", "cp-c"],
    "并列的名次要全部留下",
  );
});

/* ────────────────────────────── 3. 接单榜：数事件 ────────────────────────────── */

test("接单榜：A → B → A ⇒ A = 2、B = 1（数的是事件，不是订单的当前归属）", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    acceptEvents: [
      acceptEvent(COMPANION_A, IN_DAY, "d-1"),
      acceptEvent(COMPANION_B, IN_DAY, "d-1"),
      acceptEvent(COMPANION_A, IN_DAY, "d-1"),
    ],
  });

  assert.equal(metricOf("dispatch", source, COMPANION_A), 2);
  assert.equal(metricOf("dispatch", source, COMPANION_B), 1);
});

test("接单榜：同一派单上先后两次由同一人接，算两次（不去重）", () => {
  const source = sources({
    companions: [companion(COMPANION_A)],
    acceptEvents: [
      acceptEvent(COMPANION_A, IN_DAY, "d-1"),
      acceptEvent(COMPANION_A, new Date(DAY_START + 2 * 60 * 60 * 1000).toISOString(), "d-1"),
    ],
  });

  assert.equal(metricOf("dispatch", source, COMPANION_A), 2);
});

test("接单榜：订单后来被取消 / 退款 / 换人，都不回改已经发生过的接单", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    /*
     * ⚠️ 事件与订单**按 orderId 明确对上**，而且订单上的当前归属**不是** A：
     * 这正是「A 接了、后来换给 B（或退掉）」的现场。
     * 如果哪天有人把接单榜改成「读订单的 `actualCompanionId` 再数一遍」，
     * 这四条里的每一条都会让 A 少算一次——而它们**一条都不该**有影响。
     */
    acceptEvents: [
      acceptEvent(COMPANION_A, IN_DAY, "d-1", "ord-refunded"),
      acceptEvent(COMPANION_A, IN_DAY, "d-2", "ord-reassigned"),
      acceptEvent(COMPANION_A, IN_DAY, "d-3", "ord-unfinished"),
      acceptEvent(COMPANION_A, IN_DAY, "d-4", "ord-done-by-other"),
    ],
    orders: [
      order({ id: "ord-refunded", status: "refunded", refundedAmount: 2990 }),
      order({ id: "ord-reassigned", actualCompanionId: COMPANION_B }),
      order({ id: "ord-unfinished", status: "serving", actualCompanionId: COMPANION_A, completedAt: null }),
      order({ id: "ord-done-by-other", actualCompanionId: COMPANION_B }),
    ],
  });

  assert.equal(
    metricOf("dispatch", source, COMPANION_A),
    4,
    "接单榜读事件，订单当前归谁、什么状态，与它无关",
  );
});

test("接单榜：按事件时刻（acceptedAt）切周期，边界为左闭右开", () => {
  const source = sources({
    companions: [companion(COMPANION_A)],
    acceptEvents: [
      acceptEvent(COMPANION_A, BEFORE_DAY, "d-before"),
      acceptEvent(COMPANION_A, new Date(DAY_START).toISOString(), "d-at-start"),
      acceptEvent(COMPANION_A, IN_DAY, "d-inside"),
      acceptEvent(COMPANION_A, AFTER_DAY, "d-after"),
    ],
  });

  assert.equal(metricOf("dispatch", source, COMPANION_A, THE_DAY), 2, "起点算在内，终点不算");
  assert.equal(metricOf("dispatch", source, COMPANION_A, ALL_TIME), 4);
});

test("接单事件合并：同一派单已有记录时不再派生存量那一条（按 dispatchId 整体判定）", () => {
  const logged = [acceptEvent(COMPANION_A, IN_DAY, "d-1")];
  const legacy = [
    // 与已记录的事件**同派单**：存量派生出来的必然是「最后一次」，已被记录覆盖
    acceptEvent(COMPANION_B, new Date(DAY_START + 5 * 60 * 60 * 1000).toISOString(), "d-1"),
    // 事件表上线之前就已经接好的另一单：只能靠派生补上
    acceptEvent(COMPANION_B, IN_DAY, "d-2"),
  ];

  const merged = mergeAcceptEvents(logged, legacy);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((event) => `${event.dispatchId}:${event.companionId}`),
    ["d-1:cp-1", "d-2:cp-2"],
  );
});

test("接单事件合并：一条记录都没有时，存量那一次照样算数", () => {
  const merged = mergeAcceptEvents([], [acceptEvent(COMPANION_A, IN_DAY, "d-1")]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].companionId, COMPANION_A);
});

/* ────────────────────────────── 4. 完成榜：退款一笔都不计入 ────────────────────────────── */

test("完成榜：只数「由他实际完成」且状态为 completed 的订单", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    orders: [
      order({ id: "ord-1", actualCompanionId: COMPANION_A }),
      order({ id: "ord-2", actualCompanionId: COMPANION_A, status: "serving", completedAt: null }),
      order({ id: "ord-3", actualCompanionId: COMPANION_B }),
      order({ id: "ord-4", actualCompanionId: null, status: "paid", completedAt: null }),
    ],
  });

  assert.equal(metricOf("completion", source, COMPANION_A), 1);
  assert.equal(metricOf("completion", source, COMPANION_B), 1);
});

test("完成榜：用户当初指定的人 ≠ 实际完成的人时，不记给被指定的那一位", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    orders: [
      // 用户指定 A、实际由 B 做完：完成业绩属于 B
      order({ id: "ord-1", exclusiveCompanionId: COMPANION_A, actualCompanionId: COMPANION_B }),
    ],
  });

  assert.equal(metricOf("completion", source, COMPANION_A), 0);
  assert.equal(metricOf("completion", source, COMPANION_B), 1);
});

test("完成榜：部分退款后订单状态仍是 completed，也必须排除（不能只看 status）", () => {
  const source = sources({
    companions: [companion(COMPANION_A)],
    orders: [
      // 10% 部分退款：`Order.status` **仍然是 completed**（P0-15 的明确设计）
      order({ id: "ord-partial", status: "completed", refundedAmount: 299 }),
      // 全额退款：状态是 refunded
      order({ id: "ord-full", status: "refunded", refundedAmount: 2990 }),
      // 一分钱都没退过：只有这一单计入
      order({ id: "ord-clean", refundedAmount: 0 }),
    ],
  });

  assert.equal(
    metricOf("completion", source, COMPANION_A),
    1,
    "只要有已批准的退款，10% / 50% / 100% 一视同仁地不计入",
  );
});

test("完成榜：按订单完成时刻（completedAt）切周期，边界为左闭右开", () => {
  const source = sources({
    companions: [companion(COMPANION_A)],
    orders: [
      order({ id: "ord-before", completedAt: BEFORE_DAY }),
      order({ id: "ord-at-start", completedAt: new Date(DAY_START).toISOString() }),
      order({ id: "ord-inside", completedAt: IN_DAY }),
      order({ id: "ord-after", completedAt: AFTER_DAY }),
    ],
  });

  assert.equal(metricOf("completion", source, COMPANION_A, THE_DAY), 2);
  assert.equal(metricOf("completion", source, COMPANION_A, ALL_TIME), 4);
});

/* ────────────────────────────── 5. 收入榜：available 的净额 ────────────────────────────── */

test("收入榜：只数 available；frozen 不计（还没成熟的钱不能算成绩）", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    earnings: [
      earning({ id: "earn-a1", companionId: COMPANION_A, status: "available", incomeAmount: 5000 }),
      earning({ id: "earn-a2", companionId: COMPANION_A, status: "frozen", incomeAmount: 9000 }),
      earning({ id: "earn-b1", companionId: COMPANION_B, status: "frozen", incomeAmount: 9000 }),
    ],
  });

  assert.equal(metricOf("income", source, COMPANION_A), 5000);
  assert.equal(
    rowsOf("income", source).some((row) => row.companionId === COMPANION_B),
    false,
    "只有冻结收益的打手不进收入榜",
  );
});

test("收入榜：净额是 incomeAmount − reversedAmount，被冲回至 0 的不再贡献", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B), companion(COMPANION_C)],
    earnings: [
      // 全部冲回：净额 0 ⇒ 指标为 0 ⇒ 不上榜
      earning({ id: "earn-a", companionId: COMPANION_A, incomeAmount: 10000, reversedAmount: 10000 }),
      // 部分冲回：净额 3000
      earning({ id: "earn-b", companionId: COMPANION_B, incomeAmount: 5000, reversedAmount: 2000 }),
      // 没被冲回过：净额 3000
      earning({ id: "earn-c", companionId: COMPANION_C, incomeAmount: 3000, reversedAmount: 0 }),
    ],
  });

  /*
   * ⚠️ 这一段是「不得使用 incomeAmount」的**判别性**断言：
   * 如果哪天有人把指标改成 `sum(incomeAmount)`，A 会以 10000 冲到第一名，
   * 而事实是**他一分钱都没剩下**。原值最大的那位在收入榜上应当不在场。
   */
  const rows = rowsOf("income", source);
  assert.deepEqual(
    rows.map((row) => [row.companionId, row.metricValue]),
    [
      [COMPANION_B, 3000],
      [COMPANION_C, 3000],
    ],
  );
  assert.equal(metricOf("income", source, COMPANION_A), 0);
});

test("收入榜：按收益的冻结时刻（frozenAt）切周期，而不是 planned 的 availableAt", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    earnings: [
      // 冻结在上周、计划解冻落在这个窗口里：按 frozenAt 切 ⇒ 不进这个周期
      earning({
        id: "earn-a",
        companionId: COMPANION_A,
        frozenAt: BEFORE_DAY,
        availableAt: IN_DAY,
      }),
      // 冻结在这个窗口里：进
      earning({ id: "earn-b", companionId: COMPANION_B, frozenAt: IN_DAY }),
    ],
  });

  assert.equal(metricOf("income", source, COMPANION_A, THE_DAY), 0);
  assert.equal(metricOf("income", source, COMPANION_B, THE_DAY), 10000);
});

test("收入榜：withdrawn 不是 available，不计（当前没有提现写入路径，也不预埋它的口径）", () => {
  const source = sources({
    companions: [companion(COMPANION_A)],
    earnings: [earning({ id: "earn-a", companionId: COMPANION_A, status: "withdrawn" })],
  });

  assert.equal(metricOf("income", source, COMPANION_A), 0);
});

/* ────────────────────────────── 6. 上榜资格 ────────────────────────────── */

test("资格：停用（enabled=false）与被移除（removedAt 非空）的打手不进公开榜", () => {
  const source = sources({
    companions: [
      companion(COMPANION_A),
      companion(COMPANION_B, { enabled: false }),
      companion(COMPANION_C, { removedAt: new Date(DAY_START).toISOString() }),
    ],
    acceptEvents: [
      acceptEvent(COMPANION_A, IN_DAY, "d-a"),
      acceptEvent(COMPANION_B, IN_DAY, "d-b"),
      acceptEvent(COMPANION_C, IN_DAY, "d-c"),
    ],
  });

  assert.deepEqual(
    rowsOf("dispatch", source).map((row) => row.companionId),
    [COMPANION_A],
  );
});

test("资格：休息中（available=false）**仍然**上榜——它回答的是「此刻能不能接单」", () => {
  const source = sources({
    companions: [companion(COMPANION_A, { available: false, unavailableReason: "休息中" })],
    acceptEvents: [acceptEvent(COMPANION_A, IN_DAY, "d-a")],
  });

  assert.equal(metricOf("dispatch", source, COMPANION_A), 1);
});

test("资格：指标为 0 的不上榜，且没有最低单量门槛", () => {
  assert.equal(COMPANION_RANKING_MIN_METRIC, 1);

  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    acceptEvents: [
      // 1 单就够：没有「至少 N 单 / 工作满 N 天」的门槛
      acceptEvent(COMPANION_A, IN_DAY, "d-a"),
    ],
  });

  assert.deepEqual(
    rowsOf("dispatch", source).map((row) => row.companionId),
    [COMPANION_A],
    "接了一次就上榜",
  );
  assert.equal(
    rowsOf("dispatch", source).some((row) => row.companionId === COMPANION_B),
    false,
    "一次都没接过的打手不上榜",
  );
});

test("三张榜互相独立：同一份数据在三张榜上给出三个不同的指标", () => {
  const source = sources({
    companions: [companion(COMPANION_A), companion(COMPANION_B)],
    acceptEvents: [
      // A 接了两次，其中只有一单做成并结算
      acceptEvent(COMPANION_A, IN_DAY, "d-1"),
      acceptEvent(COMPANION_A, IN_DAY, "d-2"),
      acceptEvent(COMPANION_B, IN_DAY, "d-3"),
    ],
    orders: [
      order({ id: "ord-1", actualCompanionId: COMPANION_A }),
      order({ id: "ord-2", actualCompanionId: COMPANION_A, refundedAmount: 2990 }),
    ],
    earnings: [
      earning({ id: "earn-1", orderId: "ord-1", companionId: COMPANION_A, incomeAmount: 7000 }),
      // 被退款冲回：收入榜不计，但它在**接单榜**上的那一次接单照旧
      earning({
        id: "earn-2",
        orderId: "ord-2",
        companionId: COMPANION_A,
        incomeAmount: 7000,
        reversedAmount: 7000,
      }),
    ],
  });

  assert.equal(metricOf("dispatch", source, COMPANION_A), 2);
  assert.equal(metricOf("completion", source, COMPANION_A), 1);
  assert.equal(metricOf("income", source, COMPANION_A), 7000);
});

/* ────────────────────────────── 7. DTO 隐私白名单 ────────────────────────────── */

test("DTO：字段集合精确等于六项，多一个少一个都不行", () => {
  const entry = toCompanionRankingEntry(
    { companionId: COMPANION_A, nickname: "阿泽（占位）", avatarUrl: "/mock/avatar-1.svg", metricValue: 36 },
    "dispatch",
    1,
  );

  assert.deepEqual(Object.keys(entry).sort(), [
    "avatarUrl",
    "companionId",
    "metricLabel",
    "metricValue",
    "nickname",
    "rank",
  ]);
});

test("DTO：指标文案——次数是「N 单」，收入是「¥金额」", () => {
  assert.equal(formatCompanionMetricLabel("dispatch", 36), "36 单");
  assert.equal(formatCompanionMetricLabel("completion", 31), "31 单");
  assert.equal(formatCompanionMetricLabel("income", 284050), "¥2840.50");
  assert.equal(formatCompanionMetricLabel("income", 0), "¥0.00");
});

test("展示：奖牌按名次发，不按位置发——并列不能一个挂金一个挂银", () => {
  assert.equal(formatCompanionMedal(1), "🥇");
  assert.equal(formatCompanionMedal(2), "🥈");
  assert.equal(formatCompanionMedal(3), "🥉");
  assert.equal(formatCompanionMedal(4), "", "并列把第 4 名挤进前三位时宁可不发牌");
  assert.equal(formatCompanionMedal(0), "", "名次从 1 起");

  // 竞赛排名 1 / 2 / 2：第三张卡片的**位置**是第 3 个，名次却是 2，必须挂银牌
  assert.deepEqual(
    [1, 2, 2].map(formatCompanionMedal),
    ["🥇", "🥈", "🥈"],
    "同值并列的两块牌必须一样：徽标不能与卡片上的名次文字互相打脸",
  );
  // 1 / 1 / 3 同理：前两位都挂金牌，第三位挂铜牌
  assert.deepEqual([1, 1, 3].map(formatCompanionMedal), ["🥇", "🥇", "🥉"]);

  // 源码级门禁：组件必须按 `entry.rank` 取牌，不得按数组下标取
  const board = stripComments(
    readFileSync(path.join(ROOT, "components/rank/CompanionRankingBoard.tsx"), "utf8"),
  );
  assert.match(board, /formatCompanionMedal\(entry\.rank\)/, "奖牌的唯一来源");
  assert.doesNotMatch(
    board,
    /\bMEDALS\b/,
    "按位置取牌的那张表必须已经删掉：留着它迟早有人再用一次",
  );
});

test("DTO：真实姓名 / 手机号 / 联系方式 / 分账比例一个都不出现", () => {
  const entry = toCompanionRankingEntry(
    {
      companionId: COMPANION_A,
      nickname: "阿泽（占位）",
      avatarUrl: "/mock/avatar-1.svg",
      metricValue: 36,
    },
    "dispatch",
    1,
  );

  const serialized = JSON.stringify(entry);
  for (const forbidden of ["realName", "phone", "wechat", "companionRate", "RateBp", "intro", "userId", "removedAt", "banReason"]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `公开 DTO 里不允许出现 ${forbidden}`,
    );
  }
});

test("DTO：类型定义里没有「我的排名」与等级字段（第一版不做，见裁定 §10 / §11）", () => {
  // 去注释：文件头正是在**解释**「为什么刻意没有这几个字段」，注释里出现名字不算有它
  const source = stripComments(
    readFileSync(path.join(ROOT, "lib/types/companionRanking.ts"), "utf8"),
  );

  // ⚠️ 不能用 `includes("me:")`：`nickname:` 里就有这三个字符。
  // 这里要判的是**字段声明**，因此用「行首的 me / me? 后面跟冒号」这个形状。
  assert.equal(
    /^\s*me\??\s*:/m.test(source),
    false,
    "打手榜 DTO 不该有 me 字段（第一版不做「我的排名」）",
  );

  for (const forbidden of ["viewerLoggedIn", "myRank", "levelName", "rankLabel", "grade"]) {
    assert.equal(source.includes(forbidden), false, `打手榜 DTO 不该有 ${forbidden}`);
  }
});

test("业务时区：周期按北京时间（UTC+8）切，不是 UTC 自然日", () => {
  /*
   * 取一个「UTC 与北京不在同一天」的瞬间：UTC 2026-03-01 20:00 = 北京 2026-03-02 04:00。
   * 于是北京的「今天」从 2026-03-01T16:00Z 开始——**UTC 意义上的 03-01 15:00 已经在昨天**。
   * 如果哪天有人把周期改成按 UTC 切，下面第一条断言会立刻翻面。
   */
  const now = new Date("2026-03-01T20:00:00.000Z");
  const range = resolveRankingPeriodRange("today", now);

  assert.equal(new Date(range.start).toISOString(), "2026-03-01T16:00:00.000Z");

  const source = (completedAt) =>
    sources({
      companions: [companion(COMPANION_A)],
      orders: [order({ id: "ord-1", completedAt })],
    });

  // 北京 03-02 00:30（UTC 03-01 16:30）：算今天
  assert.equal(
    metricOf("completion", source("2026-03-01T16:30:00.000Z"), COMPANION_A, range),
    1,
  );
  // 北京 03-01 23:00（UTC 03-01 15:00）：**UTC 日历上也是 03-01，但北京已经是昨天**
  assert.equal(
    metricOf("completion", source("2026-03-01T15:00:00.000Z"), COMPANION_A, range),
    0,
    "按 UTC 切周期的话这一条会变成 1——它正是「业务时区」这条要求的判别点",
  );
});

/* ────────────────────────────── 8. 榜键与周期参数的契约 ────────────────────────────── */

test("榜键：默认接单榜；空值按未指定处理；非法值严格读取为 null、宽松规范化回默认", () => {
  assert.equal(DEFAULT_COMPANION_RANKING_BOARD, "dispatch");
  assert.equal(normalizeCompanionRankingBoard(null), "dispatch");
  assert.equal(normalizeCompanionRankingBoard("revenue"), "dispatch");

  assert.equal(readCompanionRankingBoard(null), null, "没传");
  assert.equal(readCompanionRankingBoard("   "), null, "空白按未指定处理");
  assert.equal(readCompanionRankingBoard(""), null);
  assert.equal(readCompanionRankingBoard("income"), "income");
  assert.equal(readCompanionRankingBoard("revenue"), null, "传了非法值要能被区分出来");
});

test("榜键：中文名与指标名全部来自同一份定义", () => {
  assert.equal(companionRankingBoardLabel("dispatch"), "接单榜");
  assert.equal(companionRankingBoardLabel("completion"), "完成榜");
  assert.equal(companionRankingBoardLabel("income"), "收入榜");
  assert.equal(companionRankingMetricName("dispatch"), "接单次数");
  assert.equal(companionRankingMetricName("completion"), "完成订单数");
  assert.equal(companionRankingMetricName("income"), "收入净额");
});

test("口径说明：三张榜各有一句自己的说明，且都写明并列规则与隐私边界", () => {
  const notices = ["dispatch", "completion", "income"].map(companionRankingNotice);

  assert.equal(new Set(notices).size, 3, "三张榜的口径说明不能是同一句");
  for (const notice of notices) {
    assert.match(notice, /并列/);
    assert.match(notice, /真实姓名|联系方式/);
    // 这句话会被直接放进文本节点（`{result.notice}`），Markdown 不会被渲染
    assert.doesNotMatch(notice, /\*/, "口径说明是纯文本，`**` 在界面上就是星号本身");
  }
  assert.match(notices[0], /接单/);
  assert.match(notices[1], /退款/);
  assert.match(notices[2], /解冻/);

  /*
   * 时间基准逐榜不同，且必须与 `metricFor` 真正用的字段一致：
   * 接单读 `acceptedAt`、完成读 `completedAt`、收入读 `frozenAt`。
   * 三张榜共用一句「以订单完成时间为准」对接单榜是**当场就错**的。
   */
  assert.match(notices[0], /以接单成功的那一刻为准/);
  assert.match(notices[1], /以订单完成的那一刻为准/);
  assert.match(notices[2], /以收益开始冻结的那一刻/);
  assert.doesNotMatch(notices[0], /完成时间/, "接单榜不能说自己的周期按完成时间切");
});

test("地址：切榜写入 board 且不丢其它查询参数", () => {
  const next = withCompanionRankingBoard("?period=month&page=2", "income");
  const params = new URLSearchParams(next);

  assert.equal(params.get("board"), "income");
  assert.equal(params.get("period"), "month");
  assert.equal(params.get("page"), "2");
});

test("竞态：序号、榜、周期三者同时匹配才允许写入界面", () => {
  const current = { id: 3, board: "income", period: "month" };

  assert.equal(shouldApplyCompanionRankingResponse({ ...current }, current), true);

  // 迟到的响应：序号旧
  assert.equal(
    shouldApplyCompanionRankingResponse({ id: 2, board: "income", period: "month" }, current),
    false,
  );
  // 快速来回切换：序号与周期都对，但榜已经不是当前那张
  assert.equal(
    shouldApplyCompanionRankingResponse({ id: 3, board: "dispatch", period: "month" }, current),
    false,
  );
  // 序号与榜都对，周期不对
  assert.equal(
    shouldApplyCompanionRankingResponse({ id: 3, board: "income", period: "today" }, current),
    false,
  );
});

/* ────────────────────────────── 9. 服务层：真种子 ────────────────────────────── */

function page(params = {}) {
  return new URLSearchParams({ mockDelay: "0", ...params });
}

test("服务层：裸调返回接单榜 + 默认周期，且页头字段齐全", async () => {
  const result = await getCompanionRanking(page(), "server");

  assert.equal(result.board, "dispatch");
  assert.equal(result.boardLabel, "接单榜");
  assert.equal(result.metricName, "接单次数");
  assert.equal(result.period, DEFAULT_RANKING_PERIOD);
  assert.equal(typeof result.periodLabel, "string");
  assert.equal(typeof result.generatedAt, "string");
  assert.equal(result.notice, companionRankingNotice("dispatch"));
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, COMPANION_RANKING_PAGE_SIZE);
  assert.ok(Array.isArray(result.items));
});

test("服务层：非法 board / period 抛 400，不被静默当成默认值", async () => {
  await assert.rejects(
    () => getCompanionRanking(page({ board: "revenue" }), "server"),
    (error) => error.code === "BAD_REQUEST",
  );
  await assert.rejects(
    () => getCompanionRanking(page({ period: "lastWeek" }), "server"),
    (error) => error.code === "BAD_REQUEST",
  );
});

test("服务层：接单榜 = 存量派单记录里仍可考据的那一次（独立重算一致）", async () => {
  const result = await getCompanionRanking(page({ board: "dispatch", period: "all" }), "server");

  // 独立重算：直接读派单 store 数一次，不经过被测的聚合函数。
  // ⚠️ 三个条件缺一不可（§九-F 裁定）：state=accepted ∧ 有接单人 ∧
  // **来源是打手自接**。少了第三个条件，这条「独立 oracle」会把被推翻的旧口径
  // 当成判据——种子一旦改口径或将来补一条 staff 样本，它会**假红**。
  const expected = new Map();
  for (const record of dispatchStore().dispatches.values()) {
    if (record.state !== "accepted") continue;
    const id = record.acceptedByCompanionId;
    if (!id) continue;
    if (record.acceptedVia !== "companion") continue;
    expected.set(id, (expected.get(id) ?? 0) + 1);
  }

  const listed = new Set(
    companionStore()
      .companions.values()
      .filter((item) => item.enabled && item.removedAt === null)
      .map((item) => item.id),
  );

  const actual = new Map(result.items.map((entry) => [entry.companionId, entry.metricValue]));
  for (const [id, count] of expected) {
    if (!listed.has(id)) continue;
    assert.equal(actual.get(id), count, `${id} 的接单次数`);
  }
  assert.ok(result.items.length > 0, "预置数据里应当有已接单的存量样本");
});

test("服务层：完成榜独立重算一致，且不含任何有已批准退款的订单", async () => {
  const result = await getCompanionRanking(page({ board: "completion", period: "all" }), "server");

  const listed = new Set(
    companionStore()
      .companions.values()
      .filter((item) => item.enabled && item.removedAt === null)
      .map((item) => item.id),
  );

  const expected = new Map();
  for (const order of await getPaymentRepository().listAllOrders()) {
    if (order.status !== "completed") continue;
    if (order.refundedAmount > 0) continue;
    const id = order.actualCompanionId;
    if (!id || !listed.has(id)) continue;
    expected.set(id, (expected.get(id) ?? 0) + 1);
  }

  const actual = new Map(result.items.map((entry) => [entry.companionId, entry.metricValue]));
  assert.deepEqual(
    [...actual.entries()].sort(),
    [...expected.entries()].sort(),
    "完成榜的每一行都必须能被独立重算出来",
  );
});

test("服务层：榜上每一行的字段都只有公开白名单里那六项", async () => {
  for (const board of ["dispatch", "completion", "income"]) {
    const result = await getCompanionRanking(page({ board, period: "all" }), "server");
    for (const entry of result.items) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "avatarUrl",
        "companionId",
        "metricLabel",
        "metricValue",
        "nickname",
        "rank",
      ]);
    }
  }
});

test("服务层：名次是全局竞赛排名，翻页不产生重复的人", async () => {
  const first = await getCompanionRanking(
    page({ board: "dispatch", period: "all", pageSize: "1" }),
    "server",
  );
  const second = await getCompanionRanking(
    page({ board: "dispatch", period: "all", pageSize: "1", page: "2" }),
    "server",
  );

  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].rank, 1);
  if (second.items.length > 0) {
    const merged = mergeCompanionRankingPage(first, second);
    assert.equal(
      merged.items.length,
      first.items.length + second.items.length,
      "两页之间不该出现同一个人",
    );
    assert.notEqual(second.items[0].companionId, first.items[0].companionId);
    // 第二页的名次只会 >= 第一页
    assert.ok(second.items[0].rank >= first.items[0].rank);
  }
});

test("服务层：停用的打手（cp-7）无论哪张榜都不出现", async () => {
  for (const board of ["dispatch", "completion", "income"]) {
    const result = await getCompanionRanking(page({ board, period: "all" }), "server");
    assert.equal(
      result.items.some((entry) => entry.companionId === "cp-7"),
      false,
      `${board} 榜不该出现已停用的 cp-7`,
    );
  }
});

test("服务层：?mockEmpty=companionRankings 得到空榜，且不影响消费榜的空榜键", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  const empty = await getCompanionRanking(
    page({ mockEmpty: "companionRankings", period: "all" }),
    "server",
  );
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);

  // 消费榜的空榜键（`rankings`）对本榜**没有任何作用**——两个键是两个维度
  const notEmpty = await getCompanionRanking(
    page({ mockEmpty: "rankings", period: "all" }),
    "server",
  );
  assert.ok(notEmpty.total > 0, "消费榜的空榜键不该把打手榜也清空");

  // 反向：打手榜的空榜键不该动到消费榜
  const consumption = await getConsumptionRanking(
    null,
    page({ mockEmpty: "companionRankings", period: "all" }),
    "server",
  );
  assert.ok(consumption.total > 0, "打手榜的空榜键不该把消费榜清空");
});

test("服务层：两个榜是两个三维度——打手榜不读会话，消费榜的「我的排名」保持原样", () => {
  const service = stripComments(
    readFileSync(path.join(ROOT, "lib/services/companionRankings.ts"), "utf8"),
  );
  const route = stripComments(
    readFileSync(path.join(ROOT, "app/api/rankings/companions/route.ts"), "utf8"),
  );

  // 打手榜：结构上拿不到任何用户身份
  for (const source of [service, route]) {
    assert.equal(source.includes("getSessionUser"), false, "打手榜不该读会话");
    assert.equal(source.includes("requireUser"), false, "打手榜不要求登录");
    assert.equal(source.includes("@/lib/auth/session"), false, "打手榜不该引入会话模块");
  }

  // 消费榜：它自己的「我的排名」逻辑必须保留（本轮只加了一条导航）
  const consumption = readFileSync(path.join(ROOT, "lib/services/rankings.ts"), "utf8");
  assert.ok(consumption.includes("viewerUserId"), "消费榜的会话参数必须保留");
  const consumptionPage = readFileSync(
    path.join(ROOT, "app/(mobile)/rank/page.tsx"),
    "utf8",
  );
  assert.ok(consumptionPage.includes("getSessionUser"), "消费榜页面仍按会话渲染「我的排名」");
});

/** 去掉注释：门禁断言看的是代码，注释里提到会话不算「读了会话」。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/* ────────────────────────────── 11. 落点与错误边界 ────────────────────────────── */

test("落点：/rank/companions 是二级页面，且自带同段的加载与错误边界", () => {
  const page = readFileSync(path.join(ROOT, "app/(mobile)/rank/companions/page.tsx"), "utf8");
  const code = stripComments(page);

  assert.ok(code.includes("<NavBar"), "顶部返回导航");
  assert.equal(code.includes("PlaceholderPage"), false, "必须是真实实现，不是占位页");
  assert.ok(code.includes("getCompanionRanking"), "首屏由 Server Component 取数");
  // 二级页面：不在 (tabs) 里，因此没有底部 TabBar
  assert.equal(code.includes("(tabs)"), false);

  // ⚠️ 同段边界必须存在：`app/(mobile)/rank/loading.tsx` **不覆盖**这个子目录，
  // 少了它，取数失败会在外壳阶段发生，响应退化成 500
  for (const boundary of ["loading.tsx", "error.tsx"]) {
    const file = path.join(ROOT, "app/(mobile)/rank/companions", boundary);
    assert.ok(readFileSync(file, "utf8").length > 0, `缺少 ${boundary}`);
  }

  // 非法 board / period 在页面侧规范化到默认值，不该给用户一个 400 错误页
  assert.ok(code.includes("normalizeCompanionRankingBoard"));
  assert.ok(code.includes("normalizeRankingPeriod"));
});

test("落点：「我的」页有独立入口，且与消费榜是两个地址", () => {
  const entries = MINE_GRID_ENTRIES;
  const consumption = entries.find((entry) => entry.id === "rank");
  const companion = entries.find((entry) => entry.id === "companion-rank");

  assert.ok(consumption, "消费榜入口必须保留");
  assert.equal(consumption.href, "/rank");
  assert.ok(companion, "「我的」页需要有打手榜入口");
  assert.equal(companion.kind, "link");
  assert.equal(companion.href, "/rank/companions");
  assert.notEqual(companion.href, consumption.href, "两个榜是两个地址");
});

test("错误与重试：接口路由存在，错误边界把重试交回给调用方", () => {
  const route = readFileSync(path.join(ROOT, "app/api/rankings/companions/route.ts"), "utf8");
  assert.ok(/export async function GET/.test(route), "缺少 GET");
  assert.ok(route.includes("toApiError"), "错误必须走统一映射，不自己拼响应");

  const error = stripComments(
    readFileSync(path.join(ROOT, "app/(mobile)/rank/companions/error.tsx"), "utf8"),
  );
  assert.ok(error.includes("reset"), "错误边界必须给出重试出口");
  assert.ok(error.includes("ErrorState"));

  // 客户端组件里的重试与竞态守卫（组件行为无法单测，这里钉住它确实接了这两件事）
  const board = stripComments(
    readFileSync(path.join(ROOT, "components/rank/CompanionRankingBoard.tsx"), "utf8"),
  );
  assert.ok(board.includes("shouldApplyCompanionRankingResponse"), "迟到的响应必须被挡住");
  assert.ok(board.includes("useRef"), "请求序号需要跨渲染保存");
});

test("加载窗口：切榜 / 切周期期间不得显示上一张榜的榜名、口径说明与统计范围", () => {
  /*
   * 切榜时 `load("replace")` 只把 `listStatus` 置为 loading，**不清 `result`**——
   * 屏幕上有三处直接读 `result`，于是会同时出现「加载完成榜…」与
   * 「统计范围：…（接单榜那一周）」这种自相矛盾的画面。
   *
   * ⚠️ 组件行为无法单测（`node --test` 不剥 JSX），因此这里钉的是**取值来源**：
   * 只要这三处都不再直接读 `result`，矛盾在结构上就不可能发生。
   */
  const board = stripComments(
    readFileSync(path.join(ROOT, "components/rank/CompanionRankingBoard.tsx"), "utf8"),
  );

  // ① 加载提示：榜名取**当前选中的**，不取响应里的
  assert.match(
    board,
    /加载\$\{companionRankingBoardLabel\(board\)\}/,
    "加载提示必须按当前 `board` 取榜名",
  );
  assert.doesNotMatch(
    board,
    /加载\$\{result\.boardLabel\}/,
    "不得用响应里的榜名：切榜瞬间它是上一张榜的",
  );

  // ② 口径说明：只有「响应就是当前这一张榜」时才用响应里那一句
  assert.match(
    board,
    /const noticeText = result\.board === board \? result\.notice : companionRankingNotice\(board\)/,
    "口径说明必须按当前榜兜底，且兜底文案来自同一个纯函数",
  );
  assert.match(board, /<p className="text-\[12px\] leading-4 text-ink-3">\{noticeText\}<\/p>/);

  // ③ 统计范围：同一处闸门（它同时依赖周期，因此用完整的 boardMatches）
  assert.match(
    board,
    /const rangeText = boardMatches\s*\n\s*\?/,
    "统计范围的取值必须以 `boardMatches` 为闸门（渲染的是闸门后的结果，不是 result 的字段）",
  );
  assert.match(
    board,
    /<p className="mt-2 text-\[12px\] leading-5 text-ink-3">\{rangeText\}<\/p>/,
    "JSX 只允许渲染闸门后的 `rangeText`",
  );
});

/* ────────────────────────────── 10. 端到端：真实写入路径 ────────────────────────────── */

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

let seq = 0;
function uniqueKey() {
  seq += 1;
  return `p15-key-${process.pid}-${seq}`;
}

async function placeOrder(user, companionId = null) {
  const { createPaymentRequest, confirmPaymentRequest } = await import(
    "../lib/services/checkout.ts"
  );
  const created = await createPaymentRequest(
    {
      productId: "p-400w",
      specId: "s-400w",
      region: "手游",
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId,
      idempotencyKey: uniqueKey(),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付链路必须走通");
  assert.equal(confirmed.orderCreated, true);
  return confirmed.order;
}

test("端到端：一次真实接单正好写一条接单事件（重放不追加），接单榜 +1", async () => {
  const order = await placeOrder(`u-p15-${process.pid}-1`, COMPANION_A);
  const dispatch = await dispatchOf(order.id);
  const at = new Date().toISOString();

  // 打手**自己**接单 ⇒ 这是唯一该让接单榜 +1 的那条路径（§九-F）
  const before = await boardMetricOf("dispatch", COMPANION_A);

  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at });
  assert.equal(accepted.kind, "ok");

  assert.equal(await boardMetricOf("dispatch", COMPANION_A), before + 1, "自己接一单：+1");

  const events = await getCompanionAcceptRepository().listAcceptEvents();
  assert.equal(events.length, 1, "接单必须被记下来");
  assert.equal(events[0].dispatchId, dispatch.id);
  assert.equal(events[0].orderId, order.id);
  assert.equal(events[0].companionId, COMPANION_A);
  assert.equal(events[0].acceptedAt, at);

  // 重复点击 / 网络重试：重放**不追加**第二条
  const replayed = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at });
  assert.equal(replayed.kind, "ok");
  assert.equal(replayed.replayed, true);
  assert.equal((await getCompanionAcceptRepository().listAcceptEvents()).length, 1);
});

/**
 * 一位打手在某张榜、某个周期上的指标值——**走真实的榜单服务，落在预置数据上**。
 *
 * ⚠️ 与上面那个纯函数的 `metricOf(board, source, companionId, range)` 是两件事：
 * 那个喂的是手搓样本、测口径；这个读的是**整条真实链路**（真下单、真接单、真合并派生）。
 *
 * ⚠️ 一律用来**算差值**，不断言绝对值：预置数据里这些人本来就有数，
 * 断言绝对值等于把「种子今天长什么样」也钉进测试里——种子一变就红得没有意义。
 */
async function boardMetricOf(board, companionId, period = "all") {
  const result = await getCompanionRanking(page({ board, period }), "server");
  return result.items.find((entry) => entry.companionId === companionId)?.metricValue ?? 0;
}

test("端到端：客服「直接换人」不计入接单榜——订单进 accepted，但**不产生接单事件**", async () => {
  const { replaceOrderCompanionByStaff } = await import(
    "../lib/data/companionOrderTransaction.ts"
  );
  const user = `u-p15-${process.pid}-1b`;
  const order = await placeOrder(user, COMPANION_A);
  const dispatch = await dispatchOf(order.id);

  const beforeA = await boardMetricOf("dispatch", COMPANION_A);
  const beforeB = await boardMetricOf("dispatch", COMPANION_B);

  const at = new Date().toISOString();
  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at });
  assert.equal(accepted.kind, "ok");

  const swappedAt = new Date(Date.parse(at) + 60 * 1000).toISOString();
  const swapped = await replaceOrderCompanionByStaff({
    orderId: order.id,
    newCompanionId: COMPANION_B,
    staffId: "staff-1",
    at: swappedAt,
  });
  assert.equal(swapped.kind, "ok");

  /*
   * —— ① 状态迁移照旧：直换**仍然**让订单进入 accepted ——
   *
   * 产品裁定要拆开的是「订单进入 accepted」与「产生接单事件」这**两个概念**，
   * 不是要取消直换的状态迁移：B 的处境必须与他接单之后完全一样，
   * 否则客服换人就换不动了。
   */
  const after = await dispatchOf(order.id);
  assert.equal(after.state, "accepted", "直换仍然让派单进入 accepted");
  assert.equal(after.acceptedByCompanionId, COMPANION_B, "当前接单人确实是 B");
  assert.equal(
    after.acceptedVia,
    "staff",
    "来源必须写下来：派生通道只能靠它分辨「换进来的」与「自己接的」",
  );

  /* —— ② 事件层的账是平的：只有 A 自己接的那一次留下事件 —— */
  assert.deepEqual(
    (await getCompanionAcceptRepository().listAcceptEvents()).map((event) => event.companionId),
    [COMPANION_A],
    "B 是被换进来的，不得产生接单事件；A 那条也不因换人消失",
  );

  /* —— ③ 存量派生通道同样不得把这次直换捡起来 —— */
  const legacy = await getCompanionAcceptRepository().listLegacyAcceptEvents();
  assert.equal(
    legacy.filter((event) => event.dispatchId === dispatch.id).length,
    0,
    "`acceptedVia = \"staff\"` 的绑定记录**不得**被派生成接单事件（§九-F）",
  );

  /* —— ④ 榜面：A +1、B +0 —— */
  assert.equal(await boardMetricOf("dispatch", COMPANION_A), beforeA + 1, "A 自己接的那次算数");
  assert.equal(await boardMetricOf("dispatch", COMPANION_B), beforeB, "B 被换进来：接单榜 +0");
});

test("端到端：被直换的人接单榜 +0、完成榜 +1；他之后**自己**接一单才 +1", async () => {
  const { replaceOrderCompanionByStaff, startCompanionOrder } = await import(
    "../lib/data/companionOrderTransaction.ts"
  );
  const { submitCompletion, approveCompletion } = await import(
    "../lib/data/completionTransaction.ts"
  );

  const order = await placeOrder(`u-p15-${process.pid}-1c`, COMPANION_A);
  const dispatch = await dispatchOf(order.id);
  const t0 = Date.parse(order.paidAt);
  const at = (minutes) => new Date(t0 + minutes * 60 * 1000).toISOString();

  const beforeDispatch = await boardMetricOf("dispatch", COMPANION_B);
  const beforeDone = await boardMetricOf("completion", COMPANION_B);

  assert.equal(
    (await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: at(1) })).kind,
    "ok",
  );
  assert.equal(
    (
      await replaceOrderCompanionByStaff({
        orderId: order.id,
        newCompanionId: COMPANION_B,
        staffId: "staff-1",
        at: at(2),
      })
    ).kind,
    "ok",
  );
  assert.equal(
    await boardMetricOf("dispatch", COMPANION_B),
    beforeDispatch,
    "被换进来的那一刻：接单榜 +0",
  );

  // 他确实履约了这一单 ⇒ 完成榜照常 +1（直换不剥夺完成与收入，只不给他接单数）
  assert.equal(
    (
      await startCompanionOrder({ companionId: COMPANION_B, orderId: order.id, at: at(3) })
    ).kind,
    "ok",
  );
  const submitted = await submitCompletion({
    companionId: COMPANION_B,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: at(4),
  });
  assert.equal(submitted.kind, "ok");
  assert.equal(
    (
      await approveCompletion({
        submissionId: submitted.submissionId,
        staffId: "staff-1",
        staffName: "客服小雨",
        at: at(5),
      })
    ).kind,
    "ok",
  );

  assert.equal(
    await boardMetricOf("completion", COMPANION_B),
    beforeDone + 1,
    "完成榜只看「谁实际完成了这一单」，与他是怎么拿到的无关",
  );
  assert.equal(
    await boardMetricOf("dispatch", COMPANION_B),
    beforeDispatch,
    "完成一单也**不回补**接单数：两件事各算各的",
  );

  // 他自己**主动**接下另一单——这一刻才 +1
  const other = await placeOrder(`u-p15-${process.pid}-1d`, COMPANION_B);
  const otherDispatch = await dispatchOf(other.id);
  assert.equal(
    (await acceptDispatch(otherDispatch.id, { companionId: COMPANION_B, at: at(6) })).kind,
    "ok",
  );
  assert.equal(
    await boardMetricOf("dispatch", COMPANION_B),
    beforeDispatch + 1,
    "自己接的才算：B 接单榜 +1",
  );
});

test("存量派生：`acceptedVia` 为 null（认不出来源）时**不派生**，宁可保持历史下界", async () => {
  /*
   * 这一档只可能来自**存量数据**——`applyDispatchAccepted` 的 `via` 是必填参数，
   * 新写入不可能出现 null。因此这里手工把一条派单记录摆成存量那种样子：
   * `state === "accepted"`、有人接了，但**没有任何来源信息**。
   *
   * 产品裁定：「如果历史数据无法区分：不得凭空补接单事件。
   * 宁可继续保持『存量接单榜是历史下界』。**不要为了让历史数字好看而伪造主动接单行为。**」
   */
  const legacyDispatchId = `dsp-legacy-${process.pid}`;
  dispatchStore().dispatches.set(legacyDispatchId, {
    id: legacyDispatchId,
    orderId: `ord-legacy-${process.pid}`,
    state: "accepted",
    exclusiveCompanionId: null,
    exclusiveEnteredAt: null,
    exclusiveDeadlineAt: null,
    exclusiveTimeoutMinutesSnapshot: null,
    publicPoolEnteredAt: null,
    publicDeadlineAt: null,
    publicTimeoutMinutesSnapshot: null,
    acceptedByCompanionId: COMPANION_C,
    acceptedAt: IN_DAY,
    acceptedVia: null,
    timedOutAt: null,
    createdAt: IN_DAY,
    updatedAt: IN_DAY,
  });

  const legacy = await getCompanionAcceptRepository().listLegacyAcceptEvents();
  assert.equal(
    legacy.filter((event) => event.dispatchId === legacyDispatchId).length,
    0,
    "认不出来源 ⇒ 不派生：它可能是打手自己接的，也可能是客服指定的，**不能猜**",
  );

  // 同一份派单只要把来源写明是打手自己接的，那条通道立刻又能看到它
  const record = dispatchStore().dispatches.get(legacyDispatchId);
  dispatchStore().dispatches.set(legacyDispatchId, { ...record, acceptedVia: "companion" });
  const after = await getCompanionAcceptRepository().listLegacyAcceptEvents();
  assert.deepEqual(
    after
      .filter((event) => event.dispatchId === legacyDispatchId)
      .map((event) => event.companionId),
    [COMPANION_C],
    "**唯一的差别就是 acceptedVia**：它写明了来源，派生才成立",
  );
});

test("源码门禁：接单事件只可能由「打手自己接单」写入（全树扫描，不维护名单）", () => {
  const files = ["lib", "app", "components"]
    .flatMap((dir) => collectFiles(path.join(ROOT, dir)))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts"));

  const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

  /*
   * ① 写接单事件的入口**全仓只有一个**：打手自己接单的那段原子区段。
   *
   * ⚠️ 这条门禁刻意**不维护一份「哪些文件允许出现」的名单**：
   * 一轮之前的教训正是「手写清单漏一个文件时测试仍然是绿的」。
   * 扫整棵树、只允许一处命中，新的写入路径一出现就会红。
   *
   * ⚠️ **它拦的是什么、不拦什么（如实写清，别把它读成「结构上不可能」）**：
   * 它拦的是**字面调用** `appendCompanionAccept(` / `applyDispatchAccepted(`。
   * 它**拦不住**刻意绕路的三件事：① 在**定义所在文件**里新增第三个调用
   * （排除是**整文件**粒度，那个文件被整体豁免）；② `repo["appendCompanionAccept"](...)`
   * 这类不含字面子串的取用；③ **直接写 store**（`companionAcceptStore().events.set(...)`）。
   * 这三条都要「先知道门禁长什么样再去绕」，而且绕过 ①② 在 code review 里看得见；
   * 真正的行为保证在**端到端用例**里，本条只作补充。
   */
  const writers = files.filter((file) => {
    const code = stripComments(readSource(file));
    // 定义处不算写入点（`export function appendCompanionAccept(` 在 store 那个文件里）
    return !/export function appendCompanionAccept\(/.test(code) && code.includes("appendCompanionAccept(");
  });
  assert.deepEqual(
    writers.map(rel),
    ["lib/data/companionDispatchTransaction.ts"],
    "接单事件只能由「打手自己接单」写入；客服直换那条路径**不得**再出现这个调用",
  );

  /*
   * ② 状态迁移写入器有两个调用方，**并且各自必须明说来源**。
   *
   * 这一步比 ① 更严：它连「直换又去写事件」之外的另一种退化也挡住——
   * 有人把 `via` 传成 `"companion"`（那等于绕开 ① 把直换算成接单），
   * 或者新加第三个调用方而不表态。
   */
  const callSites = files.filter((file) => {
    const code = stripComments(readSource(file));
    // 定义处不算调用点（`export function applyDispatchAccepted(`）
    return !/export function applyDispatchAccepted\(/.test(code) && /applyDispatchAccepted\(/.test(code);
  });
  assert.deepEqual(
    callSites.map(rel).sort(),
    ["lib/data/companionDispatchTransaction.ts", "lib/data/companionOrderTransaction.ts"],
    "`applyDispatchAccepted` 只允许这两个调用点：打手自己接单、客服直换",
  );

  const companionCall = stripComments(
    readSource(path.join(ROOT, "lib/data/companionDispatchTransaction.ts")),
  );
  assert.match(
    companionCall,
    /applyDispatchAccepted\([^;]*"companion"\)/,
    "打手自己接单必须记成 companion",
  );
  const staffCall = stripComments(
    readSource(path.join(ROOT, "lib/data/companionOrderTransaction.ts")),
  );
  assert.match(
    staffCall,
    /applyDispatchAccepted\([^;]*"staff"\)/,
    "客服直换必须记成 staff——写成 companion 就等于把 Staff assignment 算成接单",
  );
});

test("端到端：A → B → A 之后，接单榜上 A = 2、B = 1", async () => {
  const { releaseOrderByStaff } = await import("../lib/data/companionOrderTransaction.ts");
  const user = `u-p15-${process.pid}-2`;
  const order = await placeOrder(user, COMPANION_A);
  const dispatch = await dispatchOf(order.id);

  const t0 = Date.parse(order.paidAt);
  const at = (minutes) => new Date(t0 + minutes * 60 * 1000).toISOString();

  const beforeA = await boardMetricOf("dispatch", COMPANION_A);
  const beforeB = await boardMetricOf("dispatch", COMPANION_B);

  const first = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: at(1) });
  assert.equal(first.kind, "ok");

  const releasedOnce = await releaseOrderByStaff({
    orderId: order.id,
    staffId: "staff-1",
    reason: "换人",
    at: at(2),
  });
  assert.equal(releasedOnce.kind, "ok");

  const second = await acceptDispatch(dispatch.id, { companionId: COMPANION_B, at: at(3) });
  assert.equal(second.kind, "ok");

  const releasedTwice = await releaseOrderByStaff({
    orderId: order.id,
    staffId: "staff-1",
    reason: "再换回来",
    at: at(4),
  });
  assert.equal(releasedTwice.kind, "ok");

  const third = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: at(5) });
  assert.equal(third.kind, "ok");

  // 三条事件都留住了：换人与取消都不回写历史
  const events = await getCompanionAcceptRepository().listAcceptEvents();
  assert.deepEqual(
    events.map((event) => event.companionId).sort(),
    [COMPANION_A, COMPANION_A, COMPANION_B],
  );

  /*
   * ⚠️ 这两次置换里，**A 与 B 都是自己接的**（`releaseOrderByStaff` 是「退回公共池」，
   * 谁接谁就是主动接单），因此 A = 2、B = 1 这条算例（裁定 §3）在这条路径上成立。
   * 与客服「直接换人」的区别见下一条用例：那条路径上的 B **一次都不算**。
   */
  assert.equal(await boardMetricOf("dispatch", COMPANION_A), beforeA + 2, "A 自己接了两次");
  assert.equal(await boardMetricOf("dispatch", COMPANION_B), beforeB + 1, "B 那一次不能因为被换掉就消失");
});

test("端到端：订单完成并解冻后，收入榜按净额记上这位打手", async () => {
  const { startCompanionOrder } = await import("../lib/data/companionOrderTransaction.ts");
  const { submitCompletion, approveCompletion } = await import(
    "../lib/data/completionTransaction.ts"
  );

  const user = `u-p15-${process.pid}-3`;
  const order = await placeOrder(user, COMPANION_A);
  const dispatch = await dispatchOf(order.id);

  const completedAt = new Date().toISOString();
  const at = (minutes) => new Date(Date.parse(completedAt) + minutes * 60 * 1000).toISOString();

  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: at(-40) });
  assert.equal(accepted.kind, "ok");
  const started = await startCompanionOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    at: at(-20),
  });
  assert.equal(started.kind, "ok");
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: at(-10),
  });
  assert.equal(submitted.kind, "ok");
  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    at: completedAt,
  });
  assert.equal(approved.kind, "ok");

  const [earning] = (await getEarningRepository().listAllEarnings()).filter(
    (item) => item.orderId === order.id,
  );
  assert.ok(earning, "订单完成必须产生一条收益");
  assert.equal(earning.status, "frozen", "刚完成时还冻结着");

  /*
   * 窗口到期后**不做任何显式清扫**，只读一次收入榜。
   *
   * ⚠️ 这条断言守的是**读路径的接线**：收入榜只统计 `available`（裁定 §5），
   * 而 `availableAt` 到点之后那笔钱**就已经是**可提现的，只差没有人把它写下来。
   * 榜单读路径不物化的话，打手打开自己的收益页会看到钱已可提现、榜单却还是 0——
   * 同一个事实两页给出两个答案，而**错的是榜单**。
   *
   * （用注入的 `now` 把「现在」推到计划解冻时刻之后，因此不等真实时间。）
   */
  const window = Date.parse(earning.availableAt);
  const result = await getCompanionRanking(
    page({ board: "income", period: "all" }),
    "server",
    new Date(window + 60 * 1000),
  );
  const row = result.items.find((entry) => entry.companionId === COMPANION_A);
  assert.ok(row, "到期之后只读榜单就该看到这笔收益，不需要谁先去点一次收益页");

  const after = (await getEarningRepository().listAllEarnings()).find(
    (item) => item.id === earning.id,
  );
  assert.equal(
    after.status,
    "available",
    "读完之后存储里那笔收益真的解冻了：榜单写下来的是**已经成立的事实**，不是它自己算的一个数",
  );

  assert.equal(row.metricValue, earning.incomeAmount - earning.reversedAmount);
  assert.equal(row.metricLabel, `¥${(earning.incomeAmount / 100).toFixed(2)}`);
});

test("端到端：有已批准退款的订单不进完成榜（即使它已经 completed）", async () => {
  const { startCompanionOrder } = await import("../lib/data/companionOrderTransaction.ts");
  const { submitCompletion, approveCompletion } = await import(
    "../lib/data/completionTransaction.ts"
  );
  const { sweepMaturedEarnings } = await import("../lib/data/earningTransaction.ts");
  const { applyOrderRefund } = await import("../lib/data/mockPaymentRepository.ts");

  const user = `u-p15-${process.pid}-4`;
  const order = await placeOrder(user, COMPANION_A);
  const dispatch = await dispatchOf(order.id);

  const completedAt = new Date().toISOString();
  const at = (minutes) => new Date(Date.parse(completedAt) + minutes * 60 * 1000).toISOString();

  await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: at(-40) });
  await startCompanionOrder({ companionId: COMPANION_A, orderId: order.id, at: at(-20) });
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: at(-10),
  });
  await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    at: completedAt,
  });

  const [earning] = (await getEarningRepository().listAllEarnings()).filter(
    (item) => item.orderId === order.id,
  );
  assert.ok(earning, "订单完成必须产生一条收益");
  const window = Date.parse(earning.availableAt);
  assert.deepEqual(
    sweepMaturedEarnings(new Date(window + 60 * 1000).toISOString()).releasedEarningIds,
    [earning.id],
    "前置条件：这一笔必须先成熟，收入榜才看得见它",
  );

  const before = await getCompanionRanking(page({ board: "completion", period: "all" }), "server");
  const countBefore =
    before.items.find((entry) => entry.companionId === COMPANION_A)?.metricValue ?? 0;
  assert.ok(countBefore >= 1, "前置条件：这一单此刻应当计入完成榜");

  /*
   * 退一笔**部分**款：`Order.status` 因此**仍然停在 `completed`**
   * （`applyOrderRefund` 只在退满时才改成 `refunded`）。这正是「不能只看 status」的现场：
   * 唯一的事实是 `refundedAmount > 0`，而它已经成立了。
   */
  applyOrderRefund(order.id, completedAt, 299);
  const refunded = await getPaymentRepository().findOrderById(order.id);
  assert.equal(refunded.refundedAmount, 299);
  assert.equal(refunded.status, "completed", "部分退款不改订单状态——判据必须另找");

  const after = await getCompanionRanking(page({ board: "completion", period: "all" }), "server");
  const countAfter =
    after.items.find((entry) => entry.companionId === COMPANION_A)?.metricValue ?? 0;
  assert.equal(countAfter, countBefore - 1, "出过款的订单必须从完成榜上掉下来");

  /*
   * ⚠️ 三张榜**各看各的事实**，这里正好是分界线的现场：
   * 完成榜看的是**订单上「出过款」这个事实**（刚刚成立，所以立刻掉下来）；
   * 收入榜看的是**收益被冲回**（那是退款事务里的另一笔写入，本用例只写了订单那一边，
   * 因此这一笔收益此刻仍然 `available`、净额不变，收入榜**照旧有它**）。
   * 把两者绑在一起——「订单有退款标记 ⇒ 收入也不算」——会让收入榜在冲回真正落库之前
   * 就先少一笔钱，而打手端那笔钱当时确实还在。
   */
  const income = await getCompanionRanking(page({ board: "income", period: "all" }), "server");
  assert.equal(
    income.items.find((entry) => entry.companionId === COMPANION_A)?.metricValue,
    earning.incomeAmount - earning.reversedAmount,
    "冲回没有发生，收入榜就不该跟着订单标记动",
  );
});
