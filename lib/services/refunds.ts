import { ApiError } from "@/lib/api/ApiError";
import { isComplaintWindowClosed } from "@/lib/constants/complaints";
import {
  parseEvidenceInput,
  toStoredEvidence,
  type EvidenceDraft,
} from "@/lib/constants/evidence";
import { ORDER_STATUS_LABELS, isOrderStatus } from "@/lib/constants/orders";
import {
  DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE,
  DIRECT_REFUND_NOT_ALLOWED_MESSAGE,
  DIRECT_REFUND_NOT_STARTED_MESSAGE,
  REFUND_ALREADY_ACTIVE_MESSAGE,
  REFUND_AMOUNT_INVALID_MESSAGE,
  REFUND_DESCRIPTION_EMPTY_MESSAGE,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_DESCRIPTION_TOO_LONG_MESSAGE,
  REFUND_NOT_CANCELLABLE_MESSAGE,
  REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  REFUND_REASON_LABELS,
  REFUND_REASON_REQUIRED_MESSAGE,
  REFUND_STATUS_LABELS,
  REFUND_WINDOW_CLOSED_MESSAGE,
  canCancelRefund,
  canDirectRefund,
  canRequestRefund,
  isActiveRefundStatus,
  isRefundReason,
} from "@/lib/constants/refunds";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { directRefundOrder } from "@/lib/data/directRefundTransaction";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  RefundDetail,
  RefundReasonKey,
  RefundRequest,
  RefundSummary,
  RefundTimelineEntry,
} from "@/lib/types/refund";

/**
 * 退款服务 —— 退款页、退款详情页与退款接口共用的唯一入口。
 *
 * 四条硬规则，本文件是它们唯一的落点：
 *
 * 1. **能不能退由服务端判断**。`canRequestRefund` 同时看订单状态与这一单有没有
 *    **进行中**的退款申请，接口再校验一次，按钮只是提示。
 * 2. **金额由服务端算，用户一个金额字段都没有**。请求体里没有金额（白名单解析）；
 *    P0-13 起**管理员也只输入比例**，金额由
 *    `computeRefundDecisionAmounts()` 按 §17 的冻结公式从订单快照算出来。
 *    用户这一侧连比例都填不了——他只提交原因、说明与凭证。
 * 3. **提交退款申请不改订单状态**（`createRefundForOrder`）。这里只写退款申请，绝不碰订单；
 *    订单进入 `refunded` 只能由审核流程完成。这是本阶段最重要的一条：两条状态线不能互相推导。
 *    ⚠️ **P0-12 起这条规则只约束「申请」这一条路径**：`paid` / `accepted` 走
 *    `directRefundOrderForUser`，那条路径**本来就必须当场改订单状态**——免审批的全额退款
 *    没有「等审核」这一步，也不产生任何退款申请记录。两条路径各自内部自洽，
 *    因此规则 3 不是被放宽了，而是它从来只管申请那条线。
 *    ⚠️ **P0-13 起多一条例外，而它其实也在规则之内**：申请被批准时订单**只在累计退满时**
 *    才转 `refunded`（部分退款不改状态）。批准那条路径本来就在「审核流程」里，
 *    因此规则 3 说的是「**申请**这一步不碰订单」，不是「没有任何东西能碰订单」。
 * 4. **写入幂等**。申请按「用户 + 幂等键」去重；**同一订单可以有多条申请**，
 *    但同一时刻只允许一条**进行中**（P0-13 起，见 `canRequestRefund`）；
 *    直接退款按**订单状态与已退金额**去重（见 `directRefundOrder` 的说明），
 *    两者都不依赖前端按钮禁用。
 */

// ——————————————————————————— 输入解析 ———————————————————————————

type RefundInput = {
  reasonKey: RefundReasonKey;
  description: string;
  evidence: EvidenceDraft[];
};

/**
 * 按**白名单**解析退款表单。
 *
 * 只有原因、说明、凭证三类字段会被读取——`amount` / `status` / `orderId` 之类即便塞进
 * 请求体也会被直接丢弃。这不是「检查一下金额对不对」，而是根本不存在接收金额的字段。
 */
