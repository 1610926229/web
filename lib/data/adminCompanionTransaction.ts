import { canTransitionCompanionApplication } from "@/lib/constants/adminApplications";
import { COMPANION_RELEASE_REASON_DISABLED } from "@/lib/constants/dispatch";
import {
  toCompanionApplicationAuditSnapshot,
  toCompanionAuditSnapshot,
} from "@/lib/constants/adminAudit";
import {
  NEW_COMPANION_AVATAR_URL,
  NEW_COMPANION_RANK_LABEL,
  NEW_COMPANION_UNAVAILABLE_REASON,
  adminCompanionActionFromPatch,
  isCompanionProfileUnchanged,
} from "@/lib/constants/adminCompanions";
import type { AdminAuditAction, AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type { AdminCompanionProfilePatch, Companion } from "@/lib/types/companion";
import type {
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import { takeReplay, writeAudit, type AdminWriteContext } from "./adminWriteSupport";
import { releaseOrdersForCompanion } from "./companionOrderTransaction";
import {
  applyApplicationReview,
  companionApplicationStore,
} from "./mockCompanionApplicationRepository";
import {
  applyCompanionFlags,
  applyCompanionPatch,
  applyCompanionRemoval,
  companionStore,
  createCompanionRecord,
} from "./mockCompanionRepository";
import {
  findQualificationRecord,
  grantQualificationRecord,
  qualificationStore,
} from "./mockQualificationRepository";
import type { UserQualificationRecord } from "./qualificationRepository";

/**
 * 管理写操作的**伪事务** —— 本阶段所有审核与护航改动的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * §七 要求「审核通过」在同一个原子区段里完成四件事：改申请状态、发资格、
 * 建（或关联）护航、写审计；§十 又要求业务写入与审计写入同区间。这四件事
 * 分属四个 Mock Store，仓库里没有事务可用，于是这里用一件事替代：
 * **把读—判断—写的全过程放进一段没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「通过」请求，第二个进来时第一个已经全部写完，
 * 它读到的就是「已经通过了」。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。所有 store 句柄都在区段之外（函数开头）取好，
 * 区段内只做同步的读写。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份
 * 存储，缓存下来的 Map 会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * **先校验再写入**：每个操作都先确认目标存在、状态允许，然后才动手；
 * 任何一个前置条件不满足都在写入之前返回，因此失败不会留下半完成的数据。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT`），
 * 上层的 service 与接口一行都不用改。
 *
 * ⚠️ 幂等重放判定与审计写入来自 `./adminWriteSupport`（与商品目录事务共用同一套实现），
 * 理由见那个文件：两个模块各写一份的话，「同一个幂等键第二次到达会怎样」
 * 迟早会有两种答案，而这类差异只在并发或重试时才会暴露。
 */

/** 写上下文由 `./adminWriteSupport` 定义；这里再导出一次，调用方的既有引用不用改。 */
export type { AdminWriteContext };

/** 申请类写操作失败的三种情形。文案由服务层翻译，数据层不产生界面文案。 */
export type AdminApplicationWriteFailure =
  /** 目标不存在 */
  | { kind: "not-found" }
  /** 状态机不允许这次迁移，携带当前状态 */
  | { kind: "invalid-transition"; status: CompanionApplicationStatus }
  /**
   * 这个幂等键已经被**另一个对象**用过。
   *
   * 客户端复用了幂等键属于调用方的 bug；此时安静地重放会返回另一个对象的操作结果，
   * 比报错危险得多。因此单独分出来，由服务层转成一个明确的 400。
   */
  | { kind: "operation-conflict" };

export type AdminApplicationWriteResult<T> =
  | {
      kind: "ok";
      value: T;
      /** 这一次是否真的改动了数据 */
      changed: boolean;
      /** 是否是幂等重放（同一个幂等键第二次到达） */
      replayed: boolean;
    }
  | AdminApplicationWriteFailure;

/** 护航类写操作失败的情形。 */
export type AdminCompanionWriteFailure =
  | { kind: "not-found" }
  /** 已移除的记录不能再编辑或停用：它已经不在名单里了 */
  | { kind: "removed" }
  /** 已停用的记录谈不上「暂停 / 恢复接单」——那两个动作的前提是它还在架上 */
  | { kind: "disabled" }
  | { kind: "operation-conflict" }
  /**
   * 停用时要解除的订单数据不自洽（P0-11）：派单记录缺失，或完成材料的 pending
   * 索引与记录对不上。**不可能状态**，报 500。
   *
   * ⚠️ 它是唯一一种「停用没做成」的原因，而**停用本身也一笔没写**——
   * 扫单排在改标志位之前，正是为了不留下「人已停用、单还挂在他名下」
   * （EX-COMP-01 要禁止的那一瞬）。管理员重试即可。
   */
  | { kind: "inconsistent" };

export type AdminCompanionWriteResult =
  | {
      kind: "ok";
      value: { previous: Companion; updated: Companion; action: AdminAuditAction };
      changed: boolean;
      replayed: boolean;
    }
  | AdminCompanionWriteFailure;

/** 审核通过的结果：四样写入里产生的（或复用的）那几样。 */
export type ApproveApplicationOutcome = {
  application: CompanionApplication;
  companion: Companion;
  qualification: UserQualificationRecord;
  /** 这次是新建了护航资料，还是复用了这位用户已有的那一条 */
  companionCreated: boolean;
  /** 这次是新发的资格，还是本来就有的 */
  qualificationGranted: boolean;
};

// ——————————————————————————— 内部工具 ———————————————————————————

/** 「更新前 / 更新后」的两个快照一起写，避免某个操作只写了一半。 */
function applicationSnapshots(
  previous: CompanionApplication,
  updated: CompanionApplication,
): { before: AdminAuditSnapshot; after: AdminAuditSnapshot } {
  return {
    before: toCompanionApplicationAuditSnapshot(previous),
    after: toCompanionApplicationAuditSnapshot(updated),
  };
}

// ——————————————————————————— 开始审核 ———————————————————————————

/**
 * 开始审核：`pending → reviewing`。
 *
 * ⚠️ **只改状态**。开始审核不等于通过：不产生护航资料、不发资格、不写审核时间
 * （那两者是「结果」，这一步还没有结果）。
 */
export async function startReviewCompanionApplication(
  applicationId: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<CompanionApplication>> {
  const applications = companionApplicationStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companionApplication", applicationId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = applications.applications.get(applicationId);
  if (!existing) return { kind: "not-found" };

  // 重放：这个键已经成功过一次，原样返回当前状态，**不再写任何东西**
  if (replay?.kind === "replay") {
    return { kind: "ok", value: { ...existing }, changed: false, replayed: true };
  }

  if (!canTransitionCompanionApplication(existing.status, "reviewing")) {
    return { kind: "invalid-transition", status: existing.status };
  }

  const written = applyApplicationReview(applicationId, "reviewing", {
    at: ctx.at,
    reviewNote: existing.reviewNote,
  });
  // 上面刚确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "application.start-review",
    targetType: "companionApplication",
    targetId: applicationId,
    ...applicationSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written.updated, changed: true, replayed: false };
}

// ——————————————————————————— 拒绝 ———————————————————————————

/**
 * 拒绝：`pending | reviewing → rejected`。
 *
 * ⚠️ **不产生护航资料、不发资格**（§十二 明确要求「拒绝不产生护航」）。
 * 审核意见由调用方校验为非空之后传进来（规则在
 * `lib/constants/adminApplications.ts` 的 `normalizeAdminReviewNote()`）。
 */
export async function rejectCompanionApplication(
  applicationId: string,
  reviewNote: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<CompanionApplication>> {
  const applications = companionApplicationStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companionApplication", applicationId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = applications.applications.get(applicationId);
  if (!existing) return { kind: "not-found" };

  if (replay?.kind === "replay") {
    return { kind: "ok", value: { ...existing }, changed: false, replayed: true };
  }

  if (!canTransitionCompanionApplication(existing.status, "rejected")) {
    return { kind: "invalid-transition", status: existing.status };
  }

  const written = applyApplicationReview(applicationId, "rejected", {
    at: ctx.at,
    reviewNote,
  });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "application.reject",
    targetType: "companionApplication",
    targetId: applicationId,
    ...applicationSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written.updated, changed: true, replayed: false };
}

// ——————————————————————————— 通过（§七 的核心） ———————————————————————————

/**
 * 生成一条**不会与既有记录冲突**的护航 id。
 *
 * 预置陪玩用的是 `cp-1` … `cp-9` 这样的短 id，审核产生的记录用 `cp_` 前缀
 * （下划线而不是连字符），从取值域上就分开；再加一次存在性检查，
 * 「新护航覆盖掉一条预置记录」因此不是「大概不会发生」，而是写不出来。
 *
 * ⚠️ 这段循环必须在原子区段内：`crypto.randomUUID()` 是同步的，
 * 取 id 与写入之间没有让出执行权的机会。
 */
function nextCompanionId(companions: Map<string, Companion>): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `cp_${crypto.randomUUID()}`;
    if (!companions.has(id)) return id;
  }
  // 连撞五次在现实中不会发生；真发生也只能说明随机源坏了，此时**宁可失败**，
  // 也不能返回一个可能覆盖既有记录的 id
  throw new Error("无法生成不冲突的护航 id");
}

