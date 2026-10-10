import { ApiError } from "@/lib/api/ApiError";
import {
  compareOrdersByCreatedAt,
  orderGameNames,
  orderMatchesKeyword,
  readOrderFilterDate,
  readOrderFilterGame,
} from "@/lib/constants/orderFilters";
import {
  STAFF_ORDER_DATE_INVALID_MESSAGE,
  STAFF_ORDER_DATE_RANGE_INVALID_MESSAGE,
  STAFF_ORDER_GAME_INVALID_MESSAGE,
  STAFF_ORDER_LIST_NOTICE,
  STAFF_ORDER_STATUS_INVALID_MESSAGE,
  buildStaffOrderListQuery,
  readStaffOrderStatusFilter,
  staffOrderAllowedActions,
  toStaffCompanionReleaseEntry,
  toStaffOrderDispatchSummary,
  toStaffOrderListItem,
  toStaffOrderSummary,
  type StaffOrderListQuery,
} from "@/lib/constants/staff";
import { toStaffCompletionListItem } from "@/lib/constants/staffCompletions";
import { toStaffComplaintListItem } from "@/lib/constants/staffComplaints";
import { toStaffRefundListItem } from "@/lib/constants/staffRefunds";
import { getCompanionReleaseRepository } from "@/lib/data/companionReleaseRepository";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getCompletionRepository } from "@/lib/data/completionRepository";
import { sweepExpiredDispatches } from "@/lib/data/companionDispatchTransaction";
import { sweepCompletionAutoApprovals } from "@/lib/data/completionTransaction";
import { getDispatchRepository } from "@/lib/data/dispatchRepository";
import { ADMIN_ORDER_UNFILTERED_QUERY, getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getUserRepository, type UserRecord } from "@/lib/data/userRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  StaffCompanionReleaseEntry,
  StaffOrderDetail,
  StaffOrderListData,
  StaffOrderListItem,
  StaffOrderUserSummary,
} from "@/lib/types/staff";
import { buildOrderTimeline } from "./orders";

/**
 * 客服工作台「订单」服务 —— **全平台订单的只读查询**入口（P0-10）。
 *
 * ⚠️ 本文件**只服务客服端**，每一个调用它的接口都先经过 `requireStaff()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/staffRoute.ts`），
 * 在这里再写一遍只会出现「两处规则不一致」的可能。
 *
 * 五条规矩，本文件是它们唯一的落点：
 *
 * 1. **没有任何业务处置**。这里没有换人、退款、改状态、写投诉的函数，也没有事务；
 *    因此不涉及幂等键、重放与伪事务原子区段——本文件是查询，不是处置。
 *    （P0-11 的换人与退回公共池**如约落在别处**：`lib/services/staffOrderActions.ts`。
 *    本文件仍然一行写入都没有，这个边界不是靠自觉，是靠这个文件里没有事务模块的 import。）
 *
 *    唯一的例外是读取路径上的两个**惰性物化**（`sweepExpiredDispatches` /
 *    `sweepCompletionAutoApprovals`）：它们是幂等的、与业务动作无关的既有惯例，
 *    `adminOrders` / `orders` / `companionOrders` / `staffCompletions` 都挂在同两处。
 *    不挂的话这一页会显示已经过期的派单 / 完成材料状态（理由写在两个调用点旁边）。
 * 2. **零新增仓储方法**。订单集合复用 `queryOrdersForAdmin({status, gameName, from, to})`：
 *    它回答的是**与身份无关**的问题（状态 / 游戏 / 时间范围内有哪些订单、什么顺序），
 *    为客服再写一份同义查询就是**第二套订单读取实现**（`architecture-rules.md` §4.3 禁止）。
 *    用户摘要同理复用数据源的 `findUserById()`。
 * 3. **排序与筛选字段一致，且不新写比较函数**。排序用共享的
 *    `compareOrdersByCreatedAt`（创建时间倒序 → 支付时间 → id），与时间筛选算的是同一个字段。
 * 4. **分页排在关键词过滤之后**。关键词要拼用户昵称与平台标识，而订单里只有 `userId`，
 *    数据层做不了这件事；也正因为如此，`total` 必须是**过滤后**的条数，
 *    否则会与实际能翻到的条数分叉。
 * 5. **DTO 在这里成型**。列表与详情都是显式挑字段（见 `lib/constants/staff.ts` 的转换函数），
 *    平台分账字段、游戏账号、备注与用户主键都不进响应。
 *
 * ⚠️ **本文件的每个导出函数都要求调用方已经过 `requireStaff()`**：
 * 订单的客服侧读取**刻意不按身份过滤**（工作台本来就要查任意用户的订单——
 * 用户报一个订单号来问，客服就要能查到它），因此「谁在读」必须由接口层先判掉。
 * 这也解释了下面两个读函数的签名里**都没有 `staffId`**：
 *
 * - `listOrdersForStaff`：列表没有任何按客服区分的事实（对比会话列表的未读数，
 *   那个才是按当前客服统计的），因此连参数都不给；
 * - `getStaffOrderDetail`：**它不收 `staffId` 是刻意的，不是漏了参数**。
 *   会话详情的 `staffId` 用于算「这位客服读到哪儿了」（`staffLastReadAt`），
 *   而订单详情没有任何按客服区分的事实：订单一视同仁，客服之间没有私有状态。
 *   若将来出现「这位客服认领了这单」一类事实，那时再加参数，而不是现在先占一个位置。
 */

