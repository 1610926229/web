/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound } from "next/navigation";
import AdminComplaintConsole from "@/components/admin/AdminComplaintConsole";
import AdminComplaintSections from "@/components/admin/AdminComplaintSections";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminRefundConsole from "@/components/admin/AdminRefundConsole";
import AdminRefundSections from "@/components/admin/AdminRefundSections";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, { ORDER_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_AFTERSALE_LIST_TITLE,
  isAdminAftersaleCaseType,
  type AdminAftersaleCaseType,
} from "@/lib/constants/adminAftersales";
import { COMPLAINT_STATUS_LABELS } from "@/lib/constants/complaints";
import { COMPANION_RELEASE_SOURCE_LABELS } from "@/lib/constants/dispatch";
import { REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { getAdminAftersaleDetail } from "@/lib/services/adminAftersales";
import type { AdminOrderDetail, OrderCompanionSnapshot } from "@/lib/types/order";
import { formatDateTime, formatYuan } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 本页标题下的说明。
 *
 * ⚠️ 措辞必须**如实**：这一页上确实有操作区（退款 / 投诉的 Console），
 * 早先那句「本页只读聚合」与事实相反——管理员会去找一个不存在的「只读」承诺。
 * 现在的说法是「动作与那两个专用页完全同源，本页额外聚合这一单的上下文」。
 *
 * 写在这里而不是 `lib/constants/adminAftersales.ts`：服务端那组常量描述的是**列表**的口径，
 * 而这句话只描述这一页，且只在这一个页面出现。
 *
 * 用「」而不用 Markdown 星号：它是被 `<p>` 原样渲染的，星号只会显示成四个字符。
 */
const DETAIL_READONLY_NOTE =
  "本页不是另一套入口：操作区与「退款审核」「投诉处理」用的是同一个组件（按钮同样由服务端判定），" +
  "案件正文也取自那两页的同一份只读区块。" +
  "本页额外把这一单的订单、用户、打手、客服会话与履约退出历史聚合在一起。";

/**
 * 售后案件聚合详情（`/admin/aftersales/[caseType]/[id]`）。
 *
 * 这一页把「一个售后案件需要同时看到的东西」摆在一起：案件本身（正文、凭证、
 * 审核意见 / 处理结果）+ 它关联的订单、用户、打手、客服会话、履约退出历史，
 * 以及同一单上的其它售后信号。原先要回答「这个投诉背后的订单现在到哪一步」
 * 得在三个页面之间来回跳。
 *
 * ⚠️ **两样都是复用、不是重写**：
 * - 处置动作：退款走 `AdminRefundConsole`、投诉走 `AdminComplaintConsole`；
 * - 案件只读正文：`AdminRefundSections` / `AdminComplaintSections`，
 *   它们**就是**那两个专用页渲染的那一份（P1-3 从页面里抽出来的）。
 *
 * 因此本页**没有**自己的按钮、自己的字段排版或任何写接口调用。若把动作或正文在这里
 * 再写一遍，就会得到第二份定义，两边迟早分叉——而这里变的恰恰是「哪些字段给管理员看」。
 *
 * ⚠️ **找不到就是 404**：路径里的案件类型不在枚举里时直接 `notFound()`，
 * 不回退成「默认退款」——那会把一条不存在的地址渲染成一条真的退款申请。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 *
 * ⚠️ 本页**不做任何金额运算**：页面上出现的金额全部来自 DTO，只经过 `formatYuan` 展示。
 */
export default async function AdminAftersaleDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/aftersales/[caseType]/[id]">) {
  const { caseType, id } = await params;
  const query = toSearchParams(await searchParams);

  if (!isAdminAftersaleCaseType(caseType)) notFound();

  const detail = await getAdminAftersaleDetail(caseType, id, query, "server");
  if (!detail) notFound();

  return (
    <div className="flex flex-col gap-5">
      {/* 返回工作台的入口就是标题上方这一条 `← 返回列表`（指向 `/admin/aftersales`）。
          它没有用 `backLabel` 再写一遍模块名：这里的主标题本来就是那个名字，
          两行同样的字只会让人以为点错了。 */}
      <AdminPageHeading
        title={ADMIN_AFTERSALE_LIST_TITLE}
        description={DETAIL_READONLY_NOTE}
        backHref="/admin/aftersales"
      />

      {/* 操作区：与两个专用页用的是**同一个组件**，本页没有第二份按钮或决策表单。
          ⚠️ 位置与两个专用页**不同**：那边是「只读正文在前、Console 在后」
          （先看清案件再决定怎么处置），本页把 Console 放在只读正文**之前**、紧跟页头——
          这一页的主线是「把这一单的上下文聚到一起」，处置是这个案件的第一件事，
          下面的订单 / 会话 / 退出历史是它的背景。二者至多出现一个——一个案件只有一种类型 */}
      {detail.refund ? <AdminRefundConsole refund={detail.refund} /> : null}
      {detail.complaint ? <AdminComplaintConsole complaint={detail.complaint} /> : null}

      {/* 案件只读正文：同样是那两个专用页的**同一份**区块（P1-3 抽成了 `Admin*Sections`），
          因此投诉正文 / 联系方式 / 凭证 / 处理结果、退款情况说明 / 凭证 / 审核意见在这里
          与专用页一字不差。此前这一段缺失，工作台看不到案件本身 */}
      {detail.refund ? <AdminRefundSections refund={detail.refund} /> : null}
      {detail.complaint ? <AdminComplaintSections complaint={detail.complaint} /> : null}

      {detail.order ? (
        <>
          <OrderSection order={detail.order} />
          <UserSection order={detail.order} />
          <CompanionSection order={detail.order} />
          <ConversationSection order={detail.order} />
          <ReleaseHistorySection order={detail.order} />
          <OtherAfterSaleSection order={detail.order} />
        </>
      ) : (
        <NoOrderSection caseType={caseType} />
      )}
    </div>
  );
}

