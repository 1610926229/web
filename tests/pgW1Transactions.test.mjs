import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import {
  acceptDispatchPg,
  approveCompletionPg,
  cancelAcceptedOrderPg,
  directRefundOrderPg,
  releaseOrderByStaffPg,
  rejectCompletionPg,
  replaceOrderCompanionByStaffPg,
  startCompanionOrderPg,
  submitCompletionPg,
  sweepCompletionAutoApprovalsPg,
  sweepExpiredDispatchesPg,
  sweepMaturedEarningsPg,
} from "../lib/data/pg/w1Transactions.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1B · W1 订单写闭包的 **PostgreSQL 事务**验证（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * 「把 Mock 的伪事务换成真事务之后，**同一批业务规则**在并发、幂等、回滚、
 * 持久化四个维度上仍然成立。」因此每个用例都尽量对着**一条**可证伪的断言写，
 * 而不是「跑通了就算过」。
 *
 * ## 为什么必须打真库
 *
 * 伪事务的原子性来自「Node 单线程 + 区段内无 `await`」，事务的原子性来自
 * **数据库**。用一个假的 Pg client 去测，等于把待证明的那一层替换成断言本身——
 * 无论实现是 `BEGIN` 还是三条 auto-commit，假 client 都会说「对」。
 * 因此这里连的是 `TEST_DATABASE_URL`，且**没有库时整体 skip 而不是假装通过**
 * （`SKIP` 的文案里写明缺什么，见同目录 `pgFoundation.test.mjs` 的同一套做法）。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 两件靠读代码「看起来对」、但必须由数据库自己回答的事：
 *
 * 1. **「所有参与者走同一条连接」**（交付规则 7 / 8）。Mock 里这句话没有意义
 *    （只有一个线程）；换成连接池之后，若某一条语句悄悄走了另一条连接，
 *    `BEGIN` 就开在 A、写入落在 B，事务根本不存在——而**代码看上去一模一样**。
 *    这里给每张被写的表挂一个 `AFTER` 触发器，把 `pg_backend_pid()` 记进
 *    `w1_write_log`。一次事务里所有写入的 pid 必须**只有一个值**。
 * 2. **「要么全成、要么全不成」**。让触发器在第 N 条语句上抛错（`w1_probe_fail`），
 *    然后断言前 N−1 条**一条都没留下**。这是唯一能区分「真事务」与
 *    「一串各写各的 auto-commit」的观测——两者的返回值完全一样。
 *
 * ⚠️ 探针是**测试库里的对象**，`resetDatabase()` 会把它们的数据清空、
 * `dropDatabaseObjects()` 会连对象一起删掉。因此它们不构成任何业务 schema。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  // 本文件跑在独立子进程里（node --test 的默认行为），改环境变量不影响别的文件
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/**
 * 用例时间：预置数据的基准时间**之后一分钟**。
 *
 * ⚠️ 不能用 `new Date()`：预置派单的截止时间是「建仓那一刻 + 池超时」算出来的
 * （`buildDispatchSeed` 拿的是 `getMockSeedNow()`），而它是一个**进程内固定**的值。
 * 用真实当前时间去接单，会让「还没到点」这条断言随执行时刻漂移。
 * 与种子同源之后，同一个用例在任何一天跑都得到同样的结论。
 */
const AT = plusMinutes(getMockSeedNow().toISOString(), 1);

/** 被探针盯上的表：W1 事务真正会写的那几张。 */
const PROBED_TABLES = [
  "orders",
  "dispatch_records",
  "notifications",
  "companion_accept_events",
  "completion_submissions",
  "earnings",
  "earning_adjustments",
  "coupon_claims",
  // T4 / T6 / T7 的两张历史表，以及 T5 的服务历史：必须一起被探针盯上，
  // 否则「回滚把退出历史也带走了吗」这句话在测试里无法证伪
  "companion_release_records",
  "companion_service_events",
  // PROD-1C：管理审计也是一次事务里的**业务写入**（Hard Rule 2：
  // 「业务写入与它的那一条审计必须同生共死」）。不盯上它，
  // 「审计写不进去时业务写入是否回滚」这句话在本文件里无法证伪。
  // 断言在 `pgAdminAuditTransactions.test.mjs`（那条事务的宿主文件）。
  "admin_audit_entries",
];