// ——————————————————————————— 内部：订单、用户与退出历史 ———————————————————————————

/**
 * 全部订单。用于两件事：算游戏筛选项，以及校验「按游戏筛选」的值是否合法。
 *
 * ⚠️ 接入数据库后这里对应一次 `SELECT DISTINCT game_name FROM orders` 之类的**轻查询**，
 * 而不是把整张表拉回内存。Mock 数据只有几十条，因此本阶段先用最直白的写法
 * （与管理端 `allOrdersForAdmin()` 同一个做法、同一个共享常量）。
 */
async function allOrdersForStaff() {
  return getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
}

/**
 * userId → 用户记录的缓存。
 *
 * ⚠️ **「查不到」也要缓存**（因此值类型允许 `null`，用 `has()` 而不是取值判断）：
 * 同一批订单里往往只有几个用户，逐条查询会变成 N+1；而预置数据里就有刻意不指向
 * 任何用户记录的订单，不缓存失败结果的话它们每一条都要白查一次。
 */
type StaffUserCache = Map<string, UserRecord | null>;

/**
 * 取用户记录（带缓存）。
 *
 * ⚠️ 读的是**用户记录**（`getUserRepository()`），不是登录态用户（`getDataSource()`）：
 * 两者只差在 `displayId` ——它是用户资料页上那串 ID，而客服订单页要让客服
 * 按它搜、并看见它（P0-10）。用 `getDataSource()` 拿不到这个字段，
 * 也就只能像从前那样拿内部标识去顶替「平台标识」，而用户手上根本没有那个值。
 *
 * 这一处只服务**订单页**：会话 / 退款 / 投诉 / 完成材料四处仍走各自原有的读取路径，
 * 它们的 `StaffUserSummary` 也仍然只有三样（见 `StaffOrderUserSummary` 的注释）。
 */
async function resolveStaffUser(cache: StaffUserCache, userId: string): Promise<UserRecord | null> {
  if (cache.has(userId)) return cache.get(userId) ?? null;

  const user = await getUserRepository().findUserById(userId);
  cache.set(userId, user);
  return user;
}

/**
 * 用户记录 → 客服订单页摘要。**查不到时的占位与客服会话列表同一条口径**：
 * 昵称回落成「用户」而不是空串。
 *
 * 订单本身是有效的，少一条用户记录不该让整张列表打不开，也不该让页面上出现一个
 * 没有称呼的空白行。「用户」是一句中性称呼，读的人一眼看得出这是占位而不是昵称
 * （空串则会被读成界面坏了）。头像用空串——不由这里编一个。
 *
 * ⚠️ `id` 回落成**订单上的 `userId`**：它是这一行在列表里唯一的身份线索，
 * 空掉会让「搜到了但看不出来为什么搜到」再次出现。
 *
 * ⚠️ **两个标识都给出去，两个都要能搜**：
 * - `id` 是内部标识（客服会话页给的是同一个值，`StaffConversationDetail.user.id`）；
 * - `displayId` 是用户资料页上那串，用户报的就是它。
 *
 * 下面关键词匹配的 `userId` / `displayId` 传的正是这两个值——**给出去的和参与匹配的
 * 必须是同一对**，否则命中理由在页面上看不见。
 *
 * ⚠️ `displayId` 查不到时回落成**空串**（不是编一个占位）：它不参与匹配，
 * 而页面上「没有这一路」比「显示一串查无此人的 ID」诚实。`id` 不同——它有订单上的
 * `userId` 兜底，因为它同时是这一行唯一的身份线索。
 */
