import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { PLATFORM_CONFIG_ID } from "../lib/constants/platformConfig.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { updatePlatformConfigPg } from "../lib/data/pg/platformConfigTransactions.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1D · **平台参数后台写闭包**的 PostgreSQL 事务验证（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * > 「管理员改平台参数」这一次业务写入与它的那一条管理审计**同生共死**。
 *
 * 平台参数的伪事务（`lib/data/adminPlatformConfigTransaction.ts`）在 Mock 里靠
 * 「同一段无 `await` 的同步代码」成立：`writePlatformConfig` 写完，`writeAudit`
 * 紧接着写在同一个区段里。换成数据库后，两件事各自是一条 SQL，中间必然让出执行权，
 * 因此唯一的正确替代是**同一个事务**。本文件证明的就是「它们确实在同一个事务里」——
 * 而不是「代码里写着 `withTransaction`」。
 *
 * ## 三类用例，每一类都在证伪一件具体的事
 *
 * 1. **等价**：判定顺序、no-op / replay 分支的返回值、写入的列集合与 Mock 逐条相同。
 * 2. **并发**：两个管理员同时保存时最终值唯一且可解释，同键则一执行一重放。
 * 3. **回滚**：让审计那一句 `INSERT` **故意失败**，断言平台参数的改动
 *    **一条都没留下**、`updated_at` 未被刷新。这一类是整个文件的重点。
 *
 * ## 为什么必须打真库
 *
 * 用一个假的 Pg client 去测，等于把待证明的那一层替换成断言本身：
 * 无论实现是 `BEGIN` 还是几条 auto-commit，假 client 都会说「对」。
 * 因此这里连 `TEST_DATABASE_URL`，且**没有库时整体 skip 而不是假装通过**。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 与 `pgAdminAuditTransactions.test.mjs` 同一套机制，这里盯的是本轮真正会写的两张表：
 * `platform_config`（业务）与 `admin_audit_entries`（审计）。每次写入必须落在
 * **同一条连接**上（`writePids()` 长度 1），否则 `BEGIN` 开在 A、审计 `INSERT`
 * 落在 B，事务根本不存在，而代码看上去一模一样。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/** 用例时间：与种子同源，见 `pgW1Transactions.test.mjs` 的同名常量。 */
const AT = plusMinutes(getMockSeedNow().toISOString(), 1);

/** 预置的平台参数值（`platformConfigSeed`）：断言「其他字段没被这次写入碰到」时要用。 */
const SEED_CONFIG = {
  exclusivePoolTimeoutMinutes: 10,
  publicPoolTimeoutMinutes: 60,
  completionAutoApprovalMinutes: 10,
  complaintWindowMinutes: 1440,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedByAdminId: null,
};

/** 被探针盯上的表：本轮的写入恰好落在这两张。 */
const PROBED_TABLES = ["platform_config", "admin_audit_entries"];

async function createProbes() {
  const db = executor();
  await db.query(
    `CREATE TABLE IF NOT EXISTS w1_write_log (
       seq         bigserial PRIMARY KEY,
       table_name  text NOT NULL,
       backend_pid integer NOT NULL
     )`,
  );
  await db.query(`CREATE TABLE IF NOT EXISTS w1_probe_fail (table_name text PRIMARY KEY)`);
  await db.query(
    `CREATE OR REPLACE FUNCTION w1_probe() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       INSERT INTO w1_write_log (table_name, backend_pid)
       VALUES (TG_TABLE_NAME, pg_backend_pid());
       IF EXISTS (SELECT 1 FROM w1_probe_fail WHERE table_name = TG_TABLE_NAME) THEN
         RAISE EXCEPTION 'w1-probe: 拒绝写入 %', TG_TABLE_NAME;
       END IF;
       RETURN NEW;
     END
     $$`,
  );
  for (const table of PROBED_TABLES) {
    await db.query(`DROP TRIGGER IF EXISTS w1_probe_trg ON ${table}`);
    await db.query(
      `CREATE TRIGGER w1_probe_trg AFTER INSERT OR UPDATE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION w1_probe()`,
    );
  }
}

