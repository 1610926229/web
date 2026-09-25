"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  ADMIN_REFUND_ACTION_LABELS,
  ADMIN_REFUND_CONFIRM_TEXTS,
  ADMIN_REFUND_DECISION_LABELS,
  ADMIN_REFUND_DECISION_NOTE,
  ADMIN_REFUND_DECISION_PERCENT_HINT,
  ADMIN_REFUND_DECISION_QUESTIONS,
  ADMIN_REFUND_DECISION_RATE_BASE_NOTE,
  ADMIN_REFUND_DECISION_SHARED_NOTE,
  ADMIN_REFUND_MOCK_NOTICE,
  ADMIN_REFUND_ORDER_MONEY_LABELS,
  ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE,
  ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE,
  ADMIN_REFUND_PREVIEW_LABELS,
  ADMIN_REFUND_PREVIEW_WITHDRAWN_NOTE,
  ADMIN_REFUND_TERMINAL_NOTICE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
  previewRefundDecisionAmounts,
  readAdminRefundDecisionInput,
  type RefundDecisionPreview,
} from "@/lib/constants/adminRefunds";
import { REFUND_RESPONSIBILITIES } from "@/lib/constants/refunds";
import {
  approveRefund,
  fetchAdminRefund,
  rejectRefund,
  startReviewRefund,
  type AdminRefundDecisionRequest,
} from "@/lib/services/adminHttp";
import type { AdminRefundDetail, AdminRefundOrderMoney, AdminRefundWriteResult } from "@/lib/types/refund";
import { countCharacters } from "@/lib/utils/text";
import { formatYuan } from "@/lib/utils/format";

/** 三个审核动作。它们都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type RefundIntent = "startReview" | "approve" | "reject";

/** 责任归属选择器的初值：**空串 = 还没选**（不是 `platform`）。 */
type ResponsibilityChoice = AdminRefundDecisionRequest["responsibility"] | "";

/**
 * 动作成功后的提示。
 *
 * ⚠️ 通过那条**必须按实际结果分两种说法**：P0-13 起「通过」不再等于「订单已退款」——
 * 只有累计退满才改订单状态，部分退款下这一单按原进度继续。照旧文案写死「订单已变为
 * 已退款」，管理员会把一笔 50% 的退款当成「这一单结束了」。
 *
 * ⚠️ 报出的金额是**服务端返回值**（`written.decidedAmount`），不是确认框里那个预计值：
 * 两者只在「页面数据未过期」时相等，而这里说的必须是**账上真正写下去的数**。
 */
function successMessage(intent: RefundIntent, written: AdminRefundWriteResult): string {
  if (intent === "startReview") {
    return "已开始审核：退款申请标记为「审核中」，订单状态与消费金额未变";
  }
  if (intent === "reject") {
    return "已拒绝：退款申请变为「未通过」，订单状态与消费金额未变";
  }

  const amount = written.decidedAmount === null ? "" : `本次退款 ¥${formatYuan(written.decidedAmount)}；`;
  const orderPart =
    written.orderStatus === "refunded"
      ? "订单已累计退满并变为「已退款」，不再计入用户的累计有效消费。"
      : "这是部分退款，订单状态与履约不变。";

  return `已通过（Mock 审核）：退款申请变为「已通过」，${amount}${orderPart}未执行真实退款。`;
}

/**
 * 确认按钮的文案。
 *
 * ⚠️ **P0-13 验收整改（D19）**：原先只说比例、不报金额（D15）。验收时产品要求
 * 「不应等提交后才知道金额」，因此现在**在按钮上也报出预计金额**——
 * 它是按钮上方那个预览区的同一个数，措辞用「预计」而不是断言，
 * 因为权威值仍然是服务端算完返回的那个 `decidedAmount`。
 *
 * 金额超限或算不出来时**退回不报金额的文案**（`preview` 为 `null`）：
 * 那句「金额由系统计算」在超限时是**错的**，系统不会算、它会拒绝。
 */
