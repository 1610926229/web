import NavBar from "@/components/common/NavBar";
import ServiceTabs, { type ServiceOrderOption } from "@/components/service/ServiceTabs";
import RequireAuth from "@/lib/auth/RequireAuth";
import { ORDER_MAX_PAGE_SIZE, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { parseServiceTab } from "@/lib/constants/service";
import { listConversationsForUser } from "@/lib/services/conversations";
import { queryNotificationsForUser } from "@/lib/services/notifications";
import { queryOrdersForUser } from "@/lib/services/orders";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服页（需登录，底部 TabBar 保留）。
 *
 * 三个子 Tab 的首屏数据全部由本页在服务端取（不 HTTP 请求自己的接口），
 * 客户端组件只负责切换、展开与分页，因此切 Tab 不会闪一下加载中。
 *
 * 三份数据都只按当前用户的 id 查：会话、通知都只包含本人的记录，
 * 可发起沟通的订单也只列出本人的订单——前端不做也不该做任何过滤。
 *
 * 子 Tab 支持地址深链（`/service?tab=notice`）。地址里的取值非法时按第一个 Tab 展示，
 * 与订单列表的处理一致：地址是用户随手可改的，不该因此把整页变成错误页。
 */
export default async function ServicePage({ searchParams }: PageProps<"/service">) {
  const query = toSearchParams(await searchParams);
  const initialTab = parseServiceTab(query.get("tab"));

  return (
    <>
      <NavBar title="客服" />

      <RequireAuth>
        {(user) => <ServiceBody userId={user.id} initialTab={initialTab} />}
      </RequireAuth>
    </>
  );
}

async function ServiceBody({
  userId,
  initialTab,
}: {
  userId: string;
  initialTab: ReturnType<typeof parseServiceTab>;
}) {
  const orderParams = new URLSearchParams();
  orderParams.set("pageSize", String(ORDER_MAX_PAGE_SIZE));
  // 三个查询互不依赖，一起发出，避免串行等待
  const [conversations, notifications, orderPage] = await Promise.all([
    listConversationsForUser(userId, undefined, "server"),
    queryNotificationsForUser(userId, new URLSearchParams(), "server"),
    queryOrdersForUser(userId, orderParams, "server"),
  ]);

  const orders: ServiceOrderOption[] = orderPage.items.map((order) => ({
    id: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    statusLabel: ORDER_STATUS_LABELS[order.status],
  }));

  return (
    <ServiceTabs
      initialTab={initialTab}
      conversations={conversations}
      notifications={notifications}
      orders={orders}
    />
  );
}
