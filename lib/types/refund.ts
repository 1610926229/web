import type { SupportEvidence } from "./evidence";

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
  /** 审核完成时间（通过或拒绝）；未审核完成时为 null（本阶段用户端不产生该时间） */
  reviewedAt: string | null;
  /** 处理结果说明；预置数据可能有，用户新提交的申请为空 */
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
