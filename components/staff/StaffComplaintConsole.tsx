"use client";

import { useRef, useState } from "react";
import {
  STAFF_COMPLAINT_ACTION_LABELS,
  STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  STAFF_COMPLAINT_CONFIRM_TEXTS,
  STAFF_COMPLAINT_REFRESH_FAILED_NOTICE,
  STAFF_COMPLAINT_REPLAY_NOTICE,
  STAFF_COMPLAINT_RESULT_MAX_LENGTH,
  STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  STAFF_COMPLAINT_SUCCESS_MESSAGES,
  STAFF_COMPLAINT_TERMINAL_NOTICE,
  normalizeStaffComplaintResult,
} from "@/lib/constants/staffComplaints";
import {
  closeStaffComplaint,
  fetchStaffComplaint,
  resolveStaffComplaint,
  startProcessingStaffComplaint,
} from "@/lib/services/staffComplaintsHttp";
import type { StaffComplaintDetail, StaffComplaintWriteResult } from "@/lib/types/complaint";
import { countCharacters } from "@/lib/utils/text";

/** 三个处理动作。都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type ComplaintIntent = "startProcessing" | "resolve" | "close";

/**
 * 投诉详情的**唯一写入口**（客服端）。
 *
 * ⚠️ **它不写订单，也不写退款**：三个动作只改投诉自己的状态与结论字段，
 * 请求体里没有订单、金额或退款相关的字段，也没有处理人身份字段——
 * 处理人由服务端从客服会话推导（`actorRole` 写死为 `customer_service`）。
 *
 * ⚠️ **用户提交的内容不可被覆盖**：正文、凭证与联系方式都不在本组件里，
 * 它们由服务端原样读出、只读展示；这里写的是另一个字段（处理结果）。
 *
 * ⚠️ 解决与关闭都**必须填写结论**（服务端校验，用的是同一个字段、两套文案）：
 * 一个没有结论的「已处理」对用户等于什么都没发生。开始处理不产生结论，也不需要填。
 *
 * ⚠️ 确认框不是防重手段：真正的防重是「打开确认框时生成一次幂等键、重试用同一个键」
 * 加上服务端的状态判断（§九）。失败时确认框不关，错误留在原地。
 *
 * ⚠️ **幂等重放不是成功**：`changed: false` 表示服务端什么都没改（同一个键已经成功过）。
 * 此时页面**不能**报「已解决」，而要报「这条已经处理过了」——否则客服会以为
 * 刚刚又解决了一次。真正的状态以重新取回的详情为准。
 */
