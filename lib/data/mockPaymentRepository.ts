import { compareOrdersForAdmin, orderInDateRange } from "@/lib/constants/adminOrders";
import { compareOrdersNewestFirst, matchesOrderKeyword } from "@/lib/constants/orders";
import { getMockSeedNow } from "@/lib/mocks/fixtures/mockClock";
import { buildRankingPeriodOrders, orderSeed } from "@/lib/mocks/fixtures/orderSeed";
import type { Order, OrderCompanionSnapshot } from "@/lib/types/order";
import type {
  MockPaymentResult,
  Payment,
  PaymentRequest,
  PaymentStatus,
} from "@/lib/types/payment";
import { getMockStore } from "./mockStore";
import type { AdminOrderQueryFilter, PaymentRepository } from "./paymentRepository";

/**
 * 支付与订单的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库，客户端也拿不到任何「可信状态」；将来由真实数据库替换
 * （唯一索引 + 事务），本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
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

/**
 * 建仓时把预置订单放进**同一个** `orders` Map。
 *
 * 只有建仓这一次会写入预置数据，之后所有读写都发生在这个 Map 上，
 * 因此支付成功产生的订单与预置订单在列表里是同一种数据、走同一条查询路径，
 * 也不会出现「访问一次列表就把动态订单冲掉」这种事。
 *
 * 周期榜那批预置订单在这里生成，且**基准时间在进程内只取一次**
 * （`getMockSeedNow()`）：每次查询都按「此刻」重算的话，翻页前后订单的完成时间都在变，
 * 榜单会自己漂移；固定一次之后，同一进程内榜单稳定、可复现，重启服务才会按新的当天重建。
 */
function createStore(): MockStore {
  const seedNow = getMockSeedNow();
  const orders = [...orderSeed, ...buildRankingPeriodOrders(seedNow)];

  return {
    paymentRequests: new Map(),
    orders: new Map(orders.map((order) => [order.id, order])),
    payments: new Map(),
    requestIdByKey: new Map(),
  };
}

