-- PROD-2 · 数据库权限初始化 5/5：把 `public` 里**已存在的**表与序列授权给应用角色
--
--     [执行角色] chaoge_migrator
--     [目标数据库] chaoge_prod（由库名守卫强制）
--     [执行时机] **迁移前后各跑一次**（迁移前是空跑，迁移后是真正的授权）
--
-- ## 04 与 05 的分工：一个是「预防」，一个是「收敛」
--
-- | 脚本 | 管的对象 | 机制 | 失效场景 |
-- |---|---|---|---|
-- | 04 默认权限 | **将来**由 chaoge_migrator 创建的表/序列 | `pg_default_acl` | 换身份执行 → 记错角色名下 |
-- | 05 显式授权 | **此刻已经存在**的表/序列 | 直接写进各对象的 ACL | 有人手工 `REVOKE` → 要重跑才恢复 |
--
-- 两者**互相不可替代**：
--
-- - 只有 04：任何绕过迁移创建的表（将来某次人工建表、或某次迁移换了角色执行）都拿不到授权。
-- - 只有 05：每次新增迁移都得记得重跑一遍；忘记的后果是**该次新增的表应用读不到**，
--   而且要到线上发出 `permission denied` 才会发现。
--
-- 一起用的时候，04 让新表**默认就是对的**，05 让「现在到底对不对」**可以被验证**。
-- `99-verify.sql` 验的是 05 的结果（对象的实际 ACL），`04` 的结果另有一段专门验。
--
-- ## 为什么这一步必须是幂等的（而不只是「再跑一次也没事」）
--
-- 05 在部署流程里出现在**两个位置**：迁移前、迁移后。第二次执行时，
-- 第一次授予的权限已经在了。`GRANT` 重复授予同一权限不报错（它是「使之为真」而非「追加」），
-- `REVOKE` 不存在的权限只打 WARNING——所以两条路径都是幂等的，
-- 这**不需要**额外的「先查再决定」逻辑。少一层分支就少一处会写反的地方。
--
-- ## 为什么这里不再处理 schema 级权限
--
-- `REVOKE CREATE ON SCHEMA public FROM chaoge_app` 在这里**必然失败**：
-- `public` 的属主是 `pg_database_owner`，`chaoge_migrator` 既不是属主、
-- 也不是那条授权的授予者，无权收回。schema 级收敛统一放在 `03`（由 postgres 执行）。
-- 表级归 05，schema 级归 03——按**谁能执行**划分，而不是按「看起来是一类事」划分。
--
-- ⚠️ 关于 `ALL TABLES IN SCHEMA`：它只展开**当前**存在的表。迁移之后新增的表
--    不在这次展开里——那部分由 04 的默认权限兜住。这就是两个脚本要成对存在的原因。

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

-- ── 0. 身份守卫：必须是 chaoge_migrator ───────────────────────────────────────
--
-- 与 04 同理，但原因不同：这里不是「记错角色」的问题，而是 **GRANT 的权限来源**问题。
-- `GRANT` 要求执行者**拥有该对象**或持有授权选项。表是 chaoge_migrator 建的，
-- 所以只有它（以及超级用户）能把这些表授出去。以 postgres 身份跑也能成功，
-- 但那会让 ACL 里的 `grantor` 变成 postgres——记录上就看不出「这张表的授权
-- 是跟着迁移角色走的」，运维排查时多一层无从解释的间接。

DO $identity$
BEGIN
  IF current_user IS DISTINCT FROM 'chaoge_migrator' THEN
    RAISE EXCEPTION
      '拒绝执行：本脚本必须以 chaoge_migrator 身份运行（当前为「%」）。',
      current_user
      USING ERRCODE = '42501',
            HINT = '超级用户请先执行 SET ROLE chaoge_migrator; 再运行本脚本。';
  END IF;
END
$identity$;

-- ── 1. 表：授予四项 DML ───────────────────────────────────────────────────────
--
-- 迁移前执行时 `public` 里一张表都没有（或只有 `schema_migrations`），
-- `ALL TABLES` 展开为空集——**这是正常的空跑，不是错误**。
-- 脚本不对此设断言：若在迁移前把「必须至少有一张表」写成硬断言，
-- 部署流程就被迫改变顺序，而改变顺序意味着「空库先跑 05」这条路径再也没有人走过了。

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chaoge_app;

