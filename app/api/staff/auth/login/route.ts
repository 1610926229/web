import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { isRealAuthEnabled } from "@/lib/auth/realSession";
import {
  STAFF_REAL_LOGIN_DISABLED_MESSAGE,
  loginStaffWithPassword,
} from "@/lib/services/staffAuth";

/**
 * 客服密码登录：`POST /api/staff/auth/login`。
 *
 * 请求体只有 `username` 与 `password`。角色、账号 id、启用状态**没有可传的位置**——
 * 服务端按登录名查凭据、按 id 查账号，再按账号记录判断能不能进工作台。
 *
 * 仅在 `DATA_SOURCE=postgres` 时存在；Mock 数据源下返回 404。
 * 过闸在读请求体**之前**：开关关闭时这个接口应当表现为不存在，
 * 而不是先报一个「请求体格式无效」。
 */
export async function POST(request: Request) {
  try {
    if (!isRealAuthEnabled()) {
      throw new ApiError("NOT_FOUND", STAFF_REAL_LOGIN_DISABLED_MESSAGE, 404);
    }

    const body = await readJsonBody(request);
    const staff = await loginStaffWithPassword(body.username, body.password);

    return ok({ staff });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
