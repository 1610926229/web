import type { Earning, EarningAdjustment } from "@/lib/types/earning";
import { getMockStore } from "./mockStore";
import type { EarningRepository } from "./earningRepository";

/**
 * 打手收益的**进程内** Mock 存储（P0-9）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`order_id` 唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 * 收益**没有预置数据**：它由订单完成这件事产生，全部是运行时写入。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。真正跨实体（订单 + 收益）的原子写入在
 * `lib/data/earningTransaction.ts` 的伪事务里完成，本文件只提供同步写原语。
 */

type MockEarningStore = {
  earnings: Map<string, Earning>;
  /**
   * orderId → earningId。
   *
   * ⚠️ 这份单值索引就是「**一个订单最多一条收益**」这条约束在存储层的落点：
   * 创建前查它、创建后写它，两件事与记录写入在同一段同步代码里完成。
   * 未来数据库上它是 `order_id` 上的唯一索引，语义不变。
   *
   * 它与 `Earning.orderId` 是同一份事实的两种表达，因此**只能由本文件的写入原语维护**，
   * 不允许别处直接改（与完成材料的 `pendingSubmissionIdByOrder` 同一条约定）。
   */
  earningIdByOrder: Map<string, string>;
  /**
   * 收益调整明细（P0-13）。**与收益同一张 store**，不新开第二个 store——
   * adjustment 与 earning 是同一个域的两张表，分成两个 store 会让
   * 「读收益 + 读它的调整」变成两次互不相干的快照，而它们必须一起一致。
   */
  adjustments: Map<string, EarningAdjustment>;
  /**
   * refundId → adjustmentId。
   *
   * ⚠️ 这份单值索引就是「**一次退款决策最多冲减一次**」这条幂等约束在存储层的落点
   * （P0-13 D8）。它与 `EarningAdjustment.refundId` 是同一份事实的两种表达，
   * 因此**只能由本文件的写入原语维护**。
   */
  adjustmentIdByRefund: Map<string, string>;
};

function createStore(): MockEarningStore {
  return {
    earnings: new Map(),
    earningIdByOrder: new Map(),
    adjustments: new Map(),
    adjustmentIdByRefund: new Map(),
  };
}

