#!/usr/bin/env bash
#
# PROD-2 · 服务器侧一次性收尾（**必须以 root 运行**）
#
#     sudo bash /opt/chaoge-deploy-trust/deploy/app/finalize-staging.sh \
#         --trust-dir /opt/chaoge-deploy-trust \
#         --artifact /tmp/staging-standalone-<APP_SHA>.tar.gz \
#         [--drill]
#
# 这个脚本**不**从 /home/deploy 执行任何东西。它只运行
# /opt/chaoge-deploy-trust 下由 root 拥有、经 SHA-256 manifest 校验过的文件：
#
#     deploy/trust/bootstrap.sh                  建可信快照（由入口命令调用）
#     deploy/app/create-service-user.sh
#     deploy/app/setup-staging-env.sh
#     deploy/app/chaoge-staging.service
#     deploy/app/install-release.sh
#     deploy/db/staging/deploy-staging.sh
#
# ## 两个版本号不要混淆
#
#   APP_GIT_SHA               CI 构建产物的提交 SHA（也是迁移代码快照的版本）
#   ARTIFACT_SHA256_EXPECTED  该 CI 产物的 tar.gz SHA-256
#   FINALIZER_VERSION         部署脚本版本（本文件 + deploy/ 目录）
#
# 部署脚本的 Git 提交与 APP_GIT_SHA 通常不同：前者包含本次安全整改，
# 后者仍是已经构建、已经验证过的应用产物。
#
# ## 安全边界
#
#   · 只操作 chaoge_staging；chaoge_prod 在 deploy-staging.sh 的参数解析阶段被拒绝。
#   · 日志写入 /var/log/chaoge（root 控制的目录），deploy 只读。
#   · 迁移进程以 deploy 身份运行，读取 root 拥有的 src 快照；root 不执行
#     deploy 可替换的迁移代码，也不复制 deploy 的 pnpm/corepack 缓存。
#   · 口令只经 read -rs 读入；migrator 连接串经匿名 fd 传给迁移脚本，
#     不出现在 argv、环境变量列表或日志里。
#   · 产物先复制到 root 拥有的临时文件，再校验 SHA-256 与 BUILD_INFO SHA；
#     校验过的副本不会再被 deploy 修改。
#   · --drill 使用 mktemp 创建随机路径，并在退出时清理。
#
# ## 依赖
#
#   root 运行；trust 目录已由 bootstrap.sh 建好并校验；系统已安装
#   bash / coreutils / tar / curl / systemd / postgresql-client。

set -euo pipefail

FINALIZER_VERSION="prod2-finalize-v2"
APP_GIT_SHA="8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07"
ARTIFACT_SHA256_EXPECTED="f10700772c6bab7fc75a438dba82a2e0de5cbcc6d5348a5106f0b59ae646fd5c"

TRUST_DIR="/opt/chaoge-deploy-trust"
DB_NAME="chaoge_staging"
DB_HOST="127.0.0.1"
DB_PORT="5432"
ENV_FILE="/etc/chaoge/staging.env"
LOG_DIR="/var/log/chaoge"
LOG="$LOG_DIR/prod2-finalize.log"
MIGRATE_USER="deploy"
NODE_BIN="/usr/local/bin/node"

ART=""
DRILL=0
ART_TMP=""
PERSIST_DIR=""
DRILL_DIR=""
DRILL_ART=""

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

usage() {
  cat <<'USAGE'
用法: finalize-staging.sh --trust-dir DIR --artifact FILE [--drill]

  --trust-dir DIR  bootstrap.sh 建好的 root 拥有信任目录（默认 /opt/chaoge-deploy-trust）
  --artifact FILE  CI 产物 tar.gz（必须匹配 APP_GIT_SHA 与 ARTIFACT_SHA256）
  --drill          发布失败自动回滚演练
USAGE
}

cleanup() {
  if [[ -n "${PERSIST_DIR:-}" ]]; then rm -rf -- "$PERSIST_DIR"; fi
  if [[ -n "${DRILL_DIR:-}" ]]; then rm -rf -- "$DRILL_DIR"; fi
  if [[ -n "${DRILL_ART:-}" ]]; then rm -f -- "$DRILL_ART"; fi
  if [[ -n "${ART_TMP:-}" ]]; then rm -f -- "$ART_TMP"; fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trust-dir) TRUST_DIR="${2:?--trust-dir 需要一个值}"; shift 2 ;;
    --artifact)  ART="${2:?--artifact 需要一个文件}"; shift 2 ;;
    --drill)     DRILL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行：sudo bash $0 --trust-dir DIR --artifact FILE [--drill]"
