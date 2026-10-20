/**
 * PROD-2 / Step 5.8.1 · 私有 Staging 部署的守护测试
 *
 * 覆盖 `deploy/app/` 的全部脚本、systemd 单元、环境变量模板与 GitHub Actions workflow。
 *
 * ## 这些用例在守什么
 *
 * 部署配置的价值同样**不在于它能跑通，而在于它拒绝跑通什么**。
 * 这里最重要的断言都是负面的：
 *
 *   · 服务不得以 root 运行；
 *   · 监听地址不得离开回环；
 *   · 配置文件不得有机会改写 `HOSTNAME`；
 *   · CI 不得成为「构建时把生产口令写进日志」的通道；
 *   · 发布失败不得留下一台坏掉的服务（必须自动回滚）。
 *
 * 这些性质在代码里看起来都「显然」，但每一条都对应一种真实的部署事故：
 * 有人把 `HOSTNAME` 挪进 `.env`、有人给 unit 加了 `User=root` 图省事、
 * 有人在 workflow 里 echo 一下 `DATABASE_URL` 排查问题。
 * 一旦发生，测试会先变红，而不是等到公网上出现一个 Mock 登录页。
 *
 * ## 运行方式
 *
 *     pnpm test
 *
 * 全部离线：不连数据库、不连服务器、不执行构建。
 * `bash -n` 语法检查在 Windows 上由 Git Bash 提供；没有 bash 时整组跳过。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(REPO_ROOT, "deploy", "app");
const TRUST_DIR = path.join(REPO_ROOT, "deploy", "trust");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "staging-build.yml");
const NEXT_CONFIG = path.join(REPO_ROOT, "next.config.ts");

const read = (file) => readFileSync(file, "utf8");

/**
 * manifest 的哈希按 LF 计算（见 deploy/trust/generate-manifests.sh）：
 * bundle 由 git blob 组成，永远是 LF；Windows 工作区检出的可能是 CRLF。
 */
function sha256LF(file) {
  const src = read(file).replace(/\r\n/g, "\n");
  return createHash("sha256").update(src, "utf8").digest("hex");
}

function parseManifest(file) {
  return read(file)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      assert.ok(match, `${path.basename(file)} 行格式不正确：${line}`);
      return { hash: match[1], path: match[2] };
    });
}

/**
 * 去掉以 `#` 开头的注释行。
 *
 * 理由与 `deployScripts.test.mjs` 相同：这些文件里的注释**大量引用反面写法**
 * （例如「不要写 HOSTNAME=」）。不剥注释时，一条解释性的注释会让
 * 「必须不存在某个字符串」的断言假阳性，而真正的代码问题反而被掩盖。
 */
function stripHashComments(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const FILES = {
  build: path.join(APP_DIR, "build-standalone.sh"),
  install: path.join(APP_DIR, "install-release.sh"),
  rollback: path.join(APP_DIR, "rollback.sh"),
  user: path.join(APP_DIR, "create-service-user.sh"),
  env: path.join(APP_DIR, "setup-staging-env.sh"),
  common: path.join(APP_DIR, "_common.sh"),
  health: path.join(APP_DIR, "healthcheck.sh"),
  unit: path.join(APP_DIR, "chaoge-staging.service"),
  envExample: path.join(APP_DIR, "staging.env.example"),
  readme: path.join(APP_DIR, "README.md"),
  finalize: path.join(APP_DIR, "finalize-staging.sh"),
  entry: path.join(REPO_ROOT, "deploy", "entry", "chaoge-deploy.sh"),
  installer: path.join(REPO_ROOT, "deploy", "entry", "install.sh"),
  bootstrap: path.join(TRUST_DIR, "bootstrap.sh"),
  generateManifests: path.join(TRUST_DIR, "generate-manifests.sh"),
  trustReadme: path.join(TRUST_DIR, "README.md"),
};

const raw = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));
const code = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, stripHashComments(v)]));
const workflowRaw = read(WORKFLOW);
const workflow = stripHashComments(workflowRaw);

// ── bash 探测 ─────────────────────────────────────────────────────────────────

function probeBash() {
  const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() === "ok";
}
const BASH_OK = probeBash();
const SKIP_NO_BASH = BASH_OK ? false : "需要 bash（Windows 上由 Git Bash 提供）";

// ── 1. next.config.ts ─────────────────────────────────────────────────────────

