"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { toAdminReviewAllowedActions } from "@/lib/constants/adminReviews";
import {
  REVIEW_MODERATION_ACTION_LABELS,
  REVIEW_MODERATION_REQUIRES_REASON,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_TOO_LONG_MESSAGE,
  normalizeReviewReason,
  type ReviewModerationAction,
} from "@/lib/constants/reviews";
import {
  approveAdminReview,
  hideAdminReview,
  rejectAdminReview,
  unhideAdminReview,
} from "@/lib/services/adminHttp";
import type { AdminReviewDetail, AdminReviewWriteResult } from "@/lib/types/review";
import { countCharacters } from "@/lib/utils/text";

/**
 * 四个动作的后果说明——**动手之前**必须让人看清的事。
 *
 * 通过 / 恢复公开会让内容进入公开面并计入评分，驳回 / 隐藏会让它不可见。
 * 这四句话与 `REVIEW_MODERATION_ACTION_LABELS` 的动作名一起，构成确认框的全部内容。
 */
const CONFIRM_TEXTS: Record<ReviewModerationAction, string> = {
  approve: "通过后这条评价会出现在商品页与打手页，并计入对应维度的评分。",
  reject: "驳回后这条评价不会公开。作者会看到你填写的原因，可以修改后重新提交同一条评价。",
  hide: "隐藏后这条评价立即从商品页与打手页撤下，不再计入评分。作者会看到你填写的原因。",
  unhide: "恢复公开后这条评价重新出现在商品页与打手页，并再次计入评分。",
};

/**
 * 评价详情的**唯一写入口**。
 *
 * ## 按钮的可用性完全来自 `allowedActions`（`D21`）
 *
 * 四个按钮**全部渲染**，禁用态逐个取自服务端给的 `canApprove` / `canReject` /
 * `canHide` / `canUnhide`。这里刻意**不写** `status === "pending"` 这类判断——
 * 那等于把状态机在界面这一侧再抄一遍，抄漏的那一条会表现为「某个动作永远点不了」。
 * 服务端才是真正的拦截（前端拿着 `canApprove: true` 去改一条不该改的评价一样 400）。
 *
 * ## 原因只在 reject / hide 上要（`D10`）
 *
 * 这两件事都在对用户做负面判定，不写原因用户既改不了也无从申辩。
 * 通过不要求（它是默认预期）；恢复公开不要求业务原因，但**照样写审计**（`D11`）——
 * 「谁把一条隐藏的评价放回公开列表」本身就是要能追溯的事实。
 *
 * 原因校验调用与服务端**同一个函数**（`normalizeReviewReason`）：同一份规则两边各写一遍，
 * 迟早会出现「前端放过、后端 400」这种没人能解释的失败。
 *
 * ## 成功后**就地更新**
 *
 * 响应只回 `status` / `statusLabel`（`changed` 说明这次是不是真的改了）。
 * 界面据此更新那一行，并用 `toAdminReviewAllowedActions()` 重算四个动作的可用性
 * ——它与服务端写入路径读的是同一个函数，因此不会出现「改完之后按钮还停留在旧状态」。
 *
 * ⚠️ **本组件没有「改星级 / 改正文」的入口**（`D12`）：请求体里根本没有这两个字段的位置。
 */
