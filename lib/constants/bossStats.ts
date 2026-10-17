/**
 * 「老板数据面板」的聚合口径（**纯逻辑，服务端与浏览器共用**）。
 *
 * ⚠️ 与 `lib/constants/levels.ts` 一样，本文件**只有 `import type` 之外没有运行时副作用**，
 * 但它确实 import 了 `./levels` 与 `./rankingPeriods` 里的**纯函数**——这没问题，
 * 那两个文件同样是无副作用的纯逻辑，node 能直接加载它们做纯逻辑测试。
 *
 * ## 为什么规则集中在这里
 *
 * 五个指标要在 `/mine` 面板上一次算完。只要有一处页面自己去遍历订单，
 * 「常玩游戏」与「累计消费」迟早会长成两套口径。**页面组件不得遍历订单做统计。**
 *
 * ## 产品裁定（P1-7 `D1`–`D12` + 总规则 `R1` `R2`）
 *
 * 本文件是下列裁定的**唯一**落点，改动前先读 `docs/03-dev/rounds/P1-7/02-decisions.md` §五：
 *
 * | 指标 | 规则 |
 * |---|---|
 * | 累计订单数 | `D1` 全部订单，**退款不减** |
 * | 累计消费 | `D1`+`F1`+`R2` 复用 `sumEffectiveSpend`（只看 `completed`，取净额） |
 * | 最近 30 天消费 | `D2` UTC+8 自然日 30 天（含今日）· `D3` 按 `completedAt` 归属 · `D4` 金额看当前净留存 |
 * | 常玩游戏 | `D5` 按 `gameName` 快照归组 · `D6` 按完成次数排 Top3 · 退款不减次数 |
 * | 常用打手 | `D7` 必须**真实进入过 `serving`** · `D8` 按服务次数排 Top3 · 退款不减次数 |
 *
 * 贯穿全部指标的**总规则 `R1`**：
 * **「钱」实时随退款变化；「行为历史」不因退款而抹掉。**
 */

import { countLifetimeOrders, effectiveSpendOf, sumEffectiveSpend } from "./levels";
import {
  isWithinRankingPeriod,
  recent30DayRange,
  type RankingPeriodRange,
} from "./rankingPeriods";
import type { Order } from "@/lib/types/order";
import type { BossCompanionStat, BossGameStat, BossStatsSummary } from "@/lib/types/bossStats";

/* ────────────────────────────── 参数与文案 ────────────────────────────── */

/**
 * 两个榜单的展示条数（产品裁定 `D6` / `D8`：Top 3）。
 *
 * 单独成常量而不是散落在函数默认值里：它是**产品数字**，改它要有依据；
 * 且测试与页面都从这一处取，不会出现「服务端给 3 条、页面只渲染 2 条」。
 */
export const BOSS_STATS_TOP_N = 3;

/** 金额类指标的口径说明。页面上必须原样展示。 */
export const BOSS_SPEND_NOTICE =
  "累计消费与最近 30 天消费都只统计本人「已完成」订单的实付金额，并减去已经退还给你的金额（不低于 0）；已全额退款的订单不计入，部分退款的订单按退款后的净额计入。最近 30 天按北京时间（UTC+8）自然日划分，以订单的完成时间归属。";

/** 常玩游戏的口径说明。页面上必须原样展示。 */
export const BOSS_GAME_NOTICE =
  "常玩游戏按本人「已完成」订单的游戏名统计次数，取前 3 名；同一款游戏在不同时间下的单合并计算。订单退款不影响这里已经发生过的记录。";

/** 常用打手的口径说明。页面上必须原样展示。 */
export const BOSS_COMPANION_NOTICE =
  "常用打手按本人订单中打手真实开始服务的次数统计，取前 3 名；只接过单、从未开始服务的不计入。订单退款不影响这里已经发生过的记录。";

/** 列表类指标没有数据时的文案（产品裁定 `D12`：用「暂无数据」，**不是** `—`，也不隐藏整块）。 */
export const BOSS_LIST_EMPTY_MESSAGE = "暂无数据";