test("next.config.ts 启用 standalone 输出", () => {
  const src = read(NEXT_CONFIG);
  assert.match(
    src,
    /output:\s*["']standalone["']/,
    "私有 Staging 的产物依赖 output: 'standalone'；缺了它服务器上就没有 server.js",
  );
});

test("pnpm 使用 hoisted 布局（standalone 产物可移植的前提）", () => {
  // 隔离布局下 Next 会把构建机绝对路径的符号链接复制进产物，离开构建机即断链。
  const ws = read(path.join(REPO_ROOT, "pnpm-workspace.yaml"));
  assert.match(ws, /^nodeLinker:\s*hoisted$/m);
});

// ── 2. 构建脚本 ───────────────────────────────────────────────────────────────

test("构建脚本显式拷贝 public 与 .next/static", () => {
  // Next 的 standalone 输出**不含**这两份；漏拷时页面 200 但资源全 404。
  assert.match(code.build, /cp\s+-R\s+"\$ROOT\/public"\s+"\$SA\/public"/);
  assert.match(code.build, /cp\s+-R\s+"\$ROOT\/\.next\/static"\s+"\$SA\/\.next\/static"/);
  assert.match(code.build, /rm\s+-rf\s+"\$SA\/public"/, "必须先删再拷，避免 stale asset 被打进新产物");
});

test("构建脚本拒绝 HEAD 与 EXPECTED_SHA 不一致", () => {
  assert.match(code.build, /HEAD_SHA.*git rev-parse HEAD|git rev-parse HEAD/);
  assert.match(code.build, /HEAD_SHA.*!=.*EXPECTED_SHA|"\$HEAD_SHA"\s*!=\s*"\$EXPECTED_SHA"/);
  assert.match(code.build, /拒绝构建/);
});

test("构建脚本删除并拒绝 .env 进入产物", () => {
  // Next 的 standalone 会把仓库根的 .env 原样复制进来。删除之后必须再断言一次，
  // 否则打包失败只会发生在服务器上，而且错误信息还看不出是哪来的文件。
  assert.match(code.build, /find "\$SA" \\\( -name '\.env' -o -name '\.env\.\*' \\\) -print0/);
  assert.match(code.build, /rm -f "\$f"/);
  assert.match(code.build, /拒绝打包/);
});

test("构建脚本把绝对符号链接改写为产物内相对链接", () => {
  // hoisted 布局消除了 pnpm 链接，但 Next 仍会为服务端外部包生成
  // `.next/node_modules/pg-<hash> -> <构建机>/node_modules/pg`。
  // 不改写的话，产物在服务器上解包后这个链接悬空。
  assert.match(code.build, /find "\$SA" -type l -print0/);
  assert.match(code.build, /realpath --relative-to/);
  assert.match(code.build, /rm -f "\$link"/);
  assert.match(code.build, /ln -s "\$rel" "\$link"/);
  assert.match(code.build, /绝对符号链接，离开构建机后会失效/);

  // 不能改成「解引用成真实目录」：那样会丢掉 pnpm 的虚拟存储，
  // next 的传递依赖（@swc/helpers 等）仍然解析不到。
  assert.doesNotMatch(code.build, /tar -czhf|tar --dereference|cp -aL/);
});

test("构建脚本要求产物含 server.js 与 node_modules", () => {
  assert.match(code.build, /\[\[ -f "\$SA\/server\.js" \]\]/);
  assert.match(code.build, /\[\[ -d "\$SA\/node_modules" \]\]/);
});

// ── 3. GitHub Actions workflow ───────────────────────────────────────────────

test("workflow 只允许手动触发，且必须提供 commit_sha", () => {
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /commit_sha:/);
  assert.match(workflow, /required:\s*true/);

  // 不允许被 push / pull_request 自动触发：产物必须对应一个人**选定**的提交。
  assert.doesNotMatch(workflow, /^\s*push:/m, "不应被 push 自动触发");
  assert.doesNotMatch(workflow, /^\s*pull_request:/m, "不应被 PR 自动触发");
  assert.doesNotMatch(workflow, /^\s*schedule:/m, "不应定时触发");
});

test("workflow 校验输入 SHA 并在检出后复核", () => {
  assert.match(workflow, /\[0-9a-f\]\{40\}|\[0-9a-f\]\{40\}/);
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.commit_sha\s*\}\}/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /检出的提交与请求不一致/);
});

test("workflow 不引用任何 secrets，也不把连接串写进环境", () => {
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./, "构建流程不应依赖任何仓库 secret");
  assert.doesNotMatch(workflow, /DATABASE_URL/, "构建期不需要数据库连接串");
  assert.doesNotMatch(workflow, /TEST_DATABASE_URL/);
});

test("workflow 固定 Node 24 与 pnpm 12.3.4，并上传产物", () => {
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /version:\s*12\.3\.4/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /if-no-files-found:\s*error/);
});

test("workflow 不在 CI 里跑破坏性数据库命令", () => {
  assert.doesNotMatch(workflow, /db:seed|db:reset|db:migrate/);
});

// ── 4. systemd 单元 ──────────────────────────────────────────────────────────

test("systemd 单元以非 root 账号运行", () => {
  assert.match(code.unit, /^User=chaoge$/m);
  assert.match(code.unit, /^Group=chaoge$/m);
  assert.doesNotMatch(code.unit, /^User=root$/m);
});

test("systemd 单元把绑定地址写死在 ExecStart 里", () => {
  const exec = code.unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert.ok(exec, "缺少 ExecStart");
  assert.match(exec, /HOSTNAME=127\.0\.0\.1/, "HOSTNAME 必须在 ExecStart 里，不能被 EnvironmentFile 覆盖");
  assert.match(exec, /PORT=3000/);
  assert.match(exec, /server\.js/);
  assert.match(exec, /NODE_ENV=production/);
});

