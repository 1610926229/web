-- PROD-2 · 数据库权限初始化 2/5：收紧 PostgreSQL 的内建 PUBLIC 授权
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_prod（由库名守卫强制）
--
-- ## 为什么需要这一步（任务要求第 11 条）
--
-- PostgreSQL 为一个新库配的**出厂授权**比很多人以为的宽：
--
-- | 对象 | 出厂 ACL | 含义 |
-- |---|---|---|
-- | `DATABASE chaoge_prod` | `datacl = NULL`（默认） | **PUBLIC 可以 CONNECT、可以建临时表** |
-- | `SCHEMA public` | `{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}` | `=U` 表示 **PUBLIC 有 USAGE** |
--
-- 注意 `SCHEMA public` 这一行里**没有 CREATE**——这是 PostgreSQL 15 起的行为变更：
-- `public` schema 的属主改成了 `pg_database_owner`，并且不再给 PUBLIC 授予 CREATE。
-- 本机的实测 ACL 与这条完全一致。也就是说**建表权限这一块，PG 15+ 已经关好了**；
-- 本脚本里的 `REVOKE CREATE` 因此是一个**幂等的加固声明**（重申意图），
-- 而不是在补一个真实的漏洞。把它写出来是为了让「谁能在 public 建对象」这件事
-- 在脚本里**看得见**，而不是散落在版本行为的记忆里。
--
-- 真正需要收紧的是**数据库级的 CONNECT 与 TEMPORARY**：
--
-- - **CONNECT**：出厂时 PUBLIC 可连。本库只服务两个角色，没有理由让集群里
--   任何其它角色（以及将来可能新建的任何一个）默认可连；
-- - **TEMPORARY**：允许建临时表。本应用**一处临时表都没有**（已核实：迁移与
--   `lib/data/pg/**` 全文无 `CREATE TEMP/TEMPORARY`），所以回收它零代价；
-- - **CREATE ON DATABASE**：允许在该库内建 schema。同理，不需要。
--
-- ⚠️ 回收 CONNECT 之后，**只有显式授权的角色能连**。因此本脚本必须在 03 之前跑，
--    顺序不能反——03 会补上两个角色的 CONNECT。
--    （`postgres` 是超级用户，不受影响；`pg_database_owner` 也不受影响。）
--
-- ## 为什么不回收 `SCHEMA public` 的 USAGE
--
-- 回收 USAGE 后再也无法连接（CONNECT 已被回收），USAGE 已经无处可用，属于冗余。
-- 但它也不是完全无代价的：将来若加入只读的运维/监控角色，少一次显式授权就少一次。
-- 本方案**选择回收**，理由是「本库的每一个访问者都应当是显式授权的」——
-- 与其留着一个不对任何人生效的授权，不如让授权表里只有真正需要的那几行。
-- 这一步**幂等**：PUBLIC 本来就没有的权限，REVOKE 只会产生一条 warning，不影响执行。
--
-- ⚠️ 若日后要新增任何访问角色（备份、监控、只读分析），**必须显式**授权，
--    不能再依赖 PUBLIC 的默认值。这是本脚本带来的唯一一条长期纪律。

DO $guard$
DECLARE
  expected text := coalesce(nullif(current_setting('chaoge.expected_database', true), ''), 'chaoge_prod');
  actual   text := current_database();
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      '拒绝执行：当前连接的是数据库「%」，而本脚本只允许对「%」执行。',
      actual, expected
      USING ERRCODE = '42501',
            HINT = '若确实要对另一个库执行（例如本地隔离验证），请先 SET chaoge.expected_database = ''<库名>'';';
  END IF;
END
$guard$;

-- ── 1. 数据库级：收回 PUBLIC 的 CONNECT / TEMPORARY / CREATE ───────────────────
--
-- 库名取 `current_database()` 而不是写死：写死的话，本地隔离验证就不得不改脚本，
-- 而「为了测试去改脚本」正是最容易让测试与生产跑在不同代码上的那种做法。
-- 库名守卫已经保证了 `current_database()` 就是目标库。

DO $harden_database$
BEGIN
  EXECUTE format(
    'REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  RAISE NOTICE '[02] 已收回 PUBLIC 在数据库 % 上的 CONNECT / TEMPORARY / CREATE', current_database();
END
$harden_database$;

-- ── 2. schema 级：收回 PUBLIC 在 public 上的 CREATE / USAGE ────────────────────
--
-- 幂等说明：`REVOKE` 一个本来就没有的权限不会报错，只会打一条
-- 「no privileges could be revoked」的 WARNING。这是预期输出，不是失败。
-- （另一种写法是先查 `nspacl` 再决定要不要 REVOKE，但那会让脚本多一层分支，
--   而分支本身也要被测试覆盖——用一个必然成功的 REVOKE 更简单也更难写错。）

REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;

-- ── 3. 自检：PUBLIC 确实已经没有这些权限了 ────────────────────────────────────
--
-- ⚠️ 这里**不能**用 `has_database_privilege('public', …)` / `has_schema_privilege('public', …)`：
--    那两个函数要的是一个**角色名**，而 `PUBLIC` 不是一个角色（它在 `pg_roles` 里不存在），
--    传进去会直接报「role "public" does not exist」。
--    所以这里直接展开 ACL 数组来看：`aclexplode()` 给出的 `grantee = 0` 就是 PUBLIC。
--
-- ⚠️ `datacl IS NULL` 表示「沿用出厂默认」，而数据库的出厂默认**包含** CONNECT/TEMPORARY。
--    因此 NULL 必须被判成「PUBLIC 仍然可以连接」，不能当成「没有授权」——
--    这是本段最容易写反的一处。

DO $assert$
DECLARE
  pub_connect   boolean;
  pub_temp      boolean;
  pub_schema_cr boolean;
  pub_schema_us boolean;
BEGIN
  SELECT coalesce((SELECT bool_or(a.privilege_type = 'CONNECT')
                     FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                  d.datacl IS NULL)
    INTO pub_connect
    FROM pg_database d WHERE d.datname = current_database();

  SELECT coalesce((SELECT bool_or(a.privilege_type = 'TEMPORARY')
                     FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                  d.datacl IS NULL)
    INTO pub_temp
    FROM pg_database d WHERE d.datname = current_database();

  SELECT coalesce(bool_or(a.privilege_type = 'CREATE'), false)
    INTO pub_schema_cr
    FROM pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'public' AND a.grantee = 0;

  SELECT coalesce(bool_or(a.privilege_type = 'USAGE'), false)
    INTO pub_schema_us
    FROM pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'public' AND a.grantee = 0;

  IF pub_connect OR pub_temp OR pub_schema_cr OR pub_schema_us THEN
    RAISE EXCEPTION
      'PUBLIC 授权未收紧干净（connect=% temporary=% schema_create=% schema_usage=%），拒绝继续。',
      pub_connect, pub_temp, pub_schema_cr, pub_schema_us;
  END IF;

  RAISE NOTICE '[02] 自检通过：PUBLIC 在 % / public 上已无任何可用权限', current_database();
END
$assert$;
