import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { databaseNameOf, PgConfigError } from "../lib/data/pg/config.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { checkDatabaseHealth, formatDatabaseHealth } from "../lib/data/pg/health.ts";
import { appliedVersions, loadMigrations, migrate, MIGRATION_TABLE } from "../lib/data/pg/migrate.ts";
import { closePool, getPool } from "../lib/data/pg/pool.ts";
import { dropDatabaseObjects, resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { createFavoriteRepository, pgFavoriteRepository } from "../lib/data/pg/favoriteRepository.ts";
import { createSuggestionRepository, pgSuggestionRepository } from "../lib/data/pg/suggestionRepository.ts";
import { favoriteSeed } from "../lib/mocks/fixtures/favoriteSeed.ts";
import { suggestionSeed } from "../lib/mocks/fixtures/suggestionSeed.ts";
import { buildDispatchSeed } from "../lib/mocks/fixtures/dispatchSeed.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { buildRankingPeriodOrders, orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import { couponClaimSeed, couponSeed } from "../lib/mocks/fixtures/couponSeed.ts";
import { complaintSeed } from "../lib/mocks/fixtures/complaintSeed.ts";
import { notificationSeed } from "../lib/mocks/fixtures/notificationSeed.ts";
import { refundSeed } from "../lib/mocks/fixtures/refundSeed.ts";
import { companionSeed } from "../lib/mocks/fixtures/seed.ts";

/**
 * PROD-1A · PostgreSQL 基础层与竖切片的**集成**用例（打真库）。
 *
 * ## 没配测试库时整体跳过
 *
 * 与 HTTP 用例的 `APP_BASE_URL` 同一套做法（见 `tests/httpReset.mjs` 的文件头）：
 * 没有 `TEST_DATABASE_URL` 时全部 `skip`，并写明缺什么。
 * 这样 `pnpm test` 在没库的机器上仍然全绿，而 `pnpm test:pg` 会打真库。
 *
 * ⚠️ 但**安全性质**（生产环境拒绝 seed/reset、非测试库拒绝 reset）**不在**本文件，
 * 它们在 `tests/pgConfig.test.mjs` 里无条件执行——会被跳过的守卫等于没有守卫。
 *
 * ## 连的是测试库，不是开发库
 *
 * 本文件只把 `TEST_DATABASE_URL` 赋给 `DATABASE_URL`（进程内唯一一次「切库」），
 * 而 `dropDatabaseObjects` / `resetDatabase` 内部还有两道守卫：
 * 库名必须以 `_test` 结尾、`NODE_ENV` 不能是 production。
 * 因此这里**不可能**误伤开发库或生产库。
 *
 * ## 每个用例的隔离
 *
 * `beforeEach` 先 reset 再 seed：每个用例都从「迁移到最新 + 装着完整预置数据」出发，
 * 断言里出现的数字因此是稳定的，不需要靠「上一个用例没改坏」。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  // 本测试文件跑在独立子进程里（node --test 的默认行为），改环境变量不会影响别的文件
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/**
 * 当前迁移清单，**按版本号顺序**。
 *
 * ⚠️ 新增一条迁移就要在这里加一项。这是**刻意**留的人工动作：
 * 它逼着改动者在「库的结构变了」这件事上做一次明确声明，
 * 而不是让新表悄悄出现在测试已经通过的那一层下面。
 */
const ALL_VERSIONS = [
  "0001",
  "0002",
  "0003",
  "0004",
  "0005",
  "0006",
  "0007",
  "0008",
  // PROD-1C：管理审计落库的那一张表。它排在最后，是**续号**的结果——
  // 已执行过的迁移一个字都不许改（PROD-1C Phase 2）。
  "0009",
];

/**
 * 迁移跑到最新之后，`public` 下应当有这些表（含记账表）。
 *
 * 与 `ALL_VERSIONS` 同理：**全部列出**，而不是「至少包含这几个」。
 * 后者接不住「某条迁移多建了一张没人知道的表」——而那正是记账表要防的事。
 */
const ALL_TABLES = [
  "admin_audit_entries",
  "companion_accept_events",
  "companion_release_records",
  "companion_service_events",
  "companions",
  "completion_submissions",
  "complaints",
  "coupon_claims",
  "coupon_templates",
  "dispatch_records",
  "earning_adjustments",
  "earnings",
  "favorites",
  "notifications",
  "orders",
  "payment_requests",
  "payments",
  "platform_config",
  "refund_requests",
  MIGRATION_TABLE,
  "suggestions",
];

/**
 * 按**码位**比较，不用 `Array.prototype.sort()` 的默认比较器之外的任何东西。
 *
 * ⚠️ 为什么不直接拿 SQL 的 `ORDER BY tablename` 结果去比：
 * 表名是 `name` 类型，排序走的是**数据库的默认排序规则**，而 `_` 与字母的先后
 * 在 C 规则和 glibc 的 en_US.UTF-8 下**不一样**（后者会在主级忽略标点）。
 * `earnings` / `earning_adjustments`、`payments` / `payment_requests` 这两对
 * 正好卡在这个差别上——同一份代码在两台机器上会给出不同的顺序。
 * 因此这里只比**集合**：两侧都按码位排一遍再比。SQL 里那句 ORDER BY 仍然保留，
 * 它保证的是查询本身的确定性，与本断言的判据无关。
 */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * W1（订单写闭包）里**真的有预置数据**的表，以及各有多少行。
 *
 * ⚠️ 订单集合必须与 `seedDatabase` 的取法**逐字一致**：`orderSeed` 加上
 * `buildRankingPeriodOrders`。少算那一批，「种子条数与预置数据一致」这条断言
 * 会以「少了几条」的形式失败——这正是它该有的表现。
 */
const SEED_NOW = getMockSeedNow();
const SEED_ORDERS = [...orderSeed, ...buildRankingPeriodOrders(SEED_NOW)];
const SEED_DISPATCHES = buildDispatchSeed(SEED_ORDERS, SEED_NOW);

const SEEDED_HUB_TABLES = {
  companions: companionSeed.length,
  orders: SEED_ORDERS.length,
  dispatch_records: SEED_DISPATCHES.length,
  coupon_templates: couponSeed.length,
  coupon_claims: couponClaimSeed.length,
  notifications: notificationSeed.length,
  complaints: complaintSeed.length,
  refund_requests: refundSeed.length,
  platform_config: 1,
};

/**
 * W1 里**建仓即为空**的表。
 *
 * 「两边都空」同样是 parity：Mock 的这几张 store 在 `createStore()` 里就是空的，
 * 给 Pg 编一份预置数据会凭空造出一段从未发生过的历史。
 * `earnings` / `earning_adjustments` / 三张历史事件表尤其如此
 * （见 `lib/types/companionAccept.ts` 关于「不伪造历史」的那段）。
 */
const EMPTY_HUB_TABLES = [
  // PROD-1C：审计账本建仓即为空。Mock 的审计 store 同样是空的——
  // 预置数据里没有任何一次「管理员做过什么」，给 Pg 编一份会凭空造出一段
  // 从未发生过的管理动作历史（与下面几张历史事件表同一条理由）。
  "admin_audit_entries",
  "payment_requests",
  "payments",
  "completion_submissions",
  "earnings",
  "earning_adjustments",
  "companion_accept_events",
  "companion_release_records",
  "companion_service_events",
];

/** 回到「已迁移 + 已装预置数据」的基线。 */
async function reseed() {
  await resetDatabase(executor());
  await seedDatabase(executor());
}

before(async () => {
  if (SKIP) return;

  const databaseName = databaseNameOf(TEST_URL);
  assert.match(databaseName ?? "", /_test$/, "测试库的库名必须以 _test 结尾");

  await closePool();
  process.env.DATABASE_URL = TEST_URL;

  // 从**空库**出发：这一句本身就是「空库能一路迁到最新」的前提
  await dropDatabaseObjects(executor());
  const result = await migrate(executor());
  assert.deepEqual(result.applied, ALL_VERSIONS, "全部迁移都应当被执行");
});

beforeEach(async () => {
  if (SKIP) return;
  await reseed();
});

after(async () => {
  if (SKIP) return;
  await closePool();
});

async function countRows(table) {
  const rows = await executor().query(`SELECT count(*)::int AS total FROM ${table}`);
  return rows[0].total;
}

// ————————————————————————————— 连接 —————————————————————————————

test("连不上库时给的是**脱敏后**的明确错误：主机端口在，密码不在", { skip: SKIP }, async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL =
    "postgresql://postgres:sup3r-s3cret-pw@127.0.0.1:59999/chaoge_esports_test";
  await closePool();

  try {
    const health = await checkDatabaseHealth(executor());
    assert.equal(health.ok, false, "连不上必须报 ok: false");
    assert.doesNotMatch(health.error, /sup3r-s3cret-pw/, "密码绝不能出现在错误里");
    assert.match(health.error, /127\.0\.0\.1:59999/, "但要能看出连的是哪台机器");
    assert.equal(health.database, null);

    // 反过来：健康检查不抛错（它的职责是**报告**状态），而 migrate 必须抛——
    // 「连不上」与「连上了但结构不对」是两件事，处理方式不同
    await assert.rejects(
      () => migrate(executor()),
      (error) => {
        assert.ok(error instanceof PgConfigError);
        assert.doesNotMatch(error.message, /sup3r-s3cret-pw/);
        return true;
      },
    );
  } finally {
    process.env.DATABASE_URL = saved;
    await closePool();
  }
});

