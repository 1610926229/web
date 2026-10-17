#!/usr/bin/env bash
#
# 超哥电竞 · Staging 公网只读预览：一次性安装 Nginx 反向代理
#
#     sudo bash deploy/proxy/install-public-proxy.sh
#
# ⚠️ 这是系统级变更（安装软件、写 /etc/nginx、启用 systemd 单元），
#    必须在产品负责人**明确批准**后执行。脚本本身不碰：
#      · 腾讯云安全组 / 防火墙（端口 80 的放行由人工在控制台完成）
#      · UFW / iptables
#      · SSH 配置
#      · sudoers
#      · 数据库、应用发布目录、systemd 的 chaoge-staging 单元
#
# 安装后的结构：
#
#     Internet :80 → Nginx → 127.0.0.1:3000 (chaoge-staging)
#
# 回滚：
#
#     sudo bash deploy/proxy/rollback-public-proxy.sh
#
# 安装顺序很重要：**先装好并本地验证，再去腾讯云开放 80**。
# 这样开放端口的那一刻，面对公网的就是已经验证过的配置。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="$HERE/chaoge-public.conf"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
CONF_DST="$SITES_AVAILABLE/chaoge-public.conf"
CONF_LINK="$SITES_ENABLED/chaoge-public.conf"
DEFAULT_LINK="$SITES_ENABLED/default"
BACKUP_ROOT="/var/backups/chaoge-public-proxy"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
# 本地验收必须**经过 Nginx**（80 → 127.0.0.1:3000），而不是直连上游：
# 直连 3000 测的是私有路径，看不到公网标记头与白名单是否真的生效。
PUBLIC_URL="http://127.0.0.1"

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }

# ── 0. 前置检查 ──────────────────────────────────────────────────────────────

step "0. 前置检查"

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行（安装软件、写 /etc/nginx、启用 systemd）。"
[[ -f "$CONF_SRC" && ! -L "$CONF_SRC" ]] || die "找不到配置模板：$CONF_SRC"
command -v apt-get >/dev/null 2>&1 || die "本脚本按 Ubuntu/Debian 的 apt 编写，找不到 apt-get。"
command -v curl >/dev/null 2>&1 || die "找不到 curl（安装 nginx 后需要它做本地验证）。"
ok "root / 配置模板 / apt / curl 就绪"

# ── 1. 安装 Nginx ────────────────────────────────────────────────────────────

step "1. 安装 Nginx"

if command -v nginx >/dev/null 2>&1; then
  ok "Nginx 已安装：$(nginx -v 2>&1)"
else
  info "安装 nginx（不安装推荐包）…"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx
  command -v nginx >/dev/null 2>&1 || die "nginx 安装后仍找不到可执行文件。"
  ok "Nginx 安装完成：$(nginx -v 2>&1)"
fi

# ── 2. 备份并停用默认站点 ────────────────────────────────────────────────────
#
# Ubuntu 的默认站点同样 listen 80 default_server。不先让它，`nginx -t` 会报
# conflicting server name / duplicate default server。

step "2. 备份现有站点配置"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

if [[ -e "$DEFAULT_LINK" || -L "$DEFAULT_LINK" ]]; then
  mv "$DEFAULT_LINK" "$BACKUP_DIR/sites-enabled-default"
  info "已停用并备份默认站点 → $BACKUP_DIR/sites-enabled-default"
fi

if [[ -e "$CONF_DST" ]]; then
  cp -a "$CONF_DST" "$BACKUP_DIR/chaoge-public.conf.previous"
  info "已备份旧的反代配置"
fi

if [[ -e "$CONF_LINK" || -L "$CONF_LINK" ]]; then
  rm -f "$CONF_LINK"
fi

ok "默认站点已让位，旧配置已备份到 $BACKUP_DIR"

# ── 3. 安装配置并测试 ────────────────────────────────────────────────────────

step "3. 安装反向代理配置"

install -m 0644 -o root -g root "$CONF_SRC" "$CONF_DST"
ln -sfn "$CONF_DST" "$CONF_LINK"

# 失败时恢复原状：移除本配置链接、恢复默认站点（如原本存在）。
rollback_config() {
  rm -f "$CONF_LINK"
  if [[ -e "$BACKUP_DIR/sites-enabled-default" || -L "$BACKUP_DIR/sites-enabled-default" ]]; then
    mv "$BACKUP_DIR/sites-enabled-default" "$DEFAULT_LINK"
  fi
}

if ! nginx -t; then
  rollback_config
  nginx -t >/dev/null 2>&1 || true
  die "nginx -t 未通过，已移除新配置链接并恢复默认站点。没有启用任何公网入口。"
fi
ok "nginx -t 通过"

# ── 4. 启用并加载 ────────────────────────────────────────────────────────────

step "4. 启用 Nginx"

systemctl enable nginx >/dev/null
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi
ok "Nginx 已启动/重载，并设为开机自启"

