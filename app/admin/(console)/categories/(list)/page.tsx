import Link from "next/link";
import AdminCategoryTable from "@/components/admin/AdminCategoryTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_CATEGORY_LIST_TITLE,
  ADMIN_CATEGORY_NEW_TITLE,
} from "@/lib/constants/adminCategories";
import { queryAdminCategoryList, resolveAdminCategoryListQuery } from "@/lib/services/adminCategories";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 类目管理（`/admin/categories`）。
 *
 * 看到的是**全部**类目：启用中的、停用的、已移除的。用户端分类导航只出现在
 * 「启用且未移除」的那些，但两者读的是**同一份数据源**——因此这里改完刷新，
 * 前台立刻是新值，不需要任何同步动作。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?enabled=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是整页报错。接口用严格模式——调用方是程序，静默当成「全部」
 * 会让它拿着不知道筛了什么的结果继续往下用。
 */
export default async function AdminCategoriesPage({
  searchParams,
}: PageProps<"/admin/categories">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminCategoryListQuery(params, false);
  const data = await queryAdminCategoryList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_CATEGORY_LIST_TITLE} description={data.notice}>
        <Link
          href="/admin/categories/new"
          className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          {ADMIN_CATEGORY_NEW_TITLE}
        </Link>
      </AdminPageHeading>

      <AdminCategoryTable
        initialFilters={{
          keyword: query.keyword,
          gameId: query.gameId,
          enabled: query.enabled,
          removal: query.removal,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
