import { isCompanionAcceptingOrders, toOrderCompanionSnapshot } from "@/lib/constants/companions";
import { canTransitionCompletion, isCompletionAutoApprovalBlocked, isUnresolvedComplaintStatus } from "@/lib/constants/completions";
import {
  DISPATCH_NOTIFICATION_ACCEPTED,
  DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
  DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT,
  DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT,
  DISPATCH_NOTIFICATION_STAFF_REASSIGNED,
  DISPATCH_NOTIFICATION_STAFF_REPLACED,
  plusMinutes,
} from "@/lib/constants/dispatch";
import {
  COUPON_CLAIM_NOT_FOUND_REASON,
  COUPON_USE_USED_REASON,
  resolveCouponApplication,
} from "@/lib/constants/coupons";
import { isEarningFullyReversed, isEarningMatured } from "@/lib/constants/earnings";
import { canTransitionOrder } from "@/lib/constants/orders";
import {
  canDirectRefund,
  hasRefundBeenExecuted,
  isActiveRefundStatus,
  isRefundExecutionClosed,
  REFUND_NOTIFICATION_COMPANION_REFUNDED,
} from "@/lib/constants/refunds";
import { parseNotificationInput } from "@/lib/constants/service";
import type { ComplaintStatus } from "@/lib/types/complaint";
import type { CompanionReleaseSource } from "@/lib/types/companionRelease";
import type {
  CompanionCompletionSubmitOutcome,
  CompletionSubmissionStatus,
  StaffCompletionApproveOutcome,
  StaffCompletionRejectOutcome,
} from "@/lib/types/completion";
import type { CompanionWriteContext, DispatchAcceptResult, DispatchRecord } from "@/lib/types/dispatch";
import type { CouponClaimStatus, CouponSnapshot } from "@/lib/types/coupon";
import type { Earning } from "@/lib/types/earning";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import type {
  CompanionCancelOutcome,
  CompanionStartOutcome,
  Order,
  OrderCompanionSnapshot,
  OrderStatus,
  StaffOrderReleaseOutcome,
  StaffOrderReplaceOutcome,
} from "@/lib/types/order";
import type { RefundStatus } from "@/lib/types/refund";
import type { DispatchSweepResult } from "../companionDispatchTransaction";
import type { DirectRefundOutcome } from "../directRefundTransaction";
import { getPgExecutor, type PgQueryable, type TxHandle } from "./executor";
import {
  COMPANION_COLUMNS,
  COMPLETION_COLUMNS,
  DISPATCH_COLUMNS,
  EARNING_COLUMNS,
  NOTIFICATION_COLUMNS,
  ORDER_COLUMNS,
  toCompanion,
  toCompletionSubmission,
  toDispatch,
  toEarning,
  toOrder,
  type CompanionRow,
  type CompletionSubmissionRow,
  type DispatchRow,
  type EarningRow,
  type OrderRow,
} from "./w1Rows";

/**
 * W1 订单写闭包的 **PostgreSQL 事务实现**。
 *
 * ## 本轮**不激活**（PROD-1B 裁定）
 *
 * 这个模块**不接入应用的运行路径**：`DATA_SOURCE` 未设置时，应用照旧走 Mock 伪事务。
 * 它的调用方**只有测试**。原因见 `docs/03-dev/rounds/PROD-1B/02-decisions.md` Q1：
 * 订单的完整写闭包经 `admin_audit_entries` 级联到管理端退款 / 券 / 投诉 / 平台参数，
 * 本轮不切数据源，以避免任何「一半 PG、一半 Mock」的事务。
 *
 * ## 与 Mock 伪事务的关系：**等价翻译**，不是重新设计
 *
 * 判定顺序、守卫、幂等判据、写入的字段集合，逐条对应
 * `lib/data/companionDispatchTransaction.ts` / `completionTransaction.ts` /
 * `earningTransaction.ts` / `directRefundTransaction.ts` 里的同名函数。
 * **业务规则一个字都没改**（Hard Rule 2）。
 *
 * 规则的**唯一真值源仍然是 `lib/constants/**`**：`canTransitionOrder`、
 * `canTransitionCompletion`、`isCompletionAutoApprovalBlocked`、`isEarningMatured`、
 * `isEarningFullyReversed`、`isCompanionAcceptingOrders`、`isRefundExecutionClosed`……
 * 本文件只**编排**它们，不复制它们的判据。因此两个实现之间不可能出现
 * 「规则改了一处、另一处没改」——那正是 Hard Rule 2 要防的漂移。
 *
 * ## ⚠️ 加锁顺序（全库统一）：**`orders` 永远是第一把锁**
 *
 * 这是本文件最容易写错、也最难从测试里看出来的地方，因此写在最前面。
 *
 * Mock 没有锁，因此**不存在**加锁顺序问题。一旦换成行锁，两个事务各自按相反顺序
 * 去锁同样的两行，就会**互相等待**——PostgreSQL 会在死锁检测后杀掉其中一个
 * （SQLSTATE `40P01`），而 Mock 的同一段业务**永远不会**失败。
 * 那是一次真实的可靠性倒退，且只在并发下偶发。
 *
 * 硬约束只有一条：**凡是既要动 `orders`、又要动别的行的事务，第一把行锁都落在 `orders` 上**，
 * 之后才轮到 `dispatch_records` / `completion_submissions`。一次要锁多行时一律 `ORDER BY id`，
 * 让并发事务以同一顺序取锁。
 *
 * ⚠️ **唯一可能成环的那条边是 `orders` ↔ `completion_submissions`**（T10 / T11 曾经与
 * T4 / T6 / T7 取相反顺序）。**第一把锁之后的次级顺序不影响正确性**——同一张订单上的
 * 后来者已经被订单锁串行化了，锁 2 与锁 3 谁先谁后都在同一个订单作用域内，不产生环。
 * 因此下表列的是「实际取锁顺序」，而**唯一必须守住的不变量是「第一把锁是 `orders`」**。
 *
 * | 事务 | 加锁顺序 |
 * |---|---|
 * | T2 接单 · T3 超时清扫 · T12 直接退款 | `orders` → `dispatch_records` |
 * | T9 提交完成材料 | `orders`（完成材料只**普通读**，见该函数注释） |
 * | T10 人工通过 · T11 到期自动通过 | `orders` → `completion_submissions` |
 * | T4 取消接单 · T6 客服回池 · T7 客服换人 | `orders` → `dispatch_records` → `completion_submissions` |
 * | ⚠️ 例外 · T10 驳回 `rejectCompletionPg` | **仅 `completion_submissions`**——这条路径不读也不写 `orders`，因此没有「第一把锁」可言，也就无环 |
 * | ⚠️ 例外 · T13 收益解冻 `sweepMaturedEarningsPg` | **仅 `earnings`**——同上，全程不碰 `orders` |
 *
 * ⚠️ **派单与订单是 1:1**（`dispatch_records_order_key` 唯一索引），
 * 因此锁住订单与锁住它那张派单在互斥效果上等价，T2 的「恰好一个赢家」由订单行承担。
 * **完成材料不是**：一张订单先后可以有多份材料（只有一份 `pending`），
 * 所以它必须自己排进这条顺序，**不能靠订单锁代替**它的那把锁。
 *
 * ⚠️ 这条规则在 **T4 / T6 / T7 落地时改过一次**，过程值得记下来：
 * 此前完成材料的两条路径（T10 / T11）先锁 `completion_submissions`、再锁 `orders`；
 * 那时它与「先锁订单」的 T2 / T12 **不构成环**，因为没有任何事务先锁订单、再锁完成材料。
 * 而履约解除（T4 / T6 / T7）必须**同时**动这两张表（订单回 `paid` ＋ 作废在途完成材料），
 * 两条互补的顺序立刻成环。因此把 T10 / T11 的**取锁顺序倒过来**
 * （先用一次普通读拿到 `order_id`，再按统一顺序加锁；判定与写入一个字未改），
 * 全库重新收敛到「订单永远是第一把锁」。
 *
 * ⚠️ 若将来新增一条「先锁 `completion_submissions` 再锁 `orders`」的路径，
 * 必须回头改这里，否则又成环。
 *
 * ## 原子性从哪来
 *
 * Mock 靠「Node 单线程 + 区段内无 `await`」。这里换成**数据库事务 + 行锁**：
 *
 * | Mock 的保证 | 这里的对应物 |
 * |---|---|
 * | 区段内无 `await`，别的请求插不进来 | `withTransaction` + `SELECT … FOR UPDATE` |
 * | 「先读再写」在一次同步执行里完成 | 读与写走**同一条连接**（`TxHandle`），提交点只有一个 |
 * | 重复调用看到已改过的状态 | 状态判据 + 唯一索引，见各函数注释 |
 *
 * ⚠️ **隔离级别是 READ COMMITTED（PostgreSQL 默认）**，**没有**上 SERIALIZABLE。
 * 本轮**不**用全局加锁去解决并发：需要互斥的地方由**行锁**（`FOR UPDATE`）
 * 与**唯一索引**各自表达，范围最小、代价可预期。这是交付指令的明文要求。
 *
 * ## 时钟
 *
 * 与 Mock 一样，时间一律由**调用方传入**（`at`），本模块不取 `new Date()`。
 * 「这件事发生在什么时候」是业务事实，不是「谁碰巧执行了这一行」。
 * 唯一的例外是各类 `id` 里的 `crypto.randomUUID()`——那是**标识**，不是事实。
 */

/* ─────────────────────────── 读 / 锁 原语 ─────────────────────────── */

/*
 * ⚠️ PROD-1C：本段与下面几处**事务内原语**（`lockOrder` / `lockDispatchByOrder` /
 * `readCompanion` / `readPlatformConfig` / `planNotification` / `appendNotification` /
 * `restoreCouponClaimForOrderTx` / `applyOrderRefundTx` / `releaseCurrentAssignmentTx`）
 * 从私有改成了 `export`，供 `adminAuditTransactions.ts` 的 T8 / T14 复用。
 *
 * **判定与写入一个字节都没改**，只是可见性。不这么做的话，那三个事务要么在第二个
 * 文件里各写一份「怎么锁订单 / 怎么算金额 / 怎么造通知」，要么把整个 Mock 事务模块
 * 拉进 Pg 的依赖图——前者会让同一条规则有两个落点（正是本仓反复拒绝的那类分叉），
 * 后者会让 Pg 事务在运行时依赖 `globalThis` 存储。
 */

/**
 * 取一条订单并**锁住它**。所有事务的第一把锁都落在这一行（见文件头「加锁顺序」）。
 *
 * ⚠️ `FOR UPDATE` 不是可选的：Mock 里「读订单 → 判状态 → 写订单」发生在同一段
 * 无 `await` 的代码里，别的请求插不进来。这里三个动作各自是一条 SQL，中间必然
 * 让出执行权；没有行锁，一次并发退款就能让「判的时候是 serving、写的时候已 refunded」
 * 变成真实可能——而那是 Mock 结构上做不到的事。
 */
