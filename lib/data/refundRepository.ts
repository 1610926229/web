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
  /**
   * 命中的**真实领域状态集合**；`null` 表示「全部」。
   *
   * ⚠️ 只接受 `RefundStatus`：地址栏上的虚拟筛选值 `all` / `open` **不得**
   * 出现在数据层，服务层调用前已用 `refundStatusesForFilter()` 解析完毕。
   */
  statuses: readonly RefundStatus[] | null;
};

/**
 * 退款申请的可替换仓储。
 *
 * 与 `PaymentRepository` 同一套路：**写入侧**保证原子性与幂等，读取侧只按 id / 订单查。
 *
 * 两条约束由本层负责，不能靠调用方自觉：
 *
 * 1. **一笔订单最多一条退款申请，任何状态都算数**（**P0-15 起**）。
 *    ⚠️ 这条约束**被改过两次**，读旧代码的人必须知道当前是哪一版：
 *    - P0-12 及以前：一单只能有一条申请（那时不存在部分退款）；
 *    - P0-13：放宽为「同时最多一条**进行中**的」，已结束的不挡——因为部分退款
 *      要求同一单能退第二次；
 *    - **P0-15（当前）**：收紧回「一单一条，**永久**」。已批准 / 已拒绝 / 已撤销
 *      的记录**同样挡着**新申请：拒绝也是「你的一次机会用掉了」，
 *      而批准意味着这笔订单的退款流程已经终结。
 *    「这一单有没有申请」与「写入新记录」在同一段同步代码里完成，
 *    因此快速连点不会产生两条。
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
 * 创建结果：要么成功（含幂等命中），要么这笔订单**已经有**退款申请了。
 *
 * ⚠️ `reason` 的沿革（**这个字段被改过两次名，别照中间那一版写**）：
 * - 原为 `order_already_has_refund`（「有记录就不许再申请」）；
 * - P0-13 改名 `order_has_active_refund`（「只有**进行中**的才挡」）；
 * - **P0-15 改回 `order_already_has_refund`**——不是回退，是规则回到了
 *   「一次机会」：拒绝过、撤销过、批准过的记录**全都挡**。
 *   名字必须跟着规则改：留 `active` 会让调用方按 P0-13 的语义去理解
 *   这个失败（以为被拒绝之后还能再试一次），而那正是本轮要禁掉的。
 */
export type CreateRefundOutcome =
  | { ok: true; refund: RefundRequest; created: boolean }
  | { ok: false; reason: "order_already_has_refund"; existing: RefundRequest };

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
   * ⚠️ 「最新」这个词是 P0-13 留下的：那时一个订单可以有多条申请，
   * 必须说清返回哪一条。**P0-15 之后一单最多一条**，因此「最新」= 「那一条」，
   * 措辞保留但不含歧义。它服务的是「这一单的退款现在走到哪了」这个单点问题
   * （订单详情上的退款卡）。
   */
  findRefundByOrderId(orderId: string): Promise<RefundRequest | null>;

  /**
   * 某订单的**全部**退款申请，按创建先后排列；没退过是空数组。
   *
   * ⚠️ **P0-15 之后它的返回值长度恒为 0 或 1**，与 `findRefundByOrderId` 事实上同义。
   * 刻意**不合并、不废弃**：合并会让「一单几条」这个问题的答案从一个
   * 明确返回数组的方法，变成一个必须靠调用方自己知道「现在只有一条」的假设；
   * 而 `mockRefundRepository` 的 `refundIdsByOrder` 索引本来就是数组。
   * 将来若放宽退款次数，调用点不必再改一遍。
   */
  listRefundsByOrderId(orderId: string): Promise<RefundRequest[]>;

  /**
   * 创建退款申请。
   *
   * 幂等：同「用户 + 幂等键」已存在时返回既有记录并把 `created` 置为 false，
   * 快速连点或网络重试都不会多出第二条。
   *
   * **同一订单已有任何一条申请**时拒绝创建（`order_already_has_refund`），
   * 并把已存在的那条返回给调用方——**不看它的状态**：已批准 / 已拒绝 / 已撤销
   * 一律照挡（P0-15）。这是「一个订单只能申请一次退款」的**存储层落点**，
   * 与 `lib/services/refunds.ts` 的服务层检查构成两道闸：
   * 服务层负责给出可读的错误信息，本层负责「就算有人绕过服务层也写不进去」。
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
