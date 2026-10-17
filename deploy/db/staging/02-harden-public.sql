-- PROD-2 / Step 5.8.2 · Staging 数据库权限初始化 2/6：收紧 PUBLIC 的出厂授权
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--
-- 与生产 `deploy/db/02-harden-public.sql` 的规则完全一致，区别只在目标库与角色名：
--
--   · 收回 PUBLIC 对该库的 CONNECT / TEMPORARY / CREATE；
--   · 收回 PUBLIC 在 public schema 上的 USAGE / CREATE；
--   · 自检 PUBLIC 确实已经没有这些权限。
--
-- ## 新增：数据库属主必须是 postgres
--
-- 生产方案刻意**不**把数据库交给 `chaoge_migrator` 所有——属主可以
-- `DROP SCHEMA public CASCADE`，而迁移角色只需要 `CREATE`。staging 沿用同一条边界：
-- 数据库属主是 postgres，迁移角色只是 public schema 上的 CREATE 持有者。
-- 若属主被改成某个 staging 角色，本脚本当场失败。

DO $guard$
DECLARE
  expected text := coalesce(nullif(current_setting('chaoge.expected_database', true), ''), 'chaoge_staging');
  actual   text := current_database();
BEGIN
  IF actual = 'chaoge_prod' OR expected = 'chaoge_prod' THEN
    RAISE EXCEPTION
      '拒绝执行：这是 staging 权限脚本，永远不会对 chaoge_prod 执行（当前库「%」，期望「%」）。',
      actual, expected
      USING ERRCODE = '42501';
  END IF;
  IF expected !~ '^chaoge_staging' THEN
    RAISE EXCEPTION
      '拒绝执行：staging 脚本只允许作用在 chaoge_staging* 库上（当前期望「%」）。',
      expected
      USING ERRCODE = '42501';
  END IF;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      '拒绝执行：当前连接的是数据库「%」，而脚本期望「%」。',
      actual, expected
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

-- ── 1. 数据库级：收回 PUBLIC 的 CONNECT / TEMPORARY / CREATE ───────────────────

DO $harden_database$
BEGIN
  EXECUTE format(
    'REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  RAISE NOTICE '[staging-02] 已收回 PUBLIC 在数据库 % 上的 CONNECT / TEMPORARY / CREATE', current_database();
END
$harden_database$;

-- ── 2. schema 级：收回 PUBLIC 在 public 上的 CREATE / USAGE ────────────────────

REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;

-- ── 3. 自检：PUBLIC 确实已经没有这些权限，且属主仍是 postgres ───────────────────
--
-- `datacl IS NULL` 表示沿用出厂默认，而出厂默认**包含** CONNECT / TEMPORARY；
-- 因此 NULL 必须被判成「PUBLIC 仍可连」，不能当成「没有授权」。

DO $assert$
DECLARE
  pub_connect   boolean;
  pub_temp      boolean;
  pub_schema_cr boolean;
  pub_schema_us boolean;
  db_owner      text;
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

  SELECT pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_database d WHERE d.datname = current_database();

  IF db_owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION
      '数据库属主是「%」，期望 postgres。staging 角色不得成为数据库属主（属主可以 DROP SCHEMA）。',
      db_owner
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE '[staging-02] 自检通过：PUBLIC 已无权限；数据库属主 = postgres';
END
$assert$;
