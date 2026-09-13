/**
 * 消费金额统计口径、消费等级判定与进度计算（**纯逻辑，服务端与浏览器共用**）。
 *
 * ⚠️ 本文件只有 `import type`（编译后完全消失），没有任何运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 为什么规则集中在这里：消费金额与等级判定在三个地方被用到（`/rights` 页面、
 * `/api/me/consumption-level` 接口、`/mine` 的等级摘要），只要有一处自己去遍历订单
 * 或自己判断等级，两个入口就会慢慢长成两套口径。**页面组件不得遍历订单算金额。**
 */

import type { Order, OrderStatus } from "@/lib/types/order";
import type {
  ConsumptionLevel,
  ConsumptionLevelConfigIssue,
  ConsumptionLevelSummary,
  ConsumptionLevelView,
} from "@/lib/types/level";

/* ────────────────────────────── 统计口径 ────────────────────────────── */

/**
 * 计入「累计有效消费金额」的订单状态。
 *
 * 用户端订单没有「待付款」状态（订单只在支付成功那一刻生成），因此口径就是
 * **已完成**：已付款 / 已接单 / 护航中都还在进行中，已退款要把钱退回去。
 *
 * 当前没有部分退款模型，因此**不自行发明**部分退款算法：已退款订单一分都不计。
 */
export const CONSUMPTION_ORDER_STATUS: OrderStatus = "completed";

/**
 * 消费金额的统计口径说明。页面上必须原样展示这一句——
 * 用户看到「累计有效消费」时最容易自己脑补一个口径。
 */
export const CONSUMPTION_CALCULATION_NOTICE =
  "累计有效消费金额只统计本人「已完成」且未退款的订单实付金额；已付款、已接单、护航中、已退款以及支付失败、支付取消的订单均不计入；优惠券领取与鸡腿记录不产生消费金额。";

/**
 * 累计有效消费金额（分）。
 *
 * 三条不变量由本函数**单独负责**，调用方不需要（也不应该）再过滤一遍：
 *
 * 1. **只累计 `completed`**：其余状态一律跳过，函数本身不信任调用方已经筛过；
 * 2. **同一订单只算一次**：按订单 id 去重。仓储返回的就是一个按 id 键控的 Map，
 *    正常不会有重复；这里仍显式去重，使「不重复累计」成为可单独测试的保证；
 * 3. **金额取订单的服务端快照 `totalAmount`**，不读任何客户端字段，
 *    也不做四舍五入之外的处理（分是整数，本函数保持整数运算）。
 */
export function sumEffectiveSpend(orders: readonly Order[]): number {
  const counted = new Set<string>();
  let total = 0;

  for (const order of orders) {
    if (order.status !== CONSUMPTION_ORDER_STATUS) continue;
    if (counted.has(order.id)) continue;
    if (!Number.isFinite(order.totalAmount)) continue;

    counted.add(order.id);
    total += Math.trunc(order.totalAmount);
  }

  return total;
}

/** 参与统计的订单笔数（页面上的「共 N 笔有效订单」）。去重规则与金额一致。 */
export function countEffectiveOrders(orders: readonly Order[]): number {
  const counted = new Set<string>();
  for (const order of orders) {
    if (order.status !== CONSUMPTION_ORDER_STATUS) continue;
    counted.add(order.id);
  }
  return counted.size;
}

/* ────────────────────────────── 配置校验 ────────────────────────────── */

/** 阈值必须是整数分。 */
export const LEVEL_THRESHOLD_NOT_INTEGER = "等级阈值必须是整数（单位：分）";
/** 阈值不能为负。 */
export const LEVEL_THRESHOLD_NEGATIVE = "等级阈值不能为负数";
/** 启用等级的阈值不能重复。 */
export const LEVEL_THRESHOLD_DUPLICATED = "启用等级的阈值不能重复";
/** 最低启用等级的阈值必须是 0，否则会有用户「一个等级都达不到」。 */
export const LEVEL_LOWEST_THRESHOLD_NOT_ZERO = "最低启用等级的阈值必须为 0";

