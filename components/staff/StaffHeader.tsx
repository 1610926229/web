"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  STAFF_CONSOLE_NAME,
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_LOGOUT_LABEL,
  STAFF_OVERVIEW_PAGE_TITLE,
} from "@/lib/constants/staff";
import { logoutStaff } from "@/lib/services/staffHttp";
import type { StaffSessionUser } from "@/lib/types/staff";

/** 顶栏导航。两个入口，顺序即页面上从左到右的顺序。 */
const NAV_ITEMS: readonly { href: string; label: string }[] = [
  { href: "/staff", label: STAFF_OVERVIEW_PAGE_TITLE },
  { href: "/staff/conversations", label: STAFF_CONVERSATIONS_PAGE_TITLE },
];

/**
 * 工作台顶栏：平台名 + 导航 + **当前客服名称与退出入口**。
 *
 * ⚠️ 这是**独立于用户端与管理端**的第三套壳层。它不用用户端的 `TabBar`
 * （工作台是桌面优先的，480px 的底部页签在这里既挤又不对），
 * 也不进管理端侧栏（客服看不到订单全量、退款审核与投诉处理）。
 *
 * ⚠️ 导航用 `/staff/conversations` 的**前缀匹配**判断选中：详情页
 * `/staff/conversations/[orderId]` 也应当把「会话列表」点亮——
 * 只做全等比较的话，从列表点进详情，导航会突然全部熄灭，像走进了死胡同。
 *
 * 退出只清客服端 Cookie：它**不会**顺带清掉用户端或管理端的会话
 * （三套 Cookie 互不相干，见 `lib/auth/staffSession.ts`）。
 */
export default function StaffHeader({ staff }: { staff: StaffSessionUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");

    try {
      await logoutStaff();
      router.replace("/staff/login");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退出失败，请稍后重试。");
      setBusy(false);
    }
  }

  function isActive(href: string): boolean {
    if (href === "/staff") return pathname === "/staff";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="border-b border-admin-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="shrink-0 text-[15px] font-semibold text-ink">{STAFF_CONSOLE_NAME}</span>

          <nav aria-label="工作台导航" className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-3 py-1.5 text-[13px] ${
                    active ? "bg-page font-medium text-ink" : "text-ink-2 hover:bg-page"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-2">
            <img
              src={staff.avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full border border-admin-line object-cover"
            />
            <span className="flex flex-col leading-tight">
              <span className="text-[13px] font-medium text-ink">{staff.displayName}</span>
              <span className="text-[11px] text-ink-3">{staff.roleLabel}</span>
            </span>
          </span>

          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
          >
            {busy ? "退出中…" : STAFF_LOGOUT_LABEL}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="px-4 pb-2 text-[12px] leading-4 text-brand-red md:px-6">
          {error}
        </p>
      ) : null}
    </header>
  );
}
