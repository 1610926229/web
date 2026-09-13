import { ApiError } from "@/lib/api/ApiError";
import { ORDER_STATUS_LABELS, parseOrderListQuery } from "@/lib/constants/orders";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { PageResult } from "@/lib/types/common";
import type {
  Order,
  OrderDetail,
  OrderListItem,
  OrderStatus,
  OrderTimelineEntry,
} from "@/lib/types/order";

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

function buildTimeline(order: Order): OrderTimelineEntry[] {
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

/** 订单 → 详情。游戏 ID 与备注只在这里出现，且只返回给订单所属用户。 */
export function toOrderDetail(order: Order): OrderDetail {
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
    timeline: buildTimeline(order),
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

  const page = await withMockDebug(params, surface, () =>
    getPaymentRepository().queryOrders({ ...parsed.query, userId }),
  );

  return { ...page, items: page.items.map(toOrderListItem) };
}

/**
 * 读取当前用户的单个订单。
 *
 * 订单不存在、或不属于当前用户，一律返回 null——**两种情况的对外表现完全相同**，
 * 调用方据此返回同一个 404，从而不能拿别人的订单 id 来试探它是否存在。
 */
export async function getOrderDetailForUser(
  orderId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<OrderDetail | null> {
  if (!orderId) return null;

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) return null;

  return toOrderDetail(order);
}
