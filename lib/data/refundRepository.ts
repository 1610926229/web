import type { RefundRequest, RefundStatus } from "@/lib/types/refund";
import { mockRefundRepository } from "./mockRefundRepository";

/**
 * 管理端退款查询条件。
 *
 * ⚠️ 与订单同理**没有关键词**：后台要按用户昵称与平台展示 ID 搜，而那两个字段在用户仓储里；
 * 退款单号与订单号倒是在这条记录（及其订单）身上，但为了不让「一部分关键词在仓储筛、
 * 一部分在服务层筛」这种半截规则出现，关键词**统一由服务层处理**
 * （见 `lib/services/adminRefunds.ts`）。
 */
export type AdminRefundQueryFilter = {
  /** null 表示「全部」 */
  status: RefundStatus | null;
};

/**
 * 退款申请的可替换仓储。
 *
 * 与 `PaymentRepository` 同一套路：**写入侧**保证原子性与幂等，读取侧只按 id / 订单查。
 *
 * 两条约束由本层负责，不能靠调用方自觉：
 *
 * 1. **一笔订单同一时刻最多一条进行中的退款申请**。⚠️ **P0-13 起不再是「一笔订单
 *    只能有一条申请」**（那会让部分退款永远只能退一次）：已批准 / 已拒绝 / 已撤销的
 *    记录不再挡着新申请。「检查有没有进行中的」与「写入新记录」在同一段同步代码里完成，
 *    因此快速连点不会产生两条进行中的。
 * 2. **撤销只能发生在待审核（pending）**。状态判断与写入同样是原子的——
 *    否则「审核中」的申请在极端时序下会被用户撤销掉。
 *
 * ⚠️ 本层**不判断**「这笔订单能不能退款」「这个订单是不是你的」「还能退多少钱」：
 * 那是业务规则，在 `lib/services/refunds.ts` 与伪事务里做。
 * 仓储只保证自己这份数据的一致性。
 *
 * 当前实现是进程内内存存储，将来由数据库的（部分）唯一索引与事务替换——
 * 替换时这份契约不变（`orders/create` 服务不用改）。
 */

/**
 * 创建结果：要么成功（含幂等命中），要么这笔订单已经有一条**进行中**的申请了。
 *
 * ⚠️ `reason` 由 `order_already_has_refund` 改名为 `order_has_active_refund`（P0-13）：
 * 拒绝的理由变了——不是「已经有记录了」，而是「已经有一条还在走流程」。
 * 名字不改会让调用方按旧语义去理解这个失败（以为「有记录」就该报重复申请）。
 */
export type CreateRefundOutcome =
  | { ok: true; refund: RefundRequest; created: boolean }
  | { ok: false; reason: "order_has_active_refund"; existing: RefundRequest };

/** 撤销结果。非法状态与不存在分开报，但**对外都是同一个错误**（见服务层）。 */
export type CancelRefundOutcome =
  | { ok: true; refund: RefundRequest }
  | { ok: false; reason: "not_found" | "not_cancellable" };

export type RefundRepository = {
  /** 按 id 取退款申请（不做归属判断，归属由服务层校验）。 */
  findRefundById(id: string): Promise<RefundRequest | null>;

  /** 按「用户 + 幂等键」查已提交过的申请；不存在返回 null。 */
  findRefundByKey(userId: string, idempotencyKey: string): Promise<RefundRequest | null>;

  /**
   * 按订单取退款申请，返回**最新的一条**；一单都没退过时返回 null。
   *
   * ⚠️ P0-13 起一个订单可以有多条申请，因此「最新」是本方法的**契约的一部分**，
   * 不是实现细节：它服务的是「这一单的退款现在走到哪了」这个单点问题
   * （订单详情上的退款卡）。要「全部」用 `listRefundsByOrderId`。
   */
  findRefundByOrderId(orderId: string): Promise<RefundRequest | null>;

  /**
   * 某订单的**全部**退款申请，按创建先后排列；没退过是空数组。
   *
   * ⚠️ 与 `findRefundByOrderId` 并存不是重复：一个回答「现在到哪了」（最新一条），
   * 一个回答「一共退过几次、每次都退了多少」（全部）。部分退款上线后，
   * 后一个问题才有意义，而它在只返回一条的旧方法里**根本问不出来**。
   */
  listRefundsByOrderId(orderId: string): Promise<RefundRequest[]>;

  /**
   * 创建退款申请。
   *
   * 幂等：同「用户 + 幂等键」已存在时返回既有记录并把 `created` 置为 false，
   * 快速连点或网络重试都不会多出第二条。
   *
   * **同一订单已有进行中的申请**时拒绝创建（`order_has_active_refund`），
   * 并把已存在的那条返回给调用方。已结束（已批准 / 已拒绝 / 已撤销）的记录不挡——
   * 部分退款要求同一单能退第二次（P0-13）。
   */
  createRefundRequest(refund: RefundRequest, idempotencyKey: string): Promise<CreateRefundOutcome>;

  /**
   * 撤销退款申请：只有**待审核**且属于 `userId` 的申请会被撤销。
   *
   * 归属与状态都在同一段同步代码里判断，因此不存在「先查到是你的、写之前状态变了」的窗口。
   * 不属于当前用户的申请一律按 `not_found` 处理，避免用它来试探别人退款申请的存在。
   */
  cancelRefund(id: string, userId: string, cancelledAt: string): Promise<CancelRefundOutcome>;

  /**
   * 管理端的**全量退款**查询（P8C）：跨用户、按状态筛选，按申请时间倒序返回**全部命中记录**。
   *
   * ⚠️ 不按 `userId` 收窄（调用方只可能是管理端接口，而它们第一步都走 `requireAdmin()`），
   * 也不分页（关键词要跨用户仓储匹配，分页得在那之后做，否则总数与页数会对不上）。
   */
  queryRefundsForAdmin(filter: AdminRefundQueryFilter): Promise<RefundRequest[]>;
};

export function getRefundRepository(): RefundRepository {
  return mockRefundRepository;
}
