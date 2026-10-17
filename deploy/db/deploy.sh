#!/usr/bin/env bash
#
# PROD-2 · 超哥电竞 · 数据库分阶段部署入口
#
#     deploy/db/deploy.sh <阶段> [选项]
#
# 四个阶段互相独立，按需单独执行：
#
#     check     只读预检。不写任何东西，任何时刻都可以跑。
#     backup    备份 + 恢复验证。只写备份文件，不碰业务库。
#     init      权限初始化（01 → 05，**单事务原子执行**）。写操作，需显式确认。
#     verify    只读验收（99-verify.sql）。
#
# ## 本脚本永远不会做的事
#
# `db:migrate` / `db:seed` / `db:reset` **不在任何阶段里**，也没有对应的隐藏开关。
# `init` 跑完会打印出迁移的那条命令，但不会替你执行——迁移是唯一一次真正改结构
# 的动作，必须由人看过验收报告之后单独决定（PROD-2 要求 8）。
#
# ## 为什么写操作要合并成一个事务（要求 5 的答案）
#
# 02 会收回 PUBLIC 在业务库上的 CONNECT。如果 02 和 03 分两次执行，中间就存在一个
# 「谁也别想连上」的窗口——此刻如果 SSH 断了、脚本被打断，运维看到的是一个连不进去的库。
# 把 01～05 放进**同一个事务**，这个窗口就不存在了：要么五步全成，要么一步都没发生。
# 详见 README §4。
#
# ## 为什么本脚本不需要任何数据库口令
#
# 01～05 全部经**本机 Unix socket 以 peer 认证**执行（`sudo -u postgres psql`），
# peer 认证比对的是「操作系统用户名 == 数据库角色名」，与口令无关。
# 于是整个部署过程里没有任何一步需要在命令行、环境变量或日志里出现口令。
# 唯一需要口令的是迁移那一步（chaoge_migrator 走 TCP），见 README §3。
#
# ## 为什么本脚本不提供 db:migrate / db:seed / db:reset（要求 8 的答案）
#
# 这三个命令一个都不在这里，也**刻意**不在。它们改的是数据本身，不是权限；
# 而「什么时候该动生产数据」这件事只有人能回答。本脚本能做的最多是把命令**打印**出来。
# 把 migrate / seed / reset 当阶段名传进来，会被当作未知阶段拒绝——
# 这是刻意的，有测试守着（tests/deployScripts.test.mjs）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── 默认值 ────────────────────────────────────────────────────────────────────

DB_NAME=""
PHASE=""
BACKUP_DIR="${CHAOGE_BACKUP_DIR:-/var/backups/chaoge}"
RESTORE_VERIFY=1
DRY_RUN=0
ROLLBACK_SELFTEST=0
VERIFY_DUMP=""          # backup --verify-dump FILE：只校验已有备份，不新建

# 以什么身份执行 01～05。默认 `sudo -u postgres`（peer 认证，不需要口令）。
# 显式设成空串表示「当前用户已经是 postgres，不要再 sudo」。
if [[ -z "${CHAOGE_SUDO+x}" ]]; then
  if [[ "$(id -un 2>/dev/null || echo unknown)" == "postgres" ]]; then
    CHAOGE_SUDO=""
  else
    CHAOGE_SUDO="sudo -u postgres"
  fi
fi

# 传给 psql 的连接参数。默认留空 = 走本机 socket。
# 本地 Windows 验证时需要 `-h 127.0.0.1 -U postgres`（本机没有 Unix socket）。
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
用法: deploy.sh <阶段> [选项]

阶段:
  check     只读预检：连通性、角色、PUBLIC 收紧情况、口令是否已设、待执行迁移数、备份目录
  backup    备份 + 恢复验证：pg_dump -Fc，真实还原到临时库后比对内容指纹（行数/约束/索引/序列/迁移）
  init      权限初始化：01→05 单事务原子执行（写操作，需显式确认）
  verify    只读验收：99-verify.sql，输出 PASS / FAIL

选项:
  --database NAME      目标数据库（默认 chaoge_prod）
  --backup-dir DIR     备份目录（默认 $CHAOGE_BACKUP_DIR 或 /var/backups/chaoge）
  --no-restore-verify  备份后跳过真实还原校验（只做 pg_restore --list）
  --verify-dump FILE   只校验一个**已存在**的备份文件，不新建备份（backup 阶段）
  --dry-run            只打印将要执行的 SQL，不执行
  --rollback-selftest  仅 init：事务以 ROLLBACK 结束，零残留。**禁止对 chaoge_prod 使用**
  -h, --help           本帮助

环境变量:
  CHAOGE_SUDO         执行 01～05 的身份前缀，默认 "sudo -u postgres"；设空串=不 sudo
  CHAOGE_PSQL_ARGS    附加给 psql 的连接参数（本地验证用 "-h 127.0.0.1 -U postgres"）
  CHAOGE_BACKUP_DIR   备份目录

说明: 本脚本不提供 db:migrate / db:seed / db:reset。迁移命令由 init 打印，需人工执行。
USAGE
}

# ── 参数解析 ──────────────────────────────────────────────────────────────────

[[ $# -eq 0 ]] && { usage; exit 2; }

case "$1" in
  check|backup|init|verify) PHASE="$1"; shift ;;
  -h|--help|help)           usage; exit 0 ;;
  *) die "未知阶段「$1」（可用：check / backup / init / verify）" ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database)          DB_NAME="${2:?--database 需要一个值}"; shift 2 ;;
    --backup-dir)        BACKUP_DIR="${2:?--backup-dir 需要一个值}"; shift 2 ;;
    --no-restore-verify) RESTORE_VERIFY=0; shift ;;
    --verify-dump)       VERIFY_DUMP="${2:?--verify-dump 需要一个文件路径}"; shift 2 ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --rollback-selftest) ROLLBACK_SELFTEST=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) die "未知选项「$1」" ;;
  esac
done

DB_NAME="${DB_NAME:-chaoge_prod}"

# ── 库名与库类型守卫 ──────────────────────────────────────────────────────────

# 库名只允许小写字母/数字/下划线。这不是洁癖：库名会被拼进 `psql -d` 与
# `pg_dump -d`，一个带引号或分号的库名就是一次命令注入。白名单比转义更难写错。
if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  die "库名「$DB_NAME」不合法：只允许小写字母、数字、下划线，且不以数字开头。"
fi

