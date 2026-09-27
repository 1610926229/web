import { toRefundAuditSnapshot } from "@/lib/constants/adminAudit";
import { canTransitionRefund } from "@/lib/constants/adminRefunds";
import {
  REFUND_NOTIFICATION_COMPANION_REFUNDED,
  REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION,
  REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE,
  assertRefundAmountWithinPaid,
  assertRefundApprovalOrderStatus,
  computeRefundDecisionAmounts,
  isFullyRefunded,
  resolveFinalDecisionAmounts,
  sumApprovedCompanionReversal,
  type RefundDecisionInput,
} from "@/lib/constants/refunds";
import { parseNotificationInput } from "@/lib/constants/service";
import type { AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import type { Order } from "@/lib/types/order";
import type { RefundDecision, RefundRequest, RefundStatus } from "@/lib/types/refund";
import { takeReplayForAction, writeAudit, type AdminWriteContext } from "./adminWriteSupport";
import { readCompanionRecord } from "./mockCompanionRepository";
import { applyDispatchTimedOut, dispatchStore } from "./mockDispatchRepository";
import {
  appendEarningAdjustment,
  applyEarningReversal,
  earningStore,
  findEarningAdjustmentIdByRefund,
  newEarningAdjustmentId,
} from "./mockEarningRepository";
import { appendNotification, newNotificationId } from "./mockNotificationRepository";
import { applyOrderRefund, paymentStore } from "./mockPaymentRepository";
import { applyRefundReview, listRefundsForOrderSync, refundStore } from "./mockRefundRepository";

/**
 * 管理端退款审核的**伪事务** —— 三个审核动作的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * §退款审核 要求「通过」在同一个原子区段里完成四件事：
 * ① 退款申请变为 `approved`；② 记录管理者、审核意见与审核时间；
 * ③ 订单变为 `refunded`；④ 写一条管理审计。
 * 这四件事分属两个 Mock Store（退款与支付/订单），仓库里没有事务可用，
 * 于是这里用的办法与 `adminCompanionTransaction` 完全一致：
 * **把读—判断—写的全过程放进一段没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「通过」请求，第二个进来时第一个已经全部写完，
 * 它读到的就是「已经通过了」，于是落回 `invalid-transition`。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。所有 store 句柄都在区段之外（函数开头）取好。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储。
 *
 * ## 三条状态边界
 *
 * - `start-review` 与 `reject` **只写退款申请**，一行订单代码都不碰。订单继续按原进度走。
 * - 只有 `approve` 会写订单，写 `status`、`refundedAt` 与 `refundedAmount`：
 *   不改退款申请上的金额快照、不改商品快照、更不改用户的任何累计字段。
 *   ⚠️ **P0-13 起 `refundedAmount` 是累加值**：这一次退多少由管理员的**比例**决定
 *   （`Order.actualPaidAmount × refundRateBp`，见 `computeRefundDecisionAmounts`），
 *   而 `status` **只在累计退满时**才变成 `refunded`。因此
 *   `status === "refunded"` 的含义是「这一单**累计**已退满」，而
 *   `refundedAmount > 0` 不再蕴含「已退款」——部分退款下两个数各答一问。
 *   「退款之后消费等级与排行榜自动排除这一单」靠的是订单状态本身
 *   （口径见 `lib/constants/levels.ts`），不是去修用户的数字。
 * - 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT`），
 *   上层的 service 与接口一行都不用改。
 *
 * ## `approve` 一次写五处（P0-13）
 *
 * 退款申请（状态 + 审核人 + **资金决策**）、订单（累计退款额）、收益（冲回额 +
 * 调整明细）、派单（**仅累计退满时**关闭）、打手通知（**仅累计退满时**），
 * 外加一条审计。五处必须在同一段无 `await` 的同步代码里，否则会出现
 * 「退款批了、打手的钱没冲回」这种账实不符——而它在页面上完全看不出来。
 *
 * ⚠️ 幂等重放判定与审计写入来自 `./adminWriteSupport`（与另外两组事务共用同一套实现）。
 */

/** 写上下文由 `./adminWriteSupport` 定义；这里再导出一次，调用方的既有引用不用改。 */
export type { AdminWriteContext };

/** 退款审核写操作的失败情形。文案由服务层翻译，数据层不产生界面文案。 */
export type AdminRefundWriteFailure =
  /** 目标不存在 */
  | { kind: "not-found" }
  /** 状态机不允许这次迁移，携带当前状态 */
  | { kind: "invalid-transition"; status: RefundStatus }
  /**
   * 这个幂等键已经被**另一个对象**用过。
   *
   * 客户端复用了幂等键属于调用方的 bug；此时安静地重放会返回另一个对象的操作结果，
   * 比报错危险得多。因此单独分出来，由服务层转成一个明确的 400。
   */
  | { kind: "operation-conflict" }
  /**
   * 退款申请挂在一笔**不存在的订单**上。这是数据异常，不是用户错误。
   *
   * 单列出来是为了不把它混进 `not-found`：那会让人以为自己传错了退款 id，
   * 而实际上该报的是服务端数据问题。服务层据此返回 500。
   */
  | { kind: "order-missing" }
  /**
   * 这次决策算出来的金额过不了闸（P0-13 D2）：单次退 0，或累计超过订单实付。
   *
   * ⚠️ 为什么校验在这里而不在服务层：这一条要读**订单当前的累计已退额**，
   * 而那个读取必须与后面的写入在同一段同步代码里（服务层先读一次再交给这里写，
   * 中间隔着一次 `await`，两次读取之间可以插进另一笔退款）。
   *
   * ⚠️ 为什么是「带一句文案」而不是「带一个枚举」：这句话来自常量层的规则函数
   * （`assertRefundAmountWithinPaid`），数据层只**转述**它，不自己造句子——
   * 与本文件其它地方「数据层不产生界面文案」并不矛盾，因为文案的唯一真值源
   * 仍在 `lib/constants/refunds.ts`。反复出现在这里的其实是同一条规则，
   * 拆成枚举再让服务层映射回来只会让这句话有两个可能的落点。
   */
  | { kind: "decision-invalid"; message: string }
  /**
   * 订单档位不允许走售后**审批**（产品裁定 2026-09-27）。
   *
   * 只有 `serving` / `completed` 能进入售后资金链；`paid` / `accepted` 走的是
   * 用户直接全额退款那条路，**不存在**可被管理员批准的售后申请。
   *
   * ⚠️ 这一条判的是**订单**档位，`invalid-transition` 判的是**退款申请**的状态——
   * 两者会同时成立（一条挂在 `accepted` 单上的 `pending` 申请，
   * 退款状态本身是允许通过的），因此必须分开报，否则管理员会以为自己点错了按钮。
   *
   * ⚠️ 与 `decision-invalid` 一样**带一句文案**：句子来自常量层的规则函数
   * （`assertRefundApprovalOrderStatus`），数据层只转述。
   */
  | { kind: "order-status-not-eligible"; message: string };

/**
 * 「只改退款申请」的两个动作（开始审核 / 拒绝）的失败情形。
 *
 * ⚠️ 用 `Exclude` 把 `decision-invalid` 与 `order-status-not-eligible` 摘出去：
 *
 * - 这两个动作的入参里**根本没有资金决策**，不可能算出「金额过不了闸」；
 * - 它们也**必须可以**作用在历史遗留的申请上——把一条挂在 `accepted` 单上的
 *   存量申请**驳回**掉，正是该有的处置方式。若把状态闸也加在它们身上，
 *   那些申请既批不了、也驳不掉，会永远悬在「待审核」。
 *
 * 补一个走不到的分支就意味着要编一句不知道说给谁听的文案，
 * 而那种文案迟早会被当成真的能发生的事去排查。
 * 类型上说不出来，比运行时再拦一道更早——与 `AdminRefundDecisionRequest`
 * 把「只有分担制才有责任比例」写进判别联合是同一个理由。
 */
export type RefundReviewWriteFailure = Exclude<
  AdminRefundWriteFailure,
  { kind: "decision-invalid" } | { kind: "order-status-not-eligible" }
>;

export type AdminRefundWriteResult =
  | {
      kind: "ok";
      value: {
        refund: RefundRequest;
        /** 审核完成后的订单（通过时它就是 `refunded`；另外两个动作下与之前相同） */
        order: Order;
        /** 这一次是否真的改动了订单。**只有通过会是 true** */
        orderChanged: boolean;
      };
      /** 这一次是否真的改动了退款申请 */
      changed: boolean;
      /** 是否是幂等重放（同一个幂等键第二次到达） */
      replayed: boolean;
    }
  | AdminRefundWriteFailure;

/** 「只改退款申请」的两个动作的返回：与 `AdminRefundWriteResult` 同形，只是失败集合少一种。 */
export type RefundReviewWriteResult =
  | Extract<AdminRefundWriteResult, { kind: "ok" }>
  | RefundReviewWriteFailure;

/** 一次写入前后的一对快照。退款快照同时带上订单当时的业务状态，见 `toRefundAuditSnapshot`。 */
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

// ——————————————————————————— 开始审核 ———————————————————————————

/**
 * 开始审核：`pending → reviewing`。
 *
 * ⚠️ **只改退款申请**。开始审核不等于通过：订单状态不变、金额不变、用户的消费统计不变，
 * 也**不写审核人与审核意见**（那两样是「结果」，这一步还没有结果）。
 */
export async function startReviewRefund(
  refundId: string,
  ctx: AdminWriteContext,
): Promise<RefundReviewWriteResult> {
  const refunds = refundStore();
  const orders = paymentStore().orders;

  // —— 原子区段开始（无 await）——
  const replay = takeReplayForAction(ctx, "refund.start-review", "refund", refundId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = refunds.refunds.get(refundId);
  if (!existing) return { kind: "not-found" };

  const order = orders.get(existing.orderId);
  if (!order) return { kind: "order-missing" };

  // 重放：这个键已经成功过一次，原样返回当前状态，**不再写任何东西**
  if (replay?.kind === "replay") {
    return {
      kind: "ok",
      value: { refund: { ...existing }, order: { ...order }, orderChanged: false },
      changed: false,
      replayed: true,
    };
  }

  if (!canTransitionRefund(existing.status, "reviewing")) {
    return { kind: "invalid-transition", status: existing.status };
  }

  const written = applyRefundReview(refundId, "reviewing", {
    at: ctx.at,
    reviewNote: existing.reviewNote,
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    actorName: ctx.actorName,
  });
  // 上面刚确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "refund.start-review",
    targetType: "refund",
    targetId: refundId,
    ...refundSnapshots(written.previous, order.status, written.updated, order.status),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { refund: written.updated, order: { ...order }, orderChanged: false },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 通过（§退款审核 的核心） ———————————————————————————

/**
 * 按**退款发生前**的订单档位，挑一条**每一句都为真**的打手退款文案。
 *
 * ⚠️ 这张表就是产品裁定 `D20` 的落点，**三档缺一不可**：
 *
 * | 退款前档位 | 文案 | 为什么这几句是真的 |
 * |---|---|---|
 * | `paid` / `accepted` | `REFUND_NOTIFICATION_COMPANION_REFUNDED` | 服务尚未开始；不生成收益 |
 * | `serving` | `..._IN_SERVICE` | 服务已开始；全额退款不生成 completed Earning |
 * | `completed` | `..._AFTER_COMPLETION` | 收益已生成过并按本次核定结果结算 |
 *
 * ⚠️ **为什么不能写成两分支**：`completed ? A : B` 会把 `paid` / `accepted`
 * 静默归进 `B`（「服务已开始」），而这两档**根本没有开始过**——
 * 于是通知又成了一句与事实相反的话，只是换到了另一档。
 * 写两分支时这**是**一条真实路径：存量申请 `rf-seed-1001-01` 挂在 `accepted` 的
 * `ord-seed-1001-03` 上，`tests/adminRefunds.test.mjs` 当时确实在批准它。
 *
 * ✅ **P0-13 §十三 `D22`（2026-09-27）之后 `paid` / `accepted` 分支不可达**：
 * 产品裁定那两档不允许批准售后退款，审核入口已由 `assertRefundApprovalOrderStatus`
 * 把守（见本文件 `approveRefund` 里的状态闸）。三档因此是**防御性**的。
 * ⚠️ 若将来这一档变得可达（有测试能批准一张 `paid` / `accepted` 单的售后申请），
 * **那是闸门被绕过的信号，该修的是闸门**——不要反过来把这一档当成合法路径。
 *
 * ⚠️ **未列入上表的档位直接抛错**（而不是给个默认文案）：`refunded` 不可能
 * 还存在可批准的申请，真出现说明不变式已经破了。这里**位于写入之前**，
 * 抛错等于整个审核**零副作用**地失败——比退完钱再发一句错话好。
 */
function resolveCompanionRefundCopy(orderStatus: Order["status"]) {
  switch (orderStatus) {
    case "paid":
    case "accepted":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED;
    case "serving":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE;
    case "completed":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION;
    default:
      throw new Error(`退款通知无对应文案：订单档位 ${orderStatus}`);
  }
}

/**
 * 构造并校验一条**发给被退单打手**的通知（尚未写入）。
 *
 * ⚠️ 与 `directRefundTransaction` / `companionOrderTransaction` 里的同名逻辑
 * **刻意各留一份**，理由与那两处相同（十几行、不含业务判断，合并反而要为
 * 「将来第 N 种通知」预留参数）。本份与它们的区别是**触发时机**：
 * 那两处是「订单还没开始服务就被退掉」，这一处是「累计退满、这一单到此为止」。
 *
 * ⚠️ **文案按订单走到哪一档选**（P0-13 后续 fix，产品裁定「按场景拆文案」）：
 * 见 `resolveCompanionRefundCopy()` —— 三档各有一条为真的文案。
 *
 * ⚠️ **只有累计退满时才会被调用**：部分退款不改订单状态、这一单还要继续做，
 * 打手并没有「被退单」——那会给一位还在服务中的打手发一条「你的订单被退款了」。
 *
 * ⚠️ 校验发生在**进入写入之前**（裁决：先验证意图，再原子写入事实）。
 * 文案格式错、`href` 带查询串这类问题必须在这里抛出来——等订单已经退了再抛，
 * 留下的就是「钱退了、通知没了」。
 */
function planCompanionRefundNotification(input: {
  userId: string;
  orderId: string;
  orderStatus: Order["status"];
  at: string;
}): Notification {
  // ⚠️ **三档必须各有一条分支**，不能写成「completed ? A : B」——
  //    那会把 `paid` / `accepted` 静默归进「服务已开始」，而它们**根本没有开始过**，
  //    于是这条通知又变成一句与事实相反的书面结论（只是换到了另一档）。
  //    写两分支时这**是**可达的：预置存量申请 `rf-seed-1001-01` 就挂在
  //    `ord-seed-1001-03`（`accepted`）上，`tests/adminRefunds.test.mjs` 当时确实在批准它。
  //    它当时没发出假通知纯属巧合——那位打手 `cp-2` 的 `userId` 为 null、没有收信地址。
  //    ✅ `D22`（2026-09-27）之后这条路已被审核入口的状态闸堵死，这一档变成防御性分支。
  const copy = resolveCompanionRefundCopy(input.orderStatus);

  const payload: NotificationInput = {
    userId: input.userId,
    // 这是「退款」这件事的通知，不是派单通知：用户端按 kind 分组展示
    kind: "refund",
    title: copy.title,
    summary: copy.summary,
    body: copy.body,
    // 打手端的订单页，不是用户端的 `/orders/[id]`——那里会重新校验订单归属
    href: `/companion/orders/${input.orderId}`,
  };

  const parsed = parseNotificationInput(payload);
  // 文案与 href 都是常量、收件人来自订单上的实际打手，这里失败只可能是常量被改坏了
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
 * 审核通过 —— 五处写入在**同一段无 `await` 的同步区段**里完成（P0-13 起由四处变五处）：
 *
 * 1. 退款申请状态改成 `approved`，并写入**资金决策**（`decision`）；
 * 2. 记录管理者（`reviewedBy`）、审核意见与审核时间（`reviewedAt`）；
 * 3. 订单**累计**写入 `refundedAmount`，累计退满时才改 `status` / `refundedAt`；
 * 4. 该订单的 Earning 上累计冲回 `reversedAmount` 并补一条 `EarningAdjustment`；
 * 5. 累计退满时：关闭仍在开着的派单 + 通知被退单的打手；
 * 6. 写一条管理审计（before/after 里同时带着退款状态与订单状态）。
 *
 * ## 金额：入参是**比例**，金额是算出来的
 *
 * 请求体里没有金额字段（`业务流程表.md` §16.B：「管理员只输入退款比例，金额由系统计算」）。
 * 三个金额一律由 `computeRefundDecisionAmounts` 按**订单冻结经济快照**算：
 * `refundAmount = floor(actualPaidAmount × rate / 10000)`，
 * 冲回额按责任归属（`platform` / `companion` / `shared`）走三条已冻结的公式，
 * 平台承担额 = 前者 − 后者（允许为负，§17 原文）。
 *
 * ⚠️ **不重查商品现价、不重查当前分账比例**：`order.actualPaidAmount` 与
 * `order.companionBaseIncome` 是下单那一刻冻结的承诺，事后用今天的规则重算等于改承诺
 * （`lib/types/earning.ts` 头部同一条原则）。
 *
 * ⚠️ **冲回额不在这里重算**：它算一次、写两处（退款决策 + 收益/明细）。
 * 两处各算一遍正是「两处不一致」的来源。
 *
 * ## 累计语义与幂等
 *
 * - 累计退满（`refundedAmount + 本次 >= actualPaidAmount`）才把订单改成 `refunded`；
 *   部分退款**不改订单状态**，这一单按原进度继续（`architecture-rules.md:191`）。
 * - `applyOrderRefund` 对「已退满」的订单短路返回 `changed: false`，既不重复累计
 *   也不刷新 `refundedAt`；重复批准本身由 `canTransitionRefund` + 重放判定挡住
 *   （`approved` 是终态），这里不新增第二套判定。
 * - 收益冲回的幂等键是 `refundId`（一次决策最多一条 `EarningAdjustment`，
 *   见 `lib/types/earning.ts`）。`approved` 是终态，因此同一笔退款走不到第二次冲回。
 *
 * ## 冲回的对象（D5 / D17）
 *
 * - `frozen` 与 `available` **都要冲**：`completed` 订单的 Earning 在售后窗口内必然还是
 *   `frozen`，只阻塞不冲减等于「售后白做」——窗口一到照样按全额解冻。
 * - `withdrawn` **不冲**（Q3 DEFER）：往一条已提现的收益上写冲回，等于**追回已提现的钱**，
 *   正是本轮被划出去的那件事。此时冲回额按 0 记，多出来的部分由平台承担，
 *   决策里照实记录（`responsibility` 仍是管理员选的那个，可审计）。
 * - 收益**不存在**时不写（`serving` 订单还没结算）：冲回额已经写在退款决策上，
 *   由结算那条路径补记（D9，见 `earningTransaction.ts`）。
 *
 * ## 刻意不做的事
 *
 * - **不清 `actualCompanionId`**：批次硬约束「accepted direct refund 保留
 *   `actualCompanionId`，不得为代码统一抹平」。`applyOrderRefund` 不碰它。
 * - **不改用户的累计消费字段**：订单变成 `refunded` 之后就不再计入累计有效消费
 *   （`sumEffectiveSpend` 只累计 `completed`），消费等级与排行榜因此自然排除这一单。
 * - **不动 `Earning.incomeAmount`**：冲回是另记一笔调整，不是把原始承诺改小（Q2-a）。
 *
 * ⚠️ 所有失败判定（记录不存在 / 订单不存在 / 非法迁移 / 金额过不了闸）都排在
 * **任何写入之前**，因此不存在「退款已通过但订单未退款」这类半完成状态；
 * 反过来也不可能——订单的写入排在退款写入之后，而它不会失败。
 */
export async function approveRefund(
  refundId: string,
  reviewNote: string,
  decisionInput: RefundDecisionInput,
  ctx: AdminWriteContext,
): Promise<AdminRefundWriteResult> {
  const refunds = refundStore();
  const orders = paymentStore().orders;
  const earnings = earningStore();
  const dispatches = dispatchStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplayForAction(ctx, "refund.approve", "refund", refundId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = refunds.refunds.get(refundId);
  if (!existing) return { kind: "not-found" };

  // 订单存在性检查排在所有写入**之前**：这样「订单不见了」这条失败路径
  // 不会走成「退款已经改成通过、订单却没动」——那正是 §原子性 明令禁止的状态
  const order = orders.get(existing.orderId);
  if (!order) return { kind: "order-missing" };

  if (replay?.kind === "replay") {
    // 重放：把当时的结果原样再报一次。订单此时已经是 refunded，`orderChanged` 如实说 false
    return {
      kind: "ok",
      value: { refund: { ...existing }, order: { ...order }, orderChanged: false },
      changed: false,
      replayed: true,
    };
  }

  if (!canTransitionRefund(existing.status, "approved")) {
    return { kind: "invalid-transition", status: existing.status };
  }

  /* —— 状态闸：只有 serving / completed 能进入售后资金链（产品裁定 2026-09-27） —— */

  // ⚠️ 这一判**必须**排在下面所有读取与写入之前：它就是「零副作用」的全部实现。
  //    放在金额计算之后、写入之前也「不会写坏东西」，但那时已经读过收益、
  //    算过金额，失败路径的语义就从「没开始」变成「算完了又反悔」——
  //    而这条闸的判据只有一个字段，没有任何理由晚判。
  //
  // ⚠️ 为什么由服务端判而不是靠前端藏按钮：这条闸要挡的是**存量**申请
  //    （`paid` / `accepted` 在 P0-12 之后已开不出新申请，但历史记录还在），
  //    客户端看不出它和一条合法申请有什么区别。
  const orderStatusMessage = assertRefundApprovalOrderStatus(order.status);
  if (orderStatusMessage !== null) {
    return { kind: "order-status-not-eligible", message: orderStatusMessage };
  }

  /* —— 决策：先读既往冲回额，再按冻结公式算三个金额 —— */

  // 这一单**此前已批准**退款的累计冲回额（定义与理由见
  // `sumApprovedCompanionReversal()`）。管理端详情 DTO 读的是**同一个函数**，
  // 因此界面上显示的「本次预计冲回」与这里真正写下去的数出自同一份规则
  const reversedSoFar = sumApprovedCompanionReversal(listRefundsForOrderSync(order.id));

  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: order.actualPaidAmount,
    companionBaseIncome: order.companionBaseIncome,
    reversedSoFar,
    input: decisionInput,
  });

  // 金额闸：单次 > 0，且**累计**不超过订单实付
  const amountMessage = assertRefundAmountWithinPaid({
    refundAmount: amounts.refundAmount,
    alreadyRefundedAmount: order.refundedAmount,
    actualPaidAmount: order.actualPaidAmount,
  });
  if (amountMessage !== null) return { kind: "decision-invalid", message: amountMessage };

  /* —— 冲回对象：该订单的收益。可能不存在（serving 单还没结算） —— */
  const earningId = earnings.earningIdByOrder.get(order.id);
  const earning = earningId ? (earnings.earnings.get(earningId) ?? null) : null;

  // D17：已提现的收益本轮不冲回（Q3 DEFER），多出来的部分由平台承担。
  // ⚠️ 这一步**不在这里自己写 `if`**：管理端界面的「本次预计退款金额」调用的是
  // 同一个 `resolveFinalDecisionAmounts()`，两处各写一遍的话，
  // 界面上会出现一个服务端永远不会写下去的数
  const finalAmounts = resolveFinalDecisionAmounts(amounts, earning?.status ?? null);
  const companionReversalAmount = finalAmounts.companionReversalAmount;

  // 决策写进退款记录（D7）。六项 + 决策人与时刻，一项不少
  const decision: RefundDecision = {
    refundRateBp: decisionInput.refundRateBp,
    refundAmount: finalAmounts.refundAmount,
    responsibility: decisionInput.responsibility,
    companionLiabilityRateBp: decisionInput.companionLiabilityRateBp,
    companionReversalAmount,
    // 用减法构造，让 §17 的恒等式在定义上成立
    platformBorneAmount: finalAmounts.platformBorneAmount,
    decidedBy: ctx.actorId,
    decidedAt: ctx.at,
  };

  // 这一次之后这一单是否退满。**只有退满才动订单状态**（P0-13 §一）
  const fullyRefunded = isFullyRefunded(
    order.refundedAmount + decision.refundAmount,
    order.actualPaidAmount,
  );

  /* —— 退满才需要的那两件：关派单、通知打手 —— */

  const dispatchId = dispatches.dispatchIdByOrder.get(order.id) ?? null;
  const dispatchToClose =
    fullyRefunded && dispatchId && dispatches.dispatches.has(dispatchId) ? dispatchId : null;

  // ⚠️ 收件人必须是这位打手的**用户账号**（`Companion.userId`），而它**可以为 null**：
  //    预置 Mock 打手（`cp-*`）大多没有对应的入驻申请，`userId` 就是 null，
  //    那样的打手不存在能收信的地址。这是「没有可通知的人」，不是「通知功能坏了」
  const companion = fullyRefunded && order.actualCompanionId
    ? readCompanionRecord(order.actualCompanionId)
    : null;
  const recipientUserId = companion?.userId ?? null;
  // 通知在**任何写入之前**构造、校验并拿到 id；写入段里只剩一次不会失败的 append
  // ⚠️ 传的是**写入之前**读到的订单状态：通知是在任何写入之前构造的，
  //    因此这里拿到的就是「这一单退掉之前走到哪一档」，文案才选得对
  const notification = recipientUserId
    ? planCompanionRefundNotification({
        userId: recipientUserId,
        orderId: order.id,
        orderStatus: order.status,
        at: ctx.at,
      })
    : null;

  /* —— 写入 —— */

  // ① ② 退款申请：状态、审核人、意见、审核时间、资金决策
  const written = applyRefundReview(refundId, "approved", {
    at: ctx.at,
    reviewNote,
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    actorName: ctx.actorName,
    decision,
  });
  // 上面刚确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
  if (!written) return { kind: "not-found" };

  // ③ 订单。这里**不会**返回 null（上一段刚确认过它存在），真发生也只能说明
  //    存储被换掉了；那种情况下宁可让整个请求失败，也不能返回「已通过」。
  //    金额是**本次退多少（增量）**，累计与状态由 `applyOrderRefund` 自己决定
  const orderWritten = applyOrderRefund(existing.orderId, ctx.at, decision.refundAmount);
  if (!orderWritten) throw new Error("退款审核通过时订单写入失败");

  // ④ 收益：累计冲回 + 一条明细。两者必须同段落库——只写其中一个，
  //    「读用总数、审计用明细」这条关系就断了（不变式用例会当场抓住）。
  //
  //    ⚠️ **先验证再动钱**（P0-13 后续 fix）：同一退款决策只能冲一次（幂等键 = refundId）。
  //    已经冲过就**跳过而不是报错**——「重放不重复冲回」是业务规则，报错会把一次
  //    本来正确的重放变成 500。判定必须在 `applyEarningReversal` **之前**：
  //    放到之后，存储层那道重复抛错留下的就是「钱冲了、明细没写」的悬空状态。
  const alreadyReversed = findEarningAdjustmentIdByRefund(refundId) !== null;
  if (earning && companionReversalAmount > 0 && !alreadyReversed) {
    const reversal = applyEarningReversal(earning.id, companionReversalAmount);
    if (!reversal) throw new Error("退款冲回时收益写入失败");

    appendEarningAdjustment({
      id: newEarningAdjustmentId(),
      earningId: earning.id,
      orderId: order.id,
      // 幂等键：一次退款决策最多一条冲回明细（Q2-d）
      refundId,
      type: "refund_reversal",
      amount: companionReversalAmount,
      responsibility: decision.responsibility,
      createdAt: ctx.at,
      adminId: ctx.actorId,
    });
  }

  // ⑤ 退满：关闭派单（它是「不得继续被接单」的第一道锁）+ 通知打手
  if (dispatchToClose) applyDispatchTimedOut(dispatchToClose, ctx.at);
  if (notification) appendNotification(notification);

  // ⑥ 审计。业务写入全部完成之后紧接着写，中间没有任何 `await`
  writeAudit({
    ctx,
    action: "refund.approve",
    targetType: "refund",
    targetId: refundId,
    ...refundSnapshots(
      written.previous,
      orderWritten.previous.status,
      written.updated,
      orderWritten.updated.status,
    ),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: {
      refund: written.updated,
      order: orderWritten.updated,
      orderChanged: orderWritten.changed,
    },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 拒绝 ———————————————————————————

/**
 * 拒绝：`pending | reviewing → rejected`。
 *
 * ⚠️ **不改订单状态，也不改任何消费金额**：用户看到的订单继续按原进度走，
 * 累计有效消费也不受影响。这正是「退款状态与订单状态是两条独立的线」在拒绝这条路径上的体现。
 *
 * ⚠️ **必须填写审核意见**，规则在 `lib/constants/adminApplications.ts` 的
 * `normalizeAdminReviewNote()`（与入驻审核共用一份），服务层校验通过后才传进来。
 */
export async function rejectRefund(
  refundId: string,
  reviewNote: string,
  ctx: AdminWriteContext,
): Promise<RefundReviewWriteResult> {
  const refunds = refundStore();
  const orders = paymentStore().orders;

  // —— 原子区段开始（无 await）——
  const replay = takeReplayForAction(ctx, "refund.reject", "refund", refundId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = refunds.refunds.get(refundId);
  if (!existing) return { kind: "not-found" };

  const order = orders.get(existing.orderId);
  if (!order) return { kind: "order-missing" };

  if (replay?.kind === "replay") {
    return {
      kind: "ok",
      value: { refund: { ...existing }, order: { ...order }, orderChanged: false },
      changed: false,
      replayed: true,
    };
  }

  if (!canTransitionRefund(existing.status, "rejected")) {
    return { kind: "invalid-transition", status: existing.status };
  }

  const written = applyRefundReview(refundId, "rejected", {
    at: ctx.at,
    reviewNote,
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    actorName: ctx.actorName,
  });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "refund.reject",
    targetType: "refund",
    targetId: refundId,
    // 拒绝不动订单，因此前后两次的订单状态相同——这不是「没记」，而是它确实没变
    ...refundSnapshots(written.previous, order.status, written.updated, order.status),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { refund: written.updated, order: { ...order }, orderChanged: false },
    changed: true,
    replayed: false,
  };
}
