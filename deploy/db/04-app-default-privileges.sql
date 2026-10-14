-- PROD-2 · 数据库权限初始化 4/5：为**将来**由迁移创建的表与序列预置授权
--
--     [执行角色] chaoge_migrator  ← 不是 postgres，见下
--     [目标数据库] chaoge_prod（由库名守卫强制）
--     [执行时机] **必须在第一次 `pnpm db:migrate` 之前**
--
-- ## 为什么这个脚本必须由 chaoge_migrator 执行（本方案最容易踩的一处）
--
-- `ALTER DEFAULT PRIVILEGES` 的语义是「**今后由某个角色创建的**对象，自动带上这份授权」，
-- 而它记录在 `pg_default_acl` 里的键是 **`defaclrole` = 执行这条命令的角色**。
--
-- 于是有一个非常安静的失败模式：
--
-- | 用什么身份跑 04 | `pg_default_acl.defaclrole` | 实际效果 |
-- |---|---|---|
-- | `postgres` | postgres | 迁移将来是 chaoge_migrator 建的 → **一条都不生效**，但脚本「成功」 |
-- | `chaoge_migrator` | chaoge_migrator | 迁移建的每一张表自动带上授权 ✅ |
--
-- 第一种情况下 04 会打出一串「已设置默认权限」，`99-verify.sql` 也会显示默认权限存在——
-- 但它是给 **postgres 将来建的**表准备的，而 postgres **不会**建这些表。
-- 事后要发现它，只能等到 `chaoge_app` 查询报 `permission denied for table orders`。
--
-- 所以本脚本**第一件事是断言 `current_user = 'chaoge_migrator'`**，不满足就当场失败，
-- 而不是留下一份看起来正确的默认权限。超级用户可以用 `SET ROLE chaoge_migrator` 进来
-- （超级用户对任何角色都能 `SET ROLE`，无需先 GRANT 成员关系）。
--
-- ## 为什么必须在迁移之前跑
--
-- 默认权限**只管将来**。0001～0016 里有 39 张已经写好但尚未执行的业务表——
-- 只要 04 在 `db:migrate` 之前跑完，这 39 张表就是「将来的表」，会全部自动带上授权，
-- 之后的 `05-app-table-grants.sql` 就只是在**复核**（并在有人新增迁移时继续兜底）。
-- 两者都保留的原因见 05 的文件头：默认权限是**预防**，显式授权是**收敛**。
--
-- ## 为什么是这四个权限，而不是 `ALL`
--
-- | 权限 | 给 | 为什么 |
-- |---|---|---|
-- | SELECT | ✅ | 读业务数据 |
-- | INSERT | ✅ | 下单、写日志 |
-- | UPDATE | ✅ | 状态流转、改派、结算 |
-- | DELETE | ✅ | 需要区分「软删」与「硬删」；本仓库仓储层的删除是真实 DELETE |
-- | TRUNCATE | ❌ | **一条 SQL 清空整表**，应用在任何场景下都不该有这个能力 |
-- | REFERENCES | ❌ | 建外键约束＝DDL 能力；应用角色不得有 |
-- | TRIGGER | ❌ | 建触发器＝在别人的写入路径上挂代码；应用角色不得有 |
-- | MAINTAIN | ❌ | PG 17 新增（VACUUM / ANALYZE / REINDEX / CLUSTER 等维护动作）；属运维，不属应用 |
--
-- 换言之：**DML 全给，DDL 一个不给**。`GRANT ALL` 会把后面四项一起带出去，
-- 所以这里逐项列出——`ALL` 的语义还会随 PostgreSQL 版本增长（MAINTAIN 就是 17 才出现的），
-- 而逐项列表的语义永远等于它字面上写的那几个词。
--
-- 序列同理：`USAGE`（`nextval`/`currval`）与 `SELECT`（读 `last_value`）是自增列所必需，
-- 而 `UPDATE` 允许 `setval` 把序列拨到任意值——应用不需要，也就没给。
-- ⚠️ 现状：0001～0016 的 39 张业务表主键全是 `text COLLATE "C"`，**当前一个序列都没有**。
--    这段是为「将来某次迁移引入自增列」预留的，属于**超前防护**而非现状修复。

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

-- ── 0. 身份守卫：本脚本只允许由 chaoge_migrator 执行 ──────────────────────────
--
-- 这道守卫是本脚本存在的**全部前提**：换一个身份执行，下面两条语句语法完全正确、
-- 执行完全成功、结果完全无用。断言放在最前面，代价是脚本多五行，收益是消除一个
-- 「绿色但无效」的状态。

