import { canDirectRefund } from "@/lib/constants/refunds";
import { REFUND_NOTIFICATION_COMPANION_REFUNDED } from "@/lib/constants/refunds";
import { parseNotificationInput } from "@/lib/constants/service";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import type { OrderStatus } from "@/lib/types/order";
import { readCompanionRecord } from "./mockCompanionRepository";
import { applyDispatchTimedOut, dispatchStore } from "./mockDispatchRepository";
import { appendNotification, newNotificationId } from "./mockNotificationRepository";
import { applyOrderRefund, paymentStore } from "./mockPaymentRepository";

/**
 * 用户**直接全额退款**的伪事务（P0-12）—— 「`paid` / `accepted` → `refunded`」的**唯一**写入入口。
 *
 * ## 它为什么是一个新的伪事务，而不是塞进 `adminRefundTransaction`
 *
 * 那条路径回答的是「**管理员审不审这笔退款申请**」：它写的是 `RefundRequest` 的状态
 * 与审核人，订单只是它的一个副作用（且**只有通过时才写**）。
 * 这条路径回答的是「**用户当场把这一单退掉**」：**没有申请、没有审核人、没有审批环**，
 * 写的是订单、派单与一条给护航的通知。
 *
 * 两件事的输入、输出、失败原因各不相同。合并成一个函数，就得在里面按「谁在调用」
 * 分支——那正是「一个函数两种语义」，比两份各自短小的实现更容易写错。
 * 但它们**共用同一个订单写入原语** `applyOrderRefund`，因此「订单怎么变成 `refunded`」
 * 这件事全世界仍然只有一份实现（见该函数头：`refundedAt` 只在第一次写入）。
 *
 * ## 原子性是怎么成立的
 *
 * 与其它伪事务同一条依据：Node 是单线程的，「读—判断—写」之间只要不让出执行权，
 * 别的请求就插不进来。本函数标注的两段之间**没有一个 `await`**（函数体里也一个都没有）——
 * **在标注的边界之后加 `await` 就是 bug**，哪怕加的是 `await Promise.resolve()`。
 *
 * 必须原子的事实是三件，少任何一件系统都会自相矛盾：
 * 1. 订单说「已退款」与 `refundedAmount` 说「退了多少」必须同时成立；
 * 2. 派单必须同时关闭——否则它会继续挂在池子里被接（订单侧虽有第二道锁，见下），
 *    也会继续被 `sweepExpiredDispatches` 当成「到点该退款的候选」；
 * 3. 通知必须与退款同时发出——否则护航会看到一张被判「已退款」的单，
 *    却从没被告知过为什么。
 *
 * ## 幂等：靠状态，不靠幂等键
 *
 * 「同一个意图第二次到达」在这里的判据是**订单状态与已退金额**，不是幂等键：
 * `refunded` 或 `refundedAmount >= actualPaidAmount` 都直接返回 `already-refunded`，
 * 一个字节都不写。这比幂等键更强——键是调用方给的一个串，而状态是**事实**；
 * 而且它天然覆盖了「不是同一个人点的第二次」：超时清扫与管理员退款
 * 都会把订单写成 `refunded`，之后用户再点一次同样落回 `already-refunded`。
 *
 * 与超时自动退款的并发（EX-REFUND-02）因此是**两道**独立的锁：
 * ① 派单被关闭后 `sweepExpiredDispatches` 根本不会再看它（它只处理开着的池）；
 * ② 即使抢在关闭之前，`applyOrderRefund` 对已经是 `refunded` 的订单返回 `changed: false`。
 *
 * ## 刻意不碰的东西
 *
 * - **不清 `actualCompanionId`、不清履约绑定、不写 `CompanionReleaseRecord`**：
 *   这是批次 §历史语义 明文要求的「**不得为代码统一抹平**」——
 *   cancel / ban / re-pool 的语义是「换个人接着做」，退款是「这一单到此为止」。
 *   `actualCompanionId` 在这里是「谁曾实际接下该单」的**历史事实**，退款不该抹掉它。
 * - **不生成、也不冲正 Earning**：`paid` / `accepted` 从未进入过 `serving`，
 *   而收益只在完成结算时产生（`settleOrderCompletion` 的 `status !== "serving"` 守卫），
 *   因此这一档订单**不可能**存在 Earning。这不是「忘了写」——
 *   `tests/directRefund.test.mjs` 有用例直接断言退款后该订单没有收益记录。
 * - **不改金额之外的任何订单字段**：不动 `companionBaseIncome` / `clubNetIncome`，
 *   不动商品与规格快照，不动用户累计消费（`refunded` 天然不计入有效消费）。
 */

