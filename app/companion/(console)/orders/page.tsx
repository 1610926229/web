import CompanionOrderList from "@/components/companion/CompanionOrderList";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_ORDERS_NOTICE,
  COMPANION_ORDERS_PAGE_TITLE,
} from "@/lib/constants/dispatch";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { listCompanionOrders } from "@/lib/services/companionOrders";

/**
 * 我的订单（P0-6）：**我实际接过**的单。
 *
 * ## 这一页为什么自己读资格，而不是让布局把结果传下来
 *
 * 取自己的订单需要**当前打手的 id**，而 Next 的布局无法给 `children` 传 props。
 * 「那不就是查了两次资格？」——不是：`resolveCompanionAccess` 与 `getSessionUser`
 * 都被 `React.cache` 包着，一次请求内两次调用返回同一个结果（同一个理由见
 * `app/companion/(console)/pool/page.tsx`）。布局拿不到资格时会渲染提示页并
 * **不渲染本页**，这里的分支只是兜底，返回 null 而不是再画一个提示。
 *
 * ## 归属只由服务端回答
 *
 * `listCompanionOrders(companionId)` 以 `Order.actualCompanionId` 当**查询条件**
 * （不是「查出来再比对」），因此返回的每一单都是他接过的。
 * ⚠️ 「用户当初指定了他」**不等于**订单归他（`exclusiveCompanionId` 是历史事实），
 * 这一页不会因此多出一单——页面这一层无法、也不该再做一次归属判断。
 *
 * ## 首屏由本页直接取数，不经过 HTTP 请求自己的接口
 *
 * 与用户端订单列表同一个取舍：Server Component 直连服务层，避免构建期自请求与
 * 多一跳网络。浏览器端只在**写操作**（取消接单）时才走 `lib/services/companionHttp.ts`，
 * 而且那一次写完之后列表是**重新从服务端取**的，前端不做任何本地状态镜像。
 */
export default async function CompanionOrdersPage() {
  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const orders = await listCompanionOrders(access.companion.companionId);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold text-ink">{COMPANION_ORDERS_PAGE_TITLE}</h2>
        <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
          {COMPANION_ORDERS_NOTICE}
        </p>
      </div>

      <CompanionOrderList items={orders.items} />
    </>
  );
}
