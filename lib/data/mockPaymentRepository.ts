import { compareOrdersForAdmin, orderInDateRange } from "@/lib/constants/adminOrders";
import { plusMinutes } from "@/lib/constants/dispatch";
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
    // ⚠️ P0-11 起这里**多写一个字段**：`servingAt` 一并清空。
    //
    // 这条写入器现在服务两条边：`accepted → paid` 与 `serving → paid`
    // （后者由 P0-11 首次接上入口：封禁回池 / 客服换人）。
    // 而 `applyOrderServing` 写的是 `servingAt: order.servingAt ?? at`——
    // 释放后若不清空，**新打手点「开始服务」会沿用上一任的开始时间**：
    // 用户端时间轴、打手端「护航中」的开始时间都会显示错，
    // 而它还是将来按实际服务时长做任何统计 / 结算的基准。
    //
    // 口径由产品在 P0-11 裁定：「`servingAt` 表达**当前这位**打手从何时开始服务」
    // （见 `docs/03-dev/rounds/P0-11/02-decisions.md` §九 D-Q1）。
    // ⚠️ `?? at` 那一边**刻意不动**：释放时清空之后，下一次开始服务必然写本次的 `at`，
    // 而 `??` 仍然防着「状态还是 accepted 但 servingAt 已有值」的历史脏数据，
    // 也让 P0-7 的「重复点击不刷新服务开始时间」那条保证原样成立。
    //
    // 对 `accepted → paid`（主动取消 / 换人）这条路径它是**恒等操作**——
    // 还没开始服务时 `servingAt` 本来就该是 null。
    servingAt: null,
  };
  current.orders.set(id, updated);
  return { previous, updated };
}

/**
 * 打手开始服务 → 订单进入「护航中」（**同步写入器**，无 `await`），P0-7。
 *
 * ⚠️ 与同文件另外三个写入器同一套路：它**只负责写**，不判断这次迁移合不合法
 * （是不是本人实际履约、状态是不是还停在 `accepted`）。合法性由伪事务在调用它之前
 * 判定（`lib/data/companionOrderTransaction.ts` 的 `startCompanionOrder`）。
 *
 * ## 只写两个字段，一个都不多
 *
 * | 字段 | 动不动 | 为什么 |
 * |---|---|---|
 * | `status` | 写成 `"serving"` | 这就是这次迁移本身 |
 * | `servingAt` | 第一次进入时写入 | 需求要的「记录开始服务时间」 |
 * | `acceptedAt` | **不动** | 历史事实。进入 `serving` 不抹掉「什么时候接的」（`01-prompt.md` §二） |
 * | `actualCompanionId` / `companion` | **不动** | 履约绑定。进入 `serving` 恰恰是它成立的证明；这里清掉就等于「人还在干活、订单说没人」 |
 * | 金额域四个字段 | **不动** | 开始服务不是一个资金事件（P0-7 不做任何资金联动） |
 *
 * ⚠️ **不能复用 `applyOrderAccepted`**：那个函数会写 `acceptedAt` 与 `actualCompanionId`，
 * 用它「顺手推进状态」等于把接单时刻改写成开始服务的时刻，并且让「谁接的」有第二个出处。
 *
 * ⚠️ **同步**是必须的：它被伪事务的原子区段调用，里面出现 `await` 就会让出执行权，
 * 「订单已开始服务、别的字段还没写完」的那一瞬会被别的请求读到。
 *
 * ⚠️ `servingAt` 只在**第一次**进入 `serving` 时写入：已经是 `serving` 的订单再写一次
 * 返回 `changed: false` 且**不刷新时间戳**（照 `applyOrderRefund` 的既有先例）。
 * 「这一单是几点开始的」不该被第二次点击改掉；事务层据此把重复点击判成重放。
 */
export function applyOrderServing(
  id: string,
  at: string,
): { previous: Order; updated: Order; changed: boolean } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  if (order.status === "serving") {
    return { previous, updated: previous, changed: false };
  }

  const updated: Order = {
    ...order,
    status: "serving",
    // 已经写过的时刻原样保留（`??` 而不是直接赋值）：这一条是对「历史数据里
    // 状态还是 accepted 但 servingAt 已有值」的防御，与 refundedAt 同一写法
    servingAt: order.servingAt ?? at,
  };
  current.orders.set(id, updated);
  return { previous, updated, changed: true };
}

