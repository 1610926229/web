import type { OrderConversationRecord, OrderMessage, StaffReadRecord } from "@/lib/types/message";
import { mockMessageRepository } from "./mockMessageRepository";

/**
 * 订单沟通（会话 + 消息）的可替换仓储。
 *
 * 三条约束由本层负责：
 *
 * 1. **同一「订单 + 会话种类 + 履约段」只有一个会话**。`ensureConversation` 与
 *    `ensureAssignmentConversation` 都是幂等的，重复调用只会得到同一个会话。
 * 2. **同一「会话 + 发送者 + 幂等键」只产生一条消息**。快速连点发送不会刷出重复消息。
 * 3. **P0-14 起会话以 `id` 为键，不以 `orderId` 为键**。同一张订单可以有多段会话，
 *    用订单号做键会让新一段顶掉旧一段。
 *
 * ⚠️ 所有**用户侧**读取方法都按 `userId` 过滤：消息与会话都带着订单所属用户，
 * 因此「只能看自己的会话」在仓储这一层就已经成立，而不是指望调用方记得过滤。
 *
 * ⚠️ 本层**不判断**「这笔订单是不是你的」「内容是否为空」「这位打手还有没有权限」：
 * 那些在 `lib/services/conversations.ts` 与 `lib/services/companionConversations.ts`
 * 里做。仓储只保证自己这份数据的一致性。
 *
 * ## 三种「按订单」的读取，用途不同，不要互换
 *
 * | 方法 | 回答的问题 | 谁在用 |
 * |---|---|---|
 * | `listConversationsByOrder` | 这一单**有几段**会话，分别是哪几段 | 用户端分段 UI、订单详情摘要 |
 * | `findConversationForStaff` | 这一单**有没有**会话（只要一段就够） | 客服侧的 404 判定（投诉 / 退款 / 会话） |
 * | `listMessages(orderId)` | 这一单**全部段落**的消息，按时间升序 | 用户端「完整历史」、客服工作台 |
 *
 * `listMessages` 刻意**不按段拆分**：用户与客服要的都是「这一单发生过什么」，
 * 分段是聊天页内部的组织方式（`OrderConversationSegment`），不是取数口径。
 * 分段的取数入口是 `listMessagesInConversation`。
 */

