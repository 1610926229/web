import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  assertCredentialManagementEnabled,
  resetStaffPassword,
} from "@/lib/services/adminCredentials";

/**
 * 管理员重置客服密码：`POST /api/admin/staff/[id]/password`。
 *
 * 请求体只有 `password`。操作者身份来自管理员会话；目标客服由路径段决定。
 * 写入在同一个事务里完成：更新凭据、吊销该客服全部会话、写
 * `staff.reset-password` 审计（before/after 只含更新时间，不含任何密码内容）。
 *
 * 仅在 `DATA_SOURCE=postgres` 时存在；否则 404。
 */
export async function POST(request: Request, context: RouteContext<"/api/admin/staff/[id]/password">) {
  try {
    assertCredentialManagementEnabled();

    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    const result = await resetStaffPassword(admin, id, body.password);
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
