import { ORDER_STATUSES, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import type { AdminOrderDetail, AdminOrderListItem, Order, OrderStatus } from "@/lib/types/order";
import type { AdminUserSummary } from "@/lib/types/user";
import { formatDateTime } from "@/lib/utils/format";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「全量订单」的筛选规则、排序与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./orders`、`./pagination` 与 `lib/utils/format.ts`（都是纯函数）外
 * 没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 三条规则写在这里，是本阶段新增的**唯一**落点：
 *
 * 1. **筛选与排序的口径**：状态、游戏、时间范围、关键词四类条件，加一条稳定排序。
 *    列表页与接口都调这里的函数，因此「页面看到的」与「接口返回的」不会分叉。
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

// ——————————————————————————— 关键词 / 游戏 / 日期 ———————————————————————————

/**
 * 关键词：只去首尾空格。
 *
 * **不设长度上限、也不截断**：搜索词不是业务枚举，写长了不会造成任何危害
 * （最坏的结果是查不到东西，而那是能被看见的）。与入驻审核同一处理。
 */
export function readAdminOrderKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

/**
 * 订单里出现过的游戏名，去重并按名称排序。
 *
 * ⚠️ 筛选项**取自订单数据**，不是当前的商品目录：
 * - 目录里新增了一个游戏、但一单都还没有时，把它放进筛选栏只会得到一次必然为空的查询；
 * - 反过来，某个游戏后来下架了，历史订单仍然要能按它筛出来——那正是后台要查的东西。
 *
 * 排序用 `localeCompare` 的中文顺序，让人在筛选栏里找得到；顺序稳定因此可复现。
 */
export function orderGameNames(orders: readonly Order[]): string[] {
  const names = new Set<string>();
  for (const order of orders) {
    const name = order.gameName.trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 严格读取游戏筛选：必须是订单里出现过的游戏名。空值表示「全部游戏」。 */
export function readAdminOrderGame(raw: string | null, knownGames: readonly string[]): string | null {
  const value = (raw ?? "").trim();
  if (!value) return "";
  return knownGames.includes(value) ? value : null;
}

/**
 * 日期筛选：只接受 `YYYY-MM-DD`。
 *
 * 用固定正则而不是 `Date.parse`：后者会接受 `2026/9/1`、`Sep 1 2026` 这类写法，
 * 而它们在地址栏里与页面展示的格式对不上，出了问题没人能一眼看出是哪个参数。
 * 空值表示不限。
 */
const ADMIN_ORDER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function readAdminOrderDate(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!ADMIN_ORDER_DATE_PATTERN.test(value)) return null;
  // 正则只保证形状；`2026-13-45` 这种也要挡住。构造出的日期回读不一致即视为非法
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

/**
 * 订单创建时间落在北京时间的哪一天（`YYYY-MM-DD`）。
 *
 * 与页面展示口径一致（`formatDateTime` 固定 UTC+8）：用户在列表上看到「2026-09-12」，
 * 按 9-12 筛就应该筛得到它。用本地时区或 UTC 都会出现「显示 09-12、却被 09-13 筛掉」。
 */
export function orderBeijingDate(order: Pick<Order, "createdAt">): string {
  return formatDateTime(order.createdAt).slice(0, 10);
}

/** 订单创建时间是否落在 [from, to] 区间内（含两端，北京时间的自然日）。空串表示该侧不限。 */
export function orderInDateRange(
  order: Pick<Order, "createdAt">,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  const date = orderBeijingDate(order);
  // 时间戳坏掉时按「不在范围内」处理：它本来也没法按日期归属，放进任何一次筛选都是错的
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
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
    from: readAdminOrderDate(input.params.get("from")) ?? "",
    to: readAdminOrderDate(input.params.get("to")) ?? "",
    page: clampPage(input.params.get("page"), ADMIN_ORDER_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_ORDER_PAGE_SIZE,
      ADMIN_ORDER_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * 默认排序：**创建时间倒序**，同一时间按支付时间、再按 id 兜底。
 *
 * 兜底那两层不是可有可无的：预置数据里就有时间戳相同的订单，顺序不确定会让同一条
 * 在第一页出现过、翻到第二页又出现一次。三层比较保证同一份数据每次排出来的顺序**完全一致**。
 *
 * ⚠️ 与用户端的 `compareOrdersNewestFirst`（按支付时间）不同，这里按**创建时间**：
 * 后台要回答的是「这段时间进来了哪些单」，而时间范围的筛选也是按创建时间算的——
 * 排序的字段与筛选的字段必须是同一个，否则「筛 9 月、排出来按 8 月的时间交错」会很难解释。
 */
export function compareOrdersForAdmin(
  a: Pick<Order, "createdAt" | "paidAt" | "id">,
  b: Pick<Order, "createdAt" | "paidAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.paidAt !== b.paidAt) return a.paidAt < b.paidAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 关键词是否命中：**订单号 / 商品名称 / 用户昵称 / 平台展示 ID** 四处任一包含即可。
 *
 * 这四处正是客服手里能拿到的东西——用户打电话来报的要么是订单号，要么是「我的昵称」，
 * 要么是资料页上那串 ID。备注与游戏账号**不参与搜索**：那是内容不是标识，
 * 用它搜出来的结果没人能预期，而且备注里可能有用户写的隐私信息。
 */
export function orderMatchesAdminKeyword(
  input: {
    orderNo: string;
    productTitle: string;
    /** 用户昵称；用户记录缺失时为空串 */
    nickname: string;
    /** 平台展示 ID；用户记录缺失时为空串 */
    displayId: string;
  },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.orderNo.toLowerCase().includes(needle) ||
    input.productTitle.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle) ||
    input.displayId.toLowerCase().includes(needle)
  );
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
 * 详情所需的四份售后摘要与时间轴，由服务层查好传进来（与用户端 `OrderDetailExtras` 同理：
 * 「订单本身长什么样」与「这一单做过什么」分开）。
 */
export type AdminOrderDetailExtras = Pick<
  AdminOrderDetail,
  | "timeline"
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
    companion: order.companion,
    ...extras,
  };
}
