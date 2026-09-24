"use client";

import { useRef, useState } from "react";
import { AdminField } from "@/components/admin/AdminFormField";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  COMPLAINT_WINDOW_MAX_MINUTES,
  COMPLAINT_WINDOW_MIN_MINUTES,
  COMPLETION_AUTO_APPROVAL_MAX_MINUTES,
  COMPLETION_AUTO_APPROVAL_MIN_MINUTES,
  PLATFORM_CONFIG_INVALID_COMPLAINT_WINDOW_MESSAGE,
  PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE,
  PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_NOTICE,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
  isValidComplaintWindowMinutes,
  isValidCompletionAutoApprovalMinutes,
  isValidPublicPoolTimeoutMinutes,
} from "@/lib/constants/platformConfig";
import { ADMIN_PLATFORM_CONFIG_PAGE_TITLE } from "@/lib/constants/admin";
import { saveAdminPlatformConfig } from "@/lib/services/adminHttp";
import type { AdminPlatformConfigPatch, PlatformConfig } from "@/lib/types/platformConfig";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 平台参数（`/admin/platform-config`）：**这一页唯一的写入口**。
 *
 * ## 这一页改的是什么
 *
 * 改的是**规则**，不是某一条数据。因此页面必须把两件事说清楚，否则管理员会误判：
 *
 * 1. **改了之后只影响之后发生的事。** 公共池超时只影响此后进入公共池的订单；
 *    完成材料自动审核时长只影响此后提交的完成材料。已经在途的订单与已在审核中的
 *    完成材料各自在「进入 / 提交那一刻」把当时的分钟数冻结成了快照，界面上的数字
 *    变化**不会**动到它们。
 * 2. **「值没变」不是「保存成功」。** 服务端对「提交的值与现状完全相同」不写数据、
 *    不写审计、也不刷新最后修改时间。页面据此显示「没有变化，未写入」——
 *    显示成「已保存」会让管理员相信一个并不存在的时间戳变动。
 *
 * ⚠️ 投诉窗口（P0-9）也要写清「只影响之后」，而且它影响的是**两件事**：
 * 用户可投诉的期限，以及打手该单收益的冻结期限。只提投诉会让管理员以为
 * 调小它只改变投诉策略，而实际上它提前放款——一次看不出来的资金规则改动。
 *
 * ## 三个字段独立保存
 *
 * `AdminPlatformConfigPatch` 的三个字段都是**可选**的，PATCH 只带改了的那一项：
 * 只改公共池超时、不动另外两项，照样能保存（不能因为别的字段没动就拦下提交）。
 * 提交时只把「草稿与现状不同」的字段放进 patch，其余字段保持现状。
 *
 * ## 校验用的是服务端那一份
 *
 * `isValidPublicPoolTimeoutMinutes()` / `isValidCompletionAutoApprovalMinutes()` /
 * `isValidComplaintWindowMinutes()` 与
 * 服务端接口调用的是**同一个函数**、错误文案也是同一个常量。这里不重写一遍
 * 「1~1440 的整数」——复制一份规则就等于给将来留一个分叉。
 *
 * ⚠️ 三个函数的区间**各不相同**（投诉窗口是 60~10080）：提示文案与 `min`/`max`
 * 一律从常量取，不在这里写数字。写错一处会让表单把合法的 7 天判成非法。
 *
 * ⚠️ 不做隐式转换：`Number("60abc")` 是 `NaN`、`parseInt("60abc")` 是 `60`，
 * 因此解析只走 `Number()`，非整数一律拒。这与服务端的口径一致（`"60"` 也会被拒，
 * 因为这里先转成了数字再发出去）。
 */
