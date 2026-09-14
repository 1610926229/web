import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { resolveAdminComplaint } from "@/lib/services/adminComplaints";

/**
 * 解决投诉：`POST /api/admin/complaints/[id]/resolve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **必须填写处理结果**（`result`），规则在 `normalizeAdminComplaintResult()` 一处。
 * 处理结果会同步展示给提交投诉的用户，因此它同时是「给用户的答复」，不是内部备注。
 *
 * ⚠️ **不自动修改订单，也不自动退款**：解决一条投诉不会让任何一笔钱动起来，
 * 用户要退款仍然要走退款申请那一套。
 *
 * ⚠️ **不改写用户提交的内容**：正文、凭证与联系方式在读写两侧都没有被覆盖的位置。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/complaints/[id]/resolve">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await resolveAdminComplaint(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
