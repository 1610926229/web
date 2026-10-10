import { ApiError } from "@/lib/api/ApiError";
import {
  canCompanionAccessConversation,
  companionMessageSenderLabel,
  COMPANION_CHAT_HISTORY_NOTICE,
  COMPANION_CHAT_REFUNDED_NOTICE,
  isOrderChatClosed,
} from "@/lib/constants/conversations";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
  COMPANION_ORDER_REFUNDED_MESSAGE,
  normalizeMessageBody,
} from "@/lib/constants/service";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import type { Order } from "@/lib/types/order";
import type { OrderConversationRecord, OrderMessage } from "@/lib/types/message";
import type {
  CompanionChatDetail,
  CompanionChatListData,
  CompanionChatListItem,
  CompanionChatMessage,
} from "@/lib/types/companionChat";
import {
  ensureCurrentAssignmentConversation,
  resolveOrderAssignmentState,
  type OrderAssignmentState,
} from "./conversations";

/**
 * 打手端订单聊天服务（P0-14）—— 打手侧读取与发送的**唯一**入口。
 *
 * ## 三条硬规则
 *
 * 1. **归属只看 `Order.actualCompanionId`**。与「我的订单」（`companionOrders.ts`）
 *    同一个判据、同一个真值来源：聊天不是第二个归属系统。⚠️
 *    `exclusiveCompanionId` **绝不等于**归属——那是「用户当初指定了谁」的历史事实，
 *    订单回池、被别人接走之后都不清。
 * 2. **这一段必须是当前那一段**。判据只有一处：
 *    `canCompanionAccessConversation`（`lib/constants/conversations.ts`），
 *    本文件不自己拼「第几段」的比较——读与写用同一条判据，才不会有
 *    「读得到、发不出去」或更糟的「发得出去、读不到」。
 * 3. **换人之后旧打手立刻什么都看不到**，而且这件事**不靠本文件做任何清扫**：
 *    释放动作会清掉订单的 `actualCompanionId`（①失败）并让履约序号 +1（③失败），
 *    两条腿同时断。见 `lib/constants/conversations.ts` 的 `resolveAssignmentSeq`。
 *
 * ## 为什么没有 `withMockDebug` 的 params / surface 参数
 *
 * 打手端**整个端**（`companionOrders.ts` / `companionDispatch.ts` / `companionEarnings.ts`）
 * 都没有接 Mock 调试开关。这里跟着保持一致：单独给聊天加一个 `?mockError`
 * 会让人以为打手端支持故障注入，而实际上只有这一个模块支持——
 * 「部分支持」比「都不支持」更难解释。
 *
 * ⚠️ 本文件的每个导出函数**都要求调用方已经过 `requireCompanion()`**，
 * 且传入的 `companionId` 必须来自**守卫返回的那一份**，不是请求参数。
 * 本文件不再查一次「他是不是打手」——那是守卫的事，查第二遍就多一个真值来源。
 */

// ——————————————————————————— 履约上下文 ———————————————————————————

/**
 * 一次「这位打手能不能碰这条订单的聊天」的完整判定结果。
 *
 * 三步依次是 ① 订单归属、② 当前履约段、③ 会话本身还是不是那一段。
 * 任一步不成立就返回 null——**三种失败对外完全同形**，调用方一律当「查不到」处理，
 * 因此拿别人的订单 id 试探不出任何东西（`api-contract.md` §2.9）。
 */
type CompanionChatContext = {
  order: Order;
  state: OrderAssignmentState;
  /** 当前这一段的履约会话；还没建出来时为 null（只有读取路径会遇到） */
  conversation: OrderConversationRecord | null;
};

async function resolveChatContext(
  companionId: string,
  orderId: string,
): Promise<CompanionChatContext | null> {
  if (!orderId) return null;

  const order = await getPaymentRepository().findOrderById(orderId);
  // ① 订单归属：不存在与不是本人**同一个结果**，不能拿订单 id 试探别人有哪些单
  if (!order || order.actualCompanionId !== companionId) return null;

  const state = await resolveOrderAssignmentState(order.id, order.actualCompanionId);
  // 有履约人却算不出当前段，属于数据异常：当作「没有聊天」而不是给一段无法判定的会话
  if (!state.assignmentKey) return null;

  const found = await getMessageRepository().findAssignmentConversationByKey(
    order.id,
    state.assignmentKey,
  );

  // ② + ③：会话必须记在这位打手名下，而且仍然是当前那一段。
  // 找不到（还没建）时不算失败——读取路径会按需建立，写入路径建完再判
  if (found && !canCompanionAccessConversation(found, {
    companionId,
    actualCompanionId: order.actualCompanionId,
    currentAssignmentKey: state.assignmentKey,
  })) {
    return null;
  }

  return { order, state, conversation: found };
}