export default function AdminPlatformConfigConsole({
  initialConfig,
}: {
  /**
   * 服务端首屏取到的配置。
   *
   * 服务端组件页首屏就把真数据交给它，因此直接打开这一页看到的是当前取值，
   * 而不是一片骨架屏。
   */
  initialConfig: PlatformConfig;
}) {
  const [config, setConfig] = useState(initialConfig);
  /** 输入框里的**文本**，不是数字：用户正在输入的 `""` 或 `"6a"` 都要能如实显示出来 */
  const [draftTimeout, setDraftTimeout] = useState(String(initialConfig.publicPoolTimeoutMinutes));
  const [draftCompletion, setDraftCompletion] = useState(
    String(initialConfig.completionAutoApprovalMinutes),
  );
  const [draftComplaint, setDraftComplaint] = useState(
    String(initialConfig.complaintWindowMinutes),
  );
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [complaintError, setComplaintError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 幂等键。**同一份输入重试时沿用同一个键**：上一次点击已经把请求发出去了，
   * 只是回执没回来；换一个键就等于让服务端把它当成第二次写入。
   * 只要任一输入变了就作废它（那已经是另一次用户意图）。
   */
  const keyRef = useRef<string | null>(null);

  const changed =
    String(config.publicPoolTimeoutMinutes) !== draftTimeout ||
    String(config.completionAutoApprovalMinutes) !== draftCompletion ||
    String(config.complaintWindowMinutes) !== draftComplaint;

  function invalidateKey() {
    keyRef.current = null;
    setMessage(null);
    setSubmitError(null);
  }

  function handleTimeoutChange(value: string) {
    setDraftTimeout(value);
    setTimeoutError(null);
    invalidateKey();
  }

  function handleCompletionChange(value: string) {
    setDraftCompletion(value);
    setCompletionError(null);
    invalidateKey();
  }

  function handleComplaintChange(value: string) {
    setDraftComplaint(value);
    setComplaintError(null);
    invalidateKey();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // 只把「草稿与现状不同」的字段放进 patch：只改一个字段也必须能保存。
    const patch: AdminPlatformConfigPatch = {};

    if (draftTimeout !== String(config.publicPoolTimeoutMinutes)) {
      const next = Number(draftTimeout);
      if (!isValidPublicPoolTimeoutMinutes(next)) {
        setTimeoutError(PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE);
        setMessage(null);
        setSubmitError(null);
        return;
      }
      patch.publicPoolTimeoutMinutes = next;
    }

    if (draftCompletion !== String(config.completionAutoApprovalMinutes)) {
      const next = Number(draftCompletion);
      if (!isValidCompletionAutoApprovalMinutes(next)) {
        setCompletionError(PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE);
        setMessage(null);
        setSubmitError(null);
        return;
      }
      patch.completionAutoApprovalMinutes = next;
    }

    if (draftComplaint !== String(config.complaintWindowMinutes)) {
      const next = Number(draftComplaint);
      if (!isValidComplaintWindowMinutes(next)) {
        setComplaintError(PLATFORM_CONFIG_INVALID_COMPLAINT_WINDOW_MESSAGE);
        setMessage(null);
        setSubmitError(null);
        return;
      }
      patch.complaintWindowMinutes = next;
    }

    // 按钮在 `changed === false` 时已禁用，这里只是防御：一个字段都没带就不是一次写入
    if (Object.keys(patch).length === 0) {
      setMessage("取值没有变化，未写入。最后修改时间也没有变动。");
      return;
    }

    setTimeoutError(null);
    setCompletionError(null);
    setComplaintError(null);
    setMessage(null);
    setSubmitError(null);
    setBusy(true);

    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    try {
      const result = await saveAdminPlatformConfig(keyRef.current, patch);

      // 以**服务端返回的那份记录**为新基准，而不是本地拼出来的状态：
      // `updatedAt` 与 `updatedByAdminId` 只有服务端知道
      setConfig(result.config);
      setDraftTimeout(String(result.config.publicPoolTimeoutMinutes));
      setDraftCompletion(String(result.config.completionAutoApprovalMinutes));
      setDraftComplaint(String(result.config.complaintWindowMinutes));
      keyRef.current = null;
      setMessage(
        result.changed
          ? `已保存：公共订单池超时 ${result.config.publicPoolTimeoutMinutes} 分钟，` +
              `完成材料自动审核时长 ${result.config.completionAutoApprovalMinutes} 分钟，` +
              `投诉窗口 ${result.config.complaintWindowMinutes} 分钟。` +
              "此后新发生的事按新值判定；已在途的订单、已在审核中的完成材料与已完成的订单" +
              "沿用各自冻结的快照，不受这次修改影响。"
          : "取值没有变化，未写入。最后修改时间也没有变动。",
      );
    } catch (cause) {
      // ⚠️ 失败时**保留幂等键**：上一次请求可能已经到达服务端，只是回执丢了。
      // 沿用同一个键重试，服务端会把它当成重放并返回第一次的结果，
      // 而不是按新的一次写入再写一遍。换键只发生在输入变化时。
      setSubmitError(cause instanceof Error ? cause.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeading title={ADMIN_PLATFORM_CONFIG_PAGE_TITLE} description={PLATFORM_CONFIG_NOTICE} />

      <form
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
      >
        <AdminField
          label="公共订单池超时（分钟）"
          htmlFor="platform-config-timeout"
          hint={`可填 ${PUBLIC_POOL_TIMEOUT_MIN_MINUTES}~${PUBLIC_POOL_TIMEOUT_MAX_MINUTES} 之间的整数分钟。超时后订单停止被接取，并自动全额退款。`}
          error={timeoutError}
          errorId="platform-config-timeout-error"
        >
          <input
            id="platform-config-timeout"
            name="publicPoolTimeoutMinutes"
            type="number"
            inputMode="numeric"
            step={1}
            min={PUBLIC_POOL_TIMEOUT_MIN_MINUTES}
            max={PUBLIC_POOL_TIMEOUT_MAX_MINUTES}
            value={draftTimeout}
            disabled={busy}
            onChange={(event) => handleTimeoutChange(event.target.value)}
            aria-invalid={timeoutError ? true : undefined}
            aria-describedby={timeoutError ? "platform-config-timeout-error" : undefined}
            className={`h-9 w-40 rounded-lg border px-3 text-[13px] text-ink outline-none ${
              timeoutError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            }`}
          />
        </AdminField>

        <AdminField
          label="完成材料自动审核时长（分钟）"
          htmlFor="platform-config-completion"
          hint={`可填 ${COMPLETION_AUTO_APPROVAL_MIN_MINUTES}~${COMPLETION_AUTO_APPROVAL_MAX_MINUTES} 之间的整数分钟。` +
            "打手提交完成材料后，等待该时长仍未处理且无阻塞时由系统自动通过。" +
            "只影响之后提交的完成材料，已经在审核中的材料沿用提交时冻结的时长。"}
          error={completionError}
          errorId="platform-config-completion-error"
        >
          <input
            id="platform-config-completion"
            name="completionAutoApprovalMinutes"
            type="number"
            inputMode="numeric"
            step={1}
            min={COMPLETION_AUTO_APPROVAL_MIN_MINUTES}
            max={COMPLETION_AUTO_APPROVAL_MAX_MINUTES}
            value={draftCompletion}
            disabled={busy}
            onChange={(event) => handleCompletionChange(event.target.value)}
            aria-invalid={completionError ? true : undefined}
            aria-describedby={completionError ? "platform-config-completion-error" : undefined}
            className={`h-9 w-40 rounded-lg border px-3 text-[13px] text-ink outline-none ${
              completionError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            }`}
          />
        </AdminField>

        <AdminField
          label="投诉窗口（分钟）"
          htmlFor="platform-config-complaint"
          hint={`可填 ${COMPLAINT_WINDOW_MIN_MINUTES}~${COMPLAINT_WINDOW_MAX_MINUTES} 之间的整数分钟。` +
            "订单完成后，用户在窗口内仍可发起投诉，打手该单收益同时处于冻结状态；" +
            "窗口到期且无退款 / 投诉阻塞时收益转为可提现。" +
            "⚠️ 它同时决定打手收益冻结多久：调小它会提前放款。" +
            "只影响之后完成的订单，已完成的订单沿用完成时冻结的窗口。"}
          error={complaintError}
          errorId="platform-config-complaint-error"
        >
          <input
            id="platform-config-complaint"
            name="complaintWindowMinutes"
            type="number"
            inputMode="numeric"
            step={1}
            min={COMPLAINT_WINDOW_MIN_MINUTES}
            max={COMPLAINT_WINDOW_MAX_MINUTES}
            value={draftComplaint}
            disabled={busy}
            onChange={(event) => handleComplaintChange(event.target.value)}
            aria-invalid={complaintError ? true : undefined}
            aria-describedby={complaintError ? "platform-config-complaint-error" : undefined}
            className={`h-9 w-40 rounded-lg border px-3 text-[13px] text-ink outline-none ${
              complaintError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            }`}
          />
        </AdminField>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] leading-5 text-ink-3">
          <div className="flex gap-1">
            <dt>公共池超时当前值：</dt>
            <dd className="text-ink-2">{config.publicPoolTimeoutMinutes} 分钟</dd>
          </div>
          <div className="flex gap-1">
            <dt>完成材料自动审核当前值：</dt>
            <dd className="text-ink-2">{config.completionAutoApprovalMinutes} 分钟</dd>
          </div>
          <div className="flex gap-1">
            <dt>投诉窗口当前值：</dt>
            <dd className="text-ink-2">{config.complaintWindowMinutes} 分钟</dd>
          </div>
          <div className="flex gap-1">
            <dt>最后修改：</dt>
            {/* 时间戳是**证词**：它变过就说明有人真的改过。因此「什么都没改」时它必须不动 */}
            <dd className="text-ink-2">{formatDateTime(config.updatedAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>修改者：</dt>
            {/* 预置数据没有修改者（`null`），显示成「预置」而不是空白 */}
            <dd className="text-ink-2">{config.updatedByAdminId ?? "预置值，尚无修改记录"}</dd>
          </div>
        </dl>

        {submitError ? (
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {submitError}
          </p>
        ) : null}

        {message ? (
          <p role="status" className="text-[13px] leading-5 text-status-success">
            {message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
          <button
            type="submit"
            disabled={busy || !changed}
            className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {busy ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            disabled={busy || !changed}
            onClick={() => {
              handleTimeoutChange(String(config.publicPoolTimeoutMinutes));
              handleCompletionChange(String(config.completionAutoApprovalMinutes));
              handleComplaintChange(String(config.complaintWindowMinutes));
            }}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
          >
            放弃修改
          </button>
          <span className="text-[12px] leading-4 text-ink-3">
            取值没有变化时保存按钮不可点：提交与现状相同的值不会产生任何写入，
            也不会刷新「最后修改」——那个时间戳一变就说明有人真的改过，
            它不该被一次空保存推着往前走。
          </span>
        </div>
      </form>
    </div>
  );
}
