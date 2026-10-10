import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import {
  approveRefundPg,
  rejectRefundPg,
  releaseOrdersForCompanionTx,
  setCompanionFlagsPg,
  startReviewRefundPg,
} from "../lib/data/pg/adminAuditTransactions.ts";
import { approveCompletionPg } from "../lib/data/pg/w1Transactions.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1C · **管理审计类写闭包**的 PostgreSQL 事务验证（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * > 「业务写入与它的那一条管理审计**同生共死**。」
 *
 * 这一句是本轮存在的全部理由。PROD-1B 能把订单闭包搬进数据库，是因为那些事务
 * 只要「全部业务写入在一个提交点」；T8 / T14 / T15 多了一个跨领域的参与者——
 * `admin_audit_entries`。审计是**强一致写**：它和业务写入之间不允许存在
 * 「一个成了、另一个没成」的瞬间，也不允许 outbox / 异步 / fire-and-forget
 * 那种「迟早会写」的替代品（本轮 Hard Rule 2 明令）。
 *
 * ## 因此这里有三类用例，每一类都在证伪一件具体的事
 *
 * 1. **等价**：同一批业务规则在真事务里仍然成立（判定顺序、金额、幂等、状态机）。
 * 2. **并发**：两个管理员同时动手时，最终状态**唯一且可解释**，且钱只动一次。
 * 3. **回滚**：让审计那一句 `INSERT` **故意失败**，断言**它前面的业务写入
 *    一条都没留下**。这一类是整个文件的重点——没有它，「审计失败回滚业务改动」
 *    这句话只是注释里的一厢情愿。
 *
 * ## 为什么必须打真库
 *
 * 用一个假的 Pg client 去测，等于把待证明的那一层替换成断言本身：
 * 无论实现是 `BEGIN` 还是几条 auto-commit，假 client 都会说「对」。
 * 因此这里连 `TEST_DATABASE_URL`，且**没有库时整体 skip 而不是假装通过**。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 与 `pgW1Transactions.test.mjs` 同一套机制（那份文件头写了两条理由），
 * 这里**额外**把 `admin_audit_entries` 盯上——它正是本轮唯一的新参与者。
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

