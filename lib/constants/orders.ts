import type { PageResult } from "@/lib/types/common";
import type { Order, OrderListItem, OrderStatus } from "@/lib/types/order";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 订单列表的筛选、搜索与分页规则。
 *
 * 这里的每一条规则**服务端与浏览器共用**：订单页首屏由 Server Component 取数，
 * 切换状态 / 搜索 / 加载更多由浏览器经 `/api/orders` 取数，两侧都调用 `parseOrderListQuery`，
 * 因此「页面看到的」与「接口返回的」不会出现两套口径。
 *
 * ⚠️ 本文件只有 `import type`（编译后完全消失）+ 常量表 + 纯函数，
 * 没有任何运行时依赖，**因此仍然可以被客户端组件引用**
 * （不会把服务端模块打进浏览器产物），也可以被 node 直接加载做纯逻辑测试。
 * ⚠️ 新增内容时必须保持这一点：这里**不得**出现任何运行时的 `import`。
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

// ——————————————————————————— 打手侧展示状态（P0-15） ———————————————————————————

/**
 * 打手侧看到的订单状态，**与订单真实生命周期分开**。
 *
 * ## 它回答的问题与 `Order.status` 不同
 *
 * `Order.status` 回答「这一单履约到哪一步了」，是**事实**；
 * 打手侧展示状态回答「站在这位打手的位置上，这一单现在该怎么称呼」，是**口径**。
 * 一单被部分退款（10%）之后，履约还在继续（`serving` / `completed`），
 * 但打手这一单的钱**已经全部取消了**——他必须立刻看到「已退款」，
 * 否则他会继续按「这一单还能挣到钱」来安排自己的时间。
 *
 * ## 判定
 *
 * `refundedAmount > 0` ⇒ `refunded`，否则照抄真实状态。
 *
 * ⚠️ **为什么用 `refundedAmount` 而不是查退款申请**：它是订单上的冻结快照字段，
 * 由 `applyOrderRefund` 这个**唯一**的资金写入口维护（三条退款路径都经过它），
 * 因此「已执行过一次退款」这个事实在订单上就是自足的——不必再跨域查一次退款域，
 * 也就不会出现「订单说退过、退款表说没有」这种两份真值对不上的局面。
 * 金额为 0 的退款在服务端构造上不存在（`assertRefundAmountWithinPaid` 拒绝 0%），
 * 所以「> 0」与「退过一次」严格等价。
 *
 * ⚠️ **全额退款时这个函数与真实状态给出同一个答案**（`refunded` → `refunded`），
 * 因此它是**幂等**的：百分之百退款那条路上，展示状态不是「另一个状态」，
 * 只是恰好相同。这正是规则里「部分与全额在打手端看起来一样」的实现方式。
 *
 * ⚠️ **它绝不参与任何权限或可写性判断**。聊天的可写性看的是**真实订单状态**
 * （`isOrderChatClosed`），不是它——「打手看到已退款就锁掉沟通」会让部分退款的
 * 售后沟通在最需要的时候断掉。
 */
export function resolveCompanionDisplayStatus(
  order: Pick<Order, "status" | "refundedAmount">,
): OrderStatus {
  return order.refundedAmount > 0 ? "refunded" : order.status;
}

/** 「本单收益」这个词在打手端出现的地方只有一处，文案也只有一份。 */
export const COMPANION_ORDER_INCOME_LABEL = "本单收益";

/**
 * 已退款时限额外说一句「为什么是 0」。
 *
 * 只写数字的话，打手看到「本单收益 ¥0.00」时的第一反应是「是不是算错了」——
 * 他需要知道这是**退款的必然结果**，与退款比例无关（10% 也是 0）。
 *
 * ⚠️ **它只挂在退款那一侧**：未退款的订单不该出现这句话，
 * 而当订单还没有收益记录时（尚未完成）这一行根本不渲染——
 * `null` 是「这笔账还没产生」，`0` 是「产生了、但一分不剩」，
 * 把两者合并成一句「¥0」会让尚未完成的订单看起来像被退款了。
 */
