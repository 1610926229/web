import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { closeAdminComplaint } from "@/lib/services/adminComplaints";

/**
 * 关闭投诉：`POST /api/admin/complaints/[id]/close`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **关闭说明必填**（`result`），且与「解决」共用同一个字段但**文案不同**：
 * 对客服说「请填写处理结果」与「请填写关闭说明」是两件事，
 * 前者是「你怎么处理的」，后者是「为什么关掉」。
 *
 * ⚠️ **`closed` 是终态**，关闭之后不能再改为已处理。
 *
 * ⚠️ **不自动修改订单，也不自动退款**；也不改写用户提交的正文、凭证与联系方式。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/complaints/[id]/close">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await closeAdminComplaint(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
