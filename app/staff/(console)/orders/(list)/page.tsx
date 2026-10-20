import { redirect } from "next/navigation";
import StaffOrderTable from "@/components/staff/StaffOrderTable";
import StaffRefreshButton from "@/components/staff/StaffRefreshButton";
import { STAFF_ORDERS_PAGE_TITLE } from "@/lib/constants/staff";
import { getStaffSession } from "@/lib/services/staffAuth";
import { listOrdersForStaff, resolveStaffOrderListQuery } from "@/lib/services/staffOrders";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台全量订单列表（`/staff/orders`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」，
 * 不自己过滤、不自己排序、不自己算游戏选项。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：地址栏是客服随手改得动的地方，
 * 写错一个筛选值该回到默认，而不是给一屏 400。接口那边是严格模式，两者刻意不同。
 *
 * ⚠️ 这是「全量查询」，与 `/staff/conversations`（只看得见有会话的订单）**不是一回事**：
 * 客服要能按订单号、用户昵称、平台 ID 或商品名查到**任意状态**的订单。
 * 能看到什么由服务端的 `requireStaff()` 与 DTO 字段表决定，不由页面决定——
 * 页面上没有任何一处按用户或状态裁剪结果。
 *
 * ⚠️ 本页**只读**：没有改状态、改金额、换人、退款的按钮（那是后续轮次的事）。
 * 详情页同样只有展示区块。
 */
export default async function StaffOrdersPage({ searchParams }: PageProps<"/staff/orders">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const params = toSearchParams(await searchParams);
  const query = await resolveStaffOrderListQuery(params, false);
  const data = await listOrdersForStaff(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{STAFF_ORDERS_PAGE_TITLE}</h1>
          {/* 说明取自服务端（`StaffOrderListData.notice`）：页面上写的那句口径
              必须与实际查询口径同源，旁边再抄一份迟早会分叉 */}
          <p className="mt-2 max-w-4xl text-[13px] leading-5 text-ink-3">{data.notice}</p>
        </div>
        <StaffRefreshButton />
      </div>

      <StaffOrderTable
        initialFilters={{
          status: query.status,
          keyword: query.keyword,
          game: query.game,
          from: query.from,
          to: query.to,
          page: query.page,
        }}
        initialResult={data}
      />
    </div>
  );
}