/**
 * 一次直接退款的结果。
 *
 * 失败原因分开表达，是因为**它们要说给用户听的话不一样**：
 * `not-found` 与「不是我的订单」在服务层合成同一个 404；
 * `already-refunded` 是「不必再试」；`not-eligible` 带出当前状态，
 * 由服务层翻译成「请走售后」还是「当前不可退」。
 */
export type DirectRefundOutcome =
  | {
      kind: "ok";
      orderId: string;
      orderNo: string;
      /**
       * 这一单**累计**已退（分）。这条路径退的是「剩余可退额」，
       * 因此调用成功之后它**恒等于** `actualPaidAmount`——这一单到此退满。
       *
       * ⚠️ 它不是「这一次退掉的那一笔」：在已经部分退过的订单上，
       * 本次实际出款是 `actualPaidAmount − 退款前的 refundedAmount`。
       */
      refundedAmount: number;
      /** 退款时刻。**第一次**进入 `refunded` 的那个时刻，不会被后续请求刷新 */
      refundedAt: string;
      /** 退款前的状态。只有 `paid` / `accepted` 两种可能（其余早已被挡住） */
      previousStatus: OrderStatus;
      /**
       * 是否关闭了派单。
       *
       * ⚠️ `false` 只可能因为**这一单根本没有派单记录**（数据异常）。此时退款照常完成：
       * 让用户拿不回钱来为一个内部记录的缺失买单，是比「少关一条派单」糟糕得多的结果。
       * 见 `03-delivery.md` 的 MINOR 登记。
       */
      dispatchClosed: boolean;
      /**
       * 收到「订单已退款」通知的护航**用户 id**。
       *
       * ⚠️ 是 `userId` 而不是 `companionId`：通知的收件人字段是用户维度
       * （打手没有独立账号体系）。这里如实报出**实际送达的那个 id**，
       * 而不是报 `companionId` 让调用方自己换算。
       *
       * `null` 有且只有两种情形，都不是故障：
       * 1. `paid` 单（还没有人接，没有通知对象）；
       * 2. 接单打手的资料没有关联用户账号（预置 Mock 打手 `userId: null`）——
       *    这时**不存在能收信的地址**。
       */
      notifiedCompanionUserId: string | null;
    }
  /** 订单不存在。服务层与「不是自己的订单」合并成同一个 404 */
  | { kind: "not-found" }
  /** 已经是全额退款状态（状态为 `refunded`，或已退金额已达实付）。**不写任何东西** */
  | { kind: "already-refunded"; orderId: string; refundedAt: string | null }
  /**
   * 订单金额异常（实付 ≤ 0），退无可退。
   *
   * 单列一支而**不**并进 `already-refunded`：实付为 0 时那句 `refundedAmount >= actualPaidAmount`
   * 会成立（`0 >= 0`），于是用户得到的是「**该订单已全额退款**」——而订单其实还停在
   * `paid`、一笔钱都没退，也没有任何退款记录。那是一句**假话**，且用户会以为自己退过了。
   * 申请路径对同一异常有显式保护（`REFUND_AMOUNT_INVALID_MESSAGE`），这里与它对齐。
   */
  | { kind: "amount-invalid"; orderId: string }
  /** 状态不在「尚未开始服务」这两档里（`serving` / `completed` / 其它） */
  | { kind: "not-eligible"; orderId: string; status: OrderStatus };

