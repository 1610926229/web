import type { Order } from "@/lib/types/order";
import { formatDateTime } from "@/lib/utils/format";

/**
 * **与身份无关**的订单筛选、搜索与排序纯函数。管理端与客服端共用这一份。
 *
 * ⚠️ 为什么要单独一个文件，而不是塞进 `lib/constants/orders.ts`：
 * 那个文件的文件头明令「**不得出现任何运行时的 `import`**」（它被客户端组件引用，
 * 靠这一点保证不把服务端模块打进浏览器产物）。而 `orderBeijingDate` 依赖
 * `formatDateTime` —— 那是运行时的纯函数。因此这里单独成文件，并遵守与
 * `lib/constants/adminOrders.ts` 相同的依赖纪律：**只有类型、`lib/utils/format.ts`
 * 与纯函数**，没有任何 `lib/data` / `lib/services` 依赖，浏览器与 node 都能直接加载。
 *
 * ⚠️ 这**七个**函数原先住在 `lib/constants/adminOrders.ts`。P0-10 新增客服订单查询时
 * 把它们**上移**到这里，而不是在客服侧复制一份——复制就是**第二套实现**
 * （`architecture-rules.md` §十「无第二套实现」明确禁止）。
 * `adminOrders.ts` 按原名 re-export，既有引用点因此一个都没改。
 *
 * ⚠️ 这里**只有与身份无关**的规则。带身份的（状态筛选、错误文案、DTO 转换）
 * 仍各自留在 `adminOrders.ts` / `staff.ts` —— 两个界面拥有自己的文案与字段表，
 * 「管理端给列表加一个字段」不该顺带把它送进客服响应。
 */

// ——————————————————————————— 游戏 ———————————————————————————

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

/**
 * 严格读取游戏筛选：必须是订单里出现过的游戏名。
 *
 * 空值（缺失 / 空串）表示「全部游戏」，返回空串；**非法值返回 `null`**，
 * 由调用方决定口径——接口抛 400，页面回落成不限（与其他筛选条件同一条规则）。
 *
 * 之所以要拿 `knownGames` 校验而不是原样放行：筛选栏里的取值集合是固定的，
 * 放行一个不存在的游戏名只会得到一次必然为空、且无法解释的查询。
 */
export function readOrderFilterGame(
  raw: string | null,
  knownGames: readonly string[],
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return "";
  return knownGames.includes(value) ? value : null;
}

// ——————————————————————————— 日期 ———————————————————————————

/**
 * 日期筛选：只接受 `YYYY-MM-DD`。
 *
 * 用固定正则而不是 `Date.parse`：后者会接受 `2026/9/1`、`Sep 1 2026` 这类写法，
 * 而它们在地址栏里与页面展示的格式对不上，出了问题没人能一眼看出是哪个参数。
 * 空值表示不限。
 *
 * 返回 `null` 表示**非法**（由调用方决定：接口抛 400，页面回落成不限）。
 */
const ORDER_FILTER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function readOrderFilterDate(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!ORDER_FILTER_DATE_PATTERN.test(value)) return null;
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

// ——————————————————————————— 排序 ———————————————————————————

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
export function compareOrdersByCreatedAt(
  a: Pick<Order, "createdAt" | "paidAt" | "id">,
  b: Pick<Order, "createdAt" | "paidAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.paidAt !== b.paidAt) return a.paidAt < b.paidAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// ——————————————————————————— 关键词 ———————————————————————————

/**
 * 关键词是否命中：**订单号 / 商品名称 / 用户昵称 / 平台展示 ID** 四处任一包含即可。
 *
 * 这四处正是客服与运营手里能拿到的东西——用户打电话来报的要么是订单号，要么是「我的昵称」，
 * 要么是资料页上那串 ID。备注与游戏账号**不参与搜索**：那是内容不是标识，
 * 用它搜出来的结果没人能预期，而且备注里可能有用户写的隐私信息。
 *
 * ⚠️ **`userId` 是可选的第 5 处**（P0-10 整改）：客服订单页把内部用户标识
 * 与平台展示 ID **一并显示**（同一行上下两串，用户报哪一串都得搜得到），
 * 而管理端订单页只显示 `displayId`，没有这一路——因此是「有就参与匹配」，
 * 不是「每个调用方都必须编一个值出来」。**匹配规则只有这一份**：
 * 客服端另写一个自己的匹配函数，就会出现「同一个关键词在两张表上结果不同」。
 *
 * 传入的 `nickname` / `displayId` / `userId` 在用户记录缺失时用空串（它们不参与匹配）。
 */
export function orderMatchesKeyword(
  input: {
    orderNo: string;
    productTitle: string;
    /** 用户昵称；用户记录缺失时为空串 */
    nickname: string;
    /** 平台展示 ID；用户记录缺失时为空串 */
    displayId: string;
    /** 内部用户标识；不显示这一路的调用方不传 */
    userId?: string;
  },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.orderNo.toLowerCase().includes(needle) ||
    input.productTitle.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle) ||
    input.displayId.toLowerCase().includes(needle) ||
    (input.userId ?? "").toLowerCase().includes(needle)
  );
}
