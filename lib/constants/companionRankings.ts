/**
 * 打手排行榜（Companion Ranking）的聚合、排序、名次、分页与 DTO 转换规则
 * （**纯逻辑，服务端与浏览器共用**）。
 *
 * ## 它和 `lib/constants/rankings.ts` 是什么关系
 *
 * **没有任何关系**——两个文件各自独立，互不 import。
 * 产品裁定（`rounds/P1-5/02-decisions.md` §10）写明：「**Companion Ranking 与
 * User Consumption Ranking 必须是两个独立业务维度**」，且消费榜现有的
 * 「我的排名」逻辑**继续保留、不得删改**。因此：
 *
 * | 关注点 | 消费榜 | 打手榜（本文件） |
 * |---|---|---|
 * | 聚合对象 | 用户（`userId`） | 打手（`companionId`） |
 * | 指标 | 有效消费金额（实付之和） | 接单次数 / 完成订单数 / 收入净额 |
 * | 名次 | 序号（`start + index + 1`） | **竞赛排名**（同值并列，`1/2/2/4`） |
 * | 「我的排名」 | 有（`me` 字段） | **无**（裁定 §10） |
 * | 每页条数 | `RANKING_PAGE_SIZE` | `COMPANION_RANKING_PAGE_SIZE` |
 *
 * ⚠️ **分页常量刻意各写一份**，不是复制粘贴的疏忽：如果打手榜 import 消费榜的
 * `RANKING_PAGE_SIZE`，那么「为了消费榜把每页改成 30」会**顺手改掉打手榜**，
 * 而这种跨榜的隐式联动，正是「两个榜必须独立」要防的事。
 *
 * ## 三张榜的口径（**逐字来自产品裁定**，不得由实现者重新解释）
 *
 * | 榜 | 数什么 | 数据源 | 周期时间基准 |
 * |---|---|---|---|
 * | **接单榜** | 成功的 `acceptDispatch` **事件次数**，每次计 1 | 接单事件表（只增不改） | 事件时刻 `acceptedAt` |
 * | **完成榜** | 「实际由该打手**最终完成**的有效订单数」 | 订单 | 订单完成时刻 `completedAt` |
 * | **收入榜** | 「已经结算成熟、当前真正归属于打手的**净收益**」 | 收益 | **订单完成时刻 `frozenAt`**（见下） |
 *
 * ### 接单榜：A → B → A ⇒ A = 2，B = 1
 *
 * 「后续取消 / 换人 / 退款 / 未完成**不回写、删除**之前真实发生过的成功接单事件」。
 * 因此它**不读订单的当前归属**，只数事件——换人之后再接一次就是**新的一次**。
 *
 * ⚠️ **只数打手自己执行的接单动作（P1-5 §九-F 裁定）**：客服「直接换人 / 直接指定新打手」
 * **计入 0**。裁定原文：「即使底层为了订单状态迁移复用了 `applyDispatchAccepted()`，
 * 也不得因为复用了同一个状态迁移函数，就把 Staff assignment 当成 Companion accept event。」
 * 因此**「订单进入 `accepted`」与「产生一条接单事件」是两个概念**——本榜数的是后者
 * （`CompanionAcceptEvent` / 存量 `DerivedAcceptEvent`），不是派单记录的状态。
 * 被直换的那位**仍然**正常贡献完成榜 / 收入榜，只是没有接单榜贡献。
 * 判据落在 `DispatchRecord.acceptedVia`，写入侧与派生侧的细节见
 * `lib/types/dispatch.ts` 与 `mockCompanionAcceptRepository.ts`。
 *
 * ### 完成榜：有**任何**已批准退款就不计入
 *
 * 三条同时成立才计入：Order 已完成 · 该打手是**实际完成服务的人** ·
 * 该订单**不存在 approved refund**（10% / 50% / 100% 一视同仁）。
 * 原因（裁定 §4）：退款批准后打手本单收益归零、打手端本单显示已退款，
 * 因此不应继续作为公开「完成业绩」贡献。
 *
 * ⚠️ **判据必须用「退款已经实际批准 / 出款」的唯一事实**，而不是
 * `Order.status === "refunded"`——**部分退款时真实 `Order.status` 可能仍不是 `refunded`**
 * （P0-15 的明确设计）。那条唯一事实就是 `hasRefundBeenExecuted(order)`
 * （`lib/constants/refunds.ts`，`refundedAmount > 0`），本文件**直接复用**，
 * 不新增第二个判据、也不在调用点手写 `> 0`。
 *
 * ### 收入榜：只数 `available` 的**净额**
 *
 * - **不得使用 `Earning.incomeAmount`**——它是**历史原始收益快照**，
 *   退款冲回后**仍然保留原值**（P0-15：冲回只加 `reversedAmount`，不动 `incomeAmount`）；
 * - **不得统计 `frozen`**（还没成熟）；
 * - **不得统计已被冲回至 0 的收益**（`netAmount` 为 0 的自然不贡献）；
 * - **不设计 `withdrawn` 口径**：当前没有真实提现写入路径，
 *   **不得预埋假的 withdrawn 逻辑**（裁定 §5）。
 *
 * ⚠️ **周期时间基准取 `frozenAt`（= 订单进入 `completed` 的时刻），
 * 不是 `availableAt`**：裁定 §5 规定了「数什么」但没规定「按哪个时间切周期」。
 * 选 `frozenAt` 的三条理由（完整论证见 `rounds/P1-5/02-decisions.md` §九-B）：
 * ① 与完成榜同源，不会出现「同一周完成的单、收入算到下一周」；
 * ② `availableAt` 是**计划值**，而真实解冻由「有没有人访问」惰性触发，
 * 按它切会让同一个事实在不同机器上落进不同周期；③ 它**非空**。
 * **这一条是实现期判断，已登记为待产品追认项。**
 *
 * ## 三条硬规则
 *
 * 1. **排序必须稳定**：指标降序，同值时用 `companionId` 升序兜底。
 *    ⚠️ 稳定键**只决定同值记录的显示先后，不改变 `rank`**（裁定 §6）——
 *    少了它，同值打手在两次请求里会换位置，翻页时出现「同一个人在第一页出现过、
 *    第二页又出现一次」。
 * 2. **只有上架中且指标大于 0 的打手进入榜单**（裁定 §7）。
 *    **没有最低单量门槛**——不要求至少 5 单 / 10 单 / 工作满 N 天。
 * 3. **先按周期聚合、再分名次、最后分页**。名次是**全局**的竞赛排名，
 *    不是页内序号；先切片再算名次会让第二页的第一名显示成「第 1 名」。
 */

