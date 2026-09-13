/**
 * 商品目录两块后台列表（类目 / 商品）**共用的筛选规则**。
 *
 * ⚠️ 本文件没有任何运行时依赖，客户端与服务端都能引用，node 也能直接加载它做纯逻辑测试。
 *
 * 单独开一个文件而不是让商品去 import 类目那个：两个列表的筛选参数名是一样的
 * （`keyword` / `gameId` / `removal`），但 **类目没有 `status`、商品没有 `enabled`**，
 * 各自差异的那部分留在各自的文件里。共用部分写两份的话，「removal 只接受
 * active / removed」这句话就会有四处副本，而其中一处迟早会漏掉一次大小写归一。
 *
 * 三条口径与其它管理列表保持一致：
 * 1. **筛选值写错要报错**（接口 400），不能悄悄回退到默认值——否则
 *    「我明明筛了已停用，怎么还有启用的」会变成一个查不出来的问题；
 * 2. **页码写错不报错**，规范化到第 1 页（`clampPage`）：页码不是业务内容；
 * 3. **关键词只去首尾空格**，不静默截断。
 */

import { clampPage, clampPageSize } from "./pagination";

/** 页码上限。与其它列表同一个数，避免构造出天文数字的偏移量。 */
export const ADMIN_CATALOG_MAX_PAGE = 1000;

/** 每页条数上限。 */
export const ADMIN_CATALOG_MAX_PAGE_SIZE = 50;

/** 搜索关键词：只去首尾空格。搜索词不是业务枚举，过长不会造成危害，也不静默截断。 */
export function readAdminCatalogKeyword(raw: string | null): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 分页参数。两块列表的规则完全一样，因此共用一个构造函数。 */
export function readAdminCatalogPaging(
  params: URLSearchParams,
  defaultPageSize: number,
): { page: number; pageSize: number } {
  return {
    page: clampPage(params.get("page"), ADMIN_CATALOG_MAX_PAGE),
    pageSize: clampPageSize(params.get("pageSize"), defaultPageSize, ADMIN_CATALOG_MAX_PAGE_SIZE),
  };
}

// ——————————————————————————— 是否包含已移除 ———————————————————————————

/**
 * 是否包含已移除的记录。默认 `active`（不显示已移除）。
 *
 * ⚠️ 已移除的记录**只能在这里被筛到**：用户端永远看不到它们，
 * 但后台必须能查——「这条类目被移除过」是运营要回答的问题，
 * 一份查不到历史的列表等于把软删除做成了硬删除。
 */
export type AdminCatalogRemovalFilter = "active" | "removed";

export const ADMIN_CATALOG_REMOVAL_FILTERS: readonly AdminCatalogRemovalFilter[] = [
  "active",
  "removed",
];

export const ADMIN_CATALOG_REMOVAL_FILTER_LABELS: Record<AdminCatalogRemovalFilter, string> = {
  active: "使用中",
  removed: "已移除",
};

export const DEFAULT_ADMIN_CATALOG_REMOVAL_FILTER: AdminCatalogRemovalFilter = "active";

export const ADMIN_CATALOG_REMOVAL_INVALID_MESSAGE = "筛选条件 removal 只能是 active / removed";

