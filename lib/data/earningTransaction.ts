import { isCompletionAutoApprovalBlocked } from "@/lib/constants/completions";
import { isEarningMatured } from "@/lib/constants/earnings";
import type { Earning } from "@/lib/types/earning";
import type { Order } from "@/lib/types/order";
import { currentPlatformConfig } from "./adminPlatformConfigTransaction";
import {
  appendEarning,
  appendEarningAdjustment,
  applyEarningRelease,
  applyEarningReversal,
  earningStore,
  newEarningAdjustmentId,
} from "./mockEarningRepository";
import { applyOrderCompletion, paymentStore } from "./mockPaymentRepository";
import { listRefundsForOrderSync } from "./mockRefundRepository";
import { readOrderBlockingFacts } from "./orderBlocking";

/**
 * 收益域的伪事务（P0-9）—— 两个入口：**结算一次完成**、**清扫到期解冻**。
 *
 * ## 结算只有一个入口：`settleOrderCompletion`
 *
 * P0-8 有两个完成来源（客服人工通过、System 到期自动通过）。P0-9 把
 * 「订单 → completed + 冻结投诉窗口 + 生成 frozen 收益」这三件事**全部**
 * 收进 `settleOrderCompletion` 一个函数，两个来源都只调用它——
 * 不允许任何一处自己再写一遍「算 deadline、建收益」。
 *
 * 这条约束是刻意的、也是本轮最重要的一条：**资金事实只允许有一条生成路径**。
 * 复制成两套的那一天，「人工通过生成的收益」与「自动通过生成的收益」就会开始
 * 各自演化（一个改了金额来源、另一个没改），而两者的差异在页面上完全看不出来。
 *
 * ## 退款冲回的补记也挂在这一条路径上（P0-13 D9）
 *
 * `serving` 订单部分退款时收益还不存在，冲回只能等订单完成后**补记**（见
 * `backfillRefundReversals`）。它同样只有这一处落点：任何第二个「建 Earning」的
 * 地方都必须自己记得补记一次，而漏掉的那次会在页面上表现为「这笔钱怎么没被扣」。
 *
 * ## 原子性
 *
 * 与同目录其它伪事务同一条依据：Node 是单线程的，「读—判断—写」之间只要不让出执行权，
 * 别的请求就插不进来。本文件的两个函数**都是同步函数**（没有 `async` 外壳，
 * 因为没有任何调用方需要 `await` 它），因此原子区段内**不可能**出现 `await`——
 * 这不是靠注释约束，是类型上的事实。
 *
 * ## 幂等：判据是状态本身，不是幂等键
 *
 * 与 `approveCompletion` / `startCompanionOrder` 同一机制：
 * - 订单已经是 `completed` → 结算函数直接返回，**一个字节都不写**
 *   （重复调用不刷新 `completedAt`、不补快照、不建第二条收益）；
 * - 收益已经是 `available` → 释放原语返回 `changed: false`。
 *
 * 一次完成的结算因此可以安全地被重复触发（客服连点两次、sweep 与人工审核同时到达）。
 */

