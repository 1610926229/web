import { toAgreementAuditSnapshot } from "@/lib/constants/adminAudit";
import { bumpAgreementVersion } from "@/lib/constants/agreements";
import {
  agreementActionFromEnabled,
  isAgreementContentUnchanged,
} from "@/lib/constants/adminAgreements";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type { AdminAgreementProfilePatch } from "@/lib/types/agreement";
import { buildAuditEntry } from "../adminWriteSupport";
import type { AdminAgreementWriteOutcome, AdminWriteContext } from "../adminAgreementTransaction";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { createAgreementRepository } from "./agreementRepository";
import { takeReplayTx } from "./adminWriteTx";
import { getPgExecutor, type PgQueryable } from "./executor";

/**
 * 协议写闭包（**编辑 / 启停**）的 PostgreSQL 事务 ——
 * `lib/data/adminAgreementTransaction.ts` 两个入口的**等价翻译**（PROD-1E · Wave C）。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 协议正文与启用状态的写入入口只有一处（Mock 的伪事务），判据、版本号规则、审计、
 * 返回值都在那里定义。它与其它管理端写闭包共用一条跨领域不变式：
 *
 * > 协议的业务写入与它的那一条管理审计必须**同生共死**。
 *
 * Mock 靠「同一段无 `await` 的同步代码」成立；换成数据库之后，业务写入
 * （`agreementRepository` 的 UPDATE）与审计写入各自是一条 SQL，中间必然让出执行权。
 * 因此审计必须在**同一个事务**里 `INSERT`（`appendAuditEntryTx`），审计失败则
 * 协议写入一起回滚。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、三种「成功」的口径（`changed` / `replayed`）、版本号递增规则、写入的字段集合、
 * 审计快照 **逐条对齐** `adminAgreementTransaction.ts`。业务规则一个字节都没改，
 * 规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 「正文/标题有没有变」的判据 | `adminAgreements.ts` 的 `isAgreementContentUnchanged` |
 * | 这次该记哪个动作 | `adminAgreements.ts` 的 `agreementActionFromEnabled` |
 * | 正文变了才递增版本号 | `agreements.ts` 的 `bumpAgreementVersion` |
 * | 审计记什么（**不含正文**） | `adminAudit.ts` 的 `toAgreementAuditSnapshot` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay`（经 `adminWriteTx`） |
 *
 * ## 复用 `pg/agreementRepository.ts` 的写方法，只自己补一把行锁
 *
 * 协议没有新建、没有移除，仓储层已经有两个窄写入器（`updateAgreement` 覆盖五个可编辑列、
 * `setAgreementEnabled` 只改两列），这里**直接复用**它们——另写一份 SQL 只会让列清单
 * 在两处分叉。仓储只缺一件东西：`FOR UPDATE` 行锁，因此本文件补一个
 * `lockAgreementForUpdateTx`。
 *
 * ## 为什么必须有行锁
 *
 * 「读出现有版本号 → 算出新版本号 → 写回」必须原子（`adminAgreementTransaction.ts` 文件头）。
 * 没有锁的话，两个同时保存同一份协议的请求会各自基于同一个旧版本号算出同一个新版本号，
 * 双双 `UPDATE` —— 撞在 `agreements_type_version_key` 唯一索引上（`23505`）**整段失败**，
 * 而 Mock 的答案是第一个成功、第二个读到新版本号算出「再高一位」。
 * 因此判定与写入都必须在**锁下读到的那一份**上做。
 *
 * ⚠️ 加锁顺序：本条路径只锁 `agreements` 的一行，**不碰 `orders`**，因此与全库
 * 「`orders` 永远是第一把锁」这条不变量不冲突（那条管的是「同时要锁订单与别的表」的路径）。
 *
 * ## 幂等账本读两次（与其它管理端写闭包同一条设计）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 把 `takeReplay` 排在第一行的次序对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，会双双读空、
 * 双双写入，撞的是 `admin_audit_entries_operation_key`（`23505`）= 一次失败，
 * 而不是重放（与 `pg/couponTemplateTransactions.ts` 同）。
 */

/**
 * 锁住一份协议（`SELECT … FOR UPDATE`）—— 只回答「这一行在不在」。
 *
 * 加锁之后再用 `createAgreementRepository(tx)` 把整条读出来（同一事务、同一条连接，
 * 读到的一定是锁住的那一份）。这里不做整行映射，是为了不把仓储的列清单抄第二遍。
 */
async function lockAgreementForUpdateTx(db: PgQueryable, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM agreements WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows.length > 0;
}

