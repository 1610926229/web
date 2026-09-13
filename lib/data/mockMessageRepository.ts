import { conversationSeed, messageSeed } from "@/lib/mocks/fixtures/messageSeed";
import type { OrderConversationRecord, OrderMessage } from "@/lib/types/message";
import type { MessageRepository } from "./messageRepository";
import { getMockStore } from "./mockStore";

/**
 * 订单沟通的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换，本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置聊天记录与用户新发的消息因此进的是**同一个 Map、同一套查询方法**，
 * 不会出现「刚发的消息刷新一下就不见了」。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**。
 */

type MockMessageStore = {
  /** orderId → 会话。同一订单只有一个会话 */
  conversations: Map<string, OrderConversationRecord>;
  messages: Map<string, OrderMessage>;
  /** orderId → 该会话的消息 id，按写入顺序 */
  messageIdsByOrder: Map<string, string[]>;
  /** `${orderId}:${senderId}:${idempotencyKey}` → 消息 id */
  messageIdByKey: Map<string, string>;
};

function createStore(): MockMessageStore {
  const conversations = new Map(conversationSeed.map((item) => [item.orderId, item]));
  const messages = new Map(messageSeed.map((message) => [message.id, message]));

  // 消息按订单建索引：会话列表与聊天页都只需要某一单的消息
  const messageIdsByOrder = new Map<string, string[]>();
  for (const message of messageSeed) {
    if (!conversations.has(message.orderId)) {
      throw new Error(`预置消息 ${message.id} 没有对应的会话：${message.orderId}`);
    }
    const list = messageIdsByOrder.get(message.orderId);
    if (list) list.push(message.id);
    else messageIdsByOrder.set(message.orderId, [message.id]);
  }

  return { conversations, messages, messageIdsByOrder, messageIdByKey: new Map() };
}

function store(): MockMessageStore {
  return getMockStore("message", createStore);
}

function messageKey(orderId: string, senderId: string, idempotencyKey: string): string {
  return `${orderId}:${senderId}:${idempotencyKey}`;
}

/** 某条会话的消息，按时间升序。时间相同时用 id 兜底，保证顺序稳定。 */
function readMessages(current: MockMessageStore, orderId: string): OrderMessage[] {
  const ids = current.messageIdsByOrder.get(orderId) ?? [];
  return ids
    .map((id) => current.messages.get(id))
    .filter((message): message is OrderMessage => message !== undefined)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

export const mockMessageRepository: MessageRepository = {
  async listConversations(userId) {
    return [...store().conversations.values()].filter((item) => item.userId === userId);
  },

  async findConversation(userId, orderId) {
    const conversation = store().conversations.get(orderId) ?? null;
    // 别人的会话一律当作不存在：调用方拿不到「这不是你的」这种可区分信息
    if (!conversation || conversation.userId !== userId) return null;
    return conversation;
  },

  async ensureConversation(userId, orderId, createdAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const existing = current.conversations.get(orderId);
    if (existing) {
      // 已存在就原样返回：不改创建时间，也不把已读位置抹掉
      return existing;
    }
    const created: OrderConversationRecord = {
      orderId,
      userId,
      createdAt,
      // 新会话从未读过：对方之后发的消息都会计入未读
      userLastReadAt: null,
    };
    current.conversations.set(orderId, created);
    // —— 原子区段结束 ——

    return created;
  },

  async listMessages(userId, orderId) {
    const conversation = store().conversations.get(orderId) ?? null;
    if (!conversation || conversation.userId !== userId) return [];
    return readMessages(store(), orderId);
  },

  async listMessagesGrouped(userId) {
    const current = store();
    const grouped = new Map<string, OrderMessage[]>();
    for (const conversation of current.conversations.values()) {
      if (conversation.userId !== userId) continue;
      grouped.set(conversation.orderId, readMessages(current, conversation.orderId));
    }
    return grouped;
  },

  async createMessage(message, idempotencyKey) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const conversation = current.conversations.get(message.orderId);
    if (!conversation || conversation.userId !== message.userId) return null;

    const key = messageKey(message.orderId, message.senderId, idempotencyKey);
    const existingId = current.messageIdByKey.get(key);
    if (existingId) {
      const existing = current.messages.get(existingId);
      if (existing) return { message: existing, created: false };
    }

    current.messages.set(message.id, message);
    const ids = current.messageIdsByOrder.get(message.orderId);
    if (ids) ids.push(message.id);
    else current.messageIdsByOrder.set(message.orderId, [message.id]);
    current.messageIdByKey.set(key, message.id);
    // —— 原子区段结束 ——

    return { message, created: true };
  },

  async markConversationRead(userId, orderId, readAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const conversation = current.conversations.get(orderId);
    if (!conversation || conversation.userId !== userId) return null;

    // 已读时间是「读到哪里」，只前进不后退：后到的旧请求不会把已读位置推回去
    const nextReadAt =
      conversation.userLastReadAt && conversation.userLastReadAt > readAt
        ? conversation.userLastReadAt
        : readAt;

    const updated: OrderConversationRecord = { ...conversation, userLastReadAt: nextReadAt };
    current.conversations.set(orderId, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