/**
 * 结算一次订单完成（**同步**，P0-9 唯一的完成结算入口）。
 *
 * 三件事在同一段没有 `await` 的代码里一起发生：
 *
 * 1. 订单 → `completed`（`completedAt` 只写第一次）；
 * 2. 冻结本单的 `complaintWindowMinutesSnapshot` 与 `complaintDeadlineAt`
 *    （= `completedAt + snapshot`，两件事都由 `applyOrderCompletion` 一次写完）；
 * 3. 为该单**实际履约**的打手建一条 `frozen` 的 Earning，
 *    `incomeAmount` **直接搬** `Order.companionBaseIncome`，`availableAt` **直接搬**
 *    刚写下的 `complaintDeadlineAt`。
 *
 * ## 金额一个字都不重算
 *
 * `companionBaseIncome` 是**下单那一刻**由分账基数 × 比例快照算出来的（P0-3），
 * 它已经是一个承诺给打手的数。这里不查商品现价、不查当前分账比例、
 * 不因优惠券再下调一次——那三种做法都会让「同一张订单在完成时看到的收益」
 * 与「下单时说好的收益」不一致，而用户端订单详情里显示的正是下单时那个数。
 *
 * ## 重复调用
 *
 * 订单已经是 `completed` 时**整段跳过**（连快照都不补写）。
 * 这一条挡住了「拿今天的配置去补一张旧订单」的追溯：结算只发生在
 * `serving → completed` 那一次迁移上，之后永远不会再被执行到。
 *
 * ## 起始状态：函数自己守，不指望调用方自觉
 *
 * 上面那句「只发生在 `serving → completed` 那一次迁移上」在 P0-9 里一度**只是注释**：
 * 两个调用点确实在同一个原子区段里先判过 `order.status !== "serving"`，但函数自身
 * 没有任何判定。这意味着任何一个**新调用方**（真 Scheduler、退款冲正、封禁回池）
 * 拿一张 `paid` 订单直接调进来，都会让一张**从未开始服务**的订单变成「已完成」，
 * 写下 `completedAt` / 快照 / deadline，并在有 `actualCompanionId` 时**当场铸出一笔
 * 待解冻的钱**——而整条链路上不会有任何一处报错。
 *
 * 因此这里补一条与 `status === "completed"` **对称**的短路：不是 `serving` 就
 * 一个字都不写、原样返回既有事实。它与下面「没有实际履约打手就不建收益」是同一类
 * 防御——宁可函数白跑一次，也不要它越权写下自己没被授权写的事实。
 *
 * ⚠️ **写入器 `applyOrderCompletion` 故意不加这条判定**：与 `applyApplicationReview`
 * / `applyOrderRefund` 同一约定，`apply*` 系列只负责写，合法性一律由伪事务在调用前判定。
 * 守卫放在这一层，是因为**只有伪事务知道自己在执行哪一次迁移**。
 *
 * @returns 本次写入后的订单与收益；订单不存在时返回 null（调用方据此走 500 分支）。
 *   重复结算、或订单不在 `serving` 时，返回的是**已有的**订单与收益，`changed: false`。
 */
