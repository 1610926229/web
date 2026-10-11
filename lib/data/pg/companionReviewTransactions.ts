import { canTransitionCompanionApplication } from "@/lib/constants/adminApplications";
import {
  toCompanionApplicationAuditSnapshot,
  toCompanionAuditSnapshot,
} from "@/lib/constants/adminAudit";
import {
  adminCompanionActionFromPatch,
  isCompanionProfileUnchanged,
} from "@/lib/constants/adminCompanions";
import type {
  AdminCompanionProfilePatch,
  Companion,
} from "@/lib/types/companion";
import type { CompanionApplication } from "@/lib/types/companionApplication";
import type { UserQualificationRecord } from "../qualificationRepository";
import {
  // ⚠️ `buildCompanionFromApplication` **导出是为了共用，不是复制**：
  //    它是「由申请造一条新护航」的唯一实现，Mock 伪事务与这里都调它。
  //    循环 import 在本文件是安全的——它是函数声明（提升的），而且只在函数体里被调用，
  //    不会在任何一个模块的初始化期被求值。
  buildCompanionFromApplication,
  type AdminApplicationWriteResult,
  type AdminCompanionWriteResult,
  type ApproveApplicationOutcome,
} from "../adminCompanionTransaction";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeReplayTx } from "./adminWriteTx";
import { createCompanionApplicationRepository } from "./companionApplicationRepository";
import { createCompanionRepository, lockCompanionForFlagsTx } from "./companionRepository";
import { getPgExecutor, type TxHandle } from "./executor";
import { createQualificationRepository } from "./qualificationRepository";
import { COMPANION_COLUMNS, toCompanion, type CompanionRow } from "./w1Rows";

/**
 * 入驻申请 / 护航资料**管理端写事务**的 PostgreSQL 实现（PROD-1E · Wave C）。
 *
 * ## 逐条对应哪些 Mock 函数（等价翻译，不是重新设计 · Hard Rule 2）
 *
 * | Mock（`lib/data/adminCompanionTransaction.ts`） | Pg（本文件） |
 * |---|---|
 * | `startReviewCompanionApplication` | `startReviewCompanionApplicationPg` |
 * | `rejectCompanionApplication` | `rejectCompanionApplicationPg` |
 * | `approveCompanionApplication` | `approveCompanionApplicationPg` |
 * | `updateCompanionProfile` | `updateCompanionProfilePg` |
 * | `removeCompanion` | `removeCompanionPg` |
 *
 * ⚠️ **`setCompanionFlags` 不在这里**：它早就有了 Pg 实现（`setCompanionFlagsPg`，
 * 见 `./adminAuditTransactions.ts`），本文件既不复刻它、也不改它。
 * `lib/data/adminCompanionTransaction.ts` 的路由把那个名字转发到既有实现上。
 *
 * ## 规则一个都没搬进来
 *
 * 判定仍然住在 `lib/constants/**`，本文件只**编排**它们：
 * `canTransitionCompanionApplication`（申请状态机）、
 * `adminCompanionActionFromPatch` / `isCompanionProfileUnchanged`（编辑类动作名与「没改」判据）、
 * 审计快照 `toCompanionApplicationAuditSnapshot` / `toCompanionAuditSnapshot`。
 * 「由申请建护航」的唯一实现 `buildCompanionFromApplication` 也仍在 Mock 事务文件里，
 * 这里 import 它，不复制一份——两处各写一份的话，「新护航该有哪些字段」迟早会分叉。
 *
 * ## 幂等账本要读两次（与 PROD-1C/D 五组事务同一条规则）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 两个并发请求若都**先**读账本才决定要不要写，会双双读空、双双进入写入段，
 * 最后撞在 `admin_audit_entries_operation_key` 唯一索引上（`23505`）——那**不是重放**，
 * 是一次失败。排在行锁之后，第二个请求会在锁上等待，等第一个提交之后再读账本，
 * 于是看到那一行、正确重放。详见 `pg/adminWriteTx.ts` 的文件头。
 *
 * ## 加锁顺序（全库不变量：`orders` 永远是第一把锁）
 *
 * 本文件**任何一条路径都不碰订单**（申请、资格、护航、审计四张表里没有订单），
 * 因此不违反那条不变量，也不引入新的加锁边到 `orders`：
 *
 * | 事务 | 加锁顺序 |
 * |---|---|
 * | 开始审核 / 拒绝 / 通过 | `companion_applications` →（通过时）`companions`+`user_qualifications` |
 * | 编辑 / 移除护航 | `companions` |
 *
 * ⚠️ 「通过」先锁申请、再写护航：没有任何一条路径是「先锁护航、再锁申请」，
 * 因此这条边不成环。
 *
 * ## 窄写入，而不是整行 UPDATE
 *
 * 三类写入都只碰本次语义涉及的列：
 * - 申请：`status` / `updated_at` / `reviewed_at` / `review_note` 四列
 *   （`applyApplicationReviewTx`）——正文、凭证、幂等键一概不动；
 * - 护航：走交付好的仓储写入器（`createCompanion` / `updateCompanion` /
 *   `markCompanionRemoved`），它们各自已是窄写入；
 * - 资格：`INSERT … ON CONFLICT (user_id, role) DO NOTHING`（主键即唯一性）。
 *
 * ## 时间与 jsonb
 *
 * `*_at` 都是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成 ISO 字符串，
 * 因此领域对象上的时间字段仍是 `string`。本文件没有 jsonb 写入。
 */

