import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { moderateAdminReview } from "@/lib/services/adminReviews";

/**
 * 通过评价：`POST /api/admin/reviews/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 通过的后果：这条评价进入**公开面**——商品详情页与打手详情页的评分立刻把它算进去
 * （`D14`：只有 `approved` 计入平均分与评价条数）。
 *
 * ⚠️ **不需要原因**（`D10`）：通过是默认预期。请求体里给了 `reason` 也不会被写进
 * 任何字段——`moderateReview()` 只把原因写进 `rejectReason` / `hideReason`，
 * 因此「通过时附一句备注」在当前数据模型里**没有地方放**，也就不可能悄悄留下一条
 * 读侧看不见的记录。
 *
 * ⚠️ 只有 `pending` 的评价能被通过（`canApplyReviewModeration`）：
 * 对一条**隐藏中**的评价要做的是「恢复公开」（`unhide`），它会写一条
 * `review.unhide` 审计；用 `approve` 会让审计读起来像「通过了一条新评价」。
 * 对一条**已通过**的评价再点一次是**幂等的空操作**（`200` + `changed: false`）。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[id]/approve">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await moderateAdminReview(id, "approve", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
