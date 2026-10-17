#!/usr/bin/env bash
#
# PROD-2 / Step 5.8.2 · 超哥电竞 · **Staging 独立数据库**分阶段部署入口
#
#     deploy/db/staging/deploy-staging.sh <阶段> [选项]
#
# 六个阶段，按顺序执行：
#
#     check      只读预检：连通性、角色、PUBLIC 收紧、迁移进度、最小数据
#     create     创建独立数据库 chaoge_staging（属主 postgres）
#     init       权限初始化 01→05（**单事务原子执行**）
#     migrate    以 staging 迁移角色执行 pnpm db:migrate，然后重跑 05 授权
#     bootstrap  以 staging 应用角色写入最小测试数据（06）
#     verify     只读验收 99-verify.sql，输出 PASS / FAIL
#
# ## 本脚本与生产 `deploy/db/deploy.sh` 的关系
#
# 生产的权限脚本与角色**一个字都没有改**。本脚本只驱动 `staging/` 下这一套
# 独立脚本，目标库只允许 `chaoge_staging*`；`chaoge_prod` 在参数解析阶段就被拒绝，
# 不依赖数据库连接、不依赖任何环境变量。
#
# ## 本脚本永远不会做的事
#
#   · 不执行 `db:seed` / `db:reset`（staging 运行时是 NODE_ENV=production，
#     那两个命令本来就该被应用层拒绝；这里也不提供绕过路径）；
#   · 不操作 chaoge_prod（库名守卫 + 每个 SQL 文件自己的守卫，两层）；
#   · 不打印任何口令（迁移口令只经 `read -s` 读入，放进子进程环境变量）；
#   · 不自动 commit / push（那是人的决定）。
#
# ## 为什么 bootstrap 用 SET ROLE 而不是应用口令
#
# 06 的身份守卫要求 `current_user = chaoge_staging_app`。以 postgres 执行
# `SET ROLE chaoge_staging_app` 后，PostgreSQL 的权限检查就**按应用角色算**：
# 04/05 少给一项权限，06 会当场 42501 失败。这既验证了授权，也避免了
# 为了跑一条初始化 SQL 去处理应用口令。应用的**连接凭据**由
# `deploy/app/setup-staging-env.sh` 的试连与 `healthcheck.sh` 验证。
#
# ## 本地隔离验证
#
# `--self-test` 只允许用于 `chaoge_staging*_test` 库，跳过交互确认；
# `--rollback-selftest` 只对 init 有意义，事务以 ROLLBACK 结束、零残留。
# 两者都无法作用在 `chaoge_staging` 或 `chaoge_prod` 上。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ── 默认值 ────────────────────────────────────────────────────────────────────

DB_NAME="chaoge_staging"
DB_HOST="${CHAOGE_DB_HOST:-127.0.0.1}"
DB_PORT="${CHAOGE_DB_PORT:-5432}"
PHASE=""
DRY_RUN=0
SELF_TEST=0
ROLLBACK_SELFTEST=0

# 以什么身份执行管理类 psql。默认 `sudo -u postgres`（peer 认证，不需要口令）。
if [[ -z "${CHAOGE_SUDO+x}" ]]; then
  if [[ "$(id -un 2>/dev/null || echo unknown)" == "postgres" ]]; then
    CHAOGE_SUDO=""
  else
    CHAOGE_SUDO="sudo -u postgres"
  fi
fi
CHAOGE_PSQL_ARGS="${CHAOGE_PSQL_ARGS:-}"

# ── 输出 ──────────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_OFF=""
fi

