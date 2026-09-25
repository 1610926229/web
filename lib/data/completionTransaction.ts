import {
  canTransitionCompletion,
  isCompletionAutoApprovalBlocked,
} from "@/lib/constants/completions";
import { plusMinutes } from "@/lib/constants/dispatch";
import { canTransitionOrder } from "@/lib/constants/orders";
import type {
  CompanionCompletionSubmitOutcome,
  CompletionInvalidationOutcome,
  CompletionSubmission,
  CompletionSubmissionStatus,
  StaffCompletionApproveOutcome,
  StaffCompletionRejectOutcome,
} from "@/lib/types/completion";
import type { SupportEvidence } from "@/lib/types/evidence";
import { currentPlatformConfig } from "./adminPlatformConfigTransaction";
import { settleOrderCompletion } from "./earningTransaction";
import {
  appendCompletionSubmission,
  applyCompletionInvalidation,
  applyCompletionReview,
  completionStore,
} from "./mockCompletionRepository";
import { paymentStore } from "./mockPaymentRepository";
import { readOrderBlockingFacts } from "./orderBlocking";

/**
 * 完成材料域的伪事务（P0-8）—— 四个入口：提交、人工通过、人工驳回、到期自动通过。
 *
 * ## 原子性是怎么成立的
 *
 * 与 `lib/data/companionOrderTransaction.ts` / `companionDispatchTransaction.ts` 同一条依据：
 * Node 是单线程的，「读—判断—写」之间只要不让出执行权，别的请求就插不进来。
 * 提交 / 通过 / 驳回三个函数都是 `async` 只为签名与其它伪事务一致，**函数体里没有
 * 一个 `await`**；`sweepCompletionAutoApprovals` 干脆就是同步函数。因此在标注的边界之后
 * 加一个 `await` 就是 bug。
 *
 * ## 为什么不用 `adminWriteSupport` 的 `operationId`
 *
 * 完成材料的审核结果不是管理操作审计：人工通过 / 驳回把审核人三个字段
 * （`reviewedByStaffId` / `reviewedByName` / `reviewedAt`）**直接写在 submission 上**，
 * 那本身就是审计踪迹；System 自动通过是领域事件（BF-19A），**绝不伪装成管理员动作**。
 * 幂等判据因此不是幂等键，而是**状态本身**（与 P0-7 `startCompanionOrder` 同一机制）：
 * submission 已经是目标状态就是重放，返回第一次的结论，一个字节都不写。
 *
 * ## 「先验证意图，再原子写入」的落点
 *
 * 完成说明的 5～50 字、凭证格式、驳回原因非空——这些**参数合法性**在服务层校验
 * （`companionCompletions.ts` / `staffCompletions.ts`）；本文件收到的已经是合法意图，
 * 只回答「这件事此刻在数据上成不成立」，并且把成立的那一次与写入放在同一段同步代码里。
 */

// ——————————————————————————— 作废（P0-11） ———————————————————————————

/**
 * 作废「某订单当前那份 pending 完成材料」的**判定**（只读，`invalidatePendingCompletionForOrder`
 * 与它的只读预检共用，P0-11）。
 *
 * ⚠️ 判定只有这一份。多写一份「这一单的 pending 能不能作废」的规则，
 * 就会在状态表或索引语义变化的那一天与写入侧分叉——一侧放行、一侧报错。
 *
 * `ok` 与 `none` 都是**写入不会失败**的两种情形：前者有一份 pending 要作废，
 * 后者根本没有（绝大多数释放都属于后者）。另外两种是数据不自洽，如实报出来。
 */
