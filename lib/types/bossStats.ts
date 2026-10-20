/**
 * 「老板数据面板」的对外 DTO（P1-7）。
 *
 * 「老板」是本项目对**下单用户**的既有称呼（见 `lib/constants/mockUsers.ts` 的
 * 「老板A」、`lib/mocks/fixtures/levelSeed.ts` 的等级名「普通老板」），
 * 因此本面板是**用户看自己的**数据，不是管理端的用户画像。
 *
 * ## 最小 DTO（沿用 `toOrderDetail` 的同一条纪律）
 *
 * 字段**只放页面真的要显示的东西**。具体地，这里**刻意没有**：
 *
 * - 订单明细（标题 / 备注 / 游戏账号 / 时间线）——页面要的是「几个数」，不是「我买过什么」；
 * - `companionRateSnapshot` / `companionBaseIncome` / `clubNetIncome` —— 分账与平台账，
 *   用户端没有展示位置（`lib/services/orders.ts` 对 `clubNetIncome` 已有同样处置）；
 * - 打手手机号 / 微信号 / 内部管理字段（`enabled` / `removedAt` / `sortOrder` / `linkedUserId`）；
 * - 「最近一次服务时刻」这类**只用于排序**的稳定键——排序在服务端已完成，
 *   下发它只会多一个能被误用的字段。
 *
 * 唯一带着的内部标识是 `companionId`，理由见 `BossCompanionStat`。
 */

/** 常玩游戏的一行。 */
export type BossGameStat = {
  /**
   * 游戏名。**来自订单的 `gameName` 历史快照**（产品裁定 `D5`），
   * 已经过 `trim`，**不做**模糊匹配与别名合并。
   */
  name: string;
  /** 该游戏下**已完成**的订单数（产品裁定 `D6`：按次数，不按金额）。 */
  orderCount: number;
};

/** 常用打手的一行。 */
export type BossCompanionStat = {
  /**
   * 打手 id。
   *
   * ⚠️ 它**不是**新泄露：订单列表接口早就在每一个列表项里返回
   * `companion: { id, name, avatarUrl }`（`lib/services/orders.ts` 的 `toOrderListItem`）。
   * 这里保留它只是为了给列表一个**稳定 key**（名字可能重名），
   * 与 `lib/types/companionRanking.ts` 的公开排行 DTO 同一处置。
   */
  companionId: string;
  /** 用户可见的名字快照。取**最近一次真实服务**时那一份（产品裁定 `D9`）。空串表示历史脏数据缺快照。 */
  name: string;
  /** 用户可见的头像快照，同上。 */
  avatarUrl: string;
  /** 该打手**真实进入 `serving`** 的次数（产品裁定 `D7` / `D8`：按频次，不按金额）。 */
  serviceCount: number;
};

/**
 * 老板数据面板的完整摘要（**一个聚合 DTO 供五个指标共用**）。
 *
 * ⚠️ 金额一律是**分**（整数），由页面统一用现有金额组件 / formatter 展示
 * （产品裁定 `D12`：不另造格式）。本轮不提供任何趋势 / 图表字段。
 */
export type BossStatsSummary = {
  /**
   * 累计订单数（`D1`）：本人**历史上成功创建的 Order 数量**。
   * ⚠️ 与「有效消费订单数」**不同**——退款**不**减少它。
   */
  orderCount: number;
  /**
   * 累计消费金额（`D1`/`R1`/`R2`）：**与消费等级、消费排行榜同一口径**，
   * 即 `Σ max(0, actualPaidAmount − refundedAmount)`，只看 `completed`。
   */
  totalSpendAmount: number;
  /**
   * 最近 30 天消费（`D2`/`D3`/`D4`）：**UTC+8 自然日**窗口内**完成**的订单的净留存金额之和。
   * `D4`：窗口只认 `completedAt`，金额实时反映净留存；窗口外的订单**不会**因为今天退款而变成负数。
   */
  recent30dSpendAmount: number;
  /** 常玩游戏 Top N（`D5`/`D6`）。无数据时为空数组——**不是** null。 */
  recentGames: BossGameStat[];
  /** 常用打手 Top N（`D7`/`D8`/`D9`）。无数据时为空数组。 */
  recentCompanions: BossCompanionStat[];
  /** 金额类指标的口径说明（用户可见，必须原样展示）。 */
  spendNotice: string;
  /** 常玩游戏的口径说明。 */
  gameNotice: string;
  /** 常用打手的口径说明。 */
  companionNotice: string;
};
