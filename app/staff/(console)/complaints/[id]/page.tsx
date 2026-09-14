/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import StaffComplaintConsole from "@/components/staff/StaffComplaintConsole";
import { formatAuditActorLabel } from "@/lib/constants/adminAudit";
import { COMPLAINT_STATUS_CLASS } from "@/lib/constants/complaints";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { ORDER_STATUS_CLASS } from "@/lib/constants/orders";
import { STAFF_COMPLAINTS_PAGE_TITLE } from "@/lib/constants/staff";
import {
  STAFF_COMPLAINT_DETAIL_TITLE,
  STAFF_COMPLAINT_IMMUTABLE_NOTICE,
} from "@/lib/constants/staffComplaints";
import { getStaffSession } from "@/lib/services/staffAuth";
import { getStaffComplaintDetail } from "@/lib/services/staffComplaints";
import type { StaffComplaintDetail } from "@/lib/types/complaint";
import { formatDateTime, formatYuan } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 投诉处理详情（`/staff/complaints/[id]`）。
 *
 * 处理需要的全部内容都在这一页：正文、凭证、联系方式、关联订单摘要、处理信息、
 * 时间轴与关联订单的会话入口。列表页刻意不带正文与联系方式（§投诉处理），
 * 因此「要写处理结果就必须先读完投诉」。
 *
 * ⚠️ **用户提交的材料只读**：正文、凭证、联系方式由服务端原样读出，本页不提供任何编辑入口，
 * 后端也没有能改它们的接口。处理结果写在另一个字段里，两者永不互相覆盖
 * （说明写在页面上：`STAFF_COMPLAINT_IMMUTABLE_NOTICE`）。
 *
 * ⚠️ **本页只有一处写入口**（`StaffComplaintConsole`），按钮完全由服务端的 `allowedActions`
 * 决定；终态下显示的是「没有可执行的动作」而不是灰按钮。它不写订单、不写退款。
 *
 * ⚠️ 会话入口（`conversationOrderId`）由服务端查好传进来（§八：只查不建会话）：
 * 订单没有沟通记录时**不给入口**——客服不能凭一纸投诉就给一笔订单造出会话。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function StaffComplaintDetailPage({
  params,
  searchParams,
}: PageProps<"/staff/complaints/[id]">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const complaint = await getStaffComplaintDetail(id, query, "server");
  if (!complaint) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <Link
          href="/staff/complaints"
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {STAFF_COMPLAINTS_PAGE_TITLE}
        </Link>
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{STAFF_COMPLAINT_DETAIL_TITLE}</h1>
      </div>

      <SummarySection complaint={complaint} />
      <UserSection complaint={complaint} />
      <ContentSection complaint={complaint} />
      <OrderSection complaint={complaint} />
      <HandlingSection complaint={complaint} />
      <TimelineSection complaint={complaint} />

      <StaffComplaintConsole complaint={complaint} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-24 shrink-0 text-[13px] text-ink-3">{label}</span>
      <span className={`min-w-0 flex-1 break-words text-[13px] text-ink ${mono ? "font-mono text-[12px]" : ""}`}>
        {value || "—"}
      </span>
    </div>
  );
}

function FieldBlock({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <p className="text-[12px] text-ink-3">{title}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink">
        {content || "—"}
      </p>
    </div>
  );
}

function SummarySection({ complaint }: { complaint: StaffComplaintDetail }) {
  return (
    <Section title="投诉信息">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-24 shrink-0 text-[13px] text-ink-3">状态</span>
          <span className={`min-w-0 flex-1 text-[13px] font-medium ${COMPLAINT_STATUS_CLASS[complaint.status]}`}>
            {complaint.statusLabel}
          </span>
        </div>
        <Row label="投诉编号" value={complaint.complaintNo} mono />
        <Row label="投诉类型" value={complaint.typeLabel} />
        <Row label="提交时间" value={formatDateTime(complaint.createdAt)} />
        <Row label="更新时间" value={formatDateTime(complaint.updatedAt)} />
      </div>
    </Section>
  );
}

/**
 * 投诉人摘要。
 *
 * `id` 是平台侧用户标识，客服要靠它跟会话对上（`StaffConversationDetail.user`
 * 里也是这一个）。联系方式在下方的「投诉内容」里**只读**展示——它是用户提交的
 * 原始材料之一，与正文同权限，因此不与这段摘要混排。
 */
