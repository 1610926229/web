import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  assertCredentialManagementEnabled,
  setOwnAdminPassword,
} from "@/lib/services/adminCredentials";

/**
 * 管理员设置 / 修改**本人**密码：`POST /api/admin/auth/password`。
 *
 * 两种用途：
 * 1. **首次引导**（staging）：通过私有 Mock 管理员会话进入，还没有凭据行，
 *    直接设置新密码；
 * 2. **日常修改**：已有密码时必须带 `currentPassword`。
 *
 * 请求体只有 `currentPassword`（首次设置可空）与 `newPassword`。
 * `adminId` 来自会话，请求体里没有位置——因此这个接口无法替别人改密码。
 *
 * 修改成功会吊销该管理员的全部会话（含当前这个），响应里的
 * `reLoginRequired: true` 就是让客户端回登录页的信号。
 *
 * 仅在 `DATA_SOURCE=postgres` 时存在；否则 404。
 */
export async function POST(request: Request) {
  try {
    assertCredentialManagementEnabled();

    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    const result = await setOwnAdminPassword(admin, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
