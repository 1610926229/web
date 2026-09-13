"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmMockPayment } from "@/lib/services/checkoutHttp";
import type { MockPaymentResult } from "@/lib/types/payment";

/**
 * 模拟支付渠道的三个结果按钮（**仅本地开发**）。
 *
 * 它存在的唯一理由是：真实的微信支付没有接入，而「成功 / 失败 / 取消」三条路径都必须能被验证。
 * 这里不接入任何真实商户信息，也不调用任何微信接口；`ENABLE_MOCK_PAYMENT` 关闭时，
 * 接口直接 404，调用方也不会渲染这个组件。
 *
 * 点击之后不由本地改写任何状态，而是让服务端重新出结果：
 * `confirmMockPayment` → `router.refresh()`，页面重新按支付请求 ID 读取真实状态。
 * 也就是说，「支付成功」这四个字始终来自服务端，客户端没有能力自己宣布成功。
 */
const ACTIONS: { result: MockPaymentResult; label: string; primary: boolean }[] = [
  { result: "success", label: "模拟支付成功", primary: true },
  { result: "failure", label: "模拟支付失败", primary: false },
  { result: "cancel", label: "取消支付", primary: false },
];

export default function MockPaymentActions({ requestId }: { requestId: string }) {
  const [pending, setPending] = useState<MockPaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function confirm(result: MockPaymentResult) {
    if (pending) return;

    setPending(result);
    setError(null);

    try {
      await confirmMockPayment(requestId, result);
      // 结果以服务端为准：刷新后重新读取这条支付请求的真实状态
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模拟支付失败，请重试");
      setPending(null);
    }
  }

  return (
    <div className="mt-4 w-full rounded-[10px] border border-dashed border-line px-3 py-3">
      <p className="text-[11px] leading-4 text-ink-3">
        模拟支付（仅本地开发环境，非真实微信支付页面）
      </p>

      <div className="mt-2 flex flex-col gap-2">
        {ACTIONS.map((action) => (
          <button
            key={action.result}
            type="button"
            disabled={pending !== null}
            onClick={() => void confirm(action.result)}
            className={`h-10 rounded-full text-[14px] font-medium disabled:opacity-60 ${
              action.primary ? "bg-brand-red text-white" : "border border-line text-ink-2"
            }`}
          >
            {pending === action.result ? "处理中…" : action.label}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
