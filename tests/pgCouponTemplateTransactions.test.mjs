import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { buildThresholdCouponLabels } from "../lib/constants/coupons.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  createCouponTemplatePg,
  setCouponTemplateEnabledPg,
  updateCouponTemplatePg,
} from "../lib/data/pg/couponTemplateTransactions.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1D · **券模板管理端写闭包**的 PostgreSQL 事务验证（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * > 「券模板的业务写入与它的那一条管理审计**同生共死**。」
 *
 * 与 `pgPlatformConfigTransactions.test.mjs` / `pgComplaintTransactions.test.mjs` 同一族：
 * Mock 侧靠「同一段没有 `await` 的同步代码」把两件事绑在一起，换成数据库之后
 * 必然是两条 SQL，中间让出执行权。唯一正确的替代是**同一个事务**——
 * 审计写不进去，券模板的改动也一个字都不许留。
 *
 * ## 三类用例，每一类都在证伪一件具体的事
 *
 * 1. **等价**：判定顺序、服务端钉死的形态与文案派生、`changed` / `replayed` 的三种口径、
 *    窄写入的列集合，与 `lib/data/couponTemplateTransaction.ts` **逐字段相同**。
 * 2. **并发**：两个管理员同时动手时，最终状态**唯一且可解释**，两次真实改动都不会被
 *    静默覆盖丢失。这里分两族：
 *    - **不同键、同一目标** → 靠 `SELECT … FOR UPDATE` 的行锁串行化；
 *    - **同一个键、同一目标** → 靠「权威读排在取锁之后」（编辑 / 启停），
 *      以及「新建路径 `operationId` 派生的顾问锁」（新建，见下）。
 * 3. **回滚**：让审计那一句 `INSERT` 故意失败，断言它前面的业务写入一条都没留下。
 *
 * ## 为什么必须打真库
 *
 * 用一个假的 Pg client 去测，等于把待证明的那一层替换成断言本身：无论实现是
 * `BEGIN` 还是几条 auto-commit，假 client 都会说「对」。因此这里连 `TEST_DATABASE_URL`，
 * 且**没有库时整体 skip 而不是假装通过**。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 与 `pgW1Transactions.test.mjs` 同一套机制（那份文件头写了两条理由）。
 * 这里盯的是本轮唯一会写的那两张表：`coupon_templates` 与 `admin_audit_entries`。
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

/** 被探针盯上的表：券模板本尊 + 那条必须同生共死的审计。 */
const PROBED_TABLES = ["coupon_templates", "admin_audit_entries"];

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
 * 预热连接池，让它留下 `size` 条**已经建好、可以立刻取用**的空闲连接。
 *
 * ⚠️ 这是并发用例的一部分，不是摆设：如果池子里只有一条空闲连接，`Promise.all`
 * 里先跑的那个会立刻拿到它、跑完整段事务，而后跑的那个还要先做一次 TCP + 认证握手——
 * 结果两个请求**根本没重叠**，一条本该暴露竞态的用例会因为「碰巧串行」而变绿。
 * 预热之后两个请求各自立刻拿到连接、各自的 `BEGIN` 与后续语句真正交错。
 */
async function warmPool(size) {
  await Promise.all(Array.from({ length: size }, () => executor().query("SELECT 1")));
}

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

