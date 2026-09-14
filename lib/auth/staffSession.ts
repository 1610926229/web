import { cookies } from "next/headers";
import { isMockStaffEnabled } from "@/lib/config/env";
import { getStaffRepository } from "@/lib/data/staffRepository";
import type { StaffAccount } from "@/lib/types/staff";

/**
 * 客服端会话（仅服务端使用）。
 *
 * ⚠️ **与用户端、管理端彻底分离**，这是 P8D-1 最关键的一条边界，具体体现在四点上：
 *
 * 1. **不同的 Cookie 名**：用户端是 `mock_user_id`，管理端是 `mock_admin_id`，
 *    客服端是 `mock_staff_id`。三者取值域不相交（`u-*` / `admin-*` / `staff-*`），
 *    因此把普通用户 Cookie 原样拷成客服 Cookie，查客服仓储只会得到 null ——
 *    用户 Cookie 不构成客服权限，反之亦然。
 * 2. **不同的仓储**：用户查 `userRepository`，管理端查 `adminRepository`，
 *    客服查 `staffRepository`。三边不共享数据、不互相查询，
 *    **没有「用 A 换 B」的转换函数**——这是「三类 Cookie 完全隔离」在代码上的落点。
 * 3. **不同的开关**：客服端由 `ENABLE_MOCK_STAFF` 控制，与 `ENABLE_MOCK_AUTH`、
 *    `ENABLE_MOCK_ADMIN` 互不影响。关掉客服开关不影响另外两端。
 * 4. **本文件不被用户端与管理端引用**：`lib/auth/session.ts` 与
 *    `lib/auth/adminSession.ts` 里没有一行 import 到这里。
 *
 * ⚠️ **每次请求都重新查一次账号状态**（`getSessionStaff()` 不缓存、不信任 Cookie 内容）：
 * 「停用后立即失去工作台权限，现有 Cookie 也失效」这条要求靠的就是这一点——
 * 停用操作只改账号记录，不去（也没有地方去）删任何会话表。Cookie 还拿着旧 id，
 * 但下一次请求查到的是一条 `enabled: false` 的记录，于是当场失去权限。
 *
 * ⚠️ Mock 实现：Cookie 里直接存放 Mock 客服账号 id，**没有签名、没有加密、没有凭据**，
 * 仅用于开发阶段跑通登录态。伪造这个 Cookie 只能变成一个「知道某个 id 字符串的人」——
 * 而开关关闭时连 id 都不会被查，这正是本阶段能做到的最强保证。
 *
 * 未来实现：服务端会话表（会话 id 不可反推账号），Cookie 只放会话凭证。
 */

export const MOCK_STAFF_SESSION_COOKIE = "mock_staff_id";

/** 会话有效期，与用户端、管理端保持同一个数量级（7 天）。 */
const STAFF_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Cookie 选项。
 *
 * - `httpOnly`：脚本读不到，XSS 也偷不走会话（§三 明确要求）；
 * - `sameSite: "lax"`：跨站 POST 不带该 Cookie，挡住最基本的 CSRF（§三 明确要求）；
 * - `path: "/"`：客服页面在 `/staff`、客服接口在 `/api/staff`，
 *   两者**不在同一个路径前缀下**，因此作用域只能给 `/`（给 `/staff` 会让接口收不到 Cookie）；
 * - `secure`：**生产环境必须开**（§三 明确要求），本地开发是 http，开了浏览器不会回传该
 *   Cookie，登录会直接失败，因此按 `NODE_ENV` 判断；
 * - 不设 `maxAge` 之外的持久化手段，退出登录时显式删除（见 `clearSessionStaff`）。
 */
function staffCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: STAFF_SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * 取当前客服端会话对应的账号。
 *
 * 返回的是**仓储实体**（含 `enabled` / `removedAt` / `role`），因为调用方需要它们
 * 来判断能不能进工作台；对外下发时一律经过 `toStaffSessionUser()` 挑字段。
 *
 * 未开启 `ENABLE_MOCK_STAFF` 时一律返回 null：开关关闭后，伪造 Cookie 也没有意义。
 * 注意这里**不判断** `enabled` / `removedAt` / `role`——那是服务层的事
 * （`lib/services/staffAuth.ts`），本文件只回答「Cookie 指向哪条记录」。
 */
export async function getSessionStaff(): Promise<StaffAccount | null> {
  // 无论开关如何都先读一次 Cookie：客服页面必须按请求渲染，
  // 不能在构建期被预渲染成一份「未登录」的静态页面。
  const jar = await cookies();

  if (!isMockStaffEnabled()) return null;

  const staffId = jar.get(MOCK_STAFF_SESSION_COOKIE)?.value;
  if (!staffId) return null;

  return getStaffRepository().findStaffById(staffId);
}

export async function setSessionStaff(staffId: string): Promise<void> {
  const jar = await cookies();
  jar.set(MOCK_STAFF_SESSION_COOKIE, staffId, staffCookieOptions());
}

export async function clearSessionStaff(): Promise<void> {
  const jar = await cookies();
  // 按同样的作用域删除：path 不一致会删不掉，Cookie 会一直留着
  jar.set(MOCK_STAFF_SESSION_COOKIE, "", { ...staffCookieOptions(), maxAge: 0 });
}
