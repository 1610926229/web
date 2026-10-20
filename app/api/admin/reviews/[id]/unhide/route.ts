import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { moderateAdminReview } from "@/lib/services/adminReviews";

/**
 * 恢复公开：`POST /api/admin/reviews/[id]/unhide`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 「隐藏」是可逆的（`D11`）：恢复之后这条评价重新出现在公开列表里，
 * **并且重新计入**平均分与评价条数——两者是同一次状态变化的两个后果，
 * 不需要也不可能只恢复其中一个（`R3`：公开面与聚合必须同源）。
 *
 * ⚠️ **不需要业务原因**（`D10`）：把一条评价放回公开列表不需要向谁解释。
 * 但它**照样产生 AdminAudit**（`review.unhide`）——「谁在什么时候做了这件事」
 * 本身就是要能追溯的事实（`D11` / `D22`）。审计与「原因字段」是两件事：
 * 前者记的是动作，后者是给用户看的说明。
 *
 * ⚠️ 只有 `hidden` 的评价能被恢复公开。对一条**待审核**的评价调这个接口没有意义
 * ——它的目标状态是 `approved`，但那一步叫「通过」（`review.approve`）。
 * 两者写下的数据相同、**审计里的动作名不同**，而 `D22` 要求审计能回答「做了什么」。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[id]/unhide">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await moderateAdminReview(id, "unhide", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
