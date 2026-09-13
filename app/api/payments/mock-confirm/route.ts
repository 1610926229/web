import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { isMockPaymentEnabled } from "@/lib/config/env";
import { confirmPaymentRequest } from "@/lib/services/checkout";
import type { MockPaymentResult } from "@/lib/types/payment";

/**
 * 模拟支付结果确认接口。
 *
 * ⚠️ 这是**开发用的模拟渠道**，不代表真实微信支付页面，也不调用任何真实接口。
 * 关闭 `ENABLE_MOCK_PAYMENT` 时整个接口返回 404——正式环境里它必须等于不存在。
 *
 * 开关判断放在最前面：未启用时连「是否登录」「请求体对不对」都不该被探测到。
 */

const RESULTS: readonly MockPaymentResult[] = ["success", "failure", "cancel"];

function parseResult(value: unknown): MockPaymentResult {
  if (typeof value === "string" && (RESULTS as readonly string[]).includes(value)) {
    return value as MockPaymentResult;
  }
  throw new ApiError("BAD_REQUEST", "支付结果参数无效");
}

export async function POST(request: Request) {
  if (!isMockPaymentEnabled()) {
    return fail(new ApiError("NOT_FOUND", "模拟支付未启用", 404));
  }

  try {
    const user = await requireUser();
    const body = await readJsonBody(request);

    const paymentRequestId =
      typeof body.paymentRequestId === "string" ? body.paymentRequestId.trim() : "";
    if (!paymentRequestId) throw new ApiError("BAD_REQUEST", "缺少支付请求 id");

    const outcome = await confirmPaymentRequest(
      paymentRequestId,
      parseResult(body.result),
      user.id,
    );

    // 不存在与不属于当前用户，对接口一律是 404：不给接口留下枚举别人支付请求的余地
    if (!outcome.ok) throw new ApiError("NOT_FOUND", "支付请求不存在", 404);

    return ok({
      status: outcome.request.status,
      orderId: outcome.order ? outcome.order.id : outcome.request.orderId,
      orderNo: outcome.order ? outcome.order.orderNo : null,
      // 幂等提示：重复确认成功时不会生成新订单，这里如实告诉调用方
      duplicated: !outcome.orderCreated,
    });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
