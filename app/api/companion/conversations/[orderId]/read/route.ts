import { ApiError } from "@/lib/api/ApiError";
import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { COMPANION_CONVERSATION_FORBIDDEN_MESSAGE } from "@/lib/constants/service";
import { markCompanionChatRead } from "@/lib/services/companionConversations";

/**
 * 标记已读（浏览器端调用，打开聊天页时触发）。
 *
 * ⚠️ 第一件事是 `requireCompanion()`：已读位置记在**当前这位护航**名下，
 * 而且**挂在会话记录上**（`companionLastReadAt`），不是挂在订单上。
 *
 * ⚠️ 这一条是 `cmd_p0-14.md` §九 的硬要求：「禁止继续只按 orderId 保存 Companion
 * 已读 cursor」。挂在会话上顺带保证了三件事——换人之后新护航拿到的是
 * **新记录**（`companionLastReadAt: null`），因此
 *
 * - 他继承不到旧打手的已读位置（也就继承不到「已读」这个假象）；
 * - 旧打手的未读也不会算到他头上；
 * - 用户的阅读进度与这一段无关（`userLastReadAt` 是另一个字段）。
 *
 * ⚠️ **不碰用户与客服的已读**：三者是三份互不影响的状态。
 *
 * 读不到可读的会话（不是他接的单 / 已被换下 / 这一段还没建）一律 404，
 * 与 `GET` 同形。⚠️ 本接口**不建会话**：已读是「读过了」的记账，
 * 没有可读的东西就没什么可记的。
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/companion/conversations/[orderId]/read">,
) {
  try {
    const companion = await requireCompanion();
    const { orderId } = await context.params;

    const marked = await markCompanionChatRead(companion.companionId, orderId ?? "");
    if (!marked) {
      throw new ApiError("NOT_FOUND", COMPANION_CONVERSATION_FORBIDDEN_MESSAGE, 404);
    }

    return ok({ orderId, read: true });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