/**
 * 把订单标记为「已完成」（**同步写入器**，无 `await`），P0-8。
 *
 * ⚠️ 与 `applyOrderServing` 同一套路：它**只负责写**，不判断这次迁移合不合法
 * （完成材料有没有提交并审核通过、订单是不是还停在 `serving`）。合法性由伪事务在
 * 调用它之前判定（`lib/data/completionTransaction.ts` 的 `approveCompletion` 与
 * `sweepCompletionAutoApprovals`）。
 *
 * ## 只写四个字段，一个都不多
 *
 * | 字段 | 动不动 | 为什么 |
 * |---|---|---|
 * | `status` | 写成 `"completed"` | 这就是这次迁移本身 |
 * | `completedAt` | 第一次进入时写入 | 需求要的「记录完成时间」 |
 * | `complaintWindowMinutesSnapshot` | 第一次进入时写入（P0-9） | 本单的投诉窗口，冻结后不随后续改配置变化 |
 * | `complaintDeadlineAt` | 第一次进入时写入（P0-9） | 就是 `completedAt + 上面那个快照` |
 * | `servingAt` | **不动** | 历史事实。进入 `completed` 不抹掉「什么时候开始的」 |
 * | `actualCompanionId` / `companion` | **不动** | 履约绑定。完成恰恰是它成立的证明 |
 * | 金额域五个字段 | **不动** | 完成不是资金事件，收益金额在 `Earning` 那一侧直接搬快照 |
 *
 * ⚠️ **不能复用 `applyOrderServing` / `applyOrderRefund`**：那两个写的是别的状态与
 * 别的时间字段，用它「顺手推进状态」等于把完成时刻写成开始 / 退款时刻。
 *
 * ⚠️ `completedAt` 只在**第一次**进入 `completed` 时写入：已经是 `completed` 的订单
 * 再写一次返回 `changed: false` 且**不刷新时间戳**。重复清扫据此做到
 * 「不重复完成、不刷新 completedAt」。
 *
 * ## 为什么投诉窗口快照在这里算（P0-9）
 *
 * `completedAt` 与 `complaintDeadlineAt` 之间有一条**必须恒成立**的等式：
 * `complaintDeadlineAt === completedAt + complaintWindowMinutesSnapshot`。
 * 两个值若由两个地方分别算出来，这条等式就只靠调用方自觉；而它一旦不成立
 * （例如完成时刻来自历史数据、而 deadline 是按本次的 `at` 算的），
 * 用户端会显示一个与打手收益解冻时刻**不一致**的投诉截止时间——
 * 同一个业务事实在两张页面上给出两个答案。
 *
 * 因此两个字段在**这里**一起写：`completedAt` 先定下来（`?? at` 保留历史值），
 * 快照与 deadline 随后从它算出来。调用方只提供**分钟数**，提供不了时刻。
 *
 * ⚠️ `Earning.availableAt` 也**必须**等于这个 deadline（`lib/data/earningTransaction.ts`
 * 里直接读订单算好的值，不自己再加一次），否则「可投诉到几点」与「钱几点解冻」
 * 会分叉。
 *
 * ⚠️ `plusMinutes` 是仓库里唯一的「分钟加法」实现（它住在 `lib/constants/dispatch.ts`
 * 是历史原因，与派单无关）。这里复用它而不是自己写一段 `Date` 运算：
 * 同一件事有两份实现，迟早出现一处四舍五入、另一处不。
 */
