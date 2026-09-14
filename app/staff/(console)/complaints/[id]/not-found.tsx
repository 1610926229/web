import Link from "next/link";
import { STAFF_COMPLAINTS_PAGE_TITLE } from "@/lib/constants/staff";
import {
  STAFF_COMPLAINT_DETAIL_TITLE,
  STAFF_COMPLAINT_NOT_FOUND_MESSAGE,
} from "@/lib/constants/staffComplaints";

/**
 * 投诉不存在（投诉编号取不到数据，链接失效或记录已被清理）。
 *
 * 退路指向投诉列表而不是工作台首页：客服是从列表点进来处理待办的，回到列表更接近他原本在做的事。
 *
 * ⚠️ 只有「这条投诉读不到」会走到这里。**关联订单丢失不会**：
 * 那种情况下详情照常打开，只是订单摘要显示为「没有关联订单」
 * （见 `lib/services/staffComplaints.ts`）——投诉本身的内容仍然要能被处理。
 *
 * ⚠️ 文案与接口 404 的 message 同源（`STAFF_COMPLAINT_NOT_FOUND_MESSAGE`）：
 * 页面上和接口里说两句话，会让人以为遇到了两种不同的问题。
 */
export default function StaffComplaintNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-ink">{STAFF_COMPLAINT_DETAIL_TITLE}</h1>
      <p className="text-[14px] font-medium text-ink">{STAFF_COMPLAINT_NOT_FOUND_MESSAGE}</p>
      <p className="max-w-2xl text-[13px] leading-5 text-ink-3">
        这条投诉在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
        期间产生的投诉会消失。
      </p>
      <Link
        href="/staff/complaints"
        className="self-start rounded-lg border border-admin-line px-5 py-2 text-[13px] text-ink-2 hover:bg-page"
      >
        返回{STAFF_COMPLAINTS_PAGE_TITLE}
      </Link>
    </div>
  );
}
