/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import PriceText from "@/components/common/PriceText";
import RequireAuth from "@/lib/auth/RequireAuth";
import { COMPLAINT_STATUS_CLASS } from "@/lib/constants/complaints";
import {
  ORDER_STATUS_CLASS,
  ORDER_STATUS_HINTS,
  ORDER_STATUS_LABELS,
} from "@/lib/constants/orders";
import { REFUND_STATUS_CLASS, REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { getOrderDetailForUser } from "@/lib/services/orders";
import type { OrderDetail } from "@/lib/types/order";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 订单详情页（需登录，只读 + 售后入口）。
 *
 * 归属由服务端判定：`getOrderDetailForUser` 在订单不存在**或不属于当前用户**时都返回 null，
 * 页面因此对两种情况展示同一个「订单不存在」——不能拿订单 id 去试探别人有没有这一单。
 *
 * 页面内容全部来自订单自己的快照：商品名、规格、单价、游戏名、打手信息都是下单那一刻的值，
 * 今天商品改名下架、打手改名换头像或被停用，都不影响这里的展示。
 *
 * 底部的售后与沟通入口**完全按服务端返回的 `allowedActions` 显示**，前端不用订单状态推断：
 * 「能不能退款」既取决于订单状态，也取决于这一单有没有退款记录，只看状态一定会算错。
 * 三个摘要（退款 / 投诉 / 沟通）都是摘要，原因说明、投诉描述、消息正文要去各自详情页看。
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

        {/*
          金额域（P0-3）：下单那一刻冻结在订单上的账。
          「原价」是优惠前的应付总额，「实付」是实际付掉的钱（当前没有优惠券，两者相等），
          「护航收益」是这一单按冻结比例分给打手的钱——增值服务由打手履约，
          因此也参与分账（R3 已确认，见 lib/constants/orderAmount.ts）。
        */}
        <div className="mt-2 border-t border-line pt-1">
          <MoneyRow label="原价" cents={detail.originalAmount} />
          <MoneyRow label="实付" cents={detail.actualPaidAmount} />
          <MoneyRow label="护航收益" cents={detail.companionBaseIncome} />
        </div>

        <div className="mt-2 flex items-baseline justify-end gap-2 border-t border-line pt-2">
          {/* 支付渠道实际收的钱。当前没有优惠券，它与上面的「实付」是同一个数；
              优惠券接入之后才会分开，届时这里读的仍然是渠道实收，页面不必改 */}
          <span className="text-[13px] text-ink-2">订单合计</span>
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

        {/*
          派单进度（P0-5）：还在等人接的时候，说清「这一单现在在哪个池子里等人接、还剩多久」。
          没有这一行，用户在下单后到接单前这段时间里看到的只是一句「等待接单」——
          指定了人也一样，看不出平台到底有没有在推进。

          ⚠️ 剩余时间是**服务端在这一刻算好的一个数**，不是页面上的倒计时：
          到没到点由服务端判定，页面上的数字不参与任何决定。
        */}
        {detail.dispatchProgress ? (
          <p className="mt-2 rounded-lg bg-page px-3 py-2 text-[12px] leading-5 text-ink-3">
            {detail.dispatchProgress.poolLabel} · 剩余 {formatRemaining(detail.dispatchProgress.remainingSeconds)}
          </p>
        ) : null}
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

      <AfterSalesSection detail={detail} />

      <div className="mt-5 flex justify-center">
        <BackToOrders />
      </div>
    </div>
  );
}

/**
 * 售后与沟通。
 *
 * 每一项都由**服务端给出的值**决定显不显示：
 * - `allowedActions.canRequestRefund` —— 能不能申请退款（订单状态 + 有没有退款记录）；
 * - `refundSummary` —— 已经申请过就引到退款详情，看进度或撤销；
 * - `allowedActions.canOpenConversation` —— 订单沟通入口，带未读数；
 * - `allowedActions.canSubmitComplaint` —— 提交投诉（带上订单 id，自动关联这一单）；
 * - `complaintSummary` —— 投诉过就引到最近一条投诉的详情；
 * - `allowedActions.canReview` —— 评价服务（已完成、未评价、且没有进行中 / 已通过的退款）；
 * - `reviewSummary` —— 评价过就显示星级，并引到我的评价。
 *
 * 前端只读这些值，不拿 `status` 自己推断——写接口那边还会再校验一次，按钮只是提示，不是权限。
 */
