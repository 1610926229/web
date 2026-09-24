import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { rejectStaffCompletion } from "@/lib/services/staffCompletions";

/**
 * 客服驳回完成材料：`POST /api/staff/completions/[id]/reject`。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ⚠️ 请求体只读**驳回原因**（`reviewNote`）。操作者不在这里：客服身份来自守卫
 * 返回的会话。驳回原因**必填**，规则复用 `normalizeAdminReviewNote`
 * （与入驻审核、管理端退款同一份）。
 *
 * ## 驳回不动订单
 *
 * 只改完成材料（`pending → rejected`），订单继续 `serving`，打手可重新提交。
 * 判定与写入都在 `rejectCompletion` 的原子区段里，本接口不做判定。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/completions/[id]/reject">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await rejectStaffCompletion(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
