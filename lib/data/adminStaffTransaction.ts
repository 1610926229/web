import { type AdminStaffProfileInput, isStaffProfileUnchanged } from "@/lib/constants/adminStaff";
import { toStaffAuditSnapshot } from "@/lib/constants/adminAudit";
import type { StaffAccount } from "@/lib/types/staff";
import {
  nextRecordId,
  takeCreateReplay,
  takeReplay,
  writeAudit,
  type AdminWriteContext,
} from "./adminWriteSupport";
import {
  applyStaffFlags,
  applyStaffPatch,
  createStaffRecord,
  findStaffWithUsername,
  staffStore,
} from "./mockStaffRepository";

/**
 * 客服账号管理写操作的**伪事务** —— 后台新增 / 编辑 / 启用 / 停用 / 移除的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * 两件事必须同时成立：
 *
 * 1. **唯一性**——「先查有没有同名账号，再写入」中间只要让出一次执行权，
 *    两个同时到达的「新增 kefu-xiaoyu」就会双双通过检查、写下两条同名记录；
 * 2. **审计恰好一次**——业务写入与审计写入同生共死，事后补不回来。
 *
 * 仓库里没有事务可用，于是这里用与护航 / 商品目录完全相同的那件事替代：
 * **把读—判断—写的全过程放进一段没有 `await` 的同步代码**。
 * Node 是单线程的，同步区段一旦开始就会跑完（`await` 才是让出执行权的唯一时刻），
 * 因此这段代码在并发下与真事务等价。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。`async` 只是为了让调用方不必区分
 * 「同步的伪事务」与「将来真正的异步数据库事务」。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的 Map 会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * ⚠️ 幂等重放判定与审计写入来自 `./adminWriteSupport`（与护航、商品目录、订单共用同一套
 * 实现）：各写一份的话，「同一个幂等键第二次到达会怎样」迟早会有两种答案，
 * 而这类差异只在并发或重试时才会暴露。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + 唯一索引兜底），
 * 上层的 service 与接口一行都不用改。
 */

/** 写上下文由 `./adminWriteSupport` 定义；这里再导出一次，调用方的既有引用不用改。 */
export type { AdminWriteContext };

/**
 * 客服账号写操作失败的四种情形。文案由服务层翻译，数据层不产生界面文案。
 */
export type AdminStaffWriteFailure =
  /** 目标不存在 */
  | { kind: "not-found" }
  /** 已移除的记录不能再编辑或改变状态：它已经不在名单里了 */
  | { kind: "removed" }
  /**
   * 登录名被**另一个**账号占用（大小写不敏感）。
   *
   * ⚠️ 这个判断必须在本文件的原子区段里做，不能在服务层「先查一次再调用」：
   * 那样两个并发的新增请求会双双通过检查。服务层也会查一次，但那是为了给表单
   * 逐字段报错，**不是**唯一性的依据。
   */
  | { kind: "username-taken" }
  /**
   * 这个幂等键已经被**另一个对象**用过。
   *
   * 客户端复用了幂等键属于调用方的 bug；此时安静地重放会返回另一个对象的操作结果，
   * 比报错危险得多。因此单独分出来，由服务层转成一个明确的 400。
   */
  | { kind: "operation-conflict" };

export type AdminStaffWriteResult =
  | {
      kind: "ok";
      value: StaffAccount;
      /** 这一次是否真的改动了数据 */
      changed: boolean;
      /** 是否是幂等重放（同一个幂等键第二次到达） */
      replayed: boolean;
    }
  | AdminStaffWriteFailure;

/** 「更新前 / 更新后」的两个快照一起写，避免某个操作只写了一半。 */
function staffSnapshots(
  previous: StaffAccount,
  updated: StaffAccount,
): { before: ReturnType<typeof toStaffAuditSnapshot>; after: ReturnType<typeof toStaffAuditSnapshot> } {
  return {
    before: toStaffAuditSnapshot(previous),
    after: toStaffAuditSnapshot(updated),
  };
}

