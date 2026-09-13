import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import SuggestionList from "@/components/suggestions/SuggestionList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { SUGGESTION_PAGE_TITLE } from "@/lib/constants/suggestions";
import { querySuggestionsForUser } from "@/lib/services/suggestions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 功能建议（需登录）。
 *
 * 二级页面：在 `(tabs)` 之外，用顶部返回、**不带底部 TabBar**。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页，登录后地址仍是 `/suggestions`。
 * 右上角的 ＋ 是原型里的新增入口，进入 `/suggestions/new`。
 *
 * 本阶段**没有状态筛选**（原型上没有），因此地址里只有分页参数，首屏取第一页，
 * 其余页由 `SuggestionList` 以浏览器请求完成，两条链路共用 `lib/services/suggestions.ts`。
 * 分页参数非法（例如 `?page=abc`）会被规范化成第一页，不会把整页变成错误页。
 */
export default async function SuggestionsPage({ searchParams }: PageProps<"/suggestions">) {
  const query = toSearchParams(await searchParams);

  return (
    <>
      <NavBar
        title={SUGGESTION_PAGE_TITLE}
        showBack
        right={
          <Link
            href="/suggestions/new"
            aria-label="新增反馈"
            className="seg-tab-active flex h-8 w-8 items-center justify-center rounded-full text-[18px] leading-none"
          >
            ＋
          </Link>
        }
      />

      <RequireAuth>
        {(user) => <SuggestionsBody userId={user.id} params={query} />}
      </RequireAuth>
    </>
  );
}

async function SuggestionsBody({ userId, params }: { userId: string; params: URLSearchParams }) {
  // 首屏只取**当前页码**那一页：取多份会让「加载中 / 空 / 出错重试」这几个状态永远看不到
  const result = await querySuggestionsForUser(userId, params, "server");

  return <SuggestionList initialPage={result} />;
}
