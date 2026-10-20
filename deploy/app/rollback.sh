#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.1 · 回滚到上一个（或指定）发布版本
#
#     sudo deploy/app/rollback.sh              # 回到最近的另一个版本
#     sudo deploy/app/rollback.sh --to <ID>    # 回到指定版本
#     sudo deploy/app/rollback.sh --list       # 列出可用版本
#
# **只在服务器上、由 root 执行。** 本轮不自动运行。
#
# 回滚不做任何「重新构建」：产物是不可变的版本目录，
# 回滚只是把 `current` 链接改回去然后重启。因此它足够快，
# 也比「检出旧提交再 build 一次」可靠——后者依赖构建环境当时的状态。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$HERE/_common.sh"

ROOT_DIR="${CHAOGE_STAGING_ROOT:-/opt/chaoge-staging}"
RELEASES="$ROOT_DIR/releases"
CURRENT="$ROOT_DIR/current"
SERVICE="${CHAOGE_STAGING_SERVICE:-chaoge-staging}"
PORT="${CHAOGE_STAGING_PORT:-3000}"

TARGET=""
DO_LIST=0

usage() {
  cat <<'USAGE'
用法: rollback.sh [选项]

  --to ID      回滚到指定版本目录名
  --list       列出所有可用版本（当前版本带 *）
  -h, --help   本帮助

不带 --to 时，回到最近的一个**非当前**版本。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)     TARGET="${2:?--to 需要一个版本目录名}"; shift 2 ;;
    --list)   DO_LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行（要改 /opt 下的链接并重启 systemd 服务）。"
[[ -d "$RELEASES" ]] || die "找不到发布目录：$RELEASES"

CUR_REAL="$(readlink -f "$CURRENT" 2>/dev/null || true)"

if [[ "$DO_LIST" == "1" ]]; then
  info "版本目录（按修改时间从新到旧）："
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2- \
    | while read -r d; do
        mark=" "
        [[ "$d" == "$CUR_REAL" ]] && mark="*"
        printf '  %s %s\n' "$mark" "$(basename "$d")"
      done
  info "* = 当前版本（$CUR_REAL）"
  exit 0
fi

if [[ -n "$TARGET" ]]; then
  # 版本名只能是一层目录名：--to 由 root 手工使用，受控入口不传参数。
  [[ "$TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || die "版本目录名不合法：$TARGET"
  REL="$RELEASES/$TARGET"
  [[ -d "$REL" ]] || die "版本不存在：$REL"
else
  REL="$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
         | sort -rn | cut -d' ' -f2- \
         | while read -r d; do
             [[ "$d" == "$CUR_REAL" ]] && continue
             printf '%s\n' "$d"
             break
           done)"
  [[ -n "$REL" ]] || die "没有可回滚的其它版本。"
fi

step "回滚到 $(basename "$REL")"
info "当前: ${CUR_REAL:-（无）}"

ln -sfn "$REL" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"
ok "current -> $REL"

systemctl daemon-reload
systemctl restart "$SERVICE"

if ! wait_healthy "$PORT" 30; then
  warn "回滚后的版本也未通过健康检查。"
  journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | sed 's/^/      /' || true
  die "回滚失败，需要人工介入。当前链接仍指向 $REL。"
fi

assert_loopback_only "$PORT" || die "回滚后的监听地址不是回环，需要立即处理。"

echo
ok "回滚完成"
info "版本: $(basename "$REL")"
info "状态: $(systemctl is-active "$SERVICE")"
