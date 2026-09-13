import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { queryReviewsForUser } from "@/lib/services/reviews";

/**
 * 评价列表接口（浏览器端切换 Tab、切换时间筛选与加载更多时调用）。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的评价」参数，
 * 因此不可能通过改参数读到别人的评价，也不可能把别人的待评价订单列出来。
 *
 * 参数契约（详见 `lib/constants/reviews.ts`）：
 * - `tab` 只能是 `reviewed` / `pending`，其余取值 → 400，不静默回退；
 * - `range` 只能是 `all` / `month` / `threeMonths` / `halfYear` / `year`，其余取值 → 400；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 *
 * 返回里带上两个 Tab 的数量：前端据此渲染角标，不自己加减。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryReviewsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