# 回滚自测会执行**完全相同**的写操作，只是最后回滚掉它——它对生产库没有任何正当用途，
# 而对生产库误用一次，等于白跑一场还可能撞上 04 的身份守卫。直接在入口拦掉。
if [[ "$ROLLBACK_SELFTEST" == "1" && "$DB_NAME" == "chaoge_prod" ]]; then
  die "--rollback-selftest 拒绝对 chaoge_prod 使用：这是本地验证开关，在生产库上没有正当用途。"
fi

# 这个开关只对 init 有意义（check/backup/verify 本来就不写库）。
# 与其让它在别的阶段静默地什么都不做——运维以为「我加了自测所以安全」，
# 实际却跑了一次真的 backup——不如直接拒绝。
if [[ "$ROLLBACK_SELFTEST" == "1" && "$PHASE" != "init" ]]; then
  die "--rollback-selftest 只适用于 init 阶段（当前：$PHASE）。"
fi

# 同理：--verify-dump 只对 backup 有意义，在别的阶段静默忽略会让人以为
# 「我加了校验」，实际什么都没发生。
if [[ -n "$VERIFY_DUMP" && "$PHASE" != "backup" ]]; then
  die "--verify-dump 只适用于 backup 阶段（当前：$PHASE）。"
fi

# 两个自相矛盾的组合。共同点：**静默忽略任意一方都会给出一个骗人的退出码**。
if [[ -n "$VERIFY_DUMP" && "$DRY_RUN" == "1" ]]; then
  die "--verify-dump 与 --dry-run 不能同时用：dry-run 不执行还原，那就等于没校验，而退出码 0 会让人以为校验过了。"
fi
if [[ -n "$VERIFY_DUMP" && "$RESTORE_VERIFY" != "1" ]]; then
  die "--verify-dump 与 --no-restore-verify 不能同时用：前者要求还原校验，后者要求跳过它。"
fi

# 系统库（postgres / template*）不是业务库。按「这个阶段会不会写进去」分级放行，
# 而不是一律拒绝——一律拒绝会逼着本地验证去连开发库，那才是真正的风险。
#
#   check / verify   纯只读，任何库都放行。
#   backup           `pg_dump` 对**源库**只读（唯一写入是备份文件与临时还原库），
#                    因此也放行——它正是本地验证恢复链路时最方便的目标。
#   init             会真正写进去。`template*` 无条件拒绝（模板库上跑事务本身就违反
#                    PostgreSQL 的规矩，放行只会得到一个看不懂的报错）；
#                    `postgres` 维护库只在 --rollback-selftest 下放行。
case "$DB_NAME" in
  template0|template1)
    [[ "$PHASE" == "init" ]] && die "拒绝对模板库「$DB_NAME」执行 init。"
    ;;
  postgres)
    if [[ "$PHASE" == "init" && "$ROLLBACK_SELFTEST" != "1" ]]; then
      die "拒绝对系统库「$DB_NAME」执行 init（仅 --rollback-selftest 例外）。"
    fi
    ;;
esac

# ── psql 调用封装 ─────────────────────────────────────────────────────────────
#
# ⚠️ 全部 psql 调用都必须经由这里。两个都是实测出来的行为：
#
#   ① `-v ON_ERROR_STOP=1` —— `psql` **默认在出错后依然返回 0**（实测：`SELECT 1/0`
#      退出码 0）。漏掉它，整个部署会「成功」地失败：脚本继续往下走，数据库停在半路。
#
#   ② `-w`（--no-password）—— 客户端**连不上时默认会挂在密码提示上等输入**，
#      而不是报错退出。对无人值守的部署脚本来说这是最糟的失败形态：没有输出、
#      没有退出码、看上去像卡死。`-w` 把它变成立刻失败的明确错误。
#      本方案全程经 peer 认证执行，本来就不需要口令；`-w` 只是保证「万一需要」
#      时是失败而不是静默挂起。
#
# 两个标志写在这里一次，而不是指望每个调用点都记得加。

read -r -a _SUDO_ARR <<< "$CHAOGE_SUDO"
read -r -a _ARGS_ARR <<< "$CHAOGE_PSQL_ARGS"

psql_admin() {
  "${_SUDO_ARR[@]}" psql -w "${_ARGS_ARR[@]}" -v ON_ERROR_STOP=1 "$@"
}

# 只读探测：单个标量查询。SQL 的 NULL 会变成空串——这是**正常**返回值。
#
# ⚠️ 但不能因此用 `2>/dev/null || true` 把**失败**也变成空串。这两种「空」必须分开，
# 吞掉失败的实际后果不是「少打印一行」，而是让调用方把**一次失败**读成**一个事实**：
#   · 读不到 PUBLIC 授权        → 报「PUBLIC 仍有授权」（冤枉了这个库）
#   · 读不到 schema_migrations  → 报「迁移从未执行过」（凭空断言）
#   · sudo 需要口令而这里没终端 → 上面两条都发生，而且全篇一个字都不提 sudo
# 最后那条正是「误导性错误信息」的来源：报的是数据库的症状，病因在 sudo 那一层。
# 所以失败就带着 psql 的原话中止。真允许失败的查询用下面的 q_opt()。
q() {
  local out="" rc=0
  out="$(psql_admin -d "$DB_NAME" -At -q -c "$1" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    die "只读查询失败（psql 退出码 $rc）：${out:-（无输出）}
      查询：$1"
  fi
  printf '%s' "$out"
}

# 给「查询本身就可能合法地失败」的少数场景用。当前唯一一处是读 pg_authid：
# 它需要超级用户，普通角色会被拒绝（permission denied）——那是**预期**且可解释的
# 结果，不是部署脚本该中止的理由。调用方必须自己判断空值意味着什么。
q_opt() {
  psql_admin -d "$DB_NAME" -At -q -c "$1" 2>/dev/null || true
}

