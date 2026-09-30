"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 运营内容（`/admin/content/*`）四个子模块的公共切换条。
 *
 * ⚠️ 四个子模块做成一层的子页签，而不是侧栏里的四个扁平入口：它们都是
 * 「用户端首页与协议页上那点内容」，在侧栏里平铺会让人看不出彼此的关系，
 * 而侧栏每多一项，前面的模块就往下沉一格。
 *
 * ⚠️ 这里渲染的是**链接**，不是 `role="tablist"`：四个页签各自是一个**页面**
 * （地址不同、服务端取数不同、刷新后停在原地）。用 tab 角色会让读屏软件
 * 以为下面是一组同页的面板，还会让人期望左右方向键能切换。
 * 当前页用 `aria-current="page"` 表达——这正是链接的语义。
 *
 * 布局与侧栏同一条理由：桌面端一行排开，窄屏横向滚动而不是折行——
 * 折行会把内容区整体往下推，四行页签之后才看得到列表。
 */
const ADMIN_CONTENT_TABS = [
  {
    key: "announcements",
    href: "/admin/content/announcements",
    label: "图片公告",
    description: "首页顶部滚动的公告图",
  },
  {
    key: "banners",
    href: "/admin/content/banners",
    label: "活动 Banner",
    description: "首页活动展示图（只展示一张）",
  },
  {
    key: "quick-entries",
    href: "/admin/content/quick-entries",
    label: "快捷入口",
    description: "首页四宫格入口",
  },
  {
    key: "agreements",
    href: "/admin/content/agreements",
    label: "协议与版本",
    description: "五类协议正文与版本",
  },
] as const;

export default function AdminContentTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="运营内容子模块" className="border-b border-admin-line">
      <ul className="flex gap-1 overflow-x-auto">
        {ADMIN_CONTENT_TABS.map((tab) => {
          const active = pathname === tab.href;

          return (
            <li key={tab.key} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col rounded-t-lg border-b-2 px-4 py-2 transition-colors ${
                  active
                    ? "border-admin-accent text-ink"
                    : "border-transparent text-ink-3 hover:bg-page hover:text-ink-2"
                }`}
              >
                <span className="whitespace-nowrap text-[14px] font-medium">{tab.label}</span>
                <span className="hidden whitespace-nowrap text-[12px] text-ink-3 md:block">
                  {tab.description}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
