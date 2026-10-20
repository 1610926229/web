# 04 · 验收与人工操作清单

Round: PROD-7
Status: **PARTIAL**
- Staging 安全修复部署与自动/浏览器验收：**PASS**
- 生产只读审计：**BLOCKED（需要 root / postgres 权限）**
- 生产初始化与 Nginx 切换：**NOT EXECUTED（需人工批准）**

Deployed release: `20261020T132016Z-3768cb5`
App Git SHA: `3768cb5f5036e68ac7137a8d454ee0db594daf84`
Artifact SHA-256: `648729c9fd78ff82c2a2d3724e6f4ff0b616dd175d01fe737a654829644701c4`

---

## A. Staging 安全修复验收（已完成）

- [x] GitHub / 本地 / 服务器 SHA 关系核对完成
- [x] root 信任清单检查：无需更新；未绕过
- [x] 产物上传、`check-artifact`、受控 `deploy` 成功
- [x] release `20261020T132016Z-3768cb5`，`enabled/active`
- [x] 仅监听 `127.0.0.1:3000`
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（2454 / 1988 pass / 0 fail / 466 skipped）
- [x] 伪造 `mock_admin_id` / `mock_staff_id` / `mock_user_id` 在公网路径均无法获得权限
- [x] 私有路径 Mock 能力未受影响（对照 200）
- [x] 伪造 XFF 第一段 / X-Real-IP 无法绕过 IP 限流；第 21 次 429
- [x] 身份维度限流独立生效（第 6 次 429）
- [x] Edge 真实浏览器 25/25 通过（登录、退出、Cookie 属性、Mock 拒绝、公网只读）
- [x] 公网 `http://43.128.13.181` 仍匿名只读；登录 / 管理 / 客服 / Mock / 调试路径 404
- [x] `chaoge_staging` 未删除、未重置、未清空
- [x] `chaoge_prod` 未读取、未写入
- [ ] 客服真实账号登录（`kefu-xiaoyu` 口令仍 401；未重置）

---

## B. 生产只读审计（需要人工执行）

本轮以 `deploy` 账号尝试时被拒绝：

```
/etc/chaoge                  Permission denied
/var/backups/chaoge          Permission denied
~/.pgpass                    不存在
peer role "deploy"           不存在
postgres / chaoge_staging_migrator   需要口令
sudo -n -l                   仅 chaoge-deploy 一条 NOPASSWD
```

**请由具备 root / postgres 权限的人员执行以下只读命令**（不写库、不输出任何口令）：

### B1. 集群与数据库

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
SELECT datname,
       pg_size_pretty(pg_database_size(datname)) AS size,
       datallowconn, datconnlimit
  FROM pg_database
 WHERE datname LIKE 'chaoge%'
 ORDER BY datname;
SQL
```

### B2. 角色属性与成员关系

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls, rolcanlogin, rolconnlimit
  FROM pg_roles
 WHERE rolname LIKE 'chaoge%'
 ORDER BY rolname;

SELECT member.rolname AS member, parent.rolname AS member_of
  FROM pg_auth_members am
  JOIN pg_roles member ON member.oid = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE member.rolname LIKE 'chaoge%' OR parent.rolname LIKE 'chaoge%';
SQL
```

### B3. `chaoge_prod` 迁移版本、表数量与数据量

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d chaoge_prod <<'SQL'
\pset pager off

SELECT to_regclass('public.schema_migrations') AS has_migrations;
SELECT version, applied_at
  FROM schema_migrations
 ORDER BY version;

SELECT count(*) AS tables_in_public
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p');

DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','orders','payments','coupons','companions',
    'products','product_specs','admin_accounts','staff_accounts','auth_sessions'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '%: missing', t;
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      RAISE NOTICE '%: % rows', t, n;
    END IF;
  END LOOP;
END $$;
SQL
```

### B4. 生产权限验收（只读）

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d chaoge_prod \
  -f deploy/db/99-verify.sql
```

### B5. 交叉隔离（应全部为 false / 0）

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
SELECT has_database_privilege('chaoge_staging_app','chaoge_prod','CONNECT')   AS staging_app_can_connect_prod,
       has_database_privilege('chaoge_staging_migrator','chaoge_prod','CONNECT') AS staging_migrator_can_connect_prod,
       has_database_privilege('chaoge_app','chaoge_staging','CONNECT')        AS prod_app_can_connect_staging,
       has_database_privilege('chaoge_migrator','chaoge_staging','CONNECT')   AS prod_migrator_can_connect_staging;

SELECT count(*) AS cross_memberships
  FROM pg_auth_members am
  JOIN pg_roles member ON member.oid = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE (member.rolname LIKE 'chaoge_staging_%' AND parent.rolname IN ('chaoge_app','chaoge_migrator'))
    OR (member.rolname IN ('chaoge_app','chaoge_migrator') AND parent.rolname LIKE 'chaoge_staging_%');
SQL
```

### B6. 安全组 / 公网端口（腾讯云控制台人工复核）

- [ ] 入站仅 80（以及获批后的 443）、SSH 来源受限；
- [ ] **3000 / 3001 / 5432 未对公网开放**；
- [ ] 出站与 SSH 配置未被本轮修改。

> 开发机的原始端口探测受到本地网络拦截（任意端口都能瞬间握手），不能作为安全组证据；请以云控制台和服务器 `ss -ltn` 为准。

---

## C. 生产上线前人工批准清单

- [ ] 提供 B1–B6 的只读审计结果
- [ ] 批准新建 `chaoge-prod` 用户、目录、systemd、`prod.env`、生产部署入口与 sudoers 规则
- [ ] 批准 `chaoge_prod` 初始化：建库/角色/授权/18 个迁移/备份目录
- [ ] 确认 `platform_config` 四个业务参数（派单专属池、公共池、自动完成、投诉窗口）
- [ ] 确认生产目录/内容来源（Staging 审核复制或后台录入）
- [ ] 确认初始管理员身份与口令输入方式（终端交互，不写入 Git/日志）
- [ ] 提供域名与 A 记录；批准安全组 443、certbot、新 Nginx 站点
- [ ] 批准生产 CI workflow 与 GitHub Environment reviewer
- [ ] 提供有效客服口令，或批准新建测试客服账号
- [ ] 明确批准「执行生产数据库初始化」「首次生产部署」「公网切换」三个动作（逐项）

---

## D. 结论

| 交付面 | 状态 |
|---|---|
| Staging 安全修复部署 | **DONE** |
| Mock 身份冒充 / 限流 IP 修复验证 | **PASS** |
| 真实浏览器验收 | **PASS（25/25）** |
| 公网匿名只读边界 | **PASS（HTTP 层）** |
| 生产隔离方案 | **READY（待审阅）** |
| 生产只读审计 | **BLOCKED（权限）** |
| 生产初始化 / Nginx 切换 | **NOT EXECUTED（待批准）** |
