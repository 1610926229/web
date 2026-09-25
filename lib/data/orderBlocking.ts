import { isActiveRefundStatus } from "@/lib/constants/refunds";
import { isUnresolvedComplaintStatus } from "@/lib/constants/completions";
import { complaintStore } from "./mockComplaintRepository";
import { refundStore } from "./mockRefundRepository";

/**
 * 「这一单现在有没有阻塞原因」的**读取侧**（P0-9）。
 *
 * ## 为什么单独一个模块
 *
 * 两个地方要问同一个问题，而且**必须得到同一个答案**：
 * - P0-8 到期自动通过（`sweepCompletionAutoApprovals`）：有阻塞就不自动完成订单；
 * - P0-9 收益到期解冻（`sweepMaturedEarnings`）：有阻塞就不放款。
 *
 * 两处若各写一遍「什么算阻塞」，出现分叉的那一天会同时是资金问题的第一天：
 * 订单被投诉挡住了、钱却照样放出去。因此**数据读取只有这一份**，
 * 判据也只有一份（`isCompletionAutoApprovalBlocked`，见下面的分工说明）。
 *
 * ## 分工：本模块只读数据，不定义规则
 *
 * 本函数**只回答「有哪些事实」**，不回答「这些事实算不算阻塞」——
 * 后者是 `lib/constants/completions.ts` 的 `isCompletionAutoApprovalBlocked()`。
 * 因此调用方写出来是 `isCompletionAutoApprovalBlocked(readOrderBlockingFacts(orderId))`：
 * 「阻塞的定义」那一句始终出现在调用点上，改动它只需要动常量文件一处。
 *
 * ## 为什么是同步函数
 *
 * 它的两个调用方都在伪事务的原子区段里（无 `await`）。走异步仓储会立刻让出执行权，
 * 原子的「读—判断—写」就断成两截。这里直接取 Mock 存储的同步句柄，
 * 与两个 sweep 本身同一条理由。
 *
 * ⚠️ 真实的数据库实现里，这两次读应该在**同一条查询**里完成（或至少与写入同一事务），
 * 否则「读到没有阻塞 → 写之前投诉才进来」依然会发生。Mock 阶段靠整段无 `await` 保证。
 */
export function readOrderBlockingFacts(orderId: string): {
  /** 该订单存在**进行中**的退款申请 */
  hasActiveRefund: boolean;
  /** 该订单存在**未完结**的投诉 */
  hasUnresolvedComplaint: boolean;
} {
  const refunds = refundStore();
  const complaints = complaintStore();

  // 退款与投诉一样，都是「一单可以有多条」：P0-13（D10）起同一单允许重复申请退款，
  // 索引给出的是 id 列表。**只要还有一条在进行中就算阻塞**——只看最近一条，
  // 会让「前一笔已驳回、后一笔仍在审核」这种单被放过去。
  const hasActiveRefund = (refunds.refundIdsByOrder.get(orderId) ?? []).some((refundId) => {
    const refund = refunds.refunds.get(refundId);
    return refund ? isActiveRefundStatus(refund.status) : false;
  });

  // 投诉同样必须遍历，只要有一条未完结就算阻塞
  const hasUnresolvedComplaint = [...complaints.complaints.values()].some(
    (complaint) => complaint.orderId === orderId && isUnresolvedComplaintStatus(complaint.status),
  );

  return { hasActiveRefund, hasUnresolvedComplaint };
}
