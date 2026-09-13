import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createPaymentRequest } from "@/lib/services/checkout";

/**
 * 创建支付请求接口。
 *
 * 本接口**不生成订单**：订单只在支付成功后生成。这里做的是重新完整校验、重新计算金额，
 * 并把这一次的选择、金额与内容快照固定成一条支付请求，返回它的 id。
 *
 * 幂等由 `userId + idempotencyKey` 保证：快速连点或网络重试都只会得到同一条记录，
 * 而不是靠前端把按钮禁用住。
 *
 * ⚠️ 本接口不受 `ENABLE_MOCK_PAYMENT` 影响：创建支付请求是真实业务步骤，
 * 被开关关掉的只有「模拟渠道确认支付结果」那一步。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await readJsonBody(request);
    const { request: created } = await createPaymentRequest(body, user.id);

    return ok({
      id: created.id,
      status: created.status,
      totalAmount: created.totalAmount,
    });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
