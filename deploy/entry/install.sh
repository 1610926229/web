#!/usr/bin/env bash
#
# PROD-2 · 一次性安装受控部署入口（**必须以 root 运行**）
#
#     sudo bash <bundle>/deploy/entry/install.sh \
#         --bundle-dir <root 解压目录> \
#         [--source-tree /home/deploy/chaoge-deploy-src]
#
# 这是**唯一**需要人工输入 sudo 密码的动作。它完成后：
#
#   · /usr/local/sbin/chaoge-deploy 由 root 拥有、普通用户不可写
#   · /etc/sudoers.d/chaoge-deploy 只给 deploy 一条固定命令的 NOPASSWD 规则
#   · 数据库口令随机生成并写入 /etc/chaoge/staging.secrets（root:root 0600），
#     任何输出、日志、argv 都不包含口令明文
#   · chaoge_staging 建库/权限/角色口令就位
#   · /etc/chaoge/staging.env（root:root 0600）与 systemd 单元就位
#   · 迁移代码快照与 pg 依赖放到 /usr/local/lib/chaoge/src（root:root）
#   · 旧 bootstrap.log / prod2-finalize.log 归档到 root-only 目录（不删除）
#   · 安装前审计 deploy 的现有 sudo 规则，发现额外 NOPASSWD 即中止
#
# 安装器刻意**不**接收或解包应用产物：root 的写入路径里没有 deploy 可控的
# tar 文件。首版与后续发布统一走固定入口 chaoge-deploy deploy。
#
# 之后 Claude 可以非交互地运行：
#
#     ssh deploy@... sudo -n /usr/local/sbin/chaoge-deploy deploy ...
#
# ## 为什么安装器要校验 bundle manifest
#
# 安装器从人工校验过 SHA-256 的私有解压目录运行；在复制任何文件之前，
# 先按 deploy/trust/deploy-files.sha256 逐文件校验，避免 bundle 内容在
# 人工哈希校验之后被替换。

set -euo pipefail
umask 027
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH PYTHONPATH PERL5LIB

ENTRY_VERSION="prod2-installer-v2"
BUNDLE_DIR=""
SOURCE_TREE="${CHAOGE_SOURCE_TREE:-/home/deploy/chaoge-deploy-src}"

ENTRY_PATH="/usr/local/sbin/chaoge-deploy"
LIB_DIR="/usr/local/lib/chaoge"
UNIT_PATH="/etc/systemd/system/chaoge-staging.service"
CONF_DIR="/etc/chaoge"
SECRETS="$CONF_DIR/staging.secrets"
ENV_FILE="$CONF_DIR/staging.env"
SUDOERS_FILE="/etc/sudoers.d/chaoge-deploy"
SERVICE="chaoge-staging"
SERVICE_USER="chaoge"
MIGRATE_USER="deploy"
DB_NAME="chaoge_staging"
DB_HOST="127.0.0.1"
DB_PORT="5432"
MIGRATOR_ROLE="chaoge_staging_migrator"
APP_ROLE="chaoge_staging_app"
ROOT_DIR="/opt/chaoge-staging"
INCOMING_DIR="/home/deploy/incoming"
LOG_DIR="/var/log/chaoge"
LOG="$LOG_DIR/install.log"
LEGACY_LOG_ARCHIVE="$LOG_DIR/archive"
LEGACY_LOGS=(bootstrap.log prod2-finalize.log)
NODE_BIN="/usr/local/bin/node"

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

usage() {
  cat <<'USAGE'
用法: install.sh --bundle-dir DIR [--source-tree DIR]

  --bundle-dir DIR  已解压、已人工校验 SHA-256 的 bundle（含 deploy/ 与 src/）
  --source-tree DIR 复制 node_modules 的服务器源码目录
                    （默认 /home/deploy/chaoge-deploy-src）

安装本身**不接受也不执行任何应用产物**。首版及后续发布统一走：
  sudo -n /usr/local/sbin/chaoge-deploy deploy <artifact> <sha256> <git-sha>
因此安装器的 root 写入路径里不存在 deploy 可控制的文件解包步骤。
USAGE
}