/**
 * 校验等级配置，返回全部问题（按发现顺序）。
 *
 * 返回**问题列表**而不是布尔值：调用方既要知道配置坏没坏，也要知道坏在哪里。
 * 本函数不抛错，也不尝试修复——掩盖配置错误只会把问题推到更难查的地方。
 *
 * 「一个启用等级都没有」不算非法配置，它是**空配置**，由 `resolveConsumptionLevel`
 * 单独处理成「等级配置暂不可用」。
 */
export function validateLevelConfig(
  levels: readonly ConsumptionLevel[],
): ConsumptionLevelConfigIssue[] {
  const issues: ConsumptionLevelConfigIssue[] = [];
  const enabled = levels.filter((level) => level.enabled);
  if (enabled.length === 0) return issues;

  const seenThresholds = new Map<number, string>();

  for (const level of enabled) {
    if (!Number.isFinite(level.thresholdAmount) || !Number.isInteger(level.thresholdAmount)) {
      issues.push({ levelId: level.id, reason: LEVEL_THRESHOLD_NOT_INTEGER });
      continue;
    }
    if (level.thresholdAmount < 0) {
      issues.push({ levelId: level.id, reason: LEVEL_THRESHOLD_NEGATIVE });
      continue;
    }

    const owner = seenThresholds.get(level.thresholdAmount);
    if (owner !== undefined) {
      issues.push({
        levelId: level.id,
        reason: `${LEVEL_THRESHOLD_DUPLICATED}（与 ${owner} 同为 ${level.thresholdAmount} 分）`,
      });
      continue;
    }
    seenThresholds.set(level.thresholdAmount, level.id);
  }

  const lowest = Math.min(...seenThresholds.keys());
  if (Number.isFinite(lowest) && lowest !== 0) {
    const owner = seenThresholds.get(lowest);
    issues.push({
      levelId: owner ?? "",
      reason: LEVEL_LOWEST_THRESHOLD_NOT_ZERO,
    });
  }

  return issues;
}

/* ────────────────────────────── 等级排序与判定 ────────────────────────────── */

/**
 * 只取启用等级，并按阈值升序排列。
 *
 * 阈值相同时（非法配置）依次用 `sortOrder` 与 `id` 兜底，保证同一份配置每次排出来的
 * 顺序**完全一致**——否则「当前等级」会随遍历顺序漂移，同一个用户在两次请求里看到不同等级。
 */
