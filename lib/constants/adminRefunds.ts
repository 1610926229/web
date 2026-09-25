import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  REFUND_DECISION_LIABILITY_INVALID_MESSAGE,
  REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE,
  REFUND_DECISION_RATE_INVALID_MESSAGE,
  REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE,
  REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE,
  REFUND_REASON_LABELS,
  REFUND_STATUSES,
  REFUND_STATUS_LABELS,
  assertRefundAmountWithinPaid,
  computeRefundDecisionAmounts,
  isRefundResponsibility,
  resolveFinalDecisionAmounts,
  validateRefundDecisionInput,
  type RefundDecisionAmounts,
  type RefundDecisionInput,
} from "@/lib/constants/refunds";
import type { EarningStatus } from "@/lib/types/earning";
import type { OrderStatus } from "@/lib/types/order";
import type {
  AdminRefundAllowedActions,
  AdminRefundDetail,
  AdminRefundListItem,
  AdminRefundOrderMoney,
  RefundRequest,
  RefundStatus,
} from "@/lib/types/refund";
import type { AdminUserSummary } from "@/lib/types/user";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「退款审核」的筛选规则、状态机与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与另外几个常量模块（都是纯逻辑）外没有运行时依赖：客户端组件引用它
 * 不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ **退款状态与订单状态是两条独立的线**，管理端也不例外：
 * `start-review` 与 `reject` 都**只改退款申请**，订单按原进度继续；
 * 只有 `approve` 会同时把订单改成 `refunded`，而且必须与退款写入在同一段同步区段里完成
 * （实现见 `lib/data/adminRefundTransaction.ts`）。
 *
 * 四条规则写在这里，是本阶段新增的**唯一**落点：
 *
 * 1. **状态机**：`pending → reviewing | approved | rejected`；
 *    `reviewing → approved | rejected`；`approved` / `rejected` / `cancelled` 是**终态**。
 * 2. **可执行动作由服务端给出**：`adminRefundAllowedActions()` 从迁移表推导，页面不自己写 `if`。
 * 3. **拒绝必须填写审核意见**，通过不需要理由（规则复用入驻审核那一份，见文件末尾）。
 * 4. **金额仍然不可直接填写**（P0-13 起口径微调）：请求体里**没有**接收金额的字段，
 *    管理员输入的只有**比例**与**责任归属**，金额一律由
 *    `computeRefundDecisionAmounts()` 按订单冻结快照算出来
 *    （`业务流程表.md` §16.B：「管理员只输入退款比例，金额由系统计算」）。
 *    ⚠️ 原先写的「`amount` 取申请创建时的实付快照」在 P0-13 之后**只对申请快照成立**，
 *    它不再是「这次退了多少钱」——后者是 `decision.refundAmount`。
 */

export const ADMIN_REFUND_LIST_TITLE = "退款审核";
export const ADMIN_REFUND_DETAIL_TITLE = "退款审核详情";

/** 列表默认每页条数。后台是 PC 宽屏，比用户端一页多放几条。 */
export const ADMIN_REFUND_PAGE_SIZE = 20;
export const ADMIN_REFUND_MAX_PAGE_SIZE = 100;
export const ADMIN_REFUND_MAX_PAGE = 1000;

/**
 * **必须在页面上原样展示**的 Mock 标注（§退款审核 的硬要求）。
 *
 * 这一句不是装饰：审核通过之后页面上会出现「已通过」，没有这句话，
 * 看到的人（无论是运营还是用户）都可能以为钱已经退回去了。
 * 本阶段的通过只是把状态改到位，**没有调用任何真实退款接口，也没有微信退款单号**。
 */
export const ADMIN_REFUND_MOCK_NOTICE =
  "Mock 审核流程，未执行真实退款：通过只意味着平台侧审核通过并把退款申请与订单状态改到位，" +
  "不会调用微信支付退款、不生成微信退款单号，也不代表款项已经真实退回。";

/** 列表顶部的说明：讲清楚这张列表的口径与动作后果。 */
export const ADMIN_REFUND_LIST_NOTICE =
  "列表按申请时间倒序，涵盖全部用户的退款申请。退款状态与订单状态是两条独立的线：" +
  "开始审核与拒绝只改退款申请，订单按原进度继续；通过会同时写入退款金额与打手收益冲回，" +
  "只有累计退满时订单才变成「已退款」，部分退款不改订单状态。";

/**
 * 退款金额口径的说明（管理端）。
 *
 * ⚠️ P0-13 改写过：原来只有「不可修改」这一层意思。现在管理员**要输入比例**，
 * 所以必须同时说清「你输入的是什么」与「金额从哪来」——否则他会去找一个
 * 根本不存在的金额输入框，或者以为比例只是个备注。
 */
