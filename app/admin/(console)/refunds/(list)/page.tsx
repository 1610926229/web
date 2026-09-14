import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminRefundTable from "@/components/admin/AdminRefundTable";
import { ADMIN_REFUND_LIST_TITLE } from "@/lib/constants/adminRefunds";
import { queryAdminRefundList, resolveAdminRefundListQuery } from "@/lib/services/adminRefunds";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 退款审核（`/admin/refunds`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`），理由与订单列表相同。
 *
 * ⚠️ 本页**只读**：审核动作在详情页——那里才看得到退款原因、说明与凭证。
 * 列表上放「通过」按钮等于让人闭着眼睛批准一笔会真的把订单改成已退款的写入。
 */
export default async function AdminRefundsPage({ searchParams }: PageProps<"/admin/refunds">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminRefundListQuery(params, false);
  const data = await queryAdminRefundList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_REFUND_LIST_TITLE} description={data.notice} />

      <AdminRefundTable
        initialFilters={{ status: query.status, keyword: query.keyword, page: query.page }}
        initialResult={data}
      />
    </div>
  );
}
