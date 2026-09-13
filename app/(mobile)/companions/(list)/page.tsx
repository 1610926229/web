import NavBar from "@/components/common/NavBar";
import CompanionBrowser from "@/components/companions/CompanionBrowser";
import { COMPANION_LIST_PAGE_TITLE } from "@/lib/constants/companions";
import {
  listCompanionGameOptions,
  queryCompanionPage,
  resolveCompanionListQuery,
} from "@/lib/services/companions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 寻找陪玩（陪玩列表）。**游客可访问**。
 *
 * 二级页面：在 `(tabs)` 之外，顶部返回、**不带底部 TabBar**。
 *
 * 这里**刻意不用 `RequireAuth`**：陪玩名单是浏览型内容，与商品列表同类，
 * 看名单不应该被迫登录。页面不读会话，因此也没有任何身份相关的判断。
 *
 * 首屏由服务端取好后交给 `CompanionBrowser`：客户端不在挂载时再请求一次，
 * 因此没有加载闪烁；之后的搜索、筛选与翻页都由用户操作触发。
 *
 * 关于筛选参数：**页面侧宽松、接口侧严格**。
 * `?availability=xxx` / `?gameId=不存在的游戏` 这类坏值在这里被规范化到默认值
 * （一个手改坏的地址不该变成错误页），而 `GET /api/companions` 收到同样的值会返回 400。
 * 两处口径的差别只存在于这一行调用上，过滤规则本身只有数据层那一份。
 *
 * 游戏筛选项取自**服务端真实游戏目录**（`listCompanionGameOptions`），
 * 页面组件不写死第二份名单——写死的那一份迟早会与数据分叉，
 * 表现就是「界面上能选、点进去却是空结果」。
 *
 * Mock 参数原样传下去：`?mockEmpty=companions` 演示空名单，
 * `?mockError=1` 演示取数失败（两个都只在 `ENABLE_MOCK_DEBUG=true` 时生效）。
 *
 * ⚠️ **本页放在路由组 `(list)` 里，而不是直接放在 `app/companions/` 下：**
 * 路由组不产生 URL 段（地址仍然是 `/companions`），它存在的唯一理由是**把加载边界
 * 收在本页范围内**。加载边界是「页面挂起前先以 200 发出外壳」，而 `app/companions/[id]`
 * 一旦被它罩住，那里迟到的 `notFound()` 就只能改页面内容、改不了已经发出的状态码——
 * 「不存在的陪玩」会变成一屏 200 的 404 文案。分成同级的两个段之后，
 * 列表照旧有加载态与错误重试，详情照旧是真实的 404，两边的规则互不干扰。
 */
export default async function CompanionsPage({ searchParams }: PageProps<"/companions">) {
  const params = toSearchParams(await searchParams);

  const [games, query] = await Promise.all([
    listCompanionGameOptions(),
    resolveCompanionListQuery(params, false),
  ]);

  const initialPage = await queryCompanionPage(query, params, "server");

  return (
    <>
      <NavBar title={COMPANION_LIST_PAGE_TITLE} showBack />
      <CompanionBrowser
        initialPage={initialPage}
        games={games}
        initialKeyword={query.keyword}
        initialGameId={query.gameId}
        initialAvailability={query.availability}
      />
    </>
  );
}
