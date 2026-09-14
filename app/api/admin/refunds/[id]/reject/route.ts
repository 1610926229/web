import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { rejectAdminRefund } from "@/lib/services/adminRefunds";

/**
 * 审核拒绝退款：`POST /api/admin/refunds/[id]/reject`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **必须填写审核意见**（`reviewNote`），规则在 `lib/constants/adminApplications.ts`
 * 的 `normalizeAdminReviewNote()`（与入驻审核共用一份）。审核意见会展示给申请人，
 * 因此它不是内部备注。
 *
 * ⚠️ **不改订单状态，也不改任何消费金额**：用户看到的订单继续按原进度走，
 * 累计有效消费不受影响。这正是「退款状态与订单状态是两条独立的线」在拒绝路径上的体现。
 *
 * 请求体只读幂等键与审核意见：状态、审核人、审核时间都不从请求体读。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/refunds/[id]/reject">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await rejectAdminRefund(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
