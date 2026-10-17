import { fail, ok, toApiError } from "@/lib/api/route";
import { requireCompanion } from "@/lib/api/companionRoute";
import { listCompanionChats } from "@/lib/services/companionConversations";

/**
 * 打手「订单聊天」列表：`GET /api/companion/conversations`。
 *
 * ⚠️ 第一件事是 `requireCompanion()`。身份矩阵：匿名 401、普通用户 403（名下没有
 * 有效护航资料）、已下架的护航 403，只有启用中的护航能通过。理由见
 * `lib/api/companionRoute.ts`。
 *
 * ⚠️ **不读任何查询参数**。`companionId` 只能来自守卫返回的会话身份——
 * 多一个参数位就等于给「看别人的聊天」留一扇门，而这一条恰恰是本轮要堵死的东西。
 * 因此这里也没有分页：一位打手手上的在订单是有限的（并发上限约束），
 * 加一个可以被传进来的 `page` 只会多一处可被利用的输入。
 *
 * ⚠️ 行来自**当前实际履约的订单**，不是「已经聊过的会话」：刚接单还没人开口的订单
 * 也要出现在列表里——那正是打手最需要看到的「去打个招呼」的入口。
 * 换人之后订单不再归他，这一行同时从「我的订单」与本列表消失。
 */
export async function GET() {
  try {
    const companion = await requireCompanion();

    return ok(await listCompanionChats(companion.companionId));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
