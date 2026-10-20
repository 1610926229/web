import { ADMIN_APPLICATION_LIST_HREF, ADMIN_NAV_ITEMS } from "@/lib/constants/admin";
import { formatDateTime } from "@/lib/utils/format";
import type { Order } from "@/lib/types/order";
import type { RefundRequest } from "@/lib/types/refund";

/**
 * 管理后台**经营首页**（P1-1）的口径、文案与跳转地址。
 *
 * ⚠️ 本文件里**没有一行是「顺便算一下」**：三个「今日」数字与三个待办数字的判定规则
 * 全部作为**纯函数**写在这里，服务层只负责把仓储数据取回来喂进去。
 * 这样做的理由与 `countCompanionStates()` 完全一致——「这个数是怎么来的」只有一个出处，
 * 并且能在 node 测试里**不启服务、不碰 Mock 延迟**直接验证。
 *
 * ⚠️ 本文件**不读时钟、不读仓储、不写任何东西**。`businessDate` 由调用方（服务层）
 * 算好后传进来，因此同一个 `businessDate` 下这些函数是**确定性的**。
 *
 * ⚠️ 本文件除类型外只有 `formatDateTime` 一个运行时依赖，node 能直接加载它做纯逻辑测试，
 * 客户端组件引用它也不会把服务端模块打进浏览器产物。
 */

// ——————————————————————————— 业务日 ———————————————————————————

/**
 * 业务日键：某个时刻落在北京时间的哪一天（`YYYY-MM-DD`）。
 *
 * ⚠️ **刻意复用 `formatDateTime`**，而不是自己写一套偏移算术或被时区环境左右的
 * `toLocaleDateString`：
 *
 * - `formatDateTime` 是项目里**唯一**的时区实现（固定 UTC+8、不用 `Intl`、
 *   任何环境结果都相同，理由见 `lib/utils/format.ts`）；
 * - 管理端订单列表的日期筛选走的是**同一个口径**（`orderBeijingDate()` =
 *   `formatDateTime(...).slice(0, 10)`）。自定义第二套「今天」的算法，
 *   迟早会造出「列表里显示 09-27、经营概览却算到 09-26」这种自相矛盾的结果。
 *
 * 时刻解析不出来时返回空串：它归属不到任何一天，与任何业务日比较都不相等
 * （`"" === "2026-09-27"` 为假），因此**坏时间戳不会被算进今天**。
 */
export function beijingDateKey(iso: string): string {
  return formatDateTime(iso).slice(0, 10);
}

/** 某个时刻是否落在给定的业务日。空 `businessDate` 一律为否。 */
export function isOnBusinessDate(iso: string, businessDate: string): boolean {
  return businessDate !== "" && beijingDateKey(iso) === businessDate;
}

// ——————————————————————————— 今日经营 ———————————————————————————

/** 今日订单数与今日 GMV 的口径说明。 */
export const ADMIN_DASHBOARD_TODAY_NOTICE =
  "「今日」按北京时间（UTC+8）的自然日归属，与订单列表的日期筛选同一个口径；" +
  "订单数按支付成功时刻（paidAt）统计，因此支付成功过的订单即使当天被退款也仍计入，" +
  "GMV 也不会因为退款而回滚——退款单独体现在今日退款金额里。";

/**
 * 今日退款金额的口径说明。
 *
 * ⚠️ 这段文案是**直接渲染在页面上的纯文本**（`<p>{…}</p>`），React 不解析 Markdown，
 * 因此这里**不能**用 `**加粗**` 这类标记——它会原样显示成四个星号，用「」强调。
 *
 * ⚠️ 执行路径有**三条**（见下方 `computeTodayRefundAmount`）：用户直接退款、
 * 售后审核通过、公共池超时自动退款。它们只走**两个取数通道**，但文案说的是
 * 「实际退出去的钱」，因此按**路径**列举而不是按通道列举。
 */
