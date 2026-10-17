#!/usr/bin/env bash
#
# PROD-2 · 建立 root 信任快照并执行服务器侧收尾（**必须以 root 运行**）
#
# 这个脚本**不在** deploy 用户可写的目录里长期存在：它从一个人工校验过
# SHA-256 的 bundle 中解压出来，只运行这一次。它做三件事：
#
#   1. 校验 bundle 里的部署脚本 manifest（deploy/trust/deploy-files.sha256）
#   2. 在 /opt 下构建 root:root、组/其他用户不可写的信任目录
#      /opt/chaoge-deploy-trust/
#        deploy/      ← 本次修复后的部署脚本（deploy 可读、不可写）
#        src/         ← APP_GIT_SHA 对应的迁移代码（root 拥有，deploy 只读）
#        src/node_modules/ ← 从服务器现有安装复制，仅由 deploy 身份执行
#   3. 从新快照调用 deploy/app/finalize-staging.sh
#
# ## 两个版本号
#
#   APP_GIT_SHA=8ad9d6b…   CI 产物 / 迁移代码的提交（不随部署脚本修复而改变）
#   bundle SHA-256          本次部署脚本修复的打包哈希（人工命令里钉死）
#
# 部署脚本的 Git 提交与 APP_GIT_SHA 是**两个不同的 SHA**。不要把后者写进
# BUILD_INFO —— 那会让服务器安装一个并不存在的产物版本。
#
# ## 为什么 node_modules 从服务器现有目录复制
#
# 迁移只需要 `pg`。服务器上的 `/home/deploy/chaoge-deploy-src/node_modules`
# 是 deploy 拥有、内容可能被 deploy 改动的；把它复制进 root 快照**不会**带来
# 提权：finalizer 只以 deploy 身份执行迁移，root 从不执行这些模块。
# 好处是 bundle 不必携带 450MB，且迁移代码与依赖保持同机同版本。
# bootstrap 会扫描符号链接，拒绝任何指向快照之外的链接。
#
# ## 用法（由人工执行的单条命令调用）
#
#   sudo bash <bundle>/deploy/trust/bootstrap.sh \
#       --bundle-dir <root 解压目录> \
#       --artifact /tmp/staging-standalone-<APP_SHA>.tar.gz \
#       [--drill]

set -euo pipefail

APP_GIT_SHA="8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07"
TRUST_DIR="/opt/chaoge-deploy-trust"
SOURCE_TREE="/home/deploy/chaoge-deploy-src"
LOG_DIR="/var/log/chaoge"
LOG="$LOG_DIR/bootstrap.log"
MIGRATE_USER="deploy"
NODE_BIN="/usr/local/bin/node"

BUNDLE_DIR=""
ARTIFACT=""
DRILL=0
NEW=""
OLD=""

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

usage() {
  cat <<'USAGE'
用法: bootstrap.sh --bundle-dir DIR --artifact FILE [--drill] [--source-tree DIR]

  --bundle-dir DIR   已解压的信任 bundle（含 deploy/ 与 src/）
  --artifact FILE    CI 产物 tar.gz（finalizer 会再次校验 SHA-256 与 BUILD_INFO）
  --source-tree DIR  复制 node_modules 的服务器源码目录（默认 /home/deploy/chaoge-deploy-src）
  --drill            发布失败自动回滚演练（与 finalize-staging.sh 相同）
USAGE
}

cleanup() {
  [[ -n "${NEW:-}" && -d "$NEW" ]] && rm -rf -- "$NEW"
  if [[ -n "${OLD:-}" && -d "$OLD" && ! -e "$TRUST_DIR" ]]; then
    mv "$OLD" "$TRUST_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dir)  BUNDLE_DIR="${2:?--bundle-dir 需要一个目录}"; shift 2 ;;
    --artifact)    ARTIFACT="${2:?--artifact 需要一个文件}"; shift 2 ;;
    --source-tree) SOURCE_TREE="${2:?--source-tree 需要一个目录}"; shift 2 ;;
    --drill)       DRILL=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行。"
