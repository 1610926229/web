import { isCompanionAcceptingOrders, toOrderCompanionSnapshot } from "@/lib/constants/companions";
import {
  DISPATCH_NOTIFICATION_ACCEPTED,
  DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT,
  DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT,
  EXCLUSIVE_WAIT_MINUTES,
  plusMinutes,
} from "@/lib/constants/dispatch";
import { parseNotificationInput } from "@/lib/constants/service";
import type { CompanionWriteContext, DispatchAcceptResult, DispatchRecord } from "@/lib/types/dispatch";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import { readCompanionRecord } from "./mockCompanionRepository";
import {
  applyDispatchAccepted,
  applyDispatchTimedOut,
  applyDispatchToPublic,
  createDispatchRecord,
  dispatchStore,
} from "./mockDispatchRepository";
import { appendNotification, newNotificationId } from "./mockNotificationRepository";
import { applyOrderAccepted, applyOrderRefund, paymentStore } from "./mockPaymentRepository";
import { readPlatformConfig } from "./mockPlatformConfigRepository";

/**
 * 派单域的伪事务（P0-5）—— **唯一**能改派单与订单归属的地方。
 *
 * ## 原子性是怎么成立的
 *
 * 本文件里所有函数**没有一个 `await`**。Node 是单线程的，「读—判断—写」之间只要
 * 不让出执行权，别的请求就插不进来。因此每个函数整体就是一段原子区段，
 * 下面用注释标出的边界只是为了让「哪里开始写」一眼可见——
 * **在标注的边界之后加一个 `await` 就是 bug**，哪怕加的是 `await Promise.resolve()`。
 *
 * 三个必须原子的事实（少了任何一条，系统都会进入自相矛盾的状态）：
 *
 * 1. **接单**：派单说「被 A 接了」与订单说「实际打手是 A」必须同时成立；
 * 2. **转公共池**：状态与新的截止时间必须一起变；
 * 3. **超时退款**：派单关闭、订单退款、通知发出必须一起发生。
 *
 * ## 为什么没有幂等键
 *
 * 管理端的写操作靠幂等键 + 审计表认出「同一个意图第二次到达」。派单这里**不能照搬**：
 * 那些表是**管理操作审计**（`lib/data/adminWriteSupport.ts`），打手接单不是管理行为，
 * 往里写会让审计表变成一本什么都记的流水。
 *
 * 这里用的是更结实的一种幂等：**状态本身**。
 * - 接单：`state === "accepted"` 且 `acceptedByCompanionId` 就是我自己 → 就是这次意图的重放，
 *   原样返回成功，不重写、不重复发通知；换成别人 → 被别人接走了，明确拒绝。
 * - 超时清扫：只处理「当前池的 deadline 已到、且 state 仍是那个池」的记录，
 *   处理完 state 就变了，连跑二十次与跑一次结果完全相同。
 *
 * 这比幂等键更强：键是调用方给的一个串，而状态是**事实**。
 */

/* ───────────────────────── 建单：订单诞生即建派单 ───────────────────────── */

export type CreateDispatchInput = {
  orderId: string;
  /** 用户在下单时**指定**的打手；null 表示没指定，直接进公共池 */
  exclusiveCompanionId: string | null;
  /** 支付成功那一刻 */
  at: string;
};

/**
 * 为一张**刚刚支付成功**的订单建立派单记录（**同步**）。
 *
 * ⚠️ **同步**是刻意的，不是省事：它在支付仓储的原子区段内被调用
 * （`lib/services/checkout.ts` 的 `buildOrderFromRequest` → `confirmPaymentRequest`）。
 * 改成 `async` 就意味着那个区段里会出现 `await`，于是「订单存在了但还没有派单记录」
 * 那一刻会真的暴露给别的请求——用户会看到一张没有截止时间、没人能接、也不会退款的订单。
 *
 * 平台配置在这里**同步**读（`readPlatformConfig()`）：配置的记录值回答「现在新发生的
 * 业务按什么规则走」，读到的这一刻就冻结进快照，之后后台改参数不影响这一单。
 *
 * 两条分支的区别只有一件事：**在哪一个池子里开始等人**。
 * - 指定了打手 → 专属池，固定 10 分钟（`EXCLUSIVE_WAIT_MINUTES`，不可配置）；
 * - 没指定 → 公共池，时长取当下的平台配置。
 *
 * 两条分支都**不写** `acceptedByCompanionId`：那一刻还没有人接单。
 * 用户指定 A 只是「用户想要 A」，A 随时可以不接。
 */