function toStaffUserSummary(user: UserRecord | null, userId: string): StaffOrderUserSummary {
  return {
    id: user ? user.id : userId,
    displayId: user ? user.displayId : "",
    nickname: user ? user.nickname : STAFF_ORDER_MISSING_USER_NICKNAME,
    avatarUrl: user ? user.avatarUrl : "",
  };
}

/** 用户记录缺失时的昵称占位。与 `lib/services/staffConversations.ts` 的写法一致。 */
const STAFF_ORDER_MISSING_USER_NICKNAME = "用户";

/**
 * 订单 → 客服可读的履约退出历史（P0-6）。
 *
 * 打手在开始服务前主动取消接单之后，订单上的 `actualCompanionId` / `companion`
 * 已经被清空（订单必须能重新进公共池），因此「谁曾经接过、为什么走」只能从这里看。
 * 客服在订单页上要回答的正是这件事。
 *
 * ⚠️ 这是**客服侧各服务各写一份的私有小助手**（与 `staffConversations.ts` /
 * `staffRefunds.ts` / `staffComplaints.ts` 同例）：「一条退出历史怎么变成客服看得懂的
 * 条目」不在这里——它在 `toStaffCompanionReleaseEntry()`（唯一转换点），
 * 因此四处不会出现四种口径（`tests/staffReleaseHistory.test.mjs` 有一条门禁钉着这个调用方清单）。
 *
 * ⚠️ 名字用 `findCompanionById()` 而不是任何「有效护航」口径的查询：
 * 事后被下架的护航照样要显示得出名字，那是历史事实。查不到时传空串，
 * 由构造函数回落到 `companionId`——**回落到 id 这条规则本身也只有那一处**。
 *
 * 没有退出过返回**空数组**，不是 `null`：那是正常情况，不是「查不到」。
 */
async function releaseHistoryFor(orderId: string): Promise<StaffCompanionReleaseEntry[]> {
  const records = await getCompanionReleaseRepository().listReleasesByOrderId(orderId);
  if (records.length === 0) return [];

  // 同一单上可能同一位护航退出过多次：按 id 缓存名字，不重复查同一条资料
  const names = new Map<string, string>();
  for (const record of records) {
    if (names.has(record.companionId)) continue;
    const companion = await getCompanionRepository().findCompanionById(record.companionId);
    names.set(record.companionId, companion ? companion.displayName : "");
  }

  return records.map((record) =>
    toStaffCompanionReleaseEntry(record, names.get(record.companionId) ?? ""),
  );
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。与其它客服 / 管理列表同一套约定：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 *
 * 四类条件都要解析，因为它们都会**改变查到的数据**：一个手改坏的游戏名或日期
 * 若静默按「不限」处理，页面会显示一批与筛选栏不符的订单。
 *
 * 分页参数的非法值走规范化（`clampPage` / `clampPageSize`），两者行为不同是刻意的
 * ——「筛错了」与「翻到第 0 页」不是同一类问题（见 `lib/constants/pagination.ts`）。
 *
 * ⚠️ 游戏筛选要拿「订单里出现过的游戏名」校验，因此这是一个 async 函数
 * （与 `resolveAdminOrderListQuery` 同形）。校验的是**筛选栏上真有的取值集合**：
 * 放行一个不存在的游戏名只会得到一次必然为空、且无法解释的查询。
 */
export async function resolveStaffOrderListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<StaffOrderListQuery> {
  const knownGames = orderGameNames(await allOrdersForStaff());

  const status = readStaffOrderStatusFilter(params.get("status"));
  const game = readOrderFilterGame(params.get("game"), knownGames);
  const from = readOrderFilterDate(params.get("from"));
  const to = readOrderFilterDate(params.get("to"));

  if (strict) {
    if (status === null) {
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_STATUS_INVALID_MESSAGE, 400);
    }
    if (game === null) {
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_GAME_INVALID_MESSAGE, 400);
    }
    if (from === null || to === null) {
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_DATE_INVALID_MESSAGE, 400);
    }
    // 「开始晚于结束」必然是空结果，但它更像一次写错的查询而不是「没有数据」，因此也报 400
    if (from && to && from > to) {
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_DATE_RANGE_INVALID_MESSAGE, 400);
    }
  }

  return buildStaffOrderListQuery({
    params,
    // 宽松模式下非法状态回落到「全部」——订单列表的用途是**查询**，
    // 打开就限定成某一类会让「我这一单呢」变成一个需要先想清楚状态才查得到的问题
    status: status ?? "all",
    game: game ?? "",
  });
}

