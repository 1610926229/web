"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_LOGOUT_LABEL } from "@/lib/constants/admin";
import { logoutAdmin } from "@/lib/services/adminHttp";
import type { AdminSessionUser } from "@/lib/types/admin";

/**
 * 管理后台顶部条：当前管理者 + 退出入口。
 *
 * **客户端组件**，因为退出是一个由点击触发、并且要刷新服务端渲染结果的动作。
 *
 * ⚠️ 「退出」不由前端改写登录态：调用退出接口（服务端删除管理端 Cookie）→
 * `router.refresh()` → 服务端重新渲染当前地址 → 布局发现没有会话，把人送回登录页。
 * 前端始终没有「我登录了 / 我退出了」这个状态，它只知道一件事——把结果交给服务端。
 *
 * 显示的是会话 DTO（昵称 + 角色文案），它由服务端传入，
 * **不带 `enabled`、不带 `lastLoginAt`、不带任何凭据**。
 */
export default function AdminHeader({ admin }: { admin: AdminSessionUser }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleLogout = async () => {
    if (pending) return;
    setPending(true);

    try {
      await logoutAdmin();
    } finally {
      // 无论接口成功与否都刷新：失败时刷新只会重新渲染出「仍然登录」的界面，
      // 比卡在一个「正在退出…」的按钮上更诚实
      router.replace("/admin/login");
      router.refresh();
    }
  };

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-admin-line bg-surface px-6 py-3">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium text-ink">{admin.displayName}</p>
        <p className="truncate text-[12px] text-ink-3">
          {admin.roleLabel} · {admin.username}
        </p>
      </div>

      <button
        type="button"
        onClick={handleLogout}
        disabled={pending}
        className="rounded-lg border border-admin-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-page disabled:opacity-60"
      >
        {pending ? "退出中…" : ADMIN_LOGOUT_LABEL}
      </button>
    </header>
  );
}