export const ADMIN_DASHBOARD_REFUND_NOTICE =
  "今日退款金额按「退款发生的时刻」归属日期，而不是原订单的支付日期：" +
  "一笔昨天支付的订单今天退款，算今天的。它包含用户直接退款、售后审核通过、" +
  "公共池超时自动退款三条路径，逐笔按当天实际退出去的金额累加。";

/**
 * 订单的哪些事实参与「今日」计算。
 *
 * 收窄成 `Pick` 而不是整个 `Order`：这几个函数**不可能**碰到订单的其它字段
 * （更不可能碰到 `refundedAmount` 那个累计值——它是明令禁止的统计来源）。
 */
export type DashboardOrderFact = Pick<Order, "id" | "paidAt" | "actualPaidAmount" | "refundedAt">;

/** 今日经营的两个数字。金额单位为**分**（整数）。 */
export type DashboardTodayMetrics = {
  todayOrderCount: number;
  todayGmvAmount: number;
};

/**
 * 今日订单数与今日 GMV。
 *
 * ⚠️ **同一个谓词**同时决定这两件事（`isOnBusinessDate(order.paidAt, businessDate)`）：
 * 计数与金额必须来自**同一批订单**，否则「今日 GMV 除以今日订单数」这种最自然的追问
 * 会得出一个没有意义的数。
 *
 * ⚠️ **不按订单状态过滤**：`paidAt` 存在就说明这一单成功支付过。今天支付、
 * 今天又全额退款的订单**仍然计入今天**——GMV 是成交规模，不是净收入。
 */
export function computeTodayOrderMetrics(
  orders: readonly DashboardOrderFact[],
  businessDate: string,
): DashboardTodayMetrics {
  let todayOrderCount = 0;
  let todayGmvAmount = 0;

  for (const order of orders) {
    if (!isOnBusinessDate(order.paidAt, businessDate)) continue;
    todayOrderCount += 1;
    todayGmvAmount += order.actualPaidAmount;
  }

  return { todayOrderCount, todayGmvAmount };
}

/** 一笔退款**事件**：谁、什么时候、退了多少钱。 */
export type RefundEvent = {
  orderId: string;
  /** 退款实际发生的时刻 */
  at: string;
  /** 这一次退出去的金额（分） */
  amount: number;
};

/**
 * 全部「售后审核通过」的退款事件（跨订单，按事件时间）。
 *
 * ⚠️ 只有 `approved` **且** `decision !== null` 的记录才是真实发生过的退款：
 * 待审核 / 审核中还没有结论，已拒绝 / 已撤销一分钱都没退。
 * `refund.amount`（申请时的实付快照）**不在这里**——它不回答「最后退了多少」。
 */
export function listApprovedRefundEvents(refunds: readonly RefundRequest[]): RefundEvent[] {
  const events: RefundEvent[] = [];

  for (const refund of refunds) {
    if (refund.status !== "approved" || !refund.decision) continue;
    events.push({
      orderId: refund.orderId,
      at: refund.decision.decidedAt,
      amount: refund.decision.refundAmount,
    });
  }

  return events;
}