export function settleOrderCompletion(input: { orderId: string; at: string }):
  | { changed: boolean; order: Order; earning: Earning | null }
  | null {
  const payments = paymentStore();
  const earnings = earningStore();

  // —— 原子区段开始（同步，不可能出现 await）——

  const order = payments.orders.get(input.orderId);
  if (!order) return null;

  // 已经完成过：结算是一次迁移的副作用，不是「补齐历史」。
  // 直接返回既有事实，不补快照、不建收益、不刷新任何时间戳
  if (order.status === "completed") {
    const existing = earnings.earningIdByOrder.get(order.id);
    return {
      changed: false,
      order: { ...order },
      earning: existing ? (earnings.earnings.get(existing) ?? null) : null,
    };
  }

  // 不是 `serving` 就不是「一次完成」：原样返回既有事实，一个字节都不写。
  // 两个现有调用点在同一原子区段里已经先判过状态，所以这一条今天打不到任何人——
  // 它守的是将来多一个调用方时的那个不变量（见函数头「起始状态」）
  if (order.status !== "serving") {
    const existing = earnings.earningIdByOrder.get(order.id);
    return {
      changed: false,
      order: { ...order },
      earning: existing ? (earnings.earnings.get(existing) ?? null) : null,
    };
  }

  /* —— 第 1、2 步：订单完成 + 冻结投诉窗口 —— */
  // 窗口时长在这里读一次（同步读，不打破原子性），传下去由写入器算出 deadline。
  // 走 `currentPlatformConfig()` 而不是直接 import Mock 仓储：平台参数的读取入口
  // 只有一处（见 `adminPlatformConfigTransaction.ts` 的注释）
  const complaintWindowMinutes = currentPlatformConfig().complaintWindowMinutes;

  const written = applyOrderCompletion(order.id, input.at, complaintWindowMinutes);
  if (!written) return null;
  const settled = written.updated;

  /* —— 第 3 步：生成 frozen 收益（一个订单最多一条）—— */
  // 索引就是这条约束：有记录就不再建。重复完成已被上面的 `status === "completed"`
  // 挡住，这一句是同一约束的第二道保险（例如将来出现不复用本函数的完成路径）
  const existingId = earnings.earningIdByOrder.get(settled.id);
  if (existingId) {
    return {
      changed: written.changed,
      order: settled,
      earning: earnings.earnings.get(existingId) ?? null,
    };
  }

  // `completed` 必须有实际履约打手（`lib/types/order.ts` 的 `actualCompanionId` 注释
  // 写明了这条不变量，两条完成路径的领域 Guard 都保证它成立）。
  // 没有打手就没有收益可发：如实不建记录，而不是建一条 `companionId: ""`、
  // 金额 0 的假记录——那种记录会在打手端页面变成一条没人认领的收益
  if (!settled.actualCompanionId) {
    return { changed: written.changed, order: settled, earning: null };
  }

  const earning: Earning = {
    id: `ern_${crypto.randomUUID()}`,
    orderId: settled.id,
    companionId: settled.actualCompanionId,
    // 直接搬订单快照（与 `Order.companionBaseIncome` 是同一个数，不重算）
    incomeAmount: settled.companionBaseIncome,
    status: "frozen",
    // 冻结时刻取**订单的完成时刻**而不是本次调用的 `at`：两者在正常路径上相同，
    // 但订单可能已经带着一个历史 `completedAt`（上面写入器的 `??` 保留分支），
    // 那时「这一单什么时候完成的」是唯一正确的答案
    frozenAt: settled.completedAt ?? input.at,
    // 与投诉截止**同一个时刻**（写入器刚算出来的那个）。
    // ⚠️ 这里**不自己再加一次** minute：同一件事算两遍，迟早算岔
    availableAt: settled.complaintDeadlineAt,
    withdrawnAt: null,
    reversedAmount: 0,
    fineAmount: 0,
  };
  appendEarning(earning);

  /* —— 第 4 步：补记该订单已批准退款的冲回额（P0-13 D9）—— */
  // 顺序不能反：冲回是**写在一条已经存在的收益上**的
  backfillRefundReversals({ earningId: earning.id, orderId: settled.id, at: input.at });
  // —— 原子区段结束 ——

  // 读回**补记之后**的那一份：`applyEarningReversal` 写入的是一个新对象，
  // 直接返回上面那个 `earning` 会给调用方一个 `reversedAmount` 仍是 0 的快照，
  // 而那正是这一整段要写下的东西
  return {
    changed: written.changed,
    order: settled,
    earning: earnings.earnings.get(earning.id) ?? earning,
  };
}

/**
 * 把该订单**已批准退款**的冲回额补记到刚建好的收益上（P0-13 D9）。
 *
 * `serving` 订单**没有** Earning（`settleOrderCompletion` 的守卫要求订单已是
 * `completed`），因此「`serving` 部分退款 → 订单后来完成」这条路上，冲回在决策当时
 * 无处可写。决策本身已经把金额算好并留在了退款记录上（D1 的公式只需要订单快照，
 * 不需要 Earning 存在），这里做的事只有一件：把它**物化**——累加进新 Earning 的
 * `reversedAmount`，并逐条补写明细。
 *
 * ⚠️ 走 `applyEarningReversal` 而不是自己给 `reversedAmount` 赋值：
 * 「部分冲回**不改状态**、整笔冲完才 `reversed`」这条规则只在存储层那一处（D5）。
 * 抄一份到这里，意味着以后改这条规则要改两个地方——而漏掉一处不会有任何报错。
 *
 * ⚠️ 逐条补写明细，不合成一条：`EarningAdjustment` 的粒度是**一次退款决策**
 * （D8 用 `refundId` 唯一索引钉住），合成一条会让「这笔冲回是哪几笔退的、谁的责任」
 * 再也答不出来，而那正是 Q1-c 要求留下这份记录的原因。
 *
 * ⚠️ 这里**不再钳制**累计额：不变式 `0 <= reversedAmount <= incomeAmount` 的唯一
 * 保证点是 D4 的钳制，而它读的 `companionBaseIncome` 与这里 `incomeAmount` 的来源
 * 是同一张订单上的同一个字段，中间不可能变。多夹一次只会让「谁在保证这个不变式」
 * 多出一个答案。（存储层的 `applyEarningReversal` 自带一道护栏，那是**存储层自己的**
 * 不变式，不是这里的。）
 *
 * ⚠️ 若该订单**永远不完成**（`serving` 全额退款 → 订单直接 `refunded`），
 * 冲回就不会物化——这是正确的：`cmd_p0-13.md` 要求这种情况不产生 completed Earning，
 * 打手本来就没有收益可冲。
 */