/** `companion_applications` 的最小读：只为 `SELECT … FOR UPDATE` 取得行锁。 */
async function lockApplication(
  tx: TxHandle,
  id: string,
): Promise<CompanionApplication | null> {
  // ⚠️ 最小锁：只为「这一行属于本次事务」取得锁，**不在锁语句里映射整行**。
  //    锁到手之后再用仓储读一份完整领域对象——列清单与映射只有一处（交付好的仓储）。
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM companion_applications WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) return null;
  return createCompanionApplicationRepository(tx).findApplicationById(id);
}

/**
 * 审核状态迁移的**事务内**窄写入器 —— `mockCompanionApplicationRepository.applyApplicationReview`
 * 的 Pg 等价物。
 *
 * ⚠️ 它属于**事务层**，不属于仓储：`pg/companionApplicationRepository.ts` 刻意没有
 * 管理端审核的同步写入原语（那是本轮这笔事务的职责），因此这里自己写一条窄 UPDATE。
 * 写下的四列与 Mock 逐字段相同：
 *
 * - `status` / `updated_at` 恒写；
 * - `reviewed_at` / `review_note` **只在这三种审核结果里写**——
 *   开始审核（`reviewing`）不是结果，因此保持原值（`reviewed` 为假的分支）。
 */
async function applyApplicationReviewTx(
  tx: TxHandle,
  applicationId: string,
  to: "reviewing" | "approved" | "rejected",
  input: { at: string; reviewNote: string },
): Promise<{ previous: CompanionApplication; updated: CompanionApplication } | null> {
  const applications = createCompanionApplicationRepository(tx);

  const previous = await applications.findApplicationById(applicationId);
  if (!previous) return null;

  const reviewed = to === "approved" || to === "rejected";

  await tx.query(
    `UPDATE companion_applications
        SET status = $2,
            updated_at = $3,
            reviewed_at = $4,
            review_note = $5
      WHERE id = $1`,
    [
      applicationId,
      to,
      input.at,
      reviewed ? input.at : previous.reviewedAt,
      reviewed ? input.reviewNote : previous.reviewNote,
    ],
  );

  // 回读一次而不是把入参拼成「更新后」的对象：`updated_at` 等 `timestamptz`
  // 要经过驱动归一化，回读才能保证返回值与后续查询逐字段相同。
  const updated = await applications.findApplicationById(applicationId);
  if (!updated) return null;
  return { previous, updated };
}

/**
 * 「这位用户有没有一条关联到**这份申请**的护航」—— Mock 的
 * `findCompanionOfApplication` 的 Pg 等价物（重放分支专用）。
 *
 * ⚠️ 不筛 `removed_at`，与 Mock 一致：重放要如实回答「当时建出来的那条还在不在」，
 * 移除与否是它后来的状态，不影响「它就是那次操作产生的」。
 * 列清单与行映射复用 `w1Rows.ts` 的 `COMPANION_COLUMNS` / `toCompanion`，不重写一份。
 */
async function findCompanionOfApplicationTx(
  tx: TxHandle,
  applicationId: string,
): Promise<Companion | null> {
  const rows = await tx.query<CompanionRow>(
    `SELECT ${COMPANION_COLUMNS} FROM companions
      WHERE application_id = $1
      ORDER BY id ASC
      LIMIT 1`,
    [applicationId],
  );
  return rows[0] ? toCompanion(rows[0]) : null;
}