function confirmLabel(
  intent: RefundIntent | null,
  ratePercent: string,
  previewedAmount: number | null,
): string {
  if (!intent) return "";
  const rate = ratePercent.trim();
  if (intent !== "approve") return `确认${ADMIN_REFUND_ACTION_LABELS[intent]}`;
  if (rate === "") return `确认${ADMIN_REFUND_ACTION_LABELS[intent]}`;
  if (previewedAmount === null) return `按 ${rate}% 退款，金额由系统计算`;
  return `按 ${rate}% 退款（预计 ¥${formatYuan(previewedAmount)}）`;
}

/** 金额表里的一行。左标签右数值，数值右对齐等宽，便于逐行比对。 */
function MoneyRow({
  label,
  amount,
  strong = false,
  hint,
}: {
  label: string;
  amount: number;
  strong?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[12px] text-ink-3">
        {label}
        {hint ? <span className="ml-1 text-[11px] text-ink-3">{hint}</span> : null}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          strong ? "text-[14px] font-semibold text-ink" : "text-[12px] text-ink-2"
        }`}
      >
        ¥{formatYuan(amount)}
      </span>
    </div>
  );
}

/**
 * 订单金额表：**本次决策的基准**（C）。
 *
 * ⚠️ 顺序不是随意的：先「实付」（比例的基数）、再「已退 / 剩余可退」（这次还能退多少的边界），
 * 最后才是打手收益与平台收益（责任归属会动到的那两个数）。管理员从上往下读一遍
 * 就能把「这个比例乘谁、这次最多退多少」两个问题答完，不需要去别处找。
 */
function OrderMoneyTable({ money }: { money: AdminRefundOrderMoney }) {
  return (
    <div className="rounded-lg border border-admin-line bg-surface px-3 py-2">
      <MoneyRow label={ADMIN_REFUND_ORDER_MONEY_LABELS.actualPaidAmount} amount={money.actualPaidAmount} strong />
      <MoneyRow
        label={ADMIN_REFUND_ORDER_MONEY_LABELS.originalAmount}
        amount={money.originalAmount}
      />
      {/* 券只在非 0 时出现：0 元那一行只会在「原价与实付为什么相等」上帮倒忙 */}
      {money.couponDiscountAmount !== 0 ? (
        <MoneyRow
          label={ADMIN_REFUND_ORDER_MONEY_LABELS.couponDiscountAmount}
          amount={money.couponDiscountAmount}
        />
      ) : null}
      <MoneyRow label={ADMIN_REFUND_ORDER_MONEY_LABELS.refundedAmount} amount={money.refundedAmount} />
      <MoneyRow
        label={ADMIN_REFUND_ORDER_MONEY_LABELS.remainingRefundableAmount}
        amount={money.remainingRefundableAmount}
        strong
      />
      <div className="my-1 border-t border-admin-line" />
      <MoneyRow
        label={ADMIN_REFUND_ORDER_MONEY_LABELS.companionBaseIncome}
        amount={money.companionBaseIncome}
        hint="责任归属会动到它"
      />
      <MoneyRow
        label={ADMIN_REFUND_ORDER_MONEY_LABELS.reversedSoFarAmount}
        amount={money.reversedSoFarAmount}
      />
      <MoneyRow label={ADMIN_REFUND_ORDER_MONEY_LABELS.clubNetIncome} amount={money.clubNetIncome} />
    </div>
  );
}

/**
 * 实时预览（**D**）：管理员每敲一下比例，这里就重算一次。
 *
 * ⚠️ 数量来自 `previewRefundDecisionAmounts()`，它调用的是**服务端写入路径上的同一对函数**
 * （`computeRefundDecisionAmounts` → `resolveFinalDecisionAmounts`）。
 * 本组件里**没有任何一处 `× 比例 / 10000`**——那是这条纪律唯一的验收方式：
 * 在这个文件里搜不到一个金额运算符，就说明它没有第二份公式。
 *
 * ⚠️ 没填全时显示 `ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE` 而**不是 ¥0.00**：
 * 「还没算得出来」与「算出来是 0 元」在界面上必须是两句话。
 */
function DecisionPreview({
  money,
  preview,
  ratePercent,
}: {
  money: AdminRefundOrderMoney;
  preview: RefundDecisionPreview;
  ratePercent: string;
}) {
  if (!preview.ok) {
    return (
      <p
        className={`rounded-lg border px-3 py-2 text-[12px] leading-4 ${
          // 一个字都没填时说「填完就有」；已经开始填了就把规则层的原话给他，
          // 而不是用一句「填完…会显示」把真正的错误盖过去
          ratePercent.trim() === ""
            ? "border-admin-line bg-surface text-ink-3"
            : "border-status-danger bg-surface text-brand-red"
        }`}
      >
        {ratePercent.trim() === "" ? ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE : preview.message}
      </p>
    );
  }

  const { amounts, exceedsPaid } = preview;
  // 冲回后打手还剩多少 = 收益 − 已冲回 − 本次冲回。这是 Q2-a 那条
  // `netAvailableAmount = incomeAmount − cumulativeReversalAmount` 的直接展开，
  // 不是一个新的余额桶
  const companionRemaining =
    money.companionBaseIncome - money.reversedSoFarAmount - amounts.companionReversalAmount;

  return (
    <div className="rounded-lg border border-admin-line bg-surface px-3 py-2">
      <MoneyRow label={ADMIN_REFUND_PREVIEW_LABELS.refundAmount} amount={amounts.refundAmount} strong />
      <MoneyRow
        label={ADMIN_REFUND_PREVIEW_LABELS.companionReversalAmount}
        amount={amounts.companionReversalAmount}
      />
      <MoneyRow
        label={ADMIN_REFUND_PREVIEW_LABELS.platformBorneAmount}
        amount={amounts.platformBorneAmount}
      />
      <MoneyRow
        label={ADMIN_REFUND_PREVIEW_LABELS.companionRemainingAmount}
        amount={companionRemaining}
      />

      {/* 平台承担额允许为负，且那不是错误——必须说出来，否则会被当成界面算错了 */}
      {amounts.platformBorneAmount < 0 ? (
        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          平台承担额为负：本次从打手收益冲回的金额大于退给用户的钱，差额归平台。
        </p>
      ) : null}

      {exceedsPaid ? (
        <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
          {ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE}
        </p>
      ) : null}

      {money.companionEarningStatus === "withdrawn" ? (
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          {ADMIN_REFUND_PREVIEW_WITHDRAWN_NOTE}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 退款详情的**唯一写入口**。
 *
 * 四件事在本组件里被刻意捆在一起，因为它们说的是同一句话——「谁来裁决这笔退款」：
 *
 * 1. **动作由服务端给**：按钮的出没完全按 `allowedActions`，页面不拿 `status` 自己写 `if`。
 *    终态（已通过 / 已拒绝 / 已撤销）因此天然没有按钮，而不是三个灰按钮。
 * 2. **通过是复合写入**：它会在同一次写入里写入资金决策、订单累计退款额与打手收益冲回
 *    （累计退满时才改订单状态）。因此确认框里必须把这些说清楚（文案在常量里）。
 * 3. **金额没有输入框**：管理员填的是**比例**与**责任归属**，三个金额由服务端按订单
 *    冻结的经济快照算出来。确认框里**会实时显示预计金额**（P0-13 验收整改 D19，
 *    取代了原先 D15 的「不做预览」）——但它是调用服务端**同一个公式函数**算的，
 *    本文件里没有任何一处金额算术；提交后以响应里的 `decidedAmount` 为准。
 * 4. **表单校验调用与服务端同一个函数**（`readAdminRefundDecisionInput`）：
 *    同一份规则在两边各写一遍，迟早会出现「前端放过、后端 400」这种没人能解释的失败。
 *
 * ⚠️ **Mock 审核**：不调用真实微信退款、不生成微信退款单号、不代表款项已真实退回。
 * 这句话以 `ADMIN_REFUND_MOCK_NOTICE` 挂在按钮下面，且**任何状态下都显示**。
 *
 * ⚠️ 确认框不是防重手段：真正的防重是「打开确认框时生成一次幂等键、重试用同一个键」
 * 加上服务端的状态判断（§九）。失败时确认框不关，错误留在原地。
 */
export default function AdminRefundConsole({ refund: initialRefund }: { refund: AdminRefundDetail }) {
  const [refund, setRefund] = useState(initialRefund);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<RefundIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  // 资金决策表单（只有「通过」会用到）
  const [ratePercent, setRatePercent] = useState("");
  const [responsibility, setResponsibility] = useState<ResponsibilityChoice>("");
  const [liabilityPercent, setLiabilityPercent] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  const noteCount = countCharacters(note.trim());
  const noteRequired = pendingIntent === "reject";
  const liabilityRequired = responsibility === "shared";

  async function runWrite(
    intent: RefundIntent,
    key: string,
    request: () => Promise<AdminRefundWriteResult>,
  ) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const written = await request();
      keyRef.current = null;
      setPendingIntent(null);
      // 表单在成功后清空：下次打开确认框时不该还留着上一笔的比例
      setRatePercent("");
      setResponsibility("");
      setLiabilityPercent("");

      // 不拿响应里的几个字段自己拼新状态：通过会同时改订单与打手收益，
      // 重新取一次详情才是唯一权威。响应里的 `decidedAmount` 只用来回答
      // 「刚刚这一下退了多少」——那个数不在详情页的概览位置上。
      const fresh = await fetchAdminRefund(refund.id);
      setRefund(fresh);
      setFlash(successMessage(intent, written));
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: RefundIntent) {
    keyRef.current = crypto.randomUUID();
    setNote("");
    setNoteError(null);
    setConfirmError(null);
    setDecisionError(null);
    setFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
    setNoteError(null);
    setDecisionError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    if (!key || !pendingIntent || busy) return;

    // 通过的意见选填：留空就留空，只有写了才校验长度。
    // 拒绝的意见必填，且**调用与服务端同一个函数**校验（必填 + 长度上限），
    // 界面没有 `maxLength`，超长必须被明确拒绝而不是被悄悄截断。
    if (pendingIntent === "approve") {
      const trimmed = note.trim();
      if (trimmed && countCharacters(trimmed) > ADMIN_REVIEW_NOTE_MAX_LENGTH) {
        setNoteError(ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE);
        noteRef.current?.focus();
        return;
      }

      // 校验的字段名与请求体完全一致，因此这一步判的就是**即将发出去的东西**
      // （含「没选责任归属」这种情况，它交给规则层给文案，这里不自己写一份）。
      const checked = readAdminRefundDecisionInput({
        refundRatePercent: ratePercent,
        responsibility,
        companionLiabilityRatePercent: liabilityPercent,
      });
      if (!checked.ok) {
        setDecisionError(checked.message);
        rateRef.current?.focus();
        return;
      }

      // 责任归属从**校验结果**里取，不从表单状态里取：那里它是空串可能是 `""`，
      // 判别联合上写不出 `""`，而随手写死一个值会把「打手承担」悄悄变成「平台承担」。
      // 责任比例只在分担制下进请求体：其余两种传了会被服务端 400（金额字段不静默忽略）。
      const picked = checked.input.responsibility;
      const decision: AdminRefundDecisionRequest =
        picked === "shared"
          ? {
              refundRatePercent: ratePercent,
              responsibility: "shared",
              companionLiabilityRatePercent: liabilityPercent,
            }
          : { refundRatePercent: ratePercent, responsibility: picked };

      void runWrite("approve", key, () => approveRefund(refund.id, key, trimmed, decision));
      return;
    }

    if (pendingIntent === "reject") {
      const checked = normalizeAdminReviewNote(note);
      if (!checked.ok) {
        setNoteError(checked.message);
        noteRef.current?.focus();
        return;
      }
      void runWrite("reject", key, () => rejectRefund(refund.id, key, checked.value));
      return;
    }

    void runWrite("startReview", key, () => startReviewRefund(refund.id, key));
  }

  const { allowedActions } = refund;
  const hasAction =
    allowedActions.canStartReview || allowedActions.canApprove || allowedActions.canReject;

  /**
   * 实时预览。**只在「通过」的确认框里算**：其余两个动作不写金额，
   * 为一次「拒绝」跑一遍金额公式既没有展示位置，也会让人以为拒绝也要填比例。
   *
   * ⚠️ 「每敲一个字符就重算」是这里的**全部意义**（验收整改 D）：管理员必须在
   * **按下去之前**就看到金额。它是纯函数（不读仓储、不发请求、不取时间），因此
   * 每次渲染跑一遍没有代价，也不需要防抖。
   */
  const preview =
    pendingIntent === "approve"
      ? previewRefundDecisionAmounts({
          orderMoney: refund.orderMoney,
          refundRatePercent: ratePercent,
          responsibility,
          companionLiabilityRatePercent: liabilityPercent,
        })
      : null;

  // 按钮上只在「算得出来且不会被金额闸拒绝」时报金额：超限时报一个注定被拒的数字，
  // 比不报更误导
  const previewedAmount =
    preview?.ok && !preview.exceedsPaid ? preview.amounts.refundAmount : null;

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">审核操作</h2>

      {hasAction ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("startReview")}
            disabled={!allowedActions.canStartReview}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.startReview}
          </button>
          <button
            type="button"
            onClick={() => openIntent("approve")}
            disabled={!allowedActions.canApprove}
            className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.approve}
          </button>
          <button
            type="button"
            onClick={() => openIntent("reject")}
            disabled={!allowedActions.canReject}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {ADMIN_REFUND_ACTION_LABELS.reject}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_REFUND_TERMINAL_NOTICE}</p>
      )}

      {/* Mock 标注：任何状态下都在，包括「已通过」之后 */}
      <p className="mt-3 rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {ADMIN_REFUND_MOCK_NOTICE}
      </p>

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_REFUND_ACTION_LABELS[pendingIntent]}这笔退款申请` : ""}
        description={pendingIntent ? ADMIN_REFUND_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={confirmLabel(pendingIntent, ratePercent, previewedAmount)}
        tone={pendingIntent === "reject" ? "danger" : "primary"}
        /* 通过时要放金额表 + 实时预览 + 口径说明，`md` 宽度下会被挤成一列读不清 */
        size={pendingIntent === "approve" ? "lg" : "md"}
        pending={busy}
        error={confirmError}
        initialFocusRef={
          pendingIntent === "startReview" ? undefined : pendingIntent === "approve" ? rateRef : noteRef
        }
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingIntent === "approve" ? (
          <div className="flex flex-col gap-3 rounded-lg border border-admin-line bg-page p-3">
            <p className="text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_DECISION_NOTE}</p>

            {/* ① 基准：这次决策动的是哪几个数（C） */}
            <OrderMoneyTable money={refund.orderMoney} />

            {/* ② 输入：比例与责任归属（A / B） */}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-ink-3">{ADMIN_REFUND_DECISION_LABELS.rate}</span>
              <input
                ref={rateRef}
                value={ratePercent}
                inputMode="numeric"
                autoComplete="off"
                placeholder={ADMIN_REFUND_DECISION_PERCENT_HINT}
                onChange={(event) => {
                  setRatePercent(event.target.value);
                  // 边填边撤掉上一次的报错：错误留在输入框下面，直到下一次提交再重判
                  setDecisionError(null);
                }}
                aria-invalid={decisionError ? true : undefined}
                aria-describedby={decisionError ? "refund-decision-error" : undefined}
                className={`h-9 rounded-lg border px-3 text-[13px] text-ink outline-none ${
                  decisionError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
                }`}
              />
              {/* A：比例乘的是哪个金额。这句话必须紧贴输入框——离远了就等于没说 */}
              <span className="text-[11px] leading-4 text-ink-3">
                {ADMIN_REFUND_DECISION_RATE_BASE_NOTE}
              </span>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-[12px] text-ink-3">
                {ADMIN_REFUND_DECISION_LABELS.responsibility}
              </legend>
              {REFUND_RESPONSIBILITIES.map((item) => (
                <label key={item.key} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="refund-responsibility"
                    value={item.key}
                    checked={responsibility === item.key}
                    onChange={() => {
                      setResponsibility(item.key);
                      setDecisionError(null);
                      // 切走时**清空**责任比例：留着它，下次切回分担制会带出一个上一轮的旧数，
                      // 而界面上那句话看起来像是这一轮填的
                      if (item.key !== "shared") setLiabilityPercent("");
                    }}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-ink">{item.label}</span>
                    {/* B：每个选项直接写出它会怎么算——不再是一句抽象描述 */}
                    <span className="block text-[12px] leading-4 text-ink-3">{item.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {/* 只有分担制才渲染责任比例：另外两种下服务端会 400 拒绝它（金额字段不静默忽略） */}
            {liabilityRequired ? (
              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-ink-3">
                    {ADMIN_REFUND_DECISION_LABELS.liability}
                  </span>
                  <input
                    value={liabilityPercent}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={ADMIN_REFUND_DECISION_PERCENT_HINT}
                    onChange={(event) => {
                      setLiabilityPercent(event.target.value);
                      setDecisionError(null);
                    }}
                    aria-invalid={decisionError ? true : undefined}
                    aria-describedby={decisionError ? "refund-decision-error" : undefined}
                    className={`h-9 rounded-lg border px-3 text-[13px] text-ink outline-none ${
                      decisionError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
                    }`}
                  />
                </label>
                {/* B：说清「按比例分担」到底是谁和谁分担、乘的是哪个基数 */}
                <span className="text-[11px] leading-4 text-ink-3">
                  {ADMIN_REFUND_DECISION_SHARED_NOTE}
                </span>
              </div>
            ) : null}

            {/* ③ 实时结果：每敲一下重算一次（D） */}
            {preview ? <DecisionPreview money={refund.orderMoney} preview={preview} ratePercent={ratePercent} /> : null}

            {/* E：五个问题。默认收起——它是要「查得到」，不是要「挡在面前」 */}
            <details className="rounded-lg border border-admin-line bg-surface px-3 py-2">
              <summary className="cursor-pointer text-[12px] text-ink-2">
                这笔退款到底怎么算？（五个问题）
              </summary>
              <dl className="mt-2 flex flex-col gap-2">
                {ADMIN_REFUND_DECISION_QUESTIONS.map((item) => (
                  <div key={item.q}>
                    <dt className="text-[12px] font-medium text-ink">{item.q}</dt>
                    <dd className="mt-0.5 text-[12px] leading-4 text-ink-3">{item.a}</dd>
                  </div>
                ))}
              </dl>
            </details>

            {decisionError ? (
              <span id="refund-decision-error" role="alert" className="text-[12px] text-brand-red">
                {decisionError}
              </span>
            ) : null}
          </div>
        ) : null}

        {pendingIntent === "approve" || pendingIntent === "reject" ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>
                {noteRequired
                  ? "审核意见（必填，会展示给申请人）"
                  : "审核意见（选填，会展示给申请人）"}
              </span>
              {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚。 */}
              <AdminCharacterCounter current={noteCount} max={ADMIN_REVIEW_NOTE_MAX_LENGTH} />
            </span>
            <textarea
              ref={noteRef}
              value={note}
              rows={3}
              onChange={(event) => {
                const value = event.target.value;
                setNote(value);
                // 边写边说：超限立刻标红；「必填」留给提交时提示
                setNoteError(
                  countCharacters(value.trim()) > ADMIN_REVIEW_NOTE_MAX_LENGTH
                    ? ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE
                    : null,
                );
              }}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? "refund-note-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                noteError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {noteError ? (
              <span id="refund-note-error" role="alert" className="text-[12px] text-brand-red">
                {noteError}
              </span>
            ) : null}
          </label>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
