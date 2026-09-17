import { ApiError } from "@/lib/api/ApiError";
import { clampPage, clampPageSize, mergePageResult } from "@/lib/constants/pagination";
import {
  NOTIFICATION_MAX_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE,
  parseNotificationInput,
} from "@/lib/constants/service";
import { getNotificationRepository } from "@/lib/data/notificationRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  Notification,
  NotificationInput,
  NotificationListItem,
  NotificationPage,
} from "@/lib/types/notification";

/**
 * 系统通知服务 —— 客服首页「系统通知」与通知接口共用的唯一入口。
 *
 * 三条规则：
 *
 * 1. **只返回当前用户的通知**。仓储按 `userId` 取，服务层再按 id 校验一次归属，
 *    不存在与不属于你表现完全一致（404）。
 * 2. **通知正文与订单列表 DTO 一样有边界**：`Notification` 从建立之初就没有游戏 ID、
 *    备注、退款说明这类字段，`href` 里也只允许出现资源 id。因此列表 DTO 与仓储类型同构，
 *    不需要再切一次——注释里把这条约束写清楚，避免以后有人往里加字段。
 * 3. **标记已读幂等**。已经是已读的通知再次标记不会改动原来的已读时间。
 */

/** 通知 → 列表项。目前两者同构（通知本来就是给用户看的内容），转换函数保留是为了显式挑字段。 */
export function toNotificationListItem(notification: Notification): NotificationListItem {
  return {
    id: notification.id,
    userId: notification.userId,
    kind: notification.kind,
    title: notification.title,
    summary: notification.summary,
    body: notification.body,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    href: notification.href,
  };
}

/** 最近的通知排前面。时间相同时用 id 兜底，保证顺序稳定。 */
function compareNotificationsNewestFirst(a: Notification, b: Notification): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * 查询当前用户的通知列表。
 *
 * 分页沿用 `PageResult` 契约，并且用与订单列表**同一套**页码规范化：
 * 坏掉的页码不该让整页报错。通知数量很少，分页在服务层对全量结果切片即可，
 * 仓储只提供「取全量」这一个方法。
 */
export async function queryNotificationsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<NotificationPage> {
  const page = clampPage(params.get("page"));
  const pageSize = clampPageSize(params.get("pageSize"), NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_PAGE_SIZE);

  const all = await withMockDebug(params, surface, () =>
    getNotificationRepository().listNotifications(userId),
  );
  const sorted = all.sort(compareNotificationsNewestFirst);

  const start = (page - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize);

  return {
    items: items.map(toNotificationListItem),
    page,
    pageSize,
    total: sorted.length,
    hasMore: start + items.length < sorted.length,
    unreadCount: sorted.filter((notification) => notification.readAt === null).length,
  };
}

/** 「加载更多」的合并规则与订单 / 投诉列表完全一致（追加 + 去重）。 */
export function mergeNotificationPage(
  current: NotificationPage,
  next: NotificationPage,
): NotificationPage {
  const merged = mergePageResult(current, next);
  return { ...merged, unreadCount: next.unreadCount };
}

/**
 * 标记通知已读。
 *
 * 通知不存在、或不属于当前用户，一律抛 `NOT_FOUND`——**两种情况的对外表现完全相同**，
 * 从而不能拿别人的通知 id 来试探它是否存在。
 */
export async function markNotificationReadForUser(
  userId: string,
  notificationId: string,
): Promise<NotificationListItem> {
  if (!notificationId) throw new ApiError("NOT_FOUND", "通知不存在");

  const updated = await getNotificationRepository().markNotificationRead(
    notificationId,
    userId,
    new Date().toISOString(),
  );
  if (!updated) throw new ApiError("NOT_FOUND", "通知不存在");

  return toNotificationListItem(updated);
}

/**
 * 写入一条通知（P0-2）——**通知的唯一写入口**。
 *
 * 谁调用它：平台侧的业务事件（订单退回公共池、公共池超时自动退款……）。
 * **用户端没有任何入口**：用户不会自己给自己发通知，因此这里没有「当前登录用户」
 * 这个概念，收件人由调用方**在服务端算出来**传进来。
 *
 * ⚠️ **不要在这里判断「这条通知该不该发」**。发不发的规则属于业务本身
 * （超时退款必须通知老板、接单必须通知老板），放在这里会让两处规则迟早分叉；
 * 本函数只负责「内容合法就写下去」。内容边界（空字段、站内地址）由
 * `parseNotificationInput` 统一判定，非法值一律 400，**绝不静默补默认值**——
 * 一条标题为空的通知在列表里就是一个空白条目。
 *
 * ⚠️ 需要与业务写入**同段完成**的调用方不要走这里：本函数是异步的，在原子区段里
 * 调用它会把区段切开。那种场景用 `appendNotification`（同步）。
 */
export async function createNotificationForUser(
  input: NotificationInput,
): Promise<NotificationListItem> {
  const parsed = parseNotificationInput(input);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  const created = await getNotificationRepository().createNotification(parsed.value);
  return toNotificationListItem(created);
}
