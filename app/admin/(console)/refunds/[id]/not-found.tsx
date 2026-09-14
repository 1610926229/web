import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_REFUND_DETAIL_TITLE,
  ADMIN_REFUND_LIST_TITLE,
  ADMIN_REFUND_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminRefunds";

/**
 * 退款申请不存在（退款单号取不到数据，链接失效或记录已被清理）。
 *
 * 退路指向退款列表而不是后台首页：客服是从列表点进来处理待办的，回到列表更接近他原本在做的事。
 *
 * ⚠️ 这里**不区分**「不存在」与「关联订单丢失」：后者在管理端被当作不可读记录处理
 * （见 `lib/services/adminRefunds.ts`），对管理员的结果与不存在相同——
 * 不给出「存在但读不了」这种可以拿来探测的回答。
 */
export default function AdminRefundNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_REFUND_DETAIL_TITLE}
        backHref="/admin/refunds"
        backLabel={ADMIN_REFUND_LIST_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_REFUND_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这个退款单号在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
          期间产生的退款申请会消失。
        </p>
        <Link
          href="/admin/refunds"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回退款列表
        </Link>
      </div>
    </div>
  );
}
