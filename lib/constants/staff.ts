import { ORDER_STATUSES, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { PLATFORM_NAME } from "@/lib/constants/site";
import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import { MESSAGE_MAX_LENGTH } from "@/lib/constants/service";
import type { Order } from "@/lib/types/order";
import type { MessageSenderRole, OrderMessage } from "@/lib/types/message";
import type { OrderStatus } from "@/lib/types/order";
import type {
  StaffConversationListItem,
  StaffConversationMessage,
  StaffOrderSummary,
  StaffRole,
} from "@/lib/types/staff";

/**
 * 客服端（客服工作台）的角色规则、文案与 DTO 映射（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与几个纯函数模块（订单文案、头像白名单、分页、平台名）外
 * 没有运行时依赖，node 能直接加载它做纯逻辑测试，客户端组件引用它也不会把
 * 服务端模块打进浏览器产物。
 *
 * 三条边界写在这里：
 *
 * 1. **只有 `customer_service` 能进客服工作台**。规则只在 `canEnterStaffConsole()`
 *    里判断一次，页面、布局、接口守卫全部调它，不各自写 `role === "customer_service"`。
 * 2. **客服端与用户端、管理端是三个世界**。本文件不引用用户端会话、不引用管理端会话，
 *    也没有任何「把用户 / 管理员换算成客服」的函数。
 * 3. **工作台 DTO 不含隐私字段**。游戏 ID、订单备注、支付凭据都不在这里，
 *    少一个字段就少一条泄漏路径。
 */

// ——————————————————————————— 角色 ———————————————————————————

export const STAFF_ROLES: readonly StaffRole[] = ["customer_service", "companion"];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  customer_service: "客服",
  companion: "护航",
};

/**
 * 能否进入客服工作台。**客服端唯一的角色判断。**
 *
 * 与 `canEnterAdminConsole()` 同一个写法：判断的是「角色等于 customer_service」，
 * 而不是「角色不等于某某」——将来新增角色时新角色默认没有权限，而不是默认获得权限。
 * 停用与已移除在会话层就被挡掉，到这里已经只剩「存在、未移除且启用」的账号。
 *
 * ⚠️ 这个判断与 `canEnterAdminConsole()` **是两个函数、两套取值**：
 * 客服进不了 `/admin`，管理员也进不了 `/staff`。合成一个「有没有后台权限」
 * 会让「客服能不能看订单金额」这类问题变成一次参数传错。
 */
export function canEnterStaffConsole(role: StaffRole): boolean {
  return role === "customer_service";
}

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

export function staffRoleLabel(role: StaffRole): string {
  return STAFF_ROLE_LABELS[role];
}

// ——————————————————————————— 文案 ———————————————————————————

/** 工作台标题。平台名取自 `PLATFORM_NAME`（全站唯一一处），客服端不另起一个平台名。 */
export const STAFF_CONSOLE_NAME = `${PLATFORM_NAME} · 客服工作台`;
export const STAFF_LOGIN_PAGE_TITLE = "客服登录";
export const STAFF_OVERVIEW_PAGE_TITLE = "工作台";
export const STAFF_CONVERSATIONS_PAGE_TITLE = "会话列表";
export const STAFF_LOGOUT_LABEL = "退出登录";
export const STAFF_LOGIN_LABEL = "进入客服工作台";
export const STAFF_REFRESH_LABEL = "刷新";
export const STAFF_SEND_LABEL = "发送";

/**
 * 登录页与工作台顶部的 Mock 标注。
 *
 * 必须一眼看出这是本地模拟：本阶段没有真实客服账号与密码，也没有接任何真实的
 * 身份系统——页面上写的是「选择一个测试账号进入」，不是「请输入账号密码」。
 */
export const STAFF_MOCK_NOTICE =
  "客服工作台为本地 Mock 认证：没有真实密码与验证码，登录入口是一份预先配置的测试账号，" +
  "数据来自本地 Mock Store，重启开发服务器后回到预置数据。";

/** 未启用 `ENABLE_MOCK_STAFF` 时登录页显示的说明（此时不渲染任何账号选择控件）。 */
export const STAFF_MOCK_DISABLED_MESSAGE =
  "模拟客服登录未启用（ENABLE_MOCK_STAFF 未开启）。客服工作台需要正式的客服账号体系，本阶段尚未实现。";

