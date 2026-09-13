"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  ADMIN_APPLICATION_ACTION_LABELS,
  ADMIN_APPLICATION_CONFIRM_TEXTS,
  ADMIN_APPLICATION_TERMINAL_NOTICE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "@/lib/constants/adminApplications";
import { countCharacters } from "@/lib/utils/text";
import { approveApplication, rejectApplication, startReviewApplication } from "@/lib/services/adminHttp";
import type {
  AdminApplicationReviewResult,
  AdminCompanionApplicationAllowedActions,
} from "@/lib/types/companionApplication";

/** 当前打开的确认框对应哪个动作；`null` 表示没有确认框。 */
type PendingAction = "approve" | "reject" | null;

/**
 * 申请详情页的三个审核动作。
 *
 * ⚠️ **哪些按钮可用由服务端决定**（`allowedActions`）：本组件不拿 `status` 自己写 `if`。
 * 状态机只有一处实现（`ADMIN_APPLICATION_TRANSITIONS`），前端多一处判断，
 * 就多一处会跟服务端分叉的规则——而分叉的那一处往往是界面比服务端宽松。
 *
 * 三个动作的区别在这里必须一眼可见：
 * - 「开始审核」只把状态改成「审核中」，**不通过、不建护航、不发资格**，因此没有确认框；
 * - 「通过」与「拒绝」都要二次确认，因为前者会真的建出护航资料并发放资格，
 *   后者会把一段审核意见展示给申请人。
 *
 * ⚠️ **幂等键在打开确认框时生成，并在同一次意图里保持不变**：
 * 请求失败后重试带的是同一个键，服务端因此能识别出「这是同一次操作」而不是第二次操作。
 * 成功（或取消）后才丢弃它，下一次点击是新的意图、新的键。
 * 这与「按钮禁用防重」是两回事：按钮挡不住网络重试与刷新后重发（§九）。
 */
