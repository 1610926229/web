/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, {
  COMPLETION_STATUS_TONE,
  ORDER_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import StaffCompletionConsole from "@/components/staff/StaffCompletionConsole";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { STAFF_COMPLETION_DETAIL_TITLE } from "@/lib/constants/staffCompletions";
import { getStaffSession } from "@/lib/services/staffAuth";
import { getStaffCompletionDetail } from "@/lib/services/staffCompletions";
import type { CompletionSubmissionReviewSource, StaffCompletionDetail } from "@/lib/types/completion";
import { formatDateTime } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/** 审核来源的展示标签。取值只有两个非空：staff = 客服人工审核，system = 到期自动通过。 */
const REVIEW_SOURCE_LABEL: Record<NonNullable<CompletionSubmissionReviewSource>, string> = {
  staff: "人工审核",
  system: "系统自动通过",
};

/**
 * 客服工作台完成材料详情（`/staff/completions/[id]`）。
 *
 * 审核所需的全部内容都在这一页：完成说明、凭证、订单现状、审核信息，
 * 以及服务端判定的 `allowedActions`（通过 / 驳回）。
 *
 * ⚠️ **本页只有一处写入口**（`StaffCompletionConsole`），而且按钮完全由服务端的
 * `allowedActions` 决定；终态下那一块显示的是「没有可执行的动作」而不是灰按钮。
 *
 * ⚠️ `autoApprovalBlockedReason` 只在非 null 时显示：它回答「这份 pending 材料为什么
 * 还没被自动通过」（EX-COMPLETE-05 的阻塞规则），null 时不显示任何提示，
 * 页面**不**用 `status === "pending"` 之类在前端推断阻塞原因。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function StaffCompletionDetailPage({
  params,
  searchParams,
}: PageProps<"/staff/completions/[id]">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const completion = await getStaffCompletionDetail(id, query, "server");
  if (!completion) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <Link
          href="/staff/completions"
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {STAFF_COMPLETION_DETAIL_TITLE}
        </Link>
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{STAFF_COMPLETION_DETAIL_TITLE}</h1>
      </div>

      <SummarySection completion={completion} />
      <UserSection completion={completion} />
      <ContentSection completion={completion} />
      <ReviewSection completion={completion} />

      <StaffCompletionConsole completion={completion} />
    </div>
  );
}

/**
 * 摘要。
 *
 * ⚠️ 完成材料状态与订单状态**并排展示**：两条状态线各自独立。通过会同时把订单推进到
 * `completed`，驳回保持订单 `serving`，只看完成材料状态会让人以为「驳回就等于订单结束」，
 * 而只看订单状态又会以为「还有一份材料悬着」。
 */
function SummarySection({ completion }: { completion: StaffCompletionDetail }) {
  return (
    <Section title="完成材料">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">完成材料状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={completion.statusLabel}
              tone={COMPLETION_STATUS_TONE[completion.status]}
            />
          </span>
        </div>
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">订单状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={completion.orderStatusLabel}
              tone={ORDER_STATUS_TONE[completion.orderStatus]}
            />
          </span>
        </div>
        <DetailRow label="订单号" value={completion.orderNo} />
        <DetailRow label="商品" value={completion.productTitle} />
        <DetailRow label="打手" value={completion.companionName} />
        <DetailRow label="提交时间" value={formatDateTime(completion.submittedAt)} />
        <DetailRow
          label="自动审核截止"
          value={formatDateTime(completion.autoApprovalDeadlineAt)}
        />
        <DetailRow
          label="自动审核时长"
          value={`${completion.autoApprovalMinutesSnapshot} 分钟（提交时冻结）`}
        />
      </div>

      {/* 这份 pending 材料为什么还没被自动通过（EX-COMPLETE-05）：只在有阻塞时显示 */}
      {completion.autoApprovalBlockedReason ? (
        <p className="mt-2 rounded-lg border border-status-pending bg-page px-3 py-2 text-[12px] leading-5 text-status-pending">
          {completion.autoApprovalBlockedReason}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * 下单用户摘要。
 *
 * `StaffUserSummary` 只有昵称、头像与用户 id——都是客服要能对上话所必需的，
 * **没有** OpenID / UnionID / 手机号，也没有任何支付相关字段。
 */
function UserSection({ completion }: { completion: StaffCompletionDetail }) {
  return (
    <Section title="用户">
      <div className="flex items-center gap-3">
        <img
          src={completion.user.avatarUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{completion.user.nickname || "—"}</p>
          <p className="font-mono text-[12px] text-ink-3">{completion.user.id}</p>
        </div>
      </div>
    </Section>
  );
}

/** 打手写的完成说明原样展示，不做格式化、不改写。凭证同样是只读缩略图。 */
function ContentSection({ completion }: { completion: StaffCompletionDetail }) {
  return (
    <Section title="完成内容">
      <FieldBlock title="完成说明" content={completion.summary} />

      <div className="mt-3">
        <p className="text-[13px] text-ink-3">凭证</p>
        {completion.evidence.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-3">
            {completion.evidence.map((item) => (
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
 * ⚠️ `reviewSource` 只有两个非空取值：客服人工审核记 `staff`、到期自动通过记 `system`。
 * 后者是**同一种业务事实**，只是由 System 写结论，因此 `reviewedByName` 必须为 null。
 */
function ReviewSection({ completion }: { completion: StaffCompletionDetail }) {
  return (
    <Section title="审核信息">
      <div className="flex flex-col gap-1">
        <DetailRow
          label="审核来源"
          value={completion.reviewSource ? REVIEW_SOURCE_LABEL[completion.reviewSource] : ""}
        />
        <DetailRow label="审核人" value={completion.reviewedByName ?? ""} />
        <DetailRow
          label="审核时间"
          value={completion.reviewedAt ? formatDateTime(completion.reviewedAt) : ""}
        />
      </div>

      {completion.rejectReason ? (
        <div className="mt-3">
          <FieldBlock title="驳回原因" content={completion.rejectReason} />
        </div>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        通过会把订单同时改为「已完成」；驳回只改完成材料，订单继续「护航中」，打手可重新提交。
      </p>
    </Section>
  );
}
