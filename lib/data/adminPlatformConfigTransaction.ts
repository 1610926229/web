import { toPlatformConfigAuditSnapshot } from "@/lib/constants/adminAudit";
import { PLATFORM_CONFIG_ID } from "@/lib/constants/platformConfig";
import type { PlatformConfig } from "@/lib/types/platformConfig";
import { takeReplay, writeAudit, type AdminWriteContext } from "./adminWriteSupport";
import {
  platformConfigStore,
  readPlatformConfig,
  writePlatformConfig,
} from "./mockPlatformConfigRepository";

/**
 * 平台参数写入的**伪事务** —— 本阶段修改平台参数的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * 「重复或并发请求不得产生重复的改动或审计」这条要求横跨「配置记录」与「审计」
 * 两张表，仓库里没有事务可用，于是这里用一件事替代：**把读—判断—写的全过程
 * 放进一段没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「同一个幂等键保存配置」请求，第二个进来时第一个已经全部写完，
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
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + `operation_id`
 * 唯一索引），上层的 service 与接口一行都不用改。
 *
 * ## 与协议那份伪事务的两处不同
 *
 * 1. **没有 `{ kind: "not-found" }`**：平台参数是**单例**，没有「这条记录不存在」
 *    这个状态——没有配置时读到的是预置值。宁可少一条用不到的分支，
 *    也不留一条永远不可达的。这也是本文件**不复用** `AdminWriteCommonFailure`
 *    的原因：那个并集里带着 `not-found` 与 `removed`，收下它们等于把
 *    「配置可能不存在」「配置可能被移除」这两条不存在的状态写进了类型。
 * 2. **没有 `removed`**：参数只有取值，没有上架 / 下架。
 *
 * ## 「什么都没改」为什么不算一次操作
 *
 * 管理员点了一次保存而值没变时，不写数据、不写审计、**不刷新 `updatedAt`**。
 * 「最后修改时间刚刚变过」是一个会被当作证据的字段——它一变，
 * 事后追查的人就会去找一次并不存在的改动。因此这里返回 `changed: false`，
 * 由接口把这个信息告诉调用方（不是错误，但也不是「已保存」）。
 */

// ——————————————————————————— 类型 ———————————————————————————

export type { AdminWriteContext };

/**
 * 一次平台参数写入的结果。
 *
 * 三种「成功」刻意分开（与本仓其它伪事务同一套口径）：
 * - `changed: true` —— 真的改了数据，也写了审计；
 * - `changed: false, replayed: false` —— **提交的值与现状一模一样**；
 * - `changed: false, replayed: true` —— 同一个幂等键第二次到达。
 *
 * 失败**只有一种**：这个幂等键已经被另一个操作者用过（理由见 `takeReplay` 的注释——
 * 安静地当成重放会返回一个与事实相反的成功）。
 */
export type AdminPlatformConfigWriteOutcome =
  | {
      kind: "ok";
      value: { previous: PlatformConfig; updated: PlatformConfig };
      changed: boolean;
      replayed: boolean;
    }
  | { kind: "operation-conflict" };

/**
 * 本模块能改的字段（**白名单**）。没有 `updatedAt` / `updatedByAdminId`：那两个由事务写。
 *
 * ⚠️ 三个字段都**可选**（PATCH 只带要改的那一项），但**至少一个**——空 PATCH 不算
 * 改动，这个「至少一个」由服务层校验（`PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE`）。
 * 事务层按「没带的字段保持现状」合并，而不是清空。
 */
export type PlatformConfigInput = {
  publicPoolTimeoutMinutes?: number;
  completionAutoApprovalMinutes?: number;
  complaintWindowMinutes?: number;
};

/**
 * 本模块能改的字段清单，**只用于「这次到底改没改」的判定**。
 *
 * ⚠️ 它存在的理由是让「加第四个参数时忘记更新判定」变成**编译错误**：
 * 类型是 `Record<keyof PlatformConfigInput, true>`，少写一个键就通不过 `tsc`。
 * 写成手写的 `next.x !== previous.x && next.y !== previous.y` 链则不会——
 * 那种写法漏掉一个字段时，改**只有那个字段**的请求会走进「值没变」分支，
 * 返回 `changed: false` 且**什么都不写**，管理员看到「未变化」而配置其实没保存。
 *
 * ⚠️ 合并（上面那个 `next` 字面量）不靠这份清单：`PlatformConfig` 的字段都是必填的，
 * 少写一个同样是编译错误。两边因此各有各的编译期保险，不依赖人的记性。
 */
