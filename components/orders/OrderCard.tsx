/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import PriceText from "@/components/common/PriceText";
import { ORDER_STATUS_CLASS, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import type { OrderListItem } from "@/lib/types/order";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 订单列表卡片。
 *
 * 展示的全部是**下单时的快照**：商品名、封面、规格、金额与打手信息都来自订单本身，
 * 因此商品改名改价下架、打手改名换头像，都不会让历史订单的展示变样。
 *
 * 未绑定打手时显示「等待接单」，**不编造一个打手出来**——有没有人接单是用户最关心的信息之一。
 *
 * 整张卡片是一个链接（内部不再嵌套链接），点哪里都进详情。
 * 长商品名用 `line-clamp-2` 裁切，长规格名用 `truncate`，都不会把卡片撑变形。
 */
export default function OrderCard({ order }: { order: OrderListItem }) {
  return (
    <Link href={`/orders/${order.id}`} className="block rounded-[10px] bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {order.orderNo}
        </span>
        <span className={`shrink-0 text-[13px] font-medium ${ORDER_STATUS_CLASS[order.status]}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>

      <div className="mt-2 flex gap-3">
        <img
          src={order.productCoverUrl}
          alt={order.productTitle}
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
            {order.productTitle}
          </h3>
          <p className="mt-1 truncate text-[12px] text-ink-3">{order.specName}</p>
          <p className="mt-auto pt-1 text-[12px] text-ink-3">数量 ×{order.quantity}</p>
        </div>
      </div>

      <div className="mt-2 flex items-end gap-2 border-t border-line pt-2">
        <div className="min-w-0 flex-1">
          {order.companion ? (
            <span className="flex items-center gap-1.5">
              <img
                src={order.companion.avatarUrl}
                alt=""
                loading="lazy"
                className="h-4 w-4 shrink-0 rounded-full"
              />
              <span className="truncate text-[12px] text-ink-2">
                打手 {order.companion.name}
              </span>
            </span>
          ) : (
            <span className="text-[12px] text-ink-3">等待接单</span>
          )}
          <p className="mt-0.5 text-[12px] text-ink-3">{formatDateTime(order.paidAt)}</p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-[12px] text-ink-3">
            实付 <PriceText cents={order.totalAmount} className="text-[15px] text-ink" />
          </p>
          <p className="mt-0.5 text-[12px] text-brand-red">查看详情 ›</p>
        </div>
      </div>
    </Link>
  );
}