export type MessageRepository = {
  // ————————————————————— 用户侧 —————————————————————

  /** 某个用户的全部会话，**两种 kind 都有**（会话列表用）。排序交给服务层。 */
  listConversations(userId: string): Promise<OrderConversationRecord[]>;

  /**
   * 某个用户某一笔订单的**全部会话**（客服会话 + 各段履约会话）。
   *
   * 订单不属于该用户时返回**空数组**（不是「别人的会话」，而是「看不到」）。
   * 顺序不保证，服务层用 `compareConversationsWithinOrder` 排。
   */
  listConversationsByOrder(userId: string, orderId: string): Promise<OrderConversationRecord[]>;

  /** 幂等建立**客服会话**：已存在时原样返回既有会话，不改动它的创建时间与已读位置。 */
  ensureConversation(
    userId: string,
    orderId: string,
    createdAt: string,
  ): Promise<OrderConversationRecord>;

  /**
   * 某个用户某一笔订单**全部段落**的消息，**按时间升序**。
   *
   * ⚠️ 这是「这一单的完整历史」，会跨越多个 assignment。需要单段消息时用
   * `listMessagesInConversation`。
   */
  listMessages(userId: string, orderId: string): Promise<OrderMessage[]>;

  /** 某个用户全部会话的消息，按订单分组（会话列表一次取完，避免逐个会话查）。 */
  listMessagesGrouped(userId: string): Promise<Map<string, OrderMessage[]>>;

  /**
   * 发送消息。幂等键作用域是「**会话** + 发送者」：同一个人对同一段会话重复提交同一个键，
   * 只会得到同一条消息（`created` 为 false）。
   *
   * ⚠️ 作用域从「订单」收窄到「会话」是 P0-14 的有意改动：用户给客服与给打手
   * 是两个不同的意图，共用一个键空间会让后一个意图被前一个**吞掉**而错误地返回成功。
   *
   * 消息必须先有会话：`message.conversationId` 指向的会话不存在、或不属于
   * `message.userId` 时返回 null，由服务层转成 404。
   */
  createMessage(
    message: OrderMessage,
    idempotencyKey: string,
  ): Promise<{ message: OrderMessage; created: boolean } | null>;

  /**
   * 把这一单**属于该用户的全部会话**标记为已读（只前进不后退）。
   *
   * ⚠️ 是「全部段落」而不是「当前那一段」：用户打开聊天页时看到的是整条时间线，
   * 只清最后一段会让上一段的角标永远挂着。返回 false = 这一单没有任何属于他的会话。
   */
  markConversationRead(userId: string, orderId: string, readAt: string): Promise<boolean>;

  // ————————————————————— 打手侧（P0-14）—————————————————————
  //
  // ⚠️ 这一节的读取**按 `companionId` 过滤**，与用户侧同一套路：会话记录上带着
  // 这一段履约的打手，因此「只看得到自己的段」在仓储层就成立。
  //
  // ⚠️ 但**仓储不判断这一段是否仍然有效**：那需要订单当前的 `actualCompanionId` 与
  // 现算的 `assignmentKey`，属于业务判据，唯一落点是
  // `lib/constants/conversations.ts` 的 `canCompanionAccessConversation`。
  // 仓储只回答「哪些段记在这位打手名下」——被换掉的打手在仓储层**仍然查得到**
  // 自己的旧段，是服务层的判据把他挡在外面。这不矛盾：数据还在，权限没了。

  /** 记在这位打手名下的全部履约会话（含已经失效的段）。服务层负责筛掉失效的。 */
  listAssignmentConversationsForCompanion(companionId: string): Promise<OrderConversationRecord[]>;

  /** 按「订单 + 履约身份键」找那一段会话；没有则 null。 */
  findAssignmentConversationByKey(
    orderId: string,
    assignmentKey: string,
  ): Promise<OrderConversationRecord | null>;

  /**
   * 幂等建立一段履约会话。
   *
   * ⚠️ **已存在的段原样返回**，不覆盖、不改创建时间：一段会话的 `assignmentKey`
   * 与 `companionId` 一旦写下就是历史事实。
   */
  ensureAssignmentConversation(input: {
    orderId: string;
    userId: string;
    assignmentKey: string;
    assignmentSeq: number;
    companionId: string;
    createdAt: string;
  }): Promise<OrderConversationRecord>;

  /**
   * 某一段会话的全部消息，按时间升序。
   *
   * ⚠️ **不按所有者过滤**：`conversationId` 是内部键，调用方必须先通过
   * 某个带所有者过滤的入口拿到它（用户端的 `listConversationsByOrder`、
   * 打手端的 `findAssignmentConversationByKey`、客服端的 `listConversationsByOrderForStaff`）。
   * 直接把请求里的参数当 `conversationId` 传进来就是一条越权通道。
   */
  listMessagesInConversation(conversationId: string): Promise<OrderMessage[]>;

  /**
   * 记录这位打手在这一段会话里的已读位置（只前进不后退）。
   *
   * 会话不存在、不是履约会话、或不属于这位打手时返回 null。
   * ⚠️ **不碰 `userLastReadAt`**：打手读完不清用户的未读，反过来也一样。
   */
  markAssignmentConversationRead(
    conversationId: string,
    companionId: string,
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
   * 某一笔订单的**代表会话**（有客服会话就是它，否则订单内第一段）。
   *
   * ⚠️ **没有会话就返回 null**，与订单不存在返回 null 是同一个结果：
   * 客服只能访问存在会话的订单，随意猜测订单 ID 应当拿到与不存在完全一样的 404。
   * 用途是**存在性判定**；要看全部段落用 `listConversationsByOrderForStaff`。
   */
  findConversationForStaff(orderId: string): Promise<OrderConversationRecord | null>;

  /** 某一笔订单的全部会话（客服调查视角：要看到每一段履约）。 */
  listConversationsByOrderForStaff(orderId: string): Promise<OrderConversationRecord[]>;

  /** 某一笔订单**全部段落**的消息，**按时间升序**。会话不存在时返回空数组。 */
  listMessagesForStaff(orderId: string): Promise<OrderMessage[]>;

  /** 全部会话的消息，按订单分组（工作台列表一次取完，避免逐个会话查）。 */
  listMessagesGroupedForStaff(): Promise<Map<string, OrderMessage[]>>;

  /** 这位客服在这个订单里读到哪里；没读过或这一单没有会话时返回 null。 */
  findStaffLastReadAt(orderId: string, staffId: string): Promise<string | null>;

  /** 这位客服在**全部订单**里的已读位置（工作台列表算未读数用）。 */
  listStaffReads(staffId: string): Promise<Map<string, string>>;

  /**
   * 记录客服的已读位置（只前进不后退）。这一单没有会话时返回 null。
   *
   * ⚠️ **不碰 `userLastReadAt`，也不碰 `companionLastReadAt`**：
   * 客服读用户的消息与用户读客服的消息是两个方向，客服读完一个会话不该把
   * 用户那边的未读角标清零，更不该影响打手侧的游标（`cmd_p0-14.md` §九）。
   *
   * ⚠️ **按订单一份游标，不按 assignment 分段**：理由见
   * `lib/types/message.ts` 的 `StaffReadRecord`。
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