export function sortEnabledLevels(levels: readonly ConsumptionLevel[]): ConsumptionLevel[] {
  return levels
    .filter((level) => level.enabled)
    .slice()
    .sort((a, b) => {
      if (a.thresholdAmount !== b.thresholdAmount) return a.thresholdAmount - b.thresholdAmount;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
}

/** 等级记录 → 对外展示形态。**显式挑字段**：`enabled` / 时间戳不会外泄。 */
export function toLevelView(level: ConsumptionLevel): ConsumptionLevelView {
  return {
    id: level.id,
    name: level.name,
    thresholdAmount: level.thresholdAmount,
    privileges: level.privileges.map((privilege) => ({ ...privilege })),
    sortOrder: level.sortOrder,
  };
}

/* ────────────────────────────── 文案 ────────────────────────────── */

/** Mock 配置的说明。页面上必须让用户看到「这不是最终等级规则」。 */
export const LEVEL_CONFIG_NOTICE = "当前为 Mock 等级配置，最终以平台配置为准。";

/** 权益说明。权益只做展示，不构成任何承诺。 */
export const LEVEL_PRIVILEGE_NOTICE =
  "权益内容为说明性示例，不构成折扣、优先派单、赠券或返现承诺。";

/** 没有任何启用等级时的说法。 */
export const LEVEL_UNAVAILABLE_EMPTY = "等级配置暂不可用";

/**
 * 配置存在但当前金额一个等级都够不上（只可能出现在非法配置里，例如最低阈值不为 0）。
 * 这时**不能**把最低等级算给用户——那是在用默认值掩盖配置错误。
 */
export const LEVEL_UNAVAILABLE_INVALID = "等级配置异常，暂不可用";

/** 已达到最高等级时的明确说法，页面上不能显示负数或虚假的下一等级。 */
export const TOP_LEVEL_REACHED_MESSAGE = "已达到当前最高等级";

/* ────────────────────────────── 页面文案 ────────────────────────────── */

/**
 * 页面文案集中在这里，而不是散落在组件里。
 *
 * 原因有两条：一是同一句话在多个位置出现（例如「等级配置暂不可用」既在摘要卡上、
 * 也在全部等级列表的位置），散着写迟早会说岔；二是这些句子都需要在测试里被断言，
 * 组件文件测不了（JSX 不会被 node 剥离），常量可以。
 */
export const LEVEL_PAGE_TITLE = "消费等级";

/** 摘要卡顶部的小标题。原型里的叫法是「消费等级」，沿用。 */
export const LEVEL_SECTION_TITLE = "我的消费等级";
export const LEVEL_ALL_TITLE = "全部等级";
export const LEVEL_PRIVILEGE_SECTION_TITLE = "当前等级权益";
export const LEVEL_CALCULATION_TITLE = "统计口径";

export const LEVEL_SPEND_LABEL = "累计有效消费";

/** 配置不可用时摘要卡上的补充说明：说清「等级给不出来」，但金额仍然可信。 */
export const LEVEL_UNAVAILABLE_HINT =
  "消费金额来自订单，仍然准确；等级与进度需要等平台配置完成后才能显示。";

/**
 * 全部等级列表为空时的文案。
 *
 * ⚠️ 不能编一个等级或一条进度来「兜底」：那是把配置故障显示成正常状态，
 * 用户会以为自己的等级真的就是这样。
 */
export const LEVEL_LIST_EMPTY_MESSAGE = "当前没有可展示的等级配置。";

/** 差额文案。金额始终由调用方按标准价格格式传入。 */
export function formatAmountToNextLevel(amountText: string): string {
  return `还差 ${amountText} 升级`;
}

export function formatThresholdText(amountText: string): string {
  return `累计消费满 ${amountText}`;
}

/* ────────────────────────────── 判定与进度 ────────────────────────────── */

/** 等级判定的结果：要么给出状态，要么说明为什么给不出。 */
export type ConsumptionLevelResolution =
  | { ok: true; state: ConsumptionLevelState }
  | { ok: false; reason: string };

export type ConsumptionLevelState = {
  effectiveSpendAmount: number;
  currentLevel: ConsumptionLevelView;
  nextLevel: ConsumptionLevelView | null;
  amountToNextLevel: number | null;
  progressPercent: number;
  progressCurrentAmount: number;
  progressTargetAmount: number | null;
};

/** 把任意输入收敛成非负整数分，避免 NaN / Infinity 顺着计算流下去。 */
function toSafeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** 百分比收敛：非有限值按 0，负数按 0，超过 100 按 100。 */
function toSafePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 10) / 10;
}

/**
 * 判定当前等级与下一等级。
 *
 * - **当前等级** = 累计有效消费金额已经达到的**最高**启用等级；
 * - **下一等级** = 金额尚未达到的第一个启用等级；已是最高等级时为 null；
 * - **差额** = `max(0, 下一等级阈值 - 当前金额)`，因此**永远不小于 0**；
 * - **进度** = 在当前等级区间内的位置（当前阈值 → 下一等级阈值），收敛到 0–100 的有限数；
 *   已是最高等级时为 100（满），分母为 0 时同样按满处理，绝不产生 NaN / Infinity。
 *
 * 无启用等级 → `reason: LEVEL_UNAVAILABLE_EMPTY`；
 * 有启用等级但最低阈值大于 0 且用户还没够上（非法配置）→ `LEVEL_UNAVAILABLE_INVALID`，
 * 而不是把最低等级派给用户。
 */
