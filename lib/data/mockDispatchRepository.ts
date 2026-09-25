import { plusMinutes } from "@/lib/constants/dispatch";
import { buildDispatchSeed } from "@/lib/mocks/fixtures/dispatchSeed";
import { getMockSeedNow } from "@/lib/mocks/fixtures/mockClock";
import { buildRankingPeriodOrders, orderSeed } from "@/lib/mocks/fixtures/orderSeed";
import type { DispatchRecord } from "@/lib/types/dispatch";
import { getMockStore } from "./mockStore";
import type { DispatchRepository } from "./dispatchRepository";

/**
 * 派单记录的**进程内** Mock 存储（P0-5）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置值；
 * 不写 localStorage、不写文件、不写数据库。将来由真实数据库替换
 * （唯一索引 + 事务），本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 *
 * ## 写入为什么全在这里，而不是在仓储接口上
 *
 * 接单、转公共池、超时关闭这三件事都发生在**原子区段**里：区段内出现 `await`
 * 就是 bug（会让出执行权，别的请求就能插进来）。因此它们不能走
 * `getDispatchRepository()` 的异步方法，只能用本文件导出的**同步写原语**。
 *
 * 与 `mockPaymentRepository` 的 `applyOrderRefund` 同一个套路：**这些原语只负责写，
 * 不判断这次迁移合不合法**——合法性（能不能接、有没有到点、是不是同一个人）
 * 由伪事务在调用它们之前判定（`lib/data/companionDispatchTransaction.ts`）。
 * 拆成两处是因为「谁能改派单」只应该有伪事务一处，而写入本身需要一个
 * 不让人拿到 `Map` 的入口。
 *
 * 并发安全的前提：Node 是单线程的，而下面每个函数的「读—判断—写」里**没有 await**，
 * 因此各自是一个原子动作；它们的**组合**（读订单 + 读打手 + 写派单 + 写订单 + 写通知）
 * 的原子性由伪事务保证。
 */

type MockDispatchStore = {
  /** 派单 id → 记录。一个订单同时只可能有一条（见 `createDispatchRecord`） */
  dispatches: Map<string, DispatchRecord>;
  /** `orderId` → 派单 id。保证「一个订单只有一条派单记录」这个不变量 */
  dispatchIdByOrder: Map<string, string>;
};

/**
 * 建仓时把预置派单放进**同一个** `dispatches` Map。
 *
 * 预置订单与支付成功新生成的订单走的是同一条查询路径（与订单 store 一致）：
 * 这里不提供任何「预置派单列表」的旁路，否则「新订单立刻出现在池子里」验证不了。
 */
function createStore(): MockDispatchStore {
  const seedNow = getMockSeedNow();
  const orders = [...orderSeed, ...buildRankingPeriodOrders(seedNow)];
  const seeded = buildDispatchSeed(orders, seedNow);

  return {
    dispatches: new Map(seeded.map((record) => [record.id, record])),
    dispatchIdByOrder: new Map(seeded.map((record) => [record.orderId, record.id])),
  };
}