/**
 * 新护航的 `sortOrder`：`max(sortOrder) + 10`，空名单时从 10 开始
 * —— Mock `nextSortOrder` 的 SQL 等价式。
 *
 * `GREATEST(COALESCE(MAX(sort_order), 0), 0)` 对齐 Mock 的 `let max = 0` 起点：
 * `sort_order` 被常量层限制在 `>= 0`，因此 `GREATEST(…, 0)` 今天恒等于原值，
 * 写它是为了让「起点是 0」这件事在 SQL 里也看得见（Mock 的写法就是这么读的）。
 */
async function nextCompanionSortOrderTx(tx: TxHandle): Promise<number> {
  const rows = await tx.query<{ next: number }>(
    `SELECT GREATEST(COALESCE(MAX(sort_order), 0), 0) + 10 AS next FROM companions`,
  );
  return rows[0]?.next ?? 10;
}

/**
 * 发放护航资格 —— `mockQualificationRepository.grantQualificationRecord` 的 Pg 等价物。
 *
 * ⚠️ 它属于**事务层**：`pg/qualificationRepository.ts` 刻意只有读方法（见其文件头），
 * 资格的发放是审核通过那段事务的一部分，因此写在这里。
 *
 * 返回 `created` 而不是抛错：重复审核通过时第二次走到这里，主键
 * `(user_id, role)` 会让 `ON CONFLICT DO NOTHING` 不写，「本来就有」是安静的成功。
 * 冲突后回读既有记录一并返回，使调用方拿到的永远是真值源里那一条。
 */
async function grantQualificationTx(
  tx: TxHandle,
  record: UserQualificationRecord,
): Promise<{ created: boolean; qualification: UserQualificationRecord }> {
  const inserted = await tx.query<{ user_id: string }>(
    `INSERT INTO user_qualifications
       (user_id, role, companion_id, application_id, granted_at, granted_by_admin_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, role) DO NOTHING
     RETURNING user_id`,
    [
      record.userId,
      record.role,
      record.companionId,
      record.applicationId,
      record.grantedAt,
      record.grantedByAdminId,
    ],
  );
  if (inserted[0]) return { created: true, qualification: record };

  // 已经有一条：回读它（发放时间与发放人指向第一次，不被本次覆盖）
  const existing = await createQualificationRepository(tx).findQualification(
    record.userId,
    record.role,
  );
  // 主键冲突却读不到行属于不可能状态；退回传入的那一份，绝不让调用方拿到 null
  return { created: false, qualification: existing ?? record };
}

/* ─────────────────────────── 开始审核 ─────────────────────────── */

/**
 * 开始审核：`pending → reviewing` —— `startReviewCompanionApplication` 的 Pg 实现。
 *
 * ⚠️ **只改状态**：开始审核不等于通过，不产生护航资料、不发资格、不写审核时间。
 *
 * 判定顺序（与 Mock 逐条相同）：
 * 1. 幂等键用在别的对象上 → `operation-conflict`（前置读）；
 * 2. 申请不存在 → `not-found`（取到行锁之后）；
 * 3. 重放 → `ok / changed:false`（权威读）；
 * 4. `canTransitionCompanionApplication(…, reviewing)` 为假 → `invalid-transition`；
 * 5. 写申请 + 写审计。
 */