/** 什么都没发生的返回。三种「空操作」共用，保证形状一致。 */
function unchanged(account: StaffAccount, replayed: boolean): AdminStaffWriteResult {
  return { kind: "ok", value: { ...account }, changed: false, replayed };
}

// ——————————————————————————— 新增 ———————————————————————————

/**
 * 新增一个客服账号。
 *
 * 四条规则：
 *
 * 1. **角色写死为 `customer_service`**。`AdminStaffProfileInput` 里根本没有 `role` 字段，
 *    请求体里塞 `role: "admin"` 或 `role: "companion"` 没有可以落脚的地方——
 *    这不是「校验之后拒绝」，而是「压根读不到」。
 * 2. **登录名大小写不敏感唯一**，判断在原子区段内完成（见上面的 `username-taken`）。
 * 3. **新账号是启用状态、未移除**：新建一个不能用的账号没有意义；
 *    真要收回权限，停用与移除是两个明确的动作，各自写自己的审计。
 * 4. **不产生密码**：记录里没有密码字段，也没有「初始密码」。本阶段是 Mock 认证。
 */
export async function createStaffAccount(
  input: AdminStaffProfileInput,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  const staff = staffStore();

  // —— 原子区段开始（无 await）——
  const replay = takeCreateReplay(ctx.operationId, "staff");
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  // 重放：这个键已经成功过一次，把当时建出来的那条找回来，**不再写任何东西**。
  // 目标被清掉（预置数据被重置）时按「找不到」返回，而不是再建一条——
  // 同一个幂等键两次到达必须给出同一个结果，第二次悄悄建一条新的恰恰是最坏的那种。
  if (replay?.kind === "replay") {
    const existing = staff.staff.get(replay.targetId);
    if (!existing) return { kind: "not-found" };
    return unchanged(existing, true);
  }

  if (findStaffWithUsername(staff.staff, input.username)) return { kind: "username-taken" };

  const account: StaffAccount = {
    id: nextRecordId("staff_", (candidate) => staff.staff.has(candidate), "客服账号"),
    username: input.username.trim(),
    displayName: input.displayName.trim(),
    avatarUrl: input.avatarUrl.trim(),
    role: "customer_service",
    enabled: true,
    createdAt: ctx.at,
    updatedAt: ctx.at,
    // 新账号从没登录过。用 null 而不是 0 或空串：「没登录过」与「很久以前登录过」是两件事
    lastLoginAt: null,
    removedAt: null,
  };
  createStaffRecord(account);

  writeAudit({
    ctx,
    action: "staff.create",
    targetType: "staff",
    targetId: account.id,
    before: null,
    after: toStaffAuditSnapshot(account),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...account }, changed: true, replayed: false };
}

// ——————————————————————————— 编辑 ———————————————————————————

/**
 * 编辑客服账号的资料（登录名 / 名称 / 头像）。
 *
 * ⚠️ **不碰状态**：`enabled` 与 `removedAt` 只能走 `setStaffEnabled()` /
 * `removeStaffAccount()`。「编辑时顺手把状态也写一遍」两位管理员同时操作时，
 * 后写的那次会把另一位刚停用的账号重新启用。
 *
 * 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**：
 * - 幂等重放（同一个幂等键第二次到达）；
 * - 三个字段与当前值完全一致（用另一个键再保存一次）。
 */
