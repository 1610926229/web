import type { AdminAuditAction, AdminAuditEntry, AdminAuditSnapshot } from "@/lib/types/adminAudit";
import { appendAuditEntry, findAuditEntryByOperationId } from "./mockAdminAuditRepository";

/**
 * 管理写操作的公共零件：**写上下文、幂等重放判定、审计写入**。
 *
 * ⚠️ 本文件里的三个函数都是**同步**的，而且只允许在调用方的原子区段内被调用。
 * 它们被单独抽出来，是因为护航（P8A）与商品目录（P8B）两组伪事务需要**同一套**幂等与
 * 审计规则：各写一份的话，「同一个幂等键第二次到达会怎样」在两个模块里迟早会有两种答案，
 * 而这类差异只在并发或重试时才会暴露。
 *
 * ⚠️ 这里出现 `await` 就是 bug：调用方的原子区段靠「没有让出执行权的时刻」成立，
 * 哪怕加一个 `await Promise.resolve()` 都会让它失效。
 */

/** 一次管理写操作的上下文。`operationId` 就是请求的幂等键（见 §九）。 */
export type AdminWriteContext = {
  /** 执行操作的管理者 id */
  adminId: string;
  /** 幂等键：同一次操作意图重复到达时用它认出「已经做过了」 */
  operationId: string;
  /** 服务端时间戳（ISO 字符串），业务写入与审计写入共用同一个 */
  at: string;
};

/** 这些操作共用的失败情形。各模块自己的前置条件失败不在这里，由各自的联合类型补。 */
export type AdminWriteCommonFailure =
  /** 目标不存在 */
  | { kind: "not-found" }
  /** 已移除的记录不能再编辑或改变状态：它已经不在用户端了 */
  | { kind: "removed" }
  /**
   * 这个幂等键已经被**另一个对象**用过。
   *
   * 客户端复用了幂等键属于调用方的 bug；此时安静地重放会返回另一个对象的操作结果，
   * 比报错危险得多。因此单独分出来，由服务层转成一个明确的 400。
   */
  | { kind: "operation-conflict" };

/**
 * 幂等重放检查（**已知目标 id** 的写操作）。
 *
 * 返回 `null` 表示这个幂等键没用过；返回 `replay` 表示用过且指向同一个对象；
 * 返回 `conflict` 表示用过但指向别的对象。
 *
 * ⚠️ 必须在**读写业务数据之前**调用，因此它自己也只做同步读。
 */
export function takeReplay(
  operationId: string,
  targetType: AdminAuditEntry["targetType"],
  targetId: string,
): { kind: "replay"; entry: AdminAuditEntry } | { kind: "conflict" } | null {
  const entry = findAuditEntryByOperationId(operationId);
  if (!entry) return null;

  if (entry.targetType !== targetType || entry.targetId !== targetId) return { kind: "conflict" };
  return { kind: "replay", entry };
}

/**
 * 幂等重放检查（**新建**类写操作）。
 *
 * 新建时还不知道目标 id——它要在原子区段里当场生成，因此「重放」不能靠比对 id 认出来，
 * 只能靠「这个键已经被同一个类型的对象用过」来判定，再拿审计里记的 `targetId`
 * 把当时建出来的那条记录找回来。这样同一个键第二次到达时返回的是**第一次的结果**，
 * 而不是又建一条。
 *
 * 类型不同则说明这个键被另一个模块用了，属于调用方 bug，返回 `conflict`。
 */
export function takeCreateReplay(
  operationId: string,
  targetType: AdminAuditEntry["targetType"],
): { kind: "replay"; targetId: string } | { kind: "conflict" } | null {
  const entry = findAuditEntryByOperationId(operationId);
  if (!entry) return null;

  if (entry.targetType !== targetType) return { kind: "conflict" };
  return { kind: "replay", targetId: entry.targetId };
}

/**
 * 写一条审计。同步，且**必须**在调用方的原子区段内被调用。
 *
 * 「业务写成功、审计没写进去」这种缺失事后无法补救——没有人知道当时到底发生了什么，
 * 因此两者必须同生共死。
 */
export function writeAudit(input: {
  ctx: AdminWriteContext;
  action: AdminAuditAction;
  targetType: AdminAuditEntry["targetType"];
  targetId: string;
  before: AdminAuditSnapshot | null;
  after: AdminAuditSnapshot | null;
}): AdminAuditEntry {
  return appendAuditEntry({
    id: `aud_${crypto.randomUUID()}`,
    adminId: input.ctx.adminId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before,
    after: input.after,
    // operationId 直接就是幂等键：同一个键重复到达时，靠它认出「做过了」
    operationId: input.ctx.operationId,
    createdAt: input.ctx.at,
  });
}

/**
 * 生成一个**不会与既有记录冲突**的 id。
 *
 * 预置数据用的是 `p-400w` / `c-loss` / `s-900w` 这样的短 id，后台新建的记录用下划线
 * 前缀（`p_` / `c_` / `sp_`），从取值域上就分开；再加一次存在性检查，
 * 「新建覆盖掉一条预置记录」因此不是「大概不会发生」，而是写不出来。
 *
 * ⚠️ 这段循环必须在原子区段内：`crypto.randomUUID()` 是同步的，
 * 取 id 与写入之间没有让出执行权的机会。
 */
export function nextRecordId(
  prefix: string,
  taken: (candidate: string) => boolean,
  label: string,
): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `${prefix}${crypto.randomUUID()}`;
    if (!taken(id)) return id;
  }
  // 连撞五次在现实中不会发生；真发生也只能说明随机源坏了，此时**宁可失败**，
  // 也不能返回一个可能覆盖既有记录的 id
  throw new Error(`无法生成不冲突的${label} id`);
}
