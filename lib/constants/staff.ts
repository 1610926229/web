import { COMPANION_RELEASE_SOURCE_LABELS, DISPATCH_STATE_LABELS } from "@/lib/constants/dispatch";
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { PLATFORM_NAME } from "@/lib/constants/site";
import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import { MESSAGE_MAX_LENGTH } from "@/lib/constants/service";
import type { CompanionReleaseRecord } from "@/lib/types/companionRelease";
import type { Companion } from "@/lib/types/companion";
import type { Order } from "@/lib/types/order";
import type { DispatchRecord } from "@/lib/types/dispatch";
import type { MessageSenderRole, OrderMessage } from "@/lib/types/message";
import type { OrderStatus } from "@/lib/types/order";
import type {
  StaffCompanionReleaseEntry,
  StaffConversationListItem,
  StaffConversationMessage,
  StaffOrderAllowedActions,
  StaffOrderDispatchSummary,
  StaffOrderListItem,
  StaffOrderReplaceCandidate,
  StaffOrderSummary,
  StaffOrderUserSummary,
  StaffRole,
} from "@/lib/types/staff";
import { readOrderFilterDate } from "./orderFilters";

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
/**
 * 退款 / 投诉两个入口的标题。
 *
 * 文案与用户端的「申请退款」「我的投诉」**刻意不同**：用户端说的是「我做了这件事」，
 * 工作台说的是「这件事归我处理」。与用户端共用一份文案会让客服列表页的标题
 * 变成一句像是自己提交了申请的话。
 */
export const STAFF_REFUNDS_PAGE_TITLE = "退款处理";
export const STAFF_COMPLAINTS_PAGE_TITLE = "投诉处理";
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
 * ⚠️ 在**会话**这条路上，它与「订单不存在」是**同一句话**：
 * 用订单号试探「这一单有没有会话」时，三种情形应当完全无法区分。
 *
 * ⚠️ **P0-10 之后不要再把这句话读成「客服不知道订单存不存在」**——
 * 那是本轮之前的口径。客服现在有全量订单查询（`/staff/orders/[id]`），
 * 订单存不存在是**它本来就该知道的事**（用户报一个订单号来问，客服就必须查得到）。
 * 上面那条不可区分只约束**会话**资源：它挡的是「从会话接口反推订单」，
 * 不是「订单不可见」。订单侧的 404 用的是 `STAFF_ORDER_NOT_FOUND_MESSAGE`。
 */
export const STAFF_CONVERSATION_NOT_FOUND_MESSAGE = "会话不存在";

/**
 * 工作台首页的口径说明。
 *
 * 五个数字都从仓储实时聚合，不是写死的展示值——这句话必须跟着事实改。
 *
 * ⚠️ 待处理的两个数**按平台口径而不是按当前客服**：退款与投诉没有「分配给谁」
 * 这个概念（本阶段不做工单派发），因此它们对每位客服是同一个数。
 * 会话的未读数则相反，是**当前客服自己**的。两种口径必须在这一句里说清楚，
 * 否则「为什么同事看到的未读和我不同、退款数却一样」会变成一个说不清的问题。
 */
export const STAFF_OVERVIEW_NOTICE =
  "五个数字从本地 Mock 仓储实时聚合，不是写死的展示值；会话总数与未读数按当前登录客服的口径统计，" +
  "今日消息数按北京时间（UTC+8）自然日统计；待处理退款与待处理投诉按平台口径统计" +
  "（本阶段不做工单派发，因此它们对每位客服相同）。";

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

/**
 * 客服不能改订单的说明。写在工作台上，也写在接口的注释里。
 *
 * ⚠️ P8D-1 时这句的结尾是「也不能处理退款与投诉（后续阶段）」——P8D-2 把那个「后续阶段」
 * 落地了，因此这句话必须跟着改：**留着旧文案会比没有文案更糟**，
 * 它会让客服以为退款投诉仍然不归自己管，于是不去点那两个入口。
 *
 * ⚠️ 新的结尾刻意**不展开列举**「能做什么」：那份清单在退款 / 投诉页面上
 * 由服务端算出的 `allowedActions` 给出，逐个动作都对应一个真实按钮。
 * 在这里再抄一份，迟到的一步就是「文案说能、按钮不给」。
 */
export const STAFF_ORDER_READONLY_NOTICE =
  "客服只能查看订单摘要与沟通，不能修改订单状态、金额、商品；" +
  "退款与投诉在各自的页面里处理，可执行的动作以那里的按钮为准。";