import { earningNetAmount } from "@/lib/constants/earnings";
import type { CompanionAcceptEvent, DerivedAcceptEvent } from "@/lib/types/companionAccept";
import type { CompanionRankingBoard, CompanionRankingEntry, CompanionRankingRow } from "@/lib/types/companionRanking";
import type { Earning } from "@/lib/types/earning";
import type { Order } from "@/lib/types/order";
import type { PageResult } from "@/lib/types/common";
import type { Companion } from "@/lib/types/companion";
import type { RankingPeriod, RankingPeriodRange } from "./rankingPeriods";
import { isWithinRankingPeriod } from "./rankingPeriods";
import { isCompanionListed } from "./companions";
import { hasRefundBeenExecuted } from "./refunds";
import { formatYuan } from "@/lib/utils/format";
import { mergePageResultBy } from "./pagination";

/* ────────────────────────────── 分页（本榜独立定义） ────────────────────────────── */

/** 默认每页条数。与消费榜**数值相同但各自独立**，理由见文件头 */
export const COMPANION_RANKING_PAGE_SIZE = 20;
export const COMPANION_RANKING_MAX_PAGE_SIZE = 50;
export const COMPANION_RANKING_MAX_PAGE = 1000;

/** 前三名单独突出展示，因此这个数量在服务端与页面之间是同一个约定 */
export const COMPANION_RANKING_TOP_COUNT = 3;

/**
 * 只有**指标大于 0** 的打手进入榜单（裁定 §7）。
 *
 * 公开成常量而不是写死在过滤里：页面需要照这个规则解释「为什么我没上榜」。
 * ⚠️ 它是「大于 0」这条**唯一**的门槛，**没有**额外的最低单量要求。
 */
export const COMPANION_RANKING_MIN_METRIC = 1;

/* ────────────────────────────── 三张榜的定义 ────────────────────────────── */

