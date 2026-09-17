"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  COMPANION_CONSOLE_NAME,
  COMPANION_NAV_ITEMS,
  COMPANION_ROLE_LABEL,
} from "@/lib/constants/companionConsole";
import type { CompanionSessionUser } from "@/lib/types/companionWorkspace";

/**
 * 打手工作台顶栏：平台名 + 导航 + **当前打手**。
 *
 * ⚠️ 与 `components/staff/StaffHeader.tsx` 的差别只有一处，而且是刻意的：
 * **这里没有退出登录**。打手用的是用户账号，退出登录是用户端「我的」页面的事；
 * 在工作台再放一个退出按钮，会让人以为退出后还会留着一个「打手登录」入口。
 *
 * 导航用**前缀匹配**判断选中（`/staff` 那种全等特例在这里不需要：
 * `/companion` 目前只有一项，先按同一套规则写，将来加页面时行为已经是对的）。
 *
 * 打手昵称取自**护航资料**（`displayName`），不是用户昵称：用户端看到的那位
 * 「陪玩」就是他，两处名称必须一致，否则用户下单时选的是另一个人。
 */
export default function CompanionHeader({ companion }: { companion: CompanionSessionUser }) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="border-b border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-[15px] font-semibold text-ink">
            {COMPANION_CONSOLE_NAME}
          </span>

          <nav aria-label="工作台导航" className="flex items-center gap-1">
            {COMPANION_NAV_ITEMS.map((item) => {
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

        <span className="flex shrink-0 items-center gap-2">
          <img
            src={companion.avatarUrl}
            alt=""
            className="h-8 w-8 rounded-full border border-line object-cover"
          />
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-medium text-ink">{companion.displayName}</span>
            <span className="text-[11px] text-ink-3">{COMPANION_ROLE_LABEL}</span>
          </span>
        </span>
      </div>
    </header>
  );
}
