import type { PageResult } from "@/lib/types/common";
import type { ComplaintListItem, ComplaintStatus, ComplaintTypeKey } from "@/lib/types/complaint";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 投诉的状态、类型与表单规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type`，没有运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 投诉**不自动退款、不修改订单状态**：它只是把问题记下来交给客服。
 * 因此这里没有任何「金额」「赔付」相关的字段与文案，处理结果也只能来自
 * 预置数据或将来后台的返回。
 */

/** 四个投诉状态，顺序与列表 Tab 一致。 */
export const COMPLAINT_STATUSES: readonly ComplaintStatus[] = [
  "pending",
  "processing",
  "resolved",
  "closed",
];

export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  closed: "已关闭",
};

export const COMPLAINT_STATUS_CLASS: Record<ComplaintStatus, string> = {
  pending: "text-status-pending",
  processing: "text-status-info",
  resolved: "text-status-success",
  closed: "text-status-muted",
};

/** 状态说明。**不承诺任何处理结论**，只说明当前处在哪一步。 */
export const COMPLAINT_STATUS_HINTS: Record<ComplaintStatus, string> = {
  pending: "投诉已提交，客服会尽快查看。",
  processing: "客服正在核实你反馈的问题，请留意系统通知。",
  resolved: "客服已处理本次投诉，处理结果见下方说明。",
  closed: "本次投诉已关闭。",
};

/** 投诉类型。**必选**，取值由服务端校验，文案只此一份。 */
export const COMPLAINT_TYPES: readonly { key: ComplaintTypeKey; label: string }[] = [
  { key: "companion_service", label: "打手服务问题" },
  { key: "refund_dispute", label: "退款相关争议" },
  { key: "payment_issue", label: "支付 / 订单异常" },
  { key: "platform_service", label: "平台服务问题" },
  { key: "other", label: "其他问题" },
];

export const COMPLAINT_TYPE_LABELS = COMPLAINT_TYPES.reduce<Record<string, string>>(
  (labels, item) => {
    labels[item.key] = item.label;
    return labels;
  },
  {},
);

export const COMPLAINT_DESCRIPTION_MAX_LENGTH = 300;

/** 联系方式长度上限。联系方式是**选填**，本阶段不采集更敏感的信息。 */
export const COMPLAINT_CONTACT_MAX_LENGTH = 50;

export const COMPLAINT_TYPE_REQUIRED_MESSAGE = "请选择投诉类型";
export const COMPLAINT_DESCRIPTION_EMPTY_MESSAGE = "请描述你遇到的问题";
export const COMPLAINT_DESCRIPTION_TOO_LONG_MESSAGE = `问题描述不能超过 ${COMPLAINT_DESCRIPTION_MAX_LENGTH} 个字`;
export const COMPLAINT_CONTACT_TOO_LONG_MESSAGE = `联系方式不能超过 ${COMPLAINT_CONTACT_MAX_LENGTH} 个字`;
export const COMPLAINT_STATUS_INVALID_MESSAGE = "投诉状态筛选无效";

/**
 * 提交后给用户看的说明。
 *
 * ⚠️ 刻意**不写**「将为你免单 / 补偿 / 退款」这类平台没有承诺过的结论：
 * 投诉只是记录问题，处理结果以客服反馈为准。
 */
export const COMPLAINT_RESULT_PENDING_NOTE =
  "投诉已记录，客服会在核实后同步处理结果，请留意系统通知。平台不会因投诉自动退款或改动订单状态。";

/** 投诉列表默认每页条数。 */
export const COMPLAINT_PAGE_SIZE = 10;

export const COMPLAINT_MAX_PAGE_SIZE = 20;

/** 页码上限：与订单列表共用 `clampPage` 的默认上限。 */
export const COMPLAINT_MAX_PAGE = 1000;

// ——————————————————————————— 普通投诉窗口（P0-9）———————————————————————————

/**
 * 普通投诉窗口是否已经关闭。
 *
 * 窗口来自**订单自己的快照**（`Order.complaintDeadlineAt`），不是当前平台配置：
 * 每张订单在进入 `completed` 时冻结当时的窗口，之后平台改配置不影响它
 * （P0-9 `02-decisions.md` D16）。
 *
 * 三条语义，逐条刻意：
 * 1. **`null` 表示「没有窗口」，不是「立刻关闭」**——`paid` / `accepted` / `serving`
 *    的订单还没有完成，谈不上投诉窗口；P0-9 之前就 completed 的历史订单也没有快照。
 *    把所有 `null` 都当成「已关闭」等于**顺带关掉在途订单与历史订单的投诉入口**，
 *    而那是任何人没有要求过的行为变化。
 * 2. 判据是 `deadline <= now`（含边界），与派单超时、自动审核同一口径：
 *    到点即关闭，不接受「还差一毫秒」的争论。
 * 3. 它**只回答普通投诉入口**。特殊人工申诉（如已完成很久之后的申诉）属于后续 TBD，
 *    本阶段不实现——因此「窗口关闭」**不等于**「这件事永远没有人工处理的可能」，
 *    接口文案与页面都不许把后者写成规则。
 *
 * 纯函数，不接触仓储：接口（服务层）与页面（`canSubmitComplaint`）用的是同一个它，
 * 因此不存在「页面还显示按钮、接口却已经拒绝」的窗口期。
 */
export function isComplaintWindowClosed(
  order: { complaintDeadlineAt: string | null },
  at: string,
): boolean {
  if (!order.complaintDeadlineAt) return false;
  return Date.parse(order.complaintDeadlineAt) <= Date.parse(at);
}

/**
 * 普通投诉窗口关闭后，接口给用户的一句话。
 *
 * ⚠️ **不带具体小时数**：窗口是可配置的，而且**每一单用的是它自己完成时的快照**，
 * 文案里印一个数字必然对某些订单是错的。具体时间由订单详情页显示。
 *
 * ⚠️ 必须留一句出路（「请联系客服」）：窗口关闭只是**普通入口**关闭，
 * 把它写成「无法处理」会变成一句平台其实做不到的硬规则（见上面的第 3 条）。
 */
export const COMPLAINT_WINDOW_CLOSED_MESSAGE =
  "该订单的投诉窗口已结束，无法再发起普通投诉；如有其他问题请联系客服。";

/** 列表页 Tab：`all` 是查询条件，不是投诉真实状态。 */
export type ComplaintTabKey = ComplaintStatus | "all";

export const COMPLAINT_TABS: readonly { key: ComplaintTabKey; label: string }[] = [
  { key: "all", label: "全部" },
  ...COMPLAINT_STATUSES.map((status) => ({
    key: status,
    label: COMPLAINT_STATUS_LABELS[status],
  })),
];

export function isComplaintStatus(value: string): value is ComplaintStatus {
  return (COMPLAINT_STATUSES as readonly string[]).includes(value);
}

export function isComplaintType(value: string): value is ComplaintTypeKey {
  return COMPLAINT_TYPES.some((item) => item.key === value);
}

/** 解析列表筛选状态：空串是「全部」，非法值失败。 */
export function parseComplaintStatus(raw: string | null): ComplaintStatus | null | "invalid" {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return isComplaintStatus(value) ? value : "invalid";
}

/** 规范化后的投诉列表查询条件。 */
export type ComplaintListQueryInput = {
  /** null 表示「全部」 */
  status: ComplaintStatus | null;
  page: number;
  pageSize: number;
};

/**
 * 解析投诉列表的查询条件。
 *
 * 与订单列表同一套行为：状态取值非法直接失败（不静默回退成「全部」），
 * 分页参数规范化到安全范围（坏掉的页码不该让整页报错）。
 */
export function parseComplaintListQuery(
  params: URLSearchParams,
): { ok: true; query: ComplaintListQueryInput } | { ok: false; message: string } {
  const status = parseComplaintStatus(params.get("status"));
  if (status === "invalid") return { ok: false, message: COMPLAINT_STATUS_INVALID_MESSAGE };

  return {
    ok: true,
    query: {
      status,
      page: clampPage(params.get("page"), COMPLAINT_MAX_PAGE),
      pageSize: clampPageSize(params.get("pageSize"), COMPLAINT_PAGE_SIZE, COMPLAINT_MAX_PAGE_SIZE),
    },
  };
}

/**
 * 投诉列表的「加载更多」合并。
 *
 * 通用规则在 `lib/constants/pagination.ts` 的 `mergePageResult`：
 * 追加而不是替换，并按 id 去重。
 */
export function mergeComplaintPage(
  current: PageResult<ComplaintListItem>,
  next: PageResult<ComplaintListItem>,
): PageResult<ComplaintListItem> {
  return mergePageResult(current, next);
}

/**
 * 列表默认排序：提交时间倒序，最新的投诉在最前面。
 *
 * 时间相同时用 id 兜底，保证同一份数据每次排出来的顺序**完全一致**——
 * 否则分页时可能出现同一条投诉在第一页出现过、第二页又出现一次。
 */
export function compareComplaintsNewestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 校验投诉表单的文本字段（类型与凭证另有各自规则）。 */
export type ComplaintTextResult = { ok: true; description: string; contact: string } | { ok: false; message: string };

export function validateComplaintText(description: string, contact: string): ComplaintTextResult {
  const trimmedDescription = description.trim();
  if (!trimmedDescription) return { ok: false, message: COMPLAINT_DESCRIPTION_EMPTY_MESSAGE };
  if (trimmedDescription.length > COMPLAINT_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, message: COMPLAINT_DESCRIPTION_TOO_LONG_MESSAGE };
  }

  const trimmedContact = contact.trim();
  if (trimmedContact.length > COMPLAINT_CONTACT_MAX_LENGTH) {
    return { ok: false, message: COMPLAINT_CONTACT_TOO_LONG_MESSAGE };
  }

  return { ok: true, description: trimmedDescription, contact: trimmedContact };
}