require_psql() {
  command -v psql >/dev/null 2>&1 || die "找不到 psql。请安装 postgresql-client 或把它加进 PATH。"

  # 先单独验证「身份前缀」这一层。sudo 失败与数据库失败是**两件事**，
  # 混成一条报错会把人引到错误的方向：实测最常见的是
  # 「sudo 需要口令，但当前没有交互式终端」（cron / CI / 非交互 ssh），
  # 而旧提示只说了「库不存在 / peer 不可用」，于是人去查库、查 socket、查网络，
  # 查了一圈才发现根本没进到 psql。
  if (( ${#_SUDO_ARR[@]} > 0 )); then
    local sderr="" src=0
    sderr="$("${_SUDO_ARR[@]}" true 2>&1)" || src=$?
    if (( src != 0 )); then
      die "无法以「$CHAOGE_SUDO」身份执行命令（${sderr:-无输出}）。
      这**不是**数据库的问题，是执行身份这一层就没过。常见原因：
        · sudo 需要口令，但当前没有交互式终端（cron / CI / 非交互 ssh）
        · 当前用户不在 sudoers 里
      修：以 root 直接运行本脚本（sudo $0 <阶段> ...），
          或设 CHAOGE_SUDO= 走当前用户，或设成一个可用的身份前缀。"
    fi
  fi

  # 到这里才轮到数据库。把 psql 的真实报错原样带出去——旧写法用
  # `>/dev/null 2>&1` 丢掉它，于是「库不存在」「peer 不匹配」「没有 socket」
  # 三种完全不同的问题在输出里长得一模一样。
  local err="" rc=0
  err="$(psql_admin -d "$DB_NAME" -At -q -c "SELECT 1" 2>&1)" || rc=$?
  (( rc == 0 )) && return 0
  die "以「${CHAOGE_SUDO:-当前用户}」身份连不上数据库「$DB_NAME」（psql 退出码 $rc）。
      psql 原话：${err:-（无输出）}
      请确认：数据库存在、peer 认证可用（sudo -u postgres psql -d $DB_NAME）、
      且本机 socket 可用（本地 Windows 验证请设 CHAOGE_PSQL_ARGS='-h 127.0.0.1 -U postgres'）。"
}

# ── 显式确认（写操作的闸门）──────────────────────────────────────────────────
#
# 要求 7：关键写入步骤必须显式确认。这里用「**手动输入库名**」而不是 `[y/N]`：
# y 是一个可以盲敲的键，而库名必须被读出来、读对，才能通过。
# 敲错库名的人，正是最需要被拦住的那一个人。

# 交互性检查与「敲库名」分成两步，是为了让前者能**先于任何数据库连接**执行。
# 无人值守这条路径不该依赖「库连得上」——CI / cron 里最典型的形态恰恰是
# 「没有终端、也连不上库」，而它必须在第一时间被拒绝，而不是先报一个连不上库的错，
# 让运维以为问题出在网络。
assert_interactive() {
  [[ -t 0 ]] && return 0
  # 自测模式是唯一的例外：它已保证零持久化，且被硬性禁止用于 chaoge_prod
  # （见上面的库名守卫），所以「从管道读确认」在这里没有可被滥用的余地。
  # 真实的 init 没有这条路径——它必须有人在终端前把库名敲对。
  [[ "$ROLLBACK_SELFTEST" == "1" ]] && return 0
  die "写操作需要交互式确认，但标准输入不是终端。拒绝在无人值守的情况下继续。"
}

require_confirmation() {
  local prompt="$1" answer=""
  assert_interactive

  info ""
  warn "$prompt"
  if [[ -t 0 ]]; then
    printf '  请输入目标库名以确认 (%s): ' "$DB_NAME"
    read -r answer
  else
    printf '  [自测] 从标准输入读取确认\n'
    read -r answer || answer=""
  fi

  [[ "$answer" == "$DB_NAME" ]] || die "确认失败（输入「$answer」，期望「$DB_NAME」）。未做任何改动。"
  ok "已确认"
}

# ── 阶段：check ───────────────────────────────────────────────────────────────

phase_check() {
  require_psql

  step "1. 环境"
  local ver db user
  ver="$(q "SELECT current_setting('server_version')")"
  db="$(q "SELECT current_database()")"
  user="$(q "SELECT current_user")"
  ok "PostgreSQL $ver · 目标库 $db · 以 $user 身份连接"
  [[ "$db" == "$DB_NAME" ]] || warn "当前库名与 --database 不一致：$db vs $DB_NAME"

  step "2. 角色"
  local roles
  roles="$(q "SELECT coalesce(string_agg(rolname || ' (' || case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end || ')', ', ' ORDER BY rolname), '') FROM pg_roles WHERE rolname IN ('chaoge_migrator','chaoge_app')")"
  info "  已存在的角色: ${roles:-（无）}"
  [[ "$roles" == *chaoge_migrator* ]] || warn "chaoge_migrator 不存在 —— 需要先跑 init"
  [[ "$roles" == *chaoge_app* ]]      || warn "chaoge_app 不存在 —— 需要先跑 init"

  step "3. 口令是否已设置（只输出布尔值，绝不输出校验子）"
  local pw
  # q_opt 而不是 q：读 pg_authid 需要超级用户，非超级用户会被权限拒绝，
  # 那是可解释的预期结果，由下面的 -z 分支说明「口令状态未知」。
  pw="$(q_opt "SELECT case when exists (select 1 from pg_authid where rolname='chaoge_migrator' and rolpassword is not null) then 'set' else 'UNSET' end || ' / ' || case when exists (select 1 from pg_authid where rolname='chaoge_app' and rolpassword is not null) then 'set' else 'UNSET' end")"
  if [[ -z "$pw" ]]; then
    warn "读不到 pg_authid（当前身份不是超级用户）——口令状态未知"
  else
    info "  chaoge_migrator: ${pw%% / *} · chaoge_app: ${pw##* / }"
    [[ "$pw" != *UNSET* ]] || warn "存在未设置口令的角色。用 psql 的 \\password 命令交互设置（见 README §3）——不要写进命令行。"
  fi

  step "4. PUBLIC 是否已收紧"
  #
  # ⚠️ 这里必须分成「ACL 为 NULL」和「ACL 有内容」两种情况，不能只数条目：
  #    `datacl IS NULL` 表示这份 ACL 还是出厂默认，而出厂默认**包含** PUBLIC 的
  #    CONNECT 与 TEMPORARY。若写成 `count(*)`，NULL 会数出 0，把「人人可连」
  #    报告成「已收紧」——一个把最危险的状态说成安全状态的假阴性。
  # ⚠️ 送给 psql 的 SQL 里**不能有非 ASCII 字符**（这几条以前写着中文）。
  # 客户端编码是随环境来的：Windows 的 Git Bash 会把 `-c` 参数里的 UTF-8 转成 GBK，
  # 服务端于是报 `无效的 "UTF8" 编码字节顺序`。旧实现把这个错误吞成空串，
  # 于是「PUBLIC 已收紧」被读成「PUBLIC 仍有授权」—— 结论错了，但看上去一切正常。
  # 让 SQL 只返回 ASCII 标记，中文留给 bash 去拼，就与客户端编码无关了。
  local pub_db pub_sch
  pub_db="$(q "SELECT CASE WHEN (SELECT datacl FROM pg_database WHERE datname = current_database()) IS NULL THEN 'NULL' ELSE (SELECT count(*)::text FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0) END")"
  pub_sch="$(q "SELECT CASE WHEN (SELECT nspacl FROM pg_namespace WHERE nspname='public') IS NULL THEN 'NULL' ELSE (SELECT count(*)::text FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type IN ('USAGE','CREATE')) END")"
  # NULL = ACL 还是出厂默认。出厂默认里**包含** PUBLIC 的 CONNECT/TEMPORARY，
  # 所以它绝不能显示成「0 条」——那是把最危险的状态说成安全状态。
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
  [[ "$pub_db" == "0" ]] || warn "PUBLIC 在库上仍有授权（或仍是出厂默认）—— 需要跑 init 的 02"
  [[ "$pub_sch" == "0" ]] || warn "PUBLIC 在 public schema 上仍有 USAGE/CREATE —— 需要跑 init 的 02"

  step "5. 迁移进度"
  local has_sm maxv files
  has_sm="$(q "SELECT (to_regclass('public.schema_migrations') IS NOT NULL)::text")"
  files="$(ls -1 "$REPO_ROOT/db/migrations" 2>/dev/null | grep -cE '^[0-9]+_.+\.sql$' || true)"
  if [[ "$has_sm" == "true" ]]; then
    maxv="$(q "SELECT coalesce(max(version)::text, '') FROM public.schema_migrations")"
    maxv="${maxv:-（空）}"
    info "  schema_migrations 已存在，最高版本: $maxv"
    info "  仓库内迁移文件: $files 个"
  else
    info "  schema_migrations 不存在 —— 迁移从未执行过"
    info "  仓库内迁移文件: $files 个（全部待执行）"
  fi

  step "6. 备份目录"
  check_backup_dir_for_report

  step "7. 下一步"
  info "  权限初始化:  $0 init --database $DB_NAME"
  info "  执行迁移:    cd $REPO_ROOT && NODE_ENV=production DATABASE_URL='postgresql://chaoge_migrator:<口令>@127.0.0.1:5432/$DB_NAME' pnpm db:migrate"
  info "  验收:        $0 verify --database $DB_NAME"
  info ""
  info "  ${C_YEL}本脚本不会替你执行 db:migrate / db:seed / db:reset。${C_OFF}"
}

# 备份目录检查。check 阶段只报告，backup 阶段则必须通过。
check_backup_dir_for_report() {
  if [[ ! -e "$BACKUP_DIR" ]]; then
    warn "备份目录 $BACKUP_DIR 不存在 —— backup 阶段会用 chmod 700 创建它"
    return 0
  fi
  if [[ ! -d "$BACKUP_DIR" ]]; then
    die "备份路径 $BACKUP_DIR 存在但不是目录。"
  fi
  local mode
  mode="$(stat -c '%a' "$BACKUP_DIR" 2>/dev/null || echo '?')"
  info "  目录: $BACKUP_DIR · 权限: $mode"
  # 备份文件里有全部业务数据，world-readable 等于把库发到公网上。
  if [[ "$mode" != "?" ]] && (( (10#$mode & 8#07) != 0 )); then
    warn "备份目录对 other 组开放（mode $mode）—— 备份包含全部业务数据，建议 chmod 700"
  fi
}

# ── 阶段：backup ──────────────────────────────────────────────────────────────

phase_backup() {
  # --verify-dump：只校验一个已经存在的备份文件。刻意**不碰**备份目录、
  # 不新建备份、不写校验和——「验一个旧备份」和「做一份新备份」是两件事，
  # 混在一起会让前者在磁盘满或目录不可写时无辜失败。
  if [[ -n "$VERIFY_DUMP" ]]; then
    [[ -f "$VERIFY_DUMP" ]] || die "--verify-dump 指定的文件不存在：$VERIFY_DUMP"
    [[ -s "$VERIFY_DUMP" ]] || die "--verify-dump 指定的文件是空的：$VERIFY_DUMP"
    require_psql
    step "1. 校验已有备份 $VERIFY_DUMP（不新建备份）"
    restore_verify "$VERIFY_DUMP"
    step "2. 完成"
    ok "恢复验证通过（未新建备份）: $VERIFY_DUMP"
    return 0
  fi

  command -v pg_dump >/dev/null 2>&1 || die "找不到 pg_dump。"
  require_psql

  step "1. 准备备份目录"
  if [[ ! -d "$BACKUP_DIR" ]]; then
    info "  创建 $BACKUP_DIR（mode 700）"
    "${_SUDO_ARR[@]}" mkdir -p "$BACKUP_DIR" 2>/dev/null || mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR" 2>/dev/null || warn "chmod 700 失败（Windows 无 POSIX 权限位，可忽略）"
  fi

  # 目录必须**由执行 postgres 的那个账号**可写：pg_dump 是 postgres 在写。
  local probe="$BACKUP_DIR/.write-probe.$$"
  if ! "${_SUDO_ARR[@]}" touch "$probe" 2>/dev/null; then
    die "备份目录 $BACKUP_DIR 对「${CHAOGE_SUDO:-当前用户}」不可写。pg_dump 会失败在这里之前。
      修：sudo mkdir -p $BACKUP_DIR && sudo chown postgres:postgres $BACKUP_DIR && sudo chmod 700 $BACKUP_DIR"
  fi
  "${_SUDO_ARR[@]}" rm -f "$probe"
  ok "备份目录可写"

  local mode; mode="$(stat -c '%a' "$BACKUP_DIR" 2>/dev/null || echo '?')"
  if [[ "$mode" != "?" ]] && (( (10#$mode & 8#07) != 0 )); then
    warn "备份目录 mode=$mode 对 other 组开放，建议 chmod 700"
  fi

  step "2. pg_dump"
  local stamp out
  # 时间戳由 `date` 生成而不是 `$$`：$$ 会被 pid 重用，连续两次部署可能撞名覆盖。
  stamp="$(date +%Y%m%d_%H%M%S)"
  out="$BACKUP_DIR/${DB_NAME}_${stamp}.dump"
  info "  pg_dump -Fc -d $DB_NAME -f $out"
  if [[ "$DRY_RUN" == "1" ]]; then
    info "  ${C_DIM}--dry-run：未执行${C_OFF}"
    return 0
  fi
  "${_SUDO_ARR[@]}" pg_dump -w "${_ARGS_ARR[@]}" -Fc -d "$DB_NAME" -f "$out" \
    || die "pg_dump 失败。备份未完成，**不要**继续进行 init。"
  chmod 600 "$out" 2>/dev/null || warn "chmod 600 失败（Windows 可忽略）"
  local size; size="$(du -h "$out" 2>/dev/null | cut -f1 || echo '?')"
  ok "已写出 $out（$size）"

  # 校验和。备份的意义在于「出事那天它必须能用」，而它那一天多半是从别处
  # 复制回来的——复制坏掉、存到坏盘上、被某个同步工具截断，都不会报错。
  # 有了这个文件，`sha256sum -c` 就能回答「我手上这份还是不是当初那份」。
  #
  # 刻意**不做**自动轮转清理：删备份是不可逆的，而「留多久」是运维策略不是脚本该替人
  # 决定的事。万一某次备份刚好是唯一可用的一份，自动删掉它就是灾难。
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" ) \
      || die "写校验和失败。"
    chmod 640 "$BACKUP_DIR/$(basename "$out").sha256" 2>/dev/null || true
    ok "校验和 $BACKUP_DIR/$(basename "$out").sha256"
  else
    warn "找不到 sha256sum，跳过校验和（备份本身不受影响）。"
  fi

  step "3. 备份完整性：pg_restore --list"
  # 这一步只读归档的目录表。它能抓出「文件被截断 / 根本不是 -Fc 格式」，
  # 但抓不出「内容逻辑损坏」——那要靠下一步。
  #
  # 和 restore_verify 里的规则一致：退出码是主要判据，错误输出原样保留。
  # 旧写法 `2>/dev/null | grep -c ';' || true` 把退出码和报错一起丢掉，
  # 只留下一个 0 —— 「归档读不出来」和「归档里没有条目」于是长得一样，
  # 而人看到的只有一句笼统的「读不出归档目录」。
  local listed rc=0 entries
  listed="$("${_SUDO_ARR[@]}" pg_restore -w --list "$out" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    warn "  pg_restore --list 退出码 $rc："
    printf '%s\n' "$listed" | head -10 | sed 's/^/      /'
    die "读不出归档目录（pg_restore 退出码 $rc）—— 备份文件不可用。不要继续 init。"
  fi
  entries="$(printf '%s\n' "$listed" | grep -c ';' || true)"
  (( entries > 0 )) || die "归档目录读出来了，但里面一个条目都没有 —— 备份文件不可用。"
  ok "归档目录可读，$entries 个条目"

  step "4. 恢复验证（真实还原到一个临时库）"
  if [[ "$RESTORE_VERIFY" != "1" ]]; then
    warn "--no-restore-verify：跳过。备份只经过目录表校验，未验证能否真正还原。"
    return 0
  fi
  restore_verify "$out"

  step "5. 完成"
  ok "备份与恢复验证通过: $out"
  info ""
  info "  ${C_YEL}备份文件包含全部业务数据，权限已设为 600。请勿纳入版本控制，勿复制到公网存储。${C_OFF}"
}

# ── 内容指纹查询 ──────────────────────────────────────────────────────────────
#
# 每条都返回**排序好的多行文本**：同一个库必然得到同一串，不同则 diff 出差异。
#
# ⚠️ ORDER BY 只能写 `1`。这些查询都把多个列拼成了一列，写 `ORDER BY 1,2` 会报
# 「位置 2 不在 select 列表中」——整条查询变成空结果，而空的指纹 diff 空的指纹
# 也是空，一次真失败就此伪装成一次通过。

FP_TABLES="$(cat <<'SQL'
SELECT c.relname || '|' ||
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname),
                           false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 ORDER BY 1
SQL
)"

# 约束少了 / 类型变了（比如 PK 退化成普通索引），恢复出来的库能读不能用。
# `co.contype::text` 的类型转换是必须的：`text || "char"` 实测报「操作符不是唯一的」。
FP_CONSTRAINTS="$(cat <<'SQL'
SELECT c.relname || '|' || co.conname || '|' || co.contype::text
  FROM pg_constraint co
  JOIN pg_class c ON c.oid = co.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY 1
SQL
)"

FP_INDEXES="$(cat <<'SQL'
SELECT c.relname || '|' || i.relname || '|' ||
       x.indisunique::text || '|' || x.indisprimary::text
  FROM pg_index x
  JOIN pg_class c ON c.oid = x.indrelid
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY 1
SQL
)"

# 序列本身也要比：last_value 决定下一个 id 从哪开始，还原时被重置会撞主键。
# 当前 schema 里一个序列都没有（实测 public.relkind='S' 为 0 行），所以这一项
# 今天是 N/A —— 但保留它：哪天有人加了 serial/identity，它会立刻开始起作用。
FP_SEQUENCES="$(cat <<'SQL'
SELECT c.relname || '|' ||
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT last_value FROM public.%I', c.relname),
                           false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY 1
SQL
)"

# 迁移元数据是「这个库停在第几版」的唯一真值源。它丢了，应用与库对不上版本，
# 而且不会有任何报错。第一行是行数，因此**即使一条迁移都没有**也非空。
FP_MIGRATIONS="$(cat <<'SQL'
SELECT 'count|' || count(*)::text FROM public.schema_migrations
UNION ALL
SELECT version || '|' || name || '|' || checksum FROM public.schema_migrations
ORDER BY 1
SQL
)"

# 取一份指纹。查询失败**即中止** —— 这是本次修复里最要紧的一条。
#
# 实测：写错列名的查询在 psql 里退出码为 1，stdout 为空。若把「空」也当成一份
# 指纹拿去 diff，两边都是空、diff 也是空，一次查询写错会被读成「两边一致」。
# 所以这里检查退出码，非 0 直接停，绝不把失败降级成空串。
fingerprint() {
  local db="$1" sql="$2" label="$3" out="" rc=0
  out="$(psql_admin -d "$db" -At -q -c "$sql" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    die "取「$label」指纹失败（库 $db，psql 退出码 $rc）。校验无法进行，也就不能判定备份可用：
$out"
  fi
  printf '%s' "$out"
}

# 比对一项指纹。用 FP_COMPARED 记下**真正比过**的项数：源库为空时只能报 N/A，
# 因为空集与空集相等 —— 那种「一致」什么也没证明，不能算作校验通过。
FP_COMPARED=0
compare_fingerprint() {
  local label="$1" sql="$2" src dst n d dn
  src="$(fingerprint "$DB_NAME" "$sql" "$label")"
  dst="$(fingerprint "$scratch" "$sql" "$label")"

  if [[ -z "$src" ]]; then
    info "  · $label：源库为空，无可比对（N/A）"
    return 0
  fi

  FP_COMPARED=$(( FP_COMPARED + 1 ))
  n="$(printf '%s\n' "$src" | grep -c . || true)"

  if [[ "$src" == "$dst" ]]; then
    ok "  ✓ $label：$n 项全部一致"
    return 0
  fi

  warn "  ✗ $label：不一致（源库 $n 项）"
  d="$(diff <(printf '%s\n' "$src") <(printf '%s\n' "$dst") || true)"
  printf '%s\n' "$d" | head -15 | sed 's/^/        /'
  dn="$(printf '%s\n' "$d" | grep -c '^[<>]' || true)"
  (( dn > 15 )) && info "        ……（共 $dn 行差异，此处只显示前 15 行）"
  return 1
}

# 打印 pg_restore 的日志。过滤不是装饰：备份文件被截断时 pg_restore 会把读到的
# 二进制原样吐到输出里，直接打印会执行控制字符（清屏、光标跳转、改标题），
# 把终端搅乱、让真正的错误信息看不见。
#
# 只删 C0 控制字节（保留 \t \n 与所有 >=0x20 的字节），**不做** `cat -v`：
# 后者会把中文错误信息转义成八进制（实测 `pg_restore: M-4M-mM-NM-s:...`），
# 在中文 locale 下反而没人看得懂。
#
# 计数用 wc -l 而不是 grep -c：grep 遇到二进制内容只回一句
# 「Binary file (standard input) matches」，那不是数字。
print_restore_log() {
  local file="$1" limit="$2" n
  head -n "$limit" "$file" | tr -d '\000-\010\013\014\015\016-\037' | sed 's/^/      /'
  n="$(wc -l < "$file")"; n="${n// /}"
  (( n > limit )) && info "      ……（共 $n 行输出，此处只显示前 $limit 行）"
  return 0
}

# 把备份真实还原进一个临时库，比对**内容指纹**，然后**删除这个临时库**。
#
# 为什么值得多这一步：`pg_restore --list` 只读归档头，一个在写入过程中被 kill 掉的
# pg_dump 也能通过它。真正还原一次才知道这份备份到底能不能用——而备份的全部意义
# 就在于「出事那天它必须能用」。**没有验证过的备份不是备份，是一个文件。**
#
# ## 为什么不能只比表数量（本次修复的核心）
#
# 实测：`pg_dump -Fc --section=pre-data` 出的备份只含结构不含数据，还原后
# **42 张表一张不少**，`pg_restore` 退出码 0，stderr 为空。旧实现只比表数量，
# 会把这份「有壳没肉」的备份判成成功。所以现在比的是内容：
# 每一张表的 `count(*)`、约束、索引、序列、迁移元数据。
#
# ## 为什么不 grep pg_restore 的 stderr 文本
#
# 它随 locale 变。本机（中文 locale）实测还原冲突产生了 1651 行错误，
# 文本是 `pg_restore: 错误:`，而 `grep 'pg_restore: error:'` 匹配 **0** 行——
# 按字符串判定会在生产（en_US.UTF-8）与本地之间悄悄失配。退出码才是与语言无关的判据。
#
# 规则因此是：
#   退出码 != 0  → **失败**。备份不可信，立即中止，后面 init / migrate 一律不做。
#   退出码 == 0  → 通过；stderr 有内容则原样打印供人看，但不据此判失败
#                  （`--no-owner --no-acl` 已去掉最常见的 warning 来源，实测健康备份
#                  的 stderr 是空的；即便将来出现无害 NOTICE，退出码仍是 0，不会误停）。
#
# ## 用 count(*) 而不是 reltuples
#
# reltuples 是 ANALYZE 的估计值：实测同一份数据源库 291、还原库 315，
# 且从未 ANALYZE 过的表是 -42。拿它做判据会又假通过又假失败。
#
# 删除保护：只删匹配 chaoge_restore_verify_ 前缀的库。这个前缀是硬编码的，
# 不从参数来，所以不存在「传错参数删掉业务库」的路径。
restore_verify() {
  local dump="$1"
  local scratch="chaoge_restore_verify_$$"

  python3 -c "import sys; sys.exit(0 if __import__('re').fullmatch(r'chaoge_restore_verify_[0-9]+', sys.argv[1]) else 1)" "$scratch" 2>/dev/null \
    || [[ "$scratch" =~ ^chaoge_restore_verify_[0-9]+$ ]] \
    || die "内部错误：临时库名「$scratch」不符合保护前缀，拒绝继续。"

  command -v createdb >/dev/null 2>&1 || die "找不到 createdb，无法做恢复验证。用 --no-restore-verify 跳过。"

  # 清理必须挂到 EXIT **以及** TERM/INT：只挂 EXIT 的话，Ctrl-C 或被 timeout 杀掉
  # 都不会触发（实测：`timeout 90` 之后临时库原样留在集群里）。临时库本身无害，
  # 但「失败一次留一个库」会让磁盘悄无声息地涨。
  local cleanup_done=0
  cleanup_scratch() {
    [[ "$cleanup_done" == "1" ]] && return 0
    cleanup_done=1
    case "$scratch" in
      chaoge_restore_verify_*)
        "${_SUDO_ARR[@]}" dropdb -w "${_ARGS_ARR[@]}" --if-exists "$scratch" 2>/dev/null || true
        ;;
      *) warn "拒绝删除「$scratch」：不符合 chaoge_restore_verify_* 保护前缀。" ;;
    esac
  }
  trap cleanup_scratch EXIT
  trap 'cleanup_scratch; exit 130' INT
  trap 'cleanup_scratch; exit 143' TERM

  info "  还原到临时库 $scratch"
  "${_SUDO_ARR[@]}" createdb -w "${_ARGS_ARR[@]}" -T template0 "$scratch" \
    || die "createdb $scratch 失败。"

  # --no-owner --no-acl：备份里记的是 chaoge_app/chaoge_migrator 的授权，
  # 而这两个角色在**首次部署的此刻可能还不存在**。
  # 跳过属主与 ACL 不影响验证目标——我们验的是「数据与结构能否还原」；
  # 权限本身由 01～05 重建，那份才是权限的唯一真值源，不依赖备份携带。
  #
  # 旧写法是 `pg_restore ... 2>/dev/null || true`：错误被丢掉，退出码被吞掉，
  # 于是「还原失败」和「还原成功」在脚本里长得一模一样。现在两者都留下。
  local log rc=0
  log="$(mktemp)"
  chmod 600 "$log"
  "${_SUDO_ARR[@]}" pg_restore -w "${_ARGS_ARR[@]}" --no-owner --no-acl \
      -d "$scratch" "$dump" >"$log" 2>&1 || rc=$?

  if (( rc != 0 )); then
    warn "  pg_restore 退出码 $rc，输出如下（前 30 行）："
    print_restore_log "$log" 30
    rm -f "$log"
    cleanup_scratch; trap - EXIT
    die "恢复验证失败：备份无法完整还原（pg_restore 退出码 $rc）。
      这份备份**不可信**：不要用它做恢复，也不要继续 init / migrate。"
  fi
  if [[ -s "$log" ]]; then
    # 退出码 0 但有输出 —— 打印出来，不判失败（理由见函数头）。
    warn "  pg_restore 退出码 0，但有输出（视为提示，不判失败）："
    print_restore_log "$log" 20
  fi
  rm -f "$log"
  ok "  pg_restore 退出码 0"

  # ── 内容指纹比对 ──────────────────────────────────────────────────────────
  local failed=0
  info "  内容指纹：源库 $DB_NAME ←→ 还原库 $scratch"
  compare_fingerprint "表与行数"   "$FP_TABLES"      || failed=1
  compare_fingerprint "约束"       "$FP_CONSTRAINTS" || failed=1
  compare_fingerprint "索引"       "$FP_INDEXES"     || failed=1
  compare_fingerprint "序列"       "$FP_SEQUENCES"   || failed=1

  # schema_migrations 可能**根本不存在**（生产库当前 0 张表就是这状态）。直接查它
  # 会让 psql 报错、fingerprint() 中止整个流程——那是假失败。先用 to_regclass 探一下：
  # 它对不存在的表返回 false 而不报错。
  local has_sm
  has_sm="$(fingerprint "$DB_NAME" \
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL" "迁移元数据存在性")"
  if [[ "$has_sm" == "t" ]]; then
    compare_fingerprint "迁移元数据" "$FP_MIGRATIONS" || failed=1
  else
    info "  · 迁移元数据：源库没有 schema_migrations，跳过（N/A）"
  fi

  if (( failed != 0 )); then
    cleanup_scratch; trap - EXIT
    die "恢复验证失败：还原库与源库内容不一致（见上方 ✗ 项）。
      这份备份**不可信**：不要用它做恢复，也不要继续 init / migrate。"
  fi

  # 源库为空时每一项都是 N/A —— 那种「通过」什么都没证明，必须说清楚，
  # 免得运维把一次空转当成一次验收。
  if (( FP_COMPARED == 0 )); then
    warn "源库 public schema 为空（0 张表 / 0 条迁移），没有可比对的内容。"
    warn "本次校验只证明了「一个空库能还原成空库」，它不是对数据的验收。"
  else
    ok "恢复验证通过：$FP_COMPARED 项内容指纹与源库完全一致"
  fi

  cleanup_scratch; trap - EXIT
  ok "临时库 $scratch 已删除"
}

