import { toReviewAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  REVIEW_MODERATION_AUDIT_ACTIONS,
  REVIEW_MODERATION_TARGET_STATUS,
  canApplyReviewModeration,
  type ReviewModerationAction,
} from "@/lib/constants/reviews";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type { OrderReview } from "@/lib/types/review";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import type { AdminReviewWriteOutcome } from "../adminReviewTransaction";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeReplayForActionTx } from "./adminWriteTx";
import { getPgExecutor, type TxHandle } from "./executor";
import { createReviewRepository } from "./reviewRepository";

/**
 * 评价审核写入事务的 PostgreSQL 实现（PROD-1E · Wave C）——
 * `lib/data/adminReviewTransaction.ts` 的 `moderateReview` 的等价翻译（Hard Rule 2）。
 *
 * ## 判定顺序、状态机、原因规则逐条不变
 *
 * | 步骤 | 判据 | 唯一真值源 |
 * |---|---|---|
 * | 幂等键的**意图**收窄 | 同键必须指向同一个审计动作 | `takeReplayForActionTx` + `REVIEW_MODERATION_AUDIT_ACTIONS` |
 * | 目标状态 | 动作 → 目标状态 | `REVIEW_MODERATION_TARGET_STATUS` |
 * | 已经是目标状态 | 幂等空操作，返回 `changed:false` | —— |
 * | 动作可行性 | 起点 + 状态机边 | `canApplyReviewModeration` |
 * | 原因字段 | `reject` 填 `rejectReason`、`hide` 填 `hideReason`，其余清 `null` | 由**动作**决定 |
 *
 * 「原因是否必填」由服务层按 `REVIEW_MODERATION_REQUIRES_REASON` 校验后传进来，
 * 本层只负责收纳（与 Mock 同）。
 *
 * ⚠️ `reject` 用 `takeReplayForActionTx` 而不是 `takeReplayTx`：同一条评价在同一个
 * 状态下往往有多个合法意图（待审核时既能通过、也能驳回），只比对「操作者 × 目标」
 * 会把「带着同一个键先通过、再驳回」误判成重放。理由详见 Mock 文件与
 * `adminWriteSupport.ts` 的 `takeReplayForAction`。
 *
 * ## 幂等账本要读两次（见 `pg/adminWriteTx.ts` 文件头）
 *
 * 前置读（取锁之前）只判 `conflict`，权威读（取锁之后）才判 `replay`——
 * 两次读调的是**同一个函数**、用的是**同一个判据**，只有调用位置不同。
 *
 * ## 加锁顺序
 *
 * 本事务**只锁 `order_reviews` 一行**，不碰订单（评价的审核状态与订单状态是两条
 * 互不干涉的线，`D7` / `D20`），因此不违反「`orders` 永远是第一把锁」。
 *
 * ## 只改审核字段
 *
 * 走交付好的 `ReviewRepository.applyReviewStatus`（已是窄写入）：它只写
 * `status` / `reject_reason` / `hide_reason` / `reviewed_by` / `reviewed_by_name` /
 * `reviewed_at` 六列，**一行都不碰** `product_review` / `companion_review` /
 * `evidence` / `updated_at`（`D12`：管理员不能改星级与文字，也不改「最后一次内容变更」时间）。
 */

/** `order_reviews` 的最小读：只为 `SELECT … FOR UPDATE` 取得行锁，随后用仓储读整行。 */
async function lockReview(tx: TxHandle, id: string): Promise<OrderReview | null> {
  const rows = await tx.query<{ id: string }>(
    `SELECT id FROM order_reviews WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) return null;
  // 锁到手之后再读完整领域对象：列清单与行映射只有一处（交付好的仓储）
  return createReviewRepository(tx).findReviewById(id);
}

/**
 * 审核一条评价 —— `moderateReview` 的 Pg 实现。
 *
 * ## 「已经是目标状态」为什么不是错误
 *
 * 两位管理员同时看到队列里的同一条待审评价、各自点了一次「通过」，第二位不该收到
 * 一个红色报错——那会让人以为自己的操作失败了。因此 `status === targetStatus` 时
 * 返回 `ok / changed:false`，不写数据、不写审计、不刷新审核时间戳。
 *
 * ⚠️ 但这条豁免**只覆盖「目标状态 === 当前状态」**，不覆盖「另一个不同的状态」：
 * 对一条 `approved` 的评价执行 `reject` 仍然是非法迁移（状态机里没有 `approved → rejected`）。
 *
 * ## 并发
 *
 * 行锁把两个并发请求串行化在同一条评价上：第二个请求要等第一个提交，之后它读到
 * 新的状态；若是同一个动作，要么走重放（同键），要么因为已是目标状态而空操作。
 * 因此不会出现两次写入、也不会写两条审计。
 */
export async function moderateReviewPg(
  reviewId: string,
  action: ReviewModerationAction,
  reason: string | null,
  ctx: AdminWriteContext,
): Promise<AdminReviewWriteOutcome> {
  const auditAction = REVIEW_MODERATION_AUDIT_ACTIONS[action] as AdminAuditAction;
  const targetStatus = REVIEW_MODERATION_TARGET_STATUS[action];

  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayForActionTx(tx, ctx, auditAction, "review", reviewId);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 竞争行锁：这条评价 —— */
    const existing = await lockReview(tx, reviewId);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayForActionTx(tx, ctx, auditAction, "review", reviewId);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // ① 重放：这个键已经做过这个动作了，返回当时的结果，一行都不再改
    if (replay?.kind === "replay") {
      return {
        kind: "ok",
        // 两份互不相关的副本，而不是同一个对象的两个别名
        value: { previous: { ...existing }, updated: { ...existing } },
        changed: false,
        replayed: true,
      };
    }

    // ② 已经是目标状态：不写数据、不写审计、不刷新审核时间戳，且**不是错误**
    if (existing.status === targetStatus) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing } },
        changed: false,
        replayed: false,
      };
    }

    // ③ 动作可行性判定。**唯一**的判据，不允许在这里写 `if (status === …)`。
    //    判的是 `canApplyReviewModeration` 而不是目标状态：`approve` 与 `unhide`
    //    的目标状态都是 `approved`，只看目标状态会把「对隐藏中的评价点通过」也放行，
    //    审计里记成 `review.approve`——那与真实的「恢复公开」不是同一件事。
    if (!canApplyReviewModeration(existing.status, action)) {
      return { kind: "invalid-transition", current: existing.status };
    }

    const written = await createReviewRepository(tx).applyReviewStatus(reviewId, {
      status: targetStatus,
      // 原因跟着动作走：reject 只填 rejectReason、hide 只填 hideReason，其余清空
      rejectReason: action === "reject" ? reason : null,
      hideReason: action === "hide" ? reason : null,
      reviewedBy: ctx.actorId,
      reviewedByName: ctx.actorName,
      reviewedAt: ctx.at,
    });
    // 记录在「读」与「写」之间消失属于不可能状态；当作失败返回（与 Mock 同）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: auditAction,
        targetType: "review",
        targetId: reviewId,
        before: toReviewAuditSnapshot(written.previous),
        after: toReviewAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written, changed: true, replayed: false };
  });
}
