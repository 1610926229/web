"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  STAFF_LOGIN_LABEL,
  STAFF_MOCK_DISABLED_MESSAGE,
} from "@/lib/constants/staff";
import { mockLoginStaff } from "@/lib/services/staffHttp";
import type { StaffLoginOption } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 客服登录页的账号选择面板（**Mock 认证**）。
 *
 * ⚠️ **没有密码框，也没有验证码**：本阶段不存在真实凭据，画一个密码框会让人
 * 以为它真的验了密码。这里做的唯一一件事是「从启用的客服账号里挑一个，
 * 让服务端把它的 id 写进客服端 Cookie」。
 *
 * ⚠️ 名单**只出现在这一页**：用户端前台任何地方都没有账号切换器
 * （§三：不得在用户前台提供账号切换）。因此这个组件的唯一引用点就是 `/staff/login`。
 *
 * ⚠️ 名单由**服务端**给出（`getStaffLoginOptions()`），只含启用中且未移除的账号。
 * 停用或已删除的账号不在这里——列出来等于给出一个「点了一定失败」的入口，
 * 也等于告诉所有人「这些账号存在」。这不是前端过滤能做到的：前端过滤时，
 * 被过滤掉的数据已经在响应里了。
 *
 * ⚠️ 开关关闭（`ENABLE_MOCK_STAFF=false`）时，本组件**不渲染任何控件**，
 * 只显示一句说明。渲染出来再让点击失败，会让人以为是自己操作错了。
 */
export default function StaffLoginPanel({
  options,
  enabled,
  notice,
}: {
  options: StaffLoginOption[];
  enabled: boolean;
  notice: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function signIn(staffId: string) {
    if (busyId) return;
    setBusyId(staffId);
    setError("");

    try {
      await mockLoginStaff(staffId);
      // `refresh()` 让服务端重新渲染一次：布局要重新读一次会话才会放行，
      // 只 push 的话可能命中已经渲染好的路由缓存
      router.replace("/staff");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请稍后重试。");
      setBusyId(null);
    }
  }

  if (!enabled) {
    return (
      <p
        role="status"
        className="rounded-xl border border-admin-line bg-page px-4 py-3 text-[13px] leading-5 text-ink-3"
      >
        {STAFF_MOCK_DISABLED_MESSAGE}
      </p>
    );
  }

  if (options.length === 0) {
    return (
      <p
        role="status"
        className="rounded-xl border border-admin-line bg-page px-4 py-3 text-[13px] leading-5 text-ink-3"
      >
        当前没有可登录的客服账号：所有账号都已停用或已移除。
        请先让管理员在后台「客服账号」里新增或启用一个账号。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-5 text-ink-3">{notice}</p>

      <ul className="flex flex-col gap-2">
        {options.map((option) => {
          const busy = busyId === option.id;
          return (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => void signIn(option.id)}
                disabled={busyId !== null}
                className="flex w-full items-center gap-3 rounded-xl border border-admin-line bg-surface px-4 py-3 text-left hover:bg-page disabled:opacity-60"
              >
                <img
                  src={option.avatarUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[14px] font-medium text-ink">{option.displayName}</span>
                  <span className="font-mono text-[12px] text-ink-3">{option.username}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="text-[12px] text-ink-3">
                    {option.lastLoginAt ? `上次登录 ${formatDateTime(option.lastLoginAt)}` : "从未登录"}
                  </span>
                  <span className="text-[13px] text-admin-accent">
                    {busy ? "登录中…" : STAFF_LOGIN_LABEL}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
