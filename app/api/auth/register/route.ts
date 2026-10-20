import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { assertRealAuthEnabled, registerUserAccount } from "@/lib/services/realUserAuth";

/**
 * 用户注册：`POST /api/auth/register`。
 *
 * 仅在 `DATA_SOURCE=postgres` 时开放；Mock 数据源下返回 404（接口不存在），
 * 不提供一个「看起来注册成功、实际只写进进程内存」的入口。
 *
 * 请求体只读三个字段：`email` / `password` / `nickname`（选填）。
 * 用户 id、展示号、角色、钱包字段**没有可传的位置**——身份与金额都由服务端写。
 *
 * 成功时直接建立会话（与登录写入方式完全相同），返回会话用户 DTO。
 */
export async function POST(request: Request) {
  try {
    assertRealAuthEnabled();

    const body = await readJsonBody(request);
    const user = await registerUserAccount({
      email: body.email,
      password: body.password,
      nickname: body.nickname,
    });

    return ok(user);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
