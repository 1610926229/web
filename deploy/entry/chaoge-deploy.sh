#!/usr/bin/env bash
#
# PROD-2 · 超哥电竞 Staging 受控部署入口（安装到 /usr/local/sbin/chaoge-deploy）
#
# 这个文件由 root 拥有、普通用户不可写。一次性安装脚本会把下面的 sudoers
# 规则写入 /etc/sudoers.d/chaoge-deploy（0440 root:root）：
#
#     deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
#
# 规则**只有一个命令、没有通配符、没有 ALL**。deploy 用户不能借此执行任意
# shell、任意 systemctl、任意脚本；能做什么完全由本文件的子命令与参数校验决定。
#
# 子命令：
#
#   deploy <artifact> <sha256> <git-sha>
#       校验产物 → 以 deploy 身份迁移 → 以应用角色写最小数据 → 验收 →
#       安装版本目录 → 原子切换 current → 重启 chaoge-staging → 健康检查/回滚。
#
#   rollback
#       回到最近的一个非当前版本（不接受参数，不接受版本名）。
#
#   status
#       只读状态：入口/sudoers/凭据权限、当前版本、服务与监听地址。
#
#   demo-data
#       以应用角色写入 staging 首页演示数据（07，只插入、可重复）。
#       不在正式 deploy 链上；只作用于固定的 chaoge_staging。
#
#   check-artifact <artifact> <sha256> <git-sha>
#       只做产物校验，不写任何文件、不需要 root（测试与预检使用）。
#       **拒绝以 root 身份运行**：否则 deploy 可经 sudo 让 root 对任意
#       普通文件做哈希/tar 检查，形成文件读取 oracle。普通用户按自己的
#       文件权限运行即可，不存在额外授权。
#
# ## 安全边界
#
#   · 数据库名、角色、服务名、端口、路径全部写死；不接受调用者传库名/服务名/路径。
#   · 数据库口令只从 /etc/chaoge/staging.secrets（root:root 0600）读取；
#     不打印、不写日志、不放进 argv。迁移连接串经匿名 fd 传给迁移脚本。
#   · 产物代码**从不以 root 执行**：迁移以 deploy 身份运行，应用以 chaoge 身份运行；
#     root 只做校验、复制、解包、chown、systemctl 固定服务。
#   · 产物先复制到 root 拥有的 0700 私有目录，再校验 SHA-256、Git SHA、结构；
#     校验后的副本不再可被 deploy 修改。
#   · 拒绝绝对路径 / .. / 符号链接 / 硬链接 / 设备 / FIFO / setuid 条目 / .env。
#   · chaoge_prod 从不出现；staging 脚本自身还有库名白名单与 SQL 守卫。
#   · 端口 3000 只允许 127.0.0.1；由 systemd 单元与 _common.sh 双重断言。

set -euo pipefail
umask 027
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH PYTHONPATH PERL5LIB

ENTRY_VERSION="prod2-entry-v4"
ENTRY_PATH="/usr/local/sbin/chaoge-deploy"
LIB_DIR="/usr/local/lib/chaoge"
DB_NAME="chaoge_staging"
DB_HOST="127.0.0.1"
DB_PORT="5432"
MIGRATOR_ROLE="chaoge_staging_migrator"
APP_ROLE="chaoge_staging_app"
SERVICE="chaoge-staging"
SERVICE_USER="chaoge"
MIGRATE_USER="deploy"
NODE_BIN="/usr/local/bin/node"
ROOT_DIR="/opt/chaoge-staging"
RELEASES="$ROOT_DIR/releases"
CURRENT="$ROOT_DIR/current"
CONF_DIR="/etc/chaoge"
SECRETS="$CONF_DIR/staging.secrets"
ENV_FILE="$CONF_DIR/staging.env"
SUDOERS_FILE="/etc/sudoers.d/chaoge-deploy"
INCOMING_DIR="/home/deploy/incoming"
LOG_DIR="/var/log/chaoge"
LOG="$LOG_DIR/chaoge-deploy.log"
LOCK_FILE="/run/chaoge-deploy.lock"
MAX_ARTIFACT_BYTES=$((1024 * 1024 * 1024))
MAX_ARTIFACT_ENTRIES=500000

