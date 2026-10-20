#!/usr/bin/env bash
#
# 超哥电竞 · Staging 公网只读预览：关闭并回滚
#
#     sudo bash deploy/proxy/rollback-public-proxy.sh
#
# 做两件事：
#   1. 移除 /etc/nginx/sites-enabled/chaoge-public.conf；
#   2. 停止并禁用 Nginx（80 端口不再监听）。
#
# 选择「停止 Nginx」而不是「恢复默认站点」：默认站点会把 Nginx 欢迎页暴露到公网，
# 那不是回滚，是换成另一个公网页面。本机没有别的 Nginx 站点；如果以后有，
# 应先修改本脚本，再决定是否只卸载 chaoge 站点。
#
# 不碰：腾讯云安全组、UFW、SSH、数据库、应用发布目录、chaoge-staging 服务。
# 应用本身仍然只在 127.0.0.1:3000 提供服务，SSH 隧道验收不受影响。
#
# 配置备份位于 /var/backups/chaoge-public-proxy/，本脚本**不删除**它们。

set -euo pipefail

CONF_LINK="/etc/nginx/sites-enabled/chaoge-public.conf"
CONF_DST="/etc/nginx/sites-available/chaoge-public.conf"

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行。"
command -v nginx >/dev/null 2>&1 || die "找不到 nginx。"

step "1. 移除公网站点"

rm -f "$CONF_LINK"
info "已移除 $CONF_LINK（配置模板保留在 $CONF_DST 供审计）"

# 配置语法检查：移除后不应再引用任何缺失文件。
nginx -t >/dev/null 2>&1 || die "移除站点后 nginx -t 未通过——请人工检查 /etc/nginx。"
ok "nginx -t 通过"

step "2. 停止并禁用 Nginx"

systemctl stop nginx || true
systemctl disable nginx >/dev/null 2>&1 || true
ok "Nginx 已停止并禁用"

step "3. 验证"

if ss -ltn | grep -qE 'LISTEN[[:space:]].*:80[[:space:]]'; then
  die "80 端口仍在监听，回滚未完成。"
fi
ok "80 端口已不再监听"

if ss -ltn | grep -qE '127\.0\.0\.1:3000[[:space:]]'; then
  ok "Next.js 仍在 127.0.0.1:3000 运行（SSH 隧道验收不受影响）"
else
  info "注意：Next.js 当前不在 127.0.0.1:3000 监听（与本次回滚无关）。"
fi

cat <<'EOF'

  公网入口已关闭。腾讯云安全组的 80 规则可以由人工保留或删除；
  只要 Nginx 不监听 80，公网就无法访问本站。

  需要重新开放时：
    sudo bash deploy/proxy/install-public-proxy.sh
EOF
