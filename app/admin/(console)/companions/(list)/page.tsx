import AdminCompanionTable from "@/components/admin/AdminCompanionTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COMPANIONS_PAGE_TITLE } from "@/lib/constants/admin";
import { queryAdminCompanionList, resolveAdminCompanionListQuery } from "@/lib/services/adminCompanions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 护航管理（`/admin/companions`）。
 *
 * 看到的是**全部**记录：在架的、暂停接单的、已停用的、已移除的。
 * 用户端公开列表只出现在架且未移除的，但两者读的是**同一份数据源**——
 * 因此这里改完刷新，前台立刻是新值，不需要任何同步动作。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?state=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是整页报错。接口用严格模式——调用方是程序，静默当成「全部」
 * 会让它拿着不知道筛了什么的结果继续往下用。
 *
 * `state` 参数名与概览卡片的链接一致（`/admin/companions?state=unavailable`）。
 */
export default async function AdminCompanionsPage({
  searchParams,
}: PageProps<"/admin/companions">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminCompanionListQuery(params, false);
  const data = await queryAdminCompanionList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_COMPANIONS_PAGE_TITLE} description={data.notice} />

      <AdminCompanionTable
        initialFilters={{
          keyword: query.keyword,
          gameId: query.gameId,
          state: query.state,
          removal: query.removal,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