[[ -n "$BUNDLE_DIR" ]] || { usage >&2; die "缺少 --bundle-dir"; }
[[ -n "$ARTIFACT" ]] || { usage >&2; die "缺少 --artifact"; }
[[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || die "bundle 目录不存在或是符号链接：$BUNDLE_DIR"
[[ -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || die "产物不存在或是符号链接：$ARTIFACT"
[[ -x "$NODE_BIN" ]] || die "Node 不存在或不可执行：$NODE_BIN"
id -u "$MIGRATE_USER" >/dev/null 2>&1 || die "迁移执行账号不存在：$MIGRATE_USER"
command -v sha256sum >/dev/null 2>&1 || die "找不到 sha256sum"
command -v runuser >/dev/null 2>&1 || die "找不到 runuser"

# ── 日志（root 控制）────────────────────────────────────────────────────────

if [[ -e "$LOG_DIR" || -L "$LOG_DIR" ]]; then
  [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] || die "$LOG_DIR 不是普通目录。"
  [[ "$(stat -c %u "$LOG_DIR")" == "0" ]] || die "$LOG_DIR 的属主不是 root。"
else
  install -d -o root -g "$MIGRATE_USER" -m 0750 "$LOG_DIR"
fi
chown root:"$MIGRATE_USER" "$LOG_DIR"; chmod 0750 "$LOG_DIR"
[[ -L "$LOG" ]] && die "日志路径是符号链接：$LOG"
[[ ! -e "$LOG" ]] && install -o root -g "$MIGRATE_USER" -m 0640 /dev/null "$LOG"
chown root:"$MIGRATE_USER" "$LOG"; chmod 0640 "$LOG"
exec > >(tee -a "$LOG") 2>&1

info "bootstrap 开始: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "APP_GIT_SHA（CI 产物 / 迁移代码）: $APP_GIT_SHA"
info "bundle: $BUNDLE_DIR"
info "日志: $LOG"

# ── 1. 校验 bundle ───────────────────────────────────────────────────────────

step "1/5 校验 bundle 内容"
[[ -f "$BUNDLE_DIR/deploy/trust/deploy-files.sha256" ]] \
  || die "bundle 缺少 deploy/trust/deploy-files.sha256"
[[ -f "$BUNDLE_DIR/deploy/trust/migration-code.sha256" ]] \
  || die "bundle 缺少 deploy/trust/migration-code.sha256"
[[ -f "$BUNDLE_DIR/deploy/app/finalize-staging.sh" ]] \
  || die "bundle 缺少 finalize-staging.sh"
[[ -d "$BUNDLE_DIR/src" ]] || die "bundle 缺少 src/（迁移代码快照）"

# bundle 由 git archive 生成，正常不含符号链接；出现即拒绝。
[[ -z "$(find "$BUNDLE_DIR/deploy" "$BUNDLE_DIR/src" -type l -print -quit)" ]] \
  || die "bundle 里出现了符号链接，拒绝复制。"

# manifest 路径守卫：拒绝绝对路径与 ..，防止 manifest 把复制目标引到快照之外。
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path="${line:66}"
  [[ -n "$path" ]] || die "manifest 行格式不正确：$line"
  case "$path" in
    /*|..|../*|*/../*|*/..) die "manifest 包含不安全的路径：$path" ;;
  esac
done < "$BUNDLE_DIR/deploy/trust/deploy-files.sha256"
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path="${line:66}"
  case "$path" in
    /*|..|../*|*/../*|*/..) die "迁移 manifest 包含不安全的路径：$path" ;;
  esac
done < "$BUNDLE_DIR/deploy/trust/migration-code.sha256"

( cd "$BUNDLE_DIR" && sha256sum -c --quiet deploy/trust/deploy-files.sha256 ) \
  || die "bundle 部署文件 manifest 校验失败。"
( cd "$BUNDLE_DIR/src" && sha256sum -c --quiet "$BUNDLE_DIR/deploy/trust/migration-code.sha256" ) \
  || die "bundle 迁移代码 manifest 校验失败。"
ok "bundle 的部署文件与迁移代码 manifest 均通过"

# ── 2. 构建新快照 ────────────────────────────────────────────────────────────

step "2/5 构建 root 拥有的快照"
NEW="$(mktemp -d /opt/.chaoge-deploy-trust.XXXXXX)"
chmod 0700 "$NEW"
mkdir -p "$NEW/deploy" "$NEW/src"

# 2.1 部署文件：逐个 install，属主/权限归一，不依赖 cp 的 umask。
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path="${line:66}"
  install -D -o root -g root -m 0644 "$BUNDLE_DIR/$path" "$NEW/$path"
done < "$BUNDLE_DIR/deploy/trust/deploy-files.sha256"
install -D -o root -g root -m 0644 \
  "$BUNDLE_DIR/deploy/trust/deploy-files.sha256" "$NEW/deploy/trust/deploy-files.sha256"

# 2.2 迁移代码：只复制 manifest 列出的文件（来自 git 8ad9d6b 的 src/）。
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path="${line:66}"
  [[ -f "$BUNDLE_DIR/src/$path" ]] || die "bundle 缺少迁移文件：src/$path"
  install -D -o root -g root -m 0644 "$BUNDLE_DIR/src/$path" "$NEW/src/$path"
done < "$BUNDLE_DIR/deploy/trust/migration-code.sha256"

# 2.3 node_modules：从服务器现有目录复制。只由 deploy 身份执行，root 不执行。
[[ -d "$SOURCE_TREE/node_modules" ]] || die "找不到 $SOURCE_TREE/node_modules（迁移依赖 pg）。"
info "复制 node_modules（$(du -sh "$SOURCE_TREE/node_modules" | cut -f1)）…"
cp -a "$SOURCE_TREE/node_modules" "$NEW/src/node_modules"

# 符号链接必须留在快照内部：绝对链接或 ../ 逃逸会让 deploy 在快照外替换依赖。
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  case "$target" in
    /*) die "node_modules 里存在绝对符号链接，拒绝：$link -> $target" ;;
  esac
  resolved="$(realpath -m "$(dirname "$link")/$target")"
  case "$resolved" in
    "$NEW/src/"*) ;;
    *) die "node_modules 符号链接逃逸出快照，拒绝：$link -> $target" ;;
  esac
done < <(find "$NEW/src/node_modules" -type l -print0)

chown -R root:root "$NEW"
chmod -R a+rX,go-w "$NEW"
# 目录本身必须可被 deploy 进入（0755），但不能被写。
find "$NEW" -type d -exec chmod 0755 {} +
find "$NEW" -type f -exec chmod u+rw,go+r,go-w {} +

# 复制完整性复核：任何字节与 manifest 不符都不得进入信任目录。
( cd "$NEW" && sha256sum -c --quiet deploy/trust/deploy-files.sha256 ) \
  || die "快照复制后部署文件校验失败。"
( cd "$NEW/src" && sha256sum -c --quiet "$NEW/deploy/trust/migration-code.sha256" ) \
  || die "快照复制后迁移代码校验失败。"
ok "快照文件与 manifest 一致"

# 2.4 依赖 smoke test：以 deploy 身份（finalizer 执行迁移的身份）导入 pg。
MIGRATE_HOME="$(getent passwd "$MIGRATE_USER" | cut -d: -f6)"
[[ -n "$MIGRATE_HOME" ]] || MIGRATE_HOME="/home/$MIGRATE_USER"
( cd "$NEW/src" && runuser -u "$MIGRATE_USER" -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME="$MIGRATE_HOME" \
    TMPDIR=/tmp LANG=C.UTF-8 \
    "$NODE_BIN" --input-type=module -e 'const pg = await import("pg"); if (typeof pg.default.Pool !== "function") process.exit(1);' ) \
  || die "以 $MIGRATE_USER 身份无法从快照加载 pg。"
ok "以 $MIGRATE_USER 身份可加载迁移依赖 pg"

# ── 3. 原子替换信任目录 ──────────────────────────────────────────────────────

step "3/5 替换 $TRUST_DIR"
if [[ -e "$TRUST_DIR" || -L "$TRUST_DIR" ]]; then
  [[ -d "$TRUST_DIR" && ! -L "$TRUST_DIR" ]] || die "$TRUST_DIR 不是普通目录。"
  [[ "$(stat -c '%u:%g' "$TRUST_DIR")" == "0:0" ]] || die "$TRUST_DIR 的属主不是 root:root。"
  OLD="${TRUST_DIR}.old.$$"
  mv "$TRUST_DIR" "$OLD"
  mv "$NEW" "$TRUST_DIR"; NEW=""
  rm -rf -- "$OLD"; OLD=""
  ok "旧快照已替换并删除"
else
  mv "$NEW" "$TRUST_DIR"; NEW=""
fi
chown root:root "$TRUST_DIR"
chmod 0755 "$TRUST_DIR"
[[ -z "$(find "$TRUST_DIR" -xdev \( -perm -0020 -o -perm -0002 \) -print -quit)" ]] \
  || die "信任目录中仍有组/其他用户可写的路径。"
ok "信任目录已就位：$TRUST_DIR"

# ── 4. 调用 finalizer ────────────────────────────────────────────────────────

step "4/5 调用可信 finalizer"
FINALIZER_ARGS=(--trust-dir "$TRUST_DIR" --artifact "$ARTIFACT")
if (( DRILL == 1 )); then FINALIZER_ARGS+=(--drill); fi
bash "$TRUST_DIR/deploy/app/finalize-staging.sh" "${FINALIZER_ARGS[@]}"

step "5/5 完成"
ok "bootstrap 完成。信任目录：$TRUST_DIR"
info "日志：$LOG（finalizer 另有 $LOG_DIR/prod2-finalize.log）"
