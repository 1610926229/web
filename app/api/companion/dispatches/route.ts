import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { listCompanionPools } from "@/lib/services/companionDispatch";

/**
 * 当前打手能接的订单池（专属池 + 公共池）。
 *
 * 权限：`requireCompanion()` —— 未登录 401；登录了但名下没有有效护航资料、
 * 或资料已下架，都是 403。**这一步必须是第一个动作**：页面上的隐藏区不是保护，
 * 接口可以被直接请求。
 *
 * 返回的是**已经按他收窄过的**两张池子，不是「全部在池订单 + 一个过滤字段」：
 * 调用方拿不到自己看不到的单，也就不可能因为漏过滤而看到它们。
 *
 * ⚠️ 响应里**没有游戏账号与备注**（见 `CompanionPoolItem`）。接单之前打手
 * 没有任何理由看到别人的游戏账号。
 *
 * 本文件只有 GET：接单走 `POST /api/companion/dispatches/[id]/accept`。
 * **没有拒绝 / 放弃 / 退回公共池的接口**——「不接」就是什么都不做，
 * 专属池十分钟到点后由系统自动转入公共池。
 */
export async function GET() {
  try {
    const companion = await requireCompanion();

    // 读取前先清扫已经到点的派单（幂等）。放在服务端而不是页面上，
    // 是因为接口同样要保证「返回的每一单此刻都真的还能接」
    return ok(await listCompanionPools(companion.companionId, new Date().toISOString()));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
