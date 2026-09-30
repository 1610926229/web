"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "@/components/common/EmptyState";
import { authAdapter } from "./MockAuthAdapter";
import MockUserPicker from "./MockUserPicker";

/**
 * 统一的登录拦截界面。
 *
 * 两处复用，登录逻辑只此一份：
 * - 需登录的**整页**由 `RequireAuth` 渲染本组件：不跳转，当前地址保持不变，
 *   登录成功后 `router.refresh()` 让服务端重新渲染该地址，用户自然回到原本要访问的页面；
 * - 免登录页面上的**受限操作**（详情页的收藏 / 客服 / 立即购买）由 `LoginSheet` 以浮层
 *   形式渲染本组件，`onSuccess` 用来关闭浮层并继续原来的操作。
 *
 * 未来接入公众号网页授权后，这里的按钮改为触发授权跳转即可，两处调用方都不用改。
 *
 * `mockAuthEnabled` 由服务端传入：未开启模拟登录时，界面上不出现任何模拟登录入口，
 * 只如实说明「登录功能尚未开放」。
 *
 * ⚠️ **Mock 环境下的登录入口是「测试账号选择器」，不是单个按钮**（`MockUserPicker`）。
 * 手工验收 P0-5 要同时扮演老板、打手 B、打手 C，固定登录同一个账号走不通。
 * `userId` 只在这条分支里有意义：真实微信授权下身份由 code 换取的会话决定，
 * 不由调用方声明——因此 `authAdapter.login()` 的参数**只有 Mock 实现会读**，
 * 见 `lib/auth/AuthAdapter.ts` 的说明。
 */
export default function LoginGate({
  mockAuthEnabled,
  title = "需要登录",
  description,
  onSuccess,
}: {
  mockAuthEnabled: boolean;
  title?: string;
  description?: string;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  /** 正在登录的那个账号 id（不是布尔值：选择器要指出是哪一行在转圈） */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (userId: string) => {
    if (pendingId) return;
    setPendingId(userId);
    setError(null);
    try {
      await authAdapter.login(userId);
      router.refresh();
      onSuccess?.();
    } catch {
      setError("登录失败，请重试");
      setPendingId(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-surface px-4 py-16">
      <EmptyState
        title={title}
        description={
          description ??
          (mockAuthEnabled
            ? "登录后即可查看订单、联系客服与个人中心。当前为开发阶段的模拟登录，不会调用真实微信接口。"
            : "登录后即可查看订单、联系客服与个人中心。登录功能正在接入中，敬请期待。")
        }
      />

      {mockAuthEnabled ? (
        <MockUserPicker busyId={pendingId} onPick={(userId) => void handleLogin(userId)} />
      ) : null}

      {error ? <p className="text-[13px] text-brand-red">{error}</p> : null}
    </div>
  );
}
