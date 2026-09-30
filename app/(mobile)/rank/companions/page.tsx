import NavBar from "@/components/common/NavBar";
import CompanionRankingBoard from "@/components/rank/CompanionRankingBoard";
import { COMPANION_RANKING_PAGE_TITLE, normalizeCompanionRankingBoard } from "@/lib/constants/companionRankings";
import { normalizeRankingPeriod } from "@/lib/constants/rankingPeriods";
import { getCompanionRanking } from "@/lib/services/companionRankings";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 打手排行榜（**游客可访问**）。P1-5 新增。
 *
 * 二级页面：在 `(tabs)` 之外，顶部返回、**不带底部 TabBar**。
 *
 * ## 与 `app/(mobile)/rank/page.tsx`（消费榜）的关系：**并存，不是它的一个视图**
 *
 * 两个页面是**两个地址**，共用一条导航（`RankBoardSwitch`）。做成两个地址而不是
 * 同一页里的页签，是因为产品裁定（`rounds/P1-5/02-decisions.md` §10）要求
 * 「Companion Ranking 与 User Consumption Ranking 必须是两个独立业务维度」，
 * 而消费榜那套「我的排名 / 游客文案 / 名次编号」逻辑本轮**明令不得改写**。
 * 分成两个文件之后，隔离性**用文件边界就能证明**。
 *
 * ## 三条刻意如此的设计
 *
 * 1. **不读会话**。本页不调用 `getSessionUser()`，因为裁定 §10 明确第一版
 *    **不做「我的排名」**。少读一次会话不只是省一次调用：它让「登录态会不会改变
 *    这一页的内容」这个问题在**结构上**没有答案可以变——将来要加这个功能时，
 *    那是一次需要重新审视隐私边界的变更，而不是一个字段悄悄从 null 变成对象。
 * 2. **不套 `RequireAuth`**。排行榜是公开内容，看榜不应该被迫登录。
 * 3. **非法 `board` / `period` 在这里规范化到默认值**：`?board=revenue` 这样的地址
 *    应该正常打开默认榜，而不是给用户一个 400 错误页（接口侧仍然保持 400 的严格契约，
 *    见 `app/api/rankings/companions/route.ts`）。客户端挂载后会把地址栏里的非法值
 *    改写成默认值，`CompanionRankingBoard` 负责这件事。
 *
 * Mock 参数原样传下去：`?mockEmpty=companionRankings` 演示空榜，
 * `?mockError=1` 演示错误边界。⚠️ 空榜的键与消费榜的 `rankings` **不是同一个**，
 * 两者互不影响——清空打手榜时消费榜必须原样保留。
 */
export default async function CompanionRankPage({ searchParams }: PageProps<"/rank/companions">) {
  const params = toSearchParams(await searchParams);

  // 只规范化 board 与 period 这两个参数，其余参数（分页、Mock 调试）原样保留
  params.set("board", normalizeCompanionRankingBoard(params.get("board")));
  params.set("period", normalizeRankingPeriod(params.get("period")));

  const initialResult = await getCompanionRanking(params, "server");

  return (
    <>
      <NavBar title={COMPANION_RANKING_PAGE_TITLE} showBack />
      <CompanionRankingBoard initialResult={initialResult} />
    </>
  );
}
