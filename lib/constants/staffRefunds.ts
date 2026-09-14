import { canTransitionRefund } from "@/lib/constants/adminRefunds";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import {
  REFUND_REASON_LABELS,
  REFUND_STATUSES,
  REFUND_STATUS_LABELS,
} from "@/lib/constants/refunds";
import {
  STAFF_MAX_PAGE,
  STAFF_MAX_PAGE_SIZE,
  STAFF_PAGE_SIZE,
} from "@/lib/constants/staff";
import type { OrderStatus } from "@/lib/types/order";
import type {
  RefundRequest,
  RefundStatus,
  StaffRefundAllowedActions,
  StaffRefundDetail,
  StaffRefundListItem,
} from "@/lib/types/refund";
import type { StaffUserSummary } from "@/lib/types/staff";

/**
 * 客服端「退款处理」的筛选规则、状态机结论与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与另外几个常量模块（都是纯逻辑）外没有运行时依赖：客户端组件引用它
 * 不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ 状态机**只从 `lib/constants/adminRefunds.ts` 的 `canTransitionRefund` 推导**：
 * 这里不另写一张迁移表。客服的两个动作（开始审核、驳回）是「迁移到某个状态」的别名，
 * 与管理员侧的三个动作用的是同一张表——复制一份只会让两边的合法迁移迟早不一致。
 *
 * ⚠️ 客服**没有「通过」动作**：通过会在同一次写入里把订单改成「已退款」，属于资金
 * 最终划拨，留在管理员侧。因此这里的 `StaffRefundAllowedActions` 里**没有**
 * `canApprove` 这个字段——一个恒为 false 的布尔值会被前端写成「禁用按钮」，
 * 而正确做法是这个按钮根本不存在。
 */

export const STAFF_REFUND_DETAIL_TITLE = "退款详情";

/**
 * **必须在页面上原样展示**的 Mock 标注（§退款处理 的硬要求）。
 *
 * 这句话点明两件事：客服端**没有「通过」入口**（因此本页不存在「把款批出去」的可能），
 * 而且开始审核与驳回都只改退款申请状态——不调用微信支付退款、不生成微信退款单号、
 * 不代表款项已经退回。
 */
export const STAFF_REFUND_MOCK_NOTICE =
  "Mock 审核流程，未执行真实退款：客服端只有「开始审核」与「驳回」，两者都只改退款申请状态，" +
  "不会调用微信支付退款、不生成微信退款单号，也不代表款项已经退回；" +
  "「通过」是管理员的职责，客服端没有这个入口。";

/** 列表顶部的说明：讲清楚这张列表的口径与动作后果。 */
export const STAFF_REFUND_LIST_NOTICE =
  "列表按申请时间倒序，涵盖全部用户的退款申请。退款状态与订单状态是两条独立的线：" +
  "开始审核与驳回只改退款申请，订单按原进度继续；通过退款是管理员的职责，客服端没有通过入口。";

/** 退款金额不可修改的说明（客服端）。 */
export const STAFF_REFUND_AMOUNT_NOTE =
  "退款金额取申请创建时的订单实付快照，由系统记录，客服不可修改。";

/**
 * 客服遇到「应该退」的申请时该做什么。
 *
 * 必须写出来，因为它回答的是「为什么不给我一个通过按钮」——答案是这件事涉及资金
 * 最终划拨，客服的正确做法是把它留在审核中并向上报备，而不是替平台把钱批出去。
 */
export const STAFF_REFUND_REPORT_NOTE =
  "客服没有「通过」入口：通过会在同一次写入里把订单改成「已退款」，涉及资金最终划拨，" +
  "只在管理员侧。处理完一笔申请后如果结论是「应该退」，请把它留在审核中并向上报备。";

/** 列表为空时的提示。 */
export const STAFF_REFUND_EMPTY_MESSAGE = "当前筛选下没有退款申请。";

/**
 * 列表底部的字段边界与动作位置说明。
 *
 * 两件事都要说：列表看不到原因与说明，而且**动作不在这里**——
 * 开始审核与驳回都要到详情页看全原因、说明与凭证之后才能动手。
 */
export const STAFF_REFUND_LIST_FIELDS_NOTE =
  "列表不展示退款原因、说明、凭证与审核意见；这些内容只在详情页可见，" +
  "开始审核与驳回两个动作也在详情页执行。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const STAFF_REFUND_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / reviewing / approved / rejected / cancelled";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type StaffRefundStatusFilter = RefundStatus | "all";

export const STAFF_REFUND_STATUS_FILTERS: readonly StaffRefundStatusFilter[] = [
  "all",
  ...REFUND_STATUSES,
];

