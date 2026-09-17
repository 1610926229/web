import type { PageResult } from "./common";

/**
 * 系统通知类型。
 *
 * ⚠️ 通知正文**不得包含游戏 ID、订单备注等敏感订单信息**：通知是只读的展示内容，
 * 需要看订单细节时通过 `href` 进到对应页面（那里会重新校验归属）。
 * `href` 里只允许出现资源 id，不允许带上说明、理由或消息正文。
 */

/**
 * 通知类型。
 *
 * `dispatch`（派单相关）是 P0-2 新增的：接单、放弃、超时退款、订单退回公共池
 * 都发生在**打手与订单之间**，用「订单」这一个标签概括会让用户看不出这条通知
 * 说的是「有人在处理你的单」还是「你的单又没人接了」。
 */
export type NotificationKind = "order" | "refund" | "complaint" | "dispatch" | "system";

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
 * **创建一条通知的输入**（P0-2）。
 *
 * ⚠️ 只有这六样：`id` / `createdAt` / `readAt` **不在入参里**——
 * id 由仓储生成（调用方给 id 就等于允许覆盖别人的记录），
 * `createdAt` 与 `readAt` 是事实而不是意图：一条通知不可能「创建出来就是已读的」。
 *
 * ⚠️ 即使将来由订单超时退款调用，`userId` 也必须是**服务端算出来的收件人**，
 * 不能来自请求体——通知的归属与订单的归属是同一条边界。
 */
export type NotificationInput = {
  /** 收件人（服务端决定，见上） */
  userId: string;
  kind: NotificationKind;
  title: string;
  summary: string;
  body: string;
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