function store(): MockDispatchStore {
  return getMockStore("dispatch", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function dispatchStore(): MockDispatchStore {
  return store();
}

/**
 * 新建一条派单记录（**同步**）。
 *
 * ⚠️ 一个订单只允许有一条派单记录，因此这里**不覆盖**已有记录，而是原样返回它：
 * 覆盖等于把「这一单在等谁、等到什么时候」悄悄换掉，而那条记录可能已经被
 * 别的请求读过、甚至已经决定了别人的接单结果。
 *
 * 调用方是 `createDispatchForOrder`，它在支付仓储的原子区段内被调用——
 * 订单与派单必须**同时**诞生，否则中间那一刻的订单既没有截止时间、也没有人能看到它。
 */
export function createDispatchRecord(record: DispatchRecord): DispatchRecord {
  const current = store();

  const existingId = current.dispatchIdByOrder.get(record.orderId);
  if (existingId) {
    const existing = current.dispatches.get(existingId);
    if (existing) return existing;
    // 索引命中但记录已不存在属于不可能状态；真出现时补写，保证订单不会卡在「无派单」
    current.dispatchIdByOrder.delete(record.orderId);
  }

  current.dispatches.set(record.id, record);
  current.dispatchIdByOrder.set(record.orderId, record.id);
  return record;
}

/**
 * 接单（**同步写入器**，无 `await`）。
 *
 * 写派单的 `acceptedByCompanionId` / `acceptedAt` / 状态。
 *
 * ⚠️ 订单那一侧（`status = accepted`、`actualCompanionId`）**不在本函数里**：
 * 它由伪事务在**同一个**无 `await` 区段里紧跟着写。两处必须在同一区段，
 * 否则会出现「派单说被 A 接了、订单说没人接」这种自相矛盾的状态。
 */
export function applyDispatchAccepted(
  id: string,
  companionId: string,
  at: string,
): DispatchRecord | null {
  const current = store();
  const record = current.dispatches.get(id);
  if (!record) return null;

  const updated: DispatchRecord = {
    ...record,
    state: "accepted",
    acceptedByCompanionId: companionId,
    acceptedAt: at,
    updatedAt: at,
  };
  current.dispatches.set(id, updated);
  return updated;
}

/**
 * 一条派单**回到公共池**（**同步写入器**，无 `await`）。
 *
 * 两个调用方，语义完全一致：
 * - **专属池到点**没有接（`sweepExpiredDispatches`）；
 * - **打手取消接单**（P0-6 的 `cancelAcceptedOrder`）。
 *
 * 四件事同时发生，缺一不可：
 * 1. 状态回到 `public`；
 * 2. **重记**公共池的进入时刻与截止时间——不是沿用上一次，而是按**那一刻**的配置
 *    重新冻结快照（用户被承诺的是「进入池子那一刻的规则」，后台之后改参数不影响这一单）；
 * 3. 清空**当前接单绑定**（`acceptedByCompanionId` / `acceptedAt`）；
 * 4. `updatedAt` 跟着走。
 *
 * ⚠️ 第 3 条是 P0-6 补上的（D3）。此前唯一的调用点是专属池超时清扫，那条路径上
 * 从来没人接过单，两个字段本来就是 `null`，漏清**看不见**；一旦被取消接单复用，
 * 漏清就是 `state === "public"` 却留着 `acceptedByCompanionId` 这种自相矛盾，
 * 而 `01-prompt.md` §四 点名要求做一致性清理。
 * 对既有超时清扫路径这是 **no-op**（原值已是 `null`），既有行为一字未变。
 * 补上之后，这个写入器的契约才真正等于它名字的字面意思：**回到公共池 = 现在没人接**。
 *
 * ⚠️ `exclusiveCompanionId` / `exclusiveEnteredAt` / `exclusiveDeadlineAt`
 * **一个都不清空**：它们是历史事实，管理端与客服以后要能回答
 * 「用户当初指定的是谁、什么时候轮的、等了多久」。
 * 订单转公共池、被别人接走、甚至超时退款之后，`exclusiveCompanionId` 都保持不变
 * （见 `lib/types/dispatch.ts`）。
 */
export function applyDispatchToPublic(
  id: string,
  enteredAt: string,
  timeoutMinutes: number,
): DispatchRecord | null {
  const current = store();
  const record = current.dispatches.get(id);
  if (!record) return null;

  const updated: DispatchRecord = {
    ...record,
    state: "public",
    publicPoolEnteredAt: enteredAt,
    publicDeadlineAt: plusMinutes(enteredAt, timeoutMinutes),
    publicTimeoutMinutesSnapshot: timeoutMinutes,
    acceptedByCompanionId: null,
    acceptedAt: null,
    updatedAt: enteredAt,
  };
  current.dispatches.set(id, updated);
  return updated;
}

/**
 * **关闭派单**（`state → timed_out`，**同步写入器**，无 `await`）。订单退款不在这里。
 *
 * 名字来自第一位调用方，但现在有**两位**，它们关闭派单的原因不同：
 *
 * 1. `sweepExpiredDispatches`（P0-5）——公共池到点仍无人接；
 * 2. `directRefundOrder`（P0-12）——订单在开始服务前被用户直接退款。
 *
 * 两者要做的事一样：**让这张派单不再能被接单**，因此共用这一个写入器
 * （展示名也已改成中性的「已关闭」，见 `DISPATCH_STATE_LABELS`）。
 * 刻意**不做**成两个函数：那会变成两条独立的「关闭」路径，而
 * 「关闭之后就接不了单」这条性质必须只有一处在保证。
 */
export function applyDispatchTimedOut(id: string, timedOutAt: string): DispatchRecord | null {
  const current = store();
  const record = current.dispatches.get(id);
  if (!record) return null;

  const updated: DispatchRecord = {
    ...record,
    state: "timed_out",
    timedOutAt,
    updatedAt: timedOutAt,
  };
  current.dispatches.set(id, updated);
  return updated;
}

export const mockDispatchRepository: DispatchRepository = {
  async listOpenDispatches() {
    // 两种「还在等人接」的池子。已接 / 已关闭的不进池子列表——
    // 「能被接的单」只有这两类，多带一类就会有人对着一张已接的单再点一次接单
    return [...store().dispatches.values()].filter(
      (record) => record.state === "exclusive" || record.state === "public",
    );
  },

  async findDispatchByOrderId(orderId) {
    const current = store();
    const id = current.dispatchIdByOrder.get(orderId);
    return id ? (current.dispatches.get(id) ?? null) : null;
  },
};
