# Staging 独立数据库部署（PROD-2 / Step 5.8.2）

Staging 使用**独立的** `chaoge_staging` 数据库与**独立的**两个角色，
与 `chaoge_prod` 共享同一个 PostgreSQL 18 实例，但权限、默认权限、表属主完全隔离。

生产侧的脚本（`deploy/db/01…05`、`99-verify.sql`、`deploy.sh`）**一个字都没有改**，
本目录也不会调用它们。两套脚本的对照关系见 §8。

---

## 0. 一个入口，六个阶段

所有动作都走 `deploy/db/staging/deploy-staging.sh`：

```bash
sudo deploy/db/staging/deploy-staging.sh check      # 只读预检
sudo deploy/db/staging/deploy-staging.sh create     # 建库（一次性，需确认）
sudo deploy/db/staging/deploy-staging.sh init       # 01→05 权限，单事务（需确认）
sudo deploy/db/staging/deploy-staging.sh migrate    # 迁移 + 重跑 05 授权（需确认）
sudo deploy/db/staging/deploy-staging.sh bootstrap  # 最小测试数据（需确认；只插入）
sudo deploy/db/staging/deploy-staging.sh verify     # 只读验收，输出 PASS / FAIL
```

与生产入口的关键区别：

| | 生产 `deploy/db/deploy.sh` | Staging `staging/deploy-staging.sh` |
|---|---|---|
| 目标库 | 默认 `chaoge_prod` | 默认 `chaoge_staging`；**只允许 `chaoge_staging*`** |
| 角色 | `chaoge_migrator` / `chaoge_app` | `chaoge_staging_migrator` / `chaoge_staging_app` |
| `migrate` | 不提供，只打印命令 | **提供**（staging 迁移无需等生产审批） |
| `bootstrap` | 不提供（生产数据只能走业务/审批流程） | **提供**（只插入最小测试数据） |
| `db:seed` / `db:reset` | 不提供 | 不提供，且不接受这两个词作为阶段名 |
| `--self-test` | 无 | 只允许 `chaoge_staging*_test`，跳过交互确认 |

> ⚠️ **`migrate` 与 `bootstrap` 只对 staging 提供**，因为它们的对象是
> `chaoge_staging*`。生产脚本的「迁移必须人工审批」这条纪律原样保留：
> 本目录的任何命令都无法作用在 `chaoge_prod` 上（见 §4）。

---

## 1. 文件清单

### SQL

| 文件 | 执行角色 | 作用 | 幂等 |
|---|---|---|---|
| `01-create-roles.sql` | `postgres` | 创建/收敛两个 staging 角色，**不设口令** | ✅ |
| `02-harden-public.sql` | `postgres` | 收回 PUBLIC 的库级/schema 级出厂授权；断言库属主是 postgres | ✅ |
| `03-grants.sql` | `postgres` | 只给 staging 角色 CONNECT/USAGE；**收回生产角色在 staging 的存量权限** | ✅ |
| `04-default-privileges.sql` | **`chaoge_staging_migrator`** | 为**将来**迁移建的表/序列预置授权 | ✅ |
| `05-table-grants.sql` | **`chaoge_staging_migrator`** | 为**已存在**的表/序列授权、逐表自检 | ✅ |
| `06-bootstrap-data.sql` | **`chaoge_staging_app`** | 最小测试数据；只 `INSERT ... ON CONFLICT DO NOTHING` | ✅ |
| `99-verify.sql` | `postgres` | **只读**隔离验收，输出 PASS / FAIL | — |

### 脚本

| 文件 | 执行角色 | 作用 |
|---|---|---|
| `deploy-staging.sh` | `root`（内部用 `sudo -u postgres`） | 六阶段入口 |

### 每个 SQL 文件的共同守卫

所有文件开头都有同一段库名守卫：

1. `current_database()` 或 `chaoge.expected_database` 任一等于 `chaoge_prod` → **无条件拒绝**；
2. 期望库名必须匹配 `^chaoge_staging`；
3. 当前连接库必须与期望库一致。

`chaoge.expected_database` 只用于本地隔离库（`chaoge_staging_*_test`），
但它**不能**把 `chaoge_prod` 放行——第 1 条先于第 2、3 条执行，且不读任何环境变量。

04/05 另有身份守卫：`current_user` 必须是 `chaoge_staging_migrator`。
06 的身份守卫是 `chaoge_staging_app`。

---

## 2. 账号隔离设计

角色是**集群级**对象。如果 staging 复用 `chaoge_app`，同一个凭据就同时握有
两个库的读写权——一次 `DATABASE_URL` 写错就会把 Mock 数据写进正式库。
因此 Step 5.8.2 创建两个**全新的**角色：

