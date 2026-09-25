import type { ActorRole } from "./actor";
import type { EarningStatus } from "./earning";
import type { SupportEvidence } from "./evidence";
import type { OrderStatus } from "./order";
import type { StaffCompanionReleaseEntry, StaffUserSummary } from "./staff";
import type { AdminUserSummary } from "./user";

/**
 * 退款申请类型与对外 DTO。
 *
 * **退款申请与订单状态是两条独立的线**，这是本阶段最容易搞错的一点：
 * - 提交申请**不会**把订单改成 `refunded`，订单继续保留原业务状态（已付款 / 已接单 / 护航中），
 *   只是在页面上同时显示「退款审核中」；
 * - 只有将来客服或管理者审核通过后，订单才进入 `refunded`（当前阶段没有这个入口，
 *   用户端不能自行批准或拒绝）——**P0-13 起改为「累计退满才进入」**：
 *   管理员只输入退款比例、金额由服务端按 `业务流程表.md` §17 的冻结公式算，
 *   部分退款**不改变订单状态**（`architecture-rules.md:191`）。
 *
 * 因此「订单状态」回答的是「这一单现在进行到哪一步」，「退款状态」回答的是
 * 「退款这件事现在进行到哪一步」，两者不能互相推导，只能各自存储、各自展示。
 *
 * 金额一律是「分」为单位的整数，且由服务端按订单可退金额写入——用户不能自行填写或修改。
 */

export type RefundStatus = "pending" | "reviewing" | "approved" | "rejected" | "cancelled";

/** 退款原因类型。取值由服务端校验，文案与浏览器共用 `lib/constants/refunds.ts`。 */
export type RefundReasonKey =
  | "service_not_delivered"
  | "service_quality"
  | "schedule_conflict"
  | "duplicate_payment"
  | "other";

/**
 * 退款的**资金责任**归属（P0-13，产品负责人 2026-09-25 裁定）。
 *
 * 由**管理员**在最终退款决策时认定；客服只能调查、记录、提出意见。
 * 它决定打手要冲回多少：`platform` 不冲回，`companion` / `shared` 按
 * `业务流程表.md` §17 的冻结公式冲回。
 */
export type RefundResponsibility = "platform" | "companion" | "shared";

/**
 * 一次退款的**最终资金决策**（P0-13）。
 *
 * ⚠️ 它回答的是「这一次退了多少、这笔钱谁承担」，而 `RefundRequest.amount`
 * 回答的是「申请时这一单实付多少」——两个数在部分退款下**不再相等**，
 * 因此必须分开存、分开给，不能拿一个去顶另一个。
 *
 * 六项字段对应产品裁定「Refund 最终决策至少应能表达」的清单
 * （`P0-13/02-decisions.md` §十 D-Q1 ③），另加决策人与时刻用于可审计。
 */
export type RefundDecision = {
  /**
   * 这一次退回用户的比例（**基点**，1..10000）。
   * ⚠️ 管理员输入的**就是这个比例**，不是金额——金额由服务端按 §17 算
   * （「管理员只输入退款比例，金额由系统计算」）。
   */
  refundRateBp: number;
  /** 这一次实际退给用户的金额（分）= `floor(actualPaidAmount × refundRateBp / 10000)` */
  refundAmount: number;
  responsibility: RefundResponsibility;
  /** 打手责任比例（基点，0..10000）。**只有 `shared` 时有值**，其余两种为 null */
  companionLiabilityRateBp: number | null;
  /**
   * 这一次从打手收益冲回的金额（分）。
   * `platform` 恒为 0；其余两种按 §17 公式算，并**钳制**在「该单剩余可冲回额」以内
   * （产品裁定要求 `0 <= 累计冲回 <= incomeAmount` 必须成立，见 `P0-13/02-decisions.md` §十一 D4）。
   */
  companionReversalAmount: number;
  /**
   * 这一次由**平台**承担的部分（分）= `refundAmount − companionReversalAmount`。
   * ⚠️ **允许为负**（§17 原文「允许 `clubIncomeAdjustment < 0`」）：
   * 打手按**原价**分账（§18），券由平台承担，因此冲回额可能大于实际退给用户的钱。
   */
  platformBorneAmount: number;
  /** 做出决策的管理员账号 id（`AdminAccount.id`） */
  decidedBy: string;
  decidedAt: string;
};

