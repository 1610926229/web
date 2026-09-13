import type { ReactNode } from "react";
import MobileShell from "@/components/common/MobileShell";

/**
 * 用户端（移动）外壳。
 *
 * ⚠️ **这一层存在的理由，是让 `/admin` 不被它罩住。**
 * 在此之前 `MobileShell` 挂在根布局上，于是**所有**页面——包括 PC 管理后台——都被套进
 * 480px 的居中列（`--shell-width`），而宽度是被祖先裁掉的，子页面加多少 `max-w-none`
 * 都救不回来。现在根布局只剩文档骨架（`html` / `body`），壳层按端分家：
 *
 * - 本路由组 `(mobile)`：用户端，手机优先、桌面居中，即原来的 480px 列；
 * - `app/admin/`：PC 管理后台，自己一套桌面布局，与本组互不影响。
 *
 * 路由组**不产生 URL 段**：`app/(mobile)/companions/page.tsx` 的地址仍然是 `/companions`，
 * 用户端所有地址一个都没变。搬进来的页面也只是换了目录，源码一行没改。
 *
 * 一级 Tab 页（`(mobile)/(tabs)`）是本组的子分组，因此它同样吃到这层壳，
 * 再自己补一个底部 `TabBar`；需要隐藏底部导航的二级页面不进 `(tabs)`，只吃这一层。
 *
 * 组件本身仍然叫 `MobileShell`（它描述的正是「移动端外壳」这件事），
 * 只是改由本组引用——而不是继续赖在根布局上，让每个端都不得不接受它。
 */
export default function MobileLayout({ children }: { children: ReactNode }) {
  return <MobileShell>{children}</MobileShell>;
}
