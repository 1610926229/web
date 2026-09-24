/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { ORDER_STATUS_CLASS } from "@/lib/constants/orders";
import type { CompanionOrderListItem } from "@/lib/types/order";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 「我的订单」里的一张单（P0-6）。
 *
 * 整张卡是一个链接（内部不再嵌套链接），点哪里都进详情——取消接单这个动作只在
 * 详情页上，因此列表这一层不需要任何按钮，也就不需要是个客户端组件。
 *
 * ⚠️ **不显示任何金额**：这一条不是「先这样、以后加」，而是 `CompanionOrderListItem`
 * 里**根本没有**金额字段（平台净收入 / 护航收益 / 分账比例 / 已退金额都不在打手端
 * DTO 上）。要显示金额，先得改 DTO——那是服务端的事，不能在页面上凑一个。
 *
 * ⚠️ **不渲染 `canCancel`**：按钮长在详情页上；而且在列表里它只是列表渲染那一刻的值，
 * 从看到列表到点进详情之间状态可能已经变了（被别人接走的是另一单，但同样这一单
 * 也可能已经开始服务）。列表显示**已经发生的事实**，能不能点由详情页回答。
 *
 * ⚠️ **不显示「服务要求」**：订单模型上没有这个字段（用户提交的就是备注），
 * 详情页显示的也是 `remark`。列表更不该出现一个永远读不到内容的字段。
 */
export default function CompanionOrderCard({ order }: { order: CompanionOrderListItem }) {
  return (
    <Link
      href={`/companion/orders/${order.id}`}
      className="block rounded-2xl border border-line px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {order.orderNo}
        </span>
        {/* 状态中文名由服务端给（`ORDER_STATUS_LABELS`），颜色只从 `ORDER_STATUS_CLASS` 取 */}
        <span className={`shrink-0 text-[13px] font-medium ${ORDER_STATUS_CLASS[order.status]}`}>
          {order.statusLabel}
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

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-[12px] text-ink-3">
        <span>游戏：{order.gameName}</span>
        <span>大区：{order.region}</span>
      </div>

      <div className="mt-1 flex items-end gap-2">
        <div className="min-w-0 flex-1 text-[12px] text-ink-3">
          <p>下单：{formatDateTime(order.paidAt)}</p>
          {/* 接单时间缺失（历史数据）时不编一个出来，也不留一行空值 */}
          {order.acceptedAt ? <p>接单：{formatDateTime(order.acceptedAt)}</p> : null}
        </div>
        <span className="shrink-0 text-[12px] text-brand-red">查看详情 ›</span>
      </div>
    </Link>
  );
}
