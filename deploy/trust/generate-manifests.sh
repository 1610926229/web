#!/usr/bin/env bash
#
# 生成信任 bundle 的两个 SHA-256 manifest（**本地/CI 使用，不部署**）
#
#     bash deploy/trust/generate-manifests.sh [APP_GIT_SHA]
#
# 产出（就地覆盖）：
#
#   deploy/trust/deploy-files.sha256   部署脚本与 SQL，路径相对信任目录根
#   deploy/trust/migration-code.sha256 迁移代码，固定取 APP_GIT_SHA 的 git 对象
#
# ## 为什么迁移代码取 git 对象而不是工作区
#
# 部署脚本会因为本轮安全整改而更新（新的提交），迁移代码则必须仍然对应
# **已经构建、已经验证过的 CI 产物**。两者是不同的 SHA；从 git 对象取
# 8ad9d6b 的 `package.json` / `lib/**` / `db/migrations/**` / alias hook，
# 保证服务器上执行的迁移代码就是那个产物对应的版本。
#
# ## 为什么 manifest 不含自己
#
# `deploy-files.sha256` 不可能包含自己的哈希（会改变自己）。它也不包含本脚本：
# 本脚本只在开发机运行，不进入服务器信任目录。

set -euo pipefail

APP_GIT_SHA="${1:-8ad9d6ba9dcd0094b31d8fc75a8cceb44065bb07}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$OUT_DIR/../.." && pwd)"

[[ "$APP_GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "APP_GIT_SHA 不合法：$APP_GIT_SHA" >&2; exit 1; }
git -C "$REPO_ROOT" cat-file -e "$APP_GIT_SHA^{commit}" 2>/dev/null \
  || { echo "仓库里找不到提交 $APP_GIT_SHA" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 统一按 LF 计算哈希：bundle 由 `git archive` 的 blob 组成（始终 LF），
# 而 Windows 工作区可能是 CRLF。manifest 必须描述服务器上实际解出的字节。
hash_lf() {
  local f="$1" sum
  sum="$(sed -e 's/\r$//' "$f" | sha256sum | awk '{print $1}')"
  printf '%s  %s\n' "$sum" "$f"
}

# ── 1. 迁移代码（固定提交）──────────────────────────────────────────────────

git -C "$REPO_ROOT" -c core.autocrlf=false archive "$APP_GIT_SHA" \
  package.json tests/alias-hook.mjs tests/alias-loader.mjs lib db/migrations \
  | tar -x -C "$TMP"

(
  cd "$TMP"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do
    hash_lf "${f#./}"
  done
) > "$OUT_DIR/migration-code.sha256"

# ── 2. 部署文件（工作区，即将提交的那个版本）────────────────────────────────

(
  cd "$REPO_ROOT"
  find deploy -type f \
    ! -path 'deploy/trust/deploy-files.sha256' \
    ! -path 'deploy/trust/generate-manifests.sh' \
    -print | LC_ALL=C sort | while IFS= read -r f; do
      hash_lf "$f"
    done
) > "$OUT_DIR/deploy-files.sha256"

echo "migration-code.sha256: $(wc -l < "$OUT_DIR/migration-code.sha256") 个文件（git $APP_GIT_SHA）"
echo "deploy-files.sha256:   $(wc -l < "$OUT_DIR/deploy-files.sha256") 个文件（工作区 deploy/）"
