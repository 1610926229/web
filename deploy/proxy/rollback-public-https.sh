#!/usr/bin/env bash
#
# 超哥电竞 · 公网 HTTPS 回滚（PROD-6）
#
# 恢复安装器留下的最近一次站点配置备份并 reload；没有备份时只移除
# chaoge-public 站点（Nginx 继续用默认站点，公网不再代理应用）。
#
# 用法：
#
#     sudo bash deploy/proxy/rollback-public-https.sh
#
# 不修改 UFW / 安全组 / SSH / sudoers，不删除 Let's Encrypt 证书。

set -euo pipefail

SITES_AVAILABLE="/etc/nginx/sites-available/chaoge-public.conf"
SITES_ENABLED="/etc/nginx/sites-enabled/chaoge-public.conf"

log() { printf '[chaoge-https-rollback] %s\n' "$*"; }
die() { printf '[chaoge-https-rollback] 错误：%s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "需要 root（请用 sudo）"
command -v nginx >/dev/null 2>&1 || die "本机没有 nginx"

BACKUP="$(ls -1t "$SITES_AVAILABLE".pre-https.* 2>/dev/null | head -n 1 || true)"

if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then
  cp -a "$BACKUP" "$SITES_AVAILABLE"
  ln -sfn "$SITES_AVAILABLE" "$SITES_ENABLED"
  log "已恢复：$BACKUP"
else
  rm -f "$SITES_ENABLED" "$SITES_AVAILABLE"
  log "没有备份，已移除 chaoge-public 站点配置"
fi

if ! nginx -t; then
  die "nginx -t 失败：配置未生效。请人工检查 /etc/nginx。"
fi

systemctl reload nginx
log "Nginx 已 reload。证书仍保留在 /etc/letsencrypt，可再次安装。"
