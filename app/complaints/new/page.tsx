import NavBar from "@/components/common/NavBar";
import ComplaintForm, { type ComplaintOrderOption } from "@/components/complaints/ComplaintForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { ORDER_MAX_PAGE_SIZE, ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { getOrderDetailForUser, queryOrdersForUser } from "@/lib/services/orders";
import { toSearchParams } from "@/lib/utils/query";

const ORDER_NOT_OWNED_NOTICE = "选择的订单不存在或不属于当前账号，已取消关联，可以重新选择一笔订单。";

/**
 * 提交投诉页（需登录）。
 *
 * 两种进入方式，对应两种关联订单的来源：
 * - 从订单详情点「提交投诉」进来，地址带 `?orderId=...`，直接关联那一单；
 * - 从投诉专区 / 我的进来，自己从**本人订单列表**里挑一单，或者干脆不关联。
 *
 * 可选订单由服务端按当前用户查出来（`queryOrdersForUser` 只返回本人的订单），
 * 页面不做任何过滤，前端也就无从列出别人的订单。地址里带的订单会**单独校验一次归属**：
 * 不属于当前用户就当作没有关联，并明确告诉用户，而不是静默忽略让人以为关联上了。
 *
 * 即使有人绕开页面直接提交别人的订单 id，接口同样返回 404（见 `createComplaintForUser`）。
 */
export default async function ComplaintNewPage({ searchParams }: PageProps<"/complaints/new">) {
  const query = toSearchParams(await searchParams);
  const orderId = (query.get("orderId") ?? "").trim();

  return (
    <>
      <NavBar title="提交投诉" showBack />

      <RequireAuth>
        {(user) => <ComplaintNewBody userId={user.id} orderId={orderId} />}
      </RequireAuth>
    </>
  );
}

async function ComplaintNewBody({ userId, orderId }: { userId: string; orderId: string }) {
  const params = new URLSearchParams();
  params.set("pageSize", String(ORDER_MAX_PAGE_SIZE));
  const page = await queryOrdersForUser(userId, params, "server");

  const orders: ComplaintOrderOption[] = page.items.map((order) => ({
    id: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    statusLabel: ORDER_STATUS_LABELS[order.status],
  }));

  let initialOrderId: string | null = null;
  let orderNotice = "";

  if (orderId) {
    // 先用列表命中：命中了就不必再查一次订单详情
    if (orders.some((order) => order.id === orderId)) {
      initialOrderId = orderId;
    } else {
      // 列表只有最近一页，命中不了不代表订单不存在，因此再按归属查一次
      const detail = await getOrderDetailForUser(orderId, userId, undefined, "server");
      if (detail) {
        initialOrderId = detail.id;
        // 补进可选列表：否则用户一打开就是「已关联但列表里找不到这一单」
        orders.unshift({
          id: detail.id,
          orderNo: detail.orderNo,
          productTitle: detail.productTitle,
          statusLabel: ORDER_STATUS_LABELS[detail.status],
        });
      } else {
        orderNotice = ORDER_NOT_OWNED_NOTICE;
      }
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip">
      <ComplaintForm orders={orders} initialOrderId={initialOrderId} orderNotice={orderNotice} />
    </div>
  );
}
