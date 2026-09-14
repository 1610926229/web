import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { resolveStaffComplaint } from "@/lib/services/staffComplaints";

/**
 * 解决投诉：`POST /api/staff/complaints/[id]/resolve`。
 *
 * ⚠️ 第一件事是 `requireStaff()`：处理人是谁用的是**守卫返回的那一份客服会话**，
 * 不是请求体里的任何字段（请求体里没有 `actorId` / `actorRole` / `actorName`）。
 *
 * ⚠️ **必须填写处理结果**（`result`），规则在 `normalizeAdminComplaintResult()` 一处。
 * 处理结果会同步展示给提交投诉的用户，因此它同时是「给用户的答复」，不是内部备注。
 *
 * ⚠️ **不自动修改订单，也不自动退款**：解决一条投诉不会让任何一笔钱动起来，
 * 用户要退款仍然要走退款申请那一套。
 *
 * ⚠️ **不改写用户提交的内容**：正文、凭证与联系方式在读写两侧都没有被覆盖的位置。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/complaints/[id]/resolve">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await resolveStaffComplaint(id, staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