/**
 * 订单侧聚合区整体不渲染时的说明。
 *
 * ⚠️ **两类案件到达这里的含义不同，文案必须分开**：
 *
 * - **投诉**：`Complaint.orderId` **允许为 `null`**（用户可以不关联订单提交）。
 *   未关联订单是**合法状态**（平台服务类的反馈本来就没有单），不是缺失数据。
 * - **退款**：`RefundRequest.orderId` 是**必填**（`lib/types/refund.ts`），
 *   订单侧为 `null` 只可能是**订单记录读不出来**（存储被写坏的不可能状态）。
 *   说成「没有关联订单」是错的——这条退款申请确实挂在一个订单 id 上，
 *   只是那条订单记录不在。
 *
 * 两句话都不能省：它们回答的都是「页面为什么少了一块」，说错会让人去找
 * 一个不存在的字段（见 D-P1-3-4）。
 */
function NoOrderSection({ caseType }: { caseType: AdminAftersaleCaseType }) {
  return (
    <Section title="关联订单">
      <p className="text-[13px] leading-5 text-ink-3">
        {caseType === "complaint"
          ? "这条投诉没有关联订单（例如平台服务类的反馈）。未关联订单不影响处理流程，也不代表数据缺失。"
          : "这条退款申请关联的订单记录读不出来（订单记录缺失）。退款申请本身完整可读，审核不依赖它。"}
      </p>
    </Section>
  );
}

/** 订单本身：这一单是什么、现在到哪一步了。金额是快照，不是当前商品目录。 */
function OrderSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="关联订单">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">订单状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge label={order.statusLabel} tone={ORDER_STATUS_TONE[order.status]} />
          </span>
        </div>
        <DetailRow label="订单号" value={order.orderNo} />
        <DetailRow label="商品" value={order.productTitle} />
        {/* ⚠️ 读 `actualPaidAmount`（P1-4）：这里写的是「实付金额」，
            而 `totalAmount` 是**优惠前**应付总额——用了券就不相等了 */}
        <DetailRow label="实付金额" value={`¥${formatYuan(order.actualPaidAmount)}`} />
        <DetailRow label="创建时间" value={formatDateTime(order.createdAt)} />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-[13px]">
        <Link
          href={`/admin/orders/${order.id}`}
          className="text-admin-accent underline-offset-2 hover:underline"
        >
          查看订单详情（含游戏账号、备注与时间轴）
        </Link>
      </div>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        这一单的游戏账号、备注与状态时间轴仍然只在订单详情页，本页不复制一份：
        同一份内容两处渲染，迟早会有一处先过时。
      </p>
    </Section>
  );
}

/** 用户摘要：只有昵称与平台展示 ID，没有手机号、实名或任何微信身份。 */
function UserSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="用户">
      <div className="flex flex-col gap-1">
        <DetailRow label="用户昵称" value={order.user.nickname} />
        <DetailRow label="平台 ID" value={order.user.displayId} />
      </div>
    </Section>
  );
}

/**
 * 打手：显示的是**实际接单**的那位（与用户当初指定的人可以不是同一个人）。
 *
 * 「还没有人接单」只可能出现在还在等人接的订单上；如果这一单曾经有人接过又退出，
 * 这里同样会显示这一句——那**不是矛盾**：这一块说「现在是谁」，
 * 下面「履约退出历史」说「之前是谁」。
 */
function CompanionSection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="打手">
      <CompanionRow companion={order.actualCompanion} />
    </Section>
  );
}

function CompanionRow({ companion }: { companion: OrderCompanionSnapshot | null }) {
  if (!companion) {
    return <p className="text-[13px] text-ink-3">尚无打手接单</p>;
  }

  return (
    <div className="flex items-center gap-3 py-1.5">
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
          查看打手资料
        </Link>
      </div>
    </div>
  );
}

