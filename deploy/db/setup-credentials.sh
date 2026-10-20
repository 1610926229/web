#!/usr/bin/env bash
#
# PROD-2 · 超哥电竞 · 生产凭据文件生成（只在生产服务器上运行）
#
#     deploy/db/setup-credentials.sh [选项]
#
# 在服务器上生成 `/etc/chaoge/db.env`，供 Next.js 服务进程读取。
#
# ## 为什么要有这个脚本，而不是「scp 一个 .env 上去」
#
# 手写一个 `.env` 再传上去，最容易出岔子的不是内容而是**权限**：
# 一个 `cp` 出来的文件默认是 0644——任何本地用户都能读到生产库口令，
# 而且这件事不会报错、不会被提醒，只会在某天被审计出来。
# 这里把「写入时机、属主、权限」固化成一条原子路径：
#
#     mktemp 建 0600 临时文件 → 写完 → chown/chmod → mv 就位
#
# 临时文件全程在 0600 下，`mv` 是同目录内的原子替换，因此
# **不存在任何一刻让这个文件对 others 可读**。直接 `>` 重定向到目标路径则做不到这点：
# 它先创建（受当时 umask 影响）再写入，中间那一下就是敞口。
#
# ## 口令从哪来
#
# 只用 `read -s` 从终端读，**不接受命令行参数、不读环境变量、不读管道**。
# 于是明文不会出现在：shell 历史（不是参数）、`ps` 输出（不是参数）、
# `/proc/PID/environ`（不是环境变量）、任何日志（脚本不打印它）。
#
# 服务端收到的也不会是明文：PostgreSQL 客户端在本地算出 SCRAM 验证器再发出去。
# 明文只在这个进程的内存里存在，写完文件即随进程消失。

set -euo pipefail

ENV_PATH="${CHAOGE_ENV_PATH:-/etc/chaoge/db.env}"
SERVICE_USER="${CHAOGE_SERVICE_USER:-chaoge}"
SERVICE_GROUP="${CHAOGE_SERVICE_GROUP:-chaoge}"
DB_HOST="127.0.0.1"
DB_PORT="5432"
DB_NAME="chaoge_prod"
DB_ROLE="chaoge_app"
DO_CHECK=1
FORCE=0

usage() {
  cat <<'USAGE'
用法: setup-credentials.sh [选项]

  --path PATH      凭据文件路径（默认 /etc/chaoge/db.env）
  --user NAME      服务运行账号，文件属主（默认 chaoge）
  --group NAME     服务运行组，文件属组、组内可读（默认 chaoge）
  --database NAME  目标库（默认 chaoge_prod）
  --role NAME      应用角色（默认 chaoge_app）
  --host HOST      数据库地址（默认 127.0.0.1；本方案只监听本机）
  --port PORT      端口（默认 5432）
  --no-check       写完不试连
  --force          目标文件已存在时直接覆盖（默认会先问）
  -h, --help       本帮助

权限模型:
  /etc/chaoge         root:<group>  0750
  /etc/chaoge/db.env  root:<group>  0640

  0640 = 属主 root 可读写、组内（即服务账号）可读、others 一律不可读。
  这是「服务进程读得到、同机其它用户读不到」的最小权限。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)     ENV_PATH="${2:?}"; shift 2 ;;
    --user)     SERVICE_USER="${2:?}"; shift 2 ;;
    --group)    SERVICE_GROUP="${2:?}"; shift 2 ;;
    --database) DB_NAME="${2:?}"; shift 2 ;;
    --role)     DB_ROLE="${2:?}"; shift 2 ;;
    --host)     DB_HOST="${2:?}"; shift 2 ;;
    --port)     DB_PORT="${2:?}"; shift 2 ;;
    --no-check) DO_CHECK=0; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "未知选项「$1」" >&2; usage >&2; exit 2 ;;
  esac
done

die() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info(){ printf '  %s\n' "$*"; }
warn(){ printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }

# ── 前置条件 ──────────────────────────────────────────────────────────────────

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行：要写 /etc 下的文件并 chown 给服务账号。"

