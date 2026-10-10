import { createHash } from "node:crypto";
import { toCouponAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  ADMIN_COUPON_TEMPLATE_FORM_KEY,
  ADMIN_COUPON_TEMPLATE_FORM_LABEL,
  adminCouponTemplateActionFromPatch,
  isCouponTemplateUnchanged,
  type CouponTemplateDraft,
} from "@/lib/constants/adminCoupons";
import { buildThresholdCouponLabels, isComputableCouponForm } from "@/lib/constants/coupons";
import type { Coupon } from "@/lib/types/coupon";
import { buildAuditEntry } from "../adminWriteSupport";
import {
  type AdminCouponTemplateWriteOutcome,
  type AdminWriteContext,
} from "../couponTemplateTransaction";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeCreateReplayTx, takeReplayTx } from "./adminWriteTx";
import {
  applyCouponEnabledTx,
  applyCouponPatchTx,
  insertCouponTemplateTx,
  lockCouponTemplateForUpdateTx,
  readCouponTemplateTx,
} from "./couponRepository";
import { getPgExecutor } from "./executor";

/**
 * 券模板管理端写闭包（**新建 / 编辑 / 启停**）的 PostgreSQL 事务 ——
 * `lib/data/couponTemplateTransaction.ts` 三个入口的**等价翻译**（PROD-1D）。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 券模板的写入入口只有一处（Mock 的伪事务），判据、文案派生、审计、返回值都在那里定义。
 * 它与订单闭包共用一条跨领域不变式：
 *
 * > 券模板的业务写入与它的那一条管理审计必须**同生共死**。
 *
 * Mock 靠「同一段无 `await` 的同步代码」成立（`createCouponRecord` 写完，
 * `writeAudit` 紧接着写在同一个区段里）。换成数据库之后，两件事各自是一条 SQL，
 * 中间必然让出执行权；若审计还写 `globalThis`，就会出现本仓反复拒绝的半套事务——
 * 那次事务一提交，进程内的账本已经把「管理员建过这张券」记下来了。因此审计必须在
 * **同一个事务**里 `INSERT`（`appendAuditEntryTx`），审计失败则业务写入一起回滚
 * （`tests/pgCouponTemplateTransactions.test.mjs` 的回滚用例证明这一条）。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、三种「成功」的口径（`changed` / `replayed`）、写入的字段集合、文案派生
 * **逐条对齐** `couponTemplateTransaction.ts`。业务规则一个字节都没改，规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 表单形态与入参形状 | `adminCoupons.ts` 的 `CouponTemplateDraft` / `AdminCouponTemplateProfilePatch` |
 * | 新建时钉死的形态与文案 | `ADMIN_COUPON_TEMPLATE_FORM_KEY` / `ADMIN_COUPON_TEMPLATE_FORM_LABEL` |
 * | 券面文案由两个金额派生 | `coupons.ts` 的 `buildThresholdCouponLabels` |
 * | 哪些形态可编辑 | `coupons.ts` 的 `isComputableCouponForm` |
 * | 编辑该记哪个动作 | `adminCoupons.ts` 的 `adminCouponTemplateActionFromPatch` |
 * | 「什么都没改」的判据 | `adminCoupons.ts` 的 `isCouponTemplateUnchanged` |
 * | 审计记什么 | `adminAudit.ts` 的 `toCouponAuditSnapshot` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay` / `evaluateCreateReplay`（经 `adminWriteTx`） |
 *
 * ⚠️ 本文件**只改券模板（`coupon_templates`）**，一行都不碰 `coupon_claims`：
 * §5 明文停用不删除已发出的 Claim，§「编辑不追溯」明文改模板不回写快照。
 * 因此这里根本没有「顺带更新一下用户手里的券」这种代码的位置。
 *
 * ## 幂等账本要读**两次**（与 `pg/adminAuditTransactions.ts` 同一条设计）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 前置读为什么必要：Mock 把「键冲突」排在**一切业务判定之前**（三个入口第一行都是
 * `takeReplay` / `takeCreateReplay`）。若把整段账本读推到锁后，一次「复用了别人的幂等键」
 * 就可能先撞上「目标不存在」或「形态不可编辑」，报出来的原因与 Mock 不同。
 * 前置读**只回答 `conflict`**，它读到的 `replay` **不被采信**（那会导向写入，
 * 必须留给权威读）。
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，
 * 会双双读空、双双进入写入段，最后撞在 `admin_audit_entries_operation_key`
 * 唯一索引上（`23505`）——那**不是重放，是一次失败**。排在竞争锁之后，
 * 第二个请求会等待、等第一个提交之后再读账本，于是看到那一行、正确重放。
 *
 * ⚠️ 因此有两条**不可合并**的判据，别把前置读的结果直接当结论用。
 *
 * ## 新建**没有可锁的行**：`operationId` 派生的顾问锁（本轮唯一的新机制）
 *
 * 编辑 / 启停都能把幂等判定挂在「这一行」上（`FOR UPDATE`），而**新建没有这样一行**——
 * 目标 id 是在事务里当场生成的，两个并发的新建请求不存在任何共享的行可以串行化。
 * 若照搬「先读账本、再写」，两个**同键**的新建会双双读到空账本、双双 `INSERT`，
 * 第二个撞 `admin_audit_entries_operation_key`（`23505`）→ 两个请求都失败，
 * 而正确的答案是「你刚才已经建过了」。
 *
 * 因此新建在**事务最前面**取一把由 `operationId` 派生的 bigint **事务级顾问锁**
 * （`pg_advisory_xact_lock`，与 `pg/migrate.ts` 的 `MIGRATION_LOCK_KEY` 同一个 idiom）。
 * 作用与效果写在 `couponCreateLockKey()` 上：
 *
 * - **为什么需要它**：它是新建路径上**唯一**能把两个同键请求串行化的东西——
 *   等价于 Mock 的「第二个请求必然读到第一个已经写下的账本」。
 * - **为什么它不构成新的 schema**：顾问锁是 PostgreSQL 的**内存锁表**，
 *   不建表、不加列、不落盘、不写任何业务数据，因此**零 migration**。
 * - **键怎么派生**：`sha256(operationId)` 取前 64 bit，映射进有符号 int64。
 *   同一个键 ⇒ 同一把锁 ⇒ 串行；不同键 ⇒ 不同锁 ⇒ 互不阻塞。
 * - **碰撞的后果**：两个**不相关**的新建恰好撞进同一个键，只会让它们**串行化**
 *   （一个稍等另一个提交），既不报错也不改结果——所以碰撞是**无害**的，
 *   这也是可以放心用哈希而不必引入一张「键 → 锁」对照表的原因。
 *
 * ⚠️ 顾问锁**只在新建路径**用。编辑 / 启停**不取**它：那两条路径已经有一把**更精确**
 * 的行锁（`FOR UPDATE`），再叠一把按 `operationId` 的锁只会让「同一张券的两次不同编辑」
 * 因为键不同而互不阻塞、白白多一层复杂度。两处的目标都是「同键请求串行」，
 * 但能挂在行上的地方就挂在行上。
 *
 * ## 本轮**不激活**（与 PROD-1B / PROD-1C 同一条裁定）
 *
 * `DATA_SOURCE` 未设置时应用照旧走 Mock 伪事务，本模块的调用方**只有测试**。
 *
 * ## 事务内**绝不**调 Mock 的 `writeAudit`
 *
 * `lib/data/adminWriteSupport.ts` 的 `writeAudit` 末尾会写**进程内的** Mock 账本。
 * 这里复用同一个**拼装函数** `buildAuditEntry`（纯函数），把结果交给
 * `appendAuditEntryTx` 的 `INSERT`。拼装规则一字未改，因此「审计记了些什么」
 * 在两个存储上仍然只有一处定义。
 */

