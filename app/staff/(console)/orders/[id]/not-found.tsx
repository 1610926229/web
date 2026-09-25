import Link from "next/link";
import { STAFF_ORDERS_PAGE_TITLE, STAFF_ORDER_NOT_FOUND_MESSAGE } from "@/lib/constants/staff";

/**
 * 订单不存在（`/staff/orders/[id]`）。
 *
 * ⚠️ 这里说的是「订单不存在」，而**不是**「你没有权限看这一单」——
 * 两者刻意不可区分：客服可以按订单号查全量订单，若「存在但无权」与「不存在」
 * 给出不同的话，就等于给出一个「拿订单号试探平台上有哪些订单」的信号。
 *
 * ⚠️ 文案与接口 404 的 message 同源（`STAFF_ORDER_NOT_FOUND_MESSAGE`）：
 * 页面上和接口里说两句话，会让人以为遇到了两种不同的问题。
 */
export default function StaffOrderNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-ink">{STAFF_ORDER_NOT_FOUND_MESSAGE}</h1>
      <p className="max-w-2xl text-[13px] leading-5 text-ink-3">
        订单号写错、这一单已经被移除，或者它本来就不属于平台上的任何一笔订单，
        看到的都是这一页。订单列表里可以按订单号、用户昵称、平台 ID 或商品名重新查一次。
      </p>
      <Link
        href="/staff/orders"
        className="self-start rounded-lg border border-admin-line px-5 py-2 text-[13px] text-ink-2 hover:bg-page"
      >
        返回{STAFF_ORDERS_PAGE_TITLE}
      </Link>
    </div>
  );
}