/** 让探针在某张表上失败。事务里第一次写这张表时整段回滚。 */
async function failWritesOn(table) {
  await executor().query(`INSERT INTO w1_probe_fail (table_name) VALUES ($1)`, [table]);
}

/** 一次事务里所有写入的 pid 集合。长度 > 1 就是「同一段业务走了多条连接」。 */
async function writePids() {
  const rows = await executor().query(`SELECT DISTINCT backend_pid FROM w1_write_log`);
  return rows.map((row) => row.backend_pid);
}

async function clearWriteLog() {
  await executor().query(`DELETE FROM w1_write_log`);
}

/* ─────────────────────────────── 通用夹具 ─────────────────────────────── */

/** 一次后台写操作的上下文。`operationId` 就是幂等键。 */
function ctxOf(operationId, overrides = {}) {
  return {
    actorId: "admin-1",
    actorRole: "admin",
    actorName: "管理员一号",
    operationId,
    at: AT,
    ...overrides,
  };
}

async function readConfig() {
  const rows = await executor().query(`SELECT * FROM platform_config WHERE id = 1`);
  return rows[0] ?? null;
}

async function countRows(table, where = "", values = []) {
  const rows = await executor().query(`SELECT count(*)::int AS n FROM ${table} ${where}`, values);
  return rows[0].n;
}

/** 某个目标身上的全部审计，按发生顺序。 */
async function readAudits(targetId) {
  return executor().query(
    `SELECT * FROM admin_audit_entries WHERE target_id = $1 ORDER BY created_at, id`,
    [targetId],
  );
}

/**
 * 直接插一条审计（造「这个幂等键已经被别的对象 / 别的操作者用过」的现场）。
 *
 * ⚠️ 这是**夹具**，不是「第二条写入通道」——生产代码里审计只有一个写入口
 * （`appendAuditEntryTx`）。测试里手写 `INSERT` 是为了构造一条本不属于这次请求的
 * 账本记录，走服务层反而造不出来。
 */
async function insertAuditEntry({ id, operationId, actorId, actorRole, targetType, targetId }) {
  await executor().query(
    `INSERT INTO admin_audit_entries
       (id, actor_id, actor_role, actor_name, action, target_type, target_id,
        before, after, operation_id, created_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL, NULL, $7, $8)`,
    [
      id,
      actorId,
      actorRole,
      targetType === "platformConfig" ? "platformConfig.update" : "companion.pause",
      targetType,
      targetId,
      operationId,
      AT,
    ],
  );
}

/* ─────────────────────────────── 生命周期 ─────────────────────────────── */

before(async () => {
  if (!TEST_URL) return;
  await migrate(executor());
  await createProbes();
});

beforeEach(async () => {
  if (!TEST_URL) return;
  await resetDatabase(executor());
  await seedDatabase(executor());
  // 种子写入也会触发探针；用例只关心**被测事务**写了什么
  await clearWriteLog();
});

after(async () => {
  if (!TEST_URL) return;
  await closePool();
});

/* ═══════════════ 等价：单次改动（updatePlatformConfigPg） ═══════════════ */

