import type { OrderConversationRecord, OrderMessage } from "@/lib/types/message";
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
};

export function getMessageRepository(): MessageRepository {
  return mockMessageRepository;
}
