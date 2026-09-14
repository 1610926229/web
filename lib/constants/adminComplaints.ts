import {
  COMPLAINT_STATUSES,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_TYPES,
  COMPLAINT_TYPE_LABELS,
} from "@/lib/constants/complaints";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import type {
  AdminComplaintAllowedActions,
  AdminComplaintDetail,
  AdminComplaintListItem,
  AdminComplaintOrderSummary,
  Complaint,
  ComplaintStatus,
  ComplaintTypeKey,
} from "@/lib/types/complaint";
import type { OrderStatus } from "@/lib/types/order";
import type { AdminUserSummary } from "@/lib/types/user";
import { countCharacters } from "@/lib/utils/text";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「投诉处理」的筛选规则、状态机与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./complaints`、`./orders`、`./pagination` 与 `lib/utils/text.ts`
 * （都是纯逻辑）外没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ **投诉不自动改订单，也不自动退款。** 处理投诉的任何一步都不写订单、不写退款申请，
 * 本文件里也没有任何接收金额的字段：处理结果是一段文字，不是一笔钱。
 *
 * 四条规则写在这里，是本阶段新增的**唯一**落点：
 *
 * 1. **状态机**：`pending → processing | closed`；`processing → resolved | closed`；
 *    `resolved` / `closed` 是**终态**。「开始处理」只把状态改成处理中，
 *    它不等于已处理、也不产生任何结论。
 * 2. **可执行动作由服务端给出**：`adminComplaintAllowedActions()` 从迁移表推导。
 * 3. **解决必须填写处理结果，关闭必须填写关闭说明**：校验只写在 `normalizeAdminComplaintResult()`。
 * 4. **用户提交的内容不可被覆盖**：`description` / `evidence` / `contact` 是只读的，
 *    管理端没有入口能改它们；处理结果写在另一个字段（`result`）里，两者永不互相覆盖。
 */

export const ADMIN_COMPLAINT_LIST_TITLE = "投诉处理";
export const ADMIN_COMPLAINT_DETAIL_TITLE = "投诉处理详情";

/** 列表默认每页条数。后台是 PC 宽屏，比用户端一页多放几条。 */
export const ADMIN_COMPLAINT_PAGE_SIZE = 20;
export const ADMIN_COMPLAINT_MAX_PAGE_SIZE = 100;
export const ADMIN_COMPLAINT_MAX_PAGE = 1000;

/** 列表顶部的说明：讲清楚这张列表的口径与动作边界。 */
export const ADMIN_COMPLAINT_LIST_NOTICE =
  "列表按提交时间倒序，涵盖全部用户的投诉。投诉不会自动修改订单，也不会自动退款：" +
  "「解决」与「关闭」只记录平台侧的处理结果，订单与退款申请都不受影响。";

/**
 * 用户提交内容只读的说明。**必须写在详情页上**：
 * 看到投诉正文与联系方式的人很容易顺手去找编辑入口，而这里刻意没有。
 */
export const ADMIN_COMPLAINT_IMMUTABLE_NOTICE =
  "投诉正文、凭证与联系方式是用户提交的原始材料，平台不可修改或覆盖；" +
  "处理结果记录在下方独立的结果栏里，与用户提交的内容各占一处。";

/** 列表为空时的提示。 */
export const ADMIN_COMPLAINT_EMPTY_MESSAGE = "当前筛选下没有投诉。";

/**
 * 列表底部的字段边界与动作位置说明。
 *
 * 联系方式尤其不能进列表：一次列表请求会带走全部投诉人的手机号，
 * 而列表上根本用不到它。处理动作也要去详情页——那里才看得到正文与凭证。
 */
export const ADMIN_COMPLAINT_LIST_FIELDS_NOTE =
  "列表不展示投诉正文、凭证与联系方式；这些内容只在详情页可见，三个处理动作也在详情页执行。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const ADMIN_COMPLAINT_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / processing / resolved / closed";
export const ADMIN_COMPLAINT_TYPE_INVALID_MESSAGE =
  "筛选条件 type 只能是 companion_service / refund_dispute / payment_issue / platform_service / other";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type AdminComplaintStatusFilter = ComplaintStatus | "all";

export const ADMIN_COMPLAINT_STATUS_FILTERS: readonly AdminComplaintStatusFilter[] = [
  "all",
  ...COMPLAINT_STATUSES,
];

export const ADMIN_COMPLAINT_STATUS_FILTER_LABELS: Record<AdminComplaintStatusFilter, string> = {
  all: "全部",
  ...COMPLAINT_STATUS_LABELS,
};

/**
 * 默认筛选：**待处理**。
 *
 * 与入驻审核、退款审核同理：这个页面的主要用途是处理待办。
 * 已处理与已关闭的投诉仍然可以筛出来回查——「上个月那条投诉当时是怎么处理的」
 * 是一个会被问到的问题。
 */
export const DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER: AdminComplaintStatusFilter = "pending";

export function isAdminComplaintStatusFilter(
  value: string,
): value is AdminComplaintStatusFilter {
  return (ADMIN_COMPLAINT_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readAdminComplaintStatusFilter(
  raw: string | null,
): AdminComplaintStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER;
  return isAdminComplaintStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminComplaintStatusFilter(
  raw: string | null,
): AdminComplaintStatusFilter {
  return readAdminComplaintStatusFilter(raw) ?? DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER;
}

// ——————————————————————————— 类型筛选 ———————————————————————————

/** 类型筛选。`all` 表示不限。 */
export type AdminComplaintTypeFilter = ComplaintTypeKey | "all";

export const ADMIN_COMPLAINT_TYPE_FILTERS: readonly AdminComplaintTypeFilter[] = [
  "all",
  ...COMPLAINT_TYPES.map((item) => item.key),
];

/** 投诉类型的展示文案。文案只有 `COMPLAINT_TYPES` 那一份，这里只是按 key 取回来。 */
function typeLabel(key: ComplaintTypeKey): string {
  return COMPLAINT_TYPES.find((item) => item.key === key)?.label ?? key;
}

/**
 * 类型筛选的展示文案。
 *
 * ⚠️ **逐键写出来**，不是 `...COMPLAINT_TYPE_LABELS` 展开：那样写虽然更短，
 * 但那份表是 `Record<string, string>`，展开后 TypeScript 无法确认五个类型键都在，
 * 而且将来新增一个投诉类型时这里会**安静地少一个筛选文案**。
 * 写全之后，漏一个键会直接编译不过。
 */
export const ADMIN_COMPLAINT_TYPE_FILTER_LABELS: Record<AdminComplaintTypeFilter, string> = {
  all: "全部类型",
  companion_service: typeLabel("companion_service"),
  refund_dispute: typeLabel("refund_dispute"),
  payment_issue: typeLabel("payment_issue"),
  platform_service: typeLabel("platform_service"),
  other: typeLabel("other"),
};

export function isAdminComplaintTypeFilter(value: string): value is AdminComplaintTypeFilter {
  return (ADMIN_COMPLAINT_TYPE_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值表示不限类型。 */
export function readAdminComplaintTypeFilter(
  raw: string | null,
): AdminComplaintTypeFilter | null {
  const value = (raw ?? "").trim();
  if (!value) return "all";
  return isAdminComplaintTypeFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到「不限类型」（页面地址栏用）。 */
export function normalizeAdminComplaintTypeFilter(raw: string | null): AdminComplaintTypeFilter {
  return readAdminComplaintTypeFilter(raw) ?? "all";
}

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 合法迁移表。**这是投诉状态机唯一的定义处。**
 *
 * - `pending → processing | closed`（可以先处理，也可以直接关闭——例如重复提交、
 *   或用户没说清问题且联系不上）；
 * - `processing → resolved | closed`；
 * - `resolved` / `closed` 是终态。
 *
 * 终态写空数组而不是省略：`Record` 要求每个状态都出现，
 * 将来新增一个状态时，漏掉它的迁移规则会直接编译不过。
 */
export const ADMIN_COMPLAINT_TRANSITIONS: Record<
  ComplaintStatus,
  readonly ComplaintStatus[]
> = {
  pending: ["processing", "closed"],
  processing: ["resolved", "closed"],
  resolved: [],
  closed: [],
};

/** 这次迁移是否合法。`from === to` 一律不合法（那不是一个「迁移」）。 */
export function canTransitionComplaint(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return ADMIN_COMPLAINT_TRANSITIONS[from].includes(to);
}

/** 服务端判定的可执行动作。全部从迁移表推导：终态三项都是 false。 */
export function adminComplaintAllowedActions(
  status: ComplaintStatus,
): AdminComplaintAllowedActions {
  return {
    canStartProcessing: canTransitionComplaint(status, "processing"),
    canResolve: canTransitionComplaint(status, "resolved"),
    canClose: canTransitionComplaint(status, "closed"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const ADMIN_COMPLAINT_TERMINAL_NOTICE = "这条投诉已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const ADMIN_COMPLAINT_NOT_FOUND_MESSAGE = "投诉不存在";
export const ADMIN_COMPLAINT_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**。 */
export function adminComplaintTransitionMessage(status: ComplaintStatus): string {
  return `当前状态是「${COMPLAINT_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。 */
export const ADMIN_COMPLAINT_ACTION_LABELS = {
  startProcessing: "开始处理",
  resolve: "解决",
  close: "关闭",
} as const;

/**
 * 三个动作的二次确认文案。
 *
 * 解决与关闭那条都要说清楚**用户会看到什么**（处理结果会展示给对方），
 * 以及**不会发生什么**（订单与退款都不受影响）。关闭是不可撤销的终态，
 * 文案里要让人意识到这一点。
 */
export const ADMIN_COMPLAINT_CONFIRM_TEXTS = {
  startProcessing: "开始处理后投诉会变为「处理中」，用户看到的进度会同步更新。订单与退款都不受影响。确定开始？",
  resolve: "解决后投诉变为「已处理」，你填写的处理结果会展示给提交投诉的用户。确定解决？",
  close:
    "关闭后投诉变为「已关闭」，你填写的关闭说明会展示给提交投诉的用户。" +
    "已关闭是终态，之后不能再改为已处理。确定关闭？",
} as const;

// ——————————————————————————— 处理结果 ———————————————————————————

export const ADMIN_COMPLAINT_RESULT_MAX_LENGTH = 300;

export const ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE = "请填写处理结果";
export const ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE = `处理结果不能超过 ${ADMIN_COMPLAINT_RESULT_MAX_LENGTH} 个字符`;
export const ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE = "请填写关闭说明";
export const ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE = `关闭说明不能超过 ${ADMIN_COMPLAINT_RESULT_MAX_LENGTH} 个字符`;

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 处理结果 / 关闭说明的校验。
 *
 * ⚠️ 两者共用**同一个字段**（`result`）而不是各开一个：它们都是管理者写的平台侧结论，
 * 一条投诉只会有一个结论。分开存会出现「已关闭但还有一份处理结果」这种读不出来的状态。
 *
 * 但**文案必须分开**：对客服说「请填写处理结果」与「请填写关闭说明」是两件事，
 * 前者是「你怎么处理的」，后者是「为什么关掉」。同一个字段、两种问法。
 *
 * 字数用 `countCharacters`（code point），与全站口径一致——用 `length` 会把一个 emoji
 * 当成两个字符，出现「看着没超却报超了」。
 */
export function normalizeAdminComplaintResult(
  raw: string,
  intent: "resolve" | "close",
): FieldResult<string> {
  const value = raw.trim();
  if (!value) {
    return {
      ok: false,
      message:
        intent === "resolve"
          ? ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE
          : ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE,
    };
  }
  if (countCharacters(value) > ADMIN_COMPLAINT_RESULT_MAX_LENGTH) {
    return {
      ok: false,
      message:
        intent === "resolve"
          ? ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE
          : ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
    };
  }
  return { ok: true, value };
}

// ——————————————————————————— 列表查询 ———————————————————————————

/** 管理端投诉列表查询条件（已解析、已校验）。 */
export type AdminComplaintListQuery = {
  /** `all` 表示不限状态 */
  status: AdminComplaintStatusFilter;
  /** `all` 表示不限类型 */
  type: AdminComplaintTypeFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它管理列表一致）。
 *
 * ⚠️ **只搜「投诉编号 / 订单号 / 用户昵称 / 平台展示 ID」**，不搜投诉正文、处理结果
 * 与联系方式：正文里可能有用户写的隐私信息，联系方式更是——把它们当搜索对象，
 * 等于让任何一个能进后台的人用关键词把别人的手机号试出来。
 */
export function readAdminComplaintKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildAdminComplaintListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: AdminComplaintStatusFilter;
  /** 已经解析好的类型筛选 */
  type: AdminComplaintTypeFilter;
}): AdminComplaintListQuery {
  return {
    status: input.status,
    type: input.type,
    keyword: readAdminComplaintKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), ADMIN_COMPLAINT_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_COMPLAINT_PAGE_SIZE,
      ADMIN_COMPLAINT_MAX_PAGE_SIZE,
    ),
  };
}

