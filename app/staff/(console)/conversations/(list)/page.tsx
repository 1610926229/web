import { redirect } from "next/navigation";
import StaffConversationTable from "@/components/staff/StaffConversationTable";
import StaffRefreshButton from "@/components/staff/StaffRefreshButton";
import {
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_CONVERSATION_LIST_NOTICE,
} from "@/lib/constants/staff";
import { getStaffSession } from "@/lib/services/staffAuth";
import {
  listConversationsForStaff,
  resolveStaffConversationListQuery,
} from "@/lib/services/staffConversations";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台会话列表（`/staff/conversations`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：地址栏是客服随手改得动的地方，
 * 写错一个筛选值该回到默认，而不是给一屏 400。接口那边是严格模式，两者刻意不同。
 *
 * ⚠️ 取数用的是**当前登录客服**的 `staff.id`（会话里读出来的那份），
 * 地址栏里没有任何东西能影响「以谁的身份看」。因此打开别人发来的链接，
 * 看到的仍然是自己的未读口径。
 */
export default async function StaffConversationsPage({
  searchParams,
}: PageProps<"/staff/conversations">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const params = toSearchParams(await searchParams);
  const query = resolveStaffConversationListQuery(params, false);
  const data = await listConversationsForStaff(staff.id, query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{STAFF_CONVERSATIONS_PAGE_TITLE}</h1>
          <p className="mt-2 max-w-4xl text-[13px] leading-5 text-ink-3">
            {STAFF_CONVERSATION_LIST_NOTICE}
          </p>
        </div>
        <StaffRefreshButton />
      </div>

      <StaffConversationTable
        initialFilters={{
          keyword: query.keyword,
          unreadOnly: query.unreadOnly,
          status: query.status,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
