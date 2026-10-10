import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import {
  COUPON_CLAIM_NOT_FOUND_REASON,
  COUPON_FORM_LABELS,
  COUPON_USE_DISABLED_REASON,
  COUPON_USE_EXPIRED_REASON,
  COUPON_USE_NOT_STARTED_REASON,
  COUPON_USE_USED_REASON,
  couponThresholdNotMetReason,
} from "../lib/constants/coupons.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { insertCouponTemplateTx, pgCouponRepository } from "../lib/data/pg/couponRepository.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { confirmPaymentRequestPg, pgPaymentRepository } from "../lib/data/pg/paymentRepository.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { createCouponRecord, mockCouponRepository } from "../lib/data/mockCouponRepository.ts";
import { mockPaymentRepository } from "../lib/data/mockPaymentRepository.ts";
import { resetAllMockStores } from "../lib/data/mockStore.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";

/**
 * PROD-1D · **T1「支付确认建单」** 的 PostgreSQL 事务验证（打真库）。
 *
 * ## 这个文件要证明的那一句话
 *
 * > 支付确认成功、订单创建、派单创建、券核销（如果用了券）**必须落在同一个
 * > PostgreSQL 事务里**。
 *
 * 由此派生出四种**结构上不可能出现**的状态，每一种都有可证伪的用例：
 *
 * 1. **Pg 建单而券核销进 Mock**；2. **先提交再 best-effort 核销**；
 * 3. **券被核销但订单没建**；4. **订单建了但券没核销**。
 *
 * ## 为什么必须打真库
 *
 * 伪事务的原子性来自「Node 单线程 + 区段内无 `await`」，事务的原子性来自**数据库**。
 * 用一个假 Pg client 去测，等于把待证明的那一层替换成断言本身：
 * 无论实现是 `BEGIN` 还是几条 auto-commit，假 client 都会说「对」。
 * 因此这里连 `TEST_DATABASE_URL`，**没有库时整体 skip 而不是假装通过**。
 *
 * ## 探针：`w1_write_log` + `w1_probe_fail`
 *
 * 两件靠读代码「看起来对」、但必须由数据库自己回答的事（与
 * `tests/pgW1Transactions.test.mjs` / `tests/pgAdminAuditTransactions.test.mjs`
 * 同一套机制，本仓每个 pg 测试文件各自带一份）：
 *
 * 1. **「所有参与者走同一条连接」**。`BEGIN` 开在 A、某条写入落在 B，
 *    事务根本不存在——而代码看上去一模一样。这里给每张被写的表挂一个 `AFTER`
 *    触发器，把 `pg_backend_pid()` 记进 `w1_write_log`；一次事务里所有写入的
 *    pid 必须**只有一个值**。
 * 2. **「要么全成、要么全不成」**。让触发器在某条语句上抛错（`w1_probe_fail`），
 *    断言前 N−1 条**一条都没留下**。这是唯一能区分「真事务」与「一串各写各的
 *    auto-commit」的观测——两者的返回值完全一样。
 *
 * ⚠️ 探针是**测试库里的对象**，`resetDatabase()` 会把它们的数据清空、
 * 因此它们不构成任何业务 schema。**不改 `lib/**`，不新增 migration。**
 *
 * ## 夹具时间
 *
 * 用例时间取 `plusMinutes(getMockSeedNow().toISOString(), 1)`——与种子同源。
 * 「还没到点 / 已过期」这类断言因此不随执行时刻漂移。
 * 券快照的有效期**由本文件自己写死成 2020~2099 的宽窗口**（种子券的 `validTo`
 * 是 2026-12-31，直接依赖真实时间会让本文件在某一天集体变红，而那与
 * 「券核销在不在同一个事务里」毫无关系）。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  // 本文件跑在独立子进程里（node --test 的默认行为），改环境变量不影响别的文件
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/** 用例时间：与种子同源，见 `pgW1Transactions.test.mjs` 的同名常量。 */
const AT = plusMinutes(getMockSeedNow().toISOString(), 1);