# ── 阶段：init ────────────────────────────────────────────────────────────────

phase_init() {
  local scripts=(01-create-roles.sql 02-harden-public.sql 03-migrator-grants.sql 04-app-default-privileges.sql 05-app-table-grants.sql)
  local s
  for s in "${scripts[@]}"; do
    [[ -r "$SCRIPT_DIR/$s" ]] || die "缺少脚本 $SCRIPT_DIR/$s"
  done

  local fin="COMMIT"
  [[ "$ROLLBACK_SELFTEST" == "1" ]] && fin="ROLLBACK"

  step "将要对「$DB_NAME」执行的写操作"
  info "  01 创建/收敛 chaoge_migrator 与 chaoge_app（不设口令）"
  info "  02 收回 PUBLIC 在该库与 public schema 上的出厂授权"
  info "  03 授予两个角色 CONNECT / USAGE，CREATE 只给 chaoge_migrator"
  info "  04 以 chaoge_migrator 身份预置默认权限（管将来的表）"
  info "  05 以 chaoge_migrator 身份为已存在的表授权（管此刻）"
  info ""
  info "  ${C_GRN}全部五步在同一个事务里，要么全成要么全不发生。${C_OFF}"

  if [[ "$ROLLBACK_SELFTEST" == "1" ]]; then
    warn "已启用 --rollback-selftest：事务将以 ROLLBACK 结束，不留任何残留。"
  fi

  # 把五个脚本拼成一条流。用 `cat` 而不是 `\i`：
  # `\i` 的路径由 psql 解析，在 Git Bash / Windows 上盘符写法会打架；
  # 拼接出来的流在 Linux 与本地验证环境里行为完全一致。
  # 每个文件前打一个 `\echo` 标记——出错时 psql 会停在标记之后，
  # 最后一个标记就指向出问题的那个文件。
  #
  # ⚠️ 标记行必须走 `printf '%s\n' '\echo …'` 这个形式，**不能**把 `\echo`
  #    写进 printf 的格式串：格式串里的 `\e` 会被 printf 解释成 ESC (0x1B)，
  #    送进 psql 的就是一个 `^[cho …`。这个字节会打断语句解析，报出来的
  #    却是几十行之外的一个「语法错误在 "" 或附近」——极难定位。
  #    数据永远走 `%s`，格式串里只留真正想要的转义。
  echo_marker() { printf '%s\n' "$1"; }

  build_init_stream() {
    printf 'BEGIN;\n'
    printf "SET chaoge.expected_database = '%s';\n" "$DB_NAME"
    echo_marker '\echo === 01-create-roles.sql ===';              cat "$SCRIPT_DIR/01-create-roles.sql"
    echo_marker '\echo === 02-harden-public.sql ===';             cat "$SCRIPT_DIR/02-harden-public.sql"
    echo_marker '\echo === 03-migrator-grants.sql ===';           cat "$SCRIPT_DIR/03-migrator-grants.sql"
    # SET ROLE 必须紧贴 04：ALTER DEFAULT PRIVILEGES 的记账键是 current_user，
    # 换了身份就是给别的角色预置权限（04 开头有身份守卫，会当场报错）。
    printf 'SET ROLE chaoge_migrator;\n'
    echo_marker '\echo === 04-app-default-privileges.sql (as chaoge_migrator) ==='; cat "$SCRIPT_DIR/04-app-default-privileges.sql"
    echo_marker '\echo === 05-app-table-grants.sql (as chaoge_migrator) ===';       cat "$SCRIPT_DIR/05-app-table-grants.sql"
    printf 'RESET ROLE;\n'
    printf '%s;\n' "$fin"
  }

  # --dry-run 不写任何东西，因此不要求确认——把确认留给真正会改变数据库的那一次，
  # 而不是训练运维「看到提示就敲库名」。它的代价只是一次多余的输入，
  # 收益是这条提示始终保持「说的就是即将发生的事」这层含义。
  #
  # 它同样**不要求连得上数据库**：dry-run 的意义正是在「还没碰之前」看清要做什么。
  # 要求先连通才能预览，就把这条路径限制在了「已经能连上」的场景——而那时最不需要它。
  if [[ "$DRY_RUN" == "1" ]]; then
    step "--dry-run：以下是将要送入 psql 的全部内容（未执行）"
    build_init_stream
    return 0
  fi

  # 顺序：先拒绝无人值守（不依赖网络），再确认连得上，最后才要求人敲库名。
  # 三者的失败原因互不相同，报错也就必须各不相同——否则运维会照着错的线索去排查。
  assert_interactive
  require_psql

  require_confirmation "即将写库：$DB_NAME"

  step "执行"
  local rc=0
  build_init_stream | psql_admin -d "$DB_NAME" -q -f - || rc=$?

  if (( rc != 0 )); then
    # ON_ERROR_STOP 让 psql 在第一个错误处退出；连接随进程结束关闭，
    # 未 COMMIT 的事务由服务端自动回滚（实测确认，见 README §4）。
    die "初始化失败（psql 退出码 $rc）。事务已回滚，数据库保持执行前的状态。"
  fi

  if [[ "$ROLLBACK_SELFTEST" == "1" ]]; then
    ok "自测完成（已 ROLLBACK，零残留）"
    return 0
  fi

  print_init_done
}

