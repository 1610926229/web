import { notFound } from "next/navigation";
import AdminCompanionConsole from "@/components/admin/AdminCompanionConsole";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COMPANIONS_PAGE_TITLE } from "@/lib/constants/admin";
import { ADMIN_COMPANION_DETAIL_TITLE } from "@/lib/constants/adminCompanions";
import { getAdminCompanionDetail, getAdminCompanionFormOptions } from "@/lib/services/adminCompanions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 护航详情与编辑（`/admin/companions/[id]`）。
 *
 * ⚠️ **已移除的记录照样打开**：后台要能查到「这个人被移除过」。返回 404 等于把
 * 软删除做成了记录消失，而那正是软删除要避免的事——历史订单与评价都还指着它。
 *
 * 页面本身只负责取数：详情 DTO（含只读统计与关联信息）与游戏目录（含大区，
 * 编辑表单要据此限制大区选项）都从这里进客户端组件，写操作全在
 * `AdminCompanionConsole` 里——它是这一页唯一的写入口。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function AdminCompanionDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/companions/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const [companion, options] = await Promise.all([
    getAdminCompanionDetail(id, query, "server"),
    getAdminCompanionFormOptions(),
  ]);
  if (!companion) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COMPANION_DETAIL_TITLE}
        backHref="/admin/companions"
        backLabel={ADMIN_COMPANIONS_PAGE_TITLE}
      />

      <AdminCompanionConsole record={companion} games={options.games} />
    </div>
  );
}