PRIV_DIR=""
SCRATCH_DIR=""
ARTIFACT_IN=""
ARTIFACT_SHA=""
GIT_SHA=""
BUILD_INFO_TEXT=""

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }
usage() {
  cat <<'USAGE'
用法:
  chaoge-deploy deploy <artifact.tar.gz> <sha256> <git-sha>
  chaoge-deploy rollback
  chaoge-deploy status
  chaoge-deploy demo-data
  chaoge-deploy check-artifact <artifact.tar.gz> <sha256> <git-sha>

说明:
  · 只操作 chaoge_staging 与 chaoge-staging；不接受数据库名、服务名或可执行路径。
  · 产物必须位于 /home/deploy/incoming/，文件名必须是
    staging-standalone-<git-sha>.tar.gz。
  · deploy / rollback / status / demo-data 需要 root（sudoers 只允许 deploy 免密执行本入口）。
  · demo-data 只写入 staging 首页演示内容；不在正式 deploy 链上，可重复执行。
  · check-artifact 只读，必须由普通用户运行；root 身份会被拒绝。
USAGE
}

cleanup() {
  [[ -n "${PRIV_DIR:-}" && -d "$PRIV_DIR" ]] && rm -rf -- "$PRIV_DIR"
  [[ -n "${SCRATCH_DIR:-}" && -d "$SCRATCH_DIR" ]] && rm -rf -- "$SCRATCH_DIR"
  return 0
}
trap cleanup EXIT INT TERM HUP

require_root() {
  [[ "$(id -u)" == "0" ]] \
    || die "必须以 root 运行。正常路径：sudo /usr/local/sbin/chaoge-deploy <子命令>（由受控 sudoers 规则授权）。"
}

# check-artifact 明确拒绝 root。
#
# sudoers 把整个入口授权给 deploy，因此 `sudo -n chaoge-deploy check-artifact
# /任意路径 ...` 会让 root 替 deploy 读取/哈希 deploy 自己无权读取的文件。
# 普通用户运行 check-artifact 时，读取能力完全受原有文件权限约束，不会因
# 这个子命令增加任何权限；root 运行则没有这个约束，所以这里直接拒绝。
require_non_root() {
  [[ "$(id -u)" != "0" ]] \
    || die "check-artifact 只能由普通用户运行：root 身份会形成对任意路径的文件检查 oracle。需要 root 的部署请使用 deploy / rollback / status。"
}

require_regular_file() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "$label 不存在或是符号链接：$path"
}

assert_root_file_mode() {
  local path="$1" want="$2" label="$3" actual
  require_regular_file "$path" "$label"
  actual="$(stat -c '%u:%g %a' "$path")"
  [[ "$actual" == "$want" ]] \
    || die "$label 的属主/权限是「$actual」，期望「$want」：$path"
}

validate_hex64() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "SHA-256 必须是 64 位小写十六进制：$1"
}
validate_hex40() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "Git SHA 必须是 40 位小写十六进制：$1"
}

setup_log() {
  if [[ -e "$LOG_DIR" || -L "$LOG_DIR" ]]; then
    [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] || die "$LOG_DIR 不是普通目录，拒绝写日志。"
    [[ "$(stat -c '%u' "$LOG_DIR")" == "0" ]] || die "$LOG_DIR 的属主不是 root。"
  else
    install -d -o root -g "$MIGRATE_USER" -m 0750 "$LOG_DIR"
  fi
  chown root:"$MIGRATE_USER" "$LOG_DIR"
  chmod 0750 "$LOG_DIR"
  [[ -L "$LOG" ]] && die "日志路径是符号链接，拒绝写入：$LOG"
  [[ -e "$LOG" && ! -f "$LOG" ]] && die "日志路径不是普通文件：$LOG"
  [[ -e "$LOG" ]] || install -o root -g "$MIGRATE_USER" -m 0640 /dev/null "$LOG"
  chown root:"$MIGRATE_USER" "$LOG"
  chmod 0640 "$LOG"
  exec > >(tee -a "$LOG") 2>&1
}