/** 被探针盯上的表：T1 事务真正会写的那五张。 */
const PROBED_TABLES = [
  "payment_requests",
  "orders",
  "payments",
  "dispatch_records",
  "coupon_claims",
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

/** 一次事务里被写过的表（集合，顺序无关）。 */
async function writtenTables() {
  const rows = await executor().query(
    `SELECT DISTINCT table_name FROM w1_write_log ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function clearWriteLog() {
  await executor().query(`DELETE FROM w1_write_log`);
}

/**
 * 让连接池里先有 `size` 条**空闲**连接。
 *
 * ⚠️ 这是并发用例**判别力**的前提，不是可有可无的加速手段：池子里若只有一条空闲连接，
 * 先发出的那个请求会立刻拿走它跑完整段事务，后发的那个还在做 TCP 握手——
 * 两个请求**根本没有重叠**。此时删掉被守护的并发保护（条件 `UPDATE` / 权威读 / 顾问锁）
 * 用例**照样绿**，于是它测不出任何东西。（PROD-1D 实测到过这种假绿。）
 */
async function warmPool(size) {
  await Promise.all(Array.from({ length: size }, () => executor().query("SELECT 1")));
}

async function countRows(table, where = "", values = []) {
  const rows = await executor().query(`SELECT count(*)::int AS n FROM ${table} ${where}`, values);
  return rows[0].n;
}

async function readRequest(id) {
  const rows = await executor().query(`SELECT * FROM payment_requests WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readOrder(id) {
  const rows = await executor().query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readClaim(id) {
  const rows = await executor().query(`SELECT * FROM coupon_claims WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readDispatchByOrder(orderId) {
  const rows = await executor().query(`SELECT * FROM dispatch_records WHERE order_id = $1`, [
    orderId,
  ]);
  return rows[0] ?? null;
}

/** 平台当前的池超时（分钟）。断言里**不硬编码 10 / 60**，跟着种子走。 */
async function poolTimeouts() {
  const rows = await executor().query(
    `SELECT exclusive_pool_timeout_minutes AS exclusive, public_pool_timeout_minutes AS public
       FROM platform_config WHERE id = 1`,
  );
  return rows[0];
}

/* ─────────────────────────────── 夹具 ─────────────────────────────── */

const USER = "u-prod1d-checkout";
const INTRUDER = "u-prod1d-intruder";
/** 可用满减券模板（种子：启用、满 10000 减 1000）。 */
const COUPON_ID = "cpn-mock-new-user";
/** 已停用模板（种子：`enabled: false`）。用它把「模板已停用」这一闸逼到台面上。 */
const DISABLED_COUPON_ID = "cpn-mock-disabled";
/** 券快照的宽有效期：让「一张可用的券」不随真实时钟变红。 */
const WIDE_FROM = "2020-01-01T00:00:00.000Z";
const WIDE_TO = "2099-12-31T15:59:59.000Z";
const CLAIMED_AT = "2026-01-01T00:00:00.000Z";

let seq = 0;
function uniqueId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 一张满减券的**券面快照**（`CouponSnapshot`）。有效期默认宽窗口。 */
function thresholdSnapshot({
  thresholdAmount = 10_000,
  discountAmount = 1_000,
  validFrom = WIDE_FROM,
  validTo = WIDE_TO,
} = {}) {
  return {
    name: "测试满减券",
    formKey: "threshold",
    formLabel: "满减券",
    valueLabel: "满 100 减 10",
    conditionLabel: "测试夹具",
    validFrom,
    validTo,
    thresholdAmount,
    discountAmount,
  };
}

/** 订单 / 支付请求上冻结的**券快照**（`OrderCouponSnapshot`）。 */
function orderCoupon(claimId, couponId = COUPON_ID) {
  const snapshot = thresholdSnapshot();
  return {
    claimId,
    couponId,
    name: snapshot.name,
    formKey: snapshot.formKey,
    thresholdAmount: snapshot.thresholdAmount,
    discountAmount: snapshot.discountAmount,
    valueLabel: snapshot.valueLabel,
    conditionLabel: snapshot.conditionLabel,
  };
}

async function insertClaim({
  id,
  userId = USER,
  couponId = COUPON_ID,
  status = "unused",
  usedAt = null,
  snapshot = thresholdSnapshot(),
  source = "self_claim",
  grantedByAdminId = null,
}) {
  await executor().query(
    `INSERT INTO coupon_claims
       (id, user_id, coupon_id, status, source, claimed_at, used_at, granted_by_admin_id,
        idempotency_key, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
    [id, userId, couponId, status, source, CLAIMED_AT, usedAt, grantedByAdminId, JSON.stringify(snapshot)],
  );
}

/**
 * 插一条 `pending` 的支付请求。
 *
 * ⚠️ 金额自洽是**必须**的：`payment_requests` 上有
 * `actual_paid_amount = total_amount - coupon_discount_amount` 与
 * `total_amount = items_amount + addons_amount` 两条 CHECK，编一组不自洽的数
 * 会在这里就失败，而不是被静默接受。
 */
async function insertRequest({
  id,
  userId = USER,
  idempotencyKey = uniqueId("idem"),
  itemsAmount = 12_000,
  addonsAmount = 0,
  coupon = null,
  couponDiscountAmount = 0,
  companion = null,
  createdAt = AT,
}) {
  const totalAmount = itemsAmount + addonsAmount;
  const actualPaidAmount = totalAmount - couponDiscountAmount;
  const snapshot = {
    productTitle: "三角洲行动 · 机密单（测试夹具）",
    productCoverUrl: "/mock/cover.svg",
    specName: "4 小时（测试夹具）",
    unitPrice: itemsAmount,
    gameName: "三角洲行动",
    addons: [],
    companion,
  };

  await executor().query(
    `INSERT INTO payment_requests
       (id, user_id, idempotency_key, status, product_id, spec_id, quantity, region,
        addon_ids, game_account_id, remark, companion_id, coupon_claim_id,
        created_at, confirmed_at, items_amount, addons_amount, total_amount,
        coupon_discount_amount, actual_paid_amount, companion_rate_snapshot,
        coupon, snapshot, order_id)
     VALUES ($1, $2, $3, 'pending', 'p-test', 's-test', 1, '手游',
             $4::jsonb, 'acc-test', '测试夹具', $5, $6,
             $7, NULL, $8, $9, $10,
             $11, $12, 8000,
             $13::jsonb, $14::jsonb, NULL)`,
    [
      id,
      userId,
      idempotencyKey,
      JSON.stringify([]),
      companion ? companion.id : null,
      coupon ? coupon.claimId : null,
      createdAt,
      itemsAmount,
      addonsAmount,
      totalAmount,
      couponDiscountAmount,
      actualPaidAmount,
      coupon ? JSON.stringify(coupon) : null,
      JSON.stringify(snapshot),
    ],
  );

  return { id, userId, totalAmount, actualPaidAmount, couponDiscountAmount, coupon };
}

/**
 * 建单回调 —— 与 `lib/services/checkout.ts` 的 `buildOrderFromRequest` 同义：
 * **纯构造**，一行都不写，且金额域自洽（满足 `orders` 上的三条金额 CHECK）。
 *
 * ⚠️ `createdAt` 取 `AT`（夹具时刻）而不是 `new Date()`：派单快照与券核销时刻
 * 都取 `order.createdAt`，钉住它之后
 * 「`exclusive_deadline_at` = at + 专属池超时」这句断言才不随执行时刻漂移。
 * 生产实现取真实墙钟——这里钉时钟是**夹具**的选择，不是规则。
 */
function buildOrderFromRequest(request) {
  const companionBaseIncome = Math.floor(
    (request.totalAmount * request.companionRateSnapshot) / 10_000,
  );
  return {
    id: `ord_${randomUUID()}`,
    orderNo: `TEST-${randomUUID()}`,
    userId: request.userId,
    status: "paid",
    createdAt: AT,
    paidAt: AT,
    acceptedAt: null,
    servingAt: null,
    completedAt: null,
    refundedAt: null,
    everAcceptedAt: null,

    productId: request.productId,
    productTitle: request.snapshot.productTitle,
    productCoverUrl: request.snapshot.productCoverUrl,
    specId: request.specId,
    specName: request.snapshot.specName,
    unitPrice: request.snapshot.unitPrice,

    quantity: request.quantity,
    gameName: request.snapshot.gameName,
    region: request.region,
    gameAccountId: request.gameAccountId,
    remark: request.remark,
    addons: request.snapshot.addons,

    itemsAmount: request.itemsAmount,
    addonsAmount: request.addonsAmount,
    totalAmount: request.totalAmount,
    originalAmount: request.totalAmount,
    couponDiscountAmount: request.couponDiscountAmount,
    actualPaidAmount: request.actualPaidAmount,
    companionRateSnapshot: request.companionRateSnapshot,
    companionBaseIncome,
    clubNetIncome: request.actualPaidAmount - companionBaseIncome,
    refundedAmount: 0,

    coupon: request.coupon,
    actualCompanionId: null,
    companion: null,
    complaintWindowMinutesSnapshot: null,
    complaintDeadlineAt: null,
  };
}

const COMPANION_CP1 = { id: "cp-1", name: "阿泽（占位）", avatarUrl: "/mock/avatar-1.svg" };

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

/* ══════════════ 一、无券正常支付：三个写参与者一起落库 ══════════════ */

test("无券支付确认成功：请求认领 / 订单 / 支付记录 / 派单四件事一起落库", { skip: SKIP }, async () => {
  // ⚠️ 预置数据里**本来就有订单**（种子订单 + 榜单订单），因此断言必须写成
  // 「比原来多一张」，不能写成「恰好一张」——后者只是把种子的条数抄进断言里
  const ordersBefore = await countRows("orders");
  const request = await insertRequest({ id: "pr-nc-1" });
  const cfg = await poolTimeouts();

  // 夹具写入也走探针，先清掉，下面「写了哪几张表」才是被测事务的答案
  await clearWriteLog();

  const result = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);

  assert.ok(result, "支付请求存在时不该返回 null");
  assert.equal(result.orderCreated, true);
  assert.equal("kind" in result, false, "成功的确认不是 coupon-unavailable 分支");

  // ① 支付请求被认领，且订单号已回填
  const settled = await readRequest(request.id);
  assert.equal(settled.status, "success");
  assert.ok(settled.confirmed_at !== null, "确认时刻由数据库 now() 写下");
  assert.equal(settled.order_id, result.order.id, "order_id 已回填");
  assert.equal(result.request.orderId, result.order.id);

  // ② 订单恰好**多出一行**、支付记录恰好一行
  assert.equal(await countRows("orders"), ordersBefore + 1, "只多出一张新订单");
  assert.equal(await countRows("payments"), 1, "一次确认只产生一条支付记录");

  const order = await readOrder(result.order.id);
  assert.equal(order.status, "paid");
  assert.equal(order.actual_companion_id, null, "刚建出来还没有人接单");
  assert.equal(order.coupon, null, "无券订单上不冻结券快照");

  const payment = (await executor().query(`SELECT * FROM payments WHERE order_id = $1`, [order.id]))[0];
  assert.equal(payment.payment_request_id, request.id);
  assert.equal(payment.amount, request.actualPaidAmount, "渠道实收 = 实付");
  assert.equal(payment.status, "success");
  assert.equal(payment.paid_at, settled.confirmed_at, "支付时刻取认领那一刻写下的 confirmed_at");

  // ③ 派单恰好一行，且落在公共池（结算时没指定人）
  const dispatch = await readDispatchByOrder(order.id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.exclusive_companion_id, null);
  assert.equal(dispatch.exclusive_entered_at, null);
  assert.equal(dispatch.exclusive_deadline_at, null);
  assert.equal(dispatch.exclusive_timeout_minutes_snapshot, null);
  assert.equal(dispatch.public_pool_entered_at, AT, "进池时刻 = 建单时刻");
  assert.equal(dispatch.public_deadline_at, plusMinutes(AT, cfg.public));
  assert.equal(dispatch.public_timeout_minutes_snapshot, cfg.public, "时长当场冻结");
  assert.equal(dispatch.accepted_by_companion_id, null);

  // ④ 券一个字都没被碰过：整表逐行相同（最强的一种「没动」）
  const claims = await executor().query(`SELECT * FROM coupon_claims ORDER BY id`);
  assert.equal(claims.length, 3, "预置三条领取记录原样在此");
  assert.deepEqual(
    await writtenTables(),
    ["dispatch_records", "orders", "payment_requests", "payments"],
    "无券时这四张表都被写、且**只有**这四张——coupon_claims 一个字节都没写",
  );
});

/* ═══════════════ 二、有券正常支付：券在同一事务里核销 ═══════════════ */

test("有券支付确认成功：券 unused → used，快照与金额与支付请求上冻结的一致", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-ok-1" });
  const coupon = orderCoupon("claim-ok-1");
  const request = await insertRequest({
    id: "pr-cp-1",
    coupon,
    couponDiscountAmount: 1_000,
  });
  await clearWriteLog();

  const result = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);
  assert.equal(result.orderCreated, true);

  const order = await readOrder(result.order.id);
  // ① 券被核销，且核销时刻 = 建单时刻（同一个 `at`，不是两次取钟）
  const claim = await readClaim("claim-ok-1");
  assert.equal(claim.status, "used");
  assert.equal(claim.used_at, order.created_at, "used_at 必须等于订单的 created_at");

  // ② 订单落库的券快照与支付请求上冻结的那份一致（一字不差，逐字段）
  assert.deepEqual(order.coupon, coupon);
  assert.deepEqual(claim.snapshot, thresholdSnapshot(), "领取记录自己的快照不被改写");

  // ③ 金额：抵扣与实付与请求上冻结的一致，且恒等式成立
  assert.equal(order.coupon_discount_amount, 1_000);
  assert.equal(order.original_amount, request.totalAmount);
  assert.equal(order.actual_paid_amount, request.actualPaidAmount);
  assert.equal(
    order.companion_base_income + order.club_net_income,
    order.actual_paid_amount,
    "实付 = 打手收益 + 平台净收入",
  );
  assert.equal(
    order.companion_base_income,
    Math.floor((order.original_amount * order.companion_rate_snapshot) / 10_000),
    "打手收益按**优惠前**基数算（券不降低打手理论基础收益）",
  );

  // ④ 券核销、订单、支付、派单、请求认领全在一批写入里
  assert.deepEqual(
    await writtenTables(),
    ["coupon_claims", "dispatch_records", "orders", "payment_requests", "payments"],
    "五张表都被写，缺一张就说明有一件事跑到了事务外面",
  );
});

/* ═══════════ 三、指定护航：专属池；未指定：公共池 ═══════════ */

test("指定护航：派单落专属池，截止时间 = 建单时刻 + 专属池超时，公共池三列为 NULL", { skip: SKIP }, async () => {
  const cfg = await poolTimeouts();
  const request = await insertRequest({
    id: "pr-ex-1",
    companion: COMPANION_CP1,
  });

  const result = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);
  assert.equal(result.orderCreated, true);

  const dispatch = await readDispatchByOrder(result.order.id);
  assert.equal(dispatch.state, "exclusive");
  assert.equal(dispatch.exclusive_companion_id, "cp-1");
  assert.equal(dispatch.exclusive_entered_at, AT);
  assert.equal(
    dispatch.exclusive_deadline_at,
    plusMinutes(AT, cfg.exclusive),
    "截止时间 = at + 专属池超时",
  );
  assert.equal(dispatch.exclusive_timeout_minutes_snapshot, cfg.exclusive);
  // 专属池里这三列必须为空：写上了就意味着它同时在两个池子里等人
  assert.equal(dispatch.public_pool_entered_at, null);
  assert.equal(dispatch.public_deadline_at, null);
  assert.equal(dispatch.public_timeout_minutes_snapshot, null);

  // 用户指定的人只进派单，**不进订单**：订单上还没有「实际接单人」
  const order = await readOrder(result.order.id);
  assert.equal(order.actual_companion_id, null);
  assert.equal(order.companion, null);
});

test("未指定护航：派单落公共池，专属池三列为 NULL", { skip: SKIP }, async () => {
  const cfg = await poolTimeouts();
  const request = await insertRequest({ id: "pr-pub-1", companion: null });

  const result = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);
  assert.equal(result.orderCreated, true);

  const dispatch = await readDispatchByOrder(result.order.id);
  assert.equal(dispatch.state, "public");
  assert.equal(dispatch.public_pool_entered_at, AT);
  assert.equal(dispatch.public_deadline_at, plusMinutes(AT, cfg.public));
  assert.equal(dispatch.public_timeout_minutes_snapshot, cfg.public);
  assert.equal(dispatch.exclusive_companion_id, null);
  assert.equal(dispatch.exclusive_entered_at, null);
  assert.equal(dispatch.exclusive_deadline_at, null);
  assert.equal(dispatch.exclusive_timeout_minutes_snapshot, null);
});

