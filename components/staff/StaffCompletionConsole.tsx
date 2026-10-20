"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "@/lib/constants/adminRefunds";
import {
  STAFF_COMPLETION_ACTION_LABELS,
  STAFF_COMPLETION_CONFIRM_TEXTS,
  STAFF_COMPLETION_REFRESH_FAILED_NOTICE,
  STAFF_COMPLETION_REPLAY_NOTICE,
  STAFF_COMPLETION_TERMINAL_NOTICE,
} from "@/lib/constants/staffCompletions";
import {
  approveStaffCompletion,
  fetchStaffCompletion,
  rejectStaffCompletion,
} from "@/lib/services/staffCompletionsHttp";
import type { StaffCompletionDetail, StaffCompletionWriteResult } from "@/lib/types/completion";
import { countCharacters } from "@/lib/utils/text";

/** 客服的两个审核动作。它们都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type CompletionIntent = "approve" | "reject";

const SUCCESS_MESSAGE: Record<CompletionIntent, string> = {
  approve: "已通过：完成材料变为「已通过」，订单变为「已完成」",
  reject: "已驳回：完成材料变为「已驳回」，订单仍为「护航中」，打手可重新提交",
};

/**
 * 完成材料详情的**唯一写入口**。
 *
 * 两件事在本组件里被刻意捆在一起，因为它们说的是同一句话——「客服能对这份完成材料
 * 做什么」：
 *
 * 1. **动作由服务端给**：按钮的出没完全按 `allowedActions`，页面不拿 `status` 自己写 `if`。
 *    终态（已通过 / 已驳回 / 已失效）因此天然没有按钮，而不是一排灰按钮。
 * 2. **通过会同时把订单推进到 completed**：这是 `serving → completed` 的唯一入口之一，
 *    与驳回（只改完成材料、订单继续 serving）是两种后果完全不同的动作，各是一个接口。
 *
 * ⚠️ **没有幂等键、没有 operationId**：幂等判据是状态本身（已经是 approved / rejected
 * 就是重放），因此确认框里不生成键、`runWrite` 里也不传键。与 `StaffRefundConsole`
 * （幂等键）是两条刻意不同的机制。
 *
 * ⚠️ 失败分两种，说法与做法都不同：
 * - **写入失败**（服务端拒绝了）→ 确认框**不关**，错误留在原地；
 * - **写入已生效、但刷新详情失败** → 关掉确认框（那一笔确实成功了），
 *   提示「操作已生效，但详情刷新失败」。**不能**说成「操作失败」：那句话与事实相反，
 *   还会诱导客服再点一次。
 */
export default function StaffCompletionConsole({
  completion: initialCompletion,
}: {
  completion: StaffCompletionDetail;
}) {
  const [completion, setCompletion] = useState(initialCompletion);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<CompletionIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const noteRef = useRef<HTMLTextAreaElement>(null);

  const noteCount = countCharacters(note.trim());

  async function runWrite(intent: CompletionIntent, reviewNote: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const call = {
        approve: () => approveStaffCompletion(completion.id),
        reject: () => rejectStaffCompletion(completion.id, reviewNote),
      }[intent];

      // —— 第一步：写入。**失败时确认框不关**，错误留在原地（见文件头注释）。
      let written: StaffCompletionWriteResult;
      try {
        written = await call();
      } catch (cause) {
        setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
        return;
      }

      setPendingIntent(null);

      // —— 第二步：重新取一次详情，它才是唯一权威。
      // 不拿响应里的几个字段自己拼新状态——那样拼出来的状态迟早会和真实记录分叉。
      //
      // ⚠️ 走到这里，写入**已经生效**。因此这一步的失败**不能**报成「操作失败」。
      try {
        setCompletion(await fetchStaffCompletion(completion.id));
      } catch {
        setFlash(STAFF_COMPLETION_REFRESH_FAILED_NOTICE);
        return;
      }

      // ⚠️ 幂等重放（`changed:false`）时服务端这一次什么都没改，不能报「已通过 / 已驳回」。
      setFlash(written.changed ? SUCCESS_MESSAGE[intent] : STAFF_COMPLETION_REPLAY_NOTICE);
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: CompletionIntent) {
    setNote("");
    setNoteError(null);
    setConfirmError(null);
    setFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    setPendingIntent(null);
    setConfirmError(null);
    setNoteError(null);
  }

  function confirmIntent() {
    if (!pendingIntent || busy) return;

    // 驳回的原因必填，且**调用与服务端同一个函数**校验（必填 + 长度上限），
    // 界面没有 `maxLength`，超长必须被明确拒绝而不是被悄悄截断。
    if (pendingIntent === "reject") {
      const checked = normalizeAdminReviewNote(note);
      if (!checked.ok) {
        setNoteError(checked.message);
        noteRef.current?.focus();
        return;
      }
      void runWrite("reject", checked.value);
      return;
    }

    void runWrite("approve", "");
  }

  const { allowedActions } = completion;
  const hasAction = allowedActions.canApprove || allowedActions.canReject;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">处理操作</h2>

      {hasAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("approve")}
            disabled={!allowedActions.canApprove}
            className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {STAFF_COMPLETION_ACTION_LABELS.approve}
          </button>
          <button
            type="button"
            onClick={() => openIntent("reject")}
            disabled={!allowedActions.canReject}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {STAFF_COMPLETION_ACTION_LABELS.reject}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{STAFF_COMPLETION_TERMINAL_NOTICE}</p>
      )}

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${STAFF_COMPLETION_ACTION_LABELS[pendingIntent]}这份完成材料` : ""}
        description={pendingIntent ? STAFF_COMPLETION_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${STAFF_COMPLETION_ACTION_LABELS[pendingIntent]}` : ""}
        tone={pendingIntent === "reject" ? "danger" : "primary"}
        pending={busy}
        error={confirmError}
        initialFocusRef={pendingIntent === "approve" ? undefined : noteRef}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingIntent === "reject" ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>驳回原因（必填，会展示给打手）</span>
              {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚。 */}
              <AdminCharacterCounter current={noteCount} max={ADMIN_REVIEW_NOTE_MAX_LENGTH} />
            </span>
            <textarea
              ref={noteRef}
              value={note}
              rows={3}
              onChange={(event) => {
                const value = event.target.value;
                setNote(value);
                // 边写边说：超限立刻标红；「必填」留给提交时提示
                setNoteError(
                  countCharacters(value.trim()) > ADMIN_REVIEW_NOTE_MAX_LENGTH
                    ? ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE
                    : null,
                );
              }}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? "staff-completion-note-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                noteError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {noteError ? (
              <span
                id="staff-completion-note-error"
                role="alert"
                className="text-[12px] text-brand-red"
              >
                {noteError}
              </span>
            ) : null}
          </label>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