DO $identity$
BEGIN
  IF current_user IS DISTINCT FROM 'chaoge_migrator' THEN
    RAISE EXCEPTION
      '拒绝执行：本脚本必须以 chaoge_migrator 身份运行（当前为「%」）。',
      current_user
      USING ERRCODE = '42501',
            HINT = '超级用户请先执行 SET ROLE chaoge_migrator; 再运行本脚本。'
                   '换身份执行会让默认权限记在错误的角色名下，导致迁移建的表拿不到授权。';
  END IF;
END
$identity$;

-- ── 1. 表：给 chaoge_app 预置 SELECT / INSERT / UPDATE / DELETE ────────────────
--
-- 不带 `FOR ROLE` 子句＝作用于「当前角色（已由上面的守卫保证是 chaoge_migrator）」。
-- 这不是省略，是刻意：`FOR ROLE` 写死角色名反而会让「守卫保证了什么」变得含糊。

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chaoge_app;

-- ── 2. 序列：给 chaoge_app 预置 USAGE / SELECT ────────────────────────────────

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chaoge_app;

-- ── 3. 自检：默认权限确实记在 chaoge_migrator 名下，且内容不多不少 ─────────────
--
-- ⚠️ 这里同时验**四件事**，缺一不可：
--    ① `defaclrole` 是 chaoge_migrator（防止记错角色——本脚本要防的正是这件事）；
--    ② grantee 是 chaoge_app（防止授权发给别人）；
--    ③ 四个 DML 权限**都在**（防止漏发，漏发的后果是迁移之后应用全线 42501）；
--    ④ 四个 DDL/维护权限**都不在**（防止多发给多了——只验 ③ 会漏掉这类问题）。
--
-- `pg_default_acl` 对所有人可读，所以 `SET ROLE` 之后仍读得到。

DO $assert$
DECLARE
  migrator_oid oid;
  app_oid      oid;
  acl_row      aclitem[];
BEGIN
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'chaoge_migrator';
  SELECT oid INTO app_oid      FROM pg_roles WHERE rolname = 'chaoge_app';

  IF migrator_oid IS NULL OR app_oid IS NULL THEN
    RAISE EXCEPTION '角色缺失：请先执行 01-create-roles.sql。';
  END IF;

  -- ── ① 记录存在，且记在 chaoge_migrator 名下 ──
  --
  -- 单列查、不用 LEFT JOIN：这里问的是「有没有这条记录」，
  -- 而「这条记录里有什么」是下一段的事。混在一个查询里写，
  -- 「行不存在」和「行存在但 grantee 不匹配」会得到同样的聚合结果，分不清。
  SELECT d.defaclacl INTO acl_row
    FROM pg_default_acl d
   WHERE d.defaclrole     = migrator_oid
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype   = 'r';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '未找到 chaoge_migrator 在 public 上的表默认权限记录 —— 04 没有生效，或记到了别的角色名下。';
  END IF;

  -- ── ② 表的授权内容：四项 DML 齐全，且没有 TRUNCATE / REFERENCES / TRIGGER ──
  --
  -- `aclexplode()` 把 aclitem[] 展开成 (grantor, grantee, privilege_type, is_grantable)。
  -- 它比 `has_table_privilege()` 更适合这里：那是**表**上的函数，读不到默认权限，
  -- 而且 PG 18 之前不认识 MAINTAIN 之类的名字。按 privilege_type 做文本比较，
  -- 版本无关，且「多给了什么」会原样出现在错误信息里。
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
        '表默认权限不全（select=% insert=% update=% delete=%），迁移后 chaoge_app 会大面积 permission denied。',
        tbl_sel, tbl_ins, tbl_upd, tbl_del;
    END IF;
    IF array_length(tbl_bad, 1) > 0 THEN
      RAISE EXCEPTION '表默认权限里多出了不该给的权限：%', array_to_string(tbl_bad, ', ');
    END IF;
  END;

  -- ── ③ 序列（defaclobjtype = 'S'）：USAGE + SELECT，且没有 UPDATE(setval) ──

  SELECT d.defaclacl INTO acl_row
    FROM pg_default_acl d
   WHERE d.defaclrole     = migrator_oid
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype   = 'S';

  IF NOT FOUND THEN
    RAISE EXCEPTION '未找到 chaoge_migrator 在 public 上的序列默认权限记录 —— 04 没有生效。';
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

  RAISE NOTICE '[04] 自检通过：chaoge_app 的默认权限记在 chaoge_migrator 名下（表 4 项 DML / 序列 2 项）';
END
$assert$;
