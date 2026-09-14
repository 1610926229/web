import type { ActorRole } from "./actor";
import type { SupportEvidence } from "./evidence";
import type { OrderStatus } from "./order";
import type { StaffUserSummary } from "./staff";
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
   * 做出审核结果（通过 / 拒绝）的账号 id。
   *
   * ⚠️ **只记结果，不记开始审核**：`start-review` 只是把状态改成审核中，
   * 还没有任何结论，「谁开始看的」由审计记录回答（审计每条都有 `actorId`）。
   * 这里的字段回答的是另一个问题——「这笔退款是谁批的」，它要跟着业务记录长期存在。
   *
   * ⚠️ 这个 id 可能是 `AdminAccount.id`（管理员批的），也可能是 `StaffAccount.id`
   * （客服驳回的）——**必须连 `reviewedByRole` 一起读**才知道该去哪张表查。
   * 单独存一个字符串是 P8C 的做法，那时只有管理员会写它；P8D-2 起不再成立。
   */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；还没出结果时为 null */
  reviewedByRole: ActorRole | null;
  /**
   * 出结果时那个账号的显示名快照；还没出结果时为 null（管理员写入时也是 null）。
   *
   * ⚠️ 记快照而不是渲染时现查，理由与消息的 `senderName` 完全一致：
   * 客服账号被停用或软删除之后，这条退款记录仍然显示得出当时是谁批的。
   */
  reviewedByName: string | null;
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
  /** 做出审核结果的账号 id；未审核完成时为 null。可能是管理员，也可能是客服 */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；未审核完成时为 null */
  reviewedByRole: ActorRole | null;
  /** 审核人显示名快照；未审核完成或由管理员写入时为 null */
  reviewedByName: string | null;
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

/* ───────────────────────── 客服端退款 DTO（P8D-2） ───────────────────────── */

/**
 * 客服端的退款列表项。
 *
 * ⚠️ **与 `AdminRefundListItem` 同形，但刻意是两个类型**。
 * 共用一份类型的话，「管理端给列表加一个字段」与「这个字段该不该给客服看」
 * 会变成同一个改动——而它们本该是两次判断。字段表分开之后，
 * 管理端加字段不会顺带进客服响应，客服端要加字段也得在这里显式写一行。
 *
 * ⚠️ 「同形」是**当下的事实**而不是承诺：这里列出的每一项都是客服处理退款
 * 确实要用的（单号用来核对、状态用来筛选、金额与订单摘要用来判断、用户摘要用来对话）。
 * 管理端列表里将来出现的「内部备注」「审核人分布」这类字段不会自动跟过来。
 */
export type StaffRefundListItem = {
  id: string;
  refundNo: string;
  status: RefundStatus;
  statusLabel: string;
  /** 单位：分。整单退款，等于申请创建时的订单实付快照。**只读**，客服没有修改入口 */
  amount: number;
  createdAt: string;
  updatedAt: string;
  user: StaffUserSummary;
  orderId: string;
  orderNo: string;
  /** 订单**当前**的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  productTitle: string;
};

/**
 * 客服可执行的退款动作。**只有两个，而且这是刻意的。**
 *
 * | 动作 | 状态迁移 | 客服 | 为什么 |
 * | --- | --- | --- | --- |
 * | 开始审核 | `pending → reviewing` | ✅ | 只是认领，不改订单、不动钱 |
 * | 驳回 | `pending \| reviewing → rejected` | ✅ | 只写退款记录，订单按原进度继续 |
 * | **通过** | `pending \| reviewing → approved` | ❌ | **会在同一次写入里把订单改成「已退款」** |
 *
 * ⚠️ 「通过」是**唯一会改动订单、也是唯一代表平台承诺退钱**的动作，
 * 因此它留在管理员侧（§五：涉及真实资金最终划拨的动作不擅自赋权给客服）。
 * 客服处理完一笔申请后如果结论是「应该退」，正确的做法是把它留在审核中并上报，
 * 而不是替平台把钱批出去——本阶段没有真实退款通道，但状态机上的边界要先立住。
 *
 * ⚠️ 这里**没有** `canApprove: false` 这种字段：一个恒为 false 的布尔值会被
 * 前端写成「禁用按钮」，而正确做法是这个按钮根本不存在（文案由常量层给出）。
 */
export type StaffRefundAllowedActions = {
  canStartReview: boolean;
  canReject: boolean;
};

/**
 * 客服端退款详情。
 *
 * 比列表项多出：退款原因、说明、凭证、金额对照、审核信息、进度时间轴、
 * 服务端判定的可执行动作，以及**关联会话入口**。
 */
export type StaffRefundDetail = StaffRefundListItem & {
  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  /**
   * 原订单实付金额（单位：分）。
   *
   * ⚠️ 本阶段退款一律是**整单退款**（见 `lib/services/refunds.ts`），
   * 因此它与 `amount` 在构造上必然相等。两个都留着，是因为页面上要回答的是
   * 两个不同的问题——「这一单原来多少钱」与「这次申请退多少」——
   * 用同一个数字回答时读者无从确认它们本来就是一回事。
   */
  orderTotalAmount: number;

  /** 开始审核时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未完成时为 null */
  reviewedAt: string | null;
  /** 做出审核结果的账号 id；未审核完成时为 null */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；未审核完成时为 null */
  reviewedByRole: ActorRole | null;
  /** 审核人显示名快照；未审核完成或由管理员写入时为 null */
  reviewedByName: string | null;
  reviewNote: string;
  cancelledAt: string | null;
  timeline: RefundTimelineEntry[];

  /**
   * 这笔退款关联订单在工作台里的会话。
   *
   * ⚠️ 有值时它一定是**已经存在的订单 id**（页面据此链到
   * `/staff/conversations/[orderId]`），因此不会因为点进去而凭空建出一个会话。
   * 没有沟通记录时为 null，页面就不给这个入口——而不是给一个点进去 404 的链接。
   */
  conversationOrderId: string | null;

  allowedActions: StaffRefundAllowedActions;
};

/**
 * 一次客服审核动作的结果。
 *
 * ⚠️ 与管理端的 `AdminRefundWriteResult` 分开：那个类型带着 `orderStatus` /
 * `orderChanged` 两个字段，而客服的两个动作**都不会动订单**——把它们抄过来，
 * 只会让客服页面以为自己需要处理「订单变了没有」这件事。
 */
export type StaffRefundWriteResult = {
  refundId: string;
  status: RefundStatus;
  statusLabel: string;
  reviewedAt: string | null;
  /** 这一次是否真的改动了退款申请（幂等重放为 false） */
  changed: boolean;
};

/** 客服端退款列表接口一次返回的全部数据。 */
export type StaffRefundListData = {
  items: StaffRefundListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};