export default function AdminReviewConsole({
  review: initialReview,
}: {
  review: AdminReviewDetail;
}) {
  const router = useRouter();
  const [review, setReview] = useState(initialReview);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingAction, setPendingAction] = useState<ReviewModerationAction | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const reasonRequired = pendingAction
    ? REVIEW_MODERATION_REQUIRES_REASON[pendingAction]
    : false;
  const reasonCount = countCharacters(reason.trim());

  async function runWrite(
    action: ReviewModerationAction,
    normalizedReason: string | null,
    request: () => Promise<AdminReviewWriteResult>,
  ) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const written = await request();
      keyRef.current = null;
      setPendingAction(null);
      setReason("");

      // 就地更新那一行，不重新拉整页：响应里的状态就是权威值。
      // 可执行动作由 `toAdminReviewAllowedActions()` 按**新状态**重算——
      // 与服务端写入路径读的是同一个函数，界面因此不会比服务端宽或窄。
      setReview((current) => ({
        ...current,
        status: written.status,
        statusLabel: written.statusLabel,
        rejectReason: action === "reject" ? normalizedReason : current.rejectReason,
        hideReason: action === "hide" ? normalizedReason : current.hideReason,
        allowedActions: toAdminReviewAllowedActions(written.status),
      }));

      // `changed === false` 是**成功**（本来就是目标状态 / 同一幂等键重放），
      // 但绝不能说成「已通过」——那会让管理员以为刚发生了一次状态变化。
      setFlash(
        written.changed
          ? `${REVIEW_MODERATION_ACTION_LABELS[action]}成功：这条评价现在是「${written.statusLabel}」`
          : `该评价已是「${written.statusLabel}」状态，无需重复操作`,
      );

      // 就地更新只够这一块（它自己维护状态）。上面的只读区块是**服务端组件**，
      // 里的状态角标与「最近审核 / 审核人」不会跟着动——不刷一次，
      // 页面上会同时出现「审核中」的角标和「通过成功」的提示。`refresh()` 让
      // 服务端把最新的那条评价重新取一遍，客户端的本地状态不会被重置。
      router.refresh();
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(action: ReviewModerationAction) {
    // 一次「操作意图」一个幂等键：失败重试沿用同一个，服务端按它重放第一次的结果
    keyRef.current = crypto.randomUUID();
    setReason("");
    setReasonError(null);
    setConfirmError(null);
    setFlash("");
    setPendingAction(action);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingAction(null);
    setConfirmError(null);
    setReasonError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    const action = pendingAction;
    if (!key || !action || busy) return;

    // 与服务端同一个函数校验（必填 + 长度上限）；界面不用 `maxLength` 静默截断
    const checked = normalizeReviewReason(reason, REVIEW_MODERATION_REQUIRES_REASON[action]);
    if (!checked.ok) {
      setReasonError(checked.message);
      reasonRef.current?.focus();
      return;
    }

    void runWrite(action, checked.reason, () => {
      if (action === "approve") return approveAdminReview(review.id, key);
      if (action === "unhide") return unhideAdminReview(review.id, key);
      // reject / hide 的原因必填，`normalizeReviewReason` 已保证这里非空
      return action === "reject"
        ? rejectAdminReview(review.id, key, checked.reason ?? "")
        : hideAdminReview(review.id, key, checked.reason ?? "");
    });
  }

  const { allowedActions } = review;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">审核操作</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => openIntent("approve")}
          disabled={!allowedActions.canApprove}
          className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {REVIEW_MODERATION_ACTION_LABELS.approve}
        </button>
        <button
          type="button"
          onClick={() => openIntent("reject")}
          disabled={!allowedActions.canReject}
          className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
        >
          {REVIEW_MODERATION_ACTION_LABELS.reject}
        </button>
        <button
          type="button"
          onClick={() => openIntent("hide")}
          disabled={!allowedActions.canHide}
          className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
        >
          {REVIEW_MODERATION_ACTION_LABELS.hide}
        </button>
        <button
          type="button"
          onClick={() => openIntent("unhide")}
          disabled={!allowedActions.canUnhide}
          className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
        >
          {REVIEW_MODERATION_ACTION_LABELS.unhide}
        </button>
      </div>

      <p className="mt-3 text-[12px] leading-4 text-ink-3">
        管理员只能改「这条评价能不能被公开看到」：四个动作里没有修改星级或正文的入口，
        需要改内容时由作者在被驳回后重新提交。
      </p>

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? `${REVIEW_MODERATION_ACTION_LABELS[pendingAction]}这条评价` : ""}
        description={pendingAction ? CONFIRM_TEXTS[pendingAction] : ""}
        confirmLabel={pendingAction ? `确认${REVIEW_MODERATION_ACTION_LABELS[pendingAction]}` : ""}
        tone={pendingAction === "approve" || pendingAction === "unhide" ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        initialFocusRef={reasonRequired ? reasonRef : undefined}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {reasonRequired ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>原因（必填，会展示给评价作者）</span>
              {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚 */}
              <AdminCharacterCounter current={reasonCount} max={REVIEW_REASON_MAX_LENGTH} />
            </span>
            <textarea
              ref={reasonRef}
              value={reason}
              rows={3}
              onChange={(event) => {
                const value = event.target.value;
                setReason(value);
                // 超限文案与服务端同一份常量：两边各写一遍迟早会分叉
                setReasonError(
                  countCharacters(value.trim()) > REVIEW_REASON_MAX_LENGTH
                    ? REVIEW_REASON_TOO_LONG_MESSAGE
                    : null,
                );
              }}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? "review-reason-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                reasonError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {reasonError ? (
              <span id="review-reason-error" role="alert" className="text-[12px] text-brand-red">
                {reasonError}
              </span>
            ) : null}
          </label>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