export function createDispatchForOrder(input: CreateDispatchInput): DispatchRecord {
  const config = readPlatformConfig();
  const exclusive = input.exclusiveCompanionId !== null;

  return createDispatchRecord({
    id: `dsp_${crypto.randomUUID()}`,
    orderId: input.orderId,
    state: exclusive ? "exclusive" : "public",

    // 指定值原样存下：它是**历史事实**，此后无论发生什么都不会被覆盖
    exclusiveCompanionId: input.exclusiveCompanionId,
    exclusiveEnteredAt: exclusive ? input.at : null,
    exclusiveDeadlineAt: exclusive ? plusMinutes(input.at, EXCLUSIVE_WAIT_MINUTES) : null,

    publicPoolEnteredAt: exclusive ? null : input.at,
    publicDeadlineAt: exclusive ? null : plusMinutes(input.at, config.publicPoolTimeoutMinutes),
    publicTimeoutMinutesSnapshot: exclusive ? null : config.publicPoolTimeoutMinutes,

    acceptedByCompanionId: null,
    acceptedAt: null,
    timedOutAt: null,

    createdAt: input.at,
    updatedAt: input.at,
  });
}

/* ───────────────────────── 接单 ───────────────────────── */

/**
 * 一张派单**当前所在池**的截止时间。
 *
 * 两种池子各看各的字段：专属池看 `exclusiveDeadlineAt`，公共池看 `publicDeadlineAt`。
 * 转池时后者会被重写，因此**不存在**「用一个统一的截止时间」这种省事写法——
 * 那会让一张刚转进公共池的订单继续按专属池的时间被拒。
 *
 * 返回 null 表示记录处于不可能状态（状态是池子但截止时间缺失）。调用方一律拒绝，
 * 不猜一个默认值：猜出来的截止时间会让一张本该结束的订单继续被接走。
 */
function currentDeadlineAt(record: DispatchRecord): string | null {
  return record.state === "exclusive" ? record.exclusiveDeadlineAt : record.publicDeadlineAt;
}

/** 一张派单现在还能不能被接。`accepted` / `timed_out` 都不能。 */
function isOpenPool(state: DispatchRecord["state"]): state is "exclusive" | "public" {
  return state === "exclusive" || state === "public";
}

/**
 * 构造并校验一条**发给订单用户**的通知（尚未写入）。
 *
 * ⚠️ 校验发生在**进入原子区段之前**（裁决：先验证意图，再原子写入事实）。
 * 文案格式错误、`href` 带查询串这类问题必须在这里抛出来——等到订单已经改了、
 * 退款已经发生了再抛，留下的就是一段半完成的业务状态。
 *
 * `href` 只带订单 id，不带任何说明或理由：通知是只读展示，要看细节进订单详情页，
 * 那里会重新校验归属。
 */
function planNotification(input: {
  userId: string;
  orderId: string;
  content: { title: string; summary: string; body: string };
  at: string;
}): Notification {
  const payload: NotificationInput = {
    userId: input.userId,
    kind: "dispatch",
    title: input.content.title,
    summary: input.content.summary,
    body: input.content.body,
    href: `/orders/${input.orderId}`,
  };

  const parsed = parseNotificationInput(payload);
  // 文案是常量、收件人与 href 都来自订单本身，这里失败只可能是常量被改坏了——
  // 那就该整段失败，而不是把一条格式不对的通知写进用户的收件箱
  if (!parsed.ok) throw new Error(`派单通知内容非法：${parsed.message}`);

  return {
    id: newNotificationId(),
    userId: parsed.value.userId,
    kind: parsed.value.kind,
    title: parsed.value.title,
    summary: parsed.value.summary,
    body: parsed.value.body,
    // 通知的时间就是**那件事发生的时间**，不是「谁碰巧来看了一眼的时间」
    createdAt: input.at,
    readAt: null,
    href: parsed.value.href,
  };
}

