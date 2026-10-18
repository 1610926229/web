"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { loginRealUser, registerRealUser } from "@/lib/services/realAuthHttp";

/**
 * 用户注册 / 登录表单（真实邮箱密码）。
 *
 * ⚠️ 只在 `DATA_SOURCE=postgres` 时渲染。Mock 数据源下没有凭据表，
 * 画一个密码框会让人以为它真的验了密码。
 *
 * 表单只负责收集与提交；邮箱规范化、密码强度、哈希、会话写入全在服务端。
 * 成功后 `router.refresh()` 让服务端重新渲染当前地址（受保护页面因此放行），
 * 而不是由客户端自己把「已登录」写进状态。
 */
type Mode = "login" | "register";

export default function RealAuthForm({
  onSuccess,
  initialMode = "login",
}: {
  onSuccess?: () => void;
  initialMode?: Mode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      if (mode === "register") {
        await registerRealUser({ email, password, nickname: nickname.trim() || undefined });
      } else {
        await loginRealUser({ email, password });
      }

      // 会话由服务端写入；刷新让服务端重新读一次会话并渲染页面
      router.refresh();
      onSuccess?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
      setPending(false);
    }
  }

  function switchMode(next: Mode) {
    if (pending || next === mode) return;
    setMode(next);
    setError(null);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
      <div className="flex rounded-lg border border-line bg-page p-1">
        {(
          [
            ["login", "登录"],
            ["register", "注册"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => switchMode(value)}
            aria-pressed={mode === value}
            className={`flex-1 rounded-md py-2 text-[14px] ${
              mode === value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-[13px] text-ink-2">
        邮箱
        <input
          type="email"
          name="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          maxLength={254}
          className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-brand-red"
        />
      </label>

      <label className="flex flex-col gap-1 text-[13px] text-ink-2">
        密码
        <input
          type="password"
          name="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          required
          minLength={8}
          maxLength={128}
          className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-brand-red"
        />
        {mode === "register" ? (
          <span className="text-[12px] text-ink-3">至少 8 个字符</span>
        ) : null}
      </label>

      {mode === "register" ? (
        <label className="flex flex-col gap-1 text-[13px] text-ink-2">
          昵称（选填）
          <input
            type="text"
            name="nickname"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            autoComplete="nickname"
            maxLength={15}
            className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-brand-red"
          />
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-full bg-brand-red py-3 text-[15px] font-medium text-white disabled:opacity-60"
      >
        {pending ? "处理中…" : mode === "register" ? "注册并登录" : "登录"}
      </button>
    </form>
  );
}