async function createProbes() {
  const db = executor();
  await db.query(
    `CREATE TABLE IF NOT EXISTS w1_write_log (
       seq         bigserial PRIMARY KEY,
       table_name  text NOT NULL,
       backend_pid integer NOT NULL
     )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS w1_probe_fail (table_name text PRIMARY KEY)`,
  );
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

/** 让探针在第 N 条语句上失败。见文件头第 2 条。 */
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

/* ─────────────────────────── 夹具选取 ─────────────────────────── */

/** 公共池里的待接单：`paid` 订单 + `state='public'` 派单。 */
async function findPublicDispatch() {
  const rows = await executor().query(
    `SELECT d.id AS dispatch_id, d.order_id, o.user_id, d.public_deadline_at
       FROM dispatch_records d JOIN orders o ON o.id = d.order_id
      WHERE d.state = 'public' AND o.status = 'paid'
      ORDER BY d.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * 造一张**专属池**待接单：只有 `exclusive_companion_id` 那位能接。
 *
 * ⚠️ 不能「找」：预置数据里 7 张 `paid` 单**全部**停在公共池，
 * 没有任何一张 `paid + exclusive` 的派单。因此这里取一张公共池单，
 * 把派单改造成专属池的样子（订单本身不动）。
 */
async function makeExclusiveDispatch({ companionId = null } = {}) {
  const target = await findPublicDispatch();
  assert.ok(target, "需要一张公共池待接单作为改造对象");
  const owner = companionId ?? (await findAcceptingCompanions({ limit: 1 }))[0].id;
  await executor().query(
    `UPDATE dispatch_records
        SET state = 'exclusive',
            exclusive_companion_id = $2,
            exclusive_entered_at = $3,
            exclusive_deadline_at = $4,
            exclusive_timeout_minutes_snapshot = 15,
            public_pool_entered_at = NULL,
            public_deadline_at = NULL,
            public_timeout_minutes_snapshot = NULL,
            updated_at = $3
      WHERE id = $1`,
    [target.dispatch_id, owner, AT, plusMinutes(AT, 15)],
  );
  return { ...target, exclusive_companion_id: owner };
}

/**
 * 造一张可直接退款的订单：`paid` + 有派单 + **有专属护航**。
 *
 * ⚠️ 必须带护航，不能用公共池的单：退款通知的收件人是**护航的用户账号**
 * （`REFUND_NOTIFICATION_COMPANION_REFUNDED`），而公共池的单还没有人接，
 * 因此它**不会**产生任何通知——拿它去断言「发出了通知」会得到一个假结论。
 *
 * ⚠️ 同样不能「找」：预置数据里没有一张 `paid` 单带专属护航。这里把一张公共池单
 * 改造成「已被指定护航」的样子。被指定的护航必须有 `user_id`——早期资料可能
 * 没有关联用户，那种情况下没有收信地址。
 */
async function findRefundableOrder() {
  const target = await findPublicDispatch();
  assert.ok(target, "需要一张公共池待接单作为改造对象");
  const rows = await executor().query(
    `SELECT id, user_id FROM companions
      WHERE user_id IS NOT NULL AND removed_at IS NULL
      ORDER BY id LIMIT 1`,
  );
  const companion = rows[0];
  assert.ok(companion, "需要一位关联了用户账号的护航");

  await executor().query(`UPDATE orders SET actual_companion_id = $2 WHERE id = $1`, [
    target.order_id,
    companion.id,
  ]);
  await executor().query(
    `UPDATE dispatch_records
        SET state = 'exclusive',
            exclusive_companion_id = $2,
            exclusive_entered_at = $3,
            exclusive_deadline_at = $4,
            exclusive_timeout_minutes_snapshot = 15,
            public_pool_entered_at = NULL,
            public_deadline_at = NULL,
            public_timeout_minutes_snapshot = NULL,
            updated_at = $3
      WHERE id = $1`,
    [target.dispatch_id, companion.id, AT, plusMinutes(AT, 15)],
  );
  return {
    ...target,
    companion_id: companion.id,
    companion_user_id: companion.user_id,
  };
}

/** 能接单的打手（`isCompanionAcceptingOrders` 的三个条件），可排除某位用户自己的账号。 */
async function findAcceptingCompanions({ excludeUserId = null, limit = 3 } = {}) {
  const rows = await executor().query(
    `SELECT id, user_id FROM companions
      WHERE enabled AND available AND removed_at IS NULL
      ORDER BY id`,
  );
  return rows
    .filter((row) => excludeUserId === null || row.user_id !== excludeUserId)
    .slice(0, limit);
}

/**
 * 一位护航中的订单：`serving` + 有实际履约打手。
 *
 * ⚠️ 默认会先**清掉这张单的阻塞事实**（进行中的退款 / 未完结的投诉）。
 * 预置数据里**两张 serving 单各自带着一个**：一张 `reviewing` 的退款、
 * 一张 `pending` 的投诉。这本身是对的——它们让「被阻塞时不得放行」有真实样本；
 * 但测「到期就该放行」时，实现返回空数组是**正确**的，断言却会把它读成失败。
 *
 * ⚠️ 用 DELETE 而不是改成终态：`refund_requests` 对 `order_id` 有唯一索引，
 * 留一条 `cancelled` 仍然占着那个位置，后面想插「进行中的退款」就插不进去。
 * 阻塞判据只看状态，「删掉」与「改成终态」对被测代码是同一件事。
 *
 * `clean: false` 留给需要原样读预置阻塞事实的用例。
 */
async function findServingOrder({ clean = true } = {}) {
  const rows = await executor().query(
    `SELECT id, actual_companion_id, user_id FROM orders
      WHERE status = 'serving' AND actual_companion_id IS NOT NULL
      ORDER BY id LIMIT 1`,
  );
  const order = rows[0] ?? null;
  if (order && clean) {
    await executor().query(`DELETE FROM refund_requests WHERE order_id = $1`, [order.id]);
    await executor().query(`DELETE FROM complaints WHERE order_id = $1`, [order.id]);
  }
  return order;
}

/** 直接插一份待审完成材料。T10 / T11 的输入靠它精确构造，不必先跑一遍 T9。 */
async function insertPendingSubmission({
  id,
  orderId,
  companionId,
  submittedAt = AT,
  snapshotMinutes = 30,
  deadlineAt = plusMinutes(AT, -5),
}) {
  await executor().query(
    `INSERT INTO completion_submissions
       (id, order_id, companion_id, summary, evidence, status,
        submitted_at, auto_approval_minutes_snapshot, auto_approval_deadline_at,
        review_source, reviewed_by_staff_id, reviewed_by_name, reviewed_at, reject_reason, invalidated_at)
     VALUES ($1, $2, $3, '完成材料说明', '[]'::jsonb, 'pending', $4, $5, $6,
             NULL, NULL, NULL, NULL, NULL, NULL)`,
    [id, orderId, companionId, submittedAt, snapshotMinutes, deadlineAt],
  );
}

async function readOrder(id) {
  const rows = await executor().query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readDispatch(id) {
  const rows = await executor().query(`SELECT * FROM dispatch_records WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function countRows(table, where = "", values = []) {
  const rows = await executor().query(`SELECT count(*)::int AS n FROM ${table} ${where}`, values);
  return rows[0].n;
}

/* ────────────── T3 / T4 / T5 / T6 / T7 的夹具 ────────────── */

/** 平台当前的公共池超时（分钟）。断言里**不硬编码 60**，跟着种子走。 */
async function publicPoolTimeoutMinutes() {
  const rows = await executor().query(
    `SELECT public_pool_timeout_minutes AS n FROM platform_config WHERE id = 1`,
  );
  return rows[0].n;
}

/**
 * 一张**专属池已到点**的待接单（T3 转公共池的输入）。
 *
 * ⚠️ 不能拿 `makeExclusiveDispatch` 凑合：那个夹具把截止时间设在 `AT + 15`，
 * 是「还没到点」。超时清扫要的是**已经过去**的截止时间。
 */
async function makeExpiredExclusiveDispatch({ deadlineAt = plusMinutes(AT, -1) } = {}) {
  const target = await findPublicDispatch();
  assert.ok(target, "需要一张公共池待接单作为改造对象");
  const owner = (await findAcceptingCompanions({ limit: 1 }))[0];
  assert.ok(owner, "需要一位能接单的护航");
  await executor().query(
    `UPDATE dispatch_records
        SET state = 'exclusive',
            exclusive_companion_id = $2,
            exclusive_entered_at = $3,
            exclusive_deadline_at = $4,
            exclusive_timeout_minutes_snapshot = 15,
            public_pool_entered_at = NULL,
            public_deadline_at = NULL,
            public_timeout_minutes_snapshot = NULL,
            updated_at = $3
      WHERE id = $1`,
    [target.dispatch_id, owner.id, plusMinutes(deadlineAt, -15), deadlineAt],
  );
  return { ...target, exclusive_companion_id: owner.id, deadline_at: deadlineAt };
}

/** 一张**公共池已到点**的待接单（T3 关池 / 退款的输入）。 */
async function makeExpiredPublicDispatch({ deadlineAt = plusMinutes(AT, -1) } = {}) {
  const target = await findPublicDispatch();
  assert.ok(target, "需要一张公共池待接单");
  await executor().query(
    `UPDATE dispatch_records
        SET public_pool_entered_at = $2, public_deadline_at = $3,
            public_timeout_minutes_snapshot = 60, updated_at = $2
      WHERE id = $1`,
    [target.dispatch_id, plusMinutes(deadlineAt, -60), deadlineAt],
  );
  return { ...target, deadline_at: deadlineAt };
}

/** 一张 `accepted` 订单：订单 + 派单 + 履约人。 */
async function findAcceptedOrder() {
  const rows = await executor().query(
    `SELECT o.id, o.order_no, o.user_id, o.actual_companion_id, o.ever_accepted_at,
            d.id AS dispatch_id
       FROM orders o JOIN dispatch_records d ON d.order_id = o.id
      WHERE o.status = 'accepted' AND o.actual_companion_id IS NOT NULL
        AND d.state = 'accepted'
      ORDER BY o.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** 一张 `serving` 订单：订单 + 派单 + 履约人（`clean` 同 `findServingOrder` 的理由）。 */
async function findServingOrderWithDispatch({ clean = true } = {}) {
  const rows = await executor().query(
    `SELECT o.id, o.order_no, o.user_id, o.actual_companion_id, o.serving_at,
            d.id AS dispatch_id
       FROM orders o JOIN dispatch_records d ON d.order_id = o.id
      WHERE o.status = 'serving' AND o.actual_companion_id IS NOT NULL
      ORDER BY o.id LIMIT 1`,
  );
  const order = rows[0] ?? null;
  if (order && clean) {
    await executor().query(`DELETE FROM refund_requests WHERE order_id = $1`, [order.id]);
    await executor().query(`DELETE FROM complaints WHERE order_id = $1`, [order.id]);
  }
  return order;
}

/** 一位能接单、且**关联了用户账号**的护航（T7 的换人目标）。 */
async function findAcceptingCompanionWithUser({ excludeIds = [] } = {}) {
  const rows = await executor().query(
    `SELECT id, user_id FROM companions
      WHERE enabled AND available AND removed_at IS NULL AND user_id IS NOT NULL
      ORDER BY id`,
  );
  return rows.find((row) => !excludeIds.includes(row.id)) ?? null;
}

async function readReleases(orderId) {
  return executor().query(
    `SELECT * FROM companion_release_records WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
}

/* ─────────────────────────── 生命周期 ─────────────────────────── */

before(async () => {
  if (!TEST_URL) return;
  await migrate(executor());
  await createProbes();
});

beforeEach(async () => {
  if (!TEST_URL) return;
  // 每个用例从「迁移到最新 + 完整预置数据」出发，断言里的数字因此是稳定的
  await resetDatabase(executor());
  await seedDatabase(executor());
  // 种子写入也会触发探针；用例只关心**被测事务**写了什么
  await clearWriteLog();
});

after(async () => {
  if (!TEST_URL) return;
  await closePool();
});

/* ═══════════════════════ T2 · 接单（acceptDispatchPg） ═══════════════════════ */

test("T2 接单成功：派单 / 订单 / 通知 / 接单事件四件事一起落库", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  assert.ok(target, "预置数据里应当有一张公共池待接单");

  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });
  assert.ok(companion, "预置数据里应当有能接单的护航");

  const result = await acceptDispatchPg(target.dispatch_id, {
    companionId: companion.id,
    at: AT,
  });

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.replayed, false, "第一次接单不是重放");
  assert.equal(result.dispatch.state, "accepted");
  assert.equal(result.dispatch.acceptedByCompanionId, companion.id);
  assert.equal(result.dispatch.acceptedVia, "companion");

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actual_companion_id, companion.id);
  // 时间列由 `pool.ts` 统一还原成 ISO 字符串，因此这里比的是字符串，
  // 不需要（也不能）再调 `toISOString()`
  assert.equal(order.accepted_at, result.dispatch.acceptedAt);
  assert.equal(order.ever_accepted_at, result.dispatch.acceptedAt);
  // 接单那一刻写进去的是**公开快照**，不是整条打手记录
  assert.deepEqual(Object.keys(order.companion).sort(), ["avatarUrl", "id", "name"]);
  assert.equal(order.companion.id, companion.id);

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'dispatch'", [target.user_id]),
    1,
    "下单用户收到一条派单通知",
  );
  assert.equal(
    await countRows("companion_accept_events", "WHERE dispatch_id = $1", [target.dispatch_id]),
    1,
    "接单历史留下一条",
  );
});

