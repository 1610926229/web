import type { SupportEvidence } from "./evidence";
import type { OrderStatus } from "./order";
import type { StaffUserSummary } from "./staff";

/**
 * 完成材料（CompletionSubmission）类型与对外 DTO（P0-8）。
 *
 * 完成材料是「打手宣布护航完成」这件事的记录：打手在 `serving` 的本人订单上提交
 * 截图与 5～50 字说明，客服人工通过 / 驳回，或到点由 System 自动通过。
 * 通过是订单从 `serving → completed` 的**唯一**入口。
 *
 * ⚠️ 与退款 / 投诉同理：完成材料与订单状态是**两条独立的线**。pending 期间订单
 * 仍是 `serving`（派生展示阶段 `completion_review` 由「serving + pending」拼出，
 * **不**进 `OrderStatus`）；只有通过才把订单推进到 `completed`。
 */

/**
 * 完成材料状态。
 *
 * `invalidated`（已失效）在 P0-8 只是 §T1 的枚举占位、**零写入路径**；
 * P0-11 起它有了**唯一一个**写入路径——当前履约被打手之外的力量解除时
 * （封禁回池 / 客服换人），该打手那份 pending 材料立即作废，防止回池后
 * 被自动通过（`特殊情况与异常处理表.md` EX-COMP-02）。
 */
export type CompletionSubmissionStatus = "pending" | "approved" | "rejected" | "invalidated";

/**
 * 审核来源。`null` 表示「还没有出审核结果」。
 *
 * ⚠️ 只有两个非空取值：客服人工审核记 `staff`，到期自动通过记 `system`。
 * 两者是**同一种业务事实**（BF-19A 明文），区别只在谁来写结论——
 * 自动通过**绝不伪装成 staff**，因此 `reviewSource = "system"` 时
 * `reviewedByStaffId` / `reviewedByName` 必须为 null。
 */
export type CompletionSubmissionReviewSource = "staff" | "system" | null;

/**
 * 完成材料（仓储内部类型）。
 *
 * ⚠️ 每一次提交都是**新建一条**记录：rejected 后重新提交不覆盖旧审核历史
 * （旧记录原样保留），approved 后也不得再提交改变 completed 事实。
 *
 * ⚠️ `autoApprovalMinutesSnapshot` / `autoApprovalDeadlineAt` 在**创建那一刻**冻结：
 * 之后改平台配置不影响这条在途的 pending；重新提交 = 新建记录，自然重新读配置。
 */
export type CompletionSubmission = {
  /** `cs_${crypto.randomUUID()}`，由服务端生成 */
  id: string;
  orderId: string;
  /** 提交者 = 订单当时的实际履约打手。**只来自 `requireCompanion()` 会话**，不来自请求体 */
  companionId: string;
  /** 完成说明：5～50 字（`countCharacters`） */
  summary: string;
  /** 截图 / 证明材料。复用售后凭证约定，`id` / `url` 由服务端生成 */
  evidence: SupportEvidence[];
  status: CompletionSubmissionStatus;
  submittedAt: string;
  /** 提交那一刻的平台自动审核等待时长快照（分钟） */
  autoApprovalMinutesSnapshot: number;
  /** `submittedAt + autoApprovalMinutesSnapshot`。到点且无阻塞时由 System 自动通过 */
  autoApprovalDeadlineAt: string;
  /** 还没出审核结果时为 null */
  reviewSource: CompletionSubmissionReviewSource;
  /** 人工审核通过 / 驳回时写；System 自动通过时**必须为 null**（§T1 明文） */
  reviewedByStaffId: string | null;
  /** 同上：审核人显示名快照 */
  reviewedByName: string | null;
  /** 出审核结果的时间；还没出结果时为 null */
  reviewedAt: string | null;
  /** 驳回原因；pending / approved / invalidated 时为 null，rejected 时必填 */
  rejectReason: string | null;
  /**
   * pending 被作废的时间；非 `invalidated` 时为 null。
   *
   * ⚠️ P0-11 起**有写入路径**了（封禁回池 / 客服换人时该打手那份 pending 立即作废，
   * 见 `COMPLETION_TRANSITIONS` 与 `applyCompletionInvalidation`），
   * 不再是「恒为 null」的占位字段。
   */
  invalidatedAt: string | null;
};

