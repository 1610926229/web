import { toCompanionAuditSnapshot, toRefundAuditSnapshot } from "@/lib/constants/adminAudit";
import { canTransitionRefund, resolveRefundReview } from "@/lib/constants/adminRefunds";
import { canTransitionCompletion } from "@/lib/constants/completions";
import {
  COMPANION_RELEASE_REASON_DISABLED,
  DISPATCH_NOTIFICATION_COMPANION_DISABLED,
} from "@/lib/constants/dispatch";
import { resolveEarningReversal } from "@/lib/constants/earnings";
import {
  areCompanionFlagsUnchanged,
  companionFlagAction,
  nextCompanionFlags,
  type CompanionFlagIntent,
} from "@/lib/constants/adminCompanions";
import {
  assertRefundAmountWithinPaid,
  assertRefundApprovalOrderStatus,
  companionRefundNotificationHref,
  computeRefundDecisionAmounts,
  isFullyRefunded,
  resolveCompanionRefundCopy,
  type RefundDecisionInput,
} from "@/lib/constants/refunds";
import type { AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type { Companion } from "@/lib/types/companion";
import type { CompletionSubmissionStatus } from "@/lib/types/completion";
import type { CompanionOrdersReleaseOutcome, Order } from "@/lib/types/order";
import type { RefundDecision, RefundRequest, RefundStatus } from "@/lib/types/refund";
import type { AdminCompanionWriteResult } from "../adminCompanionTransaction";
import type { AdminRefundWriteResult, RefundReviewWriteResult } from "../adminRefundTransaction";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeReplayForActionTx, takeReplayTx } from "./adminWriteTx";
import { applyCompanionFlagsTx, lockCompanionForFlagsTx } from "./companionRepository";
import { getPgExecutor, type TxHandle } from "./executor";
import {
  EARNING_COLUMNS,
  ORDER_COLUMNS,
  REFUND_COLUMNS,
  jsonbParam,
  toEarning,
  toOrder,
  toRefund,
  type EarningRow,
  type OrderRow,
  type RefundRow,
} from "./w1Rows";
import {
  appendNotification,
  applyOrderRefundTx,
  lockDispatchByOrder,
  lockOrder,
  planNotification,
  readCompanion,
  readPlatformConfig,
  releaseCurrentAssignmentTx,
  restoreCouponClaimForOrderTx,
} from "./w1Transactions";

