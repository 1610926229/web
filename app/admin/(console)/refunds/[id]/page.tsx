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
import { formatAuditActorLabel } from "@/lib/constants/adminAudit";
import {
  ADMIN_REFUND_AMOUNT_NOTE,
  ADMIN_REFUND_CONSUMPTION_NOTICE,
  ADMIN_REFUND_DECISION_PENDING_NOTE,
  ADMIN_REFUND_DECISION_QUESTIONS,
  ADMIN_REFUND_DECISION_RATE_BASE_NOTE,
  ADMIN_REFUND_DECISION_SHARED_NOTE,
  ADMIN_REFUND_DETAIL_TITLE,
  ADMIN_REFUND_LIST_TITLE,
} from "@/lib/constants/adminRefunds";
import { EARNING_STATUS_LABELS } from "@/lib/constants/earnings";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { REFUND_RESPONSIBILITY_LABELS, formatRefundRatePercent } from "@/lib/constants/refunds";
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
 * ⚠️ **金额本身仍然是只读的**（P0-13 起口径微调）：申请金额取申请创建时的订单实付快照，
 * 页面上没有任何输入框能改它；`AdminRefundConsole` 里新增的两个输入框是
 * **退款比例**与**责任归属**，三个金额由服务端按订单冻结快照算出来（§16.B）。
 *
 * ⚠️ **P0-13 验收整改（D19）**：确认框里现在**会实时显示预计金额**了。
 * 原先 D15 的「不做预览」被显式取代——它答不出管理员真正要问的问题（见
 * `02-decisions.md` §十一）。取代的只是「不显示」：预计金额由
 * `previewRefundDecisionAmounts()` 调用**服务端同一个公式函数**算出，
 * 界面上没有任何第二份金额公式。本页新增的「订单金额」一段给出基准与口径。
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
      <OrderMoneySection refund={refund} />
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
        开始审核与拒绝只改退款申请，订单按原进度继续；通过会同时写入资金决策与打手收益冲回，
        只有累计退满时订单才变成「已退款」，部分退款不改订单状态。
      </p>
    </Section>
  );
}

/**
 * **订单金额**：这一笔退款比例的基准（P0-13 验收整改 C）。
 *
 * ⚠️ 它与下面那两块**不是一回事**，因此单独一段，不合并：
 * - 这一段是**整张订单**的钱（原价 / 实付 / 累计已退 / 还能退多少 / 双方收益）；
 * - 下面「申请金额」是**这笔申请**创建时的实付快照；
 * - 再下面「实际退款金额」是**这笔决策**最终退出去的钱。
 *
 * 合并成一个数的话，管理员就答不出「这一单还能再退多少」——而部分退款允许
 * 同一单退多次，那个问题从 P0-13 起才真正存在。
 *
 * ⚠️ 口径说明与「五个问题」挂在这里（而不是只放在确认框里）：确认框是**动手时**
 * 才打开的，而「这个比例乘的是谁」是**看数之前**就该知道的事。
 *
 * ⚠️ 全部数字照抄订单冻结快照，页面**不重算**（`architecture-rules.md` §三 第 4 条）。
 */