export default function AdminApplicationActions({
  applicationId,
  allowedActions,
}: {
  applicationId: string;
  allowedActions: AdminCompanionApplicationAllowedActions;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const noteCount = countCharacters(note.trim());
  const [noteError, setNoteError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminApplicationReviewResult | null>(null);

  // 幂等键与「这一次意图」绑定：确认框打开时生成，取消或成功后清掉
  const keyRef = useRef<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  function openConfirm(action: Exclude<PendingAction, null>) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setError(null);
    if (action === "reject") {
      setNote("");
      setNoteError(null);
    }
    setPendingAction(action);
  }

  function closeConfirm() {
    if (busy) return;
    keyRef.current = null;
    setPendingAction(null);
    setConfirmError(null);
  }

  function applyResult(next: AdminApplicationReviewResult, message: string) {
    setResult(next);
    setError(null);
    // 重新渲染服务端结果：状态、时间轴、可执行动作都会跟着服务端一起更新，
    // 前端不自己推算「下一步还能做什么」
    router.refresh();
    setNote(message);
  }

  async function runStartReview() {
    if (starting) return;
    setStarting(true);
    setError(null);
    setNote("");

    try {
      const next = await startReviewApplication(applicationId, crypto.randomUUID());
      applyResult(next, `已开始审核，当前状态：${next.statusLabel}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setStarting(false);
    }
  }

  async function confirmApprove() {
    const key = keyRef.current;
    if (!key || busy) return;
    setBusy(true);
    setConfirmError(null);

    try {
      const next = await approveApplication(applicationId, key);
      keyRef.current = null;
      setPendingAction(null);
      applyResult(
        next,
        next.companionId
          ? `已通过审核，护航资料已就绪（${next.companionId}）`
          : "已通过审核，护航资料已就绪",
      );
    } catch (cause) {
      // 不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function confirmReject() {
    const key = keyRef.current;
    if (!key || busy) return;

    // 与服务端**同一个函数**校验审核意见，因此不会出现「前端说能提交、服务端却拒绝」
    const checked = normalizeAdminReviewNote(note);
    if (!checked.ok) {
      setNoteError(checked.message);
      noteRef.current?.focus();
      return;
    }

    setBusy(true);
    setConfirmError(null);

    try {
      const next = await rejectApplication(applicationId, key, checked.value);
      keyRef.current = null;
      setPendingAction(null);
      applyResult(next, "已拒绝这份申请，审核意见已记录");
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const hasAnyAction =
    allowedActions.canStartReview || allowedActions.canApprove || allowedActions.canReject;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">审核操作</h2>

      {hasAnyAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* 开始审核：只改状态，没有确认框——它不产生任何不可撤销的后果 */}
          <button
            type="button"
            onClick={() => void runStartReview()}
            disabled={!allowedActions.canStartReview || starting}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {starting ? "处理中…" : ADMIN_APPLICATION_ACTION_LABELS.startReview}
          </button>

          <button
            type="button"
            onClick={() => openConfirm("approve")}
            disabled={!allowedActions.canApprove}
            className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {ADMIN_APPLICATION_ACTION_LABELS.approve}
          </button>

          <button
            type="button"
            onClick={() => openConfirm("reject")}
            disabled={!allowedActions.canReject}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {ADMIN_APPLICATION_ACTION_LABELS.reject}
          </button>
        </div>
      ) : (
        // 终态不给一排灰按钮，直接说明原因：灰按钮会让人反复猜「为什么点不了」
        <p className="mt-3 text-[13px] leading-5 text-ink-3">{ADMIN_APPLICATION_TERMINAL_NOTICE}</p>
      )}

      <p className="mt-3 text-[12px] leading-4 text-ink-3">
        通过会追加护航资格并创建（或关联）一条护航资料，申请人的老板身份不变；
        三件事与审核记录一起写入，不会出现只写一半的状态。
      </p>

      {note ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {note}
          {result?.companionId ? (
            <>
              {" "}
              <Link
                href={`/admin/companions/${result.companionId}`}
                className="text-admin-accent underline-offset-2 hover:underline"
              >
                查看护航资料
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-brand-red">
          {error}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingAction === "approve"}
        title={`${ADMIN_APPLICATION_ACTION_LABELS.approve}这份申请`}
        description={ADMIN_APPLICATION_CONFIRM_TEXTS.approve}
        confirmLabel={`确认${ADMIN_APPLICATION_ACTION_LABELS.approve}`}
        tone="primary"
        pending={busy}
        error={confirmError}
        onConfirm={() => void confirmApprove()}
        onCancel={closeConfirm}
      />

      <AdminConfirmDialog
        open={pendingAction === "reject"}
        title={`${ADMIN_APPLICATION_ACTION_LABELS.reject}这份申请`}
        description={ADMIN_APPLICATION_CONFIRM_TEXTS.reject}
        confirmLabel={`确认${ADMIN_APPLICATION_ACTION_LABELS.reject}`}
        pending={busy}
        error={confirmError}
        initialFocusRef={noteRef}
        onConfirm={() => void confirmReject()}
        onCancel={closeConfirm}
      >
        <label className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
            <span>审核意见（必填，申请人可见）</span>
            {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚。 */}
            <AdminCharacterCounter current={noteCount} max={ADMIN_REVIEW_NOTE_MAX_LENGTH} />
          </span>
          <textarea
            ref={noteRef}
            value={note}
            onChange={(event) => {
              const value = event.target.value;
              setNote(value);
              // 边写边说：超限立刻标红，其余错误（比如空）留给提交时提示，
              // 免得刚删掉一个字就被说「必填」
              setNoteError(
                countCharacters(value.trim()) > ADMIN_REVIEW_NOTE_MAX_LENGTH
                  ? ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE
                  : null,
              );
            }}
            rows={3}
            aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? "reject-note-error" : undefined}
            className={`w-full resize-y rounded-lg border px-3 py-2 text-[13px] text-ink outline-none ${
              noteError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            }`}
          />
        </label>
        {noteError ? (
          <p id="reject-note-error" role="alert" className="mt-1 text-[12px] text-brand-red">
            {noteError}
          </p>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