print_init_done() {
  step "完成 — 下一步（都必须由人执行）"
  cat <<EOF

  权限已经建好，但**迁移还没跑**。接下来的事本脚本一件都不会替你做。

  (a) 设置口令 —— 如果 check 显示 UNSET
        sudo -u postgres psql -d $DB_NAME
        \\password chaoge_migrator
        \\password chaoge_app
      （\\password 在客户端算好 SCRAM 验证器再发出，明文不进 shell 历史、
        不进 psql 历史、不进服务端日志。见 README §3.2。
        走的是 peer 认证，任何时刻都能设，不受 02 收回 CONNECT 的影响。）

  (b) 执行迁移
        cd $REPO_ROOT
        NODE_ENV=production \\
        DATABASE_URL='postgresql://chaoge_migrator:<口令>@127.0.0.1:5432/$DB_NAME' \\
          pnpm db:migrate

  (c) 迁移之后补一次表级授权 —— **不要用 init，用 05**
        sudo -u postgres psql -d $DB_NAME -v ON_ERROR_STOP=1 \\
          -c "SET ROLE chaoge_migrator" \\
          -f $SCRIPT_DIR/05-app-table-grants.sql
      上面 init 里跑的 05 是空跑（那时 public 里还没有表，输出 0 张表是正确结果）；
      迁移建出来的 40 张表要再跑一次才会被逐张授权。

  (d) 验收
        $0 verify --database $DB_NAME

EOF
}