export const ADMIN_REFUND_AMOUNT_NOTE =
  "「申请金额」是申请创建时的订单实付快照，不可修改。实际退款金额由你填写的退款比例与责任归属决定，" +
  "由系统按订单冻结的经济快照计算，无需也不允许直接填写金额。";

/**
 * 通过之后消费侧会怎样。
 *
 * 这段话必须写出来，因为它回答的是「通过了要不要再去改用户的消费金额」——
 * 答案是不用，也不许：订单变成 `refunded` 之后就不再计入累计有效消费，
 * 消费等级与周期排行榜会自然地把它排除（口径见 `lib/constants/levels.ts`）。
 *
 * ⚠️ P0-13 起补了一句「部分退款不动消费口径」：这不是新增规则，
 * 而是在说明**订单状态没变、消费口径自然也没变**——如果不说，
 * 管理员会合理地以为「退了钱就该扣消费」，然后去找一个不存在的操作。
 */
export const ADMIN_REFUND_CONSUMPTION_NOTICE =
  "累计退满后订单变为「已退款」，不再计入累计有效消费，消费等级与周期排行榜会自动排除这一单；" +
  "部分退款不改变订单状态，因此这一单的消费口径也不变；" +
  "平台不会改动用户记录上的任何累计字段。";

/** 列表为空时的提示。 */
export const ADMIN_REFUND_EMPTY_MESSAGE = "当前筛选下没有退款申请。";

/**
 * 列表底部的字段边界与动作位置说明。
 *
 * 三件事都要说：列表看不到原因与说明、**审核动作不在这里**（列表只看得见单号与金额，
 * 闭着眼睛点「通过」的后果是一笔订单被退款），以及**两个金额列各自是什么**
 * ——P0-13 起退款可以是部分的，「申请金额」与「实退金额」不再是同一个数，
 * 不写清楚会让人把申请时的实付快照当成实际退出去的钱。
 */
export const ADMIN_REFUND_LIST_FIELDS_NOTE =
  "「申请金额」是申请创建时的订单实付快照；「实退金额」是管理员最终决定退给用户的金额，" +
  "未决策的申请没有这一项。列表不展示退款原因、说明、凭证与审核意见，" +
  "这些内容只在详情页可见，三个审核动作也在详情页执行。";

/** 筛选条件不合法时的提示。**返回 400，不静默回退**。 */
export const ADMIN_REFUND_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / reviewing / approved / rejected / cancelled";

// ——————————————————————————— 状态筛选 ———————————————————————————

/** 状态筛选。`all` 表示不限。 */
export type AdminRefundStatusFilter = RefundStatus | "all";

export const ADMIN_REFUND_STATUS_FILTERS: readonly AdminRefundStatusFilter[] = [
  "all",
  ...REFUND_STATUSES,
];

export const ADMIN_REFUND_STATUS_FILTER_LABELS: Record<AdminRefundStatusFilter, string> = {
  all: "全部",
  ...REFUND_STATUS_LABELS,
};

/**
 * 默认筛选：**待审核**。
 *
 * 与入驻审核同理：这个页面的主要用途是处理待办，「打开就是全部历史」并不好用。
 * 已撤销的申请也进列表（可以筛、但不默认显示）——用户撤销之后客服仍然要能查到
 * 「这一单为什么没有退款记录」，而那不是平台的工作量。
 */
export const DEFAULT_ADMIN_REFUND_STATUS_FILTER: AdminRefundStatusFilter = "pending";

export function isAdminRefundStatusFilter(value: string): value is AdminRefundStatusFilter {
  return (ADMIN_REFUND_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readAdminRefundStatusFilter(
  raw: string | null,
): AdminRefundStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_REFUND_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_REFUND_STATUS_FILTER;
  return isAdminRefundStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminRefundStatusFilter(raw: string | null): AdminRefundStatusFilter {
  return readAdminRefundStatusFilter(raw) ?? DEFAULT_ADMIN_REFUND_STATUS_FILTER;
}

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 合法迁移表。**这是退款状态机唯一的定义处。**
 *
 * 与 §退款审核 逐条对应：
 * - `pending → reviewing | approved | rejected`（可以直接批，也可以先开始审核）；
 * - `reviewing → approved | rejected`；
 * - `approved` / `rejected` / `cancelled` 是终态，从终态出发没有任何合法迁移。
 *
 * 终态写空数组而不是省略：`Record` 要求每个状态都出现，
 * 将来新增一个状态时，漏掉它的迁移规则会直接编译不过。
 *
 * ⚠️ **没有 `cancelled` 的入边**：撤销是用户自己的动作（`POST /api/refunds/[id]/cancel`），
 * 管理后台不能替用户撤销，因此它的入边是空的——不是「暂时没做」，是刻意留白。
 */
export const ADMIN_REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  pending: ["reviewing", "approved", "rejected"],
  reviewing: ["approved", "rejected"],
  approved: [],
  rejected: [],
  cancelled: [],
};

/** 这次迁移是否合法。`from === to` 一律不合法（那不是一个「迁移」）。 */
export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return ADMIN_REFUND_TRANSITIONS[from].includes(to);
}

