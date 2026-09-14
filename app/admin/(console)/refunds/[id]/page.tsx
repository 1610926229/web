/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminRefundConsole from "@/components/admin/AdminRefundConsole";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_REFUND_AMOUNT_NOTE,
  ADMIN_REFUND_CONSUMPTION_NOTICE,
  ADMIN_REFUND_DETAIL_TITLE,
  ADMIN_REFUND_LIST_TITLE,
} from "@/lib/constants/adminRefunds";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { getAdminRefundDetail } from "@/lib/services/adminRefunds";
import type { AdminRefundDetail } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 退款审核详情（`/admin/refunds/[id]`）。
 *
 * 审核需要的全部内容都在这一页：原因、说明、凭证、订单摘要、审核信息与进度时间轴。
 * 列表页刻意不带原因与说明（§退款审核），因此「要批一笔款就必须先看到它为什么被申请」。
 *
 * ⚠️ **本页只有一处写入口**（`AdminRefundConsole`），而且按钮完全由服务端的
 * `allowedActions` 决定；终态下那一块显示的是「没有可执行的动作」而不是三个灰按钮。
 *
 * ⚠️ **金额是只读展示值**：取申请创建时的订单实付快照，页面上没有任何输入框能改它。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function AdminRefundDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/refunds/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const refund = await getAdminRefundDetail(id, query, "server");
  if (!refund) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_REFUND_DETAIL_TITLE}
        backHref="/admin/refunds"
        backLabel={ADMIN_REFUND_LIST_TITLE}
      />

      <SummarySection refund={refund} />
      <AmountSection refund={refund} />
      <UserSection refund={refund} />
      <ContentSection refund={refund} />
      <ReviewSection refund={refund} />
      <TimelineSection refund={refund} />

      <AdminRefundConsole refund={refund} />
    </div>
  );
}

/**
 * 摘要。
 *
 * ⚠️ 退款状态与订单状态**并排展示**，这是这一页最要紧的一处排版：
 * 两条状态线各自独立，通过之前订单不会变成「已退款」。只看退款状态会让人以为
 * 「批了就等于退了」，而只看订单状态又会以为「还有一笔退款悬着」。
 */
function SummarySection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="退款申请">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">退款状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={refund.statusLabel}
              tone={REFUND_STATUS_TONE[refund.status]}
            />
          </span>
        </div>
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">订单状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={refund.orderStatusLabel}
              tone={ORDER_STATUS_TONE[refund.orderStatus]}
            />
          </span>
        </div>
        <DetailRow label="退款单号" value={refund.refundNo} />
        <DetailRow label="订单号" value={refund.orderNo} />
        <DetailRow label="商品" value={refund.productTitle} />
        <DetailRow label="申请时间" value={formatDateTime(refund.createdAt)} />
        <DetailRow label="更新时间" value={formatDateTime(refund.updatedAt)} />
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        开始审核与拒绝只改退款申请，订单按原进度继续；只有通过会同时把订单改成「已退款」。
      </p>
    </Section>
  );
}

/** 退款金额。**只读**，且把「不可修改」与「通过后消费侧会怎样」都写在旁边。 */
function AmountSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="退款金额">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink-3">整单退款金额</span>
        <span className="text-[20px] font-semibold tabular-nums text-ink">
          ¥{formatYuan(refund.amount)}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_AMOUNT_NOTE}</p>
      <p className="mt-1 text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_CONSUMPTION_NOTICE}</p>
    </Section>
  );
}

/**
 * 用户摘要。
 *
 * `id` 是平台侧用户标识，**只在管理端出现**，不进任何用户端 DTO；
 * 给出它是为了让客服能核对「同一个人还有没有别的售后」。
 */
function UserSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="用户">
      <div className="flex flex-col gap-1">
        <DetailRow label="用户昵称" value={refund.user.nickname} />
        <DetailRow label="平台 ID" value={refund.user.displayId} />
        <DetailRow label="用户标识" value={refund.user.id} />
      </div>
    </Section>
  );
}

/** 申请内容：用户写的原文原样展示，不做格式化、不改写。凭证同样是只读缩略图。 */
function ContentSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="申请内容">
      <div className="flex flex-col gap-1">
        <DetailRow label="退款原因" value={refund.reasonLabel} />
      </div>

      <div className="mt-3">
        <FieldBlock title="情况说明" content={refund.description} />
      </div>

      <div className="mt-3">
        <p className="text-[13px] text-ink-3">凭证</p>
        {refund.evidence.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-3">
            {refund.evidence.map((item) => (
              <li key={item.id} className="w-28">
                <img
                  src={item.url}
                  alt=""
                  className="h-20 w-28 rounded-lg border border-admin-line object-cover"
                />
                <span className="mt-1 block truncate text-[11px] text-ink-3">
                  {EVIDENCE_KIND_LABELS[item.kind]} · {item.name}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-3">未上传凭证</p>
        )}
      </div>
    </Section>
  );
}

/**
 * 审核信息。
 *
 * 四个时间点各自单独一行、缺哪个就显示「—」：**不推测、不补占位**。
 * 「开始审核」不记审核人（`reviewedBy` 只记结论的做出者），
 * 谁开始看的由审计回答——那一条不属于业务记录，也就不在这一页展示。
 */
function ReviewSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="审核信息">
      <div className="flex flex-col gap-1">
        <DetailRow label="开始审核" value={refund.reviewingAt ? formatDateTime(refund.reviewingAt) : ""} />
        <DetailRow label="审核完成" value={refund.reviewedAt ? formatDateTime(refund.reviewedAt) : ""} />
        <DetailRow label="审核人" value={refund.reviewedBy ?? ""} />
        <DetailRow label="撤销时间" value={refund.cancelledAt ? formatDateTime(refund.cancelledAt) : ""} />
      </div>

      <div className="mt-3">
        <FieldBlock title="审核意见" content={refund.reviewNote} />
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        「审核人」只记通过或拒绝的做出者；开始审核只改状态、不产生结论。撤销是用户自己的动作，
        完成审核之后不能再撤销。
      </p>
    </Section>
  );
}

/** 进度时间轴：**只列已经发生的节点**，不补占位、不推测时间。 */
function TimelineSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="状态时间轴">
      <ol className="flex flex-col gap-3">
        {refund.timeline.map((entry) => (
          <li key={entry.key} className="flex gap-3">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-admin-accent" />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                {entry.label}
                <span className="ml-2 text-[12px] text-ink-3">{formatDateTime(entry.at)}</span>
              </p>
              <p className="mt-0.5 break-words text-[12px] leading-4 text-ink-3">{entry.note}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
