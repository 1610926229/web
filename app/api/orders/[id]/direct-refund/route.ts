import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { directRefundOrderForUser } from "@/lib/services/refunds";

/**
 * 直接全额退款接口（P0-12，浏览器端调用）。
 *
 * 权限：必须登录，且订单必须属于当前用户——订单不存在与不属于你返回**同一个 404**，
 * 因此不能拿订单 id 试探别人有哪些订单。
 *
 * ## 它为什么与 `POST /api/orders/[id]/refunds` 是两个接口
 *
 * 那两个接口做的是两件事，而不是同一件事的两个版本：
 *
 * | | `/refunds` | `/direct-refund` |
 * |---|---|---|
 * | 用户在做的事 | 向客服**申请**退款 | **当场退掉**这一单 |
 * | 请求体 | 原因 / 说明 / 凭证 + 幂等键 | **空**（没有可填的东西） |
 * | 订单一 | 一动不动，等审核 | 立刻 `refunded`，钱当场退回 |
 * | 返回 | 新申请的 id，跳进度页 | 退款结果，就在本页刷新 |
 * | 适用状态 | `serving` / `completed` | `paid` / `accepted` |
 *
 * 合成一个接口就必须靠请求体里有没有 `reasonKey` 来分辨意图——那是把
 * 「哪条业务路径」变成一个可被伪造的字段。而状态集合不相交，因此两条路不会同时适用。
 *
 * ## 三件事由服务端保证，客户端做不了
 *
 * - **金额**：请求体里没有金额字段，取订单 `actualPaidAmount`，全额退款；
 * - **幂等**：重复请求（含超时清扫、管理员退款之后的重复点击）不重复出款、
 *   不重复通知、不刷新退款时刻；
 * - **通知**：`accepted` 单退款时，把「订单已退款」发给当前打手，与退款同时落库。
 *
 * ⚠️ **不读请求体**：这一档退款没有任何可填参数（没有原因、没有说明、没有金额）。
 * 读了就必须校验，而校验一个不存在的意图只会给将来留一个可以从外部影响资金的口子。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/orders/[id]/direct-refund">) {
  try {
    // ⚠️ 守卫必须在最前：未登录时不得先碰订单数据，否则响应快慢会泄露订单是否存在
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const result = await directRefundOrderForUser(id ?? "", user.id, searchParams, "http");
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