test("等价 · 改一个字段：值落库、时间戳与操作者被写、恰好一条审计", { skip: SKIP }, async () => {
  const result = await updatePlatformConfigPg(
    { publicPoolTimeoutMinutes: 120 },
    ctxOf("op-pc-basic"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);

  // 返回值：改动前后两份，未提交的字段保持现状
  assert.equal(result.value.previous.publicPoolTimeoutMinutes, 60);
  assert.equal(result.value.updated.publicPoolTimeoutMinutes, 120);
  assert.equal(result.value.updated.complaintWindowMinutes, 1440, "没提交的字段保持现状");
  assert.equal(result.value.updated.updatedAt, AT);
  assert.equal(result.value.updated.updatedByAdminId, "admin-1");

  // 落库：四个时长 + updated_at + updated_by_admin_id
  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 120);
  assert.equal(config.exclusive_pool_timeout_minutes, 10, "★ 窄写入不碰另外三个时长");
  assert.equal(config.completion_auto_approval_minutes, 10);
  assert.equal(config.complaint_window_minutes, 1440);
  assert.equal(config.updated_at, AT);
  assert.equal(config.updated_by_admin_id, "admin-1");

  // 审计：逐字段
  const audits = await readAudits(PLATFORM_CONFIG_ID);
  assert.equal(audits.length, 1, "一次动作一条审计");
  const audit = audits[0];
  assert.equal(audit.action, "platformConfig.update");
  assert.equal(audit.target_type, "platformConfig");
  assert.equal(audit.target_id, PLATFORM_CONFIG_ID);
  assert.equal(audit.operation_id, "op-pc-basic");
  assert.equal(audit.actor_id, "admin-1");
  assert.equal(audit.actor_role, "admin");
  assert.equal(audit.actor_name, "管理员一号");
  assert.equal(audit.created_at, AT);
  // before 是写入前那一份（预置值），after 是写入后那一份
  assert.deepEqual(audit.before, {
    exclusivePoolTimeoutMinutes: 10,
    publicPoolTimeoutMinutes: 60,
    completionAutoApprovalMinutes: 10,
    complaintWindowMinutes: 1440,
    updatedAt: SEED_CONFIG.updatedAt,
    updatedByAdminId: null,
  });
  assert.deepEqual(audit.after, {
    exclusivePoolTimeoutMinutes: 10,
    publicPoolTimeoutMinutes: 120,
    completionAutoApprovalMinutes: 10,
    complaintWindowMinutes: 1440,
    updatedAt: AT,
    updatedByAdminId: "admin-1",
  });

  // ⚠️ 这条断言证明的是「**只有一个** pid」——`BEGIN` 开在 A、审计 `INSERT` 落在 B，
  //    `writePids()` 就会有第二个值。它证明不了「这个 pid 就是本次事务那条」，
  //    但「只有一种取值」已经是「同连接」的充分条件（探针由事务自身触发）。
  assert.equal((await writePids()).length, 1, "业务写入与审计写入走同一条连接");
});

test("等价 · 只改一个字段时其他三个时长与既有 updatedBy 不被本次动作带走", { skip: SKIP }, async () => {
  // 先把配置改成一组「不是预置值」的样子，并留下一个**别的**管理员
  await executor().query(
    `UPDATE platform_config
        SET exclusive_pool_timeout_minutes = 15,
            completion_auto_approval_minutes = 20,
            complaint_window_minutes = 2880,
            updated_by_admin_id = 'admin-9'`,
  );
  await clearWriteLog();

  await updatePlatformConfigPg({ publicPoolTimeoutMinutes: 90 }, ctxOf("op-pc-narrow"));

  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 90);
  assert.equal(config.exclusive_pool_timeout_minutes, 15, "窄写入不碰专属池超时");
  assert.equal(config.completion_auto_approval_minutes, 20, "窄写入不碰自动审核时长");
  assert.equal(config.complaint_window_minutes, 2880, "窄写入不碰投诉窗口");
  assert.equal(config.updated_by_admin_id, "admin-1", "最近一次是这位管理员改的");
});

/* ═══════════════ 幂等：nothingChanged / replay ═══════════════ */

