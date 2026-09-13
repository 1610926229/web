import { fail, ok, toApiError } from "@/lib/api/route";
import { getSessionUser } from "@/lib/auth/session";
import { getConsumptionRanking } from "@/lib/services/rankings";

/**
 * 消费排行榜（浏览器端翻页与「加载更多」时调用）。
 *
 * 权限：**游客可访问**。榜单是公开内容，因此这里**不调用 `requireUser()`**——
 * 只是为了显示「我的排名」才顺便读一次会话，读不到就按游客处理，不会返回 401。
 *
 * 四条不能越过的线：
 *
 * 1. 榜单条目只有 `rank` / `nickname` / `avatarUrl` / `levelName` /
 *    `effectiveSpendAmount` 五项，**没有 userId**：客户端列表用名次做 key，
 *    因此不需要把内部用户标识发给浏览器；
 * 2. 按周期过滤、聚合、排序与分页全部在服务端完成（`getConsumptionRanking`），
 *    响应里没有任何一条订单明细；
 * 3. 接口不接受客户端提交的金额、等级或名次——`period` / `page` / `pageSize`
 *    之外的参数一律忽略，名次永远由服务端按订单重新算出来；
 * 4. `period` 的契约是明确的：合法值是 `today` / `yesterday` / `week` / `month` /
 *    `lastMonth` / `all`；**不传**用默认周期（本周），**传了非法值回 400**。
 *    静默把非法值当成默认周期返回，会让调用方拿着「不知道是哪一段时间的榜单」
 *    继续往下用，比报错难查得多。
 *
 * 会话 Cookie 无效或已过期时 `getSessionUser()` 返回 null，等同于游客：
 * 「登录态坏了」不应该变成「榜单打不开」。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = await getSessionUser();

    return ok(await getConsumptionRanking(user?.id ?? null, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