export async function lockOrder(tx: TxHandle, id: string): Promise<OrderRow | null> {
  const rows = await tx.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

/** 取一条派单并**锁住它**。必须在 `lockOrder` 之后调用——顺序理由见文件头。 */
async function lockDispatch(tx: TxHandle, id: string): Promise<DispatchRow | null> {
  const rows = await tx.query<DispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM dispatch_records WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

/** 按订单取派单并锁住它（T12 用；`order_id` 上有唯一索引，至多一行）。 */
export async function lockDispatchByOrder(tx: TxHandle, orderId: string): Promise<DispatchRow | null> {
  const rows = await tx.query<DispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM dispatch_records WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0] ?? null;
}

/**
 * 取一位打手（**不加锁**）。
 *
 * ⚠️ 刻意不加 `FOR UPDATE`：Mock 读它也是普通读，而打手资料的变化（下架 / 暂停接单）
 * 由管理端事务写。给它上锁会让接单与「管理员改一位打手的开关」互相阻塞，
 * 而 Mock 从来没有这条互斥——本轮的翻译不引入新的锁粒度。
 */
export async function readCompanion(tx: TxHandle, id: string) {
  const rows = await tx.query<CompanionRow>(
    `SELECT ${COMPANION_COLUMNS} FROM companions WHERE id = $1`,
    [id],
  );
  return rows[0] ? toCompanion(rows[0]) : null;
}

/** 读平台参数（单行表）。超时 / 窗口快照的冻结就靠它。 */
export async function readPlatformConfig(tx: TxHandle) {
  return readPlatformConfigFrom(tx);
}

/**
 * 同上，但只要求「能执行 SQL」——给那些**拿得到执行器、拿不到 `TxHandle` 类型**的
 * 写入器用（例如 `insertDispatchForOrderTx`：它的 `tx` 参数被刻意放宽到 `PgQueryable`，
 * 好让建在事务句柄上的仓储工厂能直接把它传进来）。
 *
 * ⚠️ 业务语义不变：**读不到 `id = 1` 那一行仍然抛错**（见下）。放宽的只是类型。
 */
async function readPlatformConfigFrom(db: PgQueryable) {
  const rows = await db.query<{
    exclusive_pool_timeout_minutes: number;
    public_pool_timeout_minutes: number;
    completion_auto_approval_minutes: number;
    complaint_window_minutes: number;
  }>(
    `SELECT exclusive_pool_timeout_minutes, public_pool_timeout_minutes,
            completion_auto_approval_minutes, complaint_window_minutes
       FROM platform_config WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) {
    // 与 Mock 不同：Mock 的 store 恒有一份配置（`platformConfigSeed` 建仓），
    // 数据库里则可能一行都没有。这里**不猜默认值**——猜一个就等于让一次超时快照
    // 建立在一份并不存在的配置上，而快照一旦写下就永不刷新。
    // 种子（`seedDatabase`）保证这一行存在，`tests/pgW1*` 据此断言。
    throw new Error("platform_config 没有 id = 1 的那一行：迁移后必须先播种平台参数");
  }
  return {
    exclusivePoolTimeoutMinutes: row.exclusive_pool_timeout_minutes,
    publicPoolTimeoutMinutes: row.public_pool_timeout_minutes,
    completionAutoApprovalMinutes: row.completion_auto_approval_minutes,
    complaintWindowMinutes: row.complaint_window_minutes,
  };
}

/**
 * 「这一单现在有没有阻塞原因」的 Pg 版本 —— 与 `lib/data/orderBlocking.ts`
 * **同一口径**，判据仍是调用方那句 `isCompletionAutoApprovalBlocked(...)`。
 *
 * ⚠️ `orderBlocking.ts:32-33` 自带注释要求「真实 DB 实现里这两次读应与写入同一事务」，
 * 因此它必须收 `tx`。两条 `SELECT` 与后面的写入共享同一条连接、同一个提交点。
 */
async function readOrderBlockingFacts(tx: TxHandle, orderId: string) {
  const refunds = await tx.query<{ status: string }>(
    `SELECT status FROM refund_requests WHERE order_id = $1`,
    [orderId],
  );
  const complaints = await tx.query<{ status: string }>(
    `SELECT status FROM complaints WHERE order_id = $1`,
    [orderId],
  );
  return {
    hasActiveRefund: refunds.some((row) => isActiveRefundStatus(row.status as RefundStatus)),
    hasUnresolvedComplaint: complaints.some((row) =>
      isUnresolvedComplaintStatus(row.status as ComplaintStatus),
    ),
  };
}

/* ─────────────────────── 通知的构造与写入 ─────────────────────── */

/**
 * 构造一条通知（**不写**）。
 *
 * ⚠️ 与 Mock 的 `planNotification` 一样，**校验发生在写入之前**：
 * 文案非法要在订单已经被改掉之前抛出来，否则留下的是「钱退了、通知没了」。
 */
export function planNotification(input: {
  userId: string;
  kind: Notification["kind"];
  content: { title: string; summary: string; body: string };
  href: string;
  at: string;
}): Notification {
  const payload: NotificationInput = {
    userId: input.userId,
    kind: input.kind,
    title: input.content.title,
    summary: input.content.summary,
    body: input.content.body,
    href: input.href,
  };

  const parsed = parseNotificationInput(payload);
  if (!parsed.ok) throw new Error(`通知内容非法：${parsed.message}`);

  return {
    id: `nt_${crypto.randomUUID()}`,
    userId: parsed.value.userId,
    kind: parsed.value.kind,
    title: parsed.value.title,
    summary: parsed.value.summary,
    body: parsed.value.body,
    createdAt: input.at,
    readAt: null,
    href: parsed.value.href,
  };
}

/**
 * 追加一条通知。
 *
 * ⚠️ **不写 `ON CONFLICT DO NOTHING`**：Mock 的 `appendNotification` 在 id 已存在时
 * **抛错**（「拒绝覆盖已有记录」），而一条已经发给用户的业务事实不能被新记录顶掉。
 * 主键冲突因此是**正确行为**，不是需要被吞掉的噪音——让整段失败，把 bug 暴露出来。
 */
export async function appendNotification(tx: TxHandle, record: Notification): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (${NOTIFICATION_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      record.id,
      record.userId,
      record.kind,
      record.title,
      record.summary,
      record.body,
      record.createdAt,
      record.readAt,
      record.href,
    ],
  );
}

/* ───────────────────────────── T2 · 接单 ───────────────────────────── */

/** 一张派单**当前所在池**的截止时间。与 Mock 的 `currentDeadlineAt` 一字不差。 */
function currentDeadlineAt(record: DispatchRecord): string | null {
  return record.state === "exclusive" ? record.exclusiveDeadlineAt : record.publicDeadlineAt;
}

/**
 * 接单（T2）—— `acceptDispatch` 的 Pg 实现。
 *
 * ## 并发下的「恰好一个赢家」是怎么成立的
 *
 * 第一把锁落在**订单行**上（见文件头「加锁顺序」）。派单与订单 1:1，
 * 因此两个并发接单请求被数据库串行化在同一行上：后到的那个要等前一个提交之后
 * 才能读到这些行，而那时 `state` 已经是 `accepted`——它走「已经被接走」那条分支，
 * **不会再写任何一个字节**。
 *
 * ⚠️ 这**不是**「先读一次再判断」：判断与写入之间持有行锁，因此中间状态不可见。
 * ⚠️ 也**不是**靠 SERIALIZABLE：锁的范围就是这两行，与其它订单完全无关。
 */
export async function acceptDispatchPg(
  dispatchId: string,
  ctx: CompanionWriteContext,
): Promise<DispatchAcceptResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    // 派单记录从不删除（没有 DELETE 路径），因此这条**不加锁**的读拿到的 order_id 是稳定的。
    // 目的只是「先知道要锁哪一行订单」，好让加锁顺序统一为 orders → dispatch_records
    const owner = await tx.query<{ order_id: string }>(
      `SELECT order_id FROM dispatch_records WHERE id = $1`,
      [dispatchId],
    );
    if (!owner[0]) return { kind: "not-found" };

    // ⚠️ 锁订单在锁派单**之前**。反过来写会在并发退款下与 T12 成环（死锁）
    const orderRow = await lockOrder(tx, owner[0].order_id);
    // 订单行缺失（外键本该拦住，属数据被写坏）与 Mock 第 7 道守卫同解：order-closed
    if (!orderRow) return { kind: "order-closed" };
    const order = toOrder(orderRow);

    const recordRow = await lockDispatch(tx, dispatchId);
    if (!recordRow) return { kind: "not-found" };
    const record = toDispatch(recordRow);

    // 已经被接走：是我自己接的算重放，是别人接的是「被抢了」。两种都不写
    if (record.state === "accepted") {
      return record.acceptedByCompanionId === ctx.companionId
        ? { kind: "ok", dispatch: record, replayed: true }
        : { kind: "not-open", state: record.state };
    }
    if (record.state === "timed_out") return { kind: "not-open", state: record.state };

    const deadlineAt = currentDeadlineAt(record);
    if (deadlineAt === null) return { kind: "not-open", state: record.state };
    if (Date.parse(deadlineAt) <= Date.parse(ctx.at)) return { kind: "expired" };

    if (record.state === "exclusive" && record.exclusiveCompanionId !== ctx.companionId) {
      return { kind: "not-eligible" };
    }

    if (order.status !== "paid") return { kind: "order-closed" };

    const companion = await readCompanion(tx, ctx.companionId);
    if (!companion || !isCompanionAcceptingOrders(companion)) {
      return { kind: "companion-unavailable" };
    }
    if (companion.userId !== null && order.userId === companion.userId) {
      return { kind: "self-order" };
    }

    // 文案校验放在写之前：非法文案要在订单被改掉之前抛出来
    const notification = planNotification({
      userId: order.userId,
      kind: "dispatch",
      content: DISPATCH_NOTIFICATION_ACCEPTED,
      href: `/orders/${order.id}`,
      at: ctx.at,
    });

    /* —— 写入：派单 + 订单 + 通知 + 接单事件，同一个事务 —— */

    const acceptedRows = await tx.query<DispatchRow>(
      `UPDATE dispatch_records
          SET state = 'accepted',
              accepted_by_companion_id = $2,
              accepted_at = $3,
              accepted_via = 'companion',
              updated_at = $3
        WHERE id = $1
        RETURNING ${DISPATCH_COLUMNS}`,
      [dispatchId, ctx.companionId, ctx.at],
    );
    if (!acceptedRows[0]) return { kind: "not-found" };

    await tx.query(
      `UPDATE orders
          SET status = 'accepted',
              accepted_at = $2,
              actual_companion_id = $3,
              companion = $4::jsonb,
              -- 「曾经被承接」只写第一次：后来的第二个打手接手不刷新它
              ever_accepted_at = COALESCE(ever_accepted_at, $2)
        WHERE id = $1`,
      [order.id, ctx.at, companion.id, JSON.stringify(toOrderCompanionSnapshot(companion))],
    );

    await appendNotification(tx, notification);

    // ⚠️ 与上面三件事**同一个事务**：分开写就会出现「接单成功但没有历史」，
    //    而接单榜数的正是历史条数——少算一次接单，事后无法补回来。
    //    重复接单不会多留一条：`replayed` 那条路径在上面已经返回，走不到这里
    await tx.query(
      `INSERT INTO companion_accept_events (id, dispatch_id, order_id, companion_id, accepted_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [`acc_${crypto.randomUUID()}`, dispatchId, order.id, companion.id, ctx.at],
    );

    return { kind: "ok", dispatch: toDispatch(acceptedRows[0]), replayed: false };
  });
}

/* ────────────────────── T9/T10/T11 · 完成材料 ────────────────────── */

/**
 * 打手提交完成材料（T9）。
 *
 * 「同一订单最多一份 pending」由**部分唯一索引** `completion_submissions_pending_order_key`
 * （`WHERE status = 'pending'`）保证。Mock 里它是 `pendingSubmissionIdByOrder`
 * 这个只在 pending 时存在的键——语义相同，落点从应用层挪到了数据库层。
 *
 * ⚠️ 这里**先查后插**是刻意的（与仓储层「直接用唯一索引」的态度不同）：
 * 业务要求把这种情况表达成 `pending-exists` 这个**正常结果**（对外 400 + 一句话），
 * 而不是一个 23505 异常。查询与插入在同一事务里，且插入**仍受唯一索引保护**——
 * 并发下的第二个请求会撞索引（调用方按 500 处理），**不会**产生第二份 pending。
 */
