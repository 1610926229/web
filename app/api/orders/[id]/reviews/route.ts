import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createReviewForOrder } from "@/lib/services/reviews";

/**
 * 提交评价接口（浏览器端调用）。
 *
 * 权限：必须登录，且订单必须属于当前用户——订单不存在与不属于你返回**同一个 404**，
 * 因此不能拿订单 id 试探别人有哪些订单。
 *
 * 四件事由服务端保证，客户端做不了：
 * - **资格**：只有「已完成」且没有进行中 / 已通过退款的订单可以评价；
 * - **一单一评**：「用户 + 订单」是业务唯一键，重复提交返回第一次的结果（不是报错），
 *   快速连点、刷新页面重发、并发提交都不会产生第二条；
 * - **身份与快照**：订单号、商品、打手、完成时间从订单抄一份，评价时间由服务端写，
 *   请求体里的 `userId` / `orderStatus` / `companionId` / `createdAt` 一律不读；
 * - **不改动订单**：本接口只写评价记录，不碰订单状态与金额，也不参与消费等级计算。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/orders/[id]/reviews">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await createReviewForOrder(id ?? "", user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