test("健康检查报出库名、版本、延迟与迁移进度", { skip: SKIP }, async () => {
  const health = await checkDatabaseHealth(executor());

  assert.equal(health.ok, true);
  assert.equal(health.database, databaseNameOf(TEST_URL));
  assert.match(health.serverVersion, /^\d+\./);
  assert.ok(health.latencyMs >= 0);
  assert.deepEqual(health.migrations, { applied: ALL_VERSIONS.length, pending: 0 });

  const password = new URL(TEST_URL).password;
  assert.ok(password.length > 0, "测试库连接串里应当带密码，否则这条断言证明不了什么");
  assert.ok(!health.endpoint.includes(password), "endpoint 必须脱敏：密码不能出现在里面");

  assert.match(formatDatabaseHealth(health), /数据库可用/);
});

test("迁移没跑完时健康检查会报「还差几条」——连得上不等于结构是新的", { skip: SKIP }, async () => {
  await dropDatabaseObjects(executor());
  try {
    const health = await checkDatabaseHealth(executor());
    assert.equal(health.ok, true, "库本身是通的");
    assert.deepEqual(health.migrations, { applied: 0, pending: ALL_VERSIONS.length });
  } finally {
    await migrate(executor());
    await reseed();
  }
});

// ————————————————————————————— 迁移 —————————————————————————————