/**
 * 客服端订单列表：状态 / 游戏 / 时间范围筛选 + 关键词 + 分页 + 稳定排序。
 *
 * 分工与用户端 / 管理端一致：
 *
 * - **状态、游戏、时间范围在数据层完成**（`queryOrdersForAdmin`）；
 * - **关键词与分页在这一层**：关键词要拼用户昵称与平台标识，而订单里只有 `userId`；
 *   分页因此必须排在关键词过滤**之后**（`total` 与能翻到的条数才不会分叉）。
 *
 * `?mockError=…` 由 `withMockDebug` 统一处理（只在 `ENABLE_MOCK_DEBUG=true` 时生效），
 * 且都在这一层处理——`app/staff/**` 下的页面不引用 `lib/mocks`。
 *
 * ⚠️ **本函数不产生任何业务处置**：没有换人、没有退款、没有状态推进。
 * 它对订单的唯一"写入"是两个**惰性物化**（见下），那是本项目在读取路径上的既有惯例，
 * 不是本轮新引入的写路径。
 */
export async function listOrdersForStaff(
  query: StaffOrderListQuery,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<StaffOrderListData> {
  // ⚠️ 超时事实的惰性物化（幂等），与 `adminOrders.ts` 的列表**同一处、同一个函数**。
  //
  // 为什么客服这一页也必须挂：`dispatch.state` 是这一页要显示的事实之一。不物化的话，
  // 若期间没人访问管理端 / 用户端 / 打手端，客服会看到「公共池等待接单」而
  // `publicDeadlineAt` 早已过去——他据此告诉用户「还在等人接」，
  // 而实际上这一单按规则已经超时关闭了。`adminOrders.ts` 写这句的理由原文就是
  // 「否则**客服**会对着一条『等待接单』的单去催一个已经不存在的接单」。
  // 悬挂点不是可选项：漏挂产生的是一条只在"没人在别处访问"时才出现的错误状态，
  // 那是最难被发现、也最难被复现的一类不一致。
  sweepExpiredDispatches(new Date().toISOString());
  // 同理，完成材料到期自动通过（P0-8）：`completion.statusLabel` 也在这张列表的详情里显示
  sweepCompletionAutoApprovals(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    // 游戏筛选项先算好：它取自**全部订单**，与当前筛选无关（筛了游戏之后就只剩一个选项了）
    const games = orderGameNames(await allOrdersForStaff());

    const rows = await getPaymentRepository().queryOrdersForAdmin({
      status: query.status === "all" ? null : query.status,
      gameName: query.game,
      from: query.from,
      to: query.to,
    });

    // 排序：复用共享的比较函数（创建时间倒序 → 支付时间 → id 兜底）。
    // ⚠️ 数据层（`mockPaymentRepository.queryOrdersForAdmin`）已经用**同一个函数**排过一遍；
    // 这里再显式排一次不是纠错，而是让「客服订单列表按创建时间倒序」这条契约写在服务层
    // 自己身上——否则将来数据层换了实现，客服列表的顺序会跟着一起变而没人发现。
    // 对同一份数据排两次结果相同（幂等），代价是几十条内存排序。
    rows.sort(compareOrdersByCreatedAt);

    const cache: StaffUserCache = new Map();
    const matched: StaffOrderListItem[] = [];

    for (const order of rows) {
      const user = await resolveStaffUser(cache, order.userId);

      // 关键词匹配「订单号 / 商品名 / 用户昵称 / 平台标识」，
      // 用的是共享的 `orderMatchesKeyword`（与后台同一个函数、同一批匹配字段）。
      // 用户记录缺失时传空串：它不参与匹配，而占位昵称「用户」也不该被搜到
      // （否则「用户」这个词会把所有孤儿订单一起捞出来）。
      const hit = orderMatchesKeyword(
        {
          orderNo: order.orderNo,
          productTitle: order.productTitle,
          nickname: user?.nickname ?? "",
          // 两个平台标识都参与匹配：列表上**两个都显示**（用户资料页那串 displayId
          // 在上、内部标识在下），因此两个都得搜得到，命中理由才永远看得见。
          displayId: user?.displayId ?? "",
          userId: user?.id ?? "",
        },
        query.keyword,
      );
      if (!hit) continue;

      matched.push(toStaffOrderListItem(order, toStaffUserSummary(user, order.userId)));
    }

    const total = matched.length;
    const start = (query.page - 1) * query.pageSize;
    const items = matched.slice(start, start + query.pageSize);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: start + items.length < total,
      games,
      notice: STAFF_ORDER_LIST_NOTICE,
    };
  });
}

