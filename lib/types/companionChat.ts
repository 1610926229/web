import type { MessageSenderRole } from "@/lib/types/message";

/**
 * 打手端「订单聊天」的对外类型（P0-14）。
 *
 * ## 为什么单独一个文件，而不是塞进 `lib/types/order.ts` 或 `message.ts`
 *
 * 这三条边界是刻意的：
 *
 * 1. **不是订单域**：聊天不改订单状态、不参与状态机，把它写进 `order.ts`
 *    会让人以为它和 `OrderStatus` 有什么联动；
 * 2. **不是 `message.ts`**：那里是**仓储内部**的形状（`OrderConversationRecord`
 *    带 `assignmentKey` / `companionId` 这些内部键）。对外 DTO 必须是一个
 *    **独立的、只包含可公开字段**的类型，否则「响应里有没有内部键」就只靠
 *    调用方自觉；
 * 3. **浏览器端只能 import `lib/types` 与 `lib/constants`**
 *    （见 `lib/services/companionHttp.ts` 的说明），所以它必须在这里，
 *    不能定义在服务层模块里。
 *
 * ⚠️ 这里**没有** `companionId` / `assignmentKey` / `conversationId`：
 * 打手端只可能看到「当前这一段」，段身份对他没有信息量，
 * 而在响应里带上它等于把内部键交给任何能读接口的人。
 */

/** 打手端聊天列表的一行：**一张正在服务中的订单** + 它与用户这一段的聊天状态。 */
export type CompanionChatListItem = {
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  orderStatus: string;
  orderStatusLabel: string;
  /** 下单用户的昵称——只够在页面上称呼对方 */
  customerNickname: string;
  messageCount: number;
  lastMessageBody: string | null;
  lastMessageAt: string | null;
  /** 最后一条消息的发送者角色，用于在列表上区分「我」与「用户」 */
  lastMessageRole: MessageSenderRole | null;
  /** 用户在**这位打手**上次已读之后发来的条数 */
  unreadCount: number;
  /**
   * 这一单的履约聊天是否**只能看不能发**（产品裁定 `TBD-P0-14-1`）。
   *
   * ⚠️ 由服务端按唯一判据（`isOrderChatClosed`）算好，页面**不要**自己拿
   * `orderStatus === "refunded"` 再判一次：判据一旦要改（比如将来再添一种
   * 「只读」的情形），页面里那份副本不会跟着动，于是列表说能发、聊天页说不能发。
   */
  isReadOnly: boolean;
};

export type CompanionChatListData = {
  items: CompanionChatListItem[];
  /** 全部会话的未读合计，用于入口角标 */
  totalUnread: number;
  /**
   * 展示用说明。当前内容是「只能看到本次护航的沟通记录」——
   * 打手需要知道自己看到的是**范围受限**的一段，而不是与这位用户的全部历史。
   */
  notice: string;
};

/**
 * 聊天页里的一条消息（已按**打手视角**加工过）。
 *
 * ⚠️ 与用户端 DTO 的差别在 `senderLabel`：用户端把 `user` 显示成「我」，
 * 打手端把 `companion` 显示成「我」。同一批数据、两个视角，
 * 因此称呼在**服务端**算好（`isSelf` + `senderLabel`），页面不自己拼——
 * 页面自己判「哪个角色算我」的写法在两种视角并存时必然有一处判反。
 */
export type CompanionChatMessage = {
  id: string;
  body: string;
  createdAt: string;
  senderRole: MessageSenderRole;
  /** 是不是自己发的 */
  isSelf: boolean;
  /** 展示用称呼（自己 = 「我」） */
  senderLabel: string;
  senderAvatarUrl: string;
};

/** 打手端聊天页的完整内容。 */
export type CompanionChatDetail = {
  orderId: string;
  orderNo: string;
  productTitle: string;
  /** 订单当前状态：聊天不会改变它，只是顺带展示 */
  orderStatus: string;
  orderStatusLabel: string;
  customerNickname: string;
  messages: CompanionChatMessage[];
  /** 这位打手在这一段里的已读位置；null = 从未读过 */
  companionLastReadAt: string | null;
  /**
   * 只能看、不能发（产品裁定 `TBD-P0-14-1`）。
   *
   * ⚠️ 与 `notice` **不是二选一**：`notice` 是给人看的一句话，`isReadOnly` 是
   * 驱动输入框的开关。只给文案不给标志位，页面就只能靠比对文案来决定要不要
   * 藏输入框——那是把展示层当判据用。
   */
  isReadOnly: boolean;
  notice: string;
};
