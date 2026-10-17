-- PROD-2 · 数据库权限初始化 1/5：创建（或收敛）两个角色
--
--     [执行角色] postgres（超级用户）
--     [目标数据库] chaoge_prod（由下方的库名守卫强制）
--
-- ## 本脚本**不设置任何密码**（这是刻意的，不是遗漏）
--
-- 「创建角色」「设置密码」「授予权限」是三件职责不同的事，被拆成三个脚本：
--
-- | 脚本 | 是否需要机密 | 谁执行 |
-- |---|---|---|
-- | 本脚本（01） | **否** —— 全文没有一处口令 | postgres |
-- | 设置密码（见 README §4 第 3 步） | **是** —— 用 `\password` 交互输入 | postgres |
-- | 授权（02 / 03 / 04 / 05） | **否** | postgres，之后只需 chaoge_migrator |
--
-- 拆开的好处是：**这个文件可以安全地进 Git**。它落在仓库里、被 review、被 diff，
-- 都不会带出一个口令字节。设置密码那一步走 psql 的 `\password` 内建命令——
-- 它由客户端两次提示输入、不回显、**不经过命令行参数、不进 shell 历史、不进 psql 历史**，
-- 而且服务端收到的是客户端算好的 SCRAM 验证器，明文口令不出本机。
-- 因此「口令进脚本 / 进 Git / 进 CLI 参数 / 进日志」这四条路在这个方案里**一条都不存在**。
--
-- ## 为什么创建之后紧跟一组 ALTER ROLE
--
-- 因为「不存在就创建、存在就跳过」这句话只保证**幂等**，不保证**收敛**。
-- 若有人早先把 `chaoge_migrator` 建成了 SUPERUSER，一个只做「存在就跳过」的脚本
-- 会安安静静地放行，而后面的授权全部建立在一个超级用户之上——那是最坏的一种
-- 「脚本跑成功了」。所以创建之后无条件把属性**收敛到最小权限**：
-- 这是一个幂等的、只会往安全方向走的动作。
--
-- ## 为什么数据库守卫是必需的
--
-- 角色是**集群级**对象，不属于任何一个数据库；本脚本一旦连错库，仍会改动整个集群。
-- 因此每个脚本开头都有一道库名守卫（见下方 $guard$）：连到非目标库时**直接抛错**，
-- 而不是「做完才发现」。这也满足本轮「确保不会误操作其他数据库」的要求。
-- 本地隔离验证时，先 `SET chaoge.expected_database = '<本地库名>';` 即可放行。

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

-- ── 1. 创建（不存在时） ────────────────────────────────────────────────────────
--
-- 两个角色都只给 LOGIN。SUPERUSER / CREATEDB / CREATEROLE 在下面的 ALTER 里被显式关掉。
--
-- ⚠️ 这里用 EXECUTE 而不是直接写 CREATE ROLE：DDL 在 PL/pgSQL 里走 EXECUTE 是
--    唯一没有歧义的写法（直接写会在部分语句上撞上语法限制）。
--    两个分支都 RAISE NOTICE：**「建了」与「本来就有」必须在输出里能分辨**，
--    否则重跑时无法判断脚本到底做了什么。

DO $create$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaoge_migrator') THEN
    EXECUTE 'CREATE ROLE chaoge_migrator LOGIN';
    RAISE NOTICE '[01] 已创建角色 chaoge_migrator（未设置密码）';
  ELSE
    RAISE NOTICE '[01] 角色 chaoge_migrator 已存在，跳过创建';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaoge_app') THEN
    EXECUTE 'CREATE ROLE chaoge_app LOGIN';
    RAISE NOTICE '[01] 已创建角色 chaoge_app（未设置密码）';
  ELSE
    RAISE NOTICE '[01] 角色 chaoge_app 已存在，跳过创建（**不修改其密码**）';
  END IF;
END
$create$;

-- ── 2. 收敛属性（无论本次是否新建，无条件执行） ────────────────────────────────
--
-- 只写「安全方向」的属性：NOLOGIN 不写（两者都必须是可登录角色），密码不碰。
--
-- | 属性 | 值 | 为什么 |
-- |---|---|---|
-- | SUPERUSER | NO | 超级用户能绕过一切权限检查——一个超级用户应用账号会让本方案全部失效 |
-- | CREATEDB | NO | 应用与迁移都不得创建数据库；`chaoge_prod` 是本方案**唯一**的目标库 |
-- | CREATEROLE | NO | 否则被攻破的应用可以自造一个超级用户，权限收敛形同虚设 |
-- | REPLICATION | NO | 与业务无关的能力，一律关掉 |
-- | BYPASSRLS | NO | 本库没有 RLS 策略，但这个属性是绕过手段，默认关 |
--
-- ⚠️ 这里**刻意不设** `CONNECTION LIMIT`：它是个真实存在的加固手段，但它同时是一条
--    「将来把 `PG_POOL_MAX` 调大就会突然连不上」的暗雷。见 README「可选加固」一节。

ALTER ROLE chaoge_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;
ALTER ROLE chaoge_app      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;

-- ── 3. 自检：属性确实是收敛后的值 ──────────────────────────────────────────────
--
-- 收敛动作之后立刻验一次。ALTER ROLE 的作用是确定的，但「确定」和「已验证」是两件事；
-- 这一段让脚本在**属性没落到位**时当场失败，而不是留给后面某个环节去发现。

DO $assert$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
      FROM pg_roles
     WHERE rolname IN ('chaoge_migrator', 'chaoge_app')
     ORDER BY rolname
  LOOP
    IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION
        '角色 % 仍带有特权属性（super=% createdb=% createrole=% replication=% bypassrls=%），拒绝继续。',
        r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls;
    END IF;
    IF NOT r.rolcanlogin THEN
      RAISE EXCEPTION '角色 % 不是可登录角色（rolcanlogin=false），应用与迁移都无法连接。', r.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('chaoge_migrator','chaoge_app')) <> 2 THEN
    RAISE EXCEPTION '两个角色未能同时就位，拒绝继续。';
  END IF;

  RAISE NOTICE '[01] 自检通过：chaoge_migrator / chaoge_app 均为最小权限可登录角色';
END
$assert$;
