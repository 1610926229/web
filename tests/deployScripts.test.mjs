/**
 * PROD-2 · 部署脚本的守护测试
 *
 * 覆盖 `deploy/db/deploy.sh`（分阶段部署入口）与 `deploy/db/setup-credentials.sh`（凭据生成）。
 *
 * ## 为什么这些用例值得存在
 *
 * 这两个脚本的价值**不在于它们能跑通，而在于它们拒绝跑通什么**。
 * 一个部署入口如果在错误的库名上照常执行、在没有终端确认时照常执行、
 * 把 `db:migrate` 顺手带进流程，那么它比没有脚本更危险：没有脚本时人会停下来想，
 * 有脚本时人会以为脚本已经想过了。
 *
 * 所以这里的断言绝大多数是**负面断言**——「它必须拒绝」：
 * 拒绝注入式的库名、拒绝 --rollback-selftest 用在生产库、拒绝无终端的写操作、
 * 拒绝把系统库/模板库当业务库。这些用例在「脚本变宽松了」时会立刻变红。
 *
 * 另有两个正面断言来自实测教训，代码里看不出但会真的咬人：
 *   · 生成的 SQL 流里不能有 ESC 字节（`printf "\\echo"` 会把 `\e` 吃掉，
 *     报出来的却是几十行之外的「语法错误」）；
 *   · 生成的 SQL 流不能要求连得上数据库——`--dry-run` 的意义就是「还没碰之前先看」。
 *
 * ## 运行方式
 *
 *     pnpm test                                  # 只跑不需要数据库的部分
 *     PG_DEPLOY_SH_VERIFY=1 pnpm test:pg         # 加上真实执行（单事务回滚，零残留）
 *
 * 真实执行那一段默认跳过：它需要超级用户连接，且比单元测试重得多。
 * 连的是**维护库**（默认 `postgres`），**指向 `chaoge_prod` 会在模块加载期直接抛错**。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_DB_DIR = path.join(REPO_ROOT, "deploy", "db");
const DEPLOY_SH = path.join(DEPLOY_DB_DIR, "deploy.sh");
const CREDS_SH = path.join(DEPLOY_DB_DIR, "setup-credentials.sh");
const ENV_EXAMPLE = path.join(DEPLOY_DB_DIR, "db.env.example");

/** 真实执行要连的维护库。**绝不能是任何有业务数据的库。** */
const MAINTENANCE_DB = process.env.PG_DEPLOY_DB || "postgres";
const ENABLED = process.env.PG_DEPLOY_SH_VERIFY === "1";

if (ENABLED && MAINTENANCE_DB === "chaoge_prod") {
  throw new Error(
    "拒绝执行：PG_DEPLOY_DB 指向了生产库 chaoge_prod。本用例只允许对维护库或空库运行。",
  );
}

// ── bash 探测 ─────────────────────────────────────────────────────────────────

function probeBash() {
  const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() === "ok";
}
const BASH_OK = probeBash();
const SKIP_NO_BASH = BASH_OK ? false : "需要 bash（Windows 上由 Git Bash 提供）";

// ── 执行辅助 ──────────────────────────────────────────────────────────────────

/**
 * 跑一次 deploy.sh。
 *
 * stdin 一律是管道而不是终端——这正是要复现的生产事故形态：
 * 有人在 CI、cron 或 SSH 非交互会话里把部署脚本跑了起来。脚本必须拒绝这种调用。
 */
function runDeploy(args, { input = "" } = {}) {
  const r = spawnSync("bash", [DEPLOY_SH, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    env: { ...process.env, CHAOGE_SUDO: "", CHAOGE_PSQL_ARGS: "" },
  });
  return {
    code: r.status,
    out: `${r.stdout || ""}${r.stderr || ""}`,
    stdout: r.stdout || "",
  };
}

