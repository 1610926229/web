import Link from "next/link";
import { notFound } from "next/navigation";
import AdminApplicationActions from "@/components/admin/AdminApplicationActions";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminStatusBadge, { APPLICATION_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import { ADMIN_APPLICATIONS_PAGE_TITLE } from "@/lib/constants/admin";
import { ADMIN_APPLICATION_DETAIL_TITLE } from "@/lib/constants/adminApplications";
import { COMPANION_APPLICATION_MOCK_NOTICE } from "@/lib/constants/companionApplications";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { formatDateTime } from "@/lib/utils/format";
import { getAdminApplicationDetail } from "@/lib/services/adminCompanionApplications";
import { toSearchParams } from "@/lib/utils/query";
import type { AdminCompanionApplicationDetail } from "@/lib/types/companionApplication";

/**
 * 申请详情（`/admin/applications/[id]`）。
 *
 * 这一页才给出审核真正需要的东西：正文、Mock 凭证、联系说明、申请人摘要、时间轴，
 * 以及**服务端判定的可执行动作**。列表页刻意不带前面那些（§六），
 * 因此「想审核就必须打开详情，打开详情就会看到全文」。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码，「不存在的申请」就变成一屏 200 的 404 文案。
 * 兄弟目录 `(list)` 存在的理由正是这个——列表需要加载边界，详情需要真 404。
 *
 * 申请人摘要里的两件事（是否已有护航、是否已有资格）是「一名用户最多一条有效护航」
 * 在界面上的落点：审核的人据此知道这次通过会新建资料还是复用已有的一条。
 */
export default async function AdminApplicationDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/applications/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const application = await getAdminApplicationDetail(id, query, "server");
  if (!application) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_APPLICATION_DETAIL_TITLE}
        backHref="/admin/applications"
        backLabel={ADMIN_APPLICATIONS_PAGE_TITLE}
      />

      <SummarySection application={application} />
      <ApplicantSection application={application} />
      <ContentSection application={application} />
      <EvidenceSection application={application} />
      <TimelineSection application={application} />

      <AdminApplicationActions
        applicationId={application.id}
        allowedActions={application.allowedActions}
      />
    </div>
  );
}

/** 一行的字段展示：标签 + 值。值为空时显示「—」，不留空白让人以为页面坏了。 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-20 shrink-0 text-[13px] text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-ink-2">{value || "—"}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function SummarySection({ application }: { application: AdminCompanionApplicationDetail }) {
  return (
    <Section title="申请信息">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">状态</span>
          <span className="min-w-0 flex-1">
            <AdminStatusBadge
              label={application.statusLabel}
              tone={APPLICATION_STATUS_TONE[application.status]}
            />
          </span>
        </div>
        <DetailRow label="申请单号" value={application.applicationNo} />
        <DetailRow label="陪玩昵称" value={application.displayName} />
        <DetailRow
          label="游戏"
          value={application.games.map((game) => game.name).join("、")}
        />
        <DetailRow label="大区" value={application.regions.join("、")} />
        <DetailRow label="服务标签" value={application.serviceTags.join("、")} />
        <DetailRow label="提交时间" value={formatDateTime(application.submittedAt)} />
        <DetailRow label="最近更新" value={formatDateTime(application.updatedAt)} />
        <DetailRow
          label="处理时间"
          value={application.reviewedAt ? formatDateTime(application.reviewedAt) : ""}
        />
        <DetailRow label="联系说明" value={application.contactNote} />
      </div>
    </Section>
  );
}

/**
 * 申请人摘要。
 *
 * ⚠️ `userId` 是平台侧标识，**只在管理端出现**，不进任何用户端 DTO。
 * 给出它是因为审核要回答「这个人是不是已经有一条护航了」。
 */
function ApplicantSection({ application }: { application: AdminCompanionApplicationDetail }) {
  const { applicant } = application;

  return (
    <Section title="申请人">
      <div className="flex flex-col gap-1">
        <DetailRow label="用户昵称" value={applicant.nickname} />
        <DetailRow label="用户 ID" value={applicant.userId} />
        <DetailRow
          label="护航资格"
          value={applicant.hasCompanionQualification ? "已具备" : "尚未具备"}
        />
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">已有护航</span>
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">
            {applicant.linkedCompanionId ? (
              <Link
                href={`/admin/companions/${applicant.linkedCompanionId}`}
                className="text-admin-accent underline-offset-2 hover:underline"
              >
                {applicant.linkedCompanionId}
              </Link>
            ) : (
              "无（通过审核会新建一条）"
            )}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        一名用户最多关联一条有效护航：通过审核时若已有护航资料会复用它，不会新建第二条。
      </p>
    </Section>
  );
}

function ContentSection({ application }: { application: AdminCompanionApplicationDetail }) {
  return (
    <Section title="申请内容">
      <div className="flex flex-col gap-3">
        <FieldBlock title="经验说明" content={application.experience} />
        <FieldBlock title="自我介绍" content={application.introduction} />
        {application.reviewNote ? (
          <FieldBlock title="审核意见" content={application.reviewNote} />
        ) : null}
      </div>
    </Section>
  );
}

function FieldBlock({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <p className="text-[13px] text-ink-3">{title}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
        {content || "—"}
      </p>
    </div>
  );
}

/** Mock 凭证。地址由服务端写成 `public/mock` 下的占位图，客户端注入不了外链。 */
function EvidenceSection({ application }: { application: AdminCompanionApplicationDetail }) {
  return (
    <Section title="凭证">
      {application.evidence.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
          {application.evidence.map((item) => (
            <li key={item.id}>
              {/* 凭证是申请人提交的材料，图片本身没有可读文本；说明写在图下方 */}
              <img
                src={item.url}
                alt=""
                className="h-24 w-full rounded-lg border border-admin-line object-cover"
              />
              <span className="mt-1 block truncate text-[12px] text-ink-3">
                {EVIDENCE_KIND_LABELS[item.kind]} · {item.name}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-3">未上传凭证</p>
      )}
      <p className="mt-2 text-[12px] leading-4 text-ink-3">{COMPANION_APPLICATION_MOCK_NOTICE}</p>
    </Section>
  );
}

/** 状态时间轴：**只列已经发生的节点**，不补占位、不推测时间。 */
function TimelineSection({ application }: { application: AdminCompanionApplicationDetail }) {
  return (
    <Section title="状态时间轴">
      <ol className="flex flex-col gap-3">
        {application.timeline.map((entry) => (
          <li key={entry.key} className="flex gap-3">
            <span
              aria-hidden
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-admin-accent"
            />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                {entry.label}
                <span className="ml-2 text-[12px] text-ink-3">{formatDateTime(entry.at)}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-4 text-ink-3">
                {entry.note}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
