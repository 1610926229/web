import NavBar from "@/components/common/NavBar";
import FavoriteList from "@/components/favorites/FavoriteList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { queryFavoritesForUser } from "@/lib/services/favorites";

/**
 * 商品收藏（需登录）。
 *
 * 二级页面：在 `(tabs)` 之外，用顶部返回、**不带底部 TabBar**。
 * 首屏由服务端直接取（不 HTTP 请求自己的接口），加载更多与移除由 `FavoriteList`
 * 以浏览器请求完成，两条链路共用 `lib/services/favorites.ts` 的同一个函数。
 *
 * 列表只可能是**当前用户**的收藏：用户身份来自会话，本页不接受任何地址参数，
 * 仓储查询本身也按 userId 过滤。地址里的分页参数不读——首屏固定第 1 页，
 * 与客户端初始状态一致，否则「加载更多」会和首屏那一页重叠。
 */
export default function FavoritesPage() {
  return (
    <>
      <NavBar title="商品收藏" showBack />

      <RequireAuth>
        {(user) => <FavoritesBody userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function FavoritesBody({ userId }: { userId: string }) {
  // 服务端首屏不注入 Mock 故障参数：一个查询参数就把整页打成错误页不是想要的调试体验
  const result = await queryFavoritesForUser(userId, new URLSearchParams(), "server");

  return <FavoriteList initialResult={result} />;
}
