import { apiGet } from "@/lib/api/client";
import { RANKING_PAGE_SIZE } from "@/lib/constants/rankings";
import type { RankingPeriod } from "@/lib/constants/rankingPeriods";
import type { ConsumptionRankingPage } from "@/lib/types/ranking";

/**
 * 消费排行榜的**浏览器端**取数（切周期、翻页与「加载更多」）。
 *
 * 服务端模块 `lib/services/rankings.ts` 会为了聚合读到**全部用户的订单**，
 * 绝不能被客户端组件引用：那不只是把 Mock 打进产物，而是把全站订单数据
 * 一起拖进浏览器。首屏榜单由 Server Component 直接取数，不经过本文件。
 *
 * ⚠️ 请求里**只有周期与分页参数**。金额、等级与名次都不接受客户端提交，服务端每次都按
 * 订单重新算；游客也能调用，未登录时响应里的 `me` 为 null。
 */

export type RankingListRequest = {
  /** 要看的周期。**必填**：漏传会让服务端用默认周期，页面就会显示与页签不符的榜单 */
  period: RankingPeriod;
  page?: number;
  pageSize?: number;
};

/** 消费排行榜一页。 */
export function fetchConsumptionRanking(
  input: RankingListRequest,
): Promise<ConsumptionRankingPage> {
  const params = new URLSearchParams();
  params.set("period", input.period);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? RANKING_PAGE_SIZE));

  return apiGet<ConsumptionRankingPage>(`/api/rankings/consumption?${params.toString()}`);
}
