import type { ActorRole } from "./actor";
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
 * 一次退款的**最终资金决策**（P0-13 建立，**P0-15 收敛**）。
 *
 * ⚠️ 它回答的是「这一次退了多少」，而 `RefundRequest.amount` 回答的是
 * 「申请时这一单实付多少」——两个数在部分退款下**不再相等**，
 * 因此必须分开存、分开给，不能拿一个去顶另一个。
 *
 * ## P0-15：四项字段被删除，不是被改名
 *
 * 产品负责人 2026-09-28 正式裁定「一个订单最多只允许一次退款」，
 * 并废弃责任模型。因此下面四项**连语义一起消失**，本类型不再声明它们：
 *
 * | 删除的字段 | 为什么它不再有意义 |
 * |---|---|
 * | `refundFullRemaining` | 它的存在理由是「多步部分退款会留下 1–99 分尾差，整数百分比表达不了」（P0-14）。**只有一次退款时不存在尾差**：`floor(实付 × n/100)` 一步到位。 |
 * | `responsibility` | 管理员不再选择责任归属（P0-15 §五）。 |
 * | `companionLiabilityRateBp` | 只有 `shared` 才有值，而 `shared` 已被废弃。 |
 * | `platformBorneAmount` | 它回答「本次退款里平台担了多少」，而新口径问的是「平台最终净收入 = 实付 − 退款额」，**是两个不同的问题**，且新问题由订单与退款额就能算出来，不需要存。 |
 *
 * ⚠️ **不是「保留但弃用」而是直接删除**：本仓库没有真库、没有历史持久化数据
 * （`globalThis` 内存存储，重启即清空），唯一的历史载体是种子 fixture，
 * 而它随本批次一并更新。产品裁定允许「迁移成本高时只读兼容」，
 * 这里迁移成本为**零**，因此不做半吊子的兼容层——
 * 留一个永远不会被写入的字段，只会让后来的人以为它还有用。
 *
 * ⚠️ `EarningAdjustment.responsibility` 同批删除，理由相同。
 */
export type RefundDecision = {
  /**
   * 这一次退回用户的比例（**基点**，1..10000）。
   *
   * ⚠️ 管理员输入的**就是这个比例**，不是金额——金额由服务端按
   * `floor(actualPaidAmount × refundRateBp / 10000)` 算。
   *
   * ⚠️ **P0-15 起它不再是 `number | null`**：唯一的另一种意图
   * （「退满剩余」）已被删除，因此**每一次决策都必然带一个比例**。
   * 这个收窄是有意的——`null` 一旦不可能出现，把它留在类型里就是在
   * 邀请调用方写一个永远走不到的分支。
   */
  refundRateBp: number;
  /**
   * 这一次实际退给用户的金额（分）= `floor(actualPaidAmount × refundRateBp / 10000)`。
   *
   * ⚠️ 100% 时它**精确等于** `actualPaidAmount`（`floor(x × 10000 / 10000) === x`），
   * 这正是「全额退款」不需要单独意图的原因。
   */
  refundAmount: number;
  /**
   * 这一次从打手收益冲回的金额（分）。**P0-15 起恒为该单打手收益的整笔**
   * （= `Order.companionBaseIncome` = `Earning.incomeAmount`），
   * **与退款比例无关**：退 10% 也是整笔归零。
   *
   * ⚠️ **它是从订单快照算的，不是从 `Earning` 上读的**——这一点是刻意的：
   * 退款可以在订单还在 `serving` 时就被批准（EX-REFUND-07），那时 `Earning`
   * **根本还不存在**（收益在订单进入 `completed` 时才由 `settleOrderCompletion()`
   * 生成）。若这里读 `Earning.incomeAmount`，serving 期退款会记成 0，
   * 而实际上那笔收益终将被全额冲掉——账上就会少一笔。
   * `Earning.incomeAmount` 本来就**直接搬** `Order.companionBaseIncome`（不重算），
   * 所以拿订单快照是同一个数，而且**任何时候都拿得到**。
   *
   * 因此不变式是：**该订单最终那条 `Earning` 的 `reversedAmount` 必须精确等于本字段**。
   * 哪条路径去写那次冲销（批准时写 / 完成生成收益时补写）不由本字段决定，
   * 见 `lib/data/earningTransaction.ts`。
   */
  companionReversalAmount: number;
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
  /**
   * 单位：分。关联订单**当前的实付金额**（用户端详情页那一行「订单实付」）。
   *
   * ⚠️ P1-4 修正：它原先取自 `order.totalAmount`（**优惠前**应付总额），
   * 接满减券之后那比用户实际付掉的钱大，而它的注释与页面标签一直写着「实付」。
   * 与 `amount`（申请那一刻的实付快照）是两个数：订单实付可能随退款而变，
   * 申请金额冻结在申请那一刻。
   */
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
 *
 * ⚠️ `canApprove` **不止看退款状态**：它还守一道订单状态闸（产品裁定 2026-09-27，
 * `paid` / `accepted` 不允许批准售后申请），被挡下的原因见 `AdminRefundDetail.approveBlockedReason`。
 * 因此 `canApprove === false` 有两种含义，页面**不能**用同一个 `if` 处理
 * 「这笔申请已结束」与「这一单不在审批范围内」——前者走 `ADMIN_REFUND_TERMINAL_NOTICE`，
 * 后者的按钮仍要出现（另外两个动作还可做），旁边配上原因。
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
  /**
   * 该订单**累计**已退金额。
   *
   * ⚠️ **P0-15 起它在正常流程里恒为 0**：一个订单只退一次，而管理端看到这张表时
   * 那唯一一次还没执行。它非 0 只有两种来源——**免审批直接退款**（P0-12，
   * 不产生申请记录，因此没有这张详情页）或 P0-15 之前的历史数据。
   * 保留它是为了如实显示订单自身的历史，**新业务路径不再用它做金额计算**。
   */
  refundedAmount: number;
  /** 订单冻结的打手分账基数收益（护航收益）。**退款批准后整笔冲回的金额** */
  companionBaseIncome: number;
  /** 订单冻结的平台净收入 = 实付 − 打手收益。**允许为负** */
  clubNetIncome: number;
};

