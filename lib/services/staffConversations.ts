import { ApiError } from "@/lib/api/ApiError";
import { beijingDayStart } from "@/lib/constants/rankingPeriods";
import { normalizeMessageBody } from "@/lib/constants/service";
import {
  STAFF_CONVERSATION_LIST_NOTICE,
  STAFF_CONVERSATION_NOT_FOUND_MESSAGE,
  STAFF_ORDER_STATUS_INVALID_MESSAGE,
  STAFF_OVERVIEW_NOTICE,
  buildStaffConversationListQuery,
  compareStaffConversations,
  readStaffOrderStatusFilter,
  staffConversationMatchesKeyword,
  staffUnreadCount,
  toStaffConversationListItem,
  toStaffConversationMessage,
  toStaffOrderSummary,
  type StaffConversationListQuery,
  type StaffOrderStatusFilter,
} from "@/lib/constants/staff";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type { OrderMessage } from "@/lib/types/message";
import type {
  StaffConversationDetail,
  StaffConversationListData,
  StaffConversationListItem,
  StaffConversationMetrics,
  StaffSessionUser,
} from "@/lib/types/staff";

/**
 * 客服工作台服务 —— 工作台首页、会话列表、会话详情与客服发消息共用的唯一入口。
 *
 * 六条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只读得到「有会话的订单」**。所有入口都先查会话，查不到一律当作不存在（404），
 *    与「订单不存在」返回**完全一样**的结果——客服随便猜一个订单 id 试探不出任何东西。
 * 2. **消息仓储只有一份**。本文件读写的是 `getMessageRepository()`，
 *    与用户端 `lib/services/conversations.ts` 是**同一个仓储、同一批消息**，
 *    因此客服发出的消息用户端刷新就能看到。这里没有、也不会有「客服专用消息副本」。
 * 3. **发送者身份由服务端写入**。请求体里没有 `senderRole` / `senderId` / `senderName`
 *    这些字段可读，客户端无法伪造用户或护航发消息。
 * 4. **已读按「当前客服」记录**。用的是 `staffReads` 索引（`orderId + staffId`），
 *    与用户侧的 `userLastReadAt` 是两份互不影响的状态：客服读完不清用户的未读，
 *    反过来也一样。
 * 5. **不改订单**。本文件从头到尾没有一处写订单：不改状态、不改金额、不改商品，
 *    也不碰退款与投诉。
 * 6. **不做实时聊天**。没有 WebSocket：发送后由页面重新拉取，刷新也是重新拉取。
 *
 * ⚠️ 本文件的每个导出函数**都要求调用方已经过 `requireStaff()`**：
 * 仓储的客服侧读取刻意不按 `userId` 过滤（工作台本来就要跨用户看有会话的订单），
 * 因此「谁在读」必须由接口层先判掉。函数签名里带 `staffId` 的，用的都是
 * **守卫返回的那一份**，不是请求体里传进来的。
 */

// ——————————————————————————— 内部：会话 + 订单 + 用户 ———————————————————————————

/**
 * 一条会话凑齐「订单 + 用户昵称 + 消息 + 这位客服的已读位置」。
 *
 * 拿不到订单的会话**直接跳过**：没有订单号就没有可展示的行，
 * 整页报错不如少一行。真正的数据异常会在别处暴露出来。
 */
type StaffConversationRow = {
  order: Order;
  userNickname: string;
  messages: OrderMessage[];
  staffLastReadAt: string | null;
};

