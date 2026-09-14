import AdminOrderTable from "@/components/admin/AdminOrderTable";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_ORDER_LIST_TITLE } from "@/lib/constants/adminOrders";
import { queryAdminOrderList, resolveAdminOrderListQuery } from "@/lib/services/adminOrders";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 全量订单（`/admin/orders`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」，
 * 不自己过滤、不自己排序、不自己算游戏选项。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?status=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是抛 400 变成错误页。接口用严格模式——接口的调用方是程序，
 * 静默把非法值当成「全部」返回，会让它拿着不知道筛了什么的结果继续往下用。
 *
 * ⚠️ 本页**只读**：没有任何改订单状态、金额、商品或用户信息的按钮（§订单管理）。
 * 订单唯一会被后台改动的路径是退款审核通过，那个入口在退款审核页。
 */
export default async function AdminOrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  const params = toSearchParams(await searchParams);
  const query = await resolveAdminOrderListQuery(params, false);
  const data = await queryAdminOrderList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_ORDER_LIST_TITLE} description={data.notice} />

      <AdminOrderTable
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
