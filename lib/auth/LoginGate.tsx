"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "@/components/common/EmptyState";
import { authAdapter } from "./MockAuthAdapter";

/**
 * 统一的登录拦截界面。
 *
 * 所有需登录的页面都由 `RequireAuth` 渲染本组件，页面自身不重复编写登录判断。
 *
 * 拦截时**不跳转**，当前地址保持不变；登录成功后 `router.refresh()` 让服务端重新
 * 渲染该地址，用户自然回到原本要访问的页面（即回跳原地址）。
 * 未来接入公众号网页授权后，这里的按钮改为触发授权跳转即可。
 *
 * `mockAuthEnabled` 由服务端传入：未开启模拟登录时，界面上不出现任何模拟登录入口，
 * 只如实说明「登录功能尚未开放」。
 */
export default function LoginGate({ mockAuthEnabled }: { mockAuthEnabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await authAdapter.login();
      router.refresh();
    } catch {
      setError("登录失败，请重试");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-surface px-4 py-16">
      <EmptyState
        title="需要登录"
        description={
          mockAuthEnabled
            ? "登录后即可查看订单、联系客服与个人中心。当前为开发阶段的模拟登录，不会调用真实微信接口。"
            : "登录后即可查看订单、联系客服与个人中心。登录功能正在接入中，敬请期待。"
        }
      />

      {mockAuthEnabled ? (
        <button
          type="button"
          onClick={handleLogin}
          disabled={pending}
          className="rounded-full bg-ink px-8 py-3 text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "登录中…" : "模拟微信登录"}
        </button>
      ) : null}

      {error ? <p className="text-[13px] text-brand-red">{error}</p> : null}
    </div>
  );
}