/* ─────────────────────────── 编辑 ─────────────────────────── */

/**
 * 编辑一份协议（标题 / 正文 / 启用状态一起提交）—— `updateAgreement` 的 Pg 实现。
 *
 * 版本号规则在这里、也只在这里：正文或标题**真的变了**才 `bumpAgreementVersion()`；
 * 只改启用状态则不动版本；什么都没改则不写数据、不写审计、不刷新 `updatedAt`。
 *
 * 审计动作按「启停优先」的口径选（`agreementActionFromEnabled`）：一次同时改了正文
 * 又关掉启用的保存记的是 `agreement.disable`——它回答的是「这份协议为什么从用户端消失了」。
 */
export async function updateAgreementPg(
  id: string,
  draft: AdminAgreementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminAgreementWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在第一行）—— */
    const pre = await takeReplayTx(tx, ctx, "agreement", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这份协议自己。判定与写入都围着这一行 —— */
    if (!(await lockAgreementForUpdateTx(tx, id))) return { kind: "not-found" };
    const repo = createAgreementRepository(tx);
    const existing = await repo.findAgreementById(id);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "agreement", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const contentChanged = !isAgreementContentUnchanged(existing, draft);
    const enabledChanged = existing.enabled !== draft.enabled;
    const action: AdminAuditAction = agreementActionFromEnabled(existing.enabled, draft.enabled);

    // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**。
    // ⚠️ 两份必须是**互相独立**的副本（Mock 里是两次 `cloneAgreement`）：再读一次——
    //    `toAgreement` 每次都返回新对象，因此两次读天然互不影响。
    if (replay?.kind === "replay" || (!contentChanged && !enabledChanged)) {
      const copy = await repo.findAgreementById(id);
      return {
        kind: "ok",
        value: { previous: existing, updated: copy ?? existing, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await repo.updateAgreement(id, {
      title: draft.title,
      sections: draft.sections,
      // 正文/标题真的变了才推进版本号；只改启用状态时原样保留
      version: contentChanged ? bumpAgreementVersion(existing.version) : existing.version,
      enabled: draft.enabled,
      at: ctx.at,
    });
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "agreement",
        targetId: id,
        // ⚠️ 快照里不含正文：`toAgreementAuditSnapshot` 只记 sectionCount / paragraphCount。
        // 审计表不该以「正文的长度」增长。
        before: toAgreementAuditSnapshot(written.previous),
        after: toAgreementAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { previous: written.previous, updated: written.updated, action },
      changed: true,
      replayed: false,
    };
  });
}

/* ─────────────────────────── 启用 / 停用 ─────────────────────────── */

/**
 * 启用 / 停用协议（**窄写入**：只改这一个字段）—— `setAgreementEnabled` 的 Pg 实现。
 *
 * ⚠️ 与 `updateAgreementPg()` 分开，是因为它**不该碰标题与正文**：列表页上的开关只应当
 * 改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，两位管理员同时操作时，
 * 后写的那次会把另一位刚改好的正文覆盖回旧值——而正文是几十段文本，那种覆盖发现不了。
 *
 * ⚠️ **这条路径不动 `version`**：启用状态不是正文的版本。
 *
 * 已经是目标状态时：不写数据、不写审计、**不刷新 `updatedAt`**，返回 `changed:false`。
 */
export async function setAgreementEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminAgreementWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "agreement", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这份协议自己 —— */
    if (!(await lockAgreementForUpdateTx(tx, id))) return { kind: "not-found" };
    const repo = createAgreementRepository(tx);
    const existing = await repo.findAgreementById(id);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本 —— */
    const replay = await takeReplayTx(tx, ctx, "agreement", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action: AdminAuditAction = enabled ? "agreement.enable" : "agreement.disable";

    // 两份互相独立的副本，理由同 `updateAgreementPg`
    if (replay?.kind === "replay" || existing.enabled === enabled) {
      const copy = await repo.findAgreementById(id);
      return {
        kind: "ok",
        value: { previous: existing, updated: copy ?? existing, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    // 仓储的窄写入器只改 `enabled` 与 `updated_at` 两列，version 原样保留
    const written = await repo.setAgreementEnabled(id, enabled, ctx.at);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态（与 Mock 同处理）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "agreement",
        targetId: id,
        before: toAgreementAuditSnapshot(written.previous),
        after: toAgreementAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { previous: written.previous, updated: written.updated, action },
      changed: true,
      replayed: false,
    };
  });
}
