import type { AdminAuditEntry } from "@/lib/types/adminAudit";
import type { AdminAuditQuery, AdminAuditRepository } from "./adminAuditRepository";
import { getMockStore } from "./mockStore";

/**
 * 审计记录的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后清空（**预置数据里没有审计**：
 * 平台刚上线时本来就没有人操作过，凭空造几条「某人做过某事」的审计，
 * 比空着更容易误导）。将来由真实数据库替换（`operation_id` 唯一索引），
 * 本文件的删除不影响上层接口。
 *
 * 建仓时**是空的**，这与其它仓储不同，但对审计来说恰恰是正确状态。
 *
 * ⚠️ `adminAuditStore()` 是**导出**的，理由与 `companionStore()` / `qualificationStore()` 相同：
 * 业务写入与审计写入必须在同一段不可打断的同步区段里完成，
 * 那段伪事务在 `lib/data/adminCompanionTransaction.ts`。除它以外不要从别处取这个 store。
 *
 * 仓储本身**没有任何写方法**（见 `adminAuditRepository.ts` 的说明）：写入口只有一处。
 */

type MockAdminAuditStore = {
  /** 用 Map 而不是数组：插入顺序即发生顺序，`listAudits` 直接按顺序读出 */
  audits: Map<string, AdminAuditEntry>;
  /**
   * `operationId` → 审计 id。**幂等的落点。**
   *
   * 同一个幂等键第二次到达时，服务端靠这个索引认出「这件事已经做过了」，
   * 于是既不再写业务数据，也不再写第二条审计。
   */
  auditIdByOperationId: Map<string, string>;
};

function createStore(): MockAdminAuditStore {
  return { audits: new Map(), auditIdByOperationId: new Map() };
}

export function adminAuditStore(): MockAdminAuditStore {
  return getMockStore("adminAudit", createStore);
}

function matches(entry: AdminAuditEntry, query: AdminAuditQuery): boolean {
  if (query.targetType && entry.targetType !== query.targetType) return false;
  if (query.targetId && entry.targetId !== query.targetId) return false;
  if (query.action && entry.action !== query.action) return false;
  return true;
}

// ——————————————————————————— 同步写入器 ———————————————————————————

/**
 * 同步读出这个幂等键对应的审计记录；没有则返回 null。
 *
 * 给伪事务用的：在动手写业务数据**之前**先问一次「这件事是不是已经做过了」，
 * 是幂等重放的唯一依据。放在仓储方法之外，是因为仓储接口刻意只读（见上）。
 */
export function findAuditEntryByOperationId(operationId: string): AdminAuditEntry | null {
  const store = adminAuditStore();
  const id = store.auditIdByOperationId.get(operationId);
  if (!id) return null;
  return store.audits.get(id) ?? null;
}

/**
 * 追加一条审计。**同步**。
 *
 * ⚠️ 只由 `lib/data/adminCompanionTransaction.ts` 调用，而且必须与业务写入
 * 写在同一个不可打断的区段里：「业务写成功、审计没写进去」这种缺失事后无法补救，
 * 因为没有人知道当时到底发生了什么。
 *
 * 同一个 `operationId` 第二次进来会直接覆盖索引指向（业务侧已经被幂等挡住，
 * 走不到这里），因此这里不做去重——去重的判断必须在**业务写入之前**发生，
 * 而不是事后。
 */
export function appendAuditEntry(entry: AdminAuditEntry): AdminAuditEntry {
  const store = adminAuditStore();
  store.audits.set(entry.id, entry);
  store.auditIdByOperationId.set(entry.operationId, entry.id);
  return entry;
}

export const mockAdminAuditRepository: AdminAuditRepository = {
  async listAudits(query = {}) {
    // Map 的迭代顺序是插入顺序，也就是发生顺序——不排序：审计要的是「当时按什么顺序发生」
    return [...adminAuditStore().audits.values()]
      .filter((entry) => matches(entry, query))
      .map((entry) => ({ ...entry }));
  },

  async findAuditByOperationId(operationId) {
    const store = adminAuditStore();
    const id = store.auditIdByOperationId.get(operationId);
    if (!id) return null;
    const found = store.audits.get(id) ?? null;
    return found ? { ...found } : null;
  },

  async countAudits() {
    return adminAuditStore().audits.size;
  },
};
