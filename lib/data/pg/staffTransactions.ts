import { createHash } from "node:crypto";
import { toStaffAuditSnapshot } from "@/lib/constants/adminAudit";
import { isStaffProfileUnchanged, type AdminStaffProfileInput } from "@/lib/constants/adminStaff";
import type { StaffAccount } from "@/lib/types/staff";
import { buildAuditEntry } from "../adminWriteSupport";
import type { AdminStaffWriteResult, AdminWriteContext } from "../adminStaffTransaction";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeCreateReplayTx, takeReplayTx } from "./adminWriteTx";
import { getPgExecutor, type PgQueryable } from "./executor";

/**
 * 客服账号管理端写闭包（**新增 / 编辑 / 启停 / 移除**）的 PostgreSQL 事务 ——
 * `lib/data/adminStaffTransaction.ts` 四个入口的**等价翻译**（PROD-1E · Wave C）。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 客服账号的两条要求横跨「账号记录」与「审计」两张表，Mock 靠**同一段无 `await`
 * 的同步代码**同时满足它们（`adminStaffTransaction.ts` 文件头）：
 *
 * 1. **登录名唯一**——「先查有没有同名、再写入」中间只要让出一次执行权，
 *    两个同时到达的「新增 kefu-xiaoyu」就会双双通过检查、写下两条同名记录；
 * 2. **审计恰好一次**——业务写入与审计写入必须同生共死，事后补不回来。
 *
 * 换成数据库之后，每个查询都会让出执行权，那段区段不再原子。唯一正确的替代是
 * **一个数据库事务**：判定顺序一字不改，业务写入与 `appendAuditEntryTx` 落同一条
 * 连接、同一个提交点，审计失败则整段回滚。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、写入的字段集合、`changed` / `replayed` 的口径、审计快照
 * **逐条对齐** `adminStaffTransaction.ts`。业务规则一个字节都没改，
 * 规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 入参形状（只三个可改字段，没有 `role`） | `adminStaff.ts` 的 `AdminStaffProfileInput` |
 * | 「资料有没有变」的判据 | `adminStaff.ts` 的 `isStaffProfileUnchanged` |
 * | 审计记什么 | `adminAudit.ts` 的 `toStaffAuditSnapshot` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay` / `evaluateCreateReplay`（经 `adminWriteTx`） |
 *
 * ## 幂等账本要读**两次**（前置读只判 conflict，权威读在锁后）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 把 `takeReplay` 排在业务判定之前的次序对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，会双双读空、
 * 双双进入写入段，最后撞上 `admin_audit_entries_operation_key` 唯一索引（`23505`）——
 * 那**不是重放，是一次失败**。排在行锁之后，第二个请求会等待，等第一个提交之后再读，
 * 于是看到那一行、正确重放（与 `pg/couponTemplateTransactions.ts` 同一条设计）。
 *
 * ## 新增**没有可锁的行**：两把 `operationId` / 登录名派生的顾问锁
 *
 * 编辑 / 启停 / 移除都能把幂等判定挂在「这一行」上（`FOR UPDATE`），而**新增没有这样
 * 一行**——目标 id 在事务里当场生成。若照搬「先读账本、再写」，两个**同键**的新增会
 * 双双读空、双双写入，第二个撞唯一索引（`23505`）→ 两个请求都失败，而正确答案是
 * 「你刚才已经建过了」。因此新增按顺序取**两把**事务级顾问锁：
 *
 * 1. `operationId` 派生（同 `couponTemplateTransactions.ts` 的 `couponCreateLockKey`）——
 *    把两个**同键**的新增串行化，等价于 Mock 里「第二个请求必然读到第一个已写下的账本」；
 * 2. **登录名**派生——把两个**登录名相同、幂等键不同**的新增串行化。没有它的话，
 *    两个并发新增会双双通过「查重」再双双 `INSERT`，第二个撞 `staff_accounts_username_key`
 *    （`23505`）报 500；Mock 的答案是先到的那个成功、后到的返回 `username-taken`。
 *    键按与唯一索引**同一套归一化**（`trim().toLowerCase()`）派生，因此索引认为相等的
 *    两个登录名一定拿到同一把锁。
 *
 * 两把锁的**取用顺序固定**（先 operationId、后登录名），因此不会与其它路径形成环。
 * 顾问锁是 PostgreSQL 的**内存锁表**，不建表、不加列、零 migration；哈希碰撞只会让两个
 * 无关的新增串行一下（既不改结果也不报错），因此**无害**。
 *
 * ⚠️ 顾问锁**只在新增路径**用。三条编辑路径已经有更精确的行锁（`FOR UPDATE`），
 * 再叠一把按 `operationId` 的锁只会白白多一层复杂度。
 *
 * ## 写原语为什么在**本文件**，而不是 `pg/staffRepository.ts`
 *
 * `pg/staffRepository.ts` 的文件头写明：那四个同步写原语
 * （`findStaffWithUsername` / `createStaffRecord` / `applyStaffPatch` / `applyStaffFlags`）
 * 服务于管理端写事务的原子区段，**刻意不在仓储里实现**，由管理端写事务那条链路单独负责。
 * 本文件就是那条链路，因此这里带着自己的行映射与窄写入器——`SELECT … FOR UPDATE`、
 * `RETURNING` 的列清单与 `STAFF_COLUMNS` 同源，列名与占位符个数不可能错位。
 *
 * ⚠️ `STAFF_COLUMNS` 必须与 `pg/staffRepository.ts` 的 `COLUMNS` **逐字相同**：
 * 两个文件读的是同一张表的同一组列（那一个只读、硬编码在仓储里不能改）。
 */

type StaffRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  role: StaffAccount["role"];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  removed_at: string | null;
};

/** 列清单。`id` 定义在 `COLLATE "C"` 上（`0010_identity_and_accounts.sql`）。 */
const STAFF_COLUMNS =
  "id, username, display_name, avatar_url, role, enabled, " +
  "created_at, updated_at, last_login_at, removed_at";

/** 占位符由列清单派生：列名与 `$n` 永远一一对应，改列清单只改一处。 */
const STAFF_INSERT_SQL =
  `INSERT INTO staff_accounts (${STAFF_COLUMNS})\n` +
  `VALUES (${STAFF_COLUMNS.split(", ")
    .map((_, index) => `$${index + 1}`)
    .join(", ")})`;

function toStaffAccount(row: StaffRow): StaffAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    removedAt: row.removed_at,
  };
}

/* ─────────────────────── 顾问锁（仅新增路径） ─────────────────────── */

/**
 * 事务级顾问锁的键 —— 由「作用域 + 值」派生（与 `pg/migrate.ts` 的 `MIGRATION_LOCK_KEY`
 * 同一 idiom）。哈希把字符串压成 64 bit：同一个键永远得到同一个数（→ 同一把锁），
 * 不同键极大概率得到不同的数（→ 不同的锁）。`\u0000` 分隔避免「作用域」与「值」拼接歧义。
 */
function advisoryLockKey(scope: string, value: string): bigint {
  const digest = createHash("sha256").update(`${scope}\u0000${value}`).digest("hex");
  return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
}

/* ─────────────────────────── 同步写原语（事务内） ─────────────────────────── */

/** 普通读（不加锁）。只给「新建重放」那条纯读路径用：拿账本里的 id 回表把当时那条读出来。 */
async function readStaffByIdTx(db: PgQueryable, id: string): Promise<StaffAccount | null> {
  const rows = await db.query<StaffRow>(
    `SELECT ${STAFF_COLUMNS} FROM staff_accounts WHERE id = $1`,
    [id],
  );
  return rows[0] ? toStaffAccount(rows[0]) : null;
}

/**
 * 取一条客服账号并**锁住它**（`SELECT … FOR UPDATE`）。
 *
 * 「读—判断—写」的全部判定都围着这一行，行锁把两个同时编辑同一个账号的请求串行化：
 * 第二个要等第一个提交，之后读到的是第一个写下的结果——与 Mock 的同步区段等价。
 */
