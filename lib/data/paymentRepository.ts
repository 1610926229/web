import type { OrderListQuery } from "@/lib/constants/orders";
import type { PageResult } from "@/lib/types/common";
import type { Order, OrderStatus } from "@/lib/types/order";
import type { MockPaymentResult, PaymentRequest } from "@/lib/types/payment";
import { mockPaymentRepository } from "./mockPaymentRepository";

/**
 * 管理端订单查询条件。
 *
 * ⚠️ **没有关键词**：后台要按用户昵称与平台展示 ID 搜单，而这两个字段在用户仓储里，
 * 不在订单上。仓储只按订单**自己身上**的条件筛选（状态 / 游戏名快照 / 创建日期范围），
 * 关键词那一段由服务层跨实体匹配（见 `lib/services/adminOrders.ts`）。
 * 让仓储接一个「调用方传进来的判定函数」看起来更省事，但那样筛选规则就跑到仓储外面去了，
 * 将来换成数据库查询时无处安放。
 */
export type AdminOrderQueryFilter = {
  /** null 表示「全部」 */
  status: OrderStatus | null;
  /** 游戏名快照（`Order.gameName`）；空串表示全部游戏 */
  gameName: string;
  /** 起始日期 `YYYY-MM-DD`（含当天，北京时间）；空串表示不限 */
  from: string;
  /** 结束日期 `YYYY-MM-DD`（含当天，北京时间）；空串表示不限 */
  to: string;
};

/**
 * 「不限任何条件」的查询条件。
 *
 * 三个管理端服务都需要**取全部订单**，而且都不是为了展示：
 * 订单列表要算游戏筛选项（`orderGameNames`）、退款列表要按订单号做关键词匹配、
 * 投诉详情要拼关联订单摘要。与其在三处各写一份字面量，不如在这里给一个共享常量——
 * 「不限」这件事属于查询条件本身，正是本模块的概念。
 */
export const ADMIN_ORDER_UNFILTERED_QUERY: AdminOrderQueryFilter = {
  status: null,
  gameName: "",
  from: "",
  to: "",
};

/**
 * 支付与订单的可替换实现：**写入侧**保证原子性与幂等，**读取侧**是订单列表与详情的唯一入口。
 *
 * 与 `DataSource`（只读目录）分开，是因为写入必须保证两件只读取数不需要保证的事：
 *
 * 1. **原子性**——「把支付请求标记为成功 + 生成订单 + 生成支付记录」必须一次完成，
 *    不能出现「状态已成功但没有订单」或反过来。
 * 2. **幂等**——同一支付请求成功确认多次只能生成一个订单；同一「用户 + 幂等键」
 *    只能有一条支付请求。
 *
 * ⚠️ 这两条约束由本层负责，不能靠调用方自觉。当前实现是进程内内存存储，
 * 将来由数据库的唯一索引与事务替换——替换时这份契约不变，`lib/services/checkout.ts` 不用改。
 *
 * 调用方必须先完成鉴权与归属校验，本层不判断「这个请求是不是你的」。
 *
 * 订单为什么要放在这里而不是另建一个「订单仓储」：**支付成功生成的订单与预置订单
 * 必须是同一批数据**。两套存储必然出现「刚支付的订单在列表里看不到」这类问题，
 * 因此订单只有这一个 `Map`、只有这一套查询方法。
 */