/** 默认排序：提交时间倒序，同一时间按 id 兜底（理由同其它管理列表）。 */
export function compareComplaintsForAdmin(
  a: Pick<Complaint, "createdAt" | "id">,
  b: Pick<Complaint, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 关键词是否命中：投诉编号 / 订单号 / 用户昵称 / 平台展示 ID 四处任一包含即可。 */
export function complaintMatchesAdminKeyword(
  input: { complaintNo: string; orderNo: string; nickname: string; displayId: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.complaintNo.toLowerCase().includes(needle) ||
    input.orderNo.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle) ||
    input.displayId.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 投诉 + 用户摘要 → 管理端列表项。**显式挑字段**：正文、凭证、联系方式与结果都不在里面。 */
export function toAdminComplaintListItem(
  complaint: Complaint,
  user: AdminUserSummary,
): AdminComplaintListItem {
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

/** 关联订单摘要的输入：由服务层从订单仓储取好，本层只做拼装。 */
export type AdminComplaintOrderInput = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  productTitle: string;
  totalAmount: number;
};

export function toAdminComplaintOrderSummary(
  order: AdminComplaintOrderInput,
): AdminComplaintOrderSummary {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    productTitle: order.productTitle,
    totalAmount: order.totalAmount,
  };
}

/**
 * 内部实体 → 管理端详情。
 *
 * 在列表项之上补齐正文、凭证、联系方式、处理信息、订单摘要、时间轴与可执行动作。
 * 正文/凭证/联系方式都只是**读出来展示**，这里没有任何写回它们的路径。
 */
export function toAdminComplaintDetail(
  complaint: Complaint,
  user: AdminUserSummary,
  order: AdminComplaintOrderInput | null,
): AdminComplaintDetail {
  return {
    ...toAdminComplaintListItem(complaint, user),
    description: complaint.description,
    evidence: complaint.evidence,
    contact: complaint.contact,
    processingAt: complaint.processingAt,
    handledAt: complaint.handledAt,
    handledByAdminId: complaint.handledByAdminId,
    result: complaint.result,
    orderSummary: order ? toAdminComplaintOrderSummary(order) : null,
    timeline: buildAdminComplaintTimeline(complaint),
    allowedActions: adminComplaintAllowedActions(complaint.status),
  };
}

/**
 * 管理端的进度时间轴。
 *
 * ⚠️ 与用户端 `buildComplaintTimeline()` **分开**：那一份的第一句是「投诉已提交」，
 * 站在用户视角读。管理端要能一眼看出「这一步是谁做的」——提交是用户做的，
 * 开始处理与出结果是平台做的，混在一套文案里客服会读错。
 *
 * 只包含**已经发生**的节点，按时间先后排列。
 */
export function buildAdminComplaintTimeline(complaint: Complaint): AdminComplaintDetail["timeline"] {
  const entries: AdminComplaintDetail["timeline"] = [
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