/**
 * 履约退出历史区块的文案（P0-6）。
 *
 * ⚠️ 这些常量放在本文件的原因与其它客服端文案一致：**渲染方不拥有常量层**，
 * 客服工作台、投诉详情、退款详情三处看到的是**同一份字符串**。
 * 每处各写一遍「履约退出历史」这种标题，迟早有一处写成别的叫法，
 * 而同一件事有两种叫法时，读的人只会以为它们是两件事。
 *
 * ⚠️ 这里**刻意没有「无退出记录」的空态文案**：客服端空数组时整段不渲染
 * （`components/staff/StaffReleaseHistory.tsx` 的 `entries.length === 0` 分支）。
 * 客服这三页是**作业面**，而绝大多数订单本来就不该有退出记录——占位句会出现在
 * 每一张正常订单上，久了就被读成装饰，等人真的退出过时同样被跳过；
 * 「出现本身就是信号」才是这里要的。
 * ⚠️ 管理端订单详情**正好相反**（空数组显示「无退出记录」），那是**刻意的不对称**：
 * 审计视角要的是「查过了，没有」这个明确结论，一片空白区分不了「没有」与「没查」。
 */
export const STAFF_RELEASE_HISTORY_TITLE = "履约退出历史（只读）";
export const STAFF_RELEASE_HISTORY_COMPANION_LABEL = "原打手";
export const STAFF_RELEASE_HISTORY_SOURCE_LABEL = "退出方式";
export const STAFF_RELEASE_HISTORY_TIME_LABEL = "退出时间";
export const STAFF_RELEASE_HISTORY_REASON_LABEL = "退出原因";
export const STAFF_RELEASE_HISTORY_READONLY_NOTE = "仅用于核对履约经过，客服不能修改退出记录。";

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
 *
 * ⚠️ `releaseHistory` 与 `userNickname` 一样由调用方查好传进来，本层不做仓储读取：
 * 它是浏览器端组件也会引用的常量模块，碰 `lib/data` 会把 Mock 存储打进前端产物。
 * 条目本身由 `toStaffCompanionReleaseEntry()` 转换——那是唯一的转换口径。
 */
export function toStaffOrderSummary(
  order: Order,
  userNickname: string,
  releaseHistory: StaffCompanionReleaseEntry[],
): StaffOrderSummary {
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
    releaseHistory,
  };
}

/**
 * 一条退出历史 → 客服视野里的条目（P0-6）。**三个客服 DTO 共用的唯一转换点**
 * （会话详情、投诉详情的订单摘要、退款详情），因此「退出方式怎么显示」
 * 「原因取哪个字段」只有这一处口径。
 *
 * ## 为什么名字要靠调用方解析，而不是存进记录
 *
 * `CompanionReleaseRecord` 上**只有 `companionId`**，没有名字快照，这是刻意的：
 *
 * 1. **记录只写已经发生的事实**。它是 `database-schema.md` T4 定义的 7 字段结构
 *    （P0-6 冻结，不加字段）。往里塞一个「名字快照」等于让它承担展示职责，
 *    而展示职责会随时间变——名字快照与护航资料一改就分叉，那时两份数据
 *    谁对谁错没有规则可依。
 * 2. **名字是可推导的**：`getCompanionRepository().findCompanionById()` 按 id 查得到
 *    （它连**已移除**的记录都查得到，因此事后被下架的护航仍然显示得出名字）。
 *    可推导的东西存第二份，就是两个真值源。
 * 3. 本文件**不能自己去查**：它是浏览器端组件也会引用的常量模块，碰 `lib/data`
 *    会把 Mock 存储打进前端产物。因此解名字是服务层的事，这里只做拼装。
 *
 * ⚠️ **回落到 `companionId`、绝不留空串**：查不到护航资料（资料被彻底删除）
 * 时，页面上仍要看得出「退出的是哪一位」。空名字会让那一行看起来像界面坏了，
 * 而 id 至少是可核对的。调用方查不到时传空串即可，这条规则只在这里执行一次。
 */