export function parseRefundInput(body: Record<string, unknown>): RefundInput {
  const rawReason = typeof body.reasonKey === "string" ? body.reasonKey.trim() : "";
  if (!rawReason || !isRefundReason(rawReason)) {
    throw new ApiError("BAD_REQUEST", REFUND_REASON_REQUIRED_MESSAGE);
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) throw new ApiError("BAD_REQUEST", REFUND_DESCRIPTION_EMPTY_MESSAGE);
  if (description.length > REFUND_DESCRIPTION_MAX_LENGTH) {
    throw new ApiError("BAD_REQUEST", REFUND_DESCRIPTION_TOO_LONG_MESSAGE);
  }

  const evidence = parseEvidenceInput(body.evidence);
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  return { reasonKey: rawReason, description, evidence: evidence.items };
}

// ——————————————————————————— 转换 ———————————————————————————

/** 退款申请 → 摘要。**显式挑字段**：原因、说明、凭证都不会出现在摘要里。 */
export function toRefundSummary(refund: RefundRequest): RefundSummary {
  return {
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    createdAt: refund.createdAt,
  };
}

/** 退款单号：日期 + 随机尾号。只用于展示，不作为业务主键。 */
function makeRefundNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `RF${stamp}${tail}`;
}

/** 进度时间轴：只包含**已经发生**的节点，按时间先后排列。 */
export function buildRefundTimeline(refund: RefundRequest): RefundTimelineEntry[] {
  const entries: RefundTimelineEntry[] = [
    {
      key: "pending",
      label: REFUND_STATUS_LABELS.pending,
      at: refund.createdAt,
      note: "退款申请已提交，等待客服审核",
    },
  ];

  if (refund.reviewingAt) {
    entries.push({
      key: "reviewing",
      label: REFUND_STATUS_LABELS.reviewing,
      at: refund.reviewingAt,
      note: "客服已开始审核这笔退款申请",
    });
  }
  if (refund.status === "approved" && refund.reviewedAt) {
    entries.push({
      key: "approved",
      label: REFUND_STATUS_LABELS.approved,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请已通过",
    });
  }
  if (refund.status === "rejected" && refund.reviewedAt) {
    entries.push({
      key: "rejected",
      label: REFUND_STATUS_LABELS.rejected,
      at: refund.reviewedAt,
      note: refund.reviewNote || "退款申请未通过",
    });
  }
  if (refund.status === "cancelled" && refund.cancelledAt) {
    entries.push({
      key: "cancelled",
      label: REFUND_STATUS_LABELS.cancelled,
      at: refund.cancelledAt,
      note: "你撤销了这笔退款申请",
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

/**
 * 退款申请 + 关联订单 → 详情 DTO。
 *
 * 订单侧的信息（订单号、商品快照、当前业务状态）取自订单自己的快照，
 * 因此退款审核期间订单状态不会变成 `refunded`——页面在这里如实展示订单「现在」的状态。
 */
export function toRefundDetail(refund: RefundRequest, order: Order): RefundDetail {
  return {
    ...toRefundSummary(refund),
    refundNo: refund.refundNo,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.status,
    orderStatusLabel: isOrderStatus(order.status) ? ORDER_STATUS_LABELS[order.status] : order.status,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    orderTotalAmount: order.totalAmount,

    reasonKey: refund.reasonKey,
    reasonLabel: refund.reasonLabel,
    description: refund.description,
    evidence: refund.evidence,

    // ⚠️ 只给**结果金额**：平台与打手之间怎么分（责任归属、冲回额、平台承担额）
    // 是平台财务，用户端没有任何展示位置（P0-13 D13）
    decidedAmount: refund.decision?.refundAmount ?? null,

    updatedAt: refund.updatedAt,
    reviewedAt: refund.reviewedAt,
    reviewNote: refund.reviewNote,
    cancelledAt: refund.cancelledAt,

    timeline: buildRefundTimeline(refund),

    // 权限由服务端给出：前端只按这个值显示「撤销申请」按钮
    allowedActions: { canCancelRefund: canCancelRefund(refund.status) },
  };
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 读取一笔退款申请详情。
 *
 * 退款申请不存在、或不属于当前用户，一律返回 null——**两种情况的对外表现完全相同**，
 * 调用方据此返回同一个 404，从而不能拿别人的退款 id 来试探它是否存在。
 */
export async function getRefundDetailForUser(
  refundId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<RefundDetail | null> {
  if (!refundId) return null;

  const refund = await withMockDebug(params, surface, () =>
    getRefundRepository().findRefundById(refundId),
  );
  if (!refund || refund.userId !== userId) return null;

  const order = await getPaymentRepository().findOrderById(refund.orderId);
  if (!order) {
    // 退款挂在一笔不存在的订单上是数据异常，不能当成 404 —— 那会让人以为是自己传错了 id
    throw new ApiError("SERVER_ERROR", "退款申请关联的订单数据异常");
  }

  return toRefundDetail(refund, order);
}

/** 某一笔订单的退款摘要（订单详情页用）。 */
export async function getOrderRefundSummary(orderId: string): Promise<RefundSummary | null> {
  const refund = await getRefundRepository().findRefundByOrderId(orderId);
  return refund ? toRefundSummary(refund) : null;
}

/**
 * 退款相关的权限值与金额，一次算清：申请（人工审核）· 直接退款（免审批）· 撤销申请 ·
 * **这一次直退会退回多少**。
 *
 * ⚠️ 前两个**互斥**，而互斥关系由 `lib/constants/refunds.ts` 里两个状态集合
 * **不相交**来保证，不在这里写 `!canDirectRefund` 之类的补丁——
 * 那种写法会让「两条路径不能同时存在」变成某一处的判断，而不是集合本身的性质。
 *
 * ⚠️ 与 `canRequestRefund` 一样，`canDirectRefund` **不能只看状态就想完**：
 * 它还要看**已退金额**（退满了就不该再出现按钮）。金额那一半由
 * `directRefundOrder` 的原子区段兜底。
 *
 * ⚠️ **P0-13 整改**：上面那句「兜底」原先只兜「**退满**」，兜不住「**部分已退**」——
 * `directRefundOrder` 的第三道判据是 `refundedAmount >= actualPaidAmount`，
 * 而一张退了 30% 的订单在这一句上是不成立的。真正的缺口在**金额**：
 * `applyOrderRefund` 的第三个参数是「本次增量」，传实付会把它加成「已退 + 实付」。
 * 因此这条路径改成退**剩余可退额**，并在这里把两个金额一并交给页面——
 * 页面照报，不做减法。
 *
 * ⚠️ **P0-13：传进来的 `refund` 是「该订单最新一条」**（`findRefundByOrderId` 的口径），
 * 而 `canRequestRefund` 问的是「有没有**进行中**的」——因此这里要再判一次状态，
 * 不能只写 `refund !== null`。这两件事在今天**恰好等价**（有进行中的那条一定是最新的，
 * 因为进行中的记录存在时不允许再开一条），但不能靠「恰好」：
 * 写成 `refund !== null` 的话，等哪天并发的第二条被放进来，
 * 已结束的最新一条会挡住一个本该可用的入口。
 */
export function buildRefundActions(
  order: Order,
  refund: RefundRequest | null,
): {
  canRequestRefund: boolean;
  canDirectRefund: boolean;
  canCancelRefund: boolean;
  directRefundAmountCents: number | null;
  alreadyRefundedAmountCents: number | null;
} {
  const hasActiveRefund = refund !== null && isActiveRefundStatus(refund.status);
  const directRefundAllowed = canDirectRefund(order.status);
  // 可退额 = 实付 − 累计已退。这里**不是**复制 `directRefundOrder` 的算法，
  // 而是同一个事实的展示面：两处都由 `refundedAmount <= actualPaidAmount` 这条
  // 冻结约束兜着（写入器还会再钳一次），因此页面报的数与真正到账的数不会分叉
  const refundableAmount = Math.max(0, order.actualPaidAmount - order.refundedAmount);
  return {
    canRequestRefund: canRequestRefund(order.status, hasActiveRefund),
    canDirectRefund: directRefundAllowed,
    canCancelRefund: refund !== null && canCancelRefund(refund.status),
    directRefundAmountCents: directRefundAllowed ? refundableAmount : null,
    alreadyRefundedAmountCents: directRefundAllowed ? order.refundedAmount : null,
  };
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 提交退款申请。
 *
 * 顺序刻意如此：
 *
 * 1. 幂等键格式不对直接拒绝——没有键就无法防重，宁可不做；
 * 2. **快速路径**：这个键提交过就返回上一次的结果，连校验都不重来
 *    （重试要的是「和上次一样的结果」，而不是「按现在的状态重新算一遍」）；
 * 3. 订单不存在 / 不属于当前用户 → 404（对外与「不存在」无差别）；
 * 4. 业务校验：订单状态可退、这一单没有**进行中**的申请、**售后窗口未过**；
 * 5. 金额取订单实付金额，写入申请。**不修改订单**。
 *
 * ⚠️ **P0-13 起同一订单可以有多条申请**（部分退款必须能退第二次）。
 * 因此第 4 步从「没有任何记录」改成「没有进行中的记录」，
 * 「已拒绝 / 已撤销过也能再申请」是这次放宽的**已知后果**，产品已裁定接受（D10）。
 * 累计退满时订单转 `refunded`，而 `refunded` 不在可退状态集合里，
 * 入口与接口都会自动关上——不需要再靠「有没有记录」去挡。
 */
export async function createRefundForOrder(
  orderId: string,
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ refundId: string; created: boolean }> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getRefundRepository();

  const existing = await repository.findRefundByKey(userId, idempotencyKey);
  if (existing) return { refundId: existing.id, created: false };

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) {
    throw new ApiError("NOT_FOUND", "订单不存在");
  }

  const current = await repository.findRefundByOrderId(order.id);
  // 只挡**进行中**的那一条：同一时刻不能对同一单开两条流程。
  // 已结束（已拒绝 / 已撤销 / 已通过）的记录不再挡——部分退款要能退第二次。
  if (current && isActiveRefundStatus(current.status)) {
    throw new ApiError("BAD_REQUEST", REFUND_ALREADY_ACTIVE_MESSAGE);
  }
  if (!canRequestRefund(order.status, false)) {
    throw new ApiError("BAD_REQUEST", REFUND_ORDER_NOT_ALLOWED_MESSAGE);
  }
  /**
   * ⚠️ **售后窗口**（P0-13 §一：completed 售后必须在订单冻结的窗口内）。
   *
   * 判据**原样复用** `isComplaintWindowClosed`（D11）：它读的是订单自己的
   * `complaintDeadlineAt` 快照，**不读当前 PlatformConfig**，
   * 因此天然满足「必须使用订单冻结 deadline，不读取当前配置追溯历史」。
   *
   * 不加 `status === "completed"` 的前置判断是**刻意**的：`isComplaintWindowClosed`
   * 对没有快照的订单（在途订单、P0-9 之前的历史订单）返回 `false`，
   * 也就是「窗口没关」。再加一层状态判断等于把同一条规则写成两处，
   * 而两处迟早会不一致。
   */
  if (isComplaintWindowClosed(order, new Date().toISOString())) {
    throw new ApiError("BAD_REQUEST", REFUND_WINDOW_CLOSED_MESSAGE);
  }
  // 实付异常时不生成一条 0 元的退款申请。
  // ⚠️ 判据是 `actualPaidAmount`（§17 的退款基数）而不是 `totalAmount`：
  // 券接入之后两者会分开，而退款只能按**用户实付**退，不能按渠道原价退。
  if (order.actualPaidAmount <= 0) {
    throw new ApiError("BAD_REQUEST", REFUND_AMOUNT_INVALID_MESSAGE);
  }

  const input = parseRefundInput(body);
  const now = new Date().toISOString();

  const outcome = await repository.createRefundRequest(
    {
      id: `rf_${crypto.randomUUID()}`,
      refundNo: makeRefundNo(new Date()),
      userId,
      orderId: order.id,
      // 用户新提交的申请只会是「待审核」：本阶段没有用户端的审核入口
      status: "pending",
      // 申请时的实付快照。⚠️ 它**不是**「最后退了多少」——后者是 `decision.refundAmount`
      amount: order.actualPaidAmount,
      // 还没人决策。`null` 而不是零值决策：见 `RefundRequest.decision` 的注释
      decision: null,

      reasonKey: input.reasonKey,
      reasonLabel: REFUND_REASON_LABELS[input.reasonKey] ?? input.reasonKey,
      description: input.description,
      // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
      evidence: toStoredEvidence(input.evidence),

      createdAt: now,
      updatedAt: now,
      reviewingAt: null,
      reviewedAt: null,
      // 用户新提交的申请一定还没有审核结果，因此也一定还没有审核人
      reviewedBy: null,
      reviewedByRole: null,
      reviewedByName: null,
      reviewNote: "",
      cancelledAt: null,
    },
    idempotencyKey,
  );

  if (!outcome.ok) {
    // 走到这里说明上面查过之后、写入之前有另一个请求先进来了（并发提交）。
    // 仓储的原子区段挡住了第二条**进行中**的记录，这里翻译成同样的业务提示。
    // ⚠️ 只剩这一种失败原因了（已结束的记录不再被拒），因此不再需要分支。
    throw new ApiError("BAD_REQUEST", REFUND_ALREADY_ACTIVE_MESSAGE);
  }

  return { refundId: outcome.refund.id, created: outcome.created };
}

// ——————————————————————————— 直接全额退款（P0-12，免审批） ———————————————————————————

/**
 * 用户**直接全额退款**：`paid → refunded` / `accepted → refunded`。
 *
 * 与上面 `createRefundForOrder` 的差别不是「快一点」或「少一步」，而是**业务完全不同**：
 * 那个是向客服**申请**（写一条待审核记录，**订单一动不动**），这个是**当场就退**
 * （没有申请、没有审核人、没有审批环）。因此它写得像「一步到位的动作」，
 * 而不是「一条流程的起点」——它没有返回值让前端跳去哪个进度页，因为**没有进度页**。
 *
 * 四件事的顺序都是刻意的：
 *
 * 1. **归属校验在事务之前**。事务只回答「这件事在数据上此刻成不成立」，
 *    它不知道也不该知道「谁在问」。查不到、或不是本人的订单一律**同一个 404**——
 *    否则就能拿订单 id 逐个试探别人有哪些订单。
 * 2. **业务失败在事务里判定**，不在这里先用状态预判一遍：预判等于把规则抄成两份，
 *    而两份迟早会不一致（真正的保护必须在写入的那一段同步代码里）。
 * 3. **失败原因翻译成人话**时才带状态：「已开始服务」与「这单现在退不了」对用户
 *    是两件不同的事，前者还有路可走（走售后找客服），后者没有。
 * 4. **金额不由调用方给**：请求体里没有金额字段，事务从订单上取 `actualPaidAmount`。
 *
 * ⚠️ 不需要幂等键。同一个意图第二次到达时，订单**已经是** `refunded`，
 * 事务据此返回 `already-refunded`——比幂等键更强，因为状态是事实而不是调用方给的串，
 * 因此它同样挡得住「不是同一个人点的第二次」（超时清扫、管理员退款）。
 */
export async function directRefundOrderForUser(
  orderId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ orderId: string; orderNo: string; refundedAmount: number; refundedAt: string }> {
  if (!orderId) throw new ApiError("NOT_FOUND", "订单不存在");

  const order = await withMockDebug(params, surface, () =>
    getPaymentRepository().findOrderById(orderId),
  );
  if (!order || order.userId !== userId) {
    throw new ApiError("NOT_FOUND", "订单不存在");
  }

  const outcome = await directRefundOrder(orderId, new Date().toISOString());

  switch (outcome.kind) {
    case "ok":
      return {
        orderId: outcome.orderId,
        orderNo: outcome.orderNo,
        refundedAmount: outcome.refundedAmount,
        refundedAt: outcome.refundedAt,
      };
    case "not-found":
      // 事务之前刚查到过；真发生说明存储被换掉了。对外与「本来就没有」无差别
      throw new ApiError("NOT_FOUND", "订单不存在");
    case "already-refunded":
      throw new ApiError("BAD_REQUEST", DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE);
    case "amount-invalid":
      // 实付 ≤ 0 的订单退无可退。与申请路径对同一异常**共用同一句文案**
      // （「订单金额异常，暂时无法发起退款」）——「这一单的钱本身是坏的」只有一种说法
      throw new ApiError("BAD_REQUEST", REFUND_AMOUNT_INVALID_MESSAGE);
    case "not-eligible":
      // `refunded` 在上面那一支已经拦掉了，走到这里的只有「已经开始 / 已经结束」
      throw new ApiError(
        "BAD_REQUEST",
        outcome.status === "serving" ? DIRECT_REFUND_NOT_STARTED_MESSAGE : DIRECT_REFUND_NOT_ALLOWED_MESSAGE,
      );
  }
}

// ——————————————————————————— 撤销 ———————————————————————————

/**
 * 撤销退款申请。
 *
 * 只有**待审核**且属于当前用户的申请可以撤销：归属与状态的判断都在仓储的原子区段里，
 * 因此不存在「查的时候还是待审核、写的时候已经变了」的窗口。
 * 撤销只改退款申请的状态，**不动订单**——订单按原进度继续。
 */
export async function cancelRefundForUser(
  refundId: string,
  userId: string,
): Promise<{ refundId: string; status: string }> {
  if (!refundId) throw new ApiError("NOT_FOUND", "退款申请不存在");

  const outcome = await getRefundRepository().cancelRefund(
    refundId,
    userId,
    new Date().toISOString(),
  );

  if (!outcome.ok) {
    if (outcome.reason === "not_found") throw new ApiError("NOT_FOUND", "退款申请不存在");
    throw new ApiError("BAD_REQUEST", REFUND_NOT_CANCELLABLE_MESSAGE);
  }

  return { refundId: outcome.refund.id, status: outcome.refund.status };
}
