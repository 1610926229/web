import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_ORDER_DATE_INVALID_MESSAGE,
  ADMIN_ORDER_DATE_RANGE_INVALID_MESSAGE,
  ADMIN_ORDER_GAME_INVALID_MESSAGE,
  ADMIN_ORDER_LIST_NOTICE,
  ADMIN_ORDER_STATUS_INVALID_MESSAGE,
  DEFAULT_ADMIN_ORDER_STATUS_FILTER,
  buildAdminOrderListQuery,
  orderGameNames,
  orderMatchesAdminKeyword,
  readAdminOrderDate,
  readAdminOrderGame,
  readAdminOrderStatusFilter,
  toAdminOrderDetail,
  toAdminOrderListItem,
  type AdminOrderListQuery,
} from "@/lib/constants/adminOrders";
import { sweepExpiredDispatches } from "@/lib/data/companionDispatchTransaction";
import { getDispatchRepository } from "@/lib/data/dispatchRepository";
import { toOrderCompanionSnapshot } from "@/lib/constants/companions";
import { getMessageRepository } from "@/lib/data/messageRepository";
import {
  ADMIN_ORDER_UNFILTERED_QUERY,
  getPaymentRepository,
} from "@/lib/data/paymentRepository";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getReviewRepository } from "@/lib/data/reviewRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { AdminOrderDetail, AdminOrderListData, OrderCompanionSnapshot } from "@/lib/types/order";
import type { AdminUserSummary } from "@/lib/types/user";
import { toOrderComplaintSummary } from "./complaints";
import { buildConversationStats } from "./conversations";
import { buildOrderTimeline } from "./orders";
import { toRefundSummary } from "./refunds";
import { toReviewSummary } from "./reviews";

/**
 * 管理端「全量订单」服务 —— 列表与详情的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`），
 * 在这里再写一遍只会出现「两处规则不一致」的可能。
 *
 * 三条分工，与申请审核那一组完全一致：
 *
 * 1. **筛选与排序在数据层完成**（`queryOrdersForAdmin`），**关键词与分页在这一层**。
 *    关键词要拼用户昵称与平台 ID，而订单里只有 `userId`，因此数据层做不了；
 *    也正因为如此，分页必须排在关键词过滤**之后**——否则 `total` 与实际能翻到的条数会分叉。
 * 2. **DTO 在这里生成**：列表项刻意不带游戏账号、备注、增值服务明细与四份售后摘要。
 * 3. **本阶段的订单详情是只读的**：这里没有任何写订单的函数，返回的 DTO 上也没有
 *    `allowedActions`。唯一会写订单的是退款审核通过，它在 `./adminRefunds.ts` 里。
 *
 * ⚠️ 用户摘要只有三样（`AdminUserSummary`）：昵称与平台展示 ID 是搜索命中的字段，
 * id 用于把「同一用户的多个订单」串起来。**任何微信身份、会话标识都不在这里**。
 */

/**
 * 全部订单。用于两件事：算游戏筛选项，以及校验「按游戏筛选」的值是否合法。
 *
 * ⚠️ 接入数据库后这里对应一次 `SELECT DISTINCT game_name FROM orders` 之类的**轻查询**，
 * 而不是把整张表拉回内存。Mock 数据只有几十条，因此本阶段先用最直白的写法。
 */
async function allOrdersForAdmin() {
  return getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
}

/**
 * userId → 用户摘要。
 *
 * 用户仓储（而不是 `getDataSource()`）：数据源是只读契约，只暴露 `findUserById`，
 * 而列表要按 keyword 过滤就得**一次拿到全部用户**，逐条 `findUserById` 会变成 N+1。
 */
async function adminUserIndex(): Promise<Map<string, AdminUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [user.id, { id: user.id, displayId: user.displayId, nickname: user.nickname }]),
  );
}

/**
 * 用户**指定**的那位护航（P0-5）——后台订单详情里「指定」那一行。
 *
 * 三件事都与「实际接单的人」不同：
 *
 * 1. 来源不同：它取自**派单记录**的 `exclusiveCompanionId`，不在订单上；
 * 2. 可能为空：用户没指定时订单直接进公共池，这里就是 null，
 *    而实际接单的人可能已经有一位；
 * 3. **它不会因为别人接单而改变**：用户指定 A、A 没接、B 从公共池接走，
 *    这里仍然是 A，实际接单那一行是 B。两个事实都要留得住——
 *    只留一个，「我明明指定了 A，怎么是 B 在打」在后台就查不出来。
 *
 * ⚠️ **软移除的护航照样显示**。用户当初指定的是他，这件事不因为他后来被下架而没发生过；
 * 这里用 `findCompanionById` 而不是任何「有效护航」口径的查询。
 *
 * 查不到记录（订单已退款、管理员手动退款、护航记录被彻底删除）时返回 null：
 * 不编造一个名字，也不让整页报错。
 */
async function resolveExclusiveCompanion(orderId: string): Promise<OrderCompanionSnapshot | null> {
  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  if (!dispatch?.exclusiveCompanionId) return null;

  const companion = await getCompanionRepository().findCompanionById(dispatch.exclusiveCompanionId);
  return companion ? toOrderCompanionSnapshot(companion) : null;
}

/**
 * 用户记录缺失时的占位摘要。
 *
 * 不返回 null、也不抛错：订单本身是有效的，少一条用户记录不该让整张列表打不开
 * （预置订单里就有刻意不指向任何用户的条目）。页面看到的是一行空昵称，
 * 而不是一整页错误。
 */
function missingUser(userId: string): AdminUserSummary {
  return { id: userId, nickname: "", displayId: "" };
}

