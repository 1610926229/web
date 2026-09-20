"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { authAdapter } from "./MockAuthAdapter";
import type { User } from "@/lib/types/user";

/**
 * 登录态上下文。
 *
 * 用户信息来源是**服务端**（`lib/auth/session.ts` 读取会话），客户端不重复拉取，
 * 避免出现两份真相。登录/登出后调用 `router.refresh()` 让服务端重新渲染。
 *
 * `user` 可以为空：商品详情页这类**免登录可浏览、但部分操作需登录**的页面也需要
 * 读取登录态。需要「必定已登录」的场景请用 `useAuthUser()`。
 */
type AuthContextValue = {
  user: User | null;
  /** `userId` 只对 Mock 实现有意义（测试账号名单），见 `AuthAdapter` */
  login: (userId?: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export default function AuthProvider({
  user,
  children,
}: {
  user: User | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const value = useMemo<AuthContextValue>(() => {
    const run = async (action: () => Promise<unknown>) => {
      if (pending) return;
      setPending(true);
      try {
        await action();
        router.refresh();
      } finally {
        setPending(false);
      }
    };

    return {
      user,
      login: (userId?: string) => run(() => authAdapter.login(userId)),
      logout: () => run(() => authAdapter.logout()),
    };
  }, [user, pending, router]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth 只能在 AuthProvider 内使用");
  }
  return value;
}

/**
 * 取当前登录用户，并断言必定已登录。
 *
 * 只在 `RequireAuth` 保护的页面里可用——那些页面在未登录时根本渲染不到，
 * 因此这里多一层断言，省去调用方的判空分支。
 */
export function useAuthUser(): User {
  const { user } = useAuth();
  if (!user) {
    throw new Error("useAuthUser 只能在 RequireAuth 保护的页面内使用");
  }
  return user;
}
