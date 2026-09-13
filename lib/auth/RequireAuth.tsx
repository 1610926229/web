import type { ReactNode } from "react";
import { isMockAuthEnabled } from "@/lib/config/env";
import type { User } from "@/lib/types/user";
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
 * `children` 也可以是函数 `(user) => ReactNode`：有些页面（如支付结果页）必须在**服务端**
 * 就拿到当前用户去做归属校验，用函数可以直接拿到守卫已经读出来的这个用户，
 * 而不是在页面里再读一次会话——鉴权因此始终只有一处实现。
 * 这是 Server Component 到 Server Component 的传参，函数不会跨到浏览器。
 *
 * 开关在服务端读取后以 props 传给客户端组件，客户端因此不需要（也不应该）
 * 知道任何环境变量。
 */
export default async function RequireAuth({
  children,
}: {
  children: ReactNode | ((user: User) => ReactNode);
}) {
  const user = await getSessionUser();

  if (!user) return <LoginGate mockAuthEnabled={isMockAuthEnabled()} />;

  const content = typeof children === "function" ? children(user) : children;

  return <AuthProvider user={user}>{content}</AuthProvider>;
}