function AfterSalesSection({ detail }: { detail: OrderDetail }) {
  const { allowedActions, refundSummary, complaintSummary, conversationSummary, reviewSummary } =
    detail;
  const unread = conversationSummary?.unreadCount ?? 0;

  return (
    <section className="mt-2 bg-surface px-4 py-3">
      <h2 className="text-[14px] font-medium text-ink">售后与沟通</h2>

      <div className="mt-1">
        {allowedActions.canRequestRefund ? (
          <ActionRow href={`/orders/${detail.id}/refund`} label="申请退款" hint="整单退款" />
        ) : null}

        {refundSummary ? (
          <ActionRow
            href={`/refunds/${refundSummary.id}`}
            label="退款进度"
            hint={REFUND_STATUS_LABELS[refundSummary.status]}
            hintClass={REFUND_STATUS_CLASS[refundSummary.status]}
          />
        ) : null}

        {allowedActions.canOpenConversation ? (
          <ActionRow
            href={`/service/chat/${detail.id}`}
            label="订单沟通"
            hint={unread > 0 ? `未读 ${unread} 条` : "与客服 / 打手沟通"}
            hintClass={unread > 0 ? "text-brand-red" : undefined}
          />
        ) : null}

        {allowedActions.canSubmitComplaint ? (
          <ActionRow href={`/complaints/new?orderId=${detail.id}`} label="提交投诉" hint="由客服跟进" />
        ) : null}

        {complaintSummary ? (
          <ActionRow
            href={`/complaints/${complaintSummary.latestId}`}
            label="投诉记录"
            hint={`${complaintSummary.latestStatusLabel} · 共 ${complaintSummary.count} 条`}
            hintClass={COMPLAINT_STATUS_CLASS[complaintSummary.latestStatus]}
          />
        ) : null}

        {/* 已完成且还没评价：给一个入口；评价过之后换成「我的评价」，不会两个同时出现 */}
        {allowedActions.canReview ? (
          <ActionRow href={`/reviews/new/${detail.id}`} label="评价服务" hint="已完成，可以评价" />
        ) : null}

        {reviewSummary ? (
          <ActionRow
            href="/reviews"
            label="我的评价"
            hint={`已评价 · ${reviewSummary.rating} 星`}
          />
        ) : null}
      </div>
    </section>
  );
}

/** 售后入口行：整行是一个链接，右侧是状态或说明。 */
function ActionRow({
  href,
  label,
  hint,
  hintClass,
}: {
  href: string;
  label: string;
  hint: string;
  hintClass?: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 border-b border-line py-2.5 text-[13px] last:border-b-0"
    >
      <span className="shrink-0 text-ink">{label}</span>
      <span className={`ml-auto min-w-0 truncate text-right ${hintClass ?? "text-ink-3"}`}>{hint}</span>
      <span className="shrink-0 text-ink-3" aria-hidden>
        ›
      </span>
    </Link>
  );
}

/**
 * 剩余时间：只在这个页面上格式化，不引入「倒计时」这种会自己走的组件。
 *
 * 秒数已经由服务端算好（`remainingSeconds`），这里只做单位换算：
 * 超过一分钟说「X 分」，不足一分钟说「不到 1 分钟」——
 * 「剩余 0 分 12 秒」这种写法看着像在倒数，而它其实不会再变。
 * 已过点时为 0（服务端保证不为负），显示成「即将结束」而不是「剩余 -3 分钟」。
 */
function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "即将结束";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分钟` : "不到 1 分钟";
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
