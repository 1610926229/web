import { ApiError } from "@/lib/api/ApiError";
import { DISPATCH_POOL_LABELS } from "@/lib/constants/dispatch";
import { ORDER_STATUS_LABELS, parseOrderListQuery } from "@/lib/constants/orders";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { sweepExpiredDispatches, toDispatchProgress } from "@/lib/data/companionDispatchTransaction";
import { getDispatchRepository } from "@/lib/data/dispatchRepository";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getReviewRepository } from "@/lib/data/reviewRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { PageResult } from "@/lib/types/common";
import type {
  Order,
  OrderAllowedActions,
  OrderDetail,
  OrderDispatchProgress,
  OrderListItem,
  OrderStatus,
  OrderTimelineEntry,
} from "@/lib/types/order";
import { toOrderComplaintSummary } from "./complaints";
import { buildConversationStats } from "./conversations";
import { buildRefundActions, toRefundSummary } from "./refunds";
import { buildReviewActions, toReviewSummary } from "./reviews";

/**
 * 订单查询服务 —— 订单列表页、订单详情页与两个接口共用的唯一入口。
 *
 * 三条规则：
 *
 * 1. **归属由服务端决定**。所有函数都要求传入当前登录用户的 `userId`，
 *    仓储的 `queryOrders` 把它当作查询条件而不是过滤项，取单个订单时也在这里校验归属；
 *    调用方拿不到「别人的订单」这种东西，也就不可能忘记过滤。
 * 2. **列表与详情是两个 DTO**。`toOrderListItem` 刻意丢掉游戏 ID、备注与金额明细，
 *    列表接口不可能顺手把它们带出去。
 * 3. **仓储返回完整订单，转换只在这里发生**。页面与接口都不直接接触仓储类型。
 *
 * 订单与支付请求由同一个仓储提供（见 `lib/data/paymentRepository.ts`）：
 * P4 支付成功生成的订单和预置的 Mock 订单是同一批数据，因此新订单会立刻出现在列表里。
 */

/** 状态 → 时间字段。详情页只展示**已经发生**的节点。 */
const TIMELINE_SOURCE: readonly { key: OrderStatus; at: (order: Order) => string | null }[] = [
  { key: "paid", at: (order) => order.paidAt },
  { key: "accepted", at: (order) => order.acceptedAt },
  { key: "serving", at: (order) => order.servingAt },
  { key: "completed", at: (order) => order.completedAt },
  { key: "refunded", at: (order) => order.refundedAt },
];

/**
 * 状态时间轴：只包含**已经发生**的节点，按时间先后排列。
 *
 * 导出给管理端的订单详情复用（P8C）：那一份 DTO 同样要展示时间轴，而
 * 「哪个时间戳代表哪个状态」只应该有这一处定义——两份实现迟早会在新增状态时漏掉一处。
 * ⚠️ 本模块依赖 `lib/data` 与 `lib/mocks`，因此**只能被服务端引用**：
 * 管理端的浏览器取数走 `lib/services/adminHttp.ts`，不经这里。
 */
export function buildOrderTimeline(order: Order): OrderTimelineEntry[] {
  return TIMELINE_SOURCE.flatMap((node) => {
    const at = node.at(order);
    return at ? [{ key: node.key, label: ORDER_STATUS_LABELS[node.key], at }] : [];
  }).sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

/** 订单 → 列表项。**显式挑字段**：新增的订单字段不会自动出现在列表接口里。 */
export function toOrderListItem(order: Order): OrderListItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paidAt: order.paidAt,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    companion: order.companion,
  };
}

/**
 * 订单详情里的三个售后摘要 + 可执行动作。
 *
 * 单独成类型是为了让「订单本身长什么样」与「这一单现在还能做什么」分开：
 * 前者来自订单，后者来自退款 / 投诉 / 会话三份数据，两者拼装只在这里发生。
 */
export type OrderDetailExtras = {
  refundSummary: OrderDetail["refundSummary"];
  complaintSummary: OrderDetail["complaintSummary"];
  conversationSummary: OrderDetail["conversationSummary"];
  reviewSummary: OrderDetail["reviewSummary"];
  allowedActions: OrderAllowedActions;
};

/**
 * 订单 → 详情。游戏 ID 与备注只在这里出现，且只返回给订单所属用户。
 *
 * `dispatchProgress` 与四份售后摘要一样由服务层查好传进来：它不在订单上，
 * 而在派单记录里（见 `OrderDispatchProgress`）。
 */
export function toOrderDetail(
  order: Order,
  extras: OrderDetailExtras & { dispatchProgress: OrderDispatchProgress | null },
): OrderDetail {
  return {
    ...toOrderListItem(order),
    createdAt: order.createdAt,
    gameName: order.gameName,
    region: order.region,
    gameAccountId: order.gameAccountId,
    remark: order.remark,
    unitPrice: order.unitPrice,
    itemsAmount: order.itemsAmount,
    addonsAmount: order.addonsAmount,
    addons: order.addons,
    // 金额域（P0-3）：详情页显示「原价 / 实付 / 护航收益」三行。
    // `clubNetIncome`（平台净收入）**刻意不在这里**：它是平台自己的账，
    // 用户端没有展示位置，放进 DTO 只会顺着接口响应流到浏览器。
    // 当前没有优惠券，所以实付等于原价；券接入后这里会天然变成两个数，
    // 页面不需要改——它读的一直是这两个不同的字段。
    originalAmount: order.originalAmount,
    couponDiscountAmount: order.couponDiscountAmount,
    actualPaidAmount: order.actualPaidAmount,
    companionRateSnapshot: order.companionRateSnapshot,
    companionBaseIncome: order.companionBaseIncome,
    refundedAmount: order.refundedAmount,
    timeline: buildOrderTimeline(order),
    ...extras,
  };
}