/**
 * 三张榜的页签顺序。
 *
 * ⚠️ 顺序有意义：接单 → 完成 → 收入是**业务的自然流程**（先接、再做完、后结算），
 * 因此默认停在第一张（接单榜）。这不是「随便挑一个先做」——
 * 三张榜**同时上线**，默认项只影响用户第一次打开落在哪一页。
 */
export const COMPANION_RANKING_BOARDS: readonly {
  key: CompanionRankingBoard;
  label: string;
  /** 指标的中文名，页面上写说明用 */
  metricName: string;
}[] = [
  { key: "dispatch", label: "接单榜", metricName: "接单次数" },
  { key: "completion", label: "完成榜", metricName: "完成订单数" },
  { key: "income", label: "收入榜", metricName: "收入净额" },
];

/** 默认榜：接单榜（三张榜同时上线，见上） */
export const DEFAULT_COMPANION_RANKING_BOARD: CompanionRankingBoard = "dispatch";

/** 是不是一个合法的榜键。用于接口侧区分「没传」与「传了非法值」 */
export function isCompanionRankingBoard(value: unknown): value is CompanionRankingBoard {
  return value === "dispatch" || value === "completion" || value === "income";
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按「未指定」处理 */
export function readCompanionRankingBoard(raw: string | null): CompanionRankingBoard | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  return isCompanionRankingBoard(raw) ? raw : null;
}

/** 宽松规范化：非法值回到默认值（页面地址栏用） */
export function normalizeCompanionRankingBoard(raw: string | null | undefined): CompanionRankingBoard {
  return isCompanionRankingBoard(raw) ? raw : DEFAULT_COMPANION_RANKING_BOARD;
}

export function companionRankingBoardLabel(board: CompanionRankingBoard): string {
  return COMPANION_RANKING_BOARDS.find((item) => item.key === board)?.label ?? "打手榜";
}

export function companionRankingMetricName(board: CompanionRankingBoard): string {
  return COMPANION_RANKING_BOARDS.find((item) => item.key === board)?.metricName ?? "指标";
}

/* ────────────────────────────── 页面文案 ────────────────────────────── */

export const COMPANION_RANKING_PAGE_TITLE = "打手排行榜";
export const COMPANION_RANKING_LIST_TITLE = "完整榜单";
/** 顶部三名之外的名次前缀。与消费榜同一种写法，各自独立定义 */
export function formatCompanionRankNumber(rank: number): string {
  return `No.${rank}`;
}

/**
 * 奖牌徽标——**按名次取，不按位置取**。
 *
 * ⚠️ 这两件事在并列时**会分叉**，而榜单是竞赛排名（裁定 §6）：100 / 80 / 80 / 50
 * 得到的是 1 / 2 / 2 / 4。按位置发牌就会出现「并列第 2 名，一个挂银牌一个挂铜牌」——
 * 而同一张卡片上刚写着的名次文字（`No.2` / `No.2`）与徽标当场互相打脸。
 * 徽标是装饰，名次是事实：装饰不能反驳事实。
 *
 * 名次超过 3 时返回空串（1 / 1 / 1 之外还有一种：1 / 1 / 4 里的第三个人）。
 * 空白比「发一块错的牌」好。
 */
export function formatCompanionMedal(rank: number): string {
  switch (rank) {
    case 1:
      return "🥇";
    case 2:
      return "🥈";
    case 3:
      return "🥉";
    default:
      return "";
  }
}

/**
 * 指标值的展示文案（**服务端算好**，见 `CompanionRankingEntry.metricLabel`）。
 *
 * 接单 / 完成榜是**次数**（`36 单`），收入榜是**金额**（`¥2840.50`，
 * `¥` + `formatYuan` 与全仓其它金额展示同一种写法）。
 *
 * ⚠️ 单位不跟着数字走：一次接单也是「1 单」，不是「1 次」——
 * 打手榜的三种指标都落在**订单**这个单位上，混用两套量词只会让人怀疑
 * 「单」和「次」数的是不是同一件事。
 */
export function formatCompanionMetricLabel(
  board: CompanionRankingBoard,
  metricValue: number,
): string {
  if (board === "income") return `¥${formatYuan(metricValue)}`;
  return `${metricValue} 单`;
}