/**
 * 打手订单详情上的完成材料摘要（P0-8）。
 *
 * 只够页面渲染「提交入口 / 完成审核中 / 驳回原因」三态：
 * - `status === null`：这一单还没提交过；
 * - `canSubmit`：**服务端算好**，页面不自己用订单状态推断；
 * - `autoApprovalDeadlineAt` / `rejectReason` 只在对应状态下有值，其余为 null。
 */
export type CompanionCompletionInfo = {
  /** 这一单**最近一次**提交的状态；从未提交过为 null */
  status: CompletionSubmissionStatus | null;
  /** 此刻能否提交（serving + 无 pending + 最近一次不是 approved）。服务端算好 */
  canSubmit: boolean;
  /** pending 时的自动审核截止时间；非 pending 为 null */
  autoApprovalDeadlineAt: string | null;
  /** 最近一次被驳回的原因；非 rejected 为 null */
  rejectReason: string | null;
};

/**
 * 打手提交完成材料的结果（事务层 → 服务层 → 接口）。
 *
 * ⚠️ **没有幂等键**：这个动作每次都是新建一条记录，幂等判据是「同一订单最多一份
 * pending」的索引（见 `completionTransaction.ts`）。成功分支的 `status` 是字面量
 * `"pending"`——**本次操作把这条记录置成的状态**，不是订单现状。
 */
export type CompanionCompletionSubmitOutcome =
  | {
      kind: "ok";
      submissionId: string;
      orderId: string;
      status: "pending";
      /** 本次冻结的自动审核截止时间 */
      autoApprovalDeadlineAt: string;
      changed: true;
    }
  | { kind: "not-found" }
  | { kind: "not-serving"; status: OrderStatus }
  | { kind: "pending-exists" };

/**
 * 客服「通过」的结果（事务层）。
 *
 * ⚠️ **没有幂等键、没有 operationId**：幂等判据是**状态本身**——submission 已经是
 * `approved` 就是重放（返回第一次的结论，不刷新任何时间）。审核人三个字段直接写在
 * submission 上（reviewedByStaffId / reviewedByName / reviewedAt），那本身就是审计踪迹。
 */
export type StaffCompletionApproveOutcome =
  | { kind: "ok"; submission: CompletionSubmission; changed: true }
  | { kind: "replayed"; submission: CompletionSubmission; changed: false }
  | { kind: "not-found" }
  | { kind: "invalid-status"; status: CompletionSubmissionStatus }
  /** 提交记录挂着的订单不见了（存储被写坏，报 500 而不是 404） */
  | { kind: "order-missing" }
  | { kind: "order-not-serving"; status: OrderStatus }
  /** 提交记录的打手与订单当前实际履约打手不一致（换人后旧材料失效，防御分支） */
  | { kind: "stale-submission" };

/**
 * 客服「驳回」的结果（事务层）。
 *
 * 与通过同一套幂等口径：已经是 `rejected` 就是重放（**不覆盖**第一次的驳回原因）。
 * 驳回**不动订单**——订单继续 `serving`，打手可重新提交并重新计时。
 */
export type StaffCompletionRejectOutcome =
  | { kind: "ok"; submission: CompletionSubmission; changed: true }
  | { kind: "replayed"; submission: CompletionSubmission; changed: false }
  | { kind: "not-found" }
  | { kind: "invalid-status"; status: CompletionSubmissionStatus };

/**
 * 客服工作台「完成材料审核」列表项。
 *
 * ⚠️ **刻意不含**凭证与审核信息：列表一次返回多条，凭证只在详情页展示；
 * 审核人 / 驳回原因属于结果，去详情页看。完成说明只有 5～50 字，进列表用于分诊。
 */
