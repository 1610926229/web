import type { ReactNode } from "react";
import MobileShell from "@/components/common/MobileShell";
import MockIdentitySwitcher from "@/lib/auth/MockIdentitySwitcher";
import { isPublicPreviewRequest } from "@/lib/auth/publicPreviewRequest";
import { isMockAuthEnabled } from "@/lib/config/env";

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
 *
 * ⚠️ **DEV-1 的身份切换面板挂在这里，而不是挂在 `MobileShell` 上。**
 * `MobileShell` 还被打手工作台（`app/companion/(console)/layout.tsx`）复用，
 * 挂在它上面等于顺着壳层漏进另一端；挂在**本路由组**上，「用户端才有的开发工具」
 * 与「用户端」在结构上是同一句话。开关与渲染条件全在
 * `lib/auth/MockIdentitySwitcher.tsx`，本文件只负责给它一个位置。
 *
 * ⚠️ **公网只读预览：公网请求不挂身份切换面板。**
 * Nginx 会为公网请求注入 `X-Chaoge-Public-Preview: 1` 并清空 Cookie；
 * 该标记存在时这里直接不渲染面板，页面上因此既没有入口、也没有名单。
 * 真正的拒绝在两层：Nginx 白名单（`deploy/proxy/chaoge-public.conf`）与
 * 应用守卫（`proxy.ts`）——这里只负责不让「开发工具」出现在公网 HTML 里。
 * 先判 `isMockAuthEnabled()` 再读请求头，开关关闭时不会调用 `headers()`，
 * 静态化行为保持不变。
 */
export default async function MobileLayout({ children }: { children: ReactNode }) {
  const showMockIdentity =
    isMockAuthEnabled() && !(await isPublicPreviewRequest());

  return (
    <MobileShell>
      {children}
      {showMockIdentity ? <MockIdentitySwitcher /> : null}
    </MobileShell>
  );
}