function store(): MockEarningStore {
  return getMockStore("earning", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * 与 `completionStore()` / `refundStore()` 同一个理由：「读—判断—写」必须发生在
 * 同一段没有 `await` 的同步代码里，走 `getEarningRepository()` 的异步方法做不到。
 */
export function earningStore(): MockEarningStore {
  return store();
}

/**
 * 追加一条收益（**同步写原语**，无 `await`）。
 *
 * ⚠️ **只负责写**，不判断该不该建（订单是不是刚完成、这一单是不是已经有收益）——
 * 合法性由伪事务在调用它之前判定，而且**判定与这次写入必须在同一段同步代码里**
 * （`earningIdByOrder` 是那条判定读的东西）。
 *
 * 记录写入与索引更新一起做：只写记录不写索引，会出现「记录在、索引说没有」
 * 的悬空状态，之后同一订单就能再建一条。
 */
export function appendEarning(earning: Earning): void {
  const current = store();
  current.earnings.set(earning.id, earning);
  current.earningIdByOrder.set(earning.orderId, earning.id);
}

/**
 * 把一条收益写成 `available`（**同步写原语**，无 `await`）。
 *
 * ⚠️ **只改状态，不动 `availableAt`**：那个字段是「计划解冻时刻」，
 * 创建时就已经写下（= 本单的 `complaintDeadlineAt`），释放不是「重新安排时间」。
 * 刷新它会让同一个业务事实在不同机器上得到不同的时间戳——sweep 是惰性物化的，
 * 什么时候被调用取决于有没有人访问，而「这笔钱什么时候到期」不该取决于那件事。
 *
 * 已经是 `available` 的记录返回 `changed: false`，一个字节都不写（重复 sweep 幂等）；
 * 记录不存在返回 null。两者都不判断「该不该释放」——那是伪事务的事。
 */
export function applyEarningRelease(
  id: string,
): { previous: Earning; updated: Earning; changed: boolean } | null {
  const current = store();
  const earning = current.earnings.get(id);
  if (!earning) return null;

  const previous = { ...earning };
  if (earning.status === "available") {
    return { previous, updated: previous, changed: false };
  }

  const updated: Earning = { ...earning, status: "available" };
  current.earnings.set(id, updated);
  return { previous, updated, changed: true };
}

/**
 * 生成一个**当前尚未被占用**的收益调整 id（`adj_…`）。
 *
 * 与 `newNotificationId()` 同一条理由：调用方要在写入之前拿到一个不会与既有记录
 * 冲突的 id。`crypto.randomUUID()` 是同步的，因此这里没有 `await`——
 * 取 id 与写下去之间不会让出执行权。
 *
 * ⚠️ 它与 `adjustmentIdByRefund` 那份索引是**两件事**：那个索引保证
 * 「一次退款最多冲一次」（业务幂等），这里保证的只是「两条明细不会同名」（主键唯一）。
 * 判重读的是**当前存储**，因此拿到 id 之后不应隔着 `await` 再写。
 */
export function newEarningAdjustmentId(): string {
  const current = store();

  let id = `adj_${crypto.randomUUID()}`;
  while (current.adjustments.has(id)) id = `adj_${crypto.randomUUID()}`;

  return id;
}

/**
 * 追加一条收益调整明细（**同步写原语**，无 `await`）。
 *
 * ⚠️ **只负责写**，不判断「该不该冲、冲多少」——那是伪事务的事，
 * 而且判定与这次写入必须在同一段同步代码里。
 *
 * 记录写入与 `refundId` 索引一起做：只写记录不写索引，同一次退款就能再冲一次
 * （幂等失效），而幂等失效是**重复扣打手的钱**，比悬空状态严重得多。
 *
 * ⚠️ id 由调用方用 `newEarningAdjustmentId()` 备好（与 `appendNotification` 同一条约定）：
 * 本函数不生成 id，因为调用方需要在**同一段同步代码**里先判定、后写入。
 */
export function appendEarningAdjustment(adjustment: EarningAdjustment): void {
  const current = store();
  current.adjustments.set(adjustment.id, adjustment);
  current.adjustmentIdByRefund.set(adjustment.refundId, adjustment.id);
}

/**
 * 把一笔收益**累计冲回** `amount`（**同步写原语**，无 `await`）。
 *
 * 三件事，缺一不可（P0-13 D5）：
 *
 * 1. `reversedAmount` 是**累加**，不是覆盖——同一笔收益可以被多次退款反复冲减；
 * 2. **状态规则**：`0 < reversedAmount < incomeAmount` 时**留在原状态**
 *    （`frozen` 仍 `frozen`、`available` 仍 `available`），只有**整笔冲完**
 *    才进 `reversed`。⚠️ 部分冲回**绝不能**把 `frozen` 变成 `available`——
 *    那等于用一次退款把冻结期提前结束了（`cmd_p0-13.md` 明令禁止提前释放）；
 * 3. **不变式护栏**：`0 <= reversedAmount <= incomeAmount`。伪事务已经按 D4
 *    钳制过一次，这里再夹一次是**存储层自己的不变式**：即使调用方算错，
 *    存储里也不会出现一笔「被冲回得比挣的还多」的收益。
 *
 * `amount <= 0` 返回 `changed: false` 且一个字节都不写——「冲 0 元」不是一次写入，
 * 记一条明细只会让对账多出一堆空记录。
 */
export function applyEarningReversal(
  id: string,
  amount: number,
): { previous: Earning; updated: Earning; changed: boolean } | null {
  const current = store();
  const earning = current.earnings.get(id);
  if (!earning) return null;

  const previous = { ...earning };
  if (amount <= 0) return { previous, updated: previous, changed: false };

  const nextReversed = Math.min(
    Math.max(0, earning.reversedAmount + amount),
    earning.incomeAmount,
  );
  const status =
    nextReversed >= earning.incomeAmount && earning.incomeAmount > 0
      ? "reversed"
      : earning.status;

  const updated: Earning = { ...earning, reversedAmount: nextReversed, status };
  current.earnings.set(id, updated);
  return { previous, updated, changed: true };
}

/** 一笔收益的全部调整明细，按发生时间正序（同刻用 id 兜底）。 */
function compareAdjustmentsOldestFirst(a: EarningAdjustment, b: EarningAdjustment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 某个打手自己的收益，**最新在前**。
 *
 * 排序取 `frozenAt` 倒序，同刻再用 `id` 兜底：两份记录的时间戳完全相同时
 * （同一毫秒内完成两单是可能的），没有兜底键的排序结果在两次调用之间可以不一样，
 * 而列表顺序不稳定在页面上就是「刷新一下顺序变了」。
 */
function compareEarningsNewestFirst(a: Earning, b: Earning): number {
  if (a.frozenAt !== b.frozenAt) return a.frozenAt < b.frozenAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const mockEarningRepository: EarningRepository = {
  async listEarningsForCompanion(companionId) {
    return [...store().earnings.values()]
      .filter((earning) => earning.companionId === companionId)
      .sort(compareEarningsNewestFirst);
  },

  async findEarningByOrderId(orderId) {
    const id = store().earningIdByOrder.get(orderId);
    if (!id) return null;
    return store().earnings.get(id) ?? null;
  },

  async listAdjustmentsForEarning(earningId) {
    return [...store().adjustments.values()]
      .filter((adjustment) => adjustment.earningId === earningId)
      .sort(compareAdjustmentsOldestFirst);
  },
};
