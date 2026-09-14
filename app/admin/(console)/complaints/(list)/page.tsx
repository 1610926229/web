import AdminComplaintTable from "@/components/admin/AdminComplaintTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COMPLAINT_LIST_TITLE } from "@/lib/constants/adminComplaints";
import {
  queryAdminComplaintList,
  resolveAdminComplaintListQuery,
} from "@/lib/services/adminComplaints";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 投诉处理（`/admin/complaints`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`），理由与其它管理列表相同：
 * 地址栏是用户随手改得动的地方，写错一个筛选值该回到默认，而不是给一屏 400。
 *
 * ⚠️ 本页**只读**：处理动作在详情页——那里才看得到正文、凭证与联系方式。
 * 列表上放「解决」按钮等于让人在没读过投诉内容的情况下写结论。
 */
export default async function AdminComplaintsPage({
  searchParams,
}: PageProps<"/admin/complaints">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminComplaintListQuery(params, false);
  const data = await queryAdminComplaintList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_COMPLAINT_LIST_TITLE} description={data.notice} />

      <AdminComplaintTable
        initialFilters={{
          status: query.status,
          type: query.type,
          keyword: query.keyword,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
