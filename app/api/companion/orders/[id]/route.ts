import { ApiError } from "@/lib/api/ApiError";
import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { COMPANION_ORDER_NOT_FOUND_MESSAGE } from "@/lib/constants/dispatch";
import { getCompanionOrderDetail } from "@/lib/services/companionOrders";

/**
 * 打手订单详情。
 *
 * 权限：`requireCompanion()`，**第一个动作**。
 *
 * ## 非本人实际履约走 404，不泄露存在性
 *
 * 归属（`Order.actualCompanionId === 当前 companionId`）由服务层**重新校验**，
 * 不是「列表里没有就看不到」——接口可以被直接请求。订单不存在、或者存在但不是他接的单，
 * 对外表现完全一致：同一个 404、同一句话（`COMPANION_ORDER_NOT_FOUND_MESSAGE`）。
 * 因此不能拿别人的订单 id 试探它是否存在（api-contract §2.9）。
 *
 * ## DTO 在这里不裁剪
 *
 * 服务的 `getCompanionOrderDetail()` 返回的就是对外形态（`CompanionOrderDetail`）：
 * 接口只做「null → 404」这一件事，不做字段挑选——字段选择散在接口里，
 * 迟早有一处会顺手多带一个内部字段出去。
 *
 * 本文件只有 GET。
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/companion/orders/[id]">,
) {
  try {
    const companion = await requireCompanion();
    const { id } = await context.params;

    const detail = await getCompanionOrderDetail(companion.companionId, id);
    if (!detail) throw new ApiError("NOT_FOUND", COMPANION_ORDER_NOT_FOUND_MESSAGE, 404);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
