import { cookies } from "next/headers";
import { isMockAdminEnabled } from "@/lib/config/env";
import { getAdminRepository } from "@/lib/data/adminRepository";
import type { AdminAccount } from "@/lib/types/admin";

/**
 * 管理端会话（仅服务端使用）。
 *
 * ⚠️ **与用户端会话彻底分离**，这是本阶段最关键的一条边界，具体体现在四点上：
 *
 * 1. **不同的 Cookie 名**：用户端是 `mock_user_id`，管理端是 `mock_admin_id`。
 *    两者取值域不相交（一边是 `u-*`，一边是 `admin-*`），因此就算把用户 Cookie
 *    原样拷成管理 Cookie，查管理仓储也只会得到 null —— 用户 Cookie 不构成管理权限。
 * 2. **不同的仓储**：用户查 `userRepository`，管理端查 `adminRepository`，
 *    两边不共享数据、不互相查询，没有「用 A 换 B」的转换函数。
 * 3. **不同的开关**：管理端由 `ENABLE_MOCK_ADMIN` 控制，与 `ENABLE_MOCK_AUTH` 互不影响。
 *    关掉管理端开关不会影响用户端登录，反之亦然。
 * 4. **本文件不被用户端引用**：`lib/auth/session.ts` 里没有一行 import 到这里。
 *    用户端拿不到管理者实体，也就拿不到角色信息。
 *
 * ⚠️ Mock 实现：Cookie 里直接存放 Mock 管理端账号 id，**没有签名、没有加密、没有凭据**，
 * 仅用于开发阶段跑通登录态。伪造这个 Cookie 只能变成一个「知道某个 id 字符串的人」——
 * 而开关关闭时连 id 都不会被查，这正是本阶段能做到的最强保证。
 *
 * 未来实现：服务端会话表（会话 id 不可反推账号），Cookie 只放会话凭证。
 */

export const MOCK_ADMIN_SESSION_COOKIE = "mock_admin_id";

/** 会话有效期，与用户端保持同一个数量级（7 天）。 */
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Cookie 选项。
 *
 * - `httpOnly`：脚本读不到，XSS 也偷不走会话；
 * - `sameSite: "lax"`：跨站 POST 不带该 Cookie，挡住最基本的 CSRF；
 * - `path: "/"`：管理页面在 `/admin`、管理接口在 `/api/admin`，
 *   两者**不在同一个路径前缀下**，因此作用域只能给 `/`（给 `/admin` 会让接口收不到 Cookie，
 *   那才是真正的问题）；
 * - `secure`：**生产环境必须开**，本地开发是 http，开了浏览器不会回传该 Cookie，
 *   登录会直接失败，因此按 `NODE_ENV` 判断；
 * - 不设 `maxAge` 之外的持久化手段，退出登录时显式删除（见 `clearSessionAdmin`），
 *   退出后 Cookie 立即失效。
 */
function adminCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * 取当前管理端会话对应的账号。
 *
 * 返回的是**仓储实体**（含 `enabled`），因为调用方需要它来判断停用；
 * 对外下发时一律经过 `toAdminSessionUser()` 挑字段。
 *
 * 未开启 `ENABLE_MOCK_ADMIN` 时一律返回 null：开关关闭后，伪造 Cookie 也没有意义。
 */
export async function getSessionAdmin(): Promise<AdminAccount | null> {
  // 无论开关如何都先读一次 Cookie：管理页面必须按请求渲染，
  // 不能在构建期被预渲染成一份「未登录」的静态页面。
  const jar = await cookies();

  if (!isMockAdminEnabled()) return null;

  const adminId = jar.get(MOCK_ADMIN_SESSION_COOKIE)?.value;
  if (!adminId) return null;

  return getAdminRepository().findAdminById(adminId);
}

export async function setSessionAdmin(adminId: string): Promise<void> {
  const jar = await cookies();
  jar.set(MOCK_ADMIN_SESSION_COOKIE, adminId, adminCookieOptions());
}

export async function clearSessionAdmin(): Promise<void> {
  const jar = await cookies();
  // 按同样的作用域删除：path 不一致会删不掉，Cookie 会一直留着
  jar.set(MOCK_ADMIN_SESSION_COOKIE, "", { ...adminCookieOptions(), maxAge: 0 });
}
