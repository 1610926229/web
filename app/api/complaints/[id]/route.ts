import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getComplaintDetailForUser } from "@/lib/services/complaints";

/**
 * 投诉详情接口（浏览器端调用）。
 *
 * 返回的是详情 DTO：包含投诉说明、凭证与联系方式，因此**只向投诉人本人返回**。
 *
 * 投诉不存在与不属于当前用户，一律返回同一个 404「投诉不存在」：
 * 若两者返回不同结果，就可以拿投诉 id 一个个试出「哪些 id 真实存在」。
 */
export async function GET(request: Request, { params }: RouteContext<"/api/complaints/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const detail = await getComplaintDetailForUser(id ?? "", user.id, searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", "投诉不存在");

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
