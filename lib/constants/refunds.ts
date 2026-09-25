import type { EarningStatus } from "@/lib/types/earning";
import type { OrderStatus } from "@/lib/types/order";
import type { RefundReasonKey, RefundResponsibility, RefundStatus } from "@/lib/types/refund";
import { formatShareRatioBpForInput } from "./shareRatio";

/**
 * 退款状态机与表单规则（服务端与浏览器共用）。
 *
 * ⚠️ **P0-13 起本文件有一个运行时依赖**（`./shareRatio` 的基点↔百分比换算，
 * 用于把决策里的比例显示给人看）。它不改变本文件的定位：那一份是纯函数、
 * 无服务端依赖、本来就被客户端组件引用（商品表单），因此引用它不会把服务端模块
 * 打进浏览器产物，node 也仍然能直接加载本文件做纯逻辑测试。
 * 其余全部是 `import type`。
 *
 * 这里只描述**规则**，不读写数据。判断「能不能退」的权威仍然是服务端：
 * 页面用同一套函数渲染按钮，写接口时再校验一次。
 */

/** 五个退款状态，顺序与进度时间轴一致。 */
export const REFUND_STATUSES: readonly RefundStatus[] = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "cancelled",
];

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "待审核",
  reviewing: "审核中",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已撤销",
};

/** 状态文字色：全部来自 `app/globals.css` 的 `--color-status-*` 令牌。 */
export const REFUND_STATUS_CLASS: Record<RefundStatus, string> = {
  pending: "text-status-pending",
  reviewing: "text-status-info",
  approved: "text-status-success",
  rejected: "text-status-danger",
  cancelled: "text-status-muted",
};

/** 状态的一句话说明。只描述退款这件事，不承诺任何审核结果。 */
export const REFUND_STATUS_HINTS: Record<RefundStatus, string> = {
  pending: "退款申请已提交，等待客服审核。审核期间订单按原进度继续。",
  reviewing: "客服正在审核这笔退款申请，请留意系统通知。",
  approved: "退款申请已通过，款项将按原支付渠道退回。",
  rejected: "退款申请未通过，如有疑问可联系客服进一步说明。",
  cancelled: "退款申请已由你撤销，订单按原进度继续。",
};

/** 退款原因选项。**必选**，取值由服务端校验，文案只此一份。 */
export const REFUND_REASONS: readonly { key: RefundReasonKey; label: string }[] = [
  { key: "service_not_delivered", label: "打手未按约定提供服务" },
  { key: "service_quality", label: "服务过程与描述不符" },
  { key: "schedule_conflict", label: "时间冲突，无法继续本次服务" },
  { key: "duplicate_payment", label: "重复支付 / 多付了金额" },
  { key: "other", label: "其他原因" },
];

export const REFUND_REASON_LABELS = REFUND_REASONS.reduce<Record<string, string>>(
  (labels, item) => {
    labels[item.key] = item.label;
    return labels;
  },
  {},
);

export const REFUND_DESCRIPTION_MAX_LENGTH = 200;

export const REFUND_REASON_REQUIRED_MESSAGE = "请选择退款原因";
export const REFUND_DESCRIPTION_EMPTY_MESSAGE = "请填写退款说明";
export const REFUND_DESCRIPTION_TOO_LONG_MESSAGE = `退款说明不能超过 ${REFUND_DESCRIPTION_MAX_LENGTH} 个字`;

/**
 * 退款金额不可编辑的说明。
 *
 * ⚠️ **P0-13 改口径**：原来写的是「整单实付金额」——那是「一笔订单一次全额退」
 * 时代的说法。现在用户申请时**不填金额、也看不到金额**（他本来就不该能决定退多少），
 * 退多少由管理员在最终决策时按比例核定，因此这里只能说清「谁定、依据是什么」。
 */
export const REFUND_AMOUNT_NOTE = "退款金额由平台按订单实付金额与责任认定核定，无需你填写";

