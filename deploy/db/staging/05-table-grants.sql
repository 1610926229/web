-- PROD-2 / Step 5.8.2 · Staging 数据库权限初始化 5/6：把已存在的表授权给 staging 应用角色
--
--     [执行角色] chaoge_staging_migrator
--     [目标数据库] chaoge_staging（由库名守卫强制）
--     [执行时机] **迁移前后各跑一次**（迁移前空跑，迁移后真正授权）
--
-- ## 04 与 05 的分工
--
-- 04 是**预防**（默认权限，管将来由 staging 迁移角色建的表）；
-- 05 是**收敛**（显式授权，管此刻已经存在的表）。
-- 两者互相不可替代：只有 04 时，任何绕过迁移手工建的表拿不到授权；
-- 只有 05 时，每次新增迁移都必须记得重跑。
--
-- ## staging 专属：收回生产角色在表上的存量授权
--
-- 即使 03 已经收走了 CONNECT，表级 ACL 仍可能残留（例如有人在 staging 上
-- 手工 GRANT 过）。这里作为表的属主把生产角色的权限**全部收回**：
-- 不是「这次不授予」，而是「此刻确定没有」。
--
-- 自检逐表核对，同时验四件事：
--   ① staging 应用角色四项 DML 齐全；
--   ② staging 应用角色没有 TRUNCATE / REFERENCES / TRIGGER / MAINTAIN；
--   ③ 表的属主是 chaoge_staging_migrator（防止有人在错误身份下跑迁移）；
--   ④ 生产角色对这些表**没有任何**权限。

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

-- ── 1. 表：授予四项 DML ───────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chaoge_staging_app;

-- ── 2. 表：收回不该有的权限（收敛存量） ───────────────────────────────────────

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM chaoge_staging_app;

DO $revoke_maintain$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM chaoge_staging_app';
  ELSE
    RAISE NOTICE '[staging-05] 服务端 % < 17，跳过 MAINTAIN 收敛（该权限位不存在）',
      current_setting('server_version');
  END IF;
END
$revoke_maintain$;

-- ── 3. 表与序列：收回生产角色的全部权限 ───────────────────────────────────────

DO $evict_prod_table_grants$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['chaoge_app', 'chaoge_migrator'] LOOP
    IF to_regrole(r) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    RAISE NOTICE '[staging-05] 已收回生产角色 % 在 staging 表 / 序列上的存量权限', r;
  END LOOP;
END
$evict_prod_table_grants$;

-- ── 4. 序列：授予 USAGE / SELECT，收回 UPDATE ─────────────────────────────────

GRANT  USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chaoge_staging_app;
REVOKE UPDATE           ON ALL SEQUENCES IN SCHEMA public FROM chaoge_staging_app;

-- ── 5. 自检：逐表核对 ─────────────────────────────────────────────────────────

DO $assert$
DECLARE
  t                record;
  bad_grants       text[] := '{}';
  bad_revokes      text[] := '{}';
  wrong_owner      text[] := '{}';
  prod_role_hits   text[] := '{}';
  table_count      int := 0;
  maintain_exists  boolean;
  has_prod_roles   boolean;
