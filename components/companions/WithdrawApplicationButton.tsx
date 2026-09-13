"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { withdrawCompanionApplication } from "@/lib/services/companionApplicationsHttp";

/**
 * 撤销入驻申请。
 *
 * 两个要点：
 *
 * 1. **只有 `allowedActions.canWithdraw` 为真时才渲染**（判断由父组件按服务端 DTO 完成）。
 *    本阶段只有「待查看」可撤销，「审核中 / 已通过 / 未通过 / 已撤销」都不可以，
 *    这条规则只应该有一处实现（`canWithdrawCompanionApplication`），前端不自己再判一遍。
 * 2. **撤销是不可逆动作，所以要点两下**：第一下只是把按钮换成确认区，第二下才真的发请求，
 *    避免误触把申请撤掉。
 *
 * 撤销成功后 `router.refresh()` 重新拉服务端数据：状态变为「已撤销」，`canWithdraw` 随之变假，
 * 按钮自己消失——不做前端本地的状态镜像。
 *
 * 撤销**只改状态、不删除记录**，申请内容与凭证仍然留在进度页上：
 * 用户要能看到自己提交过什么。
 */
export default function WithdrawApplicationButton({ applicationId }: { applicationId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  /** 同步闸门：`pending` 要等重渲染才生效，连点两下时第二次可能在重渲染之前到达 */
  const pendingRef = useRef(false);

  async function confirm() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");

    try {
      await withdrawCompanionApplication(applicationId);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "撤销失败，请稍后重试");
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
          撤销申请
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
        撤销后这次入驻申请将直接结束，申请内容与凭证仍会保留在本页。重新申请规则待确认，
        本阶段撤销后无法再次提交。
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
