import type {
  CompanionServiceEvent,
  DerivedServiceEvent,
} from "@/lib/types/companionService";
import { dispatchStore } from "./mockDispatchRepository";
import { paymentStore } from "./mockPaymentRepository";
import { getMockStore } from "./mockStore";
import type { CompanionServiceRepository } from "./companionServiceRepository";

/**
 * 服务事件的**进程内** Mock 存储（P1-7）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`orderId` + `servingAt` 普通索引 +
 * 唯一约束，见下方「唯一键」一节），本文件的删除不影响上层接口。
 *
 * 没有预置数据，也不需要：它是**只增不改**的历史表，建仓时是空的，
 * 第一位真正开始服务的打手把它写起来。为它编造几条「历史服务记录」等于伪造一段
 * 从未发生过的业务事实——**唯一**的例外是「存量数据里仍然写得明明白白的那一次服务」，
 * 那一条由读取侧的**派生**补上（见下方 `deriveLegacyServiceEvents`）。
 *
 * store 的挂载语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 *
 * ## 写入为什么全在这里
 *
 * 写服务事件发生在**原子区段**里（它必须与订单被推进到 `serving` 在同一段无 `await`
 * 的代码里完成）。因此它不能走 `getCompanionServiceRepository()` 的异步方法，
 * 只能用本文件导出的**同步写原语**。这与接单事件（`mockCompanionAcceptRepository`）、
 * 履约退出历史（`mockCompanionReleaseRepository`）是**同一种不对称**：
 * **原语只负责写，不判断这次服务是否合法**——合法性由伪事务在调用它们**之前**判定
 * （`lib/data/companionOrderTransaction.ts` 的 `startCompanionOrder`）。
 */

type MockCompanionServiceStore = {
  /**
   * 事件 id → 记录。**只增不改**：同一订单可以有**多条**（换人之后再服务一次就是新的一条，
   * 而且换人时**旧记录保留**），并且**任何路径都不会删或改**——
   * 「取消 / 换人 / 封禁释放 / 退款**不回写、删除**之前真实发生过的服务」这条规则
   * 就落在这个 Map 上（产品裁定 `D10` 附加要求第 6 / 7 / 8 条）。
   *
   * ⚠️ **外部不得持有并写这个 Map**：写事件**必须**经 `appendCompanionService()`——
   * 它在同一段同步代码里做去重与 id 生成。导出 `companionServiceStore()` 是给**读**
   * 与伪事务取句柄用的。
   */
  events: Map<string, CompanionServiceEvent>;

  /**
   * `(orderId, companionId, servingAt)` → 事件 id。**去重索引**，与 `events` 同生共死。
   *
   * 单独放一个 Set/Map 而不是每次遍历 `events`：去重是**每次写入**都要做的事，
   * 遍历会让「写第 N 条」变成 O(N)；更重要的是，索引把「同一 assignment 只记一次」
   * 这条规则变成一个**结构上的**保证，而不是一段容易被改坏的两重循环。
   */
  keys: Map<string, string>;
};

function createStore(): MockCompanionServiceStore {
  return { events: new Map(), keys: new Map() };
}

