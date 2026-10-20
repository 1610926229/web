/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import {
  COMPANION_ORDER_INCOME_LABEL,
  COMPANION_ORDER_INCOME_REFUNDED_NOTE,
  ORDER_STATUS_CLASS,
} from "@/lib/constants/orders";
import type { CompanionOrderListItem } from "@/lib/types/order";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/**
 * 「我的订单」里的一张单（P0-6）。
 *
 * 整张卡是一个链接（内部不再嵌套链接），点哪里都进详情——取消接单这个动作只在
 * 详情页上，因此列表这一层不需要任何按钮，也就不需要是个客户端组件。
 *
 * ⚠️ **仍然不显示平台的账**：平台净收入 / 分账比例 / 已退金额都不在
 * `CompanionOrderListItem` 上。这里显示的**唯一**金额是 `netIncomeAmount`——
 * 打手自己在这一单上拿到多少（P0-15）。要显示别的金额，先得改 DTO，
 * 不能在页面上凑一个。
 *
 * ⚠️ **状态显示的是 `displayStatus`，不是 `status`**（P0-15）：一单被部分退款之后，
 * 订单真实生命周期照走，但打手这一单的钱已经全部取消，他必须立刻看到「已退款」。
 * 两个状态都在 DTO 上，各自有明确用途——`status` 服务的是「这一单还能不能动手」，
 * `displayStatus` 服务的是「这一单现在该怎么称呼」。
 *
 * ⚠️ **本单收益在列表里也要显示**：只在详情页显示的话，打手在列表上会看到
 * 一整排「已退款」却不知道钱怎么样了，还得逐单点进去确认。列表是「我有哪些单」的
 * 一览，退款的后果属于这一览必须回答的事。
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
        {/* 展示状态的文案与颜色都由服务端那一份给（`displayStatusLabel` + `ORDER_STATUS_CLASS`） */}
        <span
          className={`shrink-0 text-[13px] font-medium ${ORDER_STATUS_CLASS[order.displayStatus]}`}
        >
          {order.displayStatusLabel}
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

      {/*
        ⚠️ `null` 与 `0` 分开渲染（见 `CompanionOrderListItem.netIncomeAmount`）：
        还没有收益记录（订单未结算）时**整行不出现**，而不是显示「¥0.00」——
        后者会让一张正在护航的单看起来像已经被退款了。
      */}
      {order.netIncomeAmount !== null ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 border-t border-line pt-2 text-[12px]">
          <span className="text-ink-3">{COMPANION_ORDER_INCOME_LABEL}</span>
          <span
            className={`font-medium tabular-nums ${
              order.netIncomeAmount > 0 ? "text-ink" : "text-ink-3"
            }`}
          >
            ¥{formatYuan(order.netIncomeAmount)}
          </span>
          {/* 已退款时补一句「为什么是 0」：只给数字，第一反应会是「是不是算错了」 */}
          {order.netIncomeAmount === 0 && order.displayStatus === "refunded" ? (
            <span className="text-ink-3">{COMPANION_ORDER_INCOME_REFUNDED_NOTE}</span>
          ) : null}
        </div>
      ) : null}

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
