import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { assignStaffOrderCompanion } from "@/lib/services/staffOrderActions";

/**
 * 客服给**还没有人接**的订单指派护航：`POST /api/staff/orders/[id]/assign`（PROD-4）。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ⚠️ 请求体只读**要指派的护航**（`companionId`）。操作者与审计身份来自客服会话，
 * 请求体里没有 position 可以声明「是谁做的」。
 *
 * ⚠️ 指派**不能绕过派单规则**：用户指定护航的专属期内只能指派给那位；
 * 等待时限已过的订单走超时流程，接口回 400。
 *
 * ⚠️ 本接口**不写接单事件**、不做金额联动：指派不计入接单榜，不退款、不改订单金额。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/orders/[id]/assign">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await assignStaffOrderCompanion(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
