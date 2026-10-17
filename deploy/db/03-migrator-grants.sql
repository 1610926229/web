-- PROD-2 · 数据库权限初始化 3/5：给两个角色连接权，并给迁移角色建对象的权限
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_prod（由库名守卫强制）
--
-- 前置：02 已经收回了 PUBLIC 的 CONNECT。**本脚本把连接权显式发给两个角色**——
-- 这是 02 → 03 必须按顺序执行的原因（反过来的话，中间那一刻集群里没人能连这个库）。
--
-- ## 本脚本建立的、后面四个步骤依赖的三条事实
--
-- 1. **两个角色都能连 `chaoge_prod`**（02 之后这不再是默认值）；
-- 2. **两个角色都能「看见」schema `public`**（02 收掉了 PUBLIC 的 USAGE）；
-- 3. **只有 `chaoge_migrator` 能在 `public` 里建对象**，`chaoge_app` 不行。
--
-- 第 3 条是本方案最关键的一条分工，值得说清楚它挡的是什么：
--
-- ## 为什么 `CREATE` 只给迁移角色，不给应用角色
--
-- 应用角色若能在 `public` 建表，它就有了一个**绕过全部迁移纪律**的入口：
-- 某段代码随手 `CREATE TABLE IF NOT EXISTS`（本项目在 `tech-stack.md` §11.1 明令禁止），
-- 于是「库处于哪个版本」不再由 `schema_migrations` 单独回答——而那张表正是
-- 迁移运行器用来保证「空库能一路迁到最新」「重跑幂等」「顺序不可篡改」三件事的依据。
--
-- 更直接地说：**应用角色不该有 DDL 能力**。它的职责是读写业务数据；
-- 结构变更的唯一路径是 `pnpm db:migrate`（由 `chaoge_migrator` 执行）。
-- 把这条纪律做成**数据库权限**而不是**代码约定**，是它唯一能被强制的地方——
-- 代码里少写一句注释没人会察觉，少一份 CREATE 权限会当场报错。
--
-- ⚠️ 注意这里的取舍边界：`chaoge_migrator` 拿到的是 `CREATE`（在 `public` 建对象的权利），
--    **不是** `public` schema 的属主。属主还能 `DROP SCHEMA public CASCADE`，
--    而 `CREATE` 只能在自己建的对象上动作。少一个层级，少一类事故。

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

-- ── 1. 数据库级：把 CONNECT 发给两个角色（02 已从 PUBLIC 收回） ────────────────

DO $connect$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO chaoge_migrator, chaoge_app',
    current_database()
  );
  RAISE NOTICE '[03] 已授予 chaoge_migrator / chaoge_app 对 % 的 CONNECT', current_database();
END
$connect$;

-- ── 2. schema 级：USAGE 给两个角色，CREATE 只给迁移角色 ────────────────────────
--
-- USAGE 是「能按名字找到对象」的权利。两个角色都需要：应用要按名字查表，
-- 迁移角色要按名字建表（以及读写 `schema_migrations`）。
--
-- 明确**不**执行 `GRANT ALL ON SCHEMA public`——那个 `ALL` 会连带给出 CREATE，
-- 且未来 PostgreSQL 若给 schema 增加新权限位，`ALL` 会自动带上。
-- 逐项列出虽然长一点，但「给了什么」在文本上是**可数的**。

GRANT USAGE  ON SCHEMA public TO chaoge_migrator, chaoge_app;
GRANT CREATE ON SCHEMA public TO chaoge_migrator;

-- ── 3. 收敛：显式收回 chaoge_app 可能残留的对象管理能力 ────────────────────────
--
-- 上面「不授予」已经保证了干净的新建状态；这一段负责**修复存量**。
-- 差别在于：如果本库之前被人手工给过 `chaoge_app` 建表权，只靠「这次不授予」
-- 是**发现不了**的——脚本会正常通过，而应用仍然持有 DDL 能力。
-- 显式 REVOKE 让「应用没有 DDL 能力」这件事从「本次没给」变成「此刻确定没有」。
--
-- ⚠️ `REVOKE` 一个本来就没有的权限不报错，只打一条
--    「no privileges could be revoked」的 WARNING —— 这是预期输出，不是失败。
--
-- ⚠️ 这两条**只能由 postgres（超级用户）执行**：schema 属主是 `pg_database_owner`，
--    `chaoge_migrator` 手上只有 CREATE、不是属主，也没有「授予 CREATE 的授权者」身份，
--    因此它 REVOKE 不了这条权限。05 里同理不要再写一遍——写在那里必然失败。
--    这也正是 03 与 05 的身份分工：**schema 级归 03，表级归 05**。

DO $revoke_residue$
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM chaoge_app',
    current_database()
  );
  RAISE NOTICE '[03] 已收敛：chaoge_app 在 % 上无 CREATE / TEMPORARY', current_database();
END
$revoke_residue$;

REVOKE CREATE ON SCHEMA public FROM chaoge_app;

-- ── 4. 自检：三条事实逐条验证 ─────────────────────────────────────────────────
--
-- 这一段直接调用 `has_database_privilege` / `has_schema_privilege`，因为这里的对象
-- 是**角色**（不是 PUBLIC），两个函数正是为这个用法设计的。
-- 断言里同时包含**正例**（迁移角色必须有 CREATE）与**反例**（应用角色必须没有）——
-- 只验正例的话，「权限发给了所有人」这种情况会被判成通过。

DO $assert$
BEGIN
  IF NOT has_database_privilege('chaoge_migrator', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'chaoge_migrator 不能连接 %。', current_database();
  END IF;
  IF NOT has_database_privilege('chaoge_app', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'chaoge_app 不能连接 %。', current_database();
  END IF;
  IF has_database_privilege('chaoge_app', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'chaoge_app 能在 % 上建临时表 —— 应用不需要这个能力。', current_database();
  END IF;
  IF has_database_privilege('chaoge_app', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'chaoge_app 能在 % 上建 schema —— 应用不需要这个能力。', current_database();
  END IF;

  IF NOT has_schema_privilege('chaoge_migrator', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'chaoge_migrator 在 public 上没有 USAGE。';
  END IF;
  IF NOT has_schema_privilege('chaoge_migrator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'chaoge_migrator 在 public 上没有 CREATE —— 迁移会在第一条 CREATE TABLE 处失败。';
  END IF;

  IF NOT has_schema_privilege('chaoge_app', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'chaoge_app 在 public 上没有 USAGE —— 应用按名字找不到任何表。';
  END IF;
  IF has_schema_privilege('chaoge_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION
      'chaoge_app 竟然能在 public 上建对象 —— 应用角色必须没有 DDL 能力，拒绝继续。';
  END IF;

  RAISE NOTICE '[03] 自检通过：连接权已发；CREATE 只在 chaoge_migrator 手上';
END
$assert$;