async function lockStaffForUpdateTx(db: PgQueryable, id: string): Promise<StaffAccount | null> {
  const rows = await db.query<StaffRow>(
    `SELECT ${STAFF_COLUMNS} FROM staff_accounts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toStaffAccount(rows[0]) : null;
}

/**
 * 按登录名查账号（**大小写不敏感**）—— `mockStaffRepository.findStaffWithUsername` 的 Pg 版。
 *
 * 比较表达式与唯一索引 `staff_accounts_username_key` **逐字相同**（`lower(btrim(username))`），
 * 且**不加** `removed_at IS NULL`：索引本身也不排除已移除的账号，因此一个已移除账号
 * 仍然占着它的登录名（与 Mock 遍历整张 Map 一致）。
 *
 * `exceptId` 用于「改自己的资料」：把登录名改成自己的原名不算被自己占用。
 */
async function findStaffByUsernameTx(
  db: PgQueryable,
  username: string,
  exceptId?: string,
): Promise<StaffAccount | null> {
  // 去空白后为空则直接返回 null：`lower(btrim('')) = lower(btrim(''))` 恒真，
  // 若库里存在一条空白登录名会被查出来——那是 Mock 明确拒绝的情形。
  if (!username.trim()) return null;

  const rows = exceptId
    ? await db.query<StaffRow>(
        `SELECT ${STAFF_COLUMNS} FROM staff_accounts
          WHERE lower(btrim(username)) = lower(btrim($1)) AND id <> $2`,
        [username, exceptId],
      )
    : await db.query<StaffRow>(
        `SELECT ${STAFF_COLUMNS} FROM staff_accounts
          WHERE lower(btrim(username)) = lower(btrim($1))`,
        [username],
      );
  return rows[0] ? toStaffAccount(rows[0]) : null;
}

/**
 * 写一条新账号 —— `mockStaffRepository.createStaffRecord` 的 Pg 版。
 *
 * **硬 `INSERT`，没有 `ON CONFLICT`**：Mock 用 `nextRecordId("staff_", …)` 保证 id 不冲突，
 * 而那个写法要求一个同步的 `taken()` 回调；Pg 侧改为主键冲突即硬失败——新 id 用
 * `staff_${crypto.randomUUID()}` 现取，撞上的概率可忽略，万一撞上就整段回滚，
 * **绝不覆盖一条既有记录**（与 `insertCouponTemplateTx` 同一取舍）。
 */
async function insertStaffAccountTx(db: PgQueryable, account: StaffAccount): Promise<StaffAccount> {
  await db.query(STAFF_INSERT_SQL, [
    account.id,
    account.username,
    account.displayName,
    account.avatarUrl,
    account.role,
    account.enabled,
    account.createdAt,
    account.updatedAt,
    account.lastLoginAt,
    account.removedAt,
  ]);
  return account;
}

/** `applyStaffPatch` 能改的字段 —— 与 Mock 的入参**逐字段相同**（`enabled` / `removedAt` 不在其中）。 */
type StaffProfileFields = Pick<StaffAccount, "username" | "displayName" | "avatarUrl" | "updatedAt">;

/** 编辑资料 —— `mockStaffRepository.applyStaffPatch` 的 Pg 版（**窄写入**：只写这四列）。 */
async function applyStaffPatchTx(
  db: PgQueryable,
  previous: StaffAccount,
  patch: StaffProfileFields,
): Promise<{ previous: StaffAccount; updated: StaffAccount } | null> {
  const rows = await db.query<StaffRow>(
    `UPDATE staff_accounts
        SET username = $2,
            display_name = $3,
            avatar_url = $4,
            updated_at = $5
      WHERE id = $1
      RETURNING ${STAFF_COLUMNS}`,
    [previous.id, patch.username, patch.displayName, patch.avatarUrl, patch.updatedAt],
  );
  if (!rows[0]) return null;
  return { previous: { ...previous }, updated: toStaffAccount(rows[0]) };
}

/**
 * 只改「能不能用」的三个字段（启用 / 停用 / 移除）—— `mockStaffRepository.applyStaffFlags`
 * 的 Pg 版。与资料写入分开：停用只把 `enabled` 关掉，展示名称与头像一个都不该被写一遍。
 */
async function applyStaffFlagsTx(
  db: PgQueryable,
  previous: StaffAccount,
  flags: { enabled: boolean; removedAt: string | null; updatedAt: string },
): Promise<{ previous: StaffAccount; updated: StaffAccount } | null> {
  const rows = await db.query<StaffRow>(
    `UPDATE staff_accounts
        SET enabled = $2,
            removed_at = $3,
            updated_at = $4
      WHERE id = $1
      RETURNING ${STAFF_COLUMNS}`,
    [previous.id, flags.enabled, flags.removedAt, flags.updatedAt],
  );
  if (!rows[0]) return null;
  return { previous: { ...previous }, updated: toStaffAccount(rows[0]) };
}

/* ─────────────────────────── 内部工具 ─────────────────────────── */

/** 「更新前 / 更新后」的两个快照一起写，避免某个操作只写了一半（与 Mock 同名函数同）。 */
function staffSnapshots(
  previous: StaffAccount,
  updated: StaffAccount,
): { before: ReturnType<typeof toStaffAuditSnapshot>; after: ReturnType<typeof toStaffAuditSnapshot> } {
  return { before: toStaffAuditSnapshot(previous), after: toStaffAuditSnapshot(updated) };
}

/** 什么都没发生的返回（与 Mock 的 `unchanged` 同形状）。 */
function unchanged(account: StaffAccount, replayed: boolean): AdminStaffWriteResult {
  return { kind: "ok", value: { ...account }, changed: false, replayed };
}

/* ─────────────────────────── 新增 ─────────────────────────── */

/**
 * 新增一个客服账号 —— `createStaffAccount` 的 Pg 实现。
 *
 * ⚠️ 角色写死 `customer_service`：`AdminStaffProfileInput` 里没有 `role` 字段的位置，
 * 请求体里塞 `role: "admin"` 读不到（不是「校验后拒绝」，是「压根没有落脚点」）。
 */
export async function createStaffAccountPg(
  input: AdminStaffProfileInput,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：两把顾问锁。新增没有行可锁，同键 / 同名串行只能靠它们 —— */
    // ⚠️ 必须排在**读账本与查重之前**：排在之后，「双双读空、双双写入」的窗口就又回来了。
    await tx.query("SELECT pg_advisory_xact_lock($1)", [
      advisoryLockKey("staff:create-op", ctx.operationId),
    ]);
    await tx.query("SELECT pg_advisory_xact_lock($1)", [
      advisoryLockKey("staff:create-username", input.username.trim().toLowerCase()),
    ]);

    /* —— 第 2 步：读账本（锁已在最前面，前置读与权威读合一）—— */
    const replay = await takeCreateReplayTx(tx, ctx, "staff");
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay") {
      // 账本里有、记录却没有：数据被清过。宁可报「不存在」，也不照着账本编一条出来
      const existing = await readStaffByIdTx(tx, replay.targetId);
      if (!existing) return { kind: "not-found" };
      return unchanged(existing, true);
    }

    /* —— 第 3 步：唯一性。锁下查重，与 staff_accounts_username_key 用同一套归一化 —— */
    if (await findStaffByUsernameTx(tx, input.username)) return { kind: "username-taken" };

    const account: StaffAccount = {
      // ⚠️ 不用 Mock 的 `nextRecordId()`：它要求同步的 `taken()` 回调，Pg 判存在性是异步的。
      //    前缀 `staff_` 与 Mock 一致；主键冲突即硬失败（见 `insertStaffAccountTx`）。
      id: `staff_${crypto.randomUUID()}`,
      username: input.username.trim(),
      displayName: input.displayName.trim(),
      avatarUrl: input.avatarUrl.trim(),
      role: "customer_service",
      enabled: true,
      createdAt: ctx.at,
      updatedAt: ctx.at,
      // 新账号从没登录过。null ≠ 0 ≠ 空串：「没登录过」与「很久以前登录过」是两件事
      lastLoginAt: null,
      removedAt: null,
    };
    await insertStaffAccountTx(tx, account);

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "staff.create",
        targetType: "staff",
        targetId: account.id,
        before: null,
        after: toStaffAuditSnapshot(account),
      }),
    );

    return { kind: "ok", value: { ...account }, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 编辑 ─────────────────────────── */

/**
 * 编辑客服账号的资料（登录名 / 名称 / 头像）—— `updateStaffProfile` 的 Pg 实现。
 *
 * ⚠️ **不碰状态**：`enabled` 与 `removedAt` 只能走 `setStaffEnabledPg()` / `removeStaffAccountPg()`。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * ```
 * 1. 幂等键用在别的对象上        → operation-conflict（前置读）
 * 2. 取锁；目标不存在            → not-found
 * 3. 已移除                      → removed
 * 4. 登录名被另一个账号占用      → username-taken（锁下查重，排除自己）
 * 5. 权威读：重放                → ok / changed:false, replayed:true
 * 6. 三个字段与现状完全一致      → ok / changed:false, replayed:false
 * 7. 窄 UPDATE + 审计
 * ```
 */
export async function updateStaffProfilePg(
  id: string,
  input: AdminStaffProfileInput,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在业务判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, "staff", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这个账号自己 —— */
    const existing = await lockStaffForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    // 已移除的记录不再接受编辑：它已经不在名单里，改资料没有任何去向
    if (existing.removedAt !== null) return { kind: "removed" };

    // 唯一性：`exceptId` 排除自己，否则「只改名称、登录名不动」会被自己挡住
    if (await findStaffByUsernameTx(tx, input.username, id)) return { kind: "username-taken" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, "staff", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay" || isStaffProfileUnchanged(existing, input)) {
      return unchanged(existing, replay?.kind === "replay");
    }

    const written = await applyStaffPatchTx(tx, existing, {
      username: input.username.trim(),
      displayName: input.displayName.trim(),
      avatarUrl: input.avatarUrl.trim(),
      updatedAt: ctx.at,
    });
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "staff.update",
        targetType: "staff",
        targetId: id,
        ...staffSnapshots(written.previous, written.updated),
      }),
    );

    return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 启用 / 停用 ─────────────────────────── */

/**
 * 启用或停用一个客服账号 —— `setStaffEnabled` 的 Pg 实现。
 *
 * ⚠️ 已移除的账号不允许再启用（返回 `removed`）：移除是软删除，不是可以来回拨的开关。
 * 重复停用不是错误：已经是目标状态就返回 `changed:false`，不写第二条审计。
 */
export async function setStaffEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "staff", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这个账号自己 —— */
    const existing = await lockStaffForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };
    if (existing.removedAt !== null) return { kind: "removed" };

    /* —— 权威读：锁下重读账本 —— */
    const replay = await takeReplayTx(tx, ctx, "staff", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay" || existing.enabled === enabled) {
      return unchanged(existing, replay?.kind === "replay");
    }

    const written = await applyStaffFlagsTx(tx, existing, {
      enabled,
      // 原样带回，不重新推导：状态变更不该顺手改写移除时间
      removedAt: existing.removedAt,
      updatedAt: ctx.at,
    });
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: enabled ? "staff.enable" : "staff.disable",
        targetType: "staff",
        targetId: id,
        ...staffSnapshots(written.previous, written.updated),
      }),
    );

    return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
  });
}

/* ─────────────────────────── 移除（软删除） ─────────────────────────── */

/**
 * 移除客服账号（**软删除**）—— `removeStaffAccount` 的 Pg 实现。
 *
 * ⚠️ **不删除记录**：只写 `removedAt`，并把 `enabled` 一起置为 false。已移除的账号
 * 仍然可以被查到（`pg/staffRepository.ts` 的读方法都含已移除），也仍然占着它的登录名
 * （唯一索引不排除已移除账号）。
 *
 * 已经移除过：不刷新时间戳、不写第二条审计——重复移除是幂等的，不是错误。
 * ⚠️ 这条路径**没有 `removed` 失败分支**：移除一个已移除的账号是 no-op，不是前置条件失败。
 */
export async function removeStaffAccountPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminStaffWriteResult> {
  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, "staff", id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这个账号自己 —— */
    const existing = await lockStaffForUpdateTx(tx, id);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本 —— */
    const replay = await takeReplayTx(tx, ctx, "staff", id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay" || existing.removedAt !== null) {
      return unchanged(existing, replay?.kind === "replay");
    }

    const written = await applyStaffFlagsTx(tx, existing, {
      enabled: false,
      removedAt: ctx.at,
      updatedAt: ctx.at,
    });
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action: "staff.remove",
        targetType: "staff",
        targetId: id,
        ...staffSnapshots(written.previous, written.updated),
      }),
    );

    return { kind: "ok", value: { ...written.updated }, changed: true, replayed: false };
  });
}
