/**
 * 鸡腿记录的类型与对外 DTO。
 *
 * ⚠️ **本阶段只记录、不结算**。鸡腿的价格、兑换比例、支付方式、打手实际到手金额与
 * 结算规则都还没有确认，因此这里**刻意不存在**任何金额字段：
 *
 * - `quantity` 是「鸡腿个数」这一原始记录值，不是金额，也不乘任何单价；
 * - 记录里只保存**支付状态**（已支付 / 待支付 / 支付失败），不保存支付金额、
 *   不保存平台抽成、不保存打手到手金额；
 * - 没有「兑换比例」这类字段，将来确认后新增字段即可，不会与现在的数据口径冲突。
 *
 * 这样处理的原因是：一旦先写下一个自造的单价或比例，界面与数据都会把它当成事实，
 * 等真实规则确认时既要改数据又要改口径。宁可只留原始记录。
 *
 * 与订单一样，关联订单与打手信息都是**记录创建那一刻的快照**：
 * 之后订单改名、打手改名换头像都不影响历史记录的展示。
 */

import type { PageResult } from "./common";
import type { OrderCompanionSnapshot } from "./order";

/**
 * 一条鸡腿记录的支付状态。
 *
 * 取值刻意只有这三个：更细的状态（退款、结算中、已结算）需要支付与结算规则确认后才能定，
 * 现在造出来只会与将来的真实状态对不上。
 */
export type TipPaymentStatus = "paid" | "pending" | "failed";

/**
 * 鸡腿记录（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律使用下面的 DTO，
 * `userId` 不会顺带泄漏出去。
 */
export type TipRecord = {
  id: string;
  userId: string;

  // —— 关联订单快照 ——
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  /** 收到鸡腿的打手快照；未绑定时为 null（页面上明确写「未绑定」） */
  companion: OrderCompanionSnapshot | null;

  /**
   * 鸡腿个数的原始记录值。
   *
   * **不是金额**：本阶段没有单价，也没有兑换比例，因此它不参与任何金额计算。
   */
  quantity: number;

  paymentStatus: TipPaymentStatus;
  /** 记录创建时间，由服务端写 */
  createdAt: string;
};

/**
 * 鸡腿记录列表项 DTO。
 *
 * **刻意不含**单价、兑换比例、支付金额、平台抽成与打手到手金额：
 * 这些规则都还没有确认，接口不能先把它们当成事实发出去。
 */
export type TipListItem = {
  id: string;
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  companion: OrderCompanionSnapshot | null;
  /** 鸡腿个数的原始记录值（不是金额） */
  quantity: number;
  paymentStatus: TipPaymentStatus;
  /** 状态的展示文案，与服务端同源，前端不自己映射 */
  paymentStatusLabel: string;
  createdAt: string;
};

/** 分页结果 + 各状态的角标（与状态筛选一起返回，前端不自己累加）。 */
export type TipPage = PageResult<TipListItem> & {
  status: TipStatusFilter;
  counts: TipStatusCounts;
};

/** 状态筛选取值：`all` 表示不限状态。 */
export type TipStatusFilter = "all" | TipPaymentStatus;

export type TipStatusCounts = {
  all: number;
  paid: number;
  pending: number;
  failed: number;
};