/** 退款申请（仓储内部类型）。页面与接口一律使用下面的 DTO。 */
export type RefundRequest = {
  id: string;
  /** 展示用退款单号 */
  refundNo: string;
  userId: string;
  orderId: string;
  status: RefundStatus;
  /**
   * 单位：分。**申请创建时这一单的实付快照**——它回答「这一单本来涉及多少钱」，
   * **不回答**「最后退了多少」。后者看下面的 `decision.refundAmount`。
   */
  amount: number;
  /**
   * 这一次退款的最终资金决策（P0-13）。
   *
   * ⚠️ 未决策时为 `null`——**不是零值决策**。零值决策是「退 0 元」，
   * 与「还没人决定」是两件事，页面上的「待决策」与「已决策且平台全担」
   * 必须能区分开，因此不用 `{ refundAmount: 0 }` 之类去顶空。
   */
  decision: RefundDecision | null;

  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  createdAt: string;
  updatedAt: string;
  /** 客服开始审核的时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未审核完成时为 null */
  reviewedAt: string | null;
  /**
   * 做出审核结果（通过 / 拒绝）的账号 id。
   *
   * ⚠️ **只记结果，不记开始审核**：`start-review` 只是把状态改成审核中，
   * 还没有任何结论，「谁开始看的」由审计记录回答（审计每条都有 `actorId`）。
   * 这里的字段回答的是另一个问题——「这笔退款是谁批的」，它要跟着业务记录长期存在。
   *
   * ⚠️ 这个 id 可能是 `AdminAccount.id`（管理员批的），也可能是 `StaffAccount.id`
   * （客服驳回的）——**必须连 `reviewedByRole` 一起读**才知道该去哪张表查。
   * 单独存一个字符串是 P8C 的做法，那时只有管理员会写它；P8D-2 起不再成立。
   */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；还没出结果时为 null */
  reviewedByRole: ActorRole | null;
  /**
   * 出结果时那个账号的显示名快照；还没出结果时为 null（管理员写入时也是 null）。
   *
   * ⚠️ 记快照而不是渲染时现查，理由与消息的 `senderName` 完全一致：
   * 客服账号被停用或软删除之后，这条退款记录仍然显示得出当时是谁批的。
   */
  reviewedByName: string | null;
  /** 处理结果说明；用户新提交的申请为空，拒绝时必填 */
  reviewNote: string;
  cancelledAt: string | null;
};

/**
 * 订单详情里的退款摘要。
 *
 * **刻意不含**退款原因、说明、凭证与处理结果：订单详情只需要知道「有没有退款、到哪一步了」，
 * 完整内容要去退款详情页看（那里会再校验一次归属）。
 */
export type RefundSummary = {
  id: string;
  status: RefundStatus;
  /** 单位：分 */
  amount: number;
  createdAt: string;
};

/** 退款进度节点：只包含**已经发生**的节点。 */
export type RefundTimelineEntry = {
  key: RefundStatus;
  label: string;
  at: string;
  note: string;
};

/**
 * 退款申请详情 DTO：在摘要之上补齐详情页所需字段，并带上关联订单快照。
 *
 * 关联订单信息取自订单自己的快照（商品名、规格、实付金额），
 * 因此商品改名下架不影响历史退款记录的展示。
 */