/**
 * 口径说明（含隐私边界）。**按榜分别给**，因为三张榜数的是三种不同的东西——
 * 一句通用的说明会让用户以为三张榜是同一份数据的不同排序。
 *
 * ⚠️ 它会**原样显示在界面上**（`components/rank/CompanionRankingBoard.tsx` 直接把
 * `{result.notice}` 放进文本节点），因此这里不写 Markdown：`**粗体**` 到了界面上
 * 就是六个星号本身。强调靠词序和「一律 / 只 / 不」这些词，不靠标记。
 *
 * ⚠️ **时间基准那句不能提到公共部分**：三张榜切周期的字段**不是同一个**——
 * 接单看 `acceptedAt`、完成看 `completedAt`、收入看 `frozenAt`（见 `metricFor`）。
 * 之前放在公共部分的「时间以订单的完成时间为准」对接单榜和收入榜都是**当场就错**的：
 * 收入榜说「完成时间」勉强对得上（完成即冻结），接单榜则完全不对——一张单
 * 完全可以「这个周期接、下个周期才完成」，两句话会给出两个不同的归属。
 */
export function companionRankingNotice(board: CompanionRankingBoard): string {
  const base =
    "榜单按北京时间（UTC+8）自然时间划分周期；" +
    "指标越大名次越靠前，指标相同则并列同名次（如 100 / 80 / 80 / 50 ⇒ 1 / 2 / 2 / 4），" +
    "并列内部的先后由打手编号决定，不影响名次。只展示昵称与头像，不展示真实姓名、手机号、联系方式与任何内部分成信息。";

  switch (board) {
    case "dispatch":
      return `接单榜统计所选周期内成功接单的次数：每成功接下一单计 1 次，时间以接单成功的那一刻为准；此后的取消、换人、退款与是否完成都不回改已经发生过的接单。${base}`;
    case "completion":
      return `完成榜统计所选周期内实际完成的有效订单数：订单需已完成、由该打手实际完成服务，且没有任何一次已批准的退款（部分退款与全额退款一样不计入），时间以订单完成的那一刻为准。${base}`;
    case "income":
      return `收入榜统计所选周期内已经结算成熟、当前真正归属于打手的净收益：只统计已解冻的收益，退款冲回的部分不计入，时间以收益开始冻结的那一刻（即订单完成）为准。${base}`;
  }
}

/**
 * 空榜文案。带上榜名与周期：用户要能看出「是这张榜、这个周期没有」，
 * 而不是「榜单坏了」——三张榜一起上线时，这个区分尤其重要。
 *
 * ⚠️ 与消费榜的空态文案**分开定义**：消费榜那句说的是「没有有效消费」，
 * 打手榜说的是「没有打手产生指标」，两句话不能互换（口径不同）。
 */
export function companionRankingEmptyTitle(
  board: CompanionRankingBoard,
  periodLabel: string,
): string {
  return `${periodLabel}暂无${companionRankingBoardLabel(board)}数据`;
}

export function companionRankingEmptyDescription(board: CompanionRankingBoard): string {
  const metric = companionRankingMetricName(board);
  return `还没有打手在这个周期内产生${metric}，换个周期或换一张榜看看。`;
}

/* ────────────────────────────── 解析查询 ────────────────────────────── */

/** 解析打手榜的查询条件（分页部分与消费榜取舍一致：非法值走规范化，不报错） */
export function parseCompanionRankingQuery(params: URLSearchParams): {
  page: number;
  pageSize: number;
} {
  const rawPage = Number(params.get("page"));
  const rawSize = Number(params.get("pageSize"));

  const page =
    Number.isFinite(rawPage) && rawPage >= 1
      ? Math.min(Math.trunc(rawPage), COMPANION_RANKING_MAX_PAGE)
      : 1;

  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(Math.trunc(rawSize), COMPANION_RANKING_MAX_PAGE_SIZE)
      : COMPANION_RANKING_PAGE_SIZE;

  return { page, pageSize };
}

/* ────────────────────────────── 客户端：地址与竞态 ────────────────────────────── */

/**
 * 在查询串上写入榜键，**保留其它查询参数**（周期、分页、调试参数不能被切榜弄丢）。
 *
 * ⚠️ 它与 `rankingPeriods.ts` 的 `withRankingPeriod` 是**两个方向的同一个动作**，
 * 但**不能合并成一个泛化的 `withParam`**：那两个函数的调用点各在一个榜的页面里，
 * 合并之后「打手榜会不会改到消费榜的地址」就变成一句需要推理的话，
 * 而不是看一眼 import 就知道的事。
 */
