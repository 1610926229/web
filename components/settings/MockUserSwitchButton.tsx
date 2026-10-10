"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth/useAuth";
import { MOCK_USER_SWITCH_LABEL, MOCK_USER_SWITCH_NOTICE } from "@/lib/constants/mockUsers";

/**
 * 「切换 Mock 用户」（设置页，**仅 Mock 环境**）。
 *
 * ## 它不是第二种登录方式
 *
 * 它做的事只有一件：**退出当前账号**。退出之后设置页立刻变成统一的登录界面
 * （`RequireAuth` 在未登录时渲染 `LoginGate`），那里有测试账号名单可以选下一个身份。
 *
 * ```
 * 切换 = 退出 + 在同一个页面上重新选一个账号
 * ```
 *
 * 因此这里**没有**任何身份参数、没有第二套 Cookie、没有打手登录，
 * 也没有绕过 `LoginGate` 的第三条登录路径。
 *
 * ## 为什么不二次确认
 *
 * 「退出登录」要确认，是因为退出后要重新登录才能回到原处。
 * 这个按钮的下一步**就是**选择账号的那一屏，点错了立刻就能点回来，不需要确认。
 *
 * ## 关闭时不可见
 *
 * 渲染与否由设置页的 `mockAuthEnabled`（服务端读取）决定；整个组件在开关关闭时
 * 根本不会被渲染，文案也不会出现在响应里。
 */
export default function MockUserSwitchButton() {
  const router = useRouter();
  const { logout } = useAuth();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 与退出登录同理：`pending` 要等重渲染才生效，用同步的 ref 挡住连点 */
  const runningRef = useRef(false);

  const handleSwitch = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPending(true);
    setError(null);

    try {
      await logout();
      // `useAuth().logout()` 内部已经 `router.refresh()` 过一次；这里再显式刷一次，
      // 是为了让本页的正确性不依赖另一个模块的内部实现——退出后停在**当前地址**
      // 是这里的全部意义，一旦 refresh 被挪走，页面会停在旧的服务端渲染结果上。
      router.refresh();
    } catch {
      setError("切换失败，请稍后重试");
      runningRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          void handleSwitch();
        }}
        disabled={pending}
        className="w-full rounded-[10px] border border-line py-3 text-[15px] text-ink-2 disabled:opacity-60"
      >
        {pending ? "切换中…" : MOCK_USER_SWITCH_LABEL}
      </button>
      <p className="text-[12px] leading-5 text-ink-3">{MOCK_USER_SWITCH_NOTICE}</p>
      {error ? (
        <p role="alert" className="text-[13px] text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
