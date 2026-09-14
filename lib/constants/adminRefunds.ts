import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  REFUND_REASON_LABELS,
  REFUND_STATUSES,
  REFUND_STATUS_LABELS,
} from "@/lib/constants/refunds";
import type { OrderStatus } from "@/lib/types/order";
import type {
  AdminRefundAllowedActions,
  AdminRefundDetail,
  AdminRefundListItem,
  RefundRequest,
  RefundStatus,
} from "@/lib/types/refund";
import type { AdminUserSummary } from "@/lib/types/user";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「退款审核」的筛选规则、状态机与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与另外几个常量模块（都是纯逻辑）外没有运行时依赖：客户端组件引用它
 * 不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ **退款状态与订单状态是两条独立的线**，管理端也不例外：
 * `start-review` 与 `reject` 都**只改退款申请**，订单按原进度继续；
 * 只有 `approve` 会同时把订单改成 `refunded`，而且必须与退款写入在同一段同步区段里完成
 * （实现见 `lib/data/adminRefundTransaction.ts`）。
 *
 * 四条规则写在这里，是本阶段新增的**唯一**落点：
 *
 * 1. **状态机**：`pending → reviewing | approved | rejected`；
 *    `reviewing → approved | rejected`；`approved` / `rejected` / `cancelled` 是**终态**。
 * 2. **可执行动作由服务端给出**：`adminRefundAllowedActions()` 从迁移表推导，页面不自己写 `if`。
 * 3. **拒绝必须填写审核意见**，通过不需要理由（规则复用入驻审核那一份，见文件末尾）。
 * 4. **金额不可修改**：`amount` 取申请创建时的订单实付快照，管理端**没有任何入口**能改它——
 *    DTO 里它是只读展示值，写接口的请求体里根本没有接收金额的字段。
 */

export const ADMIN_REFUND_LIST_TITLE = "退款审核";
export const ADMIN_REFUND_DETAIL_TITLE = "退款审核详情";

/** 列表默认每页条数。后台是 PC 宽屏，比用户端一页多放几条。 */
export const ADMIN_REFUND_PAGE_SIZE = 20;
export const ADMIN_REFUND_MAX_PAGE_SIZE = 100;
export const ADMIN_REFUND_MAX_PAGE = 1000;

/**
 * **必须在页面上原样展示**的 Mock 标注（§退款审核 的硬要求）。
 *
 * 这一句不是装饰：审核通过之后页面上会出现「已通过」，没有这句话，
 * 看到的人（无论是运营还是用户）都可能以为钱已经退回去了。
 * 本阶段的通过只是把状态改到位，**没有调用任何真实退款接口，也没有微信退款单号**。
 */
export const ADMIN_REFUND_MOCK_NOTICE =
  "Mock 审核流程，未执行真实退款：通过只意味着平台侧审核通过并把退款申请与订单状态改到位，" +
  "不会调用微信支付退款、不生成微信退款单号，也不代表款项已经真实退回。";

/** 列表顶部的说明：讲清楚这张列表的口径与动作后果。 */
export const ADMIN_REFUND_LIST_NOTICE =
  "列表按申请时间倒序，涵盖全部用户的退款申请。退款状态与订单状态是两条独立的线：" +
  "开始审核与拒绝只改退款申请，订单按原进度继续；只有通过会同时把订单改成「已退款」。";

/** 退款金额不可修改的说明（管理端）。 */
export const ADMIN_REFUND_AMOUNT_NOTE =
  "退款金额取申请创建时的订单实付快照，由系统记录，管理端不可修改。";

/**
 * 通过之后消费侧会怎样。
 *
 * 这段话必须写出来，因为它回答的是「通过了要不要再去改用户的消费金额」——
 * 答案是不用，也不许：订单变成 `refunded` 之后就不再计入累计有效消费，
 * 消费等级与周期排行榜会自然地把它排除（口径见 `lib/constants/levels.ts`）。
 */
export const ADMIN_REFUND_CONSUMPTION_NOTICE =
  "通过后订单变为「已退款」，不再计入累计有效消费，消费等级与周期排行榜会自动排除这一单；" +
  "平台不会改动用户记录上的任何累计字段。";

/** 列表为空时的提示。 */
export const ADMIN_REFUND_EMPTY_MESSAGE = "当前筛选下没有退款申请。";

/**
 * 列表底部的字段边界与动作位置说明。
 *
 * 两件事都要说：列表看不到原因与说明，而且**审核动作不在这里**——
 * 列表只看得见单号与金额，闭着眼睛点「通过」的后果是一笔订单被退款。
 */
