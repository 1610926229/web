-- PROD-2 · 数据库权限验收（**只读**）
--
--     [执行角色] postgres（第 2 节读 `pg_authid` 需要超级用户；其余各节任意角色可读）
--     [目标数据库] 连接到哪个库就验哪个库 —— 第 1 节会把库名打出来
--     [性质] **纯只读**。全文没有一条 DDL / DML / GRANT / REVOKE / SET 改动性语句，
--            任何时刻、任何库上执行都不会改变集群状态。
--
-- ## 用法
--
--     psql -U postgres -d chaoge_prod -f deploy/db/99-verify.sql
--
-- 每节以 `section=N` 列开头，便于 `grep '^section=6'` 只取一节。
-- 最后一节 `section=8` 给出**总体判定**：`PASS` / `FAIL` 加一句原因。
--
-- ## 设计原则：只报告「能不能做」，不报告「怎么做的」
--
-- 第 2 节查口令是否已设置，但**永远输出布尔值**。`pg_authid.rolpassword`
-- 存的是 SCRAM 校验子（不是明文），但校验子仍然是**机密**——拿到它就能对
-- 该角色发起离线字典攻击。所以本文件里没有任何一处把 `rolpassword` 作为结果列。
-- （顺带：`pg_roles.rolpassword` 对所有人恒返回 `********`，
--   它**无法**用来判断口令是否为空——判断必须走 `pg_authid`，而这正是本节需要超级用户的原因。）

\pset pager off
\echo ''
\echo '══════════════════════════════════════════════════════════════════════'
\echo ' PROD-2 数据库权限验收（只读）'
\echo '══════════════════════════════════════════════════════════════════════'

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. 环境
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 1 AS section, 'environment' AS check_name,
       current_database()  AS database_name,
       current_user        AS exec_role,
       current_setting('server_version') AS server_version,
       (SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) AS tables_in_public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. 角色属性（任务要求第 1、9 条）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `rolsuper` 等六个布尔列必须**全部为 false**，`rolcanlogin` 必须为 true。
-- 任一为 true 就是权限收敛失败——尤其是 `rolsuper`，超级用户能绕过本方案的全部约束。

SELECT 2 AS section, rolname,
       rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls, rolcanlogin,
       rolconnlimit,
       CASE WHEN rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
            THEN 'FAIL 仍持有特权属性'
            WHEN NOT rolcanlogin
            THEN 'FAIL 不可登录'
            ELSE 'ok' END AS verdict
  FROM pg_roles
 WHERE rolname IN ('chaoge_migrator', 'chaoge_app')
 ORDER BY rolname;

-- 2b. 口令是否已设置 —— **仅布尔值**
DO $pwcheck$
DECLARE
  r record;
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE NOTICE '[2b] 跳过口令检查：读取 pg_authid 需要超级用户（以 % 执行）', current_user;
    RETURN;
  END IF;

  RAISE NOTICE '[2b] password_encryption = %（应为 scram-sha-256）',
    current_setting('password_encryption');

  FOR r IN
    SELECT rolname,
           (rolpassword IS NOT NULL AND rolpassword <> '') AS has_password,
           CASE WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'SCRAM-SHA-256'
                WHEN rolpassword LIKE 'md5%'          THEN 'md5（弱，建议改为 SCRAM）'
                WHEN rolpassword IS NULL OR rolpassword = '' THEN '（空）'
                ELSE 'unknown' END AS verifier_kind
      FROM pg_authid
     WHERE rolname IN ('chaoge_migrator', 'chaoge_app')
     ORDER BY rolname
  LOOP
    -- ⚠️ 只输出 has_password 与算法名，绝不输出 rolpassword 本身
    RAISE NOTICE '[2b] % : 口令已设置 = % ，校验子类型 = %',
      r.rolname, r.has_password, r.verifier_kind;
  END LOOP;
END
$pwcheck$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. 数据库级 ACL（任务要求第 11 条：PUBLIC 是否已收紧）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ `datacl IS NULL` 表示「沿用出厂默认」，而数据库的出厂默认**包含** CONNECT 与 TEMPORARY。
--    所以 NULL 必须判成「PUBLIC 仍可连」，不能当成「没有授权」。
--    这是本节最容易读反的一处，因此把它显式写成一列。