/**
 * 今日退款金额 = **今天实际执行成功的退款之和**。
 *
 * ## 三条执行路径，两个取数通道
 *
 * 钱是**三个地方**退出去的，但只有**两条**能从数据里被发现——
 * `applyOrderRefund` 全仓只有三个调用方，前两条都不写 `RefundRequest`：
 *
 * | 路径 | 写入点 | 有无 `RefundRequest` |
 * |---|---|---|
 * | 售后审核通过 | `lib/data/adminRefundTransaction.ts` | **有**（`status: approved` + `decision`） |
 * | 用户直接退款（`paid` / `accepted`） | `lib/data/directRefundTransaction.ts` | **没有** |
 * | 公共池超时自动退款 | `lib/data/companionDispatchTransaction.ts` | **没有** |
 *
 * 因此这里按**通道**取数，而不是按路径（`directRefundOrder` 注释里说的「不写退款记录」
 * 对超时退款同样成立）：
 *
 * 1. **售后审核通过**：逐条 `RefundRequest` 的 `decision.refundAmount` 按 `decidedAt` 归属。
 *    P0-15 一单一退之后，同一订单**至多一条**已通过的退款（①§一 / ①§八），
 *    所以遍历在今天的可达状态下至多累加一次。**遍历仍然留着**，因为它守的是
 *    **本函数自己的口径**（按 `decidedAt` 归属到自然日），而不是「至多一条」这个前提——
 *    上游哪天松了，这里不会开始重复计数。
 * 2. **不写退款记录的那两类**（直接退款 + 超时自动退款）：只能从订单那一侧发现，
 *    判据是 `order.refundedAt`。
 *
 * ⚠️ 第 2 类**不能**直接把 `order.refundedAt` 当成「全额退款」来计：售后链路退满时
 * **同样**会写 `refundedAt`（`applyOrderRefund` 在退满那一刻写它）。因此判据是
 * 「这张单有没有已通过的退款申请」：
 *
 * ```text
 * 订单侧增量 = actualPaidAmount − Σ 该订单已通过退款的 refundAmount
 * ```
 *
 * 减法的作用是**第 1 类算过的部分在这里不再算一遍**：
 *
 * - 整单由售后链路退的 ⇒ `Σ = actualPaidAmount` ⇒ 差额 0，第 1 类已计，跳过；
 * - 整单由无记录路径退的 ⇒ `Σ = 0`（这张单没有已通过的申请）⇒ 差额正是实付。
 *
 * ⚠️ **P0-15 后只可能是这两种极端，不再有中间量**：一单一退之下，一张出了款的单
 * 只可能是「一次退满」，而 `refundedAt` 又**只在退满那一刻**写
 * （`applyOrderRefund` 的 `fullyRefunded ? (order.refundedAt ?? at) : …`）。
 * 于是「先部分退款、再走无记录路径补尾差」这条老路径不可达，
 * 差额不是 0 就是实付。公式本身不受影响，**不必也不该**据此化简。
 *
 * ⚠️ **全程不读 `Order.refundedAmount`**（那个累计值）：它在跨日多次退款时会重复计数，
 * 是指令 §3.3 明令不得用于统计的字段。这里只读 `actualPaidAmount`（成交额）与
 * **逐事件的**退款金额。
 */
export function computeTodayRefundAmount(
  refunds: readonly RefundRequest[],
  orders: readonly DashboardOrderFact[],
  businessDate: string,
): number {
  const events = listApprovedRefundEvents(refunds);

  let total = 0;
  const approvedByOrder = new Map<string, number>();

  for (const event of events) {
    approvedByOrder.set(event.orderId, (approvedByOrder.get(event.orderId) ?? 0) + event.amount);
    if (isOnBusinessDate(event.at, businessDate)) total += event.amount;
  }

  for (const order of orders) {
    // 没有 refundedAt ⇒ 没退满 ⇒ 不可能是一次直接退款
    if (!order.refundedAt) continue;
    if (!isOnBusinessDate(order.refundedAt, businessDate)) continue;

    const directAmount = order.actualPaidAmount - (approvedByOrder.get(order.id) ?? 0);
    if (directAmount > 0) total += directAmount;
  }

  return total;
}

// ——————————————————————————— 当前待办 ———————————————————————————

/**
 * 三个待办数的**口径不在这里定义**——它们在各自领域的常量文件里，一处一个：
 *
 * | 领域 | 状态集合 | 定义处 |
 * |---|---|---|
 * | 入驻申请 | `OPEN_APPLICATION_STATUSES` | `lib/constants/adminApplications.ts` |
 * | 退款 | `OPEN_REFUND_STATUSES` | `lib/constants/refunds.ts` |
 * | 投诉 | `OPEN_COMPLAINT_STATUSES` | `lib/constants/complaints.ts` |
 *
 * ⚠️ **本文件曾经自己存过一份 `PENDING_*_STATUSES`，P1-1 的 R6 裁定把它删掉了。**
 * 那三个常量与各列表模块的状态集合是同一个概念的两份定义——首页按其中一份数、
 * 列表按另一份筛，于是出现了「卡上 2/4/3、点进去 1/3/1」。
 * 「同一规则两处实现」正是 `architecture-rules.md` 点名禁止的，删掉一份才算修好。
 *
 * ⚠️ 现在连计数也不在这里做了：待办数直接取三个列表服务在 `status=open` 下的
 * `total`（见 `lib/services/adminDashboard.ts`）。因此本文件里**没有任何计数函数**，
 * 不是因为不需要，而是因为「数一遍」这件事已经由列表自己做了——
 * 再在这里数第二遍，就等于又开了一条会与列表分叉的路径。
 */