/** 列表行里次数指标的写法，例如 `12 单`。 */
export function formatUsageCount(count: number): string {
  return `${count} 单`;
}

/**
 * 组装对外 DTO —— 这是**唯一**产出 `BossStatsSummary` 的地方。
 *
 * 页面与接口拿同一个形状，因此不会出现某个入口少算一项。
 * 五个指标：累计订单数 / 累计消费 / 最近 30 天消费 / 常玩游戏 / 常用打手。
 *
 * `now` 是**必填参数**而不是内部取 `new Date()`：最近 30 天是个**时间窗**，
 * 内部取当前时间会让这个函数不可测（跨零点跑出不同结果）。由调用方（服务层）注入。
 *
 * ⚠️ 累计消费**必须**走 `sumEffectiveSpend`（`R2`：与消费等级、消费排行榜同一个纯函数）。
 * 在这里自己写一遍 `reduce` 就等于造出第二份金额口径。
 */
export function buildBossStatsSummary(
  orders: readonly Order[],
  events: readonly ServiceUsageInput[],
  now: Date,
): BossStatsSummary {
  return {
    orderCount: countLifetimeOrders(orders),
    totalSpendAmount: sumEffectiveSpend(orders),
    recent30dSpendAmount: sumSpendWithinRange(orders, recent30DayRange(now)),
    recentGames: buildGameUsage(orders),
    recentCompanions: buildCompanionUsage(orders, events),
    spendNotice: BOSS_SPEND_NOTICE,
    gameNotice: BOSS_GAME_NOTICE,
    companionNotice: BOSS_COMPANION_NOTICE,
  };
}

/* ────────────────────────────── 累计订单数 ────────────────────────────── */

/*
 * 累计订单数（产品裁定 `D1`）**不在这里实现**——它是消费口径的一部分，
 * 唯一实现是 `lib/constants/levels.ts` 的 `countLifetimeOrders()`，
 * 本模块只负责在自己的汇总里调用它（与上面的 `sumEffectiveSpend` 同一条纪律）。
 *
 * ⚠️ **不要在这里再写一份**。曾经这里有一个 `countOrders()`，
 * 与 `countLifetimeOrders()` 逻辑逐字相同；两份实现意味着将来按 `D1` 去改
 * 「累计订单数」的人可能改到没有调用点的那一份，而面板上的数字一动不动。
 * `tests/bossStats.test.mjs` 的 §二 直接单测那个唯一实现。
 */

/* ────────────────────────────── 最近 30 天消费 ────────────────────────────── */

/**
 * 落在给定时间范围内的订单的**净留存金额之和**（产品裁定 `D3` / `D4`）。
 *
 * 两步，顺序不能反：
 *
 * 1. **窗口只看 `completedAt`**：不在窗口里的订单贡献**恒为 0**，
 *    因此「40 天前完成、今天全额退款」不会因为今天退款而变成负数（`D4` 示例 1）；
 * 2. **金额永远看当前净留存** `effectiveSpendOf`（`R2`：与累计消费**同一个**纯函数），
 *    因此「5 天前完成、今天退 30」会立刻从 100 变成 70（`D4` 示例 2）。
 *
 * ⚠️ **这里刻意不再过滤 `CONSUMPTION_ORDER_STATUS`**，这是安全的、也是更贴字面的做法：
 * 在窗口内且完成过的订单里，唯一会被状态过滤掉的是**已全额退款**的那些，
 * 而它们的净留存本来就**必然为 0**（全额退款 = `refundedAmount ≥ actualPaidAmount`，
 * 见 `mockPaymentRepository.applyOrderRefund`）。两条路殊途同归，
 * 但直接用产品给的公式少一层「两个过滤条件互相印证」的推理负担。
 *
 * ⚠️ 由此得到一条可断言的不变量：**最近 30 天消费永远不会大于累计消费**。
 */
export function sumSpendWithinRange(
  orders: readonly Order[],
  range: RankingPeriodRange,
): number {
  const counted = new Set<string>();
  let total = 0;

  for (const order of orders) {
    if (!isWithinRankingPeriod(order.completedAt, range)) continue;
    if (counted.has(order.id)) continue;
    if (!Number.isFinite(order.actualPaidAmount)) continue;

    counted.add(order.id);
    total += effectiveSpendOf(order);
  }

  return total;
}

