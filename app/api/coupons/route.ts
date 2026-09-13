import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { queryCouponsForUser } from "@/lib/services/coupons";

/**
 * 优惠券列表接口（浏览器端切换 Tab 与加载更多时调用）。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的券」参数，
 * 因此不可能通过改参数读到别人的领取记录。
 *
 * 参数契约（详见 `lib/constants/coupons.ts`）：
 * - `tab` 只能是 `owned` / `claimable`，其余取值 → 400，不静默回退；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 *
 * 返回里带上两个 Tab 的数量：前端据此渲染角标，不自己加减。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryCouponsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