export async function startReviewCompanionApplicationPg(
  applicationId: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<CompanionApplication>> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 竞争行锁：这份申请 —— */
    const existing = await lockApplication(tx, applicationId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      // 重放：原样返回当前状态，**不再写任何东西**（连审核时间都不刷新）
      return { kind: "ok", value: { ...existing }, changed: false, replayed: true };
    }

    if (!canTransitionCompanionApplication(existing.status, "reviewing")) {
      return { kind: "invalid-transition", status: existing.status };
    }

    const written = await applyApplicationReviewTx(tx, applicationId, "reviewing", {
      at: ctx.at,
      // 开始审核不动审核意见，把当前值原样传回去（写入器在非「结果」分支保持它）
      reviewNote: existing.reviewNote,
    });
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "application.start-review",
        targetType: "companionApplication",
        targetId: applicationId,
        before: toCompanionApplicationAuditSnapshot(written.previous),
        after: toCompanionApplicationAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written.updated, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 拒绝 ─────────────────────────── */

/**
 * 拒绝：`pending | reviewing → rejected` —— `rejectCompanionApplication` 的 Pg 实现。
 *
 * ⚠️ **不产生护航资料、不发资格**（§十二：拒绝不产生护航）。
 * 审核意见是否非空由服务层按 `normalizeAdminReviewNote()` 校验后传进来，本层不重复校验。
 */
export async function rejectCompanionApplicationPg(
  applicationId: string,
  reviewNote: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<CompanionApplication>> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockApplication(tx, applicationId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读 —— */
    const replay = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };
    if (replay?.kind === "replay") {
      return { kind: "ok", value: { ...existing }, changed: false, replayed: true };
    }

    if (!canTransitionCompanionApplication(existing.status, "rejected")) {
      return { kind: "invalid-transition", status: existing.status };
    }

    const written = await applyApplicationReviewTx(tx, applicationId, "rejected", {
      at: ctx.at,
      reviewNote,
    });
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "application.reject",
        targetType: "companionApplication",
        targetId: applicationId,
        before: toCompanionApplicationAuditSnapshot(written.previous),
        after: toCompanionApplicationAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written.updated, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 通过（§七 的核心） ─────────────────────────── */

/**
 * 审核通过 —— `approveCompanionApplication` 的 Pg 实现。
 *
 * 四件事在**同一个数据库事务**里完成（Mock 的「同一段无 `await` 的同步区段」）：
 *
 * 1. 申请状态改成 `approved`，写审核时间；
 * 2. 给申请人**追加**一条护航资格（不动用户记录，老板身份一点不变）；
 * 3. 创建**或关联**唯一的护航资料（一位用户最多一条有效护航）；
 * 4. 写审计记录。
 *
 * 版本迁移下这四件事的「同生共死」不再靠单线程，而是靠数据库事务：
 * 任何一步失败（例如审计 `INSERT` 撞上唯一索引）都整体回滚——申请状态、
 * 资格、护航**一个都不会留下**。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * 1. 幂等键用在别的对象上 → `operation-conflict`（前置读）；
 * 2. 申请不存在 → `not-found`；
 * 3. 重放 → 找回那一次产生的护航（按 `application_id`）与资格
 *    （按 `(userId, 'companion')`），**两者缺一即 `not-found`**（数据被清过），
 *    否则 `ok / changed:false / replayed:true`，且如实回报 `companionCreated:true` /
 *    `qualificationGranted:true`——它们第一次就产生了（权威读）；
 * 4. `canTransitionCompanionApplication(…, approved)` 为假 → `invalid-transition`；
 * 5. 写申请 → 复用或新建护航 → 复用或发放资格 → 写审计。
 *
 * ## 为什么「重复通过」不是错误
 *
 * 申请是终态、`(user_id)` 部分唯一索引、`(user_id, role)` 主键三层一起，
 * 让第二次通过无论如何都只会复用同一条护航、同一条资格——
 * 三条数据都只有一份，因此第二次的答案是「本来就有」而**不是**失败。
 */
export async function approveCompanionApplicationPg(
  applicationId: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<ApproveApplicationOutcome>> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 第一把锁：这份申请 —— */
    const existing = await lockApplication(tx, applicationId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读 —— */
    const replay = await takeReplayTx(tx, ctx, "companionApplication", applicationId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const qualifications = createQualificationRepository(tx);
    const companions = createCompanionRepository(tx);

    if (replay?.kind === "replay") {
      // 重放：把第一次产生的护航与资格找回来。两者缺一说明数据被清过，
      // 此时按「找不到」返回，而不是编一条出来（与 Mock 一致）
      const linked = await findCompanionOfApplicationTx(tx, applicationId);
      const qualification = await qualifications.findQualification(existing.userId, "companion");
      if (!linked || !qualification) return { kind: "not-found" };

      return {
        kind: "ok",
        value: {
          application: { ...existing },
          companion: linked,
          qualification,
          // 重放不代表什么都没发生：这两样在第一次就已经产生了，这里如实说「有」
          companionCreated: true,
          qualificationGranted: true,
        },
        changed: false,
        replayed: true,
      };
    }

    if (!canTransitionCompanionApplication(existing.status, "approved")) {
      return { kind: "invalid-transition", status: existing.status };
    }

    /* —— ① 申请状态 —— */
    const written = await applyApplicationReviewTx(tx, applicationId, "approved", {
      at: ctx.at,
      // 通过不需要理由。保留既有备注（正常情况下是空串），不编一句「审核通过」进去
      reviewNote: existing.reviewNote,
    });
    if (!written) return { kind: "not-found" };

    /* —— ② 资格：先看有没有，有就复用（不覆盖发放时间与发放人）—— */
    const existingQualification = await qualifications.findQualification(
      existing.userId,
      "companion",
    );

    /* —— ③ 护航：有有效记录就复用，没有才新建 —— */
    // ⚠️ id 前缀与形状与 Mock 的 `nextCompanionId` 相同（`cp_` + UUID），
    //    预置数据用的是 `cp-1` 这样的短 id，取值域分得开。真撞上主键冲突时
    //    整个事务回滚——**宁可失败，也不覆盖一条既有记录**（与 Mock 同一条）。
    const companionId = existingQualification?.companionId ?? `cp_${crypto.randomUUID()}`;
    const created = await companions.createCompanion(
      buildCompanionFromApplication({
        application: existing,
        id: companionId,
        sortOrder: await nextCompanionSortOrderTx(tx),
      }),
    );

    /* —— ② 资格（续）：没有才发；主键让「同一条只发一次」成立 —— */
    const qualification: UserQualificationRecord = existingQualification ?? {
      userId: existing.userId,
      role: "companion",
      companionId: created.companion.id,
      applicationId: existing.id,
      grantedAt: ctx.at,
      grantedByAdminId: ctx.actorId,
    };
    const granted = await grantQualificationTx(tx, qualification);

    /* —— ④ 审计：业务写入全部完成之后紧接着写，同一个事务 —— */
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "application.approve",
        targetType: "companionApplication",
        targetId: applicationId,
        before: toCompanionApplicationAuditSnapshot(written.previous),
        after: toCompanionApplicationAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: {
        application: written.updated,
        companion: created.companion,
        // ⚠️ 用 `granted.qualification` 而不是 `qualification`：主键冲突（并发通过）时
        //    前者是回读到的真值源那一条，与 Mock「本来就有的那一条」口径一致。
        qualification: granted.qualification,
        companionCreated: created.kind === "created",
        qualificationGranted: granted.created,
      },
      changed: true,
      replayed: false,
    };
  });
}

/* ─────────────────────── 护航编辑 / 状态变更 ─────────────────────── */

/**
 * 编辑护航资料（含暂停 / 恢复 / 启用 / 停用）—— `updateCompanionProfile` 的 Pg 实现。
 *
 * 五种后台动作走同一个写入路径：都只是在改同一组字段，区别只在改了什么。
 * 审计动作由 `adminCompanionActionFromPatch()` 从差异推导。
 *
 * 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**：
 * - 幂等重放；- 本来就是这个状态（`isCompanionProfileUnchanged`）。
 *
 * ⚠️ 用的是交付好的 `CompanionRepository.updateCompanion`（它已是窄写入，
 * 只覆盖 `patch` 里那些字段）。
 */
export async function updateCompanionProfilePg(
  companionId: string,
  patch: AdminCompanionProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "companion", companionId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 竞争行锁：这位护航自己 —— */
    const existing = await lockCompanionForFlagsTx(tx, companionId);
    if (!existing) return { kind: "not-found" };
    // 已移除的记录不再接受编辑：它已经不在名单里，改资料没有任何去向
    if (existing.removedAt !== null) return { kind: "removed" };

    /* —— 权威读 —— */
    const replay = await takeReplayTx(tx, ctx, "companion", companionId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = adminCompanionActionFromPatch(existing, patch);

    if (replay?.kind === "replay" || isCompanionProfileUnchanged(existing, patch)) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await createCompanionRepository(tx).updateCompanion(companionId, patch);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "companion",
        targetId: companionId,
        before: toCompanionAuditSnapshot(written.previous),
        after: toCompanionAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
  });
}

