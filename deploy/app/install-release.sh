#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.1 · 在服务器上安装一个 standalone 发布版本
#
#     sudo deploy/app/install-release.sh --artifact staging-standalone-<SHA>.tar.gz
#
# **只在服务器上、由 root 执行。** 本轮不自动运行。
#
# 它做四件事，顺序是不可交换的：
#
#   1. 校验产物（SHA 格式、必需文件、不含 .env）
#   2. 解包到 `releases/<release-id>/`（**新目录**，绝不覆盖正在跑的版本）
#   3. 原子切换 `current` 符号链接，重启 systemd
#   4. 实测：健康检查 + **监听地址必须只有回环**
#
# 第 4 步失败时自动切回上一个版本并重启——发布失败不应该留下一台坏掉的服务。
#
# 目录布局:
#   /opt/chaoge-staging/releases/<id>/   root:chaoge  每个版本一个不可变目录
#   /opt/chaoge-staging/current -> ...   root:root     符号链接，原子切换
#
# 为什么是「版本目录 + 符号链接」而不是「原地覆盖」：
#   原地覆盖时，从「删除旧文件」到「新文件就位」之间有一个窗口，
#   此刻服务读到的是**半新半旧**的文件树；回滚更是无从谈起（旧文件已经没了）。
#   版本目录让每个版本都是完整的，切换只是改一个链接，回滚就是把链接改回去。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$HERE/_common.sh"

ROOT_DIR="${CHAOGE_STAGING_ROOT:-/opt/chaoge-staging}"
RELEASES="$ROOT_DIR/releases"
CURRENT="$ROOT_DIR/current"
SERVICE="${CHAOGE_STAGING_SERVICE:-chaoge-staging}"
SERVICE_USER="${CHAOGE_SERVICE_USER:-chaoge}"
ENV_FILE="${CHAOGE_STAGING_ENV:-/etc/chaoge/staging.env}"
PORT="${CHAOGE_STAGING_PORT:-3000}"
KEEP="${CHAOGE_KEEP_RELEASES:-5}"

ARTIFACT=""
RELEASE_ID=""
DRY_RUN=0
FORCE=0
NO_PRUNE=0

usage() {
  cat <<'USAGE'
用法: install-release.sh --artifact FILE [选项]

  --artifact FILE    standalone 产物（staging-standalone-<SHA>.tar.gz）
  --release-id ID    版本目录名（默认 <UTC时间>-<SHA前7位>）
  --keep N           保留最近 N 个旧版本（默认 5）
  --no-prune         本次不清理旧版本
  --force            版本目录已存在时覆盖（默认拒绝）
  --dry-run          只做校验，不解包、不切换、不重启
  -h, --help         本帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)   ARTIFACT="${2:?--artifact 需要一个文件}"; shift 2 ;;
    --release-id) RELEASE_ID="${2:?--release-id 需要一个值}"; shift 2 ;;
    --keep)       KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
    --no-prune)   NO_PRUNE=1; shift ;;
    --force)      FORCE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

# ── 0. 前置 ──────────────────────────────────────────────────────────────────

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行（要写 /opt 并重启 systemd 服务）。"
[[ -n "$ARTIFACT" ]] || { usage >&2; die "缺少 --artifact"; }
[[ -f "$ARTIFACT" ]] || die "产物不存在：$ARTIFACT"
[[ -s "$ARTIFACT" ]] || die "产物是空的：$ARTIFACT"

id -u "$SERVICE_USER" >/dev/null 2>&1 || die "服务账号「$SERVICE_USER」不存在。先跑 bash deploy/app/create-service-user.sh。"
systemctl cat "$SERVICE" >/dev/null 2>&1 || die \
  "systemd 单元「$SERVICE」未安装。先执行：
      sudo cp deploy/app/chaoge-staging.service /etc/systemd/system/
      sudo systemctl daemon-reload"