/**
 * 新建路径的顾问锁键 —— 由 `operationId` 派生。
 *
 * ## 为什么是哈希而不是直接用 operationId 的数字
 *
 * 幂等键是**字符串**，而 `pg_advisory_xact_lock` 收 bigint。哈希把它压成 64 bit：
 * 同一个字符串永远得到同一个数（→ 同一把锁），不同的字符串极大概率得到不同的数
 * （→ 不同的锁）。取前 8 字节（16 个 hex 字符）而不是整个摘要，是为了让结果**恰好**
 * 落在 int64 里；`BigInt.asIntN(64, …)` 把无符号值映射进 PostgreSQL `bigint` 的
 * 有符号范围（负数也是合法的锁键）。
 *
 * ## 碰撞的后果：只是串行化，无害
 *
 * 两把**本该无关**的锁撞成同一个键时，两个新建请求会互相等待一下，然后各自正常完成——
 * 数据与返回值都不受影响。因此这里**不需要**一张「幂等键 → 锁」的对照表，
 * 也不需要任何去重；哈希的碰撞概率（2⁻⁶⁴ 量级）远低于 `crypto.randomUUID()` 自身的碰撞。
 */
function couponCreateLockKey(operationId: string): bigint {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
}

/* ─────────────────────────── 新建 ─────────────────────────── */