/** 被探针盯上的表：这三条事务真正会写的那几张。 */
const PROBED_TABLES = [
  "orders",
  "dispatch_records",
  "notifications",
  "completion_submissions",
  "companion_release_records",
  "refund_requests",
  "earnings",
  "earning_adjustments",
  "companions",
  // 本轮的主角：审计写不进去时，前面那些业务写入必须一起回滚
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

async function readOrder(id) {
  const rows = await executor().query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readCompanion(id) {
  const rows = await executor().query(`SELECT * FROM companions WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readRefund(id) {
  const rows = await executor().query(`SELECT * FROM refund_requests WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readDispatch(orderId) {
  const rows = await executor().query(`SELECT * FROM dispatch_records WHERE order_id = $1`, [
    orderId,
  ]);
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

/** 一张 `serving` 订单 + 它已接单的派单 + 履约人。 */
async function findServingOrderWithDispatch() {
  const rows = await executor().query(
    `SELECT o.id, o.order_no, o.user_id, o.actual_companion_id, o.actual_paid_amount,
            o.companion_base_income, d.id AS dispatch_id
       FROM orders o JOIN dispatch_records d ON d.order_id = o.id
      WHERE o.status = 'serving' AND o.actual_companion_id IS NOT NULL
      ORDER BY o.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * 一条**落在合法档位上、可以正常批准**的待审核申请，以及它挂的那张单。
 *
 * 预置数据里只有 `rf-seed-1003-01` 同时满足「申请 pending」与「订单 completed」——
 * 另外两条 pending 申请挂在 `accepted` / `paid` 上，是 P0-12 之前的存量，
 * 按规则**必须被拒绝**（见 `refundSeed.ts` 的注释）。
 */
async function findApprovableRefund() {
  const rows = await executor().query(
    `SELECT r.id AS refund_id, r.order_id, r.status, r.review_note, r.amount,
            o.user_id, o.status AS order_status, o.actual_paid_amount, o.companion_base_income,
            o.actual_companion_id, o.refunded_amount
       FROM refund_requests r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'pending' AND o.status IN ('serving', 'completed')
      ORDER BY r.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * 给一位护航补上**用户账号**。
 *
 * `cp-1` … `cp-9` 的 `user_id` 都是 `null`（预置数据里它们没有入驻申请），
 * 而退款通知的收件人取的是 `Companion.userId`。这里显式补一个**未被占用**的
 * 用户 id，让「退满时通知打手」那条路径可测——**这不是在改业务规则**，
 * 只是给夹具造一个能收信的地址。
 */
async function giveCompanionAUserAccount(companionId, userId) {
  await executor().query(`UPDATE companions SET user_id = $2 WHERE id = $1`, [
    companionId,
    userId,
  ]);
}

/** 直接插一条 frozen 收益。T14 的冲回需要一个已存在的对象。 */
async function insertFrozenEarning({ id, orderId, companionId, incomeAmount, availableAt }) {
  await executor().query(
    `INSERT INTO earnings
       (id, order_id, companion_id, income_amount, status, frozen_at, available_at, withdrawn_at,
        reversed_amount, fine_amount)
     VALUES ($1, $2, $3, $4, 'frozen', $5, $6, NULL, 0, 0)`,
    [id, orderId, companionId, incomeAmount, plusMinutes(AT, -1440), availableAt],
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

/* ═══════════════ T8 · 只改「能不能接单」（setCompanionFlagsPg） ═══════════════ */

test("T8 暂停接单：只改三列、写一条审计、一个订单都不动", { skip: SKIP }, async () => {
  const before = await readCompanion("cp-1");
  assert.equal(before.available, true, "前提：cp-1 当前可以接单");

  const result = await setCompanionFlagsPg(
    "cp-1",
    "pause",
    { unavailableReason: "临时休息两天" },
    ctxOf("op-t8-pause"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.action, "companion.pause");

  const after = await readCompanion("cp-1");
  assert.equal(after.enabled, true, "暂停**不**下架：仍然在名单里");
  assert.equal(after.available, false);
  assert.equal(after.unavailable_reason, "临时休息两天");

  const audits = await readAudits("cp-1");
  assert.equal(audits.length, 1, "一次动作一条审计");
  assert.equal(audits[0].action, "companion.pause");
  assert.equal(audits[0].operation_id, "op-t8-pause");
  assert.equal(audits[0].actor_role, "admin");

  // ⚠️ 这条断言证明的是「**只有一个** pid」——`BEGIN` 开在 A、某条写入落在 B，
  //    `writePids()` 就会有第二个值。它证明不了「这个 pid 就是本次事务那条」，
  //    但「只有一种取值」已经是「同连接」的充分条件（探针由事务自身触发）。
  assert.equal((await writePids()).length, 1, "全部走同一条连接");
});

test("T8 恢复接单：清空不可接单原因", { skip: SKIP }, async () => {
  // cp-6 预置就是「在架但不可接单」
  const before = await readCompanion("cp-6");
  assert.equal(before.enabled, true);
  assert.equal(before.available, false);

  const result = await setCompanionFlagsPg(
    "cp-6",
    "resume",
    { unavailableReason: "无所谓" },
    ctxOf("op-t8-resume"),
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.action, "companion.resume");

  const after = await readCompanion("cp-6");
  assert.equal(after.available, true);
  assert.equal(after.unavailable_reason, "", "恢复接单要把原因清空");
});

test("T8 启用：已停用的护航重新上架", { skip: SKIP }, async () => {
  const before = await readCompanion("cp-7");
  assert.equal(before.enabled, false, "前提：cp-7 预置是下架状态");

  const result = await setCompanionFlagsPg(
    "cp-7",
    "enable",
    { unavailableReason: "" },
    ctxOf("op-t8-enable"),
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.action, "companion.enable");

  const after = await readCompanion("cp-7");
  assert.equal(after.enabled, true, "回到名单");
  assert.equal(after.available, false, "复职不等于立刻可接单：可接单要本人再开");
});

test("T8 停用：解除在履约的单、保留已完成单的履约人（EX-COMP-01）", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  assert.ok(target, "预置数据里应当有一张带派单的 serving 单");
  const companionId = target.actual_companion_id;

  // 这位履约人手上还有别的订单：已完成的那些**必须原封不动**
  const completedOrders = await executor().query(
    `SELECT id FROM orders
      WHERE actual_companion_id = $1 AND status IN ('completed', 'refunded') ORDER BY id`,
    [companionId],
  );
  assert.ok(completedOrders.length > 0, "前提：这位履约人还有已完成的历史订单");

  const result = await setCompanionFlagsPg(
    companionId,
    "disable",
    { unavailableReason: "" },
    ctxOf("op-t8-disable"),
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.value.action, "companion.disable");

  const companion = await readCompanion(companionId);
  assert.equal(companion.enabled, false);
  assert.equal(companion.available, false, "下架强制不可接单");

  // ① 在履约的那一单被退回公共池
  const released = await readOrder(target.id);
  assert.equal(released.status, "paid", "回到等待接单");
  assert.equal(released.actual_companion_id, null, "旧打手不再挂在单上");
  assert.equal(released.ever_accepted_at !== null, true, "★ 曾经被承接过的痕迹**保留**");
  assert.equal(released.serving_at, null, "解除后清空服务开始时刻");
  assert.equal(released.accepted_at, null, "解除后清空接单时刻");

  const dispatch = await readDispatch(target.id);
  assert.equal(dispatch.state, "public", "派单回到公共池");
  assert.equal(dispatch.accepted_by_companion_id, null);

  const releases = await executor().query(
    `SELECT * FROM companion_release_records WHERE order_id = $1`,
    [target.id],
  );
  assert.equal(releases.length, 1, "恰好一条退出历史");
  assert.equal(releases[0].source, "companion_disabled");
  assert.equal(releases[0].companion_id, companionId);
  assert.equal(releases[0].actor_id, "admin-1", "触发者是这位管理员");

  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'dispatch'", [target.user_id]),
    1,
    "给下单用户发一条派单类通知",
  );

  // ② 已完成 / 已退款的历史订单**保留履约人**
  for (const row of completedOrders) {
    const order = await readOrder(row.id);
    assert.equal(order.actual_companion_id, companionId, `订单 ${row.id} 的履约人不得被抹掉`);
    assert.equal(order.status === "completed" || order.status === "refunded", true);
  }

  // ③ 审计
  const audits = await readAudits(companionId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "companion.disable");
});

test("T8 停用是幂等的：同一个幂等键第二次到达是重放，不写第二条审计", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  const companionId = target.actual_companion_id;

  await setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-replay"));
  await clearWriteLog();

  const again = await setCompanionFlagsPg(
    companionId,
    "disable",
    { unavailableReason: "" },
    ctxOf("op-t8-replay-MUST-BE-IGNORED", { at: plusMinutes(AT, 30) }),
  );

  // ⚠️ 这里换了幂等键：那**不是**重放，而是「已经停用了、什么都不用做」——
  //    两条路径都不写数据、都不写审计，但 `replayed` 的取值不同。
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.changed, false);
  assert.equal(again.replayed, false);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [companionId]), 1);
  assert.deepEqual(await writePids(), [], "什么都不用做时不写任何东西");

  // 真正的重放：同一个键再来一次
  const replay = await setCompanionFlagsPg(
    companionId,
    "disable",
    { unavailableReason: "" },
    ctxOf("op-t8-replay"),
  );
  assert.equal(replay.kind, "ok");
  if (replay.kind !== "ok") return;
  assert.equal(replay.replayed, true, "同一个键第二次到达 = 重放");
  assert.equal(replay.changed, false);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [companionId]), 1);
});

test("T8 幂等键被用在别的护航上 → operation-conflict，而不是安静重放", { skip: SKIP }, async () => {
  await setCompanionFlagsPg("cp-1", "pause", { unavailableReason: "x" }, ctxOf("op-t8-mixed"));

  const other = await setCompanionFlagsPg(
    "cp-2",
    "pause",
    { unavailableReason: "x" },
    ctxOf("op-t8-mixed"),
  );
  assert.equal(other.kind, "operation-conflict");
  assert.equal((await readCompanion("cp-2")).available, true, "冲突时一个字节都不写");
});

test("T8 not-found / removed / disabled 三种前置失败都是零写入", { skip: SKIP }, async () => {
  // 「已移除」：先软移除一条，再改它的开关。
  // ⚠️ `companions` 也在探针名单里，因此这条**夹具写入**必须赶在 `clearWriteLog()` 之前，
  //    否则它会被算进「这次动作写了什么」。
  await executor().query(`UPDATE companions SET removed_at = $2 WHERE id = $1`, ["cp-5", AT]);
  await clearWriteLog();

  assert.equal(
    (await setCompanionFlagsPg("cp-does-not-exist", "pause", { unavailableReason: "x" }, ctxOf("op-t8-nf"))).kind,
    "not-found",
  );
  // cp-7 是「已下架」，对它谈「暂停 / 恢复」没有意义
  assert.equal(
    (await setCompanionFlagsPg("cp-7", "pause", { unavailableReason: "x" }, ctxOf("op-t8-dis"))).kind,
    "disabled",
  );
  assert.equal(
    (await setCompanionFlagsPg("cp-5", "pause", { unavailableReason: "x" }, ctxOf("op-t8-rm"))).kind,
    "removed",
  );

  assert.deepEqual(await writePids(), [], "三种前置失败一个字节都不写");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("T8 只写那三列：别的字段（昵称、排序）不会被这次动作覆盖", { skip: SKIP }, async () => {
  const before = await readCompanion("cp-1");
  // 先把昵称改成一个「另一位管理员刚刚改过」的样子，让它与预置值不同——
  // 否则「没被覆盖」这句话在「本来就等于预置值」时也会成立，等于没测。
  await executor().query(`UPDATE companions SET display_name = '小李（已改名）' WHERE id = 'cp-1'`);

  await setCompanionFlagsPg("cp-1", "pause", { unavailableReason: "休息" }, ctxOf("op-t8-narrow"));

  const after = await readCompanion("cp-1");
  assert.equal(after.display_name, "小李（已改名）", "窄写入不碰昵称");
  // ⚠️ 与**改动前**比（不是与「刚读到的自己」比——那是恒真断言，加了 0 判别力）
  assert.equal(after.sort_order, before.sort_order, "窄写入不碰排序");
  assert.notEqual(after.available, before.available, "前提：这次动作确实改了点东西");
});

/* ═══════════════ T8 · 解除单（releaseOrdersForCompanionTx 直接调用） ═══════════════ */

test("T8 解除：手上没有在履约的单时返回空集，且不写任何东西", { skip: SKIP }, async () => {
  await clearWriteLog();

  // `releaseOrdersForCompanionTx` 不是对外入口（唯一调用方是 `setCompanionFlagsPg`），
  // 因此用一条**真事务**包一层单独验它的返回值形状——不伪造 TxHandle。
  const outcome = await getPgExecutor().withTransaction((tx) =>
    releaseOrdersForCompanionTx(tx, {
      companionId: "cp-9999",
      actorId: "admin-1",
      reason: "测试",
      at: AT,
    }),
  );

  assert.deepEqual(outcome, { kind: "ok", companionId: "cp-9999", releasedOrderIds: [] });
  assert.deepEqual(await writePids(), [], "没有在履约的单 → 一个字节都不写");
});

/* ═══════════════ T15 · 开始审核退款（startReviewRefundPg） ═══════════════ */

test("T15 开始审核：pending → reviewing，只写状态与审核时刻", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  const before = await readRefund(target.refund_id);
  assert.equal(before.status, "pending");

  const result = await startReviewRefundPg(target.refund_id, ctxOf("op-t15-ok"));
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.orderChanged, false, "开始审核不动订单");
  assert.equal(result.value.refund.status, "reviewing");
  assert.equal(result.value.refund.reviewingAt, AT);
  assert.equal(result.value.refund.reviewedAt, null, "还没有结果，不写审核时间");
  assert.equal(result.value.refund.reviewedBy, null, "还没有结果，不写审核人");
  assert.equal(result.value.refund.reviewNote, before.review_note, "审核意见保持原值");

  // 订单一个字节不动
  const order = await readOrder(target.order_id);
  assert.equal(order.status, target.order_status);
  assert.equal(order.refunded_amount, 0);

  const audits = await readAudits(target.refund_id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "refund.start-review");
  assert.equal(audits[0].target_type, "refund");
});

test("T15 同一个幂等键第二次 → 重放，零写入", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await startReviewRefundPg(target.refund_id, ctxOf("op-t15-replay"));
  await clearWriteLog();

  const again = await startReviewRefundPg(target.refund_id, ctxOf("op-t15-replay"));
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.replayed, true);
  assert.equal(again.changed, false);
  assert.deepEqual(await writePids(), [], "重放不写任何东西");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
});