export function toStaffCompanionReleaseEntry(
  record: CompanionReleaseRecord,
  companionName: string,
): StaffCompanionReleaseEntry {
  return {
    companionId: record.companionId,
    companionName: companionName || record.companionId,
    source: record.source,
    // 标签表复用派单域那一份（`COMPANION_RELEASE_SOURCE_LABELS`），不另写一套叫法
    sourceLabel: COMPANION_RELEASE_SOURCE_LABELS[record.source],
    reason: record.reason,
    createdAt: record.createdAt,
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

// ——————————————————————————— 全量订单查询（P0-10） ———————————————————————————

/**
 * 客服工作台「订单」页的筛选规则、文案与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本段除类型与几个纯函数模块（`./orderFilters`、`./dispatch`、`./orders`、`./pagination`）
 * 外没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。仓储读取一律在
 * `lib/services/staffOrders.ts` 里完成，本层只做「怎么筛、怎么显示」。
 *
 * ⚠️ **与身份无关的那几条规则不在这里**：日期格式、北京时间的自然日、游戏筛选项的来源、
 * 关键词匹配的四个字段、创建时间倒序——它们住在 `./orderFilters`，
 * 由管理端与客服端**共用同一份实现**。这里只做三件带客服身份的事：
 *
 * 1. **字段表**：`StaffOrderListItem` / `StaffOrderDispatchSummary` 显式挑字段，
 *    平台分账字段与游戏账号、备注不进客服响应（详见 `lib/types/staff.ts` 的注释）；
 * 2. **文案**：每个界面拥有自己的错误文案与说明句，不跨界面共享（与
 *    `STAFF_ORDER_STATUS_INVALID_MESSAGE` 同例）；
 * 3. **状态筛选**：复用既有的 `StaffOrderStatusFilter`（`all` + 五种订单状态）。
 *
 * ⚠️ 页面的只读说明**复用 `STAFF_ORDER_READONLY_NOTICE`，不另写一句**：
 * 那句说的正是「客服不能改订单状态 / 金额 / 商品，动作在各自的页面里」，
 * 订单页与订单摘要面板说的是同一件事。同一件事写两句，迟早有一处被改而另一处没有，
 * 那时两页对同一条边界给出两种说法。
 */

export const STAFF_ORDERS_PAGE_TITLE = "订单";
export const STAFF_ORDER_DETAIL_TITLE = "订单详情";

/**
 * 列表顶部的说明：讲清楚这张列表的口径，以及它与「会话列表」的区别。
 *
 * ⚠️ 必须点明「**全平台订单**，不只是有沟通记录的」：客服手上同时有会话列表与订单列表
 * 两个入口，不说明的话会以为订单页漏了那些「没聊过」的单。
 *
 * ⚠️ 也要点明时间筛选按**创建时间**算：排序字段与筛选字段必须是同一个，
 * 否则「筛 9 月、排出来按 8 月的时间交错」会很难解释。
 */
export const STAFF_ORDER_LIST_NOTICE =
  "这里可以查询全平台的订单（不只是有沟通记录的订单），按创建时间倒序；" +
  "日期按北京时间（UTC+8）的自然日筛选，算的是下单（支付成功）时间。" +
  "支付失败与取消只留下支付请求记录，它们不是订单，因此不出现在这里。";

/**
 * 列表底部的字段边界说明。
 *
 * ⚠️ 必须写在列表上，而不是只在代码里裁字段：看到列表的人会去找「这一单的账号和备注」，
 * 得让他知道**客服端两处都没有**，而不是以为数据没采到。
 *
 * ⚠️ 与 `ADMIN_ORDER_LIST_FIELDS_NOTE` 的措辞**刻意不同**：管理端那句说
 * 「这些内容只在详情页可见」，因为管理端详情确实带游戏账号与备注；
 * 客服端**详情也不带**，照抄那句会写出一句假话。这是一处**刻意的不对称**。
 */
export const STAFF_ORDER_LIST_FIELDS_NOTE =
  "列表不展示游戏账号、用户备注、增值服务明细与售后摘要：增值明细与售后摘要只在详情页可见，" +
  "游戏账号与用户备注客服端两处都不展示；列表与详情都不展示分账比例与平台收入。";

/**
 * 列表为空时的提示。与 `STAFF_CONVERSATION_EMPTY_TITLE` 同例：
 * 空态说的是「**当前筛选下**没有」，而不是「平台没有订单」——
 * 后者会让人以为数据坏了，前者会让人去改筛选条件。
 */
export const STAFF_ORDER_EMPTY_TITLE = "当前筛选下没有订单";

/** 目标订单不存在时的提示。与接口 404 的 message 同源。 */
export const STAFF_ORDER_NOT_FOUND_MESSAGE = "订单不存在";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const STAFF_ORDER_GAME_INVALID_MESSAGE = "筛选条件 game 不是订单里出现过的游戏";
export const STAFF_ORDER_DATE_INVALID_MESSAGE = "筛选条件 from / to 必须是 YYYY-MM-DD 格式的日期";
export const STAFF_ORDER_DATE_RANGE_INVALID_MESSAGE = "开始日期不能晚于结束日期";

// ——————————————————————————— 订单列表查询 ———————————————————————————

/**
 * 客服端订单列表查询条件（已解析、已校验）。
 *
 * ⚠️ **排序不是参数**：默认（也是唯一）的排序是按创建时间倒序，
 * 用的就是共享的 `compareOrdersByCreatedAt`（与时间筛选同一个字段）。
 */
export type StaffOrderListQuery = {
  /** `all` 表示不限状态 */
  status: StaffOrderStatusFilter;
  /**
   * 已去首尾空格；空串表示不搜索。
   *
   * 匹配**订单号 / 商品名 / 用户昵称 / 平台展示 ID / 内部用户标识**（共享的
   * `orderMatchesKeyword`），这些正是客服手里能拿到的东西。备注与游戏账号不参与搜索
   * ——那是内容不是标识，用它们搜出来的结果没人能预期。
   *
   * ⚠️ 平台标识有**两串**（P0-10 整改）：`displayId` 是用户资料页上那串，
   * 内部标识是客服会话页一直给的那串。列表上两个都显示，因此两个都得能搜。
   */
  keyword: string;
  /** 游戏名；空串表示全部游戏 */
  game: string;
  /** 起始日期 `YYYY-MM-DD`（含当天，北京时间）；空串表示不限 */
  from: string;
  /** 结束日期 `YYYY-MM-DD`（含当天，北京时间）；空串表示不限 */
  to: string;
  page: number;
  pageSize: number;
};

/**
 * 组装查询条件。与 `buildAdminOrderListQuery` 同一写法，分页上限用 **Staff 自己的**
 * `STAFF_MAX_PAGE` / `STAFF_MAX_PAGE_SIZE`：工作台是手机 / 平板宽度，与管理端 PC 宽屏
 * 一次能看的条数不是一个问题。
 *
 * ⚠️ 日期在这里**再解析一次**（严格模式已经在服务层校验过、非法即 400），
 * 解析不了回落到空串表示不限——与 `buildAdminOrderListQuery` 完全一致。
 */
export function buildStaffOrderListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: StaffOrderStatusFilter;
  /** 已经解析好的游戏筛选；空串表示全部游戏 */
  game: string;
}): StaffOrderListQuery {
  const keyword = input.params.get("keyword");

  return {
    status: input.status,
    keyword: typeof keyword === "string" ? keyword.trim() : "",
    game: input.game,
    from: readOrderFilterDate(input.params.get("from")) ?? "",
    to: readOrderFilterDate(input.params.get("to")) ?? "",
    page: clampPage(input.params.get("page"), STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), STAFF_PAGE_SIZE, STAFF_MAX_PAGE_SIZE),
  };
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 订单 + 用户摘要 → 客服端列表项。**显式挑字段**，不是 `{ ...order }` 再删几个。
 *
 * ⚠️ 平台分账字段（`companionRateSnapshot` / `companionBaseIncome` / `clubNetIncome`）、
 * 游戏账号、备注与用户主键因此默认不会外流——只有写在这里的字段才会被浏览器看到。
 * 给 `Order` 新增字段也不会自动出现在响应里，那正是「该不该给客服看」被重新判断一次的地方。
 *
 * 用户摘要由服务层查好传进来（订单里只有 `userId`）：昵称与两串平台标识都是搜索命中的
 * 字段，列表上也要显示得出来，否则「搜到了但看不出来为什么搜到」。
 */
