"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ADMIN_LOGIN_PAGE_TITLE,
  ADMIN_MOCK_DISABLED_MESSAGE,
  ADMIN_MOCK_LOGIN_LABEL,
  ADMIN_MOCK_NOTICE,
} from "@/lib/constants/admin";
import { mockLoginAdmin } from "@/lib/services/adminHttp";

/**
 * 管理后台登录面板。
 *
 * ⚠️ **只有一个固定的「模拟管理员登录」按钮**：没有账号输入框、没有密码输入框、
 * 没有账号切换器。这不是「先简化一下」，而是本阶段就只做这一个入口——
 * 真实管理员账号与密码尚未实现，界面上给出输入框就是在暗示一个并不存在的登录方式。
 *
 * ⚠️ 登录动作**不携带任何身份信息**：`mockLoginAdmin()` 不带参数，
 * 登录对象由服务端固定。因此不存在「改一下请求就能变成管理员」的客户端路径。
 *
 * `mockAdminEnabled` 由服务端传入（`ENABLE_MOCK_ADMIN`）：未开启时
 * 既不渲染按钮，也不渲染「登录失败」这类假动作，只如实说明该能力未启用。
 * 客户端因此不需要（也不应该）知道任何环境变量。
 */
export default function AdminLoginPanel({ mockAdminEnabled }: { mockAdminEnabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      await mockLoginAdmin();
      // 刷新而不是 push：当前地址仍是 /admin/login，服务端重新渲染时发现
      // 已经有会话，页面自己会把人转到 /admin——跳转规则只写在一处
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请重试");
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-page px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-admin-line bg-surface p-8">
        <h1 className="text-[18px] font-semibold text-ink">{ADMIN_LOGIN_PAGE_TITLE}</h1>
        <p className="mt-3 text-[13px] leading-5 text-ink-3">{ADMIN_MOCK_NOTICE}</p>

        {mockAdminEnabled ? (
          <button
            type="button"
            onClick={handleLogin}
            disabled={pending}
            className="mt-6 w-full rounded-lg bg-ink px-6 py-3 text-[15px] font-medium text-white disabled:opacity-60"
          >
            {pending ? "登录中…" : ADMIN_MOCK_LOGIN_LABEL}
          </button>
        ) : (
          <p className="mt-6 rounded-lg bg-page px-4 py-3 text-[13px] leading-5 text-ink-2">
            {ADMIN_MOCK_DISABLED_MESSAGE}
          </p>
        )}

        {error ? (
          <p role="alert" className="mt-4 text-[13px] text-brand-red">
            {error}
          </p>
        ) : null}
      </div>

      {/*
        用户端入口刻意**不在这里**：管理后台与用户端是两个站点，
        互相不给入口可以避免「点着点着就串了」这类误操作，
        也避免后台页面上出现一个把管理者带到用户前台的链接。
      */}
      <p className="text-center text-[12px] leading-5 text-ink-3">
        本页仅供平台管理者使用，不是用户端入口。
      </p>
    </main>
  );
}
