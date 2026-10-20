#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.1 · 构建 Next.js standalone 运行产物
#
#     EXPECTED_SHA=<40位 SHA> deploy/app/build-standalone.sh [选项]
#
# 在哪里跑：
#   · GitHub Actions 的 ubuntu-latest —— 正常路径
#   · 本地 Linux / Git Bash —— 验收产物结构
#   · **服务器上不跑**：服务器不装 pnpm、不执行 next build，只接收 tar.gz
#
# 产物：
#   dist/staging-standalone-<SHA>.tar.gz
#     内含 server.js / node_modules / .next / public / BUILD_INFO
#     解包到 releases/<id>/ 后即可由 systemd 直接 `node server.js`
#
# 为什么必须显式拷贝 public 与 .next/static：
#   Next 的 standalone 输出只包含「被代码追踪到的服务端依赖」。
#   `public/` 与 `.next/static/` 是静态资源，不在追踪范围内，默认**不在**产物里。
#   漏拷时页面能返回 200，但 CSS/JS/图片全部 404——这是最难从日志里看出来的一类
#   「部署成功」。
#
# 为什么要把 SHA 写进产物并校验：
#   服务器只接收产物，没有 git 历史。BUILD_INFO 是产物与提交之间**唯一**的绑定，
#   安装脚本据此回显「这次发布的是哪个提交」，回滚时也能说清楚回到了什么。
#   脚本在构建前校验 `git rev-parse HEAD`，避免把工作区里未提交的改动打进产物。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
SKIP_BUILD=0

usage() {
  cat <<'USAGE'
用法: EXPECTED_SHA=<40位 SHA> deploy/app/build-standalone.sh [选项]

  --expected-sha SHA   要构建的提交（也可用环境变量 EXPECTED_SHA）
  --out DIR            产物目录（默认 <repo>/dist）
  --skip-build         复用已有的 .next，只做组装（调试用）
  -h, --help           本帮助

说明:
  · SHA 必须与当前 `git rev-parse HEAD` 一致，否则拒绝构建。
    这是为了「产物 = 某个确定的提交」这条绑定，而不是「某个时刻的工作区」。
  · 设置 REQUIRE_CLEAN=1 会额外要求工作区完全干净（CI 里就是这么用的）。
USAGE
}

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-sha) EXPECTED_SHA="${2:?--expected-sha 需要一个值}"; shift 2 ;;
    --out)          OUT_DIR="${2:?--out 需要一个目录}"; shift 2 ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

cd "$ROOT"

# ── 1. 确定并校验提交 ────────────────────────────────────────────────────────

step "1. 提交校验"

command -v git >/dev/null 2>&1 || die "找不到 git。产物必须绑定到一个确定的提交。"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 git 工作区：$ROOT"

HEAD_SHA="$(git rev-parse HEAD)"
if [[ -z "$EXPECTED_SHA" ]]; then
  EXPECTED_SHA="$HEAD_SHA"
  info "未指定 EXPECTED_SHA，按当前 HEAD 构建：$EXPECTED_SHA"
fi

