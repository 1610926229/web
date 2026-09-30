import { compareConversationsWithinOrder, serviceConversationId } from "@/lib/constants/conversations";
import { conversationSeed, messageSeed, staffReadSeed } from "@/lib/mocks/fixtures/messageSeed";
import type { OrderConversationRecord, OrderMessage, StaffReadRecord } from "@/lib/types/message";
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
 * ## P0-14：会话以 `conversationId` 为键
 *
 * 主索引从 `orderId → 会话` 改成 `conversationId → 会话`，订单维度的读取走一个
 * **附索引** `conversationIdsByOrder`。这是「一张订单可以有多段会话」的代价：
 * 用订单号当主键时，第二段会话会把第一段**顶掉**，而历史恰好是最不能丢的东西。
 *
 * ⚠️ 附索引与主索引必须在同一段同步代码里一起改：只写主索引会让新会话
 * 「存在但按订单查不到」，表现为「刚建的聊天刷新一下就没了」——比报错更难查。
 * 因此建会话只有一个内部出口 `registerConversation()`，没有第二处写
 * `conversationIdsByOrder` 的地方。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**。
 */

type MockMessageStore = {
  /** conversationId → 会话。**P0-14 起以会话 id 为键**，同一订单可以有多条 */
  conversations: Map<string, OrderConversationRecord>;
  /** orderId → 该订单的会话 id（写入顺序，读取时再按订单内顺序排） */
  conversationIdsByOrder: Map<string, string[]>;
  messages: Map<string, OrderMessage>;
  /** conversationId → 该段会话的消息 id，按写入顺序 */
  messageIdsByConversation: Map<string, string[]>;
  /** `${conversationId}:${senderId}:${idempotencyKey}` → 消息 id */
  messageIdByKey: Map<string, string>;
  /**
   * `${orderId}:${staffId}` → 客服侧的已读位置。
   *
   * 与 `conversations` 里的 `userLastReadAt` / `companionLastReadAt` 是**三份独立的状态**，
   * 刻意不合并：客服读完一个会话不能把用户的未读角标清零，反过来也一样。
   * 键里带 `staffId` 是因为两位客服同时值班时，一位读过的会话不该从另一位的工作台上消失。
   *
   * ⚠️ **按订单一份，不按 assignment 分段**（理由见 `lib/types/message.ts` 的
   * `StaffReadRecord`）：客服读的是「这一单」，不是「这一段」。
   */
  staffReads: Map<string, StaffReadRecord>;
};

function createStore(): MockMessageStore {
  const conversations = new Map(conversationSeed.map((item) => [item.id, item]));
  const messages = new Map(messageSeed.map((message) => [message.id, message]));

  // 订单 → 会话 id 附索引
  const conversationIdsByOrder = new Map<string, string[]>();
  for (const conversation of conversationSeed) {
    const list = conversationIdsByOrder.get(conversation.orderId);
    if (list) list.push(conversation.id);
    else conversationIdsByOrder.set(conversation.orderId, [conversation.id]);
  }

  // 消息按**会话**建索引：分段聊天页只需要某一段的消息。
  // 订单维度的读取由 `readMessagesOfOrder` 跨段合并，不再单独建一份索引
  // —— 同一件事存两份，迟早有一份忘了更新。
  const messageIdsByConversation = new Map<string, string[]>();
  for (const message of messageSeed) {
    const conversation = conversations.get(message.conversationId);
    if (!conversation) {
      throw new Error(`预置消息 ${message.id} 没有对应的会话：${message.conversationId}`);
    }
    if (conversation.orderId !== message.orderId) {
      throw new Error(
        `预置消息 ${message.id} 的订单 ${message.orderId} 与所属会话 ${conversation.id} 的订单不一致`,
      );
    }
    const list = messageIdsByConversation.get(message.conversationId);
    if (list) list.push(message.id);
    else messageIdsByConversation.set(message.conversationId, [message.id]);
  }

  return {
    conversations,
    conversationIdsByOrder,
    messages,
    messageIdsByConversation,
    messageIdByKey: new Map(),
    // 预置的客服已读位置只有一条（见 `staffReadSeed`）：工作台上要能同时看到
    // 「这个会话还有未读」与「这个会话已经处理过」两种样子，而不是清一色未读。
    // 其余会话没有记录 = 从未读过，用户发来的消息全部算未读。
    staffReads: new Map(staffReadSeed.map((item) => [staffReadKey(item.orderId, item.staffId), item])),
  };
}