test("T2 并发接单：两个护航同时抢，恰好一个赢，另一个走 not-open", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const companions = await findAcceptingCompanions({ excludeUserId: target.user_id, limit: 2 });
  assert.equal(companions.length, 2, "并发用例需要两位不同的护航");

  const [a, b] = await Promise.all([
    acceptDispatchPg(target.dispatch_id, { companionId: companions[0].id, at: AT }),
    acceptDispatchPg(target.dispatch_id, { companionId: companions[1].id, at: AT }),
  ]);

  const winners = [a, b].filter((result) => result.kind === "ok");
  const losers = [a, b].filter((result) => result.kind !== "ok");
  assert.equal(winners.length, 1, "恰好一个赢家");
  assert.equal(losers.length, 1);
  // 输的那个看到的不是「重放」——它根本没接上
  assert.equal(losers[0].kind, "not-open");
  assert.equal(winners[0].replayed, false);

  // ⚠️ 这两条才是「赢家只有一个」的**证据**，而不是上面那个返回值：
  //    返回值可能对，而库里留下两条接单历史 / 订单被写了两遍
  assert.equal(
    await countRows("companion_accept_events", "WHERE dispatch_id = $1", [target.dispatch_id]),
    1,
    "只有一条接单历史",
  );
  const order = await readOrder(target.order_id);
  assert.equal(order.actual_companion_id, winners[0].dispatch.acceptedByCompanionId);
});

test("T2 重复接单：同一位护航再点一次是重放，不产生第二条历史", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  const first = await acceptDispatchPg(target.dispatch_id, { companionId: companion.id, at: AT });
  assert.equal(first.kind, "ok");

  await clearWriteLog();
  const second = await acceptDispatchPg(target.dispatch_id, { companionId: companion.id, at: AT });

  assert.equal(second.kind, "ok");
  assert.equal(second.replayed, true, "第二次是重放");
  // 重放之所以必须是「一个字节都不写」：否则会多出一条接单历史，
  // 而接单榜数的正是历史条数——多算一次，且事后无法分辨哪条是假的
  assert.deepEqual(await writePids(), [], "重放没有任何写入");
  assert.equal(
    await countRows("companion_accept_events", "WHERE dispatch_id = $1", [target.dispatch_id]),
    1,
  );
  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'dispatch'", [target.user_id]),
    1,
  );
});

test("T2 到点接单是 expired：截止时间一到就不许再接", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  // 截止时间**等于**入参时刻即算过期（`<=`，与 Mock 同一条边界）
  const late = await acceptDispatchPg(target.dispatch_id, {
    companionId: companion.id,
    at: target.public_deadline_at,
  });
  assert.equal(late.kind, "expired");

  assert.equal((await readDispatch(target.dispatch_id)).state, "public");
  assert.equal((await readOrder(target.order_id)).status, "paid");
});

test("T2 专属池：不是被指定的那位，接不了", { skip: SKIP }, async () => {
  const target = await makeExclusiveDispatch();
  const others = (await findAcceptingCompanions({ limit: 10 })).filter(
    (row) => row.id !== target.exclusive_companion_id,
  );
  assert.ok(others.length > 0, "需要一位不是被指定的护航");

  const result = await acceptDispatchPg(target.dispatch_id, {
    companionId: others[0].id,
    at: AT,
  });
  assert.equal(result.kind, "not-eligible");
  assert.equal((await readDispatch(target.dispatch_id)).state, "exclusive");
});

test("T2 不能接自己下的单", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  // 把一位护航的账号改成下单人：这不是正常业务，而是**把守卫逼到台面上**
  const [companion] = await findAcceptingCompanions();
  // 先把占用这个 user_id 的其它有效护航让开，否则会撞上「一人只能是一位有效护航」的部分唯一索引
  await executor().query(`UPDATE companions SET user_id = NULL WHERE user_id = $1`, [
    target.user_id,
  ]);
  await executor().query(`UPDATE companions SET user_id = $2 WHERE id = $1`, [
    companion.id,
    target.user_id,
  ]);
  await clearWriteLog();

  const result = await acceptDispatchPg(target.dispatch_id, {
    companionId: companion.id,
    at: AT,
  });
  assert.equal(result.kind, "self-order");
  assert.deepEqual(await writePids(), [], "被挡住时一个字节都不写");
});

test("T2 订单已退款就不能接：order-closed", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  // 只把状态改掉，保留金额列——这个用例只问「订单不可接时接单会不会被拦住」
  await executor().query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [target.order_id]);
  await clearWriteLog();

  const result = await acceptDispatchPg(target.dispatch_id, {
    companionId: companion.id,
    at: AT,
  });
  assert.equal(result.kind, "order-closed");
  assert.equal((await readDispatch(target.dispatch_id)).state, "public");
});

test("T2 派单 / 订单 / 通知 / 事件走的是**同一条连接**", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  await acceptDispatchPg(target.dispatch_id, { companionId: companion.id, at: AT });

  const logged = await executor().query(
    `SELECT DISTINCT table_name FROM w1_write_log ORDER BY table_name`,
  );
  assert.deepEqual(
    logged.map((row) => row.table_name),
    ["companion_accept_events", "dispatch_records", "notifications", "orders"],
    "四张表都被写了（顺序无关，集合必须齐）",
  );
  const pids = await writePids();
  assert.equal(pids.length, 1, `一次事务只能有一条连接，实际见到 ${pids.length} 条`);
});

test("T2 中途失败 → 前面的写入全部回滚，一条都不留", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  // ⚠️ 预置数据本身就有通知与接单事件，因此基准只能是「跑之前有多少」，
  //    不能写死 0——写死 0 测的就不是「这次事务没留下东西」，而是种子有几行。
  const notificationsBefore = await countRows("notifications");
  const acceptEventsBefore = await countRows("companion_accept_events");

  // 让**最后一步**（接单事件）失败：此时派单已改、订单已改、通知已插
  await failWritesOn("companion_accept_events");
  await assert.rejects(
    () => acceptDispatchPg(target.dispatch_id, { companionId: companion.id, at: AT }),
    /w1-probe: 拒绝写入 companion_accept_events/,
  );

  assert.equal((await readDispatch(target.dispatch_id)).state, "public", "派单没被改动");
  const order = await readOrder(target.order_id);
  assert.equal(order.status, "paid", "订单没被改动");
  assert.equal(order.actual_companion_id, null);
  assert.equal(await countRows("notifications"), notificationsBefore, "通知没有留下");
  assert.equal(
    await countRows("companion_accept_events"),
    acceptEventsBefore,
    "接单历史没有留下",
  );
});

test("T2 接单结果**跨连接池重建**依然在：不是留在内存里", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const [companion] = await findAcceptingCompanions({ excludeUserId: target.user_id });

  await acceptDispatchPg(target.dispatch_id, { companionId: companion.id, at: AT });

  // `closePool()` 把连接池整个关掉，下次取执行器会建一条全新的连接。
  // 这是单进程内最接近「进程重启」的动作：内存里的一切都没了，只剩库里的行
  await closePool();
  const order = await readOrder(target.order_id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actual_companion_id, companion.id);

  const events = await executor().query(
    `SELECT count(*)::int AS n FROM companion_accept_events WHERE order_id = $1`,
    [target.order_id],
  );
  assert.equal(events[0].n, 1);
});

/* ══════════════════ T9 · 提交完成材料（submitCompletionPg） ══════════════════ */

test("T9 提交完成材料：冻结自动审核截止时间，写回读到的值与写进去的一致", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  const result = await submitCompletionPg({
    companionId: order.actual_companion_id,
    orderId: order.id,
    summary: "已完成护航并截图留证",
    evidence: [],
    at: AT,
  });

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  const rows = await executor().query(
    `SELECT * FROM completion_submissions WHERE id = $1`,
    [result.submissionId],
  );
  const row = rows[0];
  assert.equal(row.status, "pending");
  // ⚠️ 这一条是「截止时间往返无损」：算出来的、写进去的、读回来的必须是同一个时刻
  assert.equal(row.auto_approval_deadline_at, result.autoApprovalDeadlineAt);
  assert.equal(
    row.auto_approval_deadline_at,
    plusMinutes(AT, row.auto_approval_minutes_snapshot),
    "截止时间 = 提交时刻 + 冻结下来的快照",
  );
});

test("T9 不是当前履约打手 → not-found（不泄露「这一单存在且已开始服务」）", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  const others = (await findAcceptingCompanions({ limit: 10 })).filter(
    (row) => row.id !== order.actual_companion_id,
  );
  assert.ok(others.length > 0);

  const result = await submitCompletionPg({
    companionId: others[0].id,
    orderId: order.id,
    summary: "这不是我的单",
    evidence: [],
    at: AT,
  });
  // 与「订单根本不存在」同一个返回值：外人无法用它试探订单状态
  assert.equal(result.kind, "not-found");
});

test("T9 订单不在 serving → not-serving，且不写任何东西", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await executor().query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
  await clearWriteLog();

  const result = await submitCompletionPg({
    companionId: order.actual_companion_id,
    orderId: order.id,
    summary: "已完成护航并截图留证",
    evidence: [],
    at: AT,
  });
  assert.equal(result.kind, "not-serving");
  assert.deepEqual(await writePids(), []);
});

