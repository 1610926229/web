import type { SupportEvidence } from "./evidence";
import type { OrderStatus } from "./order";
import type { AdminUserSummary } from "./user";

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
   * 用户新提交的投诉一定为 null。
   */
  handledAt: string | null;
  /**
   * 做出完结动作（解决 / 关闭）的管理者 id（`AdminAccount.id`）。
   *
   * ⚠️ 与退款同理**只记结果，不记开始处理**：`start-processing` 只把状态改成处理中，
   * 还没有结论；「谁开始看的」由审计记录回答。本字段回答的是「这次是谁给的结果」。
   */
  handledByAdminId: string | null;
  /**
   * 处理结果说明。
   *
   * 「解决」时是处理结果，「关闭」时是关闭说明——两者都是**管理者填写的平台侧结论**，
   * 因此共用这一个字段。用户提交的说明在 `description` 里，两者永不互相覆盖。
   */
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

/* ───────────────────────── 管理端投诉 DTO（P8C） ───────────────────────── */

/**
 * 管理端投诉列表项。
 *
 * ⚠️ **刻意不含**投诉正文、凭证、联系方式与处理结果：列表一次返回多条，
 * 而这三类是用户提交的原始材料。**联系方式尤其不进列表**——它只在详情页出现，
 * 且是只读的（见 `AdminComplaintDetail`）。
 */
export type AdminComplaintListItem = {
  id: string;
  complaintNo: string;
  status: ComplaintStatus;
  statusLabel: string;
  typeKey: ComplaintTypeKey;
  typeLabel: string;
  /** 关联订单 id；未关联时为 null */
  orderId: string | null;
  /** 订单号快照；未关联时为 null */
  orderNo: string | null;
  createdAt: string;
  updatedAt: string;
  user: AdminUserSummary;
};

/**
 * 服务端判定的可执行动作。全部从 `ADMIN_COMPLAINT_TRANSITIONS` 推导，
 * 终态（已处理 / 已关闭）三项都是 false。
 */
export type AdminComplaintAllowedActions = {
  canStartProcessing: boolean;
  canResolve: boolean;
  canClose: boolean;
};

/**
 * 投诉详情里的关联订单摘要。
 *
 * 只够回答「这一单是什么、现在到哪一步了」：订单号、商品标题、实付金额与当前业务状态。
 * 关联订单可能属于同一位用户但**不是当前管理员正在处理的那一单**，
 * 因此这里不带上游戏账号、备注等订单明细——那些要去订单详情页看。
 */
export type AdminComplaintOrderSummary = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  productTitle: string;
  /** 单位：分 */
  totalAmount: number;
};

/**
 * 管理端投诉详情。
 *
 * ⚠️ `description` / `evidence` / `contact` 三样是**用户提交的原始材料，只读**：
 * 管理端没有任何接口能改写它们，页面也不提供编辑入口。处理结果写在 `result` 里，
 * 与用户提交的内容各占一个字段，永不互相覆盖。
 */
export type AdminComplaintDetail = AdminComplaintListItem & {
  description: string;
  evidence: SupportEvidence[];
  contact: string;
  processingAt: string | null;
  handledAt: string | null;
  handledByAdminId: string | null;
  result: string;
  /** 关联订单摘要；未关联订单时为 null */
  orderSummary: AdminComplaintOrderSummary | null;
  timeline: ComplaintTimelineEntry[];
  allowedActions: AdminComplaintAllowedActions;
};

/** 一次处理动作的结果。`changed` 为 false 表示这是一次幂等重放。 */
export type AdminComplaintWriteResult = {
  complaintId: string;
  status: ComplaintStatus;
  statusLabel: string;
  handledAt: string | null;
  changed: boolean;
};

/** 管理端投诉列表接口一次返回的全部数据。 */
export type AdminComplaintListData = {
  items: AdminComplaintListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};