/**
 * 新建券模板（§1：**只可能是满减券**）—— `createCouponTemplate` 的 Pg 实现。
 *
 * 形态与文案都由**服务端**钉死：`formKey` 取常量层的值，`valueLabel` /
 * `conditionLabel` 由 `buildThresholdCouponLabels()` 从两个金额派生（§3）。
 * 调用方（服务层）传进来的 `draft` 里根本没有这三个字段的位置。
 *
 * ⚠️ 「同一个幂等键第二次到达」靠**操作类型**识别（`takeCreateReplayTx`），
 * 而不是靠目标 id：新建的目标 id 是在事务里当场生成的，第二次调用会生成一个不同的 id，
 * 按 id 比对只会把它误判成「幂等键被别的对象用了」。
 *
 * ⚠️ **由此产生一条对调用方的要求：同一个幂等键只能用于一类动作**（与 Mock 的原注释同）。
 * `takeCreateReplayTx` 只认「这个键已经被 `targetType: "coupon"` 用过的对象」，
 * 因此同一个键若先被**启停**用掉，再来新建会被判成重放，返回的是那张**已存在的**券
 * 的 id 与 200——一次没有发生的创建被报成成功。服务层每次操作都用
 * `crypto.randomUUID()` 现取新键，真实路径不会撞上；但这是**调用方的义务**。
 *
 * ⚠️ `draft` 的值**由调用方保证已通过 `couponTemplateFieldErrors()`**。
 * 本函数不做校验、更不做夹取——一个「顺手夹到合法范围」的实现会让一条本该被拒绝的
 * 输入被静默改成另一个数字写进去。
 */
export async function createCouponTemplatePg(
  draft: CouponTemplateDraft,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：顾问锁。新建没有行可锁，同键串行只能靠它 —— */
    // ⚠️ 必须排在**读账本之前**：排在之后，「双双读空、双双写入」的窗口就又回来了。
    await tx.query("SELECT pg_advisory_xact_lock($1)", [couponCreateLockKey(ctx.operationId)]);

    /* —— 第 2 步：读账本（本路径里前置读与权威读合一，因为锁已经在最前面）—— */
    const replay = await takeCreateReplayTx(tx, ctx, "coupon");
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay") {
      // 账本里有、记录却没有：数据被清过。宁可报「不存在」，也不照着账本编一条出来
      const existing = await readCouponTemplateTx(tx, replay.targetId);
      if (!existing) return { kind: "not-found" };
      return {
        kind: "ok",
        value: { previous: null, updated: { ...existing } },
        changed: false,
        replayed: true,
      };
    }

    const labels = buildThresholdCouponLabels(draft.thresholdAmount, draft.discountAmount);

    const created: Coupon = {
      // ⚠️ 不用 Mock 的 `nextRecordId()`：它要求一个**同步**的 `taken()` 回调，
      //    而 Pg 判存在性是异步的。改成「主键冲突即硬失败」——见 `insertCouponTemplateTx`
      //    的说明，那恰好保住了「绝不覆盖既有记录」这条不变量。
      id: `cpn_${crypto.randomUUID()}`,
      // 形态由服务端钉死，不由调用方决定（§1）
      formKey: ADMIN_COUPON_TEMPLATE_FORM_KEY,
      formLabel: ADMIN_COUPON_TEMPLATE_FORM_LABEL,
      name: draft.name.trim(),
      // 文案由金额派生，不由调用方提交（§3）
      valueLabel: labels.valueLabel,
      conditionLabel: labels.conditionLabel,
      validFrom: draft.validFrom,
      validTo: draft.validTo,
      enabled: draft.enabled,
      thresholdAmount: draft.thresholdAmount,
      discountAmount: draft.discountAmount,
      // 建档与最后改动是同一个时刻：这条记录就是现在产生的
      createdAt: ctx.at,
      updatedAt: ctx.at,
    };

    await insertCouponTemplateTx(tx, created);

    // 审计与业务写入同一个提交点：审计失败 ⇒ 这张券也回滚（回滚用例证明这一条）
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "coupon.create",
        targetType: "coupon",
        targetId: created.id,
        before: null,
        after: toCouponAuditSnapshot(created),
      }),
    );

    return {
      kind: "ok",
      value: { previous: null, updated: { ...created } },
      changed: true,
      replayed: false,
    };
  });
}

/* ─────────────────────────── 编辑 ─────────────────────────── */

/**
 * 编辑券模板（名称 / 门槛 / 优惠金额 / 有效期 / 启用状态，一次保存）
 * —— `updateCouponTemplate` 的 Pg 实现。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * ```
 * 1. 幂等键用在别的对象上        → operation-conflict（前置读）
 * 2. 取锁；目标不存在            → not-found
 * 3. 形态不是满减券              → not-editable
 * 4. 权威读：重放                → ok / changed:false, replayed:true
 * 5. 提交的值与现状一模一样      → ok / changed:false, replayed:false
 * 6. 窄 UPDATE + 审计
 * ```
 *
 * ⚠️ 第 3 步的判据是**锁下读到的那份记录**的 `formKey`，不是请求体里的任何东西——
 * 一张折扣券不会因为请求体里写了 `formKey: "threshold"` 就变得可以编辑
 * （何况 `CouponTemplateDraft` 里根本没有那个字段的位置）。
 *
 * ⚠️ 文案**重新派生**：`valueLabel` / `conditionLabel` 由**新**的两个金额算出来。
 * 这不是「顺手更新一下」，而是「文案与金额是同一份数据的两种呈现」（§3）——
 * 改了金额却留着旧文案，就会在用户端显示「满 100 减 10」而实际抵扣别的数。
 *
 * ⚠️ **不追溯已发出的 Claim**（§5）：本函数只写 `coupon_templates` 这一张表。
 * 用户手里的券是 `CouponClaim.snapshot`，它在领取那一刻就冻结了。
 */