export async function submitCompletionPg(input: {
  companionId: string;
  orderId: string;
  summary: string;
  evidence: unknown[];
  at: string;
}): Promise<CompanionCompletionSubmitOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    // 归属先于状态：先看状态的话，别人就能拿订单 id 试探出「这一单已开始服务」
    const orderRow = await lockOrder(tx, input.orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);
    if (order.actualCompanionId !== input.companionId) return { kind: "not-found" };
    if (order.status !== "serving") return { kind: "not-serving", status: order.status };

    // 普通读，**不加锁**：这一行已经持有订单锁（见文件头「`orders` 永远是第一把锁」），
    // 而「同一订单最多一份 pending」由部分唯一索引兜底，不需要再排一次锁
    const pending = await tx.query<{ id: string }>(
      `SELECT id FROM completion_submissions WHERE order_id = $1 AND status = 'pending'`,
      [order.id],
    );
    if (pending.length > 0) return { kind: "pending-exists" };

    const autoApprovalMinutesSnapshot = (await readPlatformConfig(tx)).completionAutoApprovalMinutes;
    const autoApprovalDeadlineAt = plusMinutes(input.at, autoApprovalMinutesSnapshot);
    const id = `cs_${crypto.randomUUID()}`;

    await tx.query(
      `INSERT INTO completion_submissions (${COMPLETION_COLUMNS})
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, $8,
               NULL, NULL, NULL, NULL, NULL, NULL)`,
      [
        id,
        order.id,
        input.companionId,
        input.summary,
        JSON.stringify(input.evidence),
        input.at,
        autoApprovalMinutesSnapshot,
        autoApprovalDeadlineAt,
      ],
    );

    return {
      kind: "ok",
      submissionId: id,
      orderId: order.id,
      status: "pending",
      autoApprovalDeadlineAt,
      changed: true,
    };
  });
}

/**
 * 结算一次订单完成（T10 通过 / T11 自动通过 的**共用下半段**）
 * —— `settleOrderCompletion` 的 Pg 版本。
 *
 * 三件事在**同一个事务**里一起发生：订单 → `completed`、冻结投诉窗口快照、
 * 为该单实际履约打手建一条 `frozen` 收益。金额**直接搬** `companionBaseIncome`，
 * 一个字都不重算。
 *
 * ⚠️ 调用方必须**已经锁住这一行订单**（两条完成路径都先取到订单或完成材料再走到这里）。
 * 这里再读一次拿的是同一事务里的同一份数据，因此不加第二次锁。
 */
