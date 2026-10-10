import type { CompanionReleaseRecord } from "@/lib/types/companionRelease";
import { getMockStore } from "./mockStore";
import type { CompanionReleaseRepository } from "./companionReleaseRepository";

/**
 * 履约退出历史的**进程内** Mock 存储（P0-6）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`orderId` 普通索引 + 幂等键唯一索引 +
 * 事务），本文件的删除不影响上层接口。
 *
 * 没有预置数据，也不需要：它是**只增不改**的历史表，建仓时是空的，
 * 第一位退出的打手把它写起来。为它编造几条「历史订单的退出记录」等于伪造一段
 * 从未发生过的业务事实——订单明明还挂着履约人，历史里却说他退出了。
 *
 * store 的挂载语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 *
 * ## 写入为什么全在这里
 *
 * 写退出历史发生在**原子区段**里（它必须与订单回 `paid`、派单回公共池、通知用户
 * 在同一段无 `await` 的代码里完成）。因此它不能走 `getCompanionReleaseRepository()`
 * 的异步方法，只能用本文件导出的**同步写原语**。
 *
 * 与 `mockDispatchRepository` 同一套路：**这些原语只负责写，不判断这次退出的合法性**
 * ——合法性（是不是本人实际履约、状态是不是还停在 `accepted`）由伪事务在调用它们
 * 之前判定（`lib/data/companionOrderTransaction.ts`）。
 */

type MockCompanionReleaseStore = {
  /** 退出历史 id → 记录。**只增不改**：同一订单可以有多条（退出一次留一条） */
  releases: Map<string, CompanionReleaseRecord>;
  /**
   * `${companionId}:${idempotencyKey}` → 退出历史 id。
   *
   * ⚠️ 这是 **store 级索引**，**不是**记录上的字段：
   * `database-schema.md` T4 与 `01-prompt.md` §三 都只给了 7 个字段。
   * 幂等键是「调用方给的一个串」，把它写进业务事实里，等于让调用方往历史记录里
   * 塞任意内容——而历史记录应当只包含已经发生的事。
   *
   * 与订单 store 的 `requestIdByKey`、退款 store 的 `refundIdByKey`、
   * 支付 store 的 `requestIdByKey` 是同一套做法（`api-contract.md` §2.8 第一种机制）。
   *
   * ⚠️ 键的作用域是 `companionId`（来自会话），因此**不可能**被用来重放别人的取消。
   */
  releaseIdByKey: Map<string, string>;
};

function createStore(): MockCompanionReleaseStore {
  return { releases: new Map(), releaseIdByKey: new Map() };
}

function store(): MockCompanionReleaseStore {
  return getMockStore("companionRelease", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function companionReleaseStore(): MockCompanionReleaseStore {
  return store();
}

function keyOf(companionId: string, idempotencyKey: string): string {
  return `${companionId}:${idempotencyKey}`;
}

/**
 * 追加一条退出历史（**同步写入器**，无 `await`）。
 *
 * id 在这里生成，而且**当场确认未被占用**：调用方无法指定 id
 * （能指定就等于能覆盖别人的记录），而一条已有的退出历史是**业务事实**，
 * 不能被新记录顶掉。生成与写入在同一段同步代码里，因此不存在
 * 「拿到 id 与写下去之间被别人占掉」这个窗口——这也是为什么这里不像
 * 通知那样单独导出一个 `newXxxId()`：通知需要**在区段之前**把 id 备好
 * 是因为它的内容要提前校验，而退出历史的入参就是一个已经判定完的对象。
 *
 * ⚠️ **不覆盖旧记录**：同一订单退出过两次就是两条，历史不做合并。
 */
export function appendCompanionRelease(
  record: Omit<CompanionReleaseRecord, "id">,
): CompanionReleaseRecord {
  const current = store();

  // —— 原子区段开始（无 await）——
  let id = `rel_${crypto.randomUUID()}`;
  while (current.releases.has(id)) id = `rel_${crypto.randomUUID()}`;

  const stored: CompanionReleaseRecord = { ...record, id };
  current.releases.set(id, stored);
  // —— 原子区段结束 ——

  return stored;
}

/**
 * 幂等索引查询（同步）：同一个打手用同一个键提交过没有。
 *
 * 返回的是**记录 id** 而不是记录本身：调用方按 id 再取一次，
 * 从而「索引命中」与「记录还在」两件事可以分开判断（索引命中但记录已不存在
 * 属于不可能状态，那时按未命中处理而不是让整个请求炸掉）。
 */
export function findCompanionReleaseIdByKey(
  companionId: string,
  idempotencyKey: string,
): string | null {
  return store().releaseIdByKey.get(keyOf(companionId, idempotencyKey)) ?? null;
}

/** 按 id 取一条退出历史；不存在返回 null（同步）。 */
export function findCompanionRelease(id: string): CompanionReleaseRecord | null {
  return store().releases.get(id) ?? null;
}

/**
 * 绑定幂等索引（同步）。
 *
 * ⚠️ **已绑定的键不覆盖**：一个键对应的是「调用方的同一次意图」，
 * 而一次意图只会留下**第一条**记录。允许覆盖就等于允许后来的请求把
 * 「第一次取消发生在什么时候、留下的是哪条历史」悄悄换掉，
 * 于是重放返回的结果会随时间漂移。
 */
export function bindCompanionReleaseKey(
  companionId: string,
  idempotencyKey: string,
  releaseId: string,
): void {
  const current = store();

  // —— 原子区段开始（无 await）——
  const key = keyOf(companionId, idempotencyKey);
  if (!current.releaseIdByKey.has(key)) current.releaseIdByKey.set(key, releaseId);
  // —— 原子区段结束 ——
}

/**
 * 某一单的退出历史，按 `createdAt` 正序（同步）。
 *
 * 同一时刻的两条按 id 兜底排序，保证顺序稳定、可复现——否则管理端每次刷新
 * 可能看到两个不同的先后，而「谁先退的」恰恰是这里唯一要回答的问题。
 */
export function listCompanionReleasesByOrderId(orderId: string): CompanionReleaseRecord[] {
  return [...store().releases.values()]
    .filter((release) => release.orderId === orderId)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
}

export const mockCompanionReleaseRepository: CompanionReleaseRepository = {
  async listReleasesByOrderId(orderId) {
    return listCompanionReleasesByOrderId(orderId);
  },
};