info()  { printf '%s\n' "$*"; }
step()  { printf '\n%s── %s %s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()    { printf '%s  ✓ %s%s\n' "$C_GRN" "$*" "$C_OFF"; }
warn()  { printf '%s  ! %s%s\n' "$C_YEL" "$*" "$C_OFF" >&2; }
die()   { printf '%s  ✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法: deploy-staging.sh <阶段> [选项]

阶段（按顺序）:
  check      只读预检。任何时刻都可以跑。
  create     创建独立数据库（默认 chaoge_staging，属主 postgres）。一次性。
  init       权限初始化 01→05，单事务原子执行（写操作，需显式确认）。
  migrate    以 chaoge_staging_migrator 执行 pnpm db:migrate，随后重跑 05 授权。
  bootstrap  以 chaoge_staging_app 写入最小测试数据（06，只插入，可重复）。
  verify     只读验收 99-verify.sql，输出 PASS / FAIL。

选项:
  --database NAME     目标库（默认 chaoge_staging；只允许 chaoge_staging*）
  --dry-run           只打印将要执行的内容，不写库
  --self-test         跳过交互确认。**只允许** chaoge_staging*_test
  --rollback-selftest 仅 init：事务以 ROLLBACK 结束，零残留。只允许 *_test
  -h, --help          本帮助

环境变量:
  CHAOGE_SUDO         管理身份前缀，默认 "sudo -u postgres"；设空串 = 不 sudo
  CHAOGE_PSQL_ARGS    附加 psql 连接参数（本地验证用 "-h 127.0.0.1 -U postgres"）
  CHAOGE_DB_HOST      数据库主机（默认 127.0.0.1，只允许本机回环）
  CHAOGE_DB_PORT      数据库端口（默认 5432）
  CHAOGE_STAGING_MIGRATOR_URL
                      migrate 阶段非交互验证用：完整的 migrator 连接串。
                      只限本地隔离验证（`--self-test`）；正常运维请使用交互式口令输入。

说明:
  · 本脚本不提供 db:seed / db:reset，也不接受这两个词作为阶段名。
  · migrate 的口令只经 read -s 读入，放进 pnpm 子进程的 DATABASE_URL，不落盘、不打印。
USAGE
}

# ── 参数解析 ──────────────────────────────────────────────────────────────────

[[ $# -eq 0 ]] && { usage; exit 2; }

case "$1" in
  check|create|init|migrate|bootstrap|verify) PHASE="$1"; shift ;;
  -h|--help|help) usage; exit 0 ;;
  *) die "未知阶段「$1」（可用：check / create / init / migrate / bootstrap / verify）" ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database)          DB_NAME="${2:?--database 需要一个值}"; shift 2 ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --self-test)         SELF_TEST=1; shift ;;
    --rollback-selftest) ROLLBACK_SELFTEST=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

# ── 库名守卫（不依赖数据库连接）───────────────────────────────────────────────

# 只允许 chaoge_staging 与 chaoge_staging_<...>。这条白名单同时做到三件事：
#   ① 永远不可能指向 chaoge_prod（它不以 chaoge_staging 开头）；
#   ② 拒绝任何带引号 / 分号 / 空格的库名（库名会被拼进 psql -d 与 CREATE DATABASE）；
#   ③ 本地隔离测试库（chaoge_staging_iso_test）天然落在允许范围内。
if [[ ! "$DB_NAME" =~ ^chaoge_staging(_[a-z0-9]+)*$ ]]; then
  die "库名「$DB_NAME」不允许：本脚本只作用于 chaoge_staging 或 chaoge_staging_<后缀>。
      chaoge_prod 与其它任何库名都会被拒绝——包括通过 --database 传入。"
fi

# 附加一层，防的是白名单将来被改宽时这道语义边界一起丢掉。
if [[ "$DB_NAME" == "chaoge_prod" ]]; then
  die "拒绝：staging 脚本永远不会对 chaoge_prod 执行。"
fi

# 回环地址守卫。staging 数据库与应用在同一台机器上，没有理由连远端。
case "$DB_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) die "CHAOGE_DB_HOST=$DB_HOST 不是回环地址。staging 方案只允许本机数据库。" ;;
esac

if [[ "$ROLLBACK_SELFTEST" == "1" ]]; then
  [[ "$PHASE" == "init" ]] || die "--rollback-selftest 只适用于 init 阶段（当前：$PHASE）。"
  [[ "$DB_NAME" == *_test ]] || die "--rollback-selftest 只允许用于 *_test 隔离库（当前：$DB_NAME）。"
fi

case "$DB_NAME" in
  *_test) ;;
  *)
    if [[ "$SELF_TEST" == "1" ]]; then
      die "--self-test 只允许用于 chaoge_staging*_test 隔离库（当前：$DB_NAME）。"
    fi
    ;;
