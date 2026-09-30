import { apiGet, apiPost } from "@/lib/api/client";
import { STAFF_PAGE_SIZE, type StaffOrderStatusFilter } from "@/lib/constants/staff";
import type {
  StaffConversationDetail,
  StaffConversationListData,
  StaffOrderListData,
  StaffOrderReleaseResult,
  StaffOrderReplaceCandidateListData,
  StaffOrderReplaceResult,
  StaffSessionUser,
} from "@/lib/types/staff";

/**
 * 客服工作台的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/staffAuth.ts` / `staffConversations.ts` 分开是必须的：
 * 那些模块依赖 `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，
 * Mock 层与内存存储就会被打进浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：客服会话由服务端下发的 HttpOnly Cookie
 * （`mock_staff_id`）维护，客户端连「我是谁」都不自己存一份。
 * 客服身份因此不存在于任何页面状态里，也不可能被伪造。
 *
 * ⚠️ 发送消息**只传 `body` 与幂等键**：`senderId` / `senderRole` / `senderName`
 * 在请求体里根本没有位置，服务端从会话推导。因此「前端改名冒充别人」写不出来。
 */

// ——————————————————————————— 认证 ———————————————————————————

/** 当前客服端会话。未登录 / 不是客服时抛 401 / 403，由调用方引导回登录页。 */
export function fetchStaffSession(): Promise<StaffSessionUser> {
  return apiGet<StaffSessionUser>("/api/staff/auth/session");
}

/**
 * 模拟客服登录。
 *
 * ⚠️ 请求体里唯一的输入是 `staffId`，它**不是身份来源**：服务端拿它去查客服仓储，
 * 查到的记录才决定这个人能不能登录。因此提交一个别人 / 停用 / 已移除的 id
 * 只会得到 403，不会得到「以这个身份登录」。
 *
 * ⚠️ 这个入口**只存在于客服登录页**：用户前台没有任何账号切换控件。
 */
export function mockLoginStaff(staffId: string): Promise<{ staff: StaffSessionUser }> {
  return apiPost<{ staff: StaffSessionUser }>("/api/staff/auth/mock-login", { staffId });
}

/** 退出登录：只删除客服端 Cookie，用户端与管理端会话不受影响。 */
export function logoutStaff(): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/staff/auth/logout");
}

/**
 * 登录页可选的测试账号**没有对应的接口**：那一页是 Server Component，
 * 服务端直接调 `getStaffLoginOptions()` 渲染。多一个「列出全部测试账号」的公开接口，
 * 就多一条「谁都能枚举客服账号」的路径。
 */

// ——————————————————————————— 工作台 ———————————————————————————

/** 会话列表的查询条件。**全部是可选的**：不传即默认第一页、不筛选。 */
export type StaffConversationListRequest = {
  keyword?: string;
  unreadOnly?: boolean;
  status?: StaffOrderStatusFilter;
  page?: number;
  pageSize?: number;
};

/**
 * 会话列表。
 *
 * 关键字**只去空白，不截断、不设上限**（与订单搜索、后台搜索同一条规则）：
 * 搜索框不该在用户打字时把内容吞掉，匹配不上就是匹配不上。
 */
export function fetchStaffConversations(
  input: StaffConversationListRequest = {},
): Promise<StaffConversationListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.unreadOnly) params.set("unread", "1");
  if (input.status && input.status !== "all") params.set("status", input.status);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? STAFF_PAGE_SIZE));

  return apiGet<StaffConversationListData>(`/api/staff/conversations?${params.toString()}`);
}

/**
 * 一条会话的完整详情。
 *
 * 404 表示**三种情况中的任意一种**：订单号写错了、订单存在但没人发起过沟通、
 * 会话关联的订单记录查不到。三者刻意不可区分——能区分就等于给出一个
 * 「拿订单号试探平台有哪些订单」的接口。
 */
export function fetchStaffConversation(orderId: string): Promise<StaffConversationDetail> {
  return apiGet<StaffConversationDetail>(
    `/api/staff/conversations/${encodeURIComponent(orderId)}`,
  );
}

/**
 * 发送一条消息。
 *
 * ⚠️ 请求体只有正文与幂等键。发送者身份由服务端写入（`senderId` = 当前客服会话，
 * `senderRole` = `customer_service`），名称与头像写成**发送时的快照**，
 * 因此之后这位客服被停用或移除，这条消息仍然显示得出当时的名字与头像。
 *
 * 幂等键由**调用方**生成，同一次用户意图内保持不变：连点发送只会产生一条消息。
 */
export function sendStaffMessage(
  orderId: string,
  idempotencyKey: string,
  body: string,
): Promise<{ messageId: string; created: boolean }> {
  return apiPost<{ messageId: string; created: boolean }>(
    `/api/staff/conversations/${encodeURIComponent(orderId)}/messages`,
    { idempotencyKey, body },
  );
}

/**
 * 标记会话已读（打开详情页时调用）。
 *
 * ⚠️ 只更新**当前这位客服**的已读位置，不清用户侧的未读：
 * 两个方向各记各的（见 `lib/data/messageRepository.ts`）。
 */
export function markStaffConversationRead(orderId: string): Promise<{ orderId: string; read: true }> {
  return apiPost<{ orderId: string; read: true }>(
    `/api/staff/conversations/${encodeURIComponent(orderId)}/read`,
  );
}

