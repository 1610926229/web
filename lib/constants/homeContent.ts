import { isSafePath } from "./safePath";
import type {
  AdminAnnouncementItem,
  AdminBannerItem,
  AdminQuickEntryItem,
  AnnouncementImage,
  ContentAnnouncementRecord,
  ContentBannerRecord,
  HomeShortcut,
  QuickEntryRecord,
} from "@/lib/types/content";

/**
 * 首页运营内容的**唯一**一份挑选与转换规则（纯函数）。
 *
 * ⚠️ 本文件回答的问题只有一个：**哪些记录会出现在用户端，以及长什么样**。
 * 服务端页面、Route Handler、后台预览读的都是这里，因此不存在「页面看到的」
 * 与「接口返回的」分叉——那种分叉在验收时表现为「刷新一下又变了」。
 *
 * 为什么不把这套规则写进 `mockContentRepository`：仓储的职责是**存取**，
 * 将来换成数据库时这一层会被 SQL 替换掉；而「用户端该看到哪几条」是一条**业务规则**，
 * 换数据库不该改变它。规则留在这里，换存储时一个字都不用改。
 */

/** 用户端可见：启用中，且未被软移除。 */
export function isContentVisible(record: { enabled: boolean; removedAt: string | null }): boolean {
  return record.enabled && record.removedAt === null;
}

/**
 * 用户端展示顺序：`sortOrder` 升序，相同则 `id` 升序。
 *
 * ⚠️ 必须**两级都定死**。只比 `sortOrder` 时，两条排序值相同的记录在不同请求里
 * 可能以不同顺序返回（取决于底层容器的遍历顺序），于是首页会出现
 * 「刷新一下公告图就换了个位置」这种没人改过任何东西的变动。
 * 加一条 `id` 兜底之后，排序是**全序**，任何输入都只有一个输出顺序。
 */
export function compareContentOrder(
  a: { id: string; sortOrder: number },
  b: { id: string; sortOrder: number },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 用户端公告：按顺序取出可见的那些，只留图片与替代文本。 */
export function selectPublicAnnouncements(
  records: readonly ContentAnnouncementRecord[],
): AnnouncementImage[] {
  return records
    .filter(isContentVisible)
    .slice()
    .sort(compareContentOrder)
    .map((record) => ({ id: record.id, imageUrl: record.imageUrl, alt: record.alt }));
}

/**
 * 用户端活动图：**只有一张**。
 *
 * ⚠️ 这是 §三 冻结口径的落点：后台可以预置多张 Banner（运营要提前备好素材），
 * 但用户端首页仍然是**一张图**，不是轮播。挑选规则是
 * `enabled === true` → `sortOrder` 升序 → `id` 升序 → 取第一条，
 * 因此后台改 `enabled` 或 `sortOrder` 之后，用户刷新看到的就是新的那张。
 *
 * 一张都没有时返回空串：首页据此隐藏活动位（`hasActivity` 判断已存在），
 * **不返回 null、不返回占位图**——占位图会让「后台一张都没配」看起来像配好了。
 */
export function selectActivityImageUrl(records: readonly ContentBannerRecord[]): string {
  const first = records
    .filter(isContentVisible)
    .slice()
    .sort(compareContentOrder)[0];

  return first ? first.imageUrl : "";
}

/** 一条快捷入口记录 → 用户端 DTO。`href` 就是记录里的 `path`。 */
export function toHomeShortcut(record: QuickEntryRecord): HomeShortcut {
  return {
    id: record.id,
    label: record.label,
    href: record.path,
    icon: record.icon,
  };
}

/**
 * 用户端快捷入口：可见 + **地址安全** + 按顺序。
 *
 * ⚠️ 「地址安全」这一条**在这里再判一次**，尽管事务层写入前已经校验过。
 * 两次判断不是冗余：这里是**最后一道**关卡，而它守的是「用户端 `<Link>` 的
 * `href` 里不出现 `javascript:`」这条安全属性。写入侧将来若多出一条路径
 * （批量导入、种子数据、直接的仓储写入），这一层仍然拦得住。
 * 安全属性的守门函数可以重复，不可以缺失。
 */
export function selectPublicShortcuts(records: readonly QuickEntryRecord[]): HomeShortcut[] {
  return records
    .filter(isContentVisible)
    .filter((record) => isSafePath(record.path))
    .slice()
    .sort(compareContentOrder)
    .map(toHomeShortcut);
}

// ————————————————————————— 管理端 DTO —————————————————————————

/**
 * 后台列表的排序：`sortOrder` 升序、`id` 升序。
 *
 * ⚠️ 与用户端**同一个全序**（直接复用 `compareContentOrder`），但列表里多了一类
 * 用户端没有的记录（停用 / 已移除）。刻意让两边顺序一致：后台看到的第一条
 * 就是用户端的第一条，运营调完顺序不必再去用户端猜「现在谁在最前面」。
 */
function sortForAdmin<T extends { id: string; sortOrder: number }>(records: readonly T[]): T[] {
  return records.slice().sort(compareContentOrder);
}

export function toAdminAnnouncementItem(record: ContentAnnouncementRecord): AdminAnnouncementItem {
  return {
    id: record.id,
    title: record.title,
    imageUrl: record.imageUrl,
    alt: record.alt,
    enabled: record.enabled,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removed: record.removedAt !== null,
  };
}

export function toAdminBannerItem(record: ContentBannerRecord): AdminBannerItem {
  return {
    id: record.id,
    title: record.title,
    imageUrl: record.imageUrl,
    alt: record.alt,
    enabled: record.enabled,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removed: record.removedAt !== null,
  };
}

export function toAdminQuickEntryItem(record: QuickEntryRecord): AdminQuickEntryItem {
  return {
    id: record.id,
    label: record.label,
    icon: record.icon,
    path: record.path,
    enabled: record.enabled,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removed: record.removedAt !== null,
  };
}

export function toAdminAnnouncementList(
  records: readonly ContentAnnouncementRecord[],
): AdminAnnouncementItem[] {
  return sortForAdmin(records).map(toAdminAnnouncementItem);
}

export function toAdminBannerList(records: readonly ContentBannerRecord[]): AdminBannerItem[] {
  return sortForAdmin(records).map(toAdminBannerItem);
}

export function toAdminQuickEntryList(records: readonly QuickEntryRecord[]): AdminQuickEntryItem[] {
  return sortForAdmin(records).map(toAdminQuickEntryItem);
}