function store(): MockMessageStore {
  return getMockStore("message", createStore);
}

function messageKey(conversationId: string, senderId: string, idempotencyKey: string): string {
  return `${conversationId}:${senderId}:${idempotencyKey}`;
}

/** 客服已读位置的键。订单号与客服 id 都不会含 `:`，因此不会串键。 */
function staffReadKey(orderId: string, staffId: string): string {
  return `${orderId}:${staffId}`;
}

/**
 * 登记一段新会话：主索引与订单附索引**一起写**。
 *
 * ⚠️ 这是**唯一**允许写 `conversationIdsByOrder` 的地方。绕过它写主索引，
 * 新会话就会「存在但按订单查不到」。
 */
function registerConversation(current: MockMessageStore, conversation: OrderConversationRecord): void {
  current.conversations.set(conversation.id, conversation);
  const list = current.conversationIdsByOrder.get(conversation.orderId);
  if (list) list.push(conversation.id);
  else current.conversationIdsByOrder.set(conversation.orderId, [conversation.id]);
}

/**
 * 某一单的全部会话，按**订单内顺序**（客服会话第一，其后按履约序号升序）。
 *
 * 顺序在这里就定下来，而不是交给每个调用方各自排：分段 UI 的段落顺序是有意义的
 * （它就是履约发生的时间序），让三个调用方各排一次，迟早有一处排成随机的。
 */
function conversationsOfOrder(current: MockMessageStore, orderId: string): OrderConversationRecord[] {
  const ids = current.conversationIdsByOrder.get(orderId) ?? [];
  return ids
    .map((id) => current.conversations.get(id))
    .filter((conversation): conversation is OrderConversationRecord => conversation !== undefined)
    .sort(compareConversationsWithinOrder);
}