SELECT 3 AS section, 'database ACL' AS check_name,
       d.datname,
       d.datacl IS NULL AS datacl_is_default,
       coalesce((SELECT bool_or(a.privilege_type = 'CONNECT')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)               AS public_can_connect,
       coalesce((SELECT bool_or(a.privilege_type = 'TEMPORARY')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)               AS public_can_temp,
       coalesce((SELECT bool_or(a.privilege_type = 'CREATE')
                   FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                d.datacl IS NULL)               AS public_can_create,
       has_database_privilege('chaoge_migrator', d.datname, 'CONNECT') AS migrator_connect,
       has_database_privilege('chaoge_app',      d.datname, 'CONNECT') AS app_connect
  FROM pg_database d
 WHERE d.datname = current_database();

-- 3b. 数据库上所有非 PUBLIC 的显式授权（看清楚到底给了谁）

SELECT 3 AS section, 'database grants (non-PUBLIC)' AS check_name,
       coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee,
       a.privilege_type,
       pg_get_userbyid(a.grantor) AS grantor
  FROM pg_database d, aclexplode(d.datacl) a
 WHERE d.datname = current_database()
   AND a.grantee <> 0
 ORDER BY 2, 3;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. schema `public` 的属主与 ACL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 期望：属主仍是 `pg_database_owner`（本方案**没有**改属主——改属主会连带
-- 引入 `DROP SCHEMA` 的能力），PUBLIC 既无 USAGE 也无 CREATE，
-- `chaoge_migrator` 有 USAGE + CREATE，`chaoge_app` 只有 USAGE。

SELECT 4 AS section, 'schema public' AS check_name,
       n.nspname,
       pg_get_userbyid(n.nspowner) AS owner,
       coalesce(bool_or(a.privilege_type = 'CREATE') FILTER (WHERE a.grantee = 0), false) AS public_create,
       coalesce(bool_or(a.privilege_type = 'USAGE')  FILTER (WHERE a.grantee = 0), false) AS public_usage,
       has_schema_privilege('chaoge_migrator', 'public', 'USAGE')  AS migrator_usage,
       has_schema_privilege('chaoge_migrator', 'public', 'CREATE') AS migrator_create,
       has_schema_privilege('chaoge_app',      'public', 'USAGE')  AS app_usage,
       has_schema_privilege('chaoge_app',      'public', 'CREATE') AS app_create
  FROM pg_namespace n
  LEFT JOIN aclexplode(n.nspacl) a ON true
 WHERE n.nspname = 'public'
 GROUP BY n.nspname, n.nspowner;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. 默认权限（任务要求第 5 条）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 期望看到 **两行**：`defaclrole = chaoge_migrator`、`defaclnamespace = public`，
-- 分别是 `defaclobjtype = r`（表）与 `S`（序列）。
--
-- ⚠️ `defaclrole` 必须是 **chaoge_migrator**。若这里显示的是 `postgres`，
--    说明 04 执行身份错了——默认权限记在了别人名下，迁移建的表拿不到授权。

SELECT 5 AS section, 'default privileges' AS check_name,
       pg_get_userbyid(d.defaclrole) AS for_creating_role,
       coalesce(n.nspname, '(all schemas)') AS in_schema,
       CASE d.defaclobjtype WHEN 'r' THEN 'TABLE'
                            WHEN 'S' THEN 'SEQUENCE'
                            WHEN 'f' THEN 'FUNCTION'
                            WHEN 'T' THEN 'TYPE'
                            ELSE d.defaclobjtype END AS objtype,
       coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  LEFT JOIN aclexplode(d.defaclacl) a ON true
 GROUP BY d.defaclrole, n.nspname, d.defaclobjtype, a.grantee
 ORDER BY 2, 4, 5;

-- 5b. 存在性汇总 —— 保证「一条默认权限都没有」时**也有输出**。
--
-- 上一节是「展开每一行」，`pg_default_acl` 为空时会返回**零行**；
-- 而零行的输出和「本节没有输出」在终端上长得一样，容易被读成「没什么问题」。
-- 这一节恒定返回一行，把「有没有」和「在谁名下」直接写成数字。

SELECT 5 AS section, 'default privileges (existence)' AS check_name,
       count(*) FILTER (WHERE pg_get_userbyid(d.defaclrole) = 'chaoge_migrator'
                          AND d.defaclnamespace = 'public'::regnamespace
                          AND d.defaclobjtype = 'r')  AS migrator_table_rows,
       count(*) FILTER (WHERE pg_get_userbyid(d.defaclrole) = 'chaoge_migrator'
                          AND d.defaclnamespace = 'public'::regnamespace
                          AND d.defaclobjtype = 'S')  AS migrator_sequence_rows,
       count(*) FILTER (WHERE pg_get_userbyid(d.defaclrole) <> 'chaoge_migrator')
                                                      AS rows_on_wrong_role,
       count(*)                                        AS total_rows
  FROM pg_default_acl d;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. 逐表权限矩阵（任务要求第 4、10 条）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 用 `has_table_privilege()` 取的是**有效**权限（含经由角色成员关系继承的），
-- 而不是这张表自己的那条 ACL —— 应用角色将来被加入某个 group role 时，
-- 只有有效权限能反映真实情况。
--
-- `MAINTAIN` 只在 PG 17+ 存在，按版本分支，避免在老版本上语法报错。

DO $matrix$
DECLARE
  t record;
  maintain_exists boolean;
  n_ok int := 0;
  n_bad int := 0;
BEGIN
  maintain_exists := current_setting('server_version_num')::int >= 170000;

  RAISE NOTICE '[6] 逐表权限矩阵（应用角色 chaoge_app）：';
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     ORDER BY c.relname
  LOOP
    -- 传 oid 而不是拼 'schema.table' 字符串：字符串形式要自己处理标识符引用，
    -- 而 oid 形式不受表名大小写 / 特殊字符影响，也不需要 `quote_ident`。
    DECLARE
      sel  boolean := has_table_privilege('chaoge_app', t.oid, 'SELECT');
      ins  boolean := has_table_privilege('chaoge_app', t.oid, 'INSERT');
      upd  boolean := has_table_privilege('chaoge_app', t.oid, 'UPDATE');
      del  boolean := has_table_privilege('chaoge_app', t.oid, 'DELETE');
      tru  boolean := has_table_privilege('chaoge_app', t.oid, 'TRUNCATE');
      ref  boolean := has_table_privilege('chaoge_app', t.oid, 'REFERENCES');
      trg  boolean := has_table_privilege('chaoge_app', t.oid, 'TRIGGER');
      mnt  boolean := false;
      ok   boolean;
    BEGIN
      IF maintain_exists THEN
        mnt := has_table_privilege('chaoge_app', t.oid, 'MAINTAIN');
      END IF;

      ok := sel AND ins AND upd AND del AND NOT (tru OR ref OR trg OR mnt);
      IF ok THEN n_ok := n_ok + 1; ELSE n_bad := n_bad + 1; END IF;

      RAISE NOTICE '    % % sel=% ins=% upd=% del=% | trunc=% ref=% trig=% maintain=%',
        CASE WHEN ok THEN '[ok]  ' ELSE '[BAD] ' END, t.relname, sel, ins, upd, del, tru, ref, trg, mnt;
    END;
  END LOOP;

  RAISE NOTICE '[6] 小结：% 张表通过，% 张表不通过', n_ok, n_bad;
END
$matrix$;

-- 6b. 序列权限（当前应为空集 —— 本仓库 39 张业务表主键全是 text，没有序列）

SELECT 6 AS section, 'sequence privileges' AS check_name,
       c.relname AS sequence_name,
       has_sequence_privilege('chaoge_app', c.oid, 'USAGE')  AS app_usage,
       has_sequence_privilege('chaoge_app', c.oid, 'SELECT') AS app_select,
       has_sequence_privilege('chaoge_app', c.oid, 'UPDATE') AS app_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY c.relname;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. 违规汇总（把上面所有 FAIL 聚合成一个数字）
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 7 AS section, 'violations' AS check_name,
       (SELECT count(*) FROM pg_roles
         WHERE rolname IN ('chaoge_migrator','chaoge_app')
           AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
                OR rolbypassrls OR NOT rolcanlogin))                       AS role_attr_violations,
       (SELECT count(*) FROM pg_database d
         WHERE d.datname = current_database()
           AND coalesce((SELECT bool_or(a.privilege_type IN ('CONNECT','TEMPORARY','CREATE'))
                           FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                        d.datacl IS NULL))                                 AS public_db_violations,
       (SELECT count(*) FROM pg_namespace n
         WHERE n.nspname = 'public'
           AND coalesce((SELECT bool_or(a.privilege_type IN ('USAGE','CREATE'))
                           FROM aclexplode(n.nspacl) a WHERE a.grantee = 0), false)) AS public_schema_violations,
       (SELECT count(*) FROM pg_default_acl d
         WHERE d.defaclrole IN (SELECT oid FROM pg_roles
                                 WHERE rolname IN ('chaoge_migrator','chaoge_app'))
           AND d.defaclnamespace = 'public'::regnamespace
           AND pg_get_userbyid(d.defaclrole) <> 'chaoge_migrator')          AS default_acl_wrong_role,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
           AND NOT (has_table_privilege('chaoge_app', c.oid, 'SELECT')
                AND has_table_privilege('chaoge_app', c.oid, 'INSERT')
                AND has_table_privilege('chaoge_app', c.oid, 'UPDATE')
                AND has_table_privilege('chaoge_app', c.oid, 'DELETE')))    AS tables_missing_dml,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
           AND (has_table_privilege('chaoge_app', c.oid, 'TRUNCATE')
             OR has_table_privilege('chaoge_app', c.oid, 'REFERENCES')
             OR has_table_privilege('chaoge_app', c.oid, 'TRIGGER')))       AS tables_over_privileged,
       has_schema_privilege('chaoge_app', 'public', 'CREATE')               AS app_can_create_objects,
       has_database_privilege('chaoge_app', current_database(), 'TEMPORARY') AS app_can_create_temp;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. 总体判定
-- ═══════════════════════════════════════════════════════════════════════════

WITH v AS (
  SELECT
    (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('chaoge_migrator','chaoge_app')
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
             OR rolbypassrls OR NOT rolcanlogin))                          AS role_attr,
    (SELECT count(*) FROM pg_roles WHERE rolname IN ('chaoge_migrator','chaoge_app')) AS role_exists,
    (SELECT coalesce((SELECT bool_or(a.privilege_type IN ('CONNECT','TEMPORARY','CREATE'))
                        FROM aclexplode(d.datacl) a WHERE a.grantee = 0),
                     d.datacl IS NULL) FROM pg_database d
      WHERE d.datname = current_database())                                AS public_db,
    (SELECT coalesce((SELECT bool_or(a.privilege_type IN ('USAGE','CREATE'))
                        FROM aclexplode(n.nspacl) a WHERE a.grantee = 0), false)
       FROM pg_namespace n WHERE n.nspname = 'public')                     AS public_schema,
    (SELECT count(*) FROM pg_default_acl d
      WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'chaoge_migrator')
        AND d.defaclnamespace = 'public'::regnamespace
        AND d.defaclobjtype IN ('r','S'))                                  AS default_acl_ok,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND NOT (has_table_privilege('chaoge_app', c.oid, 'SELECT')
             AND has_table_privilege('chaoge_app', c.oid, 'INSERT')
             AND has_table_privilege('chaoge_app', c.oid, 'UPDATE')
             AND has_table_privilege('chaoge_app', c.oid, 'DELETE')))      AS tables_bad_grant,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND (has_table_privilege('chaoge_app', c.oid, 'TRUNCATE')
          OR has_table_privilege('chaoge_app', c.oid, 'REFERENCES')
          OR has_table_privilege('chaoge_app', c.oid, 'TRIGGER')))         AS tables_bad_revoke,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p'))               AS table_count,
    has_schema_privilege('chaoge_app', 'public', 'CREATE')                 AS app_can_create
)
SELECT 8 AS section, 'OVERALL' AS check_name,
       CASE WHEN role_exists = 2
             AND role_attr = 0
             AND NOT public_db
             AND NOT public_schema
             AND default_acl_ok = 2
             AND tables_bad_grant = 0
             AND tables_bad_revoke = 0
             AND NOT app_can_create
            THEN 'PASS'
            ELSE 'FAIL' END AS verdict,
       format('角色 %s/2 · 特权属性违规 %s · 库级外泄 %s · schema 级外泄 %s · 默认权限记录 %s/2 · '
              || '表权限缺失 %s · 表越权 %s · 应用可建对象 %s · public 表数 %s',
              role_exists, role_attr, public_db, public_schema,
              default_acl_ok, tables_bad_grant, tables_bad_revoke, app_can_create, table_count)
         AS detail
  FROM v;
