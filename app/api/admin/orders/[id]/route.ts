import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { ADMIN_ORDER_NOT_FOUND_MESSAGE } from "@/lib/constants/adminOrders";
import { getAdminOrderDetail } from "@/lib/services/adminOrders";

/**
 * 管理端订单详情：`GET /api/admin/orders/[id]`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 详情在列表项之上补齐游戏、大区、游戏账号、备注、金额明细、状态时间轴、
 * 护航摘要与四份售后摘要。**本阶段是只读的**：这一组路由里只有 GET，
 * 没有第二个方法——订单不会被后台随手改状态或改金额，
 * 唯一会写订单的是退款审核通过（`/api/admin/refunds/[id]/approve`）。
 *
 * 订单不存在返回 404。
 */
export async function GET(request: Request, context: RouteContext<"/api/admin/orders/[id]">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminOrderDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_ORDER_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
