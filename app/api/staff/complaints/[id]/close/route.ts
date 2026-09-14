import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { closeStaffComplaint } from "@/lib/services/staffComplaints";

/**
 * 关闭投诉：`POST /api/staff/complaints/[id]/close`。
 *
 * ⚠️ 第一件事是 `requireStaff()`：处理人是谁用的是**守卫返回的那一份客服会话**，
 * 不是请求体里的任何字段。
 *
 * ⚠️ **必须填写关闭说明**（`result`），规则在 `normalizeAdminComplaintResult()` 一处。
 * `closed` 是终态，之后不能再改为已处理。关闭说明会展示给提交投诉的用户。
 *
 * ⚠️ **不自动修改订单，也不自动退款**，也**不改写用户提交的内容**：
 * 正文、凭证与联系方式在读写两侧都没有被覆盖的位置。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/complaints/[id]/close">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await closeStaffComplaint(id, staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
