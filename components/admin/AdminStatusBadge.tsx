import type { AdminCategoryStatusKey } from "@/lib/constants/adminCategories";
import type { AdminContentStatusKey } from "@/lib/constants/adminContent";
import type { AdminCompanionStatusKey } from "@/lib/constants/adminCompanions";
import type { AdminProductStatusKey } from "@/lib/constants/adminProducts";
import type { ComplaintStatus } from "@/lib/types/complaint";
import type { CompanionApplicationStatus } from "@/lib/types/companionApplication";
import type { OrderStatus } from "@/lib/types/order";
import type { RefundStatus } from "@/lib/types/refund";
import type { AdminStaffState } from "@/lib/types/staff";

/**
 * 管理端状态标注。
 *
 * ⚠️ **状态不能只靠颜色表达**（§十一）：`label` 是必填的，任何一个状态都必然带一段文字，
 * 颜色只是辅助。色盲用户、黑白打印、截图转发都不会丢掉信息。
 * 需要更细的口径时（如「已停用 = 不在公开名单里，直链详情为只读」）用 `description` 补一句。
 *
 * 形状上也不依赖颜色：状态词前面有一个小方点，`aria-hidden` ——
 * 它对读屏没有意义，文字已经把状态说清楚了。
 */
export type AdminStatusTone = "success" | "pending" | "danger" | "muted";

/**
 * 业务状态 → 语气。
 *
 * 「哪个状态算红、算橙」只写在这里一处：管理端的申请状态、护航状态共用同一套语气，
 * 页面上不会出现「同一个状态在两个模块里颜色不一样」。
 * 语气只是辅助，状态文字始终由业务常量给出（`*_STATUS_LABELS`）。
 */
export const APPLICATION_STATUS_TONE: Record<CompanionApplicationStatus, AdminStatusTone> = {
  pending: "pending",
  reviewing: "pending",
  approved: "success",
  rejected: "danger",
  withdrawn: "muted",
};

export const COMPANION_STATUS_TONE: Record<AdminCompanionStatusKey, AdminStatusTone> = {
  removed: "muted",
  disabled: "danger",
  unavailable: "pending",
  available: "success",
};

/** 类目：已移除是终态（灰），已停用是「用户端看不到」的明确状态（红），已启用才是正常的（绿）。 */
export const CATEGORY_STATUS_TONE: Record<AdminCategoryStatusKey, AdminStatusTone> = {
  removed: "muted",
  disabled: "danger",
  enabled: "success",
};

/**
 * 商品：已下架用 `pending` 而不是 `danger`。
 *
 * 下架是**正常的运营动作**（改价期间先下架、活动结束下架），不是出问题；
 * 标成红色会让「一屏待处理的错误」这种错觉出现，真正需要抬头看的异常反而被淹没。
 * 已移除才是终态。
 */
export const PRODUCT_STATUS_TONE: Record<AdminProductStatusKey, AdminStatusTone> = {
  removed: "muted",
  off: "pending",
  on: "success",
};

/**
 * 订单：**进行中的三个状态共用 `pending`**，只有「已完成」是绿的。
 *
 * 已付款 / 已接单 / 护航中之间没有「好坏」之分，它们是同一件事的三个阶段；
 * 给它们三种颜色会让人以为颜色深的那个出了问题。已退款是灰的终态——
 * 这一单不再计入累计有效消费，与「已完成」必须一眼分得开。
 */
export const ORDER_STATUS_TONE: Record<OrderStatus, AdminStatusTone> = {
  paid: "pending",
  accepted: "pending",
  serving: "pending",
  completed: "success",
  refunded: "muted",
};

/**
 * 退款申请：已通过是绿的（对申请人而言这是结论），已拒绝是红的（需要被看见），
 * 已撤销是灰的（用户自己的动作，不是平台的结论）。
 *
 * ⚠️ 绿色**不代表钱已经退回去了**：这是 Mock 审核。页面必须同时展示
 * `ADMIN_REFUND_MOCK_NOTICE`，颜色不能独自承担这句话。
 */
export const REFUND_STATUS_TONE: Record<RefundStatus, AdminStatusTone> = {
  pending: "pending",
  reviewing: "pending",
  approved: "success",
  rejected: "danger",
  cancelled: "muted",
};

/**
 * 投诉：已处理是绿的（给出了结论），已关闭是**灰的而不是红的**——
 * 关闭是终态但不是失败：重复提交、联系不上、用户自己不再追问都会走到这里。
 * 标红会让「一屏待处理的错误」这种错觉出现。
 */
export const COMPLAINT_STATUS_TONE: Record<ComplaintStatus, AdminStatusTone> = {
  pending: "pending",
  processing: "pending",
  resolved: "success",
  closed: "muted",
};

/**
 * 客服账号：已移除是灰的终态，已停用是红的（**停用是有后果的**——
 * 该账号当场失去工作台权限，已有会话 Cookie 也失效），启用中才是绿的。
 *
 * 与类目、商品同一套口径：**「停用」不是「预备」，是「现在用不了」**，
 * 因此用 `danger` 而不是 `pending`。用 `pending` 会让人以为它在等什么。
 */
export const STAFF_STATE_TONE: Record<AdminStaffState, AdminStatusTone> = {
  removed: "muted",
  disabled: "danger",
  enabled: "success",
};

/**
 * 运营内容（图片公告 / 活动 Banner / 快捷入口）：与类目、客服账号**同一套口径**。
 *
 * ⚠️ 这里没有复用 `CATEGORY_STATUS_TONE` 的常量名，但三个取值与语气完全一致——
 * 两处都来自「已移除是终态（灰）、已停用是现在用不了（红）、已启用才是正常的（绿）」，
 * 运营在侧栏里切换模块时看到的颜色不该变。协议与版本介绍只有启用 / 停用两档
 * （协议没有软删除），用的是同一张表里的两个键。
 */
export const CONTENT_STATUS_TONE: Record<AdminContentStatusKey, AdminStatusTone> = {
  removed: "muted",
  disabled: "danger",
  enabled: "success",
};

const TONE_CLASS: Record<AdminStatusTone, string> = {
  success: "text-status-success",
  pending: "text-status-pending",
  danger: "text-status-danger",
  muted: "text-status-muted",
};

const DOT_CLASS: Record<AdminStatusTone, string> = {
  success: "bg-status-success",
  pending: "bg-status-pending",
  danger: "bg-status-danger",
  muted: "bg-status-muted",
};

export default function AdminStatusBadge({
  label,
  description,
  tone = "muted",
}: {
  label: string;
  description?: string;
  tone?: AdminStatusTone;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={`flex items-center gap-1.5 text-[13px] font-medium ${TONE_CLASS[tone]}`}>
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]}`} />
        {label}
      </span>
      {description ? (
        <span className="text-[12px] leading-4 text-ink-3">{description}</span>
      ) : null}
    </span>
  );
}