/** 由被通过的申请构造一条新护航资料。字段来源见 §七：昵称 / 游戏 / 大区 / 标签 / 介绍全部来自申请。 */
function buildCompanionFromApplication(input: {
  application: CompanionApplication;
  id: string;
  sortOrder: number;
}): Companion {
  const { application } = input;

  return {
    id: input.id,
    userId: application.userId,
    applicationId: application.id,
    removedAt: null,

    displayName: application.displayName,
    // 头像用白名单里的默认占位图：申请里的「凭证」是审核材料，不是门面图
    avatarUrl: NEW_COMPANION_AVATAR_URL,
    rankLabel: NEW_COMPANION_RANK_LABEL,
    intro: application.introduction,
    gameIds: [...application.gameIds],
    regions: [...application.regions],
    serviceTags: [...application.serviceTags],

    // 新护航一律「启用但不可接单」：资料刚建出来，可接单安排还没人确认过
    available: false,
    unavailableReason: NEW_COMPANION_UNAVAILABLE_REASON,
    enabled: true,

    // 统计从零开始，**不继承任何东西**：没有订单、没有评价、没有鸡腿。
    // `rating` 用 null 而不是 0：0 分与「暂无评分」是两件事。
    completedOrderCount: 0,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,

    sortOrder: input.sortOrder,
    reviews: [],
  };
}