/* ═══════════ 四、券不可用：返回原因，且一个字节都没写 ═══════════ */

/**
 * 「券不可用」这一类用例的共同断言：返回 `{ kind: "coupon-unavailable" }`、
 * `reason` 逐字相同、**整段回滚**。
 *
 * ⚠️ 这里必须先写后判：确认的那一瞬间实现**已经把支付请求认领掉了**
 * （`UPDATE … SET status='success'`），若券不可用只是「正常返回一个失败结论」，
 * 那句话会被提交，留下「支付成功、没有订单」——正是本轮禁止的状态。
 * 所以下面每一条都断言 `payment_requests` **仍是 pending**。
 */
async function assertCouponUnavailable({ requestId, claimId, reason, ordersBefore, paymentsBefore, dispatchesBefore }) {
  // 先留一份「拒绝之前」的券行：五种拒绝理由里有一种（已使用）本来就已经是 `used`，
  // 因此不能断言「结果是 unused」，只能断言**这一行一个字节都没变**
  const claimBefore = await readClaim(claimId);
  // 夹具自己的写入也走探针；下面的「零写入」必须是**这一次确认**留下的答案
  await clearWriteLog();

  const result = await confirmPaymentRequestPg(requestId, "success", buildOrderFromRequest);

  assert.ok(result, "支付请求存在时不该返回 null");
  assert.equal(result.kind, "coupon-unavailable", `实际返回 ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason, "原因必须与 lib/constants/coupons.ts 里的那句话逐字相同");

  // 支付请求：仍是 pending，既没认领也没回填订单号
  const request = await readRequest(requestId);
  assert.equal(request.status, "pending", "认领必须随事务一起回滚");
  assert.equal(request.confirmed_at, null);
  assert.equal(request.order_id, null);

  // 订单 / 支付 / 派单：一行都没有多
  assert.equal(await countRows("orders"), ordersBefore, "不得多出订单");
  assert.equal(await countRows("payments"), paymentsBefore, "不得多出支付记录");
  assert.equal(await countRows("dispatch_records"), dispatchesBefore, "不得多出派单");

  // 券：整行原样（原本 `used` 的仍是 `used`，原本 `unused` 的仍是 `unused`；`used_at` 不动）
  assert.deepEqual(await readClaim(claimId), claimBefore, "被拒不得改动券一个字");

  // 整段回滚的另一个观测：探针日志也跟着回滚了，一条写入都没留下
  assert.deepEqual(await writtenTables(), [], "回滚后不留下任何写入");
}

test("券不可用 · 已使用：reason 为「该券已使用」，且零写入零回填", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-used", status: "used", usedAt: AT });
  const request = await insertRequest({
    id: "pr-cu-used",
    coupon: orderCoupon("claim-used"),
    couponDiscountAmount: 1_000,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-used",
    reason: COUPON_USE_USED_REASON,
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

test("券不可用 · 已过期：reason 为「该券已过有效期，无法使用」", { skip: SKIP }, async () => {
  await insertClaim({
    id: "claim-expired",
    snapshot: thresholdSnapshot({
      validFrom: plusMinutes(AT, -2880),
      validTo: plusMinutes(AT, -1440),
    }),
  });
  const request = await insertRequest({
    id: "pr-cu-expired",
    coupon: orderCoupon("claim-expired"),
    couponDiscountAmount: 1_000,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-expired",
    reason: COUPON_USE_EXPIRED_REASON,
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

test("券不可用 · 尚未开始：reason 为「该券尚未到可用时间」", { skip: SKIP }, async () => {
  await insertClaim({
    id: "claim-upcoming",
    snapshot: thresholdSnapshot({
      validFrom: plusMinutes(AT, 1440),
      validTo: plusMinutes(AT, 2880),
    }),
  });
  const request = await insertRequest({
    id: "pr-cu-upcoming",
    coupon: orderCoupon("claim-upcoming"),
    couponDiscountAmount: 1_000,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-upcoming",
    reason: COUPON_USE_NOT_STARTED_REASON,
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

test("券不可用 · 模板已停用：reason 为「该券已停用，无法使用」", { skip: SKIP }, async () => {
  // `cpn-mock-disabled` 是种子里唯一 `enabled: false` 的模板
  await insertClaim({ id: "claim-disabled", couponId: DISABLED_COUPON_ID });
  const request = await insertRequest({
    id: "pr-cu-disabled",
    coupon: orderCoupon("claim-disabled", DISABLED_COUPON_ID),
    couponDiscountAmount: 1_000,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-disabled",
    reason: COUPON_USE_DISABLED_REASON,
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

test("券不可用 · 未达门槛：reason 写明还差多少，与共享函数逐字相同", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-threshold" });
  const request = await insertRequest({
    id: "pr-cu-threshold",
    itemsAmount: 5_000,
    coupon: orderCoupon("claim-threshold"),
    couponDiscountAmount: 0,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-threshold",
    // 门槛基数是优惠前应付 5000，门槛 10000；文案由**共享函数**给出，不手写
    reason: couponThresholdNotMetReason(5_000, 10_000),
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

test("券不可用 · 不属于本人：与「不存在」同一句话，且不泄露券面", { skip: SKIP }, async () => {
  // 券属于 USER，但支付请求的用户是另一个人
  await insertClaim({ id: "claim-not-mine", userId: USER });
  const request = await insertRequest({
    id: "pr-cu-not-mine",
    userId: INTRUDER,
    coupon: orderCoupon("claim-not-mine"),
    couponDiscountAmount: 1_000,
  });

  const ordersBefore = await countRows("orders");
  const paymentsBefore = await countRows("payments");
  const dispatchesBefore = await countRows("dispatch_records");

  await assertCouponUnavailable({
    requestId: request.id,
    claimId: "claim-not-mine",
    reason: COUPON_CLAIM_NOT_FOUND_REASON,
    ordersBefore,
    paymentsBefore,
    dispatchesBefore,
  });
});

/* ══════════════ 五、同券并发：只有一个赢家，券只核销一次 ══════════════ */

/**
 * ## 这条用例凭什么有判别力（PROD-1D 实测到它一度是**假绿**）
 *
 * 朴素的 `Promise.all` 并发：池子冷的时候两个请求**根本不重叠**——第一个拿走唯一的
 * 空闲连接跑完整段事务并提交，第二个还在握手，于是它读到的是 `used`，被 `resolveCouponApplication`
 * 拒掉。实测：把 `redeemCouponClaimForOrderTx` 条件 `UPDATE` 的谓词 `AND status = 'unused'`
 * 整条删掉（并发保护消失），这条用例**仍然全绿**——它测到的其实是「顺序执行」。
 *
 * 因此这里做两件事把窗口**真的**撑开：
 * 1. `warmPool(2)` —— 两个请求各自先有一条就绪连接，发出后立刻重叠；
 * 2. 在 `coupon_claims` 上挂一个**测试专用**的 `BEFORE UPDATE` 触发器做 `pg_sleep` ——
 *    赢家在**持有该行行锁**期间被拖住，输家的「读券 → 判 unused」必然落在赢家提交
 *    **之前**，于是复现真实的双花时刻。触发器在 `finally` 里摘掉。
 */

test("同券并发：两笔待支付请求同时确认，恰好一单成功、另一单 coupon-unavailable", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-race" });
  const coupon = orderCoupon("claim-race");
  // 两笔请求都合法地创建出来（建请求时券还是 unused）——这正是真实的双花窗口
  const first = await insertRequest({ id: "pr-race-a", coupon, couponDiscountAmount: 1_000 });
  const second = await insertRequest({ id: "pr-race-b", coupon, couponDiscountAmount: 1_000 });
  const ordersBefore = await countRows("orders");
  const dispatchesBefore = await countRows("dispatch_records");
  await clearWriteLog();
  await warmPool(2);

  // 撑开赢家持有行锁的窗口（理由见用例说明），只对本用例生效，finally 摘除
  await executor().query(
    `CREATE OR REPLACE FUNCTION cc_sleep_probe() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       PERFORM pg_sleep(0.3);
       RETURN NEW;
     END
     $$`,
  );
  await executor().query(
    `CREATE TRIGGER cc_sleep_trg BEFORE UPDATE ON coupon_claims
       FOR EACH ROW EXECUTE FUNCTION cc_sleep_probe()`,
  );

  let a;
  let b;
  try {
    [a, b] = await Promise.all([
      confirmPaymentRequestPg(first.id, "success", buildOrderFromRequest),
      confirmPaymentRequestPg(second.id, "success", buildOrderFromRequest),
    ]);
  } finally {
    await executor().query(`DROP TRIGGER IF EXISTS cc_sleep_trg ON coupon_claims`);
  }

  const winners = [a, b].filter((result) => result && result.orderCreated === true);
  const losers = [a, b].filter((result) => result && result.kind === "coupon-unavailable");
  assert.equal(winners.length, 1, "恰好一个赢家（两个都成功 = 双花）");
  assert.equal(losers.length, 1, "另一个必须看到券已被用掉");
  assert.equal(losers[0].reason, COUPON_USE_USED_REASON);

  // 库里只多出一张订单、券只被核销一次
  assert.equal(await countRows("orders"), ordersBefore + 1, "不得出现第二张订单");
  assert.equal(await countRows("payments"), 1);
  assert.equal(await countRows("dispatch_records"), dispatchesBefore + 1, "只多出一行派单");

  const claim = await readClaim("claim-race");
  assert.equal(claim.status, "used");
  assert.equal(claim.used_at, AT, "核销时刻只被写一次");

  // 「没有两张订单共用一个 claim」——按冻结在订单上的券快照查
  assert.equal(
    await countRows("orders", `WHERE coupon->>'claimId' = $1`, ["claim-race"]),
    1,
    "共用同一张券的订单只能有一张",
  );

  // 输的那笔必须原地停在 pending，一个字节都没留下
  const loserId = a === winners[0] ? second.id : first.id;
  const loser = await readRequest(loserId);
  assert.equal(loser.status, "pending");
  assert.equal(loser.order_id, null);
});

/* ══════════════ 六、重复确认：既有行为，不建第二个订单 ══════════════ */

test("重复确认：第二次原样返回既有订单，一个字节都不写", { skip: SKIP }, async () => {
  const ordersBefore = await countRows("orders");
  const request = await insertRequest({ id: "pr-repeat-1" });

  const first = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);
  assert.equal(first.orderCreated, true);

  await clearWriteLog();
  const second = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);

  assert.equal(second.orderCreated, false, "第二次不再建单");
  assert.equal(second.order.id, first.order.id, "返回的是同一张订单");
  assert.deepEqual(await writePids(), [], "重放不写任何东西");
  assert.equal(await countRows("orders"), ordersBefore + 1, "不得出现第二张订单");
  assert.equal(await countRows("payments"), 1);
});

/* ══════════════ 七、回滚证明 A：派单写不进去 → 全部回滚 ══════════════ */

test("回滚 A · 派单写不进去：订单 / 支付 / 请求 / 券全部回到原样", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-rb-a" });
  const coupon = orderCoupon("claim-rb-a");
  const request = await insertRequest({ id: "pr-rb-a", coupon, couponDiscountAmount: 1_000 });

  const ordersBefore = await countRows("orders");
  const dispatchesBefore = await countRows("dispatch_records");
  await clearWriteLog();

  // ⚠️ 派单写入排在**券核销之后**：这一步失败时，券已经被核销过、订单与支付
  //    也已经插入过——只有真事务能把它们一起带走
  await failWritesOn("dispatch_records");
  await assert.rejects(
    () => confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest),
    /w1-probe: 拒绝写入 dispatch_records/,
  );

  const settled = await readRequest(request.id);
  assert.equal(settled.status, "pending", "支付请求没有被认领");
  assert.equal(settled.confirmed_at, null);
  assert.equal(settled.order_id, null);

  assert.equal(await countRows("orders"), ordersBefore, "订单没有留下");
  assert.equal(await countRows("payments"), 0, "支付记录没有留下");
  assert.equal(await countRows("dispatch_records"), dispatchesBefore, "派单没有留下");

  const claim = await readClaim("claim-rb-a");
  assert.equal(claim.status, "unused", "★ 券必须回到未使用");
  assert.equal(claim.used_at, null, "★ 核销时刻必须一起回滚");
});

/* ══════════════ 八、回滚证明 B：支付记录写不进去 → 全部回滚 ══════════════ */

test("回滚 B · 支付记录写不进去：订单已插入也必须被带走，券回到 unused", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-rb-b" });
  const coupon = orderCoupon("claim-rb-b");
  const request = await insertRequest({ id: "pr-rb-b", coupon, couponDiscountAmount: 1_000 });

  const ordersBefore = await countRows("orders");
  const dispatchesBefore = await countRows("dispatch_records");
  await clearWriteLog();

  // 支付记录排在订单**之后**：此刻订单已经真的写进库里了
  await failWritesOn("payments");
  await assert.rejects(
    () => confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest),
    /w1-probe: 拒绝写入 payments/,
  );

  const settled = await readRequest(request.id);
  assert.equal(settled.status, "pending", "支付请求没有被认领");
  assert.equal(settled.confirmed_at, null);
  assert.equal(settled.order_id, null);

  assert.equal(await countRows("orders"), ordersBefore, "★ 已插入的订单必须被回滚");
  assert.equal(await countRows("payments"), 0);
  assert.equal(await countRows("dispatch_records"), dispatchesBefore, "派单没轮到写，也没留下");

  const claim = await readClaim("claim-rb-b");
  assert.equal(claim.status, "unused", "★ 券必须回到未使用");
  assert.equal(claim.used_at, null);
});

/* ══════════════ 九、单连接证明：一次确认只走一条连接 ══════════════ */

test("单连接：一次成功确认里所有写入的 pg_backend_pid 只有一个值", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-conn" });
  const request = await insertRequest({
    id: "pr-conn-1",
    coupon: orderCoupon("claim-conn"),
    couponDiscountAmount: 1_000,
  });
  await clearWriteLog();

  await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);

  // ⚠️ 这条断言是唯一能证伪「仓储自己又拿了一条连接」的观测：
  //    `BEGIN` 开在 A、某条写入落在 B，事务根本不存在，而代码在两个情况下长得一模一样
  const pids = await writePids();
  assert.equal(pids.length, 1, `一次事务只能有一条连接，实际见到 ${pids.length} 条`);
});

/* ══════════════ 十、重启持久化：确认后重开连接池再读一遍 ══════════════ */

test("重启持久化：确认后关掉连接池再读，四张表的数据仍在", { skip: SKIP }, async () => {
  await insertClaim({ id: "claim-keep" });
  const request = await insertRequest({
    id: "pr-keep-1",
    coupon: orderCoupon("claim-keep"),
    couponDiscountAmount: 1_000,
  });

  const result = await confirmPaymentRequestPg(request.id, "success", buildOrderFromRequest);
  assert.equal(result.orderCreated, true);

  // `closePool()` 把连接池整个关掉，下次取执行器会建一条全新的连接。
  // 这是单进程内最接近「进程重启」的动作：内存里的一切都没了，只剩库里的行
  await closePool();

  const order = await readOrder(result.order.id);
  assert.equal(order.status, "paid");
  assert.equal(order.coupon_discount_amount, 1_000);
  assert.equal(order.actual_paid_amount, request.actualPaidAmount);

  const settled = await readRequest(request.id);
  assert.equal(settled.status, "success");
  assert.equal(settled.order_id, order.id);

  const dispatch = await readDispatchByOrder(order.id);
  assert.ok(dispatch, "派单记录仍在");
  assert.equal(dispatch.state, "public");

  const claim = await readClaim("claim-keep");
  assert.equal(claim.status, "used");
  assert.equal(claim.used_at, order.created_at);
});

/* ══════════ 十一、契约等价：Mock 与 Pg 对同一次「用券建单」给出同一张订单 ══════════ */

/**
 * T1 的**用券链**在 Mock 与 PostgreSQL 两侧必须逐字段等价。
 *
 * ## 这条用例证伪什么
 *
 * 前十条用例都在证明「Pg 这一侧自洽」；它们**证明不了**「两侧给出同一个答案」。
 * 上一轮把券核销与派单从 `lib/services/checkout.ts` 的 `buildOrderFromRequest()`
 * 里搬到了「按存储分家」的两份实现里（Mock 走
 * `commitMockCheckoutParticipants()`，Pg 走同一事务的 SQL）。搬动之后最容易发生的
 * 事故不是「Pg 写错」而是**「规则只改了一处」**——比如把闸门顺序、券核销时刻、
 * 门槛基数（优惠前应付 vs 实付）在两侧写成了不同的式子。那种漂移在单侧断言里
 * **完全看不见**，因为两侧各自都自洽。
 *
 * 因此这里造一份**同一个世界**（同一张券模板、同一条领取记录、同一笔支付请求、
 * 同一个建单回调），分别喂给两个实现，再逐字段比对。
 *
 * ## 比对手法照抄 `tests/pgContract.test.mjs` 的 T1 那条用例
 *
 * 那份现成的口径是：
 *
 * - 会**由实现生成**的东西（时钟给出的 `confirmedAt`）归一化成占位符——
 *   Mock 取进程墙钟、Pg 取数据库 `now()`，它们**必然**不同，把它算成差异
 *   只会让用例永远红着；
 * - 其余字段**一个都不放过**——金额、状态、快照、`orderId` 全在比。
 *
 * 这里额外把 `order.id` / `orderNo` / `createdAt` 也**钉成固定值**（由测试自己
 * 提供的建单回调给出），于是「两侧返回的订单」可以直接逐字段比，
 * 不需要再为「谁生成的 id 更长」这类无关差异写例外。
 */
const CONTRACT_USER = "u-prod1d-contract";
const CONTRACT_COUPON_ID = "cpn-prod1d-contract";
const CONTRACT_CLAIM_ID = "claim-prod1d-contract";
const CONTRACT_REQUEST_ID = "pr-prod1d-contract";
const CONTRACT_ORDER_ID = "ord-prod1d-contract-1";
const CONTRACT_ORDER_NO = "TEST-CONTRACT-1";
const CONTRACT_ITEMS_AMOUNT = 12_000;
const CONTRACT_DISCOUNT = 1_000;
const CONTRACT_RATE_BP = 8_000;

/** 契约对照用的券模板：有效期开成 2020~2099，避免用例在某一天因过期集体变红。 */
function contractCouponTemplate() {
  return {
    id: CONTRACT_COUPON_ID,
    name: "契约对照券（测试夹具）",
    formKey: "threshold",
    formLabel: COUPON_FORM_LABELS.threshold,
    valueLabel: "满 100 减 10",
    conditionLabel: "契约对照（测试夹具）",
    validFrom: WIDE_FROM,
    validTo: WIDE_TO,
    enabled: true,
    thresholdAmount: 10_000,
    discountAmount: CONTRACT_DISCOUNT,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  };
}

/** 契约对照用的领取记录：快照取自上面那张模板（与真实领取路径一致）。 */
function contractClaim() {
  const template = contractCouponTemplate();
  return {
    id: CONTRACT_CLAIM_ID,
    userId: CONTRACT_USER,
    couponId: CONTRACT_COUPON_ID,
    status: "unused",
    source: "self_claim",
    claimedAt: CLAIMED_AT,
    usedAt: null,
    grantedByAdminId: null,
    snapshot: {
      name: template.name,
      formKey: template.formKey,
      formLabel: template.formLabel,
      valueLabel: template.valueLabel,
      conditionLabel: template.conditionLabel,
      validFrom: template.validFrom,
      validTo: template.validTo,
      thresholdAmount: template.thresholdAmount,
      discountAmount: template.discountAmount,
    },
  };
}

/** 冻结在支付请求 / 订单上的券快照。 */
function contractOrderCoupon() {
  const template = contractCouponTemplate();
  return {
    claimId: CONTRACT_CLAIM_ID,
    couponId: CONTRACT_COUPON_ID,
    name: template.name,
    formKey: template.formKey,
    thresholdAmount: template.thresholdAmount,
    discountAmount: template.discountAmount,
    valueLabel: template.valueLabel,
    conditionLabel: template.conditionLabel,
  };
}

/** 支付请求字面量：金额自洽（12000 − 1000 = 11000 = 9600 + 1400）。 */
function contractRequest() {
  return {
    id: CONTRACT_REQUEST_ID,
    userId: CONTRACT_USER,
    idempotencyKey: "contract-key-1",
    status: "pending",
    productId: "p-contract",
    specId: "s-contract",
    quantity: 1,
    region: "手游",
    addonIds: [],
    gameAccountId: "acc-contract",
    remark: "契约对照",
    companionId: null,
    couponClaimId: CONTRACT_CLAIM_ID,
    createdAt: AT,
    confirmedAt: null,
    itemsAmount: CONTRACT_ITEMS_AMOUNT,
    addonsAmount: 0,
    totalAmount: CONTRACT_ITEMS_AMOUNT,
    couponDiscountAmount: CONTRACT_DISCOUNT,
    actualPaidAmount: CONTRACT_ITEMS_AMOUNT - CONTRACT_DISCOUNT,
    companionRateSnapshot: CONTRACT_RATE_BP,
    coupon: contractOrderCoupon(),
    orderId: null,
    snapshot: {
      productTitle: "契约对照商品（测试夹具）",
      productCoverUrl: "/mock/cover.svg",
      specName: "契约对照规格（测试夹具）",
      unitPrice: CONTRACT_ITEMS_AMOUNT,
      gameName: "三角洲行动",
      addons: [],
      companion: null,
    },
  };
}

/**
 * 建单回调：**固定字面量**（id / 单号 / 时刻全是常量），因此两侧返回的订单可直接比。
 * 38 个字段一处不漏——少一个字段，`orders` 的 INSERT 就会在那里断掉。
 */
function contractOrder() {
  const base = Math.floor((CONTRACT_ITEMS_AMOUNT * CONTRACT_RATE_BP) / 10_000);
  const actualPaid = CONTRACT_ITEMS_AMOUNT - CONTRACT_DISCOUNT;
  return {
    id: CONTRACT_ORDER_ID,
    orderNo: CONTRACT_ORDER_NO,
    userId: CONTRACT_USER,
    status: "paid",
    createdAt: AT,
    paidAt: AT,
    acceptedAt: null,
    servingAt: null,
    completedAt: null,
    refundedAt: null,
    everAcceptedAt: null,

    productId: "p-contract",
    productTitle: "契约对照商品（测试夹具）",
    productCoverUrl: "/mock/cover.svg",
    specId: "s-contract",
    specName: "契约对照规格（测试夹具）",
    unitPrice: CONTRACT_ITEMS_AMOUNT,

    quantity: 1,
    gameName: "三角洲行动",
    region: "手游",
    gameAccountId: "acc-contract",
    remark: "契约对照",
    addons: [],

    itemsAmount: CONTRACT_ITEMS_AMOUNT,
    addonsAmount: 0,
    totalAmount: CONTRACT_ITEMS_AMOUNT,
    originalAmount: CONTRACT_ITEMS_AMOUNT,
    couponDiscountAmount: CONTRACT_DISCOUNT,
    actualPaidAmount: actualPaid,
    companionRateSnapshot: CONTRACT_RATE_BP,
    companionBaseIncome: base,
    clubNetIncome: actualPaid - base,
    refundedAmount: 0,

    coupon: contractOrderCoupon(),
    actualCompanionId: null,
    companion: null,
    complaintWindowMinutesSnapshot: null,
    complaintDeadlineAt: null,
  };
}

/** `confirmedAt` 由时钟给出（Mock 墙钟 / Pg `now()`），两侧必然不同：归一化成占位符。 */
function normalizeContractRequest(request) {
  return (
    request && {
      ...request,
      confirmedAt: request.confirmedAt === null ? null : "<确认时刻>",
    }
  );
}

/**
 * 同一段「观察」，两侧各跑一遍。
 *
 * ⚠️ 世界的**造法**两侧不同（Mock 用仓储原语写进进程内存，Pg 用模板写入函数 +
 * 仓储写进库），因此不能像 `pgContract.test.mjs` 那样把同一个函数喂给两个实现。
 * 但**观察到的形状**必须完全一致，最后 `deepEqual` 的就是它。
 */
function contractObservation(result, claim, readBackOrder) {
  return {
    orderCreated: result.orderCreated,
    order: result.order,
    request: normalizeContractRequest(result.request),
    readBackOrder,
    claimStatus: claim.status,
    claimUsedAt: claim.usedAt,
  };
}

async function observeContractOnMock() {
  // 每次都换掉整份 Mock 存储：上一个用例的写入绝不能留到这里
  resetAllMockStores();
  createCouponRecord(contractCouponTemplate());
  await mockCouponRepository.createClaim(contractClaim(), "contract-claim-key");
  await mockPaymentRepository.createPaymentRequest(contractRequest());

  const result = await mockPaymentRepository.confirmPaymentRequest(
    CONTRACT_REQUEST_ID,
    "success",
    contractOrder,
  );
  const claim = await mockCouponRepository.findClaimById(CONTRACT_USER, CONTRACT_CLAIM_ID);
  return contractObservation(result, claim, await mockPaymentRepository.findOrderById(CONTRACT_ORDER_ID));
}

async function observeContractOnPg() {
  await insertCouponTemplateTx(executor(), contractCouponTemplate());
  await pgCouponRepository.createClaim(contractClaim(), "contract-claim-key");
  await pgPaymentRepository.createPaymentRequest(contractRequest());

  const result = await confirmPaymentRequestPg(CONTRACT_REQUEST_ID, "success", contractOrder);
  const claim = await pgCouponRepository.findClaimById(CONTRACT_USER, CONTRACT_CLAIM_ID);
  return contractObservation(result, claim, await pgPaymentRepository.findOrderById(CONTRACT_ORDER_ID));
}

test("用券建单契约等价：同一份世界下 Mock 与 Pg 给出同一张订单、同一个核销结论", { skip: SKIP }, async () => {
  const fromMock = await observeContractOnMock();
  const fromPg = await observeContractOnPg();

  // 先钉住「这次确实建成了一单、券确实被核销」——
  // 否则两个都失败的世界也会 deepEqual 通过，比对就退化成自我印证
  assert.equal(fromMock.orderCreated, true);
  assert.equal(fromMock.request.status, "success");
  assert.equal(fromMock.request.orderId, CONTRACT_ORDER_ID);
  assert.equal(fromMock.request.createdAt, AT, "创建时间必须原样落库（错位会在这里暴露）");
  assert.equal(fromMock.claimStatus, "used");
  assert.equal(fromMock.claimUsedAt, AT);
  assert.equal(fromMock.claimUsedAt, fromMock.order.createdAt, "核销时刻 = 建单时刻");
  assert.deepEqual(fromMock.readBackOrder, contractOrder(), "Mock 回读的订单就是那份固定字面量");

  // ★ 逐字段比对：返回的订单、回读的订单、支付请求、券的核销结论
  assert.deepEqual(fromPg, fromMock, "Pg 与 Mock 对同一次用券建单必须逐字段相同");
});
