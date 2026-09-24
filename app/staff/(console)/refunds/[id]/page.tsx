/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import StaffRefundConsole from "@/components/staff/StaffRefundConsole";
import StaffReleaseHistory from "@/components/staff/StaffReleaseHistory";
import { formatAuditActorLabel } from "@/lib/constants/adminAudit";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { STAFF_REFUNDS_PAGE_TITLE } from "@/lib/constants/staff";
import {
  STAFF_REFUND_AMOUNT_NOTE,
  STAFF_REFUND_DETAIL_TITLE,
} from "@/lib/constants/staffRefunds";
import { getStaffSession } from "@/lib/services/staffAuth";
import { getStaffRefundDetail } from "@/lib/services/staffRefunds";
import type { StaffRefundDetail } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 客服工作台退款详情（`/staff/refunds/[id]`）。
 *
 * 处理退款需要的全部内容都在这一页：原因、说明、凭证、订单摘要、金额对照、
 * 审核信息、进度时间轴与关联会话入口。
 *
 * ⚠️ **本页只有一处写入口**（`StaffRefundConsole`），而且按钮完全由服务端的
 * `allowedActions` 决定；终态下那一块显示的是「没有可执行的动作」而不是灰按钮。
 * **没有「通过」按钮**——通过涉及资金最终划拨，只在管理员侧。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function StaffRefundDetailPage({
  params,
  searchParams,
}: PageProps<"/staff/refunds/[id]">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const refund = await getStaffRefundDetail(id, query, "server");
  if (!refund) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <Link
          href="/staff/refunds"
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {STAFF_REFUNDS_PAGE_TITLE}
        </Link>
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{STAFF_REFUND_DETAIL_TITLE}</h1>
      </div>

      <SummarySection refund={refund} />
      {/* 履约退出历史紧跟在「退款申请」下面（那一块里就是订单号、商品与订单状态）。
          退款理由常常就是「接单的打手走了」——原打手、退出方式与退出时间
          是客服判断这一笔该不该退时要先看的上下文，因此放在订单信息旁边而不是页尾。
          没有退出记录时整段不渲染（组件自己返回 null），本页其余部分不受影响。 */}
      <StaffReleaseHistory entries={refund.releaseHistory} />
      <AmountSection refund={refund} />
      <UserSection refund={refund} />
      <ContentSection refund={refund} />
      <ReviewSection refund={refund} />
      <TimelineSection refund={refund} />

      <StaffRefundConsole refund={refund} />
    </div>
  );
}

/**
 * 摘要。
 *
 * ⚠️ 退款状态与订单状态**并排展示**：两条状态线各自独立，开始审核与驳回只改退款申请，
 * 订单按原进度继续。只看退款状态会让人以为「驳回就等于订单结束」，而只看订单状态
 * 又会以为「还有一笔退款悬着」。
 */
function SummarySection({ refund }: { refund: StaffRefundDetail }) {
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

        {refund.conversationOrderId ? (
          <div className="flex gap-3 py-1.5">
            <span className="w-20 shrink-0 text-[13px] text-ink-3">关联会话</span>
            <Link
              href={`/staff/conversations/${refund.conversationOrderId}`}
              className="min-w-0 flex-1 break-words text-[13px] text-admin-accent underline-offset-2 hover:underline"
            >
              打开这笔订单的工作台会话
            </Link>
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        开始审核与驳回只改退款申请，订单按原进度继续；通过退款是管理员的职责。
      </p>
    </Section>
  );
}

/**
 * 退款金额。**只读**。
 *
 * 本阶段退款一律整单退款，因此 `amount`（申请退多少）与 `orderTotalAmount`
 * （这一单原价多少）在构造上相等。两个都写出来，是让读者确认它们本来就是一回事。
 */
function AmountSection({ refund }: { refund: StaffRefundDetail }) {
  return (
    <Section title="退款金额">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink-3">整单退款金额</span>
        <span className="text-[20px] font-semibold tabular-nums text-ink">
          ¥{formatYuan(refund.amount)}
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[13px] text-ink-3">原订单实付金额</span>
        <span className="text-[13px] tabular-nums text-ink-2">
          ¥{formatYuan(refund.orderTotalAmount)}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_REFUND_AMOUNT_NOTE}</p>
    </Section>
  );
}

/**
 * 用户摘要。
 *
 * `StaffUserSummary` 只有昵称、头像与平台标识三样——都是客服要能对上话所必需的，
 * **没有** OpenID / UnionID / 手机号，也没有任何支付相关字段。
 */
function UserSection({ refund }: { refund: StaffRefundDetail }) {
  return (
    <Section title="用户">
      <div className="flex items-center gap-3">
        <img
          src={refund.user.avatarUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{refund.user.nickname || "—"}</p>
          <p className="font-mono text-[12px] text-ink-3">{refund.user.id}</p>
        </div>
      </div>
    </Section>
  );
}

/** 申请内容：用户写的原文原样展示，不做格式化、不改写。凭证同样是只读缩略图。 */
function ContentSection({ refund }: { refund: StaffRefundDetail }) {
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
 * ⚠️ 客服也能驳回，因此「审核人」那一行**必须带角色**：`reviewedBy` 可能装着
 * 客服 id（客服驳回时）或管理员 id（管理员通过 / 拒绝时）。
 * 「开始审核」不记审核人（`reviewedBy` 只记结论的做出者），谁开始看的由审计回答。
 */
function ReviewSection({ refund }: { refund: StaffRefundDetail }) {
  return (
    <Section title="审核信息">
      <div className="flex flex-col gap-1">
        <DetailRow
          label="开始审核"
          value={refund.reviewingAt ? formatDateTime(refund.reviewingAt) : ""}
        />
        <DetailRow
          label="审核完成"
          value={refund.reviewedAt ? formatDateTime(refund.reviewedAt) : ""}
        />
        <DetailRow
          label="审核人"
          value={formatAuditActorLabel({
            role: refund.reviewedByRole,
            id: refund.reviewedBy,
            name: refund.reviewedByName,
          })}
        />
        <DetailRow
          label="撤销时间"
          value={refund.cancelledAt ? formatDateTime(refund.cancelledAt) : ""}
        />
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
function TimelineSection({ refund }: { refund: StaffRefundDetail }) {
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
