import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import StaffOrderActionsConsole from "@/components/staff/StaffOrderActionsConsole";
import StaffOrderSummaryPanel from "@/components/staff/StaffOrderSummaryPanel";
import StaffReleaseHistory from "@/components/staff/StaffReleaseHistory";
import {
  StaffOrderAfterSaleSection,
  StaffOrderAmountSection,
  StaffOrderContentSection,
  StaffOrderDispatchSection,
  StaffOrderIdentitySection,
  StaffOrderTimelineSection,
  StaffOrderUserSection,
} from "@/components/staff/StaffOrderDetailPanels";
import { STAFF_ORDERS_PAGE_TITLE, STAFF_ORDER_DETAIL_TITLE } from "@/lib/constants/staff";
import { getStaffSession } from "@/lib/services/staffAuth";
import { getStaffOrderDetail } from "@/lib/services/staffOrders";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台订单详情（`/staff/orders/[id]`）。
 *
 * 一页七块：订单信息、用户、下单内容快照、金额、当前打手与退出历史、派单记录、
 * 三份售后摘要与状态时间轴。区块实现在 `components/staff/StaffOrderDetailPanels.tsx`。
 *
 * ⚠️ **本页只有一处写入口**（`StaffOrderActionsConsole`，P0-11：换人 / 退回公共池），
 * 而且按钮完全由服务端的 `allowedActions` 决定；这一单不该有动作时那一块显示的是
 * 「没有可执行的处置」而不是灰按钮。**没有退款按钮**——退款是另一个动作、另一个入口。
 *
 * ⚠️ 也是**唯一持有 `allowedActions` 的读写页**：订单详情 DTO 上那两个布尔值只服务于
 * 这一个面板。判据在 `staffOrderAllowedActions()`，与事务层的两个入口共用同一条，
 * 因此不存在「按钮看得见、接口却不接受」的分叉。
 *
 * ⚠️ 处置面板排在**所有只读区块之后**：客服要先看完这一单是什么、现在谁在做、
 * 之前谁走过，再决定要不要换人。把动手的地方放在最上面，等于鼓励先点再读。
 *
 * ⚠️ 分账比例、护航收益与平台净收入**不进 DTO、不进页面**：
 * 用户权限表 §7.1 §7.2 禁止客服查看分账比例，且这三个数是同一个数的三种写法。
 * 金额那一块里有一句面向读者的说明。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码，「查无此单」就变成一屏 200 的 404 文案。
 * 兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function StaffOrderDetailPage({
  params,
  searchParams,
}: PageProps<"/staff/orders/[id]">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const detail = await getStaffOrderDetail(id ?? "", query, "server");
  if (!detail) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <Link
          href="/staff/orders"
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {STAFF_ORDERS_PAGE_TITLE}
        </Link>
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{STAFF_ORDER_DETAIL_TITLE}</h1>
      </div>

      <StaffOrderIdentitySection detail={detail} />
      <StaffOrderUserSection detail={detail} />
      <StaffOrderContentSection detail={detail} />
      <StaffOrderAmountSection detail={detail} />

      {/* 订单只读摘要（与沟通页右侧同一张卡）回答「现在是谁在履约」，
          退出历史回答「之前是谁、为什么走」——两者不是重复，删除任何一块都会让
          另一块的问题变得没法回答（订单回到公共池后，摘要里那行会变回「等待接单」）。
          两块都由页面取好传进来，组件只渲染，没有多一次取数。 */}
      <StaffOrderSummaryPanel order={detail.order} />
      <StaffReleaseHistory entries={detail.order.releaseHistory} />

      <StaffOrderDispatchSection dispatch={detail.dispatch} />
      <StaffOrderAfterSaleSection detail={detail} />
      <StaffOrderTimelineSection timeline={detail.timeline} />

      {/* 唯一的写入口，放在最后：先读完这一单，再决定要不要动手 */}
      <StaffOrderActionsConsole orderId={detail.order.orderId} allowedActions={detail.allowedActions} />
    </div>
  );
}