export type RefundDetail = RefundSummary & {
  refundNo: string;
  orderId: string;
  orderNo: string;
  /** 订单当前的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: string;
  orderStatusLabel: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  orderTotalAmount: number;

  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  /**
   * 管理员最终决定**退给这位用户**的金额（分）；还没决策时为 `null`。
   *
   * ⚠️ **不是 `amount`**：`amount` 是申请时的订单实付快照，部分退款下两者不相等。
   * 页面上「这一单本来多少钱」与「这次退了多少」是两句话，不能拿一个数答两问。
   */
  decidedAmount: number | null;

  updatedAt: string;
  reviewedAt: string | null;
  reviewNote: string;
  cancelledAt: string | null;

  timeline: RefundTimelineEntry[];

  /** 服务端给出的可执行动作，前端不自行根据状态推断权限。 */
  allowedActions: {
    /** 只有待审核（pending）可以由用户撤销 */
    canCancelRefund: boolean;
  };
};

/* ───────────────────────── 管理端退款 DTO（P8C） ───────────────────────── */

/**
 * 管理端退款列表项。
 *
 * 带上订单侧的两样摘要（订单号、订单当前业务状态、商品标题），因为客服审核时
 * 第一眼要看到的就是「这一单是什么、现在走到哪了」。
 *
 * **不含**退款原因、说明、凭证与审核意见：那些内容只在详情页展示，
 * 列表一次返回多条，没有必要把它们一起带出去。
 */
