import NavBar from "@/components/common/NavBar";
import OrderList from "@/components/orders/OrderList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { isOrderStatus, type OrderTabKey } from "@/lib/constants/orders";
import { queryOrdersForUser } from "@/lib/services/orders";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 订单列表页（需登录）。
 *
 * 取数与交互的分工：
 * - **首屏**由本页在服务端直接取（不走 HTTP 请求自己的接口），没有加载闪烁；
 * - **切换状态 / 搜索 / 加载更多**由 `OrderList` 以浏览器请求完成。
 * 两条链路共用 `lib/services/orders.ts` 的同一个函数，因此筛选口径只有一套。
 *
 * 状态可以直接用地址深链（`/orders?status=refunded`）。地址里的取值非法时**在页面这一层
 * 忽略掉、按「全部」展示**；接口收到非法状态则返回 400。两者行为不同是刻意的：
 * 页面地址是用户随手可改的，不该因此把整页变成错误页；接口是程序契约，写错了必须报错。
 *
 * 页码不从地址读取：首屏固定第 1 页，与客户端的初始状态一致，
 * 否则「加载更多」会与首屏已经展示的那一页重叠。
 *
 * Mock 调试参数（`?mockError=...`）由浏览器端请求自动带上（见 `lib/api/client.ts`），
 * 服务端首屏不注入故障——一个查询参数就把整页打成错误页，不是想要的调试体验。
 */
export default async function OrdersPage({ searchParams }: PageProps<"/orders">) {
  const query = toSearchParams(await searchParams);
  const rawStatus = (query.get("status") ?? "").trim();
  const initialStatus: OrderTabKey = isOrderStatus(rawStatus) ? rawStatus : "all";

  return (
    <>
      <NavBar title="订单" />

      <RequireAuth>
        {(user) => <OrdersBody userId={user.id} initialStatus={initialStatus} />}
      </RequireAuth>
    </>
  );
}

async function OrdersBody({
  userId,
  initialStatus,
}: {
  userId: string;
  initialStatus: OrderTabKey;
}) {
  const params = new URLSearchParams();
  if (initialStatus !== "all") params.set("status", initialStatus);

  const result = await queryOrdersForUser(userId, params, "server");

  return <OrderList initialStatus={initialStatus} initialResult={result} />;
}