test("T9 已有待审材料 → pending-exists，且只可能有一份 pending", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-existing",
    orderId: order.id,
    companionId: order.actual_companion_id,
  });

  const result = await submitCompletionPg({
    companionId: order.actual_companion_id,
    orderId: order.id,
    summary: "再交一份试试",
    evidence: [],
    at: AT,
  });
  assert.equal(result.kind, "pending-exists");
  assert.equal(
    await countRows("completion_submissions", "WHERE order_id = $1 AND status = 'pending'", [order.id]),
    1,
  );
});

/* ═══════════════ T10 · 人工通过 / 驳回（approve & reject） ═══════════════ */

test("T10 人工通过：订单转 completed、投诉窗口冻结、生成一条 frozen 收益", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t10-ok",
    orderId: order.id,
    companionId: order.actual_companion_id,
  });

  const result = await approveCompletionPg({
    submissionId: "cs-t10-ok",
    staffId: "admin-1",
    staffName: "客服一号",
    at: AT,
  });
  assert.equal(result.kind, "ok");

  const settled = await readOrder(order.id);
  assert.equal(settled.status, "completed");
  assert.equal(settled.completed_at, AT);
  assert.equal(
    settled.complaint_deadline_at,
    plusMinutes(AT, settled.complaint_window_minutes_snapshot),
    "投诉截止 = 完成时刻 + 冻结的窗口快照",
  );

  const earnings = await executor().query(`SELECT * FROM earnings WHERE order_id = $1`, [order.id]);
  assert.equal(earnings.length, 1, "一个订单至多一条收益");
  assert.equal(earnings[0].status, "frozen");
  // 金额**直接搬订单快照**，不重算：改了比例也不会让这一单的收益变
  assert.equal(earnings[0].income_amount, settled.companion_base_income);
  assert.equal(earnings[0].available_at, settled.complaint_deadline_at);

  const submission = await executor().query(
    `SELECT * FROM completion_submissions WHERE id = 'cs-t10-ok'`,
  );
  assert.equal(submission[0].status, "approved");
  assert.equal(submission[0].review_source, "staff");
});

test("T10 通过是幂等的：第二次是重放，不刷新时间、不建第二条收益", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t10-replay",
    orderId: order.id,
    companionId: order.actual_companion_id,
  });

  await approveCompletionPg({ submissionId: "cs-t10-replay", staffId: "admin-1", staffName: "客服一号", at: AT });

  const later = plusMinutes(AT, 90);
  await clearWriteLog();
  const second = await approveCompletionPg({
    submissionId: "cs-t10-replay",
    staffId: "admin-9",
    staffName: "另一个客服",
    at: later,
  });

  assert.equal(second.kind, "replayed");
  assert.deepEqual(await writePids(), [], "重放不写任何东西");
  assert.equal((await readOrder(order.id)).completed_at, AT, "完成时刻不被刷新");
  assert.equal(await countRows("earnings", "WHERE order_id = $1", [order.id]), 1);
  // 审核人也不被后来的人顶掉：谁做的决定就是谁
  const submission = await executor().query(
    `SELECT reviewed_by_staff_id FROM completion_submissions WHERE id = 'cs-t10-replay'`,
  );
  assert.equal(submission[0].reviewed_by_staff_id, "admin-1");
});

test("T10 换人后的旧材料通过不了：stale-submission", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  const others = (await findAcceptingCompanions({ limit: 10 })).filter(
    (row) => row.id !== order.actual_companion_id,
  );
  await insertPendingSubmission({
    id: "cs-t10-stale",
    orderId: order.id,
    companionId: order.actual_companion_id,
  });
  // 订单换了履约打手：那份旧材料不再代表这一单
  await executor().query(`UPDATE orders SET actual_companion_id = $2 WHERE id = $1`, [
    order.id,
    others[0].id,
  ]);
  await clearWriteLog();

  const result = await approveCompletionPg({
    submissionId: "cs-t10-stale",
    staffId: "admin-1",
    staffName: "客服一号",
    at: AT,
  });
  assert.equal(result.kind, "stale-submission");
  assert.deepEqual(await writePids(), []);
  assert.equal((await readOrder(order.id)).status, "serving");
});

test("T10 驳回：不动订单，且重复驳回不覆盖第一次的原因", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t10-reject",
    orderId: order.id,
    companionId: order.actual_companion_id,
  });

  const first = await rejectCompletionPg({
    submissionId: "cs-t10-reject",
    staffId: "admin-1",
    staffName: "客服一号",
    rejectReason: "截图看不清",
    at: AT,
  });
  assert.equal(first.kind, "ok");

  const second = await rejectCompletionPg({
    submissionId: "cs-t10-reject",
    staffId: "admin-2",
    staffName: "客服二号",
    rejectReason: "换一个理由",
    at: plusMinutes(AT, 30),
  });
  assert.equal(second.kind, "replayed");

  const rows = await executor().query(
    `SELECT status, reject_reason, review_source FROM completion_submissions WHERE id = 'cs-t10-reject'`,
  );
  assert.equal(rows[0].status, "rejected");
  assert.equal(rows[0].reject_reason, "截图看不清", "第一次的驳回原因不被覆盖");
  assert.equal(rows[0].review_source, "staff");
  // 驳回不改订单：打手可以重新提交并重新计时
  assert.equal((await readOrder(order.id)).status, "serving");
  assert.equal(await countRows("earnings", "WHERE order_id = $1", [order.id]), 0);
});

/* ═══════════ T11 · 到期自动通过（sweepCompletionAutoApprovalsPg） ═══════════ */

test("T11 到期自动通过：记 system 来源、没有审核人，并完成结算", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t11-due",
    orderId: order.id,
    companionId: order.actual_companion_id,
    deadlineAt: plusMinutes(AT, -5),
  });

  const result = await sweepCompletionAutoApprovalsPg(AT);
  assert.deepEqual(result.autoApprovedSubmissionIds, ["cs-t11-due"]);

  const rows = await executor().query(
    `SELECT * FROM completion_submissions WHERE id = 'cs-t11-due'`,
  );
  assert.equal(rows[0].status, "approved");
  assert.equal(rows[0].review_source, "system");
  // ⚠️ System 自动通过**绝不伪装成 staff**：没有审核人是这条事实的一部分
  assert.equal(rows[0].reviewed_by_staff_id, null);
  assert.equal(rows[0].reviewed_by_name, null);

  assert.equal((await readOrder(order.id)).status, "completed");
  assert.equal(await countRows("earnings", "WHERE order_id = $1", [order.id]), 1);
});

test("T11 没到点的不扫；重复扫已通过的不再动", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t11-not-due",
    orderId: order.id,
    companionId: order.actual_companion_id,
    deadlineAt: plusMinutes(AT, 30),
  });

  assert.deepEqual((await sweepCompletionAutoApprovalsPg(AT)).autoApprovedSubmissionIds, []);

  // 把截止推到现在之前，再扫一次 → 通过；再扫第三次必须什么也不做
  await executor().query(
    `UPDATE completion_submissions SET auto_approval_deadline_at = $1 WHERE id = 'cs-t11-not-due'`,
    [plusMinutes(AT, -1)],
  );
  assert.deepEqual((await sweepCompletionAutoApprovalsPg(AT)).autoApprovedSubmissionIds, [
    "cs-t11-not-due",
  ]);

  await clearWriteLog();
  assert.deepEqual((await sweepCompletionAutoApprovalsPg(AT)).autoApprovedSubmissionIds, []);
  assert.deepEqual(await writePids(), []);
  assert.equal(await countRows("earnings", "WHERE order_id = $1", [order.id]), 1);
});

test("T11 有进行中的退款时不自动通过：阻塞判据真的生效", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertPendingSubmission({
    id: "cs-t11-blocked",
    orderId: order.id,
    companionId: order.actual_companion_id,
    deadlineAt: plusMinutes(AT, -5),
  });
  // 插一条「进行中」的退款申请。`refund_requests` 对 `order_id` 有唯一索引，
  // 因此这一单在预置数据里必然还没有退款记录
  // ⚠️ `review_note` 与 `evidence` 是 NOT NULL：前者未决策时写空串，后者写空数组。
  //    `decision` 未决策时是 **NULL**，不是零值决策。
  await executor().query(
    `INSERT INTO refund_requests
       (id, refund_no, user_id, order_id, status, amount, decision,
        reason_key, reason_label, description, evidence, idempotency_key,
        created_at, updated_at, reviewing_at, reviewed_at,
        reviewed_by, reviewed_by_role, reviewed_by_name, review_note, cancelled_at)
     SELECT 'rf-t11', 'RF-T11', o.user_id, o.id, 'pending', o.actual_paid_amount, NULL,
            'other', '其它原因', '测试用进行中的退款申请', '[]'::jsonb, NULL,
            $2, $2, NULL, NULL, NULL, NULL, NULL, '', NULL
       FROM orders o WHERE o.id = $1`,
    [order.id, AT],
  );

  assert.deepEqual((await sweepCompletionAutoApprovalsPg(AT)).autoApprovedSubmissionIds, []);
  assert.equal((await readOrder(order.id)).status, "serving");
  assert.equal(await countRows("earnings", "WHERE order_id = $1", [order.id]), 0);
});