esac

# ── psql 封装 ─────────────────────────────────────────────────────────────────
#
# 与生产脚本相同的两条硬性理由：
#   ① -v ON_ERROR_STOP=1：psql 默认出错仍返回 0，漏掉它会把「失败」读成「成功」；
#   ② -w：连不上时默认会挂起等待口令输入，无人值守场景下表现为「卡死」而不是报错。
# 本方案的管理路径经 peer 认证，本来不需要口令；-w 只保证失败是明确的失败。

read -r -a _SUDO_ARR <<< "$CHAOGE_SUDO"
read -r -a _ARGS_ARR <<< "$CHAOGE_PSQL_ARGS"

psql_admin() {
  "${_SUDO_ARR[@]}" psql -w "${_ARGS_ARR[@]}" -v ON_ERROR_STOP=1 "$@"
}

# 在某个库上执行单值只读查询；失败即中止，绝不把失败降级成空串。
q_db() {
  local db="$1" sql="$2" out="" rc=0
  out="$(psql_admin -d "$db" -At -q -c "$sql" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    die "只读查询失败（库 $db，psql 退出码 $rc）：${out:-（无输出）}
      查询：$sql"
  fi
  printf '%s' "$out"
}

q() { q_db "$DB_NAME" "$1"; }

# 读 pg_authid 需要超级用户；非超级用户失败是预期结果，由调用方解释。
q_opt_db() {
  local db="$1" sql="$2"
  psql_admin -d "$db" -At -q -c "$sql" 2>/dev/null || true
}