function store(): MockStore {
  return getMockStore("payment", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * `adminRefundTransaction` 的原子区段要在同一次同步执行里读订单、写订单，
 * 走 `getPaymentRepository()` 的异步方法做不到——每个 `await` 都会让出执行权。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function paymentStore(): MockStore {
  return store();
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

  async queryOrders(query) {
    const { userId, status, keyword, page, pageSize } = query;

    const filtered = [...store().orders.values()]
      .filter((order) => order.userId === userId)
      .filter((order) => status === null || order.status === status)
      .filter((order) => matchesOrderKeyword(order.orderNo, keyword))
      .sort(compareOrdersNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async findOrderById(id) {
    return store().orders.get(id) ?? null;
  },

  async listOrdersByUser(userId) {
    // 与 queryOrders 走同一个 Map：支付成功新生成的订单会立刻计入消费统计
    return [...store().orders.values()].filter((order) => order.userId === userId);
  },

  async queryOrdersByCompanion(companionId) {
    // `actualCompanionId` 是**查询条件**而不是「查出来再比对」：本方法只可能返回
    // 这一位打手实际接过的单。与 queryOrders 同一个 Map，因此刚接的单立刻可见、
    // 取消之后（`actualCompanionId` 被清空）也立刻不可见
    return [...store().orders.values()]
      .filter((order) => order.actualCompanionId === companionId)
      .sort(compareOrdersNewestFirst);
  },

  async listAllOrders() {
    // 订单在 Map 里按 id 键控，因此每条订单只会出现一次——「同一订单只累计一次」的**数据侧**保证
    return [...store().orders.values()];
  },

  async queryOrdersForAdmin(filter: AdminOrderQueryFilter) {
    return [...store().orders.values()]
      .filter((order) => filter.status === null || order.status === filter.status)
      // 游戏按**下单时的名称快照**匹配：订单里没有游戏 id，而且改名不该让历史订单换个游戏
      .filter((order) => !filter.gameName || order.gameName === filter.gameName)
      .filter((order) => orderInDateRange(order, filter.from, filter.to))
      .sort(compareOrdersForAdmin);
  },
};

/**
 * 打手接单 → 订单进入「已接单」（**同步写入器**，无 `await`）。
 *
 * ⚠️ 与下面的 `applyOrderRefund` 同一套路：它**只负责写**，不判断这次迁移合不合法
 * （能不能接、有没有超时、是不是指定给这位打手）。合法性由伪事务在调用它之前判定
 * （`lib/data/companionDispatchTransaction.ts` 的 `acceptDispatch`），
 * 而订单那一侧**必须与派单那一侧在同一段无 `await` 的代码里写完**。
 *
 * `input.companion` 是**接单那一刻**的打手公开信息快照（昵称 / 头像），
 * 与其它快照字段一样：之后改昵称换头像，这一单的展示不受影响。
 */
export function applyOrderAccepted(
  id: string,
  input: { companionId: string; companion: OrderCompanionSnapshot; at: string },
): { previous: Order; updated: Order } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  const updated: Order = {
    ...order,
    status: "accepted",
    acceptedAt: input.at,
    // ⚠️ 这里写的是**实际接单的人**，与用户当初指定的人（`Dispatch.exclusiveCompanionId`）
    // 是两个字段。它也**只**由这里写：与派单的 `acceptedByCompanionId` 同段写下去，
    // 因此「派单说被 A 接了、订单说没人接」这种状态在结构上产生不出来
    actualCompanionId: input.companionId,
    companion: input.companion,
  };
  current.orders.set(id, updated);
  return { previous, updated };
}

/**
 * 打手主动取消接单 → 订单退出当前履约（**同步写入器**，无 `await`），P0-6。
 *
 * 与上面的 `applyOrderAccepted` **严格对称**：那边一次写四个字段
 * （`status` / `acceptedAt` / `actualCompanionId` / `companion`），
 * 这里就把这四个字段**一起**退回去。四个必须同进同退，理由有三条：
 *
 * 1. **对称性**：接单是一次四字段的原子赋值，取消只回退其中一部分，
 *    就会留下一条永远对不齐的不变量（「什么时候接的」被清空而「谁接的」还在）；
 * 2. **技术设计把前两者定义为一个整体**：`database-schema.md` 把
 *    `actualCompanionId` 与 `companion` 归在「履约人」同一组；
 *    `01-prompt.md` §2.3 说的是「当前**履约绑定**必须解除」——绑定指的就是这一组；
 * 3. **不清空会直接渲染出自相矛盾的界面**：`lib/services/orders.ts` 的 `TIMELINE_SOURCE`
 *    把 `acceptedAt` 直接变成用户可见的时间轴节点（只判「时间戳非 null」），
 *    残留的 `acceptedAt` 会让一张已回到 `paid` 的订单在用户端显示「已接单」；
 *    而 `toOrderListItem()` 输出 `order.companion`，残留快照会让订单列表里
 *    挂着一个并不在履约的打手。
 *
 * 「谁曾经接过这一单」不在这里保存：它由 `CompanionReleaseRecord` 记一位，
 * 由伪事务在同一段代码里写下去（`lib/data/companionOrderTransaction.ts`）。
 *
 * ⚠️ 与同文件另外两个写入器同一套路：它**只负责写**，不判断这次迁移合不合法
 * （是不是本人、状态是不是还停在 `accepted`）。合法性由伪事务在调用它之前判定。
 *
 * ⚠️ `Order` 上**没有** `updatedAt` 字段，因此这里没有「一并刷新时间戳」这一步——
 * `applyOrderAccepted` 也没有。订单的时间事实是它自己的那五个节点，
 * 「最后一次改动发生在何时」不属于订单模型。
 */
export function applyOrderAcceptanceReleased(
  id: string,
): { previous: Order; updated: Order } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  const updated: Order = {
    ...order,
    status: "paid",
    acceptedAt: null,
    // 与派单的 `acceptedByCompanionId` 同段写下去，因此「派单说没人接、订单说有人接」
    // 这种状态在结构上产生不出来（见 applyOrderAccepted 的同一句注释）
    actualCompanionId: null,
    companion: null,
  };
  current.orders.set(id, updated);
  return { previous, updated };
}

/**
 * 把订单标记为「已退款」（**同步写入器**，无 `await`）。
 *
 * ⚠️ 与 `applyApplicationReview` 同一套路：它**只负责写**，不判断这次迁移合不合法
 * ——合法性由伪事务在调用它之前用状态机判定（`lib/constants/adminRefunds.ts`）。
 * 拆成两处是因为「谁能改订单」只有伪事务一处，而写入本身需要一个不让人拿到 `Map` 的入口。
 *
 * ⚠️ 又是**同步**的：它被 `adminRefundTransaction` 的原子区段调用，里面出现 `await`
 * 就会让出执行权，原子性立刻消失。P0-5 的超时自动退款同样在原子区段里调用它。
 *
 * `refundedAt` 只在**第一次**进入 `refunded` 时写入：重复调用不会刷新时间戳
 * （「这一单是什么时候退的」不该被第二次点击改掉）。
 * 已经是 `refunded` 的订单再写一次返回 `changed: false`，由调用方决定这算不算异常——
 * P0-5 的超时清扫据此做到「重复执行不重复退款」。
 */
export function applyOrderRefund(
  id: string,
  at: string,
  /**
   * 这一次退掉的钱（分）。**不传表示「不改动累计已退」**——这是一个技术上的默认值，
   * 当前**没有任何调用方**依赖它：两条退款路径（P0-5 公共池超时自动退款、
   * P0-5.5 起的管理端退款裁决）都是全额退款，都显式传 `actualPaidAmount`。
   *
   * 传了就一并写进 `refundedAmount`：**全额退款**的调用方传 `actualPaidAmount`，
   * 因为订单类型上写着「全额退款后 refundedAmount === actualPaidAmount」。
   * 少了这一步，用户会看到「已退款」但「累计已退 0 元」。
   * 将来部分退款上线后，这里才是「累计已退」的累加入口（公式属后续批次）。
   */
  refundedAmount?: number,
): { previous: Order; updated: Order; changed: boolean } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  if (order.status === "refunded") {
    return { previous, updated: previous, changed: false };
  }

  const updated: Order = {
    ...order,
    status: "refunded",
    refundedAt: order.refundedAt ?? at,
    refundedAmount: refundedAmount ?? order.refundedAmount,
  };
  current.orders.set(id, updated);
  return { previous, updated, changed: true };
}
