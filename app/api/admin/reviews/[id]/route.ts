import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { ADMIN_REVIEW_NOT_FOUND_MESSAGE } from "@/lib/constants/adminReviews";
import { getAdminReviewDetail } from "@/lib/services/adminReviews";

/**
 * 管理端评价详情：`GET /api/admin/reviews/[id]`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **没有 `PATCH`**，这是刻意的：`D12` 明文「管理员不能修改星级与正文」。
 * 不提供这个入口，比提供一个会返回 400 的入口更好——前者是「这件事做不到」，
 * 后者是「这件事本来能做到、我们拦住了」，读代码的人会以为规则是松的。
 *
 * 评价不存在返回 **404**。与其它后台详情不同，这里没有「软删除后仍可查看」的情况：
 * 评价的状态变化是 `hidden`（在列表里能筛出来），不是记录消失（`R2`）。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminReviewDetail(id, searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", ADMIN_REVIEW_NOT_FOUND_MESSAGE, 404);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
