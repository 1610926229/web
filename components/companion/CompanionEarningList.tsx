import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import PriceText from "@/components/common/PriceText";
import { EARNING_STATUS_CLASS, EARNING_STATUS_HINTS } from "@/lib/constants/earnings";
import type { CompanionEarningItem } from "@/lib/types/earning";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/**
 * 「我的收益」列表（P0-9）—— 打手**自己**的每一笔收益。
 *
 * ⚠️ **本组件不读数据**：列表由服务端页面 `listCompanionEarnings()` 取好传进来，
 * 因此不存在「页面读一次、组件再读一次」这种两份结果。它也不筛状态、不分页：
 * 后端返回的就是一份平铺列表（按状态与时间倒序由服务端决定），
 * 页面结构这一层不再自己发明第二套排序或分组规则。
 *
 * ⚠️ **不是客户端组件，也没有任何写操作**：P0-9 不做提现，卡片上就不该有按钮。
 * 把整张卡做成链接即可（与 `CompanionOrderCard` 同一个做法），
 * 点进去看的是**那一单**——收益本身没有独立的详情页，也不需要：
 * 收益的全部事实只有它挂在哪个订单、多少钱、什么时候到期。
 *
 * ⚠️ **不显示平台净收入 / 用户实付 / 分账比例 / 其他打手**：这些字段不在
 * `CompanionEarningItem` 上（见 `lib/types/earning.ts` 的 DTO 注释），
 * 要显示先得改 DTO——那是服务端的事，不能在页面上凑一个。
 * 也不显示任何「余额 / 钱包 / 提现」：那是钱包域，本批次不存在。
 */
export default function CompanionEarningList({
  items,
}: {
  items: readonly CompanionEarningItem[];
}) {
  if (items.length === 0) {
    return <EmptyState title={EARNINGS_EMPTY_TITLE} description={EARNINGS_EMPTY_DESCRIPTION} />;
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <EarningCard item={item} />
        </li>
      ))}
    </ul>
  );
}

/**
 * 空态文案。
 *
 * ⚠️ 写在这里而不是 `lib/constants/earnings.ts`：那一层是服务端与浏览器**共用**的
 * 纯字符串模块（`listCompanionEarnings()` 也从它取状态名），空态只有这一个组件用；
 * 本仓同样做法的先例见 `components/coupons/CouponList.tsx` 与 `components/tips/TipList.tsx`。
 */
const EARNINGS_EMPTY_TITLE = "暂无收益记录";
const EARNINGS_EMPTY_DESCRIPTION = "订单完成后产生的收益会出现在这里。";

/**
 * 一张收益卡。
 *
 * ⚠️ 状态色**只从 `EARNING_STATUS_CLASS` 取**，页面与卡片不得写 `text-status-*`：
 * 与订单状态同一条约定，换色只改常量那一处。
 * ⚠️ 状态名取服务端给的 `statusLabel`，一句话说明取 `EARNING_STATUS_HINTS`：
 * 页面不自己维护第三份文案。
 */
function EarningCard({ item }: { item: CompanionEarningItem }) {
  return (
    <Link
      href={`/companion/orders/${item.orderId}`}
      className="block rounded-2xl border border-line px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {item.orderNo}
        </span>
        {/* 状态中文名由服务端给（`EARNING_STATUS_LABELS`），颜色只从 `EARNING_STATUS_CLASS` 取 */}
        <span className={`shrink-0 text-[13px] font-medium ${EARNING_STATUS_CLASS[item.status]}`}>
          {item.statusLabel}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="shrink-0 text-[12px] text-ink-3">本单收益</span>
        {/* 金额走 `PriceText`（内部即 `formatYuan`）：两位小数的口径全站一处 */}
        <PriceText cents={item.incomeAmount} className="text-[16px] text-ink" />
      </div>

      {/* 有冲回才多出这两行：没冲回的记录多两行「0.00」只是噪声。
          ⚠️ 但在有冲回时**三个数必须一起出现**（原值 / 冲回 / 实际可得）：
          只显示原值，打手会以为这笔钱还能全提；只显示净额，他又对不上
          「订单上明明写着挣了 40」。三个数都由服务端算好（`netAmount` 不在页面做减法） */}
      {item.reversedAmount > 0 ? (
        <>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="shrink-0 text-[12px] text-ink-3">退款冲回</span>
            <span className="text-[14px] tabular-nums text-brand-red">
              −¥{formatYuan(item.reversedAmount)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="shrink-0 text-[12px] text-ink-3">实际可得</span>
            <PriceText cents={item.netAmount} className="text-[16px] text-ink" />
          </div>
        </>
      ) : null}

      {/* 一句话说清「这笔钱现在能不能用」，而不是只报流程到了哪一步 */}
      <p className="mt-1 text-[12px] leading-5 text-ink-3">
        {EARNING_STATUS_HINTS[item.status]}
      </p>

      <div className="mt-2 flex items-end gap-2 border-t border-line pt-2">
        <div className="min-w-0 flex-1 text-[12px] text-ink-3">
          <p>冻结时间：{formatDateTime(item.frozenAt)}</p>
          {/* 到期时刻是**计划值**（下单时的投诉窗口快照），因此写「预计」。
              历史缺快照的记录显示「—」：宁可留空，也不凭空编一个时间 */}
          <p>预计解冻：{item.availableAt ? formatDateTime(item.availableAt) : "—"}</p>
        </div>
        <span className="shrink-0 text-[12px] text-brand-red">查看订单 ›</span>
      </div>
    </Link>
  );
}
