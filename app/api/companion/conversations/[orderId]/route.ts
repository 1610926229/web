import { ApiError } from "@/lib/api/ApiError";
import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { COMPANION_CONVERSATION_FORBIDDEN_MESSAGE } from "@/lib/constants/service";
import { getCompanionChatDetail } from "@/lib/services/companionConversations";

/**
 * 打手查看某条订单的聊天：`GET /api/companion/conversations/[orderId]`。
 *
 * ⚠️ 第一件事是 `requireCompanion()`。
 *
 * ## 为什么地址里是 `orderId` 而不是 `conversationId`
 *
 * 打手**根本不知道**会话 id，也不该知道：一段履约会话的内部键（`${orderId}#s${seq}`）
 * 一旦出现在路径里，客户端就能试着去寻址一段历史会话，而这个接口的安全性
 * 会退化成「服务层记得判 ③」。用订单定位、由服务端现算「当前是哪一段」，
 * 越权通道就不是被拦住的，而是**不存在**——与用户端的 `target` 是同一个思路。
 *
 * ## 三种「查不到」对外完全同形
 *
 * 订单不存在、不是他接的单、或者他已经被换下（哪怕是同一位打手的上一次履约），
 * 一律同一个 404、同一句话（`COMPANION_CONVERSATION_FORBIDDEN_MESSAGE`）。
 * 因此不能拿别人的订单 id 试探它是否存在，也不能反推出「这一单换过几个人」
 * （`api-contract.md` §2.9）。
 *
 * ⚠️ 这一条与用户端 `/api/orders/[id]/messages` 的差别是刻意的：用户端返回
 * **全部段落**（他要看完整历史），打手端只返回**当前那一段**（他只看得到自己的）。
 * 权限不在这一层裁剪——服务层拿不到当前段就直接返回 null。
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/companion/conversations/[orderId]">,
) {
  try {
    const companion = await requireCompanion();
    const { orderId } = await context.params;

    const detail = await getCompanionChatDetail(companion.companionId, orderId ?? "");
    if (!detail) {
      throw new ApiError("NOT_FOUND", COMPANION_CONVERSATION_FORBIDDEN_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
