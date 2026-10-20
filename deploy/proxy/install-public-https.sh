#!/usr/bin/env bash
#
# 超哥电竞 · Staging 公网 HTTPS 安装器（PROD-6）
#
# ⚠️ **需要产品负责人明确批准后才能执行。** 本脚本会：
#   1. 在缺少 certbot 时通过 apt 安装；
#   2. 为指定域名签发 Let's Encrypt 证书（standalone 模式，期间会短暂停止 Nginx）；
#   3. 用 `chaoge-public-https.conf.template` 覆盖站点配置并 reload。
#
# 不做：不修改 UFW / iptables / 安全组 / SSH / sudoers；不开放 3000 / 5432；
#       不改数据库；不读取或输出任何应用凭据。
#
# 用法：
#
#     sudo bash deploy/proxy/install-public-https.sh \
#       --server-name chaoge.example.com \
#       --email ops@example.com \
#       --apply
#
# 不带 `--apply` 时只做预检并打印将要执行的步骤（可普通用户运行）。
#
# 回滚：
#
#     sudo bash deploy/proxy/rollback-public-https.sh

set -euo pipefail

SERVER_NAME=""
EMAIL=""
APPLY=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/chaoge-public-https.conf.template"
SNIPPETS=(
  "$SCRIPT_DIR/chaoge-proxy-public.inc"
  "$SCRIPT_DIR/chaoge-proxy-session.inc"
)
SITES_AVAILABLE="/etc/nginx/sites-available/chaoge-public.conf"
SITES_ENABLED="/etc/nginx/sites-enabled/chaoge-public.conf"
SNIPPET_DIR="/etc/nginx/snippets"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$SITES_AVAILABLE.pre-https.$STAMP"