BEGIN
  maintain_exists := current_setting('server_version_num')::int >= 170000;
  has_prod_roles  := to_regrole('chaoge_app') IS NOT NULL OR to_regrole('chaoge_migrator') IS NOT NULL;

  FOR t IN
    SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    table_count := table_count + 1;

    IF t.owner IS DISTINCT FROM 'chaoge_staging_migrator' THEN
      wrong_owner := wrong_owner || format('%s 属主是 %s', t.relname, t.owner);
    END IF;

    IF NOT has_table_privilege('chaoge_staging_app', t.oid, 'SELECT') THEN
      bad_grants := bad_grants || format('%s 缺 SELECT', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_staging_app', t.oid, 'INSERT') THEN
      bad_grants := bad_grants || format('%s 缺 INSERT', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_staging_app', t.oid, 'UPDATE') THEN
      bad_grants := bad_grants || format('%s 缺 UPDATE', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_staging_app', t.oid, 'DELETE') THEN
      bad_grants := bad_grants || format('%s 缺 DELETE', t.relname);
    END IF;

    IF has_table_privilege('chaoge_staging_app', t.oid, 'TRUNCATE') THEN
      bad_revokes := bad_revokes || format('%s 多 TRUNCATE', t.relname);
    END IF;
    IF has_table_privilege('chaoge_staging_app', t.oid, 'REFERENCES') THEN
      bad_revokes := bad_revokes || format('%s 多 REFERENCES', t.relname);
    END IF;
    IF has_table_privilege('chaoge_staging_app', t.oid, 'TRIGGER') THEN
      bad_revokes := bad_revokes || format('%s 多 TRIGGER', t.relname);
    END IF;
    IF maintain_exists AND has_table_privilege('chaoge_staging_app', t.oid, 'MAINTAIN') THEN
      bad_revokes := bad_revokes || format('%s 多 MAINTAIN', t.relname);
    END IF;

    -- 反例：生产角色对 staging 表不得有任何权限。逐表查，不抽样。
    IF has_prod_roles THEN
      IF to_regrole('chaoge_app') IS NOT NULL AND (
           has_table_privilege('chaoge_app', t.oid, 'SELECT')
        OR has_table_privilege('chaoge_app', t.oid, 'INSERT')
        OR has_table_privilege('chaoge_app', t.oid, 'UPDATE')
        OR has_table_privilege('chaoge_app', t.oid, 'DELETE')
        OR has_table_privilege('chaoge_app', t.oid, 'TRUNCATE')
        OR has_table_privilege('chaoge_app', t.oid, 'REFERENCES')
        OR has_table_privilege('chaoge_app', t.oid, 'TRIGGER')
      ) THEN
        prod_role_hits := prod_role_hits || format('%s 仍可被 chaoge_app 访问', t.relname);
      END IF;

      IF to_regrole('chaoge_migrator') IS NOT NULL AND (
           has_table_privilege('chaoge_migrator', t.oid, 'SELECT')
        OR has_table_privilege('chaoge_migrator', t.oid, 'INSERT')
        OR has_table_privilege('chaoge_migrator', t.oid, 'UPDATE')
        OR has_table_privilege('chaoge_migrator', t.oid, 'DELETE')
        OR has_table_privilege('chaoge_migrator', t.oid, 'TRUNCATE')
        OR has_table_privilege('chaoge_migrator', t.oid, 'REFERENCES')
        OR has_table_privilege('chaoge_migrator', t.oid, 'TRIGGER')
      ) THEN
        prod_role_hits := prod_role_hits || format('%s 仍可被 chaoge_migrator 访问', t.relname);
      END IF;
    END IF;
  END LOOP;

  IF array_length(wrong_owner, 1) > 0 THEN
    RAISE EXCEPTION '表属主不是 chaoge_staging_migrator（% 张表）：%',
      table_count, array_to_string(wrong_owner, '；');
  END IF;
  IF array_length(bad_grants, 1) > 0 THEN
    RAISE EXCEPTION '授权不全（% 张表）：%', table_count, array_to_string(bad_grants, '；');
  END IF;
  IF array_length(bad_revokes, 1) > 0 THEN
    RAISE EXCEPTION 'staging 应用角色存在越权（% 张表）：%', table_count, array_to_string(bad_revokes, '；');
  END IF;
  IF array_length(prod_role_hits, 1) > 0 THEN
    RAISE EXCEPTION '生产角色仍可访问 staging 表（% 张表）：%',
      table_count, array_to_string(prod_role_hits, '；')
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE '[staging-05] 自检通过：% 张表逐张核对，属主 / 授权 / 越权 / 生产角色隔离全部正确', table_count;
END
$assert$;