function inspectPendingCompletion(orderId: string):
  | { kind: "none" }
  | { kind: "ok"; submissionId: string }
  | { kind: "not-pending"; status: CompletionSubmissionStatus }
  | { kind: "missing-record" } {
  const completions = completionStore();

  /* —— 第 1 步：这一单有没有 pending —— */
  const submissionId = completions.pendingSubmissionIdByOrder.get(orderId);
  if (!submissionId) return { kind: "none" };

  /* —— 第 2 步：索引指向的记录必须还在 —— */
  // 索引在、记录丢：数据已经不自洽。此时**不猜**（既不当作没有 pending，
  // 也不硬写一条不存在的记录），如实报告，由调用方整件事失败
  const submission = completions.submissions.get(submissionId);
  if (!submission) return { kind: "missing-record" };

  /* —— 第 3 步：结构校验（中央状态机）—— */
  if (!canTransitionCompletion(submission.status, "invalidated")) {
    return { kind: "not-pending", status: submission.status };
  }

  /* —— 第 4 步：领域 Guard —— */
  // ⚠️ 与第 3 步并列存在，不是它的重复：能走到这里的状态今天只剩 pending
  // （索引只装 pending，而第 3 步已排除了终态），但这一句才是「这一条此刻
  // 允许被作废吗」的答案。删掉它，将来状态表一变宽，作废的范围就跟着变宽了
  if (submission.status !== "pending") {
    return { kind: "not-pending", status: submission.status };
  }

  return { kind: "ok", submissionId };
}

/**
 * **只读**地问一次：「释放这一单时，作废它的 pending 完成材料会不会失败？」
 *
 * ## 它为什么存在（P0-11 §MINOR-1）
 *
 * `releaseOrdersForCompanion`（封禁回池）写的是「**全量校验 → 全量写**」：
 * 多单在手时，若第 2 单的 pending 索引与记录对不上，第 1 单已经解除完了，
 * 整件事却报 `inconsistent`——管理员看到失败，数据里躺着半截结果。
 * 判定的唯一失败源就是作废，因此把这一步的判定**提前到校验阶段**读一遍。
 *
 * `true` = 这一次作废不可能失败（没有 pending，或有且可作废）。
 * `false` = 数据不自洽，调用方应当**在任何写入之前**整件事失败。
 *
 * ⚠️ 它不是写入前的第二次独立判断：`invalidatePendingCompletionForOrder`
 * 仍然会用同一个 `inspectPendingCompletion` 判一次（预检与写入之间没有 `await`，
 * 因此两次结论必然相同）。预检的作用是**把失败前移**，不是替代那道门。
 */
export function canInvalidatePendingCompletionForOrder(orderId: string): boolean {
  const inspected = inspectPendingCompletion(orderId);
  return inspected.kind === "none" || inspected.kind === "ok";
}

/**
 * 作废「某订单当前那份 pending 完成材料」（**同步、幂等**，P0-11）。
 *
 * ## 它是谁的入口
 *
 * **只有**订单释放路径会调它（封禁回池 / 客服换人）——见
 * `lib/data/companionOrderTransaction.ts` 的 `releaseCurrentAssignment`
 * （P0-11 起由它统一承载四件「解除当前履约」的事；P0-6 时期那个私有出口
 * `writeAcceptanceRelease` 就是它被抽出来之前的形状）。
 * 没有任何接口、任何页面暴露这个动作：客服点不出「作废」，打手也点不出来。
 *
 * ## 为什么必须走中央状态机（D15）
 *
 * `P0-9/02-decisions.md` 的 **D15** 有两条要求，这里是它们的落点：
 * 1. **走中央状态机**——`canTransitionCompletion(status, "invalidated")` 是那次判定，
 *    领域 Guard（`status === "pending"`）随后并列存在。两道门都要留，理由与
 *    `approveCompletion` 的第 3、4 步同：状态表回答「这条边存不存在」，
 *    领域 Guard 回答「这一条此刻就站在起点的状态上吗」。
 * 2. **明确处理 `pendingSubmissionIdByOrder` 索引**——索引的清理收在
 *    `applyCompletionInvalidation` 里，与状态写入同段完成。
 *
 * 判定本身收在 `inspectPendingCompletion`，与只读预检共用同一份。
 *
 * ## 幂等判据是索引本身
 *
 * 第一次调用清理掉索引；第二次调用时索引已不在，直接返回 `none`。
 * 因此它在释放路径上重复执行是安全的（那段代码本身是原子区段，不会重复，
 * 但这条性质让「将来再挂一个调用方」不会变成双重作废）。
 *
 * ## 为什么「没有 pending」不是错误
 *
 * 绝大多数释放都发生在打手还没提交完成材料的时候（`accepted` 阶段、
 * 或 `serving` 刚接手）。那时**没有任何东西需要作废**，返回 `none` 让调用方继续。
 */