test("等价 · nothingChanged：值与现状完全相同 → 不写、不审计、不刷新 updatedAt", { skip: SKIP }, async () => {
  await clearWriteLog();

  const result = await updatePlatformConfigPg(
    { publicPoolTimeoutMinutes: 60 },
    ctxOf("op-pc-noop"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, false);
  assert.equal(result.replayed, false, "值没变不是重放");
  // 两份是独立的副本，且都过了一遍读边界归一化
  assert.deepEqual(result.value.previous, result.value.updated);
  assert.equal(result.value.updated.publicPoolTimeoutMinutes, 60);
  assert.notEqual(result.value.previous, result.value.updated, "两份必须是不同的对象");

  const config = await readConfig();
  assert.equal(config.updated_at, SEED_CONFIG.updatedAt, "★ updatedAt 不许被刷新");
  assert.equal(config.updated_by_admin_id, null);
  assert.equal(await countRows("admin_audit_entries"), 0, "没改就没有审计");
  assert.deepEqual(await writePids(), [], "什么都没变 → 一个字节都不写");
});

test("等价 · replay：同一个幂等键第二次到达 → 不写、不审计、replayed = true", { skip: SKIP }, async () => {
  await updatePlatformConfigPg({ publicPoolTimeoutMinutes: 120 }, ctxOf("op-pc-replay"));
  await clearWriteLog();

  // 第二次带**不同的值**：它不该生效——这一次的答案是「你刚才已经做过了」
  const again = await updatePlatformConfigPg(
    { publicPoolTimeoutMinutes: 30 },
    ctxOf("op-pc-replay", { at: plusMinutes(AT, 30) }),
  );

  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.changed, false);
  assert.equal(again.replayed, true, "同一个键第二次到达 = 重放");
  // 重放返回的是**当前**配置（第一次写下的那一份），不是这次请求里的 30
  assert.equal(again.value.updated.publicPoolTimeoutMinutes, 120);

  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 120, "重放不改值");
  assert.equal(config.updated_at, AT, "重放不刷新 updatedAt");
  assert.equal(await countRows("admin_audit_entries"), 1, "没有第二条审计");
  assert.deepEqual(await writePids(), [], "重放不写任何东西");
});

/* ═══════════════ 幂等键冲突 ═══════════════ */

test("冲突 · 同一个键被**另一个 targetType**用过 → operation-conflict，零写入", { skip: SKIP }, async () => {
  await insertAuditEntry({
    id: "aud-op-pc-mixed-type",
    operationId: "op-pc-mixed-type",
    actorId: "admin-1",
    actorRole: "admin",
    targetType: "companion",
    targetId: "cp-1",
  });
  await clearWriteLog();

  const result = await updatePlatformConfigPg(
    { publicPoolTimeoutMinutes: 120 },
    ctxOf("op-pc-mixed-type"),
  );

  assert.equal(result.kind, "operation-conflict");
  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 60, "冲突时一个字节都不写");
  assert.equal(config.updated_at, SEED_CONFIG.updatedAt);
  assert.equal(await countRows("admin_audit_entries"), 1, "没有新审计（只有夹具那一条）");
  assert.deepEqual(await writePids(), []);
});

test("冲突 · 同一个键被**另一个操作者**用过 → operation-conflict，零写入", { skip: SKIP }, async () => {
  await insertAuditEntry({
    id: "aud-op-pc-mixed-actor",
    operationId: "op-pc-mixed-actor",
    actorId: "admin-2",
    actorRole: "admin",
    targetType: "platformConfig",
    targetId: PLATFORM_CONFIG_ID,
  });
  await clearWriteLog();

  const result = await updatePlatformConfigPg(
    { publicPoolTimeoutMinutes: 120 },
    ctxOf("op-pc-mixed-actor"),
  );

  assert.equal(result.kind, "operation-conflict", "★ 安静地当成重放会返回与事实相反的成功");
  assert.equal((await readConfig()).public_pool_timeout_minutes, 60);
  assert.equal(await countRows("admin_audit_entries"), 1);
  assert.deepEqual(await writePids(), []);
});

/* ═══════════════ 回滚（本文件最重要的一条） ═══════════════ */

