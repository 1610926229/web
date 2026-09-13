"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ADMIN_CONSOLE_NAME,
  ADMIN_NAV_ITEMS,
  ADMIN_UPCOMING_BADGE,
  ADMIN_UPCOMING_MODULES,
} from "@/lib/constants/admin";

/**
 * 管理后台左侧导航。
 *
 * **客户端组件**，理由只有一个：选中态需要 `usePathname()`。
 * 导航项本身来自 `lib/constants/admin.ts` 的常量——**它不读会话、不判断角色**：
 * 界面上的可见性不是权限，权限在服务端（`lib/api/adminRoute.ts` 的 `requireAdmin()`）。
 * 就算有人在浏览器里把侧栏改成显示全部模块，接口该 401 还是 401、该 403 还是 403。
 *
 * 「后续开放」的模块渲染成**禁用项**，没有 `href`：这些模块本阶段不存在，
 * 给一个能点进去的空壳，比什么都不显示更容易被当成已经做好了。
 *
 * 布局：桌面端固定在左侧（`sticky` + 自身高度），窄屏时降到顶部横向滚动一行——
 * 不做抽屉（那要额外的开关状态），也不把侧栏藏起来（后台的导航不能需要先找到才能用）。
 */
export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="管理后台导航"
      className="flex shrink-0 flex-col gap-6 bg-admin-sidebar px-4 py-5 text-admin-sidebar-ink md:sticky md:top-0 md:h-dvh md:w-60 md:px-4 md:py-6"
    >
      <div className="px-2">
        <p className="text-[15px] font-semibold">{ADMIN_CONSOLE_NAME}</p>
        <p className="mt-1 text-[12px] text-admin-sidebar-ink-soft">本地 Mock 环境</p>
      </div>

      <ul className="flex gap-2 overflow-x-auto md:flex-col md:gap-1 md:overflow-visible">
        {ADMIN_NAV_ITEMS.map((item) => {
          // 精确匹配而不是「前缀匹配」：`/admin` 是 `/admin/applications` 的前缀，
          // 用前缀判断会让概览永远处于选中态。子路径由本组的页面各自声明。
          const active = pathname === item.href;

          return (
            <li key={item.key} className="shrink-0 md:shrink">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex flex-col rounded-lg px-3 py-2 transition-colors ${
                  active
                    ? "bg-admin-sidebar-active text-white"
                    : "text-admin-sidebar-ink-soft hover:bg-admin-sidebar-active/60 hover:text-white"
                }`}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-admin-accent"
                  />
                ) : null}
                <span className="whitespace-nowrap text-[14px] font-medium">{item.label}</span>
                <span className="hidden whitespace-nowrap text-[12px] text-admin-sidebar-ink-soft md:block">
                  {item.description}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/*
        后续阶段模块：**只列出名字，不提供入口**。
        这里没有链接、没有按钮，所以也不需要 `aria-disabled`——
        一个不可点击的列表项本来就不可点击，读屏与键盘都不会把它当成能到达的地方。
        「后续开放」的角标是这行文字的注解，不是可操作控件。
      */}
      <div className="hidden md:mt-auto md:block">
        <p className="px-2 text-[12px] font-medium text-admin-sidebar-ink-soft">后续阶段</p>
        <ul className="mt-2 flex flex-col gap-1">
          {ADMIN_UPCOMING_MODULES.map((label) => (
            <li
              key={label}
              className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-[12px] text-admin-sidebar-ink-soft/70"
            >
              <span className="truncate">{label}</span>
              <span className="shrink-0 rounded border border-admin-sidebar-ink-soft/30 px-1 py-px text-[10px] leading-4">
                {ADMIN_UPCOMING_BADGE}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