async function settleOrderCompletionTx(
  tx: TxHandle,
  input: { orderId: string; at: string },
): Promise<{ changed: boolean; order: OrderRow; earning: Earning | null } | null> {
  const orderRow = await lockOrder(tx, input.orderId);
  if (!orderRow) return null;

  const readExistingEarning = async (): Promise<Earning | null> => {
    const rows = await tx.query<EarningRow>(
      `SELECT ${EARNING_COLUMNS} FROM earnings WHERE order_id = $1`,
      [orderRow.id],
    );
    return rows[0] ? toEarning(rows[0]) : null;
  };

  // 已经完成过：结算是一次状态迁移的副作用，不是「补齐历史」。不补快照、不建收益
  if (orderRow.status === "completed") {
    return { changed: false, order: orderRow, earning: await readExistingEarning() };
  }
  // 不是 serving 就不是「一次完成」：原样返回既有事实，一个字节都不写
  if (orderRow.status !== "serving") {
    return { changed: false, order: orderRow, earning: await readExistingEarning() };
  }

  const config = await readPlatformConfig(tx);
  const completedAt = orderRow.completed_at ?? input.at;
  const snapshot = orderRow.complaint_window_minutes_snapshot ?? config.complaintWindowMinutes;
  // ⚠️ 复用仓库里**唯一**的分钟加法实现（`plusMinutes`），不自己写 Date 运算：
  //    同一件事有两份实现，迟早出现一处四舍五入、另一处不
  const deadline = orderRow.complaint_deadline_at ?? plusMinutes(completedAt, snapshot);

  const updatedRows = await tx.query<OrderRow>(
    `UPDATE orders
        SET status = 'completed',
            completed_at = $2,
            complaint_window_minutes_snapshot = $3,
            complaint_deadline_at = $4
      WHERE id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [orderRow.id, completedAt, snapshot, deadline],
  );
  const settled = updatedRows[0];
  if (!settled) return null;

  const existing = await readExistingEarning();
  if (existing) return { changed: true, order: settled, earning: existing };

  // `completed` 必须有实际履约打手（两条完成路径的领域 Guard 都保证它成立）。
  // 没有打手就没有收益可发：如实不建记录，而不是建一条 `companionId: ""`、
  // 金额 0 的假记录——那种记录会在打手端变成一笔没人认领的钱
  if (!settled.actual_companion_id) {
    return { changed: true, order: settled, earning: null };
  }

  const earningId = `ern_${crypto.randomUUID()}`;
  await tx.query(
    `INSERT INTO earnings (${EARNING_COLUMNS})
     VALUES ($1, $2, $3, $4, 'frozen', $5, $6, NULL, 0, 0)`,
    [
      earningId,
      settled.id,
      settled.actual_companion_id,
      // 直接搬订单快照（与 `Order.companionBaseIncome` 是同一个数，不重算）
      settled.companion_base_income,
      // 冻结时刻取**订单的完成时刻**，不是本次调用的 at：订单可能带着历史 completedAt
      settled.completed_at ?? input.at,
      // 与投诉截止**同一个时刻**，不自己再加一次 minute
      settled.complaint_deadline_at,
    ],
  );

  await backfillRefundReversalsTx(tx, { earningId, orderId: settled.id, at: input.at });

  // 读回**补记之后**的那一份：用插入入参会让调用方拿到一个 reversedAmount 仍是 0 的快照
  const finalRows = await tx.query<EarningRow>(
    `SELECT ${EARNING_COLUMNS} FROM earnings WHERE id = $1`,
    [earningId],
  );
  return {
    changed: true,
    order: settled,
    earning: finalRows[0] ? toEarning(finalRows[0]) : null,
  };
}

/**
 * 把该订单**已批准退款**的冲回额补记到刚建好的收益上（P0-13 D9）。
 *
 * ⚠️ 逐条补写明细，不合成一条：`EarningAdjustment` 的粒度是**一次退款决策**
 * （`earning_adjustments_refund_key` 唯一索引钉住）。P0-15 之后这个循环至多跑一轮，
 * 但循环本身**不改成「只取那一条」**——「明细与决策一一对应」这条规则由索引表达。
 *
 * ⚠️ **先验证再动钱**：已经留下明细的退款在这里就由 `NOT EXISTS` 剔除，
 * 否则重放会在循环中途撞唯一索引，而那时前几笔的冲减已经落库——
 * 留下的正是「钱冲了、明细没写」的悬空状态。
 */
async function backfillRefundReversalsTx(
  tx: TxHandle,
  input: { earningId: string; orderId: string; at: string },
): Promise<void> {
  const refunds = await tx.query<{
    id: string;
    decision: { companionReversalAmount: number; decidedBy: string } | null;
  }>(
    `SELECT r.id, r.decision
       FROM refund_requests r
      WHERE r.order_id = $1
        AND r.status = 'approved'
        AND r.decision IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM earning_adjustments a WHERE a.refund_id = r.id
            )`,
    [input.orderId],
  );

  for (const refund of refunds) {
    const decision = refund.decision;
    // `amount <= 0` 时一个字节都不写，也不需要一条空明细
    if (!decision || decision.companionReversalAmount <= 0) continue;

    // 与 Mock 的 `applyEarningReversal` 同一口径：累加，且由 CHECK 约束守住不变式
    // （`0 <= reversed_amount <= income_amount`）——写入器坏掉也越不了界
    await tx.query(
      `UPDATE earnings SET reversed_amount = reversed_amount + $2 WHERE id = $1`,
      [input.earningId, decision.companionReversalAmount],
    );

    await tx.query(
      `INSERT INTO earning_adjustments
         (id, earning_id, order_id, refund_id, type, amount, created_at, admin_id)
       VALUES ($1, $2, $3, $4, 'refund_reversal', $5, $6, $7)`,
      [
        `eadj_${crypto.randomUUID()}`,
        input.earningId,
        input.orderId,
        refund.id,
        decision.companionReversalAmount,
        input.at,
        decision.decidedBy,
      ],
    );
  }
}

/**
 * 客服人工通过（T10）—— `approveCompletion` 的 Pg 实现。
 *
 * 幂等判据是**状态本身**（submission 已是 `approved` 就是重放），不是幂等键。
 * 结构校验（状态表）与领域 Guard 两道门都保留，顺序与 Mock 一致。
 *
 * ## 取锁顺序：先订单、后完成材料
 *
 * 见文件头「`orders` 永远是第一把锁」。完成材料的 `order_id` 先用一次**普通读**
 * 取到——普通读不参与加锁顺序，因此不会引入新的环。判定与写入逐条不变，
 * 变的只有「先拿哪把锁」。
 */
export async function approveCompletionPg(input: {
  submissionId: string;
  staffId: string;
  staffName: string;
  at: string;
}): Promise<StaffCompletionApproveOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    // 第一把锁必须是订单（见文件头）。为知道要锁哪一行订单，先**不加锁**读一次 order_id
    const probe = await tx.query<{ order_id: string }>(
      `SELECT order_id FROM completion_submissions WHERE id = $1`,
      [input.submissionId],
    );
    if (!probe[0]) return { kind: "not-found" };

    const orderRow = await lockOrder(tx, probe[0].order_id);
    if (!orderRow) return { kind: "order-missing" };

    const submissionRows = await tx.query<CompletionSubmissionRow>(
      `SELECT ${COMPLETION_COLUMNS} FROM completion_submissions WHERE id = $1 FOR UPDATE`,
      [input.submissionId],
    );
    if (!submissionRows[0]) return { kind: "not-found" };
    const submission = toCompletionSubmission(submissionRows[0]);

    // 第 2 步早于结构校验：`approved → approved` 不在状态表里，先做结构校验会把
    // 一次重复点击判成 400，而它只是一次重放
    if (submission.status === "approved") {
      return { kind: "replayed", submission, changed: false };
    }
    if (!canTransitionCompletion(submission.status, "approved")) {
      return { kind: "invalid-status", status: submission.status };
    }
    if (submission.status !== "pending") {
      return { kind: "invalid-status", status: submission.status };
    }

    // 结构校验先于领域 Guard：让 ORDER_TRANSITIONS 回答「这条边存不存在」
    if (!canTransitionOrder(orderRow.status as OrderStatus, "completed")) {
      return { kind: "order-not-serving", status: orderRow.status as OrderStatus };
    }
    if (orderRow.status !== "serving") {
      return { kind: "order-not-serving", status: orderRow.status as OrderStatus };
    }
    // submission 必须是当前有效完成材料（换人后旧材料失效）
    if (orderRow.actual_companion_id !== submission.companionId) {
      return { kind: "stale-submission" };
    }

    const writtenRows = await tx.query<CompletionSubmissionRow>(
      `UPDATE completion_submissions
          SET status = 'approved',
              review_source = 'staff',
              reviewed_by_staff_id = $2,
              reviewed_by_name = $3,
              reviewed_at = $4
        WHERE id = $1
        RETURNING ${COMPLETION_COLUMNS}`,
      [input.submissionId, input.staffId, input.staffName, input.at],
    );
    if (!writtenRows[0]) return { kind: "not-found" };

    // 订单完成**不能**只改 status——那会漏掉投诉窗口快照与打手收益。
    // 结算收在这一个函数里，两个完成来源（人工 / System）都只走它
    const settled = await settleOrderCompletionTx(tx, { orderId: orderRow.id, at: input.at });
    if (!settled) return { kind: "order-missing" };

    return { kind: "ok", submission: toCompletionSubmission(writtenRows[0]), changed: true };
  });
}

/** 客服人工驳回（T10）—— `rejectCompletion` 的 Pg 实现。**不动订单**。 */
export async function rejectCompletionPg(input: {
  submissionId: string;
  staffId: string;
  staffName: string;
  rejectReason: string;
  at: string;
}): Promise<StaffCompletionRejectOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    const rows = await tx.query<CompletionSubmissionRow>(
      `SELECT ${COMPLETION_COLUMNS} FROM completion_submissions WHERE id = $1 FOR UPDATE`,
      [input.submissionId],
    );
    if (!rows[0]) return { kind: "not-found" };
    const submission = toCompletionSubmission(rows[0]);

    // 已经是 rejected → 重放（**不覆盖**第一次的驳回原因）
    if (submission.status === "rejected") {
      return { kind: "replayed", submission, changed: false };
    }
    if (!canTransitionCompletion(submission.status, "rejected")) {
      return { kind: "invalid-status", status: submission.status };
    }
    if (submission.status !== "pending") {
      return { kind: "invalid-status", status: submission.status };
    }

    const writtenRows = await tx.query<CompletionSubmissionRow>(
      `UPDATE completion_submissions
          SET status = 'rejected',
              review_source = 'staff',
              reviewed_by_staff_id = $2,
              reviewed_by_name = $3,
              reviewed_at = $4,
              reject_reason = $5
        WHERE id = $1
        RETURNING ${COMPLETION_COLUMNS}`,
      [input.submissionId, input.staffId, input.staffName, input.at, input.rejectReason],
    );
    if (!writtenRows[0]) return { kind: "not-found" };

    return { kind: "ok", submission: toCompletionSubmission(writtenRows[0]), changed: true };
  });
}

/**
 * 到期自动通过（T11）—— `sweepCompletionAutoApprovals` 的 Pg 实现。
 *
 * ## 幂等靠 `FOR UPDATE` + 状态条件，不靠「计划阶段读到的状态」
 *
 * Mock 用「计划 / 提交两段之间无 `await`」保证「挑的时候是 pending、写之前被审了」
 * 不会发生。这里换成：`SELECT … WHERE status = 'pending' … FOR UPDATE`。
 * 并发的第二个 sweep 会**阻塞在同一批行上**，等第一个提交后 PostgreSQL 用
 * **更新后的行版本**重新求值 `WHERE`（EvalPlanQual）——那时状态已不是 `pending`，
 * 于是它一行都拿不到。重复执行不重复完成、不刷新 `completed_at`。
 *
 * ⚠️ `ORDER BY id` 让两个 sweep 以**同一顺序**取锁，避免它们彼此成环。
 *
 * ## 取锁顺序：先订单、后完成材料（见文件头）
 *
 * 候选订单按 `ORDER BY id` **整批**先锁住，两个并发 sweep 因此以同一顺序取锁；
 * 「恰好通过一次」仍然由下面那条条件 `UPDATE … WHERE status = 'pending'` 兜底——
 * 后到者要么在候选查询里就看不到它，要么 `UPDATE` 影响 0 行。
 */
export async function sweepCompletionAutoApprovalsPg(at: string): Promise<{
  autoApprovedSubmissionIds: string[];
}> {
  return getPgExecutor().withTransaction(async (tx) => {
    // 第一把锁必须是订单（见文件头）。候选订单集合由「待审且已到点」的材料反查而来
    const lockedOrders = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders
        WHERE id IN (
              SELECT order_id FROM completion_submissions
               WHERE status = 'pending'
                 AND auto_approval_deadline_at <= $1)
        ORDER BY id
          FOR UPDATE`,
      [at],
    );
    const orderById = new Map<string, OrderRow>(lockedOrders.map((row) => [row.id, row]));

    const candidates = await tx.query<CompletionSubmissionRow>(
      `SELECT ${COMPLETION_COLUMNS}
         FROM completion_submissions
        WHERE status = 'pending'
          AND auto_approval_deadline_at <= $1
        ORDER BY id`,
      [at],
    );

    const approved: string[] = [];

    for (const row of candidates) {
      const submission = toCompletionSubmission(row);

      // 候选集合与锁集合来自两条语句、两个快照，因此这里允许回退再锁一次；
      // 那种材料必然是在两条语句之间才变成候选的，本轮扫不到、下一轮会扫到
      const orderRow = orderById.get(submission.orderId) ?? (await lockOrder(tx, submission.orderId));
      if (!orderRow) continue;
      if (orderRow.status !== "serving") continue;
      if (orderRow.actual_companion_id !== submission.companionId) continue;

      // 阻塞判据（D4）：进行中的退款 + 未完结的投诉。与收益到期解冻**同一个函数**——
      // 两处各读一遍的那天，「被投诉挡住却照样放款」就会成为可能
      if (isCompletionAutoApprovalBlocked(await readOrderBlockingFacts(tx, submission.orderId))) {
        continue;
      }

      const written = await tx.query<{ id: string }>(
        `UPDATE completion_submissions
            SET status = 'approved', review_source = 'system', reviewed_at = $2
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [submission.id, at],
      );
      // 行没回来 = 在这几句之间被别的路径审掉了。跳过，不重复结算
      if (!written[0]) continue;

      // 与人工通过走**同一个**结算函数：投诉窗口快照 + frozen 收益
      await settleOrderCompletionTx(tx, { orderId: submission.orderId, at });
      approved.push(submission.id);
    }

    return { autoApprovedSubmissionIds: approved };
  });
}

/* ────────────────────────── T13 · 到期解冻 ────────────────────────── */

/**
 * 收益到期解冻（T13）—— `sweepMaturedEarnings` 的 Pg 实现。
 *
 * 释放的唯一条件是三条同时成立：**到期**、**没有阻塞**、**净额还在**。
 * 第三条（`isEarningFullyReversed`）是 P0-15 带出来的：一笔被退款冲光的收益
 * 状态照样是 `frozen`、`availableAt` 也早已到点，前两条判不出「这笔钱已经没了」。
 *
 * 幂等与 T11 同构：`FOR UPDATE` + `WHERE status = 'frozen'`，
 * 且 `UPDATE … AND status = 'frozen'` 兜第二道。
 */
export async function sweepMaturedEarningsPg(
  at: string,
): Promise<{ releasedEarningIds: string[] }> {
  return getPgExecutor().withTransaction(async (tx) => {
    const candidates = await tx.query<EarningRow>(
      `SELECT ${EARNING_COLUMNS}
         FROM earnings
        WHERE status = 'frozen'
          AND available_at <= $1
        ORDER BY id
          FOR UPDATE`,
      [at],
    );

    const released: string[] = [];

    for (const row of candidates) {
      const earning = toEarning(row);

      // ⚠️ 三条判据都在这一段里**现读**，不接收调用方传入的旧状态
      if (!isEarningMatured({ status: earning.status, availableAt: earning.availableAt, at })) {
        continue;
      }
      if (isCompletionAutoApprovalBlocked(await readOrderBlockingFacts(tx, earning.orderId))) {
        continue;
      }
      // 钱已经归零：状态停在 frozen 是终局，不是「还没到点」
      if (isEarningFullyReversed(earning)) continue;

      const written = await tx.query<{ id: string }>(
        `UPDATE earnings SET status = 'available'
          WHERE id = $1 AND status = 'frozen'
          RETURNING id`,
        [earning.id],
      );
      if (!written[0]) continue;
      released.push(earning.id);
    }

    return { releasedEarningIds: released };
  });
}

/* ───────────────────────── T12 · 直接全额退款 ───────────────────────── */

/**
 * 用户直接全额退款（T12）—— `directRefundOrder` 的 Pg 实现。
 *
 * ## 幂等靠状态，不靠幂等键
 *
 * `refunded` **或** `hasRefundBeenExecuted(order)`（出过一次款）都直接返回
 * `already-refunded`，一个字节都不写。这比幂等键更强——键是调用方给的串，
 * 状态是事实。并发下由行锁串行化：两个请求里第二个读到的是第一个提交后的状态。
 *
 * ## 四件写错就会自相矛盾的事，同一个事务
 *
 * 订单退款金额与状态、**退券**、派单关闭、通知护航。
 * ⚠️ 退券**紧跟在「退款真的发生了」之后**，不能提前：否则会出现「退款被拒、券却还回去」。
 */
export async function directRefundOrderPg(
  orderId: string,
  at: string,
): Promise<DirectRefundOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    // ⚠️ 锁订单在最前。T2 也以订单为第一把锁，两条路径的加锁顺序因此一致
    const orderRow = await lockOrder(tx, orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);

    // ① 幂等的第一道：状态已是终态。**在金额判断之前**——
    //    「什么时候退的」要从订单上读，而不是从这一次请求的 at 编一个出来
    if (order.status === "refunded") {
      return { kind: "already-refunded", orderId: order.id, refundedAt: order.refundedAt };
    }
    // ② 金额异常必须先拦：`0 >= 0` 会让用户得到「已全额退款」，而订单一分钱没退
    if (order.actualPaidAmount <= 0) {
      return { kind: "amount-invalid", orderId: order.id };
    }
    // ③ 幂等的第二道，也是一单一退：状态没变但钱已经出过一次了（部分退款不改状态）
    if (hasRefundBeenExecuted(order)) {
      return { kind: "already-refunded", orderId: order.id, refundedAt: order.refundedAt };
    }
    // ④ 「尚未开始服务」只有这两档
    if (!canDirectRefund(order.status)) {
      return { kind: "not-eligible", orderId: order.id, status: order.status };
    }

    const dispatchRow = await lockDispatchByOrder(tx, order.id);
    const dispatchExists = Boolean(dispatchRow);

    const companion = order.actualCompanionId
      ? await readCompanion(tx, order.actualCompanionId)
      : null;
    // ⚠️ 收件人是这位打手的**用户账号**，而它**可以为 null**（早期资料没有关联用户）。
    //    那种情况下不存在能收信的地址，因此没有可通知的人，而不是「通知功能坏了」
    const recipientUserId = companion?.userId ?? null;
    const notification = recipientUserId
      ? planNotification({
          userId: recipientUserId,
          kind: "refund",
          content: REFUND_NOTIFICATION_COMPANION_REFUNDED,
          // ⚠️ 打手端页面：发给下单用户的 /orders/[id] 对打手是 404
          href: `/companion/orders/${order.id}`,
          at,
        })
      : null;

    /* —— 写入 —— */

    // 金额取**订单自己还剩多少**（实付 − 累计已退），没有任何参数能把金额传进来。
    // 一单一退下 ③ 已保证 refundedAmount === 0，减法仍然留着：它形式上正确且不依赖 ③
    const refundableAmount = order.actualPaidAmount - order.refundedAmount;
    if (isRefundExecutionClosed(order) || order.refundedAmount >= order.actualPaidAmount) {
      return { kind: "already-refunded", orderId: order.id, refundedAt: order.refundedAt };
    }
    const nextRefundedAmount = order.refundedAmount + Math.max(0, refundableAmount);
    const fullyRefunded = nextRefundedAmount >= order.actualPaidAmount;

    const updatedRows = await tx.query<OrderRow>(
      `UPDATE orders
          SET status = $2,
              refunded_at = $3,
              refunded_amount = $4
        WHERE id = $1
        RETURNING ${ORDER_COLUMNS}`,
      [
        order.id,
        fullyRefunded ? "refunded" : order.status,
        // 「第一次退满」的时刻一旦写下就不刷新
        fullyRefunded ? (order.refundedAt ?? at) : order.refundedAt,
        nextRefundedAmount,
      ],
    );
    const updated = updatedRows[0];
    if (!updated) throw new Error("直接退款时订单写入失败");
    if (updated.refunded_amount === order.refundedAmount) {
      // 双保险：真的走到「写不动」时如实按已退款回答，不谎报成功
      return { kind: "already-refunded", orderId: order.id, refundedAt: updated.refunded_at };
    }

    // ①' 退券。**紧跟在退款真的发生之后**，判据是订单历史上有没有被承接
    await restoreCouponClaimForOrderTx(tx, {
      userId: order.userId,
      everAcceptedAt: order.everAcceptedAt,
      claimId: order.coupon?.claimId ?? null,
    });

    // ② 关闭派单：这是「不得继续接单」的第一道，也是「超时清扫不得再次退款」的机制依据
    if (dispatchExists) {
      await tx.query(
        `UPDATE dispatch_records
            SET state = 'timed_out', timed_out_at = $2, updated_at = $2
          WHERE order_id = $1`,
        [order.id, at],
      );
    }

    // ③ 通知
    if (notification) await appendNotification(tx, notification);

    return {
      kind: "ok",
      orderId: updated.id,
      orderNo: updated.order_no,
      refundedAmount: updated.refunded_amount,
      refundedAt: updated.refunded_at ?? at,
      previousStatus: order.status,
      dispatchClosed: dispatchExists,
      notifiedCompanionUserId: notification ? notification.userId : null,
    };
  });
}

/**
 * 退券 —— `restoreCouponClaimForOrder` 的 Pg 版本。
 *
 * 判据只有一条：**订单历史上有没有被承接**（`everAcceptedAt`）。
 * ⚠️ 不看退款比例，也不能只看退款瞬间的 `status`：`accepted → 回池 → paid` 的单
 * 退款时状态是 `paid`，但它已经被承接过了，**不还券**。
 *
 * ⚠️ 只有 `used` 才动：把原 Claim 从 `used` 改回 `unused` 并清掉 `usedAt`。
 * 这张券能不能再用，由「当下重新判」决定——返还的是**未使用资格**，
 * 不是绕过门槛与有效期。
 */
export async function restoreCouponClaimForOrderTx(
  tx: TxHandle,
  input: { userId: string; everAcceptedAt: string | null; claimId: string | null },
): Promise<void> {
  if (input.everAcceptedAt !== null) return;
  if (!input.claimId) return;

  // 归属校验在这里再做一次：订单上的快照是历史事实，这句防的是「快照指向了别人的券」
  await tx.query(
    `UPDATE coupon_claims
        SET status = 'unused', used_at = NULL
      WHERE id = $1 AND user_id = $2 AND status = 'used'`,
    [input.claimId, input.userId],
  );
}

/* ─────────────── 核销与派单：T1 事务内的两个写入参与者（PROD-1D） ─────────────── */

/**
 * 核销券 —— `redeemCouponClaimForOrder` 的 **Pg 版本**（给 T1 用）。
 *
 * ## 判定与 Mock 逐条同序、同因
 *
 * 归属 → 券模板此刻是否启用 → `resolveCouponApplication()`（共享纯函数）判
 * 「已用 / 已停用 / 未开始 / 已过期 / 门槛未达 / 形态不支持」。**判定逻辑只有一份**，
 * 因此「试算说能用、真下单却被拒」在两个存储上都不可能发生。
 *
 * ⚠️ 券模板的 `enabled` 是**普通读**（与 `readCompanion` / `readPlatformConfig` 同口径），
 * 不加行锁。含义是：一位管理员在本事务读完之后、提交之前**停用了**这张模板，
 * 本单仍然按「启用」核销。这与 Mock 的读——它在原子区段里读同一份 store——
 * 只在「真的有并发停用」这一种情形下有差别，且**不产生自相矛盾的落库状态**
 * （券被核销、订单成立、模板停用，三者各自都是已提交的事实）。
 * 这是本轮**如实登记的已知残留**，不是被忽略的窗口。
 *
 * ## 并发的唯一保证是那条条件 `UPDATE`，不是前面的那次读
 *
 * `SELECT … → 判 unused → UPDATE` 这一串在 READ COMMITTED 下**不足以**防双花：
 * 两个事务可以双双读到 `unused`。真正把它堵死的是写入语句上的
 * `AND status = 'unused'`——两个并发 UPDATE 会在同一行上串行化，后到者在锁释放后
 * 按**新**快照重求值该谓词，于是改 0 行、返回 `used`。
 * 返回 `0 行` 因此是「券已经被这一单之外的人用掉了」的**唯一**信号，
 * 与 Mock 的 `status === 'used'` 闸同因（`COUPON_USE_USED_REASON`）。
 *
 * ## 失败**不抛错**
 *
 * 与 Mock 同：调用方（建单）要区分「券的问题」（用户可纠正、要看到原因）与
 * 「系统的问题」（抛错），因此这里返回失败种类。⚠️ 调用方拿到 `{ ok: false }` 时
 * **必须**让整个事务回滚（本仓的 T1 入口是**抛出一个内部信号**触发 ROLLBACK，
 * 见 `lib/data/pg/paymentRepository.ts`）——否则认领支付请求那一步会被提交，
 * 留下「支付成功但没有订单」。
 *
 * @param originalAmount 券的门槛基数（**优惠前应付**，裁定 §2），**不是实付**
 */
export async function redeemCouponClaimForOrderTx(
  tx: PgQueryable,
  input: { userId: string; claimId: string; originalAmount: number; at: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const claimRows = await tx.query<{
    id: string;
    user_id: string;
    coupon_id: string;
    status: CouponClaimStatus;
    snapshot: CouponSnapshot;
  }>(
    `SELECT id, user_id, coupon_id, status, snapshot FROM coupon_claims WHERE id = $1`,
    [input.claimId],
  );
  const claim = claimRows[0];
  // 与 Mock 同一句话：不区分「不存在」与「不属于你」，避免被用来试探
  if (!claim || claim.user_id !== input.userId) {
    return { ok: false, reason: COUPON_CLAIM_NOT_FOUND_REASON };
  }

  // Mock：`current.coupons.get(claim.couponId)?.enabled ?? false`——查不到模板按「未启用」
  const templateRows = await tx.query<{ enabled: boolean }>(
    `SELECT enabled FROM coupon_templates WHERE id = $1`,
    [claim.coupon_id],
  );
  const enabled = templateRows[0]?.enabled ?? false;

  // ⚠️ `at` 由调用方传入，且必须是**建单那一刻**（`order.createdAt`）——
  // 在 Mock 里核销时刻与订单创建时刻本来就是同一个 `at` 变量
  const application = resolveCouponApplication(
    { status: claim.status, snapshot: claim.snapshot },
    input.originalAmount,
    new Date(input.at),
    enabled,
  );
  if (!application.applicable) return { ok: false, reason: application.reason };

  // —— 写入：条件核销（并发下唯一赢家由这一行的行锁决定）——
  const used = await tx.query<{ id: string }>(
    `UPDATE coupon_claims
        SET status = 'used', used_at = $3
      WHERE id = $1 AND user_id = $2 AND status = 'unused'
      RETURNING id`,
    [input.claimId, input.userId, input.at],
  );
  if (!used[0]) return { ok: false, reason: COUPON_USE_USED_REASON };

  return { ok: true };
}

/**
 * 为一张**刚刚支付成功**的订单建立派单记录 —— `createDispatchForOrder` 的 **Pg 版本**。
 *
 * ## 冻结快照的规则一字不差
 *
 * 时长取 `platform_config` **此刻**的值（`readPlatformConfig(tx)`），并**当场冻结**成
 * `*TimeoutMinutesSnapshot` + 对应的 deadline：管理员之后改参数不影响这一单。
 * 两条分支只有一件事不同——**在哪一个池子里开始等人**：指定了打手进专属池
 * （`exclusivePoolTimeoutMinutes`），没指定直接进公共池（`publicPoolTimeoutMinutes`）。
 * 两条分支都**不写** `acceptedByCompanionId`：那一刻还没有人接单。
 *
 * ⚠️ `readPlatformConfig(tx)` 在**读不到 `id = 1` 那一行时抛错**，而 Mock 的
 * `readPlatformConfig()` 是兜底不抛的（store 恒有一份配置）。这是本仓 Pg 侧
 * 既定的取舍：不猜默认值，由种子保证那一行存在（见 `w1Transactions.ts` 该函数的注释）。
 *
 * ⚠️ 本函数**必须**在同一条连接、同一个提交点里被调用——订单与派单要么一起存在，
 * 要么一起不存在。分开写会留下「已付款、没人能接、也不会超时退款」的订单。
 */
export async function insertDispatchForOrderTx(
  tx: PgQueryable,
  input: { orderId: string; exclusiveCompanionId: string | null; at: string },
): Promise<void> {
  const config = await readPlatformConfigFrom(tx);
  const exclusive = input.exclusiveCompanionId !== null;

  await tx.query(
    `INSERT INTO dispatch_records (${DISPATCH_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      `dsp_${crypto.randomUUID()}`,
      input.orderId,
      exclusive ? "exclusive" : "public",
      input.exclusiveCompanionId,
      exclusive ? input.at : null,
      exclusive ? plusMinutes(input.at, config.exclusivePoolTimeoutMinutes) : null,
      exclusive ? config.exclusivePoolTimeoutMinutes : null,
      exclusive ? null : input.at,
      exclusive ? null : plusMinutes(input.at, config.publicPoolTimeoutMinutes),
      exclusive ? null : config.publicPoolTimeoutMinutes,
      null,
      null,
      null,
      null,
      input.at,
      input.at,
    ],
  );
}

/**
 * 订单退款（**事务内写入器**）—— `applyOrderRefund` 的 Pg 版本。
 *
 * ## 一单一退在这里是**结构性**的
 *
 * 两条短路（`isRefundExecutionClosed` 与「累计已退 ≥ 实付」）与 Mock 一字不差，
 * 且**必须一起看**：部分退款不改订单状态，因此一张 `serving` 单可以带着
 * `refundedAmount > 0` 被退回公共池、随后又走一遍超时退款——
 * 只看 `status !== 'refunded'` 就会在这里**再出一次款**。
 *
 * ## 金额是「这一次退多少」（增量），并且钳在「还剩多少」
 *
 * 与 Mock 同一条：`EX-REFUND-02` 把「累计已退不得超过实付」冻结为硬约束，
 * 而写入点就是这一行，于是这条不变式在**写入处**成为结构性的。
 *
 * ## `status` 只在退满时才改
 *
 * 部分退款**不改订单状态**——订单按原进度继续履约。因此返回的 `changed` 只说明
 * 「这一次出款真的发生了」，不说明订单变成了什么。
 *
 * ## 为什么还返回 `previous` / `updated`
 *
 * PROD-1C 加宽了返回值：T14（`approveRefund`）需要**写入器亲眼看到的前后两份订单**
 * ——审计快照的 `orderStatus` 与退券判定读的都是它们。让调用方在外面另读一次
 * 会得到一个可能与写入瞬间不同的快照（并发下），而「审计里记的订单状态」
 * 必须是**这次写入造成的那个变化**。`updated` 为 `null` 表示没更新到行（不可能状态）。
 */
export async function applyOrderRefundTx(
  tx: TxHandle,
  order: Order,
  at: string,
  refundedAmount?: number,
): Promise<{ changed: boolean; previous: Order; updated: Order | null }> {
  if (isRefundExecutionClosed(order) || order.refundedAmount >= order.actualPaidAmount) {
    return { changed: false, previous: order, updated: null };
  }

  const remainingAmount = order.actualPaidAmount - order.refundedAmount;
  const nextRefundedAmount =
    order.refundedAmount + Math.max(0, Math.min(refundedAmount ?? 0, remainingAmount));
  const fullyRefunded = nextRefundedAmount >= order.actualPaidAmount;

  const updatedRows = await tx.query<OrderRow>(
    `UPDATE orders
        SET status = $2,
            refunded_at = $3,
            refunded_amount = $4
      WHERE id = $1
      RETURNING ${ORDER_COLUMNS}`,
    [
      order.id,
      fullyRefunded ? "refunded" : order.status,
      // 「第一次退满」的时刻一旦写下就不刷新；部分退款不写它
      fullyRefunded ? (order.refundedAt ?? at) : order.refundedAt,
      nextRefundedAmount,
    ],
  );

  // `previous` 是**写入器亲眼看到的前一状态**——调用方（T14 的审计快照与退券判定）
  // 必须拿它，而不是事务开始时另读的那一份：并发下两者可能不同。
  return {
    changed: true,
    previous: order,
    updated: updatedRows[0] ? toOrder(updatedRows[0]) : null,
  };
}

/* ──────────────────── T3 · 派单超时清扫（自动转池 / 退款） ──────────────────── */

/** 一张派单现在还能不能被接。与 Mock 的 `isOpenPool` 一字不差。 */
function isOpenPool(state: DispatchRecord["state"]): state is "exclusive" | "public" {
  return state === "exclusive" || state === "public";
}

/**
 * 把已经到点的派单**物化**成事实（T3）—— `sweepExpiredDispatches` 的 Pg 实现。
 *
 * ## 一条到点的单可能连跳两级
 *
 * 服务停了一夜再启动，「专属池到点」与「公共池到点」都已经是过去的事了。
 * 因此每个候选沿**当前池**逐级追平：专属池先转公共池、公共池再关闭（未出过款时退款），
 * 最多两格。迁移时刻取的都是**到点那一刻**，不是「扫到它的那一刻」——
 * 因此同一个 `at` 调几次、隔多久调一次，写入的记录完全一样。
 *
 * ## 幂等是怎么成立的
 *
 * 只处理「当前池的 deadline 已到、且 `state` **仍然**是那个池」的记录。
 * 处理完 `state` 就变了，第二遍扫到时状态与池已经对不上，直接跳过——
 * 不重复转池、不重复退款、不重复发通知。并发下的第二道：所有候选订单先被锁住，
 * 因此另一条请求读到的必然是提交后的状态。
 *
 * ## 加锁：**先锁订单、再读派单**（见文件头）
 *
 * 候选集合由「有未关闭派单的订单」反查而来，第一把锁因此落在 `orders` 上，
 * 与 T2 / T12 一致。派单与订单是 1:1，而**任何改派单的路径都先持有订单锁**
 * （T2 / T12 / T4 / T6 / T7 都如此），因此这里不必再给派单单独上一把锁——
 * 持有订单锁已经足以让这张派单在本事务内保持不动。
 *
 * ⚠️ 这是一条**全局扫一遍**的事务（Mock 本来就是全局的：单线程 + 同步区段）。
 * 锁住的是「未关闭派单所对应的那些订单」——绝大多数订单的派单早已终结，
 * 因此集合很小。
 */
export async function sweepExpiredDispatchesPg(at: string): Promise<DispatchSweepResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    let orders: OrderRow[];
    try {
      // `ORDER BY o.id`：一次要锁多行，必须让并发事务以同一顺序取锁（见文件头）
      orders = await tx.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders o
          WHERE EXISTS (
                SELECT 1 FROM dispatch_records d
                 WHERE d.order_id = o.id
                   AND d.state IN ('exclusive', 'public'))
          ORDER BY o.id
            FOR UPDATE`,
      );
    } catch (error) {
      // 并发的 T2 可能正好把最后一张派单接走，让这条语句与它撞上。交给调用方重试，
      // 而不是在这里吞掉——「清扫没跑成」必须让人看见，不能假装扫完了
      throw error;
    }

    // 配置在这一次清扫里读**一次**：整段在同一事务里，中途不可能被改
    const config = await readPlatformConfig(tx);

    const movedToPublic: string[] = [];
    const refunded: string[] = [];

    for (const orderRow of orders) {
      const order = toOrder(orderRow);

      const recordRows = await tx.query<DispatchRow>(
        `SELECT ${DISPATCH_COLUMNS} FROM dispatch_records WHERE order_id = $1`,
        [order.id],
      );
      if (!recordRows[0]) continue;
      const record = toDispatch(recordRows[0]);
      if (!isOpenPool(record.state)) continue;

      // 从当前池开始追平：每一轮只前进一格，最多两格（专属 → 公共 → 关闭）
      let state: "exclusive" | "public" = record.state;
      let deadlineAt = currentDeadlineAt(record);

      while (deadlineAt !== null && Date.parse(deadlineAt) <= Date.parse(at)) {
        const atDeadline = deadlineAt;

        if (state === "exclusive") {
          // 专属池到点：**不进退款**——订单还在等人接。
          // 进入公共池的时刻取「专属池到点那一刻」，公共池的计时从那里开始
          const publicDeadlineAt = plusMinutes(atDeadline, config.publicPoolTimeoutMinutes);
          // 通知在写之前构造并校验（含 id）：非法文案要在订单被改掉之前抛出来
          const notification = planNotification({
            userId: order.userId,
            kind: "dispatch",
            content: DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT,
            href: `/orders/${order.id}`,
            at: atDeadline,
          });

          await tx.query(
            `UPDATE dispatch_records
                SET state = 'public',
                    public_pool_entered_at = $2,
                    public_deadline_at = $3,
                    public_timeout_minutes_snapshot = $4,
                    accepted_by_companion_id = NULL,
                    accepted_at = NULL,
                    accepted_via = NULL,
                    updated_at = $2
              WHERE id = $1`,
            [record.id, atDeadline, publicDeadlineAt, config.publicPoolTimeoutMinutes],
          );
          await appendNotification(tx, notification);
          movedToPublic.push(record.id);

          state = "public";
          deadlineAt = publicDeadlineAt;
          continue;
        }

        // 公共池到点：停止接取 + **自动退款**（未出过款时）。不是售后、不等审核。
        //
        // ⚠️ 「出过款」在**计划阶段**就判好，并把结论写进 `refundDue`——
        //    不能让存储层静默拒掉，那样 `refundedOrderIds` 会报假账。
        //    `actualPaidAmount > 0` 那一半同理：实付 0 的坏单子不得被写成「凭空退满」。
        const refundDue = !isRefundExecutionClosed(order) && order.actualPaidAmount > 0;
        const notification = refundDue
          ? planNotification({
              userId: order.userId,
              kind: "dispatch",
              content: DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT,
              href: `/orders/${order.id}`,
              at: atDeadline,
            })
          : null;

        // ⚠️ 关闭与退款写的都是**到点那一刻**，不是「扫到它的那一刻」
        await tx.query(
          `UPDATE dispatch_records
              SET state = 'timed_out', timed_out_at = $2, updated_at = $2
            WHERE id = $1`,
          [record.id, atDeadline],
        );

        // `null` = 这一单已经出过款（一单一退）。**关池照做**——池子里的记录必须收掉，
        // 否则下一次清扫还会看到它；只是不再出第二笔钱
        if (refundDue) {
          const written = await applyOrderRefundTx(
            tx,
            order,
            atDeadline,
            // 未出过款时 `refundedAmount` 必为 0，因此这里就是实付。仍然写成差值：
            // 形式正确，且不依赖「还没出过款」这个前提在本处成立
            order.actualPaidAmount - order.refundedAmount,
          );
          // 退券紧跟在「退款真的发生了」之后。这一段里的订单全部是在公共池里
          // 等到超时的，自然是「从未被承接」——但判据仍然交给同一个函数，
          // 不在这里手写「超时 ⇒ 没接过」：那是本条路径今天的性质，不是规则
          if (written.changed) {
            await restoreCouponClaimForOrderTx(tx, {
              userId: order.userId,
              everAcceptedAt: order.everAcceptedAt,
              claimId: order.coupon?.claimId ?? null,
            });
          }
          refunded.push(order.id);
        }

        // 已经出过款的订单不再发一条重复的退款通知——它当初退款时的通知已经发过了
        if (notification) await appendNotification(tx, notification);
        break;
      }
    }

    return { movedToPublicDispatchIds: movedToPublic, refundedOrderIds: refunded };
  });
}

/* ═════════════ T4/T5/T6/T7 · 履约绑定的建立与解除（P0-6 / P0-7 / P0-11） ═════════════ */

/**
 * 「作废 pending 完成材料 → 写退出历史 → 清当前履约绑定 → 派单的去向 → 通知」
 * 的事务内实现 —— `releaseCurrentAssignment` 的 Pg 版本。
 *
 * ## 一次解除必须同时成立的**五**件事
 *
 * 缺任何一件都会留下自相矛盾的状态：只有清绑定是「订单没主了但派单还说被 A 接了」，
 * 只有派单回池是「派单空着但订单还挂在 A 名下」，只有退出历史是「历史里没有这次退出」，
 * 只有通知是「用户以为还有人给他做」，而**只有不作废在途完成材料**最阴——
 * 那份材料的 `autoApprovalDeadlineAt` 一到就会自动通过，把一张已经换了人的订单
 * 判成已完成（`EX-COMP-02`）。
 *
 * ## 为什么作废必须排在**整段写的第一步**
 *
 * 它是这五件事里**唯一可能失败**的一件（材料状态与中央状态机对不上 = 数据被写坏）。
 * 排在第一步，失败时区段里还没有任何写入（事务回滚也已经是空的），整件事干净地失败。
 *
 * ## 加锁顺序：调用方**已经持有订单锁**
 *
 * 见文件头「`orders` 永远是第一把锁」。这里再锁 `completion_submissions`
 * （材料那一行）与 `dispatch_records`，顺序都在订单之后。
 *
 * ## `idempotencyKey` 允许为 `null`
 *
 * 只有打手主动取消那条路径有幂等键。为 `null` 时不写这一列——
 * 编一个键塞进去，就等于把「调用方给的一个串」伪装成业务事实。
 * 非 `null` 时它落在 `companion_release_records.idempotency_key` 上，
 * 由部分唯一索引 `(companion_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
 * 保证「同一打手 + 同一键只产生一条退出记录」。
 */
export async function releaseCurrentAssignmentTx(
  tx: TxHandle,
  input: {
    orderId: string;
    dispatchId: string;
    companionId: string;
    source: CompanionReleaseSource;
    reason: string | null;
    actorId: string | null;
    idempotencyKey: string | null;
    at: string;
    /** 此刻的平台公共池超时（分钟）。调用方读一次、整段用同一份 */
    publicPoolTimeoutMinutes: number;
    notification: Notification;
    /** `null` = 派单回公共池；非 null = 直接改绑给这位打手（客服直接换人） */
    reassign: { companionId: string; companion: OrderCompanionSnapshot } | null;
  },
): Promise<{ kind: "ok"; releaseId: string } | { kind: "inconsistent"; orderId: string }> {
  /* —— 第 1 件：这一单当前的 pending 完成材料立即作废（唯一可能失败的一件）—— */
  const pending = await tx.query<{ id: string; status: string }>(
    `SELECT id, status FROM completion_submissions
      WHERE order_id = $1 AND status = 'pending'
      FOR UPDATE`,
    [input.orderId],
  );
  const submission = pending[0];
  if (submission) {
    // ⚠️ 两道门在 SQL 与这里合一：`WHERE status = 'pending'` 同时是领域 Guard
    //    （索引只装 pending），而 `canTransitionCompletion` 仍是**中央状态机**的
    //    结构校验——「新增状态该改哪里」这件事只有一个出处。
    //    与 Mock 的 `inspectPendingCompletion` 同一口径：对不上就是数据被写坏，
    //    整件事失败，不假装作废成功
    if (!canTransitionCompletion(submission.status as CompletionSubmissionStatus, "invalidated")) {
      return { kind: "inconsistent", orderId: input.orderId };
    }
    await tx.query(
      `UPDATE completion_submissions
          SET status = 'invalidated',
              invalidated_at = COALESCE(invalidated_at, $2)
        WHERE id = $1`,
      [submission.id, input.at],
    );
  }

  /* —— 第 2 件：退出历史（同一段里写下幂等键，键与记录同生共死）—— */
  const releaseId = `rel_${crypto.randomUUID()}`;
  await tx.query(
    `INSERT INTO companion_release_records
       (id, order_id, companion_id, source, reason, actor_id, created_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      releaseId,
      input.orderId,
      input.companionId,
      input.source,
      input.reason,
      input.actorId,
      input.at,
      input.idempotencyKey,
    ],
  );

  /* —— 第 3、4 件：订单与派单必须在**同一个事务**里写 —— */
  // ⚠️ `ever_accepted_at` **刻意不在这里**：它不是履约绑定，是历史事实——
  //    「这一单有没有被承接」一旦写上就不再变。清掉它会让
  //    「accepted → 回池 → paid → 用户退款」这条路径把券错误地还给用户。
  // ⚠️ `serving_at` 一并清空：它表达「**当前这位**打手从何时开始服务」，
  //    不清的话新打手点「开始服务」会沿用上一任的开始时间。
  await tx.query(
    `UPDATE orders
        SET status = 'paid',
            accepted_at = NULL,
            actual_companion_id = NULL,
            companion = NULL,
            serving_at = NULL
      WHERE id = $1`,
    [input.orderId],
  );

  if (input.reassign) {
    /*
     * `accepted_via = 'staff'`：**订单进入 `accepted`，但不产生接单事件**（P1-5 §九-F）。
     *
     * 客服「直接换人 / 直接指定新打手」不计入接单榜——接单榜数的是打手**自己**
     * 成功执行接单动作的次数。因此这里**不写** `companion_accept_events`：
     * 「订单进入 accepted」与「产生接单事件」是两个概念，即使底层复用了同一次
     * 状态迁移，也不得把 Staff assignment 当成 Companion accept event。
     *
     * ⚠️ 而 `accepted_via` **不是备注，是防线的另一半**：存量派生通道
     * （`deriveLegacyAcceptEvents`）只能靠这个字段分辨「被换进来的」与「自己接的」。
     */
    await tx.query(
      `UPDATE dispatch_records
          SET state = 'accepted',
              accepted_by_companion_id = $2,
              accepted_at = $3,
              accepted_via = 'staff',
              updated_at = $3
        WHERE id = $1`,
      [input.dispatchId, input.reassign.companionId, input.at],
    );
    await tx.query(
      `UPDATE orders
          SET status = 'accepted',
              accepted_at = $2,
              actual_companion_id = $3,
              companion = $4::jsonb,
              -- 「曾经被承接」只写第一次：后来的第二个打手接手不刷新它
              ever_accepted_at = COALESCE(ever_accepted_at, $2)
        WHERE id = $1`,
      [
        input.orderId,
        input.at,
        input.reassign.companionId,
        JSON.stringify(input.reassign.companion),
      ],
    );
  } else {
    // 回公共池：**按此刻的配置重冻**三个 public 字段，并清空当前接单绑定。
    // ⚠️ `accepted_via` 必须与 `accepted_by_companion_id` 一起清——绑定的**来源**
    //    也是绑定的一部分，漏清就是「这一单现在没人接，却记着上次是谁绑上去的」
    await tx.query(
      `UPDATE dispatch_records
          SET state = 'public',
              public_pool_entered_at = $2,
              public_deadline_at = $3,
              public_timeout_minutes_snapshot = $4,
              accepted_by_companion_id = NULL,
              accepted_at = NULL,
              accepted_via = NULL,
              updated_at = $2
        WHERE id = $1`,
      [
        input.dispatchId,
        input.at,
        plusMinutes(input.at, input.publicPoolTimeoutMinutes),
        input.publicPoolTimeoutMinutes,
      ],
    );
  }

  /* —— 第 5 件：通知 —— */
  await appendNotification(tx, input.notification);

  return { kind: "ok", releaseId };
}

/**
 * 当前实际履约的打手**主动取消接单**（T4）—— `cancelAcceptedOrder` 的 Pg 实现。
 *
 * ## 判定顺序（先验证意图，再原子写入）
 *
 * 1. **先查幂等键**——命中就是「同一次取消的第二次到达」，原样返回第一次的结果，
 *    一个字节都不写。⚠️ 键被**误用到别的单上**时不返回那条记录：那会把别人订单的
 *    状态当成这次请求的结果；
 * 2. **再取订单**——不存在、或 `actualCompanionId` 不是本人，一律 `not-found`：
 *    两种情况的对外表现必须完全相同，否则可以用别人的订单 id 试探它是否存在；
 * 3. **再看状态**——不是 `accepted` 就 `not-accepted`，**绝不**把 `serving` /
 *    `completed` / `refunded` 拉回 `paid`。这不是重放，是「你点了一个此刻不该存在的按钮」；
 * 4. **读一次平台配置**，把公共池超时**当下**的值冻结进这一单的新截止时间。
 *    用启动时的旧值、或硬编码一个时长，都是第二套 timeout 算法；
 * 5. 通知在进入写入之前构造并校验完（含 id）；
 * 6. 五件事一次写完。
 *
 * ⚠️ `ctx.companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 事务层不认识请求体、不认识 Cookie。
 */
export async function cancelAcceptedOrderPg(
  ctx: CompanionWriteContext & { orderId: string; reason: string; idempotencyKey: string },
): Promise<CompanionCancelOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：幂等键（命中即返回，不进入写入区段）—— */
    const replayRows = await tx.query<{ id: string; order_id: string; created_at: string }>(
      `SELECT id, order_id, created_at FROM companion_release_records
        WHERE companion_id = $1 AND idempotency_key = $2`,
      [ctx.companionId, ctx.idempotencyKey],
    );
    const replay = replayRows[0];
    if (replay) {
      // 键被误用到**别的单上**时不认它——按 not-found 回答，而不是把别人订单的结果
      // 当成这次请求的结果（用户会看到一张自己没操作过的单号）
      if (replay.order_id !== ctx.orderId) return { kind: "not-found" };
      const replayOrder = await tx.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
        [replay.order_id],
      );
      if (!replayOrder[0]) return { kind: "not-found" };
      return {
        kind: "replayed",
        orderId: replay.order_id,
        orderNo: replayOrder[0].order_no,
        status: "paid",
        releaseRecordId: replay.id,
        // 第一次的时刻，不是现在：重放不刷新任何时间
        cancelledAt: replay.created_at,
        changed: false,
      };
    }

    /* —— 第 2 步：订单存在，且**当前履约人就是我** —— */
    const orderRow = await lockOrder(tx, ctx.orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);
    if (order.actualCompanionId !== ctx.companionId) return { kind: "not-found" };

    /* —— 第 3 步：状态必须**恰好**停在 accepted —— */
    if (order.status !== "accepted") return { kind: "not-accepted", status: order.status };

    /* —— 第 4 步：这一单对应的派单记录 —— */
    // 订单说「A 在履约」却查不到派单记录：数据已经不自洽。此时**宁可整件事失败**，
    // 也不能只把订单退回 paid——那张单会既不在任何池子里、也没人能再接
    const recordRow = await lockDispatchByOrder(tx, order.id);
    if (!recordRow) return { kind: "not-found" };

    /* —— 第 5 步：写入之前把通知与配置备好 —— */
    const notification = planNotification({
      userId: order.userId,
      kind: "dispatch",
      content: DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
      href: `/orders/${order.id}`,
      at: ctx.at,
    });
    // 公共池超时读**当前**配置：用户与后来接单的打手被承诺的是「重新进池那一刻的规则」
    const config = await readPlatformConfig(tx);

    /* —— 第 6 步：五件事一次写完 —— */
    const written = await releaseCurrentAssignmentTx(tx, {
      orderId: order.id,
      dispatchId: recordRow.id,
      companionId: ctx.companionId,
      source: "companion_cancel",
      reason: ctx.reason,
      // 主动取消的触发者就是打手本人
      actorId: ctx.companionId,
      idempotencyKey: ctx.idempotencyKey,
      at: ctx.at,
      publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
      notification,
      // 打手自己取消：这一单**没有人接替**，派单回公共池等别人来
      reassign: null,
    });
    // 唯一可能失败的一件发生在任何写入之前——如实报 500，不编一个「已取消」的结果
    if (written.kind === "inconsistent") {
      return { kind: "inconsistent", orderId: order.id };
    }

    return {
      kind: "ok",
      orderId: order.id,
      orderNo: order.orderNo,
      status: "paid",
      releaseRecordId: written.releaseId,
      cancelledAt: ctx.at,
      changed: true,
    };
  });
}

/**
 * 当前实际履约的打手**开始服务**（T5，`accepted → serving`）—— `startCompanionOrder` 的 Pg 实现。
 *
 * ## 判定顺序（先验证意图，再原子写入）
 *
 * ```
 * 1. 订单不存在 / actualCompanionId ≠ 我   → not-found（对外 404，不泄露存在性）
 * 2. status === "serving"                  → replayed（已经是我的服务中订单）
 * 3. 结构校验 canTransitionOrder(…, serving) → false 则 not-startable
 * 4. 领域 Guard：status 必须恰好是 accepted → false 则 not-startable
 * 5. 原子写入：订单 → serving + servingAt，**并追加一条服务历史**
 * ```
 *
 * - **第 1 步先于第 2 步**：归属是**事实**，状态只是它的属性。先看状态的话，
 *   别人就能拿一个订单 id 试探出「这一单已经开始服务了」。
 * - **第 2 步必须早于第 3 步**：`serving → serving` **不在**中央状态表里，
 *   先做结构校验会把一次重复点击判成「非法迁移」（400），而它本来只是一次重放。
 * - **第 3、4 步语义不同，两道门都要留**：结构表回答「这条边存不存在」，
 *   领域 Guard 回答「这一单此刻就站在这条边的起点上吗」。
 * - **幂等判据是状态本身，不是幂等键**：这个动作没有附属记录要找回、
 *   请求体也是空的，状态就是那次操作的结果。
 *
 * ## 为什么必须留下服务历史（P1-7）
 *
 * `Order.servingAt` 表达的是「**当前这位**打手从何时开始服务」，换人回池时会被清空——
 * 于是 A 服务过、后来换成 B，**A 的服务时刻就再也不存在**。而「常用打手」正要以
 * 「谁真实服务过」为准。因此这条历史与订单写入在**同一个事务**里，不可能出现
 * 「订单写着服务中、历史里却没有这次服务」。
 *
 * ⚠️ 去重交给**唯一约束** `companion_service_events_segment_key`
 * `(order_id, companion_id, serving_at)`——它正是「同一服务段只记一次」这条规则
 * 在 DB 层的落点，因此这里是 `ON CONFLICT DO NOTHING`，不是「先查再插」。
 */
export async function startCompanionOrderPg(
  ctx: CompanionWriteContext & { orderId: string },
): Promise<CompanionStartOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：订单存在，且**当前履约人就是我** —— */
    const orderRow = await lockOrder(tx, ctx.orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);
    if (order.actualCompanionId !== ctx.companionId) return { kind: "not-found" };

    /* —— 第 2 步：已经是我的服务中订单 → 重放 —— */
    if (order.status === "serving") {
      return {
        kind: "replayed",
        orderId: order.id,
        orderNo: order.orderNo,
        status: "serving",
        // **第一次**开始的时刻，不是现在。这里是「状态已是 serving 但 servingAt 从未写下」
        // 的历史脏数据唯一可能露面的地方——如实给 null，不编一个开始时间出来
        servingAt: order.servingAt,
        changed: false,
      };
    }

    /* —— 第 3 步：结构校验（中央状态机）—— */
    if (!canTransitionOrder(order.status, "serving")) {
      return { kind: "not-startable", status: order.status };
    }

    /* —— 第 4 步：领域 Guard —— */
    // ⚠️ 与第 3 步并列存在，不是它的重复：能走到这里的状态今天恰好只剩 accepted，
    //    但这句才是「这一单此刻允许开始服务吗」的答案。删掉它，将来状态表一变宽，
    //    权限就跟着变宽了——那就成了「状态机即权限」
    if (order.status !== "accepted") return { kind: "not-startable", status: order.status };

    /* —— 第 5 步：原子写入（订单 → serving + servingAt）—— */
    // 已经写过的时刻原样保留（`COALESCE` 而不是直接赋值）：与 Mock 的 `?? at` 同一写法，
    // 防的是「状态还是 accepted 但 servingAt 已有值」的历史脏数据。
    // 第 2、4 步都已在行锁下排除「此刻已经是 serving」，因此这里必然真的改了状态
    const writtenRows = await tx.query<OrderRow>(
      `UPDATE orders
          SET status = 'serving',
              serving_at = COALESCE(serving_at, $2)
        WHERE id = $1
        RETURNING ${ORDER_COLUMNS}`,
      [order.id, ctx.at],
    );
    if (!writtenRows[0]) return { kind: "not-found" };
    const updated = toOrder(writtenRows[0]);

    const dispatchRows = await tx.query<{ id: string }>(
      `SELECT id FROM dispatch_records WHERE order_id = $1`,
      [updated.id],
    );

    await tx.query(
      `INSERT INTO companion_service_events
         (id, order_id, companion_id, dispatch_id, serving_at, companion_name, companion_avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id, companion_id, serving_at) DO NOTHING`,
      [
        `svc_${crypto.randomUUID()}`,
        updated.id,
        updated.actualCompanionId ?? ctx.companionId,
        dispatchRows[0]?.id ?? null,
        updated.servingAt ?? ctx.at,
        // 快照取订单上那一份；历史脏数据可能没有——那时如实给空串（两列都是 NOT NULL），
        // 由展示层回落到「已服务打手」这类中性文案，而不是凭空造一个名字
        updated.companion?.name ?? order.companion?.name ?? "",
        updated.companion?.avatarUrl ?? order.companion?.avatarUrl ?? "",
      ],
    );

    return {
      kind: "ok",
      orderId: updated.id,
      orderNo: updated.orderNo,
      status: "serving",
      servingAt: updated.servingAt,
      changed: true,
    };
  });
}

