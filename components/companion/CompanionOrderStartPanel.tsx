"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  COMPANION_START_CONFIRM_LABEL,
  COMPANION_START_CONFIRM_NOTICE,
  COMPANION_START_LABEL,
  COMPANION_START_PENDING_LABEL,
  COMPANION_START_SUCCESS_LABEL,
} from "@/lib/constants/dispatch";
import { startCompanionOrderRequest } from "@/lib/services/companionHttp";

/**
 * 「开始服务」（P0-7）—— 打手把一个 `accepted` 订单推进到 `serving`。
 *
 * ## 什么时候会被渲染
 *
 * 由**服务端**决定：只有 `detail.canStart`（就是 `status === "accepted"`）为真时
 * 详情页才渲染本组件。这里**不拿订单状态自己再判一次**——状态与规则各写一份，
 * 分叉的那天页面上会出现一个点下去必然失败的按钮。`canStart` 只是**诚实性**提示，
 * 真正的保护在 `startCompanionOrder` 的原子区段里（同一段代码里再判一次归属与状态）。
 *
 * ## 为什么要点两下
 *
 * 与接单（`CompanionDispatchCard`）、取消接单（`CompanionOrderCancelPanel`）同一取舍，
 * 而且这里更必要：开始服务之后**没有**普通「取消接单」这条路（需求里 `serving`
 * 不允许打手主动取消），这是一扇**单向门**。因此第一下只是展开确认区，
 * 第二下（`确认开始服务`）才真的发请求。
 *
 * ⚠️ 与取消不同，这里**没有输入框、没有幂等键**：这个动作没有原因、没有附属记录，
 * 幂等的判据是**状态本身**（已经是 `serving` 且归本人就是重放）。给它编一个键，
 * 等于替服务端发明一条它并不要求的规则。
 *
 * ## 成功后 `router.refresh()`——与取消面板**刻意相反**
 *
 * 两处相反，理由也相反：
 *
 * - 取消之后这一单**已经不属于他**，再取一次详情会走 404（服务端重新校验归属），
 *   刷新会把成功反馈换成「订单不存在或不可操作」；
 * - 开始服务之后这一单**仍然是他的**，刷新正是让页面反映 `serving`、
 *   让「开始服务」与「取消接单」两个入口一起消失的**正确**做法，
 *   也就满足「不要求重新登录或重新进入订单」。
 *
 * ⚠️ 因此这个成功提示可能只出现一瞬间（刷新的结果一到，本节就被服务端渲染的
 * `serving` 详情替换掉了）。这是**有意**的：那一瞬间的提示是给点击到刷新落地之间看的，
 * 而刷新后的页面本身才是持久的反馈——状态变成「护航中」、两个按钮都不在。
 * 也因此这里**没有**「返回我的订单」按钮：页面没有离开，没有必要再给一条出口。
 *
 * ## 失败文案来自服务端
 *
 * 400（状态不允许）与 404（不存在或不可操作）的 message 都由接口给出，
 * 这里只负责显示，不另写一套——两套文案迟早会有一处是旧的。
 */
export default function CompanionOrderStartPanel({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // 双击防重：state 更新是异步的，第二次点击可能赶在 disabled 生效之前到达。
  // ⚠️ 与取消不同，这里**不是为了保住幂等键**（本动作没有键），只是为了不白发两次请求
  // ——就算真的发出去两次，第二次服务端也是重放
  const pendingRef = useRef(false);

  /** 「再想想」：放弃这次意图，收起确认区。 */
  function abort() {
    setError("");
    setOpen(false);
  }

  async function submit() {
    if (pendingRef.current) return;

    pendingRef.current = true;
    setPending(true);
    setError("");

    try {
      await startCompanionOrderRequest(orderId);
      // 重放（`replayed`）与首次成功（`ok`）说同一句话：对打手是同一个结果
      setDone(true);
      // 让服务端重新渲染这一页：状态变成「护航中」，两个入口一起消失
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "开始服务失败，请稍后重试");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (done) {
    return (
      <section className="rounded-2xl border border-line px-4 py-4">
        <p role="status" className="text-[13px] leading-5 text-ink">
          {COMPANION_START_SUCCESS_LABEL}
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <section className="rounded-2xl border border-line px-4 py-4">
        <button
          type="button"
          onClick={() => {
            setError("");
            setOpen(true);
          }}
          className="h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white"
        >
          {COMPANION_START_LABEL}
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">{COMPANION_START_LABEL}</h2>

      <p className="text-[12px] leading-5 text-ink-3">{COMPANION_START_CONFIRM_NOTICE}</p>

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
          {pending ? COMPANION_START_PENDING_LABEL : COMPANION_START_CONFIRM_LABEL}
        </button>
      </div>
    </section>
  );
}