function backfillRefundReversals(input: {
  earningId: string;
  orderId: string;
  at: string;
}): void {
  const approved = listRefundsForOrderSync(input.orderId).filter(
    (refund) => refund.status === "approved" && refund.decision !== null,
  );

  for (const refund of approved) {
    const decision = refund.decision;
    // 平台全额承担的退款没有从打手身上冲任何钱：`amount <= 0` 时
    // `applyEarningReversal` 一个字节都不写，也不需要一条空明细
    if (!decision || decision.companionReversalAmount <= 0) continue;

    applyEarningReversal(input.earningId, decision.companionReversalAmount);
    appendEarningAdjustment({
      id: newEarningAdjustmentId(),
      earningId: input.earningId,
      orderId: input.orderId,
      refundId: refund.id,
      type: "refund_reversal",
      amount: decision.companionReversalAmount,
      responsibility: decision.responsibility,
      // 明细的 `createdAt` 取**写入时刻**，与即时冲回那条路一致：同一个字段在两条路上
      // 必须是同一个意思——「这一行是什么时候写下的」。决策发生的时间在退款记录
      // 自己的 `decidedAt` 上，这里不再抄一遍（抄两份就会出现两个可能的答案）
      createdAt: input.at,
      adminId: decision.decidedBy,
    });
  }
}

/**
 * 到期解冻（**同步、幂等**，P0-9）。
 *
 * 对每一条 `frozen` 且已到 `availableAt` 的收益，若该订单没有阻塞原因
 * （进行中的退款 / 未完结的投诉），就把它写成 `available`。
 *
 * ## 与 P0-8 的自动通过完全同形
 *
 * 它挂在**读取路径**上（与 `sweepCompletionAutoApprovals` 一样）：解冻不是被定时
 * 触发的，而是「deadline 到点就已经成立」，读取路径只是恰好把它写下来。
 * 真实调度器上线后调用**同一个**函数，不另写一套。
 *
 * ## 阻塞判据只有一份
 *
 * 数据来自 `readOrderBlockingFacts()`，判断来自 `isCompletionAutoApprovalBlocked()`
 * ——**与 P0-8 自动通过用的是同一对函数**。分开写两份的那天，
 * 「被投诉挡住了却照样放款」就会成为可能，而那种错误在页面上看不出来。
 *
 * ## 幂等
 *
 * 第一次执行后记录已不是 `frozen`，第二次直接跳过；`applyEarningRelease` 也不刷新
 * `availableAt`（它是计划解冻时刻，写入后不再变）。因此本函数可以任意次重复调用，
 * 结果与时间戳都不变——包括「阻塞解除后再扫一次」这种正常路径。
 *
 * ## 计划 / 提交两段
 *
 * 先只读地挑出「本次要释放哪些」，再逐一写入。两段之间没有 `await`，
 * 因此「挑的时候没阻塞、写之前投诉才进来」在结构上产生不出来。
 */
export function sweepMaturedEarnings(at: string): { releasedEarningIds: string[] } {
  const earnings = earningStore();

  const plan: string[] = [];

  // —— 计划阶段（只读）——
  for (const earning of earnings.earnings.values()) {
    if (!isEarningMatured({ status: earning.status, availableAt: earning.availableAt, at })) {
      continue;
    }
    if (isCompletionAutoApprovalBlocked(readOrderBlockingFacts(earning.orderId))) continue;
    plan.push(earning.id);
  }

  // —— 提交阶段（写）——
  for (const id of plan) {
    applyEarningRelease(id);
  }

  return { releasedEarningIds: plan };
}
