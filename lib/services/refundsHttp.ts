import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import type { RefundDetail } from "@/lib/types/refund";

/**
 * 退款的**浏览器端**取数（提交申请 / 直接全额退款 / 查看详情 / 撤销申请）。
 *
 * 与服务端模块 `lib/services/refunds.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 退款详情页的首屏由 Server Component 直接取数，不经过本文件。
 */

export type RefundRequestInput = {
  reasonKey: string;
  description: string;
  /** 只提交类型与文件名；凭证的 id 与地址一律由服务端生成 */
  evidence: EvidenceDraft[];
  idempotencyKey: string;
};

/** 提交退款申请。返回新申请的 id，由页面跳到退款详情页。 */
export function submitRefund(
  orderId: string,
  input: RefundRequestInput,
): Promise<{ refundId: string; created: boolean }> {
  return apiPost<{ refundId: string; created: boolean }>(
    `/api/orders/${encodeURIComponent(orderId)}/refunds`,
    input,
  );
}

/** 读取退款申请详情（用于撤销后重新拉取最新状态）。 */
export function fetchRefundDetail(refundId: string): Promise<RefundDetail> {
  return apiGet<RefundDetail>(`/api/refunds/${encodeURIComponent(refundId)}`);
}

/**
 * **直接全额退款**（P0-12，免审批）。
 *
 * ⚠️ **不带请求体**：这一档退款没有原因、没有说明、没有金额可填，
 * 服务端也就不读请求体（见该接口的说明）。金额由服务端按订单实付金额算。
 *
 * ⚠️ **不带幂等键**：去重靠订单状态与已退金额，而不是调用方给的一个串。
 * 因此用户重复点击不会重复出款，理由与结论都写在该接口的文档注释里。
 */
export function directRefund(
  orderId: string,
): Promise<{ orderId: string; orderNo: string; refundedAmount: number; refundedAt: string }> {
  return apiPost<{ orderId: string; orderNo: string; refundedAmount: number; refundedAt: string }>(
    `/api/orders/${encodeURIComponent(orderId)}/direct-refund`,
  );
}

/** 撤销退款申请。只有待审核的申请会成功。 */
export function cancelRefund(refundId: string): Promise<{ refundId: string; status: string }> {
  return apiPost<{ refundId: string; status: string }>(
    `/api/refunds/${encodeURIComponent(refundId)}/cancel`,
  );
}
