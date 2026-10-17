import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_REVIEWS_DETAIL_TITLE, ADMIN_REVIEWS_PAGE_TITLE } from "@/lib/constants/admin";
import { ADMIN_REVIEW_NOT_FOUND_MESSAGE } from "@/lib/constants/adminReviews";

/**
 * 评价不存在（评价编号取不到数据，链接失效或记录已被清理）。
 *
 * 退路指向评价列表而不是后台首页：管理员是从列表点进来处理待办的，回到列表更接近他原本在做的事。
 */
export default function AdminReviewNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_REVIEWS_DETAIL_TITLE}
        backHref="/admin/reviews"
        backLabel={ADMIN_REVIEWS_PAGE_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_REVIEW_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这条评价在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
          期间产生的评价会消失。
        </p>
        <Link
          href="/admin/reviews"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回评价列表
        </Link>
      </div>
    </div>
  );
}
