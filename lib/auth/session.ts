import { cache } from "react";
import { cookies } from "next/headers";
import { isMockAuthEnabled } from "@/lib/config/env";
import { getDataSource } from "@/lib/data/source";
import type { User } from "@/lib/types/user";
import { MOCK_USER_SESSION_COOKIE } from "./cookieNames";
import { lookupRealSession } from "./realSession";
import { isPublicPreviewRequest } from "./publicPreviewRequest";

/**
 * 服务端会话（仅服务端使用）。
 *
 * ⚠️ 两套实现并存（PROD-4）：
 *
 * 1. **真实会话**（`DATA_SOURCE=postgres`）：`chaoge_user_session` 里是不透明令牌，
 *    数据库 `auth_sessions` 只存 SHA-256，每次请求回 `users` 复核账号是否还在。
 *    由 `./realSession.ts` 实现，登录 / 注册 / 退出接口负责写入与吊销；
 * 2. **Mock 会话**：Cookie 里直接存放 Mock 用户 id，没有签名与凭据，由
 *    `ENABLE_MOCK_AUTH` 控制。它只在**没有真实 Cookie** 时生效。
 *
 * 解析顺序见 `./realSession.ts` 文件头：真实会话优先，失效的真实会话按匿名处理。
 */

export const MOCK_SESSION_COOKIE = MOCK_USER_SESSION_COOKIE;

/**
 * 当前登录用户；未登录（或未开启 Mock 登录）为 null。
 *
 * ⚠️ 用 `React.cache` 包起来：一次请求内读到的会话**只有一份**。
 * 守卫（`RequireAuth`）读一次决定「渲染登录控件还是页面」，页面自己再读一次拿 `userId`
 * 去取数——两次调用之间隔着一个 `await`，用户记录若在中途变化，两边说的就不是同一个人。
 * 同一个请求内共享一份结果，这个窗口就不存在（见 `lib/services/companionAccess.ts` 里更长的说明）。
 *
 * ⚠️ 写入会话的 `setSessionUser` / `clearSessionUser` **不在这里**，也不受缓存影响：
 * 它们只在登录 / 退出接口里被调用，那两条路径读的是 Cookie 而不是这个函数。
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<User | null> {
  // 无论开关如何都先读一次 Cookie：受保护路由必须按请求渲染，
  // 不能在构建期被预渲染成「未登录」的静态页面。
  const jar = await cookies();

  // PROD-4：真实会话优先。带着一个**失效**的真实 Cookie 时直接按匿名处理，
  // 不回退 Mock——否则退出登录后陈旧的 Mock Cookie 会变出另一个人。
  const real = await lookupRealSession("user");
  if (real.kind === "active") return getDataSource().findUserById(real.subjectId);
  if (real.kind === "invalid") return null;

  if (!isMockAuthEnabled()) return null;

  // PROD-6：公网请求永不接受 Mock 身份 Cookie。Mock 开关在 Staging 上默认开启，
  // 而公网登录 / 工作台路径会保留 Cookie——不挡住这一步，任何人手工写一个
  // `mock_user_id` 就能在公网上变成任意演示账号。真实会话在上面已经返回。
  if (await isPublicPreviewRequest()) return null;

  const userId = jar.get(MOCK_SESSION_COOKIE)?.value;
  if (!userId) return null;

  return getDataSource().findUserById(userId);
});

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