/**
 * 工作台首页的三个数没有对应的接口：那一页是 Server Component，
 * 聚合在服务端直接算好（`getStaffOverviewMetrics()`），刷新走 `router.refresh()`
 * 让服务端重新渲染。少一个接口就少一条「谁都能读全站聚合」的路径。
 */

// ——————————————————————————— 订单（P0-10，只读） ———————————————————————————

/** 客服全量订单列表的查询条件。**全部是可选的**：不传即默认第一页、不筛选。 */
export type StaffOrderListRequest = {
  status?: StaffOrderStatusFilter;
  keyword?: string;
  game?: string;
  /** YYYY-MM-DD（含当天，北京时间自然日）。空串表示不限 */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 全量订单列表（只读查询）。
 *
 * 空值**不拼进地址**（与 `fetchStaffConversations` 同一条规则）：筛选项为空就是「不筛」，
 * 拼一个 `status=` 上去只会让服务端多解析一次空串。
 *
 * ⚠️ 本函数不做任何筛选、排序或金额计算，那全在服务端
 * （`lib/services/staffOrders.ts`）。浏览器侧只知道「要哪一页、按什么条件」，
 * 因此「哪些订单该出现在结果里」不可能被前端改掉。
 *
 * ⚠️ 关键字**只去空白，不截断、不设上限**：搜索框不该在用户打字时把内容吞掉。
 */
export function fetchStaffOrders(
  input: StaffOrderListRequest = {},
): Promise<StaffOrderListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.status && input.status !== "all") params.set("status", input.status);
  if (input.game) params.set("game", input.game);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? STAFF_PAGE_SIZE));

  return apiGet<StaffOrderListData>(`/api/staff/orders?${params.toString()}`);
}

/**
 * ⚠️ 这里**刻意没有** `fetchStaffOrderDetail`。
 *
 * 订单详情页是**服务端组件**（`app/staff/(console)/orders/[id]/page.tsx` 直接调
 * `getStaffOrderDetail()`），浏览器侧没有任何地方需要取它。写一个当前没人调用的
 * 取数函数，等于给同一份详情留**第二条读取路径**——将来有人顺手用了它，
 * 就会出现「页面上看到的详情」与「接口返回的详情」两处口径。
 *
 * 对照：会话详情有 `fetchStaffConversation()`，因为那边的详情确实由客户端组件用
 * （`StaffConversationConsole` 发送消息后要重新拉取）。判断标准是「有没有调用方」，
 * 不是「列表与详情对称」。将来若出现需要客户端刷新的订单详情场景，那时再加，
 * 而不是现在先占一个位置。
 */

// ——————————————————————————— 订单处置（P0-11） ———————————————————————————

/**
 * 换人候选名单：这一单此刻可以指定哪几位护航。
 *
 * ⚠️ **资格过滤在服务端**（`listStaffOrderReplaceCandidates`），浏览器侧拿到的是
 * 一个「点了就会成功」的名单。前端不拿全量护航列表自己筛——那等于把
 * `isCompanionAcceptingOrders()` 抄进浏览器，两份副本迟早会对同一位护航给出不同答案。
 *
 * ⚠️ 这一单不该有换人动作时服务端回 **400**，由调用方按错误处理
 * （面板只在 `allowedActions.canReplace` 为真时才请求）。
 */
export function fetchStaffOrderReplaceCandidates(
  orderId: string,
): Promise<StaffOrderReplaceCandidateListData> {
  return apiGet<StaffOrderReplaceCandidateListData>(
    `/api/staff/orders/${encodeURIComponent(orderId)}/replace-candidates`,
  );
}

/**
 * 把订单退回公共池。**原因必填**（服务端 trim 后为空即 400）。
 *
 * ⚠️ **没有幂等键、没有 operationId**：这个动作的幂等判据是**状态本身**——
 * 订单已经不在履约中时服务端回 400（而不是重放），那正好回答了
 * 「这一单现在是什么状态」。给它编一个键等于替服务端发明一条它并不要求的规则，
 * 与完成材料审核（`staffCompletionsHttp`）同一条机制。
 *
 * ⚠️ 触发者（谁写下了这条退出历史）不在请求体里，也没有位置：
 * 服务端从客服会话推导。
 */
export function releaseStaffOrder(
  orderId: string,
  body: { reason: string },
): Promise<StaffOrderReleaseResult> {
  return apiPost<StaffOrderReleaseResult>(
    `/api/staff/orders/${encodeURIComponent(orderId)}/release`,
    body,
  );
}

/**
 * 直接指定新护航接替这一单。
 *
 * ⚠️ 与退回公共池一样**没有幂等键**，也**不需要管理员审批**：
 * 客服的会话身份就是全部授权。
 *
 * ⚠️ 请求体里**只有要指定的人**：原护航是谁由服务端从订单上读——
 * 让调用方声明「我正在换掉谁」是错的，「谁正在履约」是订单的事实，不是请求的参数。
 */
export function replaceStaffOrderCompanion(
  orderId: string,
  body: { companionId: string },
): Promise<StaffOrderReplaceResult> {
  return apiPost<StaffOrderReplaceResult>(
    `/api/staff/orders/${encodeURIComponent(orderId)}/replace`,
    body,
  );
}