/** 登录接口未启用时返回的提示，与页面文案同源。 */
export const STAFF_MOCK_LOGIN_DISABLED_MESSAGE = "模拟客服登录未启用";

/** 角色不是客服（或账号被停用 / 已移除）时的提示。与接口 403 的 message 同源。 */
export const STAFF_FORBIDDEN_MESSAGE = "当前账号没有客服工作台权限";

/** 未登录（或会话失效）时的提示。与接口 401 的 message 同源。 */
export const STAFF_UNAUTHORIZED_MESSAGE = "请先登录客服工作台";

/**
 * 不存在的**会话**，以及「订单存在但没有会话」的提示。
 *
 * ⚠️ 与「订单不存在」是**同一句话**：客服只能访问有会话的订单，
 * 想用订单号试探「这一单存不存在」时，三种情形应当完全无法区分。
 */
export const STAFF_CONVERSATION_NOT_FOUND_MESSAGE = "会话不存在";

/**
 * 工作台首页的口径说明。
 *
 * 三个数字都从仓储实时聚合，不是写死的展示值——这句话必须跟着事实改。
 */
export const STAFF_OVERVIEW_NOTICE =
  "三个数字从本地 Mock 仓储实时聚合，不是写死的展示值；会话总数与未读数按当前登录客服的口径统计，" +
  "今日消息数按北京时间（UTC+8）自然日统计。";

export const STAFF_CONVERSATION_LIST_NOTICE =
  "列表只展示已经产生沟通记录的订单，按最后一条消息时间倒序排列；" +
  "订单号、用户昵称与商品名都可以搜索。";

export const STAFF_CONVERSATION_LIST_FIELDS_NOTE =
  "列表刻意不含游戏 ID、订单备注与完整消息历史：这些要么属于用户隐私，要么只有详情页需要。";

export const STAFF_CONVERSATION_EMPTY_TITLE = "当前筛选下没有会话";
export const STAFF_CONVERSATION_EMPTY_DESCRIPTION = "换一个订单号 / 用户昵称 / 商品名，或者清掉筛选条件。";

export const STAFF_CONVERSATION_DETAIL_TITLE = "订单沟通";
export const STAFF_ORDER_SUMMARY_TITLE = "订单摘要（只读）";

/**
 * 详情页对「这不是实时聊天」的说明。
 *
 * ⚠️ 必须写在页面上：本阶段没有 WebSocket，对方的新消息不会自己出现，
 * 不说明的话「发了没反应」会被当成故障。
 */
export const STAFF_NOT_REALTIME_NOTICE =
  "本页使用刷新取数，不是实时消息（没有 WebSocket）：对方的新消息需要点「刷新」才会出现。";

/** 客服不能改订单的说明。写在工作台上，也写在接口的注释里。 */
export const STAFF_ORDER_READONLY_NOTICE =
  "客服只能查看订单摘要与沟通，不能修改订单状态、金额、商品，也不能处理退款与投诉（后续阶段）。";

// ——————————————————————————— 消息 ———————————————————————————

/**
 * 工作台里的发送者称呼。
 *
 * ⚠️ 与用户端的 `MESSAGE_ROLE_LABELS` **是两个表**：同一条消息在用户端是
 * 「客服」，在工作台里是「我 / 用户 / 护航」。两边各写一份是有意的——
 * 工作台把用户发的消息叫「我」会让人误以为是自己发的。
 */
export const STAFF_MESSAGE_ROLE_LABELS: Record<MessageSenderRole, string> = {
  user: "用户",
  companion: "护航",
  customer_service: "客服",
};

export function staffMessageSenderLabel(role: MessageSenderRole, isSelf: boolean): string {
  return isSelf ? "我" : STAFF_MESSAGE_ROLE_LABELS[role];
}

