import { toComplaintAuditSnapshot } from "@/lib/constants/adminAudit";
import { canTransitionComplaint } from "@/lib/constants/adminComplaints";
import {
  INTENT_TO_STATUS,
  auditActionOf,
  type AdminComplaintIntent,
  type AdminComplaintWriteResult,
} from "../adminComplaintTransaction";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeReplayForActionTx } from "./adminWriteTx";
import { applyComplaintStatusTx, lockComplaintTx } from "./complaintRepository";
import { getPgExecutor } from "./executor";

/**
 * 管理端 / 客服端**投诉处理**的 PostgreSQL 事务 ——
 * `lib/data/adminComplaintTransaction.ts` 的 `applyAdminComplaintIntent` 的等价翻译。
 *
 * ## 为什么这一条要单独一批
 *
 * 投诉处理的写闭包形状与 T15（开始审核退款）最近：**只改被处理的那一条记录**
 * （`complaints` 一行），不写订单、不写退款、不动任何金额，因此它的加锁面最窄。
 * 但它比 T15 多两条约束：
 *
 * 1. **处理人身份是三个字段**（id / 角色 / 名称），而角色有 CHECK 约束
 *    （`complaints_handler_role_check`：`admin` 或 `customer_service`）。
 *    写错一个值是一整个事务回滚，而不是一条脏数据。
 * 2. **同一个 `result` 字段承载两种语义**（解决时的处理结果、关闭时的关闭说明），
 *    而 `start-processing` **一个字符都不许碰它**。
 *
 * ## 与 Mock 伪事务的关系：**等价翻译**，不是重新设计
 *
 * 逐条对应 `applyAdminComplaintIntent`：判定顺序、守卫、幂等判据、
 * 写入的字段集合**一个字没改**。规则的唯一真值源仍然是：
 *
 * - `INTENT_TO_STATUS`（意图 → 目标状态）与 `auditActionOf`（意图 → 审计动作）
 *   ——**直接 import Mock 模块**，不在本文件里再抄一份映射表。
 *   这两条映射分叉的那一天，同一个处理动作在 Mock 上迁到 A 状态、
 *   在 Pg 上迁到 B 状态，而两边都「没有报错」。
 * - `canTransitionComplaint`（常量层的状态机）、`toComplaintAuditSnapshot`（快照收纳）。
 *
 * 本文件只**编排**它们，不复制它们的判据。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * ```
 * 1. 幂等键用在别的投诉 / 别的意图上  → operation-conflict（前置读）
 * 2. 投诉不存在                      → not-found
 * 3. 重放                            → ok / changed:false / replayed:true（权威读）
 * 4. canTransitionComplaint(…, to)   → invalid-transition（携带**当前**状态）
 * 5. 窄写入 + 一条审计（同一事务）
 * ```
 *
 * ⚠️ 第 4 步**必须在锁下判定**。不加锁地判「这条投诉现在能不能迁移」，
 * 两个管理员会双双读到 `pending`、双双通过判定，然后后写的那一次把前一次的
 * 结果覆盖掉——而两条审计都记着「从 pending 改成 X」。行锁把两者串行化之后，
 * 第二个请求醒来时读到的是 `processing`，`processing → processing` 不在状态表里，
 * 于是它拿到 `invalid-transition`。
 *
 * ## ⚠️ 幂等账本要读**两次**（与 T8 / T14 / T15 同一条规则）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 若把权威读排在锁之前，同一个键的两个并发请求会双双读空账本、双双进入写入段，
 * 撞在 `admin_audit_entries_operation_key` 唯一索引上（`23505`）——那**不是重放，
 * 是一次失败**（调用方拿到 500，而正确的答案是「你刚才已经做过了」）。
 * 完整论证见 `pg/adminAuditTransactions.ts` 的文件头。
 *
 * ⚠️ 前置读只回答 `conflict` 一个问题，它读到的 `replay` **不被采信**——
 * 那条结论会导向写入，必须留给权威读。
 *
 * ## ⚠️ 加锁顺序：这是一条**只锁 `complaints`** 的路径
 *
 * 全库统一的不变量是「**`orders` 永远是第一把锁**」（理由见 `w1Transactions.ts` 文件头）。
 * 本路径**只锁 `complaints` 一行**，不写订单、不写退款，因此不引入新的边：
 *
 * | 事务 | 加锁顺序 |
 * |---|---|
 * | 投诉处理（本文件） | **仅 `complaints`** |
 *
 * ⚠️ 既然不锁 `orders`，那么将来若有人在这里加一次「读订单」用来做别的判定，
 * **只允许普通读**（`SELECT`，不加 `FOR UPDATE`）——普通读不参与加锁顺序，
 * 不会与「先锁订单、再回头碰投诉」的路径成环；`lockOrder` 之类一律不许用。
 * 今天这条路径连订单都不读。
 *
 * ## 事务内**绝不**调 Mock 侧的写入
 *
 * 本文件只 import Mock 模块的**两个纯映射**（`INTENT_TO_STATUS` / `auditActionOf`）
 * 与共享的类型。审计走 `appendAuditEntryTx` 的 `INSERT`，绝不调
 * `adminWriteSupport.writeAudit`（它末尾会写进程内的 Mock 账本）。
 * 因此「一次管理动作 = 一条数据库审计」在一半 Mock、一半 Pg 的意义上不存在。
 *
 * ## 不得新增通知
 *
 * Mock 这条路径上**没有任何通知写入**（`adminComplaintTransaction.ts` 里连通知模块
 * 都不 import）。因此这里也不发通知。若将来产品要求「处理投诉时通知用户」，
 * 那是一次**新功能**，不是本轮的翻译——它会按通知的幂等规则另起一条写入，
 * 而不是在这里顺手加一个 `appendNotification`。
 */

