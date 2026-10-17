import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { applyAdminComplaintIntentPg } from "../lib/data/pg/complaintTransactions.ts";
import { sweepMaturedEarningsPg } from "../lib/data/pg/w1Transactions.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1D · **投诉后台写闭包**的 PostgreSQL 事务验证（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * > 「投诉状态迁移 + 处理信息 + 那一条管理审计，全在一个 `BEGIN…COMMIT` 里。」
 *
 * 投诉处理不写订单、不写退款、不动任何金额——它是本项目里**加锁面最窄**的一条
 * 管理端写路径（只锁 `complaints` 一行）。因此这里要证的**不是**「钱只动一次」，
 * 而是三件更细的事：
 *
 * 1. **字段集合逐列对齐 Mock**：哪个动作写哪几列、哪些列保持原值，
 *    尤其是 `start-processing` **一个字节都不许碰 `result` / `handled_*`**。
 * 2. **状态机在锁下判定**：两个管理员同时动手时最终状态唯一，
 *    另一个拿到的是 `invalid-transition` 而不是覆盖。
 * 3. **审计与业务写入同生共死**：让审计那一句 `INSERT` 故意失败，
 *    断言投诉**回到原样**。没有这一条，「回滚」只是注释里的一厢情愿。
 *
 * ## 为什么必须打真库
 *
 * 用一个假的 Pg client 去测，等于把待证明的那一层替换成断言本身：
 * 无论实现是 `BEGIN` 还是几条 auto-commit，假 client 都会说「对」。
 * 因此这里连 `TEST_DATABASE_URL`，且**没有库时整体 skip 而不是假装通过**。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 与 `pgAdminAuditTransactions.test.mjs` 同一套机制。本文件盯住两张表：
 * `complaints`（业务写入）与 `admin_audit_entries`（本轮唯一的新参与者）。
 * 每次被测事务的写入必须落在**同一条连接**上（`writePids()` 长度 1），
 * 否则 `BEGIN` 开在 A、审计 `INSERT` 落在 B，事务根本不存在，而代码看上去一模一样。
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

/** 被探针盯上的表：这条路径真正会写的两张。 */
const PROBED_TABLES = ["complaints", "admin_audit_entries"];

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

/**
 * 让连接池里先有 `size` 条**空闲**连接。
 *
 * ⚠️ 并发用例的**判别力**前提：池子里只有一条空闲连接时，先发的请求会立刻拿走它跑完
 * 整段事务，后发的还在握手——两个请求**根本没重叠**，被守护的那把行锁即使删掉也照样绿。
 * （PROD-1D 实测到过这种假绿，见 `tests/pgCheckoutTransactions.test.mjs` 的同名说明。）
 *
 * ⚠️ 预热只把重叠概率**显著**提高，本身**不是**确定性的；真正把窗口钉死的是下面
 * `withWideLockWindow()` 挂的 `pg_sleep` 触发器。本文件三条并发用例都已套上它，
 * 与 `tests/pgCheckoutTransactions.test.mjs` / `tests/pgPlatformConfigTransactions.test.mjs`
 * 同款——最初它们只做了预热，判别力弱于另两组，是一处已被修正的不对称。
 */
async function warmPool(size) {
  await Promise.all(Array.from({ length: size }, () => executor().query("SELECT 1")));
}

/**
 * 在 `complaints` 上**临时**挂一个 `BEFORE UPDATE` 的 `pg_sleep` 触发器，把赢家持有
 * 行锁的窗口**确定性**撑开，然后执行 `fn`，无论如何都在 `finally` 里摘掉触发器。
 *
 * 为什么需要它（与 T1 `cc_sleep_probe` 同一条理由）：`applyAdminComplaintIntentPg`
 * 靠 `SELECT … FOR UPDATE` 串行化。两个请求若不重叠，先发的那个会**跑完整段**才轮到
 * 后发的，后发的自然读到新状态——此时把 `FOR UPDATE` 整条删掉，用例**照样绿**，
 * 它测到的其实是「顺序执行」。挂上 `pg_sleep` 后，赢家在**持有行锁**期间被拖住，
 * 输家的读必然落在赢家提交之前，「删掉锁 ⇒ 两个都 ok」这一 mutation 才会如实变红。
 *
 * ⚠️ 触发器是**测试专用**的，只在本文件的三条并发用例内存在，用完即摘；
 * 它不进 `db/migrations/`，不是 schema 的一部分。
 */