/* ══════════ T13 · 收益到期解冻（sweepMaturedEarningsPg） ══════════ */

/** 直接造一条 frozen 收益，精确控制到期时间与冲回额。 */
async function insertFrozenEarning({
  id,
  orderId,
  companionId,
  incomeAmount = 10_000,
  reversedAmount = 0,
  availableAt,
}) {
  await executor().query(
    `INSERT INTO earnings
       (id, order_id, companion_id, income_amount, status, frozen_at, available_at, withdrawn_at,
        reversed_amount, fine_amount)
     VALUES ($1, $2, $3, $4, 'frozen', $5, $6, NULL, $7, 0)`,
    [id, orderId, companionId, incomeAmount, plusMinutes(AT, -1440), availableAt, reversedAmount],
  );
}

test("T13 到期且无阻塞 → 解冻为可提现", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertFrozenEarning({
    id: "ern-t13-ok",
    orderId: order.id,
    companionId: order.actual_companion_id,
    availableAt: plusMinutes(AT, -1),
  });

  const result = await sweepMaturedEarningsPg(AT);
  assert.deepEqual(result.releasedEarningIds, ["ern-t13-ok"]);

  const rows = await executor().query(`SELECT status FROM earnings WHERE id = 'ern-t13-ok'`);
  assert.equal(rows[0].status, "available");
});

test("T13 被退款冲光的收益**不解冻**：时间到了但钱已经没了", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertFrozenEarning({
    id: "ern-t13-zero",
    orderId: order.id,
    companionId: order.actual_companion_id,
    incomeAmount: 10_000,
    reversedAmount: 10_000,
    availableAt: plusMinutes(AT, -1),
  });

  assert.deepEqual((await sweepMaturedEarningsPg(AT)).releasedEarningIds, []);
  const rows = await executor().query(`SELECT status FROM earnings WHERE id = 'ern-t13-zero'`);
  // P0-15：整笔冲销**不改状态**，它停在 frozen，靠净额闸拦住释放
  assert.equal(rows[0].status, "frozen");
});

test("T13 有未完结投诉时不解冻；重复扫不重复释放", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await insertFrozenEarning({
    id: "ern-t13-hold",
    orderId: order.id,
    companionId: order.actual_companion_id,
    availableAt: plusMinutes(AT, -1),
  });
  // ⚠️ `type_label` / `description` / `contact` / `result` 都是 NOT NULL：
  //    用户提交的说明在 `description`，处理结果在 `result`，两者永不互相覆盖。
  await executor().query(
    `INSERT INTO complaints
       (id, complaint_no, user_id, order_id, order_no, status, type_key, type_label,
        description, evidence, contact, idempotency_key,
        created_at, updated_at, processing_at, handled_at,
        handled_by_id, handled_by_role, handled_by_name, result)
     SELECT 'cp-t13', 'CP-T13', o.user_id, o.id, o.order_no, 'pending', 'other', '其它问题',
            '测试用的未完结投诉', '[]'::jsonb, '测试联系方式', NULL,
            $2, $2, NULL, NULL, NULL, NULL, NULL, ''
       FROM orders o WHERE o.id = $1`,
    [order.id, AT],
  );

  assert.deepEqual((await sweepMaturedEarningsPg(AT)).releasedEarningIds, []);

  // 撤掉投诉（改成已完结）之后就该放行，且只放一次
  await executor().query(`UPDATE complaints SET status = 'resolved' WHERE id = 'cp-t13'`);
  assert.deepEqual((await sweepMaturedEarningsPg(AT)).releasedEarningIds, ["ern-t13-hold"]);

  await clearWriteLog();
  assert.deepEqual((await sweepMaturedEarningsPg(AT)).releasedEarningIds, []);
  assert.deepEqual(await writePids(), []);
});

/* ═════════════ T12 · 直接全额退款（directRefundOrderPg） ═════════════ */

test("T12 直接退款：订单退满、派单关闭、护航收到一条通知", { skip: SKIP }, async () => {
  const target = await findRefundableOrder();
  assert.ok(target, "预置数据里应当有一张可退款的专属待接单");

  const result = await directRefundOrderPg(target.order_id, AT);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.previousStatus, "paid");
  assert.equal(result.dispatchClosed, true);
  assert.equal(result.notifiedCompanionUserId, target.companion_user_id);

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "refunded");
  assert.equal(order.refunded_amount, order.actual_paid_amount, "退的是剩余可退额，退满");
  assert.equal(order.refunded_at, AT);

  assert.equal((await readDispatch(target.dispatch_id)).state, "timed_out", "派单被关闭");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'refund'", [
      target.companion_user_id,
    ]),
    1,
    "护航收到一条退款通知",
  );
});

test("T12 重复退款：已经是终态，一个字节都不写", { skip: SKIP }, async () => {
  const target = await findRefundableOrder();
  await directRefundOrderPg(target.order_id, AT);

  await clearWriteLog();
  const second = await directRefundOrderPg(target.order_id, plusMinutes(AT, 10));
  assert.equal(second.kind, "already-refunded");
  assert.deepEqual(await writePids(), []);
  assert.equal((await readOrder(target.order_id)).refunded_at, AT, "退款时刻不被刷新");
});

test("T12 并发退款：两个请求只出一次款", { skip: SKIP }, async () => {
  const target = await findRefundableOrder();

  const [a, b] = await Promise.all([
    directRefundOrderPg(target.order_id, AT),
    directRefundOrderPg(target.order_id, AT),
  ]);
  const succeeded = [a, b].filter((result) => result.kind === "ok");
  assert.equal(succeeded.length, 1, "恰好一个真正执行了退款");
  assert.equal([a, b].filter((r) => r.kind === "already-refunded").length, 1);

  const order = await readOrder(target.order_id);
  assert.equal(order.refunded_amount, order.actual_paid_amount);
  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'refund'", [
      target.companion_user_id,
    ]),
    1,
    "只发出一条退款通知",
  );
});

test("T12 已开始服务的单不能走直接退款：not-eligible", { skip: SKIP }, async () => {
  const order = await findServingOrder();
  await clearWriteLog();

  const result = await directRefundOrderPg(order.id, AT);
  assert.equal(result.kind, "not-eligible");
  assert.deepEqual(await writePids(), []);
});

test("T12 实付为 0 时不谎报「已全额退款」，而是 amount-invalid", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  // `actual_paid_amount = original − coupon_discount`，把三者一起改成 0 才不违反 CHECK
  await executor().query(
    `UPDATE orders SET original_amount = 0, coupon_discount_amount = 0, actual_paid_amount = 0,
            companion_base_income = 0, club_net_income = 0
      WHERE id = $1`,
    [target.order_id],
  );

  const result = await directRefundOrderPg(target.order_id, AT);
  assert.equal(result.kind, "amount-invalid");
  assert.equal((await readOrder(target.order_id)).status, "paid", "订单原地不动");
});

test("T12 没被承接过的单退款时把券还回去", { skip: SKIP }, async () => {
  // 找一张「paid、从未被承接、且用了券」的单。用券的预置样本不一定存在，
  // 因此这里**自己造一个**：挑一张从未被承接的 paid 单，把一张已使用的券挂上去
  const rows = await executor().query(
    `SELECT id, user_id FROM orders
      WHERE status = 'paid' AND ever_accepted_at IS NULL
      ORDER BY id LIMIT 1`,
  );
  const order = rows[0];
  assert.ok(order, "预置数据里应当有一张从未被承接的待接单");

  const claimRows = await executor().query(`SELECT id FROM coupon_claims ORDER BY id LIMIT 1`);
  const claimId = claimRows[0].id;
  await executor().query(
    `UPDATE coupon_claims SET user_id = $2, status = 'used', used_at = $3 WHERE id = $1`,
    [claimId, order.user_id, AT],
  );
  await executor().query(`UPDATE orders SET coupon = jsonb_build_object('claimId', $2::text) WHERE id = $1`, [
    order.id,
    claimId,
  ]);

  const result = await directRefundOrderPg(order.id, AT);
  assert.equal(result.kind, "ok");

  const claim = await executor().query(`SELECT status, used_at FROM coupon_claims WHERE id = $1`, [
    claimId,
  ]);
  assert.equal(claim[0].status, "unused", "券回到未使用");
  assert.equal(claim[0].used_at, null);
});

test("T12 被承接过的单退款时**不**还券（哪怕它现在停在 paid）", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const claimRows = await executor().query(`SELECT id FROM coupon_claims ORDER BY id LIMIT 1`);
  const claimId = claimRows[0].id;
  await executor().query(
    `UPDATE coupon_claims SET user_id = $2, status = 'used', used_at = $3 WHERE id = $1`,
    [claimId, target.user_id, AT],
  );
  // 「曾经被承接」这一列是唯一的判据：状态回到 paid 不抹掉这段历史
  await executor().query(
    `UPDATE orders SET coupon = jsonb_build_object('claimId', $2::text), ever_accepted_at = $3
      WHERE id = $1`,
    [target.order_id, claimId, plusMinutes(AT, -30)],
  );

  const result = await directRefundOrderPg(target.order_id, AT);
  assert.equal(result.kind, "ok");
  const claim = await executor().query(`SELECT status FROM coupon_claims WHERE id = $1`, [claimId]);
  assert.equal(claim[0].status, "used", "券不该被还回去");
});

