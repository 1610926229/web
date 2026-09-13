import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getOrderDetailForUser } from "@/lib/services/orders";

/**
 * 订单详情接口（浏览器端调用）。
 *
 * 返回的是详情 DTO，包含游戏 ID 与用户备注——因此**只向订单所属用户返回**。
 *
 * 订单不存在与订单不属于当前用户，一律返回同一个 404「订单不存在」：
 * 若两者返回不同结果，就可以拿订单 id 一个个试出「哪些 id 真实存在」。
 */
export async function GET(request: Request, { params }: RouteContext<"/api/orders/[id]">) {
  try {
    const user = await requireUser();
    // 路由参数已由 Next 解码，这里不再二次 decode（id 里出现 `%` 时二次解码会改坏原值）
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const detail = await getOrderDetailForUser(id ?? "", user.id, searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", "订单不存在");

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
