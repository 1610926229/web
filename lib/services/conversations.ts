import { ApiError } from "@/lib/api/ApiError";
import {
  buildConversationSegments,
  isOrderChatClosed,
  resolveAssignmentSeq,
  resolveCurrentAssignmentKey,
  serviceConversationId,
  toMessageView,
} from "@/lib/constants/conversations";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  MESSAGE_ASSIGNMENT_CONVERSATION_MISSING_MESSAGE,
  MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE,
  MESSAGE_ORDER_REFUNDED_MESSAGE,
  MESSAGE_TARGET_INVALID_MESSAGE,
  normalizeMessageBody,
  readMessageTarget,
} from "@/lib/constants/service";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getCompanionReleaseRepository } from "@/lib/data/companionReleaseRepository";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  ConversationStats,
  OrderConversation,
  OrderConversationRecord,
  OrderConversationSegment,
  OrderMessage,
  OrderMessageView,
} from "@/lib/types/message";

/**
 * 订单沟通服务 —— 客服首页的会话列表、聊天页与消息接口共用的唯一入口。
 *
 * 六条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只能看 / 只能发自己的订单会话**。所有入口都先按订单归属校验，不属于当前用户的
 *    订单一律当作不存在（404），拿不到可区分的「这不是你的」信息。
 * 2. **发送者身份由服务端写入**。请求体里没有 `senderRole` / `senderId` / `senderName`
 *    这些字段可读，客户端无法伪造「客服」或「打手」发消息。
 * 3. **不做实时聊天**。没有 WebSocket：发送后由页面重新拉取，刷新也是重新拉取。
 * 4. **写入幂等**。「会话 + 发送者 + 幂等键」只产生一条消息，快速连点不会刷出重复消息。
 * 5. **P0-14：用户看得到自己订单的完整历史，但只能往两个地方发**——
 *    客服会话，与**当前**这一段履约。历史履约会话只读，而且接口里
 *    **没有**「发给历史段」这个取值（见 `MESSAGE_TARGETS`）。用户做不到，
 *    不是「做到了被拒绝」。
 * 6. **对外 DTO 不带内部键**。消息一律经 `toMessageView()` 出去，
 *    因此 `conversationId`（= 履约身份键）不会泄漏给用户（`cmd_p0-14.md` §十四.31）。
 *
 * ⚠️ 本文件里的**履约状态判据**（`resolveOrderAssignmentState` 与
 * `ensureCurrentAssignmentConversation`）是**用户端与打手端的共用件**，
 * 由 `lib/services/companionConversations.ts` 复用。两处各写一份「当前是哪一段」，
 * 迟早会有一处判错，而判错的后果是**一位不该看到的打手看到了别人的聊天**。
 */

// ——————————————————————————— 会话统计 ———————————————————————————

/**
 * 单段会话 + 该段消息 → 统计信息。
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

/**
 * 订单的**全部段落** → 订单级统计（会话列表、订单详情摘要、管理端共用）。
 *
 * ⚠️ **未读按每一段自己的游标算，再把结果加起来**——不是拿某一段的游标去算全单。
 * 这两种算法在今天的数据上**结果一样**（新一段的游标总是 null，等于全算未读），
 * 差别在「用户读完整单、之后又换了一次人」之后：分段算法会正确地让新打手的第一条
 * 消息重新变成未读，而单游标算法会把它当成已读——用户永远看不到那个角标。
 *
 * ⚠️ 找不到所属会话的消息按「从未读过」处理（`?? null`）。这是**故意的偏向**：
 * 宁可多一个未读角标，也不要因为一条对不上号的记录把未读安静地吞掉。
 * 正常数据里不该出现，出现了也不该静默。
 *
 * `conversations` 必须非空：订单没有会话时「摘要」这个概念不成立，
 * 调用方应当先判空再决定是否生成摘要。
 */
