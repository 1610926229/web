"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PASSWORD_MIN_LENGTH } from "@/lib/constants/credentials";
import { setOwnAdminPassword } from "@/lib/services/adminHttp";

/**
 * 管理员修改自己的登录密码（PROD-4）。
 *
 * - 首次设置（`hasPassword=false`）不需要当前密码；
 * - 已设置过时必须验证当前密码；
 * - 成功后服务端**吊销该管理员的全部会话**，这里把浏览器送回登录页。
 *   不能停在后台假装还登录着——下一次请求就会 401。
 *
 * ⚠️ 页面上没有任何「查看密码」入口：服务端存的是单向哈希。
 */
export default function AdminPasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setMessage("");

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符。`);
      return;
    }
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }

    setPending(true);
    try {
      await setOwnAdminPassword({
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setMessage("密码已更新，全部管理端会话已失效。即将返回登录页…");
      // 给消息一拍可见时间，然后离开；直接 replace 会让人看不清发生了什么
      window.setTimeout(() => {
        router.replace("/admin/login");
        router.refresh();
      }, 800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改失败，请稍后重试。");
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">
        {hasPassword ? "修改登录密码" : "设置登录密码"}
      </h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-3">
        密码以加盐哈希保存，任何人都无法查看。修改成功后需要重新登录。
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-3 sm:max-w-sm">
        {hasPassword ? (
          <label className="flex flex-col gap-1 text-[13px] text-ink-2">
            当前密码
            <input
              type="password"
              name="currentPassword"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
              maxLength={128}
              className="rounded-lg border border-admin-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-admin-accent"
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-[13px] text-ink-2">
          新密码
          <input
            type="password"
            name="newPassword"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            className="rounded-lg border border-admin-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-admin-accent"
          />
          <span className="text-[12px] text-ink-3">至少 {PASSWORD_MIN_LENGTH} 个字符</span>
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
          className="self-start rounded-lg bg-ink px-5 py-2.5 text-[14px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "保存中…" : "保存新密码"}
        </button>
      </form>
    </section>
  );
}
