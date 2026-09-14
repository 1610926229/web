/**
 * 订单沟通（用户侧消息）类型。
 *
 * 本阶段是**简化消息**，不是实时聊天：没有 WebSocket，也没有第三方客服系统。
 * 消息由用户主动发送、由页面主动刷新获取。
 *
 * 发送者身份**只能由服务端写入**：请求体里即便带了 `senderRole` / `senderId` 也会被忽略，
 * 因此客户端无法伪造「客服」或「打手」发消息。
 */

/**
 * 消息发送者角色。
 *
 * 用户端只能发 `user`（客服端只能发 `customer_service`），另外两种只出现在预置数据里。
 *
 * ⚠️ 客服角色的取值是 `customer_service`，与**客服账号的角色**（`StaffRole`）
 * 是同一个词：全站只有「客服」这一个概念，消息里叫 `support`、账号里叫
 * `customer_service` 会让人以为这是两回事。
 */
export type MessageSenderRole = "user" | "companion" | "customer_service";

export type OrderMessage = {
  id: string;
  orderId: string;
  /** 订单所属用户。消息按它归属，查询时不依赖调用方传入的用户 */
  userId: string;
  senderId: string;
  senderRole: MessageSenderRole;
  /** 发送者名称快照：用户昵称 / 打手名 / 客服名 */
  senderName: string;
  /**
   * 发送者头像快照。
   *
   * ⚠️ 与 `senderName` 一样是**写入那一刻的快照**，不是渲染时去查账号得到的：
   * 客服账号被停用或软删除之后，历史消息仍然显示得出当时的头像，不会变成空白。
   * 把头像存进消息是这条保证的前提——靠 `senderId` 反查账号的方案，
   * 恰恰在账号被移除时失效，而那时最需要历史记录还看得见。
   */
  senderAvatarUrl: string;
  body: string;
  createdAt: string;
};

/**
 * 会话（仓储内部类型）。
 *
 * 会话与消息**分开存**：会话可以先于第一条消息存在——用户在「联系客服」里选一笔订单
 * 发起沟通时，会话立刻就建立了，此时历史消息还是空的。若把「有消息」当作会话存在的条件，
 * 刚发起的沟通在列表里根本不会出现。
 */
export type OrderConversationRecord = {
  orderId: string;
  userId: string;
  createdAt: string;
  /**
   * 用户上次已读时间；null 表示从未读过（对方的消息全部算未读）。
   * 已读标记按「用户 + 会话」存，是用户自己的状态，不影响消息本身。
   */
  userLastReadAt: string | null;
};

/**
 * 客服侧的已读位置。
 *
 * ⚠️ **与用户侧是两个方向、两份状态**，因此不放在 `OrderConversationRecord` 上
 * 共用一个字段：客服点进会话读完了，不能顺手把用户那边的未读清零；
 * 用户读了客服的消息，也不该把客服的待办清空。
 *
 * 按「会话 + 客服」记录而不是按会话记录：两位客服同时值班时，
 * 一位读过的会话不该从另一位的工作台上消失。
 */
export type StaffReadRecord = {
  orderId: string;
  staffId: string;
  /** 这位客服读到这里；只前进不后退 */
  lastReadAt: string;
};

/** 一个订单会话的统计信息（由消息仓储算出，不含订单本身的字段）。 */
export type ConversationStats = {
  orderId: string;
  messageCount: number;
  lastMessageBody: string | null;
  lastMessageAt: string | null;
  /** 对方（客服 / 打手）在用户上次已读之后发来的条数 */
  unreadCount: number;
};

/**
 * 会话列表项 DTO：订单信息 + 最后一条消息 + 未读状态。
 *
 * 不含游戏 ID 与备注——会话列表不需要这些，将来也不需要。
 */
export type OrderConversation = ConversationStats & {
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  orderStatus: string;
  orderStatusLabel: string;
  /** 最后一条消息的发送者角色，用于在列表上区分「我」与「对方」 */
  lastMessageRole: MessageSenderRole | null;
};