export function resolveConsumptionLevel(
  effectiveSpendAmount: number,
  levels: readonly ConsumptionLevel[],
): ConsumptionLevelResolution {
  const enabled = sortEnabledLevels(levels);
  if (enabled.length === 0) return { ok: false, reason: LEVEL_UNAVAILABLE_EMPTY };

  const spend = toSafeAmount(effectiveSpendAmount);

  let currentIndex = -1;
  for (let index = 0; index < enabled.length; index += 1) {
    if (spend >= enabled[index].thresholdAmount) currentIndex = index;
  }

  // 一个都够不上：只可能是配置有问题（合法配置的最低阈值是 0，任何金额都能达到）
  if (currentIndex < 0) return { ok: false, reason: LEVEL_UNAVAILABLE_INVALID };

  const currentLevel = toLevelView(enabled[currentIndex]);
  const nextLevel = currentIndex + 1 < enabled.length ? toLevelView(enabled[currentIndex + 1]) : null;

  const progressCurrentAmount = Math.max(0, spend - currentLevel.thresholdAmount);

  if (!nextLevel) {
    return {
      ok: true,
      state: {
        effectiveSpendAmount: spend,
        currentLevel,
        nextLevel: null,
        amountToNextLevel: null,
        progressPercent: 100,
        progressCurrentAmount,
        progressTargetAmount: null,
      },
    };
  }

  const span = nextLevel.thresholdAmount - currentLevel.thresholdAmount;
  return {
    ok: true,
    state: {
      effectiveSpendAmount: spend,
      currentLevel,
      nextLevel,
      amountToNextLevel: Math.max(0, nextLevel.thresholdAmount - spend),
      progressPercent: span > 0 ? toSafePercent((progressCurrentAmount / span) * 100) : 100,
      progressCurrentAmount,
      progressTargetAmount: span > 0 ? span : null,
    },
  };
}

/**
 * 组装对外 DTO。
 *
 * 这是**唯一**产出 `ConsumptionLevelSummary` 的地方：页面、接口与 `/mine` 摘要
 * 都拿同一个形状的数据，不会出现某个入口少算一项的情况。
 *
 * 配置不可用时 `available: false` 且等级字段全为 null，但**金额照常给出**——
 * 金额来自订单，不依赖等级配置。
 */
export function buildConsumptionLevelSummary(
  effectiveSpendAmount: number,
  levels: readonly ConsumptionLevel[],
): ConsumptionLevelSummary {
  const spend = toSafeAmount(effectiveSpendAmount);
  const views = sortEnabledLevels(levels).map(toLevelView);
  const resolution = resolveConsumptionLevel(spend, levels);

  const base = {
    available: resolution.ok,
    unavailableReason: resolution.ok ? "" : resolution.reason,
    effectiveSpendAmount: spend,
    levels: views,
    configNotice: LEVEL_CONFIG_NOTICE,
    calculationNotice: CONSUMPTION_CALCULATION_NOTICE,
  };

  if (!resolution.ok) {
    return {
      ...base,
      currentLevel: null,
      nextLevel: null,
      amountToNextLevel: null,
      // 配置不可用时不给出任何进度：0% 只是一个中性占位，不表示「你差得远」
      progressPercent: 0,
      progressCurrentAmount: 0,
      progressTargetAmount: null,
    };
  }

  const { state } = resolution;
  return {
    ...base,
    currentLevel: state.currentLevel,
    nextLevel: state.nextLevel,
    amountToNextLevel: state.amountToNextLevel,
    progressPercent: state.progressPercent,
    progressCurrentAmount: state.progressCurrentAmount,
    progressTargetAmount: state.progressTargetAmount,
  };
}

/**
 * 等级名称：给排行榜这类只需要一个名字的场景用。
 *
 * 配置不可用时返回空串（页面显示「等级待配置」），**不编一个默认等级名**。
 */
export function resolveLevelName(
  effectiveSpendAmount: number,
  levels: readonly ConsumptionLevel[],
): string {
  const resolution = resolveConsumptionLevel(effectiveSpendAmount, levels);
  return resolution.ok ? resolution.state.currentLevel.name : "";
}
