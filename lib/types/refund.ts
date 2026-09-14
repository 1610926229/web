import type { SupportEvidence } from "./evidence";
import type { OrderStatus } from "./order";
import type { AdminUserSummary } from "./user";

/**
 * 退款申请类型与对外 DTO。
 *
 * **退款申请与订单状态是两条独立的线**，这是本阶段最容易搞错的一点：
 * - 提交申请**不会**把订单改成 `refunded`，订单继续保留原业务状态（已付款 / 已接单 / 护航中），
 *   只是在页面上同时显示「退款审核中」；
 * - 只有将来客服或管理者审核通过后，订单才进入 `refunded`（当前阶段没有这个入口，
 *   用户端不能自行批准或拒绝）。
 *
 * 因此「订单状态」回答的是「这一单现在进行到哪一步」，「退款状态」回答的是
 * 「退款这件事现在进行到哪一步」，两者不能互相推导，只能各自存储、各自展示。
 *
 * 金额一律是「分」为单位的整数，且由服务端按订单可退金额写入——用户不能自行填写或修改。
 */

export type RefundStatus = "pending" | "reviewing" | "approved" | "rejected" | "cancelled";

/** 退款原因类型。取值由服务端校验，文案与浏览器共用 `lib/constants/refunds.ts`。 */
export type RefundReasonKey =
  | "service_not_delivered"
  | "service_quality"
  | "schedule_conflict"
  | "duplicate_payment"
  | "other";

/** 退款申请（仓储内部类型）。页面与接口一律使用下面的 DTO。 */
export type RefundRequest = {
  id: string;
  /** 展示用退款单号 */
  refundNo: string;
  userId: string;
  orderId: string;
  status: RefundStatus;
  /** 单位：分。整单退款，等于订单实付金额 */
  amount: number;

  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  createdAt: string;
  updatedAt: string;
  /** 客服开始审核的时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未审核完成时为 null */
  reviewedAt: string | null;
  /**
   * 做出审核结果（通过 / 拒绝）的管理者 id（`AdminAccount.id`）。
   *
   * ⚠️ **只记结果，不记开始审核**：`start-review` 只是把状态改成审核中，
   * 还没有任何结论，「谁开始看的」由审计记录回答（审计每条都有 `adminId`）。
   * 这里的字段回答的是另一个问题——「这笔退款是谁批的」，它要跟着业务记录长期存在。
   */
  reviewedBy: string | null;
  /** 处理结果说明；用户新提交的申请为空，拒绝时必填 */
  reviewNote: string;
  cancelledAt: string | null;
};

/**
 * 订单详情里的退款摘要。
 *
 * **刻意不含**退款原因、说明、凭证与处理结果：订单详情只需要知道「有没有退款、到哪一步了」，
 * 完整内容要去退款详情页看（那里会再校验一次归属）。
 */
export type RefundSummary = {
  id: string;
  status: RefundStatus;
  /** 单位：分 */
  amount: number;
  createdAt: string;
};

/** 退款进度节点：只包含**已经发生**的节点。 */
export type RefundTimelineEntry = {
  key: RefundStatus;
  label: string;
  at: string;
  note: string;
};

/**
 * 退款申请详情 DTO：在摘要之上补齐详情页所需字段，并带上关联订单快照。
 *
 * 关联订单信息取自订单自己的快照（商品名、规格、实付金额），
 * 因此商品改名下架不影响历史退款记录的展示。
 */
export type RefundDetail = RefundSummary & {
  refundNo: string;
  orderId: string;
  orderNo: string;
  /** 订单当前的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: string;
  orderStatusLabel: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  orderTotalAmount: number;

  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  updatedAt: string;
  reviewedAt: string | null;
  reviewNote: string;
  cancelledAt: string | null;

  timeline: RefundTimelineEntry[];

  /** 服务端给出的可执行动作，前端不自行根据状态推断权限。 */
  allowedActions: {
    /** 只有待审核（pending）可以由用户撤销 */
    canCancelRefund: boolean;
  };
};

/* ───────────────────────── 管理端退款 DTO（P8C） ───────────────────────── */

/**
 * 管理端退款列表项。
 *
 * 带上订单侧的两样摘要（订单号、订单当前业务状态、商品标题），因为客服审核时
 * 第一眼要看到的就是「这一单是什么、现在走到哪了」。
 *
 * **不含**退款原因、说明、凭证与审核意见：那些内容只在详情页展示，
 * 列表一次返回多条，没有必要把它们一起带出去。
 */
export type AdminRefundListItem = {
  id: string;
  refundNo: string;
  status: RefundStatus;
  statusLabel: string;
  /** 单位：分。整单退款，等于申请创建时的订单实付快照 */
  amount: number;
  createdAt: string;
  updatedAt: string;
  user: AdminUserSummary;
  orderId: string;
  orderNo: string;
  /** 订单**当前**的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  productTitle: string;
};

/**
 * 服务端判定的可执行动作。
 *
 * 三个动作全部从 `ADMIN_REFUND_TRANSITIONS` 推导（见 `lib/constants/adminRefunds.ts`），
 * 页面不拿状态自己写 `if`：终态（已通过 / 已拒绝 / 已撤销）三项都是 false。
 */
export type AdminRefundAllowedActions = {
  canStartReview: boolean;
  canApprove: boolean;
  canReject: boolean;
};

/** 管理端退款详情：补齐原因、说明、凭证、审核信息、进度时间轴与可执行动作。 */
export type AdminRefundDetail = AdminRefundListItem & {
  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];
  /** 开始审核时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未完成时为 null */
  reviewedAt: string | null;
  /** 做出审核结果的管理者 id；未审核完成时为 null */
  reviewedBy: string | null;
  reviewNote: string;
  cancelledAt: string | null;
  timeline: RefundTimelineEntry[];
  allowedActions: AdminRefundAllowedActions;
};

/**
 * 一次审核动作的结果。
 *
 * 带上**订单的新状态**：审核通过会同时把订单改成 `refunded`，页面据此刷新过滤栏与详情，
 * 不需要再猜「订单动了没有」。`orderChanged` 如实说明这一次是否真的动了订单——
 * 只有通过会动，开始审核与被拒绝都不会。
 */
export type AdminRefundWriteResult = {
  refundId: string;
  status: RefundStatus;
  statusLabel: string;
  orderId: string;
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  reviewedAt: string | null;
  /** 这一次是否真的改动了退款申请（幂等重放为 false） */
  changed: boolean;
  /** 这一次是否真的改动了订单（只有「通过」会） */
  orderChanged: boolean;
};

/** 管理端退款列表接口一次返回的全部数据。 */
export type AdminRefundListData = {
  items: AdminRefundListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};