/**
 * 客服把这一单**退回公共池**（T6，`accepted` / `serving` 均可）—— `releaseOrderByStaff` 的 Pg 实现。
 *
 * ## 判定顺序
 *
 * ```
 * 1. 订单不存在                       → not-found（404）
 * 2. 结构校验 canTransitionOrder(…, paid) → not-releasable（400）
 * 3. 领域 Guard：状态恰好是 accepted / serving，且有实际履约人 → not-releasable
 * 4. 派单记录不在                      → dispatch-missing（500）
 * 5. 写入之前备好通知（含校验与 id）+ 读一次平台配置
 * 6. 五件事一次写完
 * ```
 *
 * - **第 2、3 步语义不同，两道门都要留**：结构表回答「这条边存不存在」，
 *   领域 Guard 回答「这一单此刻就站在这条边的起点上吗」。
 * - **第 3 步也检查 `actualCompanionId`**：状态说「有人在履约」而字段是空的历史脏数据，
 *   在这里被挡住，而不是写一条 `companionId` 为空的退出历史。
 * - **没有幂等键**：与打手取消刻意不同。客服侧的这个动作重复到达时，订单已经不在
 *   履约中，第 3 步会给出 `not-releasable` 与**当前状态**——那正是使用者需要的答案。
 *
 * ⚠️ `input.staffId` **只允许**来自 `requireStaff()` 返回的会话身份。
 */