export function applyOrderCompletion(
  id: string,
  at: string,
  /**
   * 本次完成应当采用的投诉窗口（分钟）。由伪事务从平台参数读出后传入——
   * 仓储不读平台配置（那是 `lib/data/adminPlatformConfigTransaction.ts` 的职责），
   * 也不做「取值是否合法」的判断（校验在服务层）。
   */
  complaintWindowMinutes: number,
): { previous: Order; updated: Order; changed: boolean } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  if (order.status === "completed") {
    return { previous, updated: previous, changed: false };
  }

  // 已经写过的时刻原样保留（`??` 而不是直接赋值）：对「历史数据里状态还是
  // serving 但 completedAt 已有值」的防御，与 servingAt / refundedAt 同一写法
  const completedAt = order.completedAt ?? at;
  // 同理：已经有快照的记录沿用旧快照（正常路径上它与状态一起为 null，
  // 这只在重复完成被上面那一步挡住之后才谈得上）
  const snapshot = order.complaintWindowMinutesSnapshot ?? complaintWindowMinutes;

  const updated: Order = {
    ...order,
    status: "completed",
    completedAt,
    complaintWindowMinutesSnapshot: snapshot,
    complaintDeadlineAt: order.complaintDeadlineAt ?? plusMinutes(completedAt, snapshot),
  };
  current.orders.set(id, updated);
  return { previous, updated, changed: true };
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
   * 只有极少数调用方依赖它（见下）。
   *
   * ## P0-13：第三个参数的语义由「覆盖成多少」改为「这一次退多少（增量）」
   *
   * 旧语义是「把 `refundedAmount` 写成这个数」，只在「一次退满」的世界里成立。
   * 部分退款上线后，同一个订单会被退第二次、第三次，覆盖式写入会让
   * 「累计已退」变成「最后一次退了多少钱」——账当场就错了。
   * 现在它累加：`refundedAmount = 原值 + 传入值`。
   *
   * ⚠️ **不要**据此认为「既有调用方都传全额，所以传什么都一样」——
   * 那个推理在本仓库**已被证伪**：部分退款（P0-13）不改订单状态，
   * 因此一张 `serving` 单可以带着 `refundedAmount > 0` 被 P0-11 的「退回公共池」
   * 打回 `paid`，随后**直接退款**与**公共池超时自动退款**都会作用在它身上。
   * 这两条路径因此都改传**本次应退的增量**（`实付 − 累计已退`），
   * 而下面那一次钳制是它们的第二道保险，不是它们可以少算一款的理由。
   *
   * ## 两条被一并收紧的规则
   *
   * 1. **幂等短路条件放宽**：原来只在 `status === "refunded"` 时短路，
   *    现在 `status === "refunded"` **或** `refundedAmount >= actualPaidAmount`
   *    都算「已经退满」，不再累加、不刷新 `refundedAt`。
   *    ⚠️ 只看状态是不够的：部分退款**不改状态**，一张已经退满的订单
   *    如果因为某种原因停在原状态上，状态判据会放它再退一次。
   * 2. **`status` 只在累计退满时才改成 `refunded`**（`architecture-rules.md`
   *    与 `database-schema.md` T3 两条都是明写的硬规矩）。
   *    部分退款**不改订单状态**——订单按原进度继续履约，
   *    打手的收益也照常走它自己的生命周期。
   *
   * 3. **本次传入的金额封顶在「还剩多少」（P0-13 整改）**：
   *    `EX-REFUND-02` 与 `cmd_p0-12.md:40` 把「累计已退不得超过实付」冻结为硬约束，
   *    而 `refundedAmount` 的**唯一写入点就是这里**——于是这条不变式在这一行成为
   *    **结构性**的，而不是「每个调用方自己记得把增量算对」：
   *    调用方把「全额」当成「本次增量」传进来（最容易犯的一种），
   *    结果是**这一单退到实付为止**，而不是退成 `1300/1000`。
   */
  refundedAmount?: number,
): { previous: Order; updated: Order; changed: boolean } | null {
  const current = store();
  const order = current.orders.get(id);
  if (!order) return null;

  const previous = { ...order };
  // 「已经退满」的两个判据都要看：状态只是其中一个表达（见上面的第 1 条）
  if (order.status === "refunded" || order.refundedAmount >= order.actualPaidAmount) {
    return { previous, updated: previous, changed: false };
  }

  // 唯一一次钳制：见上面第 3 条。上面的短路已经保证 `remainingAmount > 0`
  const remainingAmount = order.actualPaidAmount - order.refundedAmount;
  const nextRefundedAmount =
    order.refundedAmount + Math.max(0, Math.min(refundedAmount ?? 0, remainingAmount));
  const fullyRefunded = nextRefundedAmount >= order.actualPaidAmount;

  const updated: Order = {
    ...order,
    status: fullyRefunded ? "refunded" : order.status,
    // `refundedAt` 在**第一次退满**时写下，之后不再刷新（`??` 就是这条规则的落点）；
    // 部分退款不写它——「什么时候退完的」那一刻还没到
    refundedAt: fullyRefunded ? (order.refundedAt ?? at) : order.refundedAt,
    refundedAmount: nextRefundedAmount,
  };
  current.orders.set(id, updated);
  return { previous, updated, changed: true };
}