export async function updateCouponTemplatePg(
  id: string,
  draft: CouponTemplateDraft,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "coupon", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这张券自己。判定与写入都围着这一行 —— */
    const existing = await lockCouponTemplateForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    // 形态先判：一张折扣券上连「编辑」按钮都不该有，走到这里说明调用方绕过了界面
    if (!isComputableCouponForm(existing.formKey)) return { kind: "not-editable" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "coupon", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = adminCouponTemplateActionFromPatch(existing, draft);
    const next = {
      name: draft.name.trim(),
      thresholdAmount: draft.thresholdAmount,
      discountAmount: draft.discountAmount,
      validFrom: draft.validFrom,
      validTo: draft.validTo,
      enabled: draft.enabled,
    };

    // 两种「什么都没发生」都不写数据、不写审计、也不刷新时间戳，且**都不是错误**
    if (replay?.kind === "replay" || isCouponTemplateUnchanged(existing, next)) {
      return {
        kind: "ok",
        // 两份互不相关的副本，而不是同一个对象的两个别名
        value: { previous: { ...existing }, updated: { ...existing } },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const labels = buildThresholdCouponLabels(next.thresholdAmount, next.discountAmount);

    const written = await applyCouponPatchTx(tx, existing, {
      ...next,
      // 文案与金额从同一次计算里出来，不可能对不上（§3）
      valueLabel: labels.valueLabel,
      conditionLabel: labels.conditionLabel,
      at: ctx.at,
    });
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；
    // 当作失败返回，绝不继续写审计（与 Mock 的 `if (!written) return { kind: "not-found" }` 同）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "coupon",
        targetId: id,
        before: toCouponAuditSnapshot(written.previous),
        after: toCouponAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 启用 / 停用 ─────────────────────────── */

/**
 * 启用 / 停用券模板（**窄写入**：只改这一个字段）—— `setCouponTemplateEnabled` 的 Pg 实现。
 *
 * ⚠️ 与 `updateCouponTemplatePg()` 分开，是因为它**不该碰名称、金额与有效期**：
 * 详情页上的开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的金额覆盖回旧值。
 *
 * ⚠️ **对所有形态都开放**（与「编辑」不同）：折扣券与无门槛券虽然不能改内容，
 * 但「平台现在还要不要兑现它」是一个必须能回答的问题（§5）。
 *
 * ⚠️ **没有前置条件**：§5 明文 disable 不删除 Claim、不改变历史订单，
 * 因此「已经有多少人领过」不是拒绝停用的理由——它是列表上给管理员看的提示。
 *
 * ## 幂等在这里是**两轴**的
 *
 * 用 `takeReplayTx` 而不是 `takeReplayForActionTx`：本动作的**意图由入参决定**
 * （`enabled` 就是意图本身），而同一个入参第二次到达本来就该是「重放」。
 * 反过来，同一个键先用于启用、再用于停用，会被判成重放——但那种调用是
 * **调用方复用了幂等键**，两次意图里后一次什么都没做。这与 `takeReplayForAction`
 * 的注释说明的取舍是同一件事的另一面：那里的动作名要在读完记录后才算得出来，
 * 这里的动作名在调用前就定死了，因此**不需要**再收一轴——入参没变就一定是同一个意图。
 * ⚠️ 照抄这个取舍，不要「顺手改进」成 `takeReplayForActionTx`。
 */
export async function setCouponTemplateEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "coupon", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这张券自己 —— */
    const existing = await lockCouponTemplateForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "coupon", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    const action = enabled ? "coupon.enable" : "coupon.disable";

    // 已经就是那个状态：不写数据、不写审计、不刷新时间戳，且**不是错误**。
    // 「再停用一次一张已停用的券」不是失败——它已经是调用方想要的样子
    if (replay?.kind === "replay" || existing.enabled === enabled) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing } },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await applyCouponEnabledTx(tx, existing, enabled, ctx.at);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态（与 Mock 同处理）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: "coupon",
        targetId: id,
        before: toCouponAuditSnapshot(written.previous),
        after: toCouponAuditSnapshot(written.updated),
      }),
    );

    return { kind: "ok", value: written, changed: true, replayed: false };
  });
}