/**
 * 移除护航（软删除）—— `removeCompanion` 的 Pg 实现。
 *
 * ⚠️ **不删除记录**：只写 `removed_at`。历史订单、评价与鸡腿记录都要继续指得到它。
 *
 * 已经移除时不刷新时间戳、不写第二条审计：重复移除是幂等的，不是错误。
 * `markCompanionRemoved` 内部的 `COALESCE(c.removed_at, $2)` 让这一点在 SQL 里也成立，
 * 但这里的**权威重放判定**才是「同一幂等键第二次到达」的正确分支。
 */
export async function removeCompanionPg(
  companionId: string,
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "companion", companionId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    const existing = await lockCompanionForFlagsTx(tx, companionId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读 —— */
    const replay = await takeReplayTx(tx, ctx, "companion", companionId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // 已经移除了：不刷新时间戳、不写第二条审计（幂等的空操作，不是错误）
    if (replay?.kind === "replay" || existing.removedAt !== null) {
      return {
        kind: "ok",
        value: {
          previous: { ...existing },
          updated: { ...existing },
          action: "companion.remove",
        },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await createCompanionRepository(tx).markCompanionRemoved(companionId, ctx.at);
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "companion.remove",
        targetType: "companion",
        targetId: companionId,
        before: toCompanionAuditSnapshot(written.previous),
        after: toCompanionAuditSnapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { ...written, action: "companion.remove" },
      changed: true,
      replayed: false,
    };
  });
}
