import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { sendMessageForStaff } from "@/lib/services/staffConversations";

/**
 * 客服发送消息：`POST /api/staff/conversations/[orderId]/messages`。
 *
 * ⚠️ 第一件事是 `requireStaff()`：发送者身份用的是**守卫返回的那一份会话**，
 * 不是请求体里的任何字段。
 *
 * ⚠️ **写的是唯一那份消息仓储**（与用户端 `/api/orders/[id]/messages` 同一个
 * `getMessageRepository()`）：因此客服发出去的消息，用户端刷新
 * `/service/chat/[orderId]` 立刻就能看到，不需要任何同步动作。
 * 这里没有、也不会有「客服专用消息副本」。
 *
 * 服务端写死的四件事：
 * - `senderId` = 当前客服会话的 id（不是请求体里的 `senderId`）；
 * - `senderRole` = `customer_service`（请求体里的 `senderRole` 读都不读）；
 * - `senderName` / `senderAvatarUrl` = **发送时的快照**，之后这位客服被停用或
 *   软删除，这条消息仍然显示得出当时的名字与头像；
 * - `userId` = **会话所属用户**，这样用户端按自己的 userId 就能读到客服的消息。
 *
 * ⚠️ **不改订单**：发一条消息不会改变订单状态、金额或商品。
 *
 * 幂等：同一「订单 + 客服 + 幂等键」只产生一条消息，连点与网络重试都不会刷屏。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/conversations/[orderId]/messages">,
) {
  try {
    const staff = await requireStaff();
    const { orderId } = await context.params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await sendMessageForStaff(staff, orderId ?? "", body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
