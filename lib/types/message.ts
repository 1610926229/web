/**
 * 订单沟通（用户侧消息）类型。
 *
 * 本阶段是**简化消息**，不是实时聊天：没有 WebSocket，也没有第三方客服系统。
 * 消息由用户主动发送、由页面主动刷新获取。
 *
 * 发送者身份**只能由服务端写入**：请求体里即便带了 `senderRole` / `senderId` 也会被忽略，
 * 因此客户端无法伪造「客服」或「打手」发消息。
 *
 * ## P0-14：会话从「一单一会话」升级为「一单多段」
 *
 * 一张订单上现在可以有**多段会话**，这是「换人之后新打手看不到旧聊天」这条需求的
 * 唯一落点。职责划分是：
 *
 * - `OrderConversationRecord` 回答「**这一段**是谁的、还算不算当前那一段」；
 * - `lib/constants/conversations.ts` 回答「**谁**能碰这一段」（唯一判据）；
 * - 本文件只描述形状，不含任何判定逻辑。
 *
 * ⚠️ **会话 id 与订单 id 不是一回事**（虽然客服会话的 id 恰好等于订单号）：
 * 一切按会话取数的读取都应当用 `conversation.id`，用 `orderId` 会一次拿到整单的消息。
 * 两者的构造规则见 `lib/constants/conversations.ts`。
 */

/**
 * 消息发送者角色。
 *
 * 用户端只能发 `user`（客服端只能发 `customer_service`，打手端只能发 `companion`），
 * 另外两种只出现在预置数据与对端视角里。
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
  /**
   * 这条消息属于哪一段会话（P0-14 新增）。
   *
   * ⚠️ **它只存在于内部记录里，绝不进入用户端与打手端的响应体**：
   * 履约会话的 id 与 `assignmentKey` 是同一个串（`${orderId}#s${seq}`），
   * 把它交出去就等于泄露「这是第几段履约」这个内部事实（`cmd_p0-14.md` §七、
   * §十四.31）。用户端对外用 `OrderMessageView`，由 `toMessageView()` **显式挑字段**生成；
   * 打手端与客服端各有自己的 DTO（`CompanionChatMessage` / 客服分段消息），
   * 形状不同、同样都**不含**这个字段（见 `lib/services/companionConversations.ts`、
   * `lib/constants/staff.ts`）。
   */
  conversationId: string;
};

/**
 * 对外可见的消息（用户端 / 打手端 DTO）：内部记录**去掉 `conversationId`**。
 *
 * ⚠️ 这是**类型层面的保证**，运行时的保证在 `toMessageView()`——它一个一个字段地挑，
 * 而不是 `{ ...message }` 再删一个键。展开再删的写法在有人往内部记录上加字段时
 * 会**静默泄露**新字段，而显式挑选不会。
 */
export type OrderMessageView = Omit<OrderMessage, "conversationId">;

/**
 * 会话种类（P0-14）。
 *
 * - `service`    —— 用户 ↔ 客服。P0-14 之前就存在的那一种，本轮原样保留。
 * - `assignment` —— 某一次履约：订单用户 ↔ **当前实际打手**。
 *
 * ⚠️ 一张订单可以只有 `service`（还在等人接单，用户照样要能问客服），
 * 也可以两者都有。**P0-14 之前的所有数据都是 `service`**。
 */
export type ConversationKind = "service" | "assignment";

/**
 * 会话（仓储内部类型）。
 *
 * 会话与消息**分开存**：会话可以先于第一条消息存在——用户在「联系客服」里选一笔订单
 * 发起沟通时，会话立刻就建立了，此时历史消息还是空的。若把「有消息」当作会话存在的条件，
 * 刚发起的沟通在列表里根本不会出现。
 *
 * ⚠️ **P0-14 起以 `id` 为键**，不再以 `orderId` 为键：一张订单可以有多段会话，
 * 用订单号做 Map 键会让新一段会话**顶掉**旧一段，历史当场消失。
 */