export const ADMIN_REFUND_LIST_FIELDS_NOTE =
  "列表不展示退款原因、说明、凭证与审核意见；这些内容只在详情页可见，三个审核动作也在详情页执行。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const ADMIN_REFUND_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / reviewing / approved / rejected / cancelled";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type AdminRefundStatusFilter = RefundStatus | "all";

export const ADMIN_REFUND_STATUS_FILTERS: readonly AdminRefundStatusFilter[] = [
  "all",
  ...REFUND_STATUSES,
];

export const ADMIN_REFUND_STATUS_FILTER_LABELS: Record<AdminRefundStatusFilter, string> = {
  all: "全部",
  ...REFUND_STATUS_LABELS,
};

/**
 * 默认筛选：**待审核**。
 *
 * 与入驻审核同理：这个页面的主要用途是处理待办，「打开就是全部历史」并不好用。
 * 已撤销的申请也进列表（可以筛、但不默认显示）——用户撤销之后客服仍然要能查到
 * 「这一单为什么没有退款记录」，而那不是平台的工作量。
 */
export const DEFAULT_ADMIN_REFUND_STATUS_FILTER: AdminRefundStatusFilter = "pending";

export function isAdminRefundStatusFilter(value: string): value is AdminRefundStatusFilter {
  return (ADMIN_REFUND_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readAdminRefundStatusFilter(
  raw: string | null,
): AdminRefundStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_REFUND_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_REFUND_STATUS_FILTER;
  return isAdminRefundStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminRefundStatusFilter(raw: string | null): AdminRefundStatusFilter {
  return readAdminRefundStatusFilter(raw) ?? DEFAULT_ADMIN_REFUND_STATUS_FILTER;
}

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 合法迁移表。**这是退款状态机唯一的定义处。**
 *
 * 与 §退款审核 逐条对应：
 * - `pending → reviewing | approved | rejected`（可以直接批，也可以先开始审核）；
 * - `reviewing → approved | rejected`；
 * - `approved` / `rejected` / `cancelled` 是终态，从终态出发没有任何合法迁移。
 *
 * 终态写空数组而不是省略：`Record` 要求每个状态都出现，
 * 将来新增一个状态时，漏掉它的迁移规则会直接编译不过。
 *
 * ⚠️ **没有 `cancelled` 的入边**：撤销是用户自己的动作（`POST /api/refunds/[id]/cancel`），
 * 管理后台不能替用户撤销，因此它的入边是空的——不是「暂时没做」，是刻意留白。
 */
export const ADMIN_REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  pending: ["reviewing", "approved", "rejected"],
  reviewing: ["approved", "rejected"],
  approved: [],
  rejected: [],
  cancelled: [],
};

/** 这次迁移是否合法。`from === to` 一律不合法（那不是一个「迁移」）。 */
export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return ADMIN_REFUND_TRANSITIONS[from].includes(to);
}

/**
 * 服务端判定的可执行动作。三个动作都是「迁移到某个状态」的别名，
 * 因此全部从 `ADMIN_REFUND_TRANSITIONS` 推导：终态三项都是 false。
 */
