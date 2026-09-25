"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PriceText from "@/components/common/PriceText";
import { DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE } from "@/lib/constants/refunds";
import { directRefund } from "@/lib/services/refundsHttp";

/**
 * 直接全额退款（P0-12）：`paid` / `accepted` 的订单，本人一点即退，**不需要客服审批**。
 *
 * 三个要点：
 *
 * 1. **只有 `canDirectRefund` 为真时才渲染**（`AfterSalesSection` 负责判断）。
 *    这个值来自服务端，前端不拿 `status` 自己算——「哪些状态免审批、哪些状态走售后」
 *    只应该有一处规则。
 * 2. **退钱是不可逆动作，所以要点两下**。第一下只是把按钮换成确认区，
 *    第二下才真的发请求。与 `RefundCancelButton` 同一条理由：这类动作不接受误触。
 * 3. **成功后 `router.refresh()`，不做本地的状态镜像**。订单一旦变成 `refunded`，
 *    服务端给的 `canDirectRefund` 随之变假、按钮自己消失；页面上「退款金额」「订单进度」
 *    等展示也全部由服务端重算——前端复制一份状态，就等于多一份会过期的真值。
 *
 * ⚠️ **确认区必须说清金额与后果**，而不是只问一句「确定吗」：
 * 用户此刻要确认的是「退多少钱、退完之后这一单会怎样」。两个金额都取自服务端
 * （`directRefundAmountCents` / `alreadyRefundedAmountCents`），**页面不自己算**。
 *
 * ⚠️ **P0-13 整改：这里报的是「本次退回多少」，不是订单实付**。
 * 部分退款不改订单状态，因此一张被部分退款过的订单仍可能停在 `paid` / `accepted`
 * 上、仍然有这个入口，但可退的只剩差额——按实付播报会报出一个到不了账的数。
 *
 * ⚠️ 没有请求体、没有幂等键——理由见 `lib/services/refundsHttp.ts` 的 `directRefund`。
 */
export default function DirectRefundButton({
  orderId,
  amountCents,
  alreadyRefundedCents,
}: {
  orderId: string;
  /** **本次会退回**多少（分）。格式化一律交给 `PriceText`，本组件不算钱也不写钱 */
  amountCents: number;
  /** 这一单在此之前已经退回过多少（分）。`0` = 第一次退款，文案不提「已退过」 */
  alreadyRefundedCents: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const pendingRef = useRef(false);

  async function confirm() {
    // 双击保护：`pending` 是渲染用的状态，同步屏障必须是 ref
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");

    try {
      await directRefund(orderId);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "退款失败，请稍后重试";
      setError(message);
      // 「已经全额退过」说明这一单在别处（超时自动退款 / 上一次点击）已经退掉了：
      // 页面上还留着按钮只是因为这一页是那一刻渲染的，拉一次最新的服务端数据才是对的答案。
      // 其余失败（例如已开始服务）不该刷新——页面没有过期，是这件事本身不能做
      if (message === DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE) router.refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="border-b border-line py-2.5 last:border-b-0">
        <button
          type="button"
          onClick={() => {
            setError("");
            setConfirming(true);
          }}
          className="h-11 w-full rounded-full border border-brand-red text-[15px] font-medium text-brand-red"
        >
          直接退款
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
    <div className="border-b border-line py-2.5 last:border-b-0">
      <p className="text-[13px] leading-5 text-ink-2">
        这一单还没有开始服务，可以直接退款{" "}
        <PriceText cents={amountCents} className="text-[15px] text-brand-red" />
        {/* 已部分退过时补一句差额的来源：不解释的话，用户会以为平台少退了钱 */}
        {alreadyRefundedCents > 0 ? (
          <>
            （这一单此前已退回{" "}
            <PriceText cents={alreadyRefundedCents} className="text-[13px]" />
            ，退满实付为止）
          </>
        ) : null}
        ，不需要客服审核。退款后订单立即结束，无法恢复；如需重新下单请再下一单。
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
          {pending ? "退款中…" : "确认退款"}
        </button>
      </div>
    </div>
  );
}