cleanup() {
  [[ -n "${TMP_SECRETS:-}" && -f "$TMP_SECRETS" ]] && rm -f -- "$TMP_SECRETS"
  [[ -n "${TMP_SUDOERS:-}" && -f "$TMP_SUDOERS" ]] && rm -f -- "$TMP_SUDOERS"
  return 0
}
trap cleanup EXIT INT TERM HUP

# 目录就位。已存在时必须是**真实目录**：`install -d -o ...` 会跟随符号链接，
# 让 root 把链接目标 chown 给 deploy——那是直接的提权。
ensure_dir() {
  local dir="$1" owner="$2" mode="$3"
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" ]] || die "$dir 不是普通目录（可能是符号链接），拒绝继续。"
  else
    install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$dir" \
      || die "无法创建目录：$dir"
  fi
  chown "$owner" "$dir"
  chmod "$mode" "$dir"
}

# 安装前审计 deploy 已有的 sudo 授权。
#
# 本安装器只负责写入自己的单命令 NOPASSWD 规则，不修改也不删除别人的规则。
# 如果 deploy 已经拥有其它 NOPASSWD 命令（尤其 `ALL`），那么本设计的
# 「root 只能执行固定入口」边界就不成立；此时必须在动手前停下来，交给人
# 工处理，而不是带着未知的宽权限继续安装。
audit_existing_sudo_rules() {
  local out line after cmd
  local -a parts
  command -v sudo >/dev/null 2>&1 || die "找不到 sudo，无法审计已有授权。"

  if ! out="$(LC_ALL=C sudo -n -l -U "$MIGRATE_USER" 2>&1)"; then
    if grep -Eqi 'not allowed|may not run|is not in the sudoers' <<< "$out"; then
      ok "$MIGRATE_USER 当前没有 sudo 授权（安装器将写入唯一一条）"
      return 0
    fi
    warn "无法自动读取 $MIGRATE_USER 的 sudo 规则："
    printf '%s\n' "$out" | sed 's/^/      /' >&2
    die "请在安装前人工执行：sudo -l -U $MIGRATE_USER，确认没有额外 NOPASSWD 规则后重试。"
  fi

  info "现有 sudo 授权（$MIGRATE_USER）："
  printf '%s\n' "$out" | sed 's/^/      /'
  if printf '%s\n' "$out" | grep -qE '\(ALL[^)]*\).*NOPASSWD|NOPASSWD:[[:space:]]*ALL'; then
    warn "检测到 deploy 的 ALL / 免密 ALL 授权，请结合上面的输出人工确认。"
  elif printf '%s\n' "$out" | grep -qE '\(ALL[^)]*\)[[:space:]]+ALL([,[:space:]]|$)'; then
    warn "deploy 拥有带密码的 sudo ALL 授权；这不是免密规则，但请人工确认其确有必要。"
  fi

  while IFS= read -r line; do
    [[ "$line" == *NOPASSWD:* ]] || continue
    after="${line#*NOPASSWD:}"
    after="${after#"${after%%[![:space:]]*}"}"
    IFS=',' read -r -a parts <<< "$after"
    for cmd in "${parts[@]}"; do
      cmd="${cmd#"${cmd%%[![:space:]]*}"}"
      cmd="${cmd%"${cmd##*[![:space:]]}"}"
      [[ -z "$cmd" ]] && continue
      [[ "$cmd" == "$ENTRY_PATH" ]] \
        || die "发现额外的免密 sudo 授权：$line
      本安装器只允许 $ENTRY_PATH。请先人工清理该规则后重试；安装器不会修改其它 sudoers 规则。"
    done
  done <<< "$out"
  ok "sudo 预审计通过：没有 $ENTRY_PATH 以外的 NOPASSWD 命令"
}

# 旧流程的 bootstrap.log / prod2-finalize.log 可能记录了交互式输入。
# 安装器**不删除**历史日志，只把它们移入 /var/log/chaoge/archive/ 下
# root:root 0700 的独立目录，文件收敛为 root:root 0600，deploy 不再可读。
# 若历史路径本身是符号链接，移动链接本身而不读取目标。
archive_legacy_logs() {
  local found=0 name src dest stamp
  for name in "${LEGACY_LOGS[@]}"; do
    src="$LOG_DIR/$name"
    [[ -e "$src" || -L "$src" ]] && found=1
  done
  (( found )) || { info "没有需要归档的历史日志"; return 0; }

  if [[ -e "$LEGACY_LOG_ARCHIVE" || -L "$LEGACY_LOG_ARCHIVE" ]]; then
    [[ -d "$LEGACY_LOG_ARCHIVE" && ! -L "$LEGACY_LOG_ARCHIVE" ]] \
      || die "$LEGACY_LOG_ARCHIVE 不是普通目录，拒绝归档。"
  else
    install -d -o root -g root -m 0700 "$LEGACY_LOG_ARCHIVE" \
      || die "无法创建历史日志归档目录：$LEGACY_LOG_ARCHIVE"
  fi
  chown root:root "$LEGACY_LOG_ARCHIVE"
  chmod 0700 "$LEGACY_LOG_ARCHIVE"

  stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  dest="$LEGACY_LOG_ARCHIVE/$stamp"
  [[ -e "$dest" || -L "$dest" ]] && die "归档目录已存在，拒绝覆盖：$dest"
  install -d -o root -g root -m 0700 "$dest" || die "无法创建归档批次目录：$dest"

  for name in "${LEGACY_LOGS[@]}"; do
    src="$LOG_DIR/$name"
    [[ -e "$src" || -L "$src" ]] || continue
    if [[ -L "$src" ]]; then
      # 只移动链接本身，绝不跟随它读取目标。
      mv -- "$src" "$dest/$name" || die "无法归档历史日志链接：$src"
      chown -h root:root "$dest/$name" || die "无法收敛归档链接属主：$dest/$name"
    elif [[ -f "$src" ]]; then
      mv -- "$src" "$dest/$name" || die "无法归档历史日志：$src"
      chown root:root "$dest/$name" || die "无法收敛归档文件属主：$dest/$name"
      chmod 0600 "$dest/$name" || die "无法收敛归档文件权限：$dest/$name"
    else
      die "历史日志路径既不是普通文件也不是符号链接，拒绝移动：$src"
    fi
  done
  ok "历史日志已归档到 $dest（root:root 0700；内容未读取、未删除）"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dir) BUNDLE_DIR="${2:?--bundle-dir 需要一个目录}"; shift 2 ;;
    --source-tree) SOURCE_TREE="${2:?--source-tree 需要一个目录}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行：要安装 /usr/local/sbin、写入 /etc 与 sudoers。"
