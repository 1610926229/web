import { redirect } from "next/navigation";
import StaffComplaintTable from "@/components/staff/StaffComplaintTable";
import StaffRefreshButton from "@/components/staff/StaffRefreshButton";
import { STAFF_COMPLAINTS_PAGE_TITLE } from "@/lib/constants/staff";
import { STAFF_COMPLAINT_LIST_NOTICE } from "@/lib/constants/staffComplaints";
import { getStaffSession } from "@/lib/services/staffAuth";
import {
  queryStaffComplaintList,
  resolveStaffComplaintListQuery,
} from "@/lib/services/staffComplaints";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台投诉列表（`/staff/complaints`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：地址栏是客服随手改得动的地方，
 * 写错一个筛选值该回到默认，而不是给一屏 400。接口那边是严格模式，两者刻意不同。
 *
 * ⚠️ 本页**只读**：处理动作在详情页——那里才看得到正文、凭证与联系方式。
 * 列表上放「解决」按钮等于让人在没读过投诉内容的情况下写结论。
 */
export default async function StaffComplaintsPage({
  searchParams,
}: PageProps<"/staff/complaints">) {
  const staff = await getStaffSession();
  // 正常路径上不会到这里（布局已经把匿名请求转走了）。留一条兜底。
  if (!staff) redirect("/staff/login");

  const params = toSearchParams(await searchParams);
  const query = await resolveStaffComplaintListQuery(params, false);
  const data = await queryStaffComplaintList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{STAFF_COMPLAINTS_PAGE_TITLE}</h1>
          <p className="mt-2 max-w-4xl text-[13px] leading-5 text-ink-3">
            {STAFF_COMPLAINT_LIST_NOTICE}
          </p>
        </div>
        <StaffRefreshButton />
      </div>

      <StaffComplaintTable
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
