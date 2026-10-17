-- PROD-2 / Step 5.8.2 · Staging 数据库权限初始化 4/6：为**将来**由迁移创建的表预置授权
--
--     [执行角色] chaoge_staging_migrator  ← 不是 postgres，见下
--     [目标数据库] chaoge_staging（由库名守卫强制）
--     [执行时机] **必须在第一次 `pnpm db:migrate` 之前**
--
-- ## 为什么必须由 chaoge_staging_migrator 执行
--
-- `ALTER DEFAULT PRIVILEGES` 的键是 **`defaclrole` = 执行者**。若用 postgres 执行，
-- 默认权限会记在 postgres 名下；而迁移是用 staging 迁移角色连上去建的，
-- 那些表**一条都拿不到授权**——脚本全绿，应用全线 `permission denied`。
-- 因此本脚本第一件事是断言 `current_user = 'chaoge_staging_migrator'`。
--
-- ## 给谁、给什么
--
-- 只给 `chaoge_staging_app` 四项 DML（SELECT / INSERT / UPDATE / DELETE）与
-- 序列的 USAGE / SELECT。TRUNCATE / REFERENCES / TRIGGER / MAINTAIN 一律不给。
-- 理由与生产 04 相同：应用角色只做 DML，一个 DDL 权限都不该有。
--
-- ## 额外收敛：清除生产角色的默认授权
--
-- 默认权限是「这个角色将来建的对象自动带上这份授权」。若这份授权曾发给
-- `chaoge_app`，那么 staging 迁移建出的每一张表都会顺手让生产应用角色可读。
-- 本脚本以 staging 迁移角色身份**撤销**这些条目，并在自检里确认一条不剩。

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

-- ── 0. 身份守卫 ────────────────────────────────────────────────────────────────

DO $identity$
BEGIN
  IF current_user IS DISTINCT FROM 'chaoge_staging_migrator' THEN
    RAISE EXCEPTION
      '拒绝执行：本脚本必须以 chaoge_staging_migrator 身份运行（当前为「%」）。',
      current_user
      USING ERRCODE = '42501',
            HINT = '超级用户请先执行 SET ROLE chaoge_staging_migrator; 再运行本脚本。';
  END IF;
END
$identity$;

-- ── 1. 清除生产角色在本角色默认权限里的残留授权 ────────────────────────────────

DO $evict_default_acl$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['chaoge_app', 'chaoge_migrator'] LOOP
    IF to_regrole(r) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    RAISE NOTICE '[staging-04] 已清除生产角色 % 在 staging 迁移角色默认权限中的授权', r;
  END LOOP;
END
$evict_default_acl$;

-- ── 2. 表：给 chaoge_staging_app 预置四项 DML ─────────────────────────────────

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chaoge_staging_app;

-- ── 3. 序列：给 chaoge_staging_app 预置 USAGE / SELECT ────────────────────────

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chaoge_staging_app;

-- ── 4. 自检：记录记在 staging 迁移角色名下，且只发给 staging 应用角色 ────────────

DO $assert$
DECLARE
  migrator_oid oid;
  app_oid      oid;
  acl_row      aclitem[];
  bad_rows     int;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'chaoge_staging_migrator';
  SELECT oid INTO app_oid      FROM pg_roles WHERE rolname = 'chaoge_staging_app';

  IF migrator_oid IS NULL OR app_oid IS NULL THEN
    RAISE EXCEPTION 'staging 角色缺失：请先执行 staging/01-create-roles.sql。';
  END IF;

  SELECT d.defaclacl INTO acl_row
    FROM pg_default_acl d
   WHERE d.defaclrole     = migrator_oid
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype   = 'r';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '未找到 chaoge_staging_migrator 在 public 上的表默认权限记录 —— 04 没有生效，或记到了别的角色名下。';
  END IF;

  DECLARE
    tbl_sel boolean;
    tbl_ins boolean;
    tbl_upd boolean;
    tbl_del boolean;
    tbl_bad text[];
  BEGIN
    SELECT
      coalesce(bool_or(a.privilege_type = 'SELECT'), false),
      coalesce(bool_or(a.privilege_type = 'INSERT'), false),
      coalesce(bool_or(a.privilege_type = 'UPDATE'), false),
      coalesce(bool_or(a.privilege_type = 'DELETE'), false),
      coalesce(array_agg(DISTINCT a.privilege_type)
                 FILTER (WHERE a.privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE')), '{}')
      INTO tbl_sel, tbl_ins, tbl_upd, tbl_del, tbl_bad
      FROM aclexplode(acl_row) a
     WHERE a.grantee = app_oid;

    IF NOT (tbl_sel AND tbl_ins AND tbl_upd AND tbl_del) THEN
      RAISE EXCEPTION
        '表默认权限不全（select=% insert=% update=% delete=%），迁移后 staging 应用会大面积 permission denied。',
        tbl_sel, tbl_ins, tbl_upd, tbl_del;
    END IF;
    IF array_length(tbl_bad, 1) > 0 THEN
      RAISE EXCEPTION '表默认权限里多出了不该给的权限：%', array_to_string(tbl_bad, ', ');
    END IF;
  END;

  SELECT d.defaclacl INTO acl_row
    FROM pg_default_acl d
   WHERE d.defaclrole     = migrator_oid
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype   = 'S';

  IF NOT FOUND THEN
    RAISE EXCEPTION '未找到 chaoge_staging_migrator 在 public 上的序列默认权限记录 —— 04 没有生效。';
  END IF;

  DECLARE
    seq_usage boolean;
    seq_sel   boolean;
    seq_bad   text[];
  BEGIN
    SELECT
      coalesce(bool_or(a.privilege_type = 'USAGE'), false),
      coalesce(bool_or(a.privilege_type = 'SELECT'), false),
      coalesce(array_agg(DISTINCT a.privilege_type)
                 FILTER (WHERE a.privilege_type NOT IN ('USAGE','SELECT')), '{}')
      INTO seq_usage, seq_sel, seq_bad
      FROM aclexplode(acl_row) a
     WHERE a.grantee = app_oid;

    IF NOT (seq_usage AND seq_sel) THEN
      RAISE EXCEPTION '序列默认权限不全（usage=% select=%）。', seq_usage, seq_sel;
    END IF;
    IF array_length(seq_bad, 1) > 0 THEN
      RAISE EXCEPTION '序列默认权限里多出了不该给的权限：%', array_to_string(seq_bad, ', ');
    END IF;
  END;

  -- 反例：默认权限里不得出现生产角色。`defaclrole` 或 `grantee` 任一方是生产角色都算违规。
  SELECT count(*) INTO bad_rows
    FROM pg_default_acl d
    LEFT JOIN aclexplode(d.defaclacl) a ON true
   WHERE d.defaclnamespace = 'public'::regnamespace
     AND (pg_get_userbyid(d.defaclrole) IN ('chaoge_migrator', 'chaoge_app')
          OR pg_get_userbyid(a.grantee) IN ('chaoge_migrator', 'chaoge_app'));

  IF bad_rows > 0 THEN
    RAISE EXCEPTION
      'public schema 的默认权限里仍有 % 条与生产角色相关的记录 —— staging 隔离失败，拒绝继续。',
      bad_rows
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE '[staging-04] 自检通过：默认权限记在 chaoge_staging_migrator 名下，只发给 chaoge_staging_app';
END
$assert$;
