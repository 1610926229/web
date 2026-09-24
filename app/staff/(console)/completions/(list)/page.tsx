import { redirect } from "next/navigation";
import StaffRefreshButton from "@/components/staff/StaffRefreshButton";
import StaffCompletionTable from "@/components/staff/StaffCompletionTable";
import {
  STAFF_COMPLETION_DETAIL_TITLE,
  STAFF_COMPLETION_LIST_NOTICE,
} from "@/lib/constants/staffCompletions";
import { getStaffSession } from "@/lib/services/staffAuth";
import {
  listStaffCompletions,
  resolveStaffCompletionListQuery,
} from "@/lib/services/staffCompletions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台完成材料列表（`/staff/completions`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：地址栏是客服随手改得动的地方，
 * 写错一个筛选值该回到默认，而不是给一屏 400。接口那边是严格模式，两者刻意不同。
 */
export default async function StaffCompletionsPage({
  searchParams,
}: PageProps<"/staff/completions">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const params = toSearchParams(await searchParams);
  const query = resolveStaffCompletionListQuery(params, false);
  const data = await listStaffCompletions(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{STAFF_COMPLETION_DETAIL_TITLE}</h1>
          <p className="mt-2 max-w-4xl text-[13px] leading-5 text-ink-3">
            {STAFF_COMPLETION_LIST_NOTICE}
          </p>
        </div>
        <StaffRefreshButton />
      </div>

      <StaffCompletionTable
        initialFilters={{
          status: query.status,
          keyword: query.keyword,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
