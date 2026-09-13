import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminProductTable from "@/components/admin/AdminProductTable";
import { ADMIN_PRODUCT_LIST_TITLE, ADMIN_PRODUCT_NEW_TITLE } from "@/lib/constants/adminProducts";
import { queryAdminProductList, resolveAdminProductListQuery } from "@/lib/services/adminProducts";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 商品管理（`/admin/products`）。
 *
 * 看到的是**全部**商品：上架的、下架的、已移除的。用户端只看到「上架且未移除」的那些，
 * 但两者读的是**同一份数据源**——这里改完刷新，首页、分类页、详情与结算页立刻是新值，
 * 不需要任何同步动作；历史订单读的是下单快照，不受影响。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?status=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是整页报错。接口用严格模式——调用方是程序，静默当成「全部」
 * 会让它拿着不知道筛了什么的结果继续往下用。
 */
export default async function AdminProductsPage({
  searchParams,
}: PageProps<"/admin/products">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminProductListQuery(params, false);
  const data = await queryAdminProductList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_PRODUCT_LIST_TITLE} description={data.notice}>
        <Link
          href="/admin/products/new"
          className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          {ADMIN_PRODUCT_NEW_TITLE}
        </Link>
      </AdminPageHeading>

      <AdminProductTable
        initialFilters={{
          keyword: query.keyword,
          gameId: query.gameId,
          categoryId: query.categoryId,
          status: query.status,
          recommended: query.recommended,
          removal: query.removal,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