export async function releaseOrderByStaffPg(input: {
  orderId: string;
  staffId: string;
  reason: string;
  at: string;
}): Promise<StaffOrderReleaseOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：订单存在 —— */
    const orderRow = await lockOrder(tx, input.orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);

    /* —— 第 2 步：结构校验（中央状态机）—— */
    if (!canTransitionOrder(order.status, "paid")) {
      return { kind: "not-releasable", status: order.status };
    }

    /* —— 第 3 步：领域 Guard —— */
    if (order.status !== "accepted" && order.status !== "serving") {
      return { kind: "not-releasable", status: order.status };
    }
    // 走完上一步之后这一条今天恒成立（能回到 paid 的只有这两个状态）。
    // 留着它是因为「谁在履约」是**事实**字段，不是状态的函数
    if (!order.actualCompanionId) return { kind: "not-releasable", status: order.status };

    /* —— 第 4 步：这一单对应的派单记录 —— */
    const recordRow = await lockDispatchByOrder(tx, order.id);
    if (!recordRow) return { kind: "dispatch-missing" };

    /* —— 第 5 步：写入之前把通知与配置备好 —— */
    const notification = planNotification({
      userId: order.userId,
      kind: "dispatch",
      content: DISPATCH_NOTIFICATION_STAFF_REASSIGNED,
      href: `/orders/${order.id}`,
      at: input.at,
    });
    const config = await readPlatformConfig(tx);

    /* —— 第 6 步：五件事一次写完 —— */
    const written = await releaseCurrentAssignmentTx(tx, {
      orderId: order.id,
      dispatchId: recordRow.id,
      companionId: order.actualCompanionId,
      source: "staff_reassign",
      reason: input.reason,
      actorId: input.staffId,
      // 客服触发的解除没有幂等键（幂等判据是状态本身）
      idempotencyKey: null,
      at: input.at,
      publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
      notification,
      // 退回公共池：等**其他**护航来接，此刻还没有接替者
      reassign: null,
    });
    if (written.kind === "inconsistent") return { kind: "inconsistent", orderId: order.id };

    return {
      kind: "ok",
      orderId: order.id,
      orderNo: order.orderNo,
      previousStatus: order.status as "accepted" | "serving",
      releaseRecordId: written.releaseId,
      releasedAt: input.at,
      changed: true,
    };
  });
}

