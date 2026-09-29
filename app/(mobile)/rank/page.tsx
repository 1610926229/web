import NavBar from "@/components/common/NavBar";
import RankBoardSwitch from "@/components/rank/RankBoardSwitch";
import RankingBoard from "@/components/rank/RankingBoard";
import { RANKING_PAGE_TITLE } from "@/lib/constants/rankings";
import { normalizeRankingPeriod } from "@/lib/constants/rankingPeriods";
import { getSessionUser } from "@/lib/auth/session";
import { getConsumptionRanking } from "@/lib/services/rankings";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 消费排行榜（**游客可访问**）。
 *
 * 二级页面：在 `(tabs)` 之外，顶部返回、**不带底部 TabBar**。
 *
 * 这里**刻意不用 `RequireAuth`**：排行榜是公开内容，看榜不应该被迫登录。会话只用来
 * 判断要不要显示「我的排名」——读不到就按游客渲染，不会拦人、不会跳转登录页。
 *
 * 按周期过滤、聚合、排序与分页都在服务端完成（`getConsumptionRanking`），页面拿到的
 * 每一行只有名次、昵称、头像、等级名与金额五项；订单明细与内部用户标识既不在 DTO 里，
 * 也就没有「不小心渲染出来」的可能。
 *
 * **非法 `period` 在这里规范化到默认周期**：`?period=lastWeek` 这样的地址应该正常打开
 * 默认周期的榜单，而不是给用户一个 400 错误页（接口侧仍然保持 400 的严格契约，
 * 见 `app/api/rankings/consumption/route.ts`）。客户端挂载后会把地址栏里的非法值
 * 改写成默认周期，`RankingBoard` 负责这件事。
 *
 * Mock 参数原样传下去：`?mockEmpty=rankings` 演示空榜，`?mockError=1` 演示错误边界。
 *
 * ## P1-5 的改动**只有一处**：顶部多了一条 `RankBoardSwitch`
 *
 * 打手榜（`/rank/companions`）是本轮新增的另一个榜。产品裁定
 * （`rounds/P1-5/02-decisions.md` §10）要求两个榜**必须是两个独立业务维度**，
 * 而消费榜自己的「我的排名」逻辑**继续保留、不得改写**——因此这里**不做**「同一页
 * 两个页签」：切榜是一次**跳转到另一个地址**，两条取数路径不共享任何状态。
 *
 * ⚠️ 本页的取数、周期、分页与名次逻辑**一行都没有改**：
 * `getConsumptionRanking` 的参数与调用方式、`period` 的规范化、`RankingBoard` 的
 * 全部 props 都保持原样。新增的只是上面那一个导航组件。
 */
export default async function RankPage({ searchParams }: PageProps<"/rank">) {
  const params = toSearchParams(await searchParams);
  const user = await getSessionUser();

  // 只规范化 period 这一个参数，其余参数（分页、Mock 调试）原样保留
  params.set("period", normalizeRankingPeriod(params.get("period")));

  const initialResult = await getConsumptionRanking(user?.id ?? null, params, "server");

  return (
    <>
      <NavBar title={RANKING_PAGE_TITLE} showBack />
      <RankBoardSwitch active="consumption" />
      <RankingBoard initialResult={initialResult} />
    </>
  );
}
