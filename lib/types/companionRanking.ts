import type { PageResult } from "@/lib/types/common";
import type { RankingPeriod } from "@/lib/constants/rankingPeriods";

/**
 * 打手排行榜（Companion Ranking）的类型（P1-5）。
 *
 * ## 为什么与 `lib/types/ranking.ts` **分文件**，而不是加在它里面
 *
 * 产品裁定（`rounds/P1-5/02-decisions.md` §10）写明：
 * **「Companion Ranking 与 User Consumption Ranking 必须是两个独立业务维度」**，
 * 且现有消费榜的「我的排名」逻辑**继续保留、不得删改**。
 *
 * 把两套类型放进同一个文件，最容易发生的退化就是「顺手复用」：
 * 打手榜借用 `ConsumptionRankingPage` 的 `me` / `viewerLoggedIn` 字段，
 * 或者消费榜借用打手榜的 `board` 字段——一旦共享，两边就再也无法独立演进。
 * **分文件让「隔离」成为一条文件边界**，reviewer 与测试都不用靠断言去猜。
 *
 * ## 一轮三榜，不是三套接口
 *
 * 三张榜的**形状完全相同**（名次 + 打手公开信息 + 一个指标值），
 * 差别只在**指标怎么算**与**单位怎么显示**。因此只有一个 DTO，
 * 用 `board` 字段说明这是哪一张榜，而不是三个几乎相同的类型。
 */

/**
 * 三张榜的键。
 *
 * ⚠️ 与 `需求功能点进度表.md` 的分项**不是一一对应**——那张表按功能点记账，
 * 三张榜在它里面是 185 / 186 / 187 三行；这里只是把同一件事的三种指标收进一个联合类型。
 * P2 的综合榜 / 完成率 / 评价 / 投诉率**不在这个联合里**，且**不得**被读成"已覆盖"。
 */
export type CompanionRankingBoard = "dispatch" | "completion" | "income";

/**
 * 榜单内部的一行（**不进任何 DTO**）。
 *
 * 它带 `companionId`——公开 DTO 也带（裁定 §9 允许，用于跳公开详情页），
 * 但这个内部行还会参与排序兜底，因此两者**不是**同一层：
 * 排序用的稳定键是内部概念，公开 DTO 只是把 `companionId` 顺带发出去。
 */
export type CompanionRankingRow = {
  companionId: string;
  nickname: string;
  avatarUrl: string;
  /** 指标值。接单 / 完成榜是**次数**（整数），收入榜是**金额（分）**（整数） */
  metricValue: number;
};

/**
 * 榜单的一个条目（**公开 DTO**）。
 *
 * ## 字段是白名单，不是「尽量少给」
 *
 * 裁定 §9：「公开 DTO / UI **只展示** `rank`、`companionId`、`avatar`、`nickname`、
 * `metricValue`、`metricLabel`」，并逐项列出**不得公开**的内容：
 * `realName`、`phone`、微信号、`companionRate`、内部分账比例、审核资料、ban reason、
 * 敏感后台状态。
 *
 * 因此这里的键集合由测试**精确钉死**（多一个键就要红），而不是靠「我们不会写上去」
 * 这种约定。⚠️ 值得单独说一句的是 `companionRate`（打手分成比例，万分比）：
 * 它是**平台与打手之间的商业条款**，仓库里已有「上线前从用户端移除」的技术债记录
 * （见 `memory` 中 `companion-rate-bp-browser-exposure`），打手榜**绝不能**再把它带出去。
 *
 * ⚠️ **`avatar` 在这个仓库里叫 `avatarUrl`**：`RankingEntry`（消费榜）、
 * `OrderCompanionSnapshot`、`Companion` 三处都用 `avatarUrl`。裁定给的是字段
 * **语义**（头像）而不是拼写，因此沿用仓库统一的名字——同一个概念在全仓只有一个名字，
 * 否则前端要维护两套映射。
 */
export type CompanionRankingEntry = {
  /** 业务名次。同指标值**并列**（竞赛排名：`100/80/80/50` ⇒ `1/2/2/4`） */
  rank: number;
  /**
   * 打手 id（`Companion.id`）。
   *
   * 裁定 §9 允许它出现，「仅作为公开详情跳转需要时」。
   * ⚠️ 它**不是**内部标识：`Companion.id` 本来就是公开的
   * （`/companions/[id]` 是游客可达的公开页面），公开订单快照
   * `OrderCompanionSnapshot.id` 也是它。因此带上它不泄露任何新东西，
   * 而**去掉**它就无法从榜单点进打手详情。
   */
  companionId: string;
  nickname: string;
  avatarUrl: string;
  /**
   * 指标原始值：接单 / 完成榜是次数，收入榜是**分**。
   *
   * ⚠️ 与 `metricLabel` **同时给出**，且两者必须同源：
   * `metricValue` 给程序（排序、测试、将来做对比），`metricLabel` 给人（已格式化）。
   * 只有一个的话，要么前端自己格式化金额（两个地方各算一遍，迟早不一致），
   * 要么测试只能去比对一句中文文案。
   */
  metricValue: number;
  /** 已经格式化好的展示值，如 `36 单` / `¥2840.50`。**由服务端算好**，见上 */
  metricLabel: string;
};

/**
 * 榜单的一页（**公开 DTO**）。
 *
 * ⚠️ **刻意没有 `me` / `viewerLoggedIn`**：裁定 §10 明写 P1-5 第一版
 * **不做「我的排名」**。消费榜那两个字段**继续保留在它自己的类型里**，
 * 不迁移到这里——需要「我的排名」时是**将来**的事，届时再定义，
 * 而不是现在先留一个恒为 null 的字段（那会让人以为功能已经在了）。
 */
export type CompanionRankingPage = PageResult<CompanionRankingEntry> & {
  /** 这是哪一张榜 */
  board: CompanionRankingBoard;
  /** 榜单中文名，如「接单榜」 */
  boardLabel: string;
  /** 指标的中文名，如「接单次数」——给页面写说明用，不让前端自己拼 */
  metricName: string;
  period: RankingPeriod;
  periodLabel: string;
  /** 榜单生成时刻（ISO）。取数那一刻，不是页面渲染时刻 */
  generatedAt: string;
  /** 周期起点；累计榜（`all`）为 null，含义是「不限起始时间」 */
  rangeStart: string | null;
  /** 周期终点（ISO，左闭右开） */
  rangeEnd: string;
  /** 口径说明（含隐私边界），由服务端给 */
  notice: string;
};