/* ────────────────────────────── 常玩游戏（D5 / D6） ────────────────────────────── */

/**
 * 常玩游戏 Top N（产品裁定 `D5` / `D6`）。
 *
 * - **纳入**：订单**曾真实完成**（`completedAt` 非空）。⚠️ **全额退款也不删除**这次记录
 *   （`R1`：退款影响钱，不影响「我玩过这个游戏」）。这也是为什么这里**不看 `status`**——
 *   一张完成过、后来全额退款的订单状态是 `refunded`，但它的 `completedAt` **还在**
 *   （`applyOrderRefund` 只改状态与退款金额）。
 * - **归组键**：`gameName` 的**历史快照**，只做 `trim`。**不**连目录、**不**合并别名
 *   （`D5`：商品后来改分类 / 下架 / 删除都不该改写历史订单「当时玩的是什么」）。
 * - **排序**：完成次数 `DESC` → 最近一次 `completedAt` `DESC` → `gameName` `ASC`。
 *   最后一级是**稳定键**：同一份数据每次必须排出完全一样的顺序，否则榜单会随遍历顺序漂移。
 * - **指标是次数，不是金额**（`D6`：高价订单不能因为一单金额大就变成「最常玩」）。
 *
 * ⚠️ 空名字（`trim` 后为空串）**不成行**：那只会渲染出一个没有名字的条目。
 * 它是数据缺陷，应由数据侧修，而不是在展示层编一个「未知游戏」。
 */
export function buildGameUsage(
  orders: readonly Order[],
  topN: number = BOSS_STATS_TOP_N,
): BossGameStat[] {
  type Bucket = { name: string; orderCount: number; lastCompletedAt: string };
  const buckets = new Map<string, Bucket>();
  const counted = new Set<string>();

  for (const order of orders) {
    if (!order.completedAt) continue;
    if (counted.has(order.id)) continue;

    const name = order.gameName.trim();
    if (name === "") continue;

    counted.add(order.id);
    const existing = buckets.get(name);
    if (existing) {
      existing.orderCount += 1;
      // ISO 字符串按字典序比较与按时间比较等价（同格式同长度），这与仓库既有的
      // 「取最近」写法一致；不用 `Date.parse` 是为了不为一个比较引入时间解析
      if (order.completedAt > existing.lastCompletedAt) existing.lastCompletedAt = order.completedAt;
    } else {
      buckets.set(name, { name, orderCount: 1, lastCompletedAt: order.completedAt });
    }
  }

  return [...buckets.values()]
    .sort((a, b) => {
      if (a.orderCount !== b.orderCount) return b.orderCount - a.orderCount;
      if (a.lastCompletedAt !== b.lastCompletedAt) {
        return a.lastCompletedAt < b.lastCompletedAt ? 1 : -1;
      }
      if (a.name === b.name) return 0;
      return a.name < b.name ? -1 : 1;
    })
    .slice(0, Math.max(0, topN))
    .map((bucket) => ({ name: bucket.name, orderCount: bucket.orderCount }));
}

/* ────────────────────────────── 常用打手（D7 / D8 / D9） ────────────────────────────── */

/**
 * 服务历史的最小输入形状。
 *
 * `CompanionServiceEvent`（真事件）与 `DerivedServiceEvent`（存量派生）**都**满足它——
 * 前者多出 `id` / `dispatchId`，结构化类型下可以原样传进来。刻意不取那两个字段：
 * 聚合只需要「谁、哪一单、什么时候开始服务、当时叫什么」。
 */
export type ServiceUsageInput = {
  orderId: string;
  companionId: string;
  servingAt: string;
  companionName: string;
  companionAvatarUrl: string;
};