test("systemd 单元的 Node 使用目标服务器上存在的绝对路径", () => {
  const exec = code.unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert.ok(exec, "缺少 ExecStart");
  // 裸 `node` 依赖 PATH；`/usr/bin/node` 在目标服务器上不存在。
  // 两者都只会表现为 systemd 的 status=1/FAILURE，所以在这里钉死。
  assert.match(exec, /\/usr\/local\/bin\/node server\.js$/, "Node 必须是 /usr/local/bin/node");
  assert.doesNotMatch(exec, /\/usr\/bin\/node\b/, "目标服务器上不存在 /usr/bin/node");
});

test("systemd 单元实现开机自启与异常重启", () => {
  assert.match(code.unit, /^Restart=always$/m);
  assert.match(code.unit, /^RestartSec=5$/m);
  assert.match(code.unit, /^WantedBy=multi-user\.target$/m);
});

test("systemd 单元读取受限的环境变量文件", () => {
  assert.match(code.unit, /^EnvironmentFile=\/etc\/chaoge\/staging\.env$/m);
  assert.doesNotMatch(code.unit, /^EnvironmentFile=-/m, "配置文件缺失时必须拒绝启动，而不是静默跳过");
});

test("systemd 单元不启用会杀死 Node 的加固项", () => {
  // V8 的 JIT 需要可写可执行内存；打开它 Node 直接起不来，日志里只有 status=1/FAILURE。
  assert.doesNotMatch(code.unit, /^MemoryDenyWriteExecute=true$/m);
});

// ── 5. 环境变量文件 ─────────────────────────────────────────────────────────

test("env 模板包含三项必需配置，且不含绑定地址", () => {
  const active = stripHashComments(raw.envExample).split("\n").filter((l) => l.trim());
  assert.ok(active.includes("NODE_ENV=production"));
  assert.ok(active.includes("DATA_SOURCE=postgres"));
  assert.ok(active.some((l) => l.startsWith("DATABASE_URL=postgresql://")));

  // HOSTNAME / PORT 必须由 systemd 单元负责：EnvironmentFile 会覆盖 Environment=，
  // 配置文件一旦能写它们，就等于把「回环绑定」这条安全边界交给了配置文件。
  assert.ok(!active.some((l) => /^(HOSTNAME|PORT)=/.test(l)));
});

test("env 模板里没有真实口令，只有占位符", () => {
  const url = raw.envExample.match(/^DATABASE_URL=(.+)$/m)?.[1] ?? "";
  assert.match(url, /<URL-encoded-password>/, "模板只能放占位符");
  assert.doesNotMatch(raw.envExample, /BEGIN [A-Z ]*PRIVATE KEY/);
});

test("env 模板不开启 ENABLE_MOCK_DEBUG", () => {
  const active = stripHashComments(raw.envExample).split("\n").filter((l) => l.trim());
  assert.ok(
    !active.some((l) => /^ENABLE_MOCK_DEBUG=true$/.test(l)),
    "ENABLE_MOCK_DEBUG 会开放破坏性的 POST /api/debug/reset，staging 不需要它",
  );
});

test("env 生成脚本拒绝 postgres、迁移角色与生产应用角色", () => {
  // 默认值本身必须是 staging 的独立账号。
  assert.match(code.env, /^DB_NAME="chaoge_staging"$/m);
  assert.match(code.env, /^DB_ROLE="chaoge_staging_app"$/m);

  // postgres / 迁移角色一律拒绝。
  assert.match(code.env, /postgres\)\s+die/);
  assert.match(code.env, /chaoge_migrator\|chaoge_staging_migrator\)\s+die/);

  // Step 5.8.2 的核心：不得复用生产的 chaoge_app 连接串。
  assert.match(code.env, /chaoge_app\)\s+die/);
  assert.match(code.env, /不得复用生产应用角色 chaoge_app/);
  assert.match(code.env, /chaoge_staging_app/);

  // 库名守卫同样在参数解析阶段生效。
  assert.match(code.env, /DB_NAME" == "chaoge_prod"/);
  assert.match(code.env, /\^chaoge_staging\(_\[a-z0-9\]\+\)\*\$/);
});

test("env 生成脚本写入前试连并核对角色/库名/非超级用户", () => {
  // 一个指向错误库的 0640 文件一旦落盘，下一次重启就会用它。
  // 试连必须发生在写入之前，且必须核对 current_user / current_database / rolsuper。
  assert.match(code.env, /PGPASSFILE="\$PGPASS_TMP"/);
  assert.match(code.env, /current_user \|\| '\|' \|\| current_database\(\)/);
  assert.match(code.env, /"\$DB_ROLE\|\$DB_NAME\|false"/);
  assert.match(code.env, /chmod 600 "\$PGPASS_TMP"/);
  assert.match(code.env, /rm -f "\$PGPASS_TMP"/);

  // 口令仍然不能来自环境变量或命令行参数。
  assert.doesNotMatch(code.env, /PGPASSWORD/);
});