/**
 * 接单。
 *
 * ## 判定顺序是有讲究的
 *
 * 1. **先看这张单现在是什么状态**——已经被接走就直接有答案，不必再看时限与资格；
 * 2. **再看到没到点**——`deadline <= now` 即已过期，**不看 `state` 是不是还是 public**。
 *    数据库里状态还是 `public` 只是因为清扫还没跑到，那**不代表还能抢**。
 *    业务事实由 deadline 决定，不由「有没有运行 sweep」决定。
 * 3. **再看接的人对不对**——专属池只有用户指定的那位能接；
 * 4. **最后看这位打手此刻能不能接单**——已下架 / 已移除、或当前暂停接单
 *    （`available = false`），都在这里被拒。
 *
 * ⚠️ 「已被我接走」这一条**先于**第 4 步：接单之后管理员又把我暂停接单，
 * 我重复提交同一次接单（网络重试、重复点击）仍然算**重放**而不是失败——
 * 那张单在暂停之前就已经是我的了。暂停接单管的是「新的单」，不是翻旧账。
 *
 * ⚠️ 暂停接单的人**碰不到**「被别人接走」这条分支之外的任何写入：他的请求
 * 走到第 4 步就返回了，派单、订单、通知一个字节都不会被改。
 *
 * ## 三种「不能接」必须分开说
 *
 * 「被别人接走了」（`not-open`）、「到点了」（`expired`）、「这不是指定给你的」（`not-eligible`）
 * 对打手是完全不同的三件事：第一种不用再等，第二种是手慢了，第三种是他本来就不该在这。
 * 合成一句「接单失败」会让人反复重试一张永远不会属于他的单。
 */
export async function acceptDispatch(
  dispatchId: string,
  ctx: CompanionWriteContext,
): Promise<DispatchAcceptResult> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const dispatches = dispatchStore();
  const payments = paymentStore();

  // —— 原子区段开始（无 await）——
  const record = dispatches.dispatches.get(dispatchId);
  if (!record) return { kind: "not-found" };

  // 已经被接走：是**我自己**接的就算重放（重复点击、网络重试），
  // 是别人接的就是「被抢了」。两种都不再写任何东西
  if (record.state === "accepted") {
    return record.acceptedByCompanionId === ctx.companionId
      ? { kind: "ok", dispatch: record, replayed: true }
      : { kind: "not-open", state: record.state };
  }
  if (record.state === "timed_out") return { kind: "not-open", state: record.state };

  const deadlineAt = currentDeadlineAt(record);
  // 记录处于不可能状态时一律拒绝：这里猜一个截止时间，就等于让一张本该结束的订单继续被接走
  if (deadlineAt === null) return { kind: "not-open", state: record.state };

  if (Date.parse(deadlineAt) <= Date.parse(ctx.at)) return { kind: "expired" };

  // 专属池是**一对一**的：用户指定了谁，就只有谁能在十分钟里接。
  // 这里比对的是 `exclusiveCompanionId`（用户指定的人），不是「谁先来谁接」
  if (record.state === "exclusive" && record.exclusiveCompanionId !== ctx.companionId) {
    return { kind: "not-eligible" };
  }

  const order = payments.orders.get(record.orderId);
  // 订单不存在、或已经不在「已付款等待接单」这个状态（例如管理员刚把这一单退了），
  // 都不允许再被接走：接一张已经退款的单，会让打手去做一件不存在的活
  if (!order || order.status !== "paid") return { kind: "order-closed" };

  // 这位打手**此刻**能不能接单。判在这一步而不是早些时候，是为了消掉一个中间态：
  // 请求进来的那一刻他还接得动，处理到一半被管理员下架或暂停接单——写下去他就会拿到
  // 一张自己看不到、也提交不了材料的单。
  //
  // ⚠️ 两个原因**共用同一个对外结果**（`companion-unavailable`）：
  // - 资料已下架 / 已移除（`enabled === false` 或 `removedAt !== null`）——资格问题；
  // - 当前暂停接单（`available === false`）——能力问题。
  // 对打手要做的事是同一件（去找管理员），而在**这一步**分开表达没有意义：
  // 走到这里的人已经通过了守卫（`requireCompanion()` 只放行 `enabled` 的人），
  // 因此他看到的永远只会是后者。合成一个结果也少一个前端要维护的分支。
  //
  // ⚠️ 这里是**唯一**的保护：页面上不渲染接单按钮只是让人不去点，
  // 伪造请求直接 POST 这个接口一样会打到这里。
  const companion = readCompanionRecord(ctx.companionId);
  if (!companion || !isCompanionAcceptingOrders(companion)) {
    return { kind: "companion-unavailable" };
  }

  // 通知在**写之前**构造并校验完（含 id）：区段里只做不会失败的 append
  const notification = planNotification({
    userId: order.userId,
    orderId: order.id,
    content: DISPATCH_NOTIFICATION_ACCEPTED,
    at: ctx.at,
  });

  // —— 写入：派单与订单**同段**写完 ——
  const accepted = applyDispatchAccepted(dispatchId, ctx.companionId, ctx.at);
  if (!accepted) return { kind: "not-found" };

  applyOrderAccepted(order.id, {
    companionId: companion.id,
    // 接单那一刻的公开信息快照。之后改昵称换头像，这一单的展示不受影响。
    // 与「管理端回看用户指定的是谁」共用同一处转换（见 toOrderCompanionSnapshot）
    companion: toOrderCompanionSnapshot(companion),
    at: ctx.at,
  });

  appendNotification(notification);
  // —— 原子区段结束 ——

  return { kind: "ok", dispatch: accepted, replayed: false };
}

