#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.1 · 创建运行时服务账号与目录
#
#     sudo deploy/app/create-service-user.sh
#
# **只在服务器上、由 root 执行。** 本轮不自动运行。
#
# 为什么需要独立账号：
#   Next.js 进程只需要「读发布产物」和「读环境变量文件」两项能力。
#   用 root 跑它，任何一次模板注入 / 反序列化漏洞都直接等于整机沦陷；
#   而发布产物本身由 root 管理（数据库脚本需要 root），运行进程**不应该**
#   住在那个 root 管理的源码目录里。
#
# 这个账号刻意做成：
#   · 系统账号（--system），不建家目录
#   · 登录 shell 为 nologin，不能交互登录
#   · 不加进任何附加组（尤其**不是** sudo / wheel / adm）
#   · 对发布产物只有读权限

set -euo pipefail

SERVICE_USER="${CHAOGE_SERVICE_USER:-chaoge}"
ROOT_DIR="${CHAOGE_STAGING_ROOT:-/opt/chaoge-staging}"
CONF_DIR="${CHAOGE_CONF_DIR:-/etc/chaoge}"

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行（要创建系统账号并设置属主）。"

# ── 1. 账号 ──────────────────────────────────────────────────────────────────

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "账号 $SERVICE_USER 已存在，不重建"
else
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --no-create-home --home-dir "$ROOT_DIR" \
          --shell "$NOLOGIN" --comment "超哥电竞 staging runtime" "$SERVICE_USER"
  ok "已创建系统账号 $SERVICE_USER（shell=$NOLOGIN）"
fi

# ── 2. 断言：这个账号不能有提权能力 ──────────────────────────────────────────

if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qxE 'sudo|wheel|adm'; then
  die "账号 $SERVICE_USER 属于提权组（$(id -nG "$SERVICE_USER")）。拒绝继续——运行时账号不能有 sudo。"
fi
ok "账号 $SERVICE_USER 不在 sudo / wheel / adm 组"

SHELL_OF="$(getent passwd "$SERVICE_USER" | cut -d: -f7)"
case "$SHELL_OF" in
  */nologin|*/false) ok "登录 shell 已禁用：$SHELL_OF" ;;
  *) die "账号 $SERVICE_USER 的 shell 是「$SHELL_OF」——运行账号不应可交互登录。" ;;
esac

# ── 3. 目录 ──────────────────────────────────────────────────────────────────
#
# /opt/chaoge-staging          root:chaoge 0750 ← 服务账号经组权限进入
# /opt/chaoge-staging/releases root:root    0755 ← 版本目录对所有用户只读（deploy 迁移、chaoge 运行）
# /etc/chaoge                  root:root    0750 ← 环境变量与凭据文件所在目录，仅 root
#
# 版本目录必须对 deploy（迁移身份）和 chaoge（运行身份）都可读；它不含密钥，
# 产物在入口处已拒绝 .env / 链接 / 设备节点。

mkdir -p "$ROOT_DIR/releases" "$CONF_DIR"
chown "root:$SERVICE_USER" "$ROOT_DIR"
chown root:root "$ROOT_DIR/releases" "$CONF_DIR"
chmod 750 "$ROOT_DIR" "$CONF_DIR"
chmod 755 "$ROOT_DIR/releases"
ok "目录已就位：$ROOT_DIR（root:$SERVICE_USER 0750）、$ROOT_DIR/releases（root:root 0755）、$CONF_DIR（root:root 0750）"

# ── 4. 下一步 ────────────────────────────────────────────────────────────────

echo
ok "服务账号与目录创建完成。下一步（仍需 root）："
info "  1. 生成环境变量文件：  sudo bash deploy/app/setup-staging-env.sh"
info "  2. 安装 systemd 单元：  sudo cp deploy/app/chaoge-staging.service /etc/systemd/system/"
info "                          sudo systemctl daemon-reload"
info "  3. 发布第一个版本：      sudo bash deploy/app/install-release.sh --artifact <tar.gz>"
