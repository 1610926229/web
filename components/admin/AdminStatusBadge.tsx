import type { AdminCategoryStatusKey } from "@/lib/constants/adminCategories";
import type { AdminCompanionStatusKey } from "@/lib/constants/adminCompanions";
import type { AdminProductStatusKey } from "@/lib/constants/adminProducts";
import type { CompanionApplicationStatus } from "@/lib/types/companionApplication";

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