export function withCompanionRankingBoard(search: string, board: CompanionRankingBoard): string {
  const params = new URLSearchParams(search);
  params.set("board", board);
  return `?${params.toString()}`;
}

/** 一次打手榜请求的身份：序号 + 榜 + 周期。 */
export type CompanionRankingRequest = {
  /** 自增序号，每次发起请求时更新 */
  id: number;
  board: CompanionRankingBoard;
  period: RankingPeriod;
};

/**
 * 响应是否可以写入界面。
 *
 * 快速连点页签（切榜或切周期）时，先发的请求可能后到。判据必须是
 * **序号最新** 且 **榜与周期都仍是当前选中项**：
 *
 * - 只比序号：迟到的响应虽然被挡住，但界面状态与响应内容的对应关系仍然靠约定；
 * - 只比榜与周期：快速来回切换（接单榜 → 完成榜 → 接单榜）时，
 *   第一次接单榜的迟到响应与当前状态**完全一致**，于是会被放行，
 *   把中途那次的完成榜数据……换成一份**陈旧但看起来对**的接单榜数据。
 *   两份条件一起用才能同时挡住这两种。
 *
 * 与消费榜的 `shouldApplyRankingResponse` **各自实现**：那边只有 `period` 一个维度，
 * 这边多一个 `board`，合并会把「榜」这个概念塞进一个本该只关心周期的函数里。
 */
export function shouldApplyCompanionRankingResponse(
  response: CompanionRankingRequest,
  current: CompanionRankingRequest,
): boolean {
  return (
    response.id === current.id &&
    response.board === current.board &&
    response.period === current.period
  );
}

/* ────────────────────────────── 接单事件：合并真历史与存量派生 ────────────────────────────── */

/** 接单事件的最小形状。真记录与派生记录共用它，因此聚合函数不关心来源 */
export type CompanionAcceptLike = Pick<
  CompanionAcceptEvent | DerivedAcceptEvent,
  "dispatchId" | "orderId" | "companionId" | "acceptedAt"
>;

/**
 * 把**真的被记下来的**接单事件与**存量数据里仍然可考据的那一次**合并成一份。
 *
 * ## 去重规则只有一句：**这条派单已经有记录了吗**
 *
 * 派单记录只会保留**当前**那一位接单人，因此派生出来的永远是「最后一次」。
 * 判定方式是**按 `dispatchId` 整体看**，而不是逐字段比对时间戳：
 *
 * - **有**任何一条已记录的事件 ⇒ 说明这张单的接单路径**已经被记录覆盖**
 *   （事件表从它上线那天起就在写），当前状态必然也在其中 ⇒ **不派生**；
 * - **一条都没有** ⇒ 这是一张**事件表上线之前**就已经接好的单，
 *   派单记录上那一次就是它唯一还读得出来的接单 ⇒ **派生一条**。
 *
 * 逐字段比对（`dispatchId + companionId + acceptedAt` 三元组）在正常情况下结果相同，
 * 但它多了一个会失败的假设：**派单记录上的 `acceptedAt` 必须与事件记录逐字相同**。
 * 一旦将来某处写入的时刻精度变了，同一次接单就会被数成两次——
 * 而计数错了在榜单上是**直接可见的错**。按 `dispatchId` 整体判定没有这个假设。
 *
 * ⚠️ **它是下界**：历史上真的发生过 A → B → A 的存量单，只有最后一次 A 还能派生出来。
 * 详见 `lib/types/companionAccept.ts` 的 `DerivedAcceptEvent`。
 */
export function mergeAcceptEvents(
  events: readonly CompanionAcceptLike[],
  legacy: readonly CompanionAcceptLike[],
): CompanionAcceptLike[] {
  const dispatchIdsWithRecord = new Set(events.map((event) => event.dispatchId));

  return [
    ...events,
    ...legacy.filter((event) => !dispatchIdsWithRecord.has(event.dispatchId)),
  ];
}

/* ────────────────────────────── 聚合 ────────────────────────────── */

/** 聚合与排序的输入。**全是已有的只读事实**，本函数不写任何东西 */
export type CompanionRankingSources = {
  /** 接单事件；调用方先用 `mergeAcceptEvents` 把真历史与存量派生合并好 */
  acceptEvents: readonly CompanionAcceptLike[];
  orders: readonly Order[];
  earnings: readonly Earning[];
  companions: readonly Companion[];
};