/**
 * 一位客服在一个会话里还有多少条没读。
 *
 * 口径与用户侧**同构但方向相反**（用户侧是 `senderRole !== "user"`）：
 * 客服自己发的不算自己的未读，**用户与护航发来的**都算——打手说的话同样是
 * 需要客服跟进的内容，把它排除掉会让「护航说了一句就没人管」。
 *
 * ⚠️ `staffLastReadAt` 必须是**这位客服自己**的已读位置。传错成用户侧的
 * `userLastReadAt` 会让「客服的待办」变成「用户的未读」，两个数都不对了。
 *
 * 只要求两个字段（`senderRole` / `createdAt`）而不是整条 `OrderMessage`：
 * 服务端的列表用仓储实体算，工作台详情页手上只有 `StaffConversationMessage` DTO
 * ——DTO 里**没有** `senderId`。两处口径必须一致，因此这里算得宽一点，
 * 而不是让详情页另写一遍「未读怎么算」。
 */
export function staffUnreadCount(
  messages: readonly Pick<OrderMessage, "senderRole" | "createdAt">[],
  staffLastReadAt: string | null,
): number {
  return messages.filter(
    (message) =>
      message.senderRole !== "customer_service" &&
      (staffLastReadAt === null || message.createdAt > staffLastReadAt),
  ).length;
}

/**
 * 工作台发送框下方的说明。
 *
 * 长度上限直接引用 `MESSAGE_MAX_LENGTH`：客服端与用户端必须是同一个数，
 * 两边各写一遍迟早会出现「用户端能发、客服端发不出去」。
 */
export const STAFF_MESSAGE_SEND_HINT =
  `单条消息最多 ${MESSAGE_MAX_LENGTH} 个字；发送后对方需要刷新才能看到（本阶段没有实时推送）。`;

// ——————————————————————————— 工作台列表查询 ———————————————————————————

export const STAFF_PAGE_SIZE = 20;
export const STAFF_MAX_PAGE_SIZE = 100;
export const STAFF_MAX_PAGE = 1000;

export const STAFF_ORDER_STATUS_INVALID_MESSAGE = "筛选条件 status 不是有效的订单状态";
export const STAFF_UNREAD_INVALID_MESSAGE = "筛选条件 unread 只能是 1";

/** 订单状态筛选：`all` + 五种订单状态。文案与用户端订单列表同源，不另起一套叫法。 */
export type StaffOrderStatusFilter = OrderStatus | "all";

export const STAFF_ORDER_STATUS_FILTERS: readonly StaffOrderStatusFilter[] = [
  "all",
  ...ORDER_STATUSES,
];

export const STAFF_ORDER_STATUS_FILTER_LABELS: Record<StaffOrderStatusFilter, string> = {
  all: "全部状态",
  ...ORDER_STATUS_LABELS,
};