# 属主/属组必须真实存在。不存在就 chown 失败，而 chown 失败之后文件已经写出来了——
# 那会留下一个属主是 root:root 的 0640 文件，服务账号读不到，服务起不来，
# 而报错发生在几步之后。在这里先拦住。
id -u "$SERVICE_USER"  >/dev/null 2>&1 || die "服务账号「$SERVICE_USER」不存在。先创建它，或用 --user 指定。"
getent group "$SERVICE_GROUP" >/dev/null 2>&1 || die "服务组「$SERVICE_GROUP」不存在。先创建它，或用 --group 指定。"

case "$ENV_PATH" in
  /etc/*) ;;
  *) die "凭据文件必须放在 /etc 下（当前：$ENV_PATH）。放仓库或家目录里迟早会被误提交或误备份。" ;;
esac

# ── URL 编码 ──────────────────────────────────────────────────────────────────
#
# 连接串里的口令必须百分号编码：口令里一个 `@` 会让 host 被解析错，
# 一个 `:` 会让端口被解析错，而这两种错误都表现为「连不上」，
# 排查时会往网络和权限上找，很难想到是口令里的一个字符。
LC_ALL=C
urlencode() {
  local s="$1" out="" c i
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# ── 读取口令 ──────────────────────────────────────────────────────────────────

[[ -t 0 ]] || die "需要交互式终端输入口令。本脚本刻意不支持从管道/参数传入——那会让明文进入历史或进程列表。"

if [[ -e "$ENV_PATH" && "$FORCE" != "1" ]]; then
  warn "目标文件已存在：$ENV_PATH"
  printf '  覆盖会替换掉里面现有的口令。输入 yes 继续: '
  answer=""; read -r answer
  [[ "$answer" == "yes" ]] || { info "已取消，未做任何改动。"; exit 1; }
fi

# RAW_PW 是**普通 shell 变量，不是环境变量**（没有 export，也不在 `read` 之前存在
# 于环境中），因此它不会出现在 /proc/PID/environ 里。这一点是刻意的：
# 后面写 .pgpass 试连时要用**明文**口令，而 .pgpass 的字段是明文、不做百分号解码。
# 若图省事从写好的 URL 反推口令，`@` 会以 `%40` 的形式落进 .pgpass，
# 试连就会假失败——而假失败比不检查更糟：它会让人去查网络和授权，查很久。
RAW_PW=""
printf '  请输入 %s@%s 的口令（输入不回显）: ' "$DB_ROLE" "$DB_HOST"
read -rs RAW_PW; printf '\n'
CONFIRM_PW=""
printf '  再输入一次确认: '
read -rs CONFIRM_PW; printf '\n'

[[ -n "$RAW_PW" ]] || die "口令为空。空口令会让 peer/host 认证形同虚设。"
[[ "$RAW_PW" == "$CONFIRM_PW" ]] || die "两次输入不一致。"

unset CONFIRM_PW
if (( ${#RAW_PW} < 12 )); then
  warn "口令短于 12 个字符。本方案里数据库只监听本机，口令是纵深防御的一层，建议再长一些。"
fi

ENCODED_PW="$(urlencode "$RAW_PW")"

# ── 原子写入 ──────────────────────────────────────────────────────────────────

ENV_DIR="$(dirname "$ENV_PATH")"
mkdir -p "$ENV_DIR"
chown "root:$SERVICE_GROUP" "$ENV_DIR"
chmod 750 "$ENV_DIR"

TMP="$(mktemp "$ENV_DIR/.db.env.XXXXXX")"
chmod 600 "$TMP"

# 这两行是 PROD-1A 的既定契约（见 .env.example）：
#   DATA_SOURCE 只有显式等于 postgres 才切库，否则整个应用退回 Mock store；
#   DATABASE_URL 缺失时是 fail-fast 抛错，而不是「连不上但查询都返回空列表」。
#
# 刻意**不写** ENABLE_MOCK_AUTH / ENABLE_MOCK_DEBUG / ENABLE_MOCK_PAYMENT /
# ENABLE_MOCK_ADMIN / ENABLE_MOCK_STAFF —— 那五个开关在 .env.example 里的规则是
# 「显式等于字符串 true 才开启」，所以「不写」就等于关闭；而 ENABLE_MOCK_DEBUG
# 会开放 POST /api/debug/reset 这个清库接口，生产上不能有任何一行写着它。
cat > "$TMP" <<EOF
# 由 deploy/db/setup-credentials.sh 生成 —— 请勿手工编辑，勿纳入版本控制。
#
# 权限 root:$SERVICE_GROUP 0640：服务进程（$SERVICE_USER）可读，同机其它用户不可读。
# 改口令后重新运行该脚本，不要在这里手改。

DATA_SOURCE=postgres
DATABASE_URL=postgresql://$DB_ROLE:$ENCODED_PW@$DB_HOST:$DB_PORT/$DB_NAME
EOF
unset ENCODED_PW

chown "root:$SERVICE_GROUP" "$TMP"
chmod 640 "$TMP"
mv -f "$TMP" "$ENV_PATH"          # 同目录内原子替换，全程没有 others 可读的瞬间

# ── 自检 ──────────────────────────────────────────────────────────────────────

ACT="$(stat -c '%U:%G %a' "$ENV_PATH")"
ok "已写出 $ENV_PATH（$ACT）"
[[ "$ACT" == "root:$SERVICE_GROUP 640" ]] || die "权限不符合预期：$ACT，期望 root:$SERVICE_GROUP 640。"

if [[ "$SERVICE_USER" == "$SERVICE_GROUP" ]] && ! id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$SERVICE_GROUP"; then
  warn "账号 $SERVICE_USER 不是组 $SERVICE_GROUP 的成员，读不到这个文件。"
  warn "修：usermod -aG $SERVICE_GROUP $SERVICE_USER"
fi

# 只打印变量**名**，绝不打印值。
info "文件内的变量: $(grep -oE '^[A-Z_]+=' "$ENV_PATH" | tr -d '=' | paste -sd' ')"

# ── 试连（用临时 .pgpass，让口令不进 argv / 环境变量 / 历史）──────────────────

if [[ "$DO_CHECK" == "1" ]]; then
  if ! command -v psql >/dev/null 2>&1; then
    warn "找不到 psql，跳过试连。"
  else
    PGPASS_TMP="$(mktemp)"; chmod 600 "$PGPASS_TMP"
    cleanup_pgpass() { rm -f "$PGPASS_TMP"; }
    trap cleanup_pgpass EXIT INT TERM

    # 直接写明文口令，不从 URL 反推（见上面 RAW_PW 处的说明）。
    # host 字段对 127.0.0.1 也要写成 127.0.0.1 而不是 localhost：
    # 客户端是按「实际连过去的地址」匹配的，写 localhost 匹配不上。
    printf '%s:%s:%s:%s:%s\n' "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_ROLE" "$RAW_PW" > "$PGPASS_TMP"

    # 试连的结果直接进 shell 变量，**不落盘**。
    #
    # 旧写法把它重定向到固定路径 /tmp/.chaoge_conn。那个路径是全世界可预测的：
    # 同机任何用户都可以抢先在那里放一个符号链接，`>` 会顺着链接把目标文件
    # 截断/覆盖（经典 `>` 不做 O_NOFOLLOW 的问题）；放一个普通文件也能让 `cat`
    # 读到别人的内容。写进去的虽然只是 `connected as chaoge_app` 而非口令，
    # 但这与「拿一个可预测的公共路径当自己的私有暂存」是同一个错误——
    # 而口令就住在同一个函数里，边上只是运气好。
    # 变量没有这个问题：不落盘、不可预测、不需要清理。
    conn_out=""
    if conn_out="$(PGPASSFILE="$PGPASS_TMP" psql -w -h "$DB_HOST" -p "$DB_PORT" -U "$DB_ROLE" -d "$DB_NAME" \
         -At -q -c "SELECT 'connected as ' || current_user" 2>/dev/null)"; then
      ok "试连成功: $conn_out"
    else
      warn "试连失败。这通常**不是**口令问题，而是："
      warn "  · 还没有跑 03-migrator-grants.sql（chaoge_app 没有 CONNECT 权）"
      warn "  · 或该角色尚未用 \\password 设置过口令"
      warn "先跑 deploy.sh check 看角色与授权状态。"
    fi
    unset conn_out

    cleanup_pgpass; trap - EXIT INT TERM
  fi
fi

# 明文口令的使命到此为止。剩下的输出里没有任何一处会引用它。
unset RAW_PW

echo
ok "完成。下一步："
info "  1. 让服务读到它（systemd：EnvironmentFile=$ENV_PATH）"
info "  2. sudo -u $SERVICE_USER test -r $ENV_PATH && echo readable"
info "  3. 确认没有把 ENABLE_MOCK_* 带进生产环境"