export async function updateStaffProfile(
  id: string,
  input: AdminStaffProfileInput,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  const staff = staffStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "staff", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = staff.staff.get(id);
  if (!existing) return { kind: "not-found" };
  // 已移除的记录不再接受编辑：它已经不在名单里，改资料没有任何去向
  if (existing.removedAt !== null) return { kind: "removed" };

  // 唯一性：`exceptId` 排除自己，否则「只改名称、登录名不动」会被自己挡住
  if (findStaffWithUsername(staff.staff, input.username, id)) return { kind: "username-taken" };

  if (replay?.kind === "replay" || isStaffProfileUnchanged(existing, input)) {
    return unchanged(existing, replay?.kind === "replay");
  }

  const written = applyStaffPatch(id, {
    username: input.username.trim(),
    displayName: input.displayName.trim(),
    avatarUrl: input.avatarUrl.trim(),
    updatedAt: ctx.at,
  });
  // 上面刚确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "staff.update",
    targetType: "staff",
    targetId: id,
    ...staffSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
}

// ——————————————————————————— 启用 / 停用 ———————————————————————————

/**
 * 启用或停用一个客服账号。
 *
 * §二 的两条硬要求落在这一处：
 *
 * - **停用后立即失去客服工作台权限，现有会话 Cookie 也失效**。这里只改
 *   `enabled`；「旧 Cookie 立即失效」靠的是客服端**每个请求都重新查一次账号状态**
 *   （见 `lib/services/staffAuth.ts`），而不是靠这里去删什么会话表——
 *   没有会话表可删，本阶段是 Mock 认证。
 * - **重复停用不是错误**：已经停用了就不再写时间戳、不写第二条审计。
 *   这条规则让「每项写操作有且只有一条审计」多按几次之后依然成立。
 *
 * ⚠️ 已移除的账号不允许再启用：移除是软删除，不是可以来回拨的开关。
 * 要让一位已移除的客服重新上岗，请新建一个账号——这也让审计里
 * 「谁在什么时候被移除、谁在什么时候被新增」保持是两件独立的事。
 */
export async function setStaffEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  const staff = staffStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "staff", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = staff.staff.get(id);
  if (!existing) return { kind: "not-found" };
  if (existing.removedAt !== null) return { kind: "removed" };

  if (replay?.kind === "replay" || existing.enabled === enabled) {
    return unchanged(existing, replay?.kind === "replay");
  }

  const written = applyStaffFlags(id, {
    enabled,
    // 原样带回，不重新推导：状态变更不该顺手改写移除时间
    removedAt: existing.removedAt,
    updatedAt: ctx.at,
  });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: enabled ? "staff.enable" : "staff.disable",
    targetType: "staff",
    targetId: id,
    ...staffSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
}

// ——————————————————————————— 移除（软删除） ———————————————————————————

/**
 * 移除客服账号（**软删除**）。
 *
 * ⚠️ **不删除记录**：只写 `removedAt`，并把 `enabled` 一起置为 false。
 *
 * 两件事各有理由：
 *
 * - 不删记录，是因为**历史消息要保留**。客服发过的消息带着发送时的名称与头像快照
 *   （见 `lib/types/message.ts` 的 `senderAvatarUrl`），但账号本身也不能消失：
 *   后台要能筛出「已移除」的账号，回答「这条消息当时是谁发的」。
 *   硬删除会让这个问题永久无法回答，而它正是后台存在的意义之一。
 * - 顺手停用，是为了让「已移除的账号一定是停用的」成为**结构上的事实**，
 *   而不是靠每个读账号的地方都记得判 `removedAt !== null`。
 *   登录校验照样两个都判——结构保证与显式判断在这里不冲突，一个漏了另一个还在。
 *
 * 已经移除过：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误。
 */
export async function removeStaffAccount(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  const staff = staffStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "staff", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = staff.staff.get(id);
  if (!existing) return { kind: "not-found" };

  if (replay?.kind === "replay" || existing.removedAt !== null) {
    return unchanged(existing, replay?.kind === "replay");
  }

  const written = applyStaffFlags(id, {
    enabled: false,
    removedAt: ctx.at,
    updatedAt: ctx.at,
  });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action: "staff.remove",
    targetType: "staff",
    targetId: id,
    ...staffSnapshots(written.previous, written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
}
