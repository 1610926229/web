import CompanionOrderCard from "@/components/companion/CompanionOrderCard";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPANION_ORDERS_EMPTY_DESCRIPTION,
  COMPANION_ORDERS_EMPTY_TITLE,
} from "@/lib/constants/dispatch";
import type { CompanionOrderListItem } from "@/lib/types/order";

/**
 * 「我的订单」列表（P0-6）—— 打手**实际接过**的单。
 *
 * ⚠️ **本组件不读数据**：列表由服务端页面 `listCompanionOrders()` 取好传进来，
 * 因此不存在「页面读一次、组件再读一次」这种两份结果。它也不筛状态、不分页：
 * 后端返回的就是一份平铺列表（进行中的与历史都在，按支付时间倒序），
 * 页面结构这一层不再自己发明第二套分组规则。
 *
 * ⚠️ 归属不在这里判断，也判不了：`items` 里的每一单都已经是
 * `Order.actualCompanionId === 当前 companionId` 的结果（服务端按这个条件查的）。
 * 组件里再写一次判断等于给同一条规则开第二个出处。
 *
 * ⚠️ 空态用 `components/common/EmptyState`，不各写一套：用户端订单列表用的是同一个组件。
 */
export default function CompanionOrderList({
  items,
}: {
  items: readonly CompanionOrderListItem[];
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title={COMPANION_ORDERS_EMPTY_TITLE}
        description={COMPANION_ORDERS_EMPTY_DESCRIPTION}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <CompanionOrderCard order={item} />
        </li>
      ))}
    </ul>
  );
}