test("T15 已经在审核中 → invalid-transition（reviewing → reviewing 不在状态表里）", { skip: SKIP }, async () => {
  // rf-seed-1001-02 预置就是 reviewing
  await clearWriteLog();
  const result = await startReviewRefundPg("rf-seed-1001-02", ctxOf("op-t15-invalid"));
  assert.equal(result.kind, "invalid-transition");
  if (result.kind !== "invalid-transition") return;
  assert.equal(result.status, "reviewing");
  assert.deepEqual(await writePids(), []);
});

test("T15 同一个键指向另一个意图 → operation-conflict", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await startReviewRefundPg(target.refund_id, ctxOf("op-t15-mixed"));

  const conflicted = await rejectRefundPg(target.refund_id, "驳回", ctxOf("op-t15-mixed"));
  assert.equal(conflicted.kind, "operation-conflict", "同一个键不能既是「开始审核」又是「驳回」");
  assert.equal((await readRefund(target.refund_id)).status, "reviewing", "冲突时不动状态");
});

test("T15 申请不存在 → not-found，零写入", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await startReviewRefundPg("rf-does-not-exist", ctxOf("op-t15-nf"));
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

/* ═══════════════ T14 · 审核通过（approveRefundPg） ═══════════════ */

test("T14 全额通过：退款 / 订单 / 派单 / 通知 / 审计在同一个提交点", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  const companionId = target.actual_companion_id;
  // 让「通知打手」这条路径可测：给这位打手补一个用户账号
  await giveCompanionAUserAccount(companionId, "u-t14-approve");

  const result = await approveRefundPg(target.refund_id, "核实无误，同意退款", { refundRateBp: 10000 }, ctxOf("op-t14-full"));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.value.orderChanged, true);

  // ① 退款：状态、决策、审核人、审核意见、审核时间
  const refund = await readRefund(target.refund_id);
  assert.equal(refund.status, "approved");
  assert.equal(refund.reviewed_at, AT);
  assert.equal(refund.reviewed_by, "admin-1");
  assert.equal(refund.review_note, "核实无误，同意退款");
  assert.equal(refund.decision.refundRateBp, 10000);
  assert.equal(refund.decision.refundAmount, target.actual_paid_amount, "100% = 实付");
  assert.equal(
    refund.decision.companionReversalAmount,
    target.companion_base_income,
    "★ 打手冲回额恒为订单冻结的整笔基数，与比例无关",
  );
  assert.equal(refund.decision.decidedBy, "admin-1");
  assert.equal(refund.decision.decidedAt, AT);

  // ② 订单：退满 → refunded
  const order = await readOrder(target.order_id);
  assert.equal(order.status, "refunded");
  assert.equal(order.refunded_amount, target.actual_paid_amount);
  assert.equal(order.refunded_at, AT);

  // ③ 退满 → 派单关闭
  const dispatch = await readDispatch(target.order_id);
  assert.equal(dispatch.state, "timed_out");
  assert.equal(dispatch.timed_out_at, AT);

  // ④ 退满 → 通知打手的**用户账号**
  assert.equal(
    await countRows("notifications", "WHERE user_id = $1 AND kind = 'refund'", ["u-t14-approve"]),
    1,
  );

  // ⑤ 审计：before/after 同时带上退款状态与订单状态
  const audits = await readAudits(target.refund_id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "refund.approve");
  assert.equal(audits[0].before.status, "pending");
  assert.equal(audits[0].after.status, "approved");
  assert.equal(audits[0].before.orderStatus, "completed");
  assert.equal(audits[0].after.orderStatus, "refunded", "审计记的是这次写入造成的那个变化");

  // ⑥ 同一条连接
  assert.equal((await writePids()).length, 1, "BEGIN 与所有写入走同一条连接");
});