[[ -n "$BUNDLE_DIR" ]] || { usage >&2; die "缺少 --bundle-dir"; }
[[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || die "bundle 目录不存在或是符号链接：$BUNDLE_DIR"
BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)" || die "无法解析 bundle 目录。"
SOURCE_TREE="$(cd "$SOURCE_TREE" 2>/dev/null && pwd)" \
  || die "源码目录不存在：$SOURCE_TREE"
[[ "$(stat -c '%u' "$BUNDLE_DIR")" == "0" ]] \
  || die "bundle 根目录不属于 root，拒绝安装（必须先解包到 root 私有目录）。"
[[ -z "$(find "$BUNDLE_DIR" -xdev -type l -print -quit)" ]] \
  || die "bundle 里出现了符号链接，拒绝安装。"
[[ -z "$(find "$BUNDLE_DIR" -xdev ! -user root -print -quit)" ]] \
  || die "bundle 中存在不属于 root 的路径，拒绝在可能被替换的内容上执行 root 安装。"
[[ -z "$(find "$BUNDLE_DIR" -xdev ! -type l \
        \( -perm -0020 -o -perm -0002 \) -print -quit)" ]] \
  || die "bundle 中存在组/其他用户可写的路径，拒绝在可能被替换的内容上执行 root 安装。"
[[ -f "$BUNDLE_DIR/deploy/trust/deploy-files.sha256" ]] || die "bundle 缺少 deploy/trust/deploy-files.sha256"
[[ -f "$BUNDLE_DIR/deploy/trust/migration-code.sha256" ]] || die "bundle 缺少 deploy/trust/migration-code.sha256"
[[ -d "$BUNDLE_DIR/src" && ! -L "$BUNDLE_DIR/src" ]] || die "bundle 缺少 src/（迁移代码快照）"

# ── 0. 日志（root 控制）──────────────────────────────────────────────────────

if [[ -e "$LOG_DIR" || -L "$LOG_DIR" ]]; then
  [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] || die "$LOG_DIR 不是普通目录，拒绝继续。"
  [[ "$(stat -c '%u' "$LOG_DIR")" == "0" ]] || die "$LOG_DIR 的属主不是 root。"
else
  install -d -o root -g "$MIGRATE_USER" -m 0750 "$LOG_DIR"
fi
chown root:"$MIGRATE_USER" "$LOG_DIR"; chmod 0750 "$LOG_DIR"
[[ -L "$LOG" ]] && die "日志路径是符号链接：$LOG"
[[ -e "$LOG" && ! -f "$LOG" ]] && die "日志路径不是普通文件：$LOG"
[[ -e "$LOG" ]] || install -o root -g root -m 0600 /dev/null "$LOG"
chown root:root "$LOG"; chmod 0600 "$LOG"
exec > >(tee -a "$LOG") 2>&1

info "installer: $ENTRY_VERSION"
info "开始时间: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "bundle: $BUNDLE_DIR"
info "日志: $LOG"

# ── 0. 安装前审计与历史日志归档 ─────────────────────────────────────────────

step "0/7 安装前审计：sudo 授权与历史日志"
audit_existing_sudo_rules
archive_legacy_logs

# ── 1. bundle 完整性 ─────────────────────────────────────────────────────────

step "1/7 校验 bundle manifest"
( cd "$BUNDLE_DIR" && sha256sum -c --quiet deploy/trust/deploy-files.sha256 ) \
  || die "bundle 的 deploy-files.sha256 校验失败，拒绝安装。"
( cd "$BUNDLE_DIR/src" && sha256sum -c --quiet "$BUNDLE_DIR/deploy/trust/migration-code.sha256" ) \
  || die "bundle 的 migration-code.sha256 校验失败，拒绝安装。"

for f in \
  deploy/entry/chaoge-deploy.sh \
  deploy/app/install-release.sh \
  deploy/app/rollback.sh \
  deploy/app/setup-staging-env.sh \
  deploy/app/_common.sh \
  deploy/app/chaoge-staging.service \
  deploy/app/README.md \
  deploy/db/staging/deploy-staging.sh \
  deploy/db/staging/01-create-roles.sql \
  deploy/db/staging/02-harden-public.sql \
  deploy/db/staging/03-grants.sql \
  deploy/db/staging/04-default-privileges.sql \
  deploy/db/staging/05-table-grants.sql \
  deploy/db/staging/06-bootstrap-data.sql \
  deploy/db/staging/99-verify.sql ; do
  [[ -f "$BUNDLE_DIR/$f" && ! -L "$BUNDLE_DIR/$f" ]] || die "bundle 缺少普通文件：$f"
done
[[ -d "$SOURCE_TREE/node_modules" && ! -L "$SOURCE_TREE/node_modules" ]] \
  || die "找不到迁移依赖目录：$SOURCE_TREE/node_modules（需要 pg）。"
ok "bundle manifest 与必需文件齐全"

# ── 2. 安装固定代码与单元 ────────────────────────────────────────────────────

step "2/7 安装 root 拥有的受控入口与固定脚本"
ensure_dir "$LIB_DIR" root:root 0755
ensure_dir "$LIB_DIR/app" root:root 0755
ensure_dir "$LIB_DIR/db" root:root 0755

install_file() {
  local src="$1" dst="$2" mode="$3"
  # install(1) 会跟随目标位置已有的符号链接；先删除链接本身，绝不让 root
  # 的写入落到链接目标上。这些目标目录都只有 root 可写，这里是纵深防御。
  [[ -L "$dst" ]] && rm -f -- "$dst"
  install -o root -g root -m "$mode" "$BUNDLE_DIR/$src" "$dst"
}

install_file deploy/entry/chaoge-deploy.sh "$ENTRY_PATH" 0755
install_file deploy/app/_common.sh "$LIB_DIR/app/_common.sh" 0640
install_file deploy/app/install-release.sh "$LIB_DIR/app/install-release.sh" 0750
install_file deploy/app/rollback.sh "$LIB_DIR/app/rollback.sh" 0750
install_file deploy/app/setup-staging-env.sh "$LIB_DIR/app/setup-staging-env.sh" 0750
install_file deploy/app/chaoge-staging.service "$LIB_DIR/app/chaoge-staging.service" 0644
install_file deploy/app/README.md "$LIB_DIR/app/README.md" 0644
install_file deploy/db/staging/deploy-staging.sh "$LIB_DIR/db/deploy-staging.sh" 0750
for sql in 01-create-roles.sql 02-harden-public.sql 03-grants.sql \
           04-default-privileges.sql 05-table-grants.sql \
           06-bootstrap-data.sql 99-verify.sql; do
  install_file "deploy/db/staging/$sql" "$LIB_DIR/db/$sql" 0640
done
install_file deploy/app/chaoge-staging.service "$UNIT_PATH" 0644

# 安装后逐文件复核：源与目标哈希必须一致。
for pair in \
  "deploy/entry/chaoge-deploy.sh:$ENTRY_PATH" \
  "deploy/app/_common.sh:$LIB_DIR/app/_common.sh" \
  "deploy/app/install-release.sh:$LIB_DIR/app/install-release.sh" \
  "deploy/app/rollback.sh:$LIB_DIR/app/rollback.sh" \
  "deploy/app/setup-staging-env.sh:$LIB_DIR/app/setup-staging-env.sh" \
  "deploy/db/staging/deploy-staging.sh:$LIB_DIR/db/deploy-staging.sh" \
  "deploy/app/chaoge-staging.service:$UNIT_PATH" ; do
  src="${pair%%:*}"
  dst="${pair#*:}"
  [[ "$(sha256sum "$BUNDLE_DIR/$src" | awk '{print $1}')" == \
     "$(sha256sum "$dst" | awk '{print $1}')" ]] \
    || die "安装后哈希不一致：$dst"
done
[[ "$(stat -c '%u:%g %a' "$ENTRY_PATH")" == "0:0 755" ]] \
  || die "入口权限异常：$(stat -c '%u:%g %a' "$ENTRY_PATH")"
ok "受控入口：$ENTRY_PATH（root:root 0755）"

# ── 3. 服务账号与目录 ────────────────────────────────────────────────────────

step "3/7 服务账号与目录"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "账号 $SERVICE_USER 已存在，不重建"
else
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --no-create-home --home-dir "$ROOT_DIR" \
          --shell "$NOLOGIN" --comment "超哥电竞 staging runtime" "$SERVICE_USER"
fi
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qxE 'sudo|wheel|adm'; then
  die "账号 $SERVICE_USER 属于提权组（$(id -nG "$SERVICE_USER")）。"
fi
SHELL_OF="$(getent passwd "$SERVICE_USER" | cut -d: -f7)"
case "$SHELL_OF" in
  */nologin|*/false) ;;
  *) die "账号 $SERVICE_USER 的 shell 是「$SHELL_OF」，应为 nologin。" ;;
