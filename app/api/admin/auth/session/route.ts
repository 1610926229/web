import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";

/**
 * 当前管理端会话：`GET /api/admin/auth/session`。
 *
 * ⚠️ 本接口**自己执行管理者鉴权**（`requireAdmin()`），不是「返回一下 Cookie 里的 id」：
 * 未登录返回 401，登录了但不是管理员返回 403，只有真正的 admin 才能拿到数据。
 *
 * 返回的是会话 DTO（`id / username / displayName / role / roleLabel`），
 * **没有密码、没有密钥、没有仓储记录整体**——`enabled` 与 `lastLoginAt` 不外泄。
 *
 * 这个接口不受 `ENABLE_MOCK_ADMIN` 单独控制，而是间接由它控制：
 * 开关关闭时 `getSessionAdmin()` 一律返回 null，因此这里必然返回 401。
 * 「接口存在但谁都不放行」比「接口 404」更贴近真实系统将来的样子
 * （正式环境里这个接口是要存在的，只是没有会话而已）。
 */
export async function GET() {
  try {
    const admin = await requireAdmin();
    return ok(admin);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