| | `chaoge_staging_migrator` | `chaoge_staging_app` |
|---|---|---|
| 用途 | 在 `chaoge_staging` 执行 DDL | staging 运行时 DML |
| `LOGIN` | ✅ | ✅ |
| 特权属性（SUPERUSER / CREATEDB / CREATEROLE / REPLICATION / BYPASSRLS） | ❌ | ❌ |
| 库级 `CONNECT` | ✅（仅 staging） | ✅（仅 staging） |
| 库级 `CREATE` / `TEMPORARY` | ❌ | ❌ |
| schema `public` `USAGE` | ✅ | ✅ |
| schema `public` `CREATE` | ✅ | ❌ |
| 表四项 DML | ✅（对象属主） | ✅ |
| 表 `TRUNCATE` / `REFERENCES` / `TRIGGER` / `MAINTAIN` | ✅（属主） | ❌ |
| 序列 `USAGE` / `SELECT` | ✅ | ✅ |
| 序列 `UPDATE`（`setval`） | ✅ | ❌ |

另外三条隔离断言会在 `init` / `verify` 里逐条执行：

1. staging 角色与 `chaoge_migrator` / `chaoge_app` **双向都没有成员关系**
   ——一条 `GRANT role TO role` 就足以让生产角色继承 staging 权限；
2. staging 角色不在任何 `pg_*` 预定义角色里（那会绕过表级授权）；
3. `chaoge_staging_app` **不能连接 `chaoge_prod`**，`chaoge_app` / `chaoge_migrator`
   **不能连接 `chaoge_staging`**。

**口令不设默认值**：01 只建角色，口令用 psql 的 `\password` 交互设置
（客户端算好 SCRAM 验证器再发出，明文不进 shell/psql 历史、不进命令行、不进日志）。

---

## 3. 首次执行

以下命令需在服务器上**逐条人工执行**。本仓库的自动化不会替人跑这些。

### 第 0 步 · 预检（只读）

```bash
sudo deploy/db/staging/deploy-staging.sh check
```

确认：PostgreSQL 可达、`chaoge_staging` 是否已存在、两个角色是否已建、
PUBLIC 是否已收紧、`chaoge_prod` 是否被 staging 角色可达。

### 第 1 步 · 建库

```bash
sudo deploy/db/staging/deploy-staging.sh create --database chaoge_staging
```

执行：

```sql
CREATE DATABASE "chaoge_staging" OWNER postgres TEMPLATE template0 ENCODING 'UTF8';
```

只建空库。**不会** `DROP`、**不会** 在已存在的库上做任何改动——
库已存在时该阶段直接拒绝，交回给人判断。

### 第 2 步 · 权限初始化

```bash
sudo deploy/db/staging/deploy-staging.sh init --database chaoge_staging
```

01→05 拼成**一个事务**（`BEGIN` → … → `COMMIT`）交给同一个 psql 会话：

```
BEGIN
SET chaoge.expected_database = 'chaoge_staging'
01  postgres
02  postgres
03  postgres
SET ROLE chaoge_staging_migrator
04  （默认权限必须记在迁移角色名下）
05  （此刻还没有表，空跑是正确结果）
RESET ROLE
COMMIT
```

任何一步失败都会使整个事务回滚，数据库保持执行前的状态。
需要逐字输入库名才会执行（`--self-test` 只对 `*_test` 库放行）。

### 第 3 步 · 设置两个角色的口令

```bash
sudo -u postgres psql -d chaoge_staging
```

```
\password chaoge_staging_migrator
\password chaoge_staging_app
```

口令只用于 TCP（`127.0.0.1` + `scram-sha-256`）。
管理路径（`init` / `bootstrap` / `verify`）走 peer 认证，不需要口令。

### 第 4 步 · 迁移

```bash
sudo deploy/db/staging/deploy-staging.sh migrate --database chaoge_staging
```

- 交互式输入 `chaoge_staging_migrator` 口令，只放进 `pnpm` 子进程的
  `DATABASE_URL`，不写文件、不打印；
- 以 `NODE_ENV=production` 运行 `pnpm db:migrate`（保持 `db:seed` / `db:reset` 的守卫关闭）；
- 迁移完成后**重跑 `05`**，把迁移新建的 40 张表逐张授权给 `chaoge_staging_app`；
  05 同时断言每张表的属主都是 `chaoge_staging_migrator`。

> 为什么不能以 postgres 跑迁移：那样表属主会是 postgres，05 的自检会当场失败。
> 迁移角色建表、应用角色 DML，这条分工必须在对象属主层面成立。

### 第 5 步 · 最小测试数据

```bash
sudo deploy/db/staging/deploy-staging.sh bootstrap --database chaoge_staging
```

以 `SET ROLE chaoge_staging_app` 执行 06。此时权限检查按**应用角色**计算：
04/05 少给一项 DML，06 会立刻 42501 失败——这份 SQL 本身就是一次授权验证。

