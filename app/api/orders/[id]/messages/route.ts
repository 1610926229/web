import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { getMessagesForUser, sendMessageForUser } from "@/lib/services/conversations";

/**
 * 订单沟通消息接口（浏览器端调用）。
 *
 * 权限：必须登录，且订单必须属于当前用户——订单不存在与不属于你返回**同一个 404**，
 * 因此不能拿订单 id 试探别人有哪些订单，也不可能通过请求给别人的订单发消息。
 */

/**
 * 读取某一笔订单的沟通记录。
 *
 * 订单是自己的但还没有会话时，这里会**顺手建立会话**——这正是「用户主动发起沟通」
 * 这个动作（从「联系客服」里选一笔订单进来，或者直接打开聊天页）。
 * 建立是幂等的，不会产生第二个会话。
 */
export async function GET(request: Request, { params }: RouteContext<"/api/orders/[id]/messages">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const result = await getMessagesForUser(user.id, id ?? "", searchParams, "http");
    if (!result) throw new ApiError("NOT_FOUND", "订单不存在");

    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 发送一条消息。
 *
 * 三件事由服务端保证：
 * - **发送者身份**：永远是当前登录用户，角色固定为 `user`，请求体里的
 *   `senderRole` / `senderId` / `senderName` 一概不读，客户端伪造不了客服或打手；
 * - **内容**：去空白后必须非空且不超长，只发几个空格不算消息；
 * - **幂等**：同一「订单 + 发送者 + 幂等键」只产生一条消息，连点不会刷屏。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/orders/[id]/messages">) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await sendMessageForUser(user.id, id ?? "", body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
