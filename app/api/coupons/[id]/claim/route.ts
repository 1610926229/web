import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { claimCouponForUser } from "@/lib/services/coupons";

/**
 * 领取优惠券。
 *
 * 三件事由服务端保证：
 * - **归属**：领取记录写的是当前会话用户，请求体里的 `userId` 一律不读；
 * - **可领**：停用 / 未开始 / 已过期的券返回 400，文案说的是不能领的具体原因；
 * - **幂等**：同「用户 + 券」只会有一条记录，同「用户 + 幂等键」返回上一次的结果，
 *   快速连点与网络重试都不会多出第二条。
 *
 * ⚠️ 本接口只写优惠券自己的领取记录：不创建订单、不改订单金额、不碰支付，
 * 结算（P4）也不会读取这里的数据。
 */
export async function POST(request: Request, context: RouteContext<"/api/coupons/[id]/claim">) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await claimCouponForUser(user.id, id ?? "", body, "http", searchParams));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
