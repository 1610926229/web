-- PROD-2 / Step 5.8.2 · Staging 数据库隔离验收（**只读**）
--
--     [执行角色] postgres（第 2b 节读 `pg_authid` 需要超级用户；其余各节任意角色可读）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--     [性质] **纯只读**。全文没有一条 DDL / DML / GRANT / REVOKE / SET 改动性语句，
--            任何时刻执行都不会改变集群状态。
--
-- ## 用法
--
--     psql -U postgres -d chaoge_staging -v ON_ERROR_STOP=1 -f deploy/db/staging/99-verify.sql
--
-- 每节以 `section=N` 列开头；最后一节 `section=9` 给出总体判定 `PASS` / `FAIL`。
--
-- ## 验的是什么
--
-- 不是「脚本跑过没有」，而是**此刻集群的真实状态**：
--
--   1. 两个 staging 角色是最小权限登录角色，与生产角色无任何成员关系；
--   2. PUBLIC 在库 / schema 上没有任何权限（出厂默认就是开放的，必须显式收回）；
--   3. 生产角色 `chaoge_app` / `chaoge_migrator` 对 staging **连不上、看不见、读不到**；
--   4. staging 应用角色只有四项 DML，没有任何 DDL / TRUNCATE / 临时表能力；
--   5. 默认权限记在 staging 迁移角色名下，将来迁移建的表自动授权给 staging 应用角色；
--   6. 逐表核对属主、授权、越权、生产角色残留；
--   7. 迁移与最小测试数据已就位（否则登录会 404 / 403）。
--
-- 第 9 节的 PASS 是「可以给 staging 写入 DATABASE_URL」的**必要条件**。
-- 它不判断应用本身是否健康——那由 `deploy/app/healthcheck.sh` 负责。

DO $guard$
DECLARE
  expected text := coalesce(nullif(current_setting('chaoge.expected_database', true), ''), 'chaoge_staging');
  actual   text := current_database();
BEGIN
  IF actual = 'chaoge_prod' OR expected = 'chaoge_prod' THEN
    RAISE EXCEPTION
      '拒绝执行：这是 staging 验收脚本，永远不会对 chaoge_prod 执行（当前库「%」，期望「%」）。',
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

  IF to_regrole('chaoge_staging_migrator') IS NULL OR to_regrole('chaoge_staging_app') IS NULL THEN
    RAISE EXCEPTION
      'staging 角色不完整 —— 请先执行 staging/01-create-roles.sql。';
  END IF;
END
$guard$;

\pset pager off
\echo ''
\echo '══════════════════════════════════════════════════════════════════════'
\echo ' PROD-2 / Step 5.8.2 · Staging 数据库隔离验收（只读）'
\echo '══════════════════════════════════════════════════════════════════════'

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. 环境
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 1 AS section, 'environment' AS check_name,
       current_database()  AS database_name,
       current_user        AS exec_role,
       current_setting('server_version') AS server_version,
       pg_get_userbyid(d.datdba) AS database_owner,
       (SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) AS tables_in_public,
       (SELECT count(*) FROM schema_migrations) AS applied_migrations
  FROM pg_database d
 WHERE d.datname = current_database();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. 角色属性与隔离
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 六个特权布尔列必须全部 false，`rolcanlogin` 必须 true。
-- 下方 `produces_*` 两列在本地隔离测试（生产角色不存在）时为 NULL，属于正常情况；
-- 在生产服务器上必须都是 `false`（两列都显示 f）。

SELECT 2 AS section, 'role attributes' AS check_name,
       rolname,
       rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
       CASE WHEN rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
            THEN 'FAIL 仍持有特权属性'
            WHEN NOT rolcanlogin
            THEN 'FAIL 不可登录'
            ELSE 'ok' END AS verdict
  FROM pg_roles
 WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
 ORDER BY rolname;

-- 2a. 成员关系：staging 与生产角色之间不得有任何一条（双向），也不得加入 pg_* 预定义角色。

