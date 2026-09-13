import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { ADMIN_APPLICATION_NOT_FOUND_MESSAGE } from "@/lib/constants/adminApplications";
import { getAdminApplicationDetail } from "@/lib/services/adminCompanionApplications";

/**
 * 管理端入驻申请详情：`GET /api/admin/companion-applications/[id]`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 详情比列表多出正文、联系方式、凭证、审核意见与**允许的操作**。
 * 后者尤其重要：`allowedActions` 由服务端按状态机算出来（`ADMIN_APPLICATION_TRANSITIONS`），
 * 界面拿它决定按钮的显示与禁用，**不自己判断状态**——否则状态机就有了第二份实现，
 * 两处迟早不一致，而不一致的那一处往往是界面比服务端宽松。
 *
 * 申请不存在返回 404。这里与「存在但你没权限」不可能混淆：权限在上一步已经判完了，
 * 走到这里的人一定是管理员。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/companion-applications/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminApplicationDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_APPLICATION_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