// ——————————————————————————— 详情 ———————————————————————————

/**
 * 客服端订单详情。**订单不存在时返回 `null`，不抛错**：由调用方决定口径
 * （接口转 404 `STAFF_ORDER_NOT_FOUND_MESSAGE`，页面 `notFound()`），
 * 与 `getStaffRefundDetail` / `getStaffConversationDetail` 同一条约定。
 *
 * 这里一并取回四份摘要与派单进度——它们回答的都是**这一单做过什么**：
 *
 * | 事实 | 来源 | 没有时 |
 * |---|---|---|
 * | 退款 | `findRefundByOrderId`（一单一申请） | `null` |
 * | 投诉 | `listComplaintsByOrderId`（一单可多条） | `[]` |
 * | 完成材料 | `findLatestCompletionByOrderId`（最新一份） | `null` |
 * | 派单进度 | `findDispatchByOrderId` | `null`（历史订单没有派单记录） |
 * | 履约退出历史 | `listReleasesByOrderId` | `[]` |
 *
 * ⚠️ **不做任何金额计算**：四个金额字段都是下单时冻结的订单快照，原样交给 DTO
 * （`originalAmount` / `couponDiscountAmount` / `actualPaidAmount` / `refundedAmount`）。
 * 本文件不引用 `lib/constants/orderAmount.ts`，也不重算分账与退款——
 * 「这一单还能退多少」是客服读出来的，不是这一层算出来的。
 *
 * ⚠️ **`staffId` 不是漏了**，理由见文件头。
 */
export async function getStaffOrderDetail(
  orderId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<StaffOrderDetail | null> {
  if (!orderId) return null;

  // 与列表同一处、同一理由的两个惰性物化（幂等）。详情比列表更必须挂：
  // 客服往往是**直接按订单号打开这一页**，列表可能根本没被访问过。
  sweepExpiredDispatches(new Date().toISOString());
  sweepCompletionAutoApprovals(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    const order: Order | null = await getPaymentRepository().findOrderById(orderId);
    if (!order) return null;

    const [user, refund, complaints, completion, dispatch, releaseHistory] = await Promise.all([
      // 详情只有一条订单，因此用一个即用即弃的缓存走**同一个**用户解析函数：
      // 「用户记录缺失时怎么占位」只有一处口径
      resolveStaffUser(new Map(), order.userId),
      getRefundRepository().findRefundByOrderId(order.id),
      // 投诉是**数组**：一单可以有多条，服务端按订单查全部。
      // 排序由仓储负责（按提交时间），这里不重新排一遍——「多条投诉什么顺序」只有一处口径
      getComplaintRepository().listComplaintsByOrderId(order.id),
      getCompletionRepository().findLatestCompletionByOrderId(order.id),
      getDispatchRepository().findDispatchByOrderId(order.id),
      releaseHistoryFor(order.id),
    ]);

    const userSummary = toStaffUserSummary(user, order.userId);

    return {
      // P0-11：这一单此刻客服能做什么。由服务端算好，页面只按值渲染。
      // ⚠️ 它与另两个处置入口（release / replace）的前置判定用的是**同一个函数**
      // `staffOrderAllowedActions`——按钮可见性与接口接受性同源，不会分叉
      allowedActions: staffOrderAllowedActions(order),
      // 订单只读摘要复用客服侧**唯一**的转换口径（会话详情 / 投诉详情 / 退款详情用的是同一个）
      order: toStaffOrderSummary(order, userSummary.nickname, releaseHistory),
      user: userSummary,
      productCoverUrl: order.productCoverUrl,
      gameName: order.gameName,
      region: order.region,
      unitPrice: order.unitPrice,
      itemsAmount: order.itemsAmount,
      addonsAmount: order.addonsAmount,
      addons: order.addons,
      originalAmount: order.originalAmount,
      couponDiscountAmount: order.couponDiscountAmount,
      actualPaidAmount: order.actualPaidAmount,
      refundedAmount: order.refundedAmount,
      timeline: buildOrderTimeline(order),
      dispatch: dispatch ? toStaffOrderDispatchSummary(dispatch) : null,
      refund: refund ? toStaffRefundListItem(refund, order, userSummary) : null,
      complaints: complaints.map((complaint) => toStaffComplaintListItem(complaint, userSummary)),
      completion: completion ? toStaffCompletionListItem(completion, order, userSummary) : null,
    };
  });
}
