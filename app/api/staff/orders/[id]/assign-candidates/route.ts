import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { listStaffOrderAssignCandidates } from "@/lib/services/staffOrderActions";

/**
 * 指派候选名单：`GET /api/staff/orders/[id]/assign-candidates`（PROD-4）。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ **资格过滤在服务端**：名单里出现的每一位护航都是「指派一定会成功」的
 * （`enabled`、未移除、当前可接单、不是下单用户本人）。用户指定护航的专属期内，
 * 名单里只有那位——客服不能覆盖用户在下单时的选择。
 *
 * ⚠️ 这一单不是「已支付、还没有人接」时返回 **400**（与指派接口同一句文案），
 * 而不是空名单：「没有可指派的人」与「这一单不该有指派按钮」对客服的下一步完全不同。
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/staff/orders/[id]/assign-candidates">,
) {
  try {
    await requireStaff();
    const { id } = await context.params;

    return ok(await listStaffOrderAssignCandidates(id ?? ""));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
