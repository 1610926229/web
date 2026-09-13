"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelRefund } from "@/lib/services/refundsHttp";

/**
 * 撤销退款申请。
 *
 * 两个要点：
 *
 * 1. **只有 `canCancelRefund` 为真时才渲染**。这个值来自服务端（退款详情 DTO 的
 *    `allowedActions`），前端不拿状态自己判断——本阶段只有「待审核」可撤销，
 *    「审核中」不可撤销，判断规则只应该有一处。
 * 2. **撤销是不可逆动作，所以要点两下**：第一下只是把按钮换成确认区，
 *    第二下才真的发请求，避免误触把申请撤掉。
 *
 * 撤销成功后 `router.refresh()` 重新拉服务端数据：状态变为「已撤销」，
 * `canCancelRefund` 随之变假，按钮自己消失——不做前端本地的状态镜像。
 */
export default function RefundCancelButton({ refundId }: { refundId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const pendingRef = useRef(false);

  async function confirm() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");

    try {
      await cancelRefund(refundId);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销失败，请稍后重试");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="mt-2 bg-surface px-4 py-3">
        <button
          type="button"
          onClick={() => {
            setError("");
            setConfirming(true);
          }}
          className="h-11 w-full rounded-full border border-line text-[15px] text-ink-2"
        >
          撤销退款申请
        </button>
        {error ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 bg-surface px-4 py-3">
      <p className="text-[13px] leading-5 text-ink-2">
        撤销后这笔退款申请将直接结束，订单按原进度继续；同一笔订单本阶段无法再次申请。
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="h-11 flex-1 rounded-full border border-line text-[15px] text-ink-2 disabled:opacity-60"
        >
          再想想
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void confirm()}
          className="h-11 flex-1 rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "撤销中…" : "确认撤销"}
        </button>
      </div>
    </div>
  );
}
