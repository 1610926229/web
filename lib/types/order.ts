/**
 * 订单类型与对外 DTO。
 *
 * 订单在**支付成功那一刻**生成，因此没有「待付款」状态；支付失败与取消只留下一条
 * 支付请求记录，不会出现在订单列表里。
 *
 * 商品名称、图片、规格名称、单价、游戏名与陪玩公开信息都是**下单那一刻的快照**：
 * 之后改价、换图、商品下架、陪玩改名，历史订单的展示与金额都不受影响。
 *
 * 金额一律是「分」为单位的整数，且**只由服务端计算写入**——客户端提交的任何金额字段都被忽略。
 *
 * ⚠️ 列表 DTO（`OrderListItem`）与详情 DTO（`OrderDetail`）是分开的两个类型，
 * 不是「详情少几个字段」的同一份：列表接口不应携带游戏 ID、备注、增值服务明细等
 * 只有详情页才需要的信息（见各自注释）。仓储返回的是完整 `Order`，转成 DTO 由
 * `lib/services/orders.ts` 负责。
 */

import type { OrderComplaintSummary } from "./complaint";
import type { ConversationStats } from "./message";
import type { RefundSummary } from "./refund";

/**
 * 用户端订单状态。
 *
 * - `paid`      已付款（下单即此状态；此时允许还没有陪玩）
 * - `accepted`  已接单（必须有陪玩）
 * - `serving`   护航中（必须有陪玩）
 * - `completed` 已完成（必须有陪玩）
 * - `refunded`  已退款（保留完整商品与金额快照）
 *
 * 状态的推进由后续阶段（接单 / 分配 / 退款）完成，本阶段不提供任何修改状态的用户端接口。
 */
export type OrderStatus = "paid" | "accepted" | "serving" | "completed" | "refunded";

/** 增值服务快照：下单时的名称与价格，之后目录改名改价不影响历史订单。 */
export type OrderAddonSnapshot = {
  id: string;
  name: string;
  /** 单位：分 */
  price: number;
};

/** 陪玩公开信息快照。未绑定陪玩时整项为 null。 */
export type OrderCompanionSnapshot = {
  id: string;
  name: string;
  avatarUrl: string;
};

/**
 * 订单（仓储内部类型）。
 *
 * 页面与接口**不直接返回本类型**：对外一律使用下面的两个 DTO，
 * 避免「列表顺手把详情字段也带上」这类越权。
 */
export type Order = {
  id: string;
  /** 展示用订单号 */
  orderNo: string;
  userId: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string;

  // —— 状态时间节点：未发生时为 null，详情页只展示已存在的节点 ——
  acceptedAt: string | null;
  servingAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;

  // —— 下单内容快照 ——
  productId: string;
  productTitle: string;
  productCoverUrl: string;
  specId: string;
  specName: string;
  /** 单位：分 */
  unitPrice: number;

  quantity: number;
  /** 游戏名快照，与商品无关地独立保存 */
  gameName: string;
  region: string;
  gameAccountId: string;
  remark: string;
  addons: OrderAddonSnapshot[];

  // —— 金额（服务端计算，单位：分）——
  /** 单价 × 数量 */
  itemsAmount: number;
  /** 增值服务合计（按单计费，不随数量变化） */
  addonsAmount: number;
  totalAmount: number;

  /**
   * 陪玩快照；未绑定时为 null。
   *
   * 「未绑定」只允许出现在 `paid`：已接单 / 护航中 / 已完成必须有陪玩，
   * 否则页面会显示成「等待接单」，与真实进度矛盾。
   */
  companionId: string | null;
  companion: OrderCompanionSnapshot | null;
};

/**
 * 订单列表项 DTO。
 *
 * **刻意不含**游戏 ID、备注、增值服务明细与单项金额：列表一次返回多条，
 * 这些字段只有详情页用得上，列表接口不应顺带返回。
 */
export type OrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  /** 下单（支付成功）时间，列表按它倒序 */
  paidAt: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  totalAmount: number;
  /** 未绑定时为 null，页面显示「等待接单」 */
  companion: OrderCompanionSnapshot | null;
};

/** 详情页的状态时间轴节点：只包含**已经发生**的节点。 */
export type OrderTimelineEntry = {
  key: OrderStatus;
  label: string;
  at: string;
};

/**
 * 订单详情页可以执行的动作。
 *
 * **由服务端给出**（见 `lib/services/orders.ts`），前端只负责按值显示或隐藏入口，
 * 不允许自己用订单状态推断——「能不能退款」既取决于订单状态，也取决于这一单有没有退款记录，
 * 前端只看状态一定会算错。写接口同样会再校验一次，按钮只是提示，不是权限。
 */
export type OrderAllowedActions = {
  canRequestRefund: boolean;
  canCancelRefund: boolean;
  canOpenConversation: boolean;
  canSubmitComplaint: boolean;
};

/**
 * 订单详情 DTO：在列表项之上补齐详情页所需字段。
 *
 * 游戏 ID 属于用户订单信息，只在这里出现，且只返回给订单所属用户。
 *
 * 三个售后摘要都是**摘要**：只回答「有没有、到哪一步了」，原因说明、凭证、投诉描述、
 * 消息正文都不在这里——那些内容要进对应的详情页看。列表 DTO 更是一个都不带。
 */
export type OrderDetail = OrderListItem & {
  createdAt: string;
  gameName: string;
  region: string;
  gameAccountId: string;
  remark: string;
  /** 单位：分 */
  unitPrice: number;
  itemsAmount: number;
  addonsAmount: number;
  addons: OrderAddonSnapshot[];
  /** 已发生的状态节点，按时间先后排列 */
  timeline: OrderTimelineEntry[];

  /** 这一单的退款申请摘要；没有申请过为 null */
  refundSummary: RefundSummary | null;
  /** 这一单的投诉摘要；没有投诉过为 null */
  complaintSummary: OrderComplaintSummary | null;
  /** 这一单的订单沟通摘要；没有会话为 null */
  conversationSummary: ConversationStats | null;
  allowedActions: OrderAllowedActions;
};