/**
 * 同上，但**保证当前这一段的会话存在**（不存在就建）。
 *
 * ⚠️ 建完**再判一次**权限，而不是假定新建的一定属于自己：
 * 「建出来的当然是我的」这句话在 `ensureAssignmentConversation` 幂等命中一段
 * 别人的会话时就不成立了（正常数据里不会发生，但这里不靠「不会发生」来把守）。
 */
async function resolveChatContextWithConversation(
  companionId: string,
  orderId: string,
): Promise<CompanionChatContext | null> {
  const context = await resolveChatContext(companionId, orderId);
  if (!context) return null;
  if (context.conversation) return context;

  const created = await ensureCurrentAssignmentConversation(
    context.order,
    context.state,
    new Date().toISOString(),
  );
  if (!created) return null;

  if (
    !canCompanionAccessConversation(created, {
      companionId,
      actualCompanionId: context.order.actualCompanionId,
      currentAssignmentKey: context.state.assignmentKey,
    })
  ) {
    return null;
  }

  return { ...context, conversation: created };
}

// ——————————————————————————— 展示加工 ———————————————————————————

/** 下单用户的昵称。查不到给空串——不让一个取不到的称呼把整页打挂。 */
async function resolveCustomerNickname(userId: string): Promise<string> {
  const user = await getUserRepository().findUserById(userId);
  return user?.nickname ?? "";
}

/**
 * 内部消息 → 打手视角的消息 DTO。
 *
 * ⚠️ `isSelf` 判的是 **senderId**：角色只说得出「这是哪一类人发的」。
 * 一段履约会话里出现的打手消息按规则就应该是当前这位打手发的，
 * 但「按规则应该是」不是「判过了」。
 */
function toCompanionChatMessage(message: OrderMessage, companionId: string): CompanionChatMessage {
  const isSelf = message.senderId === companionId;
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt,
    senderRole: message.senderRole,
    isSelf,
    senderLabel: companionMessageSenderLabel(message.senderRole, isSelf),
    senderAvatarUrl: message.senderAvatarUrl,
  };
}

/** 某个会话里的未读数：用户发来的、且在这位打手已读位置之后的条数。 */
function companionUnreadCount(
  messages: readonly OrderMessage[],
  lastReadAt: string | null,
): number {
  return messages.filter(
    (message) =>
      // 客服消息不会出现在履约会话里，因此这里只需排除自己这一类。
      // 用 `!== "companion"` 而不是 `senderId !== me`：**未读是「对方发来的」**，
      // 一条不属于自己的打手消息（异常数据）也该算成未读，而不是静默消失
      message.senderRole !== "companion" && (lastReadAt === null || message.createdAt > lastReadAt),
  ).length;
}

function toChatListItem(
  order: Order,
  customerNickname: string,
  messages: OrderMessage[],
  lastReadAt: string | null,
): CompanionChatListItem {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    customerNickname,
    messageCount: messages.length,
    lastMessageBody: last ? last.body : null,
    lastMessageAt: last ? last.createdAt : null,
    lastMessageRole: last ? last.senderRole : null,
    unreadCount: companionUnreadCount(messages, lastReadAt),
    // 由**唯一判据**算出，列表不做自己的判断（裁定 `TBD-P0-14-1`）。
    // 退款只关掉写权限：这一行仍然留在列表里，历史仍然点得进去。
    isReadOnly: isOrderChatClosed(order.status),
  };
}

