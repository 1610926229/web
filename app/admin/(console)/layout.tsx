import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import AdminHeader from "@/components/admin/AdminHeader";
import AdminSidebar from "@/components/admin/AdminSidebar";
import { getAdminSession } from "@/lib/services/adminAuth";

/**
 * PC 管理后台的壳层（`/admin`、`/admin/applications`、`/admin/companions`）。
 *
 * ⚠️ **不复用用户端的任何壳层**：这里没有 `MobileShell`（那是 480px 的居中列，
 * 桌面后台要铺满宽度），也没有 `TabBar`。用户端的外壳在 `app/(mobile)/layout.tsx`，
 * 两套壳层并列，谁也不罩住谁。
 *
 * ⚠️ **鉴权在这一层执行，而且是服务端执行**。`getAdminSession()` 读的是管理端 Cookie
 * （`mock_admin_id`），与用户端 Cookie 不是同一个；返回 null 就说明「没有管理权限」，
 * 直接转到登录页。页面自己不再写鉴权，「哪些页面需要管理者」因此只有这一处答案。
 *
 * ⚠️ 这一层**不是**接口的保护伞：页面跳转拦不住直接请求 `/api/admin/**`。
 * 管理接口逐个调用 `requireAdmin()`（见 `lib/api/adminRoute.ts`），
 * 页面隐藏与接口鉴权是两件事，必须都有。
 *
 * 关于 `redirect`：布局在子页面之前渲染，此时响应还没有开始流式输出，
 * 因此这里给出的是真正的 307，而不是「200 + 一段客户端跳转脚本」。
 *
 * 路由组 `(console)` 不产生 URL 段：`app/admin/(console)/page.tsx` 的地址就是 `/admin`。
 * 分组的目的只有一个——让 `/admin/login` 不套这层壳（登录页没有侧栏，也不该先要求登录）。
 */
export default async function AdminConsoleLayout({ children }: { children: ReactNode }) {
  const admin = await getAdminSession();
  if (!admin) redirect("/admin/login");

  return (
    /*
     * 窄屏：侧栏在顶部一行、内容在下（flex-col）。
     * ≥md：侧栏固定在左侧（sticky 占满视口高度），内容区占满剩余宽度。
     * `min-w-0` 是必需的：flex 子项默认 `min-width: auto`，内容一宽就会把侧栏挤扁。
     */
    <div className="flex min-h-dvh flex-col bg-page md:flex-row">
      <AdminSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <AdminHeader admin={admin} />
        <main className="flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