test("空库能一路迁到最新：全部表建出来，记账表逐条记下", { skip: SKIP }, async () => {
  await dropDatabaseObjects(executor());

  try {
    const result = await migrate(executor());
    assert.deepEqual(result.applied, ALL_VERSIONS);
    assert.deepEqual(result.skipped, []);

    const tables = await executor().query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    assert.deepEqual(
      tables.map((row) => row.tablename).sort(byCodeUnit),
      [...ALL_TABLES].sort(byCodeUnit),
      "建出来的表必须与迁移清单**一一对应**：既不能少，也不能多出没人登记的一张",
    );
    assert.deepEqual(await appliedVersions(executor()), ALL_VERSIONS);
  } finally {
    await migrate(executor());
    await reseed();
  }
});

test("重复执行是幂等的：第二次全部跳过，一条也不重跑", { skip: SKIP }, async () => {
  const result = await migrate(executor());

  assert.deepEqual(result.applied, [], "已经跑过的不许再跑");
  assert.deepEqual(result.skipped, ALL_VERSIONS);

  // 第三次也一样——幂等不是「第二次恰好没事」
  assert.deepEqual((await migrate(executor())).skipped, ALL_VERSIONS);
  assert.equal(await countRows(MIGRATION_TABLE), ALL_VERSIONS.length);
});

test("已执行迁移的内容被改过就报错：两个库不能各自跑出不同结构却都显示「最新」", { skip: SKIP }, async () => {
  const migrationRowSql = `UPDATE ${MIGRATION_TABLE} SET checksum = 'tampered' WHERE version = '0001'`;
  await executor().query(migrationRowSql);

  try {
    await assert.rejects(() => migrate(executor()), (error) => {
      assert.ok(error instanceof PgConfigError);
      assert.match(error.message, /checksum/);
      return true;
    });
  } finally {
    // 把真实的摘要写回去：篡改只是这个用例的手段，不该留给后面的用例
    const [first] = await loadMigrations();
    await executor().query(
      `UPDATE ${MIGRATION_TABLE} SET checksum = $1 WHERE version = $2`,
      [first.checksum, first.version],
    );
  }

  // 恢复之后迁移重新恢复正常
  assert.deepEqual((await migrate(executor())).applied, []);
});