export type AdminRefundListItem = {
  id: string;
  refundNo: string;
  status: RefundStatus;
  statusLabel: string;
  /** 单位：分。**申请创建时的订单实付快照**，不是最终退款额 */
  amount: number;
  /**
   * 管理员最终决定退给用户的金额（分）；还没决策时为 `null`。
   * 列表里给这一列，是为了让管理员一眼看出「这条是部分退款还是全额」。
   */
  decidedAmount: number | null;
  createdAt: string;
  updatedAt: string;
  user: AdminUserSummary;
  orderId: string;
  orderNo: string;
  /** 订单**当前**的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  productTitle: string;
};

/**
 * 服务端判定的可执行动作。
 *
 * 三个动作全部从 `ADMIN_REFUND_TRANSITIONS` 推导（见 `lib/constants/adminRefunds.ts`），
 * 页面不拿状态自己写 `if`：终态（已通过 / 已拒绝 / 已撤销）三项都是 false。
 */
export type AdminRefundAllowedActions = {
  canStartReview: boolean;
  canApprove: boolean;
  canReject: boolean;
};

/**
 * 管理端退款详情：补齐原因、说明、凭证、审核信息、进度时间轴与可执行动作。
 *
 * ⚠️ 它同时带着 `decidedAmount`（继承自列表项）与 `decision`，
 * 看起来像同一个数字存了两份。这里刻意**不用 `Omit` 摘掉前者**，理由是
 * `Omit` 只改类型不改运行时——`{...toAdminRefundListItem(...)}` 里的
 * `decidedAmount` 仍然会出现在响应体里，于是类型说「没有」、实际「有」。
 * 与其造一处类型与运行时的不一致，不如两个字段都留着，并让它们在**同一处**、
 * 从**同一个来源**（`refund.decision`）派生：`decidedAmount` 是头部那一个数，
 * `decision` 是它的完整拆解。列表读前者，详情页两者都读。
 */
/**
 * 管理端退款详情上的**订单金额快照**（P0-13 验收整改 A–E）。
 *
 * ## 为什么必须加上这一组字段
 *
 * 退款比例的基数是**订单实付金额**，而「实付是多少、已经退了多少、还能退多少」
 * 原来一个都不在详情 DTO 上。管理员因此只能看到一个孤零零的「退款比例（%）」
 * 输入框：他不知道这 30% 是谁的 30%、也不知道这一单一共还能退多少钱——
 * 而这些答案全都在服务端已有的数据里，只是没被送到界面上。
 *
 * ## 口径（**照抄订单上的冻结快照，一个都不重算**）
 *
 * 全部字段都是**下单那一刻冻结在订单上的值**，读取时**不得**用今天的商品价格
 * 或今天的分账比例重算（`architecture-rules.md` §三 第 4 条：改配置不追溯）。
 * 订单字段的完整语义见 `lib/types/order.ts` 与 `lib/constants/orderAmount.ts`。
 *
 * ⚠️ **只给管理端**（D13 的延伸）：平台净收入与打手分账收益是平台自己的账，
 * 客服端与用户端的 DTO 上**一个字段都没有**，将来加字段时也不许加。
 */
export type AdminRefundOrderMoney = {
  /** 订单原价 = 商品金额 + 增值服务金额（**优惠前**）。不是退款比例的基数 */
  originalAmount: number;
  /** 优惠券抵扣。本轮恒为 0（没有券），字段留着是因为实付的定义里有它 */
  couponDiscountAmount: number;
  /** 用户实际支付金额 = 原价 − 券。**退款比例与退款金额的基数** */
  actualPaidAmount: number;
  /** 该订单**累计**已退金额（本单之前的每一次批准累加，不是本次） */
  refundedAmount: number;
  /**
   * 当前还能再退多少 = `actualPaidAmount − refundedAmount`。
   *
   * ⚠️ 刻意**不加 `Math.max(0, …)`**：`refundedAmount <= actualPaidAmount`
   * 是由金额闸（`assertRefundAmountWithinPaid`）保证的不变式。若它真的变成负数，
   * 那是数据出了问题，界面上显示一个负数比显示 0 更有用——后者会把它藏起来。
   */
  remainingRefundableAmount: number;
  /** 订单冻结的打手分账基数收益（护航收益）。`shared` / `companion` 的冲回基数 */
  companionBaseIncome: number;
  /** 订单冻结的平台净收入 = 实付 − 打手收益。**允许为负** */
  clubNetIncome: number;
  /** 该订单此前**已批准**退款累计冲回的打手收益。只为钳制服务，见 `sumApprovedCompanionReversal` */
  reversedSoFarAmount: number;
  /**
   * 该订单打手收益的当前状态；**没有收益**时为 `null`
   * （`serving` 订单退款时收益尚未结算，D9）。
   *
   * ⚠️ 界面需要它才能把「本次预计冲回」说准：D17 规定
   * **已提现（`withdrawn`）的收益本轮不冲回**，那一笔由平台全额承担。
   * 少了这个字段，界面会对一笔已经提现的收益显示「预计冲回 ¥X」，
   * 而服务端实际写下去的是 0——这正是本次整改要消灭的那类歧义。
   */
  companionEarningStatus: EarningStatus | null;
};

export type AdminRefundDetail = AdminRefundListItem & {
  /**
   * 这一笔退款所对应订单的金额快照（口径见 `AdminRefundOrderMoney`）。
   *
   * 与 `amount` / `decidedAmount` 的关系：那两个是**这笔退款申请**的金额，
   * 这一组是**整张订单**的金额。界面要同时回答「这次退多少」与
   * 「这一单本来多少钱、已经退了多少、还能退多少」，两组缺一不可。
   */
  orderMoney: AdminRefundOrderMoney;
  /**
   * 这一次退款的完整资金决策；还没决策时为 `null`。
   *
   * ⚠️ 六项字段里**只有管理端看得到**责任归属与平台承担额
   * （产品裁定：责任认定权属于管理员；客服与用户只知道自己退了多少）。
   */
  decision: RefundDecision | null;
  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];
  /** 开始审核时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未完成时为 null */
  reviewedAt: string | null;
  /** 做出审核结果的账号 id；未审核完成时为 null。可能是管理员，也可能是客服 */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；未审核完成时为 null */
  reviewedByRole: ActorRole | null;
  /** 审核人显示名快照；未审核完成或由管理员写入时为 null */
  reviewedByName: string | null;
  reviewNote: string;
  cancelledAt: string | null;
  timeline: RefundTimelineEntry[];
  allowedActions: AdminRefundAllowedActions;
};

/**
 * 一次审核动作的结果。
 *
 * 带上**订单的新状态**：审核通过会改动订单（累计退款额，退满时还包括状态），
 * 页面据此刷新过滤栏与详情，不需要再猜「订单动了没有」。`orderChanged` 如实说明
 * 这一次是否真的动了订单——只有通过会动，开始审核与被拒绝都不会。
 */