export const REFUND_STATUS_INVALID_MESSAGE = "退款状态筛选无效";
export const REFUND_ALREADY_ACTIVE_MESSAGE = "该订单已有进行中的退款申请，请先查看退款进度";
export const REFUND_NOT_CANCELLABLE_MESSAGE = "只有待审核的退款申请可以撤销";
export const REFUND_ORDER_NOT_ALLOWED_MESSAGE = "该订单当前不可申请退款";
export const REFUND_AMOUNT_INVALID_MESSAGE = "订单金额异常，暂时无法发起退款";

/**
 * 已完成订单的售后窗口已过时，接口给用户的一句话（P0-13）。
 *
 * ⚠️ **窗口的判据与投诉窗口是同一个**（`isComplaintWindowClosed(order, at)`，
 * 读的是订单冻结的 `complaintDeadlineAt`），但**文案必须分开写**：
 * `COMPLAINT_WINDOW_CLOSED_MESSAGE` 讲的是「无法再发起普通投诉」，
 * 这一句讲的是「无法再提交退款申请」。合并成一句会让用户以为
 * 「投诉窗口关了」等于「退款申请也提交不了」——那是两句各自成立、互不推导的话。
 *
 * ⚠️ 与那一句同样的两条纪律，一并沿用：
 * 1. **不带具体小时数**——窗口可配置，且每单用自己完成时的快照，
 *    文案里印一个数字必然对某些订单是错的；
 * 2. **必须留一句出路**（「请联系客服」）：窗口关闭只是**普通入口**关闭，
 *    写成「无法处理」会变成一句平台其实做不到的硬规则。
 */
export const REFUND_WINDOW_CLOSED_MESSAGE =
  "该订单完成后的售后申请窗口已结束，无法再提交退款申请；如有其他问题请联系客服。";

/**
 * ⚠️ **P0-13 删除了 `REFUND_RECORD_EXISTS_MESSAGE`**（「该订单已有退款申请记录，
 * 本阶段不支持重复申请」）。理由有两条，缺一不可：
 *
 * 1. **业务上必须能重复申请**：P0-13 支持部分退款，而「第一次退了一部分、
 *    后来又发现还要再退」只能靠第二次申请表达。这条规则若保留，
 *    部分退款就永远只能退一次；
 * 2. `canRequestRefund` 的注释**自己早就写下了这份计划**——
 *    「将来放开重复申请时，只需把这一条放宽成 `isActiveRefundStatus`」。
 *    本轮执行的就是这句，不是新发明的规则。
 *
 * 重复申请能被打开，靠的是**两道闸**而不是这一句话（见 `canRequestRefund`）：
 * 进行中的记录仍然挡着（同一时刻只能有一条流程），以及
 * **金额闸**——累计退款不得超过实付（`assertRefundAmountWithinPaid`）。
 * 用户端不会因此出现「退不完的钱」：累计退满时管理员那一步会自动把订单转 `refunded`，
 * 而 `refunded` 不在 `REFUNDABLE_ORDER_STATUSES` 里，申请入口自行消失。
 */

/**
 * 直接全额退款（P0-12，免审批）的失败文案。
 *
 * 三段分开写，因为对用户来说它们是**三件不同的事**：
 * 还能再试（走售后）、不必再试（已经退过了）、以及「这一单现在退不了」。
 */
export const DIRECT_REFUND_NOT_STARTED_MESSAGE = "护航已开始服务，退款需通过售后申请，请联系客服";
export const DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE = "该订单已全额退款，无需重复操作";
export const DIRECT_REFUND_NOT_ALLOWED_MESSAGE = "该订单当前不可直接退款";

/**
 * 直接全额退款成功后**发给被退单护航**的通知（P0-12）。
 *
 * ⚠️ 这是仓库里**第一条收件人是打手、而不是下单用户**的通知。
 * 打手没有独立账号体系（身份建立在用户会话上，`requireCompanion()` 底层就是
 * `requireUser()`），因此收件人写的是**这位打手的 `userId`**——
 * 这是他今天唯一能被送达的地址，不是把打手当成了下单用户。
 *
 * ⚠️ 文案里**不写平台对他做了什么**（与 `DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED`
 * 同一纪律）：他被退单的原因是**客户在服务开始前取消了订单**，不是平台对他有任何处置。
 * 写「你被取消」会让他以为自己出了问题。
 */
