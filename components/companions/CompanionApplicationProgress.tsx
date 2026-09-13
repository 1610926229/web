/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import {
  COMPANION_APPLICATION_EXISTING_HINTS,
  COMPANION_APPLICATION_MOCK_NOTICE,
  COMPANION_APPLICATION_STATUS_CLASS,
} from "@/lib/constants/companionApplications";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import type { CompanionApplicationDetail } from "@/lib/types/companionApplication";
import { formatDateTime } from "@/lib/utils/format";
import WithdrawApplicationButton from "./WithdrawApplicationButton";

/**
 * 入驻进度（服务端组件，只读 + 可撤销）。
 *
 * 三件事刻意如此：
 *
 * 1. **状态文案与服务端同源**（`statusLabel` / 时间轴都来自服务端 DTO），
 *    前端不再映射一遍，也就不会出现「接口说已通过、页面写成审核中」。
 * 2. **时间轴只列已经发生的节点**，不补「待审核」占位、不推测未来的审核时间。
 * 3. **审核备注只在有值时出现**：还没有结果时，页面不会画出一行空的「审核备注：」，
 *    也不会编造一条结论。本阶段用户新提交的申请永远停在「待查看」。
 *
 * 这里**没有**任何「模拟通过 / 模拟拒绝」入口，也没有重新申请按钮：
 * 审核规则与重新申请规则都未确认，本阶段不能自行发明。
 */
export default function CompanionApplicationProgress({
  application,
}: {
  application: CompanionApplicationDetail;
}) {
  return (
    <div className="flex flex-1 flex-col bg-page pb-6">
      {/* 状态与单号 */}
      <section className="bg-surface px-4 py-4">
        <p className={`text-[18px] font-semibold ${COMPANION_APPLICATION_STATUS_CLASS[application.status]}`}>
          {application.statusLabel}
        </p>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">
          {COMPANION_APPLICATION_EXISTING_HINTS[application.status]}
        </p>
        <div className="mt-2">
          <DetailRow label="申请单号" value={application.applicationNo} />
          <DetailRow label="提交时间" value={formatDateTime(application.submittedAt)} />
          <DetailRow label="最近更新" value={formatDateTime(application.updatedAt)} />
        </div>
      </section>

      {/* 提交内容：申请人自己填的东西，只在本页展示 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">申请内容</h2>
        <div className="mt-1">
          <DetailRow label="陪玩昵称" value={application.displayName} />
          <DetailRow
            label="擅长游戏"
            value={application.games.map((game) => game.name).join("、") || "—"}
          />
          <DetailRow label="可服务大区" value={application.regions.join("、") || "—"} />
          <DetailRow label="服务标签" value={application.serviceTags.join("、") || "—"} />
          {/* 联系说明只在申请人自己的进度页出现，永远不进任何陪玩 DTO */}
          {application.contactNote ? (
            <DetailRow label="联系说明" value={application.contactNote} />
          ) : null}
        </div>

        <FieldBlock title="经验说明" content={application.experience} />
        <FieldBlock title="自我介绍" content={application.introduction} />
      </section>

      {/* Mock 凭证 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">凭证</h2>
        {application.evidence.length > 0 ? (
          <ul className="mt-2 grid grid-cols-3 gap-2">
            {application.evidence.map((item) => (
              <li key={item.id}>
                <img
                  src={item.url}
                  alt=""
                  className="h-20 w-full rounded-[8px] border border-line object-cover"
                />
                <span className="mt-1 block truncate text-[11px] text-ink-3">
                  {EVIDENCE_KIND_LABELS[item.kind]} · {item.name}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[12px] text-ink-3">未上传凭证</p>
        )}
        <p className="mt-2 text-[11px] leading-4 text-ink-3">{COMPANION_APPLICATION_MOCK_NOTICE}</p>
      </section>

      {/* 审核结果：只有真的有结果时才出现，不编造结论 */}
      {application.reviewedAt ? (
        <section className="mt-2 bg-surface px-4 py-3">
          <h2 className="text-[14px] font-medium text-ink">审核结果</h2>
          <div className="mt-1">
            <DetailRow label="处理时间" value={formatDateTime(application.reviewedAt)} />
          </div>
          {application.reviewNote ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
              {application.reviewNote}
            </p>
          ) : null}
          <p className="mt-2 text-[12px] leading-4 text-ink-3">
            审核结果与陪玩公开资料、接单权限、收益之间的绑定规则待确认，本阶段不会自动开通。
          </p>
        </section>
      ) : null}

      {/* 进度时间轴：只列出已经发生的节点 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">申请进度</h2>
        <ol className="mt-2">
          {application.timeline.map((entry) => (
            <li key={entry.key} className="flex gap-3 py-1.5 text-[13px]">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-blue" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 text-ink-2">{entry.label}</span>
                  <span className="ml-auto shrink-0 text-ink-3">{formatDateTime(entry.at)}</span>
                </span>
                <span className="mt-0.5 block break-words text-[12px] leading-4 text-ink-3">
                  {entry.note}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* 撤销入口：是否显示完全取决于服务端给出的 allowedActions */}
      {application.allowedActions.canWithdraw ? (
        <WithdrawApplicationButton applicationId={application.id} />
      ) : null}
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

/** 长文本字段：单独成块，保留换行。 */
function FieldBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <h3 className="text-[13px] text-ink-3">{title}</h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
        {content}
      </p>
    </div>
  );
}