/**
 * 构造并校验一条**发给被退单护航**的通知（尚未写入）。
 *
 * ⚠️ 与另外两个伪事务里的 `planNotification` **刻意各留一份**，理由与它们相同
 * （见 `companionOrderTransaction.ts` 同名函数的说明：十几行、不含业务判断，
 * 合并反而要为「将来第 N 种通知」预留参数）。本函数与它们真正的区别是**收件人**：
 * 那两个的收件人恒为下单用户，这一个恒为**护航的 `userId`**，
 * 且 `href` 指向**打手端**的订单页——发给下单用户的 `/orders/[id]` 对打手是 404，
 * 因为那里会重新校验订单归属。
 *
 * ⚠️ 校验发生在**进入写入之前**（裁决：先验证意图，再原子写入事实）。
 * 文案格式错、`href` 带查询串这类问题必须在这里抛出来——等订单已经退了再抛，
 * 留下的就是「钱退了、通知没了」。
 */
function planCompanionRefundNotification(input: {
  userId: string;
  orderId: string;
  at: string;
}): Notification {
  const payload: NotificationInput = {
    userId: input.userId,
    // 这是「退款」这件事的通知，不是派单通知：用户端按 kind 分组展示
    kind: "refund",
    title: REFUND_NOTIFICATION_COMPANION_REFUNDED.title,
    summary: REFUND_NOTIFICATION_COMPANION_REFUNDED.summary,
    body: REFUND_NOTIFICATION_COMPANION_REFUNDED.body,
    href: `/companion/orders/${input.orderId}`,
  };

  const parsed = parseNotificationInput(payload);
  // 文案与 href 都是常量、收件人来自订单上的实际打手，这里失败只可能是常量被改坏了——
  // 那就该整段失败，而不是把一条格式不对的通知写进护航的收件箱
  if (!parsed.ok) throw new Error(`退款通知内容非法：${parsed.message}`);

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
 * 直接全额退掉这一单：`paid → refunded` 或 `accepted → refunded`（P0-12）。
 *
 * **归属（是不是本人的订单）不在这里判断**：那是服务层的事，而这里只回答
 * 「这件事在数据上此刻成不成立」。与 `createRefundForOrder` 的分工一致。
 *
 * @param at 退款时刻。**只有第一次**会被写进 `Order.refundedAt`（由 `applyOrderRefund` 保证）
 */
export async function directRefundOrder(
  orderId: string,
  at: string,
): Promise<DirectRefundOutcome> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const orders = paymentStore().orders;
  const dispatches = dispatchStore();

  /* —— 第一段：只读判断，外加「构造好但还没写」的那条通知 —— */

  const order = orders.get(orderId);
  if (!order) return { kind: "not-found" };

  // ① 幂等的第一道：状态已经是终态。**在金额判断之前**——
  //    「什么时候退的」要从订单上读，而不是从这一次请求的 `at` 编一个出来
  if (order.status === "refunded") {
    return { kind: "already-refunded", orderId: order.id, refundedAt: order.refundedAt };
  }

  // ② 金额异常：实付 ≤ 0 时**必须先拦**，不能落到下面那条 `>=` 上——
  //    `0 >= 0` 会让用户得到「该订单已全额退款」，而订单还停在 `paid`、一分钱没退。
  //    与申请路径对同一异常的保护（`REFUND_AMOUNT_INVALID_MESSAGE`）对齐。
  if (order.actualPaidAmount <= 0) {
    return { kind: "amount-invalid", orderId: order.id };
  }

  // ③ 幂等的第二道，也是「未全额退款」这条前置本身：
  //    状态还没变、但钱已经退满了（例如将来某条部分退款路径恰好退到 100%）。
  //    少了这一句，下面的写入会把退款时刻**刷新成本次**，用户看到的退款时间就变了。
  //    ⚠️ 能走到这里已经保证 `actualPaidAmount > 0`（② 刚拦过），因此这个比较是有意义的
  if (order.refundedAmount >= order.actualPaidAmount) {
    return { kind: "already-refunded", orderId: order.id, refundedAt: order.refundedAt };
  }

  // ④ 「尚未开始服务」只有这两档。`serving` / `completed` 必须走售后（P0-13），
  //    在这里放行它们就等于绕过了客服调查与管理员的比例决定权
  if (!canDirectRefund(order.status)) {
    return { kind: "not-eligible", orderId: order.id, status: order.status };
  }

  // ⑤ 派单：能关就关，关不了（记录缺失）不拦退款——理由见 `dispatchClosed` 的说明
  const dispatchId = dispatches.dispatchIdByOrder.get(order.id);
  const dispatchExists = Boolean(dispatchId && dispatches.dispatches.has(dispatchId));

  // ⑥ 通知：只有「已有实际打手」的 `accepted` 单才有人可通知。
  //    `paid` 单没有实际打手（`actualCompanionId` 为 null），因此没有通知对象
  const companion = order.actualCompanionId
    ? readCompanionRecord(order.actualCompanionId)
    : null;
  // ⚠️ **收件人必须是这位打手的用户账号**（`Companion.userId`），而它**可以为 null**：
  //    通知的收件人字段是用户维度的，打手没有独立账号体系。预置的 Mock 打手
  //    （`cp-*`，平台早期数据）大多没有对应的入驻申请，`userId` 就是 null——
  //    这样的打手**不存在能收信的地址**，因此没有可通知的人，而不是「通知功能坏了」。
  //    真实路径（打手自己登录接单）必然带 userId：接单的人必须先是登录用户。
  const recipientUserId = companion?.userId ?? null;
  // ⚠️ 通知在**任何写入之前**就构造并校验好、id 也拿好；写入段里只剩一次不会失败的 append
  const notification = recipientUserId
    ? planCompanionRefundNotification({ userId: recipientUserId, orderId: order.id, at })
    : null;

  /* —— 原子区段开始（无 await）—— */

  // ① 订单：状态 + 退款金额 + 退款时刻。金额取**订单自己还剩多少**
  //    （实付 − 累计已退），没有任何参数能把金额传进来——同一事实只有一个真值源。
  //
  //    ⚠️ **必须是剩余额，不是实付全额**（P0-13 整改）：第三个参数现在的语义是
  //    「这一次退多少（增量）」。一张 `serving` 单被部分退款后又经 P0-11 打回 `paid`
  //    时，`refundedAmount` 不是 0——传实付会把它加成「已退 300 + 实付 1000 = 1300」，
  //    超过实付。`applyOrderRefund` 里那一次钳制是第二道保险，不是这里的依据。
  //    上面的 ③ 只挡住「已经退满」，挡不住「部分已退」
  const refundableAmount = order.actualPaidAmount - order.refundedAmount;
  const written = applyOrderRefund(order.id, at, refundableAmount);
  // 上面刚确认过订单存在且未退款，真发生只能说明存储被换掉了（resetMockStore）。
  // 那种情况下宁可整个请求失败，也不能返回「已退款」——那会变成「告诉用户退了、实际没退」
  if (!written) throw new Error("直接退款时订单写入失败");
  // 与状态判断之间的双保险：真的走到「写不动」时，如实按已退款回答，不谎报成功
  if (!written.changed) {
    return { kind: "already-refunded", orderId: order.id, refundedAt: written.updated.refundedAt };
  }

  // ② 派单：关闭。这是「不得继续接单」的第一道 + 「超时清扫不得再次退款」的机制依据
  //    （sweep 只处理 `exclusive` / `public` 两种「还开着」的池）
  if (dispatchExists) applyDispatchTimedOut(dispatchId as string, at);

  // ③ 通知。完成写入之后紧接着写，中间没有任何 `await`
  if (notification) appendNotification(notification);

  /* —— 原子区段结束 —— */

  return {
    kind: "ok",
    orderId: written.updated.id,
    orderNo: written.updated.orderNo,
    refundedAmount: written.updated.refundedAmount,
    // 读回调用的那个值，而不是 `at`：`applyOrderRefund` 对 `refundedAt` 用的是
    // `order.refundedAt ?? at` 的「第一次为准」语义，如实报出**写进去的那个时刻**
    refundedAt: written.updated.refundedAt ?? at,
    previousStatus: written.previous.status,
    dispatchClosed: dispatchExists,
    notifiedCompanionUserId: notification ? notification.userId : null,
  };
}