test("迁移是「全有或全无」：一条 SQL 中途失败，它前半段建的表也不会留下", { skip: SKIP }, async () => {
  // 造一条**故意坏掉**的迁移：前半段建表，后半段在同一张表上再建一次。
  // 若迁移没有事务，前半段的表会留下，库就处在「半迁移」状态——那是记账表存在的
  // 意义所在：要么整体成功，要么什么都没发生。
  // ⚠️ 版本号必须**未被占用**。用 `0003` 会撞上真实存在的 `0003_companions.sql`：
  // 记账表里已经有 0003，迁移运行器会先报「内容与已执行的记录不一致（checksum 不符）」，
  // 于是这个用例变成在测 checksum 门禁，而不再是「失败的迁移不留半成品」。
  // 取一个远离正式序列的号，让它成为一条**真正待执行**的迁移。
  const dir = await mkdtemp(path.join(os.tmpdir(), "pg-migrations-"));
  await writeFile(
    path.join(dir, "9999_halfway_broken.sql"),
    [
      "CREATE TABLE halfway_probe (id text PRIMARY KEY);",
      "CREATE TABLE halfway_probe (id text PRIMARY KEY);",
    ].join("\n"),
    "utf8",
  );

  const saved = process.env.PG_MIGRATIONS_DIR;
  process.env.PG_MIGRATIONS_DIR = dir;

  try {
    await assert.rejects(() => migrate(executor()), /halfway_probe|already exists/i);

    const leftovers = await executor().query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'halfway_probe'`,
    );
    assert.equal(leftovers.length, 0, "失败的迁移不该留下半成品表");
    assert.equal(await countRows(MIGRATION_TABLE), ALL_VERSIONS.length, "失败的迁移不该被记账");
  } finally {
    if (saved === undefined) delete process.env.PG_MIGRATIONS_DIR;
    else process.env.PG_MIGRATIONS_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("两个进程同时迁移不会重复执行：抢不到锁的那个会等，然后读到最新记账", { skip: SKIP }, async () => {
  await dropDatabaseObjects(executor());

  try {
    const [a, b] = await Promise.all([migrate(executor()), migrate(executor())]);

    // 每条迁移各被执行**一次**，合计恰好等于迁移总数；另一侧要么跳过、要么看到已记账后返回
    assert.equal(
      a.applied.length + b.applied.length,
      ALL_VERSIONS.length,
      "同一条迁移不能被两个进程各跑一遍",
    );
    assert.equal(await countRows(MIGRATION_TABLE), ALL_VERSIONS.length);
    assert.deepEqual(await appliedVersions(executor()), ALL_VERSIONS);
  } finally {
    await reseed();
  }
});

// ————————————————————————————— 事务 —————————————————————————————

test("提交后所有写入同时可见：不是一个先到、另一个稍后到", { skip: SKIP }, async () => {
  const before = await countRows("favorites");

  await executor().withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO favorites (id, user_id, product_id, created_at) VALUES ($1,$2,$3,$4)`,
      ["fav-tx-1", "u-tx", "p-tx-1", "2026-10-01T00:00:00.000Z"],
    );
    await tx.query(
      `INSERT INTO favorites (id, user_id, product_id, created_at) VALUES ($1,$2,$3,$4)`,
      ["fav-tx-2", "u-tx", "p-tx-2", "2026-10-01T00:00:01.000Z"],
    );
  });

  const rows = await executor().query(`SELECT id FROM favorites WHERE user_id = 'u-tx' ORDER BY id`);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["fav-tx-1", "fav-tx-2"],
  );
  assert.equal(await countRows("favorites"), before + 2);
});

