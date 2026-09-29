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
 * ⚠️ `withdrawn` **在本阶段仍不可达**（不做提现），但它仍然要有显示名：
 * 类型上存在却在映射表里缺席，将来第一个用到它的页面会显示成 `undefined`，
 * 而那种缺口的来源只是「当时没人写」。
 *
 * ⚠️ `reversed` **P0-15 起也不可达了**（P0-13 曾可达）：产品裁定
 * 「退款批准后处理对象仍停在 `frozen`」（指令 ②§四 / §十(8)），
 * 净额归零不再改状态。它同样保留显示名——理由与 `withdrawn` 一样，
 * 它是这张表的设计取值，不是本批次新造的词。
 * ⚠️ **打手端看到的那句话不取这张表**：一笔净额已归零的 `frozen` 收益
 * 如果显示「冻结中 / 到期自动转为可提现」，那是**假话**——
 * 它永远不会解冻。逐条的说明走 `earningHintFor()`。
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
 *
 * ⚠️ **颜色也只看状态，不看净额**（P0-15）：一笔被退款冲光的收益状态仍是 `frozen`，
 * 因此它在这里拿到的是「待处理」色。这是**有意**的——产品裁定它就该显示成冻结中的样子
 * （打手端另有逐条的说明文案把那句「到期自动转为可提现」纠正过来，见 `earningHintFor()`）。
 * 若把颜色也改成按净额判，同一个状态会在两个组件里得到两种颜色。
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
/**
 * **净额已经归零**的那笔收益该怎么解释（P0-15）。
 *
 * ⚠️ 这句话**不能挂在状态上**：产品裁定退款批准后收益仍停在 `frozen`
 * （指令 ②§四），于是「被退款冲光」与「正常冻结中」**共用同一个状态**，
 * 而 `EARNING_STATUS_HINTS.frozen` 那句「到期自动转为可提现」在它身上是**假话**——
 * 它永远不会解冻（释放判据里有一道净额闸，见 `isEarningFullyReversed()`）。
 *
 * 「已冲正」是账务口径的词，打手看不懂。这里说清**是谁退的款**：
 * 这一单被退款冲掉了，不是平台罚了他。
 *
 * ⚠️ **不能说「已全额退款」**：这句话对 10% / 30% / 50% 的退款同样会显示
 * （退款比例与「打手收益整笔归零」无关，指令 ①§三），而那时订单**并没有**全额退款——
 * 说了就是一句可被界面自证的假话。措辞必须同时成立在部分退款与全额退款上：
 * 「这一单已退款」两种情况下都真，「这笔收益已被全部冲回」也是。
 */
export const EARNING_FULLY_REVERSED_HINT = "这一单已退款，这笔收益已被全部冲回，不可提现。";

export const EARNING_STATUS_HINTS: Record<EarningStatus, string> = {
  frozen: "订单已完成，收益正在冻结期内，到期自动转为可提现。",
  available: "收益已解冻，可以提现。",
  withdrawn: "这笔收益已提现。",
  reversed: EARNING_FULLY_REVERSED_HINT,
};

/**
 * 一条收益该显示哪句说明——**页面不按状态自己取文案**（P0-15）。
 *
 * 判据是**净额**而不是状态：净额归零是「这笔钱没了」的充分条件，
 * 而状态回答不了这个问题（`frozen` 同时装着「到期就解冻」与「永远不解冻」两种）。
 */
export function earningHintFor(input: { status: EarningStatus; netAmount: number }): string {
  // `withdrawn` 排除在外：本阶段不可达，而真到了可达的那一天，
  // 「已提现的收益后来又归零」是一套新规则，不该在这里顺手替它选一句话
  if (input.status !== "withdrawn" && input.netAmount <= 0) return EARNING_FULLY_REVERSED_HINT;
  return EARNING_STATUS_HINTS[input.status];
}

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
 * ⚠️ **还有第三半：这笔钱是不是已经没了**（P0-15）——见 `isEarningFullyReversed()`。
 * 不能把它折进本函数：本函数回答的是「时间到了没有」，
 * 而一笔被退款冲光的收益**时间确实到了**，只是不该被释放。
 *
 * 因此调用方必须是三个条件同时成立：`到期(本函数) && !阻塞 && !已冲光`。
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

/**
 * 这笔收益的**净额是不是已经归零**（被退款整笔冲光）。
 *
 * ## 为什么它必须存在（P0-15 的产品裁定带出来的）
 *
 * 产品裁定：**退款批准后收益仍停在 `frozen`**（指令 ②§四「处理对象应当仍是
 * `Earning.status = frozen`」/ §十(8)「refund approved 时 Earning 仍 frozen」）。
 * 于是「到期」与「这笔钱还在」变成了**两件独立的事**：
 * 一笔被冲光的收益状态还是 `frozen`、`availableAt` 也照旧，
 * `isEarningMatured()` 会对它返回 `true`。
 *
 * 若释放判据只看时间，清扫会把这笔**已经归零**的收益写成 `available`——
 * 那既违反 §十(10)「refund approved 后不得再释放该 earning」，
 * 也会让打手端出现一条「可提现 ¥0」的记录。因此释放必须多这一道闸。
 *
 * ⚠️ **`>=` 不是 `>`**：`reversedAmount` 由存储层钳在 `[0, incomeAmount]`，
 * 两者相等就是「整笔冲光」。`incomeAmount` 恒为正（见 `lib/types/earning.ts`），
 * 因此这里不会把一条 0 元记录误判——真出现 0 元记录时它同样不该被释放。
 *
 * ⚠️ 与 `isEarningMatured()` 一样是**纯函数**：只读两个数，不碰仓储、不看订单。
 */
export function isEarningFullyReversed(input: { incomeAmount: number; reversedAmount: number }): boolean {
  return input.reversedAmount >= input.incomeAmount;
}

/**
 * 一笔收益的**净额**（= 当前真正归属于打手的那部分）。
 *
 * ⚠️ **这是唯一一处算式**。**三个下游**都读这一个数：「我的收益」列表
 * （`lib/services/companionEarnings.ts`）、收入榜（`lib/constants/companionRankings.ts`）、
 * 打手订单列表的「本单收益」（`lib/services/companionOrders.ts`）。
 * 任何一处各写一遍 `incomeAmount - reversedAmount`，就等于把「净额怎么算」
 * 变成几处可能不一致的规则——而这些地方**都会把金额显示给打手看**，
 * 对不上时没人能判断哪一个是错的。
 *
 * 由 `tests/earningSettlementFreeze.test.mjs` 守着：它**扫整棵源码树**
 * （`lib` / `components` / `app`），除本文件外任何一处出现这个算式都会红。
 *
 * ⚠️ **它是一个派生值，绝不落库**：`incomeAmount` 是完成那一刻的快照（历史事实，
 * 退款不会让它变小），`reversedAmount` 是冲回累计。存第三份只会多一个对不上的地方
 * （`lib/types/earning.ts` 的 `netAmount` 字段说明同此）。
 *
 * ⚠️ **不钳制**：`reversedAmount` 由存储层钳在 `[0, incomeAmount]`，因此净额落在
 * `[0, incomeAmount]`。在这里再 `Math.max(0, …)` 会把存储层护栏失效这件事**盖住**——
 * 让一个不可能出现的负数静默变成 0，而不是暴露出来。
 */
export function earningNetAmount(input: { incomeAmount: number; reversedAmount: number }): number {
  return input.incomeAmount - input.reversedAmount;
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
