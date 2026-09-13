import type { PageResult } from "./common";

/**
 * 系统通知类型。
 *
 * ⚠️ 通知正文**不得包含游戏 ID、订单备注等敏感订单信息**：通知是只读的展示内容，
 * 需要看订单细节时通过 `href` 进到对应页面（那里会重新校验归属）。
 * `href` 里只允许出现资源 id，不允许带上说明、理由或消息正文。
 */

export type NotificationKind = "order" | "refund" | "complaint" | "system";

export type Notification = {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  /** 列表上的摘要，一行 */
  summary: string;
  /** 展开后的正文 */
  body: string;
  createdAt: string;
  /** 已读时间；未读为 null */
  readAt: string | null;
  /** 可选的跳转地址；为 null 表示只能在本页展开阅读 */
  href: string | null;
};

/**
 * 通知列表项 DTO。
 *
 * 与仓储类型字段一致是有意的：通知本来就是给用户看的内容，
 * 从建立之初就没有游戏 ID、备注、退款说明这类字段，不需要再切一次。
 */
export type NotificationListItem = Notification;

/**
 * 通知列表的一页。
 *
 * 在通用的 `PageResult` 之上多一个 `unreadCount`：客服页要在子 Tab 上显示未读数，
 * 为了一个角标再发一次请求不值得。未读数是**当前用户的**，因此不会把别人的未读算进来。
 */
export type NotificationPage = PageResult<NotificationListItem> & { unreadCount: number };