/**
 * 被 `admin_audit_entries` 挡住、PROD-1B 因此推迟的三个管理端事务 ——
 * **T8 停用护航 / T14 退款审核通过与被拒 / T15 开始审核退款**的 PostgreSQL 实现。
 *
 * ## 为什么这三个要单独一批
 *
 * PROD-1B 已经把订单的写闭包（接单、完成、结算、直接退款、超时清扫、派单解除）
 * 整体搬进了数据库，但**退款审核**与**护航停用**两条路径没有搬。
 * 原因只有一个：它们和订单闭包**共用同一个跨领域不变式**——
 *
 * > 业务写入与它的那一条管理审计必须**同生共死**。
 *
 * Mock 这边这条不变式靠「同一段无 `await` 的同步代码」成立（`writeAudit` 直接写
 * 进程内的账本）。换成数据库之后，审计要在**同一个事务**里 `INSERT`，
 * 而 PROD-1B 时 `admin_audit_entries` 这张表还不存在。若只把业务写入搬进 Pg、
 * 审计仍旧写 `globalThis`，得到的就是本轮明令禁止的那半套事务：
 *
 * > `companion/order release → PostgreSQL` 而 `audit → globalThis`。
 *
 * 后果不是「审计迟到」，而是**审计会凭空消失**：那次事务一旦回滚，
 * 进程内的账本已经把「管理员做过这件事」记下来了。反过来（业务回滚了、审计留下了）
 * 更糟——账本会宣称一件根本没发生的事。因此 PROD-1C 先把 `admin_audit_entries`
 * 这张表建起来（`db/migrations/0009_admin_audit_entries.sql`），再回来搬这三个事务。
 *
 * ## 与 Mock 伪事务的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 逐个对应 `lib/data/adminCompanionTransaction.ts` 的 `setCompanionFlags`、
 * `lib/data/companionOrderTransaction.ts` 的 `releaseOrdersForCompanion`、
 * `lib/data/adminRefundTransaction.ts` 的 `startReviewRefund` / `approveRefund` /
 * `rejectRefund`。**判定顺序、守卫、幂等判据、写入的字段集合逐条不变**，
 * 业务规则一个字都没改。
 *
 * 规则的**唯一真值源仍然是 `lib/constants/**`**：`canTransitionRefund`、
 * `resolveRefundReview`、`resolveEarningReversal`、`nextCompanionFlags`、
 * `companionFlagAction`、`areCompanionFlagsUnchanged`、`computeRefundDecisionAmounts`、
 * `assertRefundAmountWithinPaid`、`assertRefundApprovalOrderStatus`、`isFullyRefunded`、
 * `resolveCompanionRefundCopy`、`canTransitionCompletion`。
 * 本文件只**编排**它们，不复制它们的判据——因此两个实现之间不可能出现
 * 「规则改了一处、另一处没改」。
 *
 * ## 本轮**不激活**（与 PROD-1B 同一条裁定）
 *
 * `DATA_SOURCE` 未设置时应用照旧走 Mock 伪事务，本模块的调用方**只有测试**。
 * 激活的就绪条件见 `docs/03-dev/rounds/PROD-1C/02-decisions.md`。
 *
 * ## ⚠️ 加锁顺序
 *
 * 全库统一的不变量是「**`orders` 永远是第一把锁**」（理由见 `w1Transactions.ts` 文件头）。
 * 本轮新增的三条路径按这条不变量取锁：
 *
 * | 事务 | 加锁顺序 |
 * |---|---|
 * | T8 停用护航 | `companions` →（解除订单时）`orders` → `dispatch_records` → `completion_submissions` |
 * | T14 退款审核通过 / 拒绝 | `orders` → `refund_requests` → `earnings` → `dispatch_records` |
 * | T15 开始审核 | **仅 `refund_requests`**——它不写订单，只**普通读**一次订单做 `order-missing` 判定 |
 *
 * ⚠️ **T8 是一条反向的边**：它先锁 `companions` 再锁 `orders`，而全库其它事务
 * 都不锁 `companions`（`readCompanion` 刻意不加锁，见 `w1Transactions.ts`），
 * 因此这条边今天**不构成环**。将来若给某条「先锁订单、再锁护航」的路径加上
 * 护航行锁，这里必须回头改——否则两条互补的顺序立刻成环。
 *
 * ⚠️ **T14 要锁的那一行订单来自一次普通读**：「先读 `refund_requests.order_id`、
 * 再锁订单」是必须的（否则要锁哪一行订单都无从知道），而普通读**不参与**加锁顺序，
 * 因此不会引入环。`refund_requests` 与 `orders` 是「一订单至多一条申请」
 * （`refund_requests_order_key` 唯一索引），锁住订单之后再锁那一条申请，
 * 两者之间不存在「对方先锁了申请」的可能：**没有任何事务先锁 `refund_requests` 再锁 `orders`**。
 *
 * ## ⚠️ 幂等账本要读**两次**，两次的职责不同
 *
 * 这是本文件里唯一一处需要解释的结构，两句话说完：
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay`（重放）与 `conflict`——决定这次到底写不写 |
 *
 * **为什么权威读必须排在锁之后**：Mock 是单线程的，先读账本还是先取锁看不出差别；
 * 数据库上则不然——两个并发请求若都**先**读账本才决定要不要写，会双双读空、
 * 双双进入写入段，最后撞在 `admin_audit_entries_operation_key` 唯一索引上（`23505`）。
 * 那**不是重放，是一次失败**：调用方拿到 500，而正确的答案是「你刚才已经做过了」。
 * 排在锁之后，第二个请求会在行锁上等待，等第一个提交之后再读账本，
 * 于是看到那一行、正确重放。
 *
 * **为什么还要有一次前置读**：Mock 的判定顺序是
 * 「**键冲突 → 目标不存在 → 目标状态不允许 → 重放**」（见 `startReviewRefund` 等函数，
 * `takeReplay` 的文件注释也把「读业务数据之前先读账本」写成了硬要求）。
 * 前三条**一条都不写数据**，因此它们不需要锁；若把整个账本读统一推到锁后，
 * 报错优先级就变了：一次「复用了别人的幂等键」会被答成「这条申请不存在」，
 * 而后者会让调用方去查一个根本不存在的记录。前置读只回答 `conflict` 一个问题，
 * 它读到的 `replay` **不被采信**（那条结论会导向写入，必须留给权威读）。
 *
 * ⚠️ 因此有两条**不可合并**的判据，别把前置读的结果直接当结论用。
 * 顺序请求、重放、冲突三种情形下返回的 `changed` / `replayed` / 失败种类
 * 与 Mock **逐字段相同**。
 *
 * ## 事务内**绝不**调 Mock 的 `writeAudit`
 *
 * `lib/data/adminWriteSupport.ts` 的 `writeAudit` 末尾会写**进程内的** Mock 账本。
 * 这里复用同一个**拼装函数** `buildAuditEntry`（纯函数），把结果交给
 * `appendAuditEntryTx` 的 `INSERT`。拼装规则一字未改，因此「审计记了些什么」
 * 在两个存储上仍然只有一处定义。
 */

/* ─────────────────────────── 事务内共用原语 ─────────────────────────── */

// `takeReplayTx` / `takeReplayForActionTx` 在 PROD-1D 搬去了 `./adminWriteTx`：
// 本轮又添了平台参数、投诉、券模板三组写事务，五组事务用的是**同一条**
// 「读账本 → 比操作者 × 目标（× 意图）」规则。判定一个字没改，只是换了住处，
// 免得三份新拷贝各自长歪（见 `./adminWriteTx.ts` 的文件头）。

/** 一次写入前后的一对快照。与 Mock 的 `refundSnapshots` 同形，判据来自常量层。 */
function refundSnapshots(
  previous: RefundRequest,
  previousOrderStatus: Order["status"],
  updated: RefundRequest,
  updatedOrderStatus: Order["status"],
): { before: AdminAuditSnapshot; after: AdminAuditSnapshot } {
  return {
    before: toRefundAuditSnapshot(previous, previousOrderStatus),
    after: toRefundAuditSnapshot(updated, updatedOrderStatus),
  };
}

/**
 * 取一条退款申请并**锁住它**。
 *
 * ⚠️ T15 与 T14 的「拒绝」的第一把（也是唯一一把）锁就是它。
 * T14 的「通过」必须在 `lockOrder` **之后**调用，理由见文件头的加锁顺序。
 */
