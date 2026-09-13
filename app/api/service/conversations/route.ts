import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { listConversationsForUser } from "@/lib/services/conversations";

/**
 * 订单沟通会话列表接口（浏览器端调用，客服首页「订单沟通」用）。
 *
 * 权限：必须登录；返回的只有当前用户自己订单的会话——这个筛选在仓储层就完成了，
 * 接口没有任何「查谁」的参数。
 *
 * 会话列表**不含**游戏 ID 与订单备注：只需要订单号、商品名、最后一条消息与未读数。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await listConversationsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
