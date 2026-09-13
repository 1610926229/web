import { ADMIN_FORBIDDEN_MESSAGE, ADMIN_UNAUTHORIZED_MESSAGE } from "@/lib/constants/admin";
import { getAdminSessionState } from "@/lib/services/adminAuth";
import type { AdminSessionUser } from "@/lib/types/admin";
import { ApiError } from "./ApiError";

/**
 * 管理接口的鉴权守卫（仅服务端使用）。
 *
 * 与 `lib/api/route.ts` 的 `requireUser()` **并列而不是复用**：两者读的是不同的
 * Cookie、不同的仓储、不同的开关，混成一个 `requireUser({ admin: true })` 之类的
 * 参数化函数，迟早会出现「传错参数就当成管理员放行」这种最难查的问题。
 *
 * ⚠️ **每一个管理接口都必须自己调用本函数**。页面上的隐藏按钮、侧栏里的
 * 禁用项都不构成保护——接口是可以被直接请求的，权限只能在服务端、在每个接口里判。
 *
 * 两种拒绝分开表达，因为调用方的处置不同：
 * - 未登录 / 会话失效 → 401 `UNAUTHORIZED`（去登录）；
 * - 已登录但没有管理权限（客服、护航、停用账号）→ 403 `FORBIDDEN`（换账号也没用）。
 *
 * 两种情形给的是**同一套文案体系、不含具体原因的提示**：区分「你不是管理员」
 * 与「你的账号被停用了」，等于给出一个可以探测账号状态的接口。
 */
export async function requireAdmin(): Promise<AdminSessionUser> {
  const state = await getAdminSessionState();

  if (state.kind === "forbidden") {
    throw new ApiError("FORBIDDEN", ADMIN_FORBIDDEN_MESSAGE, 403);
  }
  if (state.kind === "anonymous") {
    throw new ApiError("UNAUTHORIZED", ADMIN_UNAUTHORIZED_MESSAGE, 401);
  }

  return state.admin;
}
