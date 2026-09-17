"use client";

import { useRef, useState } from "react";
import { AdminField } from "@/components/admin/AdminFormField";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_NOTICE,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
  isValidPublicPoolTimeoutMinutes,
} from "@/lib/constants/platformConfig";
import { ADMIN_PLATFORM_CONFIG_PAGE_TITLE } from "@/lib/constants/admin";
import { saveAdminPlatformConfig } from "@/lib/services/adminHttp";
import type { PlatformConfig } from "@/lib/types/platformConfig";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 平台参数（`/admin/platform-config`）：**这一页唯一的写入口**。
 *
 * ## 这一页改的是什么
 *
 * 改的是**规则**，不是某一条数据。因此页面必须把两件事说清楚，否则管理员会误判：
 *
 * 1. **改了之后只影响此后进入公共池的订单。** 已经进入公共池的订单在进入那一刻
 *    就把当时的分钟数冻结成了快照，界面上的数字变化**不会**动到它们。
 *    不说这一点，管理员改完去看在途订单发现没变化，会以为没保存再改一次。
 * 2. **「值没变」不是「保存成功」。** 服务端对「提交的值与现状完全相同」不写数据、
 *    不写审计、也不刷新最后修改时间。页面据此显示「没有变化，未写入」——
 *    显示成「已保存」会让管理员相信一个并不存在的时间戳变动。
 *
 * ## 校验用的是服务端那一份
 *
 * `isValidPublicPoolTimeoutMinutes()` 与服务端接口调用的是**同一个函数**、
 * 错误文案也是同一个常量。这里不重写一遍「1~1440 的整数」——复制一份规则
 * 就等于给将来留一个分叉：表单说合法、接口说非法，或者反过来。
 *
 * ⚠️ 不做隐式转换：`Number("60abc")` 是 `NaN`、`parseInt("60abc")` 是 `60`，
 * 因此解析只走 `Number()`，非整数一律拒。这与服务端的口径一致（`"60"` 也会被拒，
 * 因为这里先转成了数字再发出去）。
 *
 * ⚠️ 这里**没有**「启用 / 停用」：参数只有取值，没有上架下架。要回到默认值
 * 是把它**改成默认值**，那仍然是一次普通的修改，会留下审计。
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
  const [draft, setDraft] = useState(String(initialConfig.publicPoolTimeoutMinutes));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 幂等键。**同一份输入重试时沿用同一个键**：上一次点击已经把请求发出去了，
   * 只是回执没回来；换一个键就等于让服务端把它当成第二次写入。
   * 只要输入变了就作废它（那已经是另一次用户意图）。
   */
  const keyRef = useRef<string | null>(null);

  const changed = String(config.publicPoolTimeoutMinutes) !== draft;

  function handleDraftChange(value: string) {
    setDraft(value);
    keyRef.current = null;
    setFieldError(null);
    setMessage(null);
    setSubmitError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = Number(draft);
    if (!isValidPublicPoolTimeoutMinutes(next)) {
      setFieldError(PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE);
      setMessage(null);
      setSubmitError(null);
      return;
    }

    setFieldError(null);
    setMessage(null);
    setSubmitError(null);
    setBusy(true);

    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    try {
      const result = await saveAdminPlatformConfig(keyRef.current, {
        publicPoolTimeoutMinutes: next,
      });

      // 以**服务端返回的那份记录**为新基准，而不是本地拼出来的状态：
      // `updatedAt` 与 `updatedByAdminId` 只有服务端知道
      setConfig(result.config);
      setDraft(String(result.config.publicPoolTimeoutMinutes));
      keyRef.current = null;
      setMessage(
        result.changed
          ? `已保存。此后进入公共订单池的订单按 ${result.config.publicPoolTimeoutMinutes} 分钟判定超时；` +
              "已经进入公共池的订单沿用进入时的快照，不受这次修改影响"
          : "取值没有变化，未写入。服务端记录的仍是 " +
              `${result.config.publicPoolTimeoutMinutes} 分钟，最后修改时间也没有变动`,
      );
    } catch (cause) {
      // ⚠️ 失败时**保留幂等键**：上一次请求可能已经到达服务端，只是回执丢了。
      // 沿用同一个键重试，服务端会把它当成重放并返回第一次的结果，
      // 而不是按新的一次写入再写一遍（§九）。换键只发生在输入变化时。
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
          error={fieldError}
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
            value={draft}
            disabled={busy}
            onChange={(event) => handleDraftChange(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "platform-config-timeout-error" : undefined}
            className={`h-9 w-40 rounded-lg border px-3 text-[13px] text-ink outline-none ${
              fieldError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            }`}
          />
        </AdminField>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] leading-5 text-ink-3">
          <div className="flex gap-1">
            <dt>当前生效值：</dt>
            <dd className="text-ink-2">{config.publicPoolTimeoutMinutes} 分钟</dd>
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
            onClick={() => handleDraftChange(String(config.publicPoolTimeoutMinutes))}
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