export const COMPANION_ORDER_INCOME_REFUNDED_NOTE = "已退款，本单收益全部取消";

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 订单状态迁移表。**这是 `Order` 状态机唯一的定义处。**
 *
 * 键集合由 `Record<OrderStatus, …>` 保证与 `ORDER_STATUSES` 的五个状态一一对应。
 * 终态写空数组而不是省略：`Record` 要求每个状态都出现，
 * 将来新增一个状态时，漏掉它的迁移规则会直接编译不过。
 *
 * ⚠️ 它只回答「这种迁移在**结构上**是否允许」，**不是业务 Guard，
 * 也不得被用来绕过 Guard**：
 * - `paid → accepted` 仍必须满足 Dispatch 合法 / 未过 deadline / Companion 资格 /
 *   禁止给自己下单 / `enabled` 与 `available` / 并发下的原子抢单，
 *   这些判断全在 `acceptDispatch` 的原子区段里做；
 * - `accepted → paid` 仍必须满足「当前 `actualCompanionId` 就是本人」且状态恰好是
 *   `accepted`、必须填原因、必须原子地写退出历史 + 清履约绑定 + 派单回公共池 + 通知用户，
 *   这些判断全在 `cancelAcceptedOrder` 的原子区段里做；
 * - `serving → completed` 将来仍必须满足完成材料已提交 + 客服审核通过；
 * - `completed → refunded` 只能通过合法的投诉 / 售后 / 退款流程进入，
 *   **不得因为表允许就提供一个按钮**。
 *
 * 因此「只要状态表允许就可以直接改状态」是**明确错误**的用法：
 * 表允许只说明这个迁移在结构上讲得通，能不能做要由领域 Guard 回答。
 *
 * ## 两条回到 `paid` 的路径：**都有真实入口了**（P0-11 起）
 *
 * 表里出现的 `accepted → paid` 与 `serving → paid` 是 V0.3 需求确认的回池结构关系。
 * P0-6 先接上了前者（打手主动取消接单），P0-11 接上后者——
 * 封禁回池（`companion_disabled`）与客服换人（`staff_reassign`）两条入口，
 * 两者都**同时**作用于 `accepted` 与 `serving`，因此这张表里的两条边各自都有了调用方。
 *
 * ⚠️ 但这**不改变**「表不代替 Guard」：`serving → paid` 的合法入口只有
 * 「封禁 / 客服换人」两件事，且都必须原子地写退出历史 + 清履约绑定（含 `servingAt`）
 * + 派单回公共池 + 作废该打手那份 pending 完成材料 + 通知用户
 * （见 `lib/data/companionOrderTransaction.ts`）。**打手本人**在 `serving` 阶段
 * 仍然没有任何主动退出路径——表里有这条边，不构成给打手开一个按钮的理由。
 *
 * ## ⚠️ 结构上不存在 `serving → accepted`
 *
 * 「客服换人」在原单处于 `serving` 时的落点是 `serving → paid → accepted`
 * （同一段无 `await` 的同步代码内连续两次写入，中间态不暴露给并发抢单），
 * 而**不是**一条 `serving → accepted` 的直达边。新增那条边会让「更换护航」
 * 看起来像一次无代价的字段改写，从而把「必须先解除旧绑定」这件事从状态机里抹掉。
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  paid: ["accepted", "refunded"],
  accepted: ["paid", "serving", "refunded"],
  serving: ["paid", "completed", "refunded"],
  completed: ["refunded"],
  refunded: [],
};

/**
 * 这次迁移在结构上是否允许。
 *
 * `from === to` 一律返回 `false`——那不是一个「迁移」。
 * `includes` 天然满足这一点：表里没有任何自环（见 `ORDER_TRANSITIONS`）。
 *
 * ⚠️ 返回 `true` **不代表**这次写入合法：业务 Guard 仍须单独满足，
 * 理由见 `ORDER_TRANSITIONS` 的注释。
 */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

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
 * 通用规则在 `lib/constants/pagination.ts`，这里只是把订单自己的上限固定下来，
 * 列表行为与之前完全一致；投诉列表用的是同一个实现，不会出现两套页码口径。
 */
export function normalizePage(raw: string | null): number {
  return clampPage(raw, ORDER_MAX_PAGE);
}

/** 每页条数规范化：缺失 / 非数字 / 小于 1 用默认值，超过上限按上限处理。 */
export function normalizePageSize(raw: string | null): number {
  return clampPageSize(raw, ORDER_PAGE_SIZE, ORDER_MAX_PAGE_SIZE);
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
 * 订单列表的「加载更多」合并。
 *
 * 通用规则在 `lib/constants/pagination.ts` 的 `mergePageResult`，
 * 订单列表与投诉列表因此共用同一套「追加 + 去重」行为。
 */
export function mergeOrderPage(
  current: PageResult<OrderListItem>,
  next: PageResult<OrderListItem>,
): PageResult<OrderListItem> {
  return mergePageResult(current, next);
}
