import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_CONVERSATION_NOT_FOUND_MESSAGE } from "@/lib/constants/staff";
import { getStaffConversationDetail } from "@/lib/services/staffConversations";

/**
 * 客服工作台会话详情：`GET /api/staff/conversations/[orderId]`。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ **只允许访问存在会话的关联订单**（§五）。三种情形返回**完全相同**的 404
 * 与同一句话「会话不存在」：
 *
 * 1. 订单号写错了，压根没有这笔订单；
 * 2. 订单存在，但从来没有人发起过沟通；
 * 3. 会话存在但关联的订单记录查不到（数据异常）。
 *
 * 三者不可区分是刻意的：能区分就等于给出一个「拿订单号试探平台有哪些订单」的接口。
 * 因此客服拿一个随便猜的订单 ID 过来，得到的结果与订单不存在一模一样。
 *
 * 返回的订单摘要是**只读**的：不含支付凭据、Cookie、OpenID / UnionID，
 * 也**不含游戏 ID 与订单备注**（本阶段客服不需要它们）。
 */
export async function GET(request: Request, context: RouteContext<"/api/staff/conversations/[orderId]">) {
  try {
    const staff = await requireStaff();
    const { orderId } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getStaffConversationDetail(staff.id, orderId ?? "", searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", STAFF_CONVERSATION_NOT_FOUND_MESSAGE);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