/**
 * 解析列表查询条件。与其它管理列表同一套约定：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 *
 * 四类条件都要解析，因为它们都会**改变查到的数据**：一个手改坏的游戏名或日期
 * 若静默按「不限」处理，页面会显示一批与筛选栏不符的订单。
 *
 * 分页参数的非法值走规范化（`clampPage` / `clampPageSize`），两者行为不同是刻意的
 * ——「筛错了」与「翻到第 0 页」不是同一类问题，见 `lib/constants/pagination.ts`。
 */
export async function resolveAdminOrderListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminOrderListQuery> {
  const knownGames = orderGameNames(await allOrdersForAdmin());

  const status = readAdminOrderStatusFilter(params.get("status"));
  const game = readAdminOrderGame(params.get("game"), knownGames);
  const from = readAdminOrderDate(params.get("from"));
  const to = readAdminOrderDate(params.get("to"));

  if (strict) {
    if (status === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_ORDER_STATUS_INVALID_MESSAGE, 400);
    }
    if (game === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_ORDER_GAME_INVALID_MESSAGE, 400);
    }
    if (from === null || to === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_ORDER_DATE_INVALID_MESSAGE, 400);
    }
    // 「开始晚于结束」必然是空结果，但它更像一次写错的查询而不是「没有数据」，因此也报 400
    if (from && to && from > to) {
      throw new ApiError("BAD_REQUEST", ADMIN_ORDER_DATE_RANGE_INVALID_MESSAGE, 400);
    }
  }

  return buildAdminOrderListQuery({
    params,
    status: status ?? DEFAULT_ADMIN_ORDER_STATUS_FILTER,
    game: game ?? "",
  });
}

/**
 * 管理端订单列表。
 *
 * `?mockEmpty=orders` 演示空列表（**空数据不是错误**，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两个参数都只在 `ENABLE_MOCK_DEBUG=true`
 * 时生效，且都在这一层处理——`app/admin/**` 下的页面不引用 `lib/mocks`。
 */
export async function queryAdminOrderList(
  query: AdminOrderListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminOrderListData> {
  // 超时事实的惰性物化（幂等）：后台列表里的状态必须与业务事实一致，
  // 否则客服会对着一条「等待接单」的单去催一个已经不存在的接单
  sweepExpiredDispatches(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    const games = orderGameNames(await allOrdersForAdmin());

    if (mockEmptyApplies(params, "orders")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        games,
        notice: ADMIN_ORDER_LIST_NOTICE,
      };
    }

    const [rows, users] = await Promise.all([
      getPaymentRepository().queryOrdersForAdmin({
        status: query.status === "all" ? null : query.status,
        gameName: query.game,
        from: query.from,
        to: query.to,
      }),
      adminUserIndex(),
    ]);

    const matched = rows.filter((order) => {
      const user = users.get(order.userId);
      return orderMatchesAdminKeyword(
        {
          orderNo: order.orderNo,
          productTitle: order.productTitle,
          nickname: user?.nickname ?? "",
          displayId: user?.displayId ?? "",
        },
        query.keyword,
      );
    });

    // 分页排在关键词过滤之后：数据层只回答「状态 / 游戏 / 时间范围内有哪些、什么顺序」
    const start = (query.page - 1) * query.pageSize;
    const items = matched
      .slice(start, start + query.pageSize)
      .map((order) => toAdminOrderListItem(order, users.get(order.userId) ?? missingUser(order.userId)));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      hasMore: start + items.length < matched.length,
      games,
      notice: ADMIN_ORDER_LIST_NOTICE,
    };
  });
}

/**
 * 管理端订单详情。不存在返回 null，由页面 `notFound()`。
 *
 * 四份售后摘要与时间轴在这里拼装，与用户端 `getOrderDetailForUser()` 用的是同一批函数：
 * 「这一单做过什么」只有一套口径，管理端与用户端不该看到不同的结论。
 *
 * 唯一的差别是**归属**：这里按订单 id 直接取，不校验 `userId`——调用方已经过了
 * `requireAdmin()`，而客服本来就要能查任意用户的订单。
 */
export async function getAdminOrderDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminOrderDetail | null> {
  if (!id) return null;

  // 超时事实的惰性物化（幂等）：后台看到的订单状态必须与业务事实一致——
  // 一张在公共池里等到超时的单不该在后台还显示成「等待接单」
  sweepExpiredDispatches(new Date().toISOString());

  return withMockDebug(params, surface, async () => {
    const order = await getPaymentRepository().findOrderById(id);
    if (!order) return null;

    const [users, refund, complaintStats, conversation, exclusiveCompanion] = await Promise.all([
      adminUserIndex(),
      getRefundRepository().findRefundByOrderId(order.id),
      getComplaintRepository().summarizeComplaintsByOrder(order.id),
      getMessageRepository().findConversation(order.userId, order.id),
      resolveExclusiveCompanion(order.id),
    ]);

    // 未读数与用户端同一个口径；会话不存在时摘要为 null
    const conversationSummary = conversation
      ? buildConversationStats(
          conversation,
          await getMessageRepository().listMessages(order.userId, order.id),
        )
      : null;

    // 评价按订单 id 查，并按所属用户隔离——这个查询需要一个 userId 参数
    const review = await getReviewRepository().findReviewByOrderId(order.userId, order.id);

    return toAdminOrderDetail(order, users.get(order.userId) ?? missingUser(order.userId), {
      timeline: buildOrderTimeline(order),
      exclusiveCompanion,
      refundSummary: refund ? toRefundSummary(refund) : null,
      complaintSummary: toOrderComplaintSummary(complaintStats),
      conversationSummary,
      reviewSummary: review ? toReviewSummary(review) : null,
    });
  });
}