test("中途抛错 → 同一事务里的写入**全部**回滚，一条都不留", { skip: SKIP }, async () => {
  const before = await countRows("favorites");

  await assert.rejects(
    () =>
      executor().withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO favorites (id, user_id, product_id, created_at) VALUES ($1,$2,$3,$4)`,
          ["fav-tx-rollback", "u-tx", "p-rollback", "2026-10-01T00:00:00.000Z"],
        );
        throw new Error("业务中途失败");
      }),
    /业务中途失败/,
  );

  assert.equal(await countRows("favorites"), before, "回滚后行数必须与事务前一致");
  const rows = await executor().query(`SELECT id FROM favorites WHERE id = 'fav-tx-rollback'`);
  assert.equal(rows.length, 0);
});

test("同一个事务里的语句走**同一条连接**：connectionId 就是后端的 pg_backend_pid()", { skip: SKIP }, async () => {
  await executor().withTransaction(async (tx) => {
    const [first] = await tx.query("SELECT pg_backend_pid() AS pid");
    const [second] = await tx.query("SELECT pg_backend_pid() AS pid");

    assert.equal(first.pid, second.pid, "两条语句必须在同一条连接上");
    assert.equal(first.pid, tx.connectionId, "句柄上的 connectionId 必须是真的后端进程号");
  });
});

test("两个并发事务各自占一条连接：不会互相把对方的语句收进自己的事务", { skip: SKIP }, async () => {
  const seen = [];

  await Promise.all([
    executor().withTransaction(async (tx) => {
      seen.push(tx.connectionId);
      await tx.query("SELECT pg_sleep(0.05)");
    }),
    executor().withTransaction(async (tx) => {
      seen.push(tx.connectionId);
      await tx.query("SELECT pg_sleep(0.05)");
    }),
  ]);

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "两个并行事务必须落在两条不同的连接上");
});

test("回滚之后连接还能继续用：失败的连接不会被错当成好连接还给池子", { skip: SKIP }, async () => {
  await assert.rejects(() =>
    executor().withTransaction(async (tx) => {
      await tx.query("SELECT 1/0");
    }),
  );

  // 紧接着再开一个事务，并且真的写入——如果上一条连接留下未结束的事务，
  // 这里的写入会落在那个事务里、随连接归还而消失
  await executor().withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO favorites (id, user_id, product_id, created_at) VALUES ($1,$2,$3,$4)`,
      ["fav-after-rollback", "u-tx", "p-after-rollback", "2026-10-01T00:00:00.000Z"],
    );
  });

  const rows = await executor().query(`SELECT id FROM favorites WHERE id = 'fav-after-rollback'`);
  assert.equal(rows.length, 1, "回滚后的连接必须能正常提交后续事务");
});

// ————————————————————————————— 唯一约束 —————————————————————————————

test("唯一约束由**数据库**强制：绕过仓储直接插重复行，一样被拒", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      executor().query(
        `INSERT INTO favorites (id, user_id, product_id, created_at) VALUES ($1,$2,$3,$4)`,
        ["fav-dup-raw", "u-1001", "p-400w", "2026-10-01T00:00:00.000Z"],
      ),
    (error) => {
      assert.equal(error.code, "23505", "必须是唯一约束冲突（SQLSTATE 23505）");
      assert.match(error.constraint, /favorites_user_product_key/);
      return true;
    },
  );
});

test("W1 表的唯一性同样由**数据库**强制：一单一派单、一人一券都绕不过去", { skip: SKIP }, async () => {
  // 这两条都是**业务规则**（「一张订单只有一条派单记录」「同一个人对同一张券只能领一次」），
  // 实现把它们交给了唯一索引，而不是「先查再写」的应用层判断。
  // 这里用 `INSERT … SELECT` 复制一条**真实的预置行**、只换 id，因此
  // 除 id 之外每一个字段都与既有行相同——能撞上唯一约束，靠的只可能是索引本身。
  // ⚠️ 不手写各列的值：抄一份真实行才不会被「列漏了 / 值凑错」这两件事污染结论。
  await assert.rejects(
    () =>
      executor().query(
        `INSERT INTO dispatch_records
           (id, order_id, state, exclusive_companion_id, exclusive_entered_at,
            exclusive_deadline_at, exclusive_timeout_minutes_snapshot, public_pool_entered_at,
            public_deadline_at, public_timeout_minutes_snapshot, accepted_by_companion_id,
            accepted_at, accepted_via, timed_out_at, created_at, updated_at)
         SELECT $1, order_id, state, exclusive_companion_id, exclusive_entered_at,
                exclusive_deadline_at, exclusive_timeout_minutes_snapshot, public_pool_entered_at,
                public_deadline_at, public_timeout_minutes_snapshot, accepted_by_companion_id,
                accepted_at, accepted_via, timed_out_at, created_at, updated_at
           FROM dispatch_records ORDER BY id LIMIT 1`,
        ["dsp-dup-raw"],
      ),
    (error) => {
      assert.equal(error.code, "23505", "必须是唯一约束冲突（SQLSTATE 23505）");
      assert.match(error.constraint, /dispatch_records_order_key/);
      return true;
    },
  );

  // 「一人一券」落在**部分**唯一索引 `coupon_claims_self_claim_key`
  // （`(user_id, coupon_id) WHERE source = 'self_claim'`）上——只复制一行自己领的记录，
  // 幂等键写 NULL（预置行本来就是 NULL），因此冲突只可能来自那条部分索引。
  await assert.rejects(
    () =>
      executor().query(
        `INSERT INTO coupon_claims
           (id, user_id, coupon_id, status, source, claimed_at, used_at, granted_by_admin_id,
            snapshot, idempotency_key)
         SELECT $1, user_id, coupon_id, status, source, claimed_at, used_at, granted_by_admin_id,
                snapshot, NULL
           FROM coupon_claims WHERE source = 'self_claim' ORDER BY id LIMIT 1`,
        ["claim-dup-raw"],
      ),
    (error) => {
      assert.equal(error.code, "23505", "必须是唯一约束冲突（SQLSTATE 23505）");
      assert.match(error.constraint, /coupon_claims_self_claim_key/);
      return true;
    },
  );
});

