import { cookies } from "next/headers";
import { isMockAuthEnabled } from "@/lib/config/env";
import { getDataSource } from "@/lib/data/source";
import type { User } from "@/lib/types/user";

/**
 * 服务端会话（仅服务端使用）。
 *
 * ⚠️ Mock 实现：Cookie 里直接存放 Mock 用户 id，**没有签名、没有加密、没有凭据**，
 * 仅用于开发阶段跑通登录态。整个机制由 `ENABLE_MOCK_AUTH` 控制，未开启时
 * Cookie 不会产生任何登录身份。
 *
 * 未来实现：换为服务端会话（或签名 Cookie）保存用户在库中的会话标识，
 * 微信 openid 只在服务端保存，下发给浏览器的只是不可反推的会话凭证。
 */

export const MOCK_SESSION_COOKIE = "mock_user_id";

export async function getSessionUser(): Promise<User | null> {
  // 无论开关如何都先读一次 Cookie：受保护路由必须按请求渲染，
  // 不能在构建期被预渲染成「未登录」的静态页面。
  const jar = await cookies();

  if (!isMockAuthEnabled()) return null;

  const userId = jar.get(MOCK_SESSION_COOKIE)?.value;
  if (!userId) return null;

  return getDataSource().findUserById(userId);
}

export async function setSessionUser(userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(MOCK_SESSION_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionUser(): Promise<void> {
  const jar = await cookies();
  jar.delete(MOCK_SESSION_COOKIE);
}
