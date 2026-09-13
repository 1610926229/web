import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { markConversationReadForUser } from "@/lib/services/conversations";

/**
 * 标记订单会话已读（浏览器端调用，进入聊天页时触发）。
 *
 * 已读是**用户自己的状态**：只影响未读角标，不改动任何消息本身，
 * 也不影响对方看到的任何内容。
 *
 * 会话不存在或不属于当前用户返回 404：不存在与不是你的表现一致，
 * 不能拿订单 id 试探别人的会话。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/orders/[id]/messages/read">) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const marked = await markConversationReadForUser(user.id, id ?? "");
    if (!marked) throw new ApiError("NOT_FOUND", "会话不存在");

    return ok({ orderId: id, read: true });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
