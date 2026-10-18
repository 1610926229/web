"use client";

import { useState, type FormEvent } from "react";
import { resetAdminStaffPassword } from "@/lib/services/adminHttp";
import { PASSWORD_MIN_LENGTH } from "@/lib/constants/credentials";

/**
 * 管理员重置某位客服的登录密码（PROD-4，真实凭据模式）。
 *
 * ⚠️ 页面**永远不显示当前密码**：后台存储的是 scrypt 哈希，没有任何读取入口。
 * 这里的动作只有「设置一个新密码」，提交后服务端会吊销该客服的全部真实会话。
 *
 * ⚠️ 密码不出本表单的 state：不写 localStorage、不放进 URL、成功后立即从输入框清空。
 * 服务端只回 `{ ok: true }`，没有密码的任何回显。
 */
export default function AdminStaffPasswordReset({ staffId }: { staffId: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setMessage("");

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符。`);
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }

    setPending(true);
    try {
      await resetAdminStaffPassword(staffId, password);
      setPassword("");
      setConfirm("");
      setMessage("密码已重置：该客服需要用新密码重新登录，之前的登录会话已全部失效。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重置失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">登录密码</h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-3">
        管理员只能重置、不能查看客服密码。重置后该账号已登录的客服端会话立即失效。
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-3 sm:max-w-sm">
        <label className="flex flex-col gap-1 text-[13px] text-ink-2">
          新密码
          <input
            type="password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            className="rounded-lg border border-admin-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-[13px] text-ink-2">
          确认新密码
          <input
            type="password"
            name="confirmPassword"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            className="rounded-lg border border-admin-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        {error ? (
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-[13px] leading-5 text-status-success">
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
        >
          {pending ? "重置中…" : "重置登录密码"}
        </button>
      </form>
    </section>
  );
}
