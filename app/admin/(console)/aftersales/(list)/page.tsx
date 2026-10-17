import AdminAftersaleTable from "@/components/admin/AdminAftersaleTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_AFTERSALE_LIST_TITLE } from "@/lib/constants/adminAftersales";
import {
  queryAdminAftersaleList,
  resolveAdminAftersaleListQuery,
} from "@/lib/services/adminAftersales";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 售后统一工作台（`/admin/aftersales`）。
 *
 * 退款申请与投诉的**混合**列表：客服不必先想「这是退款还是投诉」再决定去哪一页，
 * 他手里通常只有一个订单号或一个用户昵称。两套**处置动作没有被搬过来**——
 * 仍然是各自的专用页面，本页只负责把人送到那一页。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`），理由与其它管理列表相同：
 * 地址栏是用户随手改得动的地方，写错一个筛选值该回到默认，而不是给一屏 400。
 */
export default async function AdminAftersalesPage({
  searchParams,
}: PageProps<"/admin/aftersales">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminAftersaleListQuery(params, false);
  const data = await queryAdminAftersaleList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_AFTERSALE_LIST_TITLE} description={data.notice} />

      <AdminAftersaleTable
        initialFilters={{
          view: query.view,
          caseType: query.caseType,
          keyword: query.keyword,
          from: query.from,
          to: query.to,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
