import { apiGet } from "@/lib/api/client";
import { COMPANION_RANKING_PAGE_SIZE } from "@/lib/constants/companionRankings";
import type { RankingPeriod } from "@/lib/constants/rankingPeriods";
import type { CompanionRankingBoard, CompanionRankingPage } from "@/lib/types/companionRanking";

/**
 * 打手排行榜的**浏览器端**取数（切榜、切周期、翻页与「加载更多」）。P1-5 新增。
 *
 * 服务端模块 `lib/services/companionRankings.ts` 会为了聚合读到**全部打手的收益、
 * 全部订单与全部接单事件**，绝不能被客户端组件引用：那不只是把 Mock 打进产物，
 * 而是把全站订单与打手收益一起拖进浏览器。首屏榜单由 Server Component 直接取数，
 * 不经过本文件。
 *
 * ⚠️ 与消费榜的 `rankingsHttp.ts` **各自独立**（连每页条数常量都各有一份，
 * 理由见 `lib/constants/companionRankings.ts` 文件头）：两个榜是两个独立业务维度，
 * 一旦共用取数模块，为其中一张榜加的查询参数会悄悄出现在另一张榜的请求里。
 *
 * ⚠️ 请求里**只有榜、周期与分页参数**。指标、名次与金额都不接受客户端提交，
 * 服务端每次都按数据重新算；游客也能调用——本接口**不读会话**，
 * 因此响应里没有任何与「谁在看」有关的东西（裁定 §10：第一版不做「我的排名」）。
 */

export type CompanionRankingListRequest = {
  /** 要看哪一张榜 */
  board: CompanionRankingBoard;
  /** 要看的周期。**必填**：漏传会让服务端用默认周期，页面就会显示与页签不符的榜单 */
  period: RankingPeriod;
  page?: number;
  pageSize?: number;
};

/** 打手排行榜一页。 */
export function fetchCompanionRanking(
  input: CompanionRankingListRequest,
): Promise<CompanionRankingPage> {
  const params = new URLSearchParams();
  params.set("board", input.board);
  params.set("period", input.period);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? COMPANION_RANKING_PAGE_SIZE));

  return apiGet<CompanionRankingPage>(`/api/rankings/companions?${params.toString()}`);
}
