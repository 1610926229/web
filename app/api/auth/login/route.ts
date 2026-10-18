import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { assertRealAuthEnabled, loginUserWithPassword } from "@/lib/services/realUserAuth";

/**
 * 用户登录：`POST /api/auth/login`（邮箱 + 密码）。
 *
 * 仅在 `DATA_SOURCE=postgres` 时开放；Mock 数据源下返回 404。
 *
 * 所有凭据失败返回同一句话、同一个 401——不区分「邮箱不存在」与「密码错误」，
 * 也不因为格式差异提前给出不同提示。账号不存在时同样跑一次等成本的密码派生。
 *
 * 成功时写入 `chaoge_user_session`（HttpOnly、SameSite=Lax、生产环境 Secure），
 * 并清掉同一身份的 Mock Cookie。返回会话用户 DTO。
 */
export async function POST(request: Request) {
  try {
    assertRealAuthEnabled();

    const body = await readJsonBody(request);
    const user = await loginUserWithPassword(body.email, body.password);

    return ok(user);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
