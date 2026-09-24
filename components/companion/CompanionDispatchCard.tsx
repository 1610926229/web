"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COMPANION_ACCEPTING_LABEL,
  COMPANION_ACCEPT_LABEL,
  COMPANION_ACCEPT_NOTICE,
  COMPANION_ACCEPT_PAUSED_NOTICE,
  DISPATCH_ACCEPT_FAILURE_LABELS,
  DISPATCH_ACCEPT_SUCCESS_LABEL,
} from "@/lib/constants/dispatch";
import { acceptDispatchRequest } from "@/lib/services/companionHttp";
import type { CompanionPoolItem } from "@/lib/types/dispatch";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 池子里的一张订单卡片 + **接单按钮**。
 *
 * ## 为什么没有「放弃 / 拒绝」按钮
 *
 * 打手不想接的时候**什么都不用做**：专属池的单在他手里留 10 分钟，
 * 到点自动进入公共池；公共池的单本来就不是「派给他的」，等别人接走或超时即可。
 * 「不接」本身就是拒绝，因此这里没有第二个按钮，接口里也没有对应的路由。
 *
 * ## 为什么要点两下
 *
 * 接单之后**不能一键反悔**：要退出得在开始服务前提交原因取消接单（P0-6，`accepted → paid`，
 * 订单回到公共订单池，下单用户会收到一条通知）。⚠️ 这句话在 P0-6 之前写的是
 * 「接单是不可逆的」，而那条规则**已经改掉**——留着一句被改掉的规则，
 * 读代码的人会以为下面这段确认逻辑的代价算错了。
 *
 * 误触的代价仍然是把一整张单扛在自己身上，因此第一次点击只把按钮换成确认区，
 * 第二下才真的发请求——与 `RefundCancelButton`（撤销退款申请）同一个取舍。
 * `COMPANION_ACCEPT_NOTICE` 常驻在按钮上方：这件事必须让人**在点之前**知道。
 *
 * ## 结果由服务端说了算
 *
 * 点下去之后可能被别人先接走、可能刚好到点、可能订单已被退款。
 * 这些都不是「出错」，而是**业务结果**（接口按 200 返回 `kind`），
 * 因此这里按 `kind` 说清「发生了什么、要不要刷新」，而不是把所有失败
 * 塞进一个 `catch` ——那里分不出「被抢了」和「网断了」。
 * 真正的 `catch` 只留给鉴权失败与网络异常。
 *
 * 接单成功后 `router.refresh()` 重新拉服务端数据，这张卡自己从池子里消失，
 * 前端不做任何本地状态镜像。
 *
 * ## `canAccept` 为 false 时没有按钮
 *
 * 那是「这位打手当前暂停接单」（`available = false`）。此时这张卡**不再渲染接单按钮**，
 * 只留一行说明——但他仍然看得到这张卡：用户指定给他的专属派单是**历史事实**，
 * 不会因为他暂时接不了单就消失。
 *
 * ⚠️ **这不是保护**。藏起按钮只让人不去点，伪造请求直接打接口一样能提交；
 * 真正的拦住发生在 `acceptDispatch` 的原子区段里（同一段代码里再判一次
 * `available`，不通过就返回 `companion-unavailable`）。这里的隐藏是**诚实**问题，不是安全问题。
 */
export default function CompanionDispatchCard({
  item,
  canAccept,
}: {
  item: CompanionPoolItem;
  /** 由服务端在同一次池子读取里给出，页面不自己推断（见 `CompanionPoolData`） */
  canAccept: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const router = useRouter();
  // 双击防重：state 更新是异步的，第二次点击可能赶在 disabled 生效之前到达
  const pendingRef = useRef(false);

  async function accept() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage("");

    try {
      const result = await acceptDispatchRequest(item.dispatchId);
      if (result.kind === "ok") {
        setDone(true);
        setMessage(DISPATCH_ACCEPT_SUCCESS_LABEL);
        // 重新取服务端数据：这一单会从池子里消失，不用前端自己删
        router.refresh();
        return;
      }
      setConfirming(false);
      setMessage(DISPATCH_ACCEPT_FAILURE_LABELS[result.kind]);
    } catch (cause) {
      // 到这里只剩鉴权失败（401 / 403）与网络异常——业务上的失败走的是上面的分支
      setMessage(cause instanceof Error ? cause.message : "接单失败，请稍后重试");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <li className="rounded-2xl border border-line px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-medium text-ink">
          {item.productTitle}
        </span>
        <span className="shrink-0 rounded-full bg-page px-2 py-0.5 text-[11px] text-ink-3">
          {item.poolLabel}
        </span>
      </div>

      <p className="mt-1 text-[12px] leading-5 text-ink-3">{item.specName}</p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span>游戏：{item.gameName}</span>
        <span>数量：×{item.quantity}</span>
        <span>下单：{formatDateTime(item.paidAt)}</span>
      </div>

      <p className="mt-1 text-[12px] text-ink-3">订单号：{item.orderNo}</p>

      {/*
        剩余时间是**服务端在这一刻算好的一个数**，页面不自己跑倒计时：
        到没到点由服务端的 deadline 判定，页面上的数字不参与任何决定，
        它自己往下走只会让人以为「跑到 0 就能多等一会儿」。
      */}
      <p className="mt-2 text-[12px] text-ink-2">
        {item.poolLabel}剩余 {formatRemaining(item.remainingSeconds)}
      </p>

      {!canAccept ? (
        <p className="mt-3 text-[12px] leading-5 text-ink-3">{COMPANION_ACCEPT_PAUSED_NOTICE}</p>
      ) : done ? (
        <p role="status" className="mt-3 text-[12px] leading-5 text-ink-2">
          {message}
        </p>
      ) : confirming ? (
        <div className="mt-3">
          <p className="text-[12px] leading-5 text-ink-2">{COMPANION_ACCEPT_NOTICE}</p>
          {message ? (
            <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
              {message}
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setMessage("");
                setConfirming(false);
              }}
              className="h-10 flex-1 rounded-full border border-line text-[14px] text-ink-2 disabled:opacity-60"
            >
              再想想
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void accept()}
              className="h-10 flex-1 rounded-full bg-brand-red text-[14px] font-medium text-white disabled:opacity-60"
            >
              {pending ? COMPANION_ACCEPTING_LABEL : `确认${COMPANION_ACCEPT_LABEL}`}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-[12px] leading-5 text-ink-3">{COMPANION_ACCEPT_NOTICE}</p>
          {message ? (
            <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
              {message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setMessage("");
              setConfirming(true);
            }}
            className="mt-2 h-10 w-full rounded-full bg-brand-red text-[14px] font-medium text-white"
          >
            {COMPANION_ACCEPT_LABEL}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * 剩余时间的显示口径：只说「还剩多久」，不显示秒。
 *
 * 秒数由服务端算好（`remainingSeconds`，已过点时为 0）。
 * 「剩 12 秒」这种写法看着像在倒数，而它其实不会再变——页面渲染完就定住了。
 */
function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "即将结束";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分钟` : "不到 1 分钟";
}
