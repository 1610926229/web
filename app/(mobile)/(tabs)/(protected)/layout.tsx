import type { ReactNode } from "react";
import RequireAuth from "@/lib/auth/RequireAuth";

/**
 * 需登录的一级 Tab 页面（订单 / 客服 / 我的）。
 *
 * 登录判断只在这里做一次，三个页面自身不写任何鉴权逻辑。
 * 未登录时渲染统一的登录拦截界面，当前地址不变，登录后回到该页面。
 */
export default function ProtectedTabsLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