export function invalidatePendingCompletionForOrder(input: {
  orderId: string;
  at: string;
}): CompletionInvalidationOutcome {
  // —— 原子区段开始（无 await）——

  const inspected = inspectPendingCompletion(input.orderId);
  if (inspected.kind === "none") return { kind: "none" };
  if (inspected.kind === "missing-record") return { kind: "missing-record" };
  if (inspected.kind === "not-pending") return { kind: "not-pending", status: inspected.status };

  /* —— 第 5 步：原子写入 —— */
  const written = applyCompletionInvalidation(inspected.submissionId, input.at);
  // 同一段同步代码里刚读到它，这里不可能为 null；真出现就按「记录丢了」如实报告
  if (!written) return { kind: "missing-record" };
  // —— 原子区段结束 ——

  return { kind: "invalidated", submissionId: inspected.submissionId, changed: true };
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 打手提交完成材料（`serving` → pending submission）。
 *
 * ## 判定顺序
 *
 * ```
 * 1. 订单不存在 / actualCompanionId ≠ 我   → not-found（对外 404，不泄露存在性）
 * 2. status ≠ serving                     → not-serving（对外 400）
 * 3. 该订单已有 pending                   → pending-exists（对外 400）
 * 4. 冻结配置快照与 deadline               → 新建 submission（pending）
 * ```
 *
 * - **归属先于状态**：先看状态的话，别人就能拿一个订单 id 试探出「这一单已开始服务」。
 * - **没有幂等键**：这个动作每次都是新建记录（rejected 后重提必须重开一条），
 *   「同一订单最多一份 pending」由第 3 步的索引在同一段同步代码里保证。
 * - **快照只读一次**：`autoApprovalMinutesSnapshot` / `autoApprovalDeadlineAt` 在创建
 *   这一刻冻结，之后改配置不影响这条在途 pending。
 *
 * ⚠️ `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份。
 */
export async function submitCompletion(input: {
  companionId: string;
  orderId: string;
  summary: string;
  evidence: SupportEvidence[];
  at: string;
}): Promise<CompanionCompletionSubmitOutcome> {
  const payments = paymentStore();
  const completions = completionStore();

  // —— 原子区段开始（无 await）——

  /* —— 第 1 步：订单存在，且当前履约人就是我 —— */
  const order = payments.orders.get(input.orderId);
  if (!order || order.actualCompanionId !== input.companionId) return { kind: "not-found" };

  /* —— 第 2 步：状态必须恰好是 serving —— */
  // accepted 还没开始服务；completed / refunded 是终态；paid 说明这一单不在他名下。
  // 四种都拒绝，一个都不放行
  if (order.status !== "serving") return { kind: "not-serving", status: order.status };

  /* —— 第 3 步：同一订单最多一份 pending —— */
  if (completions.pendingSubmissionIdByOrder.has(order.id)) {
    return { kind: "pending-exists" };
  }

  /* —— 第 4 步：冻结配置快照与 deadline —— */
  const autoApprovalMinutesSnapshot = currentPlatformConfig().completionAutoApprovalMinutes;
  const autoApprovalDeadlineAt = plusMinutes(input.at, autoApprovalMinutesSnapshot);

  const submission: CompletionSubmission = {
    id: `cs_${crypto.randomUUID()}`,
    orderId: order.id,
    companionId: input.companionId,
    summary: input.summary,
    evidence: input.evidence,
    status: "pending",
    submittedAt: input.at,
    autoApprovalMinutesSnapshot,
    autoApprovalDeadlineAt,
    reviewSource: null,
    reviewedByStaffId: null,
    reviewedByName: null,
    reviewedAt: null,
    rejectReason: null,
    invalidatedAt: null,
  };

  appendCompletionSubmission(submission);
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    submissionId: submission.id,
    orderId: submission.orderId,
    status: "pending",
    autoApprovalDeadlineAt: submission.autoApprovalDeadlineAt,
    changed: true,
  };
}

// ——————————————————————————— 人工通过 ———————————————————————————

/**
 * 客服人工通过（`pending submission + serving order → approved + completed`）。
 *
 * ## 判定顺序
 *
 * ```
 * 1. submission 不存在                       → not-found（404）
 * 2. status === approved                    → replayed（重复点击，什么都不写）
 * 3. 结构校验 canTransition(…, approved)      → invalid-status（400）
 * 4. 领域 Guard：status 必须恰好 pending       → invalid-status（400）
 * 5. 订单存在                                 → order-missing（500）
 * 6. 结构校验 canTransitionOrder(…, completed) → order-not-serving（400）
 * 7. 领域 Guard：订单必须仍 serving            → order-not-serving（400）
 * 8. submission 属于当前有效完成材料           → stale-submission（400）
 * 9. 原子写入：submission → approved + 订单 → completed
 * ```
 *
 * - **第 2 步早于第 3 步**：`approved → approved` 不在状态表里，先做结构校验会把
 *   一次重复点击判成 400，而它只是一次重放。
 * - **第 3、4 步语义不同，两道门都留**：状态表回答「这条边存不存在」，领域 Guard 回答
 *   「这一条此刻就站在起点的状态上吗」。
 * - **第 6、7 步同理**：与 P0-7 `startCompanionOrder` 的「结构在前、领域 Guard 在后」
 *   同一顺序。第 6 步让 `ORDER_TRANSITIONS`（结构合法性的唯一真值源）回答「serving →
 *   completed 这条边存不存在」，第 7 步才回答「这一单此刻是不是就站在 serving 上」。
 *   今天两者结果等价（领域 Guard 严格更窄），但只留后者会在状态表变宽 / 变窄时静默漂移。
 * - **第 6～8 步在写入前、同一段同步代码里**：判完到写之间让出执行权，
 *   就可能出现「判的是 serving、写的时候已被 refunded」。
 */
export async function approveCompletion(input: {
  submissionId: string;
  staffId: string;
  staffName: string;
  at: string;
}): Promise<StaffCompletionApproveOutcome> {
  const completions = completionStore();
  const payments = paymentStore();

  // —— 原子区段开始（无 await）——

  /* —— 第 1 步：submission 存在 —— */
  const submission = completions.submissions.get(input.submissionId);
  if (!submission) return { kind: "not-found" };

  /* —— 第 2 步：已经是 approved → 重放 —— */
  if (submission.status === "approved") {
    return { kind: "replayed", submission: { ...submission }, changed: false };
  }

  /* —— 第 3 步：结构校验（中央状态机）—— */
  if (!canTransitionCompletion(submission.status, "approved")) {
    return { kind: "invalid-status", status: submission.status };
  }

  /* —— 第 4 步：领域 Guard —— */
  if (submission.status !== "pending") {
    return { kind: "invalid-status", status: submission.status };
  }

  /* —— 第 5 步：订单存在 —— */
  const order = payments.orders.get(submission.orderId);
  if (!order) return { kind: "order-missing" };

  /* —— 第 6 步：结构校验（中央状态机）—— */
  // 这条判定先于领域 Guard：让「订单状态表里有没有 serving → completed 这条边」由
  // `ORDER_TRANSITIONS` 自己回答（与 P0-7 startCompanionOrder 同一顺序，见本函数头部注释）
  if (!canTransitionOrder(order.status, "completed")) {
    return { kind: "order-not-serving", status: order.status };
  }

  /* —— 第 7 步：领域 Guard：订单必须仍 serving —— */
  // ⚠️ 与第 6 步并列存在，不是它的重复：结构校验回答「这条边存在吗」，这句才回答
  // 「这一单此刻就站在 serving 上吗」。今天两者结果等价（领域 Guard 严格更窄），
  // 但只留前者会让「状态表允许」变成「此刻可以」，只留后者会让结构漂移无人拦。
  if (order.status !== "serving") {
    return { kind: "order-not-serving", status: order.status };
  }

  /* —— 第 8 步：submission 属于当前有效完成材料 —— */
  if (order.actualCompanionId !== submission.companionId) {
    return { kind: "stale-submission" };
  }

  /* —— 第 9 步：原子写入（submission → approved + 订单 → completed）—— */
  // ⚠️ 下面两个 `if` 是**类型收窄**，不是运行时会走的失败分支。理由（可核对，不是约定）：
  // ① 两条记录都已在**同一段无 await 的同步区段**里取到——submission 在第 1 步、
  //    订单在第 5 步，而且两个 store 都是进程内单例（`getMockStore` 建仓只执行一次），
  //    写原语内部再 `store()` 拿到的就是同一份 Map；
  // ② 全仓没有删除订单 / 删除完成材料的入口（订单只有 apply* 写原语、完成材料只有
  //    append / applyCompletionReview，没有任何 delete），第 1/5 步取到非 null 之后
  //    到这里不可能「又没了」；
  // ③ 整段无 `await`，别的请求插不进来。
  // 因此不存在「submission 已 approved 但订单仍 serving」的一致状态（§十禁止的正是它）。
  // 保留这两个 null 分支只是为了让同步写原语的 `| null` 签名在此处收窄成非 null。
  const written = applyCompletionReview(submission.id, "approved", {
    at: input.at,
    reviewSource: "staff",
    reviewedByStaffId: input.staffId,
    reviewedByName: input.staffName,
    rejectReason: null,
  });
  if (!written) return { kind: "not-found" };

  // ⚠️ P0-9：订单完成**不能**直接调 `applyOrderCompletion`——那会漏掉投诉窗口快照
  // 与打手收益，而漏掉之后「订单已完成、收益不存在」会一直静默存在。
  // 结算收在 `settleOrderCompletion` 一个函数里，两个完成来源（人工 / System）
  // 都只走它，因此「订单 completed + 投诉窗口冻结 + frozen 收益」三件事
  // 要么一起发生，要么一件都不发生。
  const settled = settleOrderCompletion({ orderId: order.id, at: input.at });
  if (!settled) return { kind: "order-missing" };
  // —— 原子区段结束 ——

  return { kind: "ok", submission: { ...written.updated }, changed: true };
}

// ——————————————————————————— 人工驳回 ———————————————————————————

/**
 * 客服人工驳回（`pending submission → rejected`，**订单不动**）。
 *
 * ## 判定顺序
 *
 * ```
 * 1. submission 不存在                      → not-found（404）
 * 2. status === rejected                   → replayed（重复点击，不覆盖第一次的驳回原因）
 * 3. 结构校验 canTransition(…, rejected)     → invalid-status（400）
 * 4. 领域 Guard：status 必须恰好 pending      → invalid-status（400）
 * 5. 原子写入：submission → rejected
 * ```
 *
 * ⚠️ **不改订单**：订单继续 `serving`，打手可重新提交并重新计时。驳回原因必填
 * （服务层已用 `normalizeAdminReviewNote` 校验），审核人三个字段写在这条记录上。
 */
export async function rejectCompletion(input: {
  submissionId: string;
  staffId: string;
  staffName: string;
  rejectReason: string;
  at: string;
}): Promise<StaffCompletionRejectOutcome> {
  const completions = completionStore();

  // —— 原子区段开始（无 await）——

  /* —— 第 1 步：submission 存在 —— */
  const submission = completions.submissions.get(input.submissionId);
  if (!submission) return { kind: "not-found" };

  /* —— 第 2 步：已经是 rejected → 重放 —— */
  // 不覆盖第一次的驳回原因：一次驳回只有一个结论，第二次点击不是「改结论」
  if (submission.status === "rejected") {
    return { kind: "replayed", submission: { ...submission }, changed: false };
  }

  /* —— 第 3 步：结构校验 —— */
  if (!canTransitionCompletion(submission.status, "rejected")) {
    return { kind: "invalid-status", status: submission.status };
  }

  /* —— 第 4 步：领域 Guard —— */
  if (submission.status !== "pending") {
    return { kind: "invalid-status", status: submission.status };
  }

  /* —— 第 5 步：原子写入 —— */
  const written = applyCompletionReview(submission.id, "rejected", {
    at: input.at,
    reviewSource: "staff",
    reviewedByStaffId: input.staffId,
    reviewedByName: input.staffName,
    rejectReason: input.rejectReason,
  });
  if (!written) return { kind: "not-found" };
  // —— 原子区段结束 ——

  return { kind: "ok", submission: { ...written.updated }, changed: true };
}

// ——————————————————————————— 到期自动通过 ———————————————————————————

/**
 * 到期自动通过（**同步、幂等**，P0-8）。
 *
 * 对每一份 pending 且已到 `autoApprovalDeadlineAt` 的完成材料，若订单仍 serving、
 * 打手仍一致、且无进行中退款 / 未完结投诉阻塞，就把它写成 `approved`（来源 `system`），
 * 并把订单推进到 `completed`。重复执行不重复完成、不刷新 `completedAt`：
 * 第一次执行后 submission 已不是 pending，第二次直接跳过。
 *
 * ## 为什么是同步函数
 *
 * 它要挂在**读取路径**上（用户订单读、打手订单读、管理端订单读、客服完成材料读），
 * 且要能在原子区段里被调用。真实调度器上线后调用**同一个**函数，不另写一套
 * （与 `sweepExpiredDispatches` 完全同形）。
 *
 * ## 计划 / 提交两段，整段无 await
 *
 * 先只读地把「本次要自动通过哪些」挑出来（计划阶段），再逐一写入（提交阶段）。
 * 两段之间没有 `await`，因此「挑的时候是 pending、写之前被别人审了」这种情况
 * 在结构上产生不出来；即便真发生，`applyCompletionReview` 也只会原样重写一遍
 * `approved`（不刷新时间），而订单的 `completedAt` 由 `?? at` 保证不被刷新。
 */
export function sweepCompletionAutoApprovals(at: string): {
  autoApprovedSubmissionIds: string[];
} {
  const completions = completionStore();
  const payments = paymentStore();

  const plan: { submissionId: string; orderId: string }[] = [];

  // —— 计划阶段（只读）——
  for (const submission of completions.submissions.values()) {
    // 白名单：只有 pending 才可能自动通过。不是「非终态」——即使将来有人手工
    // 塞进一条 invalidated，它也不会被自动通过（见 D3）
    if (submission.status !== "pending") continue;
    // 到点才处理：deadline <= at
    if (Date.parse(submission.autoApprovalDeadlineAt) > Date.parse(at)) continue;

    const order = payments.orders.get(submission.orderId);
    if (!order) continue;
    if (order.status !== "serving") continue;
    if (order.actualCompanionId !== submission.companionId) continue;

    // 阻塞判据（D4）：进行中的退款 + 未完结的投诉。
    // ⚠️ P0-9 起数据读取走 `readOrderBlockingFacts()`——与收益到期解冻**同一个函数**。
    // 两处各读一遍的那天，「被投诉挡住却照样放款」就会成为可能
    if (isCompletionAutoApprovalBlocked(readOrderBlockingFacts(submission.orderId))) continue;

    plan.push({ submissionId: submission.id, orderId: submission.orderId });
  }

  // —— 提交阶段（写）——
  for (const item of plan) {
    applyCompletionReview(item.submissionId, "approved", {
      at,
      reviewSource: "system",
      reviewedByStaffId: null,
      reviewedByName: null,
      rejectReason: null,
    });
    // 与人工通过走**同一个**结算函数（P0-9）：投诉窗口快照 + frozen 收益
    settleOrderCompletion({ orderId: item.orderId, at });
  }

  return { autoApprovedSubmissionIds: plan.map((item) => item.submissionId) };
}