take_lock() {
  exec 200>"$LOCK_FILE"
  flock -n 200 || die "另一个 chaoge-deploy 正在运行（锁：$LOCK_FILE）。"
}

read_secret() {
  local key="$1" line value
  assert_root_file_mode "$SECRETS" "0:0 600" "凭据文件"
  line="$(grep -E "^${key}=" "$SECRETS" | head -1 || true)"
  [[ -n "$line" ]] || die "凭据文件缺少：$key"
  value="${line#*=}"
  [[ -n "$value" ]] || die "凭据文件中的 $key 为空"
  [[ "$value" != *$'\r'* ]] || die "凭据文件中的 $key 含 CR，拒绝继续"
  printf '%s' "$value"
}

# 口令可能沿用运维早先设置的非十六进制值；连接串里的 userinfo 必须编码，
# 否则 @ : / % # 等字符会把 URL 解析到错误的主机或库。
urlencode() {
  local s="$1" out="" c i
  LC_ALL=C
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

require_initialized() {
  assert_root_file_mode "$SECRETS" "0:0 600" "凭据文件"
  assert_root_file_mode "$ENV_FILE" "0:0 600" "运行时环境文件"
  require_regular_file "$LIB_DIR/db/deploy-staging.sh" "staging 数据库入口"
  require_regular_file "$LIB_DIR/app/install-release.sh" "发布脚本"
  require_regular_file "$LIB_DIR/app/rollback.sh" "回滚脚本"
  require_regular_file "$LIB_DIR/app/_common.sh" "发布公共函数"
  require_regular_file /etc/systemd/system/chaoge-staging.service "systemd 单元"
  [[ -d "$LIB_DIR/src" && ! -L "$LIB_DIR/src" ]] \
    || die "迁移代码快照不存在或是符号链接：$LIB_DIR/src"
  [[ "$(stat -c '%u' "$LIB_DIR/src")" == "0" ]] \
    || die "迁移代码快照的属主不是 root：$LIB_DIR/src"
  [[ -z "$(find "$LIB_DIR/src" -xdev ! -type l \( -perm -0020 -o -perm -0002 \) -print -quit)" ]] \
    || die "迁移代码快照中存在组/其他用户可写的路径，拒绝继续。"
  require_regular_file "$LIB_DIR/src/package.json" "迁移代码 package.json"
  [[ -d "$LIB_DIR/src/node_modules" && ! -L "$LIB_DIR/src/node_modules" ]] \
    || die "迁移依赖目录不存在或是符号链接：$LIB_DIR/src/node_modules"
  id -u "$SERVICE_USER" >/dev/null 2>&1 || die "服务账号不存在：$SERVICE_USER"
  id -u "$MIGRATE_USER" >/dev/null 2>&1 || die "迁移账号不存在：$MIGRATE_USER"
  [[ -x "$NODE_BIN" ]] || die "Node 不存在或不可执行：$NODE_BIN"
  [[ -d "$RELEASES" && ! -L "$RELEASES" ]] || die "发布目录不存在或是符号链接：$RELEASES"
  [[ "$(stat -c '%u' "$RELEASES")" == "0" ]] || die "$RELEASES 的属主不是 root。"
}

artifact_path_policy() {
  local path="$1" git="$2" canon base owner deploy_uid size

  [[ "$path" == /* ]] || die "产物必须使用绝对路径：$path"
  [[ "$path" == "$INCOMING_DIR"/* ]] \
    || die "产物必须位于 $INCOMING_DIR 下（当前：$path）。"
  [[ -d "$INCOMING_DIR" && ! -L "$INCOMING_DIR" ]] \
    || die "上传目录不存在或是符号链接：$INCOMING_DIR"
  require_regular_file "$path" "产物"

  canon="$(readlink -f -- "$path")" || die "无法解析产物路径：$path"
  [[ "$canon" == "$INCOMING_DIR"/* ]] \
    || die "产物路径解析后逃逸出 $INCOMING_DIR：$canon"

  base="$(basename -- "$canon")"
  [[ "$base" =~ ^staging-standalone-([0-9a-f]{40})\.tar\.gz$ ]] \
    || die "产物文件名必须是 staging-standalone-<git-sha>.tar.gz（当前：$base）。"
  [[ "${BASH_REMATCH[1]}" == "$git" ]] \
    || die "文件名里的 Git SHA 与参数不一致：${BASH_REMATCH[1]} != $git"

  deploy_uid="$(id -u "$MIGRATE_USER")"
  owner="$(stat -c '%u' -- "$canon")"
  [[ "$owner" == "0" || "$owner" == "$deploy_uid" ]] \
    || die "产物必须属于 root 或 $MIGRATE_USER（当前 uid=$owner）。"

  size="$(stat -c '%s' -- "$canon")"
  (( size > 0 )) || die "产物是空的：$canon"
  (( size <= MAX_ARTIFACT_BYTES )) \
    || die "产物过大（$size 字节，上限 $MAX_ARTIFACT_BYTES）。"
}

# 只读校验：不对调用者文件做任何写操作。
# 参数：file, expected sha256, expected git sha, scratch dir
validate_artifact_file() {
  local file="$1" expected_sha="$2" expected_git="$3" scratch="$4"
  local actual_sha entries types count build_sha

  require_regular_file "$file" "产物"
  [[ -s "$file" ]] || die "产物是空的：$file"
  validate_hex64 "$expected_sha"
  validate_hex40 "$expected_git"

  actual_sha="$(sha256sum -- "$file" | awk '{print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || die \
    "产物 SHA-256 不匹配。
      期望: $expected_sha
      实际: $actual_sha"
  ARTIFACT_SHA="$actual_sha"

  tar -tzf "$file" > "$scratch/entries.txt" 2>/dev/null \
    || die "不是有效的 tar.gz：$file"
  entries="$scratch/entries.txt"
  count="$(wc -l < "$entries")"
  (( count > 0 && count <= MAX_ARTIFACT_ENTRIES )) \
    || die "产物条目数异常（$count，上限 $MAX_ARTIFACT_ENTRIES）。"

  while IFS= read -r entry; do
    case "$entry" in
      /*|..|../*|*/../*|*/..) die "产物包含不安全的 tar 条目：$entry" ;;
    esac
  done < "$entries"

  # 允许普通文件、目录与**安全的相对符号链接**；拒绝硬链接、设备、FIFO、
  # setuid/setgid，以及绝对 / 逃出产物根目录的链接目标。
  #
  # Next 的 standalone 产物里本来就有符号链接：node_modules/.bin 与
  # .next/node_modules/ 下的包链接。一律拒绝会误杀真实产物；而直接交给 tar
  # 解包又不安全，所以这里在解包前按「链接所在目录 + 目标」做词法归一化，
  # 任何越界目标都拒绝。
  tar -tvzf "$file" > "$scratch/types.txt" 2>/dev/null \
    || die "无法读取产物的 tar 类型信息：$file"
  types="$scratch/types.txt"
  if ! awk '
    function depth_of(p,   n, a, i, d) {
      d = 0
      n = split(p, a, "/")
      for (i = 1; i <= n; i++) if (a[i] != "" && a[i] != ".") d++
      return d
    }
    function link_target_safe(path, target,   n, a, i, d) {
      if (target ~ /^\//) return 0
      sub(/\/[^\/]*$/, "", path)          # dirname(link)
      d = depth_of(path)
      n = split(target, a, "/")
      for (i = 1; i <= n; i++) {
        if (a[i] == "" || a[i] == ".") continue
        if (a[i] == "..") { d--; if (d < 0) return 0 }
        else d++
      }
      return 1
    }
    {
      type = substr($1, 1, 1)
      if (type != "-" && type != "d" && type != "l") {
        print "unsafe entry type: " $0; bad = 1
      }
      if (substr($1, 4, 1) ~ /[sS]/ || substr($1, 7, 1) ~ /[sS]/) {
        print "setuid/setgid entry: " $0; bad = 1
      }
      if (type == "l") {
        at = index($0, " -> ")
        if (at == 0) { print "symlink without target: " $0; bad = 1; next }
        target = substr($0, at + 4)
        left = substr($0, 1, at - 1)
        n = split(left, f, /[ \t]+/)
        link = f[n]
        if (!link_target_safe(link, target)) {
          print "unsafe symlink target: " link " -> " target; bad = 1
        }
      }
    }
    END { exit (bad ? 1 : 0) }
  ' "$types"; then
    die "产物包含不安全的 tar 条目（链接逃逸、硬链接、设备、FIFO 或 setuid/setgid），拒绝。"
  fi

  if grep -qE '(^|/)\.env(\.|$)' "$entries"; then
    die "产物里出现了 .env 文件，拒绝安装。"
  fi

  grep -qxE '\./server\.js' "$entries"      || die "产物缺 ./server.js"
  grep -qxE '\./BUILD_INFO' "$entries"      || die "产物缺 ./BUILD_INFO"
  [[ "$(grep -cxE '\./BUILD_INFO' "$entries")" == "1" ]] \
    || die "产物里 ./BUILD_INFO 出现了不止一次，拒绝。"
  grep -qE  '^\./node_modules/' "$entries"  || die "产物缺 ./node_modules/"
  grep -qE  '^\./\.next/static/' "$entries" || die "产物缺 ./.next/static/"
  grep -qE  '^\./public/' "$entries"        || die "产物缺 ./public/"

  # BUILD_INFO 只应是几十字节；用 head 限制解压输出，避免 tar 炸弹撑爆内存。
  BUILD_INFO_TEXT="$(tar -xOzf "$file" ./BUILD_INFO 2>/dev/null | head -c 4096 || true)"
  [[ -n "$BUILD_INFO_TEXT" ]] \
    || BUILD_INFO_TEXT="$(tar -xOzf "$file" BUILD_INFO 2>/dev/null | head -c 4096 || true)"
  [[ -n "$BUILD_INFO_TEXT" ]] || die "产物里没有可读取的 BUILD_INFO。"
  build_sha="$(printf '%s\n' "$BUILD_INFO_TEXT" | sed -n 's/^sha=//p' | head -1 | tr -d '\r')"
  validate_hex40 "${build_sha:-invalid}"
  [[ "$build_sha" == "$expected_git" ]] || die \
    "BUILD_INFO 的 Git SHA 与预期不一致。
      期望: $expected_git
      实际: $build_sha"

  GIT_SHA="$build_sha"
}

cmd_check_artifact() {
  local scratch
  require_non_root
  scratch="$(mktemp -d /var/tmp/chaoge-check.XXXXXXXX)" || die "无法创建临时目录。"
  chmod 0700 "$scratch"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$scratch'" EXIT
  validate_artifact_file "$1" "$2" "$3" "$scratch"
  ok "产物校验通过"
  info "SHA-256: $ARTIFACT_SHA"
  info "Git SHA: $GIT_SHA"
  info "BUILD_INFO:"
  printf '%s\n' "$BUILD_INFO_TEXT" | sed 's/^/      /'
}

cmd_deploy() {
  local art_in="$1" expected_sha="$2" expected_git="$3"
  local canon size copy_at rel_id

  require_root
  setup_log
  take_lock
  require_initialized
  validate_hex64 "$expected_sha"
  validate_hex40 "$expected_git"
  artifact_path_policy "$art_in" "$expected_git"

  step "1/5 校验产物（root 私有副本）"
  PRIV_DIR="$(mktemp -d /var/tmp/chaoge-deploy.XXXXXXXX)" || die "无法创建 root 私有目录。"
  chmod 0700 "$PRIV_DIR"
  [[ "$(stat -c '%u:%a' "$PRIV_DIR")" == "0:700" ]] \
    || die "root 私有目录权限异常：$(stat -c '%u:%a' "$PRIV_DIR")"
  SCRATCH_DIR="$PRIV_DIR/scratch"
  mkdir -m 0700 "$SCRATCH_DIR"

  copy_at="$PRIV_DIR/artifact.tar.gz"
  timeout 120 install -o root -g root -m 0600 -- "$(readlink -f -- "$art_in")" "$copy_at" \
    || die "无法把产物复制到 root 私有目录（超时或写入失败）。"
  [[ "$(stat -c '%u:%g %a' "$copy_at")" == "0:0 600" ]] \
    || die "root 私有副本权限异常：$(stat -c '%u:%g %a' "$copy_at")"
  # 预检与复制之间源文件可能被替换；对副本再核一次上限，避免写满 /var/tmp。
  (( $(stat -c '%s' "$copy_at") <= MAX_ARTIFACT_BYTES )) \
    || die "root 私有副本超过大小上限（$(stat -c '%s' "$copy_at") 字节）。"

  validate_artifact_file "$copy_at" "$expected_sha" "$expected_git" "$SCRATCH_DIR"
  ok "SHA-256、Git SHA 与结构校验全部通过"
  info "SHA-256: $ARTIFACT_SHA"
  info "Git SHA: $GIT_SHA"
  printf '%s\n' "$BUILD_INFO_TEXT" | sed 's/^/      /'

  step "2/5 以 $MIGRATE_USER 身份执行数据库迁移"
  # 迁移代码不是来自本次 CI 产物，而是安装器一次性放进 /usr/local/lib/chaoge/src
  # 的 root 拥有快照（由 migration-code.sha256 校验过）。这样迁移代码的信任
  # 根是「人工安装的那一次」，而不是 deploy 可以自行替换的上传产物。
  local mig_pw mig_url
  mig_pw="$(read_secret MIGRATOR_PASSWORD)"
  mig_url="postgresql://$MIGRATOR_ROLE:$(urlencode "$mig_pw")@$DB_HOST:$DB_PORT/$DB_NAME"
  unset mig_pw
  exec 9< <(printf '%s\n' "$mig_url")
  unset mig_url

  env -i \
    PATH="$PATH" \
    HOME="$(getent passwd "$MIGRATE_USER" | cut -d: -f6)" \
    TMPDIR=/tmp LANG=C.UTF-8 \
    CHAOGE_SUDO='runuser -u postgres --' \
    CHAOGE_APP_DIR="$LIB_DIR/src" \
    CHAOGE_MIGRATE_AS="$MIGRATE_USER" \
    CHAOGE_NODE_BIN="$NODE_BIN" \
    bash "$LIB_DIR/db/deploy-staging.sh" migrate \
      --database "$DB_NAME" --migrator-url-fd 9 --non-interactive
  exec 9<&-
  ok "迁移完成（root 未执行产物代码）"

  step "3/5 写入最小测试数据并验收（root 拥有的 SQL）"
  env -i PATH="$PATH" LANG=C.UTF-8 CHAOGE_SUDO='runuser -u postgres --' \
    bash "$LIB_DIR/db/deploy-staging.sh" bootstrap \
      --database "$DB_NAME" --non-interactive
  env -i PATH="$PATH" LANG=C.UTF-8 CHAOGE_SUDO='runuser -u postgres --' \
    bash "$LIB_DIR/db/deploy-staging.sh" verify \
      --database "$DB_NAME" --non-interactive
  ok "数据库最小数据与隔离验收通过"

  step "4/5 安装版本并切换 current"
  rel_id="$(date -u '+%Y%m%dT%H%M%SZ')-${GIT_SHA:0:7}"
  if [[ -e "$RELEASES/$rel_id" ]]; then rel_id="$rel_id-$$"; fi
  [[ "$rel_id" =~ ^[A-Za-z0-9._-]+$ ]] || die "内部生成的 release-id 不合法：$rel_id"

  env -i PATH="$PATH" LANG=C.UTF-8 \
    bash "$LIB_DIR/app/install-release.sh" \
      --artifact "$copy_at" \
      --sha256 "$ARTIFACT_SHA" \
      --expected-sha "$GIT_SHA" \
      --release-id "$rel_id" \
      --keep 5
  ok "版本已安装：$rel_id"

  step "5/5 完成"
  info "ENTRY_VERSION: $ENTRY_VERSION"
  info "APP_GIT_SHA: $GIT_SHA"
  info "ARTIFACT_SHA256: $ARTIFACT_SHA"
  info "current -> $(readlink -f "$CURRENT")"
  info "is-enabled: $(systemctl is-enabled "$SERVICE" 2>&1)"
  info "is-active:  $(systemctl is-active "$SERVICE" 2>&1)"
  ss -ltnH 'sport = :3000' | sed 's/^/      /'
  ok "部署完成。日志：$LOG"
}

cmd_rollback() {
  require_root
  setup_log
  take_lock
  require_initialized
  step "回滚到最近的一个非当前版本"
  env -i PATH="$PATH" LANG=C.UTF-8 bash "$LIB_DIR/app/rollback.sh"
  ok "回滚完成。"
}

cmd_status() {
  require_root
  local current_sha="" perm_secret perm_env sudoers_state
  step "chaoge-deploy 状态"
  info "ENTRY_VERSION: $ENTRY_VERSION"
  info "入口: $ENTRY_PATH"
  info "入口哈希: $(sha256sum "$ENTRY_PATH" | awk '{print $1}')"
  if [[ -f "$SECRETS" && ! -L "$SECRETS" ]]; then
    perm_secret="$(stat -c '%U:%G %a' "$SECRETS")"
  else
    perm_secret="缺失"
  fi
  if [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]; then
    perm_env="$(stat -c '%U:%G %a' "$ENV_FILE")"
  else
    perm_env="缺失"
  fi
  info "凭据文件: $perm_secret（只显示权限，不显示内容）"
  info "环境文件: $perm_env（只显示权限，不显示内容）"
  if [[ -f "$SUDOERS_FILE" && ! -L "$SUDOERS_FILE" ]] \
     && [[ "$(stat -c '%u:%g %a' "$SUDOERS_FILE")" == "0:0 440" ]] \
     && grep -qx 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy' "$SUDOERS_FILE"; then
    sudoers_state="已安装（0440 root:root，单命令规则）"
  else
    sudoers_state="缺失或不符合预期"
  fi
  info "sudoers: $sudoers_state"
  if [[ -L "$CURRENT" || -d "$CURRENT" ]]; then
    info "current: $(readlink -f "$CURRENT")"
    current_sha="$(sed -n 's/^sha=//p' "$CURRENT/BUILD_INFO" 2>/dev/null | head -1 | tr -d '\r' || true)"
  else
    info "current: 缺失"
  fi
  info "BUILD_INFO sha: ${current_sha:-（不可读）}"
  info "is-enabled: $(systemctl is-enabled "$SERVICE" 2>&1)"
  info "is-active:  $(systemctl is-active "$SERVICE" 2>&1)"
  info "监听:"
  ss -ltnH 'sport = :3000' | sed 's/^/      /'
}

cmd_demo_data() {
  require_root
  setup_log
  take_lock
  require_initialized
  step "写入 staging 首页演示数据（仅 $DB_NAME）"
  env -i PATH="$PATH" LANG=C.UTF-8 CHAOGE_SUDO='runuser -u postgres --' \
    bash "$LIB_DIR/db/deploy-staging.sh" demo-data \
      --database "$DB_NAME" --non-interactive
  ok "首页演示数据已写入（只插入，可重复执行）"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    deploy)
      [[ $# -eq 4 ]] || { usage >&2; die "deploy 需要 3 个参数：artifact、sha256、git-sha"; }
      cmd_deploy "$2" "$3" "$4"
      ;;
    rollback)
      [[ $# -eq 1 ]] || { usage >&2; die "rollback 不接受任何参数"; }
      cmd_rollback
      ;;
    status)
      [[ $# -eq 1 ]] || { usage >&2; die "status 不接受任何参数"; }
      cmd_status
      ;;
    demo-data)
      [[ $# -eq 1 ]] || { usage >&2; die "demo-data 不接受任何参数"; }
      cmd_demo_data
      ;;
    check-artifact)
      [[ $# -eq 4 ]] || { usage >&2; die "check-artifact 需要 3 个参数：artifact、sha256、git-sha"; }
      cmd_check_artifact "$2" "$3" "$4"
      ;;
    -h|--help|help|"")
      usage
      [[ -n "$cmd" ]] || exit 2
      ;;
    *)
      usage >&2
      die "未知子命令「$cmd」。只接受 deploy / rollback / status / demo-data / check-artifact。"
      ;;
  esac
}

main "$@"
