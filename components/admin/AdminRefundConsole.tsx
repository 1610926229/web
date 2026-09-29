"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  ADMIN_REFUND_ACTION_LABELS,
  ADMIN_REFUND_CONFIRM_TEXTS,
  ADMIN_REFUND_DECISION_LABELS,
  ADMIN_REFUND_DECISION_NOTE,
  ADMIN_REFUND_DECISION_OUTCOME_NOTE,
  ADMIN_REFUND_DECISION_PERCENT_HINT,
  ADMIN_REFUND_DECISION_QUESTIONS,
  ADMIN_REFUND_DECISION_RATE_BASE_NOTE,
  ADMIN_REFUND_MOCK_NOTICE,
  ADMIN_REFUND_ORDER_MONEY_LABELS,
  ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE,
  ADMIN_REFUND_PREVIEW_LABELS,
  ADMIN_REFUND_TERMINAL_NOTICE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
  previewRefundDecisionAmounts,
  readAdminRefundDecisionInput,
  type RefundDecisionPreview,
} from "@/lib/constants/adminRefunds";
import {
  approveRefund,
  fetchAdminRefund,
  rejectRefund,
  startReviewRefund,
} from "@/lib/services/adminHttp";
import type { AdminRefundDetail, AdminRefundOrderMoney, AdminRefundWriteResult } from "@/lib/types/refund";
import { countCharacters } from "@/lib/utils/text";
import { formatYuan } from "@/lib/utils/format";

/** 三个审核动作。它们都是**一次状态迁移**，不是一个「把状态改成 X」的自由输入。 */
type RefundIntent = "startReview" | "approve" | "reject";

/**
 * 动作成功后的提示。
 *
 * ⚠️ 通过那条**必须按实际结果分两种说法**：P0-13 起「通过」不再等于「订单已退款」——
 * 只有退款比例是 100% 才改订单状态，部分退款下这一单按原进度继续
 * （打手收益照样归零，但那不改订单生命周期）。照旧文案写死「订单已变为
 * 已退款」，管理员会把一笔 50% 的退款当成「这一单结束了」。
 *
 * ⚠️ 报出的金额是**服务端返回值**（`written.decidedAmount`），不是确认框里那个预计值：
 * 两者只在「页面数据未过期」时相等，而这里说的必须是**账上真正写下去的数**。
 *
 * ⚠️ 判据用**服务端返回的订单状态**而不是「比例是不是 100」：页面手上的比例
 * 与服务端真正落库的那个数是两份数据，能回答「这一单现在是什么状态」的只有服务端。
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
      ? "订单已全额退款并变为「已退款」，不再计入用户的累计有效消费。"
      : "这是部分退款，订单状态与履约不变；打手本单收益已全部取消。";

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
 * 金额超限或算不出来时**退回不报金额的文案**（`previewedAmount` 为 `null`）：
 * 那句「金额由系统计算」在超限时是**错的**，系统不会算、它会拒绝。
 *
 * ⚠️ **P0-15 删掉了「退满剩余」那一条分支**：那一路上没有比例可报，
 * 因此按钮说的是意图本身，需要单独一段文案。多步退款模型废止后
 * 「退满剩余」收敛为「比例填 100」，按钮文案因此回到统一的百分比写法——
 * 它现在**只**依赖管理员填的那个数，没有一个需要特判的模式。
 */
function confirmLabel(
  intent: RefundIntent | null,
  ratePercent: string,
  previewedAmount: number | null,
): string {
  if (!intent) return "";
  if (intent !== "approve") return `确认${ADMIN_REFUND_ACTION_LABELS[intent]}`;

  const rate = ratePercent.trim();
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
 * ⚠️ 顺序不是随意的：先「实付」（比例的**基数**），再原价与券（解释实付是怎么来的），
 * 然后是打手收益（**这一笔退款会整笔冲掉的那个数**）与平台收益。
 * 管理员从上往下读一遍就能把「这个比例乘谁」与「这笔退款会动到哪笔钱」答完。
 *
 * ⚠️ **P0-15 删掉两行**：「当前剩余可退款」与「打手收益已冲回」。
 * 前者的概念（一个「最多能退多少」的上限）在一单一退的模型里不存在，
 * 后者恒为 0（管理端看到这张表时，那唯一一次退款还没执行）。
 * 详见 `ADMIN_REFUND_ORDER_MONEY_LABELS` 上的说明。
 *
 * ⚠️ `refundedAmount` 那一行**只在非 0 时**出现（与优惠券同一处理）：
 * 正常流程里它恒为 0，而一行永远写着 ¥0.00 的「累计已退款」会让管理员
 * 以为这一单退过钱，进而怀疑自己看到的是不是一张干净的单子。
 * 它非 0 只可能来自**免审批直接退款**那条不产生申请的路径或历史数据——
 * 那时它必须显示出来，因为逾期未退的账是真实存在的。
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
      {money.refundedAmount !== 0 ? (
        <MoneyRow label={ADMIN_REFUND_ORDER_MONEY_LABELS.refundedAmount} amount={money.refundedAmount} />
      ) : null}
      <div className="my-1 border-t border-admin-line" />
      <MoneyRow
        label={ADMIN_REFUND_ORDER_MONEY_LABELS.companionBaseIncome}
        amount={money.companionBaseIncome}
        hint="通过后全额冲回"
      />
      <MoneyRow label={ADMIN_REFUND_ORDER_MONEY_LABELS.clubNetIncome} amount={money.clubNetIncome} />
    </div>
  );
}