/**
 * 服务端判定的可执行动作。三个动作都是「迁移到某个状态」的别名，
 * 因此全部从 `ADMIN_REFUND_TRANSITIONS` 推导：终态三项都是 false。
 */
export function adminRefundAllowedActions(status: RefundStatus): AdminRefundAllowedActions {
  return {
    canStartReview: canTransitionRefund(status, "reviewing"),
    canApprove: canTransitionRefund(status, "approved"),
    canReject: canTransitionRefund(status, "rejected"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const ADMIN_REFUND_TERMINAL_NOTICE = "这笔退款申请已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const ADMIN_REFUND_NOT_FOUND_MESSAGE = "退款申请不存在";
export const ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/** 状态机拒绝了这次迁移时的提示。**带上当前状态**，否则会让人以为是自己点错了按钮。 */
export function adminRefundTransitionMessage(status: RefundStatus): string {
  return `当前状态是「${REFUND_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/** 按钮文案。列表与详情共用同一份。 */
export const ADMIN_REFUND_ACTION_LABELS = {
  startReview: "开始审核",
  approve: "通过",
  reject: "拒绝",
} as const;

/**
 * 三个动作的二次确认文案。
 *
 * 通过那条要**说清楚会发生什么**：它会同时改动退款申请与订单两处，
 * 而且订单一旦变成已退款就不再计入累计有效消费。拒绝那条要说清楚用户会看到什么。
 */
export const ADMIN_REFUND_CONFIRM_TEXTS = {
  startReview: "开始审核只把退款申请标记为「审核中」，订单状态与消费金额都不会变。确定开始？",
  /**
   * ⚠️ P0-13 起**必须说清「部分退款不改订单状态」**。
   *
   * 原来的文案写死了「订单变为『已退款』」——那只在累计退满时成立。
   * 部分退款下订单**保持原状态继续履约**，照旧文案会让管理员以为
   * 点一下就把这一单整单退了，从而错误地把 50% 当成「退一半、单子结束」。
   */
  approve:
    "通过后会在同一次写入里完成三件事：退款申请变为「已通过」、记录审核人与意见、" +
    "按你填写的退款比例与责任归属写入退款金额与打手收益冲回。" +
    "⚠️ 只有累计退款达到订单实付金额时，订单才会变为「已退款」并终止履约；" +
    "部分退款**不改动订单状态**，这一单按原进度继续。" +
    "订单变为「已退款」后不再计入用户的累计有效消费，消费等级与排行榜会排除这一单。" +
    "这是 Mock 审核，不会执行真实退款，也不代表款项已退回。确定通过？",
  reject: "拒绝后用户看到的进度页会变成「未通过」，审核意见会展示给对方。订单状态与消费金额都不会变。确定拒绝？",
} as const;

// ——————————————————————————— 审核意见 ———————————————————————————

/**
 * 审核意见的规则**与入驻审核共用同一份**（`lib/constants/adminApplications.ts`）。
 *
 * 复用而不是新写一份，是因为拒绝的两条硬要求完全一致：不能为空、不能超过 200 字。
 * 各写一份的话，两处的长度上限迟早会不一样，而那种差异没人能说出哪个才对。
 */
export {
  ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  normalizeAdminReviewNote,
} from "./adminApplications";

// ——————————————————————————— 列表查询 ———————————————————————————

/** 管理端退款列表查询条件（已解析、已校验）。 */
export type AdminRefundListQuery = {
  /** `all` 表示不限状态 */
  status: AdminRefundStatusFilter;
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  page: number;
  pageSize: number;
};

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它管理列表一致）。
 *
 * ⚠️ **只搜「退款单号 / 订单号 / 用户昵称 / 平台展示 ID」**，不搜退款说明与审核意见：
 * 那两段是内容不是标识，用它们搜出来的结果没人能预期；而退款说明里可能有
 * 用户写的隐私信息，把它当搜索对象等于给了一个探测入口。
 */
export function readAdminRefundKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

export function buildAdminRefundListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: AdminRefundStatusFilter;
}): AdminRefundListQuery {
  return {
    status: input.status,
    keyword: readAdminRefundKeyword(input.params.get("keyword")),
    page: clampPage(input.params.get("page"), ADMIN_REFUND_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_REFUND_PAGE_SIZE,
      ADMIN_REFUND_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * 默认排序：申请时间倒序，同一时间按 id 兜底。
 *
 * id 兜底不是可有可无的：预置数据里就有时间戳相同的记录，顺序不确定会让同一条
 * 在第一页出现过、翻到第二页又出现一次。
 */
export function compareRefundsForAdmin(
  a: Pick<RefundRequest, "createdAt" | "id">,
  b: Pick<RefundRequest, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 关键词是否命中：退款单号 / 订单号 / 用户昵称 / 平台展示 ID 四处任一包含即可。 */
export function refundMatchesAdminKeyword(
  input: { refundNo: string; orderNo: string; nickname: string; displayId: string },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    input.refundNo.toLowerCase().includes(needle) ||
    input.orderNo.toLowerCase().includes(needle) ||
    input.nickname.toLowerCase().includes(needle) ||
    input.displayId.toLowerCase().includes(needle)
  );
}

// ——————————————————————————— 资金决策表单与展示（P0-13） ———————————————————————————

/**
 * 决策表单的三个字段名。**管理端与接口共用一份文案**：
 * 页面上写「退款比例」、接口报错里也必须说「退款比例」，两处各写一次迟早会不一样。
 */
export const ADMIN_REFUND_DECISION_LABELS = {
  rate: "退款比例（%）",
  responsibility: "责任归属",
  liability: "打手责任比例（%）",
} as const;

/**
 * 决策表单的说明。
 *
 * ## 沿革（P0-13 验收整改，2026-09-25）
 *
 * 原文是「金额由系统按订单冻结的经济快照计算，这里不做预览；提交后显示实际退款金额」
 * ——那是 D15「客户端不做金额算术」的产物。验收时发现它**答不出管理员真正要问的问题**：
 * 他填了 30%，界面只说「金额由系统计算」，于是他要么先提交再看退了多少（不可撤销），
 * 要么去翻代码。因此 D15 被**显式取代**（见 `P0-13/02-decisions.md` §十一 D19）。
 *
 * ⚠️ **被取代的是「不显示」，不是「另算一套」**：界面上的预计金额由
 * `previewRefundDecisionAmounts()` 调用**服务端同一个** `computeRefundDecisionAmounts()` +
 * `resolveFinalDecisionAmounts()` 算出，规则仍然只有一份。
 * §三 那条纪律的实质是「不许有第二份金额公式」，不是「不许把服务端算出的数显示出来」。
 */
export const ADMIN_REFUND_DECISION_NOTE =
  "金额由系统按订单冻结的经济快照计算，规则与服务端完全一致（同一份公式函数）；" +
  "下面显示的是**预计值**，提交后以服务端返回的实际退款金额为准。";

/** 比例输入框的提示（与商品表单同一口径：只填数字，不带百分号）。 */
export const ADMIN_REFUND_DECISION_PERCENT_HINT = "只填数字，不带百分号";

/**
 * 未决策的申请在详情页的说明。
 *
 * ⚠️ 措辞刻意是「还没有资金决策」而不是「退款金额 0 元」：
 * 「还没人决定」与「决定了退 0 元」是两件事（见 `RefundDecision` 的注释）。
 */
export const ADMIN_REFUND_DECISION_PENDING_NOTE =
  "这笔申请还没有资金决策。通过时会按你填写的退款比例与责任归属，计算实际退款金额、打手收益冲回与平台承担额。";

// ————————————————— P0-13 验收整改：口径说明与实时金额（A–E） —————————————————

/**
 * **A. 退款比例的基数**——这句话必须在比例输入框旁边。
 *
 * ⚠️ 「比例是实付的百分比」这件事在实现里是硬事实（`computeRefundDecisionAmounts`
 * 的第一个乘数是 `actualPaidAmount`），但界面上原来一个字都没说。
 * 管理员最容易的两种误读是「原价的 30%」与「打手收益的 30%」，两种都会让他算错账。
 *
 * ⚠️ 措辞里带「只在没有优惠时才相等」：`actualPaidAmount = originalAmount − 券`，
 * 当前券恒为 0 所以两者相等，但那个等式是**规则的结果**，不是定义
 * （`lib/constants/orderAmount.ts` 顶部第 1 条纪律）。界面上说死「两者相等」，
 * 将来接券时这句话就会变成一句谎。
 */
export const ADMIN_REFUND_DECISION_RATE_BASE_NOTE =
  "退款比例是【用户实际支付金额】的比例：退款金额 = 实际支付金额 × 退款比例（向下取整到分）。" +
  "它不是订单原价的比例，也不是打手收益的比例——只有在没有任何优惠时，实付才与原价相等。";

/**
 * **B. 「按比例分担」的含义**——解答「是谁和谁分担、分担的是什么、基数是什么」。
 *
 * ⚠️ 这一段要消灭的误解非常具体：**「打手责任比例 40%」不是「打手承担退款金额的 40%」**。
 * 打手冲回额的第二个乘数是**打手收益**（`companionBaseIncome`），不是退款金额；
 * 而「剩下的由平台承担」里的「剩下」是 `退款金额 − 打手冲回额`，
 * 也不是「退款金额 ×（1 − 责任比例）」。两者只有在打手收益恰好等于退款金额时才巧合相等。
 */
export const ADMIN_REFUND_DECISION_SHARED_NOTE =
  "「按比例分担」分担的是**本次退款金额**，分担的双方是**平台与打手**。" +
  "打手承担的算法是：打手收益 × 退款比例 × 打手责任比例（向下取整到分）；" +
  "平台承担的是剩下的那部分，即**退款金额 − 打手冲回额**。" +
  "⚠️ 责任比例乘的是**打手收益**，不是退款金额——所以「责任比例 40%」并不表示打手承担退款金额的 40%。";

/**
 * **C. 订单金额表**的行标签。表在详情页与确认框里各渲染一次，标签只此一份。
 */
export const ADMIN_REFUND_ORDER_MONEY_LABELS = {
  originalAmount: "订单原价（优惠前）",
  couponDiscountAmount: "优惠券抵扣",
  actualPaidAmount: "用户实际支付金额",
  refundedAmount: "累计已退款",
  remainingRefundableAmount: "当前剩余可退款",
  companionBaseIncome: "打手收益（分账基数）",
  clubNetIncome: "平台收益",
  reversedSoFarAmount: "打手收益已冲回",
} as const;

/** 实时预览的四行标签。 */
export const ADMIN_REFUND_PREVIEW_LABELS = {
  refundAmount: "本次退款金额（预计）",
  companionReversalAmount: "本次冲回打手收益（预计）",
  platformBorneAmount: "本次由平台承担（预计）",
  companionRemainingAmount: "冲回后打手剩余收益（预计）",
} as const;

/**
 * 预览区在**还没填全**时的说明。
 *
 * ⚠️ 刻意**不显示 ¥0.00**：那会被读成「这次退 0 元」，而事实是「还没算得出来」。
 * 与 `ADMIN_REFUND_DECISION_PENDING_NOTE` 同一条纪律——「还没决定」与「决定了退 0 元」
 * 是两件事。
 */
export const ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE = "填完退款比例与责任归属后，这里会立刻显示预计金额。";

/**
 * 预览区在**金额超过剩余可退**时的警告。
 *
 * ⚠️ 这不是「多做了一层校验」，而是把服务端**已经存在**的那道闸
 * （`assertRefundAmountWithinPaid`）在提交**之前**说出来：
 * 不说的话，管理员要等提交被 400 才知道，而那一次点击本来是白点的。
 */
export const ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE =
  "本次退款金额超过当前剩余可退款金额，提交会被服务端拒绝。请调低退款比例，或改在下一笔申请中退。";

/** 打手收益已提现（D17）时，预览区必须说出来的一句话。 */
export const ADMIN_REFUND_PREVIEW_WITHDRAWN_NOTE =
  "该订单的打手收益已经提现，本轮不从打手收益中冲回（规则尚未定案，暂由平台全额承担），" +
  "因此本次冲回额为 0、平台承担额等于本次退款金额。";

/**
 * 实时预览的结果。
 *
 * `ok: false` 时 `message` 与**提交时的报错文案同源**（都来自
 * `readAdminRefundDecisionInput` / `validateRefundDecisionInput`），
 * 因此界面不会出现「预览说没事、提交说不行」这种两套说法。
 */
export type RefundDecisionPreview =
  | { ok: true; amounts: RefundDecisionAmounts; exceedsPaid: boolean }
  | { ok: false; message: string };

/**
 * **E. 五个问题**——界面必须让管理员**不看代码**就能回答的问题清单。
 *
 * 这里的答案给的是**规则**，具体到这一笔的数字由上方的实时预览与金额表回答。
 * 两者缺一不可：只给规则，管理员仍然要自己乘一遍；只给数字，他仍然不知道为什么是这个数。
 *
 * ⚠️ 每一句都必须与代码逐字对得上（对照 `computeRefundDecisionAmounts` 与
 * `resolveFinalDecisionAmounts`）。写一句「大概是这样」的话，比不写更糟——
 * 它会让人以为界面说的就是账上算的。
 */
export const ADMIN_REFUND_DECISION_QUESTIONS: readonly { q: string; a: string }[] = [
  {
    q: "这个比例是谁的比例？",
    a: "用户实际支付金额的比例。不是订单原价的，也不是打手收益的。",
  },
  {
    q: "最终会退多少钱？",
    a: "实际支付金额 × 退款比例，向下取整到分（见下方「本次退款金额（预计）」，提交后以服务端返回的实退金额为准）。",
  },
  {
    q: "这笔钱由谁承担？",
    a: "由你选的责任归属决定：平台承担 = 打手冲回 0；打手承担 = 打手收益 × 退款比例；按比例分担 = 打手收益 × 退款比例 × 打手责任比例。",
  },
  {
    q: "各方收益会因此减少多少？",
    a: "打手收益减少「本次冲回打手收益」；平台承担「本次由平台承担」= 退款金额 − 打手冲回额。" +
      "打手冲回额可能大于退款金额，此时平台承担额为负数（平台从打手处回收的比退给用户的还多）。",
  },
  {
    q: "当前最多还能退款多少钱？",
    a: "见下方「当前剩余可退款」= 实际支付金额 − 累计已退款。本次退款金额超过它，提交会被服务端拒绝。",
  },
];

// ——————————————————————————— 资金决策请求体（P0-13） ———————————————————————————

/**
 * 决策请求体里比例字段的**唯一**可接受形状：`1~3` 位数字的字符串。
 *
 * ⚠️ **刻意只收整数百分比**，不收 `"33.5"`、也不收 `33.5`（数字）。
 * 两个理由：
 *
 * 1. **金额字段不做静默取整**：允许小数就得决定 `"33.333"` 四舍五入到哪一位，
 *    而每一次这样的决定都会让「管理员以为填的比例」与「实际生效的比例」不一致；
 * 2. **不想把浮点带进规则层**：百分比走一遍浮点再乘 100 变成基点，
 *    会出现 `0.1 * 100 = 10.000000000000002` 这类需要靠 `Math.round` 兜住的值。
 *
 * 整数百分比意味着最小步进 1%（对一笔 50 元的订单就是 0.5 元）。
 * 若将来确实需要更细的粒度，那是一次**显式的规则变更**，不是在这里放宽正则。
 */
const PERCENT_PATTERN = /^\d{1,3}$/;

function readPercentAsBp(raw: unknown): { ok: true; bp: number } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!PERCENT_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, bp: Number(trimmed) * 100 };
}

/**
 * 读取并校验**通过退款**请求体里的资金决策三件套（P0-13）。
 *
 * 请求体形状（`POST /api/admin/refunds/[id]/approve`）：
 *
 * ```jsonc
 * {
 *   "refundRatePercent": "50",            // 必填，0~100 的整数字符串
 *   "responsibility": "shared",           // 必填，platform / companion / shared
 *   "companionLiabilityRatePercent": "60" // 仅 shared 需要；其余必须**不传或传空串**
 * }
 * ```
 *
 * ⚠️ 比例填 `"0"` 在**形态上**合法、在**金额上**不合法：它算出的退款金额是 0，
 * 会被数据层的金额闸按「退款金额为 0」挡下来（`REFUND_DECISION_AMOUNT_ZERO_MESSAGE`）。
 * 两道校验各答各的问题——这里答「填的东西长什么样」，那里答「退出来的钱是多少」。
 *
 * ⚠️ **为什么用字符串而不是数字**：比例是钱的一部分，用字符串过一遍
 * 可以明确区分「没填」（`undefined`）与「填了 0」（`"0"`），
 * 而数字 `0` 在 `JSON` 里和「没填」在 `??` 下长得一模一样。
 *
 * ⚠️ **为什么 `platform` / `companion` 传了责任比例要报错**（而不是忽略）：
 * 那是一个金额字段。管理员填了 60%、选了「平台承担」，若静默忽略，
 * 他会以为 60% 生效了，而实际冲回是 0——这种「填了但没生效」的错，
 * 在账上要等到对账才被发现。
 *
 * 返回 `null` 表示通过；否则是给管理员看的中文原因。
 */
export function readAdminRefundDecisionInput(
  body: unknown,
): { ok: true; input: RefundDecisionInput } | { ok: false; message: string } {
  const source = (body ?? {}) as Record<string, unknown>;

  const rawRate = source.refundRatePercent;
  if (rawRate === undefined || rawRate === null || (typeof rawRate === "string" && rawRate.trim() === "")) {
    return { ok: false, message: REFUND_DECISION_RATE_REQUIRED_MESSAGE };
  }
  const rate = readPercentAsBp(rawRate);
  if (!rate.ok) return { ok: false, message: REFUND_DECISION_RATE_INVALID_MESSAGE };

  const rawResponsibility = source.responsibility;
  if (typeof rawResponsibility !== "string" || rawResponsibility.trim() === "") {
    return { ok: false, message: REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE };
  }
  if (!isRefundResponsibility(rawResponsibility)) {
    return { ok: false, message: REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE };
  }

  const rawLiability = source.companionLiabilityRatePercent;
  const liabilityGiven =
    rawLiability !== undefined &&
    rawLiability !== null &&
    !(typeof rawLiability === "string" && rawLiability.trim() === "");

  if (rawResponsibility === "shared" && !liabilityGiven) {
    return { ok: false, message: REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE };
  }

  let liabilityBp: number | null = null;
  if (liabilityGiven) {
    const liability = readPercentAsBp(rawLiability);
    if (!liability.ok) return { ok: false, message: REFUND_DECISION_LIABILITY_INVALID_MESSAGE };
    liabilityBp = liability.bp;
  }

  const input: RefundDecisionInput = {
    refundRateBp: rate.bp,
    responsibility: rawResponsibility,
    companionLiabilityRateBp: liabilityBp,
  };

  // 范围与「谁该填责任比例」的最终判定统一走规则层，避免两处各判一遍
  const message = validateRefundDecisionInput(input);
  if (message !== null) return { ok: false, message };

  return { ok: true, input };
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 退款申请 + 订单摘要 + 用户摘要 → 管理端列表项。**显式挑字段**。 */
export function toAdminRefundListItem(
  refund: RefundRequest,
  order: { id: string; orderNo: string; status: OrderStatus; productTitle: string },
  user: AdminUserSummary,
): AdminRefundListItem {
  return {
    id: refund.id,
    refundNo: refund.refundNo,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    // 只读展示值：它来自申请创建时的服务端快照，管理端没有入口能改
    amount: refund.amount,
    // ⚠️ 与 `AdminRefundDetail.decision` 同源，都从这里派生，因此不会各自漂移
    decidedAmount: refund.decision?.refundAmount ?? null,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
    user,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status],
    productTitle: order.productTitle,
  };
}

/**
 * 内部实体 → 管理端详情。
 *
 * 在列表项之上补齐原因、说明、凭证、审核信息与可执行动作，并补齐
 * **整张订单的金额快照**（`orderMoney`，P0-13 验收整改 C）。
 * `money` 里的两项由调用方查好传进来（见 `toAdminRefundOrderMoney` 的说明）。
 */
export function toAdminRefundDetail(
  refund: RefundRequest,
  order: AdminRefundOrderFacts,
  user: AdminUserSummary,
  money: { reversedSoFarAmount: number; companionEarningStatus: EarningStatus | null },
): AdminRefundDetail {
  return {
    ...toAdminRefundListItem(refund, order, user),
    orderMoney: toAdminRefundOrderMoney(order, money),
    decision: refund.decision,
    reasonKey: refund.reasonKey,
    reasonLabel: refund.reasonLabel || (REFUND_REASON_LABELS[refund.reasonKey] ?? refund.reasonKey),
    description: refund.description,
    evidence: refund.evidence,
    reviewingAt: refund.reviewingAt,
    reviewedAt: refund.reviewedAt,
    reviewedBy: refund.reviewedBy,
    reviewedByRole: refund.reviewedByRole,
    reviewedByName: refund.reviewedByName,
    reviewNote: refund.reviewNote,
    cancelledAt: refund.cancelledAt,
    timeline: buildAdminRefundTimeline(refund),
    allowedActions: adminRefundAllowedActions(refund.status),
  };
}

/**
 * `toAdminRefundDetail` 需要的订单事实：列表项的四个展示字段 + 六个金额快照。
 *
 * ⚠️ 六个金额**全部来自订单**（下单那一刻冻结的那一份），调用方不得用今天的
 * 商品价格或今天的分账比例现算——那等于用今天的规则重算历史账。
 */
export type AdminRefundOrderFacts = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  productTitle: string;
  originalAmount: number;
  couponDiscountAmount: number;
  actualPaidAmount: number;
  refundedAmount: number;
  companionBaseIncome: number;
  clubNetIncome: number;
};

/**
 * 订单事实 + 「既往已冲回额」+「收益状态」→ 管理端详情上的订单金额快照。
 *
 * ⚠️ 后两项**不属于订单**，因此由调用方单独传进来：
 * 「已冲回多少」要读该订单**全部已批准退款**的决策（`sumApprovedCompanionReversal`），
 * 「收益状态」在收益域（`serving` 单还没结算时为 `null`，D9）。
 * 把它们塞进订单对象会造出「订单上有两处真值源」的假象。
 */
export function toAdminRefundOrderMoney(
  order: AdminRefundOrderFacts,
  extra: { reversedSoFarAmount: number; companionEarningStatus: EarningStatus | null },
): AdminRefundOrderMoney {
  return {
    originalAmount: order.originalAmount,
    couponDiscountAmount: order.couponDiscountAmount,
    actualPaidAmount: order.actualPaidAmount,
    refundedAmount: order.refundedAmount,
    // 不加 Math.max(0, …)：见类型上的说明——负数是数据出问题的信号，藏起来更糟
    remainingRefundableAmount: order.actualPaidAmount - order.refundedAmount,
    companionBaseIncome: order.companionBaseIncome,
    clubNetIncome: order.clubNetIncome,
    reversedSoFarAmount: extra.reversedSoFarAmount,
    companionEarningStatus: extra.companionEarningStatus,
  };
}

/**
 * **决策表单的实时预览**（P0-13 验收整改 D）。
 *
 * 管理员每敲一个字符就调用一次，因此它必须是**纯函数**：不读仓储、不取时间、不发请求。
 *
 * ## 为什么这不是「客户端做金额算术」
 *
 * 它做的**唯一**一件事是：把服务端写入路径上那两个函数
 * （`computeRefundDecisionAmounts` → `resolveFinalDecisionAmounts`）
 * 用**同一组入参**再跑一遍。公式一行都没有重写，取整方向也没有重写。
 * 若哪天公式改了，界面上的预计金额会**自动**跟着改——这正是「只有一份规则」的含义。
 *
 * 反过来，若在这里照抄一遍公式（哪怕逐字抄），两处迟早会漂移，
 * 而这种漂移的表现是「界面显示退 ¥25、账上退 ¥24.99」，且**只有提交之后**才看得见。
 *
 * ## 它与服务端唯一的差别
 *
 * 服务端的入参取自**写入时刻**的存储（`order.refundedAmount`、既往决策、收益状态），
 * 这里取自**页面加载时**的详情 DTO。两者只有在「你看这一页的同时别人也批了一笔」
 * 时才会不同，而那种情况下服务端的金额闸会拒绝提交并说明原因——
 * 界面上的字因此是「预计」，提交后以响应里的 `decidedAmount` 为准。
 *
 * ⚠️ 参数用**字符串**（与请求体一致）：`"0"` 与「没填」是两件事，
 * 数字 `0` 在 `??` 下与 `undefined` 长得一样。
 */
export function previewRefundDecisionAmounts(input: {
  orderMoney: AdminRefundOrderMoney;
  /** 与 `POST /approve` 请求体同形：`""` 表示还没填 */
  refundRatePercent: string;
  responsibility: string;
  companionLiabilityRatePercent: string;
}): RefundDecisionPreview {
  const checked = readAdminRefundDecisionInput({
    refundRatePercent: input.refundRatePercent,
    responsibility: input.responsibility,
    companionLiabilityRatePercent: input.companionLiabilityRatePercent,
  });
  if (!checked.ok) return { ok: false, message: checked.message };

  const { orderMoney } = input;
  const amounts = resolveFinalDecisionAmounts(
    computeRefundDecisionAmounts({
      actualPaidAmount: orderMoney.actualPaidAmount,
      companionBaseIncome: orderMoney.companionBaseIncome,
      reversedSoFar: orderMoney.reversedSoFarAmount,
      input: checked.input,
    }),
    orderMoney.companionEarningStatus,
  );

  // 服务端的金额闸**不在这里复制判断条件**：用它自己的返回值问同一个问题
  const gateMessage = assertRefundAmountWithinPaid({
    refundAmount: amounts.refundAmount,
    alreadyRefundedAmount: orderMoney.refundedAmount,
    actualPaidAmount: orderMoney.actualPaidAmount,
  });

  return { ok: true, amounts, exceedsPaid: gateMessage !== null };
}

/**
 * 管理端的进度时间轴。
 *
 * ⚠️ 与用户端 `buildRefundTimeline()` **分开**：那一份的撤销节点写的是
 * 「你撤销了这笔退款申请」——那个「你」是申请本人。管理端看到的是「用户撤销了」，
 * 用同一份文案会让客服读成「这笔申请是我撤销的」。
 *
 * 只包含**已经发生**的节点，按时间先后排列。
 */
export function buildAdminRefundTimeline(refund: RefundRequest): AdminRefundDetail["timeline"] {
  const entries: AdminRefundDetail["timeline"] = [
    {
      key: "pending",
      label: REFUND_STATUS_LABELS.pending,
      at: refund.createdAt,
      note: "用户提交了退款申请，等待平台审核",
    },
  ];

  if (refund.reviewingAt) {
    entries.push({
      key: "reviewing",
      label: REFUND_STATUS_LABELS.reviewing,
      at: refund.reviewingAt,
      note: "平台已开始审核这笔退款申请",
    });
  }
  if (refund.status === "approved" && refund.reviewedAt) {
    entries.push({
      key: "approved",
      label: REFUND_STATUS_LABELS.approved,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请已通过（Mock 审核，未执行真实退款）",
    });
  }
  if (refund.status === "rejected" && refund.reviewedAt) {
    entries.push({
      key: "rejected",
      label: REFUND_STATUS_LABELS.rejected,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请未通过",
    });
  }
  if (refund.status === "cancelled" && refund.cancelledAt) {
    entries.push({
      key: "cancelled",
      label: REFUND_STATUS_LABELS.cancelled,
      at: refund.cancelledAt,
      note: "用户自己撤销了这笔退款申请",
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}