export type AdminRefundWriteResult = {
  refundId: string;
  status: RefundStatus;
  statusLabel: string;
  orderId: string;
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  reviewedAt: string | null;
  /**
   * 这一次实际退给用户的金额（分）；未决策（开始审核 / 拒绝）时为 `null`。
   *
   * ⚠️ **必须在响应里带回来**，而且**即使确认框已经会显示预计金额也必须带**
   * （P0-13 验收整改 D19 之后仍然成立）：界面上那个数是页面加载时的数据算的**预计值**，
   * 而这里是服务端**真正写下去**的数。两者只有在「页面数据没被别处改动过」时才相等，
   * 因此成功提示里报的必须是这一个。
   *
   * 与退款详情里的 `decidedAmount` 同源（都取 `RefundDecision.refundAmount`）。
   */
  decidedAmount: number | null;
  /** 这一次是否真的改动了退款申请（幂等重放为 false） */
  changed: boolean;
  /** 这一次是否真的改动了订单（只有「通过」会） */
  orderChanged: boolean;
};

/** 管理端退款列表接口一次返回的全部数据。 */
export type AdminRefundListData = {
  items: AdminRefundListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};

/* ───────────────────────── 客服端退款 DTO（P8D-2） ───────────────────────── */

/**
 * 客服端的退款列表项。
 *
 * ⚠️ **与 `AdminRefundListItem` 同形，但刻意是两个类型**。
 * 共用一份类型的话，「管理端给列表加一个字段」与「这个字段该不该给客服看」
 * 会变成同一个改动——而它们本该是两次判断。字段表分开之后，
 * 管理端加字段不会顺带进客服响应，客服端要加字段也得在这里显式写一行。
 *
 * ⚠️ 「同形」是**当下的事实**而不是承诺：这里列出的每一项都是客服处理退款
 * 确实要用的（单号用来核对、状态用来筛选、金额与订单摘要用来判断、用户摘要用来对话）。
 * 管理端列表里将来出现的「内部备注」「审核人分布」这类字段不会自动跟过来。
 */
export type StaffRefundListItem = {
  id: string;
  refundNo: string;
  status: RefundStatus;
  statusLabel: string;
  /** 单位：分。**申请创建时的订单实付快照**，不是最终退款额。**只读**，客服没有修改入口 */
  amount: number;
  /**
   * 管理员最终决定退给用户的金额（分）；还没决策时为 `null`。
   *
   * ⚠️ 客服看得到**结果金额**，看不到责任归属与平台承担额——那两项是
   * 管理员的决策依据（产品裁定：客服只能调查、记录、提出意见）。
   * 在列表上就给，是因为 P0-13 之后「申请金额」不再等于「实退金额」：
   * 只显示前者的表格会把一笔已决策的部分退款显示成它实际不是的样子。
   */
  decidedAmount: number | null;
  createdAt: string;
  updatedAt: string;
  user: StaffUserSummary;
  orderId: string;
  orderNo: string;
  /** 订单**当前**的业务状态——退款审核期间它不会变成 refunded */
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  productTitle: string;
};

/**
 * 客服可执行的退款动作。**只有两个，而且这是刻意的。**
 *
 * | 动作 | 状态迁移 | 客服 | 为什么 |
 * | --- | --- | --- | --- |
 * | 开始审核 | `pending → reviewing` | ✅ | 只是认领，不改订单、不动钱 |
 * | 驳回 | `pending \| reviewing → rejected` | ✅ | 只写退款记录，订单按原进度继续 |
 * | **通过** | `pending \| reviewing → approved` | ❌ | **会在同一次写入里把订单改成「已退款」** |
 *
 * ⚠️ 「通过」是**唯一会改动订单、也是唯一代表平台承诺退钱**的动作，
 * 因此它留在管理员侧（§五：涉及真实资金最终划拨的动作不擅自赋权给客服）。
 * 客服处理完一笔申请后如果结论是「应该退」，正确的做法是把它留在审核中并上报，
 * 而不是替平台把钱批出去——本阶段没有真实退款通道，但状态机上的边界要先立住。
 *
 * ⚠️ 这里**没有** `canApprove: false` 这种字段：一个恒为 false 的布尔值会被
 * 前端写成「禁用按钮」，而正确做法是这个按钮根本不存在（文案由常量层给出）。
 */
