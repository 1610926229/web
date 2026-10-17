/**
 * PROD-2 · 数据库权限方案（`deploy/db/*.sql`）的隔离验证
 *
 * ## 这个用例要证明什么
 *
 * 五个部署脚本（01 建角色 / 02 收紧 PUBLIC / 03 连接与建对象权 / 04 默认权限 / 05 表级授权）
 * 在生产上会**改动一个真实数据库的权限模型**。这类改动最坏的失败方式不是「报错」，
 * 而是「脚本绿着跑完，但权限其实没落到位」——那要等到线上发出
 * `permission denied for table orders` 才会被发现，而那时应用已经不可用了。
 *
 * 所以这里不复述脚本里的断言，而是**从外部重新审视**最终结果：
 * 角色属性、PUBLIC 是否收紧、schema 权限、默认权限记在谁名下、**每一张表**的实际权限，
 * 以及「应用角色真的做不了 DDL」这条最关键的负面结论。
 *
 * ## 隔离策略：单事务 + 回滚，零残留
 *
 * 全部操作跑在**一个 `BEGIN … ROLLBACK`** 里，且连的是维护库（默认 `postgres`），
 * **不碰开发库、不碰测试库、更不碰生产库**。PostgreSQL 的 `CREATE ROLE` / `GRANT` /
 * `REVOKE` / `ALTER DEFAULT PRIVILEGES` / `CREATE TABLE` **全部是事务性的**，
 * 因此 `ROLLBACK` 之后集群状态与执行前逐字节相同——用例最后一段会验证这一点。
 *
 * 全程**没有一处 COMMIT**。
 *
 * ## 为什么可以这样验，它和生产的差别在哪
 *
 * 差别只有一处：生产上 `chaoge_migrator` 是**直接连接**（`DATABASE_URL` 指向它），
 * 这里用 `SET LOCAL ROLE chaoge_migrator` 切换。已实测二者对
 * `ALTER DEFAULT PRIVILEGES` 的记账效果一致——`defaclrole` 取的是 **`current_user`**，
 * 而不是 `session_user`，所以 `SET ROLE` 之后默认权限仍然正确地记在 `chaoge_migrator` 名下。
 * （若这一点不成立，04 会在生产上「成功但无效」——那正是本用例第 E 段要挡住的失败模式。
 *   第 H 段则是唯一能证明 04 真的有用的地方：它在 05 重跑**之前**检查刚建的表，
 *   因为 05 一旦跑过，无论默认权限是否记对，最终结果都会是正确的。）
 *
 * 库也有差别：生产是全新空库，维护库不是。为抹平它，用例会**真的执行 0001～0016**
 * （在 SAVEPOINT 里逐条跑，模拟运行器的「每条迁移一个事务」），
 * 于是被测的 40 张表（39 张业务表 + `schema_migrations`）是**真实的迁移产物**，而不是手工造出来的替身。
 *
 * ## 运行方式
 *
 *     PG_PERMS_VERIFY=1 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *       --env-file-if-exists=.env --test tests/pgDeployPrivileges.test.mjs
 *
 * 默认**跳过**（`pnpm test` / `pnpm test:pg` 都不会跑它）：
 * 它比一次单元测试重得多，且需要超级用户连接。用 `PG_PERMS_VERIFY=1` 显式打开。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_DB_DIR = path.join(REPO_ROOT, "deploy", "db");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");

/** 连哪个库做验证。必须是**维护库**，不能是任何有业务数据的库。 */
const MAINTENANCE_DB = process.env.PG_PERMS_DB || "postgres";

const ENABLED = process.env.PG_PERMS_VERIFY === "1";
const BASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const SKIP = !ENABLED
  ? "跳过：需要 PG_PERMS_VERIFY=1（本用例会在隔离事务里执行 deploy/db/*.sql 与全部迁移）"
  : (!BASE_URL ? "跳过：需要 DATABASE_URL 或 TEST_DATABASE_URL（.env 里的连接串）" : false);

/**
 * ⚠️ 生产库的名字是硬拦，不是警告。
 *
 * 本用例虽然在回滚事务里运行，但「跑在生产库上」这件事本身就不该发生——
 * 一个写错的分支、一次意外的 COMMIT、一个没被回滚的 DDL，代价都不可逆。
 * 在模块加载期就抛，让整个测试文件失败，比跑起来再后悔强。
 */
