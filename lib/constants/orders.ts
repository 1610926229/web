import type { PageResult } from "@/lib/types/common";
import type { Order, OrderListItem, OrderStatus } from "@/lib/types/order";

/**
 * 订单列表的筛选、搜索与分页规则。
 *
 * 这里的每一条规则**服务端与浏览器共用**：订单页首屏由 Server Component 取数，
 * 切换状态 / 搜索 / 加载更多由浏览器经 `/api/orders` 取数，两侧都调用 `parseOrderListQuery`，
 * 因此「页面看到的」与「接口返回的」不会出现两套口径。
 *
 * ⚠️ 本文件只有 `import type`（编译后完全消失），没有任何运行时依赖，
 * 因此可以被客户端组件引用（不会把服务端模块打进浏览器产物），
 * 也可以被 node 直接加载做纯逻辑测试。
 */

/** 五个用户端状态，顺序与 Tab 一致。`全部` 是查询条件，不在其中。 */
export const ORDER_STATUSES: readonly OrderStatus[] = [
  "paid",
  "accepted",
  "serving",
  "completed",
  "refunded",
];

/** 状态中文名。**唯一一份**，接口与页面都用它，避免两边文案漂移。 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  paid: "已付款",
  accepted: "已接单",
  serving: "护航中",
  completed: "已完成",
  refunded: "已退款",
};

/**
 * 状态的文字色映射。
 *
 * 颜色值全部来自 `app/globals.css` 的 `--color-status-*` 令牌，
 * 这里只做「状态 → 令牌类名」的对应，页面与卡片不再各自写颜色。
 */
export const ORDER_STATUS_CLASS: Record<OrderStatus, string> = {
  paid: "text-status-paid",
  accepted: "text-status-accepted",
  serving: "text-status-serving",
  completed: "text-status-completed",
  refunded: "text-status-refunded",
};

/**
 * 状态的一句话说明，详情页状态区使用。
 * 只描述**当前发生了什么**，不包含退款 / 投诉 / 联系客服等本阶段尚未实现的入口。
 */
export const ORDER_STATUS_HINTS: Record<OrderStatus, string> = {
  paid: "已付款，正在等待打手接单。",
  accepted: "打手已接单，即将开始护航。",
  serving: "护航进行中，请留意打手消息。",
  completed: "本次护航已完成。",
  refunded: "本次订单已退款，金额与商品信息已保留。",
};

/** 列表页的 Tab：`all` 是查询条件，不是订单真实状态。 */
export type OrderTabKey = OrderStatus | "all";

export const ORDER_TABS: readonly { key: OrderTabKey; label: string }[] = [
  { key: "all", label: "全部" },
  ...ORDER_STATUSES.map((status) => ({ key: status, label: ORDER_STATUS_LABELS[status] })),
];

/** 列表默认每页条数。 */
export const ORDER_PAGE_SIZE = 10;

/** 每页条数上限：接口收到的 pageSize 一律收敛到这个范围内。 */
export const ORDER_MAX_PAGE_SIZE = 20;

/** 页码上限：超过就按上限处理，避免构造出天文数字的偏移量。 */
export const ORDER_MAX_PAGE = 1000;

/** 搜索关键字长度上限（订单号本身 16 位，32 足够容纳误粘贴）。 */
export const ORDER_KEYWORD_MAX_LENGTH = 32;

/** 状态取值不合法时的提示。**返回 400，不静默回退成「全部」**。 */
export const ORDER_STATUS_INVALID_MESSAGE = "订单状态筛选无效";

/** 搜索关键字超长时的提示。 */
export const ORDER_KEYWORD_TOO_LONG_MESSAGE = `搜索关键字不能超过 ${ORDER_KEYWORD_MAX_LENGTH} 个字符`;

