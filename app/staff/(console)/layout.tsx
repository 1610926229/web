import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import StaffHeader from "@/components/staff/StaffHeader";
import { getStaffSession } from "@/lib/services/staffAuth";

/**
 * 客服工作台的壳层（`/staff`、`/staff/orders`、`/staff/conversations`、`/staff/refunds`、`/staff/complaints`）。
 *
 * ⚠️ **不复用用户端或管理端的任何壳层**：这里没有 `MobileShell`（那是 480px 的居中列），
 * 没有用户端 `TabBar`（工作台是桌面优先的），也不进管理端侧栏。
 * 三套壳层并列，谁也不罩住谁。
 *
 * ⚠️ 「不进管理端侧栏」这句话**不等于「客服看不到退款与投诉」**：P8D-1 时这里写的是
 * 「客服看不到订单全量、退款审核与投诉处理」，P8D-2 把后两样做出来了，
 * P0-10 又把第一样（`/staff/orders` 全量订单只读查询）做出来了，
 * 因此那句话必须跟着改——留着它会让下一个读这份注释的人以为工作台里没有那个入口。
 * 现在的边界是：订单、退款与投诉都在**工作台自己的页面**里处理，
 * 而**管理端的侧栏与后台仍然进不去**。这两件事同时成立，不矛盾。
 *
 * ⚠️ **鉴权在这一层执行，而且是服务端执行**。`getStaffSession()` 读的是客服端 Cookie
 * （`mock_staff_id`），与用户端、管理端都不是同一个；返回 null 就说明「没有客服权限」，
 * 直接转到登录页。它在**每次请求**都重新查一次账号状态，因此被停用或被移除的客服
 * 在下一个请求就出不去了——不需要一张会话表，也不需要在这里判断 `enabled`。
 *
 * ⚠️ 这一层**不是**接口的保护伞：页面跳转拦不住直接请求 `/api/staff/**`。
 * 客服接口逐个调用 `requireStaff()`（见 `lib/api/staffRoute.ts`），
 * 页面隐藏与接口鉴权是两件事，必须都有。
 *
 * 关于 `redirect`：布局在子页面之前渲染，此时响应还没有开始流式输出，
 * 因此这里给出的是真正的 307，而不是「200 + 一段客户端跳转脚本」。
 *
 * 路由组 `(console)` 不产生 URL 段：`app/staff/(console)/page.tsx` 的地址就是 `/staff`。
 * 分组的目的只有一个——让 `/staff/login` 不套这层壳。
 */
export default async function StaffConsoleLayout({ children }: { children: ReactNode }) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <StaffHeader staff={staff} />
      <main className="flex-1 px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