export function toStaffOrderListItem(
  order: Order,
  user: StaffOrderUserSummary,
): StaffOrderListItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    gameName: order.gameName,
    productTitle: order.productTitle,
    specName: order.specName,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    user,
  };
}

/**
 * 派单记录 → 派单进度摘要。
 *
 * ⚠️ 只取「在哪等、等到什么时候、结果是什么」这七项：两个 `*CompanionId` 与平台参数快照
 * （`publicTimeoutMinutesSnapshot`）都不给，理由见 `StaffOrderDispatchSummary` 的注释。
 * `stateLabel` 用**派单域那一份** `DISPATCH_STATE_LABELS`，客服端不另起一套叫法——
 * 同一件事两种叫法时，读的人只会以为它们是两件事。
 */
export function toStaffOrderDispatchSummary(record: DispatchRecord): StaffOrderDispatchSummary {
  return {
    state: record.state,
    stateLabel: DISPATCH_STATE_LABELS[record.state],
    exclusiveEnteredAt: record.exclusiveEnteredAt,
    exclusiveDeadlineAt: record.exclusiveDeadlineAt,
    publicPoolEnteredAt: record.publicPoolEnteredAt,
    publicDeadlineAt: record.publicDeadlineAt,
    acceptedAt: record.acceptedAt,
    timedOutAt: record.timedOutAt,
  };
}

