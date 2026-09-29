import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { sendMessageForCompanion } from "@/lib/services/companionConversations";

/**
 * 打手发送消息：`POST /api/companion/conversations/[orderId]/messages`。
 *
 * ⚠️ 第一件事是 `requireCompanion()`：发送者身份用的是**守卫返回的那一份会话**，
 * 不是请求体里的任何字段。
 *
 * ⚠️ **写的是唯一那份消息仓储**（与用户端 `/api/orders/[id]/messages`、
 * 客服端 `/api/staff/conversations/[orderId]/messages` 同一个 `getMessageRepository()`）：
 * 打手发出去的消息，用户端刷新 `service/chat/[orderId]` 立刻就能看到。
 * 这里没有、也不会有「打手专用消息副本」。
 *
 * 服务端写死的四件事：
 * - `senderId` = 当前护航的 id（**不是**请求体里的 `senderId`）；
 * - `senderRole` = `companion`（请求体里的 `senderRole` 读都不读，
 *   因此伪造「客服说」或「用户说」无从下手）；
 * - `senderName` / `senderAvatarUrl` = **发送时的快照**，之后这位护航被下架或改名，
 *   这条消息仍然显示得出当时的名字与头像；
 * - `userId` = **下单用户**，这样用户端按自己的 userId 就能读到打手的消息。
 *
 * ⚠️ **不改订单**：发一条消息不会改变订单状态、金额或商品。
 *
 * ⚠️ **也写不进历史段落**：`conversationId` 由服务层现算的「当前这一段」决定，
 * 请求体里没有任何字段能指定它（见 `getCompanionChatDetail` 的说明）。
 *
 * 幂等：同一「会话 + 打手 + 幂等键」只产生一条消息，连点与网络重试都不会刷屏。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/companion/conversations/[orderId]/messages">,
) {
  try {
    const companion = await requireCompanion();
    const { orderId } = await context.params;
    const body = await readJsonBody(request);

    return ok(await sendMessageForCompanion(companion, orderId ?? "", body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