function store(): MockCompanionServiceStore {
  return getMockStore("companionService", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function companionServiceStore(): MockCompanionServiceStore {
  return store();
}

/** 「同一 assignment 只能记录一次」的判据（产品裁定 `D10` 附加要求第 5 条）。 */
function serviceKey(event: Omit<CompanionServiceEvent, "id">): string {
  return `${event.orderId}\u0000${event.companionId}\u0000${event.servingAt}`;
}

/**
 * 追加一条服务事件（**同步写入器**，无 `await`）。
 *
 * ## 去重是**在写前**做的，不是在读时
 *
 * 判据是 `(orderId, companionId, servingAt)` 三元组（见 `serviceKey`）。
 * 正常路径下不可能重复——`startCompanionOrder` 只在
 * 「状态恰好是 `accepted`」时走到写入，重放会在更早的一步返回、
 * 一个字节都不写（`lib/data/companionOrderTransaction.ts` 第 2 步）。
 * 这里仍然显式查重，使「同一 assignment 只记一次」成为**可单独测试的保证**，
 * 而不是「碰巧上游没重复调用」。
 *
 * ⚠️ **不去重的范围是有意的**：同一个打手在**不同时刻**两次开始服务（A 服务 → 被换走 →
 * 又被换回来服务）会留下**两条**，`servingAt` 不同。那是两次真实的服务，
 * 合并成一条会把 `D8` 的频次算少。
 *
 * id 在这里生成，而且**当场确认未被占用**：调用方无法指定 id
 * （能指定就等于能覆盖别人的记录），而一条已有的服务事件是**业务事实**，不能被顶掉。
 *
 * 返回 `created: false` 表示「这条已经记过了，本次不写」；调用方可以据此断言幂等。
 */
export function appendCompanionService(
  event: Omit<CompanionServiceEvent, "id">,
): { event: CompanionServiceEvent; created: boolean } {
  const current = store();

  // —— 原子区段开始（无 await）——
  const key = serviceKey(event);
  const recorded = current.keys.get(key);
  if (recorded !== undefined) {
    const existing = current.events.get(recorded);
    // 索引与 events 同生共死；万一索引指向一条不存在的记录（只可能是代码被改坏），
    // 就当没有记过，往下正常写一条——不返回 undefined 让调用方炸掉
    if (existing) return { event: existing, created: false };
  }

  let id = `svc_${crypto.randomUUID()}`;
  while (current.events.has(id)) id = `svc_${crypto.randomUUID()}`;

  const stored: CompanionServiceEvent = { ...event, id };
  current.events.set(id, stored);
  current.keys.set(key, id);
  // —— 原子区段结束 ——

  return { event: stored, created: true };
}

/**
 * 把**仍然写在订单上的**那一次服务派生出来（同步）。
 *
 * 见 `lib/types/companionService.ts` 的 `DerivedServiceEvent`：只对
 * `servingAt` 与 `actualCompanionId` **都非空**的订单派生**一条**，
 * 因为 `Order.servingAt` 只保留**当前/最终**那位打手（产品裁定 `D10`：不 backfill 猜测值）。
 *
 * ⚠️ **不按订单状态过滤**——这是刻意的，理由与 `D8` 的退款补充规则一致：
 * 「退款影响钱，不改写『这个人曾经服务过我』」。一张服务过、后来全额退款的订单
 * 状态是 `refunded`，但它的 `servingAt` / `actualCompanionId` **都还在**
 * （`applyOrderRefund` 只改状态与退款金额），因此**照常派生**。
 *
 * ⚠️ 这是**读时派生**，不写入事件表：它描述的是「存量数据的可获得性」，
 * 而不是「又发生了一次服务」。写进表里就等于把「读一次多一条」变成持久化副作用。
 */
export function deriveLegacyServiceEvents(): DerivedServiceEvent[] {
  const derived: DerivedServiceEvent[] = [];
  const dispatchIndex = dispatchStore().dispatchIdByOrder;

  for (const order of paymentStore().orders.values()) {
    if (!order.servingAt) continue;
    if (!order.actualCompanionId) continue;

    // 快照取订单上那一份。理论上服务过就一定写下了快照，但历史脏数据可能没有——
    // 那时**如实给空串**，由展示层回落到「已服务打手」这类中性文案，
    // 而不是凭空造一个名字（不猜）
    derived.push({
      orderId: order.id,
      companionId: order.actualCompanionId,
      dispatchId: dispatchIndex.get(order.id) ?? null,
      servingAt: order.servingAt,
      companionName: order.companion?.name ?? "",
      companionAvatarUrl: order.companion?.avatarUrl ?? "",
    });
  }

  return derived;
}

export const mockCompanionServiceRepository: CompanionServiceRepository = {
  async listServiceEvents() {
    return [...store().events.values()];
  },

  async listLegacyServiceEvents() {
    return deriveLegacyServiceEvents();
  },
};