/* ─────────────────── 订单处置：换人 / 退回公共池（P0-11） ─────────────────── */

/**
 * 这一单此刻客服能做什么。**服务端与页面用的是同一个函数**（唯一出处）。
 *
 * ⚠️ 判据与事务层的领域 Guard **必须一致**（`releaseOrderByStaff` /
 * `replaceOrderCompanionByStaff` 的第 2、3 步）：
 *
 * 1. 状态恰好是 `accepted` 或 `serving`——订单上没有「有人正在履约」这个状态之外的
 *    可换对象（`paid` 是等人接、`completed` / `refunded` 是终态）；
 * 2. `actualCompanionId` 非空——「谁在履约」是**事实**字段，不是状态的函数。
 *    历史脏数据里状态说有人在履约、字段却是空的时候，两个入口都必须拒绝。
 *
 * 三处（两个事务入口 + 这个展示函数）今天给出的答案完全相同，这是刻意的：
 * 页面显示的按钮与接口接受的请求一旦分叉，客服就会遇到一个「看得见、点不动」的按钮，
 * 而那种失败没有任何文案能解释清楚。
 *
 * ⚠️ 它**不看**派单记录是否还在：那是**数据自洽**问题（真出现时接口报 500），
 * 不是「客服能不能做这件事」。把数据损坏说成一个按钮的可见性，只会让客服
 * 反复重试同一个必然失败的请求。
 */
export function staffOrderAllowedActions(order: Order): StaffOrderAllowedActions {
  const inService = order.status === "accepted" || order.status === "serving";
  const releasable = inService && order.actualCompanionId !== null;
  return { canRelease: releasable, canReplace: releasable };
}

/** 退回公共池的原因必填。**只有「必填」，没有长度要求**（与打手取消同一条裁决）。 */
export const STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE = "请填写退回公共池的原因";

/** 是这一单，但此刻没有人在履约（400）。与 404 分开：订单确实存在，只是这个按钮不该出现。 */
export const STAFF_ORDER_NOT_RELEASABLE_MESSAGE = "当前订单状态不允许退回公共池";
export const STAFF_ORDER_NOT_REPLACEABLE_MESSAGE = "当前订单状态不允许更换护航";

/** 换人没选人 / 选了一个不存在的人（400）。两种都是「这次请求本身不完整」。 */
export const STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE = "请选择要指定的护航";
export const STAFF_ORDER_COMPANION_NOT_FOUND_MESSAGE = "指定的护航不存在";

/**
 * 指定的护航此刻不能接单（400，`enabled` / 未移除 / 当前可接单 三者任一不满足）。
 *
 * ⚠️ 三种原因**共用一句**：对客服要做的动作是同一件（换一个人），
 * 而分开说明等于把一位护航的账号状态细节告诉客服——那是管理端的事。
 */
export const STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE = "指定的护航当前不能接单";

/** 指定的就是下单用户本人（400）。与用户端接单的禁止自接单是同一条规则。 */
export const STAFF_ORDER_SELF_ORDER_MESSAGE = "不能把订单指定给下单用户本人";

/** 指定的就是此刻正在履约的那位（400）。没有「换」这件事可做。 */
export const STAFF_ORDER_SAME_COMPANION_MESSAGE = "该护航正在履约这一单，无需更换";

/** 换人候选为空时的提示。空态说「没有谁可以换」，而不是「加载失败」。 */
export const STAFF_ORDER_REPLACE_EMPTY_TITLE = "当前没有可指定的护航";
export const STAFF_ORDER_REPLACE_EMPTY_DESCRIPTION =
  "所有护航都处于停用、已移除或暂停接单状态，或只剩正在履约这一单的那位。";

/**
 * 候选列表顶部的一句口径说明。
 *
 * ⚠️ 必须点明「名单已经筛过」：客服看到的是一个短名单，不说明的话会以为平台只有这么多护航；
 * 也点明**下单用户本人不在名单里**，否则他会去找一个平台刻意藏起来的人。
 */