require_psql() {
  command -v psql >/dev/null 2>&1 || die "找不到 psql。请安装 postgresql-client 或把它加进 PATH。"

  if (( ${#_SUDO_ARR[@]} > 0 )); then
    local sderr="" src=0
    sderr="$("${_SUDO_ARR[@]}" true 2>&1)" || src=$?
    if (( src != 0 )); then
      die "无法以「$CHAOGE_SUDO」身份执行命令（${sderr:-无输出}）。
      这**不是**数据库的问题，是执行身份这一层就没过。
      修：以 root 直接运行本脚本，或设 CHAOGE_SUDO= 走当前用户。"
    fi
  fi

  local err="" rc=0
  err="$(psql_admin -d postgres -At -q -c "SELECT 1" 2>&1)" || rc=$?
  (( rc == 0 )) && return 0
  die "以「${CHAOGE_SUDO:-当前用户}」身份连不上 PostgreSQL 维护库 postgres（psql 退出码 $rc）。
      psql 原话：${err:-（无输出）}
      请确认 PostgreSQL 正在运行、peer 认证可用、本机 socket 可用
      （本地 Windows 验证请设 CHAOGE_PSQL_ARGS='-h 127.0.0.1 -U postgres'）。"
}

db_exists() {
  [[ "$(q_db postgres "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'")" == "1" ]]
}

require_database() {
  db_exists || die "数据库 $DB_NAME 不存在。先执行：$0 create --database $DB_NAME"
}

# ── 确认闸门 ──────────────────────────────────────────────────────────────────

assert_interactive() {
  [[ -t 0 ]] && return 0
  [[ "$SELF_TEST" == "1" || "$ROLLBACK_SELFTEST" == "1" ]] && return 0
  die "写操作需要交互式确认，但标准输入不是终端。拒绝在无人值守的情况下继续。"
}

require_confirmation() {
  local prompt="$1" answer=""

  if [[ "$SELF_TEST" == "1" || "$ROLLBACK_SELFTEST" == "1" ]]; then
    warn "[自测] 跳过交互确认：$prompt（目标库 $DB_NAME）"
    return 0
  fi

  assert_interactive
  info ""
  warn "$prompt"
  printf '  请输入目标库名以确认 (%s): ' "$DB_NAME"
  read -r answer
  [[ "$answer" == "$DB_NAME" ]] || die "确认失败（输入「$answer」，期望「$DB_NAME」）。未做任何改动。"
  ok "已确认"
}

# ── 阶段：check ───────────────────────────────────────────────────────────────

phase_check() {
  require_psql

  step "1. 环境"
  local ver user
  ver="$(q_db postgres "SELECT current_setting('server_version')")"
  user="$(q_db postgres "SELECT current_user")"
  ok "PostgreSQL $ver · 以 $user 身份连接维护库"

  step "2. 目标数据库"
  if db_exists; then
    local owner conn
    owner="$(q_db postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'")"
    conn="$(q_db postgres "SELECT datallowconn::text FROM pg_database WHERE datname = '$DB_NAME'")"
    ok "$DB_NAME 存在（属主 $owner，allowconn=$conn）"
    [[ "$owner" == "postgres" ]] || warn "数据库属主不是 postgres —— 02 的自检会拒绝继续。"
  else
    warn "$DB_NAME 不存在。下一步：$0 create --database $DB_NAME"
  fi

  step "3. staging 角色"
  local roles
  roles="$(q_db postgres "SELECT coalesce(string_agg(rolname || ' (' || case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end || ')', ', ' ORDER BY rolname), '') FROM pg_roles WHERE rolname IN ('chaoge_staging_migrator','chaoge_staging_app')")"
  info "  已存在的角色: ${roles:-（无）}"
  [[ "$roles" == *chaoge_staging_migrator* ]] || warn "chaoge_staging_migrator 不存在 —— 需要先跑 init"
  [[ "$roles" == *chaoge_staging_app* ]]      || warn "chaoge_staging_app 不存在 —— 需要先跑 init"

  # 成员关系是隔离层最容易被忽略的一处：一条 GRANT role TO role 就足以让
  # 生产角色继承 staging 的权限。
  local crossover
  crossover="$(q_db postgres "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE ((u.rolname IN ('chaoge_staging_migrator','chaoge_staging_app') AND g.rolname IN ('chaoge_migrator','chaoge_app')) OR (u.rolname IN ('chaoge_migrator','chaoge_app') AND g.rolname IN ('chaoge_staging_migrator','chaoge_staging_app')) OR (u.rolname IN ('chaoge_staging_migrator','chaoge_staging_app') AND g.rolname LIKE 'pg\\_%'))")"
  if [[ "$crossover" == "0" ]]; then
    ok "staging 角色与生产角色 / pg_* 预定义角色之间没有任何成员关系"
  else
    warn "发现 $crossover 条违规成员关系 —— init（01 自检）会拒绝继续。"
  fi

  step "4. 口令是否已设置（只输出布尔值）"
  local pw
  pw="$(q_opt_db postgres "SELECT case when exists (select 1 from pg_authid where rolname='chaoge_staging_migrator' and rolpassword is not null) then 'set' else 'UNSET' end || ' / ' || case when exists (select 1 from pg_authid where rolname='chaoge_staging_app' and rolpassword is not null) then 'set' else 'UNSET' end")"
  if [[ -z "$pw" ]]; then
    warn "读不到 pg_authid（当前身份不是超级用户）——口令状态未知"
  else
    info "  chaoge_staging_migrator: ${pw%% / *} · chaoge_staging_app: ${pw##* / }"
    [[ "$pw" != *UNSET* ]] || warn "存在未设置口令的角色。用 psql 的 \\password 交互设置（见 README §3）。"
  fi

  if db_exists; then
    step "5. PUBLIC 是否已收紧"
    local pub_db pub_sch
    pub_db="$(q "SELECT CASE WHEN (SELECT datacl FROM pg_database WHERE datname = current_database()) IS NULL THEN 'NULL' ELSE (SELECT count(*)::text FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0) END")"
    pub_sch="$(q "SELECT CASE WHEN (SELECT nspacl FROM pg_namespace WHERE nspname='public') IS NULL THEN 'NULL' ELSE (SELECT count(*)::text FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type IN ('USAGE','CREATE')) END")"
    if [[ "$pub_db" == "NULL" ]]; then
      info "  库级 PUBLIC 授权: NULL（出厂默认，PUBLIC 仍可连接）"
    else
      info "  库级 PUBLIC 授权: $pub_db 条"
    fi
    if [[ "$pub_sch" == "NULL" ]]; then
      info "  schema public 上 PUBLIC 的 USAGE/CREATE: NULL（出厂默认）"
    else
      info "  schema public 上 PUBLIC 的 USAGE/CREATE: $pub_sch 条"
    fi
    [[ "$pub_db" == "0" ]]  || warn "PUBLIC 在库上仍有授权 —— 需要跑 init 的 02"
    [[ "$pub_sch" == "0" ]] || warn "PUBLIC 在 public schema 上仍有 USAGE/CREATE —— 需要跑 init 的 02"

    step "6. 迁移与最小数据"
    local has_sm files maxv boot
    has_sm="$(q "SELECT (to_regclass('public.schema_migrations') IS NOT NULL)::text")"
    files="$(ls -1 "$REPO_ROOT/db/migrations" 2>/dev/null | grep -cE '^[0-9]+_.+\.sql$' || true)"
    if [[ "$has_sm" == "true" ]]; then
      maxv="$(q "SELECT coalesce(max(version)::text, '') FROM public.schema_migrations")"
      info "  schema_migrations 已存在，最高版本: ${maxv:-（空）}"
      info "  仓库内迁移文件: $files 个"
      boot="$(q "SELECT (exists(select 1 from users where id='u-1001') and exists(select 1 from admin_accounts where id='admin-1'))::text")"
      if [[ "$boot" == "true" ]]; then
        ok "最小测试数据已存在（u-1001 / admin-1）"
      else
        warn "最小测试数据缺失或迁移未完成 —— 需要跑 bootstrap"
      fi
    else
      info "  schema_migrations 不存在 —— 迁移从未执行过"
      info "  仓库内迁移文件: $files 个（全部待执行）"
    fi
  fi

  step "7. 生产角色隔离（跨库）"
  local prod_exists reachable
  prod_exists="$(q_db postgres "SELECT count(*)::text FROM pg_database WHERE datname = 'chaoge_prod'")"
  if [[ "$prod_exists" == "1" ]]; then
    reachable="$(q_db postgres "SELECT count(*)::text FROM pg_database d WHERE d.datname='chaoge_prod' AND (coalesce((select has_database_privilege('chaoge_staging_migrator', d.datname, 'CONNECT') from pg_roles where rolname='chaoge_staging_migrator'), false) OR coalesce((select has_database_privilege('chaoge_staging_app', d.datname, 'CONNECT') from pg_roles where rolname='chaoge_staging_app'), false))")"
    if [[ "$reachable" == "0" ]]; then
      ok "staging 角色无法连接 chaoge_prod"
    else
      warn "staging 角色仍可连接 chaoge_prod —— 隔离失败，verify 会判定 FAIL。"
    fi
  else
    info "  chaoge_prod 不存在（本地隔离环境为正常情况），跳过跨库检查"
  fi

  step "8. 下一步"
  info "  建库:   $0 create   --database $DB_NAME"
  info "  权限:   $0 init     --database $DB_NAME"
  info "  口令:   sudo -u postgres psql -d $DB_NAME  然后 \\password chaoge_staging_migrator / \\password chaoge_staging_app"
  info "  迁移:   $0 migrate  --database $DB_NAME"
  info "  数据:   $0 bootstrap --database $DB_NAME"
  info "  验收:   $0 verify   --database $DB_NAME"
  info ""
  info "  ${C_YEL}本脚本不提供 db:seed / db:reset；staging 数据由 06 以应用角色写入。${C_OFF}"
}

# ── 阶段：create ──────────────────────────────────────────────────────────────

phase_create() {
  require_psql

  if db_exists; then
    die "数据库 $DB_NAME 已存在。本阶段只负责创建；请用 check / init / verify 继续。
      不会覆盖、不会删除、不会在已存在的库上做任何改动。"
  fi

  step "将创建数据库"
  info "  CREATE DATABASE \"$DB_NAME\" OWNER postgres TEMPLATE template0 ENCODING 'UTF8'"
  info "  只创建空库；权限、迁移、数据分别由 init / migrate / bootstrap 完成。"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "  ${C_DIM}--dry-run：未执行${C_OFF}"
    return 0
  fi

  require_confirmation "即将创建数据库：$DB_NAME"

  local rc=0
  psql_admin -d postgres -q -c "CREATE DATABASE \"$DB_NAME\" OWNER postgres TEMPLATE template0 ENCODING 'UTF8'" || rc=$?
  (( rc == 0 )) || die "创建数据库失败（psql 退出码 $rc）。"

  local owner
  owner="$(q_db postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'")"
  [[ "$owner" == "postgres" ]] || die "创建后属主是「$owner」，期望 postgres。"
  ok "已创建 $DB_NAME（属主 postgres）"
  info ""
  info "  下一步: $0 init --database $DB_NAME"
}

# ── 阶段：init ────────────────────────────────────────────────────────────────

phase_init() {
  local scripts=(
    01-create-roles.sql
    02-harden-public.sql
    03-grants.sql
    04-default-privileges.sql
    05-table-grants.sql
  )
  local s
  for s in "${scripts[@]}"; do
    [[ -r "$SCRIPT_DIR/$s" ]] || die "缺少脚本 $SCRIPT_DIR/$s"
  done

  local fin="COMMIT"
  [[ "$ROLLBACK_SELFTEST" == "1" ]] && fin="ROLLBACK"

  step "将要对「$DB_NAME」执行的写操作"
  info "  01 创建/收敛 chaoge_staging_migrator 与 chaoge_staging_app（不设口令）"
  info "  02 收回 PUBLIC 在该库与 public schema 上的出厂授权；断言库属主是 postgres"
  info "  03 只把 CONNECT/USAGE 发给 staging 角色；收回生产角色的存量权限"
  info "  04 以 staging 迁移角色预置默认权限（管将来的表）"
  info "  05 以 staging 迁移角色为已存在的表授权（管此刻）"
  info ""
  info "  ${C_GRN}全部五步在同一个事务里，要么全成要么全不发生。${C_OFF}"

  if [[ "$ROLLBACK_SELFTEST" == "1" ]]; then
    warn "已启用 --rollback-selftest：事务将以 ROLLBACK 结束，不留任何残留。"
  fi

  echo_marker() { printf '%s\n' "$1"; }

  build_init_stream() {
    printf 'BEGIN;\n'
    printf "SET chaoge.expected_database = '%s';\n" "$DB_NAME"
    echo_marker '\echo === staging/01-create-roles.sql ===';  cat "$SCRIPT_DIR/01-create-roles.sql"
    echo_marker '\echo === staging/02-harden-public.sql ==='; cat "$SCRIPT_DIR/02-harden-public.sql"
    echo_marker '\echo === staging/03-grants.sql ===';        cat "$SCRIPT_DIR/03-grants.sql"
    # SET ROLE 必须紧贴 04：ALTER DEFAULT PRIVILEGES 的记账键是 current_user。
    printf 'SET ROLE chaoge_staging_migrator;\n'
    echo_marker '\echo === staging/04-default-privileges.sql (as chaoge_staging_migrator) ==='; cat "$SCRIPT_DIR/04-default-privileges.sql"
    echo_marker '\echo === staging/05-table-grants.sql (as chaoge_staging_migrator) ===';       cat "$SCRIPT_DIR/05-table-grants.sql"
    printf 'RESET ROLE;\n'
    printf '%s;\n' "$fin"
  }

  if [[ "$DRY_RUN" == "1" ]]; then
    step "--dry-run：以下是将要送入 psql 的全部内容（未执行）"
    build_init_stream
    return 0
  fi

  require_database
  assert_interactive
  require_psql
  require_confirmation "即将初始化 staging 权限：$DB_NAME"

  step "执行"
  local rc=0
  build_init_stream | psql_admin -d "$DB_NAME" -q -f - || rc=$?

  if (( rc != 0 )); then
    die "初始化失败（psql 退出码 $rc）。事务已回滚，数据库保持执行前的状态。"
  fi

  if [[ "$ROLLBACK_SELFTEST" == "1" ]]; then
    ok "自测完成（已 ROLLBACK，零残留）"
    return 0
  fi

  step "完成 — 下一步"
  cat <<EOF

  权限已经建好，但**迁移还没跑**。

  (a) 设置口令（check 显示 UNSET 时必须做）
        sudo -u postgres psql -d $DB_NAME
        \\password chaoge_staging_migrator
        \\password chaoge_staging_app

  (b) 执行迁移
        $0 migrate --database $DB_NAME

  (c) 写入最小测试数据
        $0 bootstrap --database $DB_NAME

  (d) 验收
        $0 verify --database $DB_NAME

EOF
}

# ── 阶段：migrate ─────────────────────────────────────────────────────────────

# URL 编码：口令里的 @ : / # 会让连接串解析错，而错误统一表现为「连不上」。
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

phase_migrate() {
  require_database
  require_psql

  command -v pnpm >/dev/null 2>&1 || die "找不到 pnpm。迁移通过仓库脚本执行：pnpm db:migrate。"
  [[ -r "$REPO_ROOT/package.json" ]] || die "仓库根目录不正确：$REPO_ROOT"

  local url="${CHAOGE_STAGING_MIGRATOR_URL:-}"
  local raw_pw=""

  if [[ -z "$url" ]]; then
    assert_interactive
    printf '  请输入 chaoge_staging_migrator 的口令（输入不回显）: ' >&2
    read -rs raw_pw; printf '\n' >&2
    [[ -n "$raw_pw" ]] || die "口令为空。"
    url="postgresql://chaoge_staging_migrator:$(urlencode "$raw_pw")@$DB_HOST:$DB_PORT/$DB_NAME"
    unset raw_pw
  else
    # 非交互路径只用于本地隔离验证。仍然要求角色 / 主机 / 库名完全对得上，
    # 否则一个写错的 URL 会把迁移打到别的库上——那就是本方案要防的事故本身。
    case "$url" in
      "postgresql://chaoge_staging_migrator:"*"@$DB_HOST:$DB_PORT/$DB_NAME") ;;
      *) die "CHAOGE_STAGING_MIGRATOR_URL 与目标不匹配：必须是 chaoge_staging_migrator@$DB_HOST:$DB_PORT/$DB_NAME。" ;;
    esac
    warn "使用 CHAOGE_STAGING_MIGRATOR_URL（非交互）。仅限本地隔离验证。"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    step "--dry-run：将执行"
    info "  cd $REPO_ROOT"
    info "  NODE_ENV=production DATABASE_URL='postgresql://chaoge_staging_migrator:<REDACTED>@$DB_HOST:$DB_PORT/$DB_NAME' pnpm db:migrate"
    info "  然后以 chaoge_staging_migrator 重跑 staging/05-table-grants.sql"
    return 0
  fi

  require_confirmation "即将执行数据库迁移：$DB_NAME"

  step "1. pnpm db:migrate（以 chaoge_staging_migrator）"
  # NODE_ENV=production 保持 seed / reset 的守卫关闭；migrate 本身与它们无关。
  # DATABASE_URL 只存在于这个子进程的环境里，不写文件、不出现在命令行参数中。
  local rc=0
  ( cd "$REPO_ROOT" && NODE_ENV=production DATABASE_URL="$url" pnpm db:migrate ) || rc=$?
  unset url
  if (( rc != 0 )); then
    die "迁移失败（pnpm 退出码 $rc）。修复后重跑本阶段；迁移运行器按版本断点续跑，已成功的不会重复执行。"
  fi
  ok "迁移完成"

  step "2. 重跑 05：为新表逐张授权"
  # init 里的 05 是空跑（那时还没有表）。这一步才是真正把 40 张表
  # 授权给 chaoge_staging_app 的地方；05 的自检同时核对属主必须是迁移角色。
  local stream
  stream="$(
    printf 'BEGIN;\n'
    printf "SET chaoge.expected_database = '%s';\n" "$DB_NAME"
    printf 'SET ROLE chaoge_staging_migrator;\n'
    cat "$SCRIPT_DIR/05-table-grants.sql"
    printf 'RESET ROLE;\nCOMMIT;\n'
  )"
  rc=0
  printf '%s\n' "$stream" | psql_admin -d "$DB_NAME" -q -f - || rc=$?
  (( rc == 0 )) || die "迁移后的表级授权失败（psql 退出码 $rc）。迁移本身已提交，修好后重跑本阶段即可。"
  ok "表级授权完成"

  step "完成 — 下一步"
  info "  $0 bootstrap --database $DB_NAME"
  info "  $0 verify    --database $DB_NAME"
}

