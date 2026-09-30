import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPANION_ORDER_DETAIL_PAGE_TITLE,
  COMPANION_ORDER_NOT_FOUND_DESCRIPTION,
  COMPANION_ORDER_NOT_FOUND_MESSAGE,
  COMPANION_ORDERS_BACK_LABEL,
} from "@/lib/constants/dispatch";

/**
 * 订单详情取不到（`notFound()`）—— 订单不存在，**或**它不是当前打手正在履约的单。
 *
 * ⚠️ 两种情况**必须显示同一页、同一句话**：页面能区分它们，就等于能拿别人的订单 id
 * 试探它是否存在（api-contract §2.9）。`COMPANION_ORDER_NOT_FOUND_MESSAGE` 的措辞
 * 因此是「订单不存在或不可操作」，而不是「这不是你的订单」。
 *
 * 本文件位于 `(console)` 路由组内，因此仍然套着工作台壳层（顶栏导航照常可用），
 * 但**不是**一个 200 的页面：详情页没有挂 `loading.tsx`，`notFound()` 会正常以 404 发出。
 *
 * 退路指向「我的订单」而不是工作台首页：他是从列表点进来的，回到列表更接近原本在做的事。
 * 与 `app/admin/(console)/orders/[id]/not-found.tsx` 同一个取舍。
 */
export default function CompanionOrderNotFound() {
  return (
    <>
      <h2 className="text-[14px] font-semibold text-ink">{COMPANION_ORDER_DETAIL_PAGE_TITLE}</h2>

      <EmptyState
        title={COMPANION_ORDER_NOT_FOUND_MESSAGE}
        description={COMPANION_ORDER_NOT_FOUND_DESCRIPTION}
      />

      <div className="flex justify-center pb-2">
        <Link
          href="/companion/orders"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          {COMPANION_ORDERS_BACK_LABEL}
        </Link>
      </div>
    </>
  );
}