test("T12 退款中途失败 → 订单 / 派单 / 券全部回滚", { skip: SKIP }, async () => {
  // ⚠️ 必须用**带护航**的单：公共池的单没有收信人，压根不会写 `notifications`，
  //    于是探针没有可以失败的语句，`assert.rejects` 会以「没有抛错」告败。
  const target = await findRefundableOrder();
  const notificationsBefore = await countRows("notifications");
  await failWritesOn("notifications");

  await assert.rejects(
    () => directRefundOrderPg(target.order_id, AT),
    /w1-probe: 拒绝写入 notifications/,
  );

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "paid", "订单没有变成 refunded");
  assert.equal(order.refunded_amount, 0);
  assert.equal(order.refunded_at, null);
  assert.equal((await readDispatch(target.dispatch_id)).state, "exclusive", "派单没有被关闭");
  assert.equal(await countRows("notifications"), notificationsBefore);
});

/* ════════════ T3 · 派单超时清扫（sweepExpiredDispatchesPg） ════════════ */

test("T3 专属池到点：转公共池并通知，订单与金额一个字节都不动", { skip: SKIP }, async () => {
  const target = await makeExpiredExclusiveDispatch();
  const cfg = await publicPoolTimeoutMinutes();

  const result = await sweepExpiredDispatchesPg(AT);
  assert.deepEqual(result.movedToPublicDispatchIds, [target.dispatch_id]);
  assert.deepEqual(result.refundedOrderIds, [], "专属池到点不是退款点");

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "public");
  assert.equal(
    dispatch.public_pool_entered_at,
    target.deadline_at,
    "进入公共池的时刻取**到点那一刻**，不是扫到它的那一刻",
  );
  assert.equal(dispatch.public_deadline_at, plusMinutes(target.deadline_at, cfg));
  assert.equal(dispatch.public_timeout_minutes_snapshot, cfg, "按当下配置重冻");
  assert.equal(dispatch.accepted_by_companion_id, null);
  assert.equal(dispatch.accepted_at, null);

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "paid", "专属池到点不动订单");
  assert.equal(order.refunded_amount, 0);

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "指定护航未接单",
    ]),
    1,
  );
});

test("T3 公共池到点：停止接取 + 自动全额退款，不是售后、不等审核", { skip: SKIP }, async () => {
  const target = await makeExpiredPublicDispatch();
  assert.ok((await readOrder(target.order_id)).actual_paid_amount > 0, "需要一张实付为正的样本");

  const result = await sweepExpiredDispatchesPg(AT);
  assert.deepEqual(result.movedToPublicDispatchIds, []);
  assert.deepEqual(result.refundedOrderIds, [target.order_id]);

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "timed_out");
  assert.equal(dispatch.timed_out_at, target.deadline_at);

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "refunded");
  assert.equal(order.refunded_amount, order.actual_paid_amount, "全额退");
  assert.equal(order.refunded_at, target.deadline_at, "退款时刻也是到点那一刻");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "订单已自动退款",
    ]),
    1,
  );
});

test("T3 重复清扫：状态已经不是那个池，第二遍一个字节都不写", { skip: SKIP }, async () => {
  const target = await makeExpiredPublicDispatch();
  await sweepExpiredDispatchesPg(AT);
  await clearWriteLog();

  const second = await sweepExpiredDispatchesPg(plusMinutes(AT, 30));
  assert.deepEqual(second.movedToPublicDispatchIds, []);
  assert.deepEqual(second.refundedOrderIds, []);
  assert.deepEqual(await writePids(), [], "第二遍没有写任何一行");
  assert.equal(
    (await readOrder(target.order_id)).refunded_at,
    target.deadline_at,
    "退款时刻不被第二遍刷新",
  );
});

test("T3 停摆后一次追平：专属池与公共池都已到点，一次调用连跳两格", { skip: SKIP }, async () => {
  const cfg = await publicPoolTimeoutMinutes();
  // 专属池在很久以前就到点，于是「专属到点 + 公共池超时」也已经是过去的事
  const target = await makeExpiredExclusiveDispatch({ deadlineAt: plusMinutes(AT, -(cfg + 30)) });

  const result = await sweepExpiredDispatchesPg(AT);
  assert.deepEqual(result.movedToPublicDispatchIds, [target.dispatch_id]);
  assert.deepEqual(result.refundedOrderIds, [target.order_id], "一次调用把两级都追平");

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "timed_out", "最终停在关闭，而不是卡在公共池");
  assert.equal(
    dispatch.timed_out_at,
    plusMinutes(target.deadline_at, cfg),
    "关闭时刻 = 专属到点 + 公共池超时，与什么时候扫无关",
  );

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "refunded");
  assert.equal(order.refunded_at, dispatch.timed_out_at, "退款写在关闭那一刻");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND (title = $2 OR title = $3)", [
      target.user_id,
      "指定护航未接单",
      "订单已自动退款",
    ]),
    2,
    "连跳两级两条通知都要发",
  );
});

test("T3 已经出过款的单只关池、不出第二笔钱（P0-15 一单一退）", { skip: SKIP }, async () => {
  const target = await makeExpiredPublicDispatch();
  // 部分退款但状态仍停在 paid：`isRefundExecutionClosed` 的判据是「出过款」，
  // 不是「状态是不是 refunded」。只看状态就会在这里**再出一次款**
  await executor().query(`UPDATE orders SET refunded_amount = 1 WHERE id = $1`, [target.order_id]);
  await clearWriteLog();

  const result = await sweepExpiredDispatchesPg(AT);
  assert.deepEqual(result.refundedOrderIds, [], "没有第二次出款");
  assert.equal((await readDispatch(target.dispatch_id)).state, "timed_out", "池子照关，否则它会一直挂在那");

  const order = await readOrder(target.order_id);
  assert.equal(order.status, "paid", "没有退满就不改状态");
  assert.equal(order.refunded_amount, 1, "退款额没有被再加一次");
  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "订单已自动退款",
    ]),
    0,
    "已经退过款的单不再发一条重复通知",
  );
});

test("T3 超时退款：订单 / 派单 / 通知走的是**同一条连接**", { skip: SKIP }, async () => {
  await makeExpiredPublicDispatch();
  await clearWriteLog();
  await sweepExpiredDispatchesPg(AT);

  const pids = await writePids();
  assert.equal(pids.length, 1, `所有写入必须落在同一条连接上，实际：${pids.join(", ")}`);
});

test("T3 中途失败 → 派单关闭与退款全部回滚", { skip: SKIP }, async () => {
  const target = await makeExpiredPublicDispatch();
  await failWritesOn("notifications");

  await assert.rejects(
    () => sweepExpiredDispatchesPg(AT),
    /w1-probe: 拒绝写入 notifications/,
  );

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "public", "派单没有被关闭");
  assert.equal(dispatch.timed_out_at, null);
  const order = await readOrder(target.order_id);
  assert.equal(order.status, "paid");
  assert.equal(order.refunded_amount, 0);
  assert.equal(order.refunded_at, null);
});

/* ═══════════ T4 · 护航主动取消接单（cancelAcceptedOrderPg） ═══════════ */

/** T4 的写入入参。同一个夹具在多个用例里复用，幂等键逐条区分。 */
function cancelInput(target, { at = AT, key, orderId = target.id, reason = "临时有事" } = {}) {
  return {
    companionId: target.actual_companion_id,
    at,
    orderId,
    reason,
    idempotencyKey: key,
  };
}

test("T4 主动取消：订单回 paid、派单回公共池、写退出历史、通知用户", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  assert.ok(target, "预置数据里应当有一张 accepted 订单");
  const cfg = await publicPoolTimeoutMinutes();

  const result = await cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-1" }));
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.status, "paid");
  assert.equal(result.cancelledAt, AT);

  const order = await readOrder(target.id);
  assert.equal(order.status, "paid");
  assert.equal(order.accepted_at, null);
  assert.equal(order.actual_companion_id, null);
  assert.equal(order.companion, null);
  assert.equal(order.serving_at, null);
  assert.equal(
    order.ever_accepted_at,
    target.ever_accepted_at,
    "「曾经被承接」是历史事实，解除履约不得清掉它——否则回池后的退款会把券错误地还回去",
  );

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.public_pool_entered_at, AT, "按此刻的时刻重新进池");
  assert.equal(dispatch.public_deadline_at, plusMinutes(AT, cfg));
  assert.equal(dispatch.public_timeout_minutes_snapshot, cfg);
  assert.equal(dispatch.accepted_by_companion_id, null);
  assert.equal(dispatch.accepted_via, null, "绑定的**来源**也是绑定的一部分");

  const releases = await readReleases(target.id);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, result.releaseRecordId);
  assert.equal(releases[0].companion_id, target.actual_companion_id);
  assert.equal(releases[0].source, "companion_cancel");
  assert.equal(releases[0].reason, "临时有事");
  assert.equal(releases[0].actor_id, target.actual_companion_id, "触发者就是打手本人");
  assert.equal(releases[0].created_at, AT);
  assert.ok(releases[0].idempotency_key, "这一次写入把幂等键一起落库");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "护航已取消接单",
    ]),
    1,
  );
});