log() { printf '[chaoge-https] %s\n' "$*"; }
die() { printf '[chaoge-https] 错误：%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-name)
      [[ $# -ge 2 ]] || die "--server-name 缺少参数"
      SERVER_NAME="$2"
      shift 2
      ;;
    --email)
      [[ $# -ge 2 ]] || die "--email 缺少参数"
      EMAIL="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（--help 查看用法）"
      ;;
  esac
done

[[ -n "$SERVER_NAME" ]] || die "必须提供 --server-name"
[[ -n "$EMAIL" ]] || die "必须提供 --email（Let's Encrypt 到期通知）"
[[ "$SERVER_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
  || die "域名格式不合法：$SERVER_NAME（只允许小写字母、数字、连字符与点）"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "邮箱格式不合法"
[[ -f "$TEMPLATE" ]] || die "找不到模板：$TEMPLATE"
for snippet in "${SNIPPETS[@]}"; do
  [[ -f "$snippet" ]] || die "找不到片段：$snippet"
done
command -v nginx >/dev/null 2>&1 || die "本机没有 nginx"

if [[ "$APPLY" == "1" ]]; then
  [[ "$(id -u)" == "0" ]] || die "--apply 需要 root（请用 sudo）"
fi

log "域名：$SERVER_NAME"
log "模板：$TEMPLATE"
log "证书：/etc/letsencrypt/live/$SERVER_NAME/"

if [[ "$APPLY" != "1" ]]; then
  log "预检通过（未执行）。加 --apply 才会安装证书、写配置并 reload Nginx。"
  exit 0
fi

# ── 1. 域名解析检查（只警告，不阻断：允许先在证书签发后再切 DNS）──────────
if command -v dig >/dev/null 2>&1; then
  RESOLVED="$(dig +short A "$SERVER_NAME" | tail -n 1 || true)"
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
  if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
    log "警告：$SERVER_NAME 解析到 $RESOLVED，本机公网 IP 是 $PUBLIC_IP。"
    log "      如果证书签发失败，请先修正 A 记录。"
  fi
fi

# ── 2. certbot ──────────────────────────────────────────────────────────────
if ! command -v certbot >/dev/null 2>&1; then
  log "安装 certbot（apt）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot
fi

CERT_DIR="/etc/letsencrypt/live/$SERVER_NAME"
if [[ ! -s "$CERT_DIR/fullchain.pem" || ! -s "$CERT_DIR/privkey.pem" ]]; then
  log "签发证书（standalone；期间短暂停止 Nginx）"
  NGINX_WAS_RUNNING=0
  if systemctl is-active --quiet nginx; then
    NGINX_WAS_RUNNING=1
    systemctl stop nginx
  fi
  restart_nginx() {
    if [[ "$NGINX_WAS_RUNNING" == "1" ]]; then
      systemctl start nginx || true
    fi
  }
  trap restart_nginx EXIT

  if ! certbot certonly --standalone --non-interactive --agree-tos \
      --email "$EMAIL" -d "$SERVER_NAME"; then
    die "证书签发失败。请检查 DNS、80 端口与安全组后重试；Nginx 已恢复原状态。"
  fi

  trap - EXIT
  restart_nginx
else
  log "证书已存在，跳过签发"
fi

# ── 3. 渲染并安装配置 ──────────────────────────────────────────────────────
TMP_CONF="$(mktemp)"
trap 'rm -f "$TMP_CONF"' EXIT
sed "s|__SERVER_NAME__|$SERVER_NAME|g" "$TEMPLATE" > "$TMP_CONF"

if grep -q '__SERVER_NAME__' "$TMP_CONF"; then
  die "模板仍有未替换的占位符"
fi

install -d -m 0755 "$SNIPPET_DIR"
install -m 0644 "${SNIPPETS[0]}" "$SNIPPET_DIR/chaoge-proxy-public.inc"
install -m 0644 "${SNIPPETS[1]}" "$SNIPPET_DIR/chaoge-proxy-session.inc"

if [[ -f "$SITES_AVAILABLE" ]]; then
  cp -a "$SITES_AVAILABLE" "$BACKUP"
  log "已备份旧配置：$BACKUP"
fi

install -m 0644 "$TMP_CONF" "$SITES_AVAILABLE"
ln -sfn "$SITES_AVAILABLE" "$SITES_ENABLED"

restore_previous() {
  if [[ -f "$BACKUP" ]]; then
    cp -a "$BACKUP" "$SITES_AVAILABLE"
    log "已恢复旧配置：$BACKUP"
  else
    rm -f "$SITES_ENABLED" "$SITES_AVAILABLE"
    log "没有旧配置可恢复，已移除新配置"
  fi
  nginx -t && systemctl reload nginx || true
}

if ! nginx -t; then
  restore_previous
  die "nginx -t 失败，已回滚，未 reload"
fi

systemctl reload nginx
log "Nginx 已 reload"

# ── 4. 本机验收（--resolve 不依赖 DNS 已生效）──────────────────────────────
BASE_URL="https://$SERVER_NAME"
probe() {
  # probe <expected-codes-regex> <description> <curl args...>
  local expected="$1" label="$2"
  shift 2
  local code
  code="$(curl -sS --max-time 10 --resolve "$SERVER_NAME:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' "$@" || true)"
  if [[ ! "$code" =~ ^($expected)$ ]]; then
    die "验收失败：$label（期望 $expected，实际 $code）"
  fi
  log "通过：$label（$code）"
}

probe '200' '客服登录页' "$BASE_URL/staff/login"
probe '200' '管理员登录页' "$BASE_URL/admin/login"
probe '30[78]' '未登录 /staff 重定向' "$BASE_URL/staff"
probe '30[78]' '未登录 /admin 重定向' "$BASE_URL/admin"
probe '401' '未登录客服接口' "$BASE_URL/api/staff/orders"
probe '401' '未登录管理接口' "$BASE_URL/api/admin/dashboard"
probe '404' 'Mock 登录接口' -X POST "$BASE_URL/api/auth/mock-login"
probe '404' 'Mock 管理登录接口' -X POST "$BASE_URL/api/admin/auth/mock-login"
probe '200' '公开首页 API' "$BASE_URL/api/home"

# CSRF：不带 Origin 的 POST 必须在到达路由前被拒绝（403，而不是 401）。
CSRF_CODE="$(curl -sS --max-time 10 --resolve "$SERVER_NAME:443:127.0.0.1" \
  -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{}' \
  "$BASE_URL/api/staff/auth/login" || true)"
[[ "$CSRF_CODE" == "403" ]] || die "CSRF 验收失败：缺 Origin 的登录 POST 期望 403，实际 $CSRF_CODE"
log "通过：缺 Origin 的登录 POST 被拒绝（403）"

HTTP_CODE="$(curl -sS --max-time 10 --resolve "$SERVER_NAME:80:127.0.0.1" \
  -o /dev/null -w '%{http_code}' "http://$SERVER_NAME/staff/login" || true)"
[[ "$HTTP_CODE" == "301" ]] || die "HTTP 跳转验收失败：期望 301，实际 $HTTP_CODE"
log "通过：HTTP → HTTPS 301"

log "安装完成。下一步："
log "  1. 在无 SSH 隧道的普通设备上打开 $BASE_URL/staff/login 与 $BASE_URL/admin/login；"
log "  2. 用真实客服 / 管理员账号完成登录、授权操作与退出；"
log "  3. 微信真实登录需要 AppID / AppSecret / 授权回调域名，未配置前不会可用。"