test("回滚 · 审计写不进去 → 平台参数的改动一条都没留下、updated_at 未变", { skip: SKIP }, async () => {
  // 业务表全部**允许**写：只有审计那一句会炸
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => updatePlatformConfigPg({ publicPoolTimeoutMinutes: 999 }, ctxOf("op-pc-rollback")),
    /w1-probe/,
  );

  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 60, "★ 参数改动回滚");
  assert.equal(config.exclusive_pool_timeout_minutes, 10);
  assert.equal(config.updated_at, SEED_CONFIG.updatedAt, "★ updated_at 未被刷新");
  assert.equal(config.updated_by_admin_id, null);
  assert.equal(await countRows("admin_audit_entries"), 0, "审计与业务一起回滚");
  // 探针写入也在同一个事务里，因此回滚后一条都不留
  assert.deepEqual(await writePids(), [], "★ 整段事务一条写入都没留下");
});

/* ═══════════════ 并发 ═══════════════ */

test("并发 · 同一个幂等键：一个执行、一个重放，恰好一条审计", { skip: SKIP }, async () => {
  const [a, b] = await Promise.all([
    updatePlatformConfigPg({ publicPoolTimeoutMinutes: 120 }, ctxOf("op-pc-same")),
    updatePlatformConfigPg({ publicPoolTimeoutMinutes: 120 }, ctxOf("op-pc-same")),
  ]);

  // ⚠️ 这一条断言的是**业务不变量**（一执行一重放、恰好一条审计），
  //    但它**不是**「锁下权威读」的判别式：两个请求带相同的值，即使那条设计被改坏
  //    也会被 `nothingChanged` 兜住。真正的判别式见下面那条「撑开锁窗口」的用例。
  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal([a, b].filter((r) => r.changed).length, 1, "★ 恰好一个真正改了值");
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");

  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, 120, "值只改一次");
  assert.equal(config.updated_at, AT);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PLATFORM_CONFIG_ID]), 1);
});

test("并发 · 两个不同键改同一字段：行锁串行化，最终值唯一可解释、两条审计", { skip: SKIP }, async () => {
  const atA = AT;
  const atB = plusMinutes(AT, 5);

  const [a, b] = await Promise.all([
    updatePlatformConfigPg({ publicPoolTimeoutMinutes: 120 }, ctxOf("op-pc-race-a", { at: atA })),
    updatePlatformConfigPg({ publicPoolTimeoutMinutes: 300 }, ctxOf("op-pc-race-b", { at: atB })),
  ]);
  assert.equal(a.kind, "ok");
  assert.equal(b.kind, "ok");

  const audits = await readAudits(PLATFORM_CONFIG_ID);
  assert.equal(audits.length, 2, "两次不同的操作 = 两条审计");

  // ★ 可解释性：第一条审计的 before 是预置值；另一条的 before **必须**等于前一条的 after。
  //   这条链在任何执行顺序下都成立（不依赖「谁先拿到锁」，只依赖串行化）。
  const first = audits.find((row) => row.before.publicPoolTimeoutMinutes === 60);
  assert.ok(first, "必有一条审计的 before 是预置值 60（第一个拿到锁的那次）");
  const second = audits.find((row) => row !== first);
  assert.equal(
    second.before.publicPoolTimeoutMinutes,
    first.after.publicPoolTimeoutMinutes,
    "★ 第二条的 before 必须等于第一条的 after：两次写入被行锁串成一条链",
  );

  const config = await readConfig();
  assert.equal(config.public_pool_timeout_minutes, second.after.publicPoolTimeoutMinutes);
  assert.equal(config.updated_at, second.created_at, "后一次写入的 ctx.at 就是最终 updated_at");
  assert.equal(config.updated_by_admin_id, "admin-1");
});

/* ═══════════════ 单连接 ═══════════════ */