[[ -n "$ART" ]] || { usage >&2; die "缺少 --artifact"; }
[[ "$TRUST_DIR" == "/opt/chaoge-deploy-trust" ]] \
  || die "trust 目录必须是 /opt/chaoge-deploy-trust（当前：$TRUST_DIR）。"

# ── 0. 日志（root 控制的目录，deploy 只读）───────────────────────────────────

if [[ -e "$LOG_DIR" || -L "$LOG_DIR" ]]; then
  [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] || die "$LOG_DIR 不是普通目录，拒绝写入日志。"
  [[ "$(stat -c %u "$LOG_DIR")" == "0" ]] || die "$LOG_DIR 的属主不是 root。"
else
  install -d -o root -g deploy -m 0750 "$LOG_DIR"
fi
chown root:deploy "$LOG_DIR"
chmod 0750 "$LOG_DIR"
[[ -L "$LOG" ]] && die "日志路径是符号链接，拒绝写入：$LOG"
[[ -e "$LOG" && ! -f "$LOG" ]] && die "日志路径不是普通文件：$LOG"
if [[ ! -e "$LOG" ]]; then
  install -o root -g deploy -m 0640 /dev/null "$LOG"
fi
chown root:deploy "$LOG"
chmod 0640 "$LOG"
exec > >(tee -a "$LOG") 2>&1

info "finalizer: $FINALIZER_VERSION"
info "开始时间: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "APP_GIT_SHA（CI 产物）: $APP_GIT_SHA"
info "ARTIFACT_SHA256（CI 产物）: $ARTIFACT_SHA256_EXPECTED"
info "trust: $TRUST_DIR"
info "日志: $LOG"
info "注意：部署脚本版本与 CI 产物版本是两个不同的 SHA；不要用部署脚本提交覆盖 BUILD_INFO。"

# ── 1. 信任目录校验 ──────────────────────────────────────────────────────────

