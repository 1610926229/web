/**
 * PROD-2 / Step 5.8.2 · Staging 独立数据库的守护测试
 *
 * 覆盖 `deploy/db/staging/` 下的全部 SQL、入口脚本与文档，以及
 * `deploy/app/` 中与数据源隔离相关的守卫。
 *
 * ## 这些用例在守什么
 *
 * 这一轮的核心决策是「Staging 必须用独立库，不得把 Mock 数据写进 chaoge_prod」。
 * 一条连接串写错就足以破坏它，而错误的表现可以是完全静默的——
 * 服务能启动、页面能打开、数据也确实写成功了，只是写进了正式库。
 *
 * 所以这里的断言以两类为主：
 *
 *   1. **名字层的隔离**：库名只允许 `chaoge_staging*`，角色只允许
 *      `chaoge_staging_migrator` / `chaoge_staging_app`，生产名在参数解析阶段就被拒绝；
 *   2. **行为层的隔离**：SQL 文件自己再拒绝一次 `chaoge_prod`，
 *      04/05 必须以迁移角色执行，06 必须以应用角色执行且只插入。
 *
 * 测试全部离线：不连数据库、不执行迁移。真正的隔离验证见 README §9
 * （本地 `--self-test` 流程）与交付报告。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGING_DIR = path.join(REPO_ROOT, "deploy", "db", "staging");
const APP_DIR = path.join(REPO_ROOT, "deploy", "app");

const read = (file) => readFileSync(file, "utf8");

/** 去掉 `--` 行注释。这些 SQL 的注释大量引用反面写法（例如「永远不会对 chaoge_prod 执行」）。 */
function stripSqlComments(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

/** 去掉 shell 的 `#` 注释行。 */
function stripHashComments(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const SQL_FILES = [
  "01-create-roles.sql",
  "02-harden-public.sql",
  "03-grants.sql",
  "04-default-privileges.sql",
  "05-table-grants.sql",
  "06-bootstrap-data.sql",
  "99-verify.sql",
];

const raw = Object.fromEntries(
  SQL_FILES.map((name) => [name, read(path.join(STAGING_DIR, name))]),
);
const sql = Object.fromEntries(
  Object.entries(raw).map(([name, src]) => [name, stripSqlComments(src)]),
);

const WRAPPER_PATH = path.join(STAGING_DIR, "deploy-staging.sh");
const wrapperRaw = read(WRAPPER_PATH);
const wrapper = stripHashComments(wrapperRaw);
const readme = read(path.join(STAGING_DIR, "README.md"));
const envScriptRaw = read(path.join(APP_DIR, "setup-staging-env.sh"));
const envScript = stripHashComments(envScriptRaw);
const installRaw = read(path.join(APP_DIR, "install-release.sh"));
const install = stripHashComments(installRaw);

function probeBash() {
  const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() === "ok";
}
const BASH_OK = probeBash();
const SKIP_NO_BASH = BASH_OK ? false : "需要 bash（Windows 上由 Git Bash 提供）";

// ── 1. 文件与默认目标 ────────────────────────────────────────────────────────

test("staging SQL 六件套与验收脚本齐全", () => {
  for (const name of SQL_FILES) {
    assert.ok(existsSync(path.join(STAGING_DIR, name)), `缺少 ${name}`);
  }
  assert.ok(existsSync(WRAPPER_PATH), "缺少 deploy-staging.sh");
});

test("入口默认指向 chaoge_staging 与两个 staging 角色", () => {
  assert.match(wrapper, /^DB_NAME="chaoge_staging"$/m);
  assert.match(wrapper, /chaoge_staging_migrator/);
  assert.match(wrapper, /chaoge_staging_app/);
});

// ── 2. 每个 SQL 文件都自带「永不 chaoge_prod」守卫 ───────────────────────────

test("全部 staging SQL 都有库名守卫，且无条件拒绝 chaoge_prod", () => {
  for (const name of SQL_FILES) {
    const src = sql[name];
    assert.match(
      src,
      /current_setting\('chaoge\.expected_database', true\)/,
      `${name} 缺少 expected_database 读取（本地隔离测试需要它）`,
    );
    assert.match(src, /actual = 'chaoge_prod' OR expected = 'chaoge_prod'/, `${name} 缺少 chaoge_prod 拒绝`);
    assert.match(src, /\^chaoge_staging/, `${name} 缺少 staging 前缀白名单`);
    assert.match(src, /actual IS DISTINCT FROM expected/, `${name} 缺少「连接库 == 期望库」断言`);
  }
});

test("守卫先于任何写操作：拒绝语句出现在第一条 GRANT/INSERT 之前", () => {
  for (const name of ["01-create-roles.sql", "02-harden-public.sql", "03-grants.sql",
                      "04-default-privileges.sql", "05-table-grants.sql", "06-bootstrap-data.sql"]) {
    const src = sql[name];
    const rejectAt = src.indexOf("actual = 'chaoge_prod' OR expected = 'chaoge_prod'");
    const firstWrite = src.search(
      /\b(CREATE ROLE|ALTER ROLE|REVOKE|GRANT|ALTER DEFAULT PRIVILEGES|INSERT INTO)\b/,
    );
    assert.ok(rejectAt >= 0, `${name} 缺少守卫`);
    assert.ok(firstWrite > rejectAt, `${name} 的第一条写语句出现在守卫之前`);
  }
});

// ── 3. 身份分工 ─────────────────────────────────────────────────────────────

test("04/05 必须以 staging 迁移角色执行", () => {
  for (const name of ["04-default-privileges.sql", "05-table-grants.sql"]) {
    assert.match(sql[name], /current_user IS DISTINCT FROM 'chaoge_staging_migrator'/, `${name} 缺少身份守卫`);
    assert.match(sql[name], /SET ROLE chaoge_staging_migrator/, `${name} 的提示里应给出 SET ROLE 方法`);
  }
});

test("06 必须以 staging 应用角色执行", () => {
  assert.match(sql["06-bootstrap-data.sql"], /current_user IS DISTINCT FROM 'chaoge_staging_app'/);
  assert.match(sql["06-bootstrap-data.sql"], /SET ROLE chaoge_staging_app/);
});

test("入口在 04/05 之前 SET ROLE 迁移角色、在 06 之前 SET ROLE 应用角色", () => {
  // 04 的记账键是 current_user；06 的 DML 检查必须按应用角色算。
  assert.match(wrapper, /SET ROLE chaoge_staging_migrator;/);
  assert.match(wrapper, /SET ROLE chaoge_staging_app;/);

  // 比对真正执行 SQL 的那一行（`cat …`），而不是文件名的第一次出现——
  // 前面还有「将要执行什么」的说明文字也提到同一个文件名。
  const migratorAt = wrapper.indexOf("SET ROLE chaoge_staging_migrator;");
  const grantAt = wrapper.indexOf('cat "$SCRIPT_DIR/04-default-privileges.sql"');
  assert.ok(migratorAt >= 0 && grantAt > migratorAt, "04 必须在 SET ROLE 之后");

  const appAt = wrapper.indexOf("SET ROLE chaoge_staging_app;");
  const bootstrapAt = wrapper.indexOf('cat "$SCRIPT_DIR/06-bootstrap-data.sql"');
  assert.ok(appAt >= 0 && bootstrapAt > appAt, "06 必须在 SET ROLE 之后");
});

// ── 4. 最小数据：只插入，绝不破坏 ────────────────────────────────────────────

test("06 只有 INSERT ... ON CONFLICT DO NOTHING", () => {
  const src = sql["06-bootstrap-data.sql"];
  assert.match(src, /INSERT INTO users/);
  assert.match(src, /ON CONFLICT DO NOTHING/);
  assert.match(src, /INSERT INTO admin_accounts/);
  assert.match(src, /INSERT INTO staff_accounts/);
  assert.match(src, /INSERT INTO companions/);
  assert.match(src, /INSERT INTO products/);
  assert.match(src, /INSERT INTO product_specs/);

  // 破坏性语句一条都不能有。删掉注释后再查，避免被解释性文字干扰。
  assert.doesNotMatch(src, /\bUPDATE\s+[a-z_]/i, "06 不得 UPDATE 任何表");
  assert.doesNotMatch(src, /\bDELETE\s+FROM\b/i, "06 不得 DELETE");
  assert.doesNotMatch(src, /\bTRUNCATE\b/i, "06 不得 TRUNCATE");
  assert.doesNotMatch(src, /\b(DROP|ALTER)\s+(TABLE|SCHEMA|ROLE|DATABASE)\b/i, "06 不得做 DDL");
});

test("06 覆盖三套 mock 登录与打手工作台所需的最小身份", () => {
  const src = sql["06-bootstrap-data.sql"];
  for (const id of ["u-1001", "u-1002", "admin-1", "staff-1", "cp-demo", "p-400w", "s-400w"]) {
    assert.ok(src.includes(`'${id}'`), `缺少 ${id}`);
  }
  // 与登录代码里的常量保持一致。
  assert.match(src, /admin_accounts[\s\S]*'admin', true/);
  assert.match(src, /staff_accounts[\s\S]*'customer_service', true/);
});

test("06 在插入前断言 schema_migrations 与业务表存在", () => {
  const src = sql["06-bootstrap-data.sql"];
  assert.match(src, /to_regclass\('public\.schema_migrations'\) IS NULL/);
  assert.match(src, /to_regclass\('public\.users'\) IS NULL/);
  assert.match(src, /业务表不完整/);
});

// ── 5. 99-verify 只读且给出总体判定 ──────────────────────────────────────────

test("99-verify 是只读脚本，并输出 section=9 OVERALL", () => {
  const src = sql["99-verify.sql"];
  // 只查「行首的语句关键字」：权限名本身也是 `'CREATE'` / `'TEMPORARY'` 这样的字符串，
  // 全文搜索会把 `has_database_privilege(..., 'CREATE')` 误判成一条 DDL。
  assert.doesNotMatch(
    src,
    /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/im,
    "99-verify 不得包含任何改动性语句",
  );
  assert.match(src, /9 AS section, 'OVERALL'/);
  assert.match(src, /'PASS'/);
  assert.match(src, /'FAIL'/);

  // 跨库隔离必须被检查，而不是只检查当前库的 ACL。
  assert.match(src, /cross-database isolation/);
  assert.match(src, /staging_can_reach_prod/);
  assert.match(src, /prod_roles_on_staging/);
});

// ── 6. 入口脚本的守卫 ────────────────────────────────────────────────────────

test("入口只接受六个阶段，明确不提供 seed/reset", () => {
  assert.match(wrapper, /check\|create\|init\|migrate\|bootstrap\|verify/);
  assert.match(wrapper, /未知阶段/);
  assert.doesNotMatch(wrapper, /pnpm db:(seed|reset)/);
});

test("入口在参数解析阶段拒绝生产库与非 staging 库", () => {
  assert.match(wrapper, /\^chaoge_staging\(_\[a-z0-9\]\+\)\*\$/);
  assert.match(wrapper, /DB_NAME" == "chaoge_prod"/);
  assert.match(wrapper, /永远不会对 chaoge_prod/);
});

test("--self-test 与 --rollback-selftest 只对 *_test 隔离库放行", () => {
  assert.match(wrapper, /--self-test 只允许用于 chaoge_staging\*_test/);
  assert.match(wrapper, /--rollback-selftest 只允许用于 \*_test/);
  assert.match(wrapper, /\[\[ "\$DB_NAME" == \*_test \]\]/);
});

test("migrate 以 NODE_ENV=production 执行，且不打印口令", () => {
  assert.match(wrapper, /NODE_ENV=production DATABASE_URL="\$url" pnpm db:migrate/);
  assert.match(wrapper, /read -rs raw_pw/);
  assert.match(wrapper, /<REDACTED>/);
  // 口令不得出现在 psql 命令行参数里。
  assert.doesNotMatch(wrapper, /psql[^\n]*-U "\$DB_ROLE"[^\n]*"\$raw_pw"/);
});

test("迁移代码目录错误提示指向 CHAOGE_APP_DIR", () => {
  assert.match(wrapper, /迁移代码目录不正确（缺少 package\.json）/);
  assert.match(wrapper, /CHAOGE_APP_DIR/);
  assert.match(wrapper, /不是 CHAOGE_SRC/);
});

test("verify 从报告里读 section=9 判定，而不是看退出码", () => {
  assert.match(wrapper, /\$1\+0==9 && \$2 ~ \/OVERALL\//);
  assert.match(wrapper, /PASS\) ok "验收通过/);
  assert.match(wrapper, /FAIL\) die "验收未通过/);
});

test("verify 把目标库名作为 GUC 传给 99-verify（否则 *_test 隔离库会被守卫拒绝）", () => {
  const verifyFn = wrapper.slice(wrapper.indexOf("phase_verify()"), wrapper.indexOf("# ── 主入口"));
  assert.match(verifyFn, /SET chaoge\.expected_database = '%s'/, "verify 必须显式传入期望库名");
  assert.ok(
    verifyFn.indexOf('cat "$SCRIPT_DIR/99-verify.sql"') > verifyFn.indexOf("chaoge.expected_database"),
    "GUC 必须在 99-verify 之前设置",
  );
});

test("本地验证路径把口令经子进程环境传入，而不是落盘", () => {
  assert.match(wrapper, /CHAOGE_STAGING_MIGRATOR_URL/);
  assert.match(wrapper, /只限本地隔离验证/);
  assert.doesNotMatch(wrapper, /echo "\$url"/);
});

// ── 7. 应用侧的数据源守卫 ───────────────────────────────────────────────────

test("setup-staging-env 默认与硬守卫都指向独立 staging", () => {
  assert.match(envScript, /^DB_NAME="chaoge_staging"$/m);
  assert.match(envScript, /^DB_ROLE="chaoge_staging_app"$/m);
  assert.match(envScript, /chaoge_app\)\s+die/);
  assert.match(envScript, /staging 必须使用独立的 chaoge_staging 库/);
  assert.match(envScript, /只接受 chaoge_staging/);
});

test("setup-staging-env 沿用既有口令时正确转义 .pgpass，不强制 64 位 hex", () => {
  assert.match(envScript, /pgpass_escape\(\)/);
  assert.ok(envScript.includes('out+="\\\\$c"'), "必须给反斜杠和冒号加转义前缀");
  assert.ok(envScript.includes("'\\'|':')"), "转义分支必须同时覆盖反斜杠与冒号");
  assert.match(envScript, /PGPASS_PW="\$\(pgpass_escape "\$RAW_PW"\)"/);
  assert.match(envScript, /RAW_PW" != \*\$'\\r'\*/);
  assert.doesNotMatch(envScript, /RAW_PW" =~ \^\[0-9a-f\]\{64\}\$/);
});

test("setup-staging-env 的参数守卫先于 root 检查（本地也能验证拒绝理由）", () => {
  const roleGuardAt = envScript.indexOf("运行时不得复用生产应用角色 chaoge_app");
  const prodDbGuardAt = envScript.indexOf("staging 必须使用独立的 chaoge_staging 库");
  const rootAt = envScript.indexOf('[[ "$(id -u)" == "0" ]]');
  assert.ok(roleGuardAt >= 0, "缺少 chaoge_app 拒绝");
  assert.ok(prodDbGuardAt >= 0, "缺少生产库名拒绝");
  assert.ok(rootAt > roleGuardAt, "角色守卫必须在 root 检查之前");
  assert.ok(rootAt > prodDbGuardAt, "库名守卫必须在 root 检查之前");
});

test("install-release 在解包前拒绝生产库 / 生产角色", () => {
  assert.match(install, /^DB_URL="\$\(sed -n 's\/\^DATABASE_URL=\/\/p'/m);
  assert.match(install, /URL_ROLE" == "chaoge_staging_app"/);
  assert.match(install, /URL_DB" =~ \^chaoge_staging/);
  assert.match(install, /生产角色 chaoge_app 与迁移角色在此一律拒绝/);
});

// ── 8. 文档 ─────────────────────────────────────────────────────────────────

test("staging README 记录完整运维流程与资源预估", () => {
  assert.match(readme, /check/);
  assert.match(readme, /create/);
  assert.match(readme, /init/);
  assert.match(readme, /migrate/);
  assert.match(readme, /bootstrap/);
  assert.match(readme, /verify/);
  assert.match(readme, /2 vCPU \/ 2 GB/);
  assert.match(readme, /PG_POOL_MAX=5/);
  assert.match(readme, /CHAOGE_STAGING_MIGRATOR_URL/);
});

test("staging README 明确说明不使用 db:seed / db:reset", () => {
  assert.match(readme, /db:seed/);
  assert.match(readme, /db:reset/);
  assert.match(readme, /NODE_ENV=production/);
  assert.match(readme, /不是「关掉守卫」|不是.*关掉守卫/s);
});

test("staging README 给出重建与人工审批边界", () => {
  assert.match(readme, /重建 staging/);
  assert.match(readme, /DROP DATABASE chaoge_staging/);
  assert.match(readme, /不会.*chaoge_prod|chaoge_prod.*不受影响/s);
});

// ── 9. 运行时负例：参数守卫必须在连库之前失败 ────────────────────────────────

function runWrapper(args, options = {}) {
  return spawnSync("bash", [WRAPPER_PATH, ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, CHAOGE_SUDO: "", CHAOGE_PSQL_ARGS: "" },
    ...options,
  });
}

test("入口拒绝 db:seed / db:reset 作为阶段名", { skip: SKIP_NO_BASH }, () => {
  for (const phase of ["db:seed", "db:reset", "seed", "reset"]) {
    const r = runWrapper([phase]);
    assert.notEqual(r.status, 0, `${phase} 不应被接受`);
    assert.match(r.stderr, /未知阶段/, `${phase} 应以「未知阶段」拒绝`);
  }
});

test("入口拒绝 chaoge_prod 与任意非 staging 库（不连数据库）", { skip: SKIP_NO_BASH }, () => {
  for (const db of ["chaoge_prod", "postgres", "chaoge_esports_dev", "chaoge_staging;drop"]) {
    const r = runWrapper(["check", "--database", db]);
    assert.notEqual(r.status, 0, `${db} 不应被接受`);
    assert.match(r.stderr, /不允许|拒绝/, `${db} 应被拒绝`);
    assert.doesNotMatch(r.stderr, /连不上 PostgreSQL|psql 退出码/, `${db} 应在连库之前就被拒绝`);
  }
});

test("--self-test 不接受真实 staging 库", { skip: SKIP_NO_BASH }, () => {
  const r = runWrapper(["check", "--database", "chaoge_staging", "--self-test"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /_test/);
});

test("--rollback-selftest 不接受真实 staging 库", { skip: SKIP_NO_BASH }, () => {
  const r = runWrapper(["init", "--database", "chaoge_staging", "--rollback-selftest"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /_test/);
});

test("--rollback-selftest 只适用于 init", { skip: SKIP_NO_BASH }, () => {
  const r = runWrapper(["verify", "--database", "chaoge_staging_iso_test", "--rollback-selftest"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /只适用于 init/);
});

// ── 10. 语法与执行位 ────────────────────────────────────────────────────────

test("staging 入口语法正确（bash -n）", { skip: SKIP_NO_BASH }, () => {
  const r = spawnSync("bash", ["-n", WRAPPER_PATH], { encoding: "utf8" });
  assert.equal(r.status, 0, `deploy-staging.sh 语法错误：\n${r.stderr}`);
});

test(
  "POSIX 下 staging 入口具有执行位",
  { skip: process.platform === "win32" ? "Windows 不保留执行位" : false },
  () => {
    assert.ok(statSync(WRAPPER_PATH).mode & 0o111, "deploy-staging.sh 没有执行位");
  },
);
