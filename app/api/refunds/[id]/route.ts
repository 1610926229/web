import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getRefundDetailForUser } from "@/lib/services/refunds";

/**
 * 退款申请详情接口（浏览器端调用）。
 *
 * 返回的是详情 DTO：包含退款原因、说明与凭证，因此**只向申请人本人返回**。
 *
 * 退款申请不存在与不属于当前用户，一律返回同一个 404「退款申请不存在」：
 * 若两者返回不同结果，就可以拿退款 id 一个个试出「哪些 id 真实存在」。
 */
export async function GET(request: Request, { params }: RouteContext<"/api/refunds/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const detail = await getRefundDetailForUser(id ?? "", user.id, searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", "退款申请不存在");

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
