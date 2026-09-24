"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import EvidencePicker from "@/components/common/EvidencePicker";
import {
  COMPLETION_ORDER_NOT_SERVING_MESSAGE,
  COMPLETION_SUMMARY_MAX_LENGTH,
  COMPLETION_SUMMARY_MIN_LENGTH,
  COMPLETION_SUMMARY_TOO_LONG_MESSAGE,
  COMPLETION_SUMMARY_TOO_SHORT_MESSAGE,
  normalizeCompletionSummary,
} from "@/lib/constants/completions";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { submitCompanionCompletionRequest } from "@/lib/services/companionHttp";
import type { CompanionCompletionInfo } from "@/lib/types/completion";
import { formatDateTime } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";

/**
 * 「完成材料」（P0-8）—— 打手在 `serving` 的本人订单上提交完成说明与凭证。
 *
 * ## 入口显隐只看 `completion`，不自己用订单状态推断
 *
 * `completion` 是服务端算好的摘要（`status` / `canSubmit` / `autoApprovalDeadlineAt` /
 * `rejectReason`）。「能不能提交」涉及「serving + 无 pending + 最近一次不是 approved」
 * 三条规则，页面再拿订单状态自己推一遍，就是在这层再写一份规则——真正的保护在
 * `submitCompletion` 的原子区段里。因此本组件**始终渲染一块**，只是三种形态：
 * 提交表单 / 「完成审核中」 / 一句不能提交的原因，而不是「不能提交就消失」。
 *
 * ## 三态与 `completion` 的对应
 *
 * - `status === "pending"` → 「完成审核中」+ 自动审核截止（`autoApprovalDeadlineAt`）。
 *   这个阶段不显示提交时间：`CompanionCompletionInfo` 上**没有** `submittedAt`，
 *   页面不得凭空编一个。
 * - `canSubmit` → 表单；若最近一次是 `rejected`，上方会带驳回原因（`rejectReason`）。
 * - 其余（`canSubmit === false` 且非 pending）→ 一句人话原因：
 *   `approved` 是「已通过，订单已完成」；`rejected` 是订单已不在护航中；
 *   `null` 直接复用接口那同一句 `COMPLETION_ORDER_NOT_SERVING_MESSAGE`。
 *
 * ## 成功后 `router.refresh()`（与「开始服务」同一取舍）
 *
 * 提交之后这一单仍是他的，刷新让页面反映 `pending`、让表单换成「完成审核中」。
 * 面板**始终在页面上**（不像开始服务那个面板会整体卸载），因此服务端刷新后要
 * **采纳新的 `completion` 快照并清空上一轮提交留下的本地状态**——判据用引用，
 * 只有服务端真的重新取过数，`completion` 才会换引用（与 `StaffRefundTable` 同理）。
 *
 * ## 校验与文案
 *
 * 完成说明的 5～50 字用 `normalizeCompletionSummary` / `countCharacters`（与服务端
 * 同一个函数），凭证走 `EvidencePicker`（最多 6 个，可以 0 个）。提交失败只显示
 * 服务端给的 message，不另写一套文案。
 */
export default function CompanionCompletionPanel({
  orderId,
  completion,
}: {
  orderId: string;
  completion: CompanionCompletionInfo;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // 双击防重：state 更新是异步的，第二次点击可能赶在 disabled 生效之前到达
  const pendingRef = useRef(false);

  // 服务端重新取数后采纳新快照，并清掉上一轮提交的本地状态（引用比较，见文件头）
  const [serverSnapshot, setServerSnapshot] = useState(completion);
  if (serverSnapshot !== completion) {
    setServerSnapshot(completion);
    setDraft("");
    setEvidence([]);
    setError("");
    setDone(false);
  }

  const { status, canSubmit, autoApprovalDeadlineAt, rejectReason } = completion;

  async function submit() {
    if (pendingRef.current) return;

    const checked = normalizeCompletionSummary(draft);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError("");

    try {
      await submitCompanionCompletionRequest(orderId, {
        summary: checked.value,
        evidence,
      });
      setDone(true);
      // 让服务端重新渲染这一页：`completion` 变成 pending，表单换成「完成审核中」
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const trimmed = draft.trim();
  const count = countCharacters(trimmed);
  let liveHint: string | null = null;
  if (trimmed && count < COMPLETION_SUMMARY_MIN_LENGTH) {
    liveHint = COMPLETION_SUMMARY_TOO_SHORT_MESSAGE;
  } else if (count > COMPLETION_SUMMARY_MAX_LENGTH) {
    liveHint = COMPLETION_SUMMARY_TOO_LONG_MESSAGE;
  }

  const noEntryText =
    status === "approved"
      ? "完成材料已通过，订单已完成"
      : status === "rejected"
        ? "订单已不在护航中，无法重新提交"
        : status === "invalidated"
          ? "完成材料已失效"
          : COMPLETION_ORDER_NOT_SERVING_MESSAGE;

  return (
    <section className="rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">完成材料</h2>

      {/* 驳回原因在「重新提交」与「订单已离开护航」两种形态下都要露出来 */}
      {rejectReason ? (
        <p className="mt-2 rounded-lg bg-page px-3 py-2 text-[12px] leading-5 text-brand-red">
          驳回原因：{rejectReason}
        </p>
      ) : null}

      {status === "pending" ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-[14px] font-semibold text-ink">完成审核中</p>
          <p className="text-[12px] leading-5 text-ink-3">
            自动审核截止：{autoApprovalDeadlineAt ? formatDateTime(autoApprovalDeadlineAt) : "—"}
          </p>
        </div>
      ) : canSubmit ? (
        <div className="mt-2 flex flex-col gap-3">
          {done ? (
            <p role="status" className="text-[13px] leading-5 text-ink">
              已提交，等待审核
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2 text-[13px] text-ink-2">
                  <span>完成说明</span>
                  <span className={`text-[12px] ${liveHint ? "text-brand-red" : "text-ink-3"}`}>
                    {count}/{COMPLETION_SUMMARY_MAX_LENGTH}
                  </span>
                </span>
                <textarea
                  value={draft}
                  rows={3}
                  disabled={pending}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError("");
                  }}
                  placeholder={`${COMPLETION_SUMMARY_MIN_LENGTH}~${COMPLETION_SUMMARY_MAX_LENGTH} 个字，说明本次护航的完成情况`}
                  className="rounded-lg border border-line px-3 py-2 text-[13px] leading-5 text-ink outline-none focus:border-ink-2 disabled:opacity-60"
                />
              </label>

              <EvidencePicker value={evidence} onChange={setEvidence} disabled={pending} />

              {liveHint ? (
                <p role="alert" className="text-[12px] leading-4 text-brand-red">
                  {liveHint}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-[12px] leading-4 text-brand-red">
                  {error}
                </p>
              ) : null}

              <button
                type="button"
                disabled={pending}
                onClick={() => void submit()}
                className="h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
              >
                {pending ? "提交中…" : "提交完成材料"}
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-5 text-ink-3">{noEntryText}</p>
      )}
    </section>
  );
}