/** 回表读一条券模板的**原始行**（snake_case），用于断言落库值。 */
async function readCoupon(id) {
  const rows = await executor().query(`SELECT * FROM coupon_templates WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** 一张模板名下的全部领取记录（**原样**，含内部列），用于证明「编辑不追溯」。 */
async function readClaims(couponId) {
  return executor().query(`SELECT * FROM coupon_claims WHERE coupon_id = $1 ORDER BY id`, [
    couponId,
  ]);
}

async function countRows(table, where = "", values = []) {
  const rows = await executor().query(`SELECT count(*)::int AS n FROM ${table} ${where}`, values);
  return rows[0].n;
}

/**
 * 某个目标身上的全部审计。
 *
 * ⚠️ **不依赖这里的顺序**：本文件里的 `ctx.at` 对并发双方是同一个时刻，
 * 于是 `created_at` 相同，`ORDER BY created_at, id` 的兜底是**随机的** id。
 * 因此下面的断言一律从返回值（`previous` / `updated`）反推「谁先谁后」，
 * 只把审计集合当作无序集合来比对。
 */
async function readAudits(targetId) {
  return executor().query(
    `SELECT * FROM admin_audit_entries WHERE target_id = $1 ORDER BY created_at, id`,
    [targetId],
  );
}

/** 一条「原样保存」的编辑入参：六个字段取自现有记录（与编辑白名单一一对应）。 */
function draftOf(coupon, overrides = {}) {
  return {
    name: coupon.name,
    thresholdAmount: coupon.threshold_amount,
    discountAmount: coupon.discount_amount,
    validFrom: coupon.valid_from,
    validTo: coupon.valid_to,
    enabled: coupon.enabled,
    ...overrides,
  };
}

const NEW_DRAFT = {
  name: "暑期新人券（Pg）",
  thresholdAmount: 10_000,
  discountAmount: 1_000,
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: "2026-12-31T15:59:59.000Z",
  enabled: true,
};

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

/* ═══════════════ 新建（createCouponTemplatePg） ═══════════════ */

test("新建 · 等价：形态与文案由服务端钉死、审计一条、建档与改动同一时刻", { skip: SKIP }, async () => {
  // 刻意往 draft 里塞两个**不属于它**的字段：服务端必须无视它们。
  // 客户端提交什么都不能决定这张券的形态与文案（§1 / §3）。
  const result = await createCouponTemplatePg(
    { ...NEW_DRAFT, name: "  暑期新人券（Pg）  ", formKey: "gift", valueLabel: "满 1 减 1" },
    ctxOf("op-ct-create"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.previous, null, "新建时原本不存在，previous 为 null");

  const updated = result.value.updated;
  assert.ok(updated.id.startsWith("cpn_"), `id 应当带 cpn_ 前缀，实际 ${updated.id}`);
  // 形态与文案：服务端钉死 / 派生，调用方塞进来的那份被完全忽略
  assert.equal(updated.formKey, "threshold");
  assert.equal(updated.formLabel, "满减券");
  assert.equal(updated.valueLabel, "满 100 减 10");
  assert.equal(updated.conditionLabel, "全场通用，满 100 元可用");
  assert.equal(updated.name, "暑期新人券（Pg）", "name 必须 trim 后写入");
  assert.equal(updated.createdAt, AT, "建档时刻 = ctx.at");
  assert.equal(updated.updatedAt, AT, "建档与最后改动是同一个时刻");

  // 回表：返回值不是编出来的
  const row = await readCoupon(updated.id);
  assert.ok(row, "新建的记录必须真的在库里");
  assert.equal(row.name, "暑期新人券（Pg）");
  assert.equal(row.form_key, "threshold");
  assert.equal(row.value_label, "满 100 减 10");
  assert.equal(row.created_at, AT);
  assert.equal(await countRows("coupon_templates"), 7, "6 条种子 + 1 条新建");

  const audits = await readAudits(updated.id);
  assert.equal(audits.length, 1, "一次动作一条审计");
  assert.equal(audits[0].action, "coupon.create");
  assert.equal(audits[0].operation_id, "op-ct-create");
  assert.equal(audits[0].target_type, "coupon");
  assert.equal(audits[0].actor_role, "admin");
  assert.equal(audits[0].before, null, "新建的 before 是 null");
  assert.equal(audits[0].after.name, "暑期新人券（Pg）");
  assert.equal(audits[0].after.updatedAt, AT);

  // ⚠️ 这条断言证明的是「**只有一个** pid」——`BEGIN` 开在 A、某条写入落在 B，
  //    `writePids()` 就会有第二个值。它证明不了「这个 pid 就是本次事务那条」，
  //    但「只有一种取值」已经是「同连接」的充分条件（探针由事务自身触发）。
  assert.equal((await writePids()).length, 1, "券模板与审计走同一条连接");
});

test("新建 · 同一个键第二次到达 = 重放：同一个 id、零写入", { skip: SKIP }, async () => {
  const first = await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-replay"));
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;

  await clearWriteLog();

  const again = await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-replay"));
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.changed, false);
  assert.equal(again.replayed, true, "同一个键第二次到达 = 重放");
  assert.equal(again.value.previous, null);
  assert.equal(again.value.updated.id, first.value.updated.id, "重放拿到的是第一次那条记录");

  assert.deepEqual(await writePids(), [], "重放不写任何东西");
  assert.equal(await countRows("coupon_templates"), 7, "没有又建一条");
  assert.equal(await countRows("admin_audit_entries"), 1, "没有又写一条审计");
});

test("新建 · 账本里有、记录却被删了 → not-found，绝不照账本编一条出来", { skip: SKIP }, async () => {
  const first = await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-deleted"));
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;

  await executor().query(`DELETE FROM coupon_templates WHERE id = $1`, [first.value.updated.id]);
  await clearWriteLog();

  const again = await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-deleted"));
  assert.equal(again.kind, "not-found", "审计说的是「当时建过」，不是「它现在还在」");
  assert.deepEqual(await writePids(), [], "失败路径一个字节都不写");
  assert.equal(await countRows("coupon_templates"), 6);
});

/**
 * ## 这一条是**顾问锁存在与否的唯一判别式**
 *
 * 两个**同一个幂等键**的新建请求真并发发出。新建路径上**没有任何一行可以加锁**——
 * 目标 id 是在事务里当场生成的——所以串行化只能靠
 * `createCouponTemplatePg` 事务最前面那句
 * `SELECT pg_advisory_xact_lock(couponCreateLockKey(ctx.operationId))`。
 *
 * ⚠️ **把那一句删掉，这条用例会怎么红**（Phase 10 的 mutation 钩子，已实测）：
 * 两个事务会**双双读到空账本**（`takeCreateReplayTx` 各返回 `null`），于是各自
 * `INSERT` 一条**不同 id** 的券模板（两次 `cpn_${randomUUID()}` 不可能撞），
 * 再各自写审计——两条审计的 `operation_id` 都是 `op-ct-create-same`，
 * 第二条 `INSERT` 会**阻塞等待**第一条提交，然后撞上唯一索引
 * `admin_audit_entries_operation_key` 抛 `23505`。那个事务整段回滚，
 * 它的 Promise **reject**，`Promise.all` 跟着 reject —— 用例在
 * `await Promise.all(...)` 这一行就炸掉，实测错误信息是：
 *
 *     重复键违反唯一约束"admin_audit_entries_operation_key"
 *     detail: 键值"(operation_id)=(op-ct-create-same)" 已经存在
 *
 * 根本走不到下面的断言。也就是说：正确实现的产出是「两个都正常返回、
 * 同一个 id、一行一审计」，而删掉顾问锁的产出是「一个抛唯一冲突」——两者不可能混淆。
 *
 * ⚠️ **但这条 mutation 只有在连接池预热之后才稳定变红**：池子里若只有一条空闲连接，
 * 先跑的那个请求会立刻拿到它并**跑完整段事务**，后跑的那个还在做 TCP 握手——
 * 两个请求根本没重叠，删掉顾问锁也照样绿。因此上面那句 `warmPool(2)` 是这条
 * mutation 钩子的一部分，不是可有可无的装饰（实测：不预热时 1/1 绿，预热后 3/3 红）。
 */
test("并发 · 同一个幂等键新建：恰好一行 / 一条审计，且两次返回**同一个 id**", { skip: SKIP }, async () => {
  // ⚠️ 见 `warmPool` 的注释：池子里必须先有两条空闲连接，否则这两个请求
  //    一个立刻开跑、一个还在建连接，根本不会重叠——那样这条用例就测不到东西。
  await warmPool(2);

  const [a, b] = await Promise.all([
    createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-create-same")),
    createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-create-same")),
  ]);

  // 两个都必须正常返回——任何一方抛错（23505 / 唯一冲突）就是顾问锁那条路径坏了
  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal(
    [a, b].filter((r) => r.changed).length,
    1,
    "★ 恰好一个真正建了记录，另一个必须走重放（两个 changed 说明两边都写了）",
  );
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");

  // ★ 顾问锁把两次调用串行化的直接证据：第二次读到的是第一次写下的账本行，
  //   因此两边**拿到同一个 id**。没有锁的话两边会各建一条、各拿一个 id。
  assert.equal(a.value.updated.id, b.value.updated.id, "★ 两次返回的必须是同一个 id");

  assert.equal(await countRows("coupon_templates"), 7, "★ 只多出一条券模板");
  assert.equal(
    await countRows("admin_audit_entries", "WHERE operation_id = $1", ["op-ct-create-same"]),
    1,
    "★ 只写出一条审计",
  );
  assert.equal(
    await countRows("admin_audit_entries", "WHERE target_id = $1", [a.value.updated.id]),
    1,
  );
  assert.equal((await writePids()).length, 1, "只有胜出的那个事务写过东西");
});

/* ═══════════════ 编辑（updateCouponTemplatePg） ═══════════════ */

test("编辑 · 等价：文案按新金额重派生、窄写入、已发出的 Claim 一个字节不动", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  assert.equal(before.form_key, "threshold");
  const claimsBefore = await readClaims("cpn-mock-new-user");
  assert.ok(claimsBefore.length > 0, "前提：这张券已经被领过（编辑不得回写快照）");

  const draft = draftOf(before, {
    name: "新人立减券（改）",
    thresholdAmount: 20_000,
    discountAmount: 3_000,
  });
  const result = await updateCouponTemplatePg("cpn-mock-new-user", draft, ctxOf("op-ct-update"));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);

  // 文案与新金额是同一份数据的两种呈现（§3）——派生规则只有一处，直接拿它比对
  const expected = buildThresholdCouponLabels(20_000, 3_000);
  assert.equal(result.value.updated.valueLabel, expected.valueLabel);
  assert.equal(result.value.updated.valueLabel, "满 200 减 30");
  assert.equal(result.value.updated.conditionLabel, "全场通用，满 200 元可用");
  assert.equal(result.value.updated.name, "新人立减券（改）");
  assert.equal(result.value.updated.updatedAt, AT);

  // before 是**锁下读到的那一份**，不是事务外的陈旧快照
  assert.equal(result.value.previous.name, before.name);
  assert.equal(result.value.previous.thresholdAmount, before.threshold_amount);
  assert.equal(result.value.previous.updatedAt, before.updated_at);

  // 窄写入：形态与建档时刻不动
  const row = await readCoupon("cpn-mock-new-user");
  assert.equal(row.form_key, "threshold");
  assert.equal(row.form_label, "满减券");
  assert.equal(row.created_at, before.created_at);
  assert.equal(row.valid_from, before.valid_from, "没提交的字段保持原值");
  assert.equal(row.valid_to, before.valid_to);

  // ★ §5「编辑不追溯」：用户手里的券是领取那一刻的冻结快照，一个字节都不许动
  assert.deepEqual(
    await readClaims("cpn-mock-new-user"),
    claimsBefore,
    "★ 已发出的 Claim 必须逐字节不变",
  );

  const audits = await readAudits("cpn-mock-new-user");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "coupon.update");
  assert.equal(audits[0].before.thresholdAmount, 10_000);
  assert.equal(audits[0].after.thresholdAmount, 20_000);
  assert.equal(audits[0].before.updatedAt, before.updated_at);
  assert.equal(audits[0].after.updatedAt, AT);
  assert.equal((await writePids()).length, 1);
});

test("编辑 · 什么都没改：不写数据、不写审计、**也不刷新 updatedAt**", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  await clearWriteLog();

  // 值一个不差地原样提交，只在名字尾巴上加空格——trim 之后仍然算「没改」。
  // ⚠️ 这一次刻意换一个**更晚的时刻**：`updatedAt` 若被刷新，下面就能看出来。
  const result = await updateCouponTemplatePg(
    "cpn-mock-new-user",
    draftOf(before, { name: `${before.name}   ` }),
    ctxOf("op-ct-noop", { at: plusMinutes(AT, 45) }),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, false);
  assert.equal(result.replayed, false, "不是重放：是「提交的值与现状一样」");
  assert.equal(result.value.previous.name, before.name);
  assert.equal(result.value.updated.name, before.name);

  assert.deepEqual(await writePids(), [], "什么都不用做时不写任何东西");
  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.updated_at, before.updated_at, "★ updatedAt 不得被刷新（它是证据字段）");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("编辑 · 非满减券 → not-editable，零写入；但同一张券**可以**被停用（§1 / §5）", { skip: SKIP }, async () => {
  // 折扣券与无门槛券都不参与结算，因此不能编辑、却必须能启停
  for (const id of ["cpn-mock-holiday", "cpn-mock-no-threshold"]) {
    const before = await readCoupon(id);
    assert.notEqual(before.form_key, "threshold", `前提：${id} 不是满减券`);

    await clearWriteLog();
    const rejected = await updateCouponTemplatePg(
      id,
      draftOf(before, { name: "试图改一张不该能改的券" }),
      ctxOf(`op-ct-not-editable-${id}`),
    );
    assert.equal(rejected.kind, "not-editable", `${id} 应当拒绝编辑`);
    assert.deepEqual(await writePids(), [], "拒绝路径一个字节都不写");
    assert.equal((await readCoupon(id)).name, before.name);
    // 按**目标**数，不数全表：循环里的上一轮刚刚合法地写过一条审计
    assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [id]), 0);

    // 同一张券可以被停用：形态不参与结算，但「平台还要不要兑现它」必须能回答
    const disabled = await setCouponTemplateEnabledPg(id, false, ctxOf(`op-ct-disable-${id}`));
    assert.equal(disabled.kind, "ok", `${id} 应当允许停用`);
    if (disabled.kind !== "ok") continue;
    assert.equal(disabled.changed, true);
    assert.equal((await readCoupon(id)).enabled, false);
  }
});

test("编辑 · 目标不存在 → not-found，零写入", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await updateCouponTemplatePg(
    "cpn-does-not-exist",
    draftOf({ name: "x", threshold_amount: 100, discount_amount: 10, valid_from: NEW_DRAFT.validFrom, valid_to: NEW_DRAFT.validTo, enabled: true }),
    ctxOf("op-ct-update-nf"),
  );
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
  assert.equal(await countRows("admin_audit_entries"), 0);
});

/* ═══════════════ 启用 / 停用（setCouponTemplateEnabledPg） ═══════════════ */

test("停用 · 窄写入：只改 enabled 与 updatedAt，名称 / 金额 / 有效期一个不动", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  assert.equal(before.enabled, true);

  const result = await setCouponTemplateEnabledPg(
    "cpn-mock-new-user",
    false,
    ctxOf("op-ct-disable"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.value.previous.enabled, true);
  assert.equal(result.value.updated.enabled, false);
  assert.equal(result.value.updated.updatedAt, AT);

  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.enabled, false);
  assert.equal(after.updated_at, AT);
  assert.equal(after.name, before.name, "窄写入不碰名称");
  assert.equal(after.threshold_amount, before.threshold_amount, "窄写入不碰门槛");
  assert.equal(after.discount_amount, before.discount_amount);
  assert.equal(after.valid_from, before.valid_from);
  assert.equal(after.valid_to, before.valid_to);
  assert.equal(after.value_label, before.value_label);

  const audits = await readAudits("cpn-mock-new-user");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "coupon.disable");
  assert.equal(audits[0].before.enabled, true);
  assert.equal(audits[0].after.enabled, false);
  assert.equal((await writePids()).length, 1);
});

test("启停幂等 · 重复停用不是错误（不写审计）；同一个键第二次 = 重放", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");

  await setCouponTemplateEnabledPg("cpn-mock-new-user", false, ctxOf("op-ct-disable"));
  await clearWriteLog();

  // 「再停用一次一张已停用的券」：换一个键，值也没变 → 什么都不做，但**不是错误**。
  // ⚠️ 这一次刻意换一个**更晚的时刻**：`updatedAt` 若被刷新，下面就能看出来。
  const again = await setCouponTemplateEnabledPg(
    "cpn-mock-new-user",
    false,
    ctxOf("op-ct-disable-again", { at: plusMinutes(AT, 30) }),
  );
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.changed, false);
  assert.equal(again.replayed, false);
  assert.equal(again.value.previous.enabled, false);
  assert.deepEqual(await writePids(), [], "没变就不写任何东西");
  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.updated_at, AT, "★ 第二次没有刷新 updatedAt（仍是第一次那个时刻）");
  assert.equal(await countRows("admin_audit_entries"), 1, "没有第二条审计");
  assert.equal(before.enabled, true, "前提：原记录是启用的");

  // 真正的重放：同一个键再来一次
  const replay = await setCouponTemplateEnabledPg(
    "cpn-mock-new-user",
    false,
    ctxOf("op-ct-disable"),
  );
  assert.equal(replay.kind, "ok");
  if (replay.kind !== "ok") return;
  assert.equal(replay.replayed, true, "同一个键第二次到达 = 重放");
  assert.equal(replay.changed, false);
  assert.equal(await countRows("admin_audit_entries"), 1);
});

test("启用 · 已停用的券可以重新启用，审计记 coupon.enable", { skip: SKIP }, async () => {
  // cpn-mock-disabled 预置就是停用的 gift 券
  const before = await readCoupon("cpn-mock-disabled");
  assert.equal(before.enabled, false);

  const result = await setCouponTemplateEnabledPg(
    "cpn-mock-disabled",
    true,
    ctxOf("op-ct-enable"),
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal((await readCoupon("cpn-mock-disabled")).enabled, true);

  const audits = await readAudits("cpn-mock-disabled");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "coupon.enable");
});

test("启停 · 目标不存在 → not-found，零写入", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await setCouponTemplateEnabledPg("cpn-nope", false, ctxOf("op-ct-enable-nf"));
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

/* ═══════════════ 幂等键冲突（operation-conflict） ═══════════════ */

test("幂等键冲突 · 同一个键用在另一张券上 → operation-conflict，零字节", { skip: SKIP }, async () => {
  const created = await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-mixed"));
  assert.equal(created.kind, "ok");

  const other = await readCoupon("cpn-mock-new-user");
  await clearWriteLog();

  // 同一个键去编辑**另一张**券
  const conflicted = await updateCouponTemplatePg(
    "cpn-mock-new-user",
    draftOf(other, { name: "不该被写进去" }),
    ctxOf("op-ct-mixed"),
  );
  assert.equal(conflicted.kind, "operation-conflict");

  // 同一个键去启停**另一张**券
  const conflictedToggle = await setCouponTemplateEnabledPg(
    "cpn-mock-new-user",
    false,
    ctxOf("op-ct-mixed"),
  );
  assert.equal(conflictedToggle.kind, "operation-conflict");

  assert.deepEqual(await writePids(), [], "冲突时一个字节都不写");
  assert.equal((await readCoupon("cpn-mock-new-user")).name, other.name);
  assert.equal((await readCoupon("cpn-mock-new-user")).enabled, other.enabled);
  assert.equal(await countRows("admin_audit_entries"), 1, "只有最初那次新建的审计");
});

test("幂等键冲突 · 同一个键换了一个操作者 → operation-conflict", { skip: SKIP }, async () => {
  await createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-actor", { actorId: "admin-2" }));
  await clearWriteLog();

  const other = await createCouponTemplatePg(
    NEW_DRAFT,
    ctxOf("op-ct-actor", { actorId: "admin-1" }),
  );
  assert.equal(other.kind, "operation-conflict", "幂等键的收窄包含操作者");
  assert.deepEqual(await writePids(), []);
  assert.equal(await countRows("coupon_templates"), 7);
});

/* ═══════════════ 并发 · **不同键、同一张券**（行锁串行化） ═══════════════ */

/**
 * ## 这一组证明的是 `SELECT … FOR UPDATE` 那把行锁
 *
 * 两个管理员用的是**不同的**幂等键，因此「权威读」两边都读到 `null`，
 * 幂等判定帮不上忙——唯一阻止它们互相覆盖的东西是券模板那一行上的行锁。
 *
 * 断言写成「**两次改动都真的落地、两条审计都在**」，而不是只看最终值：
 * 后者在「后写的那次把前一次静默覆盖掉」时也会通过，而那正是要排除的结局。
 */
test("并发 · 两个不同幂等键同时编辑同一张券：行锁串行化，两次改动都落库", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  // 先让池子里有两条空闲连接，两个请求才**真的**重叠（见 `warmPool` 的注释）
  await warmPool(2);

  const [a, b] = await Promise.all([
    updateCouponTemplatePg(
      "cpn-mock-new-user",
      draftOf(before, { name: "并发改名·甲" }),
      ctxOf("op-ct-race-a"),
    ),
    updateCouponTemplatePg(
      "cpn-mock-new-user",
      draftOf(before, { name: "并发改名·乙" }),
      ctxOf("op-ct-race-b"),
    ),
  ]);

  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回，实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  // ★ 两次都是真变更：两个目标名字互不相同、也都不同于原值
  assert.equal([a, b].filter((r) => r.changed).length, 2, "★ 两次改动都没有被静默吞掉");
  assert.equal([a, b].filter((r) => r.replayed).length, 0, "两个键不同，谁都不是重放");

  // 从返回值反推谁先谁后：**先拿到行锁的那个**看到的是原始值
  const first = [a, b].find((r) => r.value.previous.name === before.name);
  const second = [a, b].find((r) => r !== first);
  assert.ok(first && second, "必然有一个先读、一个后读");
  assert.equal(
    second.value.previous.name,
    first.value.updated.name,
    "★ 后到的那个读到的正是先到的那个写下的值 —— 行锁真的把它们串行化了",
  );

  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.name, second.value.updated.name, "★ 最终值唯一，且等于后提交那一次");
  assert.ok(
    after.name === "并发改名·甲" || after.name === "并发改名·乙",
    `最终值必须可解释，实际 ${after.name}`,
  );
  assert.equal(after.updated_at, AT);
  assert.equal(after.threshold_amount, before.threshold_amount, "两次编辑都只改了名字");

  const audits = await readAudits("cpn-mock-new-user");
  assert.equal(audits.length, 2, "★ 两条审计都在");
  assert.deepEqual(audits.map((row) => row.action), ["coupon.update", "coupon.update"]);
  assert.deepEqual(
    audits.map((row) => row.after.name).sort(),
    [first.value.updated.name, second.value.updated.name].sort(),
    "★ 两次真实改动在审计里各留下一条，没有被覆盖丢失",
  );
  assert.deepEqual(
    audits.map((row) => row.operation_id).sort(),
    ["op-ct-race-a", "op-ct-race-b"],
  );
});

/**
 * ## 启停的并发：为什么这里**不能**硬断言「两条审计」
 *
 * `enable` 与 `disable` 是一对**互斥的目标状态**，而 `setCouponTemplateEnabledPg`
 * 里有一条「已经就是那个状态就什么都不做」的分支。谁先拿到行锁，谁就真的翻转；
 * 后到的那个若在锁下读到的状态**正是**它要的，就正确地空转。两种顺序的结局因此不同，
 * 而**两个都是对的**：
 *
 * | 提交顺序 | 结果 |
 * |---|---|
 * | 先 enable（本就是启用 → 空转），后 disable（真翻转） | 1 条审计，最终 `enabled = false` |
 * | 先 disable（真翻转），后 enable（真翻转） | 2 条审计，最终 `enabled = true` |
 *
 * ⚠️ 把「两条」写死，等于要求上游那条**合法**顺序必须写一条不该写的审计——
 * 那恰好是 `changed: false` 分支存在的理由（「与事实相反的成功」）。
 * 因此这里断言的是**能与事实对上的那条不变量**：
 * **审计条数 === 真实变更次数**，且**最终状态 = 最后一次真实变更写下的状态**。
 * （编辑那一组不同：两次编辑的目标名字互不相同、也与原值不同，
 * 两次都必然是真变更，所以那里可以硬断言两条审计。）
 */
test("并发 · 同时启用与停用同一张券：最终状态唯一、审计与真实变更一一对应", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  assert.equal(before.enabled, true, "前提：这张券是启用的");
  // 先让池子里有两条空闲连接，两个请求才**真的**重叠（见 `warmPool` 的注释）
  await warmPool(2);

  const [a, b] = await Promise.all([
    setCouponTemplateEnabledPg("cpn-mock-new-user", false, ctxOf("op-ct-toggle-a")),
    setCouponTemplateEnabledPg("cpn-mock-new-user", true, ctxOf("op-ct-toggle-b")),
  ]);

  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回，实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  const changed = [a, b].filter((result) => result.changed);
  const after = await readCoupon("cpn-mock-new-user");
  const audits = await readAudits("cpn-mock-new-user");

  // ★ 核心不变量：每一条审计都对应一次真实变更（既没多记，也没丢）
  assert.equal(
    audits.length,
    changed.length,
    `★ 审计条数必须等于真实变更次数，实际审计 ${audits.length} / 变更 ${changed.length}`,
  );
  assert.ok(changed.length === 1 || changed.length === 2, `真实变更次数 ${changed.length}`);

  const flips = changed
    .map((result) => `${result.value.previous.enabled}->${result.value.updated.enabled}`)
    .sort();
  if (changed.length === 2) {
    // 先 disable（true→false）再 enable（false→true）：两次都真的翻转了
    assert.deepEqual(flips, ["false->true", "true->false"]);
    assert.equal(after.enabled, true, "两次都生效 ⇒ 禁用之后又被启用，最终为启用");
  } else {
    // 先 enable（本就是启用 → 空转）再 disable：只有停用是真的
    assert.deepEqual(flips, ["true->false"]);
    assert.equal(after.enabled, false, "只有一次变更 ⇒ 只可能是「停用」赢了");
  }

  // ★ 最终状态唯一，且等于**最后提交**的那次变更写下的值。
  //   从返回值反推谁在最后：两次都变了时，后提交的那次读到的 `previous`
  //   正是前一次写下的结果（这里是 `false`），因此它就是「enable 那一次」。
  const lastWrite =
    changed.length === 2
      ? changed.find((result) => result.value.previous.enabled === false)
      : changed[0];
  assert.ok(lastWrite, "必然能定位到最后一次真实变更");
  assert.equal(after.enabled, lastWrite.value.updated.enabled);
  assert.deepEqual(
    audits.map((row) => row.after.enabled).sort(),
    changed.map((result) => result.value.updated.enabled).sort(),
    "审计里写下的状态集合必须与实际变更的结果集合一致",
  );
  assert.deepEqual(
    audits.map((row) => row.action).sort(),
    changed
      .map((result) => (result.value.updated.enabled ? "coupon.enable" : "coupon.disable"))
      .sort(),
  );
  // 窄写入：无论谁赢，名称与金额都不该被这次启停碰到
  assert.equal(after.name, before.name);
  assert.equal(after.threshold_amount, before.threshold_amount);
});

/* ═══════════════ 回滚探针（Phase 9） ═══════════════ */

test("回滚 · 新建：审计写不进去 → 券模板一条都不留", { skip: SKIP }, async () => {
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => createCouponTemplatePg(NEW_DRAFT, ctxOf("op-ct-rb-create")),
    /w1-probe/,
  );

  assert.equal(
    await countRows("coupon_templates", "WHERE name = $1", [NEW_DRAFT.name]),
    0,
    "★ 业务写入必须与审计一起回滚",
  );
  assert.equal(await countRows("coupon_templates"), 6, "回到种子的 6 条");
  assert.equal(await countRows("admin_audit_entries"), 0);
  assert.deepEqual(await writePids(), [], "★ 整段事务连探针日志都回滚掉了");
});

test("回滚 · 编辑：审计写不进去 → 名称与 updatedAt 都回到改动前", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () =>
      updateCouponTemplatePg(
        "cpn-mock-new-user",
        draftOf(before, { name: "不该被写进去" }),
        ctxOf("op-ct-rb-update"),
      ),
    /w1-probe/,
  );

  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.name, before.name, "★ 名称回滚");
  assert.equal(after.updated_at, before.updated_at, "★ updatedAt 回滚");
  assert.equal(after.value_label, before.value_label);
  assert.equal(await countRows("admin_audit_entries"), 0);
  assert.deepEqual(await writePids(), []);
});

test("回滚 · 停用：审计写不进去 → enabled 回到 true", { skip: SKIP }, async () => {
  const before = await readCoupon("cpn-mock-new-user");
  assert.equal(before.enabled, true);
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => setCouponTemplateEnabledPg("cpn-mock-new-user", false, ctxOf("op-ct-rb-enable")),
    /w1-probe/,
  );

  const after = await readCoupon("cpn-mock-new-user");
  assert.equal(after.enabled, true, "★ 不能出现「审计说停用了、记录却还是启用的」");
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(await countRows("admin_audit_entries"), 0);
  assert.deepEqual(await writePids(), []);
});