/**
 * 客服**直接指定新打手**接替这一单（T7，`accepted` / `serving` 均可）
 * —— `replaceOrderCompanionByStaff` 的 Pg 实现。
 *
 * 与 T6 共用同一个写入器，差别只有派单的去向：这里**不回公共池**，而是在同一个事务里
 * 改绑给新打手，并把订单 `→ paid → accepted`（`01-prompt.md` §三：不得让中间那个
 * `paid` 暴露给并发抢单）。两个中间态在事务提交之前都不会被任何读者看到。
 *
 * ## 判定顺序
 *
 * ```
 * 1. 订单不存在                          → not-found（404）
 * 2. 结构校验 + 领域 Guard（accepted/serving，且有履约人）→ not-replaceable（400）
 * 3. 指定的就是此刻正在履约的那位        → same-companion（400）
 * 4. 打手记录不存在                      → companion-not-found（400）
 * 5. 资格：复用 isCompanionAcceptingOrders → companion-unavailable（400）
 * 6. 指定的人是下单用户本人              → self-order（400）
 * 7. 派单记录不在                        → dispatch-missing（500）
 * 8. 写入之前备好通知 + 读一次平台配置
 * 9. 五件事一次写完（订单连写两次，派单改绑）
 * ```
 *
 * - **第 3 步先于第 4、5 步**：指定的就是他本人时，说「他当前不能接单」是反的
 *   ——他正在做着这一单。`same-companion` 才是这件事的准确说法。
 * - **第 5 步复用 `isCompanionAcceptingOrders()`**：仓库里「这位打手此刻能不能接新的单」
 *   只有这一个谓词。新写一个「换人时用的资格判定」就会出现两套资格口径，
 *   而它们迟早会对同一个打手给出不同答案。
 * - **第 6 步与接单的 `self-order` 同一条规则、同一个写法**（显式判 `userId !== null`，
 *   否则 `null === null` 会把一位没有绑定微信的打手误判成「自己给自己下单」）。
 *
 * ⚠️ 换人对**新打手**而言不是「跳过接单」：他拿到的状态与他自己点接单完全一样
 * （`accepted`），「开始服务」与完成材料仍然由他本人做。
 */