function OrderMoneySection({ refund }: { refund: AdminRefundDetail }) {
  const { orderMoney } = refund;

  return (
    <Section title="订单金额（退款比例的基准）">
      <div className="flex flex-col gap-1">
        <DetailRow
          label="用户实付"
          value={`¥${formatYuan(orderMoney.actualPaidAmount)}`}
        />
        <DetailRow
          label="订单原价"
          value={`¥${formatYuan(orderMoney.originalAmount)}（优惠券抵扣 ¥${formatYuan(
            orderMoney.couponDiscountAmount,
          )}）`}
        />
        <DetailRow
          label="累计已退款"
          value={`¥${formatYuan(orderMoney.refundedAmount)}`}
        />
        {/* 部分退款允许一单退多次，因此「还能退多少」是本页最要紧的一个数 */}
        <DetailRow
          label="剩余可退款"
          value={`¥${formatYuan(orderMoney.remainingRefundableAmount)}`}
        />
        <DetailRow
          label="打手收益"
          value={`¥${formatYuan(orderMoney.companionBaseIncome)}（已冲回 ¥${formatYuan(
            orderMoney.reversedSoFarAmount,
          )}）`}
        />
        <DetailRow label="平台收益" value={`¥${formatYuan(orderMoney.clubNetIncome)}`} />
        <DetailRow
          label="打手收益状态"
          value={
            orderMoney.companionEarningStatus === null
              ? "还没有收益（订单尚未结算）"
              : EARNING_STATUS_LABELS[orderMoney.companionEarningStatus]
          }
        />
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-admin-line pt-3">
        <p className="text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_DECISION_RATE_BASE_NOTE}</p>
        <p className="text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_DECISION_SHARED_NOTE}</p>
      </div>

      <div className="mt-3 border-t border-admin-line pt-3">
        <p className="text-[13px] text-ink-3">这笔退款怎么算</p>
        <dl className="mt-2 flex flex-col gap-2">
          {ADMIN_REFUND_DECISION_QUESTIONS.map((item) => (
            <div key={item.q}>
              <dt className="text-[13px] text-ink">{item.q}</dt>
              <dd className="mt-0.5 break-words text-[12px] leading-4 text-ink-3">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}

/**
 * 退款金额：**申请金额**（申请时的订单实付快照）与**资金决策**（P0-13）两块。
 *
 * ⚠️ 两块**都要有**，而且不能合成一个数：P0-13 起退款可以是部分的，
 * 「这一单本来涉及多少钱」与「这笔申请最后退了多少」是两个不同的问题。
 * 只显示前者，管理员会以为申请多少就退了多少；只显示后者，又答不出比例是从哪来的。
 *
 * ⚠️ 决策的六项在这里**全给管理员**（产品裁定 Q1-c：平台承担部分必须留下明确、
 * 可审计的记录，不能仅通过「没有 reversal」间接推断）——这一页就是那个记录的可读形态。
 * 客服端与用户端看不到责任归属与平台承担额（D13）。
 */
function AmountSection({ refund }: { refund: AdminRefundDetail }) {
  const { decision } = refund;

  return (
    <Section title="退款金额">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink-3">申请金额（申请时的订单实付快照）</span>
        <span className="text-[20px] font-semibold tabular-nums text-ink">
          ¥{formatYuan(refund.amount)}
        </span>
      </div>

      {decision ? (
        <>
          <div className="mt-4 flex items-baseline justify-between border-t border-admin-line pt-3">
            <span className="text-[13px] text-ink-3">实际退款金额</span>
            <span className="text-[20px] font-semibold tabular-nums text-ink">
              ¥{formatYuan(decision.refundAmount)}
            </span>
          </div>

          <div className="mt-2 flex flex-col gap-1">
            <DetailRow label="退款比例" value={`${formatRefundRatePercent(decision.refundRateBp)}%`} />
            <DetailRow
              label="责任归属"
              value={REFUND_RESPONSIBILITY_LABELS[decision.responsibility]}
            />
            {/* 只有按比例分担才有打手责任比例；其余两种显示「—」，不显示 0%
                （0% 与「这一项不适用」是两件事） */}
            <DetailRow
              label="打手责任比例"
              value={
                decision.companionLiabilityRateBp === null
                  ? ""
                  : `${formatRefundRatePercent(decision.companionLiabilityRateBp)}%`
              }
            />
            <DetailRow
              label="打手收益冲回"
              value={`¥${formatYuan(decision.companionReversalAmount)}`}
            />
            {/* 平台承担额**允许为负**（§17 原文）：打手按原价分账、券由平台承担时，
                冲回额可能大于实际退给用户的钱。照实显示，不夹到 0 */}
            <DetailRow label="平台承担" value={`¥${formatYuan(decision.platformBorneAmount)}`} />
            <DetailRow label="决策时间" value={formatDateTime(decision.decidedAt)} />
          </div>
        </>
      ) : (
        <p className="mt-4 border-t border-admin-line pt-3 text-[13px] leading-5 text-ink-3">
          {ADMIN_REFUND_DECISION_PENDING_NOTE}
        </p>
      )}

      <p className="mt-3 text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_AMOUNT_NOTE}</p>
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
 *
 * ⚠️ P8D-2 起「审核人」那一行**必须带角色**：这个字段现在可能装着客服 id
 * （客服能驳回，只是不能通过）。只显示 `staff-2` 的话，读的人会先去管理账号里找。
 */
function ReviewSection({ refund }: { refund: AdminRefundDetail }) {
  return (
    <Section title="审核信息">
      <div className="flex flex-col gap-1">
        <DetailRow label="开始审核" value={refund.reviewingAt ? formatDateTime(refund.reviewingAt) : ""} />
        <DetailRow label="审核完成" value={refund.reviewedAt ? formatDateTime(refund.reviewedAt) : ""} />
        <DetailRow
          label="审核人"
          value={formatAuditActorLabel({
            role: refund.reviewedByRole,
            id: refund.reviewedBy,
            name: refund.reviewedByName,
          })}
        />
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
