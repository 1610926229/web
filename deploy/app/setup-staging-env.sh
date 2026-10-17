#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.2 · 生成 staging 运行时环境变量文件
#
#     sudo deploy/app/setup-staging-env.sh [选项]
#
# 在服务器上生成 `/etc/chaoge/staging.env`（root:chaoge 0640），
# 供 systemd 的 `EnvironmentFile=` 读取。
#
# ## 独立数据库（Step 5.8.2）
#
# staging 运行时只允许连接**独立的** `chaoge_staging` 库，使用**独立的**
# `chaoge_staging_app` 角色。生产凭据 `chaoge_app` / `chaoge_prod` 在这里是硬拒绝，
# 不是提示：一次 `--database chaoge_prod` 误传，就意味着 Staging 的 Mock 测试数据
# 会直接写进正式库。库名与角色名在参数解析阶段就被校验，不依赖任何网络条件。
#
# ## 为什么不是「手写一个文件再 scp 上去」
#
# 手写 `scp` 最容易出岔子的不是内容而是**权限**：一个 `cp` 出来的文件默认 0644，
# 同机任何用户都能读到数据库口令，而这件事不会报错、不会被提醒。
# 这里把写入时机、属主、权限固化成一条原子路径：
#
#     mktemp 建 0600 临时文件 → 写完 → chown/chmod → mv 就位
#
# 临时文件全程在 0600 下，`mv` 是同目录内的原子替换，
# **不存在任何一刻让这个文件对 others 可读**。
#
# ## 口令从哪来
#
# 只用 `read -s` 从终端读，**不接受命令行参数、不读环境变量、不读管道**。
# 于是明文不会出现在 shell 历史、`ps` 输出、`/proc/PID/environ` 或任何日志里。

set -euo pipefail

ENV_PATH="${CHAOGE_STAGING_ENV:-/etc/chaoge/staging.env}"
SERVICE_USER="${CHAOGE_SERVICE_USER:-chaoge}"
SERVICE_GROUP="${CHAOGE_SERVICE_GROUP:-chaoge}"
DB_HOST="${CHAOGE_DB_HOST:-127.0.0.1}"
DB_PORT="${CHAOGE_DB_PORT:-5432}"
DB_NAME="chaoge_staging"
DB_ROLE="chaoge_staging_app"
WITH_MOCK=1
DRY_RUN=0
FORCE=0
DO_CHECK=1

usage() {
  cat <<'USAGE'
用法: setup-staging-env.sh [选项]

  --path PATH       输出路径（默认 /etc/chaoge/staging.env）
  --user NAME       服务账号 / 文件属组（默认 chaoge）
  --database NAME   目标库（默认 chaoge_staging；**只允许** chaoge_staging*）
  --role NAME       运行时角色（默认 chaoge_staging_app；**不得**用 postgres /
                    chaoge_migrator / 生产的 chaoge_app）
  --host HOST       数据库地址（默认 127.0.0.1，只允许回环）
  --port PORT       端口（默认 5432）
  --no-mock         不写入四个 ENABLE_MOCK_* 开关（接入真实登录后使用）
  --no-check        写完不试连（默认会用临时 .pgpass 试连一次）
  --dry-run         只打印将写入的内容（口令以 <REDACTED> 代替），不落盘
  --force           目标文件已存在时直接覆盖（默认先问）
  -h, --help        本帮助

权限模型:
  /etc/chaoge            root:chaoge  0750
  /etc/chaoge/staging.env root:chaoge 0640
USAGE
}

die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)      ENV_PATH="${2:?}"; shift 2 ;;
    --user)      SERVICE_USER="${2:?}"; SERVICE_GROUP="$SERVICE_USER"; shift 2 ;;
    --database)  DB_NAME="${2:?}"; shift 2 ;;
    --role)      DB_ROLE="${2:?}"; shift 2 ;;
    --host)      DB_HOST="${2:?}"; shift 2 ;;
    --port)      DB_PORT="${2:?}"; shift 2 ;;
    --no-mock)   WITH_MOCK=0; shift ;;
    --no-check)  DO_CHECK=0; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

# ── 库名与角色守卫：staging 必须使用自己的库和账号 ─────────────────────────────
#
# 这些检查全部在**读口令之前**执行。理由不只是「早点失败」：
# 一个指向 chaoge_prod 的调用如果先提示输入生产应用口令，运维会在还没看到
# 任何警告的情况下把生产口令打进终端——口令不该在一个注定被拒绝的流程里出现。
#
# 纯字符串校验放在 root 检查之前：参数本身就不合法的调用，无论以什么身份执行
# 都应该得到同一条拒绝理由（本地测试也据此验证守卫，而不必伪造 root）。

case "$DB_ROLE" in
  postgres)
    die "运行时绝不能用 postgres（超级用户）。请用 chaoge_staging_app。" ;;
  chaoge_migrator|chaoge_staging_migrator)
    die "运行时不能用迁移角色（$DB_ROLE）。请用 chaoge_staging_app。" ;;
  chaoge_app)
    die "运行时不得复用生产应用角色 chaoge_app —— Step 5.8.2 要求 staging 使用独立账号。
      请用 chaoge_staging_app（见 deploy/db/staging/README.md）。" ;;