# ── 5. 本地验收（此时公网 80 仍应由腾讯云安全组阻断）────────────────────────

step "5. 本地验收"

HEADERS="$(mktemp)"
BODY="$(mktemp)"
CURL_ERR="$(mktemp)"
CURL_RC="$(mktemp)"
trap 'rm -f "$HEADERS" "$BODY" "$CURL_ERR" "$CURL_RC"' EXIT

# >>> http_of（tests/publicPreview.test.mjs 会提取这段做行为测试）>>>
#
# 用法：http_of [curl 选项...] <path>
#
# path 必须是**最后一个**参数，前面的参数原样传给 curl。两种调用都成立：
#
#     http_of /api/home
#     http_of -X POST -H 'content-type: application/json' -d '{}' /api/auth/mock-login
#
# ⚠️ 不要把 path 放在第一个参数。curl 会把选项值（如 POST）和路径当成 URL，
#    `-w '%{http_code}'` 对每个 URL 各输出一次，拼起来就是 `000000000`。
#    那是验收脚本的 bug，不是接口返回 000，也不能据此判断安全拦截是否生效。
#
# 请求经过 Nginx，把响应头/响应体分别落到临时文件，返回单个三位状态码。
# curl 失败时统一返回 `000`，退出码与 stderr 留给 dump_curl_diagnostics。
http_of() {
  local n=$#
  if (( n == 0 )); then
    printf 'http_of: 缺少路径参数\n' >&2
    printf '64\n' > "$CURL_RC"
    return 64
  fi
  local path="${@:n:1}"
  if (( n > 1 )); then
    set -- "${@:1:n-1}"
  else
    set --
  fi

  if [[ "$path" != /* ]]; then
    printf 'http_of: 最后一个参数必须是路径（以 / 开头），收到：%s\n' "$path" >&2
    printf '64\n' > "$CURL_RC"
    return 64
  fi

  local code rc
  local errexit=0
  [[ $- == *e* ]] && errexit=1
  set +e
  code="$(curl --noproxy '*' -sS -D "$HEADERS" -o "$BODY" \
    -w '%{http_code}' --max-time 8 "$@" "$PUBLIC_URL$path" 2>"$CURL_ERR")"
  rc=$?
  if (( errexit )); then set -e; fi

  # http_of 总是在 `CODE="$(http_of ...)"` 里执行，函数体是子 shell——普通变量
  # 传不回调用方。把退出码写进临时文件，die_probe 才能读到真实的 curl 状态。
  printf '%s\n' "$rc" > "$CURL_RC"

  # curl 对多个 URL 会输出多个 http_code（例如 000000000）。这里只接受恰好
  # 三位数字；其它情况一律记 000，避免把拼接结果当成状态码。
  if [[ ! "$code" =~ ^[0-9]{3}$ ]]; then
    code=000
  fi
  printf '%s' "$code"
}
# <<< http_of <<<

dump_curl_diagnostics() {
  local rc="?"
  if [[ -s "$CURL_RC" ]]; then
    rc="$(cat "$CURL_RC" 2>/dev/null || printf '?')"
  fi
  printf '    curl exit: %s\n' "${rc:-?}"
  if [[ -s "$CURL_ERR" ]]; then
    printf '    curl stderr:\n'
    sed -n '1,8p' "$CURL_ERR" | sed 's/^/      /'
  fi
}

# 探针失败时一并打印 curl 退出码与 stderr：000 往往意味着请求根本没发出去，
# 不能把它当成「接口返回 000」或「安全拦截成功」。
die_probe() {
  dump_curl_diagnostics
  die "$@"
}

# 只有本配置会返回该响应头。默认站点同样返回 200，所以**不能只看状态码**：
# reload 之后旧 worker 可能还会用旧配置接几个请求，只看 200 会误判成安装成功。
has_proxy_marker() {
  grep -qiE '^X-Chaoge-Public-Proxy: 1' "$HEADERS"
}

dump_home_diagnostics() {
  printf '  诊断（这些内容用于区分「默认站点」「代理到错误服务」「应用未就绪」）：\n'
  printf '    status: %s\n' "${CODE:-?}"
  printf '    title : %s\n' "$(grep -o '<title>[^<]*</title>' "$BODY" 2>/dev/null | head -1 || true)"
  printf '    body  : %s bytes\n' "$(wc -c < "$BODY" 2>/dev/null | tr -d ' ' || printf '?')"
  printf '    headers:\n'
  sed -n '1,15p' "$HEADERS" 2>/dev/null | sed 's/^/      /' || true
  dump_curl_diagnostics
  printf '    注意：站点配置已启用且 nginx -t 已通过（验收失败不会自动回滚）。\n'
  printf '    未查明原因前不要放行公网 80；回滚脚本：rollback-public-proxy.sh\n'
}

# 最多等 20 秒，直到响应同时满足：200 + chaoge 标记头。
READY=0
for _ in $(seq 1 40); do
  CODE="$(http_of /)"
  if [[ "$CODE" == "200" ]] && has_proxy_marker; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "$READY" != "1" ]]; then
  dump_home_diagnostics
  die "20 秒内没有等到 chaoge 站点响应（X-Chaoge-Public-Proxy: 1）。公网 80 不要放行。"
fi
ok "经 Nginx 访问首页 → 200，且响应来自 chaoge 站点"

TITLE="$(grep -o '<title>[^<]*</title>' "$BODY" | head -1 || true)"
if [[ "$TITLE" != "<title>超哥电竞</title>" ]]; then
  dump_home_diagnostics
  die "首页标题不是「超哥电竞」——代理可能落到了错误的服务。"
fi
ok "首页标题为「超哥电竞」"

# 这一条同时验证「Nginx 注入请求标记头」和「应用只读守卫」两层：
# 公网请求下 Mock 身份切换面板必须不出现在 HTML 里。
if grep -q '开发工具' "$BODY"; then
  die "首页 HTML 出现了 Mock 身份切换面板（开发工具）——公网标记头或应用守卫失效。"
fi
ok "公网页面不包含 Mock 身份切换面板"

CODE="$(http_of /api/home)"
[[ "$CODE" == "200" ]] || die_probe "GET /api/home → $CODE（期望 200）"
has_proxy_marker || die_probe "GET /api/home 的 200 不是 chaoge 站点返回的。"
grep -q '"announcements"' "$BODY" \
  || die_probe "GET /api/home 返回 200，但响应体不是首页数据（没有 announcements）。"
ok "公开只读接口 /api/home → 200，响应体是首页数据"

CODE="$(http_of /api/admin/dashboard)"
[[ "$CODE" == "404" ]] || die_probe "GET /api/admin/dashboard → $CODE（期望 404，Nginx 白名单失效）"
has_proxy_marker || die_probe "私有接口的 404 不是 chaoge 站点返回的——可能命中了默认站点。"
ok "私有接口 /api/admin/dashboard → 404（由 chaoge 站点拒绝）"

# 这条调用的 path 在最后。steps 里的 http_of 也支持选项在前，但绝不能把
# path 放到第一个参数——那正是 `000000000` 的来历。
CODE="$(http_of -X POST -H 'content-type: application/json' -d '{}' /api/auth/mock-login)"
[[ "$CODE" == "404" ]] || die_probe "POST /api/auth/mock-login → $CODE（期望 404，公网不得触达 Mock 登录）"
has_proxy_marker || die_probe "Mock 登录拒绝的 404 不是 chaoge 站点返回的。"
ok "POST /api/auth/mock-login → 404（无法切换到任何 Mock 身份）"

CODE="$(http_of /admin)"
[[ "$CODE" == "404" ]] || die_probe "GET /admin → $CODE（期望 404）"
has_proxy_marker || die_probe "管理后台 404 不是 chaoge 站点返回的。"
ok "管理后台 /admin → 404（由 chaoge 站点拒绝）"

# 监听面：Nginx 只应新增 80；上游必须仍是回环。
ss -ltn | grep -qE 'LISTEN[[:space:]].*:80[[:space:]]' \
  || die "没有看到 80 端口的监听。"
ok "80 端口已在监听"

ss -ltn | grep -qE '127\.0\.0\.1:3000[[:space:]]' \
  || die "Next.js 不在 127.0.0.1:3000 监听——上游绑定可能被改动。"
if ss -ltn | grep -qE '(0\.0\.0\.0|\*|\[::\]):3000[[:space:]]'; then
  die "3000 端口出现了非回环监听，停止并检查 systemd 单元。"
fi
ok "Next.js 仍只监听 127.0.0.1:3000"

if ss -ltn | grep -qE '0\.0\.0\.0:5432|\*:5432|\[::\]:5432'; then
  die "5432 端口出现了非回环监听，停止并检查 PostgreSQL 配置。"
fi
ok "PostgreSQL 仍只监听回环"

# ── 6. 完成 ──────────────────────────────────────────────────────────────────

step "6. 安装完成"

cat <<EOF

  本地链路已验证。**公网 80 尚未放行**：
  当前由腾讯云 Lighthouse 防火墙阻断，公网访客仍无法访问。

  下一步（人工、一次）：
    腾讯云控制台 → Lighthouse → 实例 → 防火墙 → 添加规则
    协议 TCP · 端口 80 · 来源 0.0.0.0/0

  开放后再验收：
    curl -I http://43.128.13.181/
    curl -o /dev/null -w '%{http_code}\n' http://43.128.13.181/api/admin/dashboard   # 期望 404

  回滚（关闭公网入口）：
    sudo bash deploy/proxy/rollback-public-proxy.sh

  备份目录：$BACKUP_DIR
EOF