test("并发冲突**不靠**「先查再插」：8 个并发请求各带自己的 id，最终只有一条收藏", { skip: SKIP }, async () => {
  const userId = "u-race";
  const productId = "p-race";

  // 关键：每个请求**各自**生成 id —— 这正是真实并发下的样子。
  // 「先 SELECT 判断、没有再 INSERT」的写法在这里会造出多条（或者撞主键报错）；
  // 唯一索引 + ON CONFLICT 的写法只会有一条胜出。
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      pgFavoriteRepository.addFavorite({
        id: `fav-race-${index}`,
        userId,
        productId,
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    ),
  );

  assert.ok(
    results.every((result) => result.ok),
    "并发下不该有任何一个请求报错",
  );
  assert.equal(results.filter((result) => result.created).length, 1, "恰好一个请求真正创建了记录");

  const ids = new Set(results.map((result) => result.favorite.id));
  assert.equal(ids.size, 1, "所有请求都必须拿到同一条记录（创建者或读回的那条）");

  const rows = await executor().query(
    `SELECT id FROM favorites WHERE user_id = $1 AND product_id = $2`,
    [userId, productId],
  );
  assert.equal(rows.length, 1, "库里必须只有一行");
  assert.equal(rows[0].id, results[0].favorite.id);
});

test("冲突之后能读回既有记录，而且读到的就是索引保住的那一条", { skip: SKIP }, async () => {
  const first = await pgFavoriteRepository.addFavorite({
    id: "fav-replay-1",
    userId: "u-replay",
    productId: "p-replay",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(first.created, true);

  // 同一个「用户 + 商品」，但换了一个新生成的 id（模拟重试/连点各带各的 id）
  const second = await pgFavoriteRepository.addFavorite({
    id: "fav-replay-2",
    userId: "u-replay",
    productId: "p-replay",
    createdAt: "2026-10-02T00:00:00.000Z",
  });

  assert.equal(second.created, false, "第二次必须走幂等命中");
  assert.equal(second.favorite.id, "fav-replay-1", "读回的是既有那条，不是本次带来的那条");
  assert.equal(second.favorite.createdAt, "2026-10-01T00:00:00.000Z");
});

test("唯一约束不会被永久占用：取消收藏后还能重新收藏", { skip: SKIP }, async () => {
  const removed = await pgFavoriteRepository.removeFavorite("u-1001", "p-400w");
  assert.deepEqual(removed, { removed: true });

  // 取消一个不存在的收藏同样是幂等的
  assert.deepEqual(await pgFavoriteRepository.removeFavorite("u-1001", "p-400w"), {
    removed: false,
  });

  const again = await pgFavoriteRepository.addFavorite({
    id: "fav-1001-01",
    userId: "u-1001",
    productId: "p-400w",
    createdAt: "2026-09-12T21:18:00.000Z",
  });
  assert.equal(again.created, true, "删掉之后键就空出来了，插入必须成功");
});

test("反馈的幂等键同样由数据库强制：8 个并发提交只产生一条", { skip: SKIP }, async () => {
  const userId = "u-sug-race";
  const idempotencyKey = "key-race";

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      pgSuggestionRepository.createSuggestion(
        {
          id: `sug-race-${index}`,
          userId,
          typeKey: "other",
          typeLabel: "其他",
          content: "并发提交（Mock 文案）",
          contact: "",
          evidence: [],
          status: "submitted",
          reply: "",
          repliedAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        idempotencyKey,
      ),
    ),
  );

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.suggestion.id)).size, 1);

  const rows = await executor().query(
    `SELECT id FROM suggestions WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, results[0].suggestion.id);

  // 读回路径也必须命中同一条
  const byKey = await pgSuggestionRepository.findSuggestionByKey(userId, idempotencyKey);
  assert.equal(byKey.id, rows[0].id);
});

test("预置反馈没有幂等键，用任何键都查不到——与 Mock 的建仓行为严格一致", { skip: SKIP }, async () => {
  const seeded = suggestionSeed[0];

  assert.equal(
    await pgSuggestionRepository.findSuggestionByKey(seeded.userId, seeded.id),
    null,
    "预置数据不该能被幂等键命中（Mock 的 createStore 也不往索引里放它们）",
  );

  const rows = await executor().query(
    `SELECT count(*)::int AS total FROM suggestions WHERE idempotency_key IS NULL`,
  );
  assert.equal(rows[0].total, suggestionSeed.length);
});

// ————————————————————————————— 预置数据 —————————————————————————————

test("seed 写进去的条数与预置数据一致；重复执行全部跳过，不产生第二份", { skip: SKIP }, async () => {
  const counts = (total, inserted) =>
    inserted ? { inserted: total, skipped: 0 } : { inserted: 0, skipped: total };
  const expected = (inserted) => ({
    favorites: counts(favoriteSeed.length, inserted),
    suggestions: counts(suggestionSeed.length, inserted),
    companions: counts(companionSeed.length, inserted),
    orders: counts(SEED_ORDERS.length, inserted),
    dispatchRecords: counts(SEED_DISPATCHES.length, inserted),
    couponTemplates: counts(couponSeed.length, inserted),
    couponClaims: counts(couponClaimSeed.length, inserted),
    notifications: counts(notificationSeed.length, inserted),
    complaints: counts(complaintSeed.length, inserted),
    refundRequests: counts(refundSeed.length, inserted),
    platformConfig: counts(1, inserted),
  });

  const first = await seedDatabase(executor());
  assert.deepEqual(first, expected(false), "刚 seed 过，第二次必须全部跳过");

  await resetDatabase(executor());
  const afterReset = await seedDatabase(executor());
  assert.deepEqual(afterReset, expected(true), "reset 之后每一张表都要重新装进去");

  assert.equal(await countRows("favorites"), favoriteSeed.length);
  assert.equal(await countRows("suggestions"), suggestionSeed.length);

  // 库里真的有多少行，与预置数据逐表对齐——不是只信 seed 自己报的数
  for (const [table, rows] of Object.entries(SEEDED_HUB_TABLES)) {
    assert.equal(await countRows(table), rows, `${table} 的行数与预置数据不一致`);
  }
});

test("W1 里建仓即为空的那几张表，在 Pg 里也必须一条都没有", { skip: SKIP }, async () => {
  // ⚠️ 这条断言的对手不是「忘了插」，而是「忍不住替它编一份数据」。
  // 三张只增不改的历史事件表尤其如此：凭空补一段接单 / 服务 / 退出历史，
  // 正是 lib/types/companionAccept.ts 里产品裁定明令禁止的事。
  for (const table of EMPTY_HUB_TABLES) {
    assert.equal(await countRows(table), 0, `${table} 在 Mock 侧建仓即为空，Pg 侧也必须为空`);
  }
});

test("reset 之后重新 seed，数据是**确定的**：两次结果逐字段相同", { skip: SKIP }, async () => {
  const snapshot = async () => ({
    favorites: await pgFavoriteRepository.queryFavorites({ userId: "u-1001", page: 1, pageSize: 50 }),
    suggestions: await pgSuggestionRepository.querySuggestions({
      userId: "u-1001",
      page: 1,
      pageSize: 50,
    }),
  });

  const before = await snapshot();
  await reseed();
  const after = await snapshot();

  assert.deepEqual(after, before, "重置 + 重新种子之后，同一份查询必须给出完全相同的结果");
});

test("预置数据里的时间戳往返无损：写进去的 ISO 字符串读出来一个字节都不差", { skip: SKIP }, async () => {
  const rows = await executor().query(
    `SELECT created_at FROM favorites WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    ["u-1001"],
  );

  const expected = [...favoriteSeed]
    .filter((favorite) => favorite.userId === "u-1001")
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));

  assert.equal(rows[0].created_at, expected[0].createdAt);
  assert.equal(typeof rows[0].created_at, "string", "timestamptz 必须以字符串离开驱动层");
});