// ——————————————————————————— 文案与跳转 ———————————————————————————

export const ADMIN_DASHBOARD_TODAY_TITLE = "今日经营";
export const ADMIN_DASHBOARD_PENDING_TITLE = "当前待办";
export const ADMIN_DASHBOARD_QUICK_TITLE = "快捷入口";
export const ADMIN_DASHBOARD_QUICK_HINT =
  "全部模块都在左侧导航里；这里只是常用入口。";

/** 今日经营三张卡的文案。`key` 是稳定的机器标识（测试与选择器用它）。 */
export const ADMIN_DASHBOARD_METRIC_LABELS = {
  todayOrderCount: "今日订单",
  todayGmvAmount: "今日 GMV",
  todayRefundAmount: "今日退款",
} as const;

export const ADMIN_DASHBOARD_METRIC_HINTS = {
  todayOrderCount: "今天支付成功的订单数（含今天又被退款的）",
  todayGmvAmount: "今天成功支付订单的实付金额之和，退款不倒扣",
  todayRefundAmount: "今天实际退出去的金额（直接退款 + 售后通过 + 超时自动退款）；退款列表没有日期维度，对不上这个数是正常的",
} as const;

export const ADMIN_DASHBOARD_PENDING_LABELS = {
  // ⚠️ **只有这一张卡不带「待处理」前缀**（P1-1 人工验收的文案裁定：`待处理申请` → `打手申请`）。
  // 这不是排版疏漏，别顺手改回去：另外两张卡的名字里已经写清了**是什么**（退款 / 投诉），
  // 而「申请」自己不说明是什么申请——平台上不止一种申请，管理员看到「待处理申请」
  // 无法判断这是打手入驻申请还是售后申请。**改的是这一处显示文案**，
  // 卡片背后的 `open` 状态集合、计数口径与跳转地址一个字都没动。
  applications: "打手申请",
  refunds: "待处理退款",
  complaints: "待处理投诉",
} as const;

/**
 * 待办卡的提示文案。
 *
 * ⚠️ 现在可以**直说「点进去就是这些」**了：卡片与列表走的是同一次
 * `status=open` 查询（见 `lib/services/adminDashboard.ts`），
 * 因此这句话是承诺，不是安慰。
 *
 * ⚠️ 上一版这里写的是「列表默认只筛「待审核」一档」——那不是披露，是**承认对不上**：
 * 卡片数 2 条、点进去 1 条。R6 裁定要求两者必须相等，那一版文案已随之作废。
 */
export const ADMIN_DASHBOARD_PENDING_HINTS = {
  applications: "待审核 + 审核中；已通过 / 已驳回 / 用户撤销不计。点进去就是这些",
  refunds: "待审核 + 审核中；已通过 / 已驳回 / 已撤销不计。点进去就是这些",
  complaints: "待处理 + 处理中；已处理 / 已关闭不计。点进去就是这些",
} as const;

/**
 * 卡片点进去之后的地址。**由常量给出，页面不自己拼**（拼错了只会得到一个空列表）。
 *
 * ⚠️ 三个地址都带 `status=open`，与卡片上的数字**同源**：`open` 是查询层的虚拟值
 * （不是领域状态，见各领域常量文件），列表服务把它解析成该领域的
 * `OPEN_*_STATUSES` 再筛。若这里改回单值（例如 `pending`），
 * 卡片与列表立刻又会不等——`tests/adminDashboard.test.mjs` 有一条用例专门钉住这件事。
 *
 * ⚠️ 入驻申请那条走 `ADMIN_APPLICATION_LIST_HREF("open")`：地址由该模块自己的
 * 构造函数生成，不在本文件里手写字符串，避免「改了模块的地址规则、首页不知道」。
 */