/**
 * 算一位打手在这张榜、这个周期的指标值。
 *
 * ⚠️ 三个分支**各自独立**，不共用中间结果：接单数的是**事件**、完成数的是**订单**、
 * 收入数的是**收益**，三者在退款上可以给出完全不同的答案（裁定 §8）。
 * 把「有退款就都不算」提成一条公共前置过滤，是做这件事最容易犯的错。
 */
function metricFor(
  board: CompanionRankingBoard,
  companionId: string,
  sources: CompanionRankingSources,
  range: RankingPeriodRange,
): number {
  switch (board) {
    case "dispatch": {
      let count = 0;
      for (const event of sources.acceptEvents) {
        if (event.companionId !== companionId) continue;
        // 取消 / 换人 / 退款 / 未完成都不回改事件，因此这里**只看事件本身**
        if (!isWithinRankingPeriod(event.acceptedAt, range)) continue;
        count += 1;
      }
      return count;
    }

    case "completion": {
      let count = 0;
      for (const order of sources.orders) {
        // 「实际由该打手完成」——看**实际履约人**，不是用户当初指定的人
        if (order.actualCompanionId !== companionId) continue;
        if (order.status !== "completed") continue;
        // ⚠️ 出过款就不计入（部分退款下 status 可能仍是 completed，因此这一条不能省）
        if (hasRefundBeenExecuted(order)) continue;
        if (!isWithinRankingPeriod(order.completedAt, range)) continue;
        count += 1;
      }
      return count;
    }

    case "income": {
      let sum = 0;
      for (const earning of sources.earnings) {
        if (earning.companionId !== companionId) continue;
        // 只数成熟的那部分：frozen 未成熟、被冲回至 0 的自然不贡献
        if (earning.status !== "available") continue;
        // ⚠️ 周期按**冻结时刻**（= 订单完成时刻）切，理由见文件头
        if (!isWithinRankingPeriod(earning.frozenAt, range)) continue;
        // ⚠️ **净额是算出来的**：`incomeAmount` 是原始快照，退款冲回后不会变小。
        // 算式取自 `earningNetAmount()`——与「我的收益」列表同一个数，不重写第二遍
        sum += earningNetAmount(earning);
      }
      return sum;
    }
  }
}

/**
 * 聚合榜单（**服务端**）。
 *
 * 四件事按顺序做完：按榜单资格筛打手 → 各算指标 → 丢掉不达标的 → 排序。
 *
 * 第 1 步的资格门槛只有两条（裁定 §7）：**上架中** + **指标大于 0**。
 * - **上架中** = `isCompanionListed(companion)`（`enabled && removedAt === null`）。
 *   disabled / removed / banned 的打手**不进入公开排行榜**，历史统计仍保留在数据里；
 *   ⚠️ **刻意不要求 `available`**：它回答的是「此刻能不能接新单」（休息中 / 已排满），
 *   与「过去的成绩要不要公示」是两件事。
 * - **指标大于 0**，且**没有**最低单量门槛。
 *
 * `range` 是必填参数而不是可选项：漏传就会静默回退成某一种口径，周期榜最容易出的
 * 事故正是「这个页签其实返回的是累计」。累计期传入 `{ start: null }`。
 */
export function buildCompanionRankingRows(
  board: CompanionRankingBoard,
  sources: CompanionRankingSources,
  range: RankingPeriodRange,
): CompanionRankingRow[] {
  const rows: CompanionRankingRow[] = [];

  for (const companion of sources.companions) {
    if (!isCompanionListed(companion)) continue;

    const metricValue = metricFor(board, companion.id, sources, range);
    if (metricValue < COMPANION_RANKING_MIN_METRIC) continue;

    rows.push({
      companionId: companion.id,
      nickname: companion.displayName,
      avatarUrl: companion.avatarUrl,
      metricValue,
    });
  }

  return rows.sort(compareCompanionRankingRows);
}

/**
 * 排序：指标**降序** → 打手 id **升序**。
 *
 * 裁定 §6：三榜**全部**指标越大排名越高，方向不因榜而变。
 *
 * 第二步不是可有可无的「美化」，但也**必须理解它的边界**：
 * 它只决定**同值记录谁先显示**，**不改变任何人的名次**——
 * 名次由 `assignCompanionRanks` 按「值相同即并列」算出来。
 * 没有它，同值打手会随 `Array.prototype.sort` 的实现细节漂移，分页出现重复或遗漏。
 */