/**
 * 查询当前用户的订单列表。
 *
 * 查询条件解析失败（状态取值非法、关键字超长）抛 `BAD_REQUEST`：
 * 这两个是**明确的业务条件写错了**，静默当成「全部」会让调用方以为筛选生效了。
 * 分页参数的非法值走规范化，两者行为不同是刻意的（见 `lib/constants/orders.ts`）。
 */
export async function queryOrdersForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<PageResult<OrderListItem>> {
  const parsed = parseOrderListQuery(params);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  // 惰性物化超时事实（幂等）：一张在公共池里等到超时的订单，用户点开订单列表
  // 就该看到它已经退款，而不是「等待接单」——那会让人以为还有希望。
  // 放在查询**之前**，而且是不带 await 的同步调用（见全局约束 13）
  materializeDispatchTimeouts();

  const page = await withMockDebug(params, surface, () =>
    getPaymentRepository().queryOrders({ ...parsed.query, userId }),
  );

  return { ...page, items: page.items.map(toOrderListItem) };
}

/**
 * 把已经到点的派单写成事实。
 *
 * ⚠️ 这是**临时**的推进方式（决策 D1「deadline driven + lazy materialization」）：
 * 超时不是被定时触发的，而是**到点就已经成立**，读取路径只是恰好把它写下来。
 * 真实支付上线前必须换成后台调度器调用**同一个** `sweepExpiredDispatches()`
 * （见整改计划 TD-1）——**不是**另写一套超时退款逻辑。
 *
 * ⚠️ 用 `new Date()` 而不是进程基准时间：超时是**真实时间**的事，
 * 与「Mock 种子基准时间」无关（后者只用于让预置数据看起来新鲜）。
 */
function materializeDispatchTimeouts(): void {
  sweepExpiredDispatches(new Date().toISOString());
}

/**
 * 读取当前用户的单个订单。
 *
 * 订单不存在、或不属于当前用户，一律返回 null——**两种情况的对外表现完全相同**，
 * 调用方据此返回同一个 404，从而不能拿别人的订单 id 来试探它是否存在。
 *
 * 详情在这里一次性拼好订单本身的字段与三个售后摘要、可执行动作：
 * 页面与接口都拿不到「半成品」详情，也就不存在某一处忘了算权限、或者自己去推断权限的问题。
 * 三个摘要的查询都按订单 id 走（退款 / 投诉 / 会话各自带归属校验），因此不会串到别人的数据。
 */
export async function getOrderDetailForUser(
  orderId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<OrderDetail | null> {
  if (!orderId) return null;

  materializeDispatchTimeouts();

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) return null;

  const refund = await getRefundRepository().findRefundByOrderId(order.id);
  const complaintStats = await getComplaintRepository().summarizeComplaintsByOrder(order.id);
  // 评价与退款一样属于「这一单做过什么」，因此按订单 id 查（并按用户隔离）
  const review = await getReviewRepository().findReviewByOrderId(userId, order.id);

  // 会话不存在时摘要为 null（页面上不显示「订单沟通」的进度），存在就带上未读数
  const conversation = await getMessageRepository().findConversation(userId, order.id);
  const conversationSummary = conversation
    ? buildConversationStats(
        conversation,
        await getMessageRepository().listMessages(userId, order.id),
      )
    : null;

  // 派单进度：还在等人接就带上「现在在哪个池、还剩多久」，其余为 null。
  // 退款订单在种子里没有派单记录，管理员手动退款也不动派单记录，因此必须容忍查不到
  const dispatch = await getDispatchRepository().findDispatchByOrderId(order.id);
  const progress = dispatch ? toDispatchProgress(dispatch, new Date().toISOString()) : null;

  return toOrderDetail(order, {
    dispatchProgress: progress
      ? { ...progress, poolLabel: DISPATCH_POOL_LABELS[progress.pool] }
      : null,
    refundSummary: refund ? toRefundSummary(refund) : null,
    complaintSummary: toOrderComplaintSummary(complaintStats),
    conversationSummary,
    reviewSummary: review ? toReviewSummary(review) : null,
    allowedActions: {
      // 退款相关由退款规则统一算：既看订单状态，也看这一单有没有退款申请
      ...buildRefundActions(order, refund),
      // 评价同样由评价规则统一算：已完成、未评价、且没有进行中 / 已通过的退款
      ...buildReviewActions(order, review, refund),
      // 自己的订单一律可以沟通、可以投诉：投诉不会自动退款，也不改订单状态
      canOpenConversation: true,
      canSubmitComplaint: true,
    },
  });
}