esac

if [[ "$DB_ROLE" != "chaoge_staging_app" ]]; then
  die "staging 运行时角色必须是 chaoge_staging_app（当前：$DB_ROLE）。"
fi

if [[ "$DB_NAME" == "chaoge_prod" || "$DB_NAME" == "chaoge_esports_dev" || "$DB_NAME" == "chaoge_esports_test" ]]; then
  die "拒绝对「$DB_NAME」生成 staging 环境：staging 必须使用独立的 chaoge_staging 库。"
fi

if [[ ! "$DB_NAME" =~ ^chaoge_staging(_[a-z0-9]+)*$ ]]; then
  die "库名「$DB_NAME」不允许：只接受 chaoge_staging 或 chaoge_staging_<后缀>。"
fi

case "$DB_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) die "数据库地址必须是回环（127.0.0.1 / localhost / ::1），当前：$DB_HOST。" ;;
esac

case "$ENV_PATH" in
  /etc/*) ;;
  *) die "环境变量文件必须放在 /etc 下（当前：$ENV_PATH）。" ;;
esac

# ── 执行身份与服务账号（参数校验之后） ─────────────────────────────────────────

[[ "$(id -u)" == "0" ]] || die "必须以 root 运行：要写 /etc 下的文件并 chown 给服务账号。"

id -u "$SERVICE_USER" >/dev/null 2>&1 || die "服务账号「$SERVICE_USER」不存在。先跑 deploy/app/create-service-user.sh。"
getent group "$SERVICE_GROUP" >/dev/null 2>&1 || die "服务组「$SERVICE_GROUP」不存在。"

# ── URL 编码 ──────────────────────────────────────────────────────────────────
#
# 口令里的 `@` / `:` / `/` / `#` 会让连接串解析错，而错误统一表现为「连不上」。

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

# ── 读口令（dry-run 不读）─────────────────────────────────────────────────────

RAW_PW=""
ENCODED_PW="<REDACTED>"

if [[ "$DRY_RUN" == "0" ]]; then
  [[ -t 0 ]] || die "需要交互式终端输入口令。本脚本刻意不支持从管道/参数传入。"

  if [[ -e "$ENV_PATH" && "$FORCE" != "1" ]]; then
    warn "目标文件已存在：$ENV_PATH"
    printf '  覆盖会替换掉里面现有的口令。输入 yes 继续: '
    answer=""; read -r answer
    [[ "$answer" == "yes" ]] || { info "已取消，未做任何改动。"; exit 1; }
  fi

  printf '  请输入 %s@%s/%s 的口令（输入不回显）: ' "$DB_ROLE" "$DB_HOST" "$DB_NAME"
  read -rs RAW_PW; printf '\n'
  CONFIRM_PW=""
  printf '  再输入一次确认: '
  read -rs CONFIRM_PW; printf '\n'

  [[ -n "$RAW_PW" ]] || die "口令为空。"
  [[ "$RAW_PW" == "$CONFIRM_PW" ]] || die "两次输入不一致。"
  unset CONFIRM_PW

  ENCODED_PW="$(urlencode "$RAW_PW")"
fi

# ── 写入前试连：确认凭据真的能连上**这个独立库** ────────────────────────────────
#
# 为什么必须在写入前做：写成 0640 的文件一旦落盘，systemd 下一次重启就会用它。
# 一个指向错误库、或角色没有 CONNECT 的连接串，如果不在这里失败，
# 会表现为「服务起来了但所有接口 500」——那时排查要从应用日志反推数据库配置。
#
# 口令经临时 .pgpass 传给 psql（0600、随机路径、退出即删）：
# 不放进 argv（`ps` 可见）、不放环境变量（/proc/PID/environ 可见）、不落日志。
# `.pgpass` 的字段是明文、不做百分号解码，因此这里用 RAW_PW 而不是编码后的 URL。

if [[ "$DO_CHECK" == "1" ]]; then
  if ! command -v psql >/dev/null 2>&1; then
    warn "找不到 psql，跳过试连。环境变量文件仍会写入，但连接正确性未被验证。"
  else
    PGPASS_TMP="$(mktemp)"; chmod 600 "$PGPASS_TMP"
    trap 'rm -f "$PGPASS_TMP"' EXIT INT TERM

    printf '%s:%s:%s:%s:%s\n' "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_ROLE" "$RAW_PW" > "$PGPASS_TMP"

    CONN_OK=""
    CONN_RC=0
    CONN_OK="$(PGPASSFILE="$PGPASS_TMP" psql -w -h "$DB_HOST" -p "$DB_PORT" \
      -U "$DB_ROLE" -d "$DB_NAME" -At -q -v ON_ERROR_STOP=1 \
      -c "SELECT current_user || '|' || current_database() || '|' ||
                 coalesce((SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user), 'unknown')" 2>&1)" \
      || CONN_RC=$?

    rm -f "$PGPASS_TMP"; trap - EXIT INT TERM

    if (( CONN_RC != 0 )); then
      die "试连失败（psql 退出码 $CONN_RC）：${CONN_OK:-（无输出）}
      常见原因：数据库 $DB_NAME 尚未创建、角色口令未设置、
      deploy/db/staging 的 init 尚未执行（PUBLIC 的 CONNECT 已收回，只有显式授权才能连）。
      修正后重跑本脚本；**不要**先写文件再靠重启服务来发现这个问题。"
    fi

    if [[ "$CONN_OK" != "$DB_ROLE|$DB_NAME|false" ]]; then
      die "试连结果不符合预期：得到「$CONN_OK」，期望「$DB_ROLE|$DB_NAME|false」。
      这意味着连上的库 / 角色不对，或运行时角色带有超级用户属性。拒绝写入。"
    fi

    ok "试连成功：$DB_ROLE@$DB_NAME（非超级用户）"
  fi
fi

# ── 组装内容 ──────────────────────────────────────────────────────────────────

MOCK_BLOCK=""
if [[ "$WITH_MOCK" == "1" ]]; then
  MOCK_BLOCK=$'ENABLE_MOCK_AUTH=true\nENABLE_MOCK_ADMIN=true\nENABLE_MOCK_STAFF=true\nENABLE_MOCK_PAYMENT=true'
fi

render_env() {
  cat <<EOF
# 由 deploy/app/setup-staging-env.sh 生成 —— 请勿手工编辑，勿纳入版本控制。
#
# 权限 root:$SERVICE_GROUP 0640：运行时账号（$SERVICE_USER）可读，同机其它用户不可读。
# 改口令后重新运行该脚本。
#
# ⚠️ 这里刻意没有 HOSTNAME / PORT：绑定地址写死在 systemd 单元的 ExecStart 里，
#    避免配置文件把服务绑到 0.0.0.0。

NODE_ENV=production
DATA_SOURCE=postgres
DATABASE_URL=postgresql://$DB_ROLE:$ENCODED_PW@$DB_HOST:$DB_PORT/$DB_NAME

# 2 vCPU / 2GB 单机：应用池上限压到 5。默认的生产值 10 在同时跑
# PostgreSQL（约 0.5GB）与 Node（约 0.3GB）的机器上留给系统头的余量太薄。
PG_POOL_MAX=5

${MOCK_BLOCK:+$MOCK_BLOCK}
EOF
}

if [[ "$DRY_RUN" == "1" ]]; then
  info "--dry-run：以下内容**不会**写入磁盘（口令已替换为 <REDACTED>）："
  echo "────────────────────────────────────────"
  render_env
  echo "────────────────────────────────────────"
  exit 0
fi

# ── 原子写入 ──────────────────────────────────────────────────────────────────

ENV_DIR="$(dirname "$ENV_PATH")"
mkdir -p "$ENV_DIR"
chown "root:$SERVICE_GROUP" "$ENV_DIR"
chmod 750 "$ENV_DIR"

TMP="$(mktemp "$ENV_DIR/.staging.env.XXXXXX")"
chmod 600 "$TMP"

render_env > "$TMP"

chown "root:$SERVICE_GROUP" "$TMP"
chmod 640 "$TMP"
mv -f "$TMP" "$ENV_PATH"          # 同目录原子替换，全程没有 others 可读的瞬间

unset RAW_PW ENCODED_PW

# ── 自检 ──────────────────────────────────────────────────────────────────────

ACT="$(stat -c '%U:%G %a' "$ENV_PATH")"
ok "已写出 $ENV_PATH（$ACT）"
[[ "$ACT" == "root:$SERVICE_GROUP 640" ]] || die "权限不符合预期：$ACT，期望 root:$SERVICE_GROUP 640。"

# 绑定地址不能出现在这里（见文件头）：systemd 的 EnvironmentFile 会覆盖 unit 设置。
if grep -qE '^(HOSTNAME|PORT)=' "$ENV_PATH"; then
  die "环境变量文件里出现了 HOSTNAME 或 PORT —— 这会覆盖 systemd 单元里的回环绑定设置，拒绝保留该文件。"
fi

# 只打印变量**名**，绝不打印值。
info "文件内的变量: $(grep -oE '^[A-Z_]+=' "$ENV_PATH" | tr -d '=' | paste -sd' ')"

if grep -qx 'ENABLE_MOCK_DEBUG=true' "$ENV_PATH"; then
  die "环境变量文件里开启了 ENABLE_MOCK_DEBUG —— 它会开放破坏性的 /api/debug/reset。拒绝保留该文件。"
fi
ok "ENABLE_MOCK_DEBUG 未开启"

echo
ok "完成。下一步："
info "  1. 安装 systemd 单元：sudo cp deploy/app/chaoge-staging.service /etc/systemd/system/"
info "                          sudo systemctl daemon-reload"
info "  2. 发布产物：        sudo bash deploy/app/install-release.sh --artifact <tar.gz>"
