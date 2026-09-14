import type { ActorRole } from "@/lib/types/actor";
import type { AdminAuditAction, AdminAuditEntry, AdminAuditSnapshot } from "@/lib/types/adminAudit";
import { appendAuditEntry, findAuditEntryByOperationId } from "./mockAdminAuditRepository";

/**
 * 后台写操作的公共零件：**写上下文、幂等重放判定、审计写入**。
 *
 * ⚠️ 本文件里的几个函数都是**同步**的，而且只允许在调用方的原子区段内被调用。
 * 它们被单独抽出来，是因为护航（P8A）、商品目录（P8B）、退款投诉（P8C）三组伪事务，
 * 以及 P8D-2 起客服侧对退款投诉的写入，需要**同一套**幂等与审计规则：
 * 各写一份的话，「同一个幂等键第二次到达会怎样」在几个模块里迟早会有几种答案，
 * 而这类差异只在并发或重试时才会暴露。
 *
 * ⚠️ 这里出现 `await` 就是 bug：调用方的原子区段靠「没有让出执行权的时刻」成立，
 * 哪怕加一个 `await Promise.resolve()` 都会让它失效。
 *
 * ⚠️ **本文件不判断调用者是谁**：它只忠实地把 `ctx` 里的身份写进审计。
 * 「ctx 从哪来」是服务层的事，而服务层只能从 `requireAdmin()` / `requireStaff()`
 * 返回的会话里拼——请求体里的 actor 字段在这里没有任何进入路径。
 */

/** 一次后台写操作的上下文。`operationId` 就是请求的幂等键（见 §九）。 */
export type AdminWriteContext = {
  /** 执行操作的账号 id：管理员是 `AdminAccount.id`，客服是 `StaffAccount.id` */
  actorId: string;
  /** 执行操作的账号类型。与 `actorId` 一起构成操作者的完整身份 */
  actorRole: ActorRole;
  /** 操作者当时的显示名称快照；管理员侧本阶段为 null（理由见 `lib/types/adminAudit.ts`） */
  actorName: string | null;
  /** 幂等键：同一次操作意图重复到达时用它认出「已经做过了」 */
  operationId: string;
  /** 服务端时间戳（ISO 字符串），业务写入与审计写入共用同一个 */
  at: string;
};

/**
 * 幂等键归属判定的最小输入：**谁**、带着**哪个键**。
 *
 * ⚠️ 单独抽出来而不是直接收整个 `AdminWriteContext`，是因为判断「这个键属于谁」
 * 只需要这两样——时间戳与名称快照都无关。收窄之后，将来给 `ctx` 加字段
 * 不会顺带改变这里的行为。
 */
export type ActorScope = Pick<AdminWriteContext, "actorId" | "actorRole" | "operationId">;

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
 * 返回 `conflict` 表示用过但**不是同一个操作者、或不是同一个对象**。
 *
 * ⚠️ 必须在**读写业务数据之前**调用，因此它自己也只做同步读。
 *
 * ## 为什么幂等键要按操作者收窄（P8D-2 新增）
 *
 * 幂等键是「调用方为了让同一次意图不重复生效而自己生成的一个串」，它的取值域
 * **天然属于生成它的那一方**。P8C 之前只有管理员会写这张表，这一点看不出来；
 * P8D-2 起客服也能写同一批记录，于是出现这样一条真实路径：
 *
 * 1. 客服带着键 `K` 驳回退款 `R`，审计写下 `K → (refund, R)`；
 * 2. 管理员随后带着**同一个** `K` 请求通过退款 `R`；
 * 3. 若只比对 `(targetType, targetId)`，第 2 步会被判成「重放」，
 *    于是服务端**什么都不做**却回一个 200——管理员以为通过了，实际上没有。
 *
 * 这比报错危险得多：调用方拿到的是一个与事实相反的成功。收窄到操作者之后，
 * 第 2 步落进 `conflict`，服务层转成明确的 400，管理员会重新生成一个键再提交。
 */
export function takeReplay(
  actor: ActorScope,
  targetType: AdminAuditEntry["targetType"],
  targetId: string,
): { kind: "replay"; entry: AdminAuditEntry } | { kind: "conflict" } | null {
  const entry = findAuditEntryByOperationId(actor.operationId);
  if (!entry) return null;

  if (entry.targetType !== targetType || entry.targetId !== targetId) return { kind: "conflict" };
  if (!isSameActor(entry, actor)) return { kind: "conflict" };
  return { kind: "replay", entry };
}

