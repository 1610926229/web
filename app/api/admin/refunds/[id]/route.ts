import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { ADMIN_REFUND_NOT_FOUND_MESSAGE } from "@/lib/constants/adminRefunds";
import { getAdminRefundDetail } from "@/lib/services/adminRefunds";

/**
 * 管理端退款详情：`GET /api/admin/refunds/[id]`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 详情在列表项之上补齐原因、说明、凭证、审核信息（审核人 / 意见 / 时间）、
 * 进度时间轴与**服务端判定的** `allowedActions`。页面据此渲染按钮，
 * 不拿状态自己写 `if`。
 *
 * 退款申请不存在返回 404。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/refunds/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminRefundDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_REFUND_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