/**
 * 实时预览（**D**）：管理员每敲一下比例，这里就重算一次。
 *
 * ⚠️ 数量来自 `previewRefundDecisionAmounts()`，它调用的是**服务端写入路径上的同一个函数**
 * （`computeRefundDecisionAmounts`）。
 *
 * ⚠️ 这条纪律的验收方式是「**本文件里没有任何一处 × 比例 / 10000**」，
 * 也就是没有任何一处**从比例推金额**的算式。（早先这里写的是「搜不到一个金额运算符」——
 * 那是个过强的断言；真正的界线是「不许有第二份公式」。）
 *
 * ⚠️ **P0-15 删掉两行**：「本次由平台承担」与「冲回后打手剩余收益」。
 * 前者在新口径下恒等于退款金额；后者**恒为 0**（打手整笔归零），
 * 显示一行永远是 0 的数字比不显示更容易被误读成「还有剩余」。
 * 「平台最终收入」改由上面的订单金额表表达。
 *
 * ⚠️ **P0-15 也删掉了「已提现」提示**：它对应 D17 的例外，
 * 而那个例外在普通退款流程里不可达（见 `02-decisions.md` Q1 与
 * `adminRefundTransaction.ts` 第 ④ 步的说明）。
 *
 * ⚠️ 没填全时显示一句「填完就有」而**不是 ¥0.00**：
 「还没算得出来」与「算出来是 0 元」在界面上必须是两句话。
 */
