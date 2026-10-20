import { notFound } from "next/navigation";
import AdminCouponTemplateConsole from "@/components/admin/AdminCouponTemplateConsole";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COUPONS_PAGE_TITLE } from "@/lib/constants/admin";
import { ADMIN_COUPON_DETAIL_TITLE } from "@/lib/constants/adminCoupons";
import { getAdminCouponTemplateDetail } from "@/lib/services/adminCouponTemplates";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 券模板详情与编辑（`/admin/coupons/[id]`）。
 *
 * ⚠️ **已停用的模板照样打开**：后台要能查看并重新启用它。返回 404 等于把
 * 「停用」做成了记录消失，而那正是 §6 不肯做硬删除要避免的事。
 *
 * 页面本身只负责取数：详情 DTO 从这里进客户端组件，写操作全在
 * `AdminCouponTemplateConsole` 里——它是这一页唯一的写入口。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。
 */
export default async function AdminCouponDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/coupons/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const coupon = await getAdminCouponTemplateDetail(id, query, "server");
  if (!coupon) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COUPON_DETAIL_TITLE}
        backHref="/admin/coupons"
        backLabel={ADMIN_COUPONS_PAGE_TITLE}
      />

      <AdminCouponTemplateConsole record={coupon} />
    </div>
  );
}
