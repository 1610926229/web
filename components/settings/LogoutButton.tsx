"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth/useAuth";

/**
 * 退出登录（设置页）。
 *
 * 这个入口原先临时放在「我的」页用于验证登录态，P6 起归位到设置页，主页不再有退出按钮。
 *
 * 二次确认：点「退出登录」不直接退出，而是换成一行确认（取消 / 确认退出）。
 * 退出是不可撤销的动作（要回到登录态得重新登录），因此不给一键退出的机会。
 * 用行内确认而不是弹窗：这里不需要展示额外信息，浮层会打断页面上下文。
 *
 * 退出后 `router.push("/")` 回到**游客可访问的首页**——退出登录后原来的受保护页面
 * 已经渲染不出来（`RequireAuth` 会改成登录拦截），停在那里只会让用户以为卡住了。
 */
export default function LogoutButton() {
  const router = useRouter();
  const { logout } = useAuth();

  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 与编辑资料表单同理：`pending` 要等重渲染才生效，用同步的 ref 挡住连点 */
  const runningRef = useRef(false);

  const handleLogout = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPending(true);
    setError(null);

    try {
      await logout();
      router.push("/");
    } catch {
      setError("退出失败，请稍后重试");
      runningRef.current = false;
      setPending(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-[10px] border border-line py-3 text-[15px] text-ink-2"
      >
        退出登录
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">确认退出当前账号？退出后需重新登录才能查看订单与个人中心。</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="flex-1 rounded-[10px] border border-line py-3 text-[15px] text-ink-2 disabled:opacity-60"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            void handleLogout();
          }}
          disabled={pending}
          className="flex-1 rounded-[10px] bg-ink py-3 text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "退出中…" : "确认退出"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
