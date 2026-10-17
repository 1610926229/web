"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  COMPANION_CANCEL_CONFIRM_LABEL,
  COMPANION_CANCEL_CONFIRM_NOTICE,
  COMPANION_CANCEL_LABEL,
  COMPANION_CANCEL_PENDING_LABEL,
  COMPANION_CANCEL_REASON_LABEL,
  COMPANION_CANCEL_REASON_PLACEHOLDER,
  COMPANION_CANCEL_REASON_REQUIRED_MESSAGE,
  COMPANION_CANCEL_SUCCESS_LABEL,
  COMPANION_ORDERS_BACK_LABEL,
} from "@/lib/constants/dispatch";
import { cancelCompanionOrderRequest } from "@/lib/services/companionHttp";

/**
 * 「取消接单」（P0-6）—— 打手订单详情页上唯一的写操作。
 *
 * ## 什么时候会被渲染
 *
 * 由**服务端**决定：只有 `detail.canCancel`（就是 `status === "accepted"`）为真时
 * 详情页才渲染本组件。这里**不拿订单状态自己再判一次**——状态与规则各写一份，
 * 分叉的那天页面上会出现一个点下去必然失败的按钮。`canCancel` 只是**诚实性**提示，
 * 真正的保护在 `cancelAcceptedOrder` 的原子区段里（同一段代码里再判一次归属与状态）。
 *
 * ## 为什么要填原因、为什么要点两下
 *
 * 取消不是「返回上一步」：它把这一单从你名下摘掉、让别人重新接、并给下单用户发一条
 * 通知。因此第一下只是展开原因表单，第二下（`确认取消接单`）才真的发请求
 * ——与 `CompanionDispatchCard` 的接单、`RefundCancelButton` 的撤销同一取舍。
 *
 * 原因**必填**，但只做 `trim()` + 拒绝空串：需求没有冻结任何字数规则，
 * 因此这里没有 `maxLength`、没有「x~y 字」的提示（见 `COMPANION_CANCEL_REASON_PLACEHOLDER`）。
 *
 * ## 幂等键：在**展开表单时**生成一次，之后不再变
 *
 * 同一个键第二次到达时服务端返回第一次的结果（`kind: "replayed"`）而不是再写一条
 * 退出历史，因此「连点两次」「断网后重试」都会得到同一个成功结果，而不是一个
 * 让人以为订单丢了的 404。键要在整个「一次取消意图」里保持不变，所以它**不随
 * 输入框内容变化**：失败重试时用户往往正在改那句原因，换键就会把重放变成 400。
 * 「再想想」把它清掉——重新展开表单是一次**新的**意图，那时该拿一个新键。
 *
 * ## 成功后为什么不自动跳转、也不 `router.refresh()`
 *
 * 取消之后这一单**已经不属于他**：再向服务端要一次详情会走 404（服务端重新校验归属），
 * 刷新会把刚出现的成功反馈直接换成「订单不存在或不可操作」——一个刚点完取消的人
 * 看到那句话，只会以为是自己把订单弄丢了。因此成功后本节停留在原地给出明确反馈，
 * 并给一个直接的入口回列表；列表是**重新从服务端取**的，因此那一单确实已经不在里面。
 *
 * ## 失败文案来自服务端
 *
 * 400（原因必填 / 状态不允许）与 404（不存在或不可操作）的 message 都由接口给出，
 * 这里只负责显示，不另写一套——两套文案迟早会有一处是旧的。
 */
export default function CompanionOrderCancelPanel({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // 双击防重：state 更新是异步的，第二次点击可能赶在 disabled 生效之前到达
  const pendingRef = useRef(false);
  const keyRef = useRef<string | null>(null);

  /** 展开表单：生成这一次取消意图的幂等键。 */
  function startCancel() {
    keyRef.current = crypto.randomUUID();
    setReason("");
    setError("");
    setOpen(true);
  }

  /** 「再想想」：放弃这次意图，键一并作废（下次展开要拿一个新键）。 */
  function abort() {
    keyRef.current = null;
    setError("");
    setOpen(false);
  }

  async function submit() {
    if (pendingRef.current) return;

    const trimmed = reason.trim();
    if (!trimmed) {
      // 与接口同一条规则、同一句话：本地这一下只是不白跑一趟网络
      setError(COMPANION_CANCEL_REASON_REQUIRED_MESSAGE);
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError("");

    // 正常情况下键已经在 startCancel 里生成；这里兜一下，避免出现「不带键的取消请求」
    keyRef.current ??= crypto.randomUUID();

    try {
      await cancelCompanionOrderRequest(orderId, {
        reason: trimmed,
        idempotencyKey: keyRef.current,
      });
      // 重放（`replayed`）与首次成功（`ok`）说同一句话：对打手是同一个结果
      setDone(true);
    } catch (cause) {
      // 失败**不清空原因**：改一下就能用同一个键重试
      setError(cause instanceof Error ? cause.message : "取消接单失败，请稍后重试");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (done) {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-4">
        <p role="status" className="text-[13px] leading-5 text-ink">
          {COMPANION_CANCEL_SUCCESS_LABEL}
        </p>
        <Link
          href="/companion/orders"
          className="flex h-11 items-center justify-center rounded-full bg-brand-red text-[15px] font-medium text-white"
        >
          {COMPANION_ORDERS_BACK_LABEL}
        </Link>
      </section>
    );
  }

  if (!open) {
    return (
      <section className="rounded-2xl border border-line px-4 py-4">
        <button
          type="button"
          onClick={startCancel}
          className="h-11 w-full rounded-full border border-line text-[15px] text-ink-2"
        >
          {COMPANION_CANCEL_LABEL}
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">
        {COMPANION_CANCEL_REASON_LABEL} <span className="text-brand-red">*</span>
      </h2>

      <p className="text-[12px] leading-5 text-ink-3">{COMPANION_CANCEL_CONFIRM_NOTICE}</p>

      {/*
        只 trim + 拒绝空串。**不加 maxLength、不加字数提示**：需求没有冻结字数规则，
        加上去就是自己造一条服务端并不执行的规则。
      */}
      <textarea
        value={reason}
        disabled={pending}
        onChange={(event) => setReason(event.target.value)}
        rows={4}
        placeholder={COMPANION_CANCEL_REASON_PLACEHOLDER}
        aria-label={COMPANION_CANCEL_REASON_LABEL}
        className="w-full resize-none rounded-[8px] bg-page px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
      />

      {error ? (
        <p role="alert" className="text-[12px] leading-4 text-brand-red">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={abort}
          className="h-11 flex-1 rounded-full border border-line text-[15px] text-ink-2 disabled:opacity-60"
        >
          再想想
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="h-11 flex-1 rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? COMPANION_CANCEL_PENDING_LABEL : COMPANION_CANCEL_CONFIRM_LABEL}
        </button>
      </div>
    </section>
  );
}