/**
 * 常用打手 Top N（产品裁定 `D7` / `D8` / `D9`）。
 *
 * ## 判据（`D7`）：**必须真实进入过 `serving`**
 *
 * 输入是**服务历史**而不是订单状态，这正是 `D7` 的落点：只接单、从未开始服务的
 * （`accepted → cancel / release`）**不计入**。一张 A → B 换人的订单会给
 * **两位打手各记一次**（`D7` 的 A1），因为两人都真实服务过。
 *
 * ⚠️ **必须按当前用户的订单收窄**：`listServiceEvents()` 返回的是**全部用户**的事件，
 * 而事件本身不带 `userId`。因此本函数用 `orders`（当前用户的订单）建一个 id 集合，
 * 只保留挂在这些订单上的事件。漏掉这一步就会把别人的打手算进「我的常用打手」。
 *
 * ## 退款不减次数（`D8` 补充）
 *
 * 这里**不看订单状态**，也不看 `refundedAmount`：一张服务过、后来全额退款的订单
 * 依然贡献那一次服务。`R1`：退款影响钱，不改写「这个人曾经服务过我」。
 *
 * ## 快照取哪一份（`D9`）
 *
 * 同一打手多次服务时，展示**最近一次真实服务**对应的那份历史公开快照。
 * 打手后来改名、被停用（`enabled=false`）甚至被移除（`removedAt != null`），
 * **都不影响历史统计**——本函数压根不读打手资料，只用事件里冻结的快照。
 *
 * ## 排序（`D8`）
 *
 * 服务次数 `DESC` → 最近一次 `servingAt` `DESC` → `companionId` `ASC`（稳定键）。
 */
export function buildCompanionUsage(
  orders: readonly Order[],
  events: readonly ServiceUsageInput[],
  topN: number = BOSS_STATS_TOP_N,
): BossCompanionStat[] {
  const mine = new Set(orders.map((order) => order.id));

  type Bucket = {
    companionId: string;
    serviceCount: number;
    lastServedAt: string;
    latestOrderId: string;
    name: string;
    avatarUrl: string;
  };
  const buckets = new Map<string, Bucket>();
  // 同一个打手在同一条订单上、从同一时刻开始的服务只算一次。
  // 真事件与存量派生会对**当前/最终**那位打手各给一条，这里必须合并，
  // 否则那位打手会被算成两次（派生是「读时补上」，不是「又服务了一次」）。
  const counted = new Set<string>();

  for (const event of events) {
    if (!mine.has(event.orderId)) continue;

    const dedupeKey = `${event.orderId}\u0000${event.companionId}\u0000${event.servingAt}`;
    if (counted.has(dedupeKey)) continue;
    counted.add(dedupeKey);

    const existing = buckets.get(event.companionId);
    if (!existing) {
      buckets.set(event.companionId, {
        companionId: event.companionId,
        serviceCount: 1,
        lastServedAt: event.servingAt,
        latestOrderId: event.orderId,
        name: event.companionName,
        avatarUrl: event.companionAvatarUrl,
      });
      continue;
    }

    existing.serviceCount += 1;

    // 「最近一次」：先比时刻；时刻相同（正常不可能）再比 orderId，
    // 保证同一份数据每次挑到**同一条**快照，而不是随遍历顺序漂移
    const isLater =
      event.servingAt > existing.lastServedAt ||
      (event.servingAt === existing.lastServedAt && event.orderId < existing.latestOrderId);
    if (isLater) {
      existing.lastServedAt = event.servingAt;
      existing.latestOrderId = event.orderId;
      existing.name = event.companionName;
      existing.avatarUrl = event.companionAvatarUrl;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => {
      if (a.serviceCount !== b.serviceCount) return b.serviceCount - a.serviceCount;
      if (a.lastServedAt !== b.lastServedAt) return a.lastServedAt < b.lastServedAt ? 1 : -1;
      if (a.companionId === b.companionId) return 0;
      return a.companionId < b.companionId ? -1 : 1;
    })
    .slice(0, Math.max(0, topN))
    .map((bucket) => ({
      companionId: bucket.companionId,
      name: bucket.name,
      avatarUrl: bucket.avatarUrl,
      serviceCount: bucket.serviceCount,
    }));
}