SELECT 2 AS section, 'role membership' AS check_name,
       member.rolname AS member_role,
       grp.rolname    AS group_role,
       CASE WHEN grp.rolname LIKE 'pg\_%' THEN 'FAIL 预定义角色（绕过表级授权）'
            ELSE 'FAIL 与生产角色存在成员关系' END AS verdict
  FROM pg_auth_members m
  JOIN pg_roles grp    ON grp.oid = m.roleid
  JOIN pg_roles member ON member.oid = m.member
 WHERE ((member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
         AND grp.rolname IN ('chaoge_migrator', 'chaoge_app'))
     OR (member.rolname IN ('chaoge_migrator', 'chaoge_app')
         AND grp.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app'))
     OR (member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
         AND grp.rolname LIKE 'pg\_%'))
 ORDER BY 2, 3;

-- 2b. 口令是否已设置 —— **仅布尔值**，绝不输出校验子本身。

DO $pwcheck$
DECLARE
  r record;
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE NOTICE '[2b] 跳过口令检查：读取 pg_authid 需要超级用户（以 % 执行）', current_user;
    RETURN;
  END IF;

  FOR r IN
    SELECT rolname,
           (rolpassword IS NOT NULL AND rolpassword <> '') AS has_password,
           CASE WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'SCRAM-SHA-256'
                WHEN rolpassword LIKE 'md5%'          THEN 'md5（弱，建议改为 SCRAM）'
                WHEN rolpassword IS NULL OR rolpassword = '' THEN '（空）'
                ELSE 'unknown' END AS verifier_kind
      FROM pg_authid
     WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
     ORDER BY rolname
  LOOP
    RAISE NOTICE '[2b] % : 口令已设置 = % ，校验子类型 = %',
      r.rolname, r.has_password, r.verifier_kind;
  END LOOP;
END
$pwcheck$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. 数据库级 ACL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ `datacl IS NULL` = 沿用出厂默认，而出厂默认**包含** CONNECT / TEMPORARY，
--    因此 NULL 必须判成「PUBLIC 仍可连」。
--
-- `prod_*` 两列在本地无生产角色时为 NULL；生产服务器上必须是 false 或 NULL（角色不存在）。

SELECT 3 AS section, 'database ACL' AS check_name,
       d.datname,
       d.datacl IS NULL AS datacl_is_default,
       coalesce((SELECT bool_or(a.privilege_type = 'CONNECT')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)                          AS public_can_connect,
       coalesce((SELECT bool_or(a.privilege_type = 'TEMPORARY')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)                          AS public_can_temp,
       coalesce((SELECT bool_or(a.privilege_type = 'CREATE')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)                          AS public_can_create,
       has_database_privilege('chaoge_staging_migrator', d.datname, 'CONNECT') AS staging_migrator_connect,
       has_database_privilege('chaoge_staging_app',      d.datname, 'CONNECT') AS staging_app_connect,
       has_database_privilege('chaoge_staging_app',      d.datname, 'CREATE')  AS staging_app_create,
       has_database_privilege('chaoge_staging_app',      d.datname, 'TEMPORARY') AS staging_app_temp,
       (SELECT has_database_privilege('chaoge_migrator', d.datname, 'CONNECT')
          FROM pg_roles WHERE rolname = 'chaoge_migrator') AS prod_migrator_connect,
       (SELECT has_database_privilege('chaoge_app', d.datname, 'CONNECT')
          FROM pg_roles WHERE rolname = 'chaoge_app')      AS prod_app_connect
  FROM pg_database d
 WHERE d.datname = current_database();

-- 3a. 跨库：staging 角色不得能连接 chaoge_prod（角色是集群级的，这一条必须单独查）。

SELECT 3 AS section, 'cross-database isolation' AS check_name,
       d.datname AS other_database,
       (SELECT has_database_privilege('chaoge_staging_migrator', d.datname, 'CONNECT')
          FROM pg_roles WHERE rolname = 'chaoge_staging_migrator') AS staging_migrator_can_connect,
       (SELECT has_database_privilege('chaoge_staging_app', d.datname, 'CONNECT')
          FROM pg_roles WHERE rolname = 'chaoge_staging_app')      AS staging_app_can_connect,
       CASE WHEN d.datname = current_database() THEN '（当前库）'
            ELSE '必须为 false 或 NULL' END AS expectation
  FROM pg_database d
 WHERE d.datname = 'chaoge_prod';

-- 3b. 数据库上所有非 PUBLIC 的显式授权

SELECT 3 AS section, 'database grants (non-PUBLIC)' AS check_name,
       pg_get_userbyid(a.grantee) AS grantee,
       a.privilege_type,
       pg_get_userbyid(a.grantor) AS grantor
  FROM pg_database d, aclexplode(d.datacl) a
 WHERE d.datname = current_database()
   AND a.grantee <> 0
 ORDER BY 2, 3;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. schema `public`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 期望：PUBLIC 无 USAGE / CREATE；staging 迁移角色 USAGE + CREATE；
-- staging 应用角色只有 USAGE。属主保持出厂值 `pg_database_owner`。

SELECT 4 AS section, 'schema public' AS check_name,
       n.nspname,
       pg_get_userbyid(n.nspowner) AS owner,
       n.nspacl IS NULL AS nspacl_is_default,
       coalesce((SELECT bool_or(a.privilege_type = 'CREATE')
                   FROM aclexplode(n.nspacl) a WHERE a.grantee = 0),
                false) AS public_create,
       coalesce((SELECT bool_or(a.privilege_type = 'USAGE')
                   FROM aclexplode(n.nspacl) a WHERE a.grantee = 0),
                n.nspacl IS NULL) AS public_usage,
       has_schema_privilege('chaoge_staging_migrator', 'public', 'USAGE')  AS staging_migrator_usage,
       has_schema_privilege('chaoge_staging_migrator', 'public', 'CREATE') AS staging_migrator_create,
       has_schema_privilege('chaoge_staging_app',      'public', 'USAGE')  AS staging_app_usage,
       has_schema_privilege('chaoge_staging_app',      'public', 'CREATE') AS staging_app_create,
       (SELECT has_schema_privilege('chaoge_migrator', 'public', 'USAGE')
          FROM pg_roles WHERE rolname = 'chaoge_migrator') AS prod_migrator_usage,
       (SELECT has_schema_privilege('chaoge_app', 'public', 'USAGE')
          FROM pg_roles WHERE rolname = 'chaoge_app')      AS prod_app_usage
  FROM pg_namespace n
 WHERE n.nspname = 'public';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. 默认权限
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 期望两行（TABLE / SEQUENCE），`defaclrole = chaoge_staging_migrator`。
-- 若显示 postgres，说明 04 执行身份错了，迁移建出的表拿不到授权。

SELECT 5 AS section, 'default privileges' AS check_name,
       pg_get_userbyid(d.defaclrole) AS for_creating_role,
       coalesce(n.nspname, '(all schemas)') AS in_schema,
       CASE d.defaclobjtype WHEN 'r' THEN 'TABLE'
                            WHEN 'S' THEN 'SEQUENCE'
                            WHEN 'f' THEN 'FUNCTION'
                            WHEN 'T' THEN 'TYPE'
                            ELSE d.defaclobjtype END AS objtype,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(a.grantee) END AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  LEFT JOIN aclexplode(d.defaclacl) a ON true
 WHERE d.defaclnamespace = 'public'::regnamespace
 GROUP BY d.defaclrole, n.nspname, d.defaclobjtype, a.grantee
 ORDER BY 2, 4, 5;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. 逐表权限矩阵
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 6 AS section, 'table matrix' AS check_name,
       c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner,
       has_table_privilege('chaoge_staging_app', c.oid, 'SELECT')  AS app_sel,
       has_table_privilege('chaoge_staging_app', c.oid, 'INSERT')  AS app_ins,
       has_table_privilege('chaoge_staging_app', c.oid, 'UPDATE')  AS app_upd,
       has_table_privilege('chaoge_staging_app', c.oid, 'DELETE')  AS app_del,
       has_table_privilege('chaoge_staging_app', c.oid, 'TRUNCATE') AS app_trunc,
       has_table_privilege('chaoge_staging_app', c.oid, 'REFERENCES') AS app_ref,
       has_table_privilege('chaoge_staging_app', c.oid, 'TRIGGER')  AS app_trig,
       CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN has_table_privilege('chaoge_staging_app', c.oid, 'MAINTAIN')
            ELSE false END AS app_maintain,
       -- 生产角色若存在，逐表看是否残留任何权限；角色不存在时这两列为 NULL。
       coalesce((SELECT bool_or(has_table_privilege('chaoge_app', c.oid, p.priv))
                   FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                               'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                  WHERE rolname = 'chaoge_app'), false) AS prod_app_any_priv,
       coalesce((SELECT bool_or(has_table_privilege('chaoge_migrator', c.oid, p.priv))
                   FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                               'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                  WHERE rolname = 'chaoge_migrator'), false) AS prod_migrator_any_priv,
       CASE WHEN pg_get_userbyid(c.relowner) IS DISTINCT FROM 'chaoge_staging_migrator'
            THEN 'FAIL 属主错误'
            WHEN NOT (has_table_privilege('chaoge_staging_app', c.oid, 'SELECT')
                  AND has_table_privilege('chaoge_staging_app', c.oid, 'INSERT')
                  AND has_table_privilege('chaoge_staging_app', c.oid, 'UPDATE')
                  AND has_table_privilege('chaoge_staging_app', c.oid, 'DELETE'))
            THEN 'FAIL 缺 DML'
            WHEN has_table_privilege('chaoge_staging_app', c.oid, 'TRUNCATE')
              OR has_table_privilege('chaoge_staging_app', c.oid, 'REFERENCES')
              OR has_table_privilege('chaoge_staging_app', c.oid, 'TRIGGER')
              OR (current_setting('server_version_num')::int >= 170000
                  AND has_table_privilege('chaoge_staging_app', c.oid, 'MAINTAIN'))
            THEN 'FAIL 应用角色越权'
            WHEN coalesce((SELECT bool_or(has_table_privilege('chaoge_app', c.oid, p.priv))
                             FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                                         'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                            WHERE rolname = 'chaoge_app'), false)
              OR coalesce((SELECT bool_or(has_table_privilege('chaoge_migrator', c.oid, p.priv))
                             FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                                         'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                            WHERE rolname = 'chaoge_migrator'), false)
            THEN 'FAIL 生产角色残留权限'
            ELSE 'ok' END AS verdict
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
 ORDER BY c.relname;

-- 6b. 汇总

SELECT 6 AS section, 'table summary' AS check_name,
       count(*) AS tables,
       count(*) FILTER (WHERE pg_get_userbyid(c.relowner) = 'chaoge_staging_migrator') AS owner_ok,
       count(*) FILTER (WHERE has_table_privilege('chaoge_staging_app', c.oid, 'SELECT')
                          AND has_table_privilege('chaoge_staging_app', c.oid, 'INSERT')
                          AND has_table_privilege('chaoge_staging_app', c.oid, 'UPDATE')
                          AND has_table_privilege('chaoge_staging_app', c.oid, 'DELETE')) AS dml_ok,
       count(*) FILTER (WHERE has_table_privilege('chaoge_staging_app', c.oid, 'TRUNCATE')
                           OR has_table_privilege('chaoge_staging_app', c.oid, 'REFERENCES')
                           OR has_table_privilege('chaoge_staging_app', c.oid, 'TRIGGER')
                           OR (current_setting('server_version_num')::int >= 170000
                               AND has_table_privilege('chaoge_staging_app', c.oid, 'MAINTAIN'))) AS over_privileged
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p');

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. 序列权限（当前 39 张业务表主键全是 text，通常为空集）
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 7 AS section, 'sequence privileges' AS check_name,
       c.relname AS sequence_name,
       has_sequence_privilege('chaoge_staging_app', c.oid, 'USAGE')  AS app_usage,
       has_sequence_privilege('chaoge_staging_app', c.oid, 'SELECT') AS app_select,
       has_sequence_privilege('chaoge_staging_app', c.oid, 'UPDATE') AS app_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY c.relname;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. 迁移与最小测试数据
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 缺任何一条，staging 上的 mock 登录就会 404 / 403 / 500。
-- 本节只读；数据由 `06-bootstrap-data.sql` 以 staging 应用角色写入。

SELECT 8 AS section, 'bootstrap data' AS check_name,
       (SELECT count(*) FROM schema_migrations) AS applied_migrations,
       EXISTS (SELECT 1 FROM users WHERE id = 'u-1001') AS user_1001,
       EXISTS (SELECT 1 FROM users WHERE id = 'u-1002') AS user_1002,
       EXISTS (SELECT 1 FROM admin_accounts
                WHERE id = 'admin-1' AND role = 'admin' AND enabled) AS admin_1,
       EXISTS (SELECT 1 FROM staff_accounts
                WHERE id = 'staff-1' AND role = 'customer_service'
                  AND enabled AND removed_at IS NULL) AS staff_1,
       EXISTS (SELECT 1 FROM companions
                WHERE id = 'cp-demo' AND user_id = 'u-1001'
                  AND enabled AND removed_at IS NULL) AS companion_demo,
       EXISTS (SELECT 1 FROM products
                WHERE id = 'p-400w' AND status = 'on' AND removed_at IS NULL) AS product_400w,
       EXISTS (SELECT 1 FROM product_specs
                WHERE id = 's-400w' AND product_id = 'p-400w') AS spec_400w;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. 违规汇总与总体判定
-- ═══════════════════════════════════════════════════════════════════════════

WITH v AS (
  SELECT
    (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app'))  AS staging_roles,
    (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
             OR rolbypassrls OR NOT rolcanlogin))                          AS role_attr_bad,
    (SELECT count(*) FROM pg_auth_members m
       JOIN pg_roles grp    ON grp.oid = m.roleid
       JOIN pg_roles member ON member.oid = m.member
      WHERE ((member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
              AND grp.rolname IN ('chaoge_migrator', 'chaoge_app'))
          OR (member.rolname IN ('chaoge_migrator', 'chaoge_app')
              AND grp.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app'))
          OR (member.rolname IN ('chaoge_staging_migrator', 'chaoge_staging_app')
              AND grp.rolname LIKE 'pg\_%')))                              AS membership_bad,
    (SELECT pg_get_userbyid(d.datdba) FROM pg_database d
      WHERE d.datname = current_database())                                AS db_owner,
    (SELECT coalesce((SELECT bool_or(a.privilege_type IN ('CONNECT','TEMPORARY','CREATE'))
                        FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                     d.datacl IS NULL) FROM pg_database d
      WHERE d.datname = current_database())                                AS public_db_priv,
    (SELECT coalesce((SELECT bool_or(a.privilege_type IN ('USAGE','CREATE'))
                        FROM aclexplode(n.nspacl) a WHERE a.grantee = 0),
                     n.nspacl IS NULL)
       FROM pg_namespace n WHERE n.nspname = 'public')                     AS public_schema_priv,
    (SELECT count(*) FROM pg_default_acl d
      WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'chaoge_staging_migrator')
        AND d.defaclnamespace = 'public'::regnamespace
        AND d.defaclobjtype IN ('r','S'))                                  AS default_acl_ok,
    (SELECT count(*) FROM pg_default_acl d
      LEFT JOIN aclexplode(d.defaclacl) a ON true
      WHERE d.defaclnamespace = 'public'::regnamespace
        AND (pg_get_userbyid(d.defaclrole) IN ('chaoge_migrator', 'chaoge_app')
             OR (a.grantee <> 0
                 AND pg_get_userbyid(a.grantee) IN ('chaoge_migrator', 'chaoge_app')))) AS default_acl_prod,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND pg_get_userbyid(c.relowner) IS DISTINCT FROM 'chaoge_staging_migrator') AS tables_wrong_owner,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND NOT (has_table_privilege('chaoge_staging_app', c.oid, 'SELECT')
             AND has_table_privilege('chaoge_staging_app', c.oid, 'INSERT')
             AND has_table_privilege('chaoge_staging_app', c.oid, 'UPDATE')
             AND has_table_privilege('chaoge_staging_app', c.oid, 'DELETE')))  AS tables_bad_grant,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND (has_table_privilege('chaoge_staging_app', c.oid, 'TRUNCATE')
          OR has_table_privilege('chaoge_staging_app', c.oid, 'REFERENCES')
          OR has_table_privilege('chaoge_staging_app', c.oid, 'TRIGGER')
          OR (current_setting('server_version_num')::int >= 170000
              AND has_table_privilege('chaoge_staging_app', c.oid, 'MAINTAIN')))) AS tables_bad_revoke,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND coalesce((SELECT bool_or(has_table_privilege('chaoge_app', c.oid, p.priv))
                        FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                                    'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                       WHERE rolname = 'chaoge_app'), false))               AS prod_app_tables,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND coalesce((SELECT bool_or(has_table_privilege('chaoge_migrator', c.oid, p.priv))
                        FROM pg_roles, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                                    'TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
                       WHERE rolname = 'chaoge_migrator'), false))          AS prod_migrator_tables,
    (SELECT count(*) FROM pg_database d
      WHERE d.datname = 'chaoge_prod'
        AND (coalesce((SELECT has_database_privilege('chaoge_staging_migrator', d.datname, 'CONNECT')
                         FROM pg_roles WHERE rolname = 'chaoge_staging_migrator'), false)
          OR coalesce((SELECT has_database_privilege('chaoge_staging_app', d.datname, 'CONNECT')
                         FROM pg_roles WHERE rolname = 'chaoge_staging_app'), false))) AS staging_can_reach_prod,
    (SELECT count(*) FROM pg_database d
      WHERE d.datname = current_database()
        AND (coalesce((SELECT has_database_privilege('chaoge_migrator', d.datname, 'CONNECT')
                         FROM pg_roles WHERE rolname = 'chaoge_migrator'), false)
          OR coalesce((SELECT has_database_privilege('chaoge_app', d.datname, 'CONNECT')
                         FROM pg_roles WHERE rolname = 'chaoge_app'), false)
          OR coalesce((SELECT has_schema_privilege('chaoge_migrator', 'public', 'USAGE')
                         FROM pg_roles WHERE rolname = 'chaoge_migrator'), false)
          OR coalesce((SELECT has_schema_privilege('chaoge_app', 'public', 'USAGE')
                         FROM pg_roles WHERE rolname = 'chaoge_app'), false))) AS prod_roles_on_staging,
    has_schema_privilege('chaoge_staging_app', 'public', 'CREATE')         AS app_can_create_schema,
    has_database_privilege('chaoge_staging_app', current_database(), 'CREATE')    AS app_can_create_db,
    has_database_privilege('chaoge_staging_app', current_database(), 'TEMPORARY') AS app_can_temp,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p'))               AS table_count,
    (SELECT count(*) FROM schema_migrations)                               AS applied_migrations,
    EXISTS (SELECT 1 FROM users WHERE id = 'u-1001')
      AND EXISTS (SELECT 1 FROM users WHERE id = 'u-1002')
      AND EXISTS (SELECT 1 FROM admin_accounts
                   WHERE id = 'admin-1' AND role = 'admin' AND enabled)
      AND EXISTS (SELECT 1 FROM staff_accounts
                   WHERE id = 'staff-1' AND role = 'customer_service'
                     AND enabled AND removed_at IS NULL)
      AND EXISTS (SELECT 1 FROM companions
                   WHERE id = 'cp-demo' AND user_id = 'u-1001'
                     AND enabled AND removed_at IS NULL)
      AND EXISTS (SELECT 1 FROM products
                   WHERE id = 'p-400w' AND status = 'on' AND removed_at IS NULL)
      AND EXISTS (SELECT 1 FROM product_specs WHERE id = 's-400w' AND product_id = 'p-400w')
                                                                            AS bootstrap_ok
)
SELECT 9 AS section, 'OVERALL' AS check_name,
       CASE WHEN staging_roles = 2
             AND role_attr_bad = 0
             AND membership_bad = 0
             AND db_owner = 'postgres'
             AND NOT public_db_priv
             AND NOT public_schema_priv
             AND default_acl_ok = 2
             AND default_acl_prod = 0
             AND tables_wrong_owner = 0
             AND tables_bad_grant = 0
             AND tables_bad_revoke = 0
             AND prod_app_tables = 0
             AND prod_migrator_tables = 0
             AND staging_can_reach_prod = 0
             AND prod_roles_on_staging = 0
             AND NOT app_can_create_schema
             AND NOT app_can_create_db
             AND NOT app_can_temp
             AND table_count > 0
             AND applied_migrations >= 16
             AND bootstrap_ok
            THEN 'PASS'
            ELSE 'FAIL' END AS verdict,
       format('staging 角色 %s/2 · 特权属性违规 %s · 成员关系违规 %s · 库属主 %s · '
              || 'PUBLIC 库权限 %s · PUBLIC schema 权限 %s · 默认权限 %s/2 · 默认权限涉及生产角色 %s · '
              || '表属主错误 %s · 表缺 DML %s · 表越权 %s · 生产角色可达表 %s/%s · '
              || 'staging 可连 chaoge_prod %s · 生产角色可达 staging %s · '
              || '应用可建对象 %s/%s/临时表 %s · public 表数 %s · 迁移 %s · 最小数据 %s',
              staging_roles, role_attr_bad, membership_bad, db_owner,
              public_db_priv, public_schema_priv, default_acl_ok, default_acl_prod,
              tables_wrong_owner, tables_bad_grant, tables_bad_revoke,
              prod_app_tables, prod_migrator_tables,
              staging_can_reach_prod, prod_roles_on_staging,
              app_can_create_schema, app_can_create_db, app_can_temp,
              table_count, applied_migrations, bootstrap_ok)
         AS detail
  FROM v;