/**
 * 三个处理动作的**唯一写入路径**（PostgreSQL）——
 * `applyAdminComplaintIntent` 的等价翻译。
 *
 * ⚠️ 它的调用方**只有测试**：`DATA_SOURCE` 未设置时应用照旧走 Mock 伪事务
 * （与本轮其它 Pg 事务同一条裁定）。激活的就绪条件见 Round 的 `02-decisions.md`。
 */
export async function applyAdminComplaintIntentPg(
  complaintId: string,
  intent: AdminComplaintIntent,
  result: string,
  ctx: AdminWriteContext,
): Promise<AdminComplaintWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    // 意图 → 目标状态 / 审计动作：两个映射都来自 Mock 模块，本文件不自建
    const to = INTENT_TO_STATUS[intent];
    const action = auditActionOf(intent);

    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    // ⚠️ 用 `takeReplayForActionTx` 而不是 `takeReplayTx`：三个意图作用于同一条投诉，
    //    同一个键先「开始处理」再「解决」若被判成重放，会安静地返回 200 而状态不变
    const pre = await takeReplayForActionTx(tx, ctx, action, "complaint", complaintId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 竞争行锁：这条投诉自己。判定与写入都围着这一行 —— */
    const existing = await lockComplaintTx(tx, complaintId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayForActionTx(tx, ctx, action, "complaint", complaintId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      // 重放：把**当前**状态原样报一次，**不再写任何东西**（包括不写审计）。
      // 与 Mock 的 `{ ...existing }` 同：读的是锁下那一份，不是请求里的假设
      return {
        kind: "ok",
        value: { complaint: { ...existing } },
        changed: false,
        replayed: true,
      };
    }

    // 状态机判定**在锁下**（理由见文件头的判定顺序）
    if (!canTransitionComplaint(existing.status, to)) {
      return { kind: "invalid-transition", status: existing.status };
    }

    // 写入值由**锁下读到的那一份** + ctx 决定：`processing_at` 的「保持原值」
    // 与 `handled_*` 的「保持原值」都取自它，传一份陈旧快照进来那些「原值」就是错的
    const written = await applyComplaintStatusTx(tx, existing, to, {
      at: ctx.at,
      result,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actorName: ctx.actorName,
    });

    // 业务写入全部完成之后紧接着写审计，同一个事务：
    // 「业务成了、审计没成」这种缺失事后无法补救，两者必须同生共死
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "complaint",
        targetId: complaintId,
        before: toComplaintAuditSnapshot(written.previous),
        after: toComplaintAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { complaint: written.updated }, changed: true, replayed: false };
  });
}
