"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  COMPANION_BACK_TO_USER_HREF,
  COMPANION_BACK_TO_USER_LABEL,
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
 * ## 左侧的「返回用户端」（P0-6.1 FIX-1）
 *
 * 工作台**不在底部 TabBar 里**，因此进来之后原本没有任何回到用户端的入口——
 * 唯一的出口是「我的」那一页，而它需要先知道自己在哪。这里补的是一个
 * **界面导航**：同一份会话、同一个账号，只是换个界面看
 * （`COMPANION_BACK_TO_USER_*` 的注释里写了它不是退出登录、也不是身份切换）。
 *
 * ⚠️ 它长在**顶栏组件上**，不是长在每个页面上：整个 `(console)` 路由组共用这一个顶栏，
 * 因此 `pool` / `exclusive` / `orders` / `orders/[id]` 与概览页**都**有它，样式也必然一致。
 * 各页面各写一个返回按钮，迟早会有一个页面漏掉，或者哪天只改了一半。
 *
 * 导航用**前缀匹配**判断选中，`/companion` 是例外（全等比较）——理由与
 * `StaffHeader` 完全相同：它是其余所有 `/companion/...` 的前缀，
 * 前缀匹配会让概览在每个子页面上都亮着。
 *
 * 打手昵称取自**护航资料**（`displayName`），不是用户昵称：用户端看到的那位
 * 「陪玩」就是他，两处名称必须一致，否则用户下单时选的是另一个人。
 */
export default function CompanionHeader({ companion }: { companion: CompanionSessionUser }) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    // `/companion` 是其余所有 `/companion/...` 的前缀，必须全等比较：
    // 用前缀匹配的话，站在订单池页面上「工作台」也会一起点亮（与 `StaffHeader` 同一条规则）
    if (href === "/companion") return pathname === "/companion";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="border-b border-line bg-surface">
      {/* FIX-1：回到用户端的界面入口。单独一行放在最上方左侧，而不是塞进下面
          那一行——那一行已经有平台名 + 四个导航项 + 打手头像，在 375px 宽的
          手机上本来就要折行，再挤进去会先把标题压变形。 */}
      <div className="px-4 pt-2">
        <Link
          href={COMPANION_BACK_TO_USER_HREF}
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {COMPANION_BACK_TO_USER_LABEL}
        </Link>
      </div>

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
