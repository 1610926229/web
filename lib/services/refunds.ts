import { ApiError } from "@/lib/api/ApiError";
import {
  parseEvidenceInput,
  toStoredEvidence,
  type EvidenceDraft,
} from "@/lib/constants/evidence";
import { ORDER_STATUS_LABELS, isOrderStatus } from "@/lib/constants/orders";
import {
  REFUND_ALREADY_ACTIVE_MESSAGE,
  REFUND_AMOUNT_INVALID_MESSAGE,
  REFUND_DESCRIPTION_EMPTY_MESSAGE,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_DESCRIPTION_TOO_LONG_MESSAGE,
  REFUND_NOT_CANCELLABLE_MESSAGE,
  REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  REFUND_REASON_LABELS,
  REFUND_REASON_REQUIRED_MESSAGE,
  REFUND_RECORD_EXISTS_MESSAGE,
  REFUND_STATUS_LABELS,
  canCancelRefund,
  canRequestRefund,
  isActiveRefundStatus,
  isRefundReason,
} from "@/lib/constants/refunds";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
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
 * 1. **能不能退由服务端判断**。`canRequestRefund` 同时看订单状态与这一单有没有退款记录，
 *    接口再校验一次，按钮只是提示。
 * 2. **金额由服务端算**。请求体里没有任何金额字段（白名单解析），金额取订单实付金额，
 *    整单退款，用户填不了也改不了。
 * 3. **提交退款不改订单状态**。这里只写退款申请，绝不碰订单；订单进入 `refunded`
 *    只能由将来的审核流程完成。这是本阶段最重要的一条：两条状态线不能互相推导。
 * 4. **写入幂等**。同「用户 + 幂等键」只产生一条申请，「一笔订单一条申请」由仓储保证，
 *    不依赖前端按钮禁用。
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

/** 撤销申请需要展示的权限：这一单有没有退款申请、能不能撤销。 */
export function buildRefundActions(
  order: Order,
  refund: RefundRequest | null,
): { canRequestRefund: boolean; canCancelRefund: boolean } {
  return {
    canRequestRefund: canRequestRefund(order.status, refund !== null),
    canCancelRefund: refund !== null && canCancelRefund(refund.status),
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
 * 4. 业务校验：订单状态可退、这一单没有退款记录；
 * 5. 金额取订单实付金额，写入申请。**不修改订单**。
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
  if (current) {
    // 已有进行中的申请，与「已申请过但已结束」提示不同：前者用户可以去看进度，
    // 后者是这一阶段根本不支持再次申请。
    throw new ApiError(
      "BAD_REQUEST",
      isActiveRefundStatus(current.status) ? REFUND_ALREADY_ACTIVE_MESSAGE : REFUND_RECORD_EXISTS_MESSAGE,
    );
  }
  if (!canRequestRefund(order.status, false)) {
    throw new ApiError("BAD_REQUEST", REFUND_ORDER_NOT_ALLOWED_MESSAGE);
  }
  // 整单退款：金额就是订单实付金额。金额异常时不生成一条 0 元的退款申请
  if (order.totalAmount <= 0) {
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
      amount: order.totalAmount,

      reasonKey: input.reasonKey,
      reasonLabel: REFUND_REASON_LABELS[input.reasonKey] ?? input.reasonKey,
      description: input.description,
      // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
      evidence: toStoredEvidence(input.evidence),

      createdAt: now,
      updatedAt: now,
      reviewingAt: null,
      reviewedAt: null,
      reviewNote: "",
      cancelledAt: null,
    },
    idempotencyKey,
  );

  if (!outcome.ok) {
    // 走到这里说明上面查过之后、写入之前有另一个请求先进来了（并发提交）。
    // 仓储的原子区段挡住了第二条记录，这里把结果翻译成同样的业务提示。
    throw new ApiError(
      "BAD_REQUEST",
      isActiveRefundStatus(outcome.existing.status)
        ? REFUND_ALREADY_ACTIVE_MESSAGE
        : REFUND_RECORD_EXISTS_MESSAGE,
    );
  }

  return { refundId: outcome.refund.id, created: outcome.created };
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