/** 某一段会话的消息，按时间升序。时间相同时用 id 兜底，保证顺序稳定。 */
function readMessagesOfConversation(
  current: MockMessageStore,
  conversationId: string,
): OrderMessage[] {
  const ids = current.messageIdsByConversation.get(conversationId) ?? [];
  return ids
    .map((id) => current.messages.get(id))
    .filter((message): message is OrderMessage => message !== undefined)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

/** 某一单**全部段落**的消息，按时间升序（跨段合并，用于「完整历史」）。 */
function readMessagesOfOrder(current: MockMessageStore, orderId: string): OrderMessage[] {
  return conversationsOfOrder(current, orderId)
    .flatMap((conversation) => readMessagesOfConversation(current, conversation.id))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

/** 只前进不后退的游标更新：后到的旧请求不会把已读位置推回去。 */
function forwardOnly(current: string | null, next: string): string {
  return current && current > next ? current : next;
}

export const mockMessageRepository: MessageRepository = {
  // ————————————————————— 用户侧 —————————————————————

  async listConversations(userId) {
    return [...store().conversations.values()].filter((item) => item.userId === userId);
  },

  async listConversationsByOrder(userId, orderId) {
    // 别人的订单一律当作不存在：调用方拿不到「这不是你的」这种可区分信息
    return conversationsOfOrder(store(), orderId).filter((item) => item.userId === userId);
  },

  async ensureConversation(userId, orderId, createdAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const id = serviceConversationId(orderId);
    const existing = current.conversations.get(id);
    if (existing) {
      // 已存在就原样返回：不改创建时间，也不把已读位置抹掉
      return existing;
    }
    const created: OrderConversationRecord = {
      id,
      orderId,
      userId,
      kind: "service",
      // 客服会话不属于任何一段履约：这三个字段是履约会话专有的，恒为 null
      assignmentKey: null,
      assignmentSeq: null,
      companionId: null,
      createdAt,
      // 新会话从未读过：对方之后发的消息都会计入未读
      userLastReadAt: null,
      companionLastReadAt: null,
    };
    registerConversation(current, created);
    // —— 原子区段结束 ——

    return created;
  },

  async listMessages(userId, orderId) {
    const owned = conversationsOfOrder(store(), orderId).some((item) => item.userId === userId);
    if (!owned) return [];
    return readMessagesOfOrder(store(), orderId);
  },

  async listMessagesGrouped(userId) {
    const current = store();
    const grouped = new Map<string, OrderMessage[]>();
    for (const conversation of current.conversations.values()) {
      if (conversation.userId !== userId) continue;
      grouped.set(conversation.orderId, readMessagesOfOrder(current, conversation.orderId));
    }
    return grouped;
  },

  async createMessage(message, idempotencyKey) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const conversation = current.conversations.get(message.conversationId);
    if (!conversation) return null;
    // 消息的归属必须与所属会话**逐项**对得上：只查会话存在，
    // 就会让「会话是 A 单的、消息却宣称属于 B 单」这种记录被写进去，
    // 而按订单取数时它会出现在 B 单里、按段落取数时出现在 A 段里——两处说法不一致
    if (conversation.userId !== message.userId) return null;
    if (conversation.orderId !== message.orderId) return null;

    const key = messageKey(message.conversationId, message.senderId, idempotencyKey);
    const existingId = current.messageIdByKey.get(key);
    if (existingId) {
      const existing = current.messages.get(existingId);
      if (existing) return { message: existing, created: false };
    }

    current.messages.set(message.id, message);
    const ids = current.messageIdsByConversation.get(message.conversationId);
    if (ids) ids.push(message.id);
    else current.messageIdsByConversation.set(message.conversationId, [message.id]);
    current.messageIdByKey.set(key, message.id);
    // —— 原子区段结束 ——

    return { message, created: true };
  },

  async markConversationRead(userId, orderId, readAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const mine = conversationsOfOrder(current, orderId).filter((item) => item.userId === userId);
    if (mine.length === 0) return false;

    // 这一单的**每一段**都标记：用户打开聊天页看到的是整条时间线，
    // 只清最后一段会让上一段的角标永远挂着
    for (const conversation of mine) {
      current.conversations.set(conversation.id, {
        ...conversation,
        userLastReadAt: forwardOnly(conversation.userLastReadAt, readAt),
      });
    }
    // —— 原子区段结束 ——

    return true;
  },

  // ————————————————————— 打手侧（P0-14）—————————————————————

  async listAssignmentConversationsForCompanion(companionId) {
    return [...store().conversations.values()].filter(
      (item) => item.kind === "assignment" && item.companionId === companionId,
    );
  },

  async findAssignmentConversationByKey(orderId, assignmentKey) {
    return (
      conversationsOfOrder(store(), orderId).find(
        (item) => item.kind === "assignment" && item.assignmentKey === assignmentKey,
      ) ?? null
    );
  },

  async ensureAssignmentConversation(input) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const existing = conversationsOfOrder(current, input.orderId).find(
      (item) => item.kind === "assignment" && item.assignmentKey === input.assignmentKey,
    );
    // 已经存在的段原样返回：assignmentKey 与 companionId 一旦写下就是历史事实
    if (existing) return existing;

    // id 规则与 assignmentKey 同源（见 `lib/constants/conversations.ts`）：
    // 两处各拼一次，迟早会有一处拼成 `#s1` 而另一处拼成 `:1`
    const created: OrderConversationRecord = {
      id: `${input.assignmentKey}`,
      orderId: input.orderId,
      userId: input.userId,
      kind: "assignment",
      assignmentKey: input.assignmentKey,
      assignmentSeq: input.assignmentSeq,
      companionId: input.companionId,
      createdAt: input.createdAt,
      userLastReadAt: null,
      // 新一段履约的打手从未读过：他不继承上一段打手的任何进度
      companionLastReadAt: null,
    };
    registerConversation(current, created);
    // —— 原子区段结束 ——

    return created;
  },

  async listMessagesInConversation(conversationId) {
    // 不过滤所有者：conversationId 是内部键，调用方必须已经从带所有者过滤的
    // 入口拿到它（见 `lib/data/messageRepository.ts` 的说明）
    if (!store().conversations.has(conversationId)) return [];
    return readMessagesOfConversation(store(), conversationId);
  },

  async markAssignmentConversationRead(conversationId, companionId, readAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const conversation = current.conversations.get(conversationId);
    // 不是履约会话、或不是这位打手的那一段 → 当作不存在，不写任何东西
    if (!conversation || conversation.kind !== "assignment") return null;
    if (conversation.companionId !== companionId) return null;

    const updated: OrderConversationRecord = {
      ...conversation,
      companionLastReadAt: forwardOnly(conversation.companionLastReadAt, readAt),
    };
    current.conversations.set(conversation.id, updated);
    // —— 原子区段结束 ——

    return updated;
  },

  // ————————————————————— 客服侧（P8D-1）—————————————————————

  async listConversationsForStaff() {
    // 不过滤用户：工作台本来就要跨用户看。返回包含 userId 的内部记录，
    // 「客服只能看到有会话的订单」这件事由 `findConversationForStaff` 与
    // 服务层的订单关联保证，仓储这一层只回答「有哪些会话」。
    return [...store().conversations.values()];
  },

  async findConversationForStaff(orderId) {
    // 代表会话：客服会话（如果这一单有的话）排在最前，否则订单内第一段。
    // 用途是「这一单有没有会话」的存在性判定，不是「看哪一段」
    return conversationsOfOrder(store(), orderId)[0] ?? null;
  },

  async listConversationsByOrderForStaff(orderId) {
    return conversationsOfOrder(store(), orderId);
  },

  async listMessagesForStaff(orderId) {
    const current = store();
    if (conversationsOfOrder(current, orderId).length === 0) return [];
    return readMessagesOfOrder(current, orderId);
  },

  async listMessagesGroupedForStaff() {
    const current = store();
    const grouped = new Map<string, OrderMessage[]>();
    for (const conversation of current.conversations.values()) {
      grouped.set(conversation.orderId, readMessagesOfOrder(current, conversation.orderId));
    }
    return grouped;
  },

  async findStaffLastReadAt(orderId, staffId) {
    return store().staffReads.get(staffReadKey(orderId, staffId))?.lastReadAt ?? null;
  },

  async listStaffReads(staffId) {
    const result = new Map<string, string>();
    for (const record of store().staffReads.values()) {
      if (record.staffId === staffId) result.set(record.orderId, record.lastReadAt);
    }
    return result;
  },

  async markConversationReadForStaff(orderId, staffId, readAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    // 会话不存在就没有可标记的对象。**不去建会话**：客服不能凭空给一笔订单
    // 造出一个会话，那是用户发起沟通时才会发生的事。
    if (conversationsOfOrder(current, orderId).length === 0) return null;

    const key = staffReadKey(orderId, staffId);
    const existing = current.staffReads.get(key);
    // 只前进不后退：后到的旧请求不会把已读位置推回去（与用户侧同一条规则）
    const nextReadAt = existing && existing.lastReadAt > readAt ? existing.lastReadAt : readAt;

    const updated: StaffReadRecord = { orderId, staffId, lastReadAt: nextReadAt };
    current.staffReads.set(key, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
