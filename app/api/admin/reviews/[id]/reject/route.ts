import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { moderateAdminReview } from "@/lib/services/adminReviews";

/**
 * 驳回评价：`POST /api/admin/reviews/[id]/reject`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **必须给出原因**（`D10`）：`reason` trim 后为空返回 **400**。
 * 驳回是对用户内容的负面判定，不写原因用户既不知道哪里不合规、也无从修改，
 * 而 `D9` 允许他在原记录上改完重提——没有原因，那次重提只能靠猜。
 *
 * ⚠️ 驳回**不删除**这条评价（`R2`）：它仍然存在、仍然是同一条记录，
 * 只是不再公开，且作者据此获得一次「重新提交」的机会（`rejected → pending`）。
 * 因此这里的落点是 `rejectReason` 而不是任何形式的删除。
 *
 * ⚠️ 只有 `pending` 的评价能被驳回。**已公开的评价不能驳回**，要做的是「隐藏」
 * ——把一条已经公开过的评价「驳回」，在数据上等于让它凭空消失，
 * 而真正发生的是「我们不再让它公开」，那是 `hidden` 而不是 `rejected`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[id]/reject">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await moderateAdminReview(id, "reject", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
