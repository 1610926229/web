import { ApiError } from "@/lib/api/ApiError";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { normalizeMessageBody } from "@/lib/constants/service";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type { ConversationStats, OrderConversation, OrderConversationRecord, OrderMessage } from "@/lib/types/message";

/**
 * 订单沟通服务 —— 客服首页的会话列表、聊天页与消息接口共用的唯一入口。
 *
 * 四条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只能看 / 只能发自己的订单会话**。所有入口都先按订单归属校验，不属于当前用户的
 *    订单一律当作不存在（404），拿不到可区分的「这不是你的」信息。
 * 2. **发送者身份由服务端写入**。请求体里没有 `senderRole` / `senderId` / `senderName`
 *    这些字段可读，客户端无法伪造「客服」或「打手」发消息。
 * 3. **不做实时聊天**。没有 WebSocket：发送后由页面重新拉取，刷新也是重新拉取。
 * 4. **写入幂等**。「订单 + 发送者 + 幂等键」只产生一条消息，快速连点不会刷出重复消息。
 */

// ——————————————————————————— 会话统计 ———————————————————————————

/**
 * 会话 + 消息 → 统计信息。
 *
 * 未读数只统计**别人发来的、且在用户上次已读之后**的消息：自己发的消息永远不会让自己
 * 变成未读，否则发完一条消息角标就冒出来了。
 */
export function buildConversationStats(
  conversation: OrderConversationRecord,
  messages: OrderMessage[],
): ConversationStats {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastReadAt = conversation.userLastReadAt;

  const unreadCount = messages.filter(
    (message) =>
      message.senderRole !== "user" && (lastReadAt === null || message.createdAt > lastReadAt),
  ).length;

  return {
    orderId: conversation.orderId,
    messageCount: messages.length,
    lastMessageBody: last ? last.body : null,
    lastMessageAt: last ? last.createdAt : null,
    unreadCount,
  };
}

/** 会话列表排序：最近有消息的排前面，没有消息的按会话创建时间排。 */
function compareConversationsNewestFirst(a: OrderConversation, b: OrderConversation): number {
  const aAt = a.lastMessageAt ?? "";
  const bAt = b.lastMessageAt ?? "";
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  if (a.orderNo !== b.orderNo) return a.orderNo < b.orderNo ? 1 : -1;
  return 0;
}

