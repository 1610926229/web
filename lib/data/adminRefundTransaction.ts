import { toRefundAuditSnapshot } from "@/lib/constants/adminAudit";
import { canTransitionRefund } from "@/lib/constants/adminRefunds";
import type { AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type { Order } from "@/lib/types/order";
import type { RefundRequest, RefundStatus } from "@/lib/types/refund";
import { takeReplayForAction, writeAudit, type AdminWriteContext } from "./adminWriteSupport";
import { applyOrderRefund, paymentStore } from "./mockPaymentRepository";
import { applyRefundReview, refundStore } from "./mockRefundRepository";

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
 *   `refundedAmount` 写的是**订单自己的 `actualPaidAmount`**——当前只有全额退款，
 *   因此 `status === "refunded"` 的含义就是「这一单已全额退款」。
 *   「退款之后消费等级与排行榜自动排除这一单」靠的是订单状态本身
 *   （口径见 `lib/constants/levels.ts`），不是去修用户的数字。
 * - 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT`），
 *   上层的 service 与接口一行都不用改。
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
  | { kind: "order-missing" };

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
): Promise<AdminRefundWriteResult> {
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
 * 审核通过 —— 四件事在**同一段无 `await` 的同步区段**里完成：
 *
 * 1. 退款申请状态改成 `approved`；
 * 2. 记录管理者（`reviewedBy`）、审核意见与审核时间（`reviewedAt`）；
 * 3. 订单改成 `refunded`，并写入 `refundedAmount`（见下）；
 * 4. 写一条管理审计（before/after 里同时带着退款状态与订单状态）。
 *
 * ⚠️ **金额取自订单，不取自退款申请**：`RefundRequest.amount` 是申请创建时的服务端
 * 订单实付快照，管理端没有修改它的入口，这里也没有任何参数能传金额进来。
 * 要写进 `Order.refundedAmount` 的那个数从**被修改的那张订单**上读
 * （`order.actualPaidAmount`）——同一事实只有一个真值源，写的是订单实付（全额退款）。
 *
 * ⚠️ **幂等由 `applyOrderRefund` 兜底**：`order` 是原子区段开头取到的写入前快照，
 * 而 `applyOrderRefund` 对已经是 `refunded` 的订单会短路返回 `changed: false`，
 * 既不重复累计 `refundedAmount`、也不刷新 `refundedAt`。因此重复批准
 * （无论是重放还是「已退款状态不能二次退款」被挡住之前的那一瞬）都不会把金额叠加两次。
 * 「已退款不能二次退款」本身仍由 `canTransitionRefund` + 重放判定负责，这里不新增第二套判定。
 *
 * ⚠️ **不改用户的累计消费字段**：订单变成 `refunded` 之后就不再计入累计有效消费
 * （`sumEffectiveSpend` 只累计 `completed`），消费等级与排行榜因此自然排除这一单。
 * 用「去改用户的数字」来实现排除，会在两处口径之间留下一个迟早不一致的副本。
 *
 * ⚠️ 「订单不存在」在**任何写入之前**就被挡掉，因此失败不会留下
 * 「退款已通过但订单未退款」这种半完成状态；反过来也不可能出现
 * 「订单已退款但退款未通过」——订单的写入排在退款写入之后，而它不会失败。
 */
export async function approveRefund(
  refundId: string,
  reviewNote: string,
  ctx: AdminWriteContext,
): Promise<AdminRefundWriteResult> {
  const refunds = refundStore();
  const orders = paymentStore().orders;

  // —— 原子区段开始（无 await）——
  const replay = takeReplayForAction(ctx, "refund.approve", "refund", refundId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = refunds.refunds.get(refundId);
  if (!existing) return { kind: "not-found" };

  // 订单存在性检查排在两次写入**之前**：这样「订单不见了」这条失败路径
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

  // ① ② 退款申请：状态、审核人、意见、审核时间
  const written = applyRefundReview(refundId, "approved", {
    at: ctx.at,
    reviewNote,
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    actorName: ctx.actorName,
  });
  if (!written) return { kind: "not-found" };

  // ③ 订单。这里**不会**返回 null（上一段刚确认过它存在），
  //    真发生也只能说明存储被换掉了；那种情况下宁可让整个请求失败，
  //    也不能返回「已通过」——那会变成「退款已通过但订单未退款」。
  //    金额取自订单自己的实付（写入前的快照）：当前只有全额退款，故写 `actualPaidAmount`；
  //    不传金额会让用户看到「已退款」但「累计已退 0 元」。
  //    订单已经是 `refunded` 时 `applyOrderRefund` 短路返回 `changed: false`，
  //    因此重复批准不会重复累计、也不会刷新 `refundedAt`。
  const orderWritten = applyOrderRefund(existing.orderId, ctx.at, order.actualPaidAmount);
  if (!orderWritten) throw new Error("退款审核通过时订单写入失败");

  // ④ 审计。业务写入全部完成之后紧接着写，中间没有任何 `await`
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
): Promise<AdminRefundWriteResult> {
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
