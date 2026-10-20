import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { isRealAuthEnabled } from "@/lib/auth/realSession";
import { beginPublicLogin } from "@/lib/auth/publicLoginGuard";
import {
  ADMIN_REAL_LOGIN_DISABLED_MESSAGE,
  loginAdminWithPassword,
} from "@/lib/services/adminAuth";

/**
 * 管理员密码登录：`POST /api/admin/auth/login`。
 *
 * 请求体只有 `username` 与 `password`。角色、账号 id、启用状态**没有可传的位置**。
 * 仅在 `DATA_SOURCE=postgres` 时存在；Mock 数据源下返回 404。
 *
 * 保留 `/api/admin/auth/mock-login` 只作为**私有 staging 的首次凭据引导**：
 * Mock 开关由环境变量控制，正式环境不开启时该接口同样是 404。
 */
export async function POST(request: Request) {
  try {
    if (!isRealAuthEnabled()) {
      throw new ApiError("NOT_FOUND", ADMIN_REAL_LOGIN_DISABLED_MESSAGE, 404);
    }

    const body = await readJsonBody(request);
    const username = typeof body.username === "string" ? body.username : "";
    const guard = await beginPublicLogin("admin", username);

    try {
      const admin = await loginAdminWithPassword(body.username, body.password);
      guard.succeeded();
      return ok({ admin });
    } catch (cause) {
      guard.failed(cause);
      throw cause;
    }
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
