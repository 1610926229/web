import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createRefundForOrder } from "@/lib/services/refunds";

/**
 * 提交退款申请接口（浏览器端调用）。
 *
 * 权限：必须登录，且订单必须属于当前用户——订单不存在与不属于你返回**同一个 404**，
 * 因此不能拿订单 id 试探别人有哪些订单。
 *
 * 三件事由服务端保证，客户端做不了：
 * - **金额**取订单实付金额，请求体里根本没有金额字段；
 * - **状态**只会是「待审核」，且**不改动订单状态**（订单按原进度继续）；
 * - **幂等**：同一「用户 + 幂等键」只产生一条申请，一笔订单也只有一条申请。
 *
 * 返回新申请的 id，由客户端跳到退款详情页继续查看进度。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/orders/[id]/refunds">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    const result = await createRefundForOrder(id ?? "", user.id, body, searchParams, "http");
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