export function adminRefundAllowedActions(status: RefundStatus): AdminRefundAllowedActions {
  return {
    canStartReview: canTransitionRefund(status, "reviewing"),
    canApprove: canTransitionRefund(status, "approved"),
    canReject: canTransitionRefund(status, "rejected"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const ADMIN_REFUND_TERMINAL_NOTICE = "这笔退款申请已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const ADMIN_REFUND_NOT_FOUND_MESSAGE = "退款申请不存在";
export const ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**，否则会让人以为是自己点错了按钮。 */
export function adminRefundTransitionMessage(status: RefundStatus): string {
  return `当前状态是「${REFUND_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。 */
export const ADMIN_REFUND_ACTION_LABELS = {
  startReview: "开始审核",
  approve: "通过",
  reject: "拒绝",
} as const;

/**
 * 三个动作的二次确认文案。
 *
 * 通过那条要**说清楚会发生什么**：它会同时改动退款申请与订单两处，
 * 而且订单一旦变成已退款就不再计入累计有效消费。拒绝那条要说清楚用户会看到什么。
 */
export const ADMIN_REFUND_CONFIRM_TEXTS = {
  startReview: "开始审核只把退款申请标记为「审核中」，订单状态与消费金额都不会变。确定开始？",
  approve:
    "通过后会在同一次写入里完成三件事：退款申请变为「已通过」、记录审核人与意见、订单变为「已退款」。" +
    "订单将不再计入用户的累计有效消费，消费等级与排行榜会排除这一单。" +
    "这是 Mock 审核，不会执行真实退款，也不代表款项已退回。确定通过？",
  reject: "拒绝后用户看到的进度页会变成「未通过」，审核意见会展示给对方。订单状态与消费金额都不会变。确定拒绝？",
} as const;

// ——————————————————————————— 审核意见 ———————————————————————————

/**
 * 审核意见的规则**与入驻审核共用同一份**（`lib/constants/adminApplications.ts`）。
 *
 * 复用而不是新写一份，是因为拒绝的两条硬要求完全一致：不能为空、不能超过 200 字。
 * 各写一份的话，两处的长度上限迟早会不一样，而那种差异没人能说出哪个才对。
 */
export {
  ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "./adminApplications";

// ——————————————————————————— 列表查询 ———————————————————————————

/** 管理端退款列表查询条件（已解析、已校验）。 */
export type AdminRefundListQuery = {
  /** `all` 表示不限状态 */
  status: AdminRefundStatusFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它管理列表一致）。
 *
 * ⚠️ **只搜「退款单号 / 订单号 / 用户昵称 / 平台展示 ID」**，不搜退款说明与审核意见：
 * 那两段是内容不是标识，用它们搜出来的结果没人能预期；而退款说明里可能有
 * 用户写的隐私信息，把它当搜索对象等于给了一个探测入口。
 */
export function readAdminRefundKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildAdminRefundListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: AdminRefundStatusFilter;
}): AdminRefundListQuery {
  return {
    status: input.status,
    keyword: readAdminRefundKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), ADMIN_REFUND_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_REFUND_PAGE_SIZE,
      ADMIN_REFUND_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * 默认排序：申请时间倒序，同一时间按 id 兜底。
 *
 * id 兜底不是可有可无的：预置数据里就有时间戳相同的记录，顺序不确定会让同一条
 * 在第一页出现过、翻到第二页又出现一次。
 */
export function compareRefundsForAdmin(
  a: Pick<RefundRequest, "createdAt" | "id">,
  b: Pick<RefundRequest, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 关键词是否命中：退款单号 / 订单号 / 用户昵称 / 平台展示 ID 四处任一包含即可。 */
export function refundMatchesAdminKeyword(
  input: { refundNo: string; orderNo: string; nickname: string; displayId: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.refundNo.toLowerCase().includes(needle) ||
    input.orderNo.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle) ||
    input.displayId.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 退款申请 + 订单摘要 + 用户摘要 → 管理端列表项。**显式挑字段**。 */
export function toAdminRefundListItem(
  refund: RefundRequest,
  order: { id: string; orderNo: string; status: OrderStatus; productTitle: string },
  user: AdminUserSummary,
): AdminRefundListItem {
  return {
    id: refund.id,
    refundNo: refund.refundNo,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    // 只读展示值：它来自申请创建时的服务端快照，管理端没有入口能改
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

/** 内部实体 → 管理端详情。在列表项之上补齐原因、说明、凭证、审核信息与可执行动作。 */
export function toAdminRefundDetail(
  refund: RefundRequest,
  order: { id: string; orderNo: string; status: OrderStatus; productTitle: string },
  user: AdminUserSummary,
): AdminRefundDetail {
  return {
    ...toAdminRefundListItem(refund, order, user),
    reasonKey: refund.reasonKey,
    reasonLabel: refund.reasonLabel || (REFUND_REASON_LABELS[refund.reasonKey] ?? refund.reasonKey),
    description: refund.description,
    evidence: refund.evidence,
    reviewingAt: refund.reviewingAt,
    reviewedAt: refund.reviewedAt,
    reviewedBy: refund.reviewedBy,
    reviewNote: refund.reviewNote,
    cancelledAt: refund.cancelledAt,
    timeline: buildAdminRefundTimeline(refund),
    allowedActions: adminRefundAllowedActions(refund.status),
  };
}

/**
 * 管理端的进度时间轴。
 *
 * ⚠️ 与用户端 `buildRefundTimeline()` **分开**：那一份的撤销节点写的是
 * 「你撤销了这笔退款申请」——那个「你」是申请本人。管理端看到的是「用户撤销了」，
 * 用同一份文案会让客服读成「这笔申请是我撤销的」。
 *
 * 只包含**已经发生**的节点，按时间先后排列。
 */
export function buildAdminRefundTimeline(refund: RefundRequest): AdminRefundDetail["timeline"] {
  const entries: AdminRefundDetail["timeline"] = [
    {
      key: "pending",
      label: REFUND_STATUS_LABELS.pending,
      at: refund.createdAt,
      note: "用户提交了退款申请，等待平台审核",
    },
  ];

  if (refund.reviewingAt) {
    entries.push({
      key: "reviewing",
      label: REFUND_STATUS_LABELS.reviewing,
      at: refund.reviewingAt,
      note: "平台已开始审核这笔退款申请",
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
