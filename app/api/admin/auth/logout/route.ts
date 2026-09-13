import { fail, ok, toApiError } from "@/lib/api/route";
import { logoutAdmin } from "@/lib/services/adminAuth";

/**
 * 管理端退出登录：`POST /api/admin/auth/logout`。
 *
 * ⚠️ **只删除管理端 Cookie**（`mock_admin_id`），用户端的 `mock_user_id` 一个字都不动：
 * 两者是两个 Cookie、两套会话，退出后台不等于退出用户端，反之亦然。
 *
 * ⚠️ **不要求已登录**：没有会话时也返回成功。要求登录会让「会话已过期想退出」
 * 变成一个报错，而那时本来就无事可做；退出登录是幂等的。
 *
 * 由 `ENABLE_MOCK_ADMIN` 控制，未开启时返回 404——此时本就不存在管理端会话，
 * 没有可登出的对象。
 */
export async function POST() {
  try {
    const result = await logoutAdmin();
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
