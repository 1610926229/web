"use client";

import { useState } from "react";
import type { MockWechatIdentity } from "@/lib/auth/wechat/mockProvider";
import { completeMockWechatLogin } from "@/lib/services/wechatAuthHttp";

/**
 * Mock 微信身份选择器（私有 Staging 专用）。
 *
 * ⚠️ 选择身份只决定「哪个模拟 openid 登录」，**不决定角色**：
 * 卡片里没有任何「成为护航 / 客服 / 管理员」的选项。打手资格仍走入驻审核。
 *
 * 成功后用整页跳转回到发起登录前的站内地址，而不是 `router.refresh()`：
 * 登录可能发生在订单、打手工作台等不同页面，整页跳转能确保服务端重新读取
 * 新会话并渲染对应页面。
 */
export default function MockWechatLoginPanel({
  identities,
  redirectTo,
}: {
  identities: readonly MockWechatIdentity[];
  redirectTo: string;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(key: string) {
    if (pendingKey) return;
    setPendingKey(key);
    setError(null);

    try {
      const result = await completeMockWechatLogin({ key, redirect: redirectTo });
      window.location.assign(result.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请稍后重试");
      setPendingKey(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="rounded-lg border border-line bg-page px-3 py-2 text-[12px] leading-5 text-ink-3">
        以下是模拟的微信身份，不是真实微信账号。首次选择会创建一个平台用户；
        再次选择同一身份会登录回同一个用户。微信登录只确认用户身份，
        <strong className="font-medium text-ink-2">不会自动获得护航、客服或管理员权限</strong>。
      </p>

      {identities.map((identity) => {
        const pending = pendingKey === identity.key;
        return (
          <button
            key={identity.key}
            type="button"
            disabled={pendingKey !== null}
            onClick={() => void choose(identity.key)}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left disabled:opacity-60"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={identity.avatarUrl}
              alt=""
              width={44}
              height={44}
              className="h-11 w-11 shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-ink">
                {identity.nickname}
              </span>
              <span className="mt-0.5 block text-[12px] leading-4 text-ink-3">
                {identity.description}
              </span>
            </span>
            <span className="shrink-0 text-[13px] text-[#07c160]">
              {pending ? "登录中…" : "选择"}
            </span>
          </button>
        );
      })}

      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
