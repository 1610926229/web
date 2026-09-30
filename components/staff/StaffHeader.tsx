"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  STAFF_COMPLAINTS_PAGE_TITLE,
  STAFF_CONSOLE_NAME,
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_LOGOUT_LABEL,
  STAFF_ORDERS_PAGE_TITLE,
  STAFF_OVERVIEW_PAGE_TITLE,
  STAFF_REFUNDS_PAGE_TITLE,
} from "@/lib/constants/staff";
import { STAFF_COMPLETION_DETAIL_TITLE } from "@/lib/constants/staffCompletions";
import { logoutStaff } from "@/lib/services/staffHttp";
import type { StaffSessionUser } from "@/lib/types/staff";

/**
 * 顶栏导航。顺序即页面上从左到右的顺序。
 *
 * 退款与投诉是 P8D-2 新加的入口，与会话并排：三者都是客服工作台的「待办」，
 * 会话是沟通，退款 / 投诉是处理。放在同一层而不是某个二级菜单里，
 * 客服不用记「哪个模块藏在哪个角落」。
 *
 * ⚠️「订单」（P0-10）**排在「工作台」之后、其余待办之前**：它回答的是
 * 「这一单是什么情况」，是客服接到任何问题时要先看的那一页；
 * 会话 / 退款 / 投诉 / 完成材料都是**从某一单出发**才能处理的，排在它后面。
 * 顺序是按「先看事实、再看待办」排的，不是按功能上线时间排的。
 */
const NAV_ITEMS: readonly { href: string; label: string }[] = [
  { href: "/staff", label: STAFF_OVERVIEW_PAGE_TITLE },
  { href: "/staff/orders", label: STAFF_ORDERS_PAGE_TITLE },
  { href: "/staff/conversations", label: STAFF_CONVERSATIONS_PAGE_TITLE },
  { href: "/staff/refunds", label: STAFF_REFUNDS_PAGE_TITLE },
  { href: "/staff/complaints", label: STAFF_COMPLAINTS_PAGE_TITLE },
  { href: "/staff/completions", label: STAFF_COMPLETION_DETAIL_TITLE },
];

/**
 * 工作台顶栏：平台名 + 导航 + **当前客服名称与退出入口**。
 *
 * ⚠️ 这是**独立于用户端与管理端**的第三套壳层。它不用用户端的 `TabBar`
 * （工作台是桌面优先的，480px 的底部页签在这里既挤又不对），
 * 也不进管理端侧栏（客服看不到订单全量；退款与投诉在自己的独立入口里处理，
 * 不与管理端的退款审核 / 投诉处理共用同一个页面）。
 *
 * ⚠️ 除 `/staff` 外，导航都用**前缀匹配**判断选中：从列表点进
 * `/staff/conversations/[orderId]`、`/staff/refunds/[id]` 或
 * `/staff/complaints/[id]` 时，对应的列表入口仍应点亮——只做全等比较的话，
 * 从列表点进详情，导航会突然全部熄灭，像走进了死胡同。
 * `/staff` 是例外：它是其余所有 `/staff/...` 的前缀，必须全等比较，
 * 否则概览会永远处于选中态。
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