# ── 阶段：bootstrap ───────────────────────────────────────────────────────────

phase_bootstrap() {
  [[ -r "$SCRIPT_DIR/06-bootstrap-data.sql" ]] || die "缺少 $SCRIPT_DIR/06-bootstrap-data.sql"

  step "将要对「$DB_NAME」写入的最小测试数据"
  info "  users: u-1001 / u-1002 · admin_accounts: admin-1 · staff_accounts: staff-1"
  info "  companions: cp-demo（挂在 u-1001） · 目录: g-delta / c-loss / p-400w / s-400w"
  info "  只 INSERT ... ON CONFLICT DO NOTHING；不 UPDATE、不 DELETE、不 TRUNCATE。"
  info "  以 chaoge_staging_app 身份执行（SET ROLE），顺便验证 04/05 的 DML 授权。"

  local stream
  stream="$(
    printf 'BEGIN;\n'
    printf "SET chaoge.expected_database = '%s';\n" "$DB_NAME"
    printf 'SET ROLE chaoge_staging_app;\n'
    cat "$SCRIPT_DIR/06-bootstrap-data.sql"
    printf 'RESET ROLE;\nCOMMIT;\n'
  )"

  if [[ "$DRY_RUN" == "1" ]]; then
    step "--dry-run：以下是将要送入 psql 的全部内容（未执行）"
    printf '%s\n' "$stream"
    return 0
  fi

  require_database
  assert_interactive
  require_psql
  require_confirmation "即将写入 staging 最小测试数据：$DB_NAME"

  local rc=0
  printf '%s\n' "$stream" | psql_admin -d "$DB_NAME" -q -f - || rc=$?
  (( rc == 0 )) || die "bootstrap 失败（psql 退出码 $rc）。事务已回滚，未写入任何数据。"
  ok "最小测试数据已就位（可重复执行）"

  step "下一步"
  info "  $0 verify --database $DB_NAME"
}