test("env 模板指向独立 staging 库与独立应用角色", () => {
  const url = raw.envExample.match(/^DATABASE_URL=(.+)$/m)?.[1] ?? "";
  assert.match(url, /chaoge_staging_app/, "模板必须使用 staging 独立应用角色");
  assert.match(url, /\/chaoge_staging(?:[?\s]|$)/, "模板必须指向 chaoge_staging 库");
  assert.doesNotMatch(url, /chaoge_app:|chaoge_prod/, "模板不得指向生产角色或生产库");
  assert.match(stripHashComments(raw.envExample), /^PG_POOL_MAX=5$/m);
});

test("发布脚本在解包前校验 staging 数据源隔离", () => {
  assert.match(code.install, /URL_ROLE/);
  assert.match(code.install, /chaoge_staging_app/);
  assert.match(code.install, /URL_DB.*\^chaoge_staging/);
  assert.match(code.install, /生产角色 chaoge_app 与迁移角色在此一律拒绝/);
  assert.match(code.install, /只允许回环地址/);
  assert.match(code.install, /staging 只允许 chaoge_staging\*/);
});

test("env 生成脚本用 mktemp + 0600 + 原子 mv 写入", () => {
  assert.match(code.env, /mktemp "\$ENV_DIR\/\.staging\.env\.XXXXXX"/);
  assert.match(code.env, /chmod 600 "\$TMP"/);
  assert.match(code.env, /mv -f "\$TMP" "\$ENV_PATH"/);
  // 受控部署入口要求该文件 root:root 0600：只有 systemd（root）读取内容，
  // 运行账号通过注入的环境变量取值。组可读会让同机 deploy 直接拿到应用口令。
  assert.match(code.env, /chown root:root "\$TMP"/);
  assert.match(code.env, /\[\[ "\$ACT" == "root:root 600" \]\]/);
  assert.doesNotMatch(code.env, /chmod 640/);
  assert.doesNotMatch(code.env, /chown "root:\$SERVICE_GROUP"/);
});

test("env 生成脚本不接受命令行/环境变量传入口令", () => {
  assert.match(code.env, /read -rs RAW_PW/);
  // 口令不能来自 $1 或 $PGPASSWORD 之类：那会进 shell 历史或 /proc/PID/environ。
  assert.doesNotMatch(code.env, /RAW_PW=.*\$1/);
  assert.doesNotMatch(code.env, /PGPASSWORD/);
});

test("env 生成脚本写完后拒绝 HOSTNAME/PORT 与 MOCK_DEBUG", () => {
  assert.match(code.env, /grep -qE '\^\(HOSTNAME\|PORT\)='/);
  assert.match(code.env, /ENABLE_MOCK_DEBUG 未开启/);
});

// ── 6. 发布与回滚 ───────────────────────────────────────────────────────────

test("发布脚本用「版本目录 + 原子符号链接」而不是原地覆盖", () => {
  // 先建新目录、再切换链接；`mv -T` 保证切换是原子的。
  assert.match(code.install, /RELEASES="\$ROOT_DIR\/releases"/);
  assert.match(code.install, /ln -sfn "\$REL" "\$CURRENT\.tmp"/);
  assert.match(code.install, /mv -Tf "\$CURRENT\.tmp" "\$CURRENT"/);
});

test("发布脚本在健康检查或监听地址失败时自动回滚", () => {
  assert.match(code.install, /wait_healthy "\$PORT" 30 \|\| FAILED=1/);
  assert.match(code.install, /assert_loopback_only "\$PORT"/);
  assert.match(code.install, /新版本未通过验收，开始回滚/);
  assert.match(code.install, /ln -sfn "\$PREV" "\$CURRENT\.tmp"/);
  assert.match(code.install, /systemctl restart "\$SERVICE"/);
});