function DecisionPreview({
  preview,
  blankNote,
}: {
  preview: RefundDecisionPreview;
  /** 一个字都还没填时显示的那句话；已经开始填了就是 `null`（那时要给规则层的原话） */
  blankNote: string | null;
}) {
  if (!preview.ok) {
    return (
      <p
        className={`rounded-lg border px-3 py-2 text-[12px] leading-4 ${
          // 一个字都没填时说「填完就有」；已经开始填了就把规则层的原话给他，
          // 而不是用一句「填完…会显示」把真正的错误盖过去
          blankNote
            ? "border-admin-line bg-surface text-ink-3"
            : "border-status-danger bg-surface text-brand-red"
        }`}
      >
        {blankNote ?? preview.message}
      </p>
    );
  }

  const { amounts, gateMessage } = preview;

  return (
    <div className="rounded-lg border border-admin-line bg-surface px-3 py-2">
      <MoneyRow label={ADMIN_REFUND_PREVIEW_LABELS.refundAmount} amount={amounts.refundAmount} strong />
      <MoneyRow
        label={ADMIN_REFUND_PREVIEW_LABELS.companionReversalAmount}
        amount={amounts.companionReversalAmount}
      />

      {/*
        ⚠️ **原样转述金额闸自己的话**，不为「超过实付」另写一份（P0-15）。
        原先这里渲染的是一句固定的「本次退款金额超过该订单的实际支付金额……」，
        而它的触发条件只是「金额闸拒绝了」——填 0 时账实不符，补救方向也指反了。
      */}
      {gateMessage ? (
        <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
          {gateMessage}
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
 *    （比例 100% 时才改订单状态）。因此确认框里必须把这些说清楚（文案在常量里）。
 * 3. **金额没有输入框**：管理员填的**只有退款比例**，两个金额由服务端按订单冻结的
 *    经济快照算出来。确认框里**会实时显示预计金额**（P0-13 验收整改 D19，
 *    取代了原先 D15 的「不做预览」）——但它是调用服务端**同一个公式函数**算的，
 *    本文件里没有任何一处金额算术；提交后以响应里的 `decidedAmount` 为准。
 *    ⚠️ **P0-15 把这个表单从三件套减成一个输入框**：责任归属单选组、
 *    打手责任比例输入框、以及「按比例 / 退满剩余」的金额方式单选组**全部删除**。
 *    前两者随责任模型废止；后者随「一个订单只退一次」废止——
 *    尾差不再存在，`100%` 就是全额退款（见 `readAdminRefundDecisionInput`）。
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

  // 资金决策表单（只有「通过」会用到）。⚠️ P0-15 起**只有比例一个字段**
  const [ratePercent, setRatePercent] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  const noteCount = countCharacters(note.trim());
  const noteRequired = pendingIntent === "reject";

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

      // 校验的字段名与请求体完全一致，因此这一步判的就是**即将发出去的东西**。
      // ⚠️ **比例取校验结果里的那个**，不从表单状态里取：服务端用的是
      // `readPercentAsBp` 解析出来的基点，而表单里存的是原始字符串——
      // 直接发字符串会让「界面校验通过、服务端却解析出别的数」成为可能。
      const checked = readAdminRefundDecisionInput({ refundRatePercent: ratePercent });
      if (!checked.ok) {
        setDecisionError(checked.message);
        rateRef.current?.focus();
        return;
      }

      // ⚠️ **P0-15 起请求体只剩一个字段**。原先这里是一个 2 × 2 的条件表达式
      // （金额表达方式 × 责任归属）——两条判别轴都随各自的模型废止，
      // 于是这一段从「四选一」退化成一次直白的赋值。
      const decision = { refundRatePercent: ratePercent };

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
        })
      : null;

  // 按钮上只在「算得出来且不会被金额闸拒绝」时报金额：超限时报一个注定被拒的数字，
  // 比不报更误导
  const previewedAmount =
    preview?.ok && preview.gateMessage === null ? preview.amounts.refundAmount : null;

  /**
   * 「一个字都还没填」现在只剩一个含义：比例框是空的。
   *
   * ⚠️ P0-15 之前这里是个三元判断——按比例时看比例、退满剩余时看责任归属有没有选。
   * 两个分支的字段都没了，判断也就退化成一次 `trim()`。
   */
  const decisionBlank = ratePercent.trim() === "";

  /**
   * 预览区的占位语；`null` 表示已经开始填了——那时要把**规则层的原话**原样给它，
   * 而不是用一句「填完…会显示」把真正的错误盖过去。
   */
  const previewBlankNote =
    pendingIntent === "approve" && decisionBlank ? ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE : null;

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

      {/*
        「通过」被订单状态挡下时的说明。与 `ADMIN_REFUND_TERMINAL_NOTICE` 是**两种情形**：
        那一句是「这笔申请已结束，一个动作都没有」，这一句是「另外两个动作还能做，
        但这一单不在售后审批范围内」。文案来自服务端（与接口 400 的 message 同一句话），
        页面只负责显示，不重新判断订单状态。
      */}
      {refund.approveBlockedReason ? (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{refund.approveBlockedReason}</p>
      ) : null}

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

            {/*
              ② 输入：**一个**退款比例输入框。

              ⚠️ **P0-15 从这里删掉了三样东西**，删的不是「暂时不做」：
              - 「退款金额方式」单选组（按比例 / 退满剩余，P0-14）：
                「退满剩余」补的是**多步部分退款**留下的 1~99 分尾差，
                而一个订单只退一次之后 `floor(实付 × 100%) === 实付`，
                那个概念自动坍缩成 100%。留着这个开关会让管理员以为还有第二种退法。
              - 「责任归属」单选组（P0-13）：责任模型整体废止，退款批准即整笔归零。
              - 「打手责任比例」输入框（只在分担制下出现）：随责任归属一起删除。

              ⚠️ 三者删除后，这一屏**只剩一个输入框**，而它填出来的数
              是服务端唯一的金额输入。原先那些字段之间的互斥关系
              （「同时传比例与退满标志会 400」）也就不存在了——
              互斥校验的代码跟着一起删，而不是留着一个永远为假的判断。
            */}
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

            {/* B：这笔退款对打手与平台各是什么结果。**无条件显示**——
                它描述的是每一次退款都会发生的事，不是某一种选择的结果
                （P0-15 之前它只在「按比例分担」那一个分支下出现） */}
            <p className="rounded-lg border border-admin-line bg-surface px-3 py-2 text-[11px] leading-4 text-ink-3">
              {ADMIN_REFUND_DECISION_OUTCOME_NOTE}
            </p>

            {/* ③ 实时结果：每敲一下重算一次（D）。
                它只有两行——退给用户的金额、打手被冲回的金额——
                因为 P0-15 之后这两个数就是这笔决策的全部产出。 */}
            {preview ? <DecisionPreview preview={preview} blankNote={previewBlankNote} /> : null}

            {/* E：四个问题。默认收起——它是要「查得到」，不是要「挡在面前」 */}
            <details className="rounded-lg border border-admin-line bg-surface px-3 py-2">
              <summary className="cursor-pointer text-[12px] text-ink-2">
                这笔退款到底怎么算？（四个问题）
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