export function isAdminCatalogRemovalFilter(value: string): value is AdminCatalogRemovalFilter {
  return (ADMIN_CATALOG_REMOVAL_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口抛 400）。空值按默认筛选处理。 */
export function readAdminCatalogRemovalFilter(
  raw: string | null,
): AdminCatalogRemovalFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_CATALOG_REMOVAL_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_CATALOG_REMOVAL_FILTER;
  return isAdminCatalogRemovalFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminCatalogRemovalFilter(
  raw: string | null,
): AdminCatalogRemovalFilter {
  return readAdminCatalogRemovalFilter(raw) ?? DEFAULT_ADMIN_CATALOG_REMOVAL_FILTER;
}

// ——————————————————————————— 启用状态（类目） ———————————————————————————

/** 类目的启用状态筛选。`""` 表示不限。 */
export type AdminEnabledFilter = "" | "enabled" | "disabled";

export const ADMIN_ENABLED_FILTERS: readonly AdminEnabledFilter[] = ["", "enabled", "disabled"];

export const ADMIN_ENABLED_FILTER_LABELS: Record<AdminEnabledFilter, string> = {
  "": "全部状态",
  enabled: "已启用",
  disabled: "已停用",
};

export const ADMIN_ENABLED_INVALID_MESSAGE = "筛选条件 enabled 只能是 enabled / disabled";

export function isAdminEnabledFilter(value: string): value is AdminEnabledFilter {
  return (ADMIN_ENABLED_FILTERS as readonly string[]).includes(value);
}

export function readAdminEnabledFilter(raw: string | null): AdminEnabledFilter | null {
  if (raw === null || raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  return isAdminEnabledFilter(value) ? value : null;
}

// ——————————————————————————— 上下架（商品） ———————————————————————————

/** 商品的上下架筛选。`""` 表示不限。 */
export type AdminStatusFilter = "" | "on" | "off";

export const ADMIN_STATUS_FILTERS: readonly AdminStatusFilter[] = ["", "on", "off"];

export const ADMIN_STATUS_FILTER_LABELS: Record<AdminStatusFilter, string> = {
  "": "全部状态",
  on: "已上架",
  off: "已下架",
};

export const ADMIN_STATUS_INVALID_MESSAGE = "筛选条件 status 只能是 on / off";

export function isAdminStatusFilter(value: string): value is AdminStatusFilter {
  return (ADMIN_STATUS_FILTERS as readonly string[]).includes(value);
}

export function readAdminStatusFilter(raw: string | null): AdminStatusFilter | null {
  if (raw === null || raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  return isAdminStatusFilter(value) ? value : null;
}

// ——————————————————————————— 推荐状态（商品） ———————————————————————————

/** 商品的推荐状态筛选。`""` 表示不限。 */
export type AdminRecommendedFilter = "" | "recommended" | "normal";

export const ADMIN_RECOMMENDED_FILTERS: readonly AdminRecommendedFilter[] = [
  "",
  "recommended",
  "normal",
];

export const ADMIN_RECOMMENDED_FILTER_LABELS: Record<AdminRecommendedFilter, string> = {
  "": "全部",
  recommended: "已推荐",
  normal: "未推荐",
};

export const ADMIN_RECOMMENDED_INVALID_MESSAGE =
  "筛选条件 recommended 只能是 recommended / normal";

export function isAdminRecommendedFilter(value: string): value is AdminRecommendedFilter {
  return (ADMIN_RECOMMENDED_FILTERS as readonly string[]).includes(value);
}

export function readAdminRecommendedFilter(raw: string | null): AdminRecommendedFilter | null {
  if (raw === null || raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  return isAdminRecommendedFilter(value) ? value : null;
}

// ——————————————————————————— id 类筛选（游戏 / 类目） ———————————————————————————

/**
 * 读一个「必须是已知 id 之一」的筛选参数（游戏 id、类目 id 共用）。
 *
 * 返回 `""` 表示不限，返回 `null` 表示这个 id **不在已知集合里**（由接口抛 400）。
 * 与关键词的区别：`gameId=nonexistent` 不是「搜不到」，而是一个根本不存在的筛选条件，
 * 悄悄按「不限」处理会让调用方以为筛选生效了、结果却是全部记录。
 *
 * @param knownIds 已知 id 集合；传 `null` 表示不做存在性校验（页面侧用它读类目 id，
 *   因为页面本来就要把整份类目列表交给选择器，交上去之后再判也不迟）
 */
export function readAdminCatalogId(
  raw: string | null,
  knownIds: readonly string[] | null,
): string | null {
  if (raw === null || raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  if (knownIds === null) return value;
  return knownIds.includes(value) ? value : null;
}
