import { bumpAgreementVersion } from "@/lib/constants/agreements";
import { toAgreementAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  agreementActionFromEnabled,
  isAgreementContentUnchanged,
} from "@/lib/constants/adminAgreements";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type { AdminAgreementProfilePatch, Agreement } from "@/lib/types/agreement";
import { agreementStore, cloneAgreement, cloneSections } from "./mockAgreementRepository";
import {
  takeReplay,
  writeAudit,
  type AdminWriteContext,
} from "./adminWriteSupport";

/**
 * 协议写操作的**伪事务** —— 本阶段所有协议正文与启用状态改动的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * 「重复或并发请求不得产生重复的改动或审计」这条要求横跨「协议记录」与「审计」
 * 两张表，仓库里没有事务可用，于是这里用一件事替代：**把读—判断—写的全过程
 * 放进一段没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「同一个幂等键保存协议」请求，第二个进来时第一个已经全部写完，
 * 它读到的是**已经存在**的审计记录，于是走重放路径而不是又改一次。
 * 同理，「读出现有版本号 → 算出新版本号 → 写回」中间不会被别人插一次写入，
 * 否则两个人同时保存会各自基于同一个旧版本号算出同一个新版本号。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。store 句柄在区段之外（函数开头）取好，
 * 区段内只做同步的读写。下面两个函数虽然声明成 `async`（调用方要 `await` 它们），
 * 但**函数体里一个 `await` 都没有**，从第一行到 `return` 之间不会让出执行权。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的 Map 会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + `operation_id`
 * 唯一索引），上层的 service 与接口一行都不用改。
 *
 * ## 与运营内容那份伪事务的三处不同
 *
 * 1. **没有 `create`，也没有 `remove`**：协议类型是固定枚举，每个类型有且只有一条
 *    记录，前台五个页签永远都在。因此本文件只有「编辑」与「启停」两个入口。
 * 2. **没有 `{ kind: "removed" }` 这条失败分支**：协议记录上没有 `removedAt`
 *    这个字段，也就没有「已移除」这个状态。宁可少一条用不到的分支，也不留一条
 *    永远不可达的——不可达的分支会让人以为「协议是可以被移除的」，而它不是。
 *    这也是本文件**不复用** `AdminWriteCommonFailure` 的原因：那个并集里带着
 *    `removed`，收下它就等于把这条不存在的状态写进了类型。
 * 3. **版本号在这里递增**：正文或标题真的变了就 `bumpAgreementVersion()`，
 *    只改启用状态则不动版本。判断与递增必须在同一个区段里完成。
 */

// ——————————————————————————— 类型 ———————————————————————————

export type { AdminWriteContext };

/**
 * 协议写操作共有的失败情形。
 *
 * ⚠️ **只有两种**（理由见文件头第 2 条）：目标不存在、幂等键用在了另一条协议上。
 * 协议没有「已移除」状态，因此没有 `removed`。
 */
export type AdminAgreementWriteFailure =
  | { kind: "not-found" }
  | { kind: "operation-conflict" };

/**
 * 一次写操作的结果。
 *
 * 三种「成功」刻意分开（与运营内容同一套口径）：
 * - `changed: true` —— 真的改了数据，也写了审计；
 * - `changed: false, replayed: false` —— **提交的内容与现状一模一样**，不写数据、
 *   不写审计、不动版本号、不动 `updatedAt`。这不是错误（管理员点了一次保存而没改
 *   任何东西），但接口要能告诉调用方「什么都没发生」，否则前端会显示一个「已保存」
 *   而实际没有写入；
 * - `changed: false, replayed: true` —— 同一个幂等键第二次到达。
 *
 * ⚠️ `previous` 不是 `null`（协议没有新建），但仍然放在 `value` 里与 `updated`
 * 成对出现：审计的 before/after 就是这两份，服务层与测试都按同一形状读。
 */
export type AdminAgreementWriteOutcome =
  | {
      kind: "ok";
      value: {
        previous: Agreement;
        updated: Agreement;
        action: AdminAuditAction;
      };
      changed: boolean;
      replayed: boolean;
    }
  | AdminAgreementWriteFailure;

// ——————————————————————————— 编辑 ———————————————————————————

