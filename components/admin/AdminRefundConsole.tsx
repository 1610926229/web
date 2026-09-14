"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  ADMIN_REFUND_ACTION_LABELS,
  ADMIN_REFUND_CONFIRM_TEXTS,
  ADMIN_REFUND_MOCK_NOTICE,
  ADMIN_REFUND_TERMINAL_NOTICE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "@/lib/constants/adminRefunds";
import {
  approveRefund,
  fetchAdminRefund,
  rejectRefund,
  startReviewRefund,
} from "@/lib/services/adminHttp";
import type { AdminRefundDetail } from "@/lib/types/refund";
import { countCharacters } from "@/lib/utils/text";

/** 三个审核动作。它们都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type RefundIntent = "startReview" | "approve" | "reject";

const SUCCESS_MESSAGE: Record<RefundIntent, string> = {
  startReview: "已开始审核：退款申请标记为「审核中」，订单状态与消费金额未变",
  approve:
    "已通过（Mock 审核）：退款申请变为「已通过」，订单已变为「已退款」，不再计入用户的累计有效消费。未执行真实退款。",
  reject: "已拒绝：退款申请变为「未通过」，订单状态与消费金额未变",
};

/**
 * 退款详情的**唯一写入口**。
 *
 * 三件事在本组件里被刻意捆在一起，因为它们说的是同一句话——「谁来裁决这笔退款」：
 *
 * 1. **动作由服务端给**：按钮的出没完全按 `allowedActions`，页面不拿 `status` 自己写 `if`。
 *    终态（已通过 / 已拒绝 / 已撤销）因此天然没有按钮，而不是三个灰按钮。
 * 2. **通过是复合写入**：它会在同一次写入里把订单也改成 `refunded`。
 *    因此确认框里必须把「订单也会变、消费等级与排行榜会排除这一单」说清楚（文案在常量里）。
 * 3. **金额没有输入框**：这里没有任何地方能改退款金额，请求体里也没有这个字段。
 *
 * ⚠️ **Mock 审核**：不调用真实微信退款、不生成微信退款单号、不代表款项已真实退回。
 * 这句话以 `ADMIN_REFUND_MOCK_NOTICE` 挂在按钮下面，且**任何状态下都显示**。
 *
 * ⚠️ 确认框不是防重手段：真正的防重是「打开确认框时生成一次幂等键、重试用同一个键」
 * 加上服务端的状态判断（§九）。失败时确认框不关，错误留在原地。
 */
export default function AdminRefundConsole({ refund: initialRefund }: { refund: AdminRefundDetail }) {
  const [refund, setRefund] = useState(initialRefund);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<RefundIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const noteCount = countCharacters(note.trim());
  const noteRequired = pendingIntent === "reject";

  async function runWrite(intent: RefundIntent, key: string, reviewNote: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const call = {
        startReview: () => startReviewRefund(refund.id, key),
        approve: () => approveRefund(refund.id, key, reviewNote),
        reject: () => rejectRefund(refund.id, key, reviewNote),
      }[intent];

      await call();
      keyRef.current = null;
      setPendingIntent(null);

      // 不拿响应里的几个字段自己拼新状态：通过会同时改订单，重新取一次详情才是唯一权威。
      const fresh = await fetchAdminRefund(refund.id);
      setRefund(fresh);
      setFlash(SUCCESS_MESSAGE[intent]);
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: RefundIntent) {
    keyRef.current = crypto.randomUUID();
    setNote("");
    setNoteError(null);
    setConfirmError(null);
    setFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
    setNoteError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    if (!key || !pendingIntent || busy) return;

    // 通过的意见选填：留空就留空，只有写了才校验长度。
    // 拒绝的意见必填，且**调用与服务端同一个函数**校验（必填 + 长度上限），
    // 界面没有 `maxLength`，超长必须被明确拒绝而不是被悄悄截断。
    if (pendingIntent === "approve") {
      const trimmed = note.trim();
      if (trimmed && countCharacters(trimmed) > ADMIN_REVIEW_NOTE_MAX_LENGTH) {
        setNoteError(ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE);
        noteRef.current?.focus();
        return;
      }
      void runWrite("approve", key, trimmed);
      return;
    }

    if (pendingIntent === "reject") {
      const checked = normalizeAdminReviewNote(note);
      if (!checked.ok) {
        setNoteError(checked.message);
        noteRef.current?.focus();
        return;
      }
      void runWrite("reject", key, checked.value);
      return;
    }

    void runWrite("startReview", key, "");
  }

  const { allowedActions } = refund;
  const hasAction =
    allowedActions.canStartReview || allowedActions.canApprove || allowedActions.canReject;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">审核操作</h2>

      {hasAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("startReview")}
            disabled={!allowedActions.canStartReview}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.startReview}
          </button>
          <button
            type="button"
            onClick={() => openIntent("approve")}
            disabled={!allowedActions.canApprove}
            className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.approve}
          </button>
          <button
            type="button"
            onClick={() => openIntent("reject")}
            disabled={!allowedActions.canReject}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.reject}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_REFUND_TERMINAL_NOTICE}</p>
      )}

      {/* Mock 标注：任何状态下都在，包括「已通过」之后 */}
      <p className="mt-3 rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {ADMIN_REFUND_MOCK_NOTICE}
      </p>

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_REFUND_ACTION_LABELS[pendingIntent]}这笔退款申请` : ""}
        description={pendingIntent ? ADMIN_REFUND_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${ADMIN_REFUND_ACTION_LABELS[pendingIntent]}` : ""}
        tone={pendingIntent === "reject" ? "danger" : "primary"}
        pending={busy}
        error={confirmError}
        initialFocusRef={pendingIntent === "startReview" ? undefined : noteRef}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingIntent === "approve" || pendingIntent === "reject" ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>
                {noteRequired
                  ? "审核意见（必填，会展示给申请人）"
                  : "审核意见（选填，会展示给申请人）"}
              </span>
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
              aria-describedby={noteError ? "refund-note-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                noteError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {noteError ? (
              <span id="refund-note-error" role="alert" className="text-[12px] text-brand-red">
                {noteError}
              </span>
            ) : null}
          </label>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
