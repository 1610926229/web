import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_REFUND_NOT_FOUND_MESSAGE } from "@/lib/constants/staffRefunds";
import { getStaffRefundDetail } from "@/lib/services/staffRefunds";

/**
 * 客服工作台退款详情：`GET /api/staff/refunds/[id]`。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ 不存在（或它的订单不可读）返回 404，页面 `notFound()`。
 *
 * ⚠️ 详情 DTO 带上服务端判定的 `allowedActions`（只有开始审核与驳回，**没有通过**），
 * 以及关联会话入口 `conversationOrderId`——没有沟通记录时为 null，页面就不给链接。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/staff/refunds/[id]">) {
  try {
    // 与列表接口同理：退款详情是平台口径的，不需要「我是谁」，
    // 但守卫一步都不能省——它挡的是「谁可以读」。
    await requireStaff();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getStaffRefundDetail(id ?? "", searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", STAFF_REFUND_NOT_FOUND_MESSAGE);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
