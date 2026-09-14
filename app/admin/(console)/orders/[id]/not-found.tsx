import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_ORDER_DETAIL_TITLE,
  ADMIN_ORDER_LIST_TITLE,
  ADMIN_ORDER_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminOrders";

/**
 * 订单不存在（订单号取不到数据，链接失效或记录已被清理）。
 *
 * 退路指向订单列表而不是后台首页：客服是从列表点进来的，回到列表更接近他原本在做的事。
 */
export default function AdminOrderNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_ORDER_DETAIL_TITLE}
        backHref="/admin/orders"
        backLabel={ADMIN_ORDER_LIST_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_ORDER_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这个订单号在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
          期间产生的订单会消失。
        </p>
        <Link
          href="/admin/orders"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回订单列表
        </Link>
      </div>
    </div>
  );
}
