import type { AdminAuditAction, AdminAuditEntry } from "@/lib/types/adminAudit";
import {
  evaluateCreateReplay,
  evaluateReplay,
  refineReplayByAction,
  type AdminWriteContext,
  type CreateReplayOutcome,
} from "../adminWriteSupport";
import { readAuditEntryByOperationIdTx } from "./adminAuditRepository";
import type { TxHandle } from "./executor";

/**
 * 管理端写事务**事务内共用**的幂等重放判定 —— Mock 侧 `adminWriteSupport` 那三个
 * `take*Replay` 的事务内对应物。
 *
 * ## 为什么单独一个文件
 *
 * PROD-1C 起来时这三个判定是 `pg/adminAuditTransactions.ts` 的私有函数，因为
 * 「需要它们的只有 T8 / T14 / T15」。PROD-1D 又添了平台参数、投诉、券模板三组
 * 事务，**五组事务用的是同一条规则**：
 *
 * > 读账本 →（纯函数）比操作者 × 目标（× 意图）→ 决定这次写不写。
 *
 * 规则本身在 `adminWriteSupport.ts` 的 `evaluateReplay` / `refineReplayByAction` /
 * `evaluateCreateReplay` 里，**只有一处定义**。本文件不重复任何判据，
 * 它只负责「**从哪读**」——从 `admin_audit_entries` 表里读，收一条 id 回来。
 * 不抽出来的话，新添的三组事务会各自再写一遍
 * `SELECT … WHERE operation_id = $1` 加一次 `evaluateReplay` 调用，
 * 而这类重复一旦分叉（例如有人顺手把 SELECT 的列少写一个），
 * 两个存储上「同一个键算不算重放」的答案就会开始不一样。
 *
 * ## ⚠️ 结论只在**取到竞争行锁之后**采信
 *
 * 这是文件头 `pg/adminAuditTransactions.ts` 里那段说明的一半，这里重申是因为它
 * 是调用方的义务、不是本文件能保证的事：两个并发请求若都**先**读账本才决定要不要写，
 * 会双双读空、双双进入写入段，最后撞在 `admin_audit_entries_operation_key`
 * 唯一索引上（`23505`）——那**不是重放，是一次失败**（调用方拿到 500，
 * 而正确的答案是「你刚才已经做过了」）。排在**竞争行锁之后**，第二个请求会在
 * 行锁上等待、等第一个提交之后再读账本，于是看到那一行、正确重放。
 *
 * 因此每组事务都要读**两次**：
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 这两次读调用的就是下面这三个函数，**用的是同一个函数、只有调用位置不同**。
 * 「前置读的 `replay` 不被采信」这件事写在各组事务里，不在这里——
 * 本文件不做决定，它只回答「账本上有什么」。
 */

/**
 * 幂等重放判定（**事务内**，已知目标 id）。
 *
 * 与 Mock 的 `takeReplay` 一一对应：读哪里是参数（这里读 `admin_audit_entries`），
 * 判定本身仍是两个实现共用的纯函数 `evaluateReplay`。
 */
export async function takeReplayTx(
  tx: TxHandle,
  actor: AdminWriteContext,
  targetType: AdminAuditEntry["targetType"],
  targetId: string,
): Promise<ReturnType<typeof evaluateReplay>> {
  const entry = await readAuditEntryByOperationIdTx(tx, actor.operationId);
  return evaluateReplay(entry, actor, targetType, targetId);
}

/**
 * 同上，再收一轴**意图**——与 Mock 的 `takeReplayForAction` 一一对应。
 *
 * ⚠️ 只用于「意图在读到记录之前就已确定」的迁移类动作（退款的三个、投诉的三个）。
 * 编辑类动作不适用，理由见 `adminWriteSupport.ts` 的 `takeReplayForAction` 原注释。
 */
export async function takeReplayForActionTx(
  tx: TxHandle,
  actor: AdminWriteContext,
  action: AdminAuditAction,
  targetType: AdminAuditEntry["targetType"],
  targetId: string,
): Promise<ReturnType<typeof evaluateReplay>> {
  return refineReplayByAction(await takeReplayTx(tx, actor, targetType, targetId), action);
}

/**
 * 幂等重放判定（**事务内**，**新建**类写操作）—— 与 Mock 的 `takeCreateReplay` 一一对应。
 *
 * 判据是「**目标类型**相同」（新建时目标 id 尚不存在，无从比对），纯函数是
 * `evaluateCreateReplay`。返回值里的 `targetId` 是**第一次**那条记录在账本里留下的 id，
 * 调用方拿它回表把当时建出来的记录读出来还给调用方——这样同一个键第二次到达
 * 拿到的是第一次的结果，而不是又建一条。
 *
 * ⚠️ 「审计里有、记录却没有」是**数据被清过**，调用方此时应当返回 `not-found`
 * 而**不是**照着账本编一条出来（Mock 侧 `createCouponTemplate` 就是这么处理的）。
 */
export async function takeCreateReplayTx(
  tx: TxHandle,
  actor: AdminWriteContext,
  targetType: AdminAuditEntry["targetType"],
): Promise<CreateReplayOutcome> {
  const entry = await readAuditEntryByOperationIdTx(tx, actor.operationId);
  return evaluateCreateReplay(entry, actor, targetType);
}