// ————————————————————————————— 数据源切换 —————————————————————————————

test("DATA_SOURCE=postgres 时选到的确实是 PostgreSQL 实现，仓储接口一个字没变", { skip: SKIP }, async () => {
  const { getFavoriteRepository } = await import("../lib/data/favoriteRepository.ts");
  const { getSuggestionRepository } = await import("../lib/data/suggestionRepository.ts");

  const favorites = getFavoriteRepository();
  const suggestions = getSuggestionRepository();

  // 接口方法齐全（编译期已保证，这里在运行期再确认一次真的拿得到）
  for (const method of ["findFavorite", "queryFavorites", "addFavorite", "removeFavorite"]) {
    assert.equal(typeof favorites[method], "function", `FavoriteRepository 缺 ${method}`);
  }
  for (const method of ["querySuggestions", "findSuggestionByKey", "createSuggestion"]) {
    assert.equal(typeof suggestions[method], "function", `SuggestionRepository 缺 ${method}`);
  }

  // 走的是数据库：Mock 里 u-1001 的收藏数来自 seed，两者一致本身就是「同一份数据」的证据
  const page = await favorites.queryFavorites({ userId: "u-1001", page: 1, pageSize: 50 });
  assert.equal(page.total, favoriteSeed.filter((f) => f.userId === "u-1001").length);
});