test("T14 部分退款：订单**不改状态**，累计已退只加这一笔，派单不关", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  const half = Math.floor(target.actual_paid_amount / 2);
  assert.ok(half > 0, "前提：这一单的实付金额足够大");

  const result = await approveRefundPg(target.refund_id, "按一半退", { refundRateBp: 5000 }, ctxOf("op-t14-partial"));
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  const order = await readOrder(target.order_id);
  assert.equal(order.status, target.order_status, "★ 部分退款**不改**订单状态（P0-15）");
  assert.equal(order.refunded_amount, half);
  assert.equal(order.refunded_at, null, "没退满就不写退款时刻");

  const dispatch = await readDispatch(target.order_id);
  assert.equal(dispatch.state, "accepted", "没退满就不关派单");

  const refund = await readRefund(target.refund_id);
  assert.equal(refund.decision.refundAmount, half);
  // ⚠️ 这一条是本轮最容易被写错的一条：退 50% 也把打手收益**整笔**取消
  assert.equal(refund.decision.companionReversalAmount, target.companion_base_income);
});

test("T14 打手收益：整笔冲回、状态留在 frozen、补一条明细", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  // 完成单在预置数据里没有 Earning（收益只在订单完成时产生），这里补一条
  await insertFrozenEarning({
    id: "ern-t14-1",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });

  await approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-earn"));

  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-t14-1'`);
  assert.equal(earnings.length, 1);
  assert.equal(
    earnings[0].income_amount,
    target.companion_base_income,
    "★ incomeAmount 一栏不得被篡改（冲的是 reversedAmount，不是收益本身）",
  );
  assert.equal(earnings[0].reversed_amount, target.companion_base_income);
  assert.equal(earnings[0].status, "frozen", "★ 冲完仍是冻结：这笔钱永远不会变成可提现");

  const adjustments = await executor().query(
    `SELECT * FROM earning_adjustments WHERE order_id = $1`,
    [target.order_id],
  );
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].type, "refund_reversal");
  assert.equal(adjustments[0].refund_id, target.refund_id, "★ 幂等键 = refundId");
  assert.equal(adjustments[0].amount, target.companion_base_income);
  assert.equal(adjustments[0].admin_id, "admin-1");
});

