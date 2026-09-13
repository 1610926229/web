import type { Order } from "@/lib/types/order";
import type {
  MockPaymentResult,
  Payment,
  PaymentRequest,
  PaymentStatus,
} from "@/lib/types/payment";
import type { PaymentRepository } from "./paymentRepository";

/**
 * 支付与订单的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：
 * - 数据只在内存里，**开发服务器重启后全部丢失**，这是预期行为；
 * - 不写 localStorage、不写文件、不写数据库，客户端也拿不到任何「可信状态」；
 * - 将来由真实数据库替换（唯一索引 + 事务），本文件的删除不影响上层接口。
 *
 * 存储挂在 globalThis 上：开发模式热更新会重新执行模块，若存在模块作用域里，
 * 每次改动文件都会把已创建的支付请求和订单清空，联调时非常难用。
 * 挂到 globalThis 后同一个 Node 进程内始终是同一个 store。
 *
 * 并发安全的前提：Node 是单线程的，而下面的「读—判断—写」区段里**没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 */

type MockStore = {
  paymentRequests: Map<string, PaymentRequest>;
  orders: Map<string, Order>;
  payments: Map<string, Payment>;
  /** `${userId}:${idempotencyKey}` → 支付请求 id */
  requestIdByKey: Map<string, string>;
};

const STORE_KEY = "__youmuMockPaymentStore";

function createStore(): MockStore {
  return {
    paymentRequests: new Map(),
    orders: new Map(),
    payments: new Map(),
    requestIdByKey: new Map(),
  };
}

function store(): MockStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: MockStore };
  if (!holder[STORE_KEY]) holder[STORE_KEY] = createStore();
  return holder[STORE_KEY];
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

const RESULT_TO_STATUS: Record<MockPaymentResult, PaymentStatus> = {
  success: "success",
  failure: "failed",
  cancel: "cancelled",
};

export const mockPaymentRepository: PaymentRepository = {
  async findPaymentRequestByKey(userId, idempotencyKey) {
    const id = store().requestIdByKey.get(keyOf(userId, idempotencyKey));
    return id ? (store().paymentRequests.get(id) ?? null) : null;
  },

  async findPaymentRequestById(id) {
    return store().paymentRequests.get(id) ?? null;
  },

  async createPaymentRequest(request) {
    const current = store();
    const key = keyOf(request.userId, request.idempotencyKey);

    // —— 原子区段开始（无 await）——
    const existingId = current.requestIdByKey.get(key);
    if (existingId) {
      const existing = current.paymentRequests.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按未创建处理，保证不会卡死下单
      if (existing) return { request: existing, created: false };
    }
    current.paymentRequests.set(request.id, request);
    current.requestIdByKey.set(key, request.id);
    // —— 原子区段结束 ——

    return { request, created: true };
  },

  async confirmPaymentRequest(id, result, buildOrder) {
    const current = store();
    const request = current.paymentRequests.get(id);
    if (!request) return null;

    // —— 原子区段开始（无 await）——
    // 已是终态：原样返回既有结果。重复确认成功不会生成第二个订单。
    if (request.status !== "pending") {
      const settledOrder = request.orderId ? (current.orders.get(request.orderId) ?? null) : null;
      return { request, order: settledOrder, orderCreated: false };
    }

    const now = new Date();
    const paidAt = now.toISOString();
    const status = RESULT_TO_STATUS[result];

    let order: Order | null = null;
    if (status === "success") {
      order = buildOrder(request);
      const payment: Payment = {
        id: `pay_${crypto.randomUUID()}`,
        paymentRequestId: request.id,
        orderId: order.id,
        userId: request.userId,
        amount: request.totalAmount,
        status: "success",
        paidAt,
      };
      current.orders.set(order.id, order);
      current.payments.set(payment.id, payment);
    }

    const updated: PaymentRequest = {
      ...request,
      status,
      confirmedAt: paidAt,
      orderId: order ? order.id : null,
    };
    current.paymentRequests.set(id, updated);
    // —— 原子区段结束 ——

    return { request: updated, order, orderCreated: order !== null };
  },

  async findOrderById(id) {
    return store().orders.get(id) ?? null;
  },
};