export const ADMIN_DASHBOARD_PENDING_HREFS = {
  applications: ADMIN_APPLICATION_LIST_HREF("open"),
  refunds: "/admin/refunds?status=open",
  complaints: "/admin/complaints?status=open",
} as const;

/**
 * 今日订单卡点进去：订单列表按**同一天**筛选（列表的日期就是北京时间自然日，
 * 与 `businessDate` 同一个口径），因此卡上的数字与列表里的条数对得上。
 *
 * ⚠️ 这层「对得上」依赖一个**不是结构性的**事实：订单列表的日期筛的是
 * `order.createdAt`（`lib/constants/orderFilters.ts` 的 `orderBeijingDate(order.createdAt)`），
 * 而本卡的计数用的是 `order.paidAt`。两者**只有在 `createdAt === paidAt` 时才相等**——
 * 当前两个建单点（`lib/services/checkout.ts` 与 `lib/mocks/fixtures/orderSeed.ts`）
 * 都是拿同一个 `at` 同时写这两个字段，因此当下一致。
 *
 * ⚠️ 将来若出现「先建单、后支付成功」的模型（下单与支付是两个时刻），
 * 本卡会开始比列表多算（跨午夜支付那部分），**届时必须同步改这里的跳转口径**，
 * 而不是只改计数。现在写下这层依赖，是为了让那次改动有一个明确的落点。
 */
export function ADMIN_DASHBOARD_TODAY_ORDERS_HREF(businessDate: string): string {
  return `/admin/orders?from=${businessDate}&to=${businessDate}`;
}

/**
 * 今日退款卡点进去：退款列表**没有日期筛选**（`AdminRefundListRequest` 只有状态与关键词），
 * 因此这里只能链到退款模块本身，并且**显式带 `status=all`**——
 * 该模块的**默认筛选是 `pending`**（`DEFAULT_ADMIN_REFUND_STATUS_FILTER`），
 * 一张「今天已经退出去多少钱」的卡落到「待审核的退款申请」列表上毫无意义。
 *
 * ⚠️ 卡上的数字**不保证**能在目标页里重新数出来（列表没有日期维度，而且
 * 两条无退款记录的路径——用户直接退款、公共池超时自动退款——在列表里**根本查不到**）。
 * 这一点已经在卡的提示文案（`ADMIN_DASHBOARD_METRIC_HINTS.todayRefundAmount`）
 * 与 `04-acceptance.md` §五 R3 里说明了，**不假装它能对上**。
 */
export const ADMIN_DASHBOARD_REFUNDS_HREF = "/admin/refunds?status=all";

/**
 * 经营首页的快捷入口。
 *
 * ⚠️ 地址与文案**从既有导航常量里取**，不在这里重写一遍：两份清单一定会分叉，
 * 而分叉的表现是「首页上的入口指向一个改名后的旧地址」这种只有用户才会发现的错。
 * `ADMIN_NAV_ITEMS` 就是「现在真实存在哪些模块」的唯一真值源。
 *
 * 引用了不存在的模块时**直接抛错**：这属于常量表本身写错了，
 * 静默丢掉一项只会让首页悄悄少一个入口。
 */
function dashboardQuickEntry(key: string): { key: string; href: string; label: string; description: string } {
  const item = ADMIN_NAV_ITEMS.find((each) => each.key === key);
  if (!item) {
    throw new Error(`经营首页的快捷入口引用了不存在的管理模块：${key}`);
  }
  return { key: item.key, href: item.href, label: item.label, description: item.description };
}

export const ADMIN_DASHBOARD_QUICK_ENTRIES = [
  dashboardQuickEntry("orders"),
  dashboardQuickEntry("products"),
  dashboardQuickEntry("companions"),
  dashboardQuickEntry("applications"),
  dashboardQuickEntry("refunds"),
  dashboardQuickEntry("content"),
] as const;
