import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_ORDER_NOT_FOUND_MESSAGE } from "@/lib/constants/staff";
import { getStaffOrderDetail } from "@/lib/services/staffOrders";

/**
 * 客服工作台订单详情：`GET /api/staff/orders/[id]`（P0-10）。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ 订单不存在返回 404 `STAFF_ORDER_NOT_FOUND_MESSAGE`，页面 `notFound()`。
 * 与客服会话 / 退款详情同一条约定：服务层返回 `null`，**由这里决定口径**。
 *
 * ⚠️ 本接口**只读**，且**不按客服过滤**：客服要能查任意用户的订单（用户报一个订单号
 * 来问，客服就要查得到它）——这正是「全量查询」的含义。守卫挡的是「谁可以读」，
 * 不是「读得到谁的」。
 *
 * ⚠️ 详情 DTO 上的 `allowedActions`（P0-11）只回答**这一单此刻能不能换人 / 退回公共池**，
 * 它是从服务端算出来的两个布尔值，前端不自己用订单状态推断。
 * 两个动作各自的接口在 `[id]/replace` 与 `[id]/release`（本文件仍然只读）。
 *
 * ⚠️ 没有分账比例、护航收益、平台净收入、游戏账号与用户备注。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/staff/orders/[id]">) {
  try {
    await requireStaff();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getStaffOrderDetail(id ?? "", searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
