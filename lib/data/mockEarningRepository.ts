import type { Earning } from "@/lib/types/earning";
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
};

function createStore(): MockEarningStore {
  return {
    earnings: new Map(),
    earningIdByOrder: new Map(),
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
};