if (ENABLED && MAINTENANCE_DB === "chaoge_prod") {
  throw new Error(
    "拒绝执行：PG_PERMS_DB 指向了生产库 chaoge_prod。本用例只允许对维护库或空库运行。",
  );
}

/** 把连接串里的库名换成维护库。口令等其它部分原样保留（本文件从不输出连接串）。 */
function maintenanceConnectionString() {
  const url = new URL(BASE_URL);
  url.pathname = `/${MAINTENANCE_DB}`;
  return url.toString();
}

/** 执行 `deploy/db/` 下的一个脚本。多语句一次下发，走简单查询协议。 */
async function runDeployScript(client, fileName) {
  const sql = await readFile(path.join(DEPLOY_DB_DIR, fileName), "utf8");
  return client.query(sql);
}

/**
 * 断言某条语句被拒绝。
 *
 * ⚠️ 必须包在 SAVEPOINT 里：语句报错会把**整个事务**标记为 aborted，
 *    之后哪怕是一个 `SELECT 1` 都会返回 25P02。回滚到保存点即可恢复。
 *    本用例里所有「预期失败」的语句都走这个函数——包括 01 的库名守卫反例。
 */
async function expectRejected(client, sql, code, label) {
  await client.query("SAVEPOINT expected_failure");
  let error = null;
  try {
    await client.query(sql);
  } catch (caught) {
    error = caught;
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");

  assert.notEqual(error, null, `${label}：本应被拒绝，却执行成功了`);
  assert.equal(error.code, code, `${label}：错误码应为 ${code}，实际 ${error.code}（${error.message}）`);
  return error;
}

/** `public` 下所有表的 oid / 名字。`r` = 普通表，`p` = 分区表。 */
const TABLES_SQL = `
  SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY c.relname
`;

/** 读 `deploy/db/*.sql` 与 `db/migrations/*.sql`，去掉 `--` 注释后统计建表目标。 */
function createdTableNames(sql) {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const names = new Set();
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?([a-z_][a-z0-9_]*)/gi;
  for (const match of stripped.matchAll(pattern)) names.add(match[1]);
  return names;
}

const MIGRATION_FILES = (await readdir(MIGRATIONS_DIR))
  .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
  .sort();

/** 全部迁移文件里 `CREATE TABLE` 的目标表名（去重、已剔注释）。 */
const MIGRATION_TABLE_NAMES = createdTableNames(
  (
    await Promise.all(MIGRATION_FILES.map((file) => readFile(path.join(MIGRATIONS_DIR, file), "utf8")))
  ).join("\n"),
);

/**
 * `public` 里应有的表数 = 迁移建的表 + 运行器引导建的 `schema_migrations`。
 *
 * 不写死数字：从迁移文件里数出来，将来新增一条迁移，这里的期望值自动跟着走，
 * 断言不会因为「多了一张表」而变成一句需要人工解释的失败。
 * （代价：若某个迁移把 `CREATE TABLE` 写进了注释，数字会偏大——`createdTableNames`
 *   已经先剔掉 `--` 注释，剩余的这类风险会在失败信息里一眼看出来。）
 */
function expectedTableCount() {
  return MIGRATION_TABLE_NAMES.size + 1;
}

test("PROD-2 数据库权限方案：在隔离事务里跑完整套脚本并逐项验收", { skip: SKIP }, async (t) => {
  const client = new pg.Client({ connectionString: maintenanceConnectionString() });
  await client.connect();

  /** 回滚前后的基准值，最后一段用来证明零残留。 */
  let baseline = null;

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 0. 基准快照（执行任何脚本之前）
    // ═══════════════════════════════════════════════════════════════════════
    await client.query("BEGIN");
    await client.query(`SET LOCAL chaoge.expected_database = '${MAINTENANCE_DB}'`);

    const snapshot = async () => {
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('chaoge_migrator','chaoge_app')) AS roles,
          (SELECT count(*)::int FROM pg_default_acl)                                              AS defacl,
          (SELECT n.nspacl::text FROM pg_namespace n WHERE n.nspname = 'public')                  AS schema_acl,
          (SELECT d.datacl::text FROM pg_database d WHERE d.datname = current_database())         AS db_acl,
          current_database() AS db
      `);
      return rows[0];
    };

    baseline = await snapshot();
    assert.equal(baseline.db, MAINTENANCE_DB, "连到了非预期的库");
    assert.equal(baseline.roles, 0, "基准状态下两个角色不应存在（否则本用例的结论不成立）");
    assert.equal(baseline.defacl, 0, "基准状态下不应有任何默认权限记录");

    await t.test("A. 库名守卫：脚本拒绝在非目标库上执行", async () => {
      // 故意把期望库名改成一个不存在的名字，脚本必须当场抛 42501 而不是照常执行。
      // 这一条验的是「确保不会误操作其他数据库」这个要求本身。
      await client.query("SAVEPOINT guard_probe");
      await client.query("SET LOCAL chaoge.expected_database = 'definitely_not_this_database'");

      const error = await expectRejected(
        client,
        await readFile(path.join(DEPLOY_DB_DIR, "01-create-roles.sql"), "utf8"),
        "42501",
        "01-create-roles.sql 在错误的库名上",
      );
      assert.match(error.message, /拒绝执行/, "守卫信息应说明被拒绝的原因");

      await client.query("ROLLBACK TO SAVEPOINT guard_probe");
      // 回滚到保存点同时也还原了 SET LOCAL 的 GUC，后面各节自动回到正确值。
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 1. 以 postgres 身份执行 01 / 02 / 03
    // ═══════════════════════════════════════════════════════════════════════
    for (const file of ["01-create-roles.sql", "02-harden-public.sql", "03-migrator-grants.sql"]) {
      await runDeployScript(client, file);
    }

    await t.test("B. 角色属性：两个最小权限可登录角色", async () => {
      const { rows } = await client.query(`
        SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
          FROM pg_roles WHERE rolname IN ('chaoge_migrator','chaoge_app') ORDER BY rolname
      `);
      assert.equal(rows.length, 2, "两个角色都应就位");

      for (const role of rows) {
        assert.equal(role.rolsuper, false, `${role.rolname} 不应是超级用户`);
        assert.equal(role.rolcreatedb, false, `${role.rolname} 不应能建库`);
        assert.equal(role.rolcreaterole, false, `${role.rolname} 不应能建角色`);
        assert.equal(role.rolreplication, false, `${role.rolname} 不应有复制权`);
        assert.equal(role.rolbypassrls, false, `${role.rolname} 不应能绕过 RLS`);
        assert.equal(role.rolcanlogin, true, `${role.rolname} 必须能登录`);
      }
    });

    await t.test("C. PUBLIC 已收紧：既连不上库，也在 public 上无权限", async () => {
      // ⚠️ 不能用 has_database_privilege('public', …)：PUBLIC 不是一个角色。
      const { rows } = await client.query(`
        SELECT
          coalesce((SELECT bool_or(a.privilege_type = 'CONNECT')
                      FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                   d.datacl IS NULL)                       AS public_connect,
          coalesce((SELECT bool_or(a.privilege_type = 'TEMPORARY')
                      FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                   d.datacl IS NULL)                       AS public_temp,
          coalesce((SELECT bool_or(a.privilege_type IN ('USAGE','CREATE'))
                      FROM aclexplode(n.nspacl) a WHERE a.grantee = 0), false) AS public_schema
          FROM pg_database d, pg_namespace n
         WHERE d.datname = current_database() AND n.nspname = 'public'
      `);
      assert.equal(rows[0].public_connect, false, "PUBLIC 不应还能连接本库");
      assert.equal(rows[0].public_temp, false, "PUBLIC 不应还能建临时表");
      assert.equal(rows[0].public_schema, false, "PUBLIC 不应在 public 上有 USAGE / CREATE");
    });

    await t.test("D. 权限分工：CREATE 只在迁移角色手上，应用角色没有 DDL 能力", async () => {
      const { rows } = await client.query(`
        SELECT
          has_database_privilege('chaoge_migrator', current_database(), 'CONNECT')   AS mig_connect,
          has_database_privilege('chaoge_app',      current_database(), 'CONNECT')   AS app_connect,
          has_database_privilege('chaoge_app',      current_database(), 'TEMPORARY') AS app_temp,
          has_schema_privilege('chaoge_migrator','public','USAGE')                   AS mig_usage,
          has_schema_privilege('chaoge_migrator','public','CREATE')                  AS mig_create,
          has_schema_privilege('chaoge_app',     'public','USAGE')                   AS app_usage,
          has_schema_privilege('chaoge_app',     'public','CREATE')                  AS app_create,
          (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname='public') AS schema_owner
      `);
      const r = rows[0];

      assert.equal(r.mig_connect, true, "chaoge_migrator 必须能连接");
      assert.equal(r.app_connect, true, "chaoge_app 必须能连接（02 收回了 PUBLIC 的 CONNECT）");
      assert.equal(r.app_temp, false, "chaoge_app 不需要临时表能力");

      assert.equal(r.mig_usage, true, "chaoge_migrator 需要 USAGE 才能按名字建表");
      assert.equal(r.mig_create, true, "chaoge_migrator 必须有 CREATE，否则迁移第一步就失败");
      assert.equal(r.app_usage, true, "chaoge_app 需要 USAGE 才能按名字找到表");
      assert.equal(r.app_create, false, "chaoge_app 不得有 CREATE —— 这是本方案最关键的一条");

      // 本方案**不改 schema 属主**：属主还能 DROP SCHEMA，比 CREATE 多一层破坏力。
      assert.equal(r.schema_owner, "pg_database_owner", "public schema 的属主应保持不变");
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. 切换为 chaoge_migrator，执行 04 / 05
    // ═══════════════════════════════════════════════════════════════════════
    await client.query("SET LOCAL ROLE chaoge_migrator");

    // 04 必须在**第一次 db:migrate 之前**跑。这里的顺序就是部署流程的顺序：
    // 先立规矩（默认权限），再让迁移去建表——建出来的表自动带上授权。
    await runDeployScript(client, "04-app-default-privileges.sql");

    await t.test("E. 04 的默认权限确实记在 chaoge_migrator 名下", async () => {
      const { rows } = await client.query(`
        SELECT pg_get_userbyid(d.defaclrole) AS role,
               d.defaclobjtype AS objtype,
               string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
          FROM pg_default_acl d
          LEFT JOIN aclexplode(d.defaclacl) a
            ON a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'chaoge_app')
         WHERE d.defaclnamespace = 'public'::regnamespace
         GROUP BY 1, 2 ORDER BY 2
      `);
      assert.equal(rows.length, 2, "应恰好有两条记录：表一条、序列一条");

      const tables = rows.find((row) => row.objtype === "r");
      const sequences = rows.find((row) => row.objtype === "S");

      // ⚠️ 这一条是本用例的核心防线之一：若 04 被执行成了 postgres，脚本会「成功」，
      //    但默认权限记在 postgres 名下，将来迁移建的表一张都拿不到授权。
      assert.equal(tables.role, "chaoge_migrator", "默认权限必须记在 chaoge_migrator 名下");
      assert.equal(sequences.role, "chaoge_migrator", "默认权限必须记在 chaoge_migrator 名下");

      assert.equal(tables.privs, "DELETE,INSERT,SELECT,UPDATE", "表默认权限应恰好是这四项 DML");
      assert.equal(sequences.privs, "SELECT,USAGE", "序列默认权限应恰好是 USAGE + SELECT");
    });

    await t.test("F. 05 在迁移前是空跑（public 里还没有业务表）", async () => {
      await runDeployScript(client, "05-app-table-grants.sql");
      const { rows } = await client.query(TABLES_SQL);
      assert.equal(rows.length, 0, "迁移之前 public 里不应有表 —— 05 应当安静通过而不是报错");
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. 以 chaoge_migrator 身份真正跑完 0001～0016
    // ═══════════════════════════════════════════════════════════════════════
    await t.test("G. 迁移角色能完成运行器要做的每一件事", async () => {
      // 复刻 lib/data/pg/migrate.ts 的引导 DDL（逐字一致，见该文件 ensureMigrationTable）。
      // 记账表由运行器**引导创建**，不是一条迁移；它由 chaoge_migrator 建成，
      // 因此 04 的默认权限会让 chaoge_app 自动拿到 SELECT —— health.ts 需要它。
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    text COLLATE "C" PRIMARY KEY,
          name       text        NOT NULL,
          checksum   text        NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      // 运行器要取咨询锁。任何角色都可以取，但这里实测一次，证明它不需要额外授权。
      await client.query("SELECT pg_advisory_xact_lock($1)", [48201996]);

      // 每条迁移一个 SAVEPOINT，模拟运行器的「每条迁移单独一个事务」。
      // 外层仍是一个未提交的大事务，所以整体依然可以一次回滚干净。
      for (const [index, file] of MIGRATION_FILES.entries()) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        const savepoint = `migration_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await client.query(sql);
        } catch (error) {
          throw new Error(`迁移 ${file} 在最小权限下失败：${error.message}`);
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }

      // 迁移确实跑完了（而不是被静默跳过）
      const { rows } = await client.query(TABLES_SQL);
      assert.equal(
        rows.length,
        expectedTableCount(),
        `${MIGRATION_FILES.length} 条迁移应建出 ${MIGRATION_TABLE_NAMES.size} 张表，加记账表共 ${expectedTableCount()} 张`,
      );
    });

    await t.test("H. 默认权限已生效：迁移刚建的表**未经任何 GRANT** 就已授权给应用", async () => {
      // ⚠️ 这一段是本用例里**唯一**能证明 04 有用的地方，也是最容易被漏掉的一段。
      //
      // 若不在这里检查，后面 05 会把所有表都显式授权一遍——于是「04 有没有生效」
      // 就再也测不出来了：无论默认权限是否记对，最终 40 张表的权限都会是正确的。
      // 换句话说，**没有这一步，前面 E 段之外的所有断言对 04 都是盲的**。
      //
      // 所以必须在 05 重跑**之前**检查：此刻 public 里的每一张表，都是刚由
      // chaoge_migrator 建出来的，除了默认权限之外没有任何人来授过权。
      const { rows: tables } = await client.query(TABLES_SQL);
      assert.equal(tables.length, expectedTableCount(), "迁移后表数不符，后面的权限结论不成立");

      const violations = [];
      for (const table of tables) {
        const { rows } = await client.query(
          `SELECT has_table_privilege('chaoge_app', $1::oid, 'SELECT') AS sel,
                  has_table_privilege('chaoge_app', $1::oid, 'INSERT') AS ins,
                  has_table_privilege('chaoge_app', $1::oid, 'UPDATE') AS upd,
                  has_table_privilege('chaoge_app', $1::oid, 'DELETE') AS del,
                  has_table_privilege('chaoge_app', $1::oid, 'TRUNCATE') AS trunc`,
          [table.oid],
        );
        const p = rows[0];
        const missing = ["sel", "ins", "upd", "del"].filter((key) => !p[key]);
        if (missing.length || p.trunc) {
          violations.push(`${table.relname} 缺[${missing}] ${p.trunc ? "多[trunc]" : ""}`.trim());
        }
      }
      assert.deepEqual(
        violations,
        [],
        `默认权限未生效——这些表是刚由 chaoge_migrator 新建的，尚未执行过 05：\n  ${violations.join("\n  ")}`,
      );
    });

    await t.test("I. 05 重跑（迁移后）：把真实表的权限一次性补齐", async () => {
      await runDeployScript(client, "05-app-table-grants.sql");
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. 逐表核对（回到 postgres 身份，避免「自己验自己」）
    // ═══════════════════════════════════════════════════════════════════════
    await client.query("RESET ROLE");

    await t.test("J. 40 张表逐张核对：四项 DML 齐全、四项管理权限均无", async () => {
      const { rows: tables } = await client.query(TABLES_SQL);
      assert.equal(tables.length, expectedTableCount(), `应恰好 ${expectedTableCount()} 张表（39 张业务表 + schema_migrations）`);

      const violations = [];
      for (const table of tables) {
        // ⚠️ `$1::oid` 不能省：`has_table_privilege` 有 (name, oid, text) 与
        //    (name, text, text) 两个重载，未标注类型的参数会让解析器倾向 text，
        //    于是 oid 数字会被当成表名去找，报一句和权限毫无关系的「表不存在」。
        const { rows } = await client.query(
          `SELECT has_table_privilege('chaoge_app', $1::oid, 'SELECT')     AS sel,
                  has_table_privilege('chaoge_app', $1::oid, 'INSERT')     AS ins,
                  has_table_privilege('chaoge_app', $1::oid, 'UPDATE')     AS upd,
                  has_table_privilege('chaoge_app', $1::oid, 'DELETE')     AS del,
                  has_table_privilege('chaoge_app', $1::oid, 'TRUNCATE')   AS trunc,
                  has_table_privilege('chaoge_app', $1::oid, 'REFERENCES') AS refs,
                  has_table_privilege('chaoge_app', $1::oid, 'TRIGGER')    AS trg,
                  has_table_privilege('chaoge_app', $1::oid, 'MAINTAIN')   AS mnt`,
          [table.oid],
        );
        const p = rows[0];
        const missing = ["sel", "ins", "upd", "del"].filter((key) => !p[key]);
        const extra = ["trunc", "refs", "trg", "mnt"].filter((key) => p[key]);
        if (missing.length || extra.length) {
          violations.push(`${table.relname} 缺[${missing}] 多[${extra}]`);
        }
      }
      assert.deepEqual(violations, [], `存在权限偏差：\n  ${violations.join("\n  ")}`);
    });

    await t.test("K. 记账表可被应用角色读取（health.ts 的启动自检依赖它）", async () => {
      const { rows } = await client.query(
        `SELECT has_table_privilege('chaoge_app', 'public.schema_migrations', 'SELECT') AS can_read,
                has_table_privilege('chaoge_app', 'public.schema_migrations', 'TRUNCATE') AS can_truncate`,
      );
      assert.equal(rows[0].can_read, true, "chaoge_app 必须能读 schema_migrations");
      assert.equal(rows[0].can_truncate, false, "chaoge_app 不得能清空记账表");
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. 行为验证：不看权限位，直接让数据库回答「能不能做」
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 第 I 段读的是 ACL，这一段读的是**执行结果**。两者都要有：
    // 权限位对了但守卫写歪了（比如漏了一个 REVOKE 却恰好被另一条 GRANT 掩盖）
    // 只有真正执行一次才会暴露。
    await client.query("SET LOCAL ROLE chaoge_app");

    await t.test("L. 应用角色：读得到业务数据", async () => {
      const { rows: tables } = await client.query(TABLES_SQL);
      const probe = tables.find((table) => table.relname !== "schema_migrations") ?? tables[0];
      assert.ok(probe, "至少要有一张表可供探测");

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public."${probe.relname}"`);
      assert.equal(typeof rows[0].n, "number", `chaoge_app 应能读取 ${probe.relname}`);
    });

    await t.test("M. 应用角色：零行的 INSERT / UPDATE / DELETE 都能执行", async () => {
      // 找一个既没有生成列、也没有标识列的表：`INSERT … SELECT *` 只有在
      // 「每一列都可以显式写入」时才合法，否则会撞上 428C9 / 42809，
      // 那是语法层面的拒绝，与权限无关，不能拿来当权限探测的结果。
      const { rows: candidates } = await client.query(`
        SELECT c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                            WHERE a.attrelid = c.oid
                              AND (a.attgenerated <> '' OR a.attidentity <> ''))
         ORDER BY c.relname
      `);
      assert.ok(candidates.length > 0, "找不到可用于零行 DML 探测的表");

      const target = candidates[0].relname;
      const { rows: columns } = await client.query(
        `SELECT a.attname FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum LIMIT 1`,
        [`public.${target}`],
      );
      const firstColumn = columns[0].attname;

      // 三条语句都真的走一遍权限检查，但 WHERE false 保证一行都不动。
      const ins = await client.query(`INSERT INTO public."${target}" SELECT * FROM public."${target}" WHERE false`);
      assert.equal(ins.rowCount, 0, "INSERT 应是零行");

      const upd = await client.query(
        `UPDATE public."${target}" SET "${firstColumn}" = "${firstColumn}" WHERE false`,
      );
      assert.equal(upd.rowCount, 0, "UPDATE 应是零行");

      const del = await client.query(`DELETE FROM public."${target}" WHERE false`);
      assert.equal(del.rowCount, 0, "DELETE 应是零行");

      // 行级锁也要 UPDATE 权限，是「写能力」最贴近真实业务路径的一次验证。
      await client.query(`SELECT * FROM public."${target}" LIMIT 1 FOR UPDATE`);
    });

    await t.test("N. 应用角色：一切 DDL 都必须被拒绝（42501）", async () => {
      const { rows: tables } = await client.query(TABLES_SQL);
      const victim = tables[0].relname;

      // 索引用真实列名，不用常量表达式：`CREATE INDEX i ON t (1)` 在部分写法下
      // 会先撞上**语法错误**（42601），那样测到的就不是权限了，断言会以假乱真地通过。
      const { rows: columns } = await client.query(
        `SELECT a.attname FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum LIMIT 1`,
        [`public.${victim}`],
      );
      const victimColumn = columns[0].attname;

      // 越权写入组：这些是「应用能自己改结构」的入口，一个都不能通。
      await expectRejected(
        client, "CREATE TABLE sneaky_table (id text)", "42501", "chaoge_app 建表",
      );
      await expectRejected(
        client, "CREATE SCHEMA sneaky_schema", "42501", "chaoge_app 建 schema",
      );
      await expectRejected(
        client, `ALTER TABLE public."${victim}" ADD COLUMN sneaky text`, "42501", "chaoge_app 改表结构",
      );
      await expectRejected(
        client, `DROP TABLE public."${victim}"`, "42501", "chaoge_app 删表",
      );
      await expectRejected(
        client,
        `CREATE INDEX sneaky_idx ON public."${victim}" ("${victimColumn}")`,
        "42501",
        "chaoge_app 建索引",
      );

      // 最重的一条：TRUNCATE 一语句清空整表且**不触发行级触发器**。
      await expectRejected(
        client, `TRUNCATE public."${victim}"`, "42501", "chaoge_app 清空表",
      );

      // 临时表：02 收回了 TEMPORARY，应用不该有任何绕过路径。
      await expectRejected(
        client, "CREATE TEMP TABLE sneaky_temp (id text)", "42501", "chaoge_app 建临时表",
      );
    });

    await client.query("RESET ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // 6. 幂等性：整套脚本再跑一遍
    // ═══════════════════════════════════════════════════════════════════════
    await t.test("O. 五个脚本重复执行不报错（角色已存在、权限已授予、表已授权）", async () => {
      await assert.doesNotReject(
        () => runDeployScript(client, "01-create-roles.sql"),
        "01 重跑应安静通过（角色已存在时只打 NOTICE）",
      );
      await assert.doesNotReject(
        () => runDeployScript(client, "02-harden-public.sql"),
        "02 重跑应安静通过（REVOKE 不存在的权限只打 WARNING）",
      );
      await assert.doesNotReject(
        () => runDeployScript(client, "03-migrator-grants.sql"),
        "03 重跑应安静通过",
      );

      await client.query("SET LOCAL ROLE chaoge_migrator");
      try {
        await assert.doesNotReject(
          () => runDeployScript(client, "04-app-default-privileges.sql"),
          "04 重跑应安静通过",
        );
        await assert.doesNotReject(
          () => runDeployScript(client, "05-app-table-grants.sql"),
          "05 重跑应安静通过（此时 public 里已有 40 张表）",
        );
      } finally {
        await client.query("RESET ROLE");
      }
    });

    await t.test("P. 重跑之后权限仍然正确（幂等 ≠ 只在第一次对）", async () => {
      const { rows: tables } = await client.query(TABLES_SQL);
      const { rows } = await client.query(
        `SELECT count(*)::int AS bad
           FROM unnest($1::oid[]) AS oid
          WHERE NOT (has_table_privilege('chaoge_app', oid, 'SELECT')
                 AND has_table_privilege('chaoge_app', oid, 'INSERT')
                 AND has_table_privilege('chaoge_app', oid, 'UPDATE')
                 AND has_table_privilege('chaoge_app', oid, 'DELETE'))
             OR has_table_privilege('chaoge_app', oid, 'TRUNCATE')
             OR has_table_privilege('chaoge_app', oid, 'REFERENCES')
             OR has_table_privilege('chaoge_app', oid, 'TRIGGER')`,
        [tables.map((table) => table.oid)],
      );
      assert.equal(rows[0].bad, 0, `重跑后仍有 ${rows[0].bad} 张表权限不符`);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7. 验收脚本本身也要能跑出 PASS
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `99-verify.sql` 是交付给运维、用来在生产上人工确认的那份。它如果有语法错误
    // 或者查询写反了，问题不会在部署时暴露——而是在**最需要它的时候**（线上出事后）
    // 才暴露。所以在这里先把它跑一遍：此刻库里的权限是**已知正确**的，
    // 它就应当给出 PASS。一个在正确状态下都报 FAIL 的验收脚本，等于没有验收。
    await t.test("Q. 99-verify.sql 在正确状态下给出 PASS", async () => {
      const raw = await readFile(path.join(DEPLOY_DB_DIR, "99-verify.sql"), "utf8");
      // 剔除 psql 元命令（`\pset` / `\echo`）——驱动不认识它们，而它们与权限无关。
      const sql = raw
        .split("\n")
        .filter((line) => !/^\s*\\/.test(line))
        .join("\n");

      const results = await client.query(sql);
      const rows = results.flatMap((result) => result?.rows ?? []);
      const verdictRow = rows.find((row) => row.section === 8);

      assert.ok(verdictRow, "99-verify.sql 没有输出总体判定行（section = 8）");
      assert.equal(verdictRow.verdict, "PASS", `99-verify.sql 判定为 FAIL：${verdictRow.detail}`);

      // 顺带确认几个关键分节真的产出了行，而不是「查询写错返回空集、恰好没人发现」。
      const roleRows = rows.filter((row) => row.section === 2 && row.rolname);
      assert.equal(roleRows.length, 2, "第 2 节应报告两个角色");
      for (const role of roleRows) {
        assert.equal(role.verdict, "ok", `${role.rolname} 的判定应为 ok，实际 ${role.verdict}`);
      }

      const existence = rows.find((row) => row.check_name === "default privileges (existence)");
      assert.ok(existence, "第 5b 节应恒定产出一行");
      // ⚠️ `count(*)` 是 bigint，node-postgres 不做解析、原样返回**字符串** `'1'`。
      //    这不是脚本的问题（psql 里 bigint 与 int 打印完全相同），所以断言侧转换，
      //    而不是给脚本里的每一处 count 都套一个只服务于测试的 `::int`。
      assert.equal(Number(existence.migrator_table_rows), 1, "表的默认权限记录应有 1 条");
      assert.equal(Number(existence.migrator_sequence_rows), 1, "序列的默认权限记录应有 1 条");
      assert.equal(Number(existence.rows_on_wrong_role), 0, "不应有任何默认权限记在错误的角色名下");
    });
  } finally {
    // ═════════════════════════════════════════════════════════════════════
    // 7. 回滚并证明零残留
    // ═════════════════════════════════════════════════════════════════════
    await client.query("ROLLBACK");

    if (baseline) {
      const { rows } = await client.query(`
        SELECT
          (SELECT count(*)::int FROM pg_roles
            WHERE rolname IN ('chaoge_migrator','chaoge_app'))      AS roles,
          (SELECT count(*)::int FROM pg_default_acl)                AS defacl,
          (SELECT n.nspacl::text FROM pg_namespace n WHERE n.nspname = 'public')  AS schema_acl,
          (SELECT d.datacl::text FROM pg_database d WHERE d.datname = current_database()) AS db_acl
      `);
      assert.equal(rows[0].roles, baseline.roles, "回滚后不应残留任何角色");
      assert.equal(rows[0].defacl, baseline.defacl, "回滚后不应残留默认权限");
      assert.equal(rows[0].schema_acl, baseline.schema_acl, "回滚后 public 的 ACL 应与执行前逐字节相同");
      assert.equal(rows[0].db_acl, baseline.db_acl, "回滚后数据库的 ACL 应与执行前逐字节相同");
    }

    await client.end();
  }
});