test("T4 重复取消（同幂等键）：重放，不写第二条退出历史、不刷新时刻", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const first = await cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-2" }));
  assert.equal(first.kind, "ok");
  await clearWriteLog();

  const second = await cancelAcceptedOrderPg(
    cancelInput(target, { at: plusMinutes(AT, 20), key: "cancel-key-2" }),
  );
  assert.equal(second.kind, "replayed");
  if (second.kind !== "replayed") return;
  assert.equal(second.cancelledAt, AT, "返回**第一次**的时刻");
  assert.equal(second.releaseRecordId, first.releaseRecordId);
  assert.deepEqual(await writePids(), [], "重放一个字节都不写");
  assert.equal((await readReleases(target.id)).length, 1);
  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "护航已取消接单",
    ]),
    1,
    "重放不发第二条通知",
  );
});

test("T4 幂等键被用到别的单上 → not-found，不拿别人订单的结果当答案", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-3" }));
  const other = await findPublicDispatch();
  await clearWriteLog();

  const result = await cancelAcceptedOrderPg(
    cancelInput(target, { key: "cancel-key-3", orderId: other.order_id }),
  );
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

test("T4 不是本人履约的单 → not-found（不泄露存在性）", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const others = await findAcceptingCompanions({ limit: 5 });
  const stranger = others.find((row) => row.id !== target.actual_companion_id);
  assert.ok(stranger, "需要一位不是这单履约人的护航");

  const result = await cancelAcceptedOrderPg({
    companionId: stranger.id,
    at: AT,
    orderId: target.id,
    reason: "临时有事",
    idempotencyKey: "cancel-key-stranger",
  });
  assert.equal(result.kind, "not-found", "别人的单与不存在的单必须给出同一个答案");
  assert.deepEqual(await writePids(), []);
});

test("T4 状态不是 accepted → not-accepted，带上当前状态且不写任何东西", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  assert.ok(target, "预置数据里应当有一张 serving 订单");

  const result = await cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-4" }));
  assert.equal(result.kind, "not-accepted");
  if (result.kind !== "not-accepted") return;
  assert.equal(result.status, "serving", "绝不把 serving 拉回 paid");
  assert.deepEqual(await writePids(), []);
});

test("T4 取消时把在途完成材料一并作废（否则它到点会自动通过）", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await insertPendingSubmission({
    id: "sub_cancel_t4",
    orderId: target.id,
    companionId: target.actual_companion_id,
  });

  const result = await cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-5" }));
  assert.equal(result.kind, "ok");

  const rows = await executor().query(
    `SELECT status, invalidated_at FROM completion_submissions WHERE id = $1`,
    ["sub_cancel_t4"],
  );
  assert.equal(rows[0].status, "invalidated");
  assert.equal(rows[0].invalidated_at, AT);
});

test("T4 中途失败 → 订单 / 派单 / 完成材料 / 退出历史全部回滚", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await insertPendingSubmission({
    id: "sub_cancel_t4_rb",
    orderId: target.id,
    companionId: target.actual_companion_id,
  });
  await failWritesOn("notifications");

  await assert.rejects(
    () => cancelAcceptedOrderPg(cancelInput(target, { key: "cancel-key-rb" })),
    /w1-probe: 拒绝写入 notifications/,
  );

  const order = await readOrder(target.id);
  assert.equal(order.status, "accepted", "订单没有回 paid");
  assert.equal(order.actual_companion_id, target.actual_companion_id);
  assert.equal((await readDispatch(target.dispatch_id)).state, "accepted", "派单没有被送回公共池");
  assert.equal((await readReleases(target.id)).length, 0, "退出历史没有留下半条");
  const submission = await executor().query(
    `SELECT status FROM completion_submissions WHERE id = $1`,
    ["sub_cancel_t4_rb"],
  );
  assert.equal(submission[0].status, "pending", "完成材料没有被作废");
});

/* ═══════════ T5 · 护航开始服务（startCompanionOrderPg） ═══════════ */

test("T5 开始服务：订单转 serving、写下 serving_at、留下一条服务历史", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();

  const result = await startCompanionOrderPg({
    companionId: target.actual_companion_id,
    at: AT,
    orderId: target.id,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.status, "serving");
  assert.equal(result.servingAt, AT);

  const order = await readOrder(target.id);
  assert.equal(order.status, "serving");
  assert.equal(order.serving_at, AT);

  const events = await executor().query(`SELECT * FROM companion_service_events WHERE order_id = $1`, [
    target.id,
  ]);
  assert.equal(events.length, 1, "服务历史与订单在同一个事务里写下");
  assert.equal(events[0].companion_id, target.actual_companion_id);
  assert.equal(events[0].dispatch_id, target.dispatch_id);
  assert.equal(events[0].serving_at, AT);
  assert.notEqual(events[0].companion_name, "", "服务历史必须留下**当时**那份公开快照");
});

test("T5 重复开始服务：状态本身就是幂等判据，重放不刷新时刻", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await startCompanionOrderPg({ companionId: target.actual_companion_id, at: AT, orderId: target.id });
  await clearWriteLog();

  const second = await startCompanionOrderPg({
    companionId: target.actual_companion_id,
    at: plusMinutes(AT, 20),
    orderId: target.id,
  });
  assert.equal(second.kind, "replayed");
  if (second.kind !== "replayed") return;
  assert.equal(second.servingAt, AT, "**第一次**开始的时刻");
  assert.deepEqual(await writePids(), []);
  assert.equal((await readOrder(target.id)).serving_at, AT);
});

test("T5 不是本人履约的单 → not-found", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const strangers = await findAcceptingCompanions({ limit: 5 });
  const stranger = strangers.find((row) => row.id !== target.actual_companion_id);
  assert.ok(stranger, "需要一位不是这单履约人的护航");

  const result = await startCompanionOrderPg({
    companionId: stranger.id,
    at: AT,
    orderId: target.id,
  });
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

test("T5 订单不在 accepted → not-startable，绝不把它拉进 serving", { skip: SKIP }, async () => {
  // `findRefundableOrder` 给的是「paid 且已绑定护航」：状态不对，但履约人字段有值，
  // 因此它走的是 not-startable 而不是 not-found
  const target = await findRefundableOrder();
  await clearWriteLog();

  const result = await startCompanionOrderPg({
    companionId: target.companion_id,
    at: AT,
    orderId: target.order_id,
  });
  assert.equal(result.kind, "not-startable");
  if (result.kind !== "not-startable") return;
  assert.equal(result.status, "paid");
  assert.deepEqual(await writePids(), []);
});

test("T5 同一服务段只记一次历史：唯一约束兜底，不产生第二行", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  // 预先插一条**同一个服务段**（同一订单 + 同一打手 + 同一时刻）的历史
  await executor().query(
    `INSERT INTO companion_service_events
       (id, order_id, companion_id, dispatch_id, serving_at, companion_name, companion_avatar_url)
     VALUES ($1, $2, $3, $4, $5, '旧快照', '')`,
    ["svc_preexisting", target.id, target.actual_companion_id, target.dispatch_id, AT],
  );

  const result = await startCompanionOrderPg({
    companionId: target.actual_companion_id,
    at: AT,
    orderId: target.id,
  });
  assert.equal(result.kind, "ok");
  assert.equal(
    await countRows("companion_service_events", "WHERE order_id = $1", [target.id]),
    1,
    "同一 (order_id, companion_id, serving_at) 只允许一行",
  );
});

test("T5 中途失败 → 订单状态与服务历史一起回滚", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await failWritesOn("companion_service_events");

  await assert.rejects(
    () =>
      startCompanionOrderPg({ companionId: target.actual_companion_id, at: AT, orderId: target.id }),
    /w1-probe: 拒绝写入 companion_service_events/,
  );

  const order = await readOrder(target.id);
  assert.equal(order.status, "accepted", "订单没有变成 serving");
  assert.equal(order.serving_at, null);
  assert.equal(await countRows("companion_service_events", "WHERE order_id = $1", [target.id]), 0);
});

/* ═══════════ T6 · 客服退回公共池（releaseOrderByStaffPg） ═══════════ */

const STAFF_ID = "staff-t6-t7";