/** 列表排序：最近有消息的排前面，没有消息的按订单号倒序——**全序**，分页/刷新都不跳行。 */
function compareChatListItems(a: CompanionChatListItem, b: CompanionChatListItem): number {
  const aAt = a.lastMessageAt ?? "";
  const bAt = b.lastMessageAt ?? "";
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  if (a.orderNo !== b.orderNo) return a.orderNo < b.orderNo ? 1 : -1;
  return 0;
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 当前打手的订单聊天列表。
 *
 * ⚠️ **行来自订单，不来自会话**：列表回答的是「我手上这几单，哪一单用户在等我回话」。
 * 只列「已经聊过的会话」会让一条刚接、还没人开口的单凭空消失——
 * 而那正是打手最需要看到的「去打个招呼」的入口。
 *
 * ⚠️ 因此订单集合用的是与「我的订单」**同一个查询**
 * （`queryOrdersByCompanion`）。换人之后 `actualCompanionId` 被清掉，
 * 这一单**同时**从「我的订单」与「订单聊天」里消失——不需要额外清扫，
 * 也不存在「订单列表里没有了、聊天列表里还在」这种半失权状态。
 */
export async function listCompanionChats(companionId: string): Promise<CompanionChatListData> {
  const orders = await getPaymentRepository().queryOrdersByCompanion(companionId);
  const repository = getMessageRepository();

  const items: CompanionChatListItem[] = [];
  let totalUnread = 0;

  for (const order of orders) {
    const context = await resolveChatContext(companionId, order.id);
    // 订单在名下却算不出当前段：跳过而不是给一行空壳——正常的订单不会走到这里
    if (!context) continue;

    const messages = context.conversation
      ? await repository.listMessagesInConversation(context.conversation.id)
      : [];
    const item = toChatListItem(
      order,
      await resolveCustomerNickname(order.userId),
      messages,
      context.conversation?.companionLastReadAt ?? null,
    );
    totalUnread += item.unreadCount;
    items.push(item);
  }

  items.sort(compareChatListItems);
  return { items, totalUnread, notice: COMPANION_CHAT_HISTORY_NOTICE };
}

/**
 * 某一条订单的聊天页内容。
 *
 * 订单不存在、不是本人、当前没有履约段、或这一段不是他的 → `null`（调用方转 404）。
 *
 * ⚠️ 读取路径**会顺手建立当前这一段的会话**（幂等）：这与用户端
 * `getMessagesForUser` 建立客服会话是同一个道理——「打开聊天页」本身就是
 * 「开始这段沟通」这个动作，不需要先由某一方开口。
 */
export async function getCompanionChatDetail(
  companionId: string,
  orderId: string,
): Promise<CompanionChatDetail | null> {
  const context = await resolveChatContextWithConversation(companionId, orderId);
  if (!context || !context.conversation) return null;

  const messages = await getMessageRepository().listMessagesInConversation(
    context.conversation.id,
  );

  // 退款后这段履约**照旧可读**（这正是裁定第 1 条要保留的），只把写权限关掉。
  // 读取路径因此**不因为退款提前返回 null**——那会把历史一起藏掉。
  const isReadOnly = isOrderChatClosed(context.order.status);

  return {
    orderId: context.order.id,
    orderNo: context.order.orderNo,
    productTitle: context.order.productTitle,
    orderStatus: context.order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[context.order.status] ?? context.order.status,
    customerNickname: await resolveCustomerNickname(context.order.userId),
    messages: messages.map((message) => toCompanionChatMessage(message, companionId)),
    companionLastReadAt: context.conversation.companionLastReadAt,
    isReadOnly,
    // 只读时换成「这一单退掉了」的说明：原来的「换人之后看不到」在这张单上
    // 既没有换人也不是原因，留着会让人答错问题（见该常量的注释）。
    notice: isReadOnly ? COMPANION_CHAT_REFUNDED_NOTICE : COMPANION_CHAT_HISTORY_NOTICE,
  };
}

// ——————————————————————————— 已读 ———————————————————————————

/**
 * 把这一段标记为**当前打手**已读。
 *
 * ⚠️ 只动这位打手自己的游标：用户那边的未读不受影响，客服那边的也不受影响
 * （三者是三份独立状态，见 `lib/types/message.ts`）。
 *
 * ⚠️ **不去建会话**：已读是「读过了」的记账，没有可读的东西就没什么可记的。
 * 返回 false 表示这一单没有他能读的聊天（调用方转 404）。
 */
export async function markCompanionChatRead(
  companionId: string,
  orderId: string,
): Promise<boolean> {
  const context = await resolveChatContext(companionId, orderId);
  if (!context || !context.conversation) return false;

  const updated = await getMessageRepository().markAssignmentConversationRead(
    context.conversation.id,
    companionId,
    new Date().toISOString(),
  );
  return updated !== null;
}

// ——————————————————————————— 发送 ———————————————————————————

/** 发送者的身份快照来源：`requireCompanion()` 返回的会话身份。 */
export type CompanionChatSender = {
  companionId: string;
  displayName: string;
  avatarUrl: string;
};

/**
 * 打手发送一条消息。
 *
 * 四条约束在写入前全部由服务端完成：
 *
 * 1. **归属与段都必须成立**（不是本人 / 已被换下 → 404，与「订单不存在」同体）；
 * 2. **内容去空白后必须非空且不超长**——与用户端同一个 `MESSAGE_MAX_LENGTH`；
 * 3. **发送者身份由服务端写**：`senderId` 恒为**守卫返回的** `companionId`，
 *    `senderRole` 恒为 `companion`。请求体里的 `senderId` / `senderRole`
 *    根本没有被读取的地方，伪造用户或客服身份无从下手；
 * 4. **不修改订单**：发一条消息不改状态、不改金额、不改商品；
 * 5. **订单已全额退款时拒绝写入**（400，裁定 `TBD-P0-14-1`）——读取不受影响，
 *    历史照旧看得到，只是不能再发。这是 400 而**不是** 404：这段会话确实属于他，
 *    回 404 会让聊天页把历史也一起藏掉，与「保留可查」相悖。
 *    该闸**零副作用**：被拒绝的发送不会顺手把这一段空会话建出来（见函数内注释）。
 *
 * ⚠️ 消息的 `userId` 写的是**下单用户**，不是打手：这样用户端按自己的 userId
 * 就能读到打手发来的消息。与客服端 `sendMessageForStaff` 是同一条约定。
 */
export async function sendMessageForCompanion(
  sender: CompanionChatSender,
  orderId: string,
  body: Record<string, unknown>,
): Promise<{ messageId: string; created: boolean }> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const text = normalizeMessageBody(typeof body.body === "string" ? body.body : "");
  if (!text.ok) throw new ApiError("BAD_REQUEST", text.message);

  // ⚠️ 这里用**不建会话**的 `resolveChatContext`，退款闸过了才建。
  //
  // 先建会话再判退款，会让一次**被拒绝**的发送留下副作用——把这一段空会话
  // 真的建出来。而本项目的既有约定是「状态闸 400 必须**零副作用**」
  // （P0-13 `D22`：非 `serving` / `completed` 档位 400 且零副作用）。
  // 读路径建会话是对的（「打开聊天页」本身就是开始沟通）；**被拒绝的写**不是。
  const resolved = await resolveChatContext(sender.companionId, orderId);
  if (!resolved) {
    throw new ApiError("NOT_FOUND", COMPANION_CONVERSATION_FORBIDDEN_MESSAGE);
  }

  // 全额退款闸（裁定 `TBD-P0-14-1`）：订单 `refunded` 后这一段履约立即只读。
  //
  // ⚠️ 排在归属 / 段判定**之后**：先确认「这段聊天确实是你的」，再告诉他
  // 「你的这段不能写了」。反过来会把「不是你的订单」也答成「已退款」，
  // 于是拿别人的订单 id 就能问出那张单退没退款（`api-contract.md` §2.9）。
  //
  // ⚠️ 判据是 `isOrderChatClosed`，**不是** `actualCompanionId`：退款不清它
  // （P0-12 硬约束），所以退款后它照旧等于本人——拿它当「还能聊」的充分条件
  // 就是本条裁定第 2 条明确否掉的那个错误。
  if (isOrderChatClosed(resolved.order.status)) {
    throw new ApiError("BAD_REQUEST", COMPANION_ORDER_REFUNDED_MESSAGE);
  }

  // 闸过完了才确保这一段存在（不存在就建，建完**再判一次**权限）。
  // 会话已经存在时不重复解析——上面那一趟已经把归属与段判完了。
  const context =
    resolved.conversation !== null
      ? resolved
      : await resolveChatContextWithConversation(sender.companionId, orderId);
  if (!context || !context.conversation) {
    throw new ApiError("NOT_FOUND", COMPANION_CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const outcome = await getMessageRepository().createMessage(
    {
      id: `msg_${crypto.randomUUID()}`,
      orderId: context.order.id,
      userId: context.order.userId,
      conversationId: context.conversation.id,
      // 发送者身份全部由服务端写入，客户端无从指定
      senderId: sender.companionId,
      senderRole: "companion",
      // 名称与头像都是**快照**：这位护航之后被下架或改名，历史消息仍然显示当时的样子
      senderName: sender.displayName,
      senderAvatarUrl: sender.avatarUrl,
      body: text.body,
      createdAt: new Date().toISOString(),
    },
    idempotencyKey,
  );

  if (!outcome) throw new ApiError("NOT_FOUND", COMPANION_CONVERSATION_FORBIDDEN_MESSAGE);
  return { messageId: outcome.message.id, created: outcome.created };
}