[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "EXPECTED_SHA 必须是 40 位小写十六进制，收到：$EXPECTED_SHA"

if [[ "$HEAD_SHA" != "$EXPECTED_SHA" ]]; then
  die "当前 HEAD 与 EXPECTED_SHA 不一致，拒绝构建。
      HEAD         : $HEAD_SHA
      EXPECTED_SHA : $EXPECTED_SHA
      构建必须对应一个确定的提交；请先 checkout 到目标提交。"
fi
ok "HEAD == EXPECTED_SHA：$EXPECTED_SHA"

if [[ "${REQUIRE_CLEAN:-0}" == "1" ]]; then
  DIRTY="$(git status --porcelain)"
  [[ -z "$DIRTY" ]] || die "工作区不干净，拒绝构建（REQUIRE_CLEAN=1）：\n$DIRTY"
  ok "工作区干净"
fi

# ── 2. 构建 ──────────────────────────────────────────────────────────────────

step "2. next build"
if [[ "$SKIP_BUILD" == "1" ]]; then
  info "--skip-build：复用已有 .next"
  [[ -d "$ROOT/.next" ]] || die "--skip-build 但 .next 不存在"
else
  command -v pnpm >/dev/null 2>&1 || die "找不到 pnpm。"
  pnpm build
fi

[[ -f "$ROOT/.next/standalone/server.js" ]] || die \
  "没有 .next/standalone/server.js —— next.config.ts 里的 output: 'standalone' 没生效，或构建失败。"

# ── 3. 组装 ──────────────────────────────────────────────────────────────────

step "3. 组装 standalone（拷贝 public 与 .next/static）"
SA="$ROOT/.next/standalone"

[[ -d "$ROOT/public" ]]        || die "仓库里没有 public/。"
[[ -d "$ROOT/.next/static" ]]  || die "没有 .next/static/ —— 这次构建没有产出静态资源，产物不可用。"

# 先删再拷：避免上一次构建残留的文件被打进新产物（stale asset 比缺文件更难查）
rm -rf "$SA/public"
cp -R "$ROOT/public" "$SA/public"

rm -rf "$SA/.next/static"
cp -R "$ROOT/.next/static" "$SA/.next/static"

[[ -f "$SA/public/index.html" || -d "$SA/public" ]] || die "public 拷贝失败"
[[ -d "$SA/.next/static" ]]                          || die ".next/static 拷贝失败"

info "public/        $(find "$SA/public" -type f | wc -l | tr -d ' ') 个文件"
info ".next/static/ $(find "$SA/.next/static" -type f | wc -l | tr -d ' ') 个文件"

# ── 4. 修正绝对符号链接 ──────────────────────────────────────────────────────
#
# 主修法在 `pnpm-workspace.yaml`：`nodeLinker: hoisted` 让 node_modules 变成
# 扁平真实目录，standalone 因此包含全部依赖的真实文件。
#
# 但 Next 仍会为**服务端外部包**在 `.next/node_modules/` 里建一个绝对链接：
#
#     .next/node_modules/pg-<hash> -> <构建机>/node_modules/pg
#
# 这个链接不会因为 hoisted 消失。产物离开构建机后它会悬空，服务端加载 pg 时失败。
# 所以这里把所有指向构建机 node_modules 的绝对链接改写成指向产物内部对应路径的
# **相对**链接，并在最后断言一个绝对链接都不剩。

step "4. 修正绝对符号链接"

FIXED=0
while IFS= read -r -d '' link; do
  tgt="$(readlink "$link")"
  [[ "$tgt" == /* ]] || continue

  # hoisted 布局下没有 pnpm 链接，但 Next 仍会在 `.next/node_modules/` 里
  # 为服务端外部包建一个绝对链接（例如 `pg-<hash> -> <构建机>/node_modules/pg`），
  # 因此这里匹配整个 node_modules 前缀，而不只是 `.pnpm`。
  case "$tgt" in
    "$ROOT"/node_modules/*) ;;
    *)
      warn "产物里有指向构建机之外的绝对链接，保持原样：$link -> $tgt"
      continue
      ;;
  esac

  inside="${tgt#"$ROOT"/}"
  dest="$SA/$inside"
  [[ -e "$dest" ]] || die "符号链接的目标没有被打进产物：$link -> $tgt（期望 $dest）"

  rel="$(realpath --relative-to="$(dirname "$link")" "$dest")"
  # 先删再建，而不是 `ln -sfn`：Git Bash 的 ln 对「指向目录的既有链接」
  # 仍会尝试在目标目录内部建链接，报 `Not a directory`。
  rm -f "$link"
  ln -s "$rel" "$link"
  FIXED=$(( FIXED + 1 ))
done < <(find "$SA" -type l -print0)

ABS="$(find "$SA" -type l -exec readlink {} \; | grep '^/' || true)"
if [[ -n "$ABS" ]]; then
  die "产物里仍有绝对符号链接，离开构建机后会失效：
$ABS"
fi
ok "已把 $FIXED 个绝对链接改写为产物内相对链接"

# ── 5. 产物自检 ──────────────────────────────────────────────────────────────

step "5. 产物自检"

[[ -f "$SA/server.js" ]] || die "产物缺 server.js"
[[ -d "$SA/node_modules" ]] || die "产物缺 node_modules —— standalone 追踪失败？"

# ⚠️ Next 的 standalone **会**把仓库根目录的 `.env` / `.env.*` 复制进来
#    （实测 Next 16.3.4：本地 `.env` 里的 DATABASE_URL 原样出现在
#    `.next/standalone/.env`）。本地开发用的连接串因此会被打进产物、上传到服务器。
#    服务器不需要它：所有配置来自 systemd 的 `/etc/chaoge/staging.env`。
#    所以这里先删掉，再断言一个都不剩。
while IFS= read -r -d '' f; do
  info "移除产物内不应存在的文件：${f#"$SA"/}"
  rm -f "$f"
done < <(find "$SA" \( -name '.env' -o -name '.env.*' \) -print0 2>/dev/null)

LEAK="$(find "$SA" \( -name '.env' -o -name '.env.*' \) -print 2>/dev/null | head -5)"
if [[ -n "$LEAK" ]]; then
  die "产物里仍有 .env 文件，拒绝打包：
$LEAK"
fi

# ── 6. BUILD_INFO 与打包 ─────────────────────────────────────────────────────

step "6. 写 BUILD_INFO 并打包"

NODE_VER="$(node --version 2>/dev/null || echo unknown)"
PNPM_VER="$(pnpm --version 2>/dev/null || echo unknown)"
BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

cat > "$SA/BUILD_INFO" <<EOF
sha=$EXPECTED_SHA
built_at=$BUILT_AT
node=$NODE_VER
pnpm=$PNPM_VER
EOF

info "BUILD_INFO:"
sed 's/^/    /' "$SA/BUILD_INFO"

mkdir -p "$OUT_DIR"
ARTIFACT="$OUT_DIR/staging-standalone-${EXPECTED_SHA}.tar.gz"
rm -f "$ARTIFACT"
tar -czf "$ARTIFACT" -C "$SA" .

[[ -s "$ARTIFACT" ]] || die "打包失败：$ARTIFACT"

echo
ok "产物: $ARTIFACT"
info "大小: $(du -h "$ARTIFACT" | cut -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  info "sha256: $(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
fi
info "提交: $EXPECTED_SHA"
