"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { authAdapter } from "./MockAuthAdapter";
import type { User } from "@/lib/types/user";

/**
 * 登录态上下文。
 *
 * 用户信息来源是**服务端**（`lib/auth/RequireAuth.tsx` 读取会话后传入），
 * 客户端不重复拉取，避免出现两份真相。
 * 登录/登出后调用 `router.refresh()` 让服务端重新渲染，页面随之切换。
 *
 * 仅在 RequireAuth 内部可用；因此 `user` 必定非空，使用方无需判空。
 */
type AuthContextValue = {
  user: User;
  login: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export default function AuthProvider({
  user,
  children,
}: {
  user: User;
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
      login: () => run(() => authAdapter.login()),
      logout: () => run(() => authAdapter.logout()),
    };
  }, [user, pending, router]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth 只能在 RequireAuth 保护的页面内使用");
  }
  return value;
}