export const REFUND_NOTIFICATION_COMPANION_REFUNDED = {
  title: "订单已退款",
  summary: "客户在服务开始前取消了订单，本单已全额退款",
  body: "客户在护航开始服务前取消了这一单，订单已全额退款。本单不产生收益，你无需再做任何操作。",
} as const;

export function isRefundStatus(value: string): value is RefundStatus {
  return (REFUND_STATUSES as readonly string[]).includes(value);
}

export function isRefundReason(value: string): value is RefundReasonKey {
  return REFUND_REASONS.some((item) => item.key === value);
}

/** 「进行中」的退款：待审核与审核中。只有这两种会挡住新的申请。 */
export const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = ["pending", "reviewing"];

export function isActiveRefundStatus(status: RefundStatus): boolean {
  return (ACTIVE_REFUND_STATUSES as readonly string[]).includes(status);
}

/**
 * 允许**申请**退款（走人工审核）的订单状态：护航中 / **已完成**。
 *
 * 已完成也在这个集合里，是因为它才是**唯一计入消费**的状态（见
 * `lib/constants/levels.ts` 的 `CONSUMPTION_ORDER_STATUS`）：消费口径只认已完成，
 * 如果已完成不能退，那笔已计入累计消费的钱就永远退不掉。
 *
 * 「已完成可退」不代表「完成后退款很容易」——退款仍然是一笔独立的状态机，
 * 提交只产生一条待审核记录，订单状态和累计消费都**要到审核通过才变**。
 *
 * ⚠️ **P0-12 起 `paid` / `accepted` 从这个集合里移出。** 这两档属「尚未开始服务」，
 * 按 2026-09-23 的规则走**免审批直接全额退款**（`DIRECT_REFUNDABLE_ORDER_STATUSES`），
 * 不再产生一条待审核申请：
 *
 * - `业务流程表.md` **BF-26 A**：「`paid` / `accepted` → 直接全额退款，不需要客服审批」；
 * - `用户权限表.md` **PR-02**（✅ 已确认）：「直接全额退款，不需要客服/管理员审批」；
 * - `特殊情况表.md` **EX-REFUND-07**（✅ 已确认）：六项细则；
 * - `用户权限表.md:448` 更明文写死：「**客服不得把「未开始服务直接退款」强行转成人工审批**」——
 *   也就是说，让这两档走人工审核**本身**就是违规的。
 *
 * 因此两档留在同一个集合里不是「多一条路」，而是**同一种订单出现两种互斥的业务结果**
 * （一条当场退钱、一条等审核），用户点哪个按钮就退成什么样。
 */
export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ["serving", "completed"];

/**
 * 允许**直接全额退款**（免审批，P0-12）的订单状态：已付款 / 已接单。
 *
 * 「尚未开始服务」只有这两档（BF-26 A 原文）。`serving` 起必须走售后：
 * 客服调查、管理员决定退款比例——那条路径属 P0-13，**本轮不碰**。
 *
 * ⚠️ 这个集合与 `REFUNDABLE_ORDER_STATUSES` **不相交**，而且**必须**不相交：
 * 交集非空就意味着某一档同时存在两条退款路径。`tests/refunds.test.mjs` 里有断言钉住这一点。
 */
export const DIRECT_REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ["paid", "accepted"];

