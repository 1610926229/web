import { redirect } from "next/navigation";
import AdminLoginPanel from "@/components/admin/AdminLoginPanel";
import { isMockAdminEnabled } from "@/lib/config/env";
import { getAdminSession } from "@/lib/services/adminAuth";

/**
 * 管理后台登录页（`/admin/login`）。
 *
 * ⚠️ **本页在 `(console)` 路由组之外**，因此不套后台壳层：登录页既不该有侧栏，
 * 也不该在「还没登录」的时候先要求登录——那会变成一个转到自己的死循环。
 *
 * 两个分支：
 * - 已经有管理端会话（且是 admin）→ 转到 `/admin`，不让人停在登录页；
 * - 没有会话 → 渲染登录面板；面板是否显示「模拟管理员登录」按钮由
 *   `ENABLE_MOCK_ADMIN` 决定（开关由服务端读取后以 props 传入，客户端读不到环境变量）。
 *
 * `getAdminSession()` 判定的是**管理端**会话（`mock_admin_id`）：带着用户端 Cookie
 * 访问本页，会正常看到登录面板——用户身份在这里不构成任何权限。
 */
export default async function AdminLoginPage() {
  const admin = await getAdminSession();
  if (admin) redirect("/admin");

  return <AdminLoginPanel mockAdminEnabled={isMockAdminEnabled()} />;
}
