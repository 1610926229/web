import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { moderateAdminReview } from "@/lib/services/adminReviews";

/**
 * 隐藏评价：`POST /api/admin/reviews/[id]/hide`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **必须给出原因**（`D10`）。原因**作者可见**（`D8`）：作者在「我的评价」里会看到
 * 「已被管理员隐藏」以及这句话。因此这条原因不是内部备注，而是**写给用户看的说明**——
 * 写「不符合规范」这种没有信息量的话，和没写没有区别。
 *
 * 隐藏是**立即生效的下架**（`D14`）：下一次读取聚合时它就不在公开列表里、
 * 也不再计入平均分与条数——不需要任何同步动作，因为商品页 / 打手页与这里读的是
 * 同一批记录。`hidden → approved` 是可逆的（`D11`），隐藏**不是**删除。
 *
 * ⚠️ 隐藏**不动订单，也不动退款**：一条已通过的评价事后发生退款，
 * **不会**自动变成隐藏（`D20`）——违规与否由人判断，不由金额事件推断。
 * 反过来也一样：退款不影响评价资格（`D18`）。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[id]/hide">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await moderateAdminReview(id, "hide", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