test("发布脚本校验产物 SHA 与必需文件", () => {
  assert.match(code.install, /BUILD_INFO/);
  assert.match(code.install, /\[0-9a-f\]\{40\}/);
  assert.match(code.install, /产物缺 \.\/server\.js/);
  assert.match(code.install, /产物缺 \.\/node_modules\//);
  assert.match(code.install, /产物缺 \.\/\.next\/static\//);
  assert.match(code.install, /产物缺 \.\/public\//);
});

test("发布脚本拒绝含 .env 的产物与非回环监听", () => {
  assert.match(code.install, /拒绝安装/);
  assert.match(code.common, /端口 \$port 监听在\*\*非回环\*\*地址上/);
  assert.match(code.common, /127\\\.0\\\.0\\\.1/);
});

test("发布脚本的 tar 结构检查不受 pipefail/SIGPIPE 误伤", () => {
  // `grep -q` 命中后立即退出，仍在输出的 tar 会收到 SIGPIPE（141）。
  // 脚本启用了 pipefail，`tar ... | grep -q` 因此会把「条目确实存在」
  // 误判为失败。用进程替换让 grep 的退出码与 tar 的 SIGPIPE 解耦。
  const offending = code.install
    .split("\n")
    .filter((line) => /tar\s+-t[^|]*\|\s*grep\s+-q/.test(line));
  assert.deepEqual(offending, [], "tar | grep -q 在 pipefail 下会误报缺失");
  assert.match(code.install, /grep -qxE '\\\.\/server\\\.js' < <\(tar -tzf "\$ARTIFACT"\)/);
  assert.match(code.install, /grep -qE '\^\\\.\/node_modules\/' < <\(tar -tzf "\$ARTIFACT"\)/);
  assert.match(code.install, /grep -qE '\(\^\|\/\)\\\.env\(\\\.\|\$\)' < <\(tar -tzf "\$ARTIFACT"\)/);
});

test("发布脚本在解包前断言单元里的 Node 存在且可执行", () => {
  assert.match(code.install, /UNIT_EXEC=.*systemctl cat "\$SERVICE"/);
  assert.match(code.install, /NODE_BIN/);
  assert.match(code.install, /\[\[ -x "\$NODE_BIN" \]\]/);

  const guardAt = code.install.indexOf('[[ -x "$NODE_BIN" ]]');
  const extractAt = code.install.indexOf('tar -xzf "$ARTIFACT" -C "$REL"');
  assert.ok(guardAt >= 0, "缺少 Node 存在性断言");
  assert.ok(extractAt > guardAt, "Node 校验必须早于解包");
});

test("回滚脚本只切换链接并重启，不重新构建", () => {
  assert.match(code.rollback, /mv -Tf "\$CURRENT\.tmp" "\$CURRENT"/);
  assert.match(code.rollback, /systemctl restart "\$SERVICE"/);
  assert.doesNotMatch(code.rollback, /pnpm build|next build/);
  assert.match(code.rollback, /assert_loopback_only "\$PORT"/);
});

test("服务器端脚本都不执行 next build（构建只在 CI/本地）", () => {
  for (const key of ["install", "rollback", "user", "env", "health", "finalize", "bootstrap"]) {
    assert.doesNotMatch(code[key], /next build|pnpm build/, `${key} 不应在服务器上构建`);
  }
});

// ── 7. 服务账号 ─────────────────────────────────────────────────────────────

test("服务账号是 nologin 系统账号，且拒绝提权组", () => {
  assert.match(code.user, /useradd --system --no-create-home/);
  assert.match(code.user, /--shell "\$NOLOGIN"/);
  assert.match(code.user, /sudo\|wheel\|adm/);
  assert.match(code.user, /运行时账号不能有 sudo/);
});

test("服务账号脚本不安装 sudoers 规则", () => {
  assert.doesNotMatch(code.user, /\/etc\/sudoers/);
  assert.doesNotMatch(raw.user, /visudo/);
});

// ── 8. 仓库卫生 ─────────────────────────────────────────────────────────────

test("deploy/app 下没有任何真实凭据", () => {
  for (const [name, src] of Object.entries(raw)) {
    assert.doesNotMatch(src, /BEGIN [A-Z ]*PRIVATE KEY/, `${name} 含私钥`);
    assert.doesNotMatch(
      src,
      /postgresql:\/\/chaoge_app:[^@<>$\s][^@\s]*@/,
      `${name} 里出现了疑似真实口令的连接串`,
    );
    assert.doesNotMatch(
      src,
      /postgresql:\/\/chaoge_staging_app:[^@<>$\s][^@\s]*@/,
      `${name} 里出现了疑似真实 staging 口令的连接串`,
    );
  }
});

test("README 记录了独立 staging 库与最小数据准备方式", () => {
  // 迁移只建结构、不插数据；mock 登录查不到用户会 404。
  // Step 5.8.2 的答案是独立库 + 06 bootstrap，而不是 db:seed。
  assert.match(raw.readme, /chaoge_staging/);
  assert.match(raw.readme, /06-bootstrap-data\.sql/);
  assert.match(raw.readme, /db:seed/);
  assert.match(raw.readme, /chaoge_staging_app/);
});

// ── 9. 信任快照与 root 收尾（PROD-2 安全整改）────────────────────────────────

test("finalizer 钉死 CI 产物 SHA 与 BUILD_INFO SHA，并与部署脚本版本区分", () => {
  assert.match(code.finalize, /^APP_GIT_SHA="8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07"$/m);
  assert.match(
    code.finalize,
    /^ARTIFACT_SHA256_EXPECTED="f10700772c6bab7fc75a438dba82a2e0de5cbcc6d5348a5106f0b59ae646fd5c"$/m,
  );
  assert.match(code.finalize, /^FINALIZER_VERSION="prod2-finalize-v2"$/m);
  assert.match(code.finalize, /BUILD_INFO 的 Git SHA 与预期不一致/);
  assert.match(code.finalize, /部署脚本版本与 CI 产物版本是两个不同的 SHA/);
  // 产物必须同时经 --sha256 与 --expected-sha 安装。
  assert.match(code.finalize, /--sha256 "\$ARTIFACT_SHA256_EXPECTED"/);
  assert.match(code.finalize, /--expected-sha "\$APP_GIT_SHA"/);
});

test("finalizer 只执行 root 信任目录里的脚本", () => {
  assert.match(code.finalize, /^TRUST_DIR="\/opt\/chaoge-deploy-trust"$/m);
  assert.match(code.finalize, /TRUST_DIR" == "\/opt\/chaoge-deploy-trust"/);
  assert.match(code.finalize, /deploy\/trust\/deploy-files\.sha256/);
  assert.match(code.finalize, /deploy\/trust\/migration-code\.sha256/);
  assert.match(code.finalize, /sha256sum -c --quiet deploy\/trust\/deploy-files\.sha256/);
  assert.match(code.finalize, /信任目录中仍有组\/其他用户可写的路径/);
  // finalizer 的权限断言只检查真实文件/目录，符号链接不参与（同 bootstrap 修复）。
  assert.match(code.finalize, /\\\( -type f -o -type d \\\)/);
  assert.match(code.finalize, /deploy_script deploy\/db\/staging\/deploy-staging\.sh/);

  // 不允许回落到 /home/deploy 下的脚本或 pnpm/corepack 缓存。
  assert.doesNotMatch(code.finalize, /\/home\/deploy/);
  assert.doesNotMatch(code.finalize, /\bpnpm\b/);
  assert.doesNotMatch(code.finalize, /corepack/);
});

test("finalizer 把产物复制到 root 临时文件后才校验（消除 TOCTOU）", () => {
  assert.match(code.finalize, /mktemp --suffix=\.tar\.gz \/var\/tmp\/prod2-artifact\.XXXXXX/);
  assert.match(code.finalize, /install -o root -g root -m 0600 -- "\$ART" "\$ART_TMP"/);
  assert.match(code.finalize, /ART="\$ART_TMP"/);

  const copyAt = code.finalize.indexOf('install -o root -g root -m 0600 -- "$ART" "$ART_TMP"');
  const hashAt = code.finalize.indexOf('ACTUAL_SHA256="$(sha256sum "$ART"');
  assert.ok(copyAt >= 0 && hashAt > copyAt, "哈希必须在 root 拥有的副本上计算");
  assert.match(code.finalize, /产物包含不安全的 tar 条目/);
});

test("finalizer 以 deploy 身份执行迁移，root 不执行迁移代码", () => {
  assert.match(code.finalize, /^MIGRATE_USER="deploy"$/m);
  assert.match(code.finalize, /CHAOGE_APP_DIR="\$TRUST_DIR\/src"/);
  assert.match(code.finalize, /CHAOGE_MIGRATE_AS="\$MIGRATE_USER"/);
  assert.match(code.finalize, /CHAOGE_NODE_BIN="\$NODE_BIN"/);
  assert.match(code.finalize, /--migrator-url-fd 9/);
  assert.match(code.finalize, /exec 9< <\(printf '%s\\n' "\$MIG_URL"\)/);
  assert.match(code.finalize, /unset MIG_URL/);
  // 连接串走 fd，不能进 argv 或子进程环境变量列表。
  assert.doesNotMatch(code.finalize, /DATABASE_URL="\$MIG_URL"/);

  // 迁移前必须用同一个口令做真实 TCP 认证预检，且预检发生在启动迁移之前。
  assert.match(code.finalize, /PGPASSWORD="\$MIG_PW"/);
  assert.match(code.finalize, /psql -w -h "\$DB_HOST"/);
  assert.match(code.finalize, /-Atqc 'SELECT 1'/);
  assert.match(code.finalize, /migrator 口令已通过 \$DB_HOST TCP 认证预检/);
  const preflightAt = code.finalize.indexOf('PGPASSWORD="$MIG_PW"');
  const migrateAt = code.finalize.indexOf(
    "deploy_script deploy/db/staging/deploy-staging.sh migrate",
  );
  assert.ok(preflightAt >= 0 && migrateAt > preflightAt, "认证预检必须在迁移之前");
});

test("finalizer 用到的输出函数全部有定义", () => {
  // `set -e` 下调用未定义函数会以 127 立即中止；曾因漏定义 warn() 停在步骤 7。
  for (const fn of ["die", "ok", "info", "warn", "step"]) {
    assert.match(code.finalize, new RegExp(`^${fn}\\(\\)`, "m"), `finalizer 缺少 ${fn}()`);
  }
});

test("口令步骤在重跑时仍可重设，且能识别 Passwords didn't match", () => {
  // 不能因为「口令非空」就跳过 psql：旧口令会保留，步骤 8 输入的新口令必然失败。
  assert.doesNotMatch(code.finalize, /两个口令均已设置，跳过/);
  assert.match(code.finalize, /sudo -u postgres psql -d "\$DB_NAME"/);
  assert.match(code.finalize, /Passwords didn't match/);
  assert.match(code.finalize, /确认可用就直接输入/);
  // role_pw_set 只做存在性检查，不能作为认证凭据。
  assert.match(code.finalize, /rolpassword IS NOT NULL/);
});

test("finalizer 的日志在 root 控制的目录里", () => {
  assert.match(code.finalize, /^LOG_DIR="\/var\/log\/chaoge"$/m);
  assert.match(code.finalize, /^LOG="\$LOG_DIR\/prod2-finalize\.log"$/m);
  assert.match(code.finalize, /chmod 0750 "\$LOG_DIR"/);
  assert.match(code.finalize, /chmod 0640 "\$LOG"/);
  assert.match(code.finalize, /\[\[ -L "\$LOG" \]\] && die/);
  assert.match(code.finalize, /tee -a "\$LOG"/);
  assert.doesNotMatch(code.finalize, /\/home\/deploy\/prod2-finalize\.log/);
});

test("finalizer 用 mktemp 做回滚演练并在退出时清理", () => {
  assert.match(code.finalize, /DRILL_DIR="\$\(mktemp -d\)"/);
  assert.match(code.finalize, /DRILL_ART="\$\(mktemp --suffix=\.tar\.gz \/var\/tmp\/prod2-drill\.XXXXXX\)"/);
  assert.match(code.finalize, /trap cleanup EXIT/);
  assert.match(code.finalize, /rm -rf -- "\$DRILL_DIR"/);
  assert.match(code.finalize, /rm -f -- "\$DRILL_ART"/);
  assert.match(code.finalize, /回滚演练失败：坏产物居然通过了健康检查/);
});

test("bootstrap 构建 root:root 快照并拒绝路径/符号链接逃逸", () => {
  assert.match(code.bootstrap, /\[\[ "\$\(id -u\)" == "0" \]\]/);
  assert.match(code.bootstrap, /^TRUST_DIR="\/opt\/chaoge-deploy-trust"$/m);
  assert.match(code.bootstrap, /sha256sum -c --quiet deploy\/trust\/deploy-files\.sha256/);
  assert.match(code.bootstrap, /deploy\/trust\/migration-code\.sha256/);
  assert.match(code.bootstrap, /mktemp -d \/opt\/\.chaoge-deploy-trust\.XXXXXX/);
  assert.match(code.bootstrap, /install -D -o root -g root -m 0644/);
  assert.match(code.bootstrap, /manifest 包含不安全的路径/);
  assert.match(code.bootstrap, /node_modules 符号链接逃逸出快照/);
  assert.match(code.bootstrap, /node_modules 里存在绝对符号链接/);
  assert.match(code.bootstrap, /chown -R root:root "\$NEW"/);
  assert.match(code.bootstrap, /chmod -R a\+rX,go-w "\$NEW"/);
  assert.match(code.bootstrap, /-perm -4000 -o -perm -2000.*-exec chmod u-s,g-s/);
  assert.match(code.bootstrap, /快照里仍存在 setuid\/setgid 文件/);
  assert.match(code.bootstrap, /runuser -u "\$MIGRATE_USER"/);
  assert.match(code.bootstrap, /bash "\$TRUST_DIR\/deploy\/app\/finalize-staging\.sh"/);
  // 权限断言必须排除符号链接：Linux 上链接 lstat 恒为 0777，否则
  // node_modules/.bin 的 23 个相对链接会被误判为「组/其他可写」。
  assert.match(code.bootstrap, /find "\$TRUST_DIR" -xdev ! -type l/);
  assert.match(code.bootstrap, /-perm -0020 -o -perm -0002/);
  assert.match(code.bootstrap, /信任目录中存在组\/其他用户可写的路径/);
  assert.doesNotMatch(
    code.bootstrap,
    /find "\$TRUST_DIR" -xdev \\\( -perm -0020/,
    "回归：权限断言不得重新包含符号链接",
  );
});

test(
  "信任目录权限断言只标记真实文件/目录，不误报符号链接",
  { skip: process.platform !== "linux" && "find 对符号链接的 lstat 权限语义仅在 Linux 上可复现" },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chaoge-trust-perm-"));
    try {
      const real = path.join(dir, "group-writable.txt");
      writeFileSync(real, "x");
      chmodSync(real, 0o666);
      symlinkSync("group-writable.txt", path.join(dir, "link"));

      const runFind = (expr) =>
        spawnSync("bash", ["-c", `find "$1" -xdev ${expr} -print`, "bash", dir], {
          encoding: "utf8",
        });

      // 修复后的表达式：只有真实文件被标记。
      const fixed = runFind("! -type l \\( -perm -0020 -o -perm -0002 \\)");
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.equal(fixed.stdout.trim(), real);

      // 旧表达式会把符号链接也标记 —— 这正是 Staging 首次执行失败的原因。
      const old = runFind("\\( -perm -0020 -o -perm -0002 \\)");
      assert.equal(old.status, 0, old.stderr);
      assert.match(old.stdout, /\/link$/m, "旧写法应能复现符号链接误报");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("部署文件 manifest 覆盖全部部署脚本且哈希与工作区一致", () => {
  const manifest = parseManifest(path.join(TRUST_DIR, "deploy-files.sha256"));
  const listed = new Map(manifest.map((entry) => [entry.path, entry.hash]));
  const findSh = spawnSync("bash", ["-c",
    "find deploy -type f -name '*.sh' -print"], { cwd: REPO_ROOT, encoding: "utf8" });
  const shellFiles = findSh.stdout
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p !== "deploy/trust/generate-manifests.sh");

  for (const rel of shellFiles) {
    assert.ok(listed.has(rel), `deploy-files.sha256 缺少 ${rel}`);
  }
  assert.ok(listed.has("deploy/app/chaoge-staging.service"));
  assert.ok(!listed.has("deploy/trust/deploy-files.sha256"), "manifest 不能包含自己");
  assert.ok(!listed.has("deploy/trust/generate-manifests.sh"), "生成器不进入服务器信任目录");

  for (const { hash, path: rel } of manifest) {
    assert.ok(rel.startsWith("deploy/"), `manifest 路径必须在 deploy/ 下：${rel}`);
    assert.equal(sha256LF(path.join(REPO_ROOT, rel)), hash, `${rel} 的哈希与 manifest 不一致`);
  }
});

test("迁移代码 manifest 只覆盖可执行迁移所需的源码，且哈希一致", () => {
  const manifest = parseManifest(path.join(TRUST_DIR, "migration-code.sha256"));
  const listed = new Set(manifest.map((entry) => entry.path));
  const allowed = (p) =>
    p === "package.json" ||
    p === "tests/alias-hook.mjs" ||
    p === "tests/alias-loader.mjs" ||
    p.startsWith("lib/") ||
    p.startsWith("db/migrations/");

  assert.ok(listed.has("package.json"));
  assert.ok(listed.has("tests/alias-hook.mjs"));
  assert.ok(listed.has("tests/alias-loader.mjs"));
  assert.ok(listed.has("lib/data/pg/cli.ts"));
  assert.ok([...listed].some((p) => /^db\/migrations\/\d{4}_.+\.sql$/.test(p)));
  assert.ok(manifest.length > 300, `迁移源码数量异常：${manifest.length}`);

  for (const { hash, path: rel } of manifest) {
    assert.ok(allowed(rel), `迁移 manifest 出现不该部署的文件：${rel}`);
    assert.equal(sha256LF(path.join(REPO_ROOT, rel)), hash, `${rel} 的哈希与 manifest 不一致`);
  }
});

test("三个组件钉死的 APP_GIT_SHA 完全一致", () => {
  const shaOf = (src) => /^APP_GIT_SHA="([0-9a-f]{40})"$/m.exec(src)?.[1];
  const expected = "8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07";
  assert.equal(shaOf(code.finalize), expected);
  assert.equal(shaOf(code.bootstrap), expected);
  assert.match(code.generateManifests, /8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07/);
});

test("信任流程不修改 sudoers / SSH / 防火墙，也不扩大权限", () => {
  for (const key of ["finalize", "bootstrap", "generateManifests"]) {
    assert.doesNotMatch(code[key], /chmod 777|chmod -R 777/, `${key} 不得放开权限`);
    assert.doesNotMatch(code[key], /NOPASSWD/, `${key} 不得修改 sudo 免密`);
    assert.doesNotMatch(code[key], /\/etc\/sudoers|visudo/, `${key} 不得触碰 sudoers`);
    assert.doesNotMatch(code[key], /sshd_config|ufw\b|iptables|firewall-cmd/, `${key} 不得修改 SSH/防火墙`);
  }
});

test("systemd 单元的文档路径指向受控入口安装的固定库", () => {
  assert.match(code.unit, /^Documentation=file:\/\/\/usr\/local\/lib\/chaoge\/app\/README\.md$/m);
  assert.doesNotMatch(code.unit, /\/opt\/chaoge-deploy\//);
});

test("README 记录受控入口、版本区分与 Secure Cookie 限制", () => {
  assert.match(code.readme, /\/usr\/local\/sbin\/chaoge-deploy/);
  assert.match(code.readme, /\/usr\/local\/lib\/chaoge/);
  assert.match(code.readme, /ARTIFACT_SHA256/);
  assert.match(code.readme, /BUILD_INFO/);
  assert.match(raw.readme, /Secure Cookie 限制/);
  assert.match(code.readme, /\/var\/log\/chaoge/);
  assert.match(code.trustReadme, /bundle SHA-256/);
  assert.match(code.trustReadme, /chaoge_prod/);
  assert.match(code.trustReadme, /deploy\/entry\/install\.sh/);
});

// ── 10. bash 语法 ────────────────────────────────────────────────────────────

test("全部 shell 脚本语法正确（bash -n）", { skip: SKIP_NO_BASH }, () => {
  for (const file of Object.values(FILES).filter((p) => p.endsWith(".sh"))) {
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${path.basename(file)} 语法错误：\n${r.stderr}`);
  }
});

test(
  "POSIX 下脚本具有执行位",
  { skip: process.platform === "win32" ? "Windows 不保留执行位" : false },
  () => {
    for (const file of Object.values(FILES).filter((p) => p.endsWith(".sh"))) {
      const mode = statSync(file).mode;
      assert.ok(mode & 0o111, `${path.basename(file)} 没有执行位`);
    }
  },
);