/**
 * ⚠️ **P0-15 从 `AdminRefundOrderMoney` 上删掉了三个字段**，理由各不相同：
 *
 * | 删掉的字段 | 原用途 | 为什么不再需要 |
 * |---|---|---|
 * | `remainingRefundableAmount` | 「当前剩余可退款」= 实付 − 已退 | 「剩余」是多步退款模型的概念。一单一退、管理员一次性核定比例之后，**不存在「最多能退多少」这个上限**——填 100% 就是全额退款 |
 * | `reversedSoFarAmount` | 累计已冲回，用于钳制本次冲回额 | 冲回额恒等于 `companionBaseIncome`（整笔），没有可加的对象，也没有需要钳制的累计量 |
 * | `companionEarningStatus` | 让界面把「已提现不冲回」（D17）说准 | **D17 的问题被 P0-15 取消了**：普通退款下收益不可能已经提现（见 `02-decisions.md` Q1），因此没有需要解释的例外 |
 *
 * ⚠️ 三个字段**一起删**不是「顺手清理」：留着它们会让界面继续渲染
 * 「剩余可退 ¥X」「已冲回 ¥Y」这些**新规则下没有对应事实**的数字，
 * 而管理员会照着这些数字做决定。
 *
 * ⚠️ 随之去掉的还有 `EarningStatus` 这个 import：`AdminRefundOrderMoney`
 * 是它在本文件里**唯一**的使用者，没有别的字段需要它。
 */

export type AdminRefundDetail = AdminRefundListItem & {
  /**
   * 这一笔退款所对应订单的金额快照（口径见 `AdminRefundOrderMoney`）。
   *
   * 与 `amount` / `decidedAmount` 的关系：那两个是**这笔退款申请**的金额，
   * 这一组是**整张订单**的金额。界面要同时回答「这次退多少」与
   * 「这一单本来多少钱、打手收益是多少」，两组缺一不可。
   * ⚠️ P0-15 删掉「还能退多少」——一单一退，不存在第二次，见类型上的那张表。
   */
  orderMoney: AdminRefundOrderMoney;
  /**
   * 这一次退款的完整资金决策；还没决策时为 `null`。
   *
   * ⚠️ 三项字段（比例 / 退款额 / 打手冲回额）**只有管理端看得到**：
   * 客服与用户只知道自己退了多少（`decidedAmount`）。
   * ⚠️ P0-15 之前这里写的是「责任归属与平台承担额**只有管理端看得到**」，
   * 那两项已随责任模型删除；前一句的**可见性边界本身没变**。
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
  /**
   * 订单状态挡住「通过」时的原因；没被挡时为 `null`。
   *
   * 产品裁定 2026-09-27：`paid` / `accepted` 的订单不允许批准售后退款申请，
   * 只有 `serving` / `completed` 能进这条资金链。这类**存量**申请仍然存在
   * （P0-12 之前开出来的），也仍然可以被**驳回**——只是不能批。
   *
   * ⚠️ 它与写侧 400 的 `message` 是**同一句话**（同一个函数算出来的），
   * 因此不存在「界面说 A、接口说 B」的可能。
   *
   * ⚠️ **只在「申请本身还没结束」时才有值**：终态（已通过 / 已拒绝 / 已撤销）的申请
   * 一律是 `null`——那种情况下 `canApprove === false` 的原因**是申请已结束**，
   * 而不是订单档位。把两个原因混成一句话会把管理员引到错的地方去查。
   */
  approveBlockedReason: string | null;
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
   * ⚠️ 客服看得到**结果金额**，看不到退款比例与打手冲回额——那两项属于
   * 管理员的决策依据（产品裁定：客服只能调查、记录、提出意见）。
   * 在列表上就给，是因为 P0-13 之后「申请金额」不再等于「实退金额」：
   * 只显示前者的表格会把一笔已决策的部分退款显示成它实际不是的样子。
   * ⚠️ P0-15 之前这条注释举的例子是「责任归属与平台承担额」，
   * 那两项已删；可见性边界本身没变，仍是「只给结果，不给决策依据」。
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
