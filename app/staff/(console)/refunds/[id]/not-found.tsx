import Link from "next/link";
import { STAFF_REFUNDS_PAGE_TITLE } from "@/lib/constants/staff";
import { STAFF_REFUND_NOT_FOUND_MESSAGE } from "@/lib/constants/staffRefunds";

/**
 * 退款申请不存在（`/staff/refunds/[id]`）。
 *
 * ⚠️ 文案与接口 404 的 message 同源（`STAFF_REFUND_NOT_FOUND_MESSAGE`）：
 * 页面上和接口里说两句话，会让人以为遇到了两种不同的问题。
 */
export default function StaffRefundNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-ink">{STAFF_REFUND_NOT_FOUND_MESSAGE}</h1>
      <p className="max-w-2xl text-[13px] leading-5 text-ink-3">
        没有找到这条退款申请。它可能被写错了单号，也可能在别处已经被处理或撤回。
      </p>
      <Link
        href="/staff/refunds"
        className="self-start rounded-lg border border-admin-line px-5 py-2 text-[13px] text-ink-2 hover:bg-page"
      >
        返回{STAFF_REFUNDS_PAGE_TITLE}
      </Link>
    </div>
  );
}