export type OrderConversationRecord = {
  /** 会话 id。客服会话 = 订单号；履约会话 = `${orderId}#s${履约序号}` */
  id: string;
  orderId: string;
  userId: string;
  kind: ConversationKind;
  /**
   * 这一段履约的身份键；`kind === "service"` 时为 `null`。
   *
   * ⚠️ 它在**创建那一刻冻结**，之后永不重算。判定「这一段还是当前那一段吗」用的是
   * **现算**出来的键，两者相等才算数——这正是「换人后旧会话立即失效」的实现方式，
   * 也是 `A → B → A` 两次履约不会被混为一段的原因。详见
   * `lib/constants/conversations.ts` 的 `resolveAssignmentSeq`。
   */
  assignmentKey: string | null;
  /** 履约序号（0 起）；`kind === "service"` 时为 `null`。创建时冻结，用于稳定排序与展示 */
  assignmentSeq: number | null;
  /**
   * 这一段履约的打手；`kind === "service"` 时为 `null`。
   *
   * ⚠️ 与订单上的 `actualCompanionId` **不是同一个问题**：订单回答「现在谁在履约」，
   * 这里回答「这一段历史是谁的」。换人之后前者会变、后者不变，
   * 而「旧打手还能不能看」恰恰取决于这两个答案**是否一致**。
   */
  companionId: string | null;
  createdAt: string;
  /**
   * 用户上次已读时间；null 表示从未读过（对方的消息全部算未读）。
   * 已读标记按「用户 + 会话」存，是用户自己的状态，不影响消息本身。
   *
   * ⚠️ **按会话而不是按订单**：第一段读完了，第二段新来的消息仍然是未读；
   * 新一段会话建立时也不会继承旧一段的进度（`cmd_p0-14.md` §九）。
   */
  userLastReadAt: string | null;
  /**
   * 打手上次已读时间（P0-14 新增）；`kind === "service"` 时恒为 `null`。
   *
   * ⚠️ **放在会话上而不是按打手建索引**：一段履约会话只有一位打手，会话与打手是一对一，
   * 再建一张 `${conversationId}:${companionId}` 的索引只会多出一个可以写歪的地方。
   * 新打手拿到的是**新会话**，因此天然不继承旧打手的游标。
   */
  companionLastReadAt: string | null;
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
 *
 * ⚠️ **P0-14 刻意不把它改成按 assignment 分段**：客服查看履约会话是**调查**动作
 * （`cmd_p0-14.md` §八），不是参与聊天——客服没有「我这一段读到哪」这个概念，
 * 他要的是「这一单我处理到哪了」。改成按段会让工作台上同一个订单出现多行未读，
 * 而 `unread=1` 筛选与未读会话计数都会跟着变形。按订单一份游标，
 * 与「客服读的是整单」这件事是一致的。
 */
export type StaffReadRecord = {
  orderId: string;
  staffId: string;
  /** 这位客服读到这里；只前进不后退 */
  lastReadAt: string;
};

/** 一个**会话**的统计信息（由消息仓储算出，不含订单本身的字段）。 */
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
 * ⚠️ **这是「订单级」的一行，不是「会话级」的一行**：未读与消息数是该订单
 * **全部段落**的合计。用户的会话列表回答的是「这一单有没有新消息」，
 * 把同一张订单按段落拆成好几行会让列表变成流水账，而用户要的是「哪一单在等我」。
 * 分段展示是**聊天页内部**的事（见 `OrderConversationSegment`）。
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

/**
 * 聊天页里的一段会话（用户端 / 打手端共用的形状）。
 *
 * ⚠️ **不含 `id` / `assignmentKey` / `companionId`**：分段 UI 需要的是
 * 「这一段叫什么、能不能发、里面有哪几条消息」，不需要内部键。
 * 用户端要能凭它知道「这一段已经结束了」，但不能凭它反推出第几段履约。
 */
export type OrderConversationSegment = {
  /** 段落在订单内的稳定序号（0 起）。**仅供 UI key 与排序**，不承载任何内部键 */
  index: number;
  kind: ConversationKind;
  /** 段标题：「客服沟通」/「打手沟通」/「打手沟通（历史）」 */
  title: string;
  /**
   * 这一段是否**仍然是订单当前的履约段**。
   *
   * ⚠️ 与 `isReadOnly` **不是同一个问题**，两者都要有：`isReadOnly` 说「能不能往里发」，
   * `isCurrent` 说「这段履约还在不在进行中」。
   *
   * 三种组合**都真实存在**，页面不能假定其中一个蕴含另一个：
   *
   * | 场景 | `isCurrent` | `isReadOnly` |
   * |---|---|---|
   * | 客服会话 | `false` | `false`（永远可写） |
   * | 被换下的历史履约段 | `false` | `true` |
   * | **当前段，但订单已全额退款** | **`true`** | **`true`** |
   *
   * 第三行是 2026-09-27 产品裁定 `TBD-P0-14-1` 带来的：退款结束的是**这一段履约的写权限**，
   * 不是「它变成历史了」——它仍然是当前（也是唯一）那一段。
   */
  isCurrent: boolean;
  /**
   * 只能看，不能再往里发。
   *
   * 两种来源：这一段**已不是当前段**（换人 / 回池），或这一单**已全额退款**
   * （`isOrderChatClosed`）。客服会话两项都不适用，永远为 `false`。
   */
  isReadOnly: boolean;
  messages: OrderMessageView[];
};