function UserSection({ complaint }: { complaint: StaffComplaintDetail }) {
  return (
    <Section title="投诉人">
      <div className="flex items-center gap-3">
        <img
          src={complaint.user.avatarUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{complaint.user.nickname || "—"}</p>
          <p className="font-mono text-[12px] text-ink-3">{complaint.user.id}</p>
        </div>
      </div>
    </Section>
  );
}

/**
 * 投诉内容：**用户提交的原始材料**，原样展示、不做格式化、不改写。
 *
 * 这一块与下面「处理结果」是两块分开的字段，刻意不合并成一段时间线文本：
 * 合起来读会让人分不清哪句是用户说的、哪句是平台说的，而这两者的责任完全不同。
 * 同理，本页没有「编辑」入口——想补一句说明，写进处理结果里。
 */
function ContentSection({ complaint }: { complaint: StaffComplaintDetail }) {
  return (
    <Section title="投诉内容（用户提交，只读）">
      <p className="text-[12px] leading-4 text-ink-3">{STAFF_COMPLAINT_IMMUTABLE_NOTICE}</p>

      <div className="mt-3">
        <FieldBlock title="投诉正文" content={complaint.description} />
      </div>

      <div className="mt-3">
        <FieldBlock title="联系方式" content={complaint.contact} />
      </div>

      <div className="mt-3">
        <p className="text-[12px] text-ink-3">凭证</p>
        {complaint.evidence.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-3">
            {complaint.evidence.map((item) => (
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
 * 关联订单摘要与会话入口。
 *
 * 只给出「这一单是什么、现在到哪一步了」。**未关联订单是合法状态**
 * （平台服务类的投诉本来就没有订单），因此这里说的是「未关联订单」而不是「数据缺失」。
 *
 * ⚠️ 这一块**没有任何写入口**：处理投诉不改订单（§投诉处理）。
 *
 * ⚠️ 会话入口（§八）：只有订单**已经有沟通记录**时才有「进入订单沟通」的链接，
 * 指向 `/staff/conversations/[orderId]`；没有会话时**不给入口**，也绝不创建会话。
 */
function OrderSection({ complaint }: { complaint: StaffComplaintDetail }) {
  const order = complaint.orderSummary;

  if (!order) {
    return (
      <Section title="关联订单">
        <p className="text-[13px] leading-5 text-ink-3">
          这条投诉没有关联订单（例如平台服务类的反馈）。未关联订单不影响处理流程，
          也不代表数据缺失。
        </p>
      </Section>
    );
  }

  return (
    <Section title="关联订单">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-24 shrink-0 text-[13px] text-ink-3">订单状态</span>
          <span className={`min-w-0 flex-1 text-[13px] font-medium ${ORDER_STATUS_CLASS[order.status]}`}>
            {order.statusLabel}
          </span>
        </div>
        <Row label="订单号" value={order.orderNo} mono />
        <Row label="商品" value={order.productTitle} />
        <Row label="实付金额" value={`¥${formatYuan(order.totalAmount)}`} />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-[13px]">
        {complaint.conversationOrderId ? (
          <Link
            href={`/staff/conversations/${complaint.conversationOrderId}`}
            className="text-admin-accent underline-offset-2 hover:underline"
          >
            进入订单沟通
          </Link>
        ) : null}
      </div>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        处理投诉不会修改这一单的状态，也不会产生退款。需要退款时，请在订单沟通页或
        退款处理页里查看对应的退款申请。
      </p>
    </Section>
  );
}

/**
 * 处理信息。
 *
 * 四个时间点各自单独一行、缺哪个就显示「—」：**不推测、不补占位**。
 * 「开始处理」与「出结果」是两个字段：前者只是有人接手了，后者才是结论。
 */
function HandlingSection({ complaint }: { complaint: StaffComplaintDetail }) {
  return (
    <Section title="处理信息">
      <div className="flex flex-col gap-1">
        <Row
          label="开始处理"
          value={complaint.processingAt ? formatDateTime(complaint.processingAt) : ""}
        />
        <Row
          label="处理完成"
          value={complaint.handledAt ? formatDateTime(complaint.handledAt) : ""}
        />
        <Row
          label="处理人"
          value={formatAuditActorLabel({
            role: complaint.handledByRole,
            id: complaint.handledById,
            name: complaint.handledByName,
          })}
        />
      </div>

      <div className="mt-3">
        <FieldBlock title="处理结果" content={complaint.result} />
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        「处理人」只记做出结论（解决或关闭）的账号；开始处理只改状态、不产生结论。
        处理结果与关闭说明共用同一个字段，会展示给提交投诉的用户。
      </p>
    </Section>
  );
}

/** 进度时间轴：**只列已经发生的节点**，不补占位、不推测时间。 */
function TimelineSection({ complaint }: { complaint: StaffComplaintDetail }) {
  return (
    <Section title="状态时间轴">
      <ol className="flex flex-col gap-3">
        {complaint.timeline.map((entry) => (
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
