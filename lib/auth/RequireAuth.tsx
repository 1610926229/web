import type { ReactNode } from "react";
import { isMockAuthEnabled } from "@/lib/config/env";
import { getSessionUser } from "./session";
import LoginGate from "./LoginGate";
import AuthProvider from "./useAuth";

/**
 * 受保护区域的服务端守卫。
 *
 * 需登录的页面统一包在这里，页面自身不写登录判断：
 * 未登录 → 渲染统一的登录拦截界面（地址不变，登录后回到原页面）；
 * 已登录 → 把服务端读到的用户注入 AuthProvider，供页面通过 useAuth() 使用。
 *
 * 开关在服务端读取后以 props 传给客户端组件，客户端因此不需要（也不应该）
 * 知道任何环境变量。
 */
export default async function RequireAuth({ children }: { children: ReactNode }) {
  const user = await getSessionUser();

  if (!user) return <LoginGate mockAuthEnabled={isMockAuthEnabled()} />;

  return <AuthProvider user={user}>{children}</AuthProvider>;
}