/**
 * 编辑一份协议（标题 / 正文 / 启用状态一起提交）。
 *
 * 版本号的规则在这里、也只在这里：
 *
 * - **标题或正文真的变了** → `version = bumpAgreementVersion(previous.version)`；
 * - **只改了启用状态** → 版本号**不动**。启用状态不是正文的版本，
 *   「停用再启用」不该让用户端看到一个从未存在过的新版本；
 * - **什么都没改** → 不写数据、不写审计、不刷新 `updatedAt`，返回 `changed: false`。
 *
 * 审计动作按「启停优先」的口径选：一次同时改了正文又关掉启用的保存，
 * 记的是 `agreement.disable`——它回答的是「这份协议为什么从用户端消失了」，
 * 而那正是这次操作最要紧的后果。
 */
export async function updateAgreement(
  id: string,
  draft: AdminAgreementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminAgreementWriteOutcome> {
  // store 句柄在原子区段**之外**取好：取句柄本身是同步的，但它不该出现在
  // 「读—判断—写」之间，否则区段里就多了一处与业务无关的代码
  const store = agreementStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "agreement", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = store.agreements.get(id);
  if (!existing) return { kind: "not-found" };

  const contentChanged = !isAgreementContentUnchanged(existing, draft);
  const enabledChanged = existing.enabled !== draft.enabled;
  const action = agreementActionFromEnabled(existing.enabled, draft.enabled);

  // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**
  if (replay?.kind === "replay" || (!contentChanged && !enabledChanged)) {
    // 两份互不相关的副本，而不是同一个对象的两个别名：调用方改了 updated
    // 不该连带把 previous 也改掉
    return {
      kind: "ok",
      value: {
        previous: cloneAgreement(existing),
        updated: cloneAgreement(existing),
        action,
      },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const previous = cloneAgreement(existing);
  const next: Agreement = {
    id: existing.id,
    // 类型是记录的身份，**不属于可编辑字段**：改类型等于换了一份协议
    type: existing.type,
    title: draft.title,
    // 再复制一层：draft 是调用方手上的对象，它的段落数组不该被 store 引用
    sections: cloneSections(draft.sections),
    version: contentChanged ? bumpAgreementVersion(existing.version) : existing.version,
    updatedAt: ctx.at,
    enabled: draft.enabled,
  };
  store.agreements.set(id, next);

  writeAudit({
    ctx,
    action,
    targetType: "agreement",
    targetId: id,
    // ⚠️ 快照里**不含正文**：`toAgreementAuditSnapshot` 只记 sectionCount / paragraphCount。
    // 协议正文是几十段法律文本，把它抄进 before/after 等于每编辑一次就往审计表里
    // 存一份全文副本——审计表会以「正文的长度」而不是「操作的次数」增长。
    // 需要正文时去协议记录本身取；审计回答的是「哪一份、什么时候、被谁改了」。
    before: toAgreementAuditSnapshot(previous),
    after: toAgreementAuditSnapshot(next),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous, updated: cloneAgreement(next), action },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 启用 / 停用 ———————————————————————————

/**
 * 启用 / 停用（窄写入：只改这一个字段）。
 *
 * ⚠️ 与 `updateAgreement()` 分开，是因为它**不该碰标题与正文**：
 * 列表页上的启用开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的正文覆盖回旧值——
 * 而正文是几十段文本，那种覆盖是发现不了的。
 *
 * ⚠️ **这条路径不动 `version`**：启用状态不是正文的版本。
 *
 * 已经是目标状态时：不写数据、不写审计、**不刷新 `updatedAt`**，返回 `changed: false`。
 * 「点了一次已经启用的启用按钮」不该在记录上留下一次改动痕迹——那会让后台看到
 * 「最后修改时间刚刚变过」，也会让审计里多出一条什么都没改变的记录。
 */
export async function setAgreementEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminAgreementWriteOutcome> {
  const store = agreementStore();
  const action: AdminAuditAction = enabled ? "agreement.enable" : "agreement.disable";

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "agreement", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = store.agreements.get(id);
  if (!existing) return { kind: "not-found" };

  if (replay?.kind === "replay" || existing.enabled === enabled) {
    return {
      kind: "ok",
      value: {
        previous: cloneAgreement(existing),
        updated: cloneAgreement(existing),
        action,
      },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const previous = cloneAgreement(existing);
  // 只改这两个字段：版本号原样保留，其余字段一个都不动
  const next: Agreement = { ...previous, enabled, updatedAt: ctx.at };
  store.agreements.set(id, next);

  writeAudit({
    ctx,
    action,
    targetType: "agreement",
    targetId: id,
    before: toAgreementAuditSnapshot(previous),
    after: toAgreementAuditSnapshot(next),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous, updated: cloneAgreement(next), action },
    changed: true,
    replayed: false,
  };
}