export function isStaffOrderStatusFilter(value: string): value is StaffOrderStatusFilter {
  return (STAFF_ORDER_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 解析订单状态筛选；非法值返回 null（接口转 400，页面回退默认值）。 */
export function readStaffOrderStatusFilter(raw: string | null): StaffOrderStatusFilter | null {
  if (raw === null || raw === undefined) return "all";
  const value = raw.trim();
  if (value === "") return "all";
  return isStaffOrderStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeStaffOrderStatusFilter(raw: string | null): StaffOrderStatusFilter {
  return readStaffOrderStatusFilter(raw) ?? "all";
}

/** 解析「只看未读」；只有 `1` 表示开启，其余（含缺失）都是关闭。 */
export function readStaffUnreadFilter(raw: string | null): boolean {
  return (raw ?? "").trim() === "1";
}

/**
 * 会话列表的查询条件。
 *
 * 关键字**只去空白，不截断、不设上限**：搜索框不该在用户打字时把内容吞掉，
 * 匹配不上就是匹配不上（与订单搜索同一条规则）。
 */
export type StaffConversationListQuery = {
  keyword: string;
  unreadOnly: boolean;
  status: StaffOrderStatusFilter;
  page: number;
  pageSize: number;
};

export function buildStaffConversationListQuery(input: {
  params: URLSearchParams;
  status: StaffOrderStatusFilter;
}): StaffConversationListQuery {
  const keyword = input.params.get("keyword");

  return {
    keyword: typeof keyword === "string" ? keyword.trim() : "",
    unreadOnly: readStaffUnreadFilter(input.params.get("unread")),
    status: input.status,
    page: clampPage(input.params.get("page"), STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), STAFF_PAGE_SIZE, STAFF_MAX_PAGE_SIZE),
  };
}

/**
 * 会话排序：最后一条消息时间倒序；没有消息的排最后。
 *
 * 时间相同时用订单号倒序兜底——**排序必须稳定**，否则翻页时同一条会话
 * 可能在第 1 页和第 2 页各出现一次。
 */
export function compareStaffConversations(
  a: Pick<StaffConversationListItem, "lastMessageAt" | "orderNo">,
  b: Pick<StaffConversationListItem, "lastMessageAt" | "orderNo">,
): number {
  const aAt = a.lastMessageAt ?? "";
  const bAt = b.lastMessageAt ?? "";
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  if (a.orderNo !== b.orderNo) return a.orderNo < b.orderNo ? 1 : -1;
  return 0;
}

/** 关键字是否命中订单号 / 用户昵称 / 商品名（大小写不敏感）。 */
export function staffConversationMatchesKeyword(input: {
  keyword: string;
  orderNo: string;
  userNickname: string;
  productTitle: string;
}): boolean {
  const keyword = input.keyword.trim().toLowerCase();
  if (!keyword) return true;
  return (
    input.orderNo.toLowerCase().includes(keyword) ||
    input.userNickname.toLowerCase().includes(keyword) ||
    input.productTitle.toLowerCase().includes(keyword)
  );
}

/**
 * 会话统计 + 订单 + 用户 → 工作台列表项 DTO。
 *
 * **显式挑字段**：游戏 ID、订单备注、订单里的用户 id 都不出现在这里。
 * 未读数用的是**当前客服**的已读位置（由调用方算好传进来），
 * 不是用户侧那个未读数。
 */
export function toStaffConversationListItem(input: {
  order: Order;
  userNickname: string;
  messageCount: number;
  lastMessageBody: string | null;
  lastMessageAt: string | null;
  lastMessageRole: MessageSenderRole | null;
  staffUnreadCount: number;
}): StaffConversationListItem {
  const { order } = input;
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    userNickname: input.userNickname,
    productTitle: order.productTitle,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    lastMessageBody: input.lastMessageBody,
    lastMessageRole: input.lastMessageRole,
    lastMessageRoleLabel:
      input.lastMessageRole === null ? null : STAFF_MESSAGE_ROLE_LABELS[input.lastMessageRole],
    lastMessageAt: input.lastMessageAt,
    messageCount: input.messageCount,
    unreadCount: input.staffUnreadCount,
  };
}

// ——————————————————————————— 工作台详情 ———————————————————————————

/**
 * 订单 → 只读摘要。
 *
 * ⚠️ 字段表就是边界：**没有** `gameAccountId`（游戏 ID）、`remark`（备注）、
 * `userId`，也没有任何支付凭据。客服当前阶段不需要它们，
 * 而少一个字段就少一条泄漏路径。
 */
export function toStaffOrderSummary(order: Order, userNickname: string): StaffOrderSummary {
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    productTitle: order.productTitle,
    specName: order.specName,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    userNickname,
    // 护航摘要：未绑定陪玩时是一句明确的「等待接单」，不是空白
    companionSummary: order.companion ? order.companion.name : "等待接单",
  };
}

/**
 * 消息 → 工作台消息 DTO。
 *
 * ⚠️ 名称与头像是**消息自己的快照**，不是在渲染时去查客服账号：
 * 客服被停用或软删除之后，历史消息仍然显示得出当时的名字与头像，不会变成空白。
 * 这也是 `OrderMessage` 上那两个 `sender*` 字段存在的唯一理由。
 */
export function toStaffConversationMessage(
  message: OrderMessage,
  currentStaffId: string,
): StaffConversationMessage {
  const isSelf = message.senderId === currentStaffId;
  return {
    id: message.id,
    senderRole: message.senderRole,
    senderRoleLabel: staffMessageSenderLabel(message.senderRole, isSelf),
    senderName: message.senderName,
    senderAvatarUrl: message.senderAvatarUrl,
    body: message.body,
    createdAt: message.createdAt,
    isSelf,
  };
}
