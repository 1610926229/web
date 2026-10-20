import Link from "next/link";
import AdminCouponTemplateTable from "@/components/admin/AdminCouponTemplateTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COUPONS_PAGE_TITLE } from "@/lib/constants/admin";
import {
  ADMIN_COUPON_COMPUTABLE_NOTICE,
  ADMIN_COUPON_NEW_TITLE,
} from "@/lib/constants/adminCoupons";
import {
  queryAdminCouponTemplateList,
  resolveCouponTemplateListQuery,
} from "@/lib/services/adminCouponTemplates";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 优惠券管理（`/admin/coupons`）。
 *
 * 看到的是**全部**券模板：启用中的、停用的、满减的、历史的折扣券与无门槛券。
 * 用户端领券中心只出现「启用且可领」的那些，但两者读的是**同一份数据源**——
 * 因此这里改完刷新，前台立刻是新值，不需要任何同步动作。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?enabled=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是整页报错。接口用严格模式——调用方是程序，静默当成「全部」
 * 会让它拿着不知道筛了什么的结果继续往下用。
 *
 * ⚠️ **发放是另一条路**（`/admin/coupons/grant`）：这一页写的是券模板（`Coupon`），
 * 发放写的是领取记录（`CouponClaim`）。放同一个页面上会让人分不清
 * 「改了这张券」与「给这个人发了一张券」哪个动作产生了哪条记录。
 */
export default async function AdminCouponsPage({ searchParams }: PageProps<"/admin/coupons">) {
  const params = toSearchParams(await searchParams);
  const query = resolveCouponTemplateListQuery(params, false);
  const data = await queryAdminCouponTemplateList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_COUPONS_PAGE_TITLE} description={data.notice}>
        <Link
          href="/admin/coupons/grant"
          className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          去发放
        </Link>
        <Link
          href="/admin/coupons/new"
          className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          {ADMIN_COUPON_NEW_TITLE}
        </Link>
      </AdminPageHeading>

      <p className="text-[12px] leading-4 text-ink-3">{ADMIN_COUPON_COMPUTABLE_NOTICE}</p>

      <AdminCouponTemplateTable
        initialFilters={{
          keyword: query.keyword,
          enabled: query.enabled,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
