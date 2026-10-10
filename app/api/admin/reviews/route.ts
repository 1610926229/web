import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { queryAdminReviewList, resolveAdminReviewListQuery } from "@/lib/services/adminReviews";

/**
 * 管理端评价审核列表：`GET /api/admin/reviews`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。普通用户、客服、护航一律 401 / 403
 * ——权限判断只有 `lib/api/adminRoute.ts` 一处（`D21`：权限必须在服务端强制，
 * 不能只靠界面隐藏按钮）。
 *
 * 查询条件：`status`（缺省 `pending`，`all` 表示不限）、`keyword`、`page` / `pageSize`。
 *
 * ⚠️ 缺省**只看待审核**：这个页面的主用途是「处理待审队列」。
 * 默认落在「全部」会让管理员以为平台上只有这么多评价，
 * 而实际上队列里堆着没处理的那些——那恰好是最该被看见的一批。
 *
 * ⚠️ `status` 取值非法时 **400**（分页参数非法则规范化）：状态是明确的业务条件，
 * 静默回退到默认值会让调用方以为自己在看一份筛选后的结果。
 *
 * ⚠️ 返回的是 `AdminReviewListItem`（含作者摘要），不是仓储实体：
 * `userId` 之外还有 `reviewedBy` 等内部字段，且 DTO 里**只有**列表需要的字段。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveAdminReviewListQuery(searchParams, true);

    return ok(await queryAdminReviewList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
