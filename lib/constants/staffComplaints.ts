import {
  ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE,
  ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE,
  ADMIN_COMPLAINT_RESULT_MAX_LENGTH,
  ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  canTransitionComplaint,
  normalizeAdminComplaintResult,
} from "@/lib/constants/adminComplaints";
import {
  COMPLAINT_STATUSES,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_TYPES,
  COMPLAINT_TYPE_LABELS,
} from "@/lib/constants/complaints";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { STAFF_MAX_PAGE, STAFF_MAX_PAGE_SIZE, STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import type {
  Complaint,
  ComplaintStatus,
  ComplaintTypeKey,
  StaffComplaintAllowedActions,
  StaffComplaintDetail,
  StaffComplaintListItem,
  StaffComplaintOrderSummary,
} from "@/lib/types/complaint";
import type { OrderStatus } from "@/lib/types/order";
import type { StaffCompanionReleaseEntry, StaffUserSummary } from "@/lib/types/staff";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 客服端「投诉处理」的筛选规则、状态机与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与几个纯逻辑模块（投诉文案、订单文案、分页、管理端投诉常量）外
 * 没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 三条硬规则写在这里，是 P8D-2 客服侧投诉的**唯一**落点：
 *
 * 1. **与管理端共用同一个状态机**：可执行动作从 `canTransitionComplaint()` 推导
 *    （终态三项全 false），页面上不写 `if (status === "pending")`。
 *    处理投诉不写订单、不写退款、不动任何金额——它只改这条投诉自己的状态。
 * 2. **用户提交的内容不可被覆盖**：`description` / `evidence` / `contact` 是只读的，
 *    客服端没有入口能改它们；处理结果写在另一个字段（`result`）里。
 * 3. **列表不含联系方式**：一次列表请求会带走全部投诉人的联系方式，而列表用不到它；
 *    它只在详情 DTO 里出现，且只读。
 *
 * ⚠️ 处理结果 / 关闭说明的校验**直接复用管理端** `normalizeAdminComplaintResult()`
 * （见协调补充三）：同一份校验、同一套文案，客服端不另写一份。
 */

/** 客服端投诉详情页标题（列表页标题 `STAFF_COMPLAINTS_PAGE_TITLE` 在 `lib/constants/staff.ts`）。 */
export const STAFF_COMPLAINT_DETAIL_TITLE = "投诉处理详情";

/**
 * 处理结果 / 关闭说明的校验（与管理端同一个函数，`intent` 取 `resolve` | `close`）。
 *
 * 校验不过时调用方用 `result.message` 转成 400。字数上限与空值文案都在管理端那一份里，
 * 这里只是把它交给客服端的服务层与页面用，不复制一份规则。
 */
export { normalizeAdminComplaintResult as normalizeStaffComplaintResult };

/** 处理结果 / 关闭说明的长度上限（与管理端同一个数，客服端不另起一套）。 */
export const STAFF_COMPLAINT_RESULT_MAX_LENGTH = ADMIN_COMPLAINT_RESULT_MAX_LENGTH;
export const STAFF_COMPLAINT_RESULT_EMPTY_MESSAGE = ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE;
export const STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE = ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE;
export const STAFF_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE = ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE;
export const STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE = ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE;

/** 列表顶部的说明：讲清楚这张列表的口径与动作边界。 */
export const STAFF_COMPLAINT_LIST_NOTICE =
  "列表按提交时间倒序，涵盖全部用户的投诉。投诉不会自动修改订单，也不会自动退款：" +
  "「解决」与「关闭」只记录平台侧的处理结果，订单与退款申请都不受影响。";

/** 列表底部的字段边界与动作位置说明：联系方式不进列表，动作只进详情页。 */
export const STAFF_COMPLAINT_LIST_FIELDS_NOTE =
  "列表不展示投诉正文、凭证与联系方式；这些内容只在详情页可见，三个处理动作也在详情页执行。";

/**
 * 用户提交内容只读的说明。**必须写在详情页上**：
 * 看到投诉正文与联系方式的人很容易顺手去找编辑入口，而这里刻意没有。
 */
export const STAFF_COMPLAINT_IMMUTABLE_NOTICE =
  "投诉正文、凭证与联系方式是用户提交的原始材料，平台不可修改或覆盖；" +
  "处理结果记录在下方独立的结果栏里，与用户提交的内容各占一处。";

/** 列表为空时的提示。 */
export const STAFF_COMPLAINT_EMPTY_MESSAGE = "当前筛选下没有投诉。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const STAFF_COMPLAINT_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / processing / resolved / closed";
export const STAFF_COMPLAINT_TYPE_INVALID_MESSAGE =
  "筛选条件 type 只能是 companion_service / refund_dispute / payment_issue / platform_service / other";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type StaffComplaintStatusFilter = ComplaintStatus | "all";

export const STAFF_COMPLAINT_STATUS_FILTERS: readonly StaffComplaintStatusFilter[] = [
  "all",
  ...COMPLAINT_STATUSES,
];

export const STAFF_COMPLAINT_STATUS_FILTER_LABELS: Record<StaffComplaintStatusFilter, string> = {
  all: "全部",
  ...COMPLAINT_STATUS_LABELS,
};

/** 默认筛选：**待处理**（这个页面的主要用途是处理待办，与管理端同一口径）。 */
export const DEFAULT_STAFF_COMPLAINT_STATUS_FILTER: StaffComplaintStatusFilter = "pending";

export function isStaffComplaintStatusFilter(
  value: string,
): value is StaffComplaintStatusFilter {
  return (STAFF_COMPLAINT_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readStaffComplaintStatusFilter(
  raw: string | null,
): StaffComplaintStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_STAFF_COMPLAINT_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_STAFF_COMPLAINT_STATUS_FILTER;
  return isStaffComplaintStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeStaffComplaintStatusFilter(
  raw: string | null,
): StaffComplaintStatusFilter {
  return readStaffComplaintStatusFilter(raw) ?? DEFAULT_STAFF_COMPLAINT_STATUS_FILTER;
}

// ——————————————————————————— 类型筛选 ———————————————————————————

/** 类型筛选。`all` 表示不限。 */
export type StaffComplaintTypeFilter = ComplaintTypeKey | "all";

export const STAFF_COMPLAINT_TYPE_FILTERS: readonly StaffComplaintTypeFilter[] = [
  "all",
  ...COMPLAINT_TYPES.map((item) => item.key),
];

/** 投诉类型的展示文案。文案只有 `COMPLAINT_TYPES` 那一份，这里只是按 key 取回来。 */
function typeLabel(key: ComplaintTypeKey): string {
  return COMPLAINT_TYPES.find((item) => item.key === key)?.label ?? key;
}

/**
 * 类型筛选的展示文案。**逐键写出来**（理由同管理端）：
 * 展开一个 `Record<string, string>` 会让 TypeScript 无法确认五个类型键都在。
 */
export const STAFF_COMPLAINT_TYPE_FILTER_LABELS: Record<StaffComplaintTypeFilter, string> = {
  all: "全部类型",
  companion_service: typeLabel("companion_service"),
  refund_dispute: typeLabel("refund_dispute"),
  payment_issue: typeLabel("payment_issue"),
  platform_service: typeLabel("platform_service"),
  other: typeLabel("other"),
};

export function isStaffComplaintTypeFilter(value: string): value is StaffComplaintTypeFilter {
  return (STAFF_COMPLAINT_TYPE_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值表示不限类型。 */
export function readStaffComplaintTypeFilter(raw: string | null): StaffComplaintTypeFilter | null {
  const value = (raw ?? "").trim();
  if (!value) return "all";
  return isStaffComplaintTypeFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到「不限类型」（页面地址栏用）。 */
export function normalizeStaffComplaintTypeFilter(raw: string | null): StaffComplaintTypeFilter {
  return readStaffComplaintTypeFilter(raw) ?? "all";
}

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 客服端可执行的投诉动作：**三个全都有**，但能否执行由状态机推导。
 *
 * 与管理端**共用同一个迁移表**（`canTransitionComplaint`）：
 * `pending → processing | closed`，`processing → resolved | closed`，两个终态没有出边。
 * 页面不拿状态自己写 `if`——终态三项都是 false，按钮据此禁用或隐藏。
 */
export function staffComplaintAllowedActions(
  status: ComplaintStatus,
): StaffComplaintAllowedActions {
  return {
    canStartProcessing: canTransitionComplaint(status, "processing"),
    canResolve: canTransitionComplaint(status, "resolved"),
    canClose: canTransitionComplaint(status, "closed"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const STAFF_COMPLAINT_TERMINAL_NOTICE = "这条投诉已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const STAFF_COMPLAINT_NOT_FOUND_MESSAGE = "投诉不存在";
export const STAFF_COMPLAINT_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const STAFF_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**。 */
export function staffComplaintTransitionMessage(status: ComplaintStatus): string {
  return `当前状态是「${COMPLAINT_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。 */
export const STAFF_COMPLAINT_ACTION_LABELS = {
  startProcessing: "开始处理",
  resolve: "解决",
  close: "关闭",
} as const;

/**
 * 三个动作的二次确认文案。与管理端同一套（动作的语义与后果完全一致）。
 *
 * 解决与关闭那条都要说清楚**用户会看到什么**（处理结果会展示给对方），
 * 以及**不会发生什么**（订单与退款都不受影响）。
 */
export const STAFF_COMPLAINT_CONFIRM_TEXTS = {
  startProcessing: "开始处理后投诉会变为「处理中」，用户看到的进度会同步更新。订单与退款都不受影响。确定开始？",
  resolve: "解决后投诉变为「已处理」，你填写的处理结果会展示给提交投诉的用户。确定解决？",
  close:
    "关闭后投诉变为「已关闭」，你填写的关闭说明会展示给提交投诉的用户。" +
    "已关闭是终态，之后不能再改为已处理。确定关闭？",
} as const;

/** 三个动作成功后的提示。 */
export const STAFF_COMPLAINT_SUCCESS_MESSAGES = {
  startProcessing: "已开始处理：投诉标记为「处理中」，用户看到的进度会同步更新",
  resolve: "已解决：投诉变为「已处理」，处理结果会展示给提交投诉的用户",
  close: "已关闭：投诉变为「已关闭」，关闭说明会展示给提交投诉的用户",
} as const;

/**
 * 幂等重放（`changed: false`）时的提示。
 *
 * ⚠️ 必须与「成功」的文案分开：重放时服务端**什么都没改**，页面却报一句
 * 「已解决」就是在告诉客服一件与事实相反的事。真正的状态以重新取回的详情为准。
 */
export const STAFF_COMPLAINT_REPLAY_NOTICE = "这条投诉已经按这个操作处理过了，没有重复执行。";

/**
 * 写操作**已经生效**、但随后的详情刷新失败时的提示。
 *
 * ⚠️ 与退款侧的 `STAFF_REFUND_REFRESH_FAILED_NOTICE` 同因，理由见那里：
 * 写成功了就不能报「操作失败」，那句话与事实相反，还会诱导客服再点一次。
 */
export const STAFF_COMPLAINT_REFRESH_FAILED_NOTICE =
  "操作已生效，但详情刷新失败。请重新加载页面确认最新状态。";

// ——————————————————————————— 列表查询 ———————————————————————————

/** 客服端投诉列表查询条件（已解析、已校验）。 */
export type StaffComplaintListQuery = {
  /** `all` 表示不限状态 */
  status: StaffComplaintStatusFilter;
  /** `all` 表示不限类型 */
  type: StaffComplaintTypeFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它列表一致）。
 *
 * ⚠️ **只搜「投诉编号 / 订单号 / 用户昵称」**，不搜投诉正文、处理结果与联系方式：
 * 正文里可能有用户写的隐私信息，联系方式更是——把它们当搜索对象，
 * 等于让任何一个能进工作台的人用关键词把别人的手机号试出来。
 *
 * ⚠️ 与管理端的差异：`StaffUserSummary` **没有** `displayId`，
 * 因此客服端的关键词搜索不含平台展示 ID（客服要搜的编号是投诉编号与订单号）。
 */
export function readStaffComplaintKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildStaffComplaintListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: StaffComplaintStatusFilter;
  /** 已经解析好的类型筛选 */
  type: StaffComplaintTypeFilter;
}): StaffComplaintListQuery {
  return {
    status: input.status,
    type: input.type,
    keyword: readStaffComplaintKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), STAFF_PAGE_SIZE, STAFF_MAX_PAGE_SIZE),
  };
}

/** 关键词是否命中：投诉编号 / 订单号 / 用户昵称 三处任一包含即可（大小写不敏感）。 */
export function complaintMatchesStaffKeyword(
  input: { complaintNo: string; orderNo: string; nickname: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.complaintNo.toLowerCase().includes(needle) ||
    input.orderNo.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 投诉 + 用户摘要 → 客服端列表项。**显式挑字段**：正文、凭证、联系方式与结果都不在里面。 */
export function toStaffComplaintListItem(
  complaint: Complaint,
  user: StaffUserSummary,
): StaffComplaintListItem {
  return {
    id: complaint.id,
    complaintNo: complaint.complaintNo,
    status: complaint.status,
    statusLabel: COMPLAINT_STATUS_LABELS[complaint.status],
    typeKey: complaint.typeKey,
    typeLabel: complaint.typeLabel || (COMPLAINT_TYPE_LABELS[complaint.typeKey] ?? complaint.typeKey),
    orderId: complaint.orderId,
    orderNo: complaint.orderNo,
    createdAt: complaint.createdAt,
    updatedAt: complaint.updatedAt,
    user,
  };
}

/**
 * 关联订单摘要的输入：由服务层从订单仓储取好，本层只做拼装。
 *
 * ⚠️ `releaseHistory` 也在这里，理由与订单其余字段相同：**订单摘要要回答的问题**
 * 里包含「这一单有没有人中途退出」。服务层负责取数与解名字
 * （`toStaffCompanionReleaseEntry` 是转换规则的唯一出处），本层不碰 `lib/data`。
 */
export type StaffComplaintOrderInput = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  productTitle: string;
  totalAmount: number;
  releaseHistory: StaffCompanionReleaseEntry[];
};

export function toStaffComplaintOrderSummary(
  order: StaffComplaintOrderInput,
): StaffComplaintOrderSummary {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    productTitle: order.productTitle,
    totalAmount: order.totalAmount,
    releaseHistory: order.releaseHistory,
  };
}

/**
 * 内部实体 → 客服端详情。
 *
 * 在列表项之上补齐正文、凭证、联系方式、处理信息、订单摘要、会话入口、时间轴与
 * **服务端判定的** `allowedActions`。正文/凭证/联系方式都只是**读出来展示**，
 * 这里没有任何写回它们的路径。
 *
 * ⚠️ `conversationOrderId` 由服务层查好传进来（§八：只查不建会话），
 * 本层不做任何仓储读取——它只是把服务层给的结论原样放进 DTO。
 */
export function toStaffComplaintDetail(
  complaint: Complaint,
  user: StaffUserSummary,
  order: StaffComplaintOrderInput | null,
  conversationOrderId: string | null,
): StaffComplaintDetail {
  return {
    ...toStaffComplaintListItem(complaint, user),
    description: complaint.description,
    evidence: complaint.evidence,
    contact: complaint.contact,
    processingAt: complaint.processingAt,
    handledAt: complaint.handledAt,
    handledById: complaint.handledById,
    handledByRole: complaint.handledByRole,
    handledByName: complaint.handledByName,
    result: complaint.result,
    orderSummary: order ? toStaffComplaintOrderSummary(order) : null,
    conversationOrderId,
    timeline: buildStaffComplaintTimeline(complaint),
    allowedActions: staffComplaintAllowedActions(complaint.status),
  };
}

/**
 * 客服端的进度时间轴。
 *
 * ⚠️ 与用户端 `buildComplaintTimeline()` **分开**（那一份站在用户视角读），
 * 与管理端的 `buildAdminComplaintTimeline()` 同构——客服要能一眼看出
 * 「这一步是谁做的」。只包含**已经发生**的节点，按时间先后排列。
 */
export function buildStaffComplaintTimeline(complaint: Complaint): StaffComplaintDetail["timeline"] {
  const entries: StaffComplaintDetail["timeline"] = [
    {
      key: "pending",
      label: COMPLAINT_STATUS_LABELS.pending,
      at: complaint.createdAt,
      note: "用户提交了投诉，等待平台处理",
    },
  ];

  if (complaint.processingAt) {
    entries.push({
      key: "processing",
      label: COMPLAINT_STATUS_LABELS.processing,
      at: complaint.processingAt,
      note: "平台已开始核实用户反馈的问题",
    });
  }
  if (complaint.status === "resolved" && complaint.handledAt) {
    entries.push({
      key: "resolved",
      label: COMPLAINT_STATUS_LABELS.resolved,
      at: complaint.handledAt,
      note: complaint.result || "平台已处理本次投诉",
    });
  }
  if (complaint.status === "closed" && complaint.handledAt) {
    entries.push({
      key: "closed",
      label: COMPLAINT_STATUS_LABELS.closed,
      at: complaint.handledAt,
      note: complaint.result || "本次投诉已关闭",
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}
