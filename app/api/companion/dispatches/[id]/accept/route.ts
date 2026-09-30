import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { acceptDispatchForCompanion } from "@/lib/services/companionDispatch";

/**
 * 接单。
 *
 * 权限：`requireCompanion()`，**第一个动作**。以谁的身份接单完全由服务端会话决定：
 * 请求体里一个字段都不读，因此不存在「用别人的身份接单」这种可能。
 *
 * ## 业务上的失败走 200，不走 4xx
 *
 * 「这一单刚被其他护航接走了」是**正常的抢单结果**，不是调用出错
 * （与 `/api/me/companion-application` 「还没有申请返回 `null` 而不是 404」同一个取舍）。
 * 客户端拿到 `kind` 之后能说清「发生了什么、要不要再等」；
 * 用 4xx 表达的话，客户端只能把它写成一个 `catch`，而那里分不出
 * 「被抢了」（刷新即可）与「网络断了」（该重试）。
 *
 * 真正走 4xx 的只有鉴权：未登录 401、不是打手或资格已下架 403。
 *
 * ## 本接口不做判定
 *
 * 能不能接（到没到点、是不是指定给他、他还在不在架、订单有没有被退掉）
 * 全部在 `acceptDispatch` 的原子区段里判定，并在**同一段**代码里写派单与订单。
 * 到这里再判一次，就等于把判定与写入拆开——中间那段窗口正是并发抢单的入口。
 *
 * 本文件只有 POST。**没有「拒绝」「放弃」的接口**：不接就是什么都不做。
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/companion/dispatches/[id]/accept">,
) {
  try {
    const companion = await requireCompanion();
    const { id } = await context.params;

    return ok(await acceptDispatchForCompanion(companion.companionId, id, new Date().toISOString()));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