const PATCHABLE_FIELDS: Record<keyof PlatformConfigInput, true> = {
  publicPoolTimeoutMinutes: true,
  completionAutoApprovalMinutes: true,
  complaintWindowMinutes: true,
};

// ——————————————————————————— 写入 ———————————————————————————

/**
 * 修改平台参数。
 *
 * ⚠️ `input` 里的值**由调用方保证已通过 `isValidPublicPoolTimeoutMinutes`**。
 * 本函数不做校验、更不做夹取：一个「顺手夹到合法范围」的实现会让一条本该被拒绝的
 * 2880 被静默改成 1440 写进去，调用方拿到「成功」而生效的是另一个数字。
 * 校验在服务层（`lib/services/adminPlatformConfig.ts`）。
 *
 * 操作者的身份**只从 `ctx` 来**，而 `ctx` 由服务层按 `requireAdmin()` 返回的会话拼装——
 * 请求体里的任何 actor 字段在这里没有进入路径。
 */
export async function updatePlatformConfig(
  input: PlatformConfigInput,
  ctx: AdminWriteContext,
): Promise<AdminPlatformConfigWriteOutcome> {
  // store 句柄在原子区段**之外**取好：取句柄本身是同步的，但它不该出现在
  // 「读—判断—写」之间，否则区段里就多了一处与业务无关的代码
  const store = platformConfigStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "platformConfig", PLATFORM_CONFIG_ID);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const previous = { ...store.config };

  // PATCH 合并：没带的字段保持现状，带了的字段用新值。合并结果就是「这次若写、会写成什么」。
  // 用展开 `...previous` 而不是逐字段列：三个字段的 `updatedAt` / `updatedByAdminId`
  // 覆盖写在后面，其余值原样带过来——将来加第四个参数时这里**不需要**改一行。
  const next: PlatformConfig = {
    ...previous,
    publicPoolTimeoutMinutes: input.publicPoolTimeoutMinutes ?? previous.publicPoolTimeoutMinutes,
    completionAutoApprovalMinutes:
      input.completionAutoApprovalMinutes ?? previous.completionAutoApprovalMinutes,
    complaintWindowMinutes: input.complaintWindowMinutes ?? previous.complaintWindowMinutes,
    updatedAt: ctx.at,
    updatedByAdminId: ctx.actorId,
  };

  // 两种「什么都没发生」：重放，或提交的值与现状相同（所有可改字段都没变）。
  // 都不写数据、不写审计、不刷新时间戳，且**都不是错误**
  const nothingChanged = (Object.keys(PATCHABLE_FIELDS) as (keyof PlatformConfigInput)[])
    .every((field) => next[field] === previous[field]);

  if (replay?.kind === "replay" || nothingChanged) {
    return {
      kind: "ok",
      // 两份互不相关的副本，而不是同一个对象的两个别名
      value: { previous: { ...previous }, updated: { ...previous } },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = writePlatformConfig(next);

  writeAudit({
    ctx,
    action: "platformConfig.update",
    targetType: "platformConfig",
    targetId: PLATFORM_CONFIG_ID,
    before: toPlatformConfigAuditSnapshot(written.previous),
    after: toPlatformConfigAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written, changed: true, replayed: false };
}

/**
 * 当前配置（**同步读**）。
 *
 * 导出出来是为了让需要「读配置但不需要写」的上层（例如 P0-5 计算公共池截止时间）
 * 不必绕道异步仓储。它只是把 `readPlatformConfig()` 转个手——
 * 但**必须有这一处**，否则那些调用方会各自去 import Mock 仓储，
 * 而「谁在读配置」这件事就会散到各处。
 */
export function currentPlatformConfig(): PlatformConfig {
  return readPlatformConfig();
}