export type PaymentRepository = {
  /** 按「用户 + 幂等键」查已存在的支付请求；不存在返回 null。 */
  findPaymentRequestByKey(userId: string, idempotencyKey: string): Promise<PaymentRequest | null>;
  findPaymentRequestById(id: string): Promise<PaymentRequest | null>;

  /**
   * 幂等创建：同「用户 + 幂等键」已存在时**不再创建**，返回已存在的那条并把 `created` 置为 false。
   * 检查与写入在同一段同步代码里完成，并发重复提交不会产生第二条。
   */
  createPaymentRequest(
    request: PaymentRequest,
  ): Promise<{ request: PaymentRequest; created: boolean }>;

  /**
   * 确认支付结果（模拟渠道的唯一入口）。
   *
   * - 成功：在同一个原子区段内标记状态并生成订单与支付记录，**只生成一次**；
   * - 失败 / 取消：只改状态，不生成订单；
   * - 已经是终态的请求再次确认：原样返回既有结果，`orderCreated` 为 false，
   *   不会因为重复确认而多出一个订单。
   *
   * `buildOrder` 由 service 传入：订单长什么样属于业务，仓库只负责「恰好生成一次」。
   * 这样订单快照所需的异步读取可以先在 service 里做完，原子区段里不再有 await。
   *
   * 请求不存在时返回 null。
   */
  confirmPaymentRequest(
    id: string,
    result: MockPaymentResult,
    buildOrder: (request: PaymentRequest) => Order,
  ): Promise<{ request: PaymentRequest; order: Order | null; orderCreated: boolean } | null>;

  /**
   * 查询某个用户的订单（列表页与「我的订单」的**唯一**入口）。
   *
   * 状态筛选、订单号搜索、倒序与分页都在这里完成：页面与接口都不自己过滤，
   * 否则「按状态筛选」在两侧会慢慢长成两套行为。
   *
   * ⚠️ `query.userId` 是查询条件的一部分，不是可选的过滤项——本方法**只可能**
   * 返回该用户的订单，调用方不需要（也不应该）在拿到结果后再过滤一次。
   */
  queryOrders(query: OrderListQuery & { userId: string }): Promise<PageResult<Order>>;

  /** 按 id 取单个订单（不做归属判断，归属由 service 校验）。 */
  findOrderById(id: string): Promise<Order | null>;

  /**
   * 某个用户的**全部订单**（不分页、不筛状态），消费金额统计用。
   *
   * ⚠️ 刻意**不在这里筛「已完成」**：「哪些订单计入累计有效消费」是业务口径，
   * 只写在 `lib/constants/levels.ts` 的 `sumEffectiveSpend` 里。仓储若也筛一遍，
   * 同一套口径就有两份实现，改动时必然漏掉一处。
   *
   * 与 `queryOrders` 一样，`userId` 是**查询条件**而不是可选的过滤项：
   * 本方法只可能返回该用户的订单。
   */
  listOrdersByUser(userId: string): Promise<Order[]>;

  /**
   * 某个打手**实际履约**的订单（打手端「我的订单」的唯一入口，P0-6）。
   *
   * ⚠️ 条件是 `Order.actualCompanionId`，**不是**派单的 `exclusiveCompanionId`：
   * 后者是「用户当初指定了谁」的历史事实，订单回公共池、被别人接走之后都不清，
   * 拿它当归属就会把「用户想要的人」当成「现在在履约的人」。
   * 与 `queryOrders` 一样，`companionId` 是**查询条件**而不是可选的过滤项——
   * 本方法只可能返回这一位打手实际接过的单，调用方不需要（也不应该）拿到结果后再过滤。
   *
   * 不分页、也不筛状态：打手端「我的订单」本轮是一份平铺列表（进行中的与历史都在），
   * 页面结构由后续 UI 批次决定。返回值**只在服务端转成打手端 DTO**
   * （`CompanionOrderListItem`），任何情况下都不会原样作为响应体返回。
   */
  queryOrdersByCompanion(companionId: string): Promise<Order[]>;

  /**
   * 全部用户的**全部订单**（不分页、不筛状态），消费排行榜聚合用。
   *
   * ⚠️ 返回值**只在服务端参与聚合**，任何情况下都不会作为响应体返回：
   * 排行榜对外只有公开 DTO（名次 / 昵称 / 头像 / 等级 / 金额）。
   */
  listAllOrders(): Promise<Order[]>;

  /**
   * 管理端的**全量订单**查询（P8C）：跨用户、按状态 / 游戏名 / 创建日期范围筛选，
   * 按创建时间倒序返回**全部命中记录**（不分页）。
   *
   * ⚠️ 与 `queryOrders` 的两点不同，都是刻意的：
   * 1. **不按 `userId` 收窄**——这个方法的调用方只可能是管理端接口，
   *    而每个管理端接口的第一件事都是 `requireAdmin()`（见 §权限）。
   *    这里不接 `userId` 参数，也就没有「某个调用方忘了传」这种可能。
   * 2. **不分页**——关键词要跨用户仓储匹配，分页得在那之后做，
   *    否则「第 1 页筛出 3 条、第 2 页又筛出 5 条」会让总数与页数对不上。
   *    服务层在关键词过滤**之后**才切片，因此 `total` 与实际能翻到的条数始终一致。
   *
   * 返回值**只在服务端转成管理端 DTO**，任何情况下都不会原样作为响应体返回。
   */
  queryOrdersForAdmin(filter: AdminOrderQueryFilter): Promise<Order[]>;
};

export function getPaymentRepository(): PaymentRepository {
  return mockPaymentRepository;
}
