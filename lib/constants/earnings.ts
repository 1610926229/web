/**
 * 打手收益（Earning）的状态、文案与释放判据（P0-9）。
 *
 * 与订单状态（`lib/constants/orders.ts`）同一套组织方式：**状态的取值、显示名、
 * 文字色、一句话说明都只在这里定义**，页面从常量取，不自己维护一份文案。
 */

import type { EarningStatus } from "@/lib/types/earning";

export const EARNING_STATUSES: readonly EarningStatus[] = [
  "frozen",
  "available",
  "withdrawn",
  "reversed",
];

/**
 * 状态的显示名。
 *
 * ⚠️ `withdrawn` / `reversed` 在本阶段**不可达**（没有提现、没有冲正），
 * 但它们仍然要有显示名：类型上存在却在映射表里缺席，将来第一个用到它们的页面
 * 会显示成 `undefined`，而那种缺口的来源只是「当时没人写」。
 */
export const EARNING_STATUS_LABELS: Record<EarningStatus, string> = {
  frozen: "冻结中",
  available: "可提现",
  withdrawn: "已提现",
  reversed: "已冲正",
};

/**
 * 状态的文字色映射。
 *
 * ⚠️ 与订单状态同一条约定：页面**只能**通过这份映射取颜色，不得在页面里
 * 直接写 `text-status-*`。色值令牌在 `app/globals.css` 的 `@theme` 里，
 * 这里只做「状态 → 语义色」的映射。
 *
 * 语义：`frozen` 是「还等着」（待处理色），`available` 是「钱已经能用了」（成功色），
 * `withdrawn` 是「已经走了」（弱化色），`reversed` 是「被扣回去了」（危险色）。
 */
export const EARNING_STATUS_CLASS: Record<EarningStatus, string> = {
  frozen: "text-status-pending",
  available: "text-status-success",
  withdrawn: "text-status-muted",
  reversed: "text-status-danger",
};

/**
 * 状态的一句话说明，收益卡片上使用。
 *
 * ⚠️ 两句都必须说清「**这笔钱现在能不能用**」，而不是只说流程到了哪一步：
 * 打手看这个页面的唯一目的就是判断钱能不能提，「冻结中」三个字不足以让他知道
 * 是自己做错了什么、还是流程本来如此。
 */
export const EARNING_STATUS_HINTS: Record<EarningStatus, string> = {
  frozen: "订单已完成，收益正在冻结期内，到期自动转为可提现。",
  available: "收益已解冻，可以提现。",
  withdrawn: "这笔收益已提现。",
  reversed: "这笔收益已被冲正。",
};

// ——————————————————————————— 释放判据 ———————————————————————————

/**
 * 这笔收益**是否已经到期**（纯函数，不接触任何仓储）。
 *
 * 三条同时成立才算到期：
 * - 状态必须恰好是 `frozen`——`available` / `withdrawn` / `reversed` 都不是「等释放」；
 * - `availableAt` 必须有值——历史数据缺快照时**不释放**，而不是当成「立刻到期」
 *   （一个空的截止时间如果被解释成「没有约束」，那么一条缺字段的记录会静默放款）；
 * - `availableAt <= at`。
 *
 * ⚠️ 它**只回答时间这一半**。「有没有阻塞」是另一半，判据在
 * `isCompletionAutoApprovalBlocked()`（进行中的退款 / 未完结的投诉）——
 * 与 P0-8 自动通过复用**同一个**函数，理由是「什么算阻塞」在产品上只有一条定义，
 * 两处各写一份迟早出现「自动审核被投诉挡住、收益却被放出去」。
 *
 * 因此调用方应该是：`到期(本函数) && !阻塞`，两个条件缺一不可。
 */
export function isEarningMatured(input: {
  status: EarningStatus;
  availableAt: string | null;
  at: string;
}): boolean {
  if (input.status !== "frozen") return false;
  if (input.availableAt === null) return false;
  return Date.parse(input.availableAt) <= Date.parse(input.at);
}

// ——————————————————————————— 打手端文案 ———————————————————————————

/**
 * 「我的收益」页顶部的说明文案。
 *
 * ⚠️ **刻意不写具体的分钟数**：窗口是可配置的，而且**每一笔收益用的是它自己订单
 * 完成时的快照**——页面上印一个「当前配置值」会让打手拿它去核对一条旧记录，
 * 而那条记录按设计就不该跟它一致。具体到期时刻由每一笔收益自己的
 * `availableAt` 回答（页面上逐条显示）。
 *
 * ⚠️ 最后一句必须留着：它是「为什么这笔钱现在还不能提」的答案。
 * 去掉之后这个页面只剩下一个状态词，打手会把它读成「平台扣着钱」。
 */
export const COMPANION_EARNINGS_NOTICE =
  "每笔收益在订单完成时进入冻结，冻结时长取该订单完成时的投诉窗口，到期且没有进行中的退款 / 未完结的投诉后自动转为可提现。窗口不随后续平台参数修改而变化，以每笔收益上的到期时间为准。";

/**
 * 首页签（`lib/constants/companionConsole.ts`）与页面标题共用的名称。
 */
export const COMPANION_EARNINGS_PAGE_TITLE = "我的收益";
