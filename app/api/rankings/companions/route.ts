import { fail, ok, toApiError } from "@/lib/api/route";
import { getCompanionRanking } from "@/lib/services/companionRankings";

/**
 * 打手排行榜（浏览器端翻页、切榜、切周期时调用）。P1-5 新增。
 *
 * ## 权限：**游客可访问**，且**刻意不读会话**
 *
 * `docs/01-requirements/超哥电竞_用户权限表.md:90` 的「浏览排行榜」对游客就是 ✅，
 * 裁定也写明「排行榜允许游客浏览」。因此这里**不调用 `requireUser()`**。
 *
 * ⚠️ 与消费榜路由的一处**实质性**差别：消费榜为了「我的排名」还会
 * `getSessionUser()` 读一次会话，**本路由连这一次都不读**——因为裁定 §10 明确
 * 「P1-5 第一版不做『我的排名』」。
 *
 * 这不只是「少了一个字段」：**不读会话意味着本接口在结构上不可能因为登录态
 * 而改变输出**。将来要给打手榜加「我的排名」时，那是一个需要重新审视
 * 「谁会看到什么」的功能变更，不该是一个字段悄悄从 null 变成对象。
 *
 * ## 五条不能越过的线
 *
 * 1. 榜单条目只有 `rank` / `companionId` / `nickname` / `avatarUrl` /
 *    `metricValue` / `metricLabel` 六项（裁定 §9 的白名单），
 *    **没有 `realName`、手机号、微信号、`companionRate`、内部分账比例、审核资料、
 *    ban reason、敏感后台状态**；
 * 2. 按周期过滤、聚合、名次与分页全部在服务端完成（`getCompanionRanking`），
 *    响应里没有任何一条订单 / 收益 / 接单事件明细；
 * 3. 接口不接受客户端提交的指标、名次或金额——`board` / `period` / `page` / `pageSize`
 *    之外的参数一律忽略，名次永远由服务端按数据重新算出来；
 * 4. `board` 的契约与 `period` 同构：合法值是 `dispatch` / `completion` / `income`；
 *    **不传**用默认（接单榜），**传了非法值回 400**；
 * 5. **拿不到会话时不降级、不 401**——本接口本来就不需要身份。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    return ok(await getCompanionRanking(searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
