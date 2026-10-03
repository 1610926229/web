import { toReviewAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  REVIEW_MODERATION_AUDIT_ACTIONS,
  REVIEW_MODERATION_TARGET_STATUS,
  canApplyReviewModeration,
  type ReviewModerationAction,
} from "@/lib/constants/reviews";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type { OrderReview, ReviewStatus } from "@/lib/types/review";
import type { AdminWriteContext } from "./adminWriteSupport";
import { takeReplayForAction, writeAudit } from "./adminWriteSupport";
import { reviewStore } from "./mockReviewRepository";

/**
 * 评价审核写入的**伪事务** —— 管理端通过 / 驳回 / 隐藏 / 恢复公开的唯一写入入口（P1-8）。
 *
 * ## 为什么需要这一层
 *
 * 「重复或并发请求不得产生重复的改动或审计」这条要求横跨「评价」与「审计」两张表，
 * 仓库里没有事务可用，于是这里用一件事替代：**把读—判断—写的全过程放进一段
 * 没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「同一个幂等键通过同一条评价」请求，第二个进来时第一个已经全部写完，
 * 它读到的是**已经存在**的审计记录，于是走重放路径而不是又改一次。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。store 句柄在区段之外（函数开头）取好，
 * 区段内只做同步的读写。下面这个函数虽然声明成 `async`（调用方要 `await` 它），
 * 但**函数体里一个 `await` 都没有**，从第一行到 `return` 之间不会让出执行权。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的对象会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * ⚠️ 本文件**只改评价的审核字段**，一行都不碰 `productReview` / `companionReview` /
 * `evidence`：`D12` 明文「管理员不能改星级与文字」。`applyReviewStatus` 的入参
 * （`ReviewStatusPatch`）里根本没有这些字段的位置，因此这条规则不是靠自觉守住的。
 * 它也不碰订单：评价的审核状态与订单状态是两条互不干涉的线（`D7` / `D20`）。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + `operation_id`
 * 唯一索引），上层的 service 与接口一行都不用改。
 */

export type { AdminWriteContext };

/** 本模块写操作的失败情形。`operation-conflict` 的理由见 `takeReplayForAction` 的注释。 */
export type AdminReviewWriteFailure =
  /** 目标评价不存在 */
  | { kind: "not-found" }
  /** 这个幂等键已经被**另一个操作者或另一个对象**用过，或用在了另一个动作上 */
  | { kind: "operation-conflict" }
  /**
   * 当前状态不允许这个动作。
   *
   * 带上 `current`，是因为服务层要据此给出一句有用的话（「该评价当前为『已通过』，
   * 无法再次通过」）。只说「操作失败」会让管理员以为是自己点错了。
   */
  | { kind: "invalid-transition"; current: ReviewStatus };

/**
 * 一次评价审核写入的结果。
 *
 * 三种「成功」刻意分开（与本仓其它伪事务同一套口径）：
 * - `changed: true` —— 真的改了状态，也写了审计；
 * - `changed: false, replayed: false` —— **这条评价已经处于该动作的目标状态**；
 * - `changed: false, replayed: true` —— 同一个幂等键第二次到达。
 */
export type AdminReviewWriteOutcome =
  | {
      kind: "ok";
      value: { previous: OrderReview; updated: OrderReview };
      changed: boolean;
      replayed: boolean;
    }
  | AdminReviewWriteFailure;

/**
 * 审核一条评价。
 *
 * ## 幂等用 `takeReplayForAction` 而不是 `takeReplay`
 *
 * 同一条评价在同一个状态下往往有**多个合法意图**（待审核时既能通过、也能驳回）。
 * 只比对「操作者 × 目标」的话，管理员带着键 K 通过评价 R、又带着同一个 K 驳回 R，
 * 第二次会被判成「重放」——服务端什么都不做却回 200，管理员以为驳回了，
 * 而评价其实已经公开。因此必须再收一轴：**同一个键必须指向同一个动作**。
 *
 * 这四个动作的意图**在读到记录之前就已确定**（由请求体的 `action` 给出），
 * 正是 `takeReplayForAction` 文档里说的适用场景。
 *
 * ## 「已经是目标状态」为什么不是错误
 *
 * 与 `setCouponTemplateEnabled()` 对「再停用一次已停用的券」的处理一致：
 * 它**已经是调用方想要的样子**。两位管理员同时看到队列里的同一条待审评价、
 * 各自点了一次「通过」，第二位不该收到一个红色报错——那会让人以为自己的操作
 * 失败了、进而去点别的动作。
 *
 * ⚠️ 但这条豁免**只覆盖「目标状态 === 当前状态」**，不覆盖「另一个不同的状态」：
 * 对一条 `approved` 的评价执行 `reject`（目标 `rejected`）仍然是一个
 * **非法迁移**，会被拒绝。这正是 `R2` 要挡住的那条路——把一条已经公开的评价
 * 「驳回」，在数据上等于让它凭空消失，而正确的动作是**隐藏**。
 * 因此状态机里根本没有 `approved → rejected`。
 *
 * ## 原因字段由**动作**决定，不由调用方决定
 *
 * `reject` 填 `rejectReason`、`hide` 填 `hideReason`，其余动作一律清成 `null`。
 * 这样「`rejectReason` 只在 `rejected` 时非空」不是一条需要各处小心的约定，
 * 而是这个函数的输出形状本身就保证的事。原因**是否必填**已在服务层按
 * `REVIEW_MODERATION_REQUIRES_REASON` 校验过，本函数只负责收纳。
 */