esac

id -u "$MIGRATE_USER" >/dev/null 2>&1 || die "迁移账号 $MIGRATE_USER 不存在。"
MIG_HOME="$(getent passwd "$MIGRATE_USER" | cut -d: -f6)"
[[ -n "$MIG_HOME" ]] || die "读不到 $MIGRATE_USER 的家目录。"

ensure_dir "$ROOT_DIR" "root:$SERVICE_USER" 0750
ensure_dir "$ROOT_DIR/releases" root:root 0755
ensure_dir "$CONF_DIR" root:root 0750
ensure_dir "$LOG_DIR" "root:$MIGRATE_USER" 0750
# /home/deploy 属于 deploy；其中被换成符号链接的 incoming 直接移除（链接本身
# 可安全删除），再建真实目录。root 绝不跟随该链接写文件。
[[ -L "$INCOMING_DIR" ]] && rm -f -- "$INCOMING_DIR"
ensure_dir "$INCOMING_DIR" "$MIGRATE_USER:$MIGRATE_USER" 0750
ok "目录：$ROOT_DIR（root:$SERVICE_USER 0750）、releases（root:root 0755）、$CONF_DIR（root:root 0750）"

# ── 3.1 迁移代码快照（root 拥有）──────────────────────────────────────────────
#
# 迁移代码不来自 deploy 可替换的上传产物，而是来自人工校验过的 bundle src/
# （migration-code.sha256 已在上一步验证）。受控入口每次部署都以 deploy 身份
# 执行这里的代码；root 只读文件、不执行其中的模块。
step "3/7 安装 root 拥有的迁移代码快照"
# 整棵树重建：避免上一次安装留下的中间路径符号链接被 install -D 跟随。
if [[ -e "$LIB_DIR/src" || -L "$LIB_DIR/src" ]]; then
  [[ -d "$LIB_DIR/src" && ! -L "$LIB_DIR/src" ]] \
    || die "$LIB_DIR/src 不是普通目录，拒绝继续。"
  rm -rf -- "$LIB_DIR/src" || die "无法清理旧的迁移代码快照：$LIB_DIR/src"