写入内容：

| 表 | 行 | 用途 |
|---|---|---|
| `users` | `u-1001`、`u-1002` | mock 登录默认用户 / 持久化验收用户 |
| `admin_accounts` | `admin-1`（role=admin） | 管理后台 mock 登录 |
| `staff_accounts` | `staff-1`（role=customer_service） | 客服工作台 mock 登录 |
| `companions` | `cp-demo` → `u-1001` | 打手工作台 |
| `games` / `categories` / `products` / `product_specs` | `g-delta` / `c-loss` / `p-400w` / `s-400w` | 商品详情与收藏链路 |

可重复执行；已存在的行由 `ON CONFLICT DO NOTHING` 跳过。

### 第 6 步 · 验收

```bash
sudo deploy/db/staging/deploy-staging.sh verify --database chaoge_staging
```

只读。第 9 节输出 `OVERALL = PASS` 才允许继续。
它核对角色属性、成员关系、PUBLIC 收紧、默认权限、逐表授权、跨库隔离、
迁移数量与最小数据。

### 第 7 步 · 生成运行时环境变量

```bash
sudo deploy/app/setup-staging-env.sh
```

默认写入：

```
NODE_ENV=production
DATA_SOURCE=postgres
DATABASE_URL=postgresql://chaoge_staging_app:<编码口令>@127.0.0.1:5432/chaoge_staging
PG_POOL_MAX=5
ENABLE_MOCK_AUTH=true
...
```

写入前会用临时 `.pgpass` 试连一次，并核对
`current_user|current_database|rolsuper` 必须是 `chaoge_staging_app|chaoge_staging|false`。
库名或角色不是 staging 的，会在**提示输入口令之前**被拒绝。

之后按 `deploy/app/README.md` §5 发布产物即可。发布入口
`install-release.sh` 会再校验一次 `DATABASE_URL` 的角色、库名与回环地址。

### 后续每次更新

```bash
sudo deploy/db/staging/deploy-staging.sh check
sudo deploy/db/staging/deploy-staging.sh migrate     # 有新迁移时
sudo deploy/db/staging/deploy-staging.sh verify
```

---

## 4. 守卫与失败路径

| 场景 | 结果 |
|---|---|
| `--database chaoge_prod check` | **参数解析阶段**拒绝，不连数据库 |
| `--database chaoge_esports_dev init` | 拒绝（库名必须以 `chaoge_staging` 开头） |
| 把 `06` 直接对 `chaoge_prod` 执行 | SQL 守卫无条件拒绝（`42501`） |
| 把 GUC 改成 `chaoge.expected_database='chaoge_prod'` | 仍然拒绝（第 1 条守卫先于 GUC 判断） |
| 以 postgres 跑 `04/05`（未 `SET ROLE`） | 身份守卫拒绝 |
| 以 postgres 跑 `06`（未 `SET ROLE`） | 身份守卫拒绝 |
| `--self-test` 指向 `chaoge_staging`（非 `*_test`） | 拒绝 |
| `--rollback-selftest` 指向 `chaoge_staging` | 拒绝 |
| `CHAOGE_DB_HOST` 非回环 | 拒绝 |
| 给 `setup-staging-env.sh` 传 `--role chaoge_app` | 拒绝，并提示使用 `chaoge_staging_app` |
| `staging.env` 里 `DATABASE_URL` 指向 `chaoge_prod` | `install-release.sh` 在解包前拒绝 |
| 用 `db:seed` / `db:reset` 作为阶段名 | 未知阶段拒绝 |

生产角色在 staging 上的**存量授权**也会被主动收回（03/04/05），
而不是「这次不授予」——只做后者发现不了历史上手工 GRANT 留下的权限。

---

## 5. 为什么不用 `db:seed` / `db:reset`

- `db:seed` 属于开发工具，`assertSeedAllowed()` 在 `NODE_ENV=production` 下直接抛错；
- staging 运行时就是 `NODE_ENV=production`，所以它**本来就应该被拒绝**；
- `db:reset` 额外要求库名以 `_test` 结尾，staging 库不满足；
- 06 是一条独立路径：psql 直接执行、不读 `NODE_ENV`、不含 UPDATE/DELETE/TRUNCATE，
  **不是**「关掉守卫」，而是根本不经过守卫管的那条路径；
- 本目录和入口脚本都不提供 seed/reset，也不接受它们作为阶段名。

---

## 6. 重建 staging（人工，非自动化）

Staging 是可以整体重建的——这正是它独立成库的意义。重建**只影响**
`chaoge_staging`，`chaoge_prod` 的结构、数据、角色都不受影响。

操作顺序（需人工审批，脚本不提供）：

