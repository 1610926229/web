import type { AdminAuditAction, AdminAuditEntry, AdminAuditTargetType } from "@/lib/types/adminAudit";
import { mockAdminAuditRepository } from "./mockAdminAuditRepository";

/**
 * 管理操作审计仓储。
 *
 * ⚠️ **只读接口**。这里没有任何 `create` / `update` / `delete`：审计记录由
 * `lib/data/adminCompanionTransaction.ts` 在**与业务写入同一段不可打断的区段**里写入。
 * 之所以不在这一层提供写方法，是因为一旦提供，就会有人「业务写完了再补一条审计」——
 * 那两件事之间只要有 `await`，就存在「业务改成功了、审计没写进去」的窗口，
 * 而这种缺失事后没有任何办法补回来。写入口只有一处，是这条保证的前提。
 *
 * 两个读取方法的用途不同：
 * - `listAudits`：按对象查「这条护航 / 这份申请经历过什么」，也是测试验证
 *   「每项写操作有且只有一条审计」的入口；
 * - `countAudits`：只回答数量。测试里「重复提交不再产生第二条」用它，
 *   不必把记录取出来。
 */

/** 审计查询条件。两个都缺省表示「不限」。 */
export type AdminAuditQuery = {
  targetType?: AdminAuditTargetType;
  targetId?: string;
  action?: AdminAuditAction;
};

export type AdminAuditRepository = {
  /** 按对象 / 动作查审计，**按时间正序**（发生顺序即阅读顺序）。 */
  listAudits(query?: AdminAuditQuery): Promise<AdminAuditEntry[]>;

  /** 按幂等键查：这个操作标识是否已经产生过审计记录。 */
  findAuditByOperationId(operationId: string): Promise<AdminAuditEntry | null>;

  /** 全部审计记录条数。 */
  countAudits(): Promise<number>;
};

export function getAdminAuditRepository(): AdminAuditRepository {
  return mockAdminAuditRepository;
}