/**
 * 客服会话摘要。
 *
 * ⚠️ 这里判的是 `null`（**这条记录不存在**），不是 `length === 0`：
 * 会话摘要为空说明这一单还没有任何会话，与下面退出历史的「数组为空」不是同一件事。
 * 两种空值用同一个分支处理，会让「没有记录」与「记录为空」在页面上再也分不出来。
 *
 * 聊天正文属于会话模块，本页只给条数与最后一条时间。
 */
function ConversationSection({ order }: { order: AdminOrderDetail }) {
  const conversation = order.conversationSummary;

  return (
    <Section title="客服会话">
      {conversation ? (
        <div className="flex flex-col gap-1">
          <DetailRow label="消息条数" value={`${conversation.messageCount} 条`} />
          <DetailRow
            label="最后一条"
            value={conversation.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : ""}
          />
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">还没有沟通记录。</p>
      )}
    </Section>
  );
}

/**
 * 履约退出历史：谁曾经接过这一单、为什么退出、什么时候退出。
 *
 * ⚠️ 这里判的是 `length === 0`（**没有退出过**，一个正常的事实），不是 `null`：
 * 空数组与 `null` 在本页是两种不同的「没有」，见上方会话区块的说明。
 *
 * 显示的是**标识与动作**，`companionId` 是内部标识——与订单详情页同一口径，
 * 本页不对它做名称解析（那是订单详情页的取舍，这里保持一致以免两处显示不一样）。
 */
function ReleaseHistorySection({ order }: { order: AdminOrderDetail }) {
  return (
    <Section title="履约退出历史">
      {order.releaseHistory.length > 0 ? (
        <ul className="flex flex-col">
          {order.releaseHistory.map((record, index) => (
            <li key={record.id} className={`border-admin-line ${index > 0 ? "border-t pt-3" : ""}`}>
              <DetailRow label="动作" value={COMPANION_RELEASE_SOURCE_LABELS[record.source]} />
              <DetailRow label="打手标识" value={record.companionId} />
              <DetailRow label="时间" value={formatDateTime(record.createdAt)} />
              <div className="mt-2">
                {/* 原因是打手自己写的一句话，原样展示、保留换行、不做任何截断。
                    ⚠️ 用 `FieldBlock` 而不是 `DetailRow`：后者的 `<span>` 没有
                    `whitespace-pre-wrap`，会把换行压成空格——同一段话在两个页面上
                    就长得不一样了（订单详情页用的是 `FieldBlock`，这里必须一致）。 */}
                <FieldBlock title="原因" content={record.reason ?? ""} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-3">没有退出记录。</p>
      )}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        打手在开始服务前取消接单会在这里留一条记录；订单回到公共池之后就不再挂着那位打手，
        上面「打手」显示「尚无打手接单」与这里有记录并不矛盾——一个说现在是谁，一个说之前是谁。
      </p>
    </Section>
  );
}

/**
 * 同一订单上的其它售后信号。
 *
 * 只回答「有没有、到哪一步了」，正文与凭证留在各自的详情页：
 * 在本页复制一份，既是第二次隐私暴露，也会让两份内容迟早不一致。
 *
 * 两个摘要的写入者是另外两个模块，本页**没有任何入口**能改它们。
 */
function OtherAfterSaleSection({ order }: { order: AdminOrderDetail }) {
  const refund = order.refundSummary;
  const complaint = order.complaintSummary;

  return (
    <Section title="同一订单的其它售后信号">
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-[13px] text-ink-3">退款申请</p>
          {refund ? (
            <>
              <p className="mt-1 text-[13px] leading-5 text-ink-2">
                {REFUND_STATUS_LABELS[refund.status]} · ¥{formatYuan(refund.amount)} · 申请于{" "}
                {formatDateTime(refund.createdAt)}
              </p>
              <Link
                href={`/admin/refunds/${refund.id}`}
                className="mt-1 inline-block text-[13px] text-admin-accent underline-offset-2 hover:underline"
              >
                去退款审核页查看详情
              </Link>
            </>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">这一单没有退款申请。</p>
          )}
        </div>

        <div className="border-t border-admin-line pt-3">
          <p className="text-[13px] text-ink-3">投诉</p>
          {complaint ? (
            <>
              <p className="mt-1 text-[13px] leading-5 text-ink-2">
                {complaint.count} 条，最近一条{COMPLAINT_STATUS_LABELS[complaint.latestStatus]} ·{" "}
                {formatDateTime(complaint.latestCreatedAt)}
              </p>
              <Link
                href={`/admin/complaints/${complaint.latestId}`}
                className="mt-1 inline-block text-[13px] text-admin-accent underline-offset-2 hover:underline"
              >
                去投诉处理页查看详情
              </Link>
            </>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">这一单没有投诉。</p>
          )}
        </div>
      </div>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        其中一条可能就是本页正在处理的案件：链接指向的是那个模块的专用页面，
        动作在那边执行，本页只做指向。
      </p>
    </Section>
  );
}