/**
 * 审计记录里的操作者与当前调用者是不是同一个人。
 *
 * 两个字段都要比对：只比 `actorId` 的话，「管理员改的」与「客服改的」会在
 * 恰好同名的 id 上混起来（今天不可能，但幂等键的收窄不该建立在这种巧合上）。
 */
function isSameActor(entry: AdminAuditEntry, actor: ActorScope): boolean {
  return entry.actorId === actor.actorId && entry.actorRole === actor.actorRole;
}

/**
 * 重放的**意图**校验（P8D-2 新增）。
 *
 * `takeReplay` 的收窄只有「操作者 × 目标」两轴。对**状态迁移**类操作来说这还不够：
 * 同一个目标在同一个状态下往往有多个合法意图，于是出现这样一条真实路径：
 *
 * 1. 客服带着键 `K` 开始审核退款 `R`（成功，审计写下 `K → refund.start-review`）；
 * 2. 同一位客服又带着**同一个** `K` 驳回 `R`；
 * 3. target 与 actor 都匹配 → 被判成「重放」→ 服务端**什么都不做**却回 200，
 *    退款停在「审核中」，而客服以为自己已经驳回了。
 *
 * 这和 `takeReplay` 注释里说的「与事实相反的成功」是同一件事，只不过发生在同一个人身上。
 * 因此对这几个动作再收一轴：**同一个键必须指向同一个意图**。
 *
 * ⚠️ **只用于「意图在读到记录之前就已确定」的迁移类动作**（退款的三个、投诉的三个）。
 * 编辑类动作（`category.update` / `product.update` / `companion.update`）**不适用**：
 * 它们的动作名是由「改动前后的差异」算出来的，第一次写入之后差异就没有了，
 * 第二次到达时算出的动作名本来就不同——在那里比对会把**合法的重放**误判成冲突。
 * 这是本函数单独存在、而不是把参数加进 `takeReplay` 的唯一理由：
 * 一条「有时生效」的规则，迟早会在不同模块里得到不同的解释。
 */
export function takeReplayForAction(
  actor: ActorScope,
  action: AdminAuditAction,
  targetType: AdminAuditEntry["targetType"],
  targetId: string,
): ReturnType<typeof takeReplay> {
  const outcome = takeReplay(actor, targetType, targetId);
  // 键用在了同一个对象的另一个意图上：这是调用方复用了键，不是重放。
  // 归进 conflict 而不是 replay——安静地返回「已处理」会让调用方拿到与事实相反的结果。
  if (outcome?.kind === "replay" && outcome.entry.action !== action) return { kind: "conflict" };
  return outcome;
}

/**
 * 幂等重放检查（**新建**类写操作）。
 *
 * 新建时还不知道目标 id——它要在原子区段里当场生成，因此「重放」不能靠比对 id 认出来，
 * 只能靠「这个键已经被同一个类型的对象用过」来判定，再拿审计里记的 `targetId`
 * 把当时建出来的那条记录找回来。这样同一个键第二次到达时返回的是**第一次的结果**，
 * 而不是又建一条。
 *
 * 目标类型不同、或操作者不同，返回 `conflict`（理由与 `takeReplay` 同）。
 */
export function takeCreateReplay(
  actor: ActorScope,
  targetType: AdminAuditEntry["targetType"],
): { kind: "replay"; targetId: string } | { kind: "conflict" } | null {
  const entry = findAuditEntryByOperationId(actor.operationId);
  if (!entry) return null;

  if (entry.targetType !== targetType || !isSameActor(entry, actor)) return { kind: "conflict" };
  return { kind: "replay", targetId: entry.targetId };
}

/**
 * 写一条审计。同步，且**必须**在调用方的原子区段内被调用。
 *
 * 「业务写成功、审计没写进去」这种缺失事后无法补救——没有人知道当时到底发生了什么，
 * 因此两者必须同生共死。
 *
 * ⚠️ 操作者的三个字段**只从 `ctx` 来**。本函数不认识会话、不认识请求体，
 * 也不接受任何「override 一下 actor」的参数——调用方想让客服冒充管理员，
 * 唯一的路是伪造一个 `ctx`，而 `ctx` 由服务层从守卫返回的会话拼装，
 * 那条路要走通得先改掉 `requireStaff()`。
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
    actorId: input.ctx.actorId,
    actorRole: input.ctx.actorRole,
    actorName: input.ctx.actorName,
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