/** 规范化后的查询条件：状态已判定、分页已收敛到安全范围。 */
export type OrderListQuery = {
  /** null 表示「全部」 */
  status: OrderStatus | null;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

export type OrderQueryParseResult =
  | { ok: true; query: OrderListQuery }
  | { ok: false; message: string };

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * 页码规范化：缺失 / 非数字 / 小于 1 一律回到第 1 页，超过上限按上限处理。
 *
 * 分页参数**规范化**而不是报错：页码不是用户填的业务内容，
 * 一个坏掉的页码让整页报错没有意义；而状态取值是明确的业务条件，
 * 写错必须报错（见 `parseOrderListQuery`），两者行为不同是刻意的。
 */
export function normalizePage(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.trunc(value), ORDER_MAX_PAGE);
}

/** 每页条数规范化：缺失 / 非数字 / 小于 1 用默认值，超过上限按上限处理。 */
export function normalizePageSize(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return ORDER_PAGE_SIZE;
  return Math.min(Math.trunc(value), ORDER_MAX_PAGE_SIZE);
}

/**
 * 解析并校验订单列表的查询条件。
 *
 * 规则：`status` 缺失或为空表示「全部」，给了非法值直接失败（不静默回退）；
 * `keyword` 去首尾空格、限长；`page` / `pageSize` 规范化到安全范围。
 */
export function parseOrderListQuery(params: URLSearchParams): OrderQueryParseResult {
  const rawStatus = (params.get("status") ?? "").trim();
  if (rawStatus && !isOrderStatus(rawStatus)) {
    return { ok: false, message: ORDER_STATUS_INVALID_MESSAGE };
  }

  const keyword = (params.get("keyword") ?? "").trim();
  if (keyword.length > ORDER_KEYWORD_MAX_LENGTH) {
    return { ok: false, message: ORDER_KEYWORD_TOO_LONG_MESSAGE };
  }

  return {
    ok: true,
    query: {
      status: rawStatus ? (rawStatus as OrderStatus) : null,
      keyword,
      page: normalizePage(params.get("page")),
      pageSize: normalizePageSize(params.get("pageSize")),
    },
  };
}

/**
 * 订单号匹配：支持完整订单号与部分订单号，忽略大小写。
 * 关键字应当已经去过首尾空格；空串视为「不过滤」。
 */
export function matchesOrderKeyword(orderNo: string, keyword: string): boolean {
  if (!keyword) return true;
  return orderNo.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * 列表默认排序：支付时间倒序，最新的订单在最前面。
 *
 * 支付时间相同时依次用创建时间与 id 兜底，保证同一份数据每次排出来的顺序**完全一致**
 * ——否则分页时可能出现某条订单在第一页出现过、第二页又出现一次。
 */
export function compareOrdersNewestFirst(a: Order, b: Order): number {
  if (a.paidAt !== b.paidAt) return a.paidAt < b.paidAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * 把「加载更多」取回的一页**并到已有列表后面**，并按订单 id 去重。
 *
 * 两件事都必须在这里做，页面才不会出问题：
 *
 * 1. **追加是合并，不是替换**。只把新一页赋值回去，前面几页会凭空消失——
 *    看起来像「加载更多把列表变短了」。
 * 2. **去重要兜住翻页期间的插入**。翻到第二页之前如果有一笔新订单进到最前面，
 *    后面几页会整体后移，同一笔订单可能在两页里各出现一次。这是偏移量分页固有的限制，
 *    接口按页返回数据，界面这一层负责不把重复的卡片画出来。
 *
 * 规则只写这一处：组件不自己拼数组，也就不会出现「某个列表忘了去重」。
 * 新一页的 `page` / `hasMore` / `total` 一律采用 `next` 的（它才代表最新一次请求的结果）。
 */
export function mergeOrderPage(
  current: PageResult<OrderListItem>,
  next: PageResult<OrderListItem>,
): PageResult<OrderListItem> {
  const seen = new Set(current.items.map((item) => item.id));
  return {
    ...next,
    items: [...current.items, ...next.items.filter((item) => !seen.has(item.id))],
  };
}