async function withWideLockWindow(fn) {
  await executor().query(
    `CREATE OR REPLACE FUNCTION cmp_sleep_probe() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       PERFORM pg_sleep(0.3);
       RETURN NEW;
     END
     $$`,
  );
  await executor().query(
    `CREATE TRIGGER cmp_sleep_trg BEFORE UPDATE ON complaints
       FOR EACH ROW EXECUTE FUNCTION cmp_sleep_probe()`,
  );
  try {
    return await fn();
  } finally {
    await executor().query(`DROP TRIGGER IF EXISTS cmp_sleep_trg ON complaints`);
  }
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

async function readComplaint(id) {
  const rows = await executor().query(`SELECT * FROM complaints WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** 某个目标身上的全部审计，按发生顺序。 */
async function readAudits(targetId) {
  return executor().query(
    `SELECT * FROM admin_audit_entries WHERE target_id = $1 ORDER BY created_at, id`,
    [targetId],
  );
}

async function countRows(table, where = "", values = []) {
  const rows = await executor().query(`SELECT count(*)::int AS n FROM ${table} ${where}`, values);
  return rows[0].n;
}

/**
 * 三条预置投诉，正好覆盖三个可用档位（`lib/mocks/fixtures/complaintSeed.ts`）：
 *
 * | id | 状态 | 能做什么 |
 * |---|---|---|
 * | `cmp-seed-1001-01` | `pending` | 三个动作全都能做 |
 * | `cmp-seed-1001-02` | `processing` | 只能 resolved / closed |
 * | `cmp-seed-1001-03` | `resolved` | 终态 |
 * | `cmp-seed-1001-04` | `closed` | 终态 |
 */
const PENDING = "cmp-seed-1001-01";
const PROCESSING = "cmp-seed-1001-02";
const RESOLVED = "cmp-seed-1001-03";
const CLOSED = "cmp-seed-1001-04";

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

/* ═════════════ 等价 · 三个意图各一条（与 Mock 逐字段对齐） ═════════════ */

test("等价 · 开始处理：pending → processing，只写状态与处理时刻", { skip: SKIP }, async () => {
  const before = await readComplaint(PENDING);
  assert.equal(before.status, "pending");
  assert.equal(before.processing_at, null);
  assert.equal(before.handled_at, null);
  assert.equal(before.result, "", "前提：预置的待处理投诉没有处理结果");

  // ⚠️ 故意传一段文本进去：`start-processing` 必须**忽略**它
  const result = await applyAdminComplaintIntentPg(
    PENDING,
    "start-processing",
    "这段文本不该出现在处理中的记录里",
    ctxOf("op-cmp-start"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.complaint.status, "processing");

  const after = await readComplaint(PENDING);
  assert.equal(after.status, "processing");
  assert.equal(after.processing_at, AT, "开始处理写 processing_at");
  assert.equal(after.updated_at, AT);
  assert.equal(after.handled_at, null, "★ 还没有结论：不写完结时间");
  assert.equal(after.handled_by_id, null, "★ 还没有结论：不写处理人");
  assert.equal(after.handled_by_role, null);
  assert.equal(after.handled_by_name, null);
  assert.equal(after.result, "", "★ 处理中的记录不得带处理结果");
  // 用户提交的原始材料一个字节都不许动
  assert.equal(after.description, before.description);
  assert.equal(after.contact, before.contact);
  assert.equal(JSON.stringify(after.evidence), JSON.stringify(before.evidence));

  const audits = await readAudits(PENDING);
  assert.equal(audits.length, 1, "一次动作一条审计");
  assert.equal(audits[0].action, "complaint.start-processing");
  assert.equal(audits[0].target_type, "complaint");
  assert.equal(audits[0].target_id, PENDING);
  assert.equal(audits[0].operation_id, "op-cmp-start");
  assert.equal(audits[0].created_at, AT);
  assert.equal(audits[0].before.status, "pending");
  assert.equal(audits[0].after.status, "processing");
  assert.equal(audits[0].after.result, "", "审计里也不该出现那段被忽略的文本");

  // ⚠️ 这条断言证明的是「**只有一个** pid」——`BEGIN` 开在 A、某条写入落在 B，
  //    `writePids()` 就会有第二个值。
  assert.equal((await writePids()).length, 1, "全部走同一条连接");
});

test("等价 · 解决：processing → resolved，写处理结果与处理人三件套", { skip: SKIP }, async () => {
  const before = await readComplaint(PROCESSING);
  assert.equal(before.status, "processing");

  const NOTE = "已核实打手确实迟到，已提醒并记录在案。";
  const result = await applyAdminComplaintIntentPg(PROCESSING, "resolve", NOTE, ctxOf("op-cmp-resolve"));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.complaint.status, "resolved");

  const after = await readComplaint(PROCESSING);
  assert.equal(after.status, "resolved");
  assert.equal(after.updated_at, AT);
  assert.equal(after.handled_at, AT);
  assert.equal(after.handled_by_id, "admin-1");
  assert.equal(after.handled_by_role, "admin");
  assert.equal(after.handled_by_name, "管理员一号");
  assert.equal(after.result, NOTE);
  // ⚠️ 这条最容易写错：「解决」**不写** processing_at（Mock 保持原值）。
  //    这一单预置就已经在处理中，因此它必须还是原来那个时刻——
  //    被覆盖成 AT 的话，读的人会以为「开始处理」发生在「出结果」的同一瞬间。
  assert.equal(
    after.processing_at,
    before.processing_at,
    "★ 解决不覆盖原来的开始处理时刻（与 Mock 的「保持原值」同）",
  );

  const audits = await readAudits(PROCESSING);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "complaint.resolve");
  assert.equal(audits[0].operation_id, "op-cmp-resolve");
  assert.equal(audits[0].created_at, AT);
  assert.equal(audits[0].before.status, "processing");
  assert.equal(audits[0].after.status, "resolved");
  assert.equal(audits[0].before.handledById, null);
  assert.equal(audits[0].after.handledById, "admin-1");
  assert.equal(audits[0].after.handledByRole, "admin");
  assert.equal(audits[0].after.result, NOTE);
  // 用户提交的原始材料不进快照（边界 5）：联系方式只觉得「有没有」。
  // 这一条投诉**有**联系方式，因此断言的是「布尔为真、内容不在」
  assert.equal(audits[0].before.hasContact, true);
  assert.equal(
    JSON.stringify(audits[0]).includes("微信同手机号"),
    false,
    "★ 联系方式内容不得进审计",
  );
});

test("状态机 · pending 不能直接解决：必须先进入处理中", { skip: SKIP }, async () => {
  // ⚠️ 这一条把状态机的形状钉下来：`ADMIN_COMPLAINT_TRANSITIONS` 里
  //    `pending: ["processing", "closed"]`——**没有** `resolved`。
  //    「已处理」只能从「处理中」到达，否则无法解释「谁在什么时候开始看的」。
  const result = await applyAdminComplaintIntentPg(PENDING, "resolve", "直接解决", ctxOf("op-cmp-skip"));
  assert.equal(result.kind, "invalid-transition");
  if (result.kind !== "invalid-transition") return;
  assert.equal(result.status, "pending");
  assert.equal((await readComplaint(PENDING)).status, "pending");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("等价 · 关闭：pending → closed，写的是关闭说明", { skip: SKIP }, async () => {
  const NOTE = "用户未补充信息，本次投诉先关闭。";
  const result = await applyAdminComplaintIntentPg(PENDING, "close", NOTE, ctxOf("op-cmp-close"));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.complaint.status, "closed");

  const after = await readComplaint(PENDING);
  assert.equal(after.status, "closed");
  assert.equal(after.handled_at, AT);
  assert.equal(after.handled_by_id, "admin-1");
  assert.equal(after.handled_by_role, "admin");
  assert.equal(after.result, NOTE, "关闭说明与处理结果共用同一个字段");

  const audits = await readAudits(PENDING);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "complaint.close");
  assert.equal(audits[0].before.status, "pending");
  assert.equal(audits[0].after.status, "closed");
});

/* ═════════════ result 只在 resolve / close 写入 ═════════════ */

test("result 只在解决 / 关闭写入：start-processing 传进去的文本不得落库", { skip: SKIP }, async () => {
  const LEAK = "明显不该出现在数据库里的文本-9f2a";
  await applyAdminComplaintIntentPg(PENDING, "start-processing", LEAK, ctxOf("op-cmp-noleak"));

  const after = await readComplaint(PENDING);
  assert.equal(after.result, "", "★ 处理中的记录 result 必须还是空串");

  // 不止 `complaints` 表，整库都不得出现这段文本
  const leaked = await executor().query(`SELECT count(*)::int AS n FROM complaints WHERE result = $1`, [
    LEAK,
  ]);
  assert.equal(leaked[0].n, 0);

  const audits = await readAudits(PENDING);
  assert.equal(audits.length, 1);
  assert.equal(
    JSON.stringify(audits[0]).includes(LEAK),
    false,
    "★ 被忽略的文本连审计也不该进",
  );
});

/* ═════════════ 状态机：非法迁移零写入 ═════════════ */

test("非法迁移：resolved → processing 携带当前状态，且零写入零审计", { skip: SKIP }, async () => {
  const before = await readComplaint(RESOLVED);
  assert.equal(before.status, "resolved");

  const result = await applyAdminComplaintIntentPg(
    RESOLVED,
    "start-processing",
    "",
    ctxOf("op-cmp-invalid-1"),
  );
  assert.equal(result.kind, "invalid-transition");
  if (result.kind !== "invalid-transition") return;
  assert.equal(result.status, "resolved", "★ 携带的是**当前**状态，不是请求的目标状态");
  assert.deepEqual(await writePids(), [], "状态机拒绝时一个字节都不写");

  // 已关闭的单也不能再「解决」
  const second = await applyAdminComplaintIntentPg(CLOSED, "resolve", "再处理一次", ctxOf("op-cmp-invalid-2"));
  assert.equal(second.kind, "invalid-transition");
  if (second.kind !== "invalid-transition") return;
  assert.equal(second.status, "closed");

  const after = await readComplaint(RESOLVED);
  assert.equal(after.status, "resolved", "状态没动");
  assert.equal(JSON.stringify(after), JSON.stringify(before), "整行逐字段不变");
  assert.equal(await countRows("admin_audit_entries"), 0, "失败的迁移不写审计");
});

test("合法迁移：processing → closed 也能过，且不覆盖开始处理时刻", { skip: SKIP }, async () => {
  const before = await readComplaint(PROCESSING);
  assert.equal(before.status, "processing");

  const result = await applyAdminComplaintIntentPg(
    PROCESSING,
    "close",
    "用户已自行解决，本次投诉关闭。",
    ctxOf("op-cmp-from-processing"),
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.complaint.status, "closed");

  const after = await readComplaint(PROCESSING);
  assert.equal(after.processing_at, before.processing_at, "★ 完结不覆盖原来的开始处理时刻");
  assert.equal(after.contact, before.contact, "联系方式仍是原值");
  assert.equal(after.handled_at, AT);
});

/* ═════════════ 幂等：同键重放 / 意图收窄 ═════════════ */

test("幂等 · 同一个键第二次到达是重放：状态不变、只有一条审计、零写入", { skip: SKIP }, async () => {
  await applyAdminComplaintIntentPg(PROCESSING, "resolve", "处理结果甲", ctxOf("op-cmp-replay"));
  await clearWriteLog();

  const again = await applyAdminComplaintIntentPg(
    PROCESSING,
    "resolve",
    "处理结果甲",
    ctxOf("op-cmp-replay", { at: plusMinutes(AT, 30) }),
  );

  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.changed, false, "重放不改动任何数据");
  assert.equal(again.replayed, true);
  assert.equal(again.value.complaint.status, "resolved", "重放返回的是**当前**状态");
  assert.equal(again.value.complaint.updatedAt, AT, "★ 返回的是第一次写入留下的时刻，不是这次传入的");

  assert.deepEqual(await writePids(), [], "重放一个字节都不写（包括不写审计）");
  const after = await readComplaint(PROCESSING);
  assert.equal(after.updated_at, AT, "状态与时刻都没被第二次请求改动");
  assert.equal(after.result, "处理结果甲");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PROCESSING]), 1);
});

test("意图收窄 · 同一个键先开始处理再解决 → operation-conflict，不是安静的 200", { skip: SKIP }, async () => {
  const first = await applyAdminComplaintIntentPg(
    PENDING,
    "start-processing",
    "",
    ctxOf("op-cmp-mixed"),
  );
  assert.equal(first.kind, "ok");

  const conflicted = await applyAdminComplaintIntentPg(
    PENDING,
    "resolve",
    "同一把键换个意图",
    ctxOf("op-cmp-mixed"),
  );
  assert.equal(conflicted.kind, "operation-conflict", "★ 这不是重放：键指向的是另一个意图");

  const after = await readComplaint(PENDING);
  assert.equal(after.status, "processing", "冲突时不动状态");
  assert.equal(after.result, "", "冲突时也不写结果");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PENDING]), 1);
});

test("幂等键用在别的投诉上 → operation-conflict", { skip: SKIP }, async () => {
  await applyAdminComplaintIntentPg(PROCESSING, "resolve", "甲单结果", ctxOf("op-cmp-other-key"));

  const other = await applyAdminComplaintIntentPg(PENDING, "close", "乙单结果", ctxOf("op-cmp-other-key"));
  assert.equal(other.kind, "operation-conflict");
  assert.equal((await readComplaint(PENDING)).status, "pending", "冲突时一个字节都不写");
});

test("投诉不存在 → not-found，零写入", { skip: SKIP }, async () => {
  const result = await applyAdminComplaintIntentPg(
    "cmp-does-not-exist",
    "resolve",
    "查无此单",
    ctxOf("op-cmp-notfound"),
  );
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
  assert.equal(await countRows("admin_audit_entries"), 0);
});

/* ═════════════ 并发：行锁串行化 ═════════════ */

test("并发 · 两个管理员不同键同时开始处理：只有一个成功，最终状态唯一", { skip: SKIP }, async () => {
  await warmPool(2);
  const [a, b] = await withWideLockWindow(() =>
    Promise.all([
      applyAdminComplaintIntentPg(PENDING, "start-processing", "", ctxOf("op-cmp-race-a")),
      applyAdminComplaintIntentPg(PENDING, "start-processing", "", ctxOf("op-cmp-race-b")),
    ]),
  );

  assert.equal([a, b].filter((r) => r.kind === "ok").length, 1, "★ 恰好一个真正迁移了状态");
  assert.equal(
    [a, b].filter((r) => r.kind === "invalid-transition").length,
    1,
    "★ 另一个看到的是「已经在处理中了」，而不是也把它推一遍",
  );
  assert.equal([a, b].filter((r) => r.kind === "ok" && r.changed).length, 1, "★ 只有一个 changed");

  const after = await readComplaint(PENDING);
  assert.equal(after.status, "processing", "★ 最终状态唯一且可解释");
  assert.equal(after.processing_at, AT);
  assert.equal(
    await countRows("admin_audit_entries", "WHERE target_id = $1", [PENDING]),
    1,
    "★ 审计条数与实际发生的状态迁移次数一致",
  );
});

test("并发 · 不同键同时解决：结果文本唯一，只写一次", { skip: SKIP }, async () => {
  await warmPool(2);
  const [a, b] = await withWideLockWindow(() =>
    Promise.all([
      applyAdminComplaintIntentPg(PROCESSING, "resolve", "结果甲", ctxOf("op-cmp-race-r1")),
      applyAdminComplaintIntentPg(PROCESSING, "resolve", "结果乙", ctxOf("op-cmp-race-r2")),
    ]),
  );

  assert.equal([a, b].filter((r) => r.kind === "ok").length, 1);
  assert.equal([a, b].filter((r) => r.kind === "invalid-transition").length, 1);

  const after = await readComplaint(PROCESSING);
  assert.equal(after.status, "resolved");
  assert.ok(["结果甲", "结果乙"].includes(after.result), "结果是其中一次的文本，不是两者拼接");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PROCESSING]), 1);
});

test("并发 · 同一个幂等键：一个执行、一个重放，绝不撞 23505", { skip: SKIP }, async () => {
  await warmPool(2);
  const [a, b] = await withWideLockWindow(() =>
    Promise.all([
      applyAdminComplaintIntentPg(PROCESSING, "resolve", "结果甲", ctxOf("op-cmp-same")),
      applyAdminComplaintIntentPg(PROCESSING, "resolve", "结果甲", ctxOf("op-cmp-same")),
    ]),
  );

  // 两个都必须正常返回——任何一方抛错（23505 / 唯一冲突）就是这条路径坏了
  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal([a, b].filter((r) => r.changed).length, 1, "★ 恰好一个真正执行了迁移");
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PROCESSING]), 1);
});

/* ═════════════ 回滚证明 ═════════════ */

test("回滚 · 审计写不进去 → 投诉状态与处理信息一起回到原样", { skip: SKIP }, async () => {
  const before = await readComplaint(PENDING);

  // 业务表全部**允许**写：只有审计那一句会炸
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => applyAdminComplaintIntentPg(PENDING, "close", "永远不该留下", ctxOf("op-cmp-rollback")),
    /w1-probe/,
  );

  // ★ 这一组断言就是本文件存在的理由：审计写不进去 ⇒ 业务写入一条都不许留下
  const after = await readComplaint(PENDING);
  assert.equal(after.status, "pending", "★ 状态回滚");
  assert.equal(after.handled_at, null, "★ 完结时间回滚");
  assert.equal(after.handled_by_id, null, "★ 处理人回滚");
  assert.equal(after.handled_by_role, null);
  assert.equal(after.result, "", "★ 处理结果回滚");
  assert.equal(after.updated_at, before.updated_at, "★ 更新时刻回滚");
  assert.equal(JSON.stringify(after), JSON.stringify(before), "整行逐字段回到原样");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("回滚 · 同一个键在回滚后重试能成功（失败不留残迹）", { skip: SKIP }, async () => {
  await failWritesOn("admin_audit_entries");
  await assert.rejects(
    () => applyAdminComplaintIntentPg(PENDING, "close", "第一次失败", ctxOf("op-cmp-retry")),
    /w1-probe/,
  );

  // 把探针关掉：回滚之后那把键**没有**留下任何账本记录，因此这次是全新的执行
  await executor().query(`DELETE FROM w1_probe_fail`);
  const retry = await applyAdminComplaintIntentPg(PENDING, "close", "第二次成功", ctxOf("op-cmp-retry"));

  assert.equal(retry.kind, "ok");
  if (retry.kind !== "ok") return;
  assert.equal(retry.changed, true, "★ 不是重放：上一次什么都没留下");
  assert.equal((await readComplaint(PENDING)).status, "closed");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [PENDING]), 1);
});

/* ═════════════ 归属 / 操作者 ═════════════ */

test("操作者 · 客服角色如实落库：handled_by_role = customer_service", { skip: SKIP }, async () => {
  // ActorRole 的取值域只有 admin | customer_service（见 lib/types/actor.ts）——
  // 这里用的是**真实取值**，不是猜的
  const staffCtx = ctxOf("op-cmp-staff", {
    actorId: "staff-2",
    actorRole: "customer_service",
    actorName: "客服二号",
  });

  const result = await applyAdminComplaintIntentPg(PROCESSING, "resolve", "客服已核实。", staffCtx);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  const after = await readComplaint(PROCESSING);
  assert.equal(after.handled_by_id, "staff-2");
  assert.equal(after.handled_by_role, "customer_service", "★ 角色字段必须一起写，否则读的人不知道该去查哪张表");
  assert.equal(after.handled_by_name, "客服二号");

  const audits = await readAudits(PROCESSING);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, "staff-2");
  assert.equal(audits[0].actor_role, "customer_service", "★ 审计记的是客服，不是管理员");
  assert.equal(audits[0].actor_name, "客服二号");
  assert.equal(audits[0].action, "complaint.resolve");
});

test("操作者 · 管理员写入时 handled_by_name 可以为 null（管理员侧没有名称快照）", { skip: SKIP }, async () => {
  const result = await applyAdminComplaintIntentPg(
    PENDING,
    "close",
    "管理员关闭。",
    ctxOf("op-cmp-admin-noname", { actorName: null }),
  );
  assert.equal(result.kind, "ok");
  assert.equal((await readComplaint(PENDING)).handled_by_name, null);
  assert.equal((await readAudits(PENDING))[0].actor_name, null);
});

/* ═════════════ 单连接 ═════════════ */

test("单连接 · 一次成功的处理里所有写入 pid 唯一", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await applyAdminComplaintIntentPg(
    PROCESSING,
    "resolve",
    "单连接检查",
    ctxOf("op-cmp-single"),
  );
  assert.equal(result.kind, "ok");

  const pids = await writePids();
  assert.equal(pids.length, 1, "`BEGIN` 与业务写入 / 审计写入必须走同一条连接");
  // 这条路径只写两张表，各写一次
  const written = await executor().query(
    `SELECT table_name, count(*)::int AS n FROM w1_write_log GROUP BY table_name ORDER BY table_name`,
  );
  assert.deepEqual(
    written.map((row) => [row.table_name, row.n]),
    [
      ["admin_audit_entries", 1],
      ["complaints", 1],
    ],
  );
});

/* ═════════ 跨域真值同源：投诉的写者 ⇄ 订单侧的读者 ═════════ */

/**
 * ## 这一条要证伪什么
 *
 * 「投诉写进了 PostgreSQL、订单侧的读者还在读 Mock（或读的是另一份缓存）」——
 * 那类跨域真值分叉不会以「报错」的形式出现，只会让一笔本该被投诉挡住的收益
 * 照常解冻。
 *
 * 订单侧**唯一**一个回答「这一单现在有没有未完结投诉」的读者是
 * `lib/data/pg/w1Transactions.ts` 的 `readOrderBlockingFacts()`。它目前是私有的，
 * 公开入口只有两个调用它的清扫事务：`sweepCompletionAutoApprovalsPg()`（完成材料
 * 自动通过）与 `sweepMaturedEarningsPg()`（收益到期解冻）。本用例走后者：
 * **同一条订单、同一个 `at`**，在投诉解决的前后各扫一次，断言第二次**立刻**看见变化。
 *
 * ⚠️ 这里刻意**不**自己写一句 `SELECT status FROM complaints` 来「模拟读者的口径」——
 * 那样测到的是测试自己的 SQL，而不是那条真实路径。走公开入口，读者是谁、
 * 读的是哪张表、判据用哪个常量，都由被测代码自己决定。
 */
const CROSS_ORDER = "ord-seed-1001-12";
const CROSS_EARNING = "ern-cmp-cross";

test("跨域 · 解决投诉之后，订单侧的阻塞读者立刻看见（真值同源）", { skip: SKIP }, async () => {
  // 前提：这一单上没有退款申请，也没有别的投诉——阻塞只可能来自我们要解决的那一条
  const refunds = await executor().query(
    `SELECT id FROM refund_requests WHERE order_id = $1`,
    [CROSS_ORDER],
  );
  assert.equal(refunds.length, 0, "前提：这一单没有退款申请（否则阻塞原因不唯一）");
  const complaints = await executor().query(
    `SELECT id, status FROM complaints WHERE order_id = $1 ORDER BY id`,
    [CROSS_ORDER],
  );
  assert.deepEqual(
    complaints.map((row) => [row.id, row.status]),
    [[PROCESSING, "processing"]],
    "前提：这一单恰好挂着一条处理中的投诉（`cmp-seed-1001-02`）",
  );

  const orders = await executor().query(
    `SELECT actual_companion_id FROM orders WHERE id = $1`,
    [CROSS_ORDER],
  );
  assert.ok(orders[0], "前提：这一单存在");
  assert.ok(orders[0].actual_companion_id, "前提：这一单有实际履约的打手");

  // 一笔**已到期**的冻结收益：唯一挡住它解冻的就是那条未完结投诉
  await executor().query(
    `INSERT INTO earnings
       (id, order_id, companion_id, income_amount, status, frozen_at, available_at, withdrawn_at,
        reversed_amount, fine_amount)
     VALUES ($1, $2, $3, 10000, 'frozen', $4, $5, NULL, 0, 0)`,
    [
      CROSS_EARNING,
      CROSS_ORDER,
      orders[0].actual_companion_id,
      plusMinutes(AT, -1440),
      plusMinutes(AT, -1),
    ],
  );

  /* —— ① 解决之前：订单侧的读者看见「未完结的投诉」，解冻被挡住 —— */
  const blocked = await sweepMaturedEarningsPg(AT);
  assert.equal(
    blocked.releasedEarningIds.includes(CROSS_EARNING),
    false,
    "★ 有未完结投诉时，到期的收益不得解冻",
  );
  const stillFrozen = await executor().query(`SELECT status FROM earnings WHERE id = $1`, [
    CROSS_EARNING,
  ]);
  assert.equal(stillFrozen[0].status, "frozen");

  /* —— ② 把这条投诉解决掉（同一个写者，本轮的被测对象） —— */
  const resolved = await applyAdminComplaintIntentPg(
    PROCESSING,
    "resolve",
    "已核实并处理完毕。",
    ctxOf("op-cmp-cross"),
  );
  assert.equal(resolved.kind, "ok");
  if (resolved.kind !== "ok") return;
  assert.equal(resolved.value.complaint.status, "resolved");

  /* —— ③ 同一个 `at`、同一条路径再扫一次：必须**立刻**看见变化 —— */
  const released = await sweepMaturedEarningsPg(AT);
  assert.ok(
    released.releasedEarningIds.includes(CROSS_EARNING),
    "★ 投诉解决提交之后，订单侧的读者必须立刻看到「不再未完结」——" +
      "否则就是投诉写进了数据库、订单侧还在读另一份真值",
  );
  const nowAvailable = await executor().query(`SELECT status FROM earnings WHERE id = $1`, [
    CROSS_EARNING,
  ]);
  assert.equal(nowAvailable[0].status, "available");
});