/**
 * 审核通过 —— 四件事在**同一段无 `await` 的同步区段**里完成（§七）：
 *
 * 1. 申请状态改成 `approved`，写审核时间；
 * 2. 给申请人**追加**一条护航资格（不动 `UserRecord`，老板身份一点不变）；
 * 3. 创建**或关联**唯一的护航资料（一位用户最多一条有效护航）；
 * 4. 写审计记录。
 *
 * 重复或并发通过时：申请已经是终态 → 第二次数落回 `invalid-transition`；
 * 即使绕过状态机，第 3 步的索引也只会让它复用同一条记录，
 * 第 2 步的 `(userId, role)` 键同样只会发一次。**三条数据都只有一份。**
 */
export async function approveCompanionApplication(
  applicationId: string,
  ctx: AdminWriteContext,
): Promise<AdminApplicationWriteResult<ApproveApplicationOutcome>> {
  const applications = companionApplicationStore();
  const companions = companionStore();
  const qualifications = qualificationStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companionApplication", applicationId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = applications.applications.get(applicationId);
  if (!existing) return { kind: "not-found" };

  if (replay?.kind === "replay") {
    // 重放：把这一次操作当时产生的护航资料找回来（靠申请 id 反查），
    // 找不到就退回申请人当前关联的那一条；两者都没有说明数据被清过，
    // 此时按「找不到」返回，而不是编一条出来
    const linked = findCompanionOfApplication(companions.companions, applicationId);
    const qualification = qualifications.qualifications.get(`${existing.userId}:companion`) ?? null;

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

  // ① 申请状态
  const written = applyApplicationReview(applicationId, "approved", {
    at: ctx.at,
    // 通过不需要理由。保留既有备注（正常情况下是空串），不编一句「审核通过」进去
    reviewNote: existing.reviewNote,
  });
  if (!written) return { kind: "not-found" };

  // ② 资格。**已经有一条就复用**，不覆盖发放时间与发放人——
  //    重复通过时，「谁在什么时候批的」应当指向第一次
  const existingQualification = findQualificationRecord(existing.userId, "companion");

  // ③ 护航资料。先看这位用户有没有有效记录：有就复用，没有才新建
  const companionId = existingQualification?.companionId ?? nextCompanionId(companions.companions);
  const created = createCompanionRecord(
    buildCompanionFromApplication({
      application: existing,
      id: companionId,
      sortOrder: nextSortOrder(companions.companions),
    }),
  );

  const qualification: UserQualificationRecord = existingQualification ?? {
    userId: existing.userId,
    role: "companion",
    companionId: created.companion.id,
    applicationId: existing.id,
    grantedAt: ctx.at,
    grantedByAdminId: ctx.actorId,
  };
  const granted = grantQualificationRecord(qualification);

  // ④ 审计。业务写入全部完成之后紧接着写，中间没有任何 `await`
  writeAudit({
    ctx,
    action: "application.approve",
    targetType: "companionApplication",
    targetId: applicationId,
    ...applicationSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: {
      application: written.updated,
      companion: created.companion,
      qualification,
      companionCreated: created.kind === "created",
      qualificationGranted: granted.created,
    },
    changed: true,
    replayed: false,
  };
}

/** 按申请 id 反查它产生的护航资料。 */
function findCompanionOfApplication(
  companions: Map<string, Companion>,
  applicationId: string,
): Companion | null {
  for (const companion of companions.values()) {
    if (companion.applicationId === applicationId) return { ...companion };
  }
  return null;
}

/** 新记录排到最后：`max(sortOrder) + 10`。空名单时从 10 开始，与预置数据的步长一致。 */
function nextSortOrder(companions: Map<string, Companion>): number {
  let max = 0;
  for (const companion of companions.values()) {
    if (companion.sortOrder > max) max = companion.sortOrder;
  }
  return max + 10;
}

// ——————————————————————————— 护航编辑 / 状态变更 ———————————————————————————

/**
 * 编辑护航资料（含暂停 / 恢复 / 启用 / 停用）。
 *
 * 五种后台动作走的是**同一个写入路径**：它们都只是在改同一组字段，
 * 区别只在改了什么。审计动作由 `adminCompanionActionFromPatch()` 从差异推导，
 * 因此「停用」不管来自 `PATCH` 还是 `POST /disable`，记的都是同一件事。
 *
 * 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**：
 * - 幂等重放（同一个幂等键第二次到达）；
 * - 本来就是这个状态（用另一个键再停用一次）。
 * 这条规则让「每项写操作有且只有一条审计」多按几次之后依然成立。
 */
export async function updateCompanionProfile(
  companionId: string,
  patch: AdminCompanionProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  const companions = companionStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companion", companionId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = companions.companions.get(companionId);
  if (!existing) return { kind: "not-found" };
  // 已移除的记录不再接受编辑：它已经不在名单里，改资料没有任何去向
  if (existing.removedAt !== null) return { kind: "removed" };

  const action = adminCompanionActionFromPatch(existing, patch);

  if (replay?.kind === "replay" || isCompanionProfileUnchanged(existing, patch)) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyCompanionPatch(companionId, patch);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "companion",
    targetId: companionId,
    before: toCompanionAuditSnapshot(written.previous),
    after: toCompanionAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

/**
 * 只改「能不能接单」的四个动作：暂停 / 恢复 / 启用 / 停用。
 *
 * 与 `updateCompanionProfile()` 分开，是因为它们**不该碰资料字段**：
 * 暂停接单只是把 `available` 关掉，昵称、介绍、排序一个都不该被写一遍。
 * 如果这里改成「先读出来、拼一个完整 patch 再调用编辑」，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的昵称覆盖回旧值。
 *
 * 四条规则（§八）：
 * - **暂停接单**：仍然启用（`enabled: true`）、公开详情可见，只是结算时不可选。必须有原因；
 * - **恢复接单**：`available: true`，原因清空——能接单了就不该再留着「休息中」；
 * - **启用**：`enabled: true`，**不动**可接单状态（回到名单不等于马上能接单）；
 * - **停用**：`enabled: false` 并强制 `available: false`（下架的记录不可能正在接单）。
 */
export async function setCompanionFlags(
  companionId: string,
  intent: CompanionFlagIntent,
  input: { unavailableReason: string },
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  const companions = companionStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companion", companionId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = companions.companions.get(companionId);
  if (!existing) return { kind: "not-found" };
  if (existing.removedAt !== null) return { kind: "removed" };
  if (!existing.enabled && (intent === "pause" || intent === "resume")) {
    return { kind: "disabled" };
  }

  const flags = nextFlags(existing, intent, input);
  const action = companionFlagAction(intent);

  if (replay?.kind === "replay" || areFlagsUnchanged(existing, flags)) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  /* —— 第 5 步：**停用**还要立刻解除他手上在履约的订单（P0-11 / EX-COMP-01）—— */
  // ⚠️ 排在 `applyCompanionFlags` **之前**：扫单可能失败（数据不自洽），
  // 而失败时不能留下「人已停用、订单还挂在他名下」——那正是 EX-COMP-01 要禁止的那一瞬。
  // 排在这里，失败时标志位与审计都还没写，管理员重试即可；
  // 反过来（先改标志位再扫单）就只能二选一：报一个已经发生了一半的失败，或者假装成功。
  //
  // ⚠️ 只有 `disable` 会扫：暂停 / 恢复 / 启用都不解除任何履约
  // （`available = false` 不解除已有订单，EX-SERVICE-05；`enable` 只是回到名单）。
  // 「移除」（`removeCompanion`）本轮**不做**解除——需求里没有那一条，见 D10。
  if (intent === "disable") {
    const released = releaseOrdersForCompanion({
      companionId,
      // 触发者是这位管理员，写进每条退出历史的 actorId
      actorId: ctx.actorId,
      reason: COMPANION_RELEASE_REASON_DISABLED,
      at: ctx.at,
    });
    if (released.kind !== "ok") return { kind: "inconsistent" };
  }

  const written = applyCompanionFlags(companionId, flags);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "companion",
    targetId: companionId,
    before: toCompanionAuditSnapshot(written.previous),
    after: toCompanionAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written, action }, changed: true, replayed: false };
}

/** 一次「能不能接单」动作。与审计动作一一对应，不经过差异推导。 */
export type CompanionFlagIntent = "pause" | "resume" | "enable" | "disable";

function companionFlagAction(intent: CompanionFlagIntent): AdminAuditAction {
  switch (intent) {
    case "pause":
      return "companion.pause";
    case "resume":
      return "companion.resume";
    case "enable":
      return "companion.enable";
    default:
      return "companion.disable";
  }
}

/** 目标状态：只算这三个字段，其余一概不碰。 */
function nextFlags(
  existing: Companion,
  intent: CompanionFlagIntent,
  input: { unavailableReason: string },
): { enabled: boolean; available: boolean; unavailableReason: string } {
  switch (intent) {
    case "pause":
      return { enabled: true, available: false, unavailableReason: input.unavailableReason };
    case "resume":
      return { enabled: true, available: true, unavailableReason: "" };
    case "disable":
      // 下架强制不可接单：一条「已停用但可接单」的记录在结算页会解释不清
      return { enabled: false, available: false, unavailableReason: existing.unavailableReason };
    default:
      return {
        enabled: true,
        available: existing.available,
        unavailableReason: existing.unavailableReason,
      };
  }
}

function areFlagsUnchanged(
  existing: Companion,
  flags: { enabled: boolean; available: boolean; unavailableReason: string },
): boolean {
  return (
    existing.enabled === flags.enabled &&
    existing.available === flags.available &&
    existing.unavailableReason === flags.unavailableReason
  );
}

/**
 * 移除护航（软删除）。
 *
 * ⚠️ **不删除记录**：只写 `removedAt`。历史订单、评价与鸡腿记录都要继续指得到它，
 * 硬删除会让「这位护航以前做过什么」永久消失，而管理后台正是要回答这个问题。
 */
export async function removeCompanion(
  companionId: string,
  ctx: AdminWriteContext,
): Promise<AdminCompanionWriteResult> {
  const companions = companionStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "companion", companionId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = companions.companions.get(companionId);
  if (!existing) return { kind: "not-found" };

  // 已经移除了：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误
  if (replay?.kind === "replay" || existing.removedAt !== null) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action: "companion.remove" },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyCompanionRemoval(companionId, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "companion.remove",
    targetType: "companion",
    targetId: companionId,
    before: toCompanionAuditSnapshot(written.previous),
    after: toCompanionAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { ...written, action: "companion.remove" },
    changed: true,
    replayed: false,
  };
}
