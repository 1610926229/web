import { refundSeed } from "@/lib/mocks/fixtures/refundSeed";
import type { RefundRequest } from "@/lib/types/refund";
import { getMockStore } from "./mockStore";
import type { CancelRefundOutcome, CreateRefundOutcome, RefundRepository } from "./refundRepository";

/**
 * 退款申请的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（订单唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置的退款申请与用户新提交的申请因此进的是**同一个 Map、同一套查询方法**，
 * 不会出现「新提交的申请在列表里看不到」。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 */

type MockRefundStore = {
  refunds: Map<string, RefundRequest>;
  /** `${userId}:${idempotencyKey}` → 退款申请 id */
  refundIdByKey: Map<string, string>;
  /** orderId → 退款申请 id。一单一申请，所以是单值索引而不是列表 */
  refundIdByOrder: Map<string, string>;
};

function createStore(): MockRefundStore {
  const refunds = new Map(refundSeed.map((refund) => [refund.id, refund]));
  const refundIdByOrder = new Map<string, string>();
  for (const refund of refundSeed) {
    // 预置数据同样要满足「一单一申请」，重复的种子在这里就会暴露出来
    if (refundIdByOrder.has(refund.orderId)) {
      throw new Error(`预置退款数据重复关联同一订单：${refund.orderId}`);
    }
    refundIdByOrder.set(refund.orderId, refund.id);
  }

  return { refunds, refundIdByKey: new Map(), refundIdByOrder };
}

function store(): MockRefundStore {
  return getMockStore("refund", createStore);
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

export const mockRefundRepository: RefundRepository = {
  async findRefundById(id) {
    return store().refunds.get(id) ?? null;
  },

  async findRefundByKey(userId, idempotencyKey) {
    const id = store().refundIdByKey.get(keyOf(userId, idempotencyKey));
    return id ? (store().refunds.get(id) ?? null) : null;
  },

  async findRefundByOrderId(orderId) {
    const id = store().refundIdByOrder.get(orderId);
    return id ? (store().refunds.get(id) ?? null) : null;
  },

  async createRefundRequest(refund, idempotencyKey): Promise<CreateRefundOutcome> {
    const current = store();
    const key = keyOf(refund.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // 1) 幂等：这个键提交过就直接返回上一次的结果
    const existingId = current.refundIdByKey.get(key);
    if (existingId) {
      const existing = current.refunds.get(existingId);
      if (existing) return { ok: true, refund: existing, created: false };
    }

    // 2) 一单一申请：这一单已经有退款记录（不论状态）就不再创建
    const orderRefundId = current.refundIdByOrder.get(refund.orderId);
    if (orderRefundId) {
      const existing = current.refunds.get(orderRefundId);
      if (existing) return { ok: false, reason: "order_already_has_refund", existing };
    }

    current.refunds.set(refund.id, refund);
    current.refundIdByKey.set(key, refund.id);
    current.refundIdByOrder.set(refund.orderId, refund.id);
    // —— 原子区段结束 ——

    return { ok: true, refund, created: true };
  },

  async cancelRefund(id, userId, cancelledAt): Promise<CancelRefundOutcome> {
    const current = store();

    // —— 原子区段开始（无 await）——
    const refund = current.refunds.get(id);
    // 不存在与不属于你表现完全一致：调用方无法用接口枚举别人的退款申请 id
    if (!refund || refund.userId !== userId) return { ok: false, reason: "not_found" };
    if (refund.status !== "pending") return { ok: false, reason: "not_cancellable" };

    const updated: RefundRequest = {
      ...refund,
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
    };
    current.refunds.set(id, updated);
    // —— 原子区段结束 ——

    return { ok: true, refund: updated };
  },
};
