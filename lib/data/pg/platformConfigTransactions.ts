import { toPlatformConfigAuditSnapshot } from "@/lib/constants/adminAudit";
import { PLATFORM_CONFIG_ID } from "@/lib/constants/platformConfig";
import type { PlatformConfig } from "@/lib/types/platformConfig";
import {
  PATCHABLE_FIELDS,
  type AdminPlatformConfigWriteOutcome,
  type AdminWriteContext,
  type PlatformConfigInput,
} from "../adminPlatformConfigTransaction";
import { buildAuditEntry } from "../adminWriteSupport";
import { normalizePlatformConfig } from "../mockPlatformConfigRepository";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeReplayTx } from "./adminWriteTx";
import { getPgExecutor } from "./executor";
import { applyPlatformConfigTx, lockPlatformConfigForUpdateTx } from "./platformConfigRepository";

/**
 * 「修改平台参数」的 PostgreSQL 事务 ——
 * `lib/data/adminPlatformConfigTransaction.ts` 的 `updatePlatformConfig` 的**等价翻译**。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 平台参数的写入入口只有一处（Mock 的伪事务），判据、审计、返回值都在那里定义。
 * 文档（`rounds/AUDIT-PG-1/README.md` §十 10.2）把它登记为 PROD-1D 的第一类，
 * 理由是它与订单闭包共用一条跨领域不变式：
 *
 * > 平台参数的**业务写入**与它的那一条管理审计必须**同生共死**。
 *
 * Mock 靠「同一段无 `await` 的同步代码」成立：`writePlatformConfig` 写完，
 * `writeAudit` 紧接着写在同一个区段里。换成数据库之后，两件事各自是一条 SQL，
 * 中间必然让出执行权；若审计还写 `globalThis`，就会出现本仓反复拒绝的半套事务——
 * 那次事务一提交，进程内的账本已经把「管理员改过这个参数」记下来了。因此审计
 * 必须在**同一个事务**里 `INSERT`（`appendAuditEntryTx`），审计失败则业务写入
 * 一起回滚（`tests/pgPlatformConfigTransactions.test.mjs` 的回滚用例证明这一条）。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、`nothingChanged` 的判据、no-op / replay 分支的返回值、写入的字段集合
 * **逐条对齐** `adminPlatformConfigTransaction.ts` 的 `updatePlatformConfig`。
 * 业务规则一个字节都没改，规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 哪四个字段可改（`input` 的键集合） | `adminPlatformConfigTransaction.ts` 的 `PlatformConfigInput` |
 * | 「这次到底改没改」的键集合 | 同一个文件导出的 `PATCHABLE_FIELDS`（**导出是为了共用，不是复制**） |
 * | 审计记什么（before / after 的字段） | `lib/constants/adminAudit.ts` 的 `toPlatformConfigAuditSnapshot` |
 * | 审计目标 id | `lib/constants/platformConfig.ts` 的 `PLATFORM_CONFIG_ID` |
 * | 读边界归一化（旧数据补齐） | `mockPlatformConfigRepository.ts` 的 `normalizePlatformConfig` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay`（经 `takeReplayTx`） |
 *
 * ⚠️ **`PATCHABLE_FIELDS` 是从 Mock 模块 import 的，不是在这里再抄一份**。
 * 那个对象的类型是 `Record<keyof PlatformConfigInput, true>`，「加第五个参数时
 * 忘记更新判定」因此是**编译错误**。在 Pg 侧复制一份，这份保险就只对 Mock 生效；
 * 导出后两边读同一个对象，漏加键时两处**同时**通不过 `tsc`。
 *
 * ## 幂等账本要读**两次**（与 `pg/adminAuditTransactions.ts` 同一条设计）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 前置读为什么必要：Mock 把「键冲突」排在**一切业务判定之前**（`updatePlatformConfig`
 * 第一行就是 `takeReplay`）。若把整段账本读推到锁后，一次「复用了别人的幂等键」
 * 就可能先撞上别的东西，报出来的原因与 Mock 不同。前置读**只回答 `conflict`**，
 * 它读到的 `replay` **不被采信**（那会导向写入，必须留给权威读）。
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，
 * 会双双读空、双双进入写入段，最后撞在 `admin_audit_entries_operation_key`
 * 唯一索引上（`23505`）——那**不是重放，是一次失败**。排在行锁之后，第二个请求
 * 会在 `platform_config` 那一行上等待，等第一个提交之后再读账本，于是看到那一行、
 * 正确重放。
 *
 * ## 加锁顺序
 *
 * 本条路径只锁一把锁：`platform_config` 的那一行。它**不碰 `orders`**，
 * 因此与全库「`orders` 永远是第一把锁」这条不变量不冲突（那条不变量管的是
 * 「同时要锁订单与别的表」的路径）。`w1Transactions` 里的 `readPlatformConfig(tx)`
 * 是**普通读**、不参与加锁顺序，因此也不会与本条形成环。
 *
 * ## 为什么没有 `not-found` / `removed`
 *
 * 平台参数是**单例**，没有「这条记录不存在」与「已下架」两个状态——因此返回类型
 * 直接复用 Mock 的 `AdminPlatformConfigWriteOutcome`（只有 `ok` 与 `operation-conflict`
 * 两种），**不新造一个并集**。多收两个用不到的分支，等于把两条不存在的状态
 * 写进了类型。
 */

