import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";

/**
 * 当前客服端会话：`GET /api/staff/auth/session`。
 *
 * ⚠️ 本接口**自己执行客服鉴权**（`requireStaff()`），不是「返回一下 Cookie 里的 id」：
 * 未登录返回 401，登录了但不是客服（护航、停用、已移除）返回 403，
 * 只有真正的客服才能拿到数据。
 *
 * 返回的是会话 DTO（`id / username / displayName / avatarUrl / role / roleLabel`），
 * **没有 `enabled` / `removedAt` / `lastLoginAt`**，更没有 Cookie、密码或仓储记录整体。
 *
 * ⚠️ 与 `/api/admin/auth/session` 是**两个接口、两套 Cookie**：带上管理端 Cookie
 * 请求这里只会得到 401——本接口只读 `mock_staff_id`，压根不看 `mock_admin_id`。
 *
 * 这个接口不受 `ENABLE_MOCK_STAFF` 单独控制，而是间接由它控制：
 * 开关关闭时 `getSessionStaff()` 一律返回 null，因此这里必然返回 401。
 */
export async function GET() {
  try {
    const staff = await requireStaff();
    return ok(staff);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
