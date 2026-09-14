import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminStaffConsole from "@/components/admin/AdminStaffConsole";
import { ADMIN_STAFF_DETAIL_PAGE_TITLE, ADMIN_STAFF_LIST_TITLE } from "@/lib/constants/adminStaff";
import { getAdminStaffDetail } from "@/lib/services/adminStaff";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服账号详情（`/admin/customer-service/[id]`）。
 *
 * 这一页是客服账号的**唯一写入口**：状态动作（启用 / 停用 / 移除）与资料编辑表单
 * 都在 `AdminStaffConsole` 里，两者共用一条刷新路径，页面永远显示服务端的最新值。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 *
 * ⚠️ 不存在返回 404：**「已移除」不是 404**——记录还在，只是不能再登录。
 * 移除后仍然要进得来这一页，否则运营没法确认「它到底被移除了没有」。
 */
export default async function AdminCustomerServiceDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/customer-service/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const staff = await getAdminStaffDetail(id, query, "server");
  if (!staff) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_STAFF_DETAIL_PAGE_TITLE}
        backHref="/admin/customer-service"
        backLabel={ADMIN_STAFF_LIST_TITLE}
      />

      <AdminStaffConsole record={staff} />
    </div>
  );
}
