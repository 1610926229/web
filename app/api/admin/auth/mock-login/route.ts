import { fail, ok, toApiError } from "@/lib/api/route";
import { loginMockAdmin } from "@/lib/services/adminAuth";

/**
 * 模拟管理员登录：`POST /api/admin/auth/mock-login`。
 *
 * ⚠️ **不调用任何真实接口，也没有密码**：写入的是一个固定的 Mock 管理端账号 id。
 * 真实管理员账号与密码属于后续阶段。
 *
 * ⚠️ **不接收任何请求体**。登录对象由服务端固定（`MOCK_ADMIN_LOGIN_ID`），
 * 因此不存在「提交 `{"role":"admin"}` 就能变成管理员」这条路——
 * 不是「校验了角色字段」，而是根本没有读取它的位置。
 * 页面同样只有一个固定的「模拟管理员登录」按钮，没有账号切换器。
 *
 * 由 `ENABLE_MOCK_ADMIN` 控制，未开启时返回 **404**（接口不存在），
 * 与用户端 `ENABLE_MOCK_AUTH` 关闭时的行为一致，且两个开关互不影响。
 */
export async function POST() {
  try {
    const admin = await loginMockAdmin();
    return ok({ admin });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