function runCreds(args, { input = "" } = {}) {
  const r = spawnSync("bash", [CREDS_SH, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// ── 阶段与库名守卫 ────────────────────────────────────────────────────────────

test("deploy.sh --help 列出四个阶段并说明它不跑迁移", { skip: SKIP_NO_BASH }, () => {
  const { code, out } = runDeploy(["--help"]);
  assert.equal(code, 0);
  for (const phase of ["check", "backup", "init", "verify"]) {
    assert.match(out, new RegExp(`\\b${phase}\\b`), `--help 应提到阶段 ${phase}`);
  }
  assert.match(out, /db:migrate/);
  assert.match(out, /不提供/);
});

test("deploy.sh 无参数时打印用法并返回非零", { skip: SKIP_NO_BASH }, () => {
  const { code, out } = runDeploy([]);
  assert.notEqual(code, 0);
  assert.match(out, /用法/);
});

test("deploy.sh 拒绝未知阶段", { skip: SKIP_NO_BASH }, () => {
  const { code, out } = runDeploy(["deploy-everything"]);
  assert.notEqual(code, 0);
  assert.match(out, /未知阶段/);
});

test("deploy.sh 把 migrate / seed / reset 当作未知阶段拒绝", { skip: SKIP_NO_BASH }, () => {
  // 这条断言是 PROD-2 要求 8 的正面证据：那三个动作**不是**本入口的阶段。
  // 若哪天有人把它们加成阶段，这里会立刻变红。
  for (const forbidden of ["migrate", "seed", "reset", "db:migrate"]) {
    const { code, out } = runDeploy([forbidden]);
    assert.notEqual(code, 0, `阶段 ${forbidden} 必须被拒绝`);
    assert.match(out, /未知阶段/);
  }
});

test("deploy.sh 拒绝注入式的库名", { skip: SKIP_NO_BASH }, () => {
  // 库名会被拼进 psql 与 pg_dump 的命令行。白名单是这道防线的全部。
  for (const evil of [
    "chaoge_prod'; DROP DATABASE chaoge_prod; --",
    "chaoge-prod",
    "9bad",
    "chaoge prod",
    "chaoge_prod\"",
    "$(whoami)",
    "chaoge;rm -rf /",
  ]) {
    const { code, out } = runDeploy(["init", "--database", evil]);
    assert.notEqual(code, 0, `库名「${evil}」必须被拒绝`);
    assert.match(out, /不合法/, `库名「${evil}」应因不合法被拒绝，实际输出：${out.slice(0, 200)}`);
  }
});

test("deploy.sh 拒绝 --rollback-selftest 用在生产库上", { skip: SKIP_NO_BASH }, () => {
  const { code, out } = runDeploy(["init", "--database", "chaoge_prod", "--rollback-selftest"]);
  assert.notEqual(code, 0);
  assert.match(out, /chaoge_prod/);
  assert.match(out, /没有正当用途/);
});

test("deploy.sh 拒绝 --rollback-selftest 用在 init 以外的阶段", { skip: SKIP_NO_BASH }, () => {
  // 静默忽略这个开关比拒绝更危险：运维以为「我加了自测所以安全」，
  // 实际却跑了一次真的 backup。
  for (const phase of ["check", "backup", "verify"]) {
    const { code, out } = runDeploy([phase, "--database", "postgres", "--rollback-selftest"]);
    assert.notEqual(code, 0, `${phase} + --rollback-selftest 必须被拒绝`);
    assert.match(out, /只适用于 init/);
  }
});

test("deploy.sh 拒绝把系统库/模板库当业务库执行 init", { skip: SKIP_NO_BASH }, () => {
  for (const db of ["template0", "template1"]) {
    const { code, out } = runDeploy(["init", "--database", db]);
    assert.notEqual(code, 0, `${db} 必须被拒绝`);
    assert.match(out, /模板库/);
  }
  const r = runDeploy(["init", "--database", "postgres"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /系统库/);
});

test("deploy.sh 在非终端里拒绝执行写操作", { skip: SKIP_NO_BASH }, () => {
  // 无人值守执行 init 是本轮要求 8 要挡住的核心场景。
  const { code, out } = runDeploy(["init", "--database", "chaoge_esports_dev"]);
  assert.notEqual(code, 0);
  assert.match(out, /无人值守|不是终端/);
});

/** 真实执行才测得了的用例见文件末尾的 gated 段。 */

// ── 生成的 SQL 流 ─────────────────────────────────────────────────────────────

function dryRunStream(db, extra = []) {
  const { code, stdout } = runDeploy(["init", "--database", db, ...extra, "--dry-run"]);
  assert.equal(code, 0, `--dry-run 应当成功（不连库、不写库）`);
  const start = stdout.indexOf("BEGIN;");
  assert.notEqual(start, -1, "--dry-run 输出里应包含 BEGIN;");
  return stdout.slice(start);
}

test("dry-run 不要求连得上数据库", { skip: SKIP_NO_BASH }, () => {
  // 连的是本机不存在的库名，仍应成功——预览的意义就是「还没碰之前先看」。
  const { code, out } = runDeploy(["init", "--database", "chaoge_prod", "--dry-run"]);
  assert.equal(code, 0, `--dry-run 不应要求连通，实际：${out.slice(0, 300)}`);
});

test("生成的流用 BEGIN 包住五步，并以 COMMIT 收尾", { skip: SKIP_NO_BASH }, () => {
  const stream = dryRunStream("chaoge_prod");
  assert.match(stream, /^BEGIN;/);
  assert.match(stream, /COMMIT;\s*$/);
  assert.doesNotMatch(stream, /ROLLBACK;/);
});

test("--rollback-selftest 生成的流以 ROLLBACK 收尾", { skip: SKIP_NO_BASH }, () => {
  const stream = dryRunStream("postgres", ["--rollback-selftest"]);
  assert.match(stream, /^BEGIN;/);
  assert.match(stream, /ROLLBACK;\s*$/);
  assert.doesNotMatch(stream, /COMMIT;/);
});

test("生成的流带库名守卫、五个文件标记与 SET ROLE", { skip: SKIP_NO_BASH }, () => {
  const stream = dryRunStream("chaoge_prod");
  assert.match(stream, /SET chaoge\.expected_database = 'chaoge_prod';/);
  for (const f of [
    "01-create-roles.sql",
    "02-harden-public.sql",
    "03-migrator-grants.sql",
    "04-app-default-privileges.sql",
    "05-app-table-grants.sql",
  ]) {
    assert.ok(stream.includes(f), `流里应包含 ${f} 的标记`);
  }
  // 04/05 必须在 SET ROLE chaoge_migrator 之后——否则 04 的默认权限会记在 postgres 名下，
  // 脚本「成功」但一条都不生效。
  const setRole = stream.indexOf("SET ROLE chaoge_migrator;");
  const idx04 = stream.indexOf("04-app-default-privileges.sql");
  assert.ok(setRole !== -1 && idx04 !== -1 && setRole < idx04, "SET ROLE 必须出现在 04 之前");
  assert.match(stream, /RESET ROLE;/);
});

test("生成的流里没有 ESC 字节", { skip: SKIP_NO_BASH }, () => {
  // 实测教训：`printf "\\echo …"` 会把格式串里的 `\e` 解释成 ESC (0x1B)，
  // 送进 psql 的是 `^[cho …`。它打断语句解析，报出来却是几十行之外的
  // 「语法错误在 "" 或附近」，非常难定位。这条断言把它钉住。
  const stream = dryRunStream("chaoge_prod");
  assert.ok(!stream.includes("\x1b"), "生成的 SQL 流里不应出现 ESC 字节");
});

/**
 * 剥掉 heredoc 正文与引号字符串的内容，只留下 shell 会当成命令解析的部分。
 *
 * 不做这一步，「脚本里出现过 db:migrate 这几个字」和「脚本会执行 db:migrate」
 * 就分不开——而前者是**必须**存在的：init 跑完要打印迁移命令，告诉人下一步做什么。
 * 把整行当命令判断会把这段提示误判成违规。
 */
function shellCommandText(src) {
  const out = [];
  let heredoc = null;
  for (const line of src.split("\n")) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const m = line.match(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/);
    if (m) {
      heredoc = m[1];
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    out.push(line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"));
  }
  return out.join("\n");
}

test("deploy.sh 的可执行语句里没有 db:migrate / db:seed / db:reset", { skip: SKIP_NO_BASH }, () => {
  const src = readFileSync(DEPLOY_SH, "utf8");
  const commands = shellCommandText(src);
  for (const sub of ["migrate", "seed", "reset"]) {
    assert.doesNotMatch(
      commands,
      new RegExp(`\\b(pnpm|npx|node|npm)\\b[^\\n]*\\bdb:${sub}\\b`),
      `不应存在执行 db:${sub} 的语句`,
    );
  }
  // 反面：提示里**必须**有迁移命令，否则运维不知道该敲什么。
  assert.ok(src.includes("db:migrate"), "应在提示里告诉运维迁移命令是什么");
});

// ── 凭据脚本 ──────────────────────────────────────────────────────────────────

test("setup-credentials.sh --help 说明权限模型", { skip: SKIP_NO_BASH }, () => {
  const { code, out } = runCreds(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /0640/); // 服务组可读、others 不可读
  assert.match(out, /0750/);
  assert.match(out, /\/etc\//);
});

test("setup-credentials.sh 不接受命令行传口令", { skip: SKIP_NO_BASH }, () => {
  // 命令行参数会进 shell 历史与 ps 输出，这是最容易被忽略的一条泄露路径。
  const src = readFileSync(CREDS_SH, "utf8");
  assert.doesNotMatch(src, /--password/, "不应提供 --password 选项");
  assert.match(src, /read -rs/, "口令应经 read -s 从终端读取");
  // 也不应从环境变量读取明文口令。
  assert.doesNotMatch(src, /PGPASSWORD=/, "不应把明文口令放进环境变量");
  assert.doesNotMatch(src, /export\s+\w*PW/, "不应导出任何口令变量");
});

test("setup-credentials.sh 生成的文件不含任何 Mock 开关", { skip: SKIP_NO_BASH }, () => {
  const src = readFileSync(CREDS_SH, "utf8");
  // ENABLE_MOCK_DEBUG 会开放 POST /api/debug/reset（一个清库接口），生产上不能有。
  assert.doesNotMatch(src, /^\s*ENABLE_MOCK_\w+=/m, "生成的凭据文件里不应写入 Mock 开关");
  assert.match(src, /^DATA_SOURCE=postgres$/m);
});

test("db.env.example 是模板：有变量名、无凭据、无 Mock 开关", { skip: SKIP_NO_BASH }, () => {
  assert.ok(existsSync(ENV_EXAMPLE), "应提供凭据模板");
  const txt = readFileSync(ENV_EXAMPLE, "utf8");
  assert.match(txt, /^DATA_SOURCE=postgres$/m);
  assert.match(txt, /^DATABASE_URL=postgresql:\/\/chaoge_app:/m);
  assert.doesNotMatch(txt, /^\s*ENABLE_MOCK_\w+=/m);
  assert.doesNotMatch(txt, /^\s*TEST_DATABASE_URL=/m);
  // 模板里不能出现真实口令。
  assert.match(txt, /REPLACE_ME/);
});

test("urlencode 正确处理会破坏连接串的字符", { skip: SKIP_NO_BASH }, () => {
  // 从**真实脚本**里抠出 urlencode 定义来跑，而不是在用例里抄一份——
  // 抄一份的话，脚本改了、用例还绿着。
  const src = readFileSync(CREDS_SH, "utf8");
  const start = src.indexOf("urlencode() {");
  const end = src.indexOf("\n}\n", start);
  assert.ok(start !== -1 && end !== -1, "应从脚本中定位到 urlencode 定义");
  const fn = src.slice(start, end + 3);

  const cases = [
    ["simple123", "simple123"],
    ["p@ssword", "p%40ssword"], // @ 会被当成 host 分隔符
    ["a:b", "a%3Ab"], // : 会被当成端口分隔符
    ["a/b?c#d", "a%2Fb%3Fc%23d"],
    ["with space", "with%20space"],
    ["chao%ge", "chao%25ge"], // % 自身必须被编码，否则二次解码
    ["中文口令", "%E4%B8%AD%E6%96%87%E5%8F%A3%E4%BB%A4"], // UTF-8 逐字节
  ];
  const values = cases.map(([v]) => v);
  const r = spawnSync(
    "bash",
    ["-c", `set -eu\nLC_ALL=C\n${fn}\nfor v in "$@"; do urlencode "$v"; printf '\\n'; done`, "_", ...values],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const got = (r.stdout || "").trimEnd().split("\n");
  assert.deepEqual(got, cases.map(([, want]) => want));
});

// ── 备份恢复验证：源码级守护 ──────────────────────────────────────────────────
//
// 这一组守的是 PROD-2 Step 5.2.4 修掉的那个缺陷：「备份恢复验证可能误报成功」。
// 失败形态很安静——`pg_restore` 的错误被 `2>/dev/null || true` 丢掉，然后只数表数量；
// 而 `pg_dump --section=pre-data` 出来的备份还原后表**一张不少**，
// 于是「有壳没肉」的备份被判成成功。上面的真实执行段有用例复现它。

const DEPLOY_SH_SRC = readFileSync(DEPLOY_SH, "utf8");

/**
 * 剥掉**整行注释**后的源码。
 *
 * 这一组检查的是代码行为，而修复说明本身不可避免地要引用被修掉的写法——
 * 注释里literally写着「旧写法是 `pg_restore … 2>/dev/null || true`」、
 * 「不能用 reltuples」。不剥注释，守护测试会因为文档写得太清楚而变红，
 * 然后下一个人就会去删掉那段解释——那是把有用的东西删掉来迁就测试。
 */
function stripComments(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}
const DEPLOY_SH_CODE = stripComments(DEPLOY_SH_SRC);

test("restore_verify 不吞掉 pg_restore 的退出码和错误输出", { skip: SKIP_NO_BASH }, () => {
  // 旧的失败形态：错误进 /dev/null，退出码被 || true 吃掉，
  // 于是「还原失败」与「还原成功」在脚本里长得一模一样。
  const swallowed = /pg_restore\b[^\n]*2>\/dev\/null[^\n]*\|\|\s*true/;
  assert.ok(
    !swallowed.test(DEPLOY_SH_CODE),
    "pg_restore 的失败不得被 2>/dev/null || true 吞掉——那会让还原失败看起来像成功",
  );

  // 并且必须**真的**把退出码接住再判。
  const restoreBlock = DEPLOY_SH_SRC.slice(DEPLOY_SH_SRC.indexOf("restore_verify()"));
  assert.match(restoreBlock, /pg_restore[\s\S]{0,400}?\|\|\s*rc=\$\?/, "应接住 pg_restore 的退出码");
  assert.match(restoreBlock, /if\s*\(\(\s*rc\s*!=\s*0\s*\)\)/, "应显式判断退出码非 0");
});

test("restore_verify 比对数据而不只是表数量", { skip: SKIP_NO_BASH }, () => {
  // 行数、约束、索引、序列、迁移元数据这五类内容指纹缺一不可。
  for (const [needle, why] of [
    ["FP_TABLES", "每张表的 count(*)"],
    ["FP_CONSTRAINTS", "约束"],
    ["FP_INDEXES", "索引"],
    ["FP_SEQUENCES", "序列"],
    ["FP_MIGRATIONS", "迁移元数据"],
  ]) {
    assert.ok(DEPLOY_SH_SRC.includes(needle), `应定义 ${needle}（${why}）`);
  }
  // 「表与行数」这一项必须真的数行，而不是查 pg_class 的估计值。
  const fpTables = DEPLOY_SH_SRC.slice(
    DEPLOY_SH_SRC.indexOf("FP_TABLES="),
    DEPLOY_SH_SRC.indexOf("FP_CONSTRAINTS="),
  );
  assert.match(fpTables, /count\(\*\)/, "必须用真实 count(*) 逐表计数");
  assert.ok(
    !/reltuples/.test(DEPLOY_SH_CODE),
    "不得用 reltuples 判定恢复结果：它是 ANALYZE 的估计值，会同时造成假通过和假失败",
  );
});

test("取指纹的查询失败时必须中止，不能把失败读成空串", { skip: SKIP_NO_BASH }, () => {
  // 这是最隐蔽的一种假通过：查询写错 → 两边都返回空 → diff 也是空 → 判定「一致」。
  const fp = DEPLOY_SH_SRC.slice(
    DEPLOY_SH_SRC.indexOf("fingerprint()"),
    DEPLOY_SH_SRC.indexOf("compare_fingerprint()"),
  );
  assert.match(fp, /rc=0/);
  assert.match(fp, /\|\|\s*rc=\$\?/, "fingerprint 必须接住 psql 的退出码");
  assert.match(fp, /die/, "查询失败必须中止");

  // compare_fingerprint 在源库侧为空时只能报 N/A，绝不能报「一致」。
  const cmp = DEPLOY_SH_SRC.slice(DEPLOY_SH_SRC.indexOf("compare_fingerprint()"));
  assert.match(cmp.slice(0, 900), /-z "\$src"[\s\S]{0,200}?N\/A|源库为空/);
});

test("q() 不再把查询失败吞成空值", { skip: SKIP_NO_BASH }, () => {
  // 失败被吞成空串的代价不是「少一行输出」，而是调用方把**一次失败**读成**一个事实**：
  // 读不到 schema_migrations 就报「迁移从未执行过」，读不到 PUBLIC 授权就报「仍有授权」。
  // 注意用 `\nq() {` / `\nq_opt() {` 这两个**函数定义**的位置切段：
  // 说明文字里早就提到过 q_opt()，按裸串切会切出一个空区间，断言随之失效。
  const start = DEPLOY_SH_CODE.indexOf("\nq() {");
  const end = DEPLOY_SH_CODE.indexOf("\nq_opt() {");
  assert.ok(start >= 0 && end > start, "应能在源码里定位 q() 与 q_opt() 的定义");
  const q = DEPLOY_SH_CODE.slice(start, end);
  assert.ok(!/2>\/dev\/null\s*\|\|\s*true/.test(q), "q() 不得再吞掉 psql 的失败");
  assert.match(q, /\|\|\s*rc=\$\?/);
  assert.match(q, /die/);
  // 真正允许失败的那一处（读 pg_authid，需要超级用户）走单独的通融接口。
  assert.ok(end > 0, "应保留一个显式的通融接口（q_opt）给「允许失败」的查询");
});

test("送进 psql -c 的 SQL 必须是纯 ASCII", { skip: SKIP_NO_BASH }, () => {
  // 实测教训：客户端编码随环境变，Windows 的 Git Bash 会把 `-c` 参数里的 UTF-8
  // 转成 GBK，服务端报 `无效的 "UTF8" 编码字节顺序`。旧实现把这个错误吞成空串，
  // 于是「已收紧」被读成「仍有授权」——报出的结论是错的，但看上去一切正常。
  // 中文留给 bash 去拼，SQL 只要 ASCII 标记，就与客户端编码无关。
  const sqlArgs = [...DEPLOY_SH_SRC.matchAll(/\bq(?:_opt)?\s+"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1],
  );
  assert.ok(sqlArgs.length >= 8, `应找到多条 q()/q_opt() 查询，实际 ${sqlArgs.length} 条`);
  for (const sql of sqlArgs) {
    assert.ok(
      !/[^\x00-\x7F]/.test(sql),
      `q()/q_opt() 的 SQL 里不得出现非 ASCII 字符（客户端编码会把它弄坏）：${sql.slice(0, 80)}`,
    );
  }
});

test("--verify-dump 与自相矛盾的开关互斥", { skip: SKIP_NO_BASH }, () => {
  // 共同点是「静默忽略任意一方都会给出一个骗人的退出码」：
  // --dry-run 不执行还原 → 没校验，却返回 0；
  // --no-restore-verify 要求跳过校验，--verify-dump 要求做校验。
  for (const extra of ["--dry-run", "--no-restore-verify"]) {
    const { code, out } = runDeploy(["backup", "--verify-dump", "x.dump", extra]);
    assert.notEqual(code, 0, `${extra} 与 --verify-dump 同时用应被拒绝`);
    assert.match(out, /不能同时用/);
  }
});

// ── 凭据脚本：临时文件与口令 ──────────────────────────────────────────────────

test("setup-credentials.sh 不使用可预测的固定临时路径", { skip: SKIP_NO_BASH }, () => {
  const src = stripComments(readFileSync(CREDS_SH, "utf8"));
  // /tmp/.chaoge_conn 是可预测的公共路径：同机任何用户都能抢先放一个符号链接，
  // `>` 会顺着链接把目标文件覆盖掉。写进去的只是连接结果而非口令，
  // 但这与「拿公共路径当私有暂存」是同一个错误，而口令就住在同一个函数里。
  assert.ok(
    !/\/tmp\/\.chaoge_conn/.test(src),
    "不得再把试连结果写到固定的 /tmp/.chaoge_conn（可预测路径 + 符号链接覆盖）",
  );
  // .pgpass 必须走 mktemp，且权限收紧。
  assert.match(src, /mktemp/, "临时 .pgpass 应使用 mktemp");
  assert.match(src, /chmod 600/, "临时 .pgpass 应为 0600");
  // 清理必须挂在 EXIT/INT/TERM 上，否则被打断就留下明文口令。
  assert.match(src, /trap\s+cleanup_pgpass\s+EXIT\s+INT\s+TERM/, "清理应挂在 EXIT/INT/TERM");
});

test("01-create-roles.sql 的 README 交叉引用指向真实存在的章节", { skip: SKIP_NO_BASH }, () => {
  const sql = readFileSync(path.join(DEPLOY_DB_DIR, "01-create-roles.sql"), "utf8");
  const readme = readFileSync(path.join(DEPLOY_DB_DIR, "README.md"), "utf8");

  // 这条引用曾经指向「第 2 步」，而 README 重排后设置密码已经变成第 3 步——
  // 一个把人引到「权限初始化」那一节的过期路标。所以按**结构**去验，
  // 而不是比对一句会随正文措辞漂移的字面量。
  const m = sql.match(/设置密码（见 README §(\d+) 第 (\d+) 步）/);
  assert.ok(m, "01 里应有指向 README 设置密码章节的交叉引用");
  const [, section, step] = m;
  assert.ok(
    new RegExp(`^## ${section}\\.`, "m").test(readme),
    `README 里应存在 §${section} 这个章节`,
  );
  assert.ok(
    new RegExp(`^### 第 ${step} 步`, "m").test(readme),
    `README §${section} 里应存在「第 ${step} 步」——引用过期会把人引到错误的步骤`,
  );
});

// ── 真实执行（默认跳过，单事务回滚，零残留）──────────────────────────────────

if (ENABLED) {
  const { default: pg } = await import("pg");
  const BASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  assert.ok(BASE_URL, "PG_DEPLOY_SH_VERIFY=1 需要 TEST_DATABASE_URL 或 DATABASE_URL");

  // 给 deploy.sh 里的 psql 一份 .pgpass，让口令不进 argv、不进环境变量。
  const passDir = mkdtempSync(path.join(os.tmpdir(), "chaoge-deploy-test-"));
  const passFile = path.join(passDir, "pgpass");
  {
    const u = new URL(BASE_URL);
    const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
    // 维护库名与连接串里的库名不同，所以库里那一栏写 `*`。
    writeFileSync(passFile, `${host}:${u.port || 5432}:*:${u.username}:${u.password}\n`);
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(passFile, 0o600);
    } catch {
      /* Windows 无 POSIX 权限位；psql 在 Windows 上也不做这道检查 */
    }
  }
  test.after(() => rmSync(passDir, { recursive: true, force: true }));

  const u = new URL(BASE_URL);
  const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
  const PGPASS_ONLY = { PGPASSFILE: passFile };

  /** 备份的**源库**。它必须是有数据的库，否则「恢复验证」会空转、
   *  下面几个用例就什么也证明不了。 */
  const SRC_DB = u.pathname.replace(/^\//, "");
  const PG_CONN_ARGS = ["-h", host, "-p", String(u.port || 5432), "-U", u.username, "-w"];
  const PG_ENV = { ...process.env, ...PGPASS_ONLY };

  function runPg(bin, args) {
    const r = spawnSync(bin, args, { cwd: REPO_ROOT, encoding: "utf8", env: PG_ENV });
    return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  }

  const PG_TOOLS_OK = runPg("pg_dump", ["--version"]).code === 0;
  const SKIP_NO_PGDUMP = PG_TOOLS_OK ? false : "需要 pg_dump / pg_restore（psql 客户端工具）";

  async function scratchDbCount(client) {
    const r = await client.query(
      "SELECT count(*)::int AS v FROM pg_database WHERE datname LIKE 'chaoge_restore_verify_%'",
    );
    return r.rows[0].v;
  }

  function runGated(args, input = "") {
    const r = spawnSync("bash", [DEPLOY_SH, ...args], {
      cwd: REPO_ROOT,
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        ...PGPASS_ONLY,
        CHAOGE_SUDO: "",
        CHAOGE_PSQL_ARGS: `-h ${host} -p ${u.port || 5432} -U ${u.username}`,
      },
    });
    return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  }

  async function maintenanceClient() {
    const c = new URL(BASE_URL);
    c.pathname = `/${MAINTENANCE_DB}`;
    const client = new pg.Client({ connectionString: c.toString() });
    await client.connect();
    return client;
  }

  async function residue(client) {
    const roles = await client.query(
      "SELECT coalesce(string_agg(rolname, ', '), '(none)') AS v FROM pg_roles WHERE rolname LIKE 'chaoge\\_%'",
    );
    const dacl = await client.query("SELECT count(*)::int AS v FROM pg_default_acl");
    const dat = await client.query(
      "SELECT coalesce(datacl::text, 'NULL') AS v FROM pg_database WHERE datname = current_database()",
    );
    const nsp = await client.query(
      "SELECT coalesce(nspacl::text, 'NULL') AS v FROM pg_namespace WHERE nspname = 'public'",
    );
    return {
      roles: roles.rows[0].v,
      defaultAclRows: dacl.rows[0].v,
      datacl: dat.rows[0].v,
      nspacl: nsp.rows[0].v,
    };
  }

  test("deploy.sh check 在真实库上跑通并报告各节", { skip: SKIP_NO_BASH }, async () => {
    const { code, out } = runGated(["check", "--database", MAINTENANCE_DB]);
    assert.equal(code, 0, out);
    assert.match(out, /PostgreSQL \d+/);
    for (const section of ["角色", "口令", "PUBLIC", "迁移进度", "备份目录"]) {
      assert.ok(out.includes(section), `check 应报告「${section}」，实际：${out.slice(0, 400)}`);
    }
  });

  test("deploy.sh init --rollback-selftest 真跑五步、断言全过、零残留", { skip: SKIP_NO_BASH }, async () => {
    const client = await maintenanceClient();
    try {
      const before = await residue(client);

      const { code, out } = runGated(
        ["init", "--database", MAINTENANCE_DB, "--rollback-selftest"],
        `${MAINTENANCE_DB}\n`,
      );
      assert.equal(code, 0, `init 自测应成功，实际输出：${out}`);

      // 五个脚本各自的自检都必须真的跑过——只看退出码会漏掉「守卫提前返回」这类情况。
      for (const n of ["[01]", "[02]", "[03]", "[04]", "[05]"]) {
        assert.ok(out.includes(`${n} 自检通过`), `${n} 的自检应出现在输出里`);
      }

      // 事务回滚之后，集群状态必须与执行前逐字节相同。
      const after = await residue(client);
      assert.deepEqual(after, before, "回滚后集群不应有任何残留");
    } finally {
      await client.end();
    }
  });

  test("deploy.sh 的确认输入错误时不做任何改动", { skip: SKIP_NO_BASH }, async () => {
    // 自测模式允许从管道读确认，用它验证「库名敲错」这条路径。
    // 必须在真实库上跑：确认发生在连通性检查之后。
    const { code, out } = runGated(
      ["init", "--database", MAINTENANCE_DB, "--rollback-selftest"],
      "wrong-database-name\n",
    );
    assert.notEqual(code, 0);
    assert.match(out, /确认失败/);
    assert.match(out, /未做任何改动/);
  });

  test("deploy.sh init 可以重复执行（第二次仍成功且仍零残留）", { skip: SKIP_NO_BASH }, async () => {
    const client = await maintenanceClient();
    try {
      const before = await residue(client);
      for (const round of [1, 2]) {
        const { code, out } = runGated(
          ["init", "--database", MAINTENANCE_DB, "--rollback-selftest"],
          `${MAINTENANCE_DB}\n`,
        );
        assert.equal(code, 0, `第 ${round} 次应成功，实际：${out}`);
      }
      assert.deepEqual(await residue(client), before, "两次执行后仍应零残留");
    } finally {
      await client.end();
    }
  });

  test("deploy.sh backup 真的能备份、能还原、并留下可校验的校验和", { skip: SKIP_NO_BASH }, async () => {
    const backupDir = mkdtempSync(path.join(os.tmpdir(), "chaoge-backup-test-"));
    try {
      const { code, out } = runGated([
        "backup",
        "--database",
        MAINTENANCE_DB,
        "--backup-dir",
        backupDir,
      ]);
      assert.equal(code, 0, `backup 应成功，实际输出：${out}`);
      assert.match(out, /备份目录可写/);
      assert.match(out, /归档目录可读/);
      assert.match(out, /恢复验证通过/);

      const files = readdirSync(backupDir);
      const dump = files.find((f) => f.endsWith(".dump"));
      assert.ok(dump, `备份目录里应有 .dump，实际：${files.join(", ")}`);
      const sum = `${dump}.sha256`;
      assert.ok(files.includes(sum), `应有校验和文件 ${sum}`);

      // 校验和必须能真的校验通过——只生成了一个文件不代表它是对的。
      const checked = spawnSync("sha256sum", ["-c", sum], { cwd: backupDir, encoding: "utf8" });
      assert.equal(checked.status, 0, `sha256sum -c 应通过：${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /: OK$/m);
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }

    // 恢复验证用的临时库必须已经删掉。它最容易在「脚本被打断」时留下来，
    // 而每失败一次留一个库，磁盘会悄无声息地涨。
    const client = await maintenanceClient();
    try {
      assert.equal(await scratchDbCount(client), 0, "恢复验证的临时库应已被清理");
    } finally {
      await client.end();
    }
  });

  // ── 恢复验证的两条路径（PROD-2 Step 5.2.4）────────────────────────────────
  //
  // 上面那条用例只要「退出码 0」就算过——而缺陷恰恰是**它会在失败时也返回 0**。
  // 所以这里必须把两种结果分别造出来：一个真的能还原的备份，和一个
  // 「表在、数据没了」的备份，然后看脚本能不能把它们区分开。

  /** 连到**源库**（备份的源），而不是维护库——两回事，别串了。 */
  async function sourceClient() {
    const c = new URL(BASE_URL);
    c.pathname = `/${SRC_DB}`;
    const client = new pg.Client({ connectionString: c.toString() });
    await client.connect();
    return client;
  }

  /** 源库里有多少张业务表。为 0 时下面的用例无从谈起。 */
  async function sourceTableCount(client) {
    const r = await client.query(
      "SELECT count(*)::int AS v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')",
    );
    return r.rows[0].v;
  }

  test("恢复验证：成功路径要真的逐项比对内容，而不是空转", { skip: SKIP_NO_BASH || SKIP_NO_PGDUMP }, async () => {
    const client = await sourceClient();
    let tables;
    try {
      tables = await sourceTableCount(client);
    } finally {
      await client.end();
    }
    assert.ok(
      tables > 0,
      `源库 ${SRC_DB} 的 public 里没有表，恢复验证会空转、这个用例证明不了任何事。` +
        `请把 TEST_DATABASE_URL 指向已迁移的库（本机的 chaoge_esports_test）。`,
    );

    const backupDir = mkdtempSync(path.join(os.tmpdir(), "chaoge-verify-ok-"));
    try {
      const { code, out } = runGated([
        "backup",
        "--database",
        SRC_DB,
        "--backup-dir",
        backupDir,
      ]);
      assert.equal(code, 0, `备份 + 恢复验证应成功，实际输出：${out}`);

      // 逐项都要比过，并且**报出条目数**——数字本身证明它没有空转。
      assert.match(out, /表与行数：\d+ 项全部一致/);
      assert.match(out, /约束：\d+ 项全部一致/);
      assert.match(out, /索引：\d+ 项全部一致/);
      assert.ok(
        !/没有可比对的内容/.test(out),
        `有 ${tables} 张表的源库不该被判为空转：${out.slice(0, 400)}`,
      );
      // 序列这一项当前 schema 里一个都没有，应明确报 N/A 而不是假装比过。
      assert.match(out, /序列：源库为空，无可比对（N\/A）/);

      // 报出来的表数必须与源库对得上，不能是个凑数的数字。
      const m = out.match(/表与行数：(\d+) 项全部一致/);
      assert.equal(Number(m[1]), tables, "指纹里的表数应与源库一致");
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  test(
    "恢复验证：能抓出「表都在、数据全没了」的备份（本缺陷的原形）",
    { skip: SKIP_NO_BASH || SKIP_NO_PGDUMP },
    async () => {
      // `--section=pre-data` 只导出结构、不导出数据。还原之后：
      //   · 表**一张不少**          → 旧的「只数表数量」判定会通过
      //   · pg_restore 退出码 = 0   → 旧的「吞掉错误码」判定也会通过
      //   · stderr 为空             → 连「有没有报错」都看不出来
      // 唯一能识破它的是**数据比对**。这就是这个用例存在的理由。
      const dir = mkdtempSync(path.join(os.tmpdir(), "chaoge-verify-bad-"));
      try {
        const nodata = path.join(dir, "nodata.dump");
        const dumped = runPg("pg_dump", [
          ...PG_CONN_ARGS,
          "-Fc",
          "--section=pre-data",
          "-d",
          SRC_DB,
          "-f",
          nodata,
        ]);
        assert.equal(dumped.code, 0, `构造失败样本时 pg_dump 就失败了：${dumped.out}`);
        assert.ok(existsSync(nodata), "应生成只有结构的备份");

        const { code, out } = runGated([
          "backup",
          "--database",
          SRC_DB,
          "--verify-dump",
          nodata,
        ]);

        // 1) 必须失败，且必须停在失败上——后面什么都不能再做。
        assert.notEqual(code, 0, `「表在、数据没了」的备份必须被判失败，实际输出：${out}`);
        assert.ok(
          !/备份与恢复验证通过|恢复验证通过（未新建备份）/.test(out),
          `失败时不得打印任何成功信息：${out.slice(0, 400)}`,
        );

        // 2) 要点名是哪一项对不上，而不是一句笼统的「验证失败」。
        assert.match(out, /表与行数：不一致/);
        assert.match(out, /迁移元数据：不一致/);

        // 3) 说明后果，并明确拦住后续操作。
        assert.match(out, /不可信/);
        assert.match(out, /不要继续 init \/ migrate/);

        // 4) pg_restore 自己退出码是 0 —— 这正是旧实现误报成功的机制，
        //    写在这里是为了让「为什么不能只看退出码」这件事留在测试里。
        assert.match(out, /pg_restore 退出码 0/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const client = await maintenanceClient();
      try {
        assert.equal(await scratchDbCount(client), 0, "验证失败后临时库也必须被清理");
      } finally {
        await client.end();
      }
    },
  );

  test("恢复验证：pg_restore 非零退出必须中止", { skip: SKIP_NO_BASH || SKIP_NO_PGDUMP }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "chaoge-verify-trunc-"));
    try {
      // 截断的备份 = 传输中断 / 磁盘写满 / 从坏介质拷回来。这是最真实的一种坏法。
      const full = path.join(dir, "full.dump");
      const dumped = runPg("pg_dump", [...PG_CONN_ARGS, "-Fc", "-d", SRC_DB, "-f", full]);
      assert.equal(dumped.code, 0, dumped.out);

      const truncated = path.join(dir, "trunc.dump");
      const buf = readFileSync(full);
      writeFileSync(truncated, buf.subarray(0, Math.floor(buf.length / 3)));

      const { code, out } = runGated([
        "backup",
        "--database",
        SRC_DB,
        "--verify-dump",
        truncated,
      ]);
      assert.notEqual(code, 0, `被截断的备份必须被判失败，实际输出：${out}`);
      assert.match(out, /pg_restore 退出码 [1-9]/, "应报出 pg_restore 的真实退出码");
      assert.match(out, /不可信/);
      assert.ok(!/恢复验证通过（未新建备份）/.test(out), "失败时不得打印成功信息");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const client = await maintenanceClient();
    try {
      assert.equal(await scratchDbCount(client), 0, "失败路径同样不得留下临时库");
    } finally {
      await client.end();
    }
  });

  test("--verify-dump 在 backup 以外的阶段被拒绝", { skip: SKIP_NO_BASH }, () => {
    // 静默忽略会让人以为「我加了校验」，实际什么都没发生。
    for (const phase of ["check", "verify"]) {
      const { code, out } = runGated([phase, "--database", MAINTENANCE_DB, "--verify-dump", "x.dump"]);
      assert.notEqual(code, 0, `${phase} 阶段不该接受 --verify-dump`);
      assert.match(out, /--verify-dump 只适用于 backup 阶段/);
    }
  });

  test("--verify-dump 指向不存在或空文件时明确失败", { skip: SKIP_NO_BASH }, () => {
    const { code, out } = runGated([
      "backup",
      "--database",
      MAINTENANCE_DB,
      "--verify-dump",
      path.join(os.tmpdir(), "chaoge-does-not-exist.dump"),
    ]);
    assert.notEqual(code, 0);
    assert.match(out, /不存在/);
  });
}
