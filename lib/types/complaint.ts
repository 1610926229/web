import type { SupportEvidence } from "./evidence";

/**
 * 投诉类型与对外 DTO。
 *
 * 投诉**不会自动退款，也不会修改订单状态**：它只是把事情记下来交给客服处理，
 * 订单该怎么走还怎么走。处理结果只能来自预置数据或将来后台的返回，
 * 用户端不产生、也不展示任何平台没有承诺过的结论（免单、补偿、退款等）。
 */

export type ComplaintStatus = "pending" | "processing" | "resolved" | "closed";

/** 投诉类型。取值由服务端校验，文案与浏览器共用 `lib/constants/complaints.ts`。 */
export type ComplaintTypeKey =
  | "companion_service"
  | "refund_dispute"
  | "payment_issue"
  | "platform_service"
  | "other";

/** 投诉（仓储内部类型）。 */
export type Complaint = {
  id: string;
  /** 展示用投诉单号 */
  complaintNo: string;
  userId: string;
  /** 可选关联订单；不关联时为 null，同时保留订单号快照供展示 */
  orderId: string | null;
  orderNo: string | null;

  status: ComplaintStatus;
  typeKey: ComplaintTypeKey;
  typeLabel: string;
  description: string;
  evidence: SupportEvidence[];
  /** 联系方式（选填，最多 `COMPLAINT_CONTACT_MAX_LENGTH` 字） */
  contact: string;

  createdAt: string;
  updatedAt: string;
  /** 客服开始处理的时间；还没进入处理中时为 null */
  processingAt: string | null;
  /**
   * 完结时间：已处理（resolved）与已关闭（closed）都记在这里，未完结时为 null。
   * 用户新提交的投诉一定为 null——本阶段没有任何用户端的处理入口。
   */
  handledAt: string | null;
  /** 处理结果说明；用户新提交的为空，只展示预置或将来后台返回的内容 */
  result: string;
};

/**
 * 投诉列表项 DTO。
 *
 * **刻意不含**投诉说明、凭证、联系方式与处理结果：列表一次返回多条，
 * 这些内容只在详情页展示。
 */
export type ComplaintListItem = {
  id: string;
  complaintNo: string;
  status: ComplaintStatus;
  typeLabel: string;
  /** 关联订单号；未关联时为 null */
  orderNo: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * 订单详情里的投诉摘要。
 *
 * **刻意不含**投诉说明、凭证、联系方式与处理结果：订单详情只需要知道「有没有投诉、到哪一步了」，
 * 完整内容要去投诉详情页看（那里会再校验一次归属）。
 *
 * 摘要只在**有过投诉**时存在（没有投诉时整项为 null），因此 `latest*` 三个字段不带 null：
 * 否则每个用到它的页面都要再判一次「最新的那条会不会不存在」，而那是不可能出现的状态。
 */
export type OrderComplaintSummary = {
  count: number;
  latestId: string;
  latestStatus: ComplaintStatus;
  latestStatusLabel: string;
  latestCreatedAt: string;
};

/** 投诉进度节点：只包含**已经发生**的节点。 */
export type ComplaintTimelineEntry = {
  key: ComplaintStatus;
  label: string;
  at: string;
  note: string;
};

/** 投诉详情 DTO。 */
export type ComplaintDetail = ComplaintListItem & {
  orderId: string | null;
  typeKey: ComplaintTypeKey;
  description: string;
  evidence: SupportEvidence[];
  contact: string;
  processingAt: string | null;
  handledAt: string | null;
  result: string;
  timeline: ComplaintTimelineEntry[];
};