export function buildOrderConversationStats(
  conversations: readonly OrderConversationRecord[],
  messages: readonly OrderMessage[],
): ConversationStats {
  const cursors = new Map(conversations.map((conversation) => [conversation.id, conversation.userLastReadAt]));
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;

  const unreadCount = messages.filter((message) => {
    if (message.senderRole === "user") return false;
    const cursor = cursors.get(message.conversationId) ?? null;
    return cursor === null || message.createdAt > cursor;
  }).length;

  return {
    orderId: conversations[0]?.orderId ?? "",
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

// ——————————————————————————— 履约段（P0-14）———————————————————————————

/**
 * 订单当前这一段履约的身份。
 *
 * ⚠️ `assignmentSeq` 的来历（为什么是「退出历史的条数」而不是打手 id）
 * 见 `lib/constants/conversations.ts` 的 `resolveAssignmentSeq`——
 * 那是本轮最关键的一条规则，改动它之前请先读完那段注释。
 */
export type OrderAssignmentState = {
  /** 当前这一段履约的身份键；订单没有履约人时为 null */
  assignmentKey: string | null;
  /** 当前履约序号；没有履约人时为 null */
  assignmentSeq: number | null;
};

/**
 * 读订单当前的履约段。
 *
 * ⚠️ **没有履约人时不去查退出历史**：公共池里的订单不存在履约会话
 * （`cmd_p0-14.md` §4.1），少一次查询就少一处可能不一致的地方。
 * 返回的 `assignmentKey` 为 null，调用方据此整个跳过 assignment 分支。
 */
export async function resolveOrderAssignmentState(
  orderId: string,
  actualCompanionId: string | null,
): Promise<OrderAssignmentState> {
  if (!actualCompanionId) return { assignmentKey: null, assignmentSeq: null };

  const releases = await getCompanionReleaseRepository().listReleasesByOrderId(orderId);
  const assignmentSeq = resolveAssignmentSeq(releases.length);
  return {
    assignmentSeq,
    assignmentKey: resolveCurrentAssignmentKey({ orderId, actualCompanionId, releaseCount: releases.length }),
  };
}

/**
 * 幂等建立**当前这一段**的履约会话（用户端与打手端共用）。
 *
 * 订单没有履约人、或这一段已经建好时：前者返回 null，后者原样返回既有会话。
 *
 * ⚠️ **谁先打开谁建**（懒创建）。需求只规定「一段履约对应一段会话」，没有规定
 * 由谁在什么时刻建；让第一个访问者建，换来的是**不存在「该建而没建」的窗口**：
 * 无论用户先说话、打手先说话，还是两人都只是看了一眼，拿到的都是同一段会话。
 * 若改成在接单事务里建，就得给 P0-11 的原子区段加一次跨仓储写入，
 * 而那段代码的价值恰恰在于它**只做订单与派单两件事**。
 */
export async function ensureCurrentAssignmentConversation(
  order: Order,
  state: OrderAssignmentState,
  createdAt: string,
): Promise<OrderConversationRecord | null> {
  if (!state.assignmentKey || state.assignmentSeq === null) return null;
  if (!order.actualCompanionId) return null;

  return getMessageRepository().ensureAssignmentConversation({
    orderId: order.id,
    userId: order.userId,
    assignmentKey: state.assignmentKey,
    assignmentSeq: state.assignmentSeq,
    companionId: order.actualCompanionId,
    createdAt,
  });
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 当前用户的会话列表（客服首页「订单沟通」）。
 *
 * ⚠️ **一行 = 一张订单**，不是一段会话：用户要回答的问题是「哪一单在等我」，
 * 把同一单按履约段拆成好几行会让列表变成流水账。分段是聊天页内部的事。
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

  // 会话按订单归拢：一个订单一行，未读与消息数是这一单**全部段落**的合计
  const byOrder = new Map<string, OrderConversationRecord[]>();
  for (const conversation of conversations) {
    const list = byOrder.get(conversation.orderId);
    if (list) list.push(conversation);
    else byOrder.set(conversation.orderId, [conversation]);
  }

  const orderIds = [...byOrder.keys()];
  const orders = await Promise.all(
    orderIds.map((orderId) => getPaymentRepository().findOrderById(orderId)),
  );

  return orders
    .flatMap((order, index) => {
      // 订单不存在属于数据异常：这条会话渲染不出来（没有订单号可展示），跳过而不是整页报错
      if (!order) return [];
      const rows = byOrder.get(orderIds[index]) ?? [];
      const messages = grouped.get(order.id) ?? [];
      return [toOrderConversation(buildOrderConversationStats(rows, messages), order, messages)];
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

/** `getMessagesForUser` 的返回形状。分段与扁平两种视图一起给，见函数注释。 */
export type UserConversationPayload = {
  /** 订单级聚合统计（会话列表同一口径） */
  conversation: OrderConversation;
  /** 这一单**全部段落**的消息，按时间升序（「完整历史」） */
  messages: OrderMessageView[];
  /** 同一批消息的分段视图，供分段 UI 使用 */
  segments: OrderConversationSegment[];
};

/**
 * 读取某一笔订单的沟通记录。
 *
 * 订单不存在或不属于当前用户返回 null（调用方转 404）。
 *
 * 三件事在读取时发生，都是幂等的：
 *
 * 1. 客服会话不存在则建立——这正是「用户主动发起沟通」这个动作；
 * 2. 订单有履约人则建立**当前这一段**的履约会话——这样用户一进聊天页就能看到
 *    「给护航发消息」的入口，而不是等到某一方先开口（见
 *    `ensureCurrentAssignmentConversation` 的懒创建说明）；
 * 3. 全部段落与全部消息一起返回。
 *
 * ⚠️ `messages` 与 `segments` 是**同一批消息的两种组织方式**，不是一个子集关系：
 * 前者让聊天页按时间线展示完整历史（既有页面直接用），后者让分段 UI 能按履约段
 * 分组，并标出哪一段已经只读。两者都经过 `toMessageView()`，都不含内部键。
 */
export async function getMessagesForUser(
  userId: string,
  orderId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<UserConversationPayload | null> {
  const order = await getConversationOrderForUser(userId, orderId);
  if (!order) return null;

  const repository = getMessageRepository();
  const now = new Date().toISOString();

  await withMockDebug(params, surface, () => repository.ensureConversation(userId, orderId, now));

  const state = await resolveOrderAssignmentState(order.id, order.actualCompanionId);
  await withMockDebug(params, surface, () => ensureCurrentAssignmentConversation(order, state, now));

  const conversations = await repository.listConversationsByOrder(userId, orderId);
  const messages = await repository.listMessages(userId, orderId);

  return {
    conversation: toOrderConversation(
      buildOrderConversationStats(conversations, messages),
      order,
      messages,
    ),
    messages: messages.map(toMessageView),
    segments: buildConversationSegments(conversations, messages, state.assignmentKey, order.status),
  };
}

/**
 * 把会话标记为已读（进入聊天页时调用）。
 *
 * ⚠️ **这一单的每一段都标记**：用户打开聊天页看到的是整条时间线，
 * 只清最后一段会让上一段的角标永远挂着。返回 false = 这一单没有任何属于他的会话。
 */
export async function markConversationReadForUser(
  userId: string,
  orderId: string,
): Promise<boolean> {
  return getMessageRepository().markConversationRead(userId, orderId, new Date().toISOString());
}

// ——————————————————————————— 发送 ———————————————————————————

/**
 * 发送一条消息。
 *
 * 四条约束在写入前全部由服务端完成：
 *
 * 1. **订单必须是自己的**（否则 404）——请求里只有订单 id，没有别的归属信息可伪造；
 * 2. **内容去空白后必须非空且不超长**——只发几个空格不算消息；
 * 3. **发送对象只能是 `service` 或 `current`**（省略时默认 `service`），
 *    非法值报 400 而**不是**回退默认值——写错了却收到成功，消息会安静地落到别处；
 * 4. **发送者身份由服务端写**：用户端发出的消息永远是 `user` 角色，发送者是当前登录用户。
 *    请求体里的 `senderRole` / `senderId` 之类根本不会被读取；
 * 5. **`current` 且订单已全额退款时拒绝写入**（`isOrderChatClosed`，裁定 `TBD-P0-14-1`）——
 *    履约段转入只读，但**读路径不受影响**，历史仍然看得到。
 *
 * ⚠️ **`current` 且订单此刻没有履约人时是 400，不是 404**：这既不是「订单不存在」
 * 也不是「不是你的」，而是「你现在没有护航」。用户需要看到的是这句话，
 * 而不是一个让人以为页面坏了的 404。
 *
 * ⚠️ **退款同样返回 400 而不是 404**：会话确实存在、也确实是他的，只是不能再写。
 * 回 404 会让页面把整段历史当成「不存在」而藏起来，与「保留可查」的裁定相悖。
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

  const target = readMessageTarget(body.target);
  if (target === null) throw new ApiError("BAD_REQUEST", MESSAGE_TARGET_INVALID_MESSAGE);

  const text = normalizeMessageBody(typeof body.body === "string" ? body.body : "");
  if (!text.ok) throw new ApiError("BAD_REQUEST", text.message);

  const order = await getConversationOrderForUser(userId, orderId);
  if (!order) throw new ApiError("NOT_FOUND", "订单不存在");

  const repository = getMessageRepository();
  const now = new Date().toISOString();

  // —— 落到哪一段：**只有这里**决定，出口只有一个 ——
  let conversationId: string;
  if (target === "service") {
    await withMockDebug(params, surface, () => repository.ensureConversation(userId, orderId, now));
    conversationId = serviceConversationId(orderId);
  } else {
    // 全额退款闸：`TBD-P0-14-1`（2026-09-27 产品裁定）——订单一旦 `refunded`，
    // 当前这一段履约立即**只读**：历史保留、双方都还能读，但谁都不能再写。
    //
    // ⚠️ 判据是 `order.status === "refunded"`（累计全额退款），**不是** `refundedAmount > 0`：
    // 部分退款不结束履约（裁定第 5 条），而部分退款同样会让 `refundedAmount > 0`。
    // 用金额判会把「退了一半还在服务中」的单子错误地锁死。
    //
    // ⚠️ 这个闸**必须排在 assignmentKey 之前**：退款不会清 `actualCompanionId`、
    // 也不会追加释放记录，所以退款后 `assignmentKey` 仍然存在——放在后面等于永远不触发。
    // 同时「这一单退掉了」比「你现在没有打手」更接近用户想知道的答案。
    if (isOrderChatClosed(order.status)) {
      throw new ApiError("BAD_REQUEST", MESSAGE_ORDER_REFUNDED_MESSAGE);
    }

    const state = await resolveOrderAssignmentState(order.id, order.actualCompanionId);
    if (!state.assignmentKey) {
      throw new ApiError("BAD_REQUEST", MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE);
    }
    const conversation = await withMockDebug(params, surface, () =>
      ensureCurrentAssignmentConversation(order, state, now),
    );
    if (!conversation) {
      throw new ApiError("NOT_FOUND", MESSAGE_ASSIGNMENT_CONVERSATION_MISSING_MESSAGE);
    }
    conversationId = conversation.id;
  }

  // 发送者名称写的是当前用户自己的昵称（与预置数据一致）。
  // 页面上显示成「我」是**展示层**的事（`messageSenderLabel`），不是数据里的事实。
  const user = await getDataSource().findUserById(userId);

  const outcome = await repository.createMessage(
    {
      id: `msg_${crypto.randomUUID()}`,
      orderId: order.id,
      userId: order.userId,
      conversationId,
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