step "1/14 校验 root 拥有的信任目录"
[[ -d "$TRUST_DIR" && ! -L "$TRUST_DIR" ]] || die "信任目录不存在或是符号链接：$TRUST_DIR"
[[ "$(stat -c '%u:%g' "$TRUST_DIR")" == "0:0" ]] || die "信任目录必须 root:root。"
TRUST_MODE="$(stat -c %a "$TRUST_DIR")"
(( (8#$TRUST_MODE & 8#022) == 0 )) || die "信任目录对组/其他用户可写（$TRUST_MODE）。"

for f in \
  deploy/app/finalize-staging.sh \
  deploy/app/install-release.sh \
  deploy/app/create-service-user.sh \
  deploy/app/setup-staging-env.sh \
  deploy/app/chaoge-staging.service \
  deploy/db/staging/deploy-staging.sh \
  deploy/trust/deploy-files.sha256 \
  deploy/trust/migration-code.sha256 ; do
  [[ -f "$TRUST_DIR/$f" && ! -L "$TRUST_DIR/$f" ]] \
    || die "信任目录缺少普通文件：$f"
  [[ "$(stat -c '%u:%g' "$TRUST_DIR/$f")" == "0:0" ]] \
    || die "信任文件不是 root:root：$f"
done

BAD_WRITE="$(find "$TRUST_DIR" -xdev \( -type f -o -type d \) \
  \( -perm -0020 -o -perm -0002 \) -print -quit)"
[[ -z "$BAD_WRITE" ]] || die "信任目录中仍有组/其他用户可写的路径：$BAD_WRITE"

( cd "$TRUST_DIR" && sha256sum -c --quiet deploy/trust/deploy-files.sha256 ) \
  || die "部署文件 manifest 校验失败；拒绝执行任何 deploy 提供的脚本。"

[[ -d "$TRUST_DIR/src" && ! -L "$TRUST_DIR/src" ]] || die "缺少迁移代码快照：$TRUST_DIR/src"
[[ -d "$TRUST_DIR/src/node_modules" ]] || die "迁移代码快照缺少 node_modules。"
[[ -f "$TRUST_DIR/src/tests/alias-hook.mjs" ]] || die "迁移快照缺少 tests/alias-hook.mjs。"
[[ -d "$TRUST_DIR/src/db/migrations" ]] || die "迁移快照缺少 db/migrations。"
[[ ! -e "$TRUST_DIR/src/.env" ]] || die "迁移快照里出现了 .env；拒绝继续。"
( cd "$TRUST_DIR/src" && sha256sum -c --quiet "$TRUST_DIR/deploy/trust/migration-code.sha256" ) \
  || die "迁移代码 manifest 校验失败；拒绝执行迁移。"
ok "信任目录、部署脚本与迁移代码 manifest 全部通过"

# ── 2. 产物校验（先复制到 root 拥有的临时文件，消除 TOCTOU）──────────────────

step "2/14 校验 CI 产物 SHA-256 与 BUILD_INFO Git SHA"
[[ -f "$ART" && ! -L "$ART" ]] || die "产物不存在或是符号链接：$ART"
[[ -s "$ART" ]] || die "产物是空的：$ART"
command -v sha256sum >/dev/null 2>&1 || die "找不到 sha256sum。"
command -v tar >/dev/null 2>&1 || die "找不到 tar。"

ART_TMP="$(mktemp --suffix=.tar.gz /var/tmp/prod2-artifact.XXXXXX)"
install -o root -g root -m 0600 -- "$ART" "$ART_TMP"
ART="$ART_TMP"

ACTUAL_SHA256="$(sha256sum "$ART" | awk '{print $1}')"
[[ "$ACTUAL_SHA256" == "$ARTIFACT_SHA256_EXPECTED" ]] || die \
  "产物 SHA-256 不匹配。
      期望: $ARTIFACT_SHA256_EXPECTED
      实际: $ACTUAL_SHA256
      拒绝安装一个未经验证的 CI 产物。"

tar -tzf "$ART" >/dev/null 2>&1 || die "不是有效的 tar.gz：$ART"
while IFS= read -r entry; do
  case "$entry" in
    /*|..|../*|*/../*|*/..) die "产物包含不安全的 tar 条目：$entry" ;;
  esac
done < <(tar -tzf "$ART")

BUILD_INFO="$(tar -xOzf "$ART" ./BUILD_INFO 2>/dev/null || true)"
[[ -n "$BUILD_INFO" ]] || BUILD_INFO="$(tar -xOzf "$ART" BUILD_INFO 2>/dev/null || true)"
[[ -n "$BUILD_INFO" ]] || die "产物里没有 BUILD_INFO。"
BUILD_SHA="$(printf '%s\n' "$BUILD_INFO" | sed -n 's/^sha=//p' | head -1 | tr -d '\r')"
[[ "$BUILD_SHA" == "$APP_GIT_SHA" ]] || die \
  "BUILD_INFO 的 Git SHA 与预期不一致。
      期望: $APP_GIT_SHA
      实际: $BUILD_SHA
      BUILD_INFO 必须对应本次 CI 产物；不要用部署脚本的提交 SHA 替换它。"
ok "产物 SHA-256 与 BUILD_INFO Git SHA 均匹配"
info "BUILD_INFO:"
printf '%s\n' "$BUILD_INFO" | sed 's/^/      /'

deploy_script() {
  local rel="$1"; shift
  bash "$TRUST_DIR/$rel" "$@"
}

# ── 3. 服务账号与目录 ────────────────────────────────────────────────────────

step "3/14 服务账号与目录"
deploy_script deploy/app/create-service-user.sh

# ── 4. 数据库只读预检 ────────────────────────────────────────────────────────

step "4/14 数据库只读预检"
CHAOGE_APP_DIR="$TRUST_DIR/src" \
  deploy_script deploy/db/staging/deploy-staging.sh check --database "$DB_NAME"

# ── 5. 建库 ──────────────────────────────────────────────────────────────────

step "5/14 创建 $DB_NAME（已存在则跳过）"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -qx 1; then
  ok "$DB_NAME 已存在，跳过 create"
else
  CHAOGE_APP_DIR="$TRUST_DIR/src" \
    deploy_script deploy/db/staging/deploy-staging.sh create --database "$DB_NAME"
fi

# ── 6. 权限初始化 ────────────────────────────────────────────────────────────

step "6/14 权限初始化（01→05，单事务）"
CHAOGE_APP_DIR="$TRUST_DIR/src" \
  deploy_script deploy/db/staging/deploy-staging.sh init --database "$DB_NAME"

# ── 7. 角色口令 ──────────────────────────────────────────────────────────────

step "7/14 两个 staging 角色的口令"
role_pw_set() {
  [[ "$(sudo -u postgres psql -tAc "SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = '$1'")" == "t" ]]
}
if role_pw_set chaoge_staging_migrator && role_pw_set chaoge_staging_app; then
  ok "两个口令均已设置，跳过"
else
  cat <<'EOS'
  即将打开 psql（postgres 身份）。请依次输入：
      \password chaoge_staging_migrator
      \password chaoge_staging_app
  每个角色会要求输入两次（不回显）。完成后输入 \q 退出。
EOS
  sudo -u postgres psql -d "$DB_NAME"
  role_pw_set chaoge_staging_migrator || die "chaoge_staging_migrator 口令仍未设置。"
  role_pw_set chaoge_staging_app || die "chaoge_staging_app 口令仍未设置。"
  ok "两个口令已设置（只输出布尔值，未读取口令内容）"
fi

# ── 8. 迁移（以 deploy 身份执行 root 拥有的代码）─────────────────────────────

step "8/14 数据库迁移（执行身份：$MIGRATE_USER，代码：$TRUST_DIR/src）"
[[ -t 0 ]] || die "需要交互式终端输入 chaoge_staging_migrator 口令。"
command -v runuser >/dev/null 2>&1 || die "找不到 runuser。"
id -u "$MIGRATE_USER" >/dev/null 2>&1 || die "迁移执行账号不存在：$MIGRATE_USER"
[[ -x "$NODE_BIN" ]] || die "Node 不存在或不可执行：$NODE_BIN"

LC_ALL=C
urlencode() {
  local s="$1" out="" c i
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

printf '  请输入 chaoge_staging_migrator 的口令（输入不回显）: ' >&2
read -rs MIG_PW; printf '\n' >&2
[[ -n "$MIG_PW" ]] || die "口令为空。"
MIG_URL="postgresql://chaoge_staging_migrator:$(urlencode "$MIG_PW")@$DB_HOST:$DB_PORT/$DB_NAME"
unset MIG_PW

# 连接串走固定 fd 9：不出现在 argv，也不写进 root 的环境变量列表。
exec 9< <(printf '%s\n' "$MIG_URL")
unset MIG_URL
CHAOGE_APP_DIR="$TRUST_DIR/src" \
CHAOGE_MIGRATE_AS="$MIGRATE_USER" \
CHAOGE_NODE_BIN="$NODE_BIN" \
  deploy_script deploy/db/staging/deploy-staging.sh migrate \
    --database "$DB_NAME" --migrator-url-fd 9
exec 9<&-
ok "迁移完成（root 未执行迁移代码）"

# ── 9. 最小测试数据 ──────────────────────────────────────────────────────────

step "9/14 最小测试数据（只插入）"
CHAOGE_APP_DIR="$TRUST_DIR/src" \
  deploy_script deploy/db/staging/deploy-staging.sh bootstrap --database "$DB_NAME"

# ── 10. 数据库验收 ───────────────────────────────────────────────────────────

step "10/14 数据库隔离验收"
CHAOGE_APP_DIR="$TRUST_DIR/src" \
  deploy_script deploy/db/staging/deploy-staging.sh verify --database "$DB_NAME"

# ── 11. 运行时环境变量与 systemd 单元 ────────────────────────────────────────

step "11/14 生成 $ENV_FILE 并安装 systemd 单元"
if [[ -e "$ENV_FILE" ]]; then
  deploy_script deploy/app/setup-staging-env.sh --force
else
  deploy_script deploy/app/setup-staging-env.sh
fi
install -o root -g root -m 0644 \
  "$TRUST_DIR/deploy/app/chaoge-staging.service" /etc/systemd/system/chaoge-staging.service
systemctl daemon-reload
systemctl enable chaoge-staging
ok "环境变量文件与 systemd 单元已就位"

# ── 12. 发布并启动（强制双 SHA 校验）─────────────────────────────────────────

step "12/14 安装首版并启动"
deploy_script deploy/app/install-release.sh \
  --artifact "$ART" \
  --sha256 "$ARTIFACT_SHA256_EXPECTED" \
  --expected-sha "$APP_GIT_SHA"

# ── 13. HTTP、持久化、异常恢复 ───────────────────────────────────────────────

step "13/14 HTTP / 数据库持久化 / SIGKILL 恢复"
B="http://127.0.0.1:3000"
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1"; }
HOME_CODE="$(code "$B/")"
STATIC_CODE="$(code "$B/next.svg")"
GUARD_CODE="$(code "$B/api/favorites")"
info "首页: $HOME_CODE（期望 200）"
info "静态资源 /next.svg: $STATIC_CODE（期望 200）"
info "未登录 /api/favorites: $GUARD_CODE（期望 401）"
[[ "$HOME_CODE" == "200" ]] || die "首页不是 200"
[[ "$STATIC_CODE" == "200" ]] || die "静态资源不是 200"
[[ "$GUARD_CODE" == "401" ]] || die "未登录守卫不是 401"

PERSIST_DIR="$(mktemp -d)"
JAR="$PERSIST_DIR/cookies"

wait_home() {
  local i
  for i in $(seq 1 30); do
    [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$B/" 2>/dev/null)" == "200" ]] && return 0
    sleep 1
  done
  return 1
}

LOGIN_CODE="$(curl -sS -o "$PERSIST_DIR/login.json" -w '%{http_code}' \
  -c "$JAR" -X POST -H 'content-type: application/json' \
  -d '{"userId":"u-1002"}' "$B/api/auth/mock-login")"
[[ "$LOGIN_CODE" == "200" ]] || die "mock 登录失败：HTTP $LOGIN_CODE（$(cat "$PERSIST_DIR/login.json")）"
ok "mock 登录成功（u-1002）"

curl -sS -b "$JAR" -X DELETE "$B/api/favorites/p-400w" -o /dev/null || true
WRITE_CODE="$(curl -sS -o "$PERSIST_DIR/write.json" -w '%{http_code}' \
  -b "$JAR" -X POST -H 'content-type: application/json' \
  -d '{"productId":"p-400w"}' "$B/api/favorites")"
[[ "$WRITE_CODE" == "200" || "$WRITE_CODE" == "201" ]] \
  || die "收藏写入失败：HTTP $WRITE_CODE（$(cat "$PERSIST_DIR/write.json")）"
ok "收藏写入成功（p-400w）"

systemctl restart chaoge-staging
wait_home || die "重启后首页未恢复 200"
READ_BODY="$(curl -sS -b "$JAR" "$B/api/favorites")"
grep -q 'p-400w' <<< "$READ_BODY" || die "重启后读不到 p-400w —— 数据没有持久化到 PostgreSQL"
ok "重启后读回成功（数据在 PostgreSQL 中）"

curl -sS -b "$JAR" -X DELETE "$B/api/favorites/p-400w" -o /dev/null || true
rm -rf -- "$PERSIST_DIR"; PERSIST_DIR=""

PID_BEFORE="$(systemctl show -p MainPID --value chaoge-staging)"
[[ "$PID_BEFORE" =~ ^[0-9]+$ && "$PID_BEFORE" != "0" ]] || die "读不到 MainPID"
systemctl kill -s SIGKILL chaoge-staging
info "已向 PID $PID_BEFORE 发送 SIGKILL，等待 Restart=always 拉起"
RECOVERED=0
for _ in $(seq 1 20); do
  sleep 1
  PID_AFTER="$(systemctl show -p MainPID --value chaoge-staging)"
  if [[ "$PID_AFTER" =~ ^[0-9]+$ && "$PID_AFTER" != "0" && "$PID_AFTER" != "$PID_BEFORE" ]] \
     && [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$B/" 2>/dev/null)" == "200" ]]; then
    RECOVERED=1; break
  fi
done
(( RECOVERED == 1 )) || die "SIGKILL 后服务未自动恢复"
ok "异常退出后已自动恢复（PID $PID_BEFORE → $PID_AFTER）"

systemctl is-enabled chaoge-staging | sed 's/^/      is-enabled: /'
systemctl is-active chaoge-staging  | sed 's/^/      is-active:  /'
ss -ltnH 'sport = :3000' | sed 's/^/      /'
journalctl -u chaoge-staging -n 20 --no-pager | sed 's/^/      /'

# ── 14. 可选：受控发布失败回滚演练 ───────────────────────────────────────────

if (( DRILL == 1 )); then
  step "14/14 受控发布失败回滚演练"
  GOOD_REL="$(readlink -f /opt/chaoge-staging/current)"
  GOOD_SHA="$(sed -n 's/^sha=//p' "$GOOD_REL/BUILD_INFO" | head -1)"
  [[ "$GOOD_SHA" == "$APP_GIT_SHA" ]] \
    || die "当前版本 SHA（$GOOD_SHA）与 APP_GIT_SHA 不一致。"

  DRILL_DIR="$(mktemp -d)"
  tar -xzf "$ART" -C "$DRILL_DIR"
  printf 'process.stderr.write("intentional PROD-2 rollback drill\\n");\nprocess.exit(1);\n' > "$DRILL_DIR/server.js"
  DRILL_BAD_SHA="$(printf 'f%.0s' {1..40})"
  sed -i "s/^sha=.*/sha=$DRILL_BAD_SHA/" "$DRILL_DIR/BUILD_INFO"
  DRILL_ART="$(mktemp --suffix=.tar.gz /var/tmp/prod2-drill.XXXXXX)"
  tar -czf "$DRILL_ART" -C "$DRILL_DIR" .
  DRILL_SHA="$(sha256sum "$DRILL_ART" | awk '{print $1}')"
  rm -rf -- "$DRILL_DIR"; DRILL_DIR=""

  info "发布一个 server.js 立即退出的产物，期望 install-release 自动回滚"
  if deploy_script deploy/app/install-release.sh \
      --artifact "$DRILL_ART" \
      --sha256 "$DRILL_SHA" \
      --expected-sha "$DRILL_BAD_SHA" \
      --release-id "drill-$(date -u '+%Y%m%dT%H%M%SZ')-${DRILL_BAD_SHA:0:7}"; then
    die "回滚演练失败：坏产物居然通过了健康检查"
  else
    ok "坏产物按预期失败（install-release 返回非零）"
  fi

  sleep 1
  NOW_REL="$(readlink -f /opt/chaoge-staging/current)"
  NOW_SHA="$(sed -n 's/^sha=//p' "$NOW_REL/BUILD_INFO" | head -1)"
  [[ "$NOW_SHA" == "$GOOD_SHA" && "$NOW_REL" == "$GOOD_REL" ]] \
    || die "回滚后 current 未指回原版本（now=$NOW_SHA, good=$GOOD_SHA）"
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$B/")" == "200" ]] \
    || die "回滚后首页不是 200"
  ok "已自动回滚到 $NOW_REL（sha=$NOW_SHA）且服务健康"

  while IFS= read -r f; do
    d="$(dirname "$f")"
    [[ "$d" == "$NOW_REL" ]] && continue
    info "删除演练版本 $(basename "$d")"
    rm -rf -- "$d"
  done < <(grep -l "^sha=$DRILL_BAD_SHA$" /opt/chaoge-staging/releases/*/BUILD_INFO 2>/dev/null || true)
  rm -f -- "$DRILL_ART"; DRILL_ART=""
  ok "演练残留已清理"
fi

# ── 汇总 ─────────────────────────────────────────────────────────────────────

step "完成"
info "FINALIZER_VERSION: $FINALIZER_VERSION"
info "APP_GIT_SHA（CI 产物）: $APP_GIT_SHA"
info "ARTIFACT_SHA256（CI 产物）: $ARTIFACT_SHA256_EXPECTED"
info "BUILD_INFO:"
sed 's/^/      /' /opt/chaoge-staging/current/BUILD_INFO
info "current -> $(readlink -f /opt/chaoge-staging/current)"
info "is-enabled: $(systemctl is-enabled chaoge-staging 2>&1)"
info "is-active:  $(systemctl is-active chaoge-staging 2>&1)"
info "监听:"
ss -ltnH 'sport = :3000' | sed 's/^/      /'
info "限制说明：管理端/客服端 Cookie 在 NODE_ENV=production 下带 Secure，"
info "          纯 HTTP 的 SSH 隧道不会回传这些 Cookie；用户端 mock 登录不受影响。"
ok "服务器侧收尾完成。日志：$LOG"