/* ───────────────────────── 超时清扫 ───────────────────────── */

/** 一次清扫的结果。两个数组都是**本次真的发生了**的迁移，不是「扫到了什么」。 */
export type DispatchSweepResult = {
  /** 专属池到点、本次转进公共池的派单 id */
  movedToPublicDispatchIds: string[];
  /** 公共池到点、本次被自动全额退款的订单 id */
  refundedOrderIds: string[];
};

/**
 * 把已经到点的派单**物化**成事实（**同步、可重复调用、幂等**）。
 *
 * ## 三个「不」
 *
 * - **不用裸 `setTimeout`**：超时不是被「定时触发」的，而是**到点就已经成立**。
 *   这个函数只是把已经成立的事实写下来。
 * - **不依赖「上一次什么时候查」**：迁移发生的时刻取的是**到点那一刻**
 *   （专属池取 `exclusiveDeadlineAt`，公共池取 `publicDeadlineAt`），
 *   而不是「谁碰巧来看了一眼」的当前时间。因此同一个 `at` 调几次、
 *   隔多久调一次，写入的记录完全一样，真正做到了「跑 20 次与跑 1 次结果相同」。
 * - **不做第二套**：将来由后台调度器 / 定时任务触发时，调用的就是这个函数，
 *   不是另写一套超时退款逻辑。
 *
 * ## 一条到点的单可能连跳两级
 *
 * 服务停了一夜再启动，「专属池到点」与「公共池到点」都已经是过去的事了。
 * 此时一次调用要把它**追平到今天**：先转公共池、再退款，两条通知都要发。
 * 只跳一级的话，用户要在页面上多刷一次才能看到自己的钱退回来——
 * 而「刷一次才前进一格」正是「依赖上一次什么时候查」的另一种写法。
 *
 * ## 幂等是怎么成立的
 *
 * 只处理「当前池的 deadline 已到、且 `state` **仍然**是那个池」的记录。
 * 处理完 `state` 就变了（转 `public` / 转 `timed_out`），第二遍扫到它时
 * 状态与池已经对不上，直接跳过——不重复转池、不重复退款、不重复发通知。
 * 订单那一侧还有第二道锁：`applyOrderRefund` 对已经是 `refunded` 的订单返回
 * `changed: false`，重复调用不会刷新退款时间。
 */