test("T14 订单档位闸：accepted 单上的存量申请必须被拒，且零副作用", { skip: SKIP }, async () => {
  // rf-seed-1001-01 是 P0-12 之前的存量：pending，但订单是 accepted
  const before = await readRefund("rf-seed-1001-01");
  assert.equal(before.status, "pending");
  await clearWriteLog();

  const result = await approveRefundPg("rf-seed-1001-01", "同意", { refundRateBp: 10000 }, ctxOf("op-t14-gate"));

  assert.equal(result.kind, "order-status-not-eligible");
  assert.deepEqual(await writePids(), [], "闸门排在所有写入之前，一处都不许动");
  assert.equal((await readRefund("rf-seed-1001-01")).status, "pending");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("T14 金额闸：比例算出来是 0 → decision-invalid，且零副作用", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await clearWriteLog();

  const result = await approveRefundPg(target.refund_id, "同意", { refundRateBp: 0 }, ctxOf("op-t14-amount"));

  assert.equal(result.kind, "decision-invalid");
  assert.deepEqual(await writePids(), []);
  assert.equal((await readRefund(target.refund_id)).status, "pending");
});

test("T14 同一个幂等键第二次 → 重放：不重复退款、不重复冲回、不写第二条审计", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await insertFrozenEarning({
    id: "ern-t14-replay",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });
  await approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-replay"));
  await clearWriteLog();

  const again = await approveRefundPg(
    target.refund_id,
    "同意",
    { refundRateBp: 10000 },
    ctxOf("op-t14-replay", { at: plusMinutes(AT, 30) }),
  );

  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.replayed, true);
  assert.equal(again.changed, false);
  assert.deepEqual(await writePids(), [], "重放不写任何东西");

  const order = await readOrder(target.order_id);
  assert.equal(order.refunded_amount, target.actual_paid_amount, "只退一次");
  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-t14-replay'`);
  assert.equal(earnings[0].reversed_amount, target.companion_base_income, "只冲一次");
  assert.equal(await countRows("earning_adjustments", "WHERE refund_id = $1", [target.refund_id]), 1);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
});

test("T14 已经是 approved → invalid-transition（approved 是终态）", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await approveRefundPg("rf-seed-1001-03", "再批一次", { refundRateBp: 10000 }, ctxOf("op-t14-done"));
  assert.equal(result.kind, "invalid-transition");
  if (result.kind !== "invalid-transition") return;
  assert.equal(result.status, "approved");
  assert.deepEqual(await writePids(), []);
});

test("T14 申请不存在 → not-found", { skip: SKIP }, async () => {
  await clearWriteLog();
  const result = await approveRefundPg("rf-nope", "同意", { refundRateBp: 10000 }, ctxOf("op-t14-nf"));
  assert.equal(result.kind, "not-found");
  assert.deepEqual(await writePids(), []);
});

/* ═══════════════ T14 · 审核拒绝（rejectRefundPg） ═══════════════ */