# ── 0. 运行时 Node 校验 ──────────────────────────────────────────────────────
#
# 单元里的 Node 是绝对路径。路径写错（例如写了这台机器上不存在的 /usr/bin/node）
# 时，systemd 只会报 status=1/FAILURE，日志里没有「找不到 node」这种直白提示。
# 所以在解包、切换、重启之前，先从已安装单元里取出那个路径并实测。
UNIT_EXEC="$(systemctl cat "$SERVICE" | sed -n 's/^ExecStart=//p' | tail -1)"
NODE_BIN="$(printf '%s\n' "$UNIT_EXEC" | awk '
  { for (i = 1; i <= NF; i++) if ($i ~ /^\// && $i != "/usr/bin/env") { print $i; exit } }')"
[[ -n "$NODE_BIN" ]] || die "无法从 $SERVICE 的 ExecStart 解析出 Node 绝对路径：
      $UNIT_EXEC"
[[ -x "$NODE_BIN" ]] || die "systemd 单元里的 Node 不存在或不可执行：$NODE_BIN
      这会让服务以 status=1/FAILURE 启动失败。修正 ExecStart 后 daemon-reload 再发布。"
ok "运行时 Node 可用：$NODE_BIN（$( "$NODE_BIN" -v 2>/dev/null || echo '版本未知')）"

step "1. 环境变量文件校验"
[[ -f "$ENV_FILE" ]] || die "找不到 $ENV_FILE。先跑 bash deploy/app/setup-staging-env.sh。"
PERM="$(stat -c '%U:%G %a' "$ENV_FILE")"
[[ "$PERM" == "root:$SERVICE_USER 640" ]] \
  || die "$ENV_FILE 的权限是「$PERM」，期望「root:$SERVICE_USER 640」。"
grep -qx 'DATA_SOURCE=postgres' "$ENV_FILE" \
  || die "$ENV_FILE 里没有 DATA_SOURCE=postgres —— 服务会退回 Mock 数据源。"
if grep -qE '^(HOSTNAME|PORT)=' "$ENV_FILE"; then
  die "$ENV_FILE 里出现了 HOSTNAME/PORT。它们会覆盖 systemd 单元里的回环绑定设置，拒绝继续。"
fi

# ── 数据源隔离（Step 5.8.2）────────────────────────────────────────────────────
#
# staging 的 Mock 测试数据**只允许**写进 chaoge_staging。这一检查放在发布入口、
# 且在任何解包/切换/重启之前：一个指向 chaoge_prod 的 staging.env 如果放行，
# 下一次 Staging 验收就会直接在生产库上写单。发布脚本是它最后一个能拦住的关口。
DB_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1 | tr -d '\r')"
[[ -n "$DB_URL" ]] || die "$ENV_FILE 里没有 DATABASE_URL —— 服务启动后会 fail-fast。"

[[ "$DB_URL" =~ ^postgres(ql)?://([^:/@]+):[^@]*@([^/:]+)(:([0-9]+))?/([^?]+)(\?.*)?$ ]] \
  || die "DATABASE_URL 无法解析。期望 postgresql://<role>:<password>@<host>:<port>/<db>。"

URL_ROLE="${BASH_REMATCH[2]}"
URL_HOST="${BASH_REMATCH[3]}"
URL_PORT="${BASH_REMATCH[5]:-5432}"
URL_DB="${BASH_REMATCH[6]}"

[[ "$URL_ROLE" == "chaoge_staging_app" ]] \
  || die "DATABASE_URL 的角色是「$URL_ROLE」，staging 必须是 chaoge_staging_app。
      生产角色 chaoge_app 与迁移角色在此一律拒绝。"
[[ "$URL_DB" =~ ^chaoge_staging(_[a-z0-9]+)*$ ]] \
  || die "DATABASE_URL 指向的库是「$URL_DB」，staging 只允许 chaoge_staging*。"
case "$URL_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) die "DATABASE_URL 的主机是「$URL_HOST」，staging 只允许回环地址。" ;;
esac
[[ "$URL_PORT" == "5432" ]] || warn "DATABASE_URL 的端口是 $URL_PORT，预期 5432 —— 请确认这是有意为之。"

POOL_MAX="$(sed -n 's/^PG_POOL_MAX=//p' "$ENV_FILE" | head -1 | tr -d '\r')"
if [[ -n "$POOL_MAX" && "$POOL_MAX" =~ ^[0-9]+$ ]] && (( POOL_MAX > 10 )); then
  warn "PG_POOL_MAX=$POOL_MAX 对 2C2G 单机偏大（建议 5）。本次不阻止，但请确认内存余量。"
fi

ok "数据源隔离检查通过：$URL_ROLE@$URL_HOST:$URL_PORT/$URL_DB（非生产库）"
ok "$ENV_FILE 权限与内容符合预期（只打印变量名）："
info "  $(grep -oE '^[A-Z_]+=' "$ENV_FILE" | tr -d '=' | paste -sd' ')"

# ── 2. 产物校验 ──────────────────────────────────────────────────────────────

step "2. 产物校验"

tar -tzf "$ARTIFACT" > /dev/null 2>&1 || die "不是有效的 tar.gz：$ARTIFACT"

BUILD_INFO="$(tar -xzf "$ARTIFACT" -O ./BUILD_INFO 2>/dev/null || true)"
[[ -n "$BUILD_INFO" ]] || die "产物里没有 BUILD_INFO —— 不是 build-standalone.sh 产出的包。"

SHA="$(printf '%s\n' "$BUILD_INFO" | sed -n 's/^sha=//p' | head -1 | tr -d '\r')"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "BUILD_INFO 里的 SHA 不合法：$SHA"
info "BUILD_INFO:"
printf '%s\n' "$BUILD_INFO" | sed 's/^/      /'

tar -tzf "$ARTIFACT" | grep -qxE '\./server\.js' || die "产物缺 ./server.js"
tar -tzf "$ARTIFACT" | grep -qE '^\./node_modules/' || die "产物缺 ./node_modules/"
tar -tzf "$ARTIFACT" | grep -qE '^\./\.next/static/' || die "产物缺 ./.next/static/（静态资源会全 404）"
tar -tzf "$ARTIFACT" | grep -qE '^\./public/' || die "产物缺 ./public/"

# 绝不让 .env 落地：安装后再查一次，防止有人手工塞进 tar。
if tar -tzf "$ARTIFACT" | grep -qE '(^|/)\.env(\.|$)'; then
  die "产物里出现了 .env 文件，拒绝安装。"
fi
ok "产物结构完整，且不含 .env"

[[ -n "$RELEASE_ID" ]] || RELEASE_ID="$(date -u '+%Y%m%dT%H%M%SZ')-${SHA:0:7}"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "release-id 只能包含字母数字 . _ -：$RELEASE_ID"

REL="$RELEASES/$RELEASE_ID"
info "版本目录: $REL"

if [[ -e "$REL" && "$FORCE" != "1" ]]; then
  die "版本目录已存在：$REL
      换一个 --release-id，或加 --force（会先删除该目录）。"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  ok "--dry-run：校验全部通过，未解包、未切换、未重启。"
  exit 0
fi

# ── 3. 解包 ──────────────────────────────────────────────────────────────────

step "3. 解包到版本目录"

mkdir -p "$RELEASES"
[[ -e "$REL" ]] && rm -rf "$REL"
mkdir -p "$REL"
tar -xzf "$ARTIFACT" -C "$REL"

[[ -f "$REL/server.js" ]] || die "解包后缺 server.js"
[[ -d "$REL/node_modules" ]] || die "解包后缺 node_modules"

# 服务账号只需要读：属组 chaoge 可读/可进入，others 全部去掉。
chown -R "root:$SERVICE_USER" "$REL"
chmod -R g+rX,o-rwx "$REL"
ok "已解包并设置权限（root:$SERVICE_USER，others 无权限）"

PREV=""
if [[ -L "$CURRENT" ]]; then
  PREV="$(readlink -f "$CURRENT" || true)"
fi

# ── 4. 原子切换 ──────────────────────────────────────────────────────────────

step "4. 切换 current 并重启服务"

ln -sfn "$REL" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"
ok "current -> $REL"
[[ -n "$PREV" ]] && info "上一个版本: $PREV"

systemctl daemon-reload
systemctl restart "$SERVICE"

# ── 5. 实测 ──────────────────────────────────────────────────────────────────

step "5. 健康检查与监听地址实测"

FAILED=0
wait_healthy "$PORT" 30 || FAILED=1
if (( FAILED == 0 )); then
  assert_loopback_only "$PORT" || FAILED=1
fi

if (( FAILED != 0 )); then
  warn "新版本未通过验收，开始回滚。"

  if [[ -n "$PREV" && -d "$PREV" ]]; then
    ln -sfn "$PREV" "$CURRENT.tmp"
    mv -Tf "$CURRENT.tmp" "$CURRENT"
    info "current 已切回 $PREV"
    systemctl restart "$SERVICE" || true
    if wait_healthy "$PORT" 30; then
      ok "已回滚到上一个版本，服务恢复。"
    else
      warn "回滚后仍不健康。需要人工介入。"
    fi
  else
    warn "没有可回滚的上一个版本（这是第一次发布）。"
    systemctl stop "$SERVICE" || true
    warn "已停止服务，避免一个不健康的进程继续占着端口。"
    warn "current 仍指向 $REL，供排查使用。"
  fi

  echo
  warn "最近 60 行日志："
  journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | sed 's/^/      /' || true
  die "发布失败（release=$RELEASE_ID, sha=$SHA）。"
fi

# ── 6. 清理旧版本 ────────────────────────────────────────────────────────────

if [[ "$NO_PRUNE" == "1" ]]; then
  info "--no-prune：保留全部旧版本"
else
  step "6. 清理旧版本（保留最近 $KEEP 个 + 当前）"
  CUR_REAL="$(readlink -f "$CURRENT" || true)"
  mapfile -t ALL < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
                     | sort -rn | cut -d' ' -f2-)
  n=0
  for d in "${ALL[@]:-}"; do
    [[ -n "$d" ]] || continue
    [[ "$d" == "$CUR_REAL" ]] && continue
    n=$(( n + 1 ))
    if (( n > KEEP )); then
      info "删除旧版本 $(basename "$d")"
      rm -rf "$d"
    fi
  done
fi

echo
ok "发布完成"
info "版本: $RELEASE_ID"
info "提交: $SHA"
info "链接: $(readlink -f "$CURRENT")"
info "状态: $(systemctl is-active "$SERVICE")"
