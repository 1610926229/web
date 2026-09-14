import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { rejectStaffRefund } from "@/lib/services/staffRefunds";

/**
 * 客服驳回退款：`POST /api/staff/refunds/[id]/reject`。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ⚠️ 请求体只读**幂等键 + 审核意见**。操作者（actorId / actorRole / actorName）
 * 不在这里：客服身份来自守卫返回的会话。审核意见**必填**，规则复用
 * `normalizeAdminReviewNote`（与入驻审核、管理端退款同一份）。
 *
 * ⚠️ 只改退款申请（`pending | reviewing → rejected`），订单状态、金额与消费统计都不变。
 * 这里**没有通过**：通过涉及资金最终划拨，只在管理员侧。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/staff/refunds/[id]">) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await rejectStaffRefund(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
