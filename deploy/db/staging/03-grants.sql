-- PROD-2 / Step 5.8.2 · Staging 数据库权限初始化 3/6：连接权与 schema 权
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--
-- 前置：02 已经收回 PUBLIC 的 CONNECT。本脚本把连接权显式发给**两个 staging 角色**。
--
-- ## 本脚本与生产 03 的关键区别：显式驱逐生产角色
--
-- 生产 03 只需要「授予」，因为它面对的是一个从未给过其它角色的新库。
-- staging 面对的风险不同：**万一有人曾把 chaoge_app 的手工授权带到 staging**，
-- 只做「这次不授予」是发现不了存量授权的。因此这里先 `REVOKE`，再 `GRANT`：
--
--   1. 若生产角色存在，收回它们在 staging 库上的全部权限（数据库 + public schema）；
--   2. 只把 CONNECT 发给两个 staging 角色；
--   3. 自检里同时验**正例**（staging 角色必须能连）与**反例**
--      （生产角色必须连不上、staging 应用角色必须没有 DDL 能力）。
--
-- `REVOKE` 一个本来就没有的权限不报错，只打一条 WARNING——这是幂等的预期输出。
-- 动态 SQL 是为了兼容「本地隔离测试时生产角色不存在」的情况；在生产服务器上
-- 两个生产角色一定存在，这段会真正执行。

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

-- ── 1. 驱逐生产角色在 staging 库上的存量权限 ───────────────────────────────────

DO $evict_prod_roles$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['chaoge_app', 'chaoge_migrator'] LOOP
    IF to_regrole(r) IS NULL THEN
      RAISE NOTICE '[staging-03] 生产角色 % 不存在，跳过驱逐（本地隔离测试的正常情况）', r;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r);
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
    RAISE NOTICE '[staging-03] 已收回生产角色 % 在 staging 库上的数据库级与 schema 级权限', r;
  END LOOP;
END
$evict_prod_roles$;

-- ── 2. 数据库级：把 CONNECT 发给两个 staging 角色（02 已从 PUBLIC 收回） ────────

DO $connect$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO chaoge_staging_migrator, chaoge_staging_app',
    current_database()
  );
  RAISE NOTICE '[staging-03] 已授予两个 staging 角色对 % 的 CONNECT', current_database();
END
$connect$;

-- ── 3. schema 级：USAGE 给两个角色，CREATE 只给迁移角色 ────────────────────────

GRANT USAGE  ON SCHEMA public TO chaoge_staging_migrator, chaoge_staging_app;
GRANT CREATE ON SCHEMA public TO chaoge_staging_migrator;

-- 收敛：应用角色在数据库与 schema 上都不需要 DDL / 临时表能力。
DO $revoke_app$
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM chaoge_staging_app',
    current_database()
  );
END
$revoke_app$;

REVOKE CREATE ON SCHEMA public FROM chaoge_staging_app;

-- ── 4. 自检：正例与反例同时验证 ────────────────────────────────────────────────

DO $assert$
DECLARE
  r text;
BEGIN
  IF NOT has_database_privilege('chaoge_staging_migrator', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'chaoge_staging_migrator 不能连接 %。', current_database();
  END IF;
  IF NOT has_database_privilege('chaoge_staging_app', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'chaoge_staging_app 不能连接 %。', current_database();
  END IF;

  IF has_database_privilege('chaoge_staging_app', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'chaoge_staging_app 能在 % 上建临时表 —— 应用不需要这个能力。', current_database();
  END IF;
  IF has_database_privilege('chaoge_staging_app', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'chaoge_staging_app 能在 % 上建 schema —— 应用不需要这个能力。', current_database();
  END IF;

  IF NOT has_schema_privilege('chaoge_staging_migrator', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'chaoge_staging_migrator 在 public 上没有 USAGE。';
  END IF;
  IF NOT has_schema_privilege('chaoge_staging_migrator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'chaoge_staging_migrator 在 public 上没有 CREATE —— 迁移会在第一条 CREATE TABLE 处失败。';
  END IF;

  IF NOT has_schema_privilege('chaoge_staging_app', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'chaoge_staging_app 在 public 上没有 USAGE —— 应用按名字找不到任何表。';
  END IF;
  IF has_schema_privilege('chaoge_staging_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'chaoge_staging_app 竟然能在 public 上建对象 —— 应用角色必须没有 DDL 能力。';
  END IF;

  -- 反例：生产角色不得持有 staging 库的任何连接权 / schema 权。
  -- 这两个断言是「独立数据库」这条决策在权限层的最后一道检查。
  FOREACH r IN ARRAY ARRAY['chaoge_app', 'chaoge_migrator'] LOOP
    IF to_regrole(r) IS NULL THEN
      CONTINUE;
    END IF;
    IF has_database_privilege(r, current_database(), 'CONNECT') THEN
      RAISE EXCEPTION
        '生产角色 % 仍能连接 staging 库 % —— 独立数据库隔离失败，拒绝继续。',
        r, current_database()
        USING ERRCODE = '42501';
    END IF;
    IF has_schema_privilege(r, 'public', 'USAGE') THEN
      RAISE EXCEPTION
        '生产角色 % 仍对 staging 的 public schema 有 USAGE —— 隔离失败，拒绝继续。',
        r
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RAISE NOTICE '[staging-03] 自检通过：连接权只发给 staging 角色，生产角色无任何 staging 权限';
END
$assert$;