test("T6 客服回池：accepted → paid、派单回公共池、退出历史记客服为触发者", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const cfg = await publicPoolTimeoutMinutes();

  const result = await releaseOrderByStaffPg({
    orderId: target.id,
    staffId: STAFF_ID,
    reason: "护航临时失联",
    at: AT,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.previousStatus, "accepted");
  assert.equal(result.releasedAt, AT);

  const order = await readOrder(target.id);
  assert.equal(order.status, "paid");
  assert.equal(order.actual_companion_id, null);
  assert.equal(order.ever_accepted_at, target.ever_accepted_at, "历史事实保留");

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.public_deadline_at, plusMinutes(AT, cfg));
  assert.equal(dispatch.accepted_via, null);

  const releases = await readReleases(target.id);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].companion_id, target.actual_companion_id, "退出历史记的是被解除的那位");
  assert.equal(releases[0].source, "staff_reassign");
  assert.equal(releases[0].actor_id, STAFF_ID);
  assert.equal(releases[0].reason, "护航临时失联");
  assert.equal(releases[0].idempotency_key, null, "客服侧没有幂等键");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "护航已更换",
    ]),
    1,
  );
});

test("T6 服务中的单同样能被回池：serving → paid", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();

  const result = await releaseOrderByStaffPg({
    orderId: target.id,
    staffId: STAFF_ID,
    reason: "用户投诉临时介入",
    at: AT,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.previousStatus, "serving", "两个履约中状态都能被解除");

  const order = await readOrder(target.id);
  assert.equal(order.status, "paid");
  assert.equal(order.serving_at, null, "serving_at 表达「当前这位从何时开始」，必须清掉");
});

test("T6 订单不在履约中 → not-releasable，带上当前状态且不写任何东西", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();

  const result = await releaseOrderByStaffPg({
    orderId: target.order_id,
    staffId: STAFF_ID,
    reason: "无事发生",
    at: AT,
  });
  assert.equal(result.kind, "not-releasable");
  if (result.kind !== "not-releasable") return;
  assert.equal(result.status, "paid");
  assert.deepEqual(await writePids(), []);
});

test("T6 订单不存在 → not-found", { skip: SKIP }, async () => {
  const result = await releaseOrderByStaffPg({
    orderId: "ord-does-not-exist",
    staffId: STAFF_ID,
    reason: "无事发生",
    at: AT,
  });
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

test("T6 订单说有人在履约、派单记录却不见了 → dispatch-missing（宁可失败，不留半解除）", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await executor().query(`DELETE FROM companion_accept_events WHERE dispatch_id = $1`, [
    target.dispatch_id,
  ]);
  await executor().query(`DELETE FROM dispatch_records WHERE id = $1`, [target.dispatch_id]);

  const result = await releaseOrderByStaffPg({
    orderId: target.id,
    staffId: STAFF_ID,
    reason: "无事发生",
    at: AT,
  });
  assert.equal(result.kind, "dispatch-missing");
  assert.equal((await readOrder(target.id)).status, "accepted", "订单原地不动");
});

test("T6 中途失败 → 订单 / 派单 / 退出历史全部回滚", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  await failWritesOn("notifications");

  await assert.rejects(
    () => releaseOrderByStaffPg({ orderId: target.id, staffId: STAFF_ID, reason: "x", at: AT }),
    /w1-probe: 拒绝写入 notifications/,
  );

  const order = await readOrder(target.id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actual_companion_id, target.actual_companion_id);
  assert.equal((await readDispatch(target.dispatch_id)).state, "accepted");
  assert.equal((await readReleases(target.id)).length, 0);
});

/* ═══════════ T7 · 客服直接换人（replaceOrderCompanionByStaffPg） ═══════════ */

test("T7 客服换人：订单连写两次到 accepted、派单改绑，**不产生接单事件**", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const next = await findAcceptingCompanionWithUser({ excludeIds: [target.actual_companion_id] });
  assert.ok(next, "需要另一位能接单、且关联了用户账号的护航");

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: next.id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.previousStatus, "accepted");
  assert.equal(result.previousCompanionId, target.actual_companion_id);
  assert.equal(result.newCompanionId, next.id);

  const order = await readOrder(target.id);
  // ⚠️ 这一句证的是**终态**：事务提交后停在 accepted。
  //    「中间那个 paid 对读者不可见」本身是「单事务 + 行锁」的性质，
  //    没有并发读者就无法在一条断言里直接测到——这里不假装测了它
  assert.equal(order.status, "accepted", "两次写入最终提交为 accepted，不是停在中间那个 paid");
  assert.equal(order.actual_companion_id, next.id);
  assert.equal(order.accepted_at, AT);
  assert.equal(order.ever_accepted_at, target.ever_accepted_at, "「曾经被承接」只写第一次");

  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.state, "accepted");
  assert.equal(dispatch.accepted_by_companion_id, next.id);
  assert.equal(dispatch.accepted_at, AT);
  assert.equal(
    dispatch.accepted_via,
    "staff",
    "`accepted_via` 是防线的另一半：派生通道只能靠它分辨「被换进来的」与「自己接的」",
  );

  assert.equal(
    await countRows("companion_accept_events", "WHERE order_id = $1", [target.id]),
    0,
    "订单进入 accepted ≠ 产生接单事件：换人不计入接单榜",
  );

  const releases = await readReleases(target.id);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].companion_id, target.actual_companion_id, "退出历史记被解除的那位");
  assert.equal(releases[0].source, "staff_reassign");
  assert.equal(releases[0].actor_id, STAFF_ID);
  assert.equal(releases[0].reason, null);

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND title = $2", [
      target.user_id,
      "护航已更换",
    ]),
    1,
  );
});

test("T7 换人时把在途完成材料作废（旧人的材料不得在新人头上自动通过）", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  await insertPendingSubmission({
    id: "sub_replace_t7",
    orderId: target.id,
    companionId: target.actual_companion_id,
  });
  const next = await findAcceptingCompanionWithUser({ excludeIds: [target.actual_companion_id] });
  assert.ok(next, "需要另一位能接单、且关联了用户账号的护航");

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: next.id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "ok");

  const submission = await executor().query(
    `SELECT status, invalidated_at FROM completion_submissions WHERE id = $1`,
    ["sub_replace_t7"],
  );
  assert.equal(submission[0].status, "invalidated");
  assert.equal(submission[0].invalidated_at, AT);
});

test("T7 指定的就是当前履约人 → same-companion（他不是不能接单，他正在做这单）", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: target.actual_companion_id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "same-companion");
  assert.deepEqual(await writePids(), []);
});

test("T7 指定的护航不存在 → companion-not-found", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: "cp-does-not-exist",
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "companion-not-found");
  assert.deepEqual(await writePids(), []);
});

test("T7 指定的护航当前不能接单 → companion-unavailable", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const next = await findAcceptingCompanionWithUser({ excludeIds: [target.actual_companion_id] });
  assert.ok(next, "需要另一位护航");
  // 「已下架但可接单」会解释不清，因此真实系统里 disable 会强制把两者一起置 false
  await executor().query(`UPDATE companions SET enabled = FALSE, available = FALSE WHERE id = $1`, [
    next.id,
  ]);

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: next.id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "companion-unavailable");
  assert.deepEqual(await writePids(), []);
});

test("T7 指定的护航就是下单用户本人 → self-order（EX-DISPATCH-08）", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const next = await findAcceptingCompanionWithUser({ excludeIds: [target.actual_companion_id] });
  assert.ok(next, "需要另一位护航");
  // 把订单的下单用户改成这位护航关联的账号，构造「自己给自己接单」
  await executor().query(`UPDATE orders SET user_id = $2 WHERE id = $1`, [target.id, next.user_id]);
  // ⚠️ 上面那句改的正是**被探针盯上的** `orders`：不清日志的话，
  //    「一个字节都没写」的断言量到的会是夹具自己
  await clearWriteLog();

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.id,
    newCompanionId: next.id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "self-order");
  assert.deepEqual(await writePids(), []);
});

test("T7 订单不在履约中 → not-replaceable", { skip: SKIP }, async () => {
  const target = await findPublicDispatch();
  const next = await findAcceptingCompanionWithUser();

  const result = await replaceOrderCompanionByStaffPg({
    orderId: target.order_id,
    newCompanionId: next.id,
    staffId: STAFF_ID,
    at: AT,
  });
  assert.equal(result.kind, "not-replaceable");
  if (result.kind !== "not-replaceable") return;
  assert.equal(result.status, "paid");
  assert.deepEqual(await writePids(), []);
});

test("T7 中途失败 → 订单 / 派单 / 退出历史全部回滚", { skip: SKIP }, async () => {
  const target = await findAcceptedOrder();
  const next = await findAcceptingCompanionWithUser({ excludeIds: [target.actual_companion_id] });
  assert.ok(next, "需要另一位护航");
  await failWritesOn("notifications");

  await assert.rejects(
    () =>
      replaceOrderCompanionByStaffPg({
        orderId: target.id,
        newCompanionId: next.id,
        staffId: STAFF_ID,
        at: AT,
      }),
    /w1-probe: 拒绝写入 notifications/,
  );

  const order = await readOrder(target.id);
  assert.equal(order.status, "accepted");
  assert.equal(order.actual_companion_id, target.actual_companion_id, "没有换人");
  const dispatch = await readDispatch(target.dispatch_id);
  assert.equal(dispatch.accepted_by_companion_id, target.actual_companion_id);
  assert.equal(dispatch.accepted_via, "companion", "改绑也一起回滚");
  assert.equal((await readReleases(target.id)).length, 0);
});