export function compareCompanionRankingRows(
  a: CompanionRankingRow,
  b: CompanionRankingRow,
): number {
  if (a.metricValue !== b.metricValue) return b.metricValue - a.metricValue;
  if (a.companionId === b.companionId) return 0;
  return a.companionId < b.companionId ? -1 : 1;
}

/**
 * 竞赛排名（**同值并列**）：`100/80/80/50` ⇒ `1/2/2/4`。
 *
 * 规则本身只有一句：**名次 = 排在自己前面的记录数 + 1**。
 * 因此并列的几个拿到同一个名次，而下一个人的名次**跳过**被并列占掉的位置。
 *
 * ⚠️ **必须在切片之前对全表算**：名次是**全局**的。先分页再按页内序号算，
 * 第二页的第一条会显示成「第 1 名」——那正是裁定 §6 明令禁止的
 * 「不得显示成 1/2/3/4」的另一种形态。
 *
 * ⚠️ 入参必须是**已经排好序**的行（`buildCompanionRankingRows` 的输出）。
 * 本函数不排序：它只按位置与前一个值比较，输入无序就会算出一串没有意义的数字。
 */
export function assignCompanionRanks(
  rows: readonly CompanionRankingRow[],
  board: CompanionRankingBoard,
): CompanionRankingEntry[] {
  const entries: CompanionRankingEntry[] = [];
  /** 上一条的名次。并列时沿用它，因此必须**逐条传递**，不能事后重算 */
  let previousRank = 0;

  rows.forEach((row, index) => {
    const previous = index === 0 ? null : rows[index - 1];
    // 与上一条同值 ⇒ 沿用上一条的名次（这就是并列）；否则名次 = 下标 + 1
    const rank = previous && previous.metricValue === row.metricValue ? previousRank : index + 1;
    previousRank = rank;

    entries.push(toCompanionRankingEntry(row, board, rank));
  });

  return entries;
}

/* ────────────────────────────── 分页与 DTO ────────────────────────────── */

/**
 * 行 → 公开 DTO。
 *
 * **显式挑字段**：这是裁定 §9 白名单的落点。`Companion` 上的 `userId` /
 * `applicationId` / `intro` / `gameIds` / `rankLabel` / `removedAt` 等等**一个都不进来**——
 * 它们不是「这次没写」，而是**本函数根本没有读**。测试按 key 集合精确断言。
 */
export function toCompanionRankingEntry(
  row: CompanionRankingRow,
  board: CompanionRankingBoard,
  rank: number,
): CompanionRankingEntry {
  return {
    rank,
    companionId: row.companionId,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    metricValue: row.metricValue,
    metricLabel: formatCompanionMetricLabel(board, row.metricValue),
  };
}

/** 从排好序的行里按页切片，并转成公开 DTO（名次**全局**，不是页内序号） */
export function paginateCompanionRankingRows(
  rows: readonly CompanionRankingRow[],
  board: CompanionRankingBoard,
  page: number,
  pageSize: number,
): PageResult<CompanionRankingEntry> {
  const ranked = assignCompanionRanks(rows, board);
  const start = (page - 1) * pageSize;
  const slice = ranked.slice(start, start + pageSize);

  return {
    items: slice,
    page,
    pageSize,
    total: ranked.length,
    hasMore: start + slice.length < ranked.length,
  };
}

/**
 * 「加载更多」的合并：追加 + **按名次去重**。
 *
 * ⚠️ 与消费榜不同的一点要说清楚：消费榜的名次唯一，因此按名次去重是完备的；
 * 打手榜**名次会并列**，所以「名次」在**同一页内**不再是唯一键。
 * 真正唯一的是 `companionId`——它在本榜的 DTO 上是有的（裁定 §9 允许），
 * 而且同一位打手在同一张榜上只会出现一次。因此这里按 `companionId` 去重，
 * 这比按名次更严格，也不会因为并列而误删。
 */
export function mergeCompanionRankingPage<P extends PageResult<CompanionRankingEntry>>(
  current: P,
  next: P,
): P {
  return mergePageResultBy<CompanionRankingEntry, P>(current, next, (item) => item.companionId);
}