async function lockRefund(tx: TxHandle, id: string): Promise<RefundRequest | null> {
  const rows = await tx.query<RefundRow>(
    `SELECT ${REFUND_COLUMNS} FROM refund_requests WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toRefund(rows[0]) : null;
}

/**
 * 「开始审核 / 通过 / 拒绝」这三个动作的退款申请写入器 ——
 * `mockRefundRepository.applyRefundReview` 的 Pg 版本。
 *
 * ## 只写这九列，而且是**算出来**的
 *
 * 写什么由 `resolveRefundReview`（常量层的纯函数，Mock 与 Pg 共用）决定：
 * 它返回一条完整的 `RefundRequest`，这里只把**它可能改动的九个列**落库。
 *
 * ⚠️ 为什么不整行 `UPDATE`：整行写会把 `amount` / `reason_key` / `evidence`
 * 这些**这次事务根本不碰**的列也写一遍，而它们的值来自锁下读到的那一份——
 * 一旦将来有人在这两条语句之间插进第三个写者（今天没有），整行写就会把别人的
 * 改动覆盖回去，且**不会报错**。窄写入让「这次的语义」与「写下去的列」一一对应。
 *
 * ⚠️ 入参 `refund` 必须是**取锁之后读到的**那一份：`resolveRefundReview` 里
 * 「拒绝不改决策」「开始审核不写审核时间」都是「保持原值」，
 * 传一个陈旧的快照进去，这些「原值」就是错的。
 */
async function applyRefundReviewTx(
  tx: TxHandle,
  refund: RefundRequest,
  to: Extract<RefundStatus, "reviewing" | "approved" | "rejected">,
  input: {
    at: string;
    reviewNote: string;
    actorId: string;
    actorRole: AdminWriteContext["actorRole"];
    actorName: string | null;
    decision?: RefundDecision | null;
  },
): Promise<{ previous: RefundRequest; updated: RefundRequest }> {
  const previous = { ...refund };
  const updated = resolveRefundReview(refund, to, input);

  await tx.query(
    `UPDATE refund_requests
        SET status = $2,
            updated_at = $3,
            decision = $4::jsonb,
            reviewing_at = $5,
            reviewed_at = $6,
            reviewed_by = $7,
            reviewed_by_role = $8,
            reviewed_by_name = $9,
            review_note = $10
      WHERE id = $1`,
    [
      refund.id,
      updated.status,
      updated.updatedAt,
      jsonbParam(updated.decision),
      updated.reviewingAt,
      updated.reviewedAt,
      updated.reviewedBy,
      updated.reviewedByRole,
      updated.reviewedByName,
      updated.reviewNote,
    ],
  );

  return { previous, updated };
}

/* ────────────── T8 · 停用护航时解除他手上在履约的订单 ────────────── */

/**
 * 打手资格被下架时，把他手上所有还在履约的订单退回公共池
 * —— `releaseOrdersForCompanion` 的 Pg 版本。
 *
 * ⚠️ **它只被 T8 调用**，而且必须在**同一个事务**里与那次停用一起提交
 * （EX-COMP-01：解除与停用必须同时发生，不能有一个「已经停用、单还挂在他名下」
 * 的中间态——Mock 用「同步区段里排在 `applyCompanionFlags` 之前」表达这件事，
 * 这里用「同一个事务」表达，效果相同：失败就整体回滚）。
 *
 * ## 三段式：全量读 → 全量校验 → 全量写
 *
 * 与 Mock 的形状一致。Mock 之所以要求「校验全部先做完」，是因为它没有事务——
 * 边校验边写的话，第三单发现派单缺失时前两单已经解除完了，管理员看到的是一个
 * **失败**，而数据里已经躺着一半的结果。
 *
 * 在事务里这个结果本来就是原子回滚的，但**形状仍然保留**：它让「哪几单会被动、
 * 动之前要确认什么」可以一次读完，而不是埋在写循环里。
 *
 * ## 只取 `accepted` / `serving`
 *
 * ⚠️ `completed` / `refunded` 的订单**同样**挂着 `actualCompanionId`（那是
 * 「谁做的这一单」，不是「谁在做这一单」），把它们一起解除等于抹掉已完成订单的
 * 履约人——而历史必须保留（EX-COMP-01）。
 *
 * ## 候选集合与锁
 *
 * 候选 id 由一次**普通读**取出并按 `id` 排序；随后逐单 `FOR UPDATE` 取订单锁
 * **并在锁下重验谓词**。重验不是多余的：普通读到加锁之间可以让出执行权，
 * 这一单可能刚被另一条路径解除或推进到了 `completed`。重验之后「候选」与
 * 「实际处理」才是同一件事。
 */
export async function releaseOrdersForCompanionTx(
  tx: TxHandle,
  input: { companionId: string; actorId: string; reason: string; at: string },
): Promise<CompanionOrdersReleaseOutcome> {
  /* —— 第 1 步（只读）：他手上还在履约的订单 —— */
  const candidates = await tx.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE actual_companion_id = $1
        AND status IN ('accepted', 'serving')
      ORDER BY id`,
    [input.companionId],
  );
  if (candidates.length === 0) {
    return { kind: "ok", companionId: input.companionId, releasedOrderIds: [] };
  }

  /* —— 第 2 步：逐单取锁、重验谓词，并确认派单记录与完成材料 —— */
  const plans: { order: Order; dispatchId: string }[] = [];
  for (const candidate of candidates) {
    const orderRow = await lockOrder(tx, candidate.id);
    // 锁下重验：候选集合是不加锁读出来的，锁到手时这一单可能已经不是他手上那一条
    if (!orderRow) continue;
    const order = toOrder(orderRow);
    if (order.actualCompanionId !== input.companionId) continue;
    if (order.status !== "accepted" && order.status !== "serving") continue;

    const dispatchRow = await lockDispatchByOrder(tx, order.id);
    if (!dispatchRow) return { kind: "dispatch-missing", orderId: order.id };

    // 写入循环里**唯一**可能失败的一步就是「作废这一单的 pending 完成材料」，因此它
    // 必须在**任何写入之前**问一遍。
    // ⚠️ 这段与 `releaseCurrentAssignmentTx` 里的同一段判定是**故意重复**的：这里问的是
    //    「整批能不能做」，那里是「这一单能不能做」。删掉这里就只能边写边发现失败——
    //    Pg 里那仍然是原子回滚，但 Mock 的 `inspectPendingCompletion` 提前问一次的
    //    语义（失败时一单都没动过）会消失。判据本身只有一处：`canTransitionCompletion`。
    const pending = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM completion_submissions
        WHERE order_id = $1 AND status = 'pending'
        FOR UPDATE`,
      [order.id],
    );
    const submission = pending[0];
    if (
      submission &&
      !canTransitionCompletion(submission.status as CompletionSubmissionStatus, "invalidated")
    ) {
      return { kind: "inconsistent", orderId: order.id };
    }

    plans.push({ order, dispatchId: dispatchRow.id });
  }

  if (plans.length === 0) {
    return { kind: "ok", companionId: input.companionId, releasedOrderIds: [] };
  }

  /* —— 第 3 步（只读）：读一次平台配置，把每一单的通知都备好 —— */
  // ⚠️ 配置**整段用同一份**：逐单再读一次会让同一批解除落进两个不同的公共池超时
  //    （平台参数在两次读之间可能被改），而它们属于同一次管理动作。
  const config = await readPlatformConfig(tx);
  const notifications = plans.map((plan) =>
    planNotification({
      userId: plan.order.userId,
      kind: "dispatch",
      // 封禁的那条文案与「客服换人」不同：不透露平台对这位打手做了什么
      content: DISPATCH_NOTIFICATION_COMPANION_DISABLED,
      // 用户端的订单页（这条通知发给**下单用户**，不是打手）
      href: `/orders/${plan.order.id}`,
      at: input.at,
    }),
  );

  /* —— 第 4 步（写）：逐单解除 —— */
  const releasedOrderIds: string[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const written = await releaseCurrentAssignmentTx(tx, {
      orderId: plan.order.id,
      dispatchId: plan.dispatchId,
      companionId: input.companionId,
      source: "companion_disabled",
      reason: input.reason,
      actorId: input.actorId,
      // 系统触发：没有幂等键
      idempotencyKey: null,
      at: input.at,
      publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
      notification: notifications[index],
      // 退回公共池：资格被下架的人不可能再被指定
      reassign: null,
    });
    // 不可能状态：第 2 步已经把这一段里唯一可能失败的那一件问过了。
    // 真出现时返回失败——整个事务回滚，连同那次停用一起不写，管理员重试即可
    if (written.kind === "inconsistent") return { kind: "inconsistent", orderId: plan.order.id };
    releasedOrderIds.push(plan.order.id);
  }

  return { kind: "ok", companionId: input.companionId, releasedOrderIds };
}

/* ──────────────────── T8 · 只改「能不能接单」的四个动作 ──────────────────── */

/**
 * 暂停 / 恢复 / 启用 / 停用（T8）—— `setCompanionFlags` 的 Pg 实现。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * 1. 幂等键用在**别的对象**上 → `operation-conflict`；
 * 2. 这位护航不存在 → `not-found`；
 * 3. 已移除 → `removed`（它已经不在名单里，改状态没有去向）；
 * 4. 已停用还要「暂停 / 恢复」→ `disabled`（那两个动作的前提是它还在架上）；
 * 5. 重放、或本来就是这个状态 → `ok / changed:false`，一个字节都不写；
 * 6. **`disable`** 先解除他手上在履约的订单，**再**改标志位；
 * 7. 改标志位 + 写审计。
 *
 * ⚠️ 第 1 步与第 5 步是**同一个问题问两次**，读的也是同一张表——见文件头
 * 「幂等账本要读两次」。第一次只回答 `conflict`（它排在存在性判定之前，
 * 而 Mock 就是这么排的），第二次才是权威的重放判定。
 *
 * ⚠️ **第 6 步排在第 7 步之前**，与 Mock 一样，而且这里的理由更强：
 * 解除订单可能因为数据不自洽而失败（`inconsistent`）。排在前面时，失败意味着
 * **标志位与审计都还没写**，整个事务干净地回滚；反过来（先改标志位再扫单）
 * 就只能二选一：报一个已经发生了一半的失败，或者假装成功。
 * —— 那正是 EX-COMP-01 要禁止的那一瞬。
 *
 * ⚠️ 只有 `disable` 会扫：暂停 / 恢复 / 启用都不解除任何履约
 * （`available = false` 不解除已有订单，EX-SERVICE-05；`enable` 只是回到名单）。
 * 「移除」（`removeCompanion`）本轮**不做**解除——需求里没有那一条（D2 / D10）。
 *
 * ⚠️ 这里用的是**窄写入器** `applyCompanionFlagsTx`，不是
 * `CompanionRepository.updateCompanion`：后者写整份资料，「暂停接单」若走它，
 * 两位管理员同时操作时后写的那次会把另一位刚改好的昵称覆盖回旧值。
 * Mock 侧 `applyCompanionFlags` 的注释同此。
 */
export async function setCompanionFlagsPg(
  companionId: string,
  intent: CompanionFlagIntent,
  input: { unavailableReason: string },
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    // ⚠️ 这里的 `takeReplayTx` **不做**意图收窄，与 Mock 的 `takeReplay` 一致
    const pre = await takeReplayTx(tx, ctx, "companion", companionId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 竞争行锁：这位护航自己。判定与写入都围着这一行 —— */
    const existing = await lockCompanionForFlagsTx(tx, companionId);
    if (!existing) return { kind: "not-found" };
    if (existing.removedAt !== null) return { kind: "removed" };
    if (!existing.enabled && (intent === "pause" || intent === "resume")) {
      return { kind: "disabled" };
    }

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "companion", companionId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const flags = nextCompanionFlags(existing, intent, input);
    const action = companionFlagAction(intent);

    if (replay?.kind === "replay" || areCompanionFlagsUnchanged(existing, flags)) {
      // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    /* —— 停用还要立刻解除他手上在履约的订单（同一事务）—— */
    if (intent === "disable") {
      const released = await releaseOrdersForCompanionTx(tx, {
        companionId,
        // 触发者是这位管理员，写进每条退出历史的 actorId
        actorId: ctx.actorId,
        reason: COMPANION_RELEASE_REASON_DISABLED,
        at: ctx.at,
      });
      if (released.kind !== "ok") return { kind: "inconsistent" };
    }

    const written = await applyCompanionFlagsTx(tx, companionId, flags);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；
    // 当作失败返回，绝不继续写审计（与 Mock 的 `if (!written) return { kind: "not-found" }` 同）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "companion",
        targetId: companionId,
        before: toCompanionAuditSnapshot(written.previous),
        after: toCompanionAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/* ─────────────────────────── T15 · 开始审核退款 ─────────────────────────── */

/**
 * 开始审核：`pending → reviewing` —— `startReviewRefund` 的 Pg 实现。
 *
 * ⚠️ **只改退款申请**：订单状态不变、金额不变、用户的消费统计不变，
 * 也**不写审核人与审核意见**（那两样是「结果」，这一步还没有结果）。
 * 订单在这里被**普通读**一次只是为了 `order-missing` 那条判定
 * （申请挂在一笔不存在的订单上是数据异常，要报 500 而不是 404）。
 *
 * ⚠️ 因此这条路径的锁只有 `refund_requests` 一把——见文件头的加锁顺序表。
 *
 * ## 两个管理员同时开始审核
 *
 * 行锁把两者串行化：第二个请求要等第一个提交，之后它读到 `reviewing`，
 * `canTransitionRefund("reviewing", "reviewing")` 为假 → `invalid-transition`。
 * 因此最终状态唯一（`reviewing`），且**只有一个人**得到成功。
 *
 * ⚠️ 重复的 `start-review` 不是重放：`reviewing` 到 `reviewing` 不在状态表里。
 * 真正的重放只有「同一个幂等键第二次到达」那一条。两轴（操作者 × 目标）之外
 * 还有**意图**一轴：同一个键指向 `refund.reject` 也算冲突——`refineReplayByAction`
 * 就是那一轴。
 */
export async function startReviewRefundPg(
  refundId: string,
  ctx: AdminWriteContext,
): Promise<RefundReviewWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayForActionTx(tx, ctx, "refund.start-review", "refund", refundId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const refund = await lockRefund(tx, refundId);
    if (!refund) return { kind: "not-found" };

    // 普通读，不参与加锁顺序（这条路径不写订单）
    const orderRows = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [refund.orderId],
    );
    if (!orderRows[0]) return { kind: "order-missing" };
    const order = toOrder(orderRows[0]);

    /* —— 权威读：锁下重读账本 —— */
    const replay = await takeReplayForActionTx(tx, ctx, "refund.start-review", "refund", refundId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      return {
        kind: "ok",
        value: { refund: { ...refund }, order: { ...order }, orderChanged: false },
        changed: false,
        replayed: true,
      };
    }

    if (!canTransitionRefund(refund.status, "reviewing")) {
      return { kind: "invalid-transition", status: refund.status };
    }

    const written = await applyRefundReviewTx(tx, refund, "reviewing", {
      at: ctx.at,
      // 开始审核**不动**审核意见，把当前值原样传回去（`resolveRefundReview` 会保持它）
      reviewNote: refund.reviewNote,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actorName: ctx.actorName,
    });

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "refund.start-review",
        targetType: "refund",
        targetId: refundId,
        // 订单没变，因此前后两次记的是同一个状态——不是「没记」，是它确实没变
        ...refundSnapshots(written.previous, order.status, written.updated, order.status),
      }),
    );

    return {
      kind: "ok",
      value: { refund: written.updated, order: { ...order }, orderChanged: false },
      changed: true,
      replayed: false,
    };
  });
}

/* ───────────────────── T14 · 退款审核：通过 ───────────────────── */

/**
 * 审核通过 —— `approveRefund` 的 Pg 实现。
 *
 * 七件事在**同一个事务**里完成（Mock 的「同一段无 `await` 的同步区段」）：
 *
 * 1. 退款申请改成 `approved`，写入**资金决策**（`decision`）；
 * 2. 记录管理者、审核意见与审核时间；
 * 3. 订单写入 `refundedAmount`（`status` **只在退满时**才变成 `refunded`）；
 * 4. 退券（判据只有 `everAcceptedAt`，**不看退款比例**）；
 * 5. 该订单的 Earning **整笔**冲销并补一条 `EarningAdjustment`；
 * 6. **只有累计退满时**：关闭仍在开着的派单 + 通知被退单的打手；
 * 7. 写一条管理审计（before/after 同时带退款状态与订单状态）。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * ```
 * 1. 幂等键用在别的退款 / 别的意图上   → operation-conflict（前置读）
 * 2. 申请不存在                        → not-found
 * 3. 订单不存在                        → order-missing（先于任何写入，
 *                                        否则会留下「退款已通过、订单却没动」）
 * 4. 重放                              → ok / changed:false（权威读）
 * 5. canTransitionRefund(…, approved)  → invalid-transition（approved 是终态）
 * 6. 订单档位不是 serving / completed  → order-status-not-eligible
 * 7. 金额闸（本次 > 0，且累计不超实付）→ decision-invalid
 * ```
 *
 * ⚠️ 第 6 步必须排在**所有读取与写入之前**：它就是「零副作用」的全部实现。
 * 放在金额计算之后也「不会写坏东西」，但那时已经读过收益、算过金额，
 * 失败路径的语义就从「没开始」变成「算完了又反悔」。
 *
 * ⚠️ 第 7 步的判据要读**订单当前的累计已退额**，因此它只能在这里判，
 * 不能提到服务层——服务层先读一次再交给事务，中间隔着一次 `await`，
 * 两次读取之间可以插进另一笔退款。
 *
 * ## 并发：两个管理员同时批准
 *
 * 行锁把两者串行化在同一张订单上。第二个请求要等第一个提交才能继续，
 * 那时退款已经是 `approved` → `invalid-transition`，**不会被退第二笔**。
 * 这条串联还由三层结构性保证托底（顺序与 Mock 相同）：
 * ① `canTransitionRefund` 不许 `approved → approved`；
 * ② `applyOrderRefundTx` 自己短路（`isRefundExecutionClosed`）；
 * ③ 收益冲回按 `refundId` 查已有明细（`earning_adjustments_refund_key` 唯一索引）。
 *
 * ## 金额：入参是**比例**，金额是算出来的
 *
 * 请求体里只有 `refundRateBp` 一个业务字段。两个金额一律由
 * `computeRefundDecisionAmounts` 按订单**冻结的经济快照**算：
 * `refundAmount = floor(actualPaidAmount × rate / 10000)`，
 * `companionReversalAmount` **恒等于** `order.companionBaseIncome`（整笔，与比例无关）。
 * 本文件不重算任何一个，也不重查商品现价或当前分账比例。
 *
 * ## 冲回的对象与 `withdrawn` 的缺席
 *
 * `frozen` 与 `available` 都冲（冲回额那一栏与状态无关地整笔归零）；
 * 冲完状态**仍是 `frozen`**（`resolveEarningReversal` 的规则）。
 * `withdrawn` 在普通退款路径上**结构上不可达**，因此这里**不写**它的分支——
 * 完整论证见 `adminRefundTransaction.ts` 的长注释与 `EX-WITHDRAW-03`。
 * 收益不存在时不写（`serving` 单还没结算），冲回额已经记在退款决策上。
 */
export async function approveRefundPg(
  refundId: string,
  reviewNote: string,
  decisionInput: RefundDecisionInput,
  ctx: AdminWriteContext,
): Promise<AdminRefundWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayForActionTx(tx, ctx, "refund.approve", "refund", refundId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 第 1 步：先**不加锁**拿到它挂在哪张订单上 —— */
    // ⚠️ 必须这样起步：全库统一「`orders` 是第一把锁」，而要知道锁哪一行订单，
    //    只能先从申请上读一眼。普通读不参与加锁顺序。
    const probe = await tx.query<{ order_id: string }>(
      `SELECT order_id FROM refund_requests WHERE id = $1`,
      [refundId],
    );
    if (!probe[0]) return { kind: "not-found" };

    /* —— 第 2 步：第一把锁 —— */
    const orderRow = await lockOrder(tx, probe[0].order_id);
    if (!orderRow) return { kind: "order-missing" };
    const order = toOrder(orderRow);

    /* —— 第 3 步：锁下重读申请（顺序：orders → refund_requests）—— */
    const refund = await lockRefund(tx, refundId);
    if (!refund) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayForActionTx(tx, ctx, "refund.approve", "refund", refundId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      // 重放：把当时的结果原样再报一次。订单此时已经是 refunded，`orderChanged` 如实说 false
      return {
        kind: "ok",
        value: { refund: { ...refund }, order: { ...order }, orderChanged: false },
        changed: false,
        replayed: true,
      };
    }

    if (!canTransitionRefund(refund.status, "approved")) {
      return { kind: "invalid-transition", status: refund.status };
    }

    /* —— 状态闸：只有 serving / completed 能进入售后资金链 —— */
    const orderStatusMessage = assertRefundApprovalOrderStatus(order.status);
    if (orderStatusMessage !== null) {
      return { kind: "order-status-not-eligible", message: orderStatusMessage };
    }

    /* —— 决策：按冻结公式算两个金额 —— */
    const amounts = computeRefundDecisionAmounts({
      actualPaidAmount: order.actualPaidAmount,
      companionBaseIncome: order.companionBaseIncome,
      input: decisionInput,
    });
    const companionReversalAmount = amounts.companionReversalAmount;

    const amountMessage = assertRefundAmountWithinPaid({
      refundAmount: amounts.refundAmount,
      alreadyRefundedAmount: order.refundedAmount,
      actualPaidAmount: order.actualPaidAmount,
    });
    if (amountMessage !== null) return { kind: "decision-invalid", message: amountMessage };

    const decision: RefundDecision = {
      // 比例**原样存下**（P0-15 之前那条「退满剩余」的路已整体删除，
      // 因此不存在「没有比例」的决策）
      refundRateBp: decisionInput.refundRateBp,
      refundAmount: amounts.refundAmount,
      // 整笔归零，与比例无关
      companionReversalAmount,
      decidedBy: ctx.actorId,
      decidedAt: ctx.at,
    };

    /* —— 冲回对象：该订单的收益（`order_id` 唯一索引，至多一条）。可能不存在 —— */
    // ⚠️ 锁它：T13 的清扫（`sweepMaturedEarningsPg`）也锁 `earnings`，而它**不锁任何
    //    别的行**、做完就提交，因此这条边不构成环（见文件头的加锁顺序）。
    //    加了锁之后，「这次的冲回以哪一份收益为基线」在本事务内是稳定的。
    const earningRows = await tx.query<EarningRow>(
      `SELECT ${EARNING_COLUMNS} FROM earnings WHERE order_id = $1 FOR UPDATE`,
      [order.id],
    );
    const earning = earningRows[0] ? toEarning(earningRows[0]) : null;

    // 这一次之后这一单是否退满。**只有退满才动订单状态**
    const fullyRefunded = isFullyRefunded(
      order.refundedAmount + decision.refundAmount,
      order.actualPaidAmount,
    );

    /* —— 写入之前把通知备好（含校验与 id）—— */
    // ⚠️ 收件人是这位打手的**用户账号**（`Companion.userId`），而它**可以为 null**：
    //    那样的打手不存在能收信的地址。这是「没有可通知的人」，不是「通知功能坏了」。
    //    ⚠️ `readCompanion` 刻意不加锁（理由见 `w1Transactions.ts`）：给它上锁会让接单
    //    与「管理员改一位打手的开关」互相阻塞，而 Mock 从来没有这条互斥。
    const companion: Companion | null =
      fullyRefunded && order.actualCompanionId
        ? await readCompanion(tx, order.actualCompanionId)
        : null;
    const recipientUserId = companion?.userId ?? null;
    // ⚠️ 传的是**写入之前**读到的订单状态：通知在任何写入之前构造，
    //    因此拿到的就是「这一单退掉之前走到哪一档」，文案才选得对
    const notification = recipientUserId
      ? planNotification({
          userId: recipientUserId,
          kind: "refund",
          content: resolveCompanionRefundCopy(order.status),
          href: companionRefundNotificationHref(order.id),
          at: ctx.at,
        })
      : null;

    /* —— 写入 —— */

    // ① ② 退款申请：状态、审核人、意见、审核时间、资金决策
    const written = await applyRefundReviewTx(tx, refund, "approved", {
      at: ctx.at,
      reviewNote,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actorName: ctx.actorName,
      decision,
    });

    // ③ 订单。金额是**本次退多少（增量）**，累计与状态由写入器自己决定
    const orderWritten = await applyOrderRefundTx(tx, order, ctx.at, decision.refundAmount);
    if (orderWritten.changed && !orderWritten.updated) {
      // 写入器返回「改了但没有新行」是不可能状态；宁可整件事失败，
      // 也不能返回「已通过」
      throw new Error("退款审核通过时订单写入失败");
    }
    // 短路（这一单已经出过款）时写入器返回 `updated: null` 且 `previous` 就是当时那一份——
    // 与 Mock 的 `applyOrderRefund` 在短路分支返回 `updated: previous` 逐字段等价。
    // 审计的 after 状态与返回值读的都是它，两处用的是同一个值。
    const orderAfter = orderWritten.updated ?? orderWritten.previous;

    // ③' 退券：**退款实际发生之后**才恢复 Claim。
    //     ⚠️ 判据只有 `everAcceptedAt` 一个——**不看退款比例**（裁定 §一 §十二），
    //     而部分退款不改订单状态，因此不能用「订单是否已 refunded」代替。
    //     ⚠️ 传 `orderWritten.previous`：那是**写入器亲眼看到的前一状态**，
    //     并发下与事务开始时读到的那一份可能不同。
    //     归属校验由 `restoreCouponClaimForOrderTx` 内部再做一次。
    if (orderWritten.changed) {
      await restoreCouponClaimForOrderTx(tx, {
        userId: orderWritten.previous.userId,
        everAcceptedAt: orderWritten.previous.everAcceptedAt,
        claimId: orderWritten.previous.coupon?.claimId ?? null,
      });
    }

    // ④ 收益：整笔冲回 + 一条明细。两者必须同段落库——只写其中一个，
    //    「读用总数、审计用明细」这条关系就断了。
    //    ⚠️ 幂等键是 `refundId`（一次决策最多一条 `EarningAdjustment`，
    //    由 `earning_adjustments_refund_key` 唯一索引钉住）。
    //    ⚠️ **先验证再动钱**：已经冲过就**跳过而不是报错**——「重放不重复冲回」
    //    是业务规则，报错会把一次本来正确的重放变成 500。判定必须在冲减**之前**：
    //    放到之后，唯一索引抛错留下的就是「钱冲了、明细没写」的悬空状态。
    //    ⚠️ 这是**第三道**保险（前两道是 `canTransitionRefund` 与更早的重放判定），
    //    留着是因为它守的是「钱只能动一次」这条资金不变式。
    if (earning && companionReversalAmount > 0) {
      const existingAdjustment = await tx.query<{ id: string }>(
        `SELECT id FROM earning_adjustments WHERE refund_id = $1`,
        [refundId],
      );
      if (!existingAdjustment[0]) {
        const reversal = resolveEarningReversal(earning, companionReversalAmount);
        const reversed = await tx.query<{ id: string }>(
          `UPDATE earnings
              SET reversed_amount = $2,
                  status = $3
            WHERE id = $1
          RETURNING id`,
          [earning.id, reversal.reversedAmount, reversal.status],
        );
        // 上面刚在锁下确认过这一行存在，更新不到行属于不可能状态；
        // 与 Mock 的 `if (!reversal) throw ...` 同一条：宁可整件事失败
        if (!reversed[0]) throw new Error("退款冲回时收益写入失败");

        await tx.query(
          `INSERT INTO earning_adjustments
             (id, earning_id, order_id, refund_id, type, amount, created_at, admin_id)
           VALUES ($1, $2, $3, $4, 'refund_reversal', $5, $6, $7)`,
          [
            // ⚠️ 与 Mock 的 `newEarningAdjustmentId()` 同前缀同形状。
            //    预置数据的 id 是短串，两边不会撞。
            `adj_${crypto.randomUUID()}`,
            earning.id,
            order.id,
            refundId,
            companionReversalAmount,
            ctx.at,
            ctx.actorId,
          ],
        );
      }
    }

    // ⑤ 退满：关闭派单（「不得继续被接单」的第一道锁）+ 通知打手
    if (fullyRefunded) {
      // ⚠️ 锁在写入段之内取（`orders` → `refund_requests` → `earnings` → `dispatch_records`）：
      //    结果上等价于 Mock 的「先在计划阶段看一眼派单在不在」，
      //    而多出来的这把锁让「关闭」与并发的接单/清扫互斥。
      const dispatchRow = await lockDispatchByOrder(tx, order.id);
      if (dispatchRow) {
        // 写入的列与 Mock 的 `applyDispatchTimedOut` 逐字段相同：state / timed_out_at / updated_at
        await tx.query(
          `UPDATE dispatch_records
              SET state = 'timed_out',
                  timed_out_at = $2,
                  updated_at = $2
            WHERE id = $1`,
          [dispatchRow.id, ctx.at],
        );
      }
    }
    if (notification) await appendNotification(tx, notification);

    // ⑥ 审计。业务写入全部完成之后紧接着写，同一个事务
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "refund.approve",
        targetType: "refund",
        targetId: refundId,
        ...refundSnapshots(
          written.previous,
          orderWritten.previous.status,
          written.updated,
          orderAfter.status,
        ),
      }),
    );

    return {
      kind: "ok",
      value: { refund: written.updated, order: orderAfter, orderChanged: orderWritten.changed },
      changed: true,
      replayed: false,
    };
  });
}

/* ───────────────────── T14 · 退款审核：拒绝 ───────────────────── */

/**
 * 拒绝：`pending | reviewing → rejected` —— `rejectRefund` 的 Pg 实现。
 *
 * ⚠️ **不改订单状态，也不改任何消费金额**：用户看到的订单继续按原进度走，
 * 累计有效消费也不受影响。这正是「退款状态与订单状态是两条独立的线」
 * 在拒绝这条路径上的体现。
 *
 * ⚠️ 与 T15 一样**只写退款申请**，但订单仍然要**普通读**一次做 `order-missing` 判定
 * （申请挂在一笔不存在的订单上是数据异常，要报 500）。因此它**不锁**订单。
 *
 * ⚠️ 拒绝**必须填写审核意见**，规则在 `lib/constants/adminApplications.ts` 的
 * `normalizeAdminReviewNote()`（与入驻审核共用一份），服务层校验通过后才传进来。
 * 这一层**不重复校验**——与 Mock 一样。
 */
export async function rejectRefundPg(
  refundId: string,
  reviewNote: string,
  ctx: AdminWriteContext,
): Promise<RefundReviewWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayForActionTx(tx, ctx, "refund.reject", "refund", refundId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const refund = await lockRefund(tx, refundId);
    if (!refund) return { kind: "not-found" };

    const orderRows = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [refund.orderId],
    );
    if (!orderRows[0]) return { kind: "order-missing" };
    const order = toOrder(orderRows[0]);

    /* —— 权威读：锁下重读账本 —— */
    const replay = await takeReplayForActionTx(tx, ctx, "refund.reject", "refund", refundId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      return {
        kind: "ok",
        value: { refund: { ...refund }, order: { ...order }, orderChanged: false },
        changed: false,
        replayed: true,
      };
    }

    if (!canTransitionRefund(refund.status, "rejected")) {
      return { kind: "invalid-transition", status: refund.status };
    }

    const written = await applyRefundReviewTx(tx, refund, "rejected", {
      at: ctx.at,
      reviewNote,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actorName: ctx.actorName,
    });

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "refund.reject",
        targetType: "refund",
        targetId: refundId,
        // 拒绝不动订单，因此前后两次的订单状态相同——这不是「没记」，而是它确实没变
        ...refundSnapshots(written.previous, order.status, written.updated, order.status),
      }),
    );

    return {
      kind: "ok",
      value: { refund: written.updated, order: { ...order }, orderChanged: false },
      changed: true,
      replayed: false,
    };
  });
}
