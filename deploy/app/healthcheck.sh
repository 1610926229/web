#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.1 · Staging 验收探测（只读）
#
#     deploy/app/healthcheck.sh [--base-url http://127.0.0.1:3000]
#     deploy/app/healthcheck.sh --persistence     # ⚠️ 会写一条真实数据
#
# 典型用法是在**本地**先建立 SSH 隧道，再对隧道这一端跑本脚本：
#
#     ssh -N -L 3000:127.0.0.1:3000 deploy@<服务器>
#     deploy/app/healthcheck.sh
#
# 默认全部只读：
#   · 首页可达
#   · 静态资源可达（验证 public 与 .next/static 都进了产物）
#   · 用户接口在未登录时返回 401（验证路由与守卫都在）
#
# `--persistence` 额外做一次真实的数据往返：
#   mock 登录 → 新增收藏 → 读回 → 删除。
#   **它会写入 staging 独立库 chaoge_staging 的一条收藏记录**（随后删除）。
#   自 Step 5.8.2 起 staging 不再连接 chaoge_prod，因此这条写入不会落到正式库。

set -euo pipefail

BASE_URL="http://127.0.0.1:3000"
PERSISTENCE=0

usage() {
  cat <<'USAGE'
用法: healthcheck.sh [选项]

  --base-url URL   被测地址（默认 http://127.0.0.1:3000）
  --persistence    ⚠️ 额外做一次「登录 → 新增收藏 → 读回 → 删除」的真实写读往返
  -h, --help       本帮助
USAGE
}

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)    BASE_URL="${2:?--base-url 需要一个值}"; shift 2 ;;
    --persistence) PERSISTENCE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

BASE_URL="${BASE_URL%/}"
command -v curl >/dev/null 2>&1 || die "找不到 curl。"

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$@" 2>/dev/null || printf '000'
}

# ── 1. 首页 ──────────────────────────────────────────────────────────────────

CODE="$(status_of "$BASE_URL/")"
case "$CODE" in
  200|30[0-9]) ok "首页 GET / → $CODE" ;;
  *)           die "首页 GET / → $CODE（期望 200 或 3xx）" ;;
esac

# ── 2. 静态资源 ──────────────────────────────────────────────────────────────
#
# 这一条专门验「public 与 .next/static 有没有被打进产物」。
# 漏拷时页面仍可能 200，但资源全 404，线上表现为「没有样式」。

CODE="$(status_of "$BASE_URL/next.svg")"
[[ "$CODE" == "200" ]] || die "静态资源 GET /next.svg → $CODE（期望 200）——public/ 可能没有进产物。"
ok "静态资源 GET /next.svg → 200"

# 构建产物里的 CSS/JS 使用带 hash 的路径，这里只验证 /_next/static 前缀下的
# 任意资源不会 404。先取首页 HTML，找出第一个 /_next/static/ 引用。
HTML="$(curl -sS --max-time 8 "$BASE_URL/" 2>/dev/null || true)"
ASSET="$(printf '%s' "$HTML" | grep -oE '/_next/static/[^"'"'"' ]+' | head -1 || true)"
if [[ -n "$ASSET" ]]; then
  CODE="$(status_of "$BASE_URL$ASSET")"
  [[ "$CODE" == "200" ]] || die "构建资源 GET $ASSET → $CODE（期望 200）——.next/static 可能没有进产物。"
  ok "构建资源 GET $ASSET → 200"
else
  info "首页 HTML 里没有 /_next/static 引用（可能整页由客户端渲染），跳过该项"
fi

# ── 3. 鉴权守卫 ──────────────────────────────────────────────────────────────

CODE="$(status_of "$BASE_URL/api/favorites")"
[[ "$CODE" == "401" ]] || die "未登录 GET /api/favorites → $CODE（期望 401）"
ok "未登录 GET /api/favorites → 401（守卫在位）"

# ── 4. 可选：真实数据往返 ────────────────────────────────────────────────────

if [[ "$PERSISTENCE" == "1" ]]; then
  JAR="$(mktemp)"
  trap 'rm -f "$JAR"' EXIT INT TERM

  info "⚠️ --persistence：会写入并删除一条收藏记录（用户 u-1002 / 商品 p-400w）"
  local_product="p-400w"

  CODE="$(status_of -c "$JAR" -X POST -H 'content-type: application/json' \
          -d '{"userId":"u-1002"}' "$BASE_URL/api/auth/mock-login")"
  [[ "$CODE" == "200" ]] || die "mock 登录 → $CODE（期望 200）。

      两种可能，看接口返回体区分：
        · 404 + 「模拟登录接口未启用」 → ENABLE_MOCK_AUTH 没开（见 staging.env）
        · 404 + 「Mock 用户不存在」     → **users 表是空的**

      第二种说明 staging 最小数据没有写入：migration 只建结构、不插数据
      （db/migrations 里没有任何 INSERT），而 mock 登录会去 users 表查 u-1002。
      正确做法是执行 `deploy/db/staging/deploy-staging.sh bootstrap`（06 只插入、
      可重复，以 chaoge_staging_app 身份执行），**不是** pnpm db:seed——
      后者在 NODE_ENV=production 下被硬性拒绝，staging 也不提供任何绕过路径。
      见 deploy/db/staging/README.md §5。"
  ok "mock 登录 → 200（u-1002）"

  CODE="$(status_of -b "$JAR" -X POST -H 'content-type: application/json' \
          -d "{\"productId\":\"$local_product\"}" "$BASE_URL/api/favorites")"
  [[ "$CODE" == "200" ]] || die "新增收藏 → $CODE（期望 200）"
  ok "新增收藏 → 200（$local_product）"

  BODY="$(curl -sS -b "$JAR" --max-time 8 "$BASE_URL/api/favorites")"
  printf '%s' "$BODY" | grep -q "$local_product" \
    || die "读回收藏列表里没有 $local_product —— 写入没有落库。"
  ok "读回收藏列表 → 命中 $local_product"

  # 读回之后**先不要删**：验收流程要在这个状态下重启 systemd，
  # 重启后再读一次，才能证明数据是持久的而不是进程内存。
  # 所以这里把它留着，并打印清理命令。
  info "保留这条记录用于「重启后仍存在」的验证。清理命令："
  info "  curl -sS -b <cookie jar> -X DELETE $BASE_URL/api/favorites/$local_product"
  info "  （或验收结束后用同一条命令删除；cookie jar 已随脚本退出删除，"
  info "    需要重新 mock 登录一次再删。）"
fi

echo
ok "验收探测全部通过：$BASE_URL"
