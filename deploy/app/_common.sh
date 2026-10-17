# shellcheck shell=bash
#
# PROD-2 / Step 5.8.1 · install-release.sh 与 rollback.sh 共用的小工具
#
# 这个文件**不被执行**，只被 `source`。因此它不设 `set -euo pipefail`
# （那会改掉调用方的 shell 选项）。

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }

# ── 只允许回环监听 ────────────────────────────────────────────────────────────
#
# 这是本方案「不暴露公网」的核心断言之一。
# Next 的 standalone `server.js` 在 HOSTNAME 未设置时默认绑 **0.0.0.0**——
# 那会把 Mock 登录、管理后台、客服工作台一起暴露到公网。
# 所以部署脚本在重启后**必须实际读一次监听表**，而不是相信配置文件写对了。

assert_loopback_only() {
  local port="$1" out bad
  command -v ss >/dev/null 2>&1 || die "找不到 ss，无法确认监听地址。不要跳过这一步。"
  out="$(ss -ltnH "sport = :$port" 2>/dev/null || true)"
  [[ -n "$out" ]] || die "端口 $port 上没有任何监听者。"

  bad="$(printf '%s\n' "$out" | awk '
    {
      addr = $4
      if (addr !~ /^127\.0\.0\.1:/ && addr !~ /^\[::1\]:/) print $0
    }')"

  if [[ -n "$bad" ]]; then
    die "端口 $port 监听在**非回环**地址上，拒绝继续：
$bad
      唯一允许的是 127.0.0.1（或 [::1]）。
      检查 systemd 单元的 ExecStart 是否带有 HOSTNAME=127.0.0.1。"
  fi

  ok "监听地址仅回环："
  printf '%s\n' "$out" | sed 's/^/      /'
}

# ── 健康检查 ──────────────────────────────────────────────────────────────────
#
# 用 `/` 而不是新增一个健康接口：首页会走会话与取数路径，
# 「进程活着但渲染路径炸了」也能被这一条发现。`curl -f` 只把 >=400 判为失败，
# 3xx（例如跳登录页）是正常的。

wait_healthy() {
  local port="$1" tries="${2:-30}" i
  for (( i = 1; i <= tries; i++ )); do
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/" 2>/dev/null; then
      ok "健康检查通过（第 $i 次尝试，共允许 $tries 次）"
      return 0
    fi
    sleep 1
  done
  return 1
}