export function sweepExpiredDispatches(at: string): DispatchSweepResult {
  const dispatches = dispatchStore();
  const payments = paymentStore();
  // 配置在这一次清扫里读**一次**：整段是同步的，中途不可能被改
  const config = readPlatformConfig();

  /* —— 计划阶段：只读，不写任何东西 ——
     通知（含 id）在这里就构造并校验好。区段内只做不会失败的 append，
     因此不会出现「订单已经退了、通知却没写成」这种半完成状态 */
  type Transition =
    | { kind: "to-public"; dispatchId: string; enteredAt: string }
    | {
        kind: "timed-out";
        dispatchId: string;
        orderId: string;
        refundedAmount: number;
        timedOutAt: string;
      }
    | { kind: "notify"; notification: Notification };

  const plan: Transition[] = [];
  const movedToPublic: string[] = [];
  const refunded: string[] = [];

  for (const record of dispatches.dispatches.values()) {
    if (!isOpenPool(record.state)) continue;

    const order = payments.orders.get(record.orderId);
    // 订单都查不到，这一条记录已经没有业务含义；不猜、不写、也不吵
    if (!order) continue;

    // 从当前池开始追平：每一轮只前进一格，最多两格（专属 → 公共 → 关闭）
    let state: "exclusive" | "public" = record.state;
    let deadlineAt = currentDeadlineAt(record);

    while (deadlineAt !== null && Date.parse(deadlineAt) <= Date.parse(at)) {
      const atDeadline = deadlineAt;

      if (state === "exclusive") {
        // 专属池到点：**不进退款、不进售后**——订单还在等人接。
        // 进入公共池的时刻取「专属池到点那一刻」，公共池的计时从那里开始
        plan.push({ kind: "to-public", dispatchId: record.id, enteredAt: atDeadline });
        plan.push({
          kind: "notify",
          notification: planNotification({
            userId: order.userId,
            orderId: order.id,
            content: DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT,
            at: atDeadline,
          }),
        });
        movedToPublic.push(record.id);

        state = "public";
        deadlineAt = plusMinutes(atDeadline, config.publicPoolTimeoutMinutes);
        continue;
      }

      // 公共池到点：停止接取 + **自动全额退款**。不是售后、不是等客服审核、不是等管理员点一下
      plan.push({
        kind: "timed-out",
        dispatchId: record.id,
        orderId: order.id,
        refundedAmount: order.actualPaidAmount,
        timedOutAt: atDeadline,
      });
      // 已经被退过的订单不再发一条重复的退款通知——它当初退款时的通知已经发过了。
      // 这里仍然要把派单关掉，否则它会一直挂在公共池里
      if (order.status !== "refunded") {
        plan.push({
          kind: "notify",
          notification: planNotification({
            userId: order.userId,
            orderId: order.id,
            content: DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT,
            at: atDeadline,
          }),
        });
        refunded.push(order.id);
      }
      break;
    }
  }

  /* —— 原子区段开始（无 await）—— */
  for (const step of plan) {
    if (step.kind === "to-public") {
      applyDispatchToPublic(step.dispatchId, step.enteredAt, config.publicPoolTimeoutMinutes);
      continue;
    }
    if (step.kind === "timed-out") {
      // 关闭与退款写的都是**到点那一刻**，不是「扫到它的那一刻」
      applyDispatchTimedOut(step.dispatchId, step.timedOutAt);
      applyOrderRefund(step.orderId, step.timedOutAt, step.refundedAmount);
      continue;
    }
    appendNotification(step.notification);
  }
  /* —— 原子区段结束 —— */

  return { movedToPublicDispatchIds: movedToPublic, refundedOrderIds: refunded };
}

/**
 * 一条派单在用户端要显示的进度摘要（纯函数）。
 *
 * ⚠️ `remainingSeconds` 只是给页面显示的一个数字，**不参与任何判定**：
 * 到没到点一律由服务端的 `deadline <= now` 决定（`acceptDispatch` / 清扫），
 * 客户端算出来的时间不可信，也不该被信任。
 *
 * `accepted` / `timed_out` 返回 null：这两种情况下订单自己的状态已经说明了一切
 * （已接单 / 已退款），再显示一行池子进度只会和状态栏打架。
 *
 * 放在这里而不是服务层，是因为「当前池的截止时间看哪个字段」这条规则
 * （`currentDeadlineAt`）只能有一处实现——服务层与清扫各写一份的话，
 * 转池之后必然有一边还在看旧字段。
 */
export function toDispatchProgress(
  record: DispatchRecord,
  at: string,
): { pool: "exclusive" | "public"; deadlineAt: string; remainingSeconds: number } | null {
  if (!isOpenPool(record.state)) return null;

  const deadlineAt = currentDeadlineAt(record);
  if (deadlineAt === null) return null;

  const remaining = Date.parse(deadlineAt) - Date.parse(at);
  return {
    pool: record.state,
    deadlineAt,
    // 已过点时为 0：负数会让页面显示「剩余 -3 分钟」
    remainingSeconds: remaining > 0 ? Math.floor(remaining / 1000) : 0,
  };
}