export type StaffCompletionListItem = {
  id: string;
  status: CompletionSubmissionStatus;
  statusLabel: string;
  orderId: string;
  orderNo: string;
  productTitle: string;
  /** 打手展示名。来自订单的陪伴快照，查不到时回落到 companionId，**不许留空串** */
  companionName: string;
  /**
   * 下单用户摘要（P0-8）。
   *
   * ⚠️ 字段表**照抄 `StaffUserSummary`**（id / nickname / avatarUrl），没有手机号、
   * 支付信息或任何凭据。用户记录查不到时昵称 / 头像为空串（服务层占位）。
   * 进列表是因为列表关键词要能按用户昵称搜，且与客服退款列表同一口径。
   */
  user: StaffUserSummary;
  summary: string;
  submittedAt: string;
  autoApprovalDeadlineAt: string;
};

/** 客服可执行的完成材料动作。pending 两项都可点，终态两项都是 false。 */
export type StaffCompletionAllowedActions = {
  canApprove: boolean;
  canReject: boolean;
};

/**
 * 客服工作台「完成材料审核」详情。
 *
 * 在列表项之上补齐凭证、审核信息与订单现状。`allowedActions` 由服务端算好，
 * 前端只按值渲染，不自己用状态推断。
 */
export type StaffCompletionDetail = StaffCompletionListItem & {
  evidence: SupportEvidence[];
  autoApprovalMinutesSnapshot: number;
  reviewSource: CompletionSubmissionReviewSource;
  reviewedByStaffId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  /** 通过会把订单改成 completed，驳回保持 serving；给详情页展示订单现状 */
  orderStatus: OrderStatus;
  orderStatusLabel: string;
  allowedActions: StaffCompletionAllowedActions;
  /**
   * 这份 pending 材料为什么还没被自动通过（EX-COMPLETE-05 的阻塞规则在客服界面的落点）。
   *
   * - 为 null：无阻塞（还没到点，或已出审核结果——auto approval 只对 pending 有意义）；
   * - 非 null：一句客服读得懂的中文，且**必须区分**「有进行中退款」与「有未完结投诉」
   *   两种——前者让客服去看退款单，后者去看投诉单。
   *
   * ⚠️ 只表达**无阻塞时是否可自动通过**这一件事，不是通用「不能自动通过的原因」枚举：
   * 本轮只有这两种阻塞，文案与映射见 `lib/constants/staffCompletions.ts`。
   */
  autoApprovalBlockedReason: string | null;
};

/**
 * 作废「某订单当前那份 pending 完成材料」的结果（P0-11，**同步**，供释放路径在原子区段内调用）。
 *
 * ⚠️ 它**不是**一个对外动作：没有任何接口暴露它。它的**唯一调用方**是订单释放
 * （封禁回池 / 客服换人）——「当前履约被解除」时，那份还没审完的材料必须先失效，
 * 否则它会在回池后被自动通过，把一张已经换了人的订单判成已完成
 * （`特殊情况与异常处理表.md` EX-COMP-02）。
 *
 * | kind | 含义 | 调用方该怎么做 |
 * |---|---|---|
 * | `invalidated` | 真的作废了一条 | 继续 |
 * | `none` | 这一单**没有** pending 材料 | 继续（不是错误：绝大多数释放都没有 pending） |
 * | `not-pending` | 索引指向的记录状态已经不是 `pending` | **整件事失败**：数据不自洽 |
 * | `missing-record` | 索引悬空（指向一条不存在的记录） | **整件事失败**：同上 |
 *
 * 后两种是**不可能状态**（`applyCompletionReview` 与 `appendCompletionSubmission`
 * 都在同一段同步代码里维护索引），真出现时**宁可整件事失败**：继续释放会留下
 * 一份「状态不是 pending、却还占着 pending 索引」的材料，而那一单已经换了人。
 */
export type CompletionInvalidationOutcome =
  | { kind: "invalidated"; submissionId: string; changed: true }
  | { kind: "none" }
  | { kind: "not-pending"; status: CompletionSubmissionStatus }
  | { kind: "missing-record" };

/** 客服完成材料写操作（通过 / 驳回）的接口返回。 */
export type StaffCompletionWriteResult = {
  submissionId: string;
  status: CompletionSubmissionStatus;
  statusLabel: string;
  /** `true` = 本次真的改了；`false` = 重放（已经是这个状态，什么都没写） */
  changed: boolean;
};

/** 客服完成材料列表接口一次返回的全部数据。 */
export type StaffCompletionListData = {
  items: StaffCompletionListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};
