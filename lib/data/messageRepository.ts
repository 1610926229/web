import type { OrderConversationRecord, OrderMessage, StaffReadRecord } from "@/lib/types/message";
import { mockMessageRepository } from "./mockMessageRepository";

/**
 * 订单沟通（会话 + 消息）的可替换仓储。
 *
 * 两条约束由本层负责：
 *
 * 1. **同一订单只有一个会话**。`ensureConversation` 幂等，重复调用（例如用户连点
 *    「发起沟通」）只会得到同一个会话，聊天记录不会被拆成两份。
 * 2. **同一「订单 + 发送者 + 幂等键」只产生一条消息**。快速连点发送不会刷出多条重复消息。
 *
 * ⚠️ 所有读取方法都**同时按 `userId` 过滤**：消息与会话都带着订单所属用户，
 * 因此「只能看自己的会话」在仓储这一层就已经成立，而不是指望调用方记得过滤。
 *
 * ⚠️ 本层**不判断**「这笔订单是不是你的」「内容是否为空」：那在
 * `lib/services/conversations.ts` 里做。仓储只保证自己这份数据的一致性。
 */

export type MessageRepository = {
  /** 某个用户的全部会话（会话列表用）。排序交给服务层，仓储只负责取全量。 */
  listConversations(userId: string): Promise<OrderConversationRecord[]>;

  /** 某个用户某一笔订单的会话；没有会话返回 null（**属于别人的订单同样是 null**）。 */
  findConversation(userId: string, orderId: string): Promise<OrderConversationRecord | null>;

  /** 幂等建立会话：已存在时原样返回既有会话，不改动它的创建时间与已读位置。 */
  ensureConversation(
    userId: string,
    orderId: string,
    createdAt: string,
  ): Promise<OrderConversationRecord>;

  /** 某个用户某一笔订单的全部消息，**按时间升序**。 */
  listMessages(userId: string, orderId: string): Promise<OrderMessage[]>;

  /** 某个用户全部会话的消息，按订单分组（会话列表一次取完，避免逐个会话查）。 */
  listMessagesGrouped(userId: string): Promise<Map<string, OrderMessage[]>>;

  /**
   * 发送消息。幂等键作用域是「订单 + 发送者」：同一个人对同一笔订单重复提交同一个键，
   * 只会得到同一条消息（`created` 为 false）。
   *
   * 消息必须先有会话：订单不存在或不属于该用户时返回 null，由服务层转成 404。
   */
  createMessage(
    message: OrderMessage,
    idempotencyKey: string,
  ): Promise<{ message: OrderMessage; created: boolean } | null>;

  /** 把会话标记为已读（记录用户读到的时间）。会话不属于该用户时返回 null。 */
  markConversationRead(
    userId: string,
    orderId: string,
    readAt: string,
  ): Promise<OrderConversationRecord | null>;

  // ————————————————————— 客服侧（P8D-1）—————————————————————
  //
  // ⚠️ **不是另建一份消息**：下面这些方法读的、写的是**同一个 store 里的同一批
  // 会话与消息**（`createMessage` 也是同一个），客服发出去的消息与用户看到的是
  // 同一条记录。用户端与客服端看到的差异来自「谁在读」，不是「读的是哪一份数据」。
  //
  // ⚠️ 客服侧的读取**不按 `userId` 过滤**，因此每个调用它的接口都必须先过
  // `requireStaff()`。这不是「忘了过滤」，而是工作台的职责就是跨用户查看
  // **有会话的**订单；把过滤放在仓储里会让「客服能看什么」变成一个说不清的问题。

  /** 全部会话（工作台列表用）。排序交给服务层，仓储只负责取全量。 */
  listConversationsForStaff(): Promise<OrderConversationRecord[]>;

  /**
   * 某一笔订单的会话。
   *
   * ⚠️ **没有会话就返回 null**，与订单不存在返回 null 是同一个结果：
   * 客服只能访问存在会话的订单，随意猜测订单 ID 应当拿到与不存在完全一样的 404。
   */
  findConversationForStaff(orderId: string): Promise<OrderConversationRecord | null>;

  /** 某一笔订单的全部消息，**按时间升序**。会话不存在时返回空数组。 */
  listMessagesForStaff(orderId: string): Promise<OrderMessage[]>;

  /** 全部会话的消息，按订单分组（工作台列表一次取完，避免逐个会话查）。 */
  listMessagesGroupedForStaff(): Promise<Map<string, OrderMessage[]>>;

  /** 这位客服在这个会话里读到哪里；没读过或没有这个会话时返回 null。 */
  findStaffLastReadAt(orderId: string, staffId: string): Promise<string | null>;

  /** 这位客服在**全部会话**里的已读位置（工作台列表算未读数用）。 */
  listStaffReads(staffId: string): Promise<Map<string, string>>;

  /**
   * 记录客服的已读位置（只前进不后退）。会话不存在时返回 null。
   *
   * ⚠️ **不碰 `userLastReadAt`**：用户读客服的消息与客服读用户的消息是两个方向，
   * 客服读完一个会话不该把用户那边的未读角标清零。
   */
  markConversationReadForStaff(
    orderId: string,
    staffId: string,
    readAt: string,
  ): Promise<StaffReadRecord | null>;
};

export function getMessageRepository(): MessageRepository {
  return mockMessageRepository;
}