fi
ensure_dir "$LIB_DIR/src" root:root 0755
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  rel="${line:66}"
  [[ -n "$rel" ]] || die "migration-code.sha256 行格式不正确：$line"
  case "$rel" in
    /*|..|../*|*/../*|*/..) die "迁移 manifest 包含不安全的路径：$rel" ;;
  esac
  [[ -f "$BUNDLE_DIR/src/$rel" && ! -L "$BUNDLE_DIR/src/$rel" ]] \
    || die "bundle 缺少普通迁移文件：src/$rel"
  install -D -o root -g root -m 0644 "$BUNDLE_DIR/src/$rel" "$LIB_DIR/src/$rel"
done < "$BUNDLE_DIR/deploy/trust/migration-code.sha256"

# 迁移只需要 pg；从服务器现有源码树复制 node_modules。源码树属于 deploy，
# 但复制后整体归 root 所有；其中的符号链接必须留在快照内部。
rm -rf -- "$LIB_DIR/src/node_modules"
cp -a "$SOURCE_TREE/node_modules" "$LIB_DIR/src/node_modules"
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  case "$target" in
    /*) die "迁移依赖里存在绝对符号链接，拒绝：$link -> $target" ;;
  esac
  resolved="$(realpath -m -- "$(dirname "$link")/$target")"
  case "$resolved" in
    "$LIB_DIR/src/"*) ;;
    *) die "迁移依赖的符号链接逃逸出快照，拒绝：$link -> $target" ;;
  esac
done < <(find "$LIB_DIR/src/node_modules" -type l -print0)

chown -R root:root "$LIB_DIR/src"
chmod -R a+rX,go-w "$LIB_DIR/src"
find "$LIB_DIR/src" -xdev \( -perm -4000 -o -perm -2000 \) -exec chmod u-s,g-s {} +
[[ -z "$(find "$LIB_DIR/src" -xdev \( -perm -4000 -o -perm -2000 \) -print -quit)" ]] \
  || die "迁移代码快照里仍有 setuid/setgid 文件，拒绝继续。"
[[ -z "$(find "$LIB_DIR/src" -xdev ! -type l \( -perm -0020 -o -perm -0002 \) -print -quit)" ]] \
  || die "迁移代码快照里存在组/其他用户可写的路径，拒绝继续。"
( cd "$LIB_DIR/src" && sha256sum -c --quiet "$BUNDLE_DIR/deploy/trust/migration-code.sha256" ) \
  || die "安装后的迁移代码快照与 manifest 不一致。"

# 以迁移身份冒烟加载 pg。以 deploy 执行（它本来就是部署时的迁移身份），
# root 不执行从这里加载的任何模块。
if ! ( cd "$LIB_DIR/src" && runuser -u "$MIGRATE_USER" -- env -i \
        PATH=/usr/local/bin:/usr/bin:/bin HOME="$MIG_HOME" TMPDIR=/tmp LANG=C.UTF-8 \
        "$NODE_BIN" --input-type=module -e \
        'const pg = await import("pg"); if (typeof pg.default.Pool !== "function") process.exit(1);' ); then
  die "以 $MIGRATE_USER 身份无法从 $LIB_DIR/src 加载 pg。"
fi
ok "迁移代码快照：$LIB_DIR/src（root:root，manifest 一致，deploy 可加载 pg）"

# ── 4. 凭据 ──────────────────────────────────────────────────────────────────

step "4/7 数据库口令（生成一次，不输出明文）"
command -v openssl >/dev/null 2>&1 || die "找不到 openssl，无法生成随机口令。"

read_secret() {
  local key="$1" line
  line="$(grep -E "^${key}=[0-9a-f]{64}$" "$SECRETS" | head -1 || true)"
  [[ -n "$line" ]] || die "凭据文件缺少或格式错误：$key"
  printf '%s' "${line#*=}"
}

if [[ -e "$SECRETS" || -L "$SECRETS" ]]; then
  [[ -f "$SECRETS" && ! -L "$SECRETS" ]] || die "$SECRETS 不是普通文件。"
  chown root:root "$SECRETS"; chmod 0600 "$SECRETS"
  MIG_PW="$(read_secret MIGRATOR_PASSWORD)"
  APP_PW="$(read_secret APP_PASSWORD)"
  ok "沿用现有凭据文件（权限已收敛为 root:root 0600）"
else
  MIG_PW="$(openssl rand -hex 32)"
  APP_PW="$(openssl rand -hex 32)"
  TMP_SECRETS="$(mktemp "$CONF_DIR/.staging.secrets.XXXXXXXX")"
  chmod 0600 "$TMP_SECRETS"
  printf 'MIGRATOR_PASSWORD=%s\nAPP_PASSWORD=%s\n' "$MIG_PW" "$APP_PW" > "$TMP_SECRETS"
  chown root:root "$TMP_SECRETS"
  chmod 0600 "$TMP_SECRETS"
  mv -f "$TMP_SECRETS" "$SECRETS"
  TMP_SECRETS=""
  ok "已生成随机口令并写入 $SECRETS（root:root 0600；内容未输出）"
fi
[[ "$(stat -c '%u:%g %a' "$SECRETS")" == "0:0 600" ]] \
  || die "凭据文件权限异常：$(stat -c '%u:%g %a' "$SECRETS")"

# ── 5. 数据库初始化与口令收敛 ────────────────────────────────────────────────

step "5/7 chaoge_staging 建库 / 权限 / 角色口令"
command -v psql >/dev/null 2>&1 || die "找不到 psql。"
command -v runuser >/dev/null 2>&1 || die "找不到 runuser。"
[[ -x "$NODE_BIN" ]] || die "Node 不存在或不可执行：$NODE_BIN"

psql_admin() {
  runuser -u postgres -- psql -w -v ON_ERROR_STOP=1 "$@"
}

# 把明文口令转换成 PostgreSQL 的 SCRAM-SHA-256 校验子。
# 这样发给 PostgreSQL 的 SQL 里只有校验子，没有明文；即使服务端日志或
# pg_stat_statements 记录了语句，拿到的也不是可直接登录的口令。
# 明文只经 stdin 管道进入 Node，不进入 argv / 环境变量 / 文件。
make_scram_verifier() {
  local pw="$1" out
  out="$(printf '%s' "$pw" | "$NODE_BIN" --input-type=module -e '
    import { pbkdf2Sync, createHmac, createHash, randomBytes } from "node:crypto";
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const pw = Buffer.concat(chunks).toString("utf8");
    const iterations = 4096;
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(pw, salt, iterations, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();
    const serverKey = createHmac("sha256", salted).update("Server Key").digest();
    process.stdout.write(
      `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`,
    );
  ')" || die "生成 SCRAM 校验子失败。"
  [[ "$out" =~ ^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]] \
    || die "生成的 SCRAM 校验子格式不正确。"
  printf '%s' "$out"
}

if [[ "$(psql_admin -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == "1" ]]; then
  ok "$DB_NAME 已存在"
else
  env -i PATH="$PATH" LANG=C.UTF-8 \
    bash "$LIB_DIR/db/deploy-staging.sh" create --database "$DB_NAME" --non-interactive
fi

env -i PATH="$PATH" LANG=C.UTF-8 \
  bash "$LIB_DIR/db/deploy-staging.sh" init --database "$DB_NAME" --non-interactive

# 只把 SCRAM 校验子发给 psql：明文不进入 SQL、日志、argv 或环境变量。
MIG_VERIFIER="$(make_scram_verifier "$MIG_PW")"
APP_VERIFIER="$(make_scram_verifier "$APP_PW")"
{
  printf '\\set VERBOSITY terse\n'
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$MIGRATOR_ROLE" "$MIG_VERIFIER"
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$APP_ROLE" "$APP_VERIFIER"
} | PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic' \
      runuser -u postgres -- psql -w -v ON_ERROR_STOP=1 -d postgres -q
unset MIG_PW MIG_VERIFIER APP_VERIFIER

ok "角色口令已与 $SECRETS 对齐（只发送 SCRAM 校验子，未输出明文）"

# 运行时环境文件：应用口令经匿名 fd 进入，不经过 argv/环境变量。
exec 9< <(printf '%s\n' "$APP_PW")
unset APP_PW
env -i PATH="$PATH" LANG=C.UTF-8 \
  bash "$LIB_DIR/app/setup-staging-env.sh" \
    --path "$ENV_FILE" \
    --database "$DB_NAME" \
    --role "$APP_ROLE" \
    --host "$DB_HOST" \
    --port "$DB_PORT" \
    --password-fd 9 \
    --force
exec 9<&-
[[ "$(stat -c '%u:%g %a' "$ENV_FILE")" == "0:0 600" ]] \
  || die "运行时环境文件权限异常：$(stat -c '%u:%g %a' "$ENV_FILE")"
ok "运行时环境文件：$ENV_FILE（root:root 0600）"

# ── 6. systemd 与受控 sudoers ────────────────────────────────────────────────

step "6/7 systemd 单元与 sudoers 受控规则"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
ok "systemd 单元已启用（尚未启动，等待首版发布）"

command -v visudo >/dev/null 2>&1 || die "找不到 visudo，拒绝在未校验语法的情况下写入 sudoers。"
[[ -d /etc/sudoers.d && ! -L /etc/sudoers.d ]] || die "/etc/sudoers.d 不是普通目录。"

TMP_SUDOERS="$(mktemp /etc/sudoers.d/.chaoge-deploy.XXXXXXXX)"
cat > "$TMP_SUDOERS" <<'EOS'
# 超哥电竞 staging 受控部署入口（PROD-2）
# 只有这一条命令；没有通配符、没有 ALL、没有 shell。
# 参数校验由 /usr/local/sbin/chaoge-deploy 自身完成，入口是 root 拥有、deploy 不可写。
deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
EOS
chown root:root "$TMP_SUDOERS"
chmod 0440 "$TMP_SUDOERS"
visudo -cf "$TMP_SUDOERS" >/dev/null || die "sudoers 规则语法校验失败，未安装。"
mv -f "$TMP_SUDOERS" "$SUDOERS_FILE"
TMP_SUDOERS=""
if ! visudo -c >/dev/null; then
  # 语法错误会让之后所有 sudo 失效，立即撤回本次写入。
  rm -f "$SUDOERS_FILE"
  die "全局 sudoers 校验失败，已撤回 $SUDOERS_FILE。"
fi
[[ "$(stat -c '%u:%g %a' "$SUDOERS_FILE")" == "0:0 440" ]] \
  || die "sudoers 文件权限异常：$(stat -c '%u:%g %a' "$SUDOERS_FILE")"
ok "sudoers：$SUDOERS_FILE（0440 root:root，单命令 NOPASSWD）"

# 以 deploy 身份做一次真实的免密调用：这条检查失败则整个安装视为失败。
if ! runuser -u "$MIGRATE_USER" -- sudo -n "$ENTRY_PATH" status >/dev/null 2>&1; then
  die "以 $MIGRATE_USER 身份执行 sudo -n $ENTRY_PATH status 失败。
      安装未完成：请检查 $SUDOERS_FILE 是否被其它 sudoers 规则覆盖（例如 requiretty）。"
fi
ok "已验证 $MIGRATE_USER 可免密调用固定入口（sudo -n）"

# ── 7. 后续 ─────────────────────────────────────────────────────────────────

step "7/7 后续部署（不需要再输入 sudo 或数据库口令）"
warn "服务尚未启动：还没有发布过任何版本。"
info "  1. 以 deploy 身份上传产物到 $INCOMING_DIR/："
info "       staging-standalone-<git-sha>.tar.gz"
info "  2. 执行固定入口（deploy 可免密，Claude 可自动完成）："
info "       sudo -n $ENTRY_PATH deploy $INCOMING_DIR/staging-standalone-<git-sha>.tar.gz <sha256> <git-sha>"

step "完成"
info "受控入口: $ENTRY_PATH"
info "sudoers:  $SUDOERS_FILE"
info "凭据:     $SECRETS（root:root 0600，内容未输出）"
info "环境:     $ENV_FILE（root:root 0600）"
info "服务:     $SERVICE（is-enabled=$(systemctl is-enabled "$SERVICE" 2>&1)）"
ok "安装完成。后续部署不再需要人工输入 sudo 或数据库口令。"
