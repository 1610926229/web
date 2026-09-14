import type { OrderStatus } from "@/lib/types/order";
import type { RefundReasonKey, RefundStatus } from "@/lib/types/refund";

/**
 * 退款状态机与表单规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type`，没有运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 这里只描述**规则**，不读写数据。判断「能不能退」的权威仍然是服务端：
 * 页面用同一套函数渲染按钮，写接口时再校验一次。
 */

/** 五个退款状态，顺序与进度时间轴一致。 */
export const REFUND_STATUSES: readonly RefundStatus[] = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "cancelled",
];

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "待审核",
  reviewing: "审核中",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已撤销",
};

/** 状态文字色：全部来自 `app/globals.css` 的 `--color-status-*` 令牌。 */
export const REFUND_STATUS_CLASS: Record<RefundStatus, string> = {
  pending: "text-status-pending",
  reviewing: "text-status-info",
  approved: "text-status-success",
  rejected: "text-status-danger",
  cancelled: "text-status-muted",
};

/** 状态的一句话说明。只描述退款这件事，不承诺任何审核结果。 */
export const REFUND_STATUS_HINTS: Record<RefundStatus, string> = {
  pending: "退款申请已提交，等待客服审核。审核期间订单按原进度继续。",
  reviewing: "客服正在审核这笔退款申请，请留意系统通知。",
  approved: "退款申请已通过，款项将按原支付渠道退回。",
  rejected: "退款申请未通过，如有疑问可联系客服进一步说明。",
  cancelled: "退款申请已由你撤销，订单按原进度继续。",
};

/** 退款原因选项。**必选**，取值由服务端校验，文案只此一份。 */
export const REFUND_REASONS: readonly { key: RefundReasonKey; label: string }[] = [
  { key: "service_not_delivered", label: "打手未按约定提供服务" },
  { key: "service_quality", label: "服务过程与描述不符" },
  { key: "schedule_conflict", label: "时间冲突，无法继续本次服务" },
  { key: "duplicate_payment", label: "重复支付 / 多付了金额" },
  { key: "other", label: "其他原因" },
];

export const REFUND_REASON_LABELS = REFUND_REASONS.reduce<Record<string, string>>(
  (labels, item) => {
    labels[item.key] = item.label;
    return labels;
  },
  {},
);

export const REFUND_DESCRIPTION_MAX_LENGTH = 200;

export const REFUND_REASON_REQUIRED_MESSAGE = "请选择退款原因";
export const REFUND_DESCRIPTION_EMPTY_MESSAGE = "请填写退款说明";
export const REFUND_DESCRIPTION_TOO_LONG_MESSAGE = `退款说明不能超过 ${REFUND_DESCRIPTION_MAX_LENGTH} 个字`;

/** 退款金额不可编辑的说明。整单退款，金额由服务端按订单实付金额确定。 */
export const REFUND_AMOUNT_NOTE = "退款金额为整单实付金额，由系统计算，不可修改";

export const REFUND_STATUS_INVALID_MESSAGE = "退款状态筛选无效";
export const REFUND_ALREADY_ACTIVE_MESSAGE = "该订单已有进行中的退款申请，请先查看退款进度";
export const REFUND_RECORD_EXISTS_MESSAGE = "该订单已有退款申请记录，本阶段不支持重复申请";
export const REFUND_NOT_CANCELLABLE_MESSAGE = "只有待审核的退款申请可以撤销";
export const REFUND_ORDER_NOT_ALLOWED_MESSAGE = "该订单当前不可申请退款";
export const REFUND_AMOUNT_INVALID_MESSAGE = "订单金额异常，暂时无法发起退款";

export function isRefundStatus(value: string): value is RefundStatus {
  return (REFUND_STATUSES as readonly string[]).includes(value);
}

export function isRefundReason(value: string): value is RefundReasonKey {
  return REFUND_REASONS.some((item) => item.key === value);
}

/** 「进行中」的退款：待审核与审核中。只有这两种会挡住新的申请。 */
export const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = ["pending", "reviewing"];

export function isActiveRefundStatus(status: RefundStatus): boolean {
  return (ACTIVE_REFUND_STATUSES as readonly string[]).includes(status);
}

/**
 * 允许申请退款的订单状态：已付款 / 已接单 / 护航中 / **已完成**。
 *
 * 已完成也在这个集合里，是因为它才是**唯一计入消费**的状态（见
 * `lib/constants/levels.ts` 的 `CONSUMPTION_ORDER_STATUS`）：消费口径只认已完成，
 * 如果已完成不能退，那笔已计入累计消费的钱就永远退不掉。
 *
 * 「已完成可退」不代表「完成后退款很容易」——退款仍然是一笔独立的状态机，
 * 提交只产生一条待审核记录，订单状态和累计消费都**要到审核通过才变**。
 */
export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  "paid",
  "accepted",
  "serving",
  "completed",
];

export function isOrderRefundable(status: OrderStatus): boolean {
  return (REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * 能否申请退款 = 订单状态可退，**且**这一单还没有任何退款申请记录。
 *
 * 反过来读，就是仍然不能申请的四种情况：
 *
 * 1. 订单状态本身不可退（已退款；以及未支付等根本不存在的状态）；
 * 2. 已有**进行中**的退款申请（待审核 / 审核中）——不能同时对同一单开两条流程；
 * 3. 已有**已通过**的退款——钱已经退过了；
 * 4. 已有**已结束**的退款（已拒绝 / 已撤销）——本阶段仍然保持
 *    「一笔订单一条退款记录」，不自行开放重复申请。
 *
 * 第 2、3、4 条都由第二条 `hasRefundRecord` 一并挡住：这一条不是「没有进行中的申请」，
 * 而是「没有任何记录」。将来放开重复申请时，只需把这一条放宽成 `isActiveRefundStatus`，
 * 并且届时才需要考虑「已通过的能不能再退」。
 */
export function canRequestRefund(status: OrderStatus, hasRefundRecord: boolean): boolean {
  return isOrderRefundable(status) && !hasRefundRecord;
}

/** 能否撤销：只有待审核（pending）。审核中（reviewing）本阶段不允许撤销。 */
export function canCancelRefund(status: RefundStatus): boolean {
  return status === "pending";
}
