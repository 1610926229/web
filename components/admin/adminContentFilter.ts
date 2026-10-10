import {
  adminContentStatus,
  type AdminContentStatus,
  type ContentRemovalFilter,
} from "@/lib/constants/adminContent";

/**
 * 运营内容三张列表（公告 / Banner / 快捷入口）共用的**状态筛选口径**。
 *
 * ⚠️ 抽成单独一个模块，是因为它是**一套口径**而不是一段界面：三个列表上
 * 「全部 / 已启用 / 已停用 / 已移除」四个数字必须回答同一个问题，
 * 各写一份就会出现「公告页的『全部』含已移除、快捷入口页的不含」这类差异，
 * 而那种差异从界面上看不出来，只会让人对数字失去信任。
 *
 * ⚠️ 它**不是接口的第四种筛选**：接口只认 `removal`（要不要看已移除的那批），
 * 「已启用 / 已停用」是在取回的那一批里再分一次。因此「全部」指的是
 * **未移除的全部**，数字是 `enabled + disabled`，而不是 `counts.all`。
 * 这个模块里没有任何服务端依赖，因此客户端组件引用它不会把服务端模块
 * 打进浏览器产物。
 */
export type ContentStatusFilter = "all" | "enabled" | "disabled" | "removed";

export const CONTENT_STATUS_FILTERS: readonly ContentStatusFilter[] = [
  "all",
  "enabled",
  "disabled",
  "removed",
];

export const CONTENT_STATUS_FILTER_LABELS: Record<ContentStatusFilter, string> = {
  all: "全部",
  enabled: "已启用",
  disabled: "已停用",
  removed: "已移除",
};

/** 四个角标的数字，由服务端给出（口径覆盖全部记录，含已移除）。 */
export type ContentCounts = {
  all: number;
  enabled: number;
  disabled: number;
  removed: number;
};

/** 这个筛选对应的接口口径：只有「已移除」会换一次查询，其余三个在同一批数据里分。 */
export function removalForContentFilter(filter: ContentStatusFilter): ContentRemovalFilter {
  return filter === "removed" ? "removed" : "active";
}

/** 页面首次渲染时的筛选：地址栏说 `removal=removed` 就停在「已移除」，否则是「全部」。 */
export function initialContentStatusFilter(removal: ContentRemovalFilter): ContentStatusFilter {
  return removal === "removed" ? "removed" : "all";
}

export function filterRowsByContentStatus<T extends { enabled: boolean }>(
  rows: readonly T[],
  filter: ContentStatusFilter,
): T[] {
  if (filter === "enabled") return rows.filter((row) => row.enabled);
  if (filter === "disabled") return rows.filter((row) => !row.enabled);
  // 「全部」与「已移除」都直接放行：调用方已经把「已移除」那批单独取回来了，
  // 这里再判一次状态等于把同一件事写两遍，而两遍就有不一致的可能
  return rows.slice();
}

/** 筛选按钮上的数字。四个数加起来是全部记录数（含已移除），与 `counts.all` 对得上。 */
export function contentFilterCount(counts: ContentCounts, filter: ContentStatusFilter): number {
  if (filter === "all") return counts.enabled + counts.disabled;
  return counts[filter];
}

/**
 * 喂给 `adminContentStatus()` 的非空时间戳占位。
 *
 * ⚠️ 它只是个占位：那个函数只判「是不是 null」。列表页本来就不展示移除时间
 * （需要看时间的地方走实体与审计快照），因此不必为了一个布尔判断把时间戳
 * 塞进列表 DTO。
 */
const REMOVED_AT_SENTINEL = "removed";

/**
 * 一条内容记录在后台眼里的状态。
 *
 * ⚠️ 需要这个适配，是因为列表 DTO 给的是 `removed: boolean`
 * （见 `AdminContentFields` 的注释），而状态函数认的是 `removedAt`。
 * 状态文案仍然只有 `lib/constants/adminContent.ts` 一份——三张列表都调这里，
 * 谁也不复制第二份标签与说明。
 */
export function contentStatusOf(record: {
  enabled: boolean;
  removed: boolean;
}): AdminContentStatus {
  return adminContentStatus({
    enabled: record.enabled,
    removedAt: record.removed ? REMOVED_AT_SENTINEL : null,
  });
}
