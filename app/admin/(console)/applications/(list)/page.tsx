import AdminApplicationTable from "@/components/admin/AdminApplicationTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_APPLICATIONS_PAGE_TITLE } from "@/lib/constants/admin";
import {
  queryAdminApplicationList,
  resolveAdminApplicationListQuery,
} from "@/lib/services/adminCompanionApplications";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 入驻审核（`/admin/applications`）。
 *
 * 取数与聚合全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」，
 * 不自己过滤、不自己排序、不自己算角标。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?status=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是抛 400 变成错误页。接口用严格模式——接口的调用方是程序，
 * 静默把非法值当成「全部」返回，会让它拿着不知道筛了什么的结果继续往下用。
 *
 * 首屏数据通过 `initialResult` 进入客户端组件，之后筛选与翻页由它在浏览器里发起请求，
 * 因此从首页点进筛选卡片的链接（`/admin/applications?status=pending`）能直接落在正确的筛选上。
 *
 * ⚠️ 本页**只读**：审核动作用户必须进详情页，那里才能看到申请正文与申请人摘要。
 */
export default async function AdminApplicationsPage({
  searchParams,
}: PageProps<"/admin/applications">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminApplicationListQuery(params, false);
  const data = await queryAdminApplicationList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_APPLICATIONS_PAGE_TITLE} description={data.notice} />

      <AdminApplicationTable
        initialFilters={{
          status: query.status,
          keyword: query.keyword,
          gameId: query.gameId,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