test("单连接 · 一次调用的所有写入落在同一条连接上", { skip: SKIP }, async () => {
  await updatePlatformConfigPg({ complaintWindowMinutes: 2000 }, ctxOf("op-pc-pid"));

  const rows = await executor().query(
    `SELECT DISTINCT table_name FROM w1_write_log ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.map((row) => row.table_name),
    ["admin_audit_entries", "platform_config"],
    "业务表与审计表都被同一次事务写了",
  );
  assert.equal((await writePids()).length, 1, "BEGIN 与两条写入走同一条连接");
});

/**
 * ## 为什么需要这一条：朴素的同键并发用例**证明不了**「权威读必须在锁后」
 *
 * 上面那条同键用例，两个请求带的是**相同的值**。这带来一个盲区：
 * 即使把「锁下权威读」误删成「只在加锁前读一次」，第二个请求在锁下读到的
 * `previous` 也已经等于它要提交的值，`nothingChanged` 为真 → 它落进 no-op 分支，
 * **照样不写、照样不撞唯一索引**。本轮实测证实：把权威读改回只读一次，
 * 朴素用例仍然全绿——它测不出这条设计有没有被改坏。
 *
 * 因此这一条做两件事把窗口撑开：
 * 1. 两个请求带**不同的值**——第二个若误判成「没做过」就会真的去写，
 *    撞 `admin_audit_entries_operation_key`（`23505`），而那是「一次失败」而非重放；
 * 2. 在 `platform_config` 上加一个**测试专用**的 `BEFORE UPDATE` 触发器做 `pg_sleep`，
 *    让第一个请求**持有行锁**的那段时间足够长，第二个请求的**前置读**必然落在
 *    第一个提交之前（不加这一条时，第二个请求可能因为连接建立较慢而「恰好」排在
 *    提交之后，测试就退化成上面那种无判别力的情形）。触发器在 `finally` 里摘掉。
 *
 * 实测：实现正确时全绿；把锁后的权威读改成 `const replay = pre` 后，本用例以
 * `23505` 失败——它才是这条设计真正的判别式。
 */
test("并发 · 同一个幂等键、**不同**提交值（撑开锁窗口）：一执行一重放，绝不撞 23505", { skip: SKIP }, async () => {
  await executor().query(
    `CREATE OR REPLACE FUNCTION pc_sleep_probe() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       PERFORM pg_sleep(0.3);
       RETURN NEW;
     END
     $$`,
  );
  await executor().query(
    `CREATE TRIGGER pc_sleep_trg BEFORE UPDATE ON platform_config
       FOR EACH ROW EXECUTE FUNCTION pc_sleep_probe()`,
  );

  try {
    const [a, b] = await Promise.all([
      updatePlatformConfigPg({ publicPoolTimeoutMinutes: 120 }, ctxOf("op-pc-window")),
      updatePlatformConfigPg({ publicPoolTimeoutMinutes: 300 }, ctxOf("op-pc-window")),
    ]);

    // 两个都必须正常返回——任何一方抛 `23505` 就是「锁下权威读」被改坏
    assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
    assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
    if (a.kind !== "ok" || b.kind !== "ok") return;

    assert.equal([a, b].filter((r) => r.changed).length, 1, "★ 恰好一个真正改了值");
    assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 另一个必须自认重放");
    // 重放返回的是**赢家**写下的值，不是它自己带的那个
    const winner = [a, b].find((r) => r.changed);
    const loser = [a, b].find((r) => r.replayed);
    assert.equal(loser.value.updated.publicPoolTimeoutMinutes, winner.value.updated.publicPoolTimeoutMinutes);

    const config = await readConfig();
    assert.equal(config.public_pool_timeout_minutes, winner.value.updated.publicPoolTimeoutMinutes);
    assert.equal(
      await countRows("admin_audit_entries", "WHERE target_id = $1", [PLATFORM_CONFIG_ID]),
      1,
      "★ 恰好一条审计",
    );
    assert.equal((await writePids()).length, 1, "只有赢家写了，且走同一条连接");
  } finally {
    await executor().query(`DROP TRIGGER IF EXISTS pc_sleep_trg ON platform_config`);
  }
});