-- ── 2. 表：收回不该有的权限（收敛存量） ───────────────────────────────────────
--
-- `TRUNCATE` 值得单独说：它是**权限模型里后果最重的一条**——一条语句清空整表，
-- 且**不触发行级触发器**。应用在任何业务场景下都不需要它。
--
-- `MAINTAIN`（PG 17+：VACUUM / ANALYZE / REINDEX / CLUSTER / REFRESH MATVIEW）
-- 需要按版本分支：PG 16 及以前不认识这个词，直接写会**语法报错**。
-- 目标环境与本地都是 PG 18，但这段脚本没有理由因此变成「只能在 17+ 跑」。

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM chaoge_app;

DO $revoke_maintain$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM chaoge_app';
  ELSE
    RAISE NOTICE '[05] 服务端 % < 17，跳过 MAINTAIN 收敛（该权限位不存在）',
      current_setting('server_version');
  END IF;
END
$revoke_maintain$;

-- ── 3. 序列：授予 USAGE / SELECT，收回 UPDATE ─────────────────────────────────

GRANT  USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chaoge_app;
REVOKE UPDATE           ON ALL SEQUENCES IN SCHEMA public FROM chaoge_app;

-- ── 4. 自检：逐表核对，而不是抽样 ─────────────────────────────────────────────
--
-- 这一段遍历 `pg_class` 里 `public` 下的每一张表（含分区表 `p`），
-- 对**每一张**表检查六个权限位。**不是抽样**——抽样在只有 3 张表的测试库上会通过，
-- 在 40 张表的生产库上可能恰好漏掉出问题的那一张。
--
-- 用 `has_table_privilege()` 而不是展开 ACL：这里问的是「**有效**权限」
-- （含通过角色成员关系继承来的），而 `aclexplode` 只看这张表自己那一条 ACL。
-- 应用角色将来若被加入某个 group role，`aclexplode` 会漏判。
-- 反过来 04 里用 `aclexplode` 是因为它读的是 `pg_default_acl`——那里没有对应的
-- `has_*_privilege` 函数可用，只能展开。
--
-- ⚠️ `has_table_privilege` 在**表不存在**时会报错，所以必须由查询驱动（逐行传入 oid），
--    不能对着一张空表列表调用。

DO $assert$
DECLARE
  t               record;
  bad_grants      text[] := '{}';
  bad_revokes     text[] := '{}';
  table_count     int    := 0;
  maintain_exists boolean;
BEGIN
  maintain_exists := current_setting('server_version_num')::int >= 170000;

  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')          -- 普通表 / 分区表
     ORDER BY c.relname
  LOOP
    table_count := table_count + 1;

    -- 该有的（缺一即应用功能不全）
    IF NOT has_table_privilege('chaoge_app', t.oid, 'SELECT') THEN
      bad_grants := bad_grants || format('%s 缺 SELECT', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_app', t.oid, 'INSERT') THEN
      bad_grants := bad_grants || format('%s 缺 INSERT', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_app', t.oid, 'UPDATE') THEN
      bad_grants := bad_grants || format('%s 缺 UPDATE', t.relname);
    END IF;
    IF NOT has_table_privilege('chaoge_app', t.oid, 'DELETE') THEN
      bad_grants := bad_grants || format('%s 缺 DELETE', t.relname);
    END IF;

    -- 不该有的（多一项即越权）
    IF has_table_privilege('chaoge_app', t.oid, 'TRUNCATE') THEN
      bad_revokes := bad_revokes || format('%s 多 TRUNCATE', t.relname);
    END IF;
    IF has_table_privilege('chaoge_app', t.oid, 'REFERENCES') THEN
      bad_revokes := bad_revokes || format('%s 多 REFERENCES', t.relname);
    END IF;
    IF has_table_privilege('chaoge_app', t.oid, 'TRIGGER') THEN
      bad_revokes := bad_revokes || format('%s 多 TRIGGER', t.relname);
    END IF;
    IF maintain_exists AND has_table_privilege('chaoge_app', t.oid, 'MAINTAIN') THEN
      bad_revokes := bad_revokes || format('%s 多 MAINTAIN', t.relname);
    END IF;
  END LOOP;

  IF array_length(bad_grants, 1) > 0 THEN
    RAISE EXCEPTION '授权不全（% 张表）：%', table_count, array_to_string(bad_grants, '；');
  END IF;
  IF array_length(bad_revokes, 1) > 0 THEN
    RAISE EXCEPTION '存在越权（% 张表）：%', table_count, array_to_string(bad_revokes, '；');
  END IF;

  RAISE NOTICE '[05] 自检通过：% 张表逐张核对，四项 DML 齐全、四项管理权限均无', table_count;
END
$assert$;
