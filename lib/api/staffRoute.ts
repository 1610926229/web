import { STAFF_FORBIDDEN_MESSAGE, STAFF_UNAUTHORIZED_MESSAGE } from "@/lib/constants/staff";
import { getStaffSessionState } from "@/lib/services/staffAuth";
import type { StaffSessionUser } from "@/lib/types/staff";
import { ApiError } from "./ApiError";

/**
 * 客服接口的鉴权守卫（仅服务端使用）。
 *
 * 与 `lib/api/route.ts` 的 `requireUser()`、`lib/api/adminRoute.ts` 的 `requireAdmin()`
 * **并列而不是复用**：三者读的是不同的 Cookie、不同的仓储、不同的开关，
 * 混成一个 `requireUser({ staff: true })` 之类的参数化函数，
 * 迟早会出现「传错参数就当成客服放行」这种最难查的问题。
 *
 * ⚠️ **每一个客服接口都必须自己调用本函数，而且必须是第一步**（§六 明确要求）。
 * 页面上的隐藏区、侧栏里的禁用项都不构成保护——接口是可以被直接请求的，
 * 权限只能在服务端、在每个接口里判。
 *
 * ## 身份矩阵（§七）在本函数里的落点
 *
 * | 带来的 Cookie | 结果 | 为什么 |
 * | --- | --- | --- |
 * | 什么都没有 | 401 | 未登录 |
 * | `mock_user_id`（普通用户） | 401 | 客服会话只读 `mock_staff_id`，用户 Cookie 根本不被读 |
 * | `mock_admin_id`（管理员） | 401 | 同上。管理员当前**不通过客服接口读消息**（§七） |
 * | `mock_staff_id` 指向护航账号 | 403 | 记录查得到，但角色进不了工作台 |
 * | `mock_staff_id` 指向停用 / 已移除账号 | 403 | 记录查得到，但账号不能再用 |
 * | `mock_staff_id` 指向启用中的客服 | 通过 | —— |
 *
 * 前两行「用户 / 管理 Cookie 得到 401」不是靠额外判断实现的，而是因为
 * `getSessionStaff()` 只读客服自己的 Cookie：**别的身份压根不在取值范围内**。
 * 这比「读到了再判断它是哪一类」可靠得多——后者每加一类身份就要多改一处。
 *
 * ⚠️ 停用 / 移除后旧 Cookie **立即失效**，靠的是本函数**每次请求都重新查一遍账号**
 * （见 `lib/services/staffAuth.ts`）。守卫里不缓存、不信任 Cookie 里的任何内容。
 *
 * 两种拒绝分开表达，因为调用方的处置不同：
 * - 没登录 / 会话失效 → 401 `UNAUTHORIZED`（去登录页）；
 * - 登录了但不能进工作台（护航、停用、已移除）→ 403 `FORBIDDEN`（换账号也没用）。
 *
 * 两种情形给的是**同一套文案体系、不含具体原因的提示**：区分「你不是客服」
 * 与「你的账号被停用了」，等于给出一个可以探测账号状态的接口。
 */
export async function requireStaff(): Promise<StaffSessionUser> {
  const state = await getStaffSessionState();

  if (state.kind === "forbidden") {
    throw new ApiError("FORBIDDEN", STAFF_FORBIDDEN_MESSAGE, 403);
  }
  if (state.kind === "anonymous") {
    throw new ApiError("UNAUTHORIZED", STAFF_UNAUTHORIZED_MESSAGE, 401);
  }

  return state.staff;
}