/** 这一档订单此刻能否直接全额退款（只看状态，不看归属与已退金额）。 */
export function canDirectRefund(status: OrderStatus): boolean {
  return (DIRECT_REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isOrderRefundable(status: OrderStatus): boolean {
  return (REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * 这一档订单**在状态层面**还有退款路径可走——申请（人工审核）或直接全额退款，二者必居其一。
 *
 * 它存在的理由是：上面两个集合各自只描述**一条**路，而有些判断问的是**问题本身**
 * （「这一单还能不能退」），与走哪条路无关。预置数据的自洽校验就是这种判断：
 * `refundSeed.ts` 的不变量 2 要保证「一条进行中的退款申请，对应的订单没有变成终态」，
 * 而不是「这条申请此刻还能再提交一次」——后者在 `paid` / `accepted` 上已经是**假**的
 * （那两档走免审批直接退款，开不出申请），可它跟「预置数据自不自洽」毫无关系。
 *
 * ⚠️ 这**不是** P0-12 之前那个 `isOrderRefundable` 的别名：那个词现在只指申请那条路。
 * P0-12 没有缩减「哪些订单能退」，它把原来的一条路拆成了两条**互斥**的路——
 * 本函数是「拆之前那个问题」的现名，因此它今天恰好仍等于原来那四档。
 *
 * ⚠️ **入参只有状态，没有 `hasActiveRefund`**，因此它**不回答**「这一刻能不能真的提交/点到」：
 * 对一张 `serving` / `completed` 且**已有进行中退款**的订单它返回 `true`，而同文件的
 * `canRequestRefund(status, hasActiveRefund)` 对同一张订单返回 `false`。服务端拒绝时用的是
 * `REFUND_ALREADY_ACTIVE_MESSAGE`（见 `lib/services/refunds.ts` 的判定）。
 * **「入口该不该显示」必须用 `canRequestRefund` /
 * `canDirectRefund` / 服务端的 `allowedActions` 判定，不要用本函数**——
 * 用它去把守按钮，`serving` 单上会显示一个点进去必然报错的「申请退款」。
 *
 * ⚠️ P0-13 之后它与 `canRequestRefund` 的差距**变小了**（已结束的记录不再挡住申请），
 * 但**没有消失**：仍在进行中的那一条依然只有 `canRequestRefund` 看得见。
 */
export function hasRefundPath(status: OrderStatus): boolean {
  return isOrderRefundable(status) || canDirectRefund(status);
}

/**
 * 能否申请退款 = 订单状态可退，**且**这一单没有**进行中**的退款申请。
 *
 * 反过来读，就是仍然不能申请的两种情况：
 *
 * 1. 订单状态本身不可退（已退款；以及未支付等根本不存在的状态）；
 * 2. 已有**进行中**的退款申请（待审核 / 审核中）——不能同时对同一单开两条流程。
 *
 * ⚠️ **P0-13 起第二项入参的语义由「有**任何**记录」收窄为「有**进行中**记录」
 * （形参名随之从 `hasRefundRecord` 改为 `hasActiveRefund`）**。
 * 这是本文件自己在上一版注释里写下的计划：「将来放开重复申请时，
 * 只需把这一条放宽成 `isActiveRefundStatus`」。本轮做部分退款，
 * 「一次退不完、之后再申请一次」是**业务本身的需求**，不是顺手放开。
 *
 * ⚠️ 这一放宽**不是**「退款可以无限重复」：还有两道闸在外面，且都不在本函数里——
 *
 * - **金额闸**：累计退款不得超过订单实付（`assertRefundAmountWithinPaid`）。
 *   本函数看不到金额，因此它答不了「还能退多少」；
 * - **状态闸**：累计退满时订单转 `refunded`，而 `refunded` 不在
 *   `REFUNDABLE_ORDER_STATUSES` 里，第一项立刻变假。
 *
 * ⚠️ 已知后果（**产品已裁定接受**，见 `P0-13/02-decisions.md` §十一 D10）：
 * 已拒绝 / 已撤销的记录**不再挡着**再次申请——用户可以就同一单再提交一次。
 * 这是「允许重复申请」的必然含义，而不是漏挡的一条分支；
 * 若将来要禁止「反复被拒后反复提交」，那是一条**新的产品规则**，需要单独裁定。
 */
export function canRequestRefund(status: OrderStatus, hasActiveRefund: boolean): boolean {
  return isOrderRefundable(status) && !hasActiveRefund;
}

/** 能否撤销：只有待审核（pending）。审核中（reviewing）本阶段不允许撤销。 */
export function canCancelRefund(status: RefundStatus): boolean {
  return status === "pending";
}

/* ═════════════════════ 退款资金决策（P0-13） ═════════════════════ */

/**
 * 退款决策的**金额规则**（服务端与浏览器共用，纯函数，不读写数据）。
 *
 * ## 规则的出处
 *
 * 全部来自 `docs/01-requirements/超哥电竞_业务流程表.md` **§17**
 * （标题即「部分退款资金公式（规则已冻结）」）与 §16.B「**管理员只输入退款比例，
 * 金额由系统计算**」。这里**没有一条新公式**：
 *
 * ```text
 * refundRate ∈ [0, 10000] bp
 * userRefundAmount   = floor(actualPaidAmount × refundRate)
 * companionReversal  = floor(companionBaseIncome × refundRate)          // companion
 *                    = floor(companionBaseIncome × refundRate × liability) // shared
 *                    = 0                                                  // platform
 * platformBorne      = userRefundAmount − companionReversal   ← 用减法，不是另算一个数
 * 必须保持：userRefundAmount = companionReversal + platformBorne
 * 允许：platformBorne < 0
 * ```
 *
 * ⚠️ 「用减法构造」是**硬要求**，不是写法偏好：若平台承担额也各自取整算一遍，
 * 恒等式 `userRefundAmount = companionReversal + platformBorne` 会在
 * 取整误差下**偶发不成立**（差 1 分）。减法构造让恒等式**在定义上**成立。
 *
 * ⚠️ **`platformBorne` 允许为负**（§17 明写「允许 `clubIncomeAdjustment < 0`」）：
 * 打手的分账基数按**原价**算（§18），券由平台承担，因此「冲回额」可能大于
 * 「实际退给用户的钱」。这不是缺陷，是已经冻结的规则；页面照实显示。
 *
 * ⚠️ 与 §17 的一处措辞对齐：§17 里的 `clubIncomeAdjustment` 是**俱乐部口径**的调整额，
 * 本仓库没有俱乐部实体，平台即俱乐部，故字段名为 `platformBorneAmount`，
 * **语义与公式完全一致**。
 *
 * ## 为什么必须钳制（`reversedSoFar`）
 *
 * 产品裁定 Q2-d 要求「**必须保证** `0 <= cumulativeReversalAmount <= incomeAmount`」。
 * 这条不变式**不能**靠「公式本身不会超」来论证：`companionBaseIncome` 并不保证
 * `<= actualPaidAmount`（§18 的券场景下它按原价算，反而可能大于实付），
 * 而且同一笔收益可以被多次退款反复冲减（Q2-d 明说允许）。
 * 因此这里显式钳制在「该单**剩余**可冲回额」以内——
 * 这是**唯一**保证不变式成立的地方，去掉它不变式就会破。
 */

/**
 * 退款**责任归属**选项。取值由服务端校验，文案只此一份。
 *
 * ⚠️ `hint` 在 **P0-13 验收整改**时补上了**冲回公式**（原先只有一句抽象描述）。
 * 验收时的原话是「不要只显示抽象百分比」：管理员选「打手承担」时必须能立刻看出
 * 冲回额乘的是**打手收益**而不是**退款金额**——这两个基数不同，
 * 也只有在打手收益恰好等于退款金额时才会巧合相等。
 */
export const REFUND_RESPONSIBILITIES: readonly {
  key: RefundResponsibility;
  label: string;
  hint: string;
}[] = [
  {
    key: "platform",
    label: "平台承担",
    hint: "打手冲回 = 0；平台承担 = 本次退款金额。",
  },
  {
    key: "companion",
    label: "打手承担",
    hint: "打手冲回 = 打手收益 × 退款比例（⚠️ 乘的是打手收益，不是退款金额）。",
  },
  {
    key: "shared",
    label: "按比例分担",
    hint:
      "打手冲回 = 打手收益 × 退款比例 × 打手责任比例（⚠️ 乘的是打手收益，不是退款金额）；" +
      "平台承担 = 本次退款金额 − 打手冲回（可能为负）。",
  },
];

export const REFUND_RESPONSIBILITY_LABELS: Record<RefundResponsibility, string> =
  REFUND_RESPONSIBILITIES.reduce<Record<string, string>>((labels, item) => {
    labels[item.key] = item.label;
    return labels;
  }, {}) as Record<RefundResponsibility, string>;

/**
 * 退款比例的输入范围（整数百分比）。100% 即全额退款。
 *
 * ⚠️ 下限是 **0** 而不是 1，与 §16.B 的「0% ～ 100%」和 D2 的「`0 <= bp <= 10000`」一致：
 * 「0%」在**形态上**合法，只是算出来的退款金额是 0，会被下面那条
 * 「单次金额必须 > 0」挡掉——两道校验各答各的问题，不互相顶替。
 */
export const REFUND_RATE_PERCENT_MIN = 0;
export const REFUND_RATE_PERCENT_MAX = 100;
export const COMPANION_LIABILITY_PERCENT_MIN = 0;
export const COMPANION_LIABILITY_PERCENT_MAX = 100;

/**
 * 决策表单的全部失败文案。
 *
 * ⚠️ 用**百分比**措辞而不是「基点」：管理员输入的就是百分比，
 * 报错时对他说「基点必须在 0..10000 之间」是把他输入的东西又翻译了一遍。
 * 服务端内部一律用基点（`bp`），只在**这一层**做换算。
 */
export const REFUND_DECISION_RATE_REQUIRED_MESSAGE = "请填写退款比例";
export const REFUND_DECISION_RATE_INVALID_MESSAGE = `退款比例必须是 ${REFUND_RATE_PERCENT_MIN}~${REFUND_RATE_PERCENT_MAX} 之间的整数百分比`;
export const REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE = "请选择退款责任归属";
export const REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE = "退款责任归属取值无效";
export const REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE = "按比例分担时必须填写打手责任比例";
export const REFUND_DECISION_LIABILITY_INVALID_MESSAGE = `打手责任比例必须是 ${COMPANION_LIABILITY_PERCENT_MIN}~${COMPANION_LIABILITY_PERCENT_MAX} 之间的整数百分比`;
export const REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE =
  "只有「按比例分担」才需要填写打手责任比例";
export const REFUND_DECISION_AMOUNT_ZERO_MESSAGE = "退款金额为 0，无法提交退款决策";
export const REFUND_DECISION_EXCEEDS_PAID_MESSAGE =
  "累计退款金额超过订单实付金额，请调整退款比例";

export function isRefundResponsibility(value: string): value is RefundResponsibility {
  return REFUND_RESPONSIBILITIES.some((item) => item.key === value);
}

/**
 * 一次退款决策的**输入**（服务端内部口径）。
 *
 * ⚠️ 全部是**基点**整数。表单给的百分比字符串在接口层就换算掉
 * （`lib/constants/adminRefunds.ts`），因此规则层永远只面对整数基点，
 * 不面对 `"33.5"` 这种字符串，也不会在规则里做二次解析。
 */
export type RefundDecisionInput = {
  refundRateBp: number;
  responsibility: RefundResponsibility;
  /** 只有 `shared` 有意义；其余两种必须为 `null`（见 D2：金额字段不静默忽略） */
  companionLiabilityRateBp: number | null;
};

/** 一次退款决策算出来的三个金额（单位：分）。 */
export type RefundDecisionAmounts = {
  refundAmount: number;
  companionReversalAmount: number;
  platformBorneAmount: number;
};

/**
 * 决策输入的**形状校验**（不涉及订单金额，因此可以独立测试与独立复用）。
 *
 * 返回 `null` 表示通过，否则返回给管理员看的中文原因。
 * ⚠️ 它**不检查**「累计退款是否超过实付」——那要看订单，属于
 * `assertRefundAmountWithinPaid`。
 */
export function validateRefundDecisionInput(input: RefundDecisionInput): string | null {
  if (!Number.isInteger(input.refundRateBp)) return REFUND_DECISION_RATE_REQUIRED_MESSAGE;
  const ratePercent = input.refundRateBp / 100;
  if (
    ratePercent < REFUND_RATE_PERCENT_MIN ||
    ratePercent > REFUND_RATE_PERCENT_MAX
  ) {
    return REFUND_DECISION_RATE_INVALID_MESSAGE;
  }

  if (!isRefundResponsibility(input.responsibility)) {
    return REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE;
  }

  if (input.responsibility === "shared") {
    const liability = input.companionLiabilityRateBp;
    if (liability === null) return REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE;
    if (!Number.isInteger(liability)) return REFUND_DECISION_LIABILITY_INVALID_MESSAGE;
    const liabilityPercent = liability / 100;
    if (liabilityPercent < COMPANION_LIABILITY_PERCENT_MIN || liabilityPercent > COMPANION_LIABILITY_PERCENT_MAX) {
      return REFUND_DECISION_LIABILITY_INVALID_MESSAGE;
    }
  } else if (input.companionLiabilityRateBp !== null) {
    // ⚠️ 不静默忽略：管理员填了责任比例却选了「平台承担」，
    // 那个数字会被丢掉，而他以为它生效了。金额字段宁可报错。
    return REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE;
  }

  return null;
}

/**
 * 按 §17 算这一次退款的三个金额（单位：分）。
 *
 * ⚠️ **入参必须是订单的冻结经济快照**（`Order.actualPaidAmount` /
 * `Order.companionBaseIncome`），**不得**传当前商品价或当前分账比例——
 * P0-13 §一原文：「不得重新按当前商品/分账比例计算，必须基于订单冻结经济快照」。
 *
 * `reversedSoFar` = 该订单**此前已批准**退款累计冲回的打手收益（分）。
 * 它只为钳制服务，不参与正向计算。
 */
export function computeRefundDecisionAmounts(params: {
  actualPaidAmount: number;
  companionBaseIncome: number;
  reversedSoFar: number;
  input: RefundDecisionInput;
}): RefundDecisionAmounts {
  const { actualPaidAmount, companionBaseIncome, reversedSoFar, input } = params;

  const refundAmount = Math.floor((actualPaidAmount * input.refundRateBp) / 10000);

  let grossReversal: number;
  if (input.responsibility === "platform") {
    grossReversal = 0;
  } else if (input.responsibility === "companion") {
    grossReversal = Math.floor((companionBaseIncome * input.refundRateBp) / 10000);
  } else {
    const liability = input.companionLiabilityRateBp ?? 0;
    grossReversal = Math.floor(
      (companionBaseIncome * input.refundRateBp * liability) / 10000 / 10000,
    );
  }

  // ⚠️ 钳制：保证 0 <= 累计冲回 <= incomeAmount（Q2-d）。见本节顶部说明。
  const remainingReversible = Math.max(0, companionBaseIncome - reversedSoFar);
  const companionReversalAmount = Math.max(0, Math.min(grossReversal, remainingReversible));

  return {
    refundAmount,
    companionReversalAmount,
    // 用减法构造，让恒等式在定义上成立（见顶部说明）
    platformBorneAmount: refundAmount - companionReversalAmount,
  };
}

/**
 * **D17**：收益已经提现时，本次退款**不从打手身上冲回**（Q3 仍 DEFER），
 * 那部分钱由平台全额承担。
 *
 * 这是「读一侧」与「写一侧」都必须走的一步，因此抽成纯函数：
 *
 * - **写一侧**：`approveRefund` 在写决策前调用它，拿到真正落库的三个金额；
 * - **读一侧**：管理端界面的「本次预计退款金额」调用**同一个函数**。
 *
 * ⚠️ 若只在写一侧实现，界面会对一笔已经提现的收益显示「预计冲回 ¥X」，
 * 而服务端实际写下去的是 0——一笔账在界面上和在库里不一致，且**只有提交之后**才看得出来。
 *
 * ⚠️ 第三个金额仍然用**减法构造**（与 `computeRefundDecisionAmounts` 同一条纪律）：
 * 恒等式 `refundAmount = companionReversalAmount + platformBorneAmount`
 * 必须在**任何**分支下都在定义上成立。
 */
export function resolveFinalDecisionAmounts(
  amounts: RefundDecisionAmounts,
  companionEarningStatus: EarningStatus | null,
): RefundDecisionAmounts {
  if (companionEarningStatus !== "withdrawn") return amounts;

  const companionReversalAmount = 0;
  return {
    refundAmount: amounts.refundAmount,
    companionReversalAmount,
    platformBorneAmount: amounts.refundAmount - companionReversalAmount,
  };
}

/**
 * 该订单**此前已批准**退款累计冲回的打手收益（分）——`reversedSoFar` 的**唯一定义处**。
 *
 * 它有两个调用方，一个写、一个读：
 *
 * 1. **写入侧**（`lib/data/adminRefundTransaction.ts` 的 `approveRefund`）：
 *    把它作为 `computeRefundDecisionAmounts` 的钳制输入；
 * 2. **读取侧**（`lib/services/adminRefunds.ts` 的详情 DTO）：把它放进
 *    `AdminRefundOrderMoney.reversedSoFarAmount`，让管理端界面能用**同一个函数**
 *    算出与写入侧一模一样的预计金额。
 *
 * ⚠️ **必须只有这一份**：界面上要显示「本次预计冲回多少」，若读取侧照抄一遍
 * 这段 `filter + reduce`，两处只要有一处漏掉 `approved` 这个条件，
 * 界面就会显示一个服务端永远不会算出来的数——而那种不一致没人能一眼看出来。
 *
 * ⚠️ **读的是退款记录上的决策，不是收益上的 `reversedAmount`**：`serving` 订单退款时
 * 收益还不存在（D9），那种情况下只有这里读得到已冲回多少。
 *
 * ⚠️ 也**不排除本条自己**：`approved` 是终态，调用方走到「要批准这一条」时
 * 它必然还不是 `approved`。
 */
export function sumApprovedCompanionReversal(
  refunds: readonly {
    status: RefundStatus;
    decision?: { companionReversalAmount: number } | null;
  }[],
): number {
  return refunds
    .filter((item) => item.status === "approved")
    .reduce((total, item) => total + (item.decision?.companionReversalAmount ?? 0), 0);
}

/**
 * 金额闸：累计退款不得超过订单实付金额（P0-13 §一原文
 * 「累计 `refundedAmount <= actualPaidAmount`」）。
 *
 * ⚠️ 参数是「**已经退过的累计额**」而不是「这一次退多少」：判据是**累计**，
 * 因为部分退款可以来很多次，只比这一次永远比不出问题。
 * 返回 `null` 表示通过。
 */
export function assertRefundAmountWithinPaid(params: {
  refundAmount: number;
  alreadyRefundedAmount: number;
  actualPaidAmount: number;
}): string | null {
  if (params.refundAmount <= 0) return REFUND_DECISION_AMOUNT_ZERO_MESSAGE;
  if (params.alreadyRefundedAmount + params.refundAmount > params.actualPaidAmount) {
    return REFUND_DECISION_EXCEEDS_PAID_MESSAGE;
  }
  return null;
}

/**
 * 累计退款是否已经退满 = 订单该转 `refunded`（P0-13 §一：「cumulative full refund 才 refunded」）。
 *
 * ⚠️ **只有退满才转**：部分退款**不得**自动设 `refunded`——订单还要继续履约，
 * 打手的收益也还在。这一条由本函数单点回答，调用方不再自己写 `>=`。
 */
export function isFullyRefunded(alreadyRefundedAmount: number, actualPaidAmount: number): boolean {
  return actualPaidAmount > 0 && alreadyRefundedAmount >= actualPaidAmount;
}

/**
 * 基点 → 百分比文本（`8000` → `"80"`、`3350` → `"33.5"`），用于把决策里的比例**显示给人看**。
 *
 * ⚠️ **转发而不是另写一份换算**：「基点 ↔ 百分比」这个换算在仓库里只应该有一个落点
 * （`lib/constants/shareRatio.ts`），哪怕两个字段的业务含义完全不同
 * ——商品分账比例与本次退款比例是两个业务概念，但它们的单位换算是同一件事。
 * 这里保留一个退款域的名字，是为了让调用处读起来是「退款比例」而不是
 * 「分账比例」；将来若退款比例真的需要不同的显示口径，改这里就够了。
 */
export function formatRefundRatePercent(bp: number): string {
  return formatShareRatioBpForInput(bp);
}
