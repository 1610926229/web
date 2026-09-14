import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_COMPLAINT_DETAIL_TITLE,
  ADMIN_COMPLAINT_LIST_TITLE,
  ADMIN_COMPLAINT_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminComplaints";

/**
 * 投诉不存在（投诉编号取不到数据，链接失效或记录已被清理）。
 *
 * 退路指向投诉列表而不是后台首页：客服是从列表点进来处理待办的，回到列表更接近他原本在做的事。
 *
 * ⚠️ 只有「这条投诉读不到」会走到这里。**关联订单丢失不会**：
 * 那种情况下详情照常打开，只是订单摘要显示为「没有关联订单」
 * （见 `lib/services/adminComplaints.ts`）——投诉本身的内容仍然要能被处理。
 */
export default function AdminComplaintNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COMPLAINT_DETAIL_TITLE}
        backHref="/admin/complaints"
        backLabel={ADMIN_COMPLAINT_LIST_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_COMPLAINT_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这条投诉在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
          期间产生的投诉会消失。
        </p>
        <Link
          href="/admin/complaints"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回投诉列表
        </Link>
      </div>
    </div>
  );
}
