import CategoryBrowser from "@/components/catalog/CategoryBrowser";
import EmptyState from "@/components/common/EmptyState";
import { getGames, queryProducts } from "@/lib/services/catalog";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 分类页（免登录，属于底部 Tab）。
 *
 * 服务端只做两件事：取回游戏/类目，以及按 URL 上的 `gameId` / `categoryId` 取回首屏商品，
 * 首屏 HTML 里就有商品数据。之后的切换、搜索、加载更多都发生在 `CategoryBrowser` 里，
 * 经 `/api/catalog/products` 调用与这里**同一个** service。
 *
 * 页面自身没有顶部标题栏，与原型一致：搜索行即是页面顶部。
 */
export default async function CategoryPage({ searchParams }: PageProps<"/category">) {
  // 查询参数同时承载两个用途：外部传入的初始类目（deep link）与 Mock 调试参数
  const query = toSearchParams(await searchParams);

  const games = await getGames();
  const requestedGameId = query.get("gameId") ?? "";
  const game = games.find((item) => item.id === requestedGameId) ?? games[0];

  if (!game) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface px-4 py-16">
        <EmptyState title="暂无分类" description="分类配置尚未就绪，请稍后再来。" />
      </div>
    );
  }

  // 请求的类目不属于当前游戏时回落到第一个类目，避免左侧竖栏没有选中项
  const requestedCategoryId = query.get("categoryId") ?? "";
  const categoryId = game.categories.some((item) => item.id === requestedCategoryId)
    ? requestedCategoryId
    : (game.categories[0]?.id ?? "");

  const initialResult = await queryProducts({ gameId: game.id, categoryId }, query, "server");

  return (
    <CategoryBrowser
      games={games}
      initialGameId={game.id}
      initialCategoryId={categoryId}
      initialResult={initialResult}
    />
  );
}
