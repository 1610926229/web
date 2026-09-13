/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import PriceText from "@/components/common/PriceText";
import RequireAuth from "@/lib/auth/RequireAuth";
import {
  ORDER_STATUS_CLASS,
  ORDER_STATUS_HINTS,
  ORDER_STATUS_LABELS,
} from "@/lib/constants/orders";
import { getOrderDetailForUser } from "@/lib/services/orders";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 订单详情页（需登录，只读）。
 *
 * 归属由服务端判定：`getOrderDetailForUser` 在订单不存在**或不属于当前用户**时都返回 null，
 * 页面因此对两种情况展示同一个「订单不存在」——不能拿订单 id 去试探别人有没有这一单。
 *
 * 页面内容全部来自订单自己的快照：商品名、规格、单价、游戏名、打手信息都是下单那一刻的值，
 * 今天商品改名下架、打手改名换头像或被停用，都不影响这里的展示。
 *
 * 本阶段**只读**：不提供退款、投诉、评价、联系客服、再来一单等入口。
 * 这些交互要等对应阶段确认后再加，现在放上来只会是点了没反应的按钮。
 *
 * 该路由位于 `(tabs)` 之外（与商品详情一致），是二级页面，用顶部返回而非底部 TabBar。
 * NavBar 放在 `RequireAuth` 外面：未登录时也能返回上一页，不会卡在登录拦截界面上。
 */
export default async function OrderDetailPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;

  return (
    <>
      <NavBar title="订单详情" showBack />

      <RequireAuth>
        {(user) => <OrderDetailBody orderId={id ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function OrderDetailBody({ orderId, userId }: { orderId: string; userId: string }) {
  const detail = await getOrderDetailForUser(orderId, userId, undefined, "server");

  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="订单不存在"
          description="该订单可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        />
        <BackToOrders />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip bg-page pb-6">
      {/* 状态 */}
      <section className="bg-surface px-4 py-4">
        <p className={`text-[18px] font-semibold ${ORDER_STATUS_CLASS[detail.status]}`}>
          {ORDER_STATUS_LABELS[detail.status]}
        </p>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">
          {ORDER_STATUS_HINTS[detail.status]}
        </p>
        <div className="mt-2">
          <DetailRow label="订单号" value={detail.orderNo} />
          <DetailRow label="支付时间" value={formatDateTime(detail.paidAt)} />
        </div>
      </section>

      {/* 商品与金额 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">商品信息</h2>

        <div className="mt-2 flex gap-3">
          <img
            src={detail.productCoverUrl}
            alt={detail.productTitle}
            className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
              {detail.productTitle}
            </p>
            <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">{detail.specName}</p>
          </div>
        </div>

        <div className="mt-2">
          <MoneyRow label="单价" cents={detail.unitPrice} />
          <DetailRow label="数量" value={`×${detail.quantity}`} />
          <MoneyRow label="商品金额" cents={detail.itemsAmount} />

          {detail.addons.map((addon) => (
            <MoneyRow key={addon.id} label={`增值服务 · ${addon.name}`} cents={addon.price} />
          ))}
          {detail.addons.length > 0 ? (
            <MoneyRow label="增值服务合计" cents={detail.addonsAmount} />
          ) : null}
        </div>

        <div className="mt-2 flex items-baseline justify-end gap-2 border-t border-line pt-2">
          <span className="text-[13px] text-ink-2">实付金额</span>
          <PriceText cents={detail.totalAmount} className="text-[18px] text-brand-red" />
        </div>
      </section>

      {/* 订单信息：游戏 ID 属于用户订单信息，只在这里、只给订单所属用户看 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">订单信息</h2>
        <div className="mt-1">
          <DetailRow label="游戏" value={detail.gameName} />
          <DetailRow label="大区" value={detail.region} />
          <DetailRow label="游戏 ID" value={detail.gameAccountId} />
          <DetailRow label="备注" value={detail.remark || "无"} />
        </div>
      </section>

      {/* 打手：未绑定就如实显示「等待接单」，不编造一个打手 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">打手信息</h2>
        {detail.companion ? (
          <div className="mt-2 flex items-center gap-2.5">
            <img
              src={detail.companion.avatarUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full border border-line"
            />
            <span className="min-w-0 truncate text-[14px] text-ink">{detail.companion.name}</span>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-ink-3">等待接单</p>
        )}
      </section>

      {/* 状态时间轴：只列出已经发生的节点 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">订单进度</h2>
        <ol className="mt-2">
          {detail.timeline.map((entry) => (
            <li key={entry.key} className="flex items-center gap-3 py-1.5 text-[13px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" aria-hidden />
              <span className="shrink-0 text-ink-2">{entry.label}</span>
              <span className="ml-auto shrink-0 text-ink-3">{formatDateTime(entry.at)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-5 flex justify-center">
        <BackToOrders />
      </div>
    </div>
  );
}

/** 明细行：左标签右内容，长内容换行而不是把卡片撑宽。 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right text-ink">{value}</span>
    </div>
  );
}

/** 金额行：一律经 `PriceText` 展示，保证两位小数的口径只有一处实现。 */
function MoneyRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="min-w-0 flex-1 break-words text-ink-3">{label}</span>
      <PriceText cents={cents} className="shrink-0 text-[13px] text-ink" />
    </div>
  );
}

function BackToOrders() {
  return (
    <Link
      href="/orders"
      className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
    >
      返回订单列表
    </Link>
  );
}