test("T14 拒绝：只写退款申请，订单一个字节不动", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  const result = await rejectRefundPg(target.refund_id, "证据不足，不予退款", ctxOf("op-t14-reject"));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.orderChanged, false);

  const refund = await readRefund(target.refund_id);
  assert.equal(refund.status, "rejected");
  assert.equal(refund.reviewed_at, AT);
  assert.equal(refund.reviewed_by, "admin-1");
  assert.equal(refund.review_note, "证据不足，不予退款");
  assert.equal(refund.decision, null, "拒绝不产生资金决策");

  const order = await readOrder(target.order_id);
  assert.equal(order.status, target.order_status);
  assert.equal(order.refunded_amount, 0);

  const audits = await readAudits(target.refund_id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "refund.reject");
});

test("T14 拒绝**存量**申请是允许的：它既批不了、也不该被永远悬着", { skip: SKIP }, async () => {
  // rf-seed-1001-01 挂在 accepted 单上：批准被闸门挡，驳回必须能过
  const result = await rejectRefundPg("rf-seed-1001-01", "存量申请，按驳回处置", ctxOf("op-t14-legacy-reject"));
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal((await readRefund("rf-seed-1001-01")).status, "rejected");
});

test("T14 拒绝的幂等重放：不写第二条审计", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await rejectRefundPg(target.refund_id, "驳回", ctxOf("op-t14-reject-replay"));
  await clearWriteLog();

  const again = await rejectRefundPg(target.refund_id, "驳回", ctxOf("op-t14-reject-replay"));
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(again.replayed, true);
  assert.deepEqual(await writePids(), []);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
});

/* ═══════════════ 并发（Phase 8） ═══════════════ */

test("并发 · T14 两个管理员同时通过：只出一次款", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await insertFrozenEarning({
    id: "ern-t14-race",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });

  const [a, b] = await Promise.all([
    approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-race-a")),
    approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-race-b")),
  ]);

  const succeeded = [a, b].filter((result) => result.kind === "ok");
  assert.equal(succeeded.length, 1, "★ 恰好一个真正执行了退款");
  assert.equal(
    [a, b].filter((r) => r.kind === "invalid-transition").length,
    1,
    "另一个看到的是「已经批过了」，而不是也退一笔",
  );

  const order = await readOrder(target.order_id);
  assert.equal(order.refunded_amount, target.actual_paid_amount, "★ 累计已退只等于实付一次");
  assert.equal(
    await countRows("earning_adjustments", "WHERE refund_id = $1", [target.refund_id]),
    1,
    "★ 冲回明细只有一条",
  );
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-t14-race'`);
  assert.equal(earnings[0].reversed_amount, target.companion_base_income, "只冲一次");
});

test("并发 · T14 通过 vs 拒绝：最终状态唯一，钱与状态互相一致", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();

  const [a, b] = await Promise.all([
    approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-vs-a")),
    rejectRefundPg(target.refund_id, "驳回", ctxOf("op-t14-vs-b")),
  ]);

  const refund = await readRefund(target.refund_id);
  const order = await readOrder(target.order_id);

  assert.equal([a, b].filter((r) => r.kind === "ok").length, 1, "★ 恰好一个赢");
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);

  if (refund.status === "approved") {
    assert.equal(a.kind, "ok");
    assert.equal(order.status, "refunded", "批了就必须真的退");
    assert.equal(order.refunded_amount, target.actual_paid_amount);
  } else {
    assert.equal(refund.status, "rejected");
    assert.equal(b.kind, "ok");
    assert.equal(order.status, target.order_status, "驳回就不能动订单");
    assert.equal(order.refunded_amount, 0);
  }
});

test("并发 · T15 两个管理员同时开始审核：只有一个成功，审计只有一条", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();

  const [a, b] = await Promise.all([
    startReviewRefundPg(target.refund_id, ctxOf("op-t15-race-a")),
    startReviewRefundPg(target.refund_id, ctxOf("op-t15-race-b")),
  ]);

  assert.equal([a, b].filter((r) => r.kind === "ok").length, 1, "★ 恰好一个赢");
  assert.equal([a, b].filter((r) => r.kind === "invalid-transition").length, 1);

  const refund = await readRefund(target.refund_id);
  assert.equal(refund.status, "reviewing", "★ 最终状态唯一且可解释");
  assert.equal(refund.reviewing_at, AT);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
  assert.equal(await countRows("refund_requests", "WHERE id = $1", [target.refund_id]), 1);
});

