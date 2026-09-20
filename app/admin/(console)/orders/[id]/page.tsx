/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, { ORDER_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_ORDER_DETAIL_TITLE,
  ADMIN_ORDER_LIST_TITLE,
  ADMIN_ORDER_READONLY_NOTICE,
} from "@/lib/constants/adminOrders";
import { REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { COMPLAINT_STATUS_LABELS } from "@/lib/constants/complaints";
import { getAdminOrderDetail } from "@/lib/services/adminOrders";
import type { AdminOrderDetail, OrderCompanionSnapshot } from "@/lib/types/order";
import { formatDateTime, formatYuan } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 订单详情（`/admin/orders/[id]`）。
 *
 * 这一页才给出客服真正需要的东西：游戏 / 大区 / 游戏账号 / 备注（用户填错了什么）、
 * 商品与规格的金额快照、护航摘要、状态时间轴，以及四份售后摘要。
 * 列表页刻意不带前面那些（§订单管理），因此「想查一单就必须打开详情，打开就能看全」。
 *
 * ⚠️ **本页是只读的**：下面没有任何按钮，也没有引入任何客户端组件。
 * 这不是「还没做」——订单的推进（分配 / 改派护航）属于后续阶段，
 * 而本阶段唯一会写订单的是「退款审核通过」，它的主语是退款申请，
 * 入口在退款审核页（详情右上角的只读说明里写清了这一点）。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码，「不存在的订单」就变成一屏 200 的 404 文案。
 * 兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function AdminOrderDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/orders/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const order = await getAdminOrderDetail(id, query, "server");
  if (!order) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_ORDER_DETAIL_TITLE}
        description={ADMIN_ORDER_READONLY_NOTICE}
        backHref="/admin/orders"
        backLabel={ADMIN_ORDER_LIST_TITLE}
      />

      <SummarySection order={order} />
      <UserSection order={order} />
      <AmountSection order={order} />
      <CompanionSection order={order} />
      <TimelineSection order={order} />
      <AfterSaleSection order={order} />
    </div>
  );
}

function SummarySection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="订单信息">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={order.statusLabel}
              tone={ORDER_STATUS_TONE[order.status]}
            />
          </span>
        </div>
        <DetailRow label="订单号" value={order.orderNo} />
        <DetailRow label="下单时间" value={formatDateTime(order.createdAt)} />
        <DetailRow label="支付时间" value={formatDateTime(order.paidAt)} />
        <DetailRow label="游戏" value={order.gameName} />
        <DetailRow label="大区" value={order.region} />
        <DetailRow label="游戏账号" value={order.gameAccountId} />
      </div>
      {/* 备注是用户自己写的内容，原样展示、不做任何格式化 */}
      <div className="mt-3">
        <FieldBlock title="用户备注" content={order.remark} />
      </div>
    </Section>
  );
}

/**
 * 用户摘要。
 *
 * `id` 是平台侧的用户标识，**只在管理端出现**，不进任何用户端 DTO。
 * 给出它是为了让客服能回答「同一个人的其他订单」这类问题（订单之间靠它关联）。
 */
function UserSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="用户">
      <div className="flex flex-col gap-1">
        <DetailRow label="用户昵称" value={order.user.nickname} />
        <DetailRow label="平台 ID" value={order.user.displayId} />
        <DetailRow label="用户标识" value={order.user.id} />
      </div>
    </Section>
  );
}

/**
 * 商品与金额快照。
 *
 * ⚠️ 展示的是**下单那一刻的快照**（商品标题、规格名、单价、游戏名），
 * 不是当前商品目录：之后改价、改图、下架都不影响这里，而客服要判断的正是
 * 「这一单当时买的是什么」。
 *
 * 三行金额的关系是自洽的：`单价 × 数量 = 商品小计`，`商品小计 + 增值服务 = 实付合计`。
 * 把它们一起列出来，是让「金额对不对」可以被当场核对，而不是去查代码。
 */
function AmountSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="商品与金额">
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <img
            src={order.productCoverUrl}
            alt=""
            className="h-16 w-24 shrink-0 rounded-lg border border-admin-line object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{order.productTitle}</p>
            <p className="mt-0.5 text-[12px] text-ink-3">
              {order.specName} × {order.quantity}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <DetailRow label="单价" value={`¥${formatYuan(order.unitPrice)}`} />
          <DetailRow label="数量" value={String(order.quantity)} />
          <DetailRow label="商品小计" value={`¥${formatYuan(order.itemsAmount)}`} />
        </div>

        <div>
          <p className="text-[13px] text-ink-3">增值服务（下单时快照）</p>
          {order.addons.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {order.addons.map((addon) => (
                <li key={addon.id} className="flex justify-between gap-3 text-[13px] text-ink-2">
                  <span className="min-w-0 break-words">{addon.name}</span>
                  <span className="shrink-0 tabular-nums">¥{formatYuan(addon.price)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">未选择增值服务</p>
          )}
          <div className="mt-1">
            <DetailRow label="增值合计" value={`¥${formatYuan(order.addonsAmount)}`} />
          </div>
        </div>

        <div className="flex items-baseline justify-between border-t border-admin-line pt-3">
          <span className="text-[13px] text-ink-3">实付合计</span>
          <span className="text-[18px] font-semibold tabular-nums text-ink">
            ¥{formatYuan(order.totalAmount)}
          </span>
        </div>
      </div>
    </Section>
  );
}

/**
 * 护航：**指定**的人与**实际接单**的人分两行写（P0-5）。
 *
 * 这两件事可以是两个人：用户指定 A、A 十分钟内没接、订单自动进公共池、B 接走。
 * 合成一行的话，「我明明指定了 A，怎么是 B 在打」在后台就查不出来——
 * 而那正是客服最需要回答的问题。
 *
 * 「实际接单」为空只可能出现在还在等人接的订单上（`paid`）：
 * 已接单及之后的状态一定有护航，这是订单自身的约束。
 */
function CompanionSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="护航">
      <CompanionRow label="用户指定" companion={order.exclusiveCompanion} emptyHint="用户未指定护航" />
      <CompanionRow
        label="实际接单"
        companion={order.actualCompanion}
        emptyHint="还没有人接单"
      />
    </Section>
  );
}

/** 一行护航快照：头像 + 昵称 + 资料入口。没有这个人时如实说明，不补占位。 */
function CompanionRow({
  label,
  companion,
  emptyHint,
}: {
  label: string;
  companion: OrderCompanionSnapshot | null;
  emptyHint: string;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-16 shrink-0 text-[12px] text-ink-3">{label}</span>
      {companion ? (
        <>
          <img
            src={companion.avatarUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
          />
          <div className="min-w-0">
            <p className="text-[13px] text-ink">{companion.name}</p>
            <Link
              href={`/admin/companions/${companion.id}`}
              className="text-[12px] text-admin-accent underline-offset-2 hover:underline"
            >
              查看护航资料
            </Link>
          </div>
        </>
      ) : (
        <p className="text-[13px] text-ink-3">{emptyHint}</p>
      )}
    </div>
  );
}

/** 状态时间轴：**只列已经发生的节点**，不补占位、不推测时间。 */
function TimelineSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="状态时间轴">
      <ol className="flex flex-col gap-3">
        {order.timeline.map((entry) => (
          <li key={entry.key} className="flex gap-3">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-admin-accent" />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                {entry.label}
                <span className="ml-2 text-[12px] text-ink-3">{formatDateTime(entry.at)}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * 四份售后摘要：只回答「有没有、到哪一步了」，**正文不在这里**。
 *
 * 退款与投诉给出进入各自详情页的链接：那些内容属于退款 / 投诉模块，
 * 在这里复制一份正文，等于让订单详情页也承担一次隐私暴露，而且两份迟早不一致。
 * 沟通摘要只给未读数与条数——聊天正文属于会话模块，本阶段没有管理端的会话页面。
 */
function AfterSaleSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="售后摘要">
      <div className="flex flex-col gap-1">
        <DetailRow
          label="退款申请"
          value={
            order.refundSummary
              ? `${REFUND_STATUS_LABELS[order.refundSummary.status]} · ¥${formatYuan(
                  order.refundSummary.amount,
                )} · 申请于 ${formatDateTime(order.refundSummary.createdAt)}`
              : ""
          }
        />
        <DetailRow
          label="投诉"
          value={
            order.complaintSummary
              ? `${order.complaintSummary.count} 条，最近一条${
                  COMPLAINT_STATUS_LABELS[order.complaintSummary.latestStatus]
                } · ${formatDateTime(order.complaintSummary.latestCreatedAt)}`
              : ""
          }
        />
        <DetailRow
          label="订单沟通"
          value={
            order.conversationSummary
              ? `${order.conversationSummary.messageCount} 条消息${
                  order.conversationSummary.unreadCount > 0
                    ? `（用户未读 ${order.conversationSummary.unreadCount} 条）`
                    : ""
                }`
              : ""
          }
        />
        <DetailRow
          label="评价"
          value={order.reviewSummary ? `评分 ${order.reviewSummary.rating} 星` : ""}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-[13px]">
        {order.refundSummary ? (
          <Link
            href={`/admin/refunds/${order.refundSummary.id}`}
            className="text-admin-accent underline-offset-2 hover:underline"
          >
            去退款审核页查看详情
          </Link>
        ) : null}
        {order.complaintSummary ? (
          <Link
            href={`/admin/complaints/${order.complaintSummary.latestId}`}
            className="text-admin-accent underline-offset-2 hover:underline"
          >
            去投诉处理页查看详情
          </Link>
        ) : null}
      </div>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        摘要只说明「有没有、到哪一步了」；退款原因、投诉正文与聊天内容在各自的页面里查看，
        不在本页复制一份。
      </p>
    </Section>
  );
}
