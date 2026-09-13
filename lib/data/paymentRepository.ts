import type { OrderListQuery } from "@/lib/constants/orders";
import type { PageResult } from "@/lib/types/common";
import type { Order } from "@/lib/types/order";
import type { MockPaymentResult, PaymentRequest } from "@/lib/types/payment";
import { mockPaymentRepository } from "./mockPaymentRepository";

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
};

export function getPaymentRepository(): PaymentRepository {
  return mockPaymentRepository;
}
