import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_COMPLAINT_NOT_FOUND_MESSAGE } from "@/lib/constants/staffComplaints";
import { getStaffComplaintDetail } from "@/lib/services/staffComplaints";

/**
 * 客服工作台投诉详情：`GET /api/staff/complaints/[id]`。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * 详情在列表项之上补齐正文、凭证、联系方式、处理信息、关联订单摘要、
 * 进度时间轴、**服务端判定的** `allowedActions`，以及关联订单的会话入口
 * `conversationOrderId`（§八：只查不建会话）。
 *
 * ⚠️ **正文、凭证与联系方式是用户提交的原始材料，只读**：本组路由没有任何写它们的接口，
 * 页面也不提供编辑入口。处理结果写在独立的结果栏里，与用户提交的内容各占一处。
 *
 * 投诉不存在返回 404。
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/staff/complaints/[id]">,
) {
  try {
    await requireStaff();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getStaffComplaintDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", STAFF_COMPLAINT_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
