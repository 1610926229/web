import { apiGet, apiPost } from "@/lib/api/client";
import type { MessageTarget } from "@/lib/constants/service";
import type {
  OrderConversation,
  OrderConversationSegment,
  OrderMessageView,
} from "@/lib/types/message";
import type { NotificationListItem, NotificationPage } from "@/lib/types/notification";

/**
 * 客服专区（订单沟通 / 系统通知）的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/conversations.ts`、`lib/services/notifications.ts` 分开是必须的：
 * 那两个模块依赖 `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，
 * Mock 层与内存存储就会被打进浏览器产物。
 *
 * 客服首页三个子 Tab 的首屏由 Server Component 直接取数，不经过本文件；
 * 这里是「发送消息 / 刷新 / 标记已读 / 加载更多通知」这些用户操作要走的路。
 */

/**
 * 聊天页的载荷（P0-14）。
 *
 * ⚠️ 消息类型是 `OrderMessageView` 而**不是** `OrderMessage`：对外 DTO 里没有
 * `conversationId`（内部键）。用仓储类型标注这个响应，等于在类型层面承认
 * 「响应里可以带内部键」——而运行时的响应里并没有它，标注会反过来骗人。
 */
export type OrderConversationPayload = {
  conversation: OrderConversation;
  /** 全部段落按时间线扁平的消息，与 P0-14 之前同形 */
  messages: OrderMessageView[];
  /** 分段视图：客服沟通在前，其后各段护航沟通（含已结束的历史段） */
  segments: OrderConversationSegment[];
};

/** 读取某一笔订单的沟通记录（订单是自己但还没会话时，服务端会顺手建立会话）。 */
export function fetchConversation(orderId: string): Promise<OrderConversationPayload> {
  return apiGet<OrderConversationPayload>(`/api/orders/${encodeURIComponent(orderId)}/messages`);
}

/**
 * 发送一条消息。
 *
 * `idempotencyKey` 由页面在**一次发送动作开始时**生成并保持不变：
 * 失败重试沿用同一个键，因此重试不会产生第二条消息。
 *
 * ⚠️ `target` 是**角色**而不是会话 id（P0-14）：用户表达的是「这句话给谁」，
 * 而不是「写进哪一段」。会话 id 是内部键，让客户端指定它等于把越权通道
 * 做进了接口签名里——历史段落因此从结构上就不可能被寻址。
 */
export function sendMessage(
  orderId: string,
  body: string,
  idempotencyKey: string,
  target: MessageTarget,
): Promise<{ messageId: string; created: boolean }> {
  return apiPost<{ messageId: string; created: boolean }>(
    `/api/orders/${encodeURIComponent(orderId)}/messages`,
    { body, idempotencyKey, target },
  );
}

/** 标记会话已读（进入聊天页时调用）。 */
export function markConversationRead(orderId: string): Promise<{ orderId: string; read: boolean }> {
  return apiPost<{ orderId: string; read: boolean }>(
    `/api/orders/${encodeURIComponent(orderId)}/messages/read`,
  );
}

/** 系统通知列表（含未读条数）。 */
export function fetchNotifications(page = 1, pageSize?: number): Promise<NotificationPage> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  return apiGet<NotificationPage>(`/api/notifications?${params.toString()}`);
}

/** 标记通知已读。 */
export function markNotificationRead(notificationId: string): Promise<NotificationListItem> {
  return apiPost<NotificationListItem>(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
  );
}
