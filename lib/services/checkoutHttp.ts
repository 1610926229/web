import { apiPost } from "@/lib/api/client";
import type {
  CheckoutPreview,
  CheckoutSelection,
  MockPaymentConfirmResult,
  MockPaymentResult,
  PaymentRequestSummary,
} from "@/lib/types/payment";

/**
 * 结算与支付的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/checkout.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层和内存存储就会被打进浏览器产物。
 * 客户端只能引用只依赖 `lib/api/client` 的模块。
 *
 * ⚠️ 这里发出的请求**不含任何金额字段**——金额由服务端算，客户端连提交的机会都没有。
 */

/** 金额试算。修改规格 / 数量 / 增值服务后都要重新调用一次，结果以服务端返回为准。 */
export function previewCheckout(selection: CheckoutSelection): Promise<CheckoutPreview> {
  return apiPost<CheckoutPreview>("/api/orders/preview", selection);
}

/**
 * 创建支付请求。
 *
 * `idempotencyKey` 由调用方为**每一次正式提交意图**生成一次，同一次提交的重试必须复用，
 * 否则会创建出第二条支付请求。
 */
export function createPaymentRequest(
  input: CheckoutSelection & { idempotencyKey: string },
): Promise<PaymentRequestSummary> {
  return apiPost<PaymentRequestSummary>("/api/orders/pay", input);
}

/** 确认模拟支付结果。仅在 `ENABLE_MOCK_PAYMENT` 开启时可用。 */
export function confirmMockPayment(
  paymentRequestId: string,
  result: MockPaymentResult,
): Promise<MockPaymentConfirmResult> {
  return apiPost<MockPaymentConfirmResult>("/api/payments/mock-confirm", {
    paymentRequestId,
    result,
  });
}
