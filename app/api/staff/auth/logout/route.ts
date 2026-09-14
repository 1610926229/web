import { fail, ok, toApiError } from "@/lib/api/route";
import { logoutStaff } from "@/lib/services/staffAuth";

/**
 * 客服端退出登录：`POST /api/staff/auth/logout`。
 *
 * ⚠️ **只删除客服端 Cookie**（`mock_staff_id`），用户端的 `mock_user_id` 与管理端的
 * `mock_admin_id` 一个字都不动：三者是三个 Cookie、三套会话，退出客服工作台
 * 不等于退出用户端，也不等于退出后台。
 *
 * ⚠️ **不要求已登录**：没有会话时也返回成功。要求登录会让「会话已过期想退出」
 * 变成一个报错，而那时本来就无事可做；退出登录是幂等的。
 *
 * 由 `ENABLE_MOCK_STAFF` 控制，未开启时返回 404——此时本就不存在客服端会话，
 * 没有可登出的对象。
 */
export async function POST() {
  try {
    const result = await logoutStaff();
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