export const STAFF_REFUND_STATUS_FILTER_LABELS: Record<StaffRefundStatusFilter, string> = {
  all: "全部",
  ...REFUND_STATUS_LABELS,
};

/** 默认筛选：**待审核**。这个页面的主要用途是处理待办，打开就是全部历史并不好用。 */
export const DEFAULT_STAFF_REFUND_STATUS_FILTER: StaffRefundStatusFilter = "pending";

export function isStaffRefundStatusFilter(value: string): value is StaffRefundStatusFilter {
  return (STAFF_REFUND_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readStaffRefundStatusFilter(
  raw: string | null,
): StaffRefundStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_STAFF_REFUND_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_STAFF_REFUND_STATUS_FILTER;
  return isStaffRefundStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeStaffRefundStatusFilter(raw: string | null): StaffRefundStatusFilter {
  return readStaffRefundStatusFilter(raw) ?? DEFAULT_STAFF_REFUND_STATUS_FILTER;
}

// ——————————————————————————— 状态机结论 ———————————————————————————

/**
 * 客服可执行的退款动作。
 *
 * 与管理员侧同一张迁移表，但只暴露两个动作：终态（已通过 / 已拒绝 / 已撤销）两项都是
 * false，审核中（reviewing）不能再开始审核但可以驳回。**没有 `canApprove`**。
 */
export function staffRefundAllowedActions(status: RefundStatus): StaffRefundAllowedActions {
  return {
    canStartReview: canTransitionRefund(status, "reviewing"),
    canReject: canTransitionRefund(status, "rejected"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const STAFF_REFUND_TERMINAL_NOTICE = "这笔退款申请已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const STAFF_REFUND_NOT_FOUND_MESSAGE = "退款申请不存在";
export const STAFF_REFUND_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/**
 * 幂等重放（`changed:false`）时的提示。
 *
 * ⚠️ **不能报成功**：重放意味着服务端**这一次什么都没改**。文案与同目录的
 * `STAFF_COMPLAINT_REPLAY_NOTICE` 对齐——两个工作台对同一件事说同一句话。
 */
export const STAFF_REFUND_REPLAY_NOTICE = "这笔退款申请已经按这个操作处理过了，没有重复执行。";

/**
 * 写操作**已经生效**、但随后的详情刷新失败时的提示。
 *
 * ⚠️ 这一句不能说成「操作失败」：写是真的成功了，把它报成失败会诱导客服再点一次，
 * 而第二次点击会带一个新键，撞上状态机得到一个莫名其妙的 400。
 * 它只承认「结果没取回来」，并给出唯一有意义的下一步。
 */
export const STAFF_REFUND_REFRESH_FAILED_NOTICE =
  "操作已生效，但详情刷新失败。请重新加载页面确认最新状态。";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**，否则会让人以为是自己点错了按钮。 */
export function staffRefundTransitionMessage(status: RefundStatus): string {
  return `当前状态是「${REFUND_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。**刻意没有 approve**。 */
export const STAFF_REFUND_ACTION_LABELS = {
  startReview: "开始审核",
  reject: "驳回",
} as const;

/**
 * 两个动作的二次确认文案。
 *
 * 都要说清楚一件事：它们**只改退款申请**，订单状态与消费金额都不会变。
 * 驳回那条还要说明用户会看到什么。
 */
export const STAFF_REFUND_CONFIRM_TEXTS = {
  startReview: "开始审核只把退款申请标记为「审核中」，订单状态与消费金额都不会变。确定开始？",
  reject: "驳回后用户看到的进度页会变成「未通过」，审核意见会展示给对方。订单状态与消费金额都不会变。确定驳回？",
} as const;

// ——————————————————————————— 列表查询 ———————————————————————————

/** 客服端退款列表查询条件（已解析、已校验）。 */
export type StaffRefundListQuery = {
  /** `all` 表示不限状态 */
  status: StaffRefundStatusFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它列表一致）。
 *
 * ⚠️ **只搜「退款单号 / 订单号 / 用户昵称」**，不搜退款说明与审核意见：
 * 那两段是内容不是标识，用它们搜出来的结果没人能预期；而退款说明里可能有
 * 用户写的隐私信息，把它当搜索对象等于给了一个探测入口。
 * 客服端**没有**平台展示 ID 这一路（`StaffUserSummary` 只有昵称与头像），
 * 因此与管理端少一个匹配字段。
 */
export function readStaffRefundKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildStaffRefundListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: StaffRefundStatusFilter;
}): StaffRefundListQuery {
  return {
    status: input.status,
    keyword: readStaffRefundKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), STAFF_PAGE_SIZE, STAFF_MAX_PAGE_SIZE),
  };
}

/**
 * 默认排序：申请时间倒序，同一时间按退款单号倒序兜底。
 *
 * 兜底不是可有可无的：时间相同时顺序不确定，会让同一条在第一页出现过、
 * 翻到第二页又出现一次。
 */
export function compareStaffRefunds(
  a: Pick<RefundRequest, "createdAt" | "refundNo">,
  b: Pick<RefundRequest, "createdAt" | "refundNo">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.refundNo !== b.refundNo) return a.refundNo < b.refundNo ? 1 : -1;
  return 0;
}

/** 关键词是否命中：退款单号 / 订单号 / 用户昵称 三处任一包含即可（大小写不敏感）。 */
export function staffRefundMatchesKeyword(
  input: { refundNo: string; orderNo: string; nickname: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.refundNo.toLowerCase().includes(needle) ||
    input.orderNo.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 退款申请 + 订单摘要 + 用户摘要 → 客服端列表项。**显式挑字段**。 */
export function toStaffRefundListItem(
  refund: RefundRequest,
  order: { id: string; orderNo: string; status: OrderStatus; productTitle: string },
  user: StaffUserSummary,
): StaffRefundListItem {
  return {
    id: refund.id,
    refundNo: refund.refundNo,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    // 只读展示值：它来自申请创建时的服务端快照，客服没有入口能改
    amount: refund.amount,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
    user,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status],
    productTitle: order.productTitle,
  };
}

/** 内部实体 → 客服端详情。在列表项之上补齐原因、说明、凭证、金额对照、审核信息与可执行动作。 */
export function toStaffRefundDetail(
  refund: RefundRequest,
  order: {
    id: string;
    orderNo: string;
    status: OrderStatus;
    productTitle: string;
    totalAmount: number;
  },
  user: StaffUserSummary,
  conversationOrderId: string | null,
): StaffRefundDetail {
  return {
    ...toStaffRefundListItem(refund, order, user),
    reasonKey: refund.reasonKey,
    reasonLabel: refund.reasonLabel || (REFUND_REASON_LABELS[refund.reasonKey] ?? refund.reasonKey),
    description: refund.description,
    evidence: refund.evidence,
    orderTotalAmount: order.totalAmount,
    reviewingAt: refund.reviewingAt,
    reviewedAt: refund.reviewedAt,
    reviewedBy: refund.reviewedBy,
    reviewedByRole: refund.reviewedByRole,
    reviewedByName: refund.reviewedByName,
    reviewNote: refund.reviewNote,
    cancelledAt: refund.cancelledAt,
    timeline: buildStaffRefundTimeline(refund),
    conversationOrderId,
    allowedActions: staffRefundAllowedActions(refund.status),
  };
}

/**
 * 客服端的进度时间轴。
 *
 * ⚠️ 与管理端 `buildAdminRefundTimeline()` **分开**：那两份文案都说「平台」，
 * 而客服端看到的时间轴要说清**客服**在这里面做了什么（开始审核、驳回是客服的动作）。
 * 撤销节点仍是「用户自己撤销」——客服没有替用户撤销的入口。
 *
 * 只包含**已经发生**的节点，按时间先后排列。
 */
export function buildStaffRefundTimeline(refund: RefundRequest): StaffRefundDetail["timeline"] {
  const entries: StaffRefundDetail["timeline"] = [
    {
      key: "pending",
      label: REFUND_STATUS_LABELS.pending,
      at: refund.createdAt,
      note: "用户提交了退款申请，等待客服审核",
    },
  ];

  if (refund.reviewingAt) {
    entries.push({
      key: "reviewing",
      label: REFUND_STATUS_LABELS.reviewing,
      at: refund.reviewingAt,
      note: "客服已开始审核这笔退款申请",
    });
  }
  if (refund.status === "approved" && refund.reviewedAt) {
    entries.push({
      key: "approved",
      label: REFUND_STATUS_LABELS.approved,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请已通过（Mock 审核，未执行真实退款）",
    });
  }
  if (refund.status === "rejected" && refund.reviewedAt) {
    entries.push({
      key: "rejected",
      label: REFUND_STATUS_LABELS.rejected,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请未通过",
    });
  }
  if (refund.status === "cancelled" && refund.cancelledAt) {
    entries.push({
      key: "cancelled",
      label: REFUND_STATUS_LABELS.cancelled,
      at: refund.cancelledAt,
      note: "用户自己撤销了这笔退款申请",
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}