export type StaffRefundAllowedActions = {
  canStartReview: boolean;
  canReject: boolean;
};

/**
 * 客服端退款详情。
 *
 * 比列表项多出：退款原因、说明、凭证、金额对照、审核信息、进度时间轴、
 * 服务端判定的可执行动作、**关联会话入口**，以及**履约退出历史**。
 */
export type StaffRefundDetail = StaffRefundListItem & {
  reasonKey: RefundReasonKey;
  reasonLabel: string;
  description: string;
  evidence: SupportEvidence[];

  /**
   * 原订单实付金额（单位：分）。
   *
   * ⚠️ P0-13 起它**不再必然等于** `amount`：退款可以是部分的，`amount` 是申请那一刻
   * 的实付快照，而这里是订单自己当前的实付额。三个数各答一问——
   * 「这一单原来多少钱」（本字段）、「申请时实付多少」（`amount`）、
   * 「最后退了多少」（`decidedAmount`）——客服判断时本来就要看到全部。
   */
  orderTotalAmount: number;

  /** 开始审核时间；待审核时为 null */
  reviewingAt: string | null;
  /** 审核完成时间（通过或拒绝）；未完成时为 null */
  reviewedAt: string | null;
  /** 做出审核结果的账号 id；未审核完成时为 null */
  reviewedBy: string | null;
  /** `reviewedBy` 是哪一类账号；未审核完成时为 null */
  reviewedByRole: ActorRole | null;
  /** 审核人显示名快照；未审核完成或由管理员写入时为 null */
  reviewedByName: string | null;
  reviewNote: string;
  cancelledAt: string | null;
  timeline: RefundTimelineEntry[];

  /**
   * 这笔退款关联订单在工作台里的会话。
   *
   * ⚠️ 有值时它一定是**已经存在的订单 id**（页面据此链到
   * `/staff/conversations/[orderId]`），因此不会因为点进去而凭空建出一个会话。
   * 没有沟通记录时为 null，页面就不给这个入口——而不是给一个点进去 404 的链接。
   */
  conversationOrderId: string | null;

  /**
   * 这笔退款关联订单的履约退出历史（P0-6），按退出时间正序；没有退出过是**空数组**。
   *
   * ⚠️ 它回答的是客服看退款时最先会问的那个问题：「有人在服务前取消过接单吗」。
   * 与 `conversationOrderId` 同一个理由——退款详情有自己的订单区，而「进入会话」
   * 入口在订单没有沟通记录时是 `null`，只挂会话页会让这一类退款漏掉它。
   *
   * ⚠️ 它与钱**无关**：本轮退出不退款、不罚款、不扣减收益，因此这里既不是
   * 退款依据，也不改变任何金额。它只是这一单发生过的事实的只读记录。
   */
  releaseHistory: StaffCompanionReleaseEntry[];

  allowedActions: StaffRefundAllowedActions;
};

/**
 * 一次客服审核动作的结果。
 *
 * ⚠️ 与管理端的 `AdminRefundWriteResult` 分开：那个类型带着 `orderStatus` /
 * `orderChanged` 两个字段，而客服的两个动作**都不会动订单**——把它们抄过来，
 * 只会让客服页面以为自己需要处理「订单变了没有」这件事。
 */
export type StaffRefundWriteResult = {
  refundId: string;
  status: RefundStatus;
  statusLabel: string;
  reviewedAt: string | null;
  /** 这一次是否真的改动了退款申请（幂等重放为 false） */
  changed: boolean;
};

/** 客服端退款列表接口一次返回的全部数据。 */
export type StaffRefundListData = {
  items: StaffRefundListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};