export const STAFF_ORDER_REPLACE_CANDIDATES_NOTICE =
  "以下护航此刻都可以接单（已排除停用、已移除、暂停接单、下单用户本人，以及正在履约这一单的那位），可以直接指定，无需管理员审批。";

/** 候选列表非空时也要有一句话，说明那一列数字是什么。 */
export const STAFF_ORDER_REPLACE_CANDIDATES_COUNT_LABEL = "在履约订单数";

// ——— 处置面板的按钮与反馈 ———

export const STAFF_ORDER_ACTIONS_TITLE = "订单处置";

/**
 * 面板顶部的一句说明。
 *
 * ⚠️ 必须点明**两个动作都会通知下单用户**，因为这对客服是操作前的知情：
 * 「退回公共池」会让用户看到订单重新等人接，「更换护航」会让用户看到换了人。
 * 不写的话，客服会在用户来问的时候才发现自己刚刚做了什么。
 *
 * ⚠️ 也点明**两个动作都不退款**：客服最容易预设「换人 = 补偿」，
 * 而本轮换人不涉及任何金额（退款是另一个动作）。
 */
export const STAFF_ORDER_ACTIONS_NOTICE =
  "更换护航与退回公共池都会通知下单用户。两个动作都不改变订单金额，也不产生退款；" +
  "已完成的订单与还没有人接单的订单不提供这两个动作。";

/** 订单上没有可执行动作时替代面板的那一句（`canRelease === false`）。 */
export const STAFF_ORDER_ACTIONS_UNAVAILABLE_NOTICE =
  "当前订单没有可执行的处置：只有「已接单」与「护航中」的订单可以更换护航或退回公共池。";

export const STAFF_ORDER_RELEASE_LABEL = "重新进入公共池";
export const STAFF_ORDER_RELEASE_CONFIRM_LABEL = "确认退回公共池";
export const STAFF_ORDER_RELEASE_REASON_LABEL = "退回原因";
/** 与打手取消同一条取舍：**不写任何字数提示**（需求未冻结字数）。 */
export const STAFF_ORDER_RELEASE_REASON_PLACEHOLDER = "请说明为什么需要更换护航";

/**
 * 展开确认区时的那段说明。
 *
 * ⚠️ 必须说清**这一单不会取消**、**金额不变**、**原护航立即失去这一单**。
 * 少一条，客服就得在按下按钮之后去别处确认自己做了什么。
 */
export const STAFF_ORDER_RELEASE_CONFIRM_NOTICE =
  "退回后原护航立即不再负责这一单，订单重新进入公共订单池，等待其他护航接取。订单不会被取消，金额也不变；下单用户会收到一条通知。";

export const STAFF_ORDER_RELEASE_SUCCESS_LABEL =
  "已退回公共订单池。原护航已不再负责这一单，下单用户已收到通知。";

export const STAFF_ORDER_REPLACE_LABEL = "更换护航";
export const STAFF_ORDER_REPLACE_CONFIRM_LABEL = "确认更换护航";
export const STAFF_ORDER_REPLACE_SELECT_LABEL = "指定新护航";

/**
 * 换人确认区的那段说明。
 *
 * ⚠️ 必须点明**新护航拿到的只是「已接单」**：他仍要自己点「开始服务」、
 * 自己交完成材料。不写的话，客服会以为换完就有人在做这一单了。
 *
 * ⚠️ 也要点明**原护航那份未审完的完成材料会作废**：那是这次操作的一个真实后果，
 * 而且它会直接影响「这一单怎么又回到护航中了」这个客服一定会被问到的问题。
 */
export const STAFF_ORDER_REPLACE_CONFIRM_NOTICE =
  "更换后原护航立即不再负责这一单，订单转由新护航履约（状态仍是「已接单」，由他自己开始服务）。" +
  "原护航已提交但还没审完的完成材料会立即作废，不会再被自动通过。订单金额不变，下单用户会收到一条通知。";

export const STAFF_ORDER_REPLACE_SUCCESS_LABEL =
  "已更换护航。新护航已接手这一单，下单用户已收到通知。";

/**
 * 护航记录 → 换人候选项。
 *
 * ⚠️ 只取昵称与头像（外加由服务层算好的在履约单数）：联系方式、分账、内部主键
 * 都不在这里。这与 `StaffUserSummary` 是同一条数据最小化口径，
 * 只不过对象从「下单用户」换成了「护航」。
 */
export function toStaffOrderReplaceCandidate(
  companion: Companion,
  activeOrderCount: number,
): StaffOrderReplaceCandidate {
  return {
    companionId: companion.id,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
    activeOrderCount,
  };
}

