-- PROD-2 / Step 5.8.2 · Staging 数据库权限初始化 1/6：创建（或收敛）两个独立角色
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--
-- ## 为什么不能复用生产角色
--
-- 角色是**集群级**对象，不隶属于任何一个数据库。若 staging 继续使用
-- `chaoge_migrator` / `chaoge_app`，那么同一个应用凭据同时握有两个库的读写权：
-- 一次 `DATABASE_URL` 写错、一次运维在错误终端里跑迁移，就会直接落到 chaoge_prod。
-- 本脚本因此创建**两个全新的、只属于 staging 的角色**：
--
--     chaoge_staging_migrator  —— 只负责在 chaoge_staging 建表（DDL）
--     chaoge_staging_app       —— 只负责 chaoge_staging 的运行时读写（DML）
--
-- 生产侧的两个脚本（`deploy/db/01-create-roles.sql` 等）**一个字都没有改**：
-- 生产角色的属性、口令、授权路径与本文件完全无关。
--
-- ## 本脚本不设置任何密码
--
-- 与生产 01 相同的理由：创建角色、设置密码、授予权限是三件事。
-- 本文件因此可以安全地进 Git。密码用 psql 的 `\password` 交互设置，
-- 不经过命令行参数、shell 历史或 psql 历史。运行时口令由
-- `deploy/app/setup-staging-env.sh` 交互写入 `/etc/chaoge/staging.env`。
--
-- ## 库名守卫
--
-- 角色是集群级对象，连错库仍会改整个集群。每个 staging 脚本开头都有同一道守卫，
-- 它做三件事：① 永远拒绝 chaoge_prod；② 只允许 chaoge_staging*；
-- ③ 当前连接库必须与期望库一致。本地隔离验证可用
-- `SET chaoge.expected_database = 'chaoge_staging_xxx_test';` 放行，
-- 但**无论怎么设置，chaoge_prod 都会被无条件拒绝**。

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
      USING ERRCODE = '42501',
            HINT = '默认目标库是 chaoge_staging；本地隔离验证请用 chaoge_staging_*_test。';
  END IF;

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      '拒绝执行：当前连接的是数据库「%」，而脚本期望「%」。',
      actual, expected
      USING ERRCODE = '42501',
            HINT = '若要对本地隔离库执行，请先 SET chaoge.expected_database = ''<chaoge_staging_*_test>'';';
  END IF;
END
$guard$;

-- ── 1. 创建（不存在时） ────────────────────────────────────────────────────────

DO $create$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaoge_staging_migrator') THEN
    EXECUTE 'CREATE ROLE chaoge_staging_migrator LOGIN';
    RAISE NOTICE '[staging-01] 已创建角色 chaoge_staging_migrator（未设置密码）';
  ELSE
    RAISE NOTICE '[staging-01] 角色 chaoge_staging_migrator 已存在，跳过创建（不修改其密码）';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaoge_staging_app') THEN
    EXECUTE 'CREATE ROLE chaoge_staging_app LOGIN';
    RAISE NOTICE '[staging-01] 已创建角色 chaoge_staging_app（未设置密码）';
  ELSE
    RAISE NOTICE '[staging-01] 角色 chaoge_staging_app 已存在，跳过创建（不修改其密码）';
  END IF;
END
$create$;

-- ── 2. 收敛属性（无论本次是否新建，无条件执行） ────────────────────────────────

ALTER ROLE chaoge_staging_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;
ALTER ROLE chaoge_staging_app      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;

-- ── 3. 自检：属性与角色隔离 ───────────────────────────────────────────────────
--
-- ① 两个角色都存在、可登录、没有任何特权属性；
-- ② **与生产角色之间不存在任何成员关系**。哪怕只有一条
--    `GRANT chaoge_staging_app TO chaoge_app`，隔离就已经破了：
--    PostgreSQL 的成员关系是继承的，生产角色会立刻获得 staging 的读写权。
-- ③ 不在任何 `pg_*` 预定义角色里（`pg_read_all_data` / `pg_write_all_data` /
--    `pg_monitor` 这类角色能绕过表级授权，属于隐式的超级权限）。

DO $assert$
DECLARE
  r record;
  bad_membership text;
BEGIN
  FOR r IN
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
      FROM pg_roles
     WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
     ORDER BY rolname
  LOOP
    IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION
        '角色 % 仍带有特权属性（super=% createdb=% createrole=% replication=% bypassrls=%），拒绝继续。',
        r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls;
    END IF;
    IF NOT r.rolcanlogin THEN
      RAISE EXCEPTION '角色 % 不是可登录角色（rolcanlogin=false）。', r.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')) <> 2 THEN
    RAISE EXCEPTION '两个 staging 角色未能同时就位，拒绝继续。';
  END IF;

  SELECT format('%s 是 %s 的成员（roleid=%s, member=%s）', member.rolname, grp.rolname, grp.rolname, member.rolname)
    INTO bad_membership
    FROM pg_auth_members m
    JOIN pg_roles grp    ON grp.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
   WHERE (member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
          AND grp.rolname IN ('chaoge_migrator', 'chaoge_app'))
      OR (member.rolname IN ('chaoge_migrator', 'chaoge_app')
          AND grp.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app'))
   LIMIT 1;

  IF bad_membership IS NOT NULL THEN
    RAISE EXCEPTION
      '生产角色与 staging 角色之间存在成员关系：%。这会让隔离形同虚设，拒绝继续。',
      bad_membership
      USING ERRCODE = '42501',
            HINT = '先执行 REVOKE <group> FROM <member>; 再重跑本脚本。';
  END IF;

  SELECT format('%s 是预定义角色 %s 的成员', member.rolname, grp.rolname)
    INTO bad_membership
    FROM pg_auth_members m
    JOIN pg_roles grp    ON grp.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
   WHERE member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
     AND grp.rolname LIKE 'pg\_%'
   LIMIT 1;

  IF bad_membership IS NOT NULL THEN
    RAISE EXCEPTION
      'staging 角色加入了 PostgreSQL 预定义角色：%。预定义角色会绕过表级授权，拒绝继续。',
      bad_membership
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE '[staging-01] 自检通过：两个 staging 角色均为最小权限可登录角色，且与生产角色无成员关系';
END
$assert$;
