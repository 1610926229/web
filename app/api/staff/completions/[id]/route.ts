import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_COMPLETION_NOT_FOUND_MESSAGE } from "@/lib/constants/staffCompletions";
import { getStaffCompletionDetail } from "@/lib/services/staffCompletions";

/**
 * 客服工作台完成材料详情：`GET /api/staff/completions/[id]`。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ 不存在（或它的订单不可读）返回 404，页面 `notFound()`。
 *
 * ⚠️ 详情 DTO 带上服务端判定的 `allowedActions`（通过 / 驳回），
 * 以及凭证、审核信息与订单现状。字段表见 `StaffCompletionDetail`。
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/staff/completions/[id]">,
) {
  try {
    // 与列表接口同理：完成材料详情是平台口径的，不需要「我是谁」，
    // 但守卫一步都不能省——它挡的是「谁可以读」。
    await requireStaff();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getStaffCompletionDetail(id ?? "", searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", STAFF_COMPLETION_NOT_FOUND_MESSAGE);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
