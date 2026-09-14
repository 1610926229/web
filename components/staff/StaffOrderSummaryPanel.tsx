import {
  STAFF_ORDER_READONLY_NOTICE,
  STAFF_ORDER_SUMMARY_TITLE,
} from "@/lib/constants/staff";
import type { StaffOrderSummary } from "@/lib/types/staff";
import { formatYuan } from "@/lib/utils/format";

/**
 * 订单只读摘要（工作台右侧 / 沟通页上方）。
 *
 * ⚠️ **只读**：这里是服务端组件，没有任何输入框、按钮或表单，
 * 页面上也没有通往「改订单」的入口。客服不能修改订单状态、金额、商品，
 * 也不能处理退款与投诉——后端同样没有这个能力（客服接口只读订单，见
 * `lib/services/staffConversations.ts`）。
 *
 * ⚠️ 字段表就是边界（`StaffOrderSummary`）：**没有**支付凭据、Cookie、
 * OpenID / UnionID，也**没有**游戏 ID 与订单备注。客服当前阶段不需要它们，
 * 而少一个字段就少一条泄漏路径。因此这里也不能「顺手补上」——
 * 要加字段得先改那个类型，那是一次有意识的数据边界变更。
 */
export default function StaffOrderSummaryPanel({ order }: { order: StaffOrderSummary }) {
  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">{STAFF_ORDER_SUMMARY_TITLE}</h2>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3 xl:grid-cols-4">
        <Row label="订单号" value={order.orderNo} mono />
        <Row label="订单状态" value={order.orderStatusLabel} />
        <Row label="商品" value={order.productTitle} />
        <Row label="规格" value={order.specName} />
        <Row label="数量" value={String(order.quantity)} />
        <Row label="金额" value={`¥${formatYuan(order.totalAmount)}`} />
        <Row label="用户" value={order.userNickname} />
        <Row label="护航" value={order.companionSummary} />
      </dl>

      <p className="mt-3 text-[12px] leading-4 text-ink-3">{STAFF_ORDER_READONLY_NOTICE}</p>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className={`mt-0.5 break-words text-ink ${mono ? "font-mono text-[12px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