test("并发 · T8 停用 与 订单完成：不得留下「已完成但履约人已被解绑」或重复退出历史", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  const companionId = target.actual_companion_id;

  // 两张「待审完成材料」，让完成审核这条路径有机会赢
  await executor().query(
    `INSERT INTO completion_submissions
       (id, order_id, companion_id, summary, evidence, status,
        submitted_at, auto_approval_minutes_snapshot, auto_approval_deadline_at,
        review_source, reviewed_by_staff_id, reviewed_by_name, reviewed_at, reject_reason, invalidated_at)
     VALUES ('cs-race', $1, $2, '完成材料说明：整场打完并截图', '[]'::jsonb, 'pending', $3, 30, $4,
             NULL, NULL, NULL, NULL, NULL, NULL)`,
    [target.id, companionId, AT, plusMinutes(AT, 30)],
  );

  const [disable, completion] = await Promise.all([
    setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-race")),
    approveCompletionPg({ submissionId: "cs-race", staffId: "admin-1", staffName: "客服一号", at: AT }),
  ]);

  const order = await readOrder(target.id);
  const releases = await executor().query(
    `SELECT * FROM companion_release_records WHERE order_id = $1`,
    [target.id],
  );

  // ★ 不变量一：退出历史最多一条（两条路径绝不该各自解除一次）
  assert.ok(releases.length <= 1, `退出历史不得重复，实际 ${releases.length} 条`);
  // ★ 不变量二：已经完成的单**不**绑定在被停用的打手之外——它保留履约人
  if (order.status === "completed") {
    assert.equal(order.actual_companion_id, companionId, "完成的单保留履约人");
    assert.equal(releases.length, 0, "完成之后不该再有解除");
    assert.equal(await countRows("earnings", "WHERE order_id = $1", [target.id]), 1);
  } else {
    assert.equal(order.status, "paid", "没完成就回公共池");
    assert.equal(order.actual_companion_id, null);
    assert.equal(releases.length, 1);
    // 解除会把那份**待审材料**一并作废，因此完成审核在这一侧看到的是
    // `invalid-status`（材料已作废），而不是 `order-not-serving`。
    assert.equal(completion.kind, "invalid-status", "被解除之后，完成审核必须失败");
    const submission = await executor().query(
      `SELECT status FROM completion_submissions WHERE id = 'cs-race'`,
    );
    assert.equal(submission[0].status, "invalidated", "★ 材料随解除一起作废，不会留下悬空的待审");
  }
  // ★ 不变量三：无论谁赢，打手都必须处于停用状态
  assert.equal((await readCompanion(companionId)).enabled, false);
  assert.equal(disable.kind, "ok");
});

/* ════════ 并发 · **同一个幂等键**（本文件唯一需要「两次读」的那条路径） ════════ */

/**
 * ## 这一组为什么必须存在
 *
 * 上面四条并发用例用的都是**不同的** `operationId`（`…-a` / `…-b`），
 * 它们走的是「**不同键、同一目标**」——两个请求在同一行上被 `FOR UPDATE` 串行化，
 * 靠的是**行锁**。
 *
 * 而本文件里唯一需要解释的结构（文件头「幂等账本要读两次」）防的是**另一条**路径：
 * 「**同一个键**」的两个请求。它们可能**双双读到空账本**：
 *
 * - 若权威读排在取锁之后 → 第二个请求等锁，醒来时看到第一个**已提交**的账本行 → 正确重放；
 * - 若有人把权威读误删、或挪到取锁之前 → 第二个请求写第二条审计 → 撞
 *   `admin_audit_entries_operation_key`（`23505`）→ **整段回滚**，两个请求都失败。
 *
 * ⚠️ 因此这组用例是那一处**唯一**的判别式：没有它，「权威读必须在锁之后」
 * 这条设计就算被改坏，其余用例**全部照样绿**。
 *
 * 断言写成「恰好一个真正做了事、恰好一个重放」而不是「两个都 ok」——
 * 后者在「两边都真的执行了一遍」时也会通过，那正是要排除的错误结局。
 */

test("并发 · 同一个幂等键（T15）：一个执行、一个重放，绝不撞 23505", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();

  const [a, b] = await Promise.all([
    startReviewRefundPg(target.refund_id, ctxOf("op-t15-same")),
    startReviewRefundPg(target.refund_id, ctxOf("op-t15-same")),
  ]);

  // 两个都必须正常返回——任何一方抛错（23505 / 唯一冲突）就是这条路径坏了
  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal(
    [a, b].filter((r) => r.changed).length,
    1,
    "★ 恰好一个真正执行了迁移，另一个必须走重放（两个 changed 说明两边都写了）",
  );
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");

  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
  assert.equal((await readRefund(target.refund_id)).reviewing_at, AT, "状态唯一且是这个时刻");
});

test("并发 · 同一个幂等键（T14 通过）：一个出款、一个重放，钱只动一次", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await insertFrozenEarning({
    id: "ern-same-key",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });

  const [a, b] = await Promise.all([
    approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-same")),
    approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-same")),
  ]);

  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal([a, b].filter((r) => r.changed).length, 1, "★ 恰好一个真正出了款");
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");

  // 钱的四条硬断言：一次出款、一次冲回、一条明细、一条审计
  assert.equal((await readOrder(target.order_id)).refunded_amount, target.actual_paid_amount);
  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-same-key'`);
  assert.equal(earnings[0].reversed_amount, target.companion_base_income);
  assert.equal(await countRows("earning_adjustments", "WHERE refund_id = $1", [target.refund_id]), 1);
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [target.refund_id]), 1);
});

test("并发 · 同一个幂等键（T8 停用）：一个执行、一个重放，解除只做一次", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  const companionId = target.actual_companion_id;

  const [a, b] = await Promise.all([
    setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-same")),
    setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-same")),
  ]);

  assert.equal(a.kind, "ok", `第一个必须正常返回，实际 ${a.kind}`);
  assert.equal(b.kind, "ok", `第二个必须正常返回（重放），实际 ${b.kind}`);
  if (a.kind !== "ok" || b.kind !== "ok") return;

  assert.equal([a, b].filter((r) => r.changed).length, 1, "★ 恰好一个真正执行了停用");
  assert.equal([a, b].filter((r) => r.replayed).length, 1, "★ 恰好一个自认重放");

  assert.equal(
    await countRows("companion_release_records", "WHERE order_id = $1", [target.id]),
    1,
    "★ 解除恰好发生一次",
  );
  assert.equal(await countRows("admin_audit_entries", "WHERE target_id = $1", [companionId]), 1);
  assert.equal((await readCompanion(companionId)).enabled, false);
});