/** 会话 + 订单 → 列表项 DTO。**显式挑字段**：游戏 ID 与备注都不会出现在会话列表里。 */
function toOrderConversation(
  stats: ConversationStats,
  order: Order,
  messages: OrderMessage[],
): OrderConversation {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return {
    ...stats,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    // 订单当前状态：会话不会改变它，只是顺带展示
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    lastMessageRole: last ? last.senderRole : null,
  };
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 当前用户的会话列表（客服首页「订单沟通」）。
 *
 * 会话不存在的订单不会出现在这里——用户可以主动从「联系客服」里选一笔订单发起沟通
 * （见 `getMessagesForUser`），发起之后会话就出现在列表里。
 */
export async function listConversationsForUser(
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<OrderConversation[]> {
  const repository = getMessageRepository();

  const [conversations, grouped] = await withMockDebug(params, surface, () =>
    Promise.all([repository.listConversations(userId), repository.listMessagesGrouped(userId)]),
  );

  const orders = await Promise.all(
    conversations.map((conversation) => getPaymentRepository().findOrderById(conversation.orderId)),
  );

  return conversations
    .flatMap((conversation, index) => {
      const order = orders[index];
      // 订单不存在属于数据异常：这条会话渲染不出来（没有订单号可展示），跳过而不是整页报错
      if (!order) return [];
      const messages = grouped.get(conversation.orderId) ?? [];
      return [toOrderConversation(buildConversationStats(conversation, messages), order, messages)];
    })
    .sort(compareConversationsNewestFirst);
}

/** 聊天页的订单摘要（用于页头展示订单号与商品名）。 */
export async function getConversationOrderForUser(
  userId: string,
  orderId: string,
): Promise<Order | null> {
  if (!orderId) return null;
  const order = await getPaymentRepository().findOrderById(orderId);
  if (!order || order.userId !== userId) return null;
  return order;
}

/**
 * 读取某一笔订单的沟通记录。
 *
 * 订单不存在或不属于当前用户返回 null（调用方转 404）。
 * 订单是自己的但还没有会话时**顺手建立会话**：这正是「用户主动发起沟通」这个动作，
 * 不需要额外的接口，也不会重复建（`ensureConversation` 幂等）。
 */
export async function getMessagesForUser(
  userId: string,
  orderId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ conversation: OrderConversation; messages: OrderMessage[] } | null> {
  const order = await getConversationOrderForUser(userId, orderId);
  if (!order) return null;

  const repository = getMessageRepository();
  const conversation = await withMockDebug(params, surface, () =>
    repository.ensureConversation(userId, orderId, new Date().toISOString()),
  );
  const messages = await repository.listMessages(userId, orderId);

  return { conversation: toOrderConversation(buildConversationStats(conversation, messages), order, messages), messages };
}

/** 把会话标记为已读（进入聊天页时调用）。会话不属于当前用户时返回 false。 */
export async function markConversationReadForUser(
  userId: string,
  orderId: string,
): Promise<boolean> {
  const updated = await getMessageRepository().markConversationRead(
    userId,
    orderId,
    new Date().toISOString(),
  );
  return updated !== null;
}

// ——————————————————————————— 发送 ———————————————————————————

/**
 * 发送一条消息。
 *
 * 三条约束在写入前全部由服务端完成：
 *
 * 1. **订单必须是自己的**（否则 404）——请求里只有订单 id，没有别的归属信息可伪造；
 * 2. **内容去空白后必须非空且不超长**——只发几个空格不算消息；
 * 3. **发送者身份由服务端写**：用户端发出的消息永远是 `user` 角色，发送者是当前登录用户。
 *    请求体里的 `senderRole` / `senderId` 之类根本不会被读取。
 *
 * 失败时抛错，客户端据此保留输入框内容并提示重试（页面不预先清空输入框）。
 */
export async function sendMessageForUser(
  userId: string,
  orderId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ messageId: string; created: boolean }> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const text = normalizeMessageBody(typeof body.body === "string" ? body.body : "");
  if (!text.ok) throw new ApiError("BAD_REQUEST", text.message);

  const order = await getConversationOrderForUser(userId, orderId);
  if (!order) throw new ApiError("NOT_FOUND", "订单不存在");

  // 发送者名称写的是当前用户自己的昵称（与预置数据一致）。
  // 页面上显示成「我」是**展示层**的事（`messageSenderLabel`），不是数据里的事实。
  const user = await getDataSource().findUserById(userId);

  const repository = getMessageRepository();
  await withMockDebug(params, surface, () =>
    repository.ensureConversation(userId, orderId, new Date().toISOString()),
  );

  const now = new Date().toISOString();
  const outcome = await repository.createMessage(
    {
      id: `msg_${crypto.randomUUID()}`,
      orderId: order.id,
      userId: order.userId,
      // 发送者身份全部由服务端写入，客户端无从指定
      senderId: userId,
      senderRole: "user",
      // 名称与头像都是**快照**：写进消息本身，不是渲染时回查账号。
      // 头像取不到时留空串——渲染层要能接受「没有头像」而不是崩掉。
      senderName: user ? user.nickname : "我",
      senderAvatarUrl: user ? user.avatarUrl : "",
      body: text.body,
      createdAt: now,
    },
    idempotencyKey,
  );

  if (!outcome) throw new ApiError("NOT_FOUND", "订单不存在");
  return { messageId: outcome.message.id, created: outcome.created };
}