test("同一个工厂造出的「事务内仓储」与「进程级仓储」是同一个接口，且共享提交点", { skip: SKIP }, async () => {
  await assert.rejects(() =>
    executor().withTransaction(async (tx) => {
      // 同一个 createFavoriteRepository，只是把执行者从池子换成事务句柄
      const inTransaction = createFavoriteRepository(tx);
      const outcome = await inTransaction.addFavorite({
        id: "fav-in-tx",
        userId: "u-in-tx",
        productId: "p-in-tx",
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      assert.equal(outcome.created, true);

      // 事务里能读到刚才那一条
      assert.ok(await inTransaction.findFavorite("u-in-tx", "p-in-tx"));

      // 反馈侧同样验一次：两个竖切片实体都必须做到「换执行者不换接口」。
      // 只验收藏的话，建议仓储的工厂签名写错了也发现不了。
      const suggestionsInTx = createSuggestionRepository(tx);
      const created = await suggestionsInTx.createSuggestion(
        {
          id: "sug-in-tx",
          userId: "u-in-tx",
          typeKey: "other",
          typeLabel: "其他",
          content: "事务内写入",
          contact: "",
          evidence: [],
          status: "submitted",
          reply: "",
          repliedAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        "key-in-tx",
      );
      assert.equal(created.created, true);
      assert.ok(await suggestionsInTx.findSuggestionByKey("u-in-tx", "key-in-tx"));

      throw new Error("故意回滚");
    }),
    /故意回滚/,
  );

  // 回滚之后，**进程级**仓储也读不到它们 —— 两个仓储共用同一个提交点，不是两套状态
  assert.equal(await pgFavoriteRepository.findFavorite("u-in-tx", "p-in-tx"), null);
  assert.equal(await pgSuggestionRepository.findSuggestionByKey("u-in-tx", "key-in-tx"), null);

  // 再确认一次它们确实没进库
  const rows = await executor().query(`SELECT id FROM favorites WHERE id = 'fav-in-tx'`);
  assert.equal(rows.length, 0);
  const suggestionRows = await executor().query(`SELECT id FROM suggestions WHERE id = 'sug-in-tx'`);
  assert.equal(suggestionRows.length, 0);
});

test("连接池是进程内单例：反复取到的是同一个池子", { skip: SKIP }, () => {
  assert.equal(getPool(), getPool());
});