# ── 阶段：verify ──────────────────────────────────────────────────────────────

phase_verify() {
  require_psql
  [[ -r "$SCRIPT_DIR/99-verify.sql" ]] || die "缺少 $SCRIPT_DIR/99-verify.sql"

  step "验收报告（只读）"
  local out
  out="$(psql_admin -d "$DB_NAME" -q -f "$SCRIPT_DIR/99-verify.sql" 2>&1)" || {
    printf '%s\n' "$out"
    die "99-verify.sql 执行失败。"
  }
  printf '%s\n' "$out"

  # 判定必须从报告里读 verdict 列，而不是靠 psql 退出码：
  # 99-verify.sql 的结论是一行查询结果，不是一条会失败的语句。
  local verdict
  verdict="$(printf '%s\n' "$out" | awk -F'|' '$1+0==8 && $2 ~ /OVERALL/ {gsub(/[ \t]/,"",$3); print $3}' | head -1)"

  step "结论"
  case "$verdict" in
    PASS) ok "验收通过（OVERALL = PASS）"; return 0 ;;
    FAIL) die "验收未通过（OVERALL = FAIL）。请对照上面各节定位——不要带着 FAIL 上线。" ;;
    *)    die "读不出 OVERALL 判定（得到「${verdict}」）。报告格式可能已变更，请人工查看。" ;;
  esac
}

# ── 主入口 ────────────────────────────────────────────────────────────────────

case "$PHASE" in
  check)  phase_check ;;
  backup) phase_backup ;;
  init)   phase_init ;;
  verify) phase_verify ;;
esac
