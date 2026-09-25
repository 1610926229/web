import { ORDER_STATUSES, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import type { AdminOrderDetail, AdminOrderListItem, Order, OrderStatus } from "@/lib/types/order";
import type { AdminUserSummary } from "@/lib/types/user";
import { readOrderFilterDate } from "./orderFilters";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 七个**与身份无关**的订单筛选 / 搜索 / 排序纯函数已上移到 `./orderFilters`，
 * 因为客服端（P0-10）原样需要它们，而在客服侧另写一份就是第二套实现。
 *
 * 这里按**原来的名字** re-export：既有引用点（`lib/services/adminOrders.ts`、
 * `lib/data/mockPaymentRepository.ts`、`tests/adminOrders.test.mjs`）一个都不用改。
 * 新代码请直接从 `./orderFilters` 引用共享实现。
 */
export {
  compareOrdersByCreatedAt as compareOrdersForAdmin,
  orderBeijingDate,
  orderGameNames,
  orderInDateRange,
  orderMatchesKeyword as orderMatchesAdminKeyword,
  readOrderFilterDate as readAdminOrderDate,
  readOrderFilterGame as readAdminOrderGame,
} from "./orderFilters";

/**
 * 管理端「全量订单」的筛选规则、排序与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./orders`、`./orderFilters` 与 `./pagination`（都是纯函数）外
 * 没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ 「游戏 / 时间范围 / 关键词 / 创建时间倒序」这**四类**（由**七个**函数实现）
 * **与身份无关**的规则已上移到 `./orderFilters`（客服端同样需要，在别处再写一份
 * 就是第二套实现）。本文件按原名 re-export 它们，引用点因此不受影响。
 *
 * 留在这里的是**管理端自己的**口径（客服端有自己的一份，两者的文案与字段表刻意不同）：
 *
 * 1. **状态筛选与关键词的规范化**：`status` 是管理端独有的筛选维度（客服端不用它），
 *    非法值报 400 还是回落默认，也由各端自己决定；
 *    ⚠️ 关键词的**匹配规则**（匹配哪四个字段）已经共享，这里只剩读取与去空白。
 * 2. **列表与详情是两个 DTO**：`toAdminOrderListItem` 刻意丢掉游戏账号、备注、
 *    增值服务明细与四份售后摘要——列表一次返回多条，它们只属于详情页。
 * 3. **订单详情是只读的**：这里没有任何「改状态 / 改金额 / 改商品」的转换函数，
 *    DTO 上也没有 `allowedActions` 字段。本阶段唯一会写订单的是退款审核通过，
 *    而那个动作的入口在退款审核页，不在订单页（见 §订单管理）。
 *
 * ⚠️ 游戏筛选按**下单时的游戏名快照**（`Order.gameName`）匹配，不按目录里的游戏 id：
 * 订单里根本没有游戏 id。这一点同时决定了筛选项的来源——见 `orderGameNames()`。
 */

export const ADMIN_ORDER_LIST_TITLE = "全量订单";
export const ADMIN_ORDER_DETAIL_TITLE = "订单详情";

/** 列表默认每页条数。后台是 PC 宽屏，比用户端一页多放几条。 */
export const ADMIN_ORDER_PAGE_SIZE = 20;
export const ADMIN_ORDER_MAX_PAGE_SIZE = 100;
export const ADMIN_ORDER_MAX_PAGE = 1000;

/** 列表顶部的说明：讲清楚这张列表的口径。 */
export const ADMIN_ORDER_LIST_NOTICE =
  "列表按创建时间倒序，涵盖全部用户的订单。订单在支付成功那一刻生成，因此这里没有「待付款」；" +
  "支付失败与取消只留下支付请求记录，不会出现在本列表中。";

/**
 * 支付请求不进订单列表的说明。
 *
 * §订单管理 明确要求「后台可以查看内部支付请求，但不能把它混入普通订单列表」。
 * 本阶段的做法是**根本不提供支付请求的列表接口**：支付请求里只有幂等键、
 * 金额与渠道结果，没有商品与用户可读的信息，混进订单列表只会让人以为多了一批「奇怪的订单」。
 * 这一句同时是给运营看的解释——否则「我明明看到有人支付失败过，怎么列表里没有」会变成一个疑问。
 */
export const ADMIN_ORDER_PAYMENT_NOTICE =
  "支付失败与取消只留下支付请求记录：它们不是订单，因此不出现在这里，也没有单独的列表入口。";

/**
 * 详情页的只读说明。
 *
 * 必须写在页面上，而不只是写在类型里：看到订单详情的人很容易顺手找「改状态」的按钮。
 */
export const ADMIN_ORDER_READONLY_NOTICE =
  "订单详情为只读视图。本阶段不提供修改订单状态、金额、商品或用户信息的入口；" +
  "订单唯一会被后台改动的路径是「退款审核通过」，入口在退款审核页。";

/** 列表为空时的提示。 */
export const ADMIN_ORDER_EMPTY_MESSAGE = "当前筛选下没有订单。";

/**
 * 列表底部的字段边界说明。
 *
 * 必须写在列表上，而不是只在代码里裁字段：看到列表的人会去找「这一单的备注写了什么」，
 * 得让他知道要去详情页，而不是以为数据没采到。
 */
export const ADMIN_ORDER_LIST_FIELDS_NOTE =
  "列表不展示游戏账号、备注、增值服务明细与售后摘要；这些内容只在详情页可见。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const ADMIN_ORDER_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / paid / accepted / serving / completed / refunded";
export const ADMIN_ORDER_GAME_INVALID_MESSAGE = "筛选条件 game 不是订单里出现过的游戏";
export const ADMIN_ORDER_DATE_INVALID_MESSAGE = "筛选条件 from / to 必须是 YYYY-MM-DD 格式的日期";
export const ADMIN_ORDER_DATE_RANGE_INVALID_MESSAGE = "开始日期不能晚于结束日期";

/** 目标订单不存在时的提示。与接口 404 的 message 同源。 */
export const ADMIN_ORDER_NOT_FOUND_MESSAGE = "订单不存在";

// ——————————————————————————— 状态筛选 ———————————————————————————

/**
 * 状态筛选。`all` 表示不限。
 *
 * ⚠️ 这里**只有五个状态**，与用户端一致：没有 `pending_payment`。
 * 订单在支付成功那一刻生成，「待付款」不是一个订单状态，而是一个尚未成立的支付请求。
 */
export type AdminOrderStatusFilter = OrderStatus | "all";

export const ADMIN_ORDER_STATUS_FILTERS: readonly AdminOrderStatusFilter[] = [
  "all",
  ...ORDER_STATUSES,
];

export const ADMIN_ORDER_STATUS_FILTER_LABELS: Record<AdminOrderStatusFilter, string> = {
  all: "全部",
  ...ORDER_STATUS_LABELS,
};

/**
 * 默认筛选：**全部**。
 *
 * 与入驻审核默认「待查看」不同：那个页面的用途是处理待办，而这个页面是**查询**，
 * 打开就限定成某一类会让「我这一单呢」变成一个需要先想清楚状态才查得到的问题。
 */
export const DEFAULT_ADMIN_ORDER_STATUS_FILTER: AdminOrderStatusFilter = "all";

export function isAdminOrderStatusFilter(value: string): value is AdminOrderStatusFilter {
  return (ADMIN_ORDER_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readAdminOrderStatusFilter(
  raw: string | null,
): AdminOrderStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_ORDER_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_ORDER_STATUS_FILTER;
  return isAdminOrderStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminOrderStatusFilter(raw: string | null): AdminOrderStatusFilter {
  return readAdminOrderStatusFilter(raw) ?? DEFAULT_ADMIN_ORDER_STATUS_FILTER;
}

// ——————————————————————————— 关键词 / 游戏 ———————————————————————————

/**
 * 关键词：只去首尾空格。
 *
 * **不设长度上限、也不截断**：搜索词不是业务枚举，写长了不会造成任何危害
 * （最坏的结果是查不到东西，而那是能被看见的）。与入驻审核同一处理。
 */
export function readAdminOrderKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

// ——————————————————————————— 列表查询 ———————————————————————————

/**
 * 管理端订单列表查询条件（已解析、已校验）。
 *
 * 排序**不是参数**：默认（也是唯一）的排序是按创建时间倒序，见 `compareOrdersForAdmin`。
 */
export type AdminOrderListQuery = {
  /** `all` 表示不限状态 */
  status: AdminOrderStatusFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  /** 游戏名；空串表示全部游戏 */
  game: string;
  /** 起始日期 `YYYY-MM-DD`（含当天）；空串表示不限 */
  from: string;
  /** 结束日期 `YYYY-MM-DD`（含当天）；空串表示不限 */
  to: string;
  page: number;
  pageSize: number;
};

export function buildAdminOrderListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: AdminOrderStatusFilter;
  /** 已经解析好的游戏筛选；空串表示全部游戏 */
  game: string;
}): AdminOrderListQuery {
  return {
    status: input.status,
    keyword: readAdminOrderKeyword(input.params.get("keyword")),
    game: input.game,
    // 日期在解析阶段已经校验过（严格模式非法即 400，宽松模式回落到空串）
    from: readOrderFilterDate(input.params.get("from")) ?? "",
    to: readOrderFilterDate(input.params.get("to")) ?? "",
    page: clampPage(input.params.get("page"), ADMIN_ORDER_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_ORDER_PAGE_SIZE,
      ADMIN_ORDER_MAX_PAGE_SIZE,
    ),
  };
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 内部实体 → 管理端列表项。
 *
 * ⚠️ **显式挑字段**，不是 `{ ...order }` 再删几个：游戏账号、备注、增值服务明细
 * 与四份售后摘要因此默认不会外流——只有写在这里的字段才会被浏览器看到。
 *
 * 用户摘要由服务层查好传进来（仓储里订单只带 `userId`）：`nickname` 与 `displayId`
 * 是搜索命中的两个字段，列表上也要显示出来，否则「搜到了但看不出来为什么搜到」。
 */
export function toAdminOrderListItem(order: Order, user: AdminUserSummary): AdminOrderListItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
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
 * 详情所需的四份售后摘要、时间轴与「用户指定了谁」，由服务层查好传进来
 * （与用户端 `OrderDetailExtras` 同理：「订单本身长什么样」与「这一单做过什么」分开）。
 *
 * ⚠️ `exclusiveCompanion` 在 extras 里而 `actualCompanion` 不在，是因为前者**不在订单上**：
 * 它要从派单记录里取 `exclusiveCompanionId`，再用护航 id 换一份公开信息快照——
 * 那是仓储查询，而本文件只做纯转换（它同时被浏览器端引用，不能碰 `lib/data`）。
 */
export type AdminOrderDetailExtras = Pick<
  AdminOrderDetail,
  | "timeline"
  | "exclusiveCompanion"
  | "releaseHistory"
  | "refundSummary"
  | "complaintSummary"
  | "conversationSummary"
  | "reviewSummary"
>;

/** 内部实体 → 管理端详情。在列表项之上补齐游戏账号、备注、金额明细与四份摘要。 */
export function toAdminOrderDetail(
  order: Order,
  user: AdminUserSummary,
  extras: AdminOrderDetailExtras,
): AdminOrderDetail {
  return {
    ...toAdminOrderListItem(order, user),
    region: order.region,
    gameAccountId: order.gameAccountId,
    remark: order.remark,
    productCoverUrl: order.productCoverUrl,
    unitPrice: order.unitPrice,
    itemsAmount: order.itemsAmount,
    addonsAmount: order.addonsAmount,
    addons: order.addons,
    // 订单上只记着「谁在履约」；「用户当初指定了谁」在 extras 里（来自派单记录）
    actualCompanion: order.companion,
    ...extras,
  };
}
