import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { assertMockStaffEnabled, loginMockStaff } from "@/lib/services/staffAuth";

/**
 * 模拟客服登录：`POST /api/staff/auth/mock-login`。
 *
 * ⚠️ **不调用任何真实接口，也没有密码 / 验证码**：请求体里唯一的输入是
 * `{ staffId }`，它**不是身份来源**——服务端拿它去客服仓储查账号，
 * 查到的记录才决定这个人能不能登录（启用 + 未移除 + 角色是客服）。
 * 因此提交一个别的 id 只会得到「查不到」或「这个账号不能登录」，
 * 不会得到「以这个身份登录」。
 *
 * 这个入口**只存在于客服端**：用户前台没有任何账号切换控件，
 * 会话写进的是**第三个独立 Cookie**（`mock_staff_id`），
 * 不复用 `mock_user_id`，也不复用 `mock_admin_id`。
 *
 * 由 `ENABLE_MOCK_STAFF` 控制，未开启时返回 **404**（接口不存在），
 * 与用户端、管理端两个开关互不影响。
 *
 * ⚠️ 过闸必须在 `readJsonBody()` **之前**：读体会先校验请求体格式，
 * 让「开关关闭」退回成 400 会把这个接口的存在本身说出去。
 */
export async function POST(request: Request) {
  try {
    assertMockStaffEnabled();

    const body = await readJsonBody(request);
    const staffId = typeof body.staffId === "string" ? body.staffId : "";

    const staff = await loginMockStaff(staffId);
    return ok({ staff });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