export async function replaceOrderCompanionByStaffPg(input: {
  orderId: string;
  newCompanionId: string;
  staffId: string;
  at: string;
}): Promise<StaffOrderReplaceOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：订单存在 —— */
    const orderRow = await lockOrder(tx, input.orderId);
    if (!orderRow) return { kind: "not-found" };
    const order = toOrder(orderRow);

    /* —— 第 2 步：结构校验 + 领域 Guard —— */
    if (!canTransitionOrder(order.status, "paid")) {
      return { kind: "not-replaceable", status: order.status };
    }
    if (order.status !== "accepted" && order.status !== "serving") {
      return { kind: "not-replaceable", status: order.status };
    }
    if (!order.actualCompanionId) {
      return { kind: "not-replaceable", status: order.status };
    }

    /* —— 第 3 步：指定的就是他本人 —— */
    if (order.actualCompanionId === input.newCompanionId) {
      return { kind: "same-companion" };
    }

    /* —— 第 4 步：打手记录存在 —— */
    const next = await readCompanion(tx, input.newCompanionId);
    if (!next) return { kind: "companion-not-found" };

    /* —— 第 5 步：资格（复用仓库里唯一的那个谓词）—— */
    if (!isCompanionAcceptingOrders(next)) return { kind: "companion-unavailable" };

    /* —— 第 6 步：禁止自接单（EX-DISPATCH-08）—— */
    if (next.userId !== null && order.userId === next.userId) return { kind: "self-order" };

    /* —— 第 7 步：这一单对应的派单记录 —— */
    const recordRow = await lockDispatchByOrder(tx, order.id);
    if (!recordRow) return { kind: "dispatch-missing" };

    /* —— 第 8 步：写入之前把通知与配置备好 —— */
    const notification = planNotification({
      userId: order.userId,
      kind: "dispatch",
      content: DISPATCH_NOTIFICATION_STAFF_REPLACED,
      href: `/orders/${order.id}`,
      at: input.at,
    });
    // 直换**不经过公共池**，因此这次读到的超时不会被写进任何字段。
    // 仍然读它，是因为写入器对两种去向收同一份入参——为一条分支省一次读，
    // 换来的是两个签名与两个调用点，而那笔复杂度比一次纯函数调用贵
    const config = await readPlatformConfig(tx);

    /* —— 第 9 步：五件事一次写完 —— */
    const written = await releaseCurrentAssignmentTx(tx, {
      orderId: order.id,
      dispatchId: recordRow.id,
      // 退出历史记的是**被解除的那位**，不是新来的
      companionId: order.actualCompanionId,
      source: "staff_reassign",
      reason: null,
      actorId: input.staffId,
      idempotencyKey: null,
      at: input.at,
      publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
      notification,
      // 新打手接手：派单不回池，直接改绑
      reassign: {
        companionId: next.id,
        // 与 `acceptDispatch` 写的是同一种快照：之后他改昵称换头像，这一单的展示不受影响
        companion: toOrderCompanionSnapshot(next),
      },
    });
    if (written.kind === "inconsistent") return { kind: "inconsistent", orderId: order.id };

    return {
      kind: "ok",
      orderId: order.id,
      orderNo: order.orderNo,
      previousStatus: order.status as "accepted" | "serving",
      previousCompanionId: order.actualCompanionId,
      newCompanionId: next.id,
      releaseRecordId: written.releaseId,
      replacedAt: input.at,
      changed: true,
    };
  });
}
