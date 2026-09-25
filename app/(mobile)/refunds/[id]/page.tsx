/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import PriceText from "@/components/common/PriceText";
import RefundCancelButton from "@/components/refunds/RefundCancelButton";
import RequireAuth from "@/lib/auth/RequireAuth";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { REFUND_STATUS_CLASS, REFUND_STATUS_HINTS, REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { getRefundDetailForUser } from "@/lib/services/refunds";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 退款详情页（需登录，只读 + 可撤销）。
 *
 * 归属由服务端判定：`getRefundDetailForUser` 在退款申请不存在**或不属于当前用户**时都返回 null，
 * 页面因此对两种情况展示同一个「退款申请不存在」——不能拿退款 id 去试探别人有没有这笔申请。
 *
 * **订单状态与退款状态在这里并排展示，这是有意为之**：退款审核期间订单仍是原来的
 * 「已付款 / 已接单 / 护航中」，页面必须如实显示订单现在的状态，而不是把它写成「已退款」。
 * 用户新提交的申请只会是「待审核」，后续状态由将来的审核流程推进，本阶段用户端没有审核入口。
 */
export default async function RefundDetailPage({ params }: PageProps<"/refunds/[id]">) {
  const { id } = await params;

  return (
    <>
      <NavBar title="退款详情" showBack />

      <RequireAuth>
        {(user) => <RefundDetailBody refundId={id ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function RefundDetailBody({ refundId, userId }: { refundId: string; userId: string }) {
  const detail = await getRefundDetailForUser(refundId, userId, undefined, "server");

  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="退款申请不存在"
          description="这笔退款申请可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        />
        <Link
          href="/orders"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          返回订单列表
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip bg-page pb-6">
      {/* 退款状态 */}
      <section className="bg-surface px-4 py-4">
        <p className={`text-[18px] font-semibold ${REFUND_STATUS_CLASS[detail.status]}`}>
          {REFUND_STATUS_LABELS[detail.status]}
        </p>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">{REFUND_STATUS_HINTS[detail.status]}</p>
        <div className="mt-2">
          <DetailRow label="退款单号" value={detail.refundNo} />
          <DetailRow label="申请时间" value={formatDateTime(detail.createdAt)} />
        </div>
      </section>

      {/* 退款金额：**申请金额**与**实际退款金额**是两个数（P0-13 起退款可以是部分的）。
          ⚠️ 只显示申请金额，用户会以为钱按那个数退回来了；只显示实退金额，
          他又对不上「我申请的时候写的明明是全额」。两个数都在，才答得清「为什么少了」。 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-ink">申请金额</span>
          <PriceText cents={detail.amount} className="text-[18px] text-brand-red" />
        </div>
        <p className="mt-1.5 text-[12px] leading-4 text-ink-3">申请时的订单实付金额</p>

        {detail.decidedAmount === null ? null : (
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
            <span className="text-[14px] text-ink">实际退款金额</span>
            <PriceText cents={detail.decidedAmount} className="text-[18px] text-brand-red" />
          </div>
        )}
      </section>

      {/* 关联订单：同时展示订单**当前**的业务状态，退款审核不影响它 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">关联订单</h2>
          <Link href={`/orders/${detail.orderId}`} className="text-[13px] text-brand-blue">
            查看订单详情
          </Link>
        </div>

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
            <p className="mt-1 truncate text-[12px] text-ink-3">{detail.specName}</p>
            <p className="mt-auto pt-1 text-[12px] text-ink-3">
              订单号 {detail.orderNo} · 数量 ×{detail.quantity}
            </p>
          </div>
        </div>

        <div className="mt-2">
          <MoneyRow label="订单实付" cents={detail.orderTotalAmount} />
          <DetailRow label="订单当前状态" value={detail.orderStatusLabel} />
        </div>
        <p className="mt-1.5 text-[12px] leading-4 text-ink-3">
          退款审核期间订单保持原状态继续，只有审核通过后才会变成「已退款」。
        </p>
      </section>

      {/* 申请内容 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">申请内容</h2>
        <div className="mt-1">
          <DetailRow label="退款原因" value={detail.reasonLabel} />
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

      {/* 处理结果：只有审核完成（通过 / 拒绝）才有内容，待审核时不编造结论 */}
      {detail.reviewedAt ? (
        <section className="mt-2 bg-surface px-4 py-3">
          <h2 className="text-[14px] font-medium text-ink">处理结果</h2>
          <div className="mt-1">
            <DetailRow label="处理时间" value={formatDateTime(detail.reviewedAt)} />
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
            {detail.reviewNote || REFUND_STATUS_LABELS[detail.status]}
          </p>
        </section>
      ) : null}

      {/* 进度时间轴：只列出已经发生的节点 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">退款进度</h2>
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

      {/* 撤销入口：是否显示完全取决于服务端给出的 allowedActions */}
      {detail.allowedActions.canCancelRefund ? (
        <RefundCancelButton refundId={detail.id} />
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

/** 金额行：与订单详情页同一口径，一律经 `PriceText` 展示，保证两位小数只有一处实现。 */
function MoneyRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="min-w-0 flex-1 break-words text-ink-3">{label}</span>
      <PriceText cents={cents} className="shrink-0 text-[13px] text-ink" />
    </div>
  );
}
