/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import { formatAuditActorLabel } from "@/lib/constants/adminAudit";
import {
  ADMIN_REFUND_AMOUNT_NOTE,
  ADMIN_REFUND_CONSUMPTION_NOTICE,
  ADMIN_REFUND_DECISION_OUTCOME_NOTE,
  ADMIN_REFUND_DECISION_PENDING_NOTE,
  ADMIN_REFUND_DECISION_QUESTIONS,
  ADMIN_REFUND_DECISION_RATE_BASE_NOTE,
} from "@/lib/constants/adminRefunds";
import { EVIDENCE_KIND_LABELS } from "@/lib/constants/evidence";
import { formatRefundDecisionRate } from "@/lib/constants/refunds";
import type { AdminRefundDetail } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/**
 * 退款详情里**只读**的七块：退款申请 / 订单金额 / 退款金额 / 用户 / 申请内容 /
 * 审核信息 / 状态时间轴。
 *
 * 抽出来与 `AdminRefundConsole` 同一个理由（P1-3）：售后工作台的聚合详情页要展示
 * **同一份**案件内容，各写一套就会有两份定义——一处改了另一处不会跟着改，
 * 而这里变的恰恰是金额口径与空值占位这类不能有两说的东西。
 *
 * ⚠️ **本文件只读**：没有任何输入框、按钮或写接口调用，页面上也没有第二处能改金额的地方
 * （申请金额取申请创建时的订单实付快照）。唯一的写入口仍然是 `AdminRefundConsole`，
 * 它由调用方自己放在页面上，不在本文件里。
 *
 * ⚠️ **服务端组件**（刻意没有 `"use client"`）：内容全部来自已经取好的 `AdminRefundDetail`，
 * 加上它只会把数据获取拖进浏览器包。组件本身不取数。
 *
 * ⚠️ **本文件不做任何金额运算**：所有数字都是服务端算好放在 DTO 上的，这里只做 `formatYuan`
 * 展示；「比例」也是服务端写下来的决策字段，不在这里重算。
 *
 * ⚠️ 本文件是从 `app/admin/(console)/refunds/[id]/page.tsx` **逐字搬过来**的：
 * 标题、字段顺序、`DetailRow` / `FieldBlock` 的用法、条件渲染与 `—` 之类的空值占位
 * 都与那一页原来的渲染一模一样。要改这里的排版就等于同时改那一页。
 */
export default function AdminRefundSections({ refund }: { refund: AdminRefundDetail }) {
  return (
    <>
      <SummarySection refund={refund} />
      <OrderMoneySection refund={refund} />
      <AmountSection refund={refund} />
      <UserSection refund={refund} />
      <ContentSection refund={refund} />
      <ReviewSection refund={refund} />
      <TimelineSection refund={refund} />
    </>
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
        开始审核与拒绝只改退款申请，订单按原进度继续；通过会同时写入资金决策与打手收益冲回。
        只有全额退款（比例 100%）才让订单变成「已退款」，部分退款不改订单状态——
        打手那一侧的「已退款」是派生出来的展示状态，与订单状态不是同一条线。
      </p>
    </Section>
  );
}

/**
 * **订单金额**：这一笔退款比例的基准（P0-13 验收整改 C）。
 *
 * ⚠️ 它与下面那两块**不是一回事**，因此单独一段，不合并：
 * - 这一段是**整张订单**的钱（原价 / 实付 / 累计已退 / 双方收益）；
 * - 下面「申请金额」是**这笔申请**创建时的实付快照；
 * - 再下面「实际退款金额」是**这笔决策**最终退出去的钱。
 *
 * ⚠️ **P0-15 删掉了三行**，删的原因不是「这页太挤」：
 * - 「剩余可退款」：一个订单只退一次，退过就没有第二次，这个数永远是
 *   「没退过 = 实付 / 退过 = 0」——它不再是一个需要管理员读的量；
 * - 「已冲回 ¥X」：冲回只有一次且必然是全额，「冲回额 ÷ 打手收益」恒为 100%；
 * - 「打手收益状态」：那一行原本是为 D17 的 `withdrawn` 特例准备的，
 *   而该特例在普通退款流程里不可达（见 `adminRefundTransaction.ts` 第 ④ 步）。
 *
 * ⚠️ 口径说明与「四个问题」挂在这里（而不是只放在确认框里）：确认框是**动手时**
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
        <DetailRow
          label="打手收益"
          value={`¥${formatYuan(orderMoney.companionBaseIncome)}（通过后全额冲回）`}
        />
        <DetailRow label="平台收益" value={`¥${formatYuan(orderMoney.clubNetIncome)}`} />
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-admin-line pt-3">
        <p className="text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_DECISION_RATE_BASE_NOTE}</p>
        <p className="text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_DECISION_OUTCOME_NOTE}</p>
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
 * ⚠️ **P0-15 之后决策只剩三项**：退款比例、退款金额、打手收益冲回。
 * 原先的「责任归属 / 打手责任比例 / 平台承担额 / 退款方式（按比例或退满剩余）」
 * 四项全部删除——责任模型整体废止，「退满剩余」随一单一退坍缩成 100%。
 *
 * ⚠️ 因此 Q1-c 那条裁定（「平台承担部分必须留下明确、可审计的记录」）
 * **失去了它的对象**：不再有任何一方「承担」什么，剩下的归平台是唯一结果，
 * 由 `refundAmount` 与 `orderMoney.actualPaidAmount` 两者直接相减即可得出，
 * 不需要、也不应该再存第三个字段（存了就会与那两个数恒等，成为第二份真值）。
 * 客服端与用户端依旧看不到这些决策字段（D13）。
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
            {/* P0-15 起这里**只有一个形态**：管理员填的比例原样报回来。
                P0-14 的「退款方式 / 按比例或退满剩余」两态与「责任归属」三行都已删除，
                `formatRefundDecisionRate` 因此退化成一次纯格式化（不再有分支）。 */}
            <DetailRow label="退款比例" value={formatRefundDecisionRate(decision)} />
            <DetailRow
              label="打手收益冲回"
              value={`¥${formatYuan(decision.companionReversalAmount)}`}
            />
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
