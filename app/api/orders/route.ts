import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { queryOrdersForUser } from "@/lib/services/orders";

/**
 * 订单列表接口（浏览器端调用）。
 *
 * 与订单页首屏**共用** `queryOrdersForUser`，本文件只负责鉴权、透传查询参数
 * （含 Mock 调试参数）与统一信封。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的订单」参数，
 * 因此不可能通过改参数读到别人的订单。
 *
 * 参数契约（详见 `lib/constants/orders.ts`）：
 * - `status` 非法 → 400，不静默回退成「全部」；
 * - `keyword` 超长 → 400；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryOrdersForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