export default function StaffComplaintConsole({
  complaint: initialComplaint,
}: {
  complaint: StaffComplaintDetail;
}) {
  const [complaint, setComplaint] = useState(initialComplaint);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<ComplaintIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [resultError, setResultError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);

  const resultCount = countCharacters(result.trim());
  /** 解决与关闭都要填结论；两种问法的文案由 `normalizeStaffComplaintResult()` 决定。 */
  const resultRequiredIntent = pendingIntent === "resolve" || pendingIntent === "close";
  const resultLabel = pendingIntent === "close" ? "关闭说明" : "处理结果";

  async function runWrite(intent: ComplaintIntent, key: string, text: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const call = {
        startProcessing: () => startProcessingStaffComplaint(complaint.id, key),
        resolve: () => resolveStaffComplaint(complaint.id, key, text),
        close: () => closeStaffComplaint(complaint.id, key, text),
      }[intent];

      // —— 第一步：写入。**失败时确认框不关**，错误留在原地。
      let written: StaffComplaintWriteResult;
      try {
        written = await call();
      } catch (cause) {
        setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
        return;
      }

      keyRef.current = null;
      setPendingIntent(null);

      // —— 第二步：重新取一次详情，它才是唯一权威。
      // ⚠️ 写入已经生效，因此这一步的失败不能报「操作失败」（与事实相反，且会诱导重复点击）。
      try {
        // 不拿响应里的几个字段自己拼新状态：重新取一次详情才是唯一权威
        setComplaint(await fetchStaffComplaint(complaint.id));
      } catch {
        setFlash(STAFF_COMPLAINT_REFRESH_FAILED_NOTICE);
        return;
      }

      // ⚠️ 幂等重放（changed:false）时服务端什么都没改，不能报「已解决」
      setFlash(
        written.changed
          ? STAFF_COMPLAINT_SUCCESS_MESSAGES[intent]
          : STAFF_COMPLAINT_REPLAY_NOTICE,
      );
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: ComplaintIntent) {
    keyRef.current = crypto.randomUUID();
    setResult("");
    setResultError(null);
    setConfirmError(null);
    setFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
    setResultError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    if (!key || !pendingIntent || busy) return;

    if (pendingIntent === "startProcessing") {
      void runWrite("startProcessing", key, "");
      return;
    }

    // 与服务端**同一个函数**校验（必填 + 长度上限，且「解决」与「关闭」两套空值文案）：
    // 界面没有 `maxLength`，超长必须在提交时被明确拒绝，而不是被悄悄截断
    const checked = normalizeStaffComplaintResult(result, pendingIntent);
    if (!checked.ok) {
      setResultError(checked.message);
      resultRef.current?.focus();
      return;
    }
    void runWrite(pendingIntent, key, checked.value);
  }

  const { allowedActions } = complaint;
  const hasAction =
    allowedActions.canStartProcessing || allowedActions.canResolve || allowedActions.canClose;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">处理操作</h2>

      {hasAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("startProcessing")}
            disabled={!allowedActions.canStartProcessing}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {STAFF_COMPLAINT_ACTION_LABELS.startProcessing}
          </button>
          <button
            type="button"
            onClick={() => openIntent("resolve")}
            disabled={!allowedActions.canResolve}
            className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {STAFF_COMPLAINT_ACTION_LABELS.resolve}
          </button>
          <button
            type="button"
            onClick={() => openIntent("close")}
            disabled={!allowedActions.canClose}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {STAFF_COMPLAINT_ACTION_LABELS.close}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{STAFF_COMPLAINT_TERMINAL_NOTICE}</p>
      )}

      <p className="mt-3 text-[12px] leading-4 text-ink-3">
        处理投诉不会修改订单，也不会产生退款：解决与关闭只记录平台侧的处理结果。
        需要退款时请到订单沟通页或退款处理页查看对应的退款申请。
      </p>

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      {pendingIntent ? (
        <div className="mt-3 rounded-lg border border-admin-line bg-page p-4">
          <p className="text-[13px] leading-5 text-ink">
            {STAFF_COMPLAINT_CONFIRM_TEXTS[pendingIntent]}
          </p>

          {resultRequiredIntent ? (
            <label className="mt-3 flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
                <span>
                  {resultLabel}（必填，会展示给提交投诉的用户）
                  {pendingIntent === "close" ? "；已关闭是终态" : ""}
                </span>
                {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚。 */}
                <span className={resultCount > STAFF_COMPLAINT_RESULT_MAX_LENGTH ? "text-brand-red" : ""}>
                  {resultCount}/{STAFF_COMPLAINT_RESULT_MAX_LENGTH}
                </span>
              </span>
              <textarea
                ref={resultRef}
                value={result}
                rows={4}
                onChange={(event) => {
                  const value = event.target.value;
                  setResult(value);
                  // 边写边说：超限立刻标红；「必填」留给提交时提示
                  setResultError(
                    countCharacters(value.trim()) > STAFF_COMPLAINT_RESULT_MAX_LENGTH
                      ? pendingIntent === "close"
                        ? STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE
                        : STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE
                      : null,
                  );
                }}
                aria-invalid={resultError ? true : undefined}
                aria-describedby={resultError ? "complaint-result-error" : undefined}
                placeholder={
                  pendingIntent === "close"
                    ? "说明为什么关闭这条投诉，用户会看到这段话"
                    : "说明核实与处理的情况，用户会看到这段话"
                }
                className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                  resultError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
                }`}
              />
              {resultError ? (
                <span id="complaint-result-error" role="alert" className="text-[12px] text-brand-red">
                  {resultError}
                </span>
              ) : null}
            </label>
          ) : null}

          {confirmError ? (
            <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
              {confirmError}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmIntent}
              disabled={busy}
              className={
                pendingIntent === "close"
                  ? "rounded-lg bg-status-danger px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60"
                  : "rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60"
              }
            >
              {busy ? "提交中…" : `确认${STAFF_COMPLAINT_ACTION_LABELS[pendingIntent]}`}
            </button>
            <button
              type="button"
              onClick={closeIntent}
              disabled={busy}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