export async function moderateReview(
  reviewId: string,
  action: ReviewModerationAction,
  reason: string | null,
  ctx: AdminWriteContext,
): Promise<AdminReviewWriteOutcome> {
  // store 句柄在原子区段**之外**取好：取句柄本身是同步的，但它不该出现在
  // 「读—判断—写」之间，否则区段里就多了一处与业务无关的代码
  const store = reviewStore();

  const auditAction = REVIEW_MODERATION_AUDIT_ACTIONS[action] as AdminAuditAction;
  const targetStatus = REVIEW_MODERATION_TARGET_STATUS[action];

  // —— 原子区段开始（无 await）——
  const replay = takeReplayForAction(ctx, auditAction, "review", reviewId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = store.reviews.get(reviewId);
  if (!existing) return { kind: "not-found" };

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

  // ③ 动作可行性判定。**唯一**的判据，不允许在这里写 `if (status === …)`：
  // 那样加一个状态就要改多处，而漏掉的那一处会表现为「某个动作静默生效」。
  //
  // 判的是 `canApplyReviewModeration` 而不是单纯的 `canTransitionReviewStatus`：
  // `approve` 与 `unhide` 的目标状态都是 `approved`，只看目标状态会让
  // 「对一条隐藏中的评价点『通过』」也通过校验，审计里记成 `review.approve`
  // ——那与真实发生的「恢复公开」不是同一件事（见该函数的注释）。
  if (!canApplyReviewModeration(existing.status, action)) {
    return { kind: "invalid-transition", current: existing.status };
  }

  const written = applyStatusSync(reviewId, targetStatus, action, reason, ctx);
  // 记录在「读」与「写」之间消失（同一个同步区段内不可能发生，但类型上要收口）
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: auditAction,
    targetType: "review",
    targetId: reviewId,
    before: toReviewAuditSnapshot(written.previous),
    after: toReviewAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written, changed: true, replayed: false };
}

/**
 * 真正落到存储的那一笔。
 *
 * ⚠️ **刻意是同步函数，而且刻意不走 `mockReviewRepository.applyReviewStatus`**：
 * 那个方法声明成 `async`，`await` 它**就是一个让出执行权的时刻**，
 * 本文件的原子性会当场消失（而且是那种「测试全绿、并发下偶尔丢一次审计」的消失）。
 * 这里因此直接对 store 句柄做同步写入——将来换成数据库事务时，
 * 被替换的就是这一个函数体。
 */
function applyStatusSync(
  reviewId: string,
  targetStatus: ReviewStatus,
  action: ReviewModerationAction,
  reason: string | null,
  ctx: AdminWriteContext,
): { previous: OrderReview; updated: OrderReview } | null {
  const store = reviewStore();

  const previous = store.reviews.get(reviewId);
  if (!previous) return null;

  const updated: OrderReview = {
    ...previous,
    status: targetStatus,
    // 原因跟着动作走：reject 只填 rejectReason、hide 只填 hideReason，其余清空
    rejectReason: action === "reject" ? reason : null,
    hideReason: action === "hide" ? reason : null,
    reviewedBy: ctx.actorId,
    reviewedByName: ctx.actorName,
    reviewedAt: ctx.at,
    // 内容与 updatedAt 都不动：审核不修改用户写下的东西（D12），
    // 也不该让「用户最后一次改这条评价是什么时候」跟着审核动作前进
  };

  store.reviews.set(reviewId, updated);

  return { previous, updated };
}