/* ═══════════════ 回滚探针（Phase 9） ═══════════════ */

test("回滚 · T8 审计写不进去 → 停用与整批解除一起回滚", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  const companionId = target.actual_companion_id;
  const before = await readCompanion(companionId);
  // ⚠️ 预置数据本身带通知（8 条），因此这里比的不是「等于 0」而是「与基线相同」
  const notificationsBefore = await countRows("notifications");

  // 业务表全部**允许**写：只有审计那一句会炸
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-rollback")),
    /w1-probe/,
  );

  const after = await readCompanion(companionId);
  assert.equal(after.enabled, before.enabled, "★ 标志位回滚");
  assert.equal(after.available, before.available);
  assert.equal(after.unavailable_reason, before.unavailable_reason);

  const order = await readOrder(target.id);
  assert.equal(order.status, "serving", "★ 订单回滚：不能出现「人已停用、单还挂在他名下」的反面");
  assert.equal(order.actual_companion_id, companionId);
  assert.equal(
    await countRows("companion_release_records", "WHERE order_id = $1", [target.id]),
    0,
    "★ 退出历史回滚",
  );
  assert.equal((await readDispatch(target.id)).state, "accepted", "★ 派单回滚");
  assert.equal(await countRows("notifications"), notificationsBefore, "★ 通知回滚");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("回滚 · T8 退出历史写不进去 → 整批一个字节都不留", { skip: SKIP }, async () => {
  const target = await findServingOrderWithDispatch();
  const companionId = target.actual_companion_id;
  await failWritesOn("companion_release_records");

  await assert.rejects(
    () => setCompanionFlagsPg(companionId, "disable", { unavailableReason: "" }, ctxOf("op-t8-rollback2")),
    /w1-probe/,
  );

  const order = await readOrder(target.id);
  assert.equal(order.status, "serving");
  assert.equal(order.actual_companion_id, companionId);
  assert.equal((await readCompanion(companionId)).enabled, true, "解除失败 → 停用也没发生");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("回滚 · T14 审计写不进去 → 退款 / 订单 / 收益 / 派单全部回滚", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await insertFrozenEarning({
    id: "ern-t14-rollback",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });

  const notificationsBefore = await countRows("notifications");

  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () =>
      approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-rollback")),
    /w1-probe/,
  );

  // ★ 这一组断言就是本轮的全部意义：审计写不进去 ⇒ 业务写入一条都不许留下
  const refund = await readRefund(target.refund_id);
  assert.equal(refund.status, "pending", "★ 退款状态回滚");
  assert.equal(refund.decision, null, "★ 资金决策回滚");
  assert.equal(refund.reviewed_at, null);

  const order = await readOrder(target.order_id);
  assert.equal(order.status, target.order_status, "★ 订单状态回滚");
  assert.equal(order.refunded_amount, 0, "★ 累计已退回滚");
  assert.equal(order.refunded_at, null);

  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-t14-rollback'`);
  assert.equal(earnings[0].reversed_amount, 0, "★ 收益冲回回滚");
  assert.equal(earnings[0].status, "frozen");
  assert.equal(await countRows("earning_adjustments"), 0, "★ 冲回明细回滚");

  assert.equal((await readDispatch(target.order_id)).state, "accepted", "★ 派单没被关闭");
  assert.equal(await countRows("notifications"), notificationsBefore, "★ 通知回滚");
  assert.equal(await countRows("admin_audit_entries"), 0);
});

test("回滚 · T14 收益明细写不进去 → 钱、订单、退款状态一起回滚", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await insertFrozenEarning({
    id: "ern-t14-rollback2",
    orderId: target.order_id,
    companionId: target.actual_companion_id,
    incomeAmount: target.companion_base_income,
    availableAt: plusMinutes(AT, 60),
  });
  await failWritesOn("earning_adjustments");

  await assert.rejects(
    () => approveRefundPg(target.refund_id, "同意", { refundRateBp: 10000 }, ctxOf("op-t14-rollback3")),
    /w1-probe/,
  );

  assert.equal((await readRefund(target.refund_id)).status, "pending");
  assert.equal((await readOrder(target.order_id)).refunded_amount, 0);
  const earnings = await executor().query(`SELECT * FROM earnings WHERE id = 'ern-t14-rollback2'`);
  assert.equal(earnings[0].reversed_amount, 0, "★ 「钱冲了、明细没写」的悬空状态必须不存在");
});

test("回滚 · T15 审计写不进去 → 退款状态回滚到 pending", { skip: SKIP }, async () => {
  const target = await findApprovableRefund();
  await failWritesOn("admin_audit_entries");

  await assert.rejects(
    () => startReviewRefundPg(target.refund_id, ctxOf("op-t15-rollback")),
    /w1-probe/,
  );

  const refund = await readRefund(target.refund_id);
  assert.equal(refund.status, "pending", "★ 状态回滚");
  assert.equal(refund.reviewing_at, null, "★ 审核时刻回滚");
  assert.equal(await countRows("admin_audit_entries"), 0);
});
