/**
 * PROD-2 · 受控部署入口（chaoge-deploy）与一次性安装器的安全回归
 *
 * ## 这些用例在守什么
 *
 * 新的自动化部署模型把「root 权限」压缩成一个固定入口：
 *
 *     deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
 *
 * 这条 sudoers 规则意味着 deploy 用户可以随时让 root 执行**这个文件**。
 * 因此安全边界不在 sudoers 的花样，而在入口本身：
 *
 *   · 只接受四个子命令与固定参数个数；
 *   · 数据库名、服务名、路径、可执行文件全部写死；
 *   · 产物先复制到 root 私有目录，再校验 SHA-256 / Git SHA / 结构；
 *   · 产物代码不以 root 执行（迁移 deploy、应用 chaoge）；
 *   · 数据库口令只在 /etc/chaoge/staging.secrets（root:root 0600）。
 *
 * 任何一条被改松，deploy 到 root 的提权路径就会重新打开。这里既做静态断言，
 * 也用真实 tar 工件跑 `check-artifact`，确认拒绝的是「坏产物」而不是「所有人」。
 *
 * ## 运行方式
 *
 *     pnpm test
 *
 * 离线：不连数据库、不连服务器、不安装任何东西。
 * `check-artifact` 需要 bash 与可写的 /var/tmp（Linux CI 天然满足）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO_ROOT, "deploy", "entry", "chaoge-deploy.sh");
const INSTALLER = path.join(REPO_ROOT, "deploy", "entry", "install.sh");
const DB_SCRIPT = path.join(REPO_ROOT, "deploy", "db", "staging", "deploy-staging.sh");
const UNIT = path.join(REPO_ROOT, "deploy", "app", "chaoge-staging.service");

const read = (file) => readFileSync(file, "utf8");

/** 去掉整行注释：注释里大量引用反面写法（例如 sudoers 示例、chaoge_prod）。 */
function stripHashComments(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const rawEntry = read(ENTRY);
const entry = stripHashComments(rawEntry);
const rawInstaller = read(INSTALLER);
const installer = stripHashComments(rawInstaller);
const db = stripHashComments(read(DB_SCRIPT));
const unit = stripHashComments(read(UNIT));

function probeBash(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  return r.status === 0;
}
const BASH_OK = probeBash("echo ok");
const SKIP_NO_BASH = BASH_OK ? false : "需要 bash（Windows 上由 Git Bash 提供）";
const VAR_TMP_OK = BASH_OK && probeBash("test -d /var/tmp && test -w /var/tmp");
const SKIP_NO_VAR_TMP = VAR_TMP_OK ? false : "需要可写的 /var/tmp（check-artifact 的私有校验目录）";
const POSIX = process.platform !== "win32";
const SKIP_NOT_POSIX = POSIX ? false : "符号链接语义仅在 POSIX 上可复现";

// ── 1. 固定目标：入口只认识 chaoge_staging / chaoge-staging ─────────────────

test("入口把数据库、角色、服务、目录与 Node 路径全部写死", () => {
  const pins = {
    DB_NAME: "chaoge_staging",
    DB_HOST: "127.0.0.1",
    DB_PORT: "5432",
    MIGRATOR_ROLE: "chaoge_staging_migrator",
    APP_ROLE: "chaoge_staging_app",
    SERVICE: "chaoge-staging",
    SERVICE_USER: "chaoge",
    MIGRATE_USER: "deploy",
    NODE_BIN: "/usr/local/bin/node",
    ROOT_DIR: "/opt/chaoge-staging",
    CONF_DIR: "/etc/chaoge",
    ENTRY_PATH: "/usr/local/sbin/chaoge-deploy",
    LIB_DIR: "/usr/local/lib/chaoge",
  };
  for (const [name, value] of Object.entries(pins)) {
    assert.match(entry, new RegExp(`^${name}="${value}"$`, "m"), `${name} 必须钉死为 ${value}`);
  }

  // 生产库与生产角色在受控入口里一个都不出现。
  assert.doesNotMatch(entry, /chaoge_prod/, "受控入口不得出现生产库");
  assert.doesNotMatch(entry, /\bchaoge_app\b/, "受控入口不得出现生产应用角色");
  assert.doesNotMatch(entry, /\bchaoge_migrator\b/, "受控入口不得出现生产迁移角色");
});

test("入口只接受四个子命令，且参数个数严格匹配", () => {
  assert.match(entry, /deploy\)\s*\n\s*\[\[ \$# -eq 4 \]\]/);
  assert.match(entry, /rollback\)\s*\n\s*\[\[ \$# -eq 1 \]\]/);
  assert.match(entry, /status\)\s*\n\s*\[\[ \$# -eq 1 \]\]/);
  assert.match(entry, /check-artifact\)\s*\n\s*\[\[ \$# -eq 4 \]\]/);
  assert.match(entry, /未知子命令/);
  // 不接受 --database / --service / --path 这类调用者可控目标。
  assert.doesNotMatch(entry, /--database\)|--service\)|--release-id\)|--path\)/);
});

test("入口不执行任意 shell，也不 source 调用者提供的文件", () => {
  for (const src of [entry, installer]) {
    assert.doesNotMatch(src, /\beval\b/, "不得使用 eval");
    assert.doesNotMatch(src, /\b(?:sh|bash)\s+-c\b/, "不得把字符串交给 shell -c");
    assert.doesNotMatch(src, /\bsource\s+"?\$/, "不得 source 调用者可控路径");
    assert.doesNotMatch(src, /\bexec\s+"?\$/, "不得 exec 调用者可控路径");
  }
  // 入口自身由 shebang 启动，内部只调用固定路径的脚本。
  assert.match(entry, /bash "\$LIB_DIR\/db\/deploy-staging\.sh" migrate/);
  assert.match(entry, /bash "\$LIB_DIR\/app\/install-release\.sh"/);
  assert.match(entry, /bash "\$LIB_DIR\/app\/rollback\.sh"/);
});

test("deploy / rollback / status 都强制 root；check-artifact 只读且不需要 root", () => {
  assert.match(entry, /^require_root\(\)/m);
  for (const cmd of ["cmd_deploy", "cmd_rollback", "cmd_status"]) {
    const body = entry.slice(entry.indexOf(`${cmd}() {`));
    assert.match(body.slice(0, 300), /require_root/, `${cmd} 必须 require_root`);
  }
  const check = entry.slice(entry.indexOf("cmd_check_artifact() {"));
  assert.doesNotMatch(check.slice(0, 300), /require_root/, "check-artifact 只读，不应要求 root");
});

// ── 2. 产物校验与 TOCTOU ────────────────────────────────────────────────────

test("入口先复制到 root 私有目录，再对副本做哈希与结构校验", () => {
  assert.match(entry, /mktemp -d \/var\/tmp\/chaoge-deploy\.XXXXXXXX/);
  assert.match(entry, /chmod 0700 "\$PRIV_DIR"/);
  assert.match(entry, /\[\[ "\$\(stat -c '%u:%a' "\$PRIV_DIR"\)" == "0:700" \]\]/);
  assert.match(entry, /install -o root -g root -m 0600 -- "\$\(readlink -f -- "\$art_in"\)" "\$copy_at"/);
  assert.match(entry, /\[\[ "\$\(stat -c '%u:%g %a' "\$copy_at"\)" == "0:0 600" \]\]/);

  const copyAt = entry.indexOf('copy_at="$PRIV_DIR/artifact.tar.gz"');
  const validateAt = entry.indexOf('validate_artifact_file "$copy_at"');
  assert.ok(copyAt >= 0 && validateAt > copyAt, "必须先复制、后校验私有副本");
  assert.doesNotMatch(
    entry,
    /validate_artifact_file "\$art_in"/,
    "不得直接校验调用者可写的原始路径（TOCTOU）",
  );
});

test("入口校验 SHA-256、Git SHA、结构与文件名绑定", () => {
  assert.match(entry, /validate_hex64 "\$expected_sha"/);
  assert.match(entry, /validate_hex40 "\$expected_git"/);
  assert.match(entry, /\[\[ "\$actual_sha" == "\$expected_sha" \]\]/);
  assert.match(entry, /产物 SHA-256 不匹配/);
  assert.match(entry, /BUILD_INFO 的 Git SHA 与预期不一致/);
  assert.match(entry, /staging-standalone-\(\[0-9a-f\]\{40\}\)\\\.tar\\\.gz/);
  assert.match(entry, /文件名里的 Git SHA 与参数不一致/);

  const required = [
    [/grep -qxE '\\\.\/server\\\.js'/, "./server.js"],
    [/grep -qxE '\\\.\/BUILD_INFO'/, "./BUILD_INFO"],
    [/grep -qE  '\^\\\.\/node_modules\//, "./node_modules/"],
    [/grep -qE  '\^\\\.\/\\\.next\/static\//, "./.next/static/"],
    [/grep -qE  '\^\\\.\/public\//, "./public/"],
  ];
  for (const [pattern, label] of required) {
    assert.match(entry, pattern, `结构校验缺少 ${label}`);
  }
  assert.match(entry, /产物里出现了 \.env 文件/);
});

test("产物路径策略：绝对路径、上传目录、非链接、属主、大小", () => {
  assert.match(entry, /\[\[ "\$path" == \/\* \]\]/, "必须是绝对路径");
  assert.match(entry, /\[\[ "\$path" == "\$INCOMING_DIR"\/\* \]\]/, "必须位于上传目录");
  assert.match(entry, /require_regular_file "\$path" "产物"/, "产物不能是符号链接");
  assert.match(entry, /readlink -f -- "\$path"/);
  assert.match(entry, /产物路径解析后逃逸出 \$INCOMING_DIR/);
  assert.match(entry, /\[\[ "\$owner" == "0" \|\| "\$owner" == "\$deploy_uid" \]\]/);
  assert.match(entry, /MAX_ARTIFACT_BYTES=/);
  assert.match(entry, /\[\[ "\$canon" == "\$INCOMING_DIR"\/\* \]\]/);
});

test("tar 条目守卫允许安全相对链接，拒绝越界链接与危险类型", () => {
  assert.match(entry, /type != "-" && type != "d" && type != "l"/);
  assert.match(entry, /link_target_safe/);
  assert.ok(entry.includes("target ~ /^\\//"), "符号链接目标必须拒绝绝对路径");
  assert.match(entry, /setuid\/setgid/);
  assert.match(entry, /硬链接、设备、FIFO 或 setuid\/setgid/);

  // 发布脚本要有同样的守卫，并在解包后复核真实链接。
  const installRelease = stripHashComments(
    read(path.join(REPO_ROOT, "deploy", "app", "install-release.sh")),
  );
  assert.match(installRelease, /type != "-" && type != "d" && type != "l"/);
  assert.match(installRelease, /realpath -m -- "\$\(dirname "\$link"\)\/\$tgt"/);
  assert.match(installRelease, /符号链接解析后逃出版本目录/);
  assert.match(installRelease, /悬空符号链接/);
  assert.match(installRelease, /--no-same-owner --no-same-permissions/);
});

// ── 3. 凭据与特权分离 ───────────────────────────────────────────────────────

test("凭据文件 root:root 0600，口令只从文件读取且不进入 argv/日志", () => {
  assert.match(entry, /SECRETS="\$CONF_DIR\/staging\.secrets"/);
  assert.match(entry, /assert_root_file_mode "\$SECRETS" "0:0 600"/);
  assert.match(entry, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(entry, /read_secret MIGRATOR_PASSWORD/);
  assert.doesNotMatch(entry, /MIGRATOR_PASSWORD=[0-9a-f]/);
  assert.doesNotMatch(entry, /APP_PASSWORD=/);

  // migrator 连接串经匿名 fd 传递，不写文件、不进 argv。
  assert.match(entry, /exec 9< <\(printf '%s\\n' "\$mig_url"\)/);
  assert.match(entry, /unset mig_url/);
  assert.match(entry, /--migrator-url-fd 9/);
  assert.doesNotMatch(entry, /DATABASE_URL="\$mig_url"/);
});

test("迁移代码来自 root 安装的快照，而不是 deploy 可替换的产物", () => {
  assert.match(entry, /CHAOGE_APP_DIR="\$LIB_DIR\/src"/);
  assert.match(entry, /迁移代码快照不存在或是符号链接/);
  assert.match(entry, /迁移代码快照中存在组\/其他用户可写的路径/);
  assert.match(entry, /CHAOGE_MIGRATE_AS="\$MIGRATE_USER"/);
  assert.match(entry, /CHAOGE_NODE_BIN="\$NODE_BIN"/);
  // 不在 deploy 产物里找迁移代码，也不在入口里解包迁移目录。
  assert.doesNotMatch(entry, /chaoge-migrate\.XXXXXXXX/);
  assert.doesNotMatch(entry, /MIG_DIR=.*mktemp/);
});

test("应用由独立账号运行，root 不执行产物代码", () => {
  assert.match(unit, /^User=chaoge$/m);
  assert.match(unit, /^Group=chaoge$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  const exec = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.ok(exec);
  assert.match(exec, /HOSTNAME=127\.0\.0\.1/);
  assert.match(exec, /PORT=3000/);
  assert.doesNotMatch(exec, /0\.0\.0\.0/, "不得监听公网地址");
});

// ── 4. sudoers：唯一的一条固定命令 ──────────────────────────────────────────

test("安装器写入的 sudoers 规则只有一条，且命令部分没有通配符", () => {
  const match = installer.match(/cat > "\$TMP_SUDOERS" <<'EOS'\n([\s\S]*?)\nEOS/);
  assert.ok(match, "找不到 sudoers heredoc");
  const active = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(active, ["deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy"]);

  const command = active[0].split(":").slice(1).join(":").trim();
  assert.equal(command, "/usr/local/sbin/chaoge-deploy");
  assert.doesNotMatch(command, /[?*[\]]/, "命令路径不得含通配符");
  assert.doesNotMatch(active[0], /NOPASSWD:\s*ALL/);
  assert.doesNotMatch(active[0], /\(ALL(?::ALL)?\)/, "不得授予 ALL 身份");

  assert.match(installer, /visudo -cf "\$TMP_SUDOERS"/);
  assert.match(installer, /mv -f "\$TMP_SUDOERS" "\$SUDOERS_FILE"/);
  assert.match(installer, /\[\[ "\$\(stat -c '%u:%g %a' "\$SUDOERS_FILE"\)" == "0:0 440" \]\]/);
  assert.match(installer, /runuser -u "\$MIGRATE_USER" -- sudo -n "\$ENTRY_PATH" status/);
});

test("安装器不接收应用产物，root 不接触 deploy 可写的 tar", () => {
  assert.doesNotMatch(installer, /--artifact/);
  assert.doesNotMatch(installer, /tar -xzf/);
  assert.doesNotMatch(installer, /--sha256|--git-sha/);
  // 唯一需要 deploy 可写目录的地方是上传目录；安装器只创建它，不往里写文件。
  assert.match(installer, /\[\[ -L "\$INCOMING_DIR" \]\] && rm -f -- "\$INCOMING_DIR"/);
  assert.match(installer, /ensure_dir "\$INCOMING_DIR"/);
});

test("安装器目录创建拒绝符号链接（避免 root chown 到别处）", () => {
  assert.match(installer, /ensure_dir\(\)/);
  assert.match(installer, /\[\[ -d "\$dir" && ! -L "\$dir" \]\]/);
  assert.match(installer, /不是普通目录（可能是符号链接）/);
  assert.match(installer, /chown "\$owner" "\$dir"/);
});

// ── 5. 数据库口令与会话隔离 ─────────────────────────────────────────────────

test("安装器只向 PostgreSQL 发送 SCRAM 校验子，不发送明文", () => {
  assert.match(installer, /make_scram_verifier/);
  assert.match(installer, /pbkdf2Sync\(pw, salt, iterations, 32, "sha256"\)/);
  assert.match(installer, /SCRAM-SHA-256\$\$\{iterations\}/);
  assert.match(installer, /ALTER ROLE %s PASSWORD '%s'/);
  assert.match(installer, /MIG_VERIFIER/);
  assert.match(installer, /APP_VERIFIER/);
  assert.match(installer, /\\set VERBOSITY terse/);
  assert.match(installer, /log_statement=none/);
  assert.match(installer, /log_min_error_statement=panic/);
  assert.doesNotMatch(installer, /PASSWORD '\$MIG_PW'/);
  assert.doesNotMatch(installer, /PASSWORD '\$APP_PW'/);
  assert.doesNotMatch(installer, /PGPASSWORD=/);
});

test("无人值守迁移只允许 root + 精确 chaoge_staging", () => {
  assert.match(db, /NON_INTERACTIVE=1/);
  assert.match(db, /\[\[ "\$\(id -u\)" == "0" \]\]/);
  assert.match(db, /\[\[ "\$DB_NAME" == "chaoge_staging" \]\]/);
  assert.match(db, /--non-interactive 只允许目标库正好是 chaoge_staging/);
  assert.match(db, /CHAOGE_APP_DIR/);
  assert.match(db, /DATABASE_URL="\$url"/);
  assert.doesNotMatch(db, /echo[^\n]*\$url/);
});

// ── 6. 真实工件：check-artifact 的正反例 ────────────────────────────────────

const HEX64 = (i) => String(i).repeat(64).slice(0, 64);
const GIT = "a".repeat(40);

/**
 * GNU tar 会把带冒号的参数当成「远程归档主机」：
 * `tar -czf C:\Users\...` 会被解释为连接主机 C。Git Bash 里改用 /c/... 形式。
 */
function msysPath(p) {
  if (process.platform !== "win32") return p;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return match ? `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : p;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function buildTree(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "chaoge-art-"));
  const tree = path.join(dir, "tree");
  mkdirSync(path.join(tree, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(tree, ".next", "static"), { recursive: true });
  mkdirSync(path.join(tree, "public"), { recursive: true });
  writeFileSync(path.join(tree, "server.js"), "console.log('ok')\n");
  writeFileSync(path.join(tree, "node_modules", "pkg", "index.js"), "module.exports = {}\n");
  writeFileSync(path.join(tree, ".next", "static", "a.txt"), "x\n");
  writeFileSync(path.join(tree, "public", "favicon.ico"), "x\n");
  writeFileSync(path.join(tree, "BUILD_INFO"), `sha=${GIT}\nnode=v24\n`);
  for (const [rel, content] of Object.entries(overrides)) {
    const full = path.join(tree, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, tree };
}

function makeArtifact(overrides = {}) {
  const { dir, tree } = buildTree(overrides);
  const artifact = path.join(dir, `staging-standalone-${GIT}.tar.gz`);
  const tar = spawnSync(
    "tar",
    ["-czf", msysPath(artifact), "-C", msysPath(tree), "."],
    { encoding: "utf8" },
  );
  assert.equal(tar.status, 0, tar.stderr);
  return { dir, artifact, sha: sha256(artifact) };
}

function check(artifact, sha = sha256(artifact), git = GIT) {
  return spawnSync("bash", [ENTRY, "check-artifact", msysPath(artifact), sha, git], {
    encoding: "utf8",
  });
}

test("check-artifact 接受结构完整的工件", { skip: SKIP_NO_VAR_TMP }, () => {
  const { dir, artifact, sha } = makeArtifact();
  try {
    const r = check(artifact, sha);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /产物校验通过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-artifact 拒绝 SHA-256 / Git SHA / 格式不匹配", { skip: SKIP_NO_VAR_TMP }, () => {
  const { dir, artifact, sha } = makeArtifact();
  try {
    const wrongSha = check(artifact, HEX64(0));
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /SHA-256 不匹配/);

    const wrongGit = check(artifact, sha, "b".repeat(40));
    assert.notEqual(wrongGit.status, 0);
    assert.match(wrongGit.stderr, /BUILD_INFO 的 Git SHA 与预期不一致/);

    const badFormat = check(artifact, "not-a-sha", GIT);
    assert.notEqual(badFormat.status, 0);
    assert.match(badFormat.stderr, /64 位小写十六进制/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-artifact 拒绝缺必需结构或含 .env", { skip: SKIP_NO_VAR_TMP }, () => {
  const missing = makeArtifact();
  try {
    rmSync(path.join(missing.dir, "tree", "public"), { recursive: true, force: true });
    const art = path.join(missing.dir, `staging-standalone-${GIT}.tar.gz`);
    const tar = spawnSync(
      "tar",
      ["-czf", msysPath(art), "-C", msysPath(path.join(missing.dir, "tree")), "."],
      { encoding: "utf8" },
    );
    assert.equal(tar.status, 0, tar.stderr);
    const r = check(art);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /产物缺 \.\/public\//);
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }

  const dotenv = makeArtifact({ ".env": "DATABASE_URL=postgres://leak\n" });
  try {
    const r = check(dotenv.artifact, dotenv.sha);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\.env/);
  } finally {
    rmSync(dotenv.dir, { recursive: true, force: true });
  }
});

test("check-artifact 拒绝绝对路径与 .. 条目", { skip: SKIP_NO_VAR_TMP }, () => {
  const { dir, tree } = buildTree();
  try {
    const abs = path.join(dir, "abs.tar.gz");
    const r1 = spawnSync(
      "tar",
      ["-czf", msysPath(abs), "--absolute-names", msysPath(path.join(tree, "server.js"))],
      { encoding: "utf8" },
    );
    assert.equal(r1.status, 0, r1.stderr);
    const c1 = check(abs);
    assert.notEqual(c1.status, 0);
    assert.match(c1.stderr, /不安全的 tar 条目/);

    const dotdot = path.join(dir, "dotdot.tar.gz");
    const r2 = spawnSync(
      "tar",
      [
        "-czf",
        msysPath(dotdot),
        "-C",
        msysPath(tree),
        "--transform=s|^\\./public/|../evil/|",
        ".",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r2.status, 0, r2.stderr);
    const c2 = check(dotdot);
    assert.notEqual(c2.status, 0);
    assert.match(c2.stderr, /不安全的 tar 条目/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "安全相对符号链接通过，绝对 / 逃逸链接被拒绝",
  { skip: SKIP_NO_VAR_TMP ? SKIP_NO_VAR_TMP : SKIP_NOT_POSIX },
  () => {
    const safe = buildTree();
    try {
      symlinkSync("../pkg/index.js", path.join(safe.tree, "node_modules", "pkg", "link.js"));
      const art = path.join(safe.dir, `staging-standalone-${GIT}.tar.gz`);
      const tar = spawnSync(
        "tar",
        ["-czf", msysPath(art), "-C", msysPath(safe.tree), "."],
        { encoding: "utf8" },
      );
      assert.equal(tar.status, 0, tar.stderr);
      const r = check(art);
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(safe.dir, { recursive: true, force: true });
    }

    const evil = buildTree();
    try {
      symlinkSync("/etc/passwd", path.join(evil.tree, "node_modules", "escape"));
      const art = path.join(evil.dir, `staging-standalone-${GIT}.tar.gz`);
      const tar = spawnSync(
        "tar",
        ["-czf", msysPath(art), "-C", msysPath(evil.tree), "."],
        { encoding: "utf8" },
      );
      assert.equal(tar.status, 0, tar.stderr);
      const r = check(art);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /unsafe symlink target|不安全的 tar 条目/);
    } finally {
      rmSync(evil.dir, { recursive: true, force: true });
    }
  },
);

// ── 7. bash 语法 ────────────────────────────────────────────────────────────

test("入口与安装器语法正确（bash -n）", { skip: SKIP_NO_BASH }, () => {
  for (const file of [ENTRY, INSTALLER, DB_SCRIPT]) {
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${path.basename(file)} 语法错误：\n${r.stderr}`);
  }
});

test(
  "入口与安装器在 POSIX 上具有执行位",
  { skip: SKIP_NOT_POSIX },
  () => {
    for (const file of [ENTRY, INSTALLER]) {
      const mode = spawnSync("stat", ["-c", "%a", file], { encoding: "utf8" });
      assert.match(mode.stdout.trim(), /^[0-7]*[1357]$/, `${path.basename(file)} 缺少执行位`);
    }
  },
);