```bash
# 1. 停止 staging 服务，避免重建期间有活动连接
sudo systemctl stop chaoge-staging

# 2. 确认没有残留连接，然后删除 staging 库
sudo -u postgres psql -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='chaoge_staging'"
sudo -u postgres psql -d postgres -c "DROP DATABASE chaoge_staging"

# 3. 从 §3 第 1 步重新开始（create → init → 口令 → migrate → bootstrap → verify）
#    角色保留；01 是收敛式的，不会重置已有口令。
```

> ⚠️ **不要**为了「省事」把 `chaoge_staging_app` 改成数据库属主，也不要
> 给 staging 角色加 `CREATEDB`。删除库是 `postgres` 的运维动作，不是应用能力。

---

## 7. 资源消耗（2 vCPU / 2 GB 单机）

与 `chaoge_prod` 共享同一个 PostgreSQL 实例，新增的主要是**第二个库的存储**，
不是第二个实例：

| 项 | 估算 | 说明 |
|---|---|---|
| PostgreSQL 实例 | 约 350–550 MB | 与是否多一个空库基本无关；共享缓冲区是实例级 |
| 第二库结构 + 最小数据 | < 5 MB | 16 条迁移、约 40 张表、十几行数据，全空库 |
| staging 应用进程（Node） | 约 120–350 MB | Next.js standalone；与生产进程同量级 |
| 产物与版本目录 | 约 220 MB（5 个版本 × 42 MB 解压） | `CHAOGE_KEEP_RELEASES` 控制保留数 |
| 连接内存 | 池 5 + 迁移/运维临时连接 | `PG_POOL_MAX=5`，单连接约 2–5 MB |

合计新增约 **0.4–0.9 GB 内存**与约 **0.3 GB 磁盘**。在 2C2G 上可运行，
前提是：

- `PG_POOL_MAX=5`（`setup-staging-env.sh` 已写入）；
- 发布版本保留数不超过 5（默认值）；
- 不与生产应用进程在**同一秒**执行迁移/构建；
- 不开 `ENABLE_MOCK_DEBUG`（它会放大内存中的 Mock 数据）。

如果 staging 与生产应用**同时**常驻且都按默认池 10 运行，
连接与内存峰值会明显变高——这正是 staging 池被压到 5 的原因。

---

## 8. 与生产脚本的关系

| 生产 | Staging | 差异 |
|---|---|---|
| `01-create-roles.sql` | `01-create-roles.sql` | 角色名不同；staging 额外断言与生产角色**无成员关系** |
| `02-harden-public.sql` | `02-harden-public.sql` | 规则相同；staging 额外断言库属主是 postgres |
| `03-migrator-grants.sql` | `03-grants.sql` | staging 先 `REVOKE` 生产角色的存量权限，再授予 |
| `04-app-default-privileges.sql` | `04-default-privileges.sql` | staging 额外清除生产角色的默认权限残留 |
| `05-app-table-grants.sql` | `05-table-grants.sql` | staging 额外逐表收回生产角色权限并断言 |
| `99-verify.sql` | `99-verify.sql` | staging 增加跨库隔离、成员关系、最小数据检查 |

生产的 `deploy/db/*.sql` 与 `deploy.sh` **未修改**。

---

## 9. 本地隔离验证

本地可以在一台开发机上完整验证本目录，而**不会**碰到任何生产对象：

```bash
# 用本地 PostgreSQL 的 superuser 连接参数
export CHAOGE_SUDO=""
export CHAOGE_PSQL_ARGS="-h 127.0.0.1 -U postgres"
export PGPASSWORD='<本地 postgres 口令>'

deploy/db/staging/deploy-staging.sh create    --database chaoge_staging_iso_test --self-test
deploy/db/staging/deploy-staging.sh init      --database chaoge_staging_iso_test --self-test
# 给两个 staging 角色设本地临时口令，然后：
CHAOGE_STAGING_MIGRATOR_URL='postgresql://chaoge_staging_migrator:<pw>@127.0.0.1:5432/chaoge_staging_iso_test' \
  deploy/db/staging/deploy-staging.sh migrate --database chaoge_staging_iso_test --self-test
deploy/db/staging/deploy-staging.sh bootstrap --database chaoge_staging_iso_test --self-test
deploy/db/staging/deploy-staging.sh verify    --database chaoge_staging_iso_test --self-test
```

失败路径也应验证：

```bash
deploy/db/staging/deploy-staging.sh check --database chaoge_prod        # 必须被拒
deploy/db/staging/deploy-staging.sh init  --database chaoge_staging     # --self-test 未开 → 无 TTY 必须被拒
```

测试库与两个 staging 角色在验证结束后应清理（`DROP DATABASE` / `DROP ROLE`），
不要把本地隔离库留在共享实例上。
