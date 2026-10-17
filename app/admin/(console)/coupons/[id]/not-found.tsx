import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COUPONS_PAGE_TITLE } from "@/lib/constants/admin";
import {
  ADMIN_COUPON_DETAIL_TITLE,
  ADMIN_COUPON_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminCoupons";

/**
 * 优惠券不存在（id 取不到数据，链接失效）。
 *
 * 与「已停用」区分开：停用的券**仍然能打开详情**——它是有记录的状态，
 * 页面照常展示金额与时间，也能重新启用。这里是连记录都取不到。
 */
export default function AdminCouponNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COUPON_DETAIL_TITLE}
        backHref="/admin/coupons"
        backLabel={ADMIN_COUPONS_PAGE_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_COUPON_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这个券 id 在本地 Mock 数据里不存在。新建的券在开发服务器重启后也会消失
          （内存存储不做持久化，重启恢复种子数据）。
        </p>
        <Link
          href="/admin/coupons"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回优惠券管理
        </Link>
      </div>
    </div>
  );
}
