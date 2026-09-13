import NavBar from "@/components/common/NavBar";
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
      <RankingBoard initialResult={initialResult} />
    </>
  );
}
