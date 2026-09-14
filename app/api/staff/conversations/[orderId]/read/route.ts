import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { STAFF_CONVERSATION_NOT_FOUND_MESSAGE } from "@/lib/constants/staff";
import { markStaffConversationRead } from "@/lib/services/staffConversations";

/**
 * 标记会话已读（浏览器端调用，打开客服工作台详情页时触发）。
 *
 * ⚠️ 第一件事是 `requireStaff()`：已读位置记在**当前这位客服**名下
 * （`orderId + staffId` 索引），不是记在会话上。
 *
 * ⚠️ **两个方向的已读互不影响**（§六）：
 * - 本接口只更新客服的已读位置，**不碰用户侧的 `userLastReadAt`**——
 *   客服读完了，用户那边的未读角标该是什么还是什么；
 * - 反过来，用户读客服的消息（`/api/orders/[id]/messages/read`）也不会
 *   把客服的待办清空。
 *
 * 按「会话 + 客服」而不是按会话记录：两位客服同时值班时，
 * 一位读过的会话不该从另一位的工作台上消失。
 *
 * 会话不存在返回 404（与订单不存在同体），并且**不会顺手建会话**：
 * 客服不能凭空给一笔订单造出会话，那是用户发起沟通时才会发生的事。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/conversations/[orderId]/read">,
) {
  try {
    const staff = await requireStaff();
    const { orderId } = await context.params;

    const marked = await markStaffConversationRead(staff.id, orderId ?? "");
    if (!marked) throw new ApiError("NOT_FOUND", STAFF_CONVERSATION_NOT_FOUND_MESSAGE);

    return ok({ orderId, read: true });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
