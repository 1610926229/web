import type {
  CompanionAcceptEvent,
  DerivedAcceptEvent,
} from "@/lib/types/companionAccept";
import { dispatchStore } from "./mockDispatchRepository";
import { getMockStore } from "./mockStore";
import type { CompanionAcceptRepository } from "./companionAcceptRepository";

/**
 * 接单事件的**进程内** Mock 存储（P1-5）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`companionId` + `acceptedAt` 普通索引 +
 * 事务），本文件的删除不影响上层接口。
 *
 * 没有预置数据，也不需要：它是**只增不改**的历史表，建仓时是空的，
 * 第一位成功接单的打手把它写起来。为它编造几条「历史订单的接单记录」等于伪造一段
 * 从未发生过的业务事实——**唯一**的例外是「存量数据里仍然写得明明白白的那一次接单」，
 * 那一条由读取侧的**派生**补上（见下方 `deriveLegacyAcceptEvents` 与
 * `lib/types/companionAccept.ts` 的 `DerivedAcceptEvent`）。
 *
 * store 的挂载语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 *
 * ## 写入为什么全在这里
 *
 * 写接单事件发生在**原子区段**里（它必须与派单被接走、订单变 `accepted`、
 * 通知用户在同一段无 `await` 的代码里完成）。因此它不能走
 * `getCompanionAcceptRepository()` 的异步方法，只能用本文件导出的**同步写原语**。
 *
 * 与 `mockCompanionReleaseRepository` / `mockDispatchRepository` 同一套路：
 * **这些原语只负责写，不判断这次接单的合法性**——合法性（还在不在时限内、
 * 是不是指定给他的、他自己能不能接单）由伪事务在调用它们**之前**判定
 * （`lib/data/companionDispatchTransaction.ts` 的 `acceptDispatch`）。
 */

type MockCompanionAcceptStore = {
  /**
   * 事件 id → 记录。**只增不改**：同一订单可以有多条（换人之后再接一次就是新的一条），
   * 而且**任何路径都不会删或改**——「取消 / 换人 / 退款 / 未完成**不回写、删除**
   * 之前真实发生过的成功接单事件」这条规则就落在这个 Map 上。
   *
   * ⚠️ **外部不得持有并写这个 Map**：写事件**必须**经 `appendCompanionAccept()`——
   * 它在同一段同步代码里生成 id 并确认未被占用。直接 `.set(...)` 能绕开那一步，
   * 而且**源码门禁扫不出来**（它只拦字面调用，见 `tests/companionRankings.test.mjs` 里
   * 那条门禁用例的注释）。导出 `companionAcceptStore()` 是给**读**与伪事务取句柄用的。
   */
  events: Map<string, CompanionAcceptEvent>;
};

function createStore(): MockCompanionAcceptStore {
  return { events: new Map() };
}

function store(): MockCompanionAcceptStore {
  return getMockStore("companionAccept", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function companionAcceptStore(): MockCompanionAcceptStore {
  return store();
}

/**
 * 追加一条接单事件（**同步写入器**，无 `await`）。
 *
 * id 在这里生成，而且**当场确认未被占用**：调用方无法指定 id
 * （能指定就等于能覆盖别人的记录），而一条已有的接单事件是**业务事实**，
 * 不能被新记录顶掉。生成与写入在同一段同步代码里，因此不存在
 * 「拿到 id 与写下去之间被别人占掉」这个窗口。
 *
 * ⚠️ **不覆盖、不去重**：同一个打手在**同一条派单**上先后接了两次（A→B→A 里的 A）
 * 就留两条，那是两次真实的接单动作。去重会把裁定 §8 的算例数错。
 */
export function appendCompanionAccept(
  event: Omit<CompanionAcceptEvent, "id">,
): CompanionAcceptEvent {
  const current = store();

  // —— 原子区段开始（无 await）——
  let id = `acc_${crypto.randomUUID()}`;
  while (current.events.has(id)) id = `acc_${crypto.randomUUID()}`;

  const stored: CompanionAcceptEvent = { ...event, id };
  current.events.set(id, stored);
  // —— 原子区段结束 ——

  return stored;
}

/**
 * 把**仍然写在派单记录上的**那一次自接单派生出来（同步）。
 *
 * 见 `lib/types/companionAccept.ts` 的 `DerivedAcceptEvent`：只对
 * `state === "accepted"` 且两个字段都非空的派单记录派生**一条**，
 * 因为派单记录只会保留当前那一位接单人。
 *
 * ## ⚠️ 只派生**打手自己接的**那一种（P1-5 §九-F 产品裁定）
 *
 * 三个取值的处理**刻意不同**，每一档都对应一句话：
 *
 * | `acceptedVia` | 派生？ | 为什么 |
 * |---|---|---|
 * | `"companion"` | **派生** | 这就是「打手自己成功接单」，是接单榜唯一该数的东西 |
 * | `"staff"` | **不派生** | 客服直换 **不是**打手的主动接单行为，不得算进接单榜 |
 * | `null` | **不派生** | **认不出来源就不猜**：宁可让存量接单榜是下界，也不凭空补 |
 *
 * 产品裁定原文：「`deriveLegacyAcceptEvents()` 不得把能够识别为 Staff direct replacement /
 * Staff direct assignment 的历史绑定记录推导成 `CompanionAcceptEvent`。如果历史数据
 * 无法区分：不得凭空补接单事件。宁可继续保持『存量接单榜是历史下界』。**不要为了让
 * 历史数字好看而伪造主动接单行为。**」
 *
 * ⚠️ **`null` 那一档是这条通道与「主键」之间的最后一道闸**：只要有任何一条新的绑定
 * 写入路径忘了写 `acceptedVia`（`applyDispatchAccepted` 的 `via` 是必填参数，
 * 编译期就挡住了——这是第二道），它也会落进 `null` 而不是被算成一次接单。
 * **两档都是 fail-closed，方向一致。**
 *
 * ⚠️ 这是一个**读时派生**，不写入事件表：它描述的是「存量数据的可获得性」，
 * 而不是「又发生了一次接单」。写进表里就等于把「读一次多一条」变成持久化副作用。
 */
export function deriveLegacyAcceptEvents(): DerivedAcceptEvent[] {
  const derived: DerivedAcceptEvent[] = [];

  for (const record of dispatchStore().dispatches.values()) {
    if (record.state !== "accepted") continue;
    if (!record.acceptedByCompanionId || !record.acceptedAt) continue;
    // 见上表：staff 与「认不出来源」一律不派生
    if (record.acceptedVia !== "companion") continue;

    derived.push({
      dispatchId: record.id,
      orderId: record.orderId,
      companionId: record.acceptedByCompanionId,
      acceptedAt: record.acceptedAt,
    });
  }

  return derived;
}

export const mockCompanionAcceptRepository: CompanionAcceptRepository = {
  async listAcceptEvents() {
    return [...store().events.values()];
  },

  async listLegacyAcceptEvents() {
    return deriveLegacyAcceptEvents();
  },
};