/**
 * 修改平台参数（**PostgreSQL 事务**）。
 *
 * ⚠️ `input` 里的值**由调用方保证已通过 `lib/constants/platformConfig.ts` 的
 * `isValid*` 校验**（服务层 `lib/services/adminPlatformConfig.ts`）。本函数
 * **不校验、也不夹取**——一个「顺手夹到合法范围」的实现会让一条本该被拒绝的
 * 2880 被静默改成 1440 写进去，调用方拿到「成功」而生效的是另一个数字。
 * （数据库的 `CHECK` 是本函数之外的**第二道**网，它拒绝越界值、让事务回滚，
 * 但它不是这里的校验。）
 *
 * ⚠️ 操作者的身份**只从 `ctx` 来**。`ctx` 由服务层按 `requireAdmin()` 返回的会话
 * 拼装，请求体里的任何 actor 字段在这里没有进入路径。
 */
export async function updatePlatformConfigPg(
  input: PlatformConfigInput,
  ctx: AdminWriteContext,
): Promise<AdminPlatformConfigWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在一切业务判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "platformConfig", PLATFORM_CONFIG_ID);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：单行表的那一行。第二次读账本要排在它之后 —— */
    // 读不到那一行**抛错**，不返回失败种类：平台参数是单例，种子里必然有它，
    // 读不到是数据异常而不是业务结局（与 `w1Transactions.readPlatformConfigFrom()`
    // 同一口径）。
    const previous = await lockPlatformConfigForUpdateTx(tx);
    if (!previous) {
      throw new Error("platform_config 没有 id = 1 的那一行：迁移后必须先播种平台参数");
    }

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "platformConfig", PLATFORM_CONFIG_ID);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // PATCH 合并：没带的字段保持现状（取锁下读到的那一份），带了的字段用新值。
    // 展开 `...previous` 不会替我们把「带了的字段用新值」做掉，因此四个时长**必须
    // 一个一个列出来**；`updatedAt` / `updatedByAdminId` 由事务写、覆盖在后面。
    const next: PlatformConfig = {
      ...previous,
      exclusivePoolTimeoutMinutes:
        input.exclusivePoolTimeoutMinutes ?? previous.exclusivePoolTimeoutMinutes,
      publicPoolTimeoutMinutes: input.publicPoolTimeoutMinutes ?? previous.publicPoolTimeoutMinutes,
      completionAutoApprovalMinutes:
        input.completionAutoApprovalMinutes ?? previous.completionAutoApprovalMinutes,
      complaintWindowMinutes: input.complaintWindowMinutes ?? previous.complaintWindowMinutes,
      updatedAt: ctx.at,
      updatedByAdminId: ctx.actorId,
    };

    // 两种「什么都没发生」：重放，或提交的值与现状相同（所有可改字段都没变）。
    // 都不写数据、不写审计、**不刷新 updatedAt**，且都不是错误。
    // ⚠️ 键集合来自 Mock 模块导出的 `PATCHABLE_FIELDS`，与那里**是同一个对象**。
    const nothingChanged = (Object.keys(PATCHABLE_FIELDS) as (keyof PlatformConfigInput)[]).every(
      (field) => next[field] === previous[field],
    );

    if (replay?.kind === "replay" || nothingChanged) {
      // ⚠️ 与 Mock 一样：返回给调用方的两份必须过一遍**读边界归一化**
      // （`normalizePlatformConfig`），且是**两份互不相关的副本**。
      //
      // ⚠️ **只归一化返回值，不动 `previous`**：`previous` 是上面 no-op 判据的
      // 合并基准，把它也归一化会让「脏记录 + 恰好提交默认值」落进 `nothingChanged`
      // 而**永不写盘**——那样旧记录就再也修不好了。这条分支也是唯一一条不经过
      // `applyPlatformConfigTx` 就返回配置的路径，与 Mock 的注释一一对应。
      const snapshot = normalizePlatformConfig(previous);
      return {
        kind: "ok",
        value: { previous: { ...snapshot }, updated: { ...snapshot } },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    /* —— 写入段：窄 UPDATE + 审计，同一个提交点 —— */
    const written = await applyPlatformConfigTx(tx, previous, next);

    // 审计的 before / after 由**纯函数**拼装（`buildAuditEntry`），再交给
    // `appendAuditEntryTx` 落库。⚠️ 绝不调 Mock 的 `writeAudit`——那个函数末尾会写
    // **进程内的** Mock 账本，在 Pg 事务里调它等于同一件事被同时写进两个存储。
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "platformConfig.update",
        targetType: "platformConfig",
        targetId: PLATFORM_CONFIG_ID,
        before: toPlatformConfigAuditSnapshot(written.previous),
        after: toPlatformConfigAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written, changed: true, replayed: false };
  });
}