async function loadStaffConversationRows(
  staffId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffConversationRow[]> {
  const repository = getMessageRepository();

  const [conversations, grouped, reads] = await withMockDebug(params, surface, () =>
    Promise.all([
      repository.listConversationsForStaff(),
      repository.listMessagesGroupedForStaff(),
      repository.listStaffReads(staffId),
    ]),
  );

  const orders = await Promise.all(
    conversations.map((conversation) => getPaymentRepository().findOrderById(conversation.orderId)),
  );

  // 用户昵称按需查：同一批会话里往往只有几个用户，重复查一次的成本比预先全量取更低
  const nicknames = new Map<string, string>();
  const rows: StaffConversationRow[] = [];

  for (let index = 0; index < conversations.length; index += 1) {
    const conversation = conversations[index];
    const order = orders[index];
    if (!conversation || !order) continue;

    let nickname = nicknames.get(order.userId);
    if (nickname === undefined) {
      const user = await getDataSource().findUserById(order.userId);
      // 用户查不到时用一句中性称呼兜住：会话仍然要能显示出来，
      // 而不是因为一个昵称取不到就让整行消失
      nickname = user ? user.nickname : "用户";
      nicknames.set(order.userId, nickname);
    }

    rows.push({
      order,
      userNickname: nickname,
      messages: grouped.get(conversation.orderId) ?? [],
      staffLastReadAt: reads.get(conversation.orderId) ?? null,
    });
  }

  return rows;
}

/** 会话行 → 列表项 DTO。未读数用的是**当前客服**的已读位置。 */
function toListItem(row: StaffConversationRow): StaffConversationListItem {
  const last = row.messages.length > 0 ? row.messages[row.messages.length - 1] : undefined;

  return toStaffConversationListItem({
    order: row.order,
    userNickname: row.userNickname,
    messageCount: row.messages.length,
    lastMessageBody: last ? last.body : null,
    lastMessageAt: last ? last.createdAt : null,
    lastMessageRole: last ? last.senderRole : null,
    staffUnreadCount: staffUnreadCount(row.messages, row.staffLastReadAt),
  });
}

// ——————————————————————————— 工作台首页 ———————————————————————————

/**
 * 工作台首页的三个数（§四：**真实聚合**，不是写死的展示值）。
 *
 * - `conversationCount`：有会话的订单数。与列表筛选无关——它是「一共有多少单在沟通」；
 * - `unreadConversationCount`：**当前客服**还有未读的会话数，不是未读条数；
 * - `todayMessageCount`：今天（北京时间自然日）产生的消息条数，含客服自己发的。
 *
 * 三个数每次都从仓储现算。缓存会让「刚发完消息回到首页，数字还是旧的」，
 * 而验收时看到的正是一个不动的数字。
 */
export async function getStaffOverviewMetrics(
  staffId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffConversationMetrics> {
  const rows = await loadStaffConversationRows(staffId, params, surface);

  const dayStart = beijingDayStart(new Date(), 0);
  let unreadConversationCount = 0;
  let todayMessageCount = 0;

  for (const row of rows) {
    const unread = staffUnreadCount(row.messages, row.staffLastReadAt);
    if (unread > 0) unreadConversationCount += 1;

    for (const message of row.messages) {
      if (new Date(message.createdAt).getTime() >= dayStart) todayMessageCount += 1;
    }
  }

  return {
    conversationCount: rows.length,
    unreadConversationCount,
    todayMessageCount,
    generatedAt: new Date().toISOString(),
    notice: STAFF_OVERVIEW_NOTICE,
  };
}

// ——————————————————————————— 会话列表 ———————————————————————————

/**
 * 工作台会话列表：搜索 + 未读筛选 + 订单状态筛选 + 分页 + **稳定排序**。
 *
 * 排序（`compareStaffConversations`）最后一步用订单号倒序兜底，分页才不会漏行重行。
 * 筛选只作用于**展示**：`total` 是筛选后的条数，首页的会话总数不受这里影响。
 */
export async function listConversationsForStaff(
  staffId: string,
  query: StaffConversationListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffConversationListData> {
  const rows = await loadStaffConversationRows(staffId, params, surface);

  const filtered = rows
    .map(toListItem)
    .filter((item) => {
      if (query.status !== "all" && item.orderStatus !== query.status) return false;
      if (query.unreadOnly && item.unreadCount <= 0) return false;
      return staffConversationMatchesKeyword({
        keyword: query.keyword,
        orderNo: item.orderNo,
        userNickname: item.userNickname,
        productTitle: item.productTitle,
      });
    })
    .sort(compareStaffConversations);

  const total = filtered.length;
  const start = (query.page - 1) * query.pageSize;
  const items = filtered.slice(start, start + query.pageSize);

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasMore: start + items.length < total,
    notice: STAFF_CONVERSATION_LIST_NOTICE,
  };
}

/**
 * 接口与页面共用的查询解析。
 *
 * `strict: true` 时非法枚举值抛 400（接口），`false` 时回退默认值（页面地址栏）。
 * 与订单、会话列表同一套做法：**地址是用户随手可改的，接口是可被直接请求的**，
 * 两者对非法输入该有不同的反应。
 */
export function resolveStaffConversationListQuery(
  params: URLSearchParams,
  strict: boolean,
): StaffConversationListQuery {
  const rawStatus = params.get("status");
  const status = readStaffStatus(rawStatus, strict);
  return buildStaffConversationListQuery({ params, status });
}

function readStaffStatus(raw: string | null, strict: boolean): StaffOrderStatusFilter {
  const value = readStaffOrderStatusFilter(raw);
  // null 表示「解析不了」，与「解析成 all」是两回事：只有这里能区分，
  // 因此判断放在解析函数之外，常量模块只回答「这个值合不合法」
  if (value === null) {
    if (strict) throw new ApiError("BAD_REQUEST", STAFF_ORDER_STATUS_INVALID_MESSAGE);
    return "all";
  }
  return value;
}

// ——————————————————————————— 会话详情 ———————————————————————————

/**
 * 一个会话的完整详情：订单只读摘要 + 用户 + 三方历史消息 + 当前客服的已读位置。
 *
 * ⚠️ **没有会话就返回 null**，与「订单不存在」是同一个结果：
 * 客服只能访问存在会话的相关订单，随意猜测其他订单 ID 会得到与不存在相同的 404。
 * 「订单存在但没人聊过」同样返回 null——不允许客服从订单号反推出一笔订单的信息。
 */
export async function getStaffConversationDetail(
  staffId: string,
  orderId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffConversationDetail | null> {
  if (!orderId) return null;

  const repository = getMessageRepository();
  const conversation = await repository.findConversationForStaff(orderId);
  if (!conversation) return null;

  const order = await getPaymentRepository().findOrderById(orderId);
  // 会话存在但订单查不到属于数据异常。**不给出半份详情**：当作不存在，
  // 免得出现「有消息记录但没有订单号」这种解释不清的页面
  if (!order || order.userId !== conversation.userId) return null;

  const [messages, staffLastReadAt, user] = await withMockDebug(params, surface, () =>
    Promise.all([
      repository.listMessagesForStaff(orderId),
      repository.findStaffLastReadAt(orderId, staffId),
      getDataSource().findUserById(order.userId),
    ]),
  );

  return {
    order: toStaffOrderSummary(order, user ? user.nickname : "用户"),
    user: {
      id: user ? user.id : order.userId,
      nickname: user ? user.nickname : "用户",
      avatarUrl: user ? user.avatarUrl : "",
    },
    // 消息实体不直接作为响应：每一条都经过展示层加工（称呼 + 是不是自己发的）
    messages: messages.map((message) => toStaffConversationMessage(message, staffId)),
    staffLastReadAt,
  };
}

// ——————————————————————————— 已读 ———————————————————————————

/**
 * 把会话标记为**当前客服**已读（打开详情页时调用）。
 *
 * ⚠️ 只动这位客服自己的已读位置，**不碰 `userLastReadAt`**：
 * 「用户读客服消息」与「客服读用户消息」是两个方向，客服读完一个会话不该把
 * 用户那边的未读角标清零。
 *
 * 返回 false 表示这个会话不存在（调用方转 404）——不会「顺手建一个会话」：
 * 客服不能凭空给一笔订单造出会话，那是用户发起沟通时才会发生的事。
 */
export async function markStaffConversationRead(staffId: string, orderId: string): Promise<boolean> {
  const updated = await getMessageRepository().markConversationReadForStaff(
    orderId,
    staffId,
    new Date().toISOString(),
  );
  return updated !== null;
}

// ——————————————————————————— 发送 ———————————————————————————

/**
 * 客服发送一条消息。
 *
 * 四条约束在写入前全部由服务端完成：
 *
 * 1. **会话必须存在**（否则 404，与订单不存在同体）；
 * 2. **内容去空白后必须非空且不超长**——超长**明确报错**，不静默截断
 *    （`normalizeMessageBody` 用的是与用户端同一个 `MESSAGE_MAX_LENGTH`）；
 * 3. **发送者身份由服务端写**：`senderId` 来自**守卫返回的客服会话**，
 *    `senderRole` 恒为 `customer_service`，请求体里的 `senderRole` / `senderId`
 *    根本没有被读取的地方。伪造用户、护航或管理员身份无从下手；
 * 4. **不修改订单**：发送一条消息不会改变订单状态、金额或商品。
 *
 * 幂等键作用域是「订单 + 发送者」，因此客服连点发送只会产生一条消息；
 * 同一位客服在另一笔订单上用同一个键也是两条消息，不会互相吞掉。
 *
 * 名称与头像写的是**发送时的快照**：这位客服之后被停用或软删除，
 * 这条消息仍然显示得出他当时的名字与头像，不会变成空白。
 */
export async function sendMessageForStaff(
  staff: StaffSessionUser,
  orderId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ messageId: string; created: boolean }> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const text = normalizeMessageBody(typeof body.body === "string" ? body.body : "");
  if (!text.ok) throw new ApiError("BAD_REQUEST", text.message);

  const repository = getMessageRepository();
  const conversation = await repository.findConversationForStaff(orderId);
  if (!conversation) throw new ApiError("NOT_FOUND", STAFF_CONVERSATION_NOT_FOUND_MESSAGE);

  const now = new Date().toISOString();
  const outcome = await withMockDebug(params, surface, () =>
    repository.createMessage(
      {
        id: `msg_${crypto.randomUUID()}`,
        orderId,
        // 消息归属**会话所属的用户**，不是发消息的客服：
        // 这样用户端按自己的 userId 就能读到客服发来的消息
        userId: conversation.userId,
        // 发送者身份全部由服务端写入，客户端无从指定
        senderId: staff.id,
        senderRole: "customer_service",
        senderName: staff.displayName,
        senderAvatarUrl: staff.avatarUrl,
        body: text.body,
        createdAt: now,
      },
      idempotencyKey,
    ),
  );

  if (!outcome) throw new ApiError("NOT_FOUND", STAFF_CONVERSATION_NOT_FOUND_MESSAGE);
  return { messageId: outcome.message.id, created: outcome.created };
}
