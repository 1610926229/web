import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminStaffTable from "@/components/admin/AdminStaffTable";
import {
  ADMIN_STAFF_CREATE_LABEL,
  ADMIN_STAFF_LIST_TITLE,
} from "@/lib/constants/adminStaff";
import { queryAdminStaffList, resolveAdminStaffListQuery } from "@/lib/services/adminStaff";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服账号列表（`/admin/customer-service`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：地址栏是用户随手改得动的地方，
 * 写错一个筛选值该回到默认，而不是给一屏 400。接口那边是严格模式，两者刻意不同。
 *
 * ⚠️ 本页**只读**：新增在 `/admin/customer-service/new`，启停与移除在详情页——
 * 列表上放「停用」按钮等于让人在一行摘要上做有后果的决定。
 */
export default async function AdminCustomerServicePage({
  searchParams,
}: PageProps<"/admin/customer-service">) {
  const params = toSearchParams(await searchParams);
  const query = resolveAdminStaffListQuery(params, false);
  const data = await queryAdminStaffList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_STAFF_LIST_TITLE} description={data.notice}>
        <Link
          href="/admin/customer-service/new"
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white"
        >
          {ADMIN_STAFF_CREATE_LABEL}
        </Link>
      </AdminPageHeading>

      <AdminStaffTable
        initialFilters={{ state: query.state, keyword: query.keyword, page: query.page }}
        initialResult={data}
      />
    </div>
  );
}
