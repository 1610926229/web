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
  STAFF_REFUND_ACTION_LABELS,
  STAFF_REFUND_CONFIRM_TEXTS,
  STAFF_REFUND_MOCK_NOTICE,
  STAFF_REFUND_REFRESH_FAILED_NOTICE,
  STAFF_REFUND_REPLAY_NOTICE,
  STAFF_REFUND_REPORT_NOTE,
  STAFF_REFUND_TERMINAL_NOTICE,
} from "@/lib/constants/staffRefunds";
import {
  fetchStaffRefund,
  rejectStaffRefund,
  startReviewStaffRefund,
} from "@/lib/services/staffRefundsHttp";
import type { StaffRefundDetail, StaffRefundWriteResult } from "@/lib/types/refund";
import { countCharacters } from "@/lib/utils/text";

/** 客服的两个审核动作。它们都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type RefundIntent = "startReview" | "reject";

const SUCCESS_MESSAGE: Record<RefundIntent, string> = {
  startReview: "已开始审核：退款申请标记为「审核中」，订单状态与消费金额未变",
  reject: "已驳回：退款申请变为「未通过」，订单状态与消费金额未变",
};

/**
 * 退款详情的**唯一写入口**。
 *
 * 两件事在本组件里被刻意捆在一起，因为它们说的是同一句话——「客服能对这笔退款做什么」：
 *
 * 1. **动作由服务端给**：按钮的出没完全按 `allowedActions`，页面不拿 `status` 自己写 `if`。
 *    终态（已通过 / 已拒绝 / 已撤销）因此天然没有按钮，而不是两个灰按钮。
 * 2. **没有「通过」按钮**：通过会在同一次写入里把订单改成「已退款」，涉及资金最终划拨，
 *    只在管理员侧。这里连一个被禁用的通过按钮都不渲染——按钮根本不存在。
 *
 * ⚠️ **Mock 审核**：不调用真实微信退款、不生成微信退款单号、不代表款项已真实退回。
 * 这句话以 `STAFF_REFUND_MOCK_NOTICE` 挂在按钮下面，且**任何状态下都显示**。
 *
 * ⚠️ 确认框不是防重手段：真正的防重是「打开确认框时生成一次幂等键、重试用同一个键」
 * 加上服务端的状态判断。
 *
 * ⚠️ 失败分两种，说法与做法都不同：
 * - **写入失败**（服务端拒绝了）→ 确认框**不关**，错误留在原地，键也留着供重试；
 * - **写入已生效、但刷新详情失败** → 关掉确认框（那一笔确实成功了），
 *   提示「操作已生效，但详情刷新失败」。**不能**说成「操作失败」：那句话与事实相反，
 *   还会诱导客服再点一次，而第二次点击带的是新键，只会撞出一个莫名其妙的 400。
 */
export default function StaffRefundConsole({ refund: initialRefund }: { refund: StaffRefundDetail }) {
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

  async function runWrite(intent: RefundIntent, key: string, reviewNote: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const call = {
        startReview: () => startReviewStaffRefund(refund.id, key),
        reject: () => rejectStaffRefund(refund.id, key, reviewNote),
      }[intent];

      // —— 第一步：写入。**失败时确认框不关**，错误留在原地（见文件头注释）。
      let written: StaffRefundWriteResult;
      try {
        written = await call();
      } catch (cause) {
        setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
        return;
      }

      keyRef.current = null;
      setPendingIntent(null);

      // —— 第二步：重新取一次详情，它才是唯一权威。
      // 不拿响应里的几个字段自己拼新状态——那样拼出来的状态迟早会和真实记录分叉。
      //
      // ⚠️ 走到这里，写入**已经生效**。因此这一步的失败**不能**报成「操作失败」：
      // 那句话与事实相反，还会诱导客服再点一次，而第二次点击带的是新键，
      // 撞上状态机只会得到一个莫名其妙的 400。
      try {
        setRefund(await fetchStaffRefund(refund.id));
      } catch {
        setFlash(STAFF_REFUND_REFRESH_FAILED_NOTICE);
        return;
      }

      // ⚠️ 幂等重放（`changed:false`）时服务端这一次什么都没改，不能报「已驳回」。
      setFlash(written.changed ? SUCCESS_MESSAGE[intent] : STAFF_REFUND_REPLAY_NOTICE);
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

    // 驳回的意见必填，且**调用与服务端同一个函数**校验（必填 + 长度上限），
    // 界面没有 `maxLength`，超长必须被明确拒绝而不是被悄悄截断。
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
  const hasAction = allowedActions.canStartReview || allowedActions.canReject;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">处理操作</h2>

      {hasAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("startReview")}
            disabled={!allowedActions.canStartReview}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {STAFF_REFUND_ACTION_LABELS.startReview}
          </button>
          <button
            type="button"
            onClick={() => openIntent("reject")}
            disabled={!allowedActions.canReject}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {STAFF_REFUND_ACTION_LABELS.reject}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{STAFF_REFUND_TERMINAL_NOTICE}</p>
      )}

      {/* 客服没有「通过」：这句必须写出来，否则「怎么没有通过按钮」会变成没人回答的问题 */}
      <p className="mt-3 rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {STAFF_REFUND_REPORT_NOTE}
      </p>

      {/* Mock 标注：任何状态下都在，包括「已通过」之后 */}
      <p className="mt-2 rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {STAFF_REFUND_MOCK_NOTICE}
      </p>

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${STAFF_REFUND_ACTION_LABELS[pendingIntent]}这笔退款申请` : ""}
        description={pendingIntent ? STAFF_REFUND_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${STAFF_REFUND_ACTION_LABELS[pendingIntent]}` : ""}
        tone={pendingIntent === "reject" ? "danger" : "primary"}
        pending={busy}
        error={confirmError}
        initialFocusRef={pendingIntent === "startReview" ? undefined : noteRef}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingIntent === "reject" ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>审核意见（必填，会展示给申请人）</span>
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
              aria-describedby={noteError ? "staff-refund-note-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                noteError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {noteError ? (
              <span
                id="staff-refund-note-error"
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
