import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  OPEN_REFUND_STATUSES,
  REFUND_DECISION_RATE_INVALID_MESSAGE,
  REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  REFUND_REASON_LABELS,
  REFUND_STATUSES,
  REFUND_STATUS_LABELS,
  assertRefundAmountWithinPaid,
  assertRefundApprovalOrderStatus,
  computeRefundDecisionAmounts,
  validateRefundDecisionInput,
  type RefundDecisionAmounts,
  type RefundDecisionInput,
} from "@/lib/constants/refunds";
import type { ActorRole } from "@/lib/types/actor";
import type { OrderStatus } from "@/lib/types/order";
import type {
  AdminRefundAllowedActions,
  AdminRefundDetail,
  AdminRefundListItem,
  AdminRefundOrderMoney,
  RefundDecision,
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
 * 4. **金额仍然不可直接填写**：请求体里**没有**接收金额的字段，
 *    管理员输入的**只有退款比例**，金额一律由
 *    `computeRefundDecisionAmounts()` 按订单冻结快照算出来
 *    （`业务流程表.md` §16.B：「管理员只输入退款比例，金额由系统计算」）。
 *    ⚠️ 原先写的「`amount` 取申请创建时的实付快照」在 P0-13 之后**只对申请快照成立**，
 *    它不再是「这次退了多少钱」——后者是 `decision.refundAmount`。
 *    ⚠️ **P0-15 起管理员输入的字段从两个减到一个**：责任归属（P0-13 的第 4 条要求
 *    「管理员输入的只有比例**与责任归属**」）随责任模型废止而删除，
 *    界面上不再有那组单选。这一条本身没变——「请求体里没有金额字段」从来是它的主语。
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

/**
 * 列表顶部的说明：讲清楚这张列表的口径与动作后果。
 *
 * ⚠️ **P0-15**：「只有**累计**退满时」→「只有**比例填 100%** 时」。
 * 同一个订单至多退一次，因此不存在「累计」这件事。
 */
export const ADMIN_REFUND_LIST_NOTICE =
  "列表按申请时间倒序，涵盖全部用户的退款申请。退款状态与订单状态是两条独立的线：" +
  "开始审核与拒绝只改退款申请，订单按原进度继续；通过会同时写入退款金额与打手收益冲回，" +
  "只有比例填 100% 时订单才变成「已退款」，部分退款不改订单状态。";

/**
 * 退款金额口径的说明（管理端）。
 *
 * ⚠️ P0-13 改写过：原来只有「不可修改」这一层意思。现在管理员**要输入比例**，
 * 所以必须同时说清「你输入的是什么」与「金额从哪来」——否则他会去找一个
 * 根本不存在的金额输入框，或者以为比例只是个备注。
 *
 * ⚠️ **P0-15 删掉了「责任归属」这四个字**：它不是可选措辞，而是**指向一个
 * 已经不存在的输入控件**——管理员读到「由责任归属决定」会去表单里找它，
 * 找不到就以为页面坏了。金额口径现在**只有比例一个输入**。
 */
export const ADMIN_REFUND_AMOUNT_NOTE =
  "「申请金额」是申请创建时的订单实付快照，不可修改。实际退款金额由你填写的退款比例决定，" +
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
 *
 * ⚠️ **P0-15**：「只有**累计**退满时」→「**比例填 100% 时**」。
 * 一单一退之后不存在「累计」，退满与否只由那一次的比例决定。
 */
export const ADMIN_REFUND_CONSUMPTION_NOTICE =
  "比例填 100% 时订单变为「已退款」，不再计入累计有效消费，消费等级与周期排行榜会自动排除这一单；" +
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
  "筛选条件 status 只能是 all / open / pending / reviewing / approved / rejected / cancelled";

// ——————————————————————————— 状态筛选 ———————————————————————————

/**
 * 状态筛选。`all` 表示不限，`open` 表示「未终态」。
 *
 * ⚠️ `open` **不是领域状态**：不写进 store、不进状态机、不在 `RefundStatus` 里，
 * 只是「把 `OPEN_REFUND_STATUSES` 一次筛出来」的地址栏写法。
 * 服务层在调用仓储前用 `refundStatusesForFilter()` 把它解析成真实状态集合，
 * 因此数据层永远看不到 `open`。
 */
export type AdminRefundStatusFilter = RefundStatus | "all" | "open";

export const ADMIN_REFUND_STATUS_FILTERS: readonly AdminRefundStatusFilter[] = [
  "all",
  "open",
  ...REFUND_STATUSES,
];

export const ADMIN_REFUND_STATUS_FILTER_LABELS: Record<AdminRefundStatusFilter, string> = {
  all: "全部",
  open: "待处理",
  ...REFUND_STATUS_LABELS,
};

/**
 * 筛选值 → **真实领域状态集合**（`null` 表示不限）。
 *
 * ⚠️ 列表服务与首页 Dashboard 都调这一个函数，不各自写
 * `status === "all" ? null : status`——那样 `open` 会被当成一个字面量状态去筛，
 * 结果是 0 条且不报错。
 *
 * `StaffRefundStatusFilter`（`RefundStatus | "all"`）是本类型的子集，
 * 因此客服端调用同一个函数、且天然拿不到 `open`。
 */
export function refundStatusesForFilter(
  filter: AdminRefundStatusFilter,
): readonly RefundStatus[] | null {
  if (filter === "all") return null;
  if (filter === "open") return OPEN_REFUND_STATUSES;
  return [filter];
}

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
 *
 * ⚠️ **`canApprove` 还多守一道订单状态闸**（产品裁定 2026-09-27）：
 * `paid` / `accepted` 的订单**不允许批准售后退款申请**，
 * 只有 `serving` / `completed` 能进这条资金链。因此第二个入参不是可有可无的装饰——
 * 它是这道闸在**读侧**的唯一依据。
 *
 * ## 为什么读侧也要判，而不是「反正写侧会拒」
 *
 * 写侧（`adminRefundTransaction.ts` 的 `assertRefundApprovalOrderStatus`）是**保证**，
 * 读侧是**告知**，两者不能互相替代：
 *
 * - 只有写侧：详情页会理直气壮地渲染一个永远返回 400 的「通过」按钮，
 *   管理员填完比例、看完预览金额、按下去，才被告知「这一单根本不在范围内」——
 *   他会先怀疑是自己填错了，而不是这一单本来就不该批；
 * - 只有读侧：接口可以被直接请求，没有任何保护。
 *
 * ⚠️ 这与「不依赖前端隐藏按钮保证」**不矛盾**：那条说的是**不能只有**前端，
 * 不是「前端不许知道」。服务端把结论算好交给页面，页面照做——页面自己写
 * `if (orderStatus === "paid")` 才是被禁止的那件事。
 */
export function adminRefundAllowedActions(
  status: RefundStatus,
  orderStatus: OrderStatus,
): AdminRefundAllowedActions {
  return {
    canStartReview: canTransitionRefund(status, "reviewing"),
    // 订单状态闸与状态机是**两个独立条件**，必须同时成立：
    // 状态机说「这笔申请现在能不能批」，订单状态闸说「这一单的业务阶段允不允许走售后审批」
    canApprove:
      canTransitionRefund(status, "approved") && assertRefundApprovalOrderStatus(orderStatus) === null,
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
   *
   * ⚠️ **P0-15 改了两处措辞**：
   * - 「与**责任归属**」删除（那个输入控件已不存在）；
   * - 「只有**累计**退款达到订单实付金额时」→「**只有比例填 100% 时**」。
   *   「累计」是**多步退款**模型留下的词，一单一退之后它不再指任何东西；
   *   留着一个读不出对应操作的词，比说错更糟——管理员会去找「累计」在哪看。
   */
  approve:
    "通过后会在同一次写入里完成三件事：退款申请变为「已通过」、记录审核人与意见、" +
    "按你填写的退款比例写入退款金额与打手收益冲回。" +
    "⚠️ **只有比例填 100% 时**，订单才会变为「已退款」并终止履约；" +
    "部分退款（10% / 50% 等）**不改动订单状态**，这一单按原进度继续。" +
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
  /** `all` 表示不限状态，`open` 表示未终态（见 `AdminRefundStatusFilter`） */
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
 * 决策表单的字段名。**管理端与接口共用一份文案**：
 * 页面上写「退款比例」、接口报错里也必须说「退款比例」，两处各写一次迟早会不一样。
 *
 * ⚠️ **P0-15 从三个减到一个**：`responsibility`（责任归属）与
 * `liability`（打手责任比例）随责任模型一并删除。这不是「这一批先不做」——
 * 它们对应的输入框、单选组与请求体字段都已经不存在，删掉常量是**跟着删**，
 * 不是提前删。留着一个没人渲染的标签，只会让人去找那个不存在的输入框。
 */
export const ADMIN_REFUND_DECISION_LABELS = {
  rate: "退款比例（%）",
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
 * `previewRefundDecisionAmounts()` 调用**服务端同一个**
 * `computeRefundDecisionAmounts()` 算出，规则仍然只有一份。
 * §三 那条纪律的实质是「不许有第二份金额公式」，不是「不许把服务端算出的数显示出来」。
 * ⚠️ P0-15 之前这里还列着 `resolveFinalDecisionAmounts()`，那一层已删除。
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
  "这笔申请还没有资金决策。通过时会按你填写的退款比例，计算实际退款金额与打手收益冲回额（退款一旦通过，打手本单收益全部取消）。";

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
 * **B. 打手收益与平台收入**——解答「这笔退款对两边各是什么结果」。
 *
 * ⚠️ **常量名从 `ADMIN_REFUND_DECISION_SHARED_NOTE` 改为此名**（P0-15）：
 * 旧名里的 `SHARED` 指的是「按比例分担」那种责任归属，而那个选项已经不存在，
 * 留着旧名会让下一个人以为它只在某一分支下显示。它现在**无条件显示**——
 * 它描述的是每一次退款都会发生的事，不是某一种选择的结果。
 *
 * ⚠️ P0-15 之前这里讲的是「按比例分担」：打手承担 = 打手收益 × 退款比例 × 责任比例。
 * **那一整段被替换掉了**，因为责任模型已废止。要消灭的误解也换了：
 * 管理员最容易以为「退 10% 就只从打手身上扣 10%」，而**不是**——退款不论比例，
 * 打手本单收益**全额归零**，平台拿走的是「实付 − 退款额」。
 */
export const ADMIN_REFUND_DECISION_OUTCOME_NOTE =
  "退款一旦通过，**打手本单收益全部取消**（不论退款比例是 10% 还是 100%），剩下的归平台。" +
  "平台最终收入 = 用户实际支付金额 − 本次退款金额。" +
  "⚠️ 冲回额不是「打手收益 × 退款比例」——退款比例只决定退给用户多少钱，不决定打手损失多少。";

/**
 * **C. 订单金额表**的行标签。表在详情页与确认框里各渲染一次，标签只此一份。
 *
 * ⚠️ **P0-15 删掉两行**：`remainingRefundableAmount`（「当前剩余可退款」）
 * 与 `reversedSoFarAmount`（「打手收益已冲回」）——它们的名字里都含「累计 / 剩余」
 * 这个**多步退款模型**的语义。一个订单只退一次之后，前者恒等于实付（没有「剩余」可言），
 * 后者恒等于打手收益（没有「累计」可言），两行都变成同一张表里另外两行的副本。
 * 「这一次能退多少」由管理员填的比例决定，不再有一个「最多能退多少」的上限概念。
 *
 * ⚠️ `refundedAmount`（「累计已退款」）**保留**：它不是本轮的输入，
 * 而是订单自身的历史事实（也可能来自免审批直接退款那条不产生申请的路径），
 * 界面需要如实显示它。但**新业务路径不再依赖它做金额计算**。
 */
export const ADMIN_REFUND_ORDER_MONEY_LABELS = {
  originalAmount: "订单原价（优惠前）",
  couponDiscountAmount: "优惠券抵扣",
  actualPaidAmount: "用户实际支付金额",
  refundedAmount: "累计已退款",
  companionBaseIncome: "打手收益（分账基数）",
  clubNetIncome: "平台收益",
} as const;

/**
 * 实时预览的三行标签。
 *
 * ⚠️ **P0-15 删掉两行**：`platformBorneAmount`（「本次由平台承担」）
 * 与 `companionRemainingAmount`（「冲回后打手剩余收益」）。
 * 前者的定义在新规则下恒等于退款金额；后者**恒为 0**——「剩余」这个概念
 * 随「打手全额归零」一并消失。显示一行永远是 0 的数字，比不显示更容易被误读。
 * 「平台最终收入」改由订单金额表那一行（`clubNetIncome`）表达。
 */
export const ADMIN_REFUND_PREVIEW_LABELS = {
  refundAmount: "本次退款金额（预计）",
  companionReversalAmount: "本次冲回打手收益（预计）",
} as const;

/**
 * 预览区在**还没填全**时的说明。
 *
 * ⚠️ 刻意**不显示 ¥0.00**：那会被读成「这次退 0 元」，而事实是「还没算得出来」。
 * 与 `ADMIN_REFUND_DECISION_PENDING_NOTE` 同一条纪律——「还没决定」与「决定了退 0 元」
 * 是两件事。
 */
export const ADMIN_REFUND_PREVIEW_INCOMPLETE_NOTE = "填完退款比例后，这里会立刻显示预计金额。";

/**
 * ⛔ **P0-15 删除了 `ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE`**（原「金额超过实付」预览文案）。
 *
 * **删它的理由不是措辞，是它答错了问题。** 它原先挂在预览的一个布尔上，
 * 而那个布尔是 `gateMessage !== null`（见 `previewRefundDecisionAmounts`）——
 * 于是**只要金额闸拒绝就渲染这句**。金额闸拒的不止「超过实付」一种：
 * 填 `0` 时它返回的是 `REFUND_DECISION_AMOUNT_ZERO_MESSAGE`（「退款金额为 0」），
 * 预览却会告诉管理员「本次退款金额超过该订单的实际支付金额……请调低退款比例」——
 * **账实不符，而且把补救方向也指反了**（0 元的问题不是「调低」，是「退 0 元不是一次退款」）。
 *
 * 改成：预览**原样转述金额闸自己的那句话**（`gateMessage`），
 * 与提交被拒时返回的是**同一句**。这样「界面说的」与「账上算的」不可能分叉，
 * 也不需要为每一档闸门各维护一份预览副本。
 * 「超过实付」那一档的补救方向（填 100）并入了 `REFUND_DECISION_EXCEEDS_PAID_MESSAGE` 本身，
 * 因此提交时报错同样带着它。
 */

/**
 * ⚠️ **P0-15 删除了 `ADMIN_REFUND_PREVIEW_WITHDRAWN_NOTE`**（原「打手收益已提现」提示）。
 *
 * 那条提示存在的理由是 P0-13 的 D17：「已提现的收益不冲回，多出的由平台承担」，
 * 因此界面必须解释「为什么冲回额是 0」。**D17 的问题本身被 P0-15 取消了**
 * （见 `02-decisions.md` Q1）：正常退款流程下打手收益**根本到不了 `withdrawn`**——
 * 订单完成时收益被冻结，冻结期内有退款就继续保持冻结，退款批准把它整笔冲销。
 * 既然「已提现」在普通退款里不可达，为它准备的提示也就没有落点。
 *
 * ⚠️ **存储层并没有一道「已提现就不冲回」的闸**——不要以为删掉的只是文案。
 * `applyEarningReversal`（`lib/data/mockEarningRepository.ts`）里**没有 `withdrawn`
 * 分支**：对一笔 `withdrawn` 的收益调用它，冲回照常落库（状态按 P0-15 的规则回到 `frozen`）。
 * 之所以可以没有这道闸，是因为**普通退款流程里 `withdrawn` 结构上不可达**
 * （订单完成时收益 `frozen`，冻结期内有退款就继续冻结，批准即整笔冲销；
 * 唯一出口 `sweepMaturedEarnings` 的谓词含「无在途退款」）。
 * 反过来说：**若将来平台真的要支持「结算完成、甚至已提现后由后台强制退款」，
 * 那是一条新的特殊财务业务**——届时缺的不只是文案，还有存储层对已提现资金的
 * 冲回口径（负余额 / 追偿 / 平台垫付）与它的并发护栏，必须一并设计。
 */

/**
 * 实时预览的结果。
 *
 * `ok: false` 时 `message` 与**提交时的报错文案同源**（都来自
 * `readAdminRefundDecisionInput` / `validateRefundDecisionInput`），
 * 因此界面不会出现「预览说没事、提交说不行」这种两套说法。
 *
 * ⚠️ **`ok: true` 分支照样可能带一句 `gateMessage`**（`null` 表示这道闸也会放行）：
 * 「形状合法」与「金额闸放行」是两件事——填 `0` 的形状完全合法，
 * 但金额闸会拒。这句话**原样来自金额闸本身**，不是预览另写的一份副本，
 * 所以它永远与提交时看到的完全一致（P0-15：原先那个 `exceedsPaid: boolean`
 * 把「金额为 0」也答成了「超过实付」，已删）。
 */
export type RefundDecisionPreview =
  | { ok: true; amounts: RefundDecisionAmounts; gateMessage: string | null }
  | { ok: false; message: string };

/**
 * **E. 四个问题**——界面必须让管理员**不看代码**就能回答的问题清单。
 *
 * 这里的答案给的是**规则**，具体到这一笔的数字由上方的实时预览与金额表回答。
 * 两者缺一不可：只给规则，管理员仍然要自己乘一遍；只给数字，他仍然不知道为什么是这个数。
 *
 * ⚠️ **P0-15 换掉了一问，条数仍是五**：删掉的是「当前最多还能退款多少钱」——
 * 一单一退、管理员一次性核定比例之后，**不存在「最多能退多少」这个上限**；
 * 补进来的是「这一单以后还能再退吗」——唯一性是新规则里最容易搞错的点，
 * 而它的答案会影响管理员此刻该怎么批。剩下四问（**比例是谁的比例** /
 * **最终会退多少钱** / **这笔钱由谁承担** / **各方收益减少多少**）原样保留。
 *
 * ⚠️ 每一句都必须与代码逐字对得上（对照 `computeRefundDecisionAmounts`）。
 * 写一句「大概是这样」的话，比不写更糟——它会让人以为界面说的就是账上算的。
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
    a: "不再需要选择。用户拿走退款金额，打手本单收益全部取消，剩下的归平台——「谁承担」是退款比例算出来的结果，不是输入。",
  },
  {
    q: "各方收益会因此减少多少？",
    a: "打手本单收益**全部取消**（不论退款比例是多少，冲回额恒等于打手收益）；" +
      "平台最终收入 = 用户实际支付金额 − 本次退款金额。不存在「只冲减一部分打手收益」的情形。",
  },
  {
    q: "这一单以后还能再退吗？",
    a: "不能。一个订单只允许一次退款：提交过申请即封死（哪怕被拒绝或自己撤销也封死），批准并执行后这笔订单的退款流程终结。",
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
 * 读取并校验**通过退款**请求体里的资金决策（P0-13 建立 · **P0-15 收敛为一个字段**）。
 *
 * 请求体形状（`POST /api/admin/refunds/[id]/approve`）：
 *
 * ```jsonc
 * {
 *   "refundRatePercent": "50"   // 必填，0~100 的整数字符串
 * }
 * ```
 *
 * ## 被删掉的两个字段（P0-15）
 *
 * `responsibility`（`platform` / `companion` / `shared`）与
 * `companionLiabilityRatePercent` **随责任模型一并废止**。
 * 新规则下管理员不再选择责任归属：退款批准即把打手本单收益整笔取消，
 * 剩下的归平台——「谁承担」不再是输入，而是**规则的结果**。
 * 留着一个不再有分支的字段，只会让读接口的人以为还有别的可能。
 *
 * ## 被删掉的 `refundFullRemaining`（P0-15）
 *
 * 「退满剩余」是「多步退款补尾差」的产物：`floor(2990 × 67%) = 2003`，
 * 而 68% 是 2033——2040 这个尾数**没有任何整数百分比能表达**，
 * 于是 P0-14 给了它一个开关。**一个订单只退一次之后尾差不存在了**
 * （`floor(实付 × 100%) = 实付`，正好是「全额退款」），
 * 因此这个开关连同它的「二选一」校验一起删除，**「全额退款」= 比例填 100**。
 *
 * ⚠️ 比例填 `"0"` 在**形态上**合法、在**金额上**不合法：它算出的退款金额是 0，
 * 会被数据层的金额闸按「退款金额为 0」挡下来（`REFUND_DECISION_AMOUNT_ZERO_MESSAGE`）。
 * 两道校验各答各的问题——这里答「填的东西长什么样」，那里答「退出来的钱是多少」。
 *
 * ⚠️ **为什么用字符串而不是数字**：比例是钱的一部分，用字符串过一遍
 * 可以明确区分「没填」（`undefined`）与「填了 0」（`"0"`），
 * 而数字 `0` 在 `JSON` 里和「没填」在 `??` 下长得一模一样。
 *
 * 返回 `null` 表示通过；否则是给管理员看的中文原因。
 */
export function readAdminRefundDecisionInput(
  body: unknown,
): { ok: true; input: RefundDecisionInput } | { ok: false; message: string } {
  const source = (body ?? {}) as Record<string, unknown>;

  const rawRate = source.refundRatePercent;
  const rateGiven =
    rawRate !== undefined &&
    rawRate !== null &&
    !(typeof rawRate === "string" && rawRate.trim() === "");

  if (!rateGiven) {
    return { ok: false, message: REFUND_DECISION_RATE_REQUIRED_MESSAGE };
  }

  const rate = readPercentAsBp(rawRate);
  if (!rate.ok) return { ok: false, message: REFUND_DECISION_RATE_INVALID_MESSAGE };

  const input: RefundDecisionInput = { refundRateBp: rate.bp };

  // 范围的最终判定统一走规则层，避免两处各判一遍
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
 * ⚠️ P0-15 起 `orderMoney` 的全部字段都来自订单自身，
 * 因此不再需要调用方额外查收益域的东西传进来（见 `toAdminRefundOrderMoney`）。
 */
export function toAdminRefundDetail(
  refund: RefundRequest,
  order: AdminRefundOrderFacts,
  user: AdminUserSummary,
): AdminRefundDetail {
  return {
    ...toAdminRefundListItem(refund, order, user),
    orderMoney: toAdminRefundOrderMoney(order),
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
    allowedActions: adminRefundAllowedActions(refund.status, order.status),
    /*
      订单状态挡住「通过」时的原因，**与写侧 400 的 message 同一句话**
      （同一个函数 `assertRefundApprovalOrderStatus`）。没被挡时为 null。

      ⚠️ **必须先过 `canTransitionRefund` 这一关才去问订单档位**：`canApprove === false`
      有两种互不相同的原因，页面（`AdminRefundConsole`）对它们的处置也不同——

      | 情形 | `canApprove` | 页面 |
      |---|---|---|
      | 申请已终态（已通过 / 已拒绝 / 已撤销） | false | 三个按钮一起不显示，改显示「这笔退款申请已结束」 |
      | 申请未终态，但订单不在审批范围 | false | 三个按钮照常显示，「通过」变灰，下面配上这句话 |

      不先过第一关的话，一条**已通过**的申请（它的订单必然已是 `refunded`，
      于是订单档位这一问也答「不行」）会同时渲染出「已结束」与「订单不在审批范围内」
      两句话，把管理员引到**错误的原因**上去——而真正的原因是「这笔早批完了」。
    */
    approveBlockedReason: canTransitionRefund(refund.status, "approved")
      ? assertRefundApprovalOrderStatus(order.status)
      : null,
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
 * 订单事实 → 管理端详情上的订单金额快照。
 *
 * ⚠️ **P0-15 起它只接受订单自己的字段，没有任何「额外传入」**。
 * 原先还要传两项收益域的事实（既往已冲回额、收益状态），
 * 因为那时的冲回额要减掉「此前冲过多少」、还要在「已提现」时改口径。
 * 两者都随责任模型与 D17 一起消失，于是这个转换退化成一次**纯搬运**：
 * 每个输出字段都直接对应订单上的一个冻结快照，一个都不重算。
 */
export function toAdminRefundOrderMoney(order: AdminRefundOrderFacts): AdminRefundOrderMoney {
  return {
    originalAmount: order.originalAmount,
    couponDiscountAmount: order.couponDiscountAmount,
    actualPaidAmount: order.actualPaidAmount,
    refundedAmount: order.refundedAmount,
    companionBaseIncome: order.companionBaseIncome,
    clubNetIncome: order.clubNetIncome,
  };
}

/**
 * **决策表单的实时预览**（P0-13 验收整改 D · P0-15 收敛）。
 *
 * 管理员每敲一个字符就调用一次，因此它必须是**纯函数**：不读仓储、不取时间、不发请求。
 *
 * ## 为什么这不是「客户端做金额算术」
 *
 * 它做的**唯一**一件事是：把服务端写入路径上**同一个**函数
 * （`computeRefundDecisionAmounts`）用**同一组入参**再跑一遍。
 * 公式一行都没有重写，取整方向也没有重写。
 * 若哪天公式改了，界面上的预计金额会**自动**跟着改——这正是「只有一份规则」的含义。
 *
 * 反过来，若在这里照抄一遍公式（哪怕逐字抄），两处迟早会漂移，
 * 而这种漂移的表现是「界面显示退 ¥25、账上退 ¥24.99」，且**只有提交之后**才看得见。
 *
 * ⚠️ **P0-15 去掉了中间那一层 `resolveFinalDecisionAmounts`**：
 * 那层做的是「已提现的收益不冲回」（D17），而 D17 的问题已被取消
 * （普通退款下收益不可能已提现）。今天预览与服务端**逐步同构**——
 * 校验 → 一个公式函数 → 一道金额闸，没有分叉。
 *
 * ## 它与服务端唯一的差别
 *
 * 服务端的入参取自**写入时刻**的存储（`order.refundedAmount`），
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
}): RefundDecisionPreview {
  const checked = readAdminRefundDecisionInput({
    refundRatePercent: input.refundRatePercent,
  });
  if (!checked.ok) return { ok: false, message: checked.message };

  const { orderMoney } = input;
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: orderMoney.actualPaidAmount,
    companionBaseIncome: orderMoney.companionBaseIncome,
    input: checked.input,
  });

  // 服务端的金额闸**不在这里复制判断条件**：用它自己的返回值问同一个问题
  const gateMessage = assertRefundAmountWithinPaid({
    refundAmount: amounts.refundAmount,
    alreadyRefundedAmount: orderMoney.refundedAmount,
    actualPaidAmount: orderMoney.actualPaidAmount,
  });

  return { ok: true, amounts, gateMessage };
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

/**
 * 一次「审核结果」写入之后的退款申请**长什么样**（**纯函数**）。
 *
 * ⚠️ PROD-1C 从 `mockRefundRepository.ts` 的 `applyRefundReview` 里抽出来，
 * **八条字段规则一个字没改**。抽出来的理由是那份实现现在有两个调用方：
 * Mock 伪事务（`adminRefundTransaction.ts`）与 PostgreSQL 事务
 * （`lib/data/pg/adminAuditTransactions.ts` 的 T14 / T15）。
 * 让 Pg 侧另写一份 `UPDATE … SET` 就等于把「开始审核不写审核人」「拒绝不写决策」
 * 这类规则放在两处各自演化——而它们出错的方式是**静默的**：
 * 多写一个字段不会报错，只会让一条审核记录说谎。
 *
 * 三条要点（原实现里的注释，逐条保留）：
 * - **只有 `start-review` 写 `reviewingAt`**。`pending → approved` 是合法迁移，
 *   那条路径上平台没有单独走「开始审核」，**不替它补一个时间**——
 *   补了会让进度时间轴凭空多出一个没人做过的节点；
 * - **只有出了结果（`approved` / `rejected`）才写审核人、审核时间与审核意见**；
 * - `decision` **只在 `approved` 时写入**，其余两个目标状态保持原值
 *   （拒绝一条申请不该抹掉它的历史决策；而实际上被拒的申请从来没有决策，
 *   因此保持原值就是保持 `null`）。
 *
 * ⚠️ `refund` 必须是**当前存储里那一份**（Pg 侧即取行锁之后读到的那一行），
 * 否则「保持原值」会保持成一个陈旧的快照。
 */
export function resolveRefundReview(
  refund: RefundRequest,
  to: Extract<RefundStatus, "reviewing" | "approved" | "rejected">,
  input: {
    at: string;
    reviewNote: string;
    actorId: string;
    actorRole: ActorRole;
    actorName: string | null;
    /** 这一次退款的资金决策。只有 `to === "approved"` 时才会被写入。 */
    decision?: RefundDecision | null;
  },
): RefundRequest {
  const settled = to === "approved" || to === "rejected";
  const approved = to === "approved";

  return {
    ...refund,
    status: to,
    updatedAt: input.at,
    decision: approved ? (input.decision ?? null) : refund.decision,
    // 只有「开始审核」这一步写 reviewingAt
    reviewingAt: to === "reviewing" ? input.at : refund.reviewingAt,
    // 只有出了结果才写审核人与审核时间；开始审核只更新「审核中」这一格
    reviewedAt: settled ? input.at : refund.reviewedAt,
    reviewedBy: settled ? input.actorId : refund.reviewedBy,
    reviewedByRole: settled ? input.actorRole : refund.reviewedByRole,
    reviewedByName: settled ? input.actorName : refund.reviewedByName,
    reviewNote: settled ? input.reviewNote : refund.reviewNote,
  };
}