# ── 阶段：verify ──────────────────────────────────────────────────────────────

phase_verify() {
  require_database
  require_psql
  [[ -r "$SCRIPT_DIR/99-verify.sql" ]] || die "缺少 $SCRIPT_DIR/99-verify.sql"

  step "验收报告（只读）"
  local out=""
  # 99-verify 与 01→06 使用同一段库名守卫：期望库名来自 chaoge.expected_database。
  # 不显式设置时它会默认 chaoge_staging，于是 --database *_test 的本地隔离库
  # 会（正确地）被守卫拒绝。这里把目标库名以 GUC 传给同一条 psql 会话。
  out="$(
    {
      printf "SET chaoge.expected_database = '%s';\n" "$DB_NAME"
      cat "$SCRIPT_DIR/99-verify.sql"
    } | psql_admin -d "$DB_NAME" -q -f - 2>&1
  )" || {
    printf '%s\n' "$out"
    die "99-verify.sql 执行失败。"
  }
  printf '%s\n' "$out"

  # 判定从报告里读，而不是看退出码：99-verify 的结论是一行查询结果。
  local verdict
  verdict="$(printf '%s\n' "$out" | awk -F'|' '$1+0==9 && $2 ~ /OVERALL/ {gsub(/[ \t]/,"",$3); print $3}' | head -1)"

  step "结论"
  case "$verdict" in
    PASS) ok "验收通过（OVERALL = PASS）"; return 0 ;;
    FAIL) die "验收未通过（OVERALL = FAIL）。请对照上面各节定位——不要带着 FAIL 继续。" ;;
    *)    die "读不出 OVERALL 判定（得到「${verdict}」）。报告格式可能已变更，请人工查看。" ;;
  esac
}

# ── 主入口 ────────────────────────────────────────────────────────────────────

case "$PHASE" in
  check)     phase_check ;;
  create)    phase_create ;;
  init)      phase_init ;;
  migrate)   phase_migrate ;;
  bootstrap) phase_bootstrap ;;
  verify)    phase_verify ;;
esac
