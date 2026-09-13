/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import RequireAuth from "@/lib/auth/RequireAuth";
import {
  COMPLAINT_RESULT_PENDING_NOTE,
  COMPLAINT_STATUS_CLASS,
  COMPLAINT_STATUS_HINTS,
  COMPLAINT_STATUS_LABELS,
} from "@/lib/constants/complaints";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { getComplaintDetailForUser } from "@/lib/services/complaints";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 投诉详情页（需登录，只读）。
 *
 * 归属由服务端判定：`getComplaintDetailForUser` 在投诉不存在**或不属于当前用户**时都返回 null，
 * 页面因此对两种情况展示同一个「投诉记录不存在」——不能拿投诉 id 去试探别人有没有这条记录。
 *
 * 这里是**唯一**能看到投诉说明、凭证、联系方式与处理结果的地方（列表 DTO 刻意不带这些字段）。
 *
 * 处理结果只来自数据本身：还没有结果时如实显示「客服会在核实后同步」，
 * 绝不预先写出免单 / 补偿 / 退款这类平台没有承诺过的结论。
 * 投诉全程不改动订单状态，页面也不提供任何「申请退款」的入口。
 */
export default async function ComplaintDetailPage({ params }: PageProps<"/complaints/[id]">) {
  const { id } = await params;

  return (
    <>
      <NavBar title="投诉详情" showBack />

      <RequireAuth>
        {(user) => <ComplaintDetailBody complaintId={id ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function ComplaintDetailBody({
  complaintId,
  userId,
}: {
  complaintId: string;
  userId: string;
}) {
  const detail = await getComplaintDetailForUser(complaintId, userId, undefined, "server");

  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="投诉记录不存在"
          description="这条投诉可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        />
        <Link
          href="/complaints"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          返回投诉记录
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip bg-page pb-6">
      {/* 状态 */}
      <section className="bg-surface px-4 py-4">
        <p className={`text-[18px] font-semibold ${COMPLAINT_STATUS_CLASS[detail.status]}`}>
          {COMPLAINT_STATUS_LABELS[detail.status]}
        </p>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">{COMPLAINT_STATUS_HINTS[detail.status]}</p>
        <div className="mt-2">
          <DetailRow label="投诉单号" value={detail.complaintNo} />
          <DetailRow label="提交时间" value={formatDateTime(detail.createdAt)} />
        </div>
      </section>

      {/* 处理结果：有结果才显示结果，没有结果就如实说明，不编造结论 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">处理结果</h2>
        {detail.result ? (
          <>
            <div className="mt-1">
              {detail.handledAt ? (
                <DetailRow label="处理时间" value={formatDateTime(detail.handledAt)} />
              ) : null}
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
              {detail.result}
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-[13px] leading-5 text-ink-3">{COMPLAINT_RESULT_PENDING_NOTE}</p>
        )}
      </section>

      {/* 关联订单：投诉不改变订单状态，所以这里只给一个跳转，不显示「已退款」之类结论 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">关联订单</h2>
          {detail.orderId ? (
            <Link href={`/orders/${detail.orderId}`} className="text-[13px] text-brand-blue">
              查看订单详情
            </Link>
          ) : null}
        </div>
        <p className="mt-1.5 text-[13px] text-ink-2">
          {detail.orderNo ? `订单号 ${detail.orderNo}` : "未关联订单"}
        </p>
      </section>

      {/* 投诉内容：只在这里出现 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">投诉内容</h2>
        <div className="mt-1">
          <DetailRow label="投诉类型" value={detail.typeLabel} />
          <DetailRow label="联系方式" value={detail.contact || "未填写"} />
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
          {detail.description}
        </p>

        {detail.evidence.length > 0 ? (
          <ul className="mt-2 grid grid-cols-3 gap-2">
            {detail.evidence.map((item) => (
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
      </section>

      {/* 进度时间轴：只列出已经发生的节点 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">处理进度</h2>
        <ol className="mt-2">
          {detail.timeline.map((entry) => (
            <li key={entry.key} className="flex gap-3 py-1.5 text-[13px]">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" aria-hidden />
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

      <div className="mt-5 flex justify-center">
        <Link
          href="/complaints"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          返回投诉记录
        </Link>
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
