# 数据库部署与权限初始化（PROD-2）

生产库 `chaoge_prod` 的角色与权限。**首次执行**按 §4 的 0～8 步走，之后每次部署只需 `check` + `verify`（见 §4 末）。

> **Staging 使用另一套独立脚本**：`deploy/db/staging/`（独立库 `chaoge_staging`、
> 独立角色 `chaoge_staging_*`、独立入口 `deploy-staging.sh`）。
> 本目录的脚本不会被 staging 调用，生产角色与授权也不会被 staging 修改。
> 见 [`staging/README.md`](staging/README.md)。

---

## 0. 怎么用：一个入口，四个阶段

所有动作都走 `deploy/db/deploy.sh`，不要再手工逐条敲 psql：

```bash
sudo deploy/db/deploy.sh check     # 只读预检
sudo deploy/db/deploy.sh backup    # 备份 + 恢复验证（只读源库，写备份目录）
sudo deploy/db/deploy.sh init      # 权限初始化（唯一会写库的阶段，需交互确认）
sudo deploy/db/deploy.sh verify    # 只读验收，输出 PASS / FAIL
```

`check → backup → init → verify`。写操作集中在 `init` 一个阶段，
且它**必须先通过交互式确认**（要求逐字输入目标库名）才会执行（见 §4 第 2 步）。

**这个脚本不提供 `db:migrate` / `db:seed` / `db:reset`，也不会替你去跑。**
把 `migrate` / `seed` / `reset` 当阶段名传进去，会被当作未知阶段拒绝——
这是 §8 那条「迁移必须有人审批」的落地点，不是遗漏。
`init` 结束时会把迁移命令**打印**出来，由人复制执行。

---

## 1. 文件清单

### 脚本

| 文件 | 执行角色 | 作用 | 幂等 |
|---|---|---|---|
| `deploy.sh` | `postgres` | **分阶段入口**：`check` / `backup` / `init` / `verify` | ✅ |
| `setup-credentials.sh` | `root`（只读 `psql` 试连） | 生成 `/etc/chaoge/db.env`，原子写入 + 定权限 | ✅ |
| `db.env.example` | — | 凭据文件模板，**无任何真实凭据**，可进 Git | — |

### SQL（由 `deploy.sh init` 在**单个事务**里依次执行）

| 文件 | 执行角色 | 作用 | 幂等 |
|---|---|---|---|
| `01-create-roles.sql` | `postgres` | 创建 / 收敛两个角色，**不设密码** | ✅ |
| `02-harden-public.sql` | `postgres` | 收回 PostgreSQL 出厂给 PUBLIC 的授权 | ✅ |
| `03-migrator-grants.sql` | `postgres` | 连接权 + schema 级 USAGE / CREATE 分工 | ✅ |
| `04-app-default-privileges.sql` | **`chaoge_migrator`** | 为**将来**的表/序列预置授权 | ✅ |
| `05-app-table-grants.sql` | **`chaoge_migrator`** | 为**已存在**的表/序列授权 | ✅ |
| `99-verify.sql` | `postgres` | **只读**验收报告 | — |

> `deploy.sh init` 把 01～05 拼成**一个流**交给同一个 psql 会话：
> `BEGIN` → `SET chaoge.expected_database` → 01 → 02 → 03 → `SET ROLE chaoge_migrator` → 04 → 05 → `RESET ROLE` → `COMMIT`。
> **05 之后还要在迁移之后再手工跑一次**（§4 第 7 步）——默认权限只管将来的表，
> 迁移建出来的表要再跑一次才会被逐张授权。

> ⚠️ **04 与 05 的执行角色不是笔误**，是本方案最容易踩的坑：
> `ALTER DEFAULT PRIVILEGES` 的记账键是**执行者**（`current_user`），
> 用 `postgres` 执行会让默认权限记在 `postgres` 名下，而迁移将来是
> `chaoge_migrator` 跑的 —— 脚本会「成功」，但一条都不生效。
> 两个脚本开头都有身份守卫，身份不对会立刻报错而不是安静地白跑。

---

## 2. 角色设计

| | `chaoge_migrator` | `chaoge_app` |
|---|---|---|
| 用途 | 执行 `db/migrations` 里的事务性 DDL | 应用运行时（Next.js 服务进程） |
| `LOGIN` | ✅ | ✅ |
| `SUPERUSER` / `CREATEDB` / `CREATEROLE` / `REPLICATION` / `BYPASSRLS` | ❌ | ❌ |
| 库级 `CONNECT` | ✅ | ✅ |
| 库级 `TEMPORARY` / `CREATE` | ❌ | ❌ |
| schema `public` 的 `USAGE` | ✅ | ✅ |
| schema `public` 的 `CREATE` | ✅ | **❌** |
| 表 `SELECT` / `INSERT` / `UPDATE` / `DELETE` | ✅（对象属主） | ✅ |
| 表 `TRUNCATE` / `REFERENCES` / `TRIGGER` / `MAINTAIN` | ✅（属主） | **❌** |
| 序列 `USAGE` / `SELECT` | ✅ | ✅ |
| 序列 `UPDATE`（`setval`） | ✅ | **❌** |

### 三条设计取舍

**① 应用角色没有任何 DDL 能力。**
`chaoge_app` 不能建表，意味着「库处于哪个版本」这件事只能由 `schema_migrations` 回答，
而 `pnpm db:migrate` 是唯一能改结构的路径。这条纪律写在代码里只是一个约定，
做成数据库权限才是**能被强制**的：代码里少写一句注释没人察觉，少一份 `CREATE` 权限会当场报错。

**② `public` schema 的属主保持 `pg_database_owner`，不改为 `chaoge_migrator`。**
属主比 `CREATE` 多一层破坏力（能 `DROP SCHEMA public CASCADE`）。
迁移角色只需要「在 public 里建对象」，不需要「控制 public 本身」。

**③ 两个角色都不设 `CONNECTION LIMIT`。**
理由见 §7「可选加固」——它是一条会随 `PG_POOL_MAX` 变化而突然咬人的暗雷。

---

## 3. 认证与凭据

### 3.1 服务器的 pg_hba.conf（本方案的运行前提）

按生产服务器**已确认**的配置：

```
local   all   postgres             peer
local   all   all                  peer
host    all   all   127.0.0.1/32   scram-sha-256
host    all   all   ::1/128        scram-sha-256
```

加上「PostgreSQL 只监听本机地址」。三条推论，决定了整套部署路径的形态：

**① 整套部署路径一个口令都不需要。**
`local … peer` 意味着本地 socket 连接按**操作系统用户**认证：
以 `postgres` 身份的进程连库时，服务端根本不看口令。
`sudo -u postgres psql` 因此**永远不会弹口令提示**，也就不存在
「部署脚本卡在口令输入上、在无人值守时挂死」这一类故障。
备份、`check`、`init`、`verify`、`\password` 设置口令——全部走这条路径。

**② 只有两个角色需要口令，且都是 TCP 连接。**
`chaoge_migrator`（迁移那一步，走 `DATABASE_URL`）与 `chaoge_app`（应用运行时）。
`host … scram-sha-256` 要求口令，但客户端只连 `127.0.0.1`，口令不出本机。

**③ 不需要改 pg_hba.conf。**
本方案刻意不去动它——收紧 `local … peer` 会连 `sudo -u postgres` 这条路一起堵死，
而它正是恢复路径本身。**部署脚本不读、不写、不校验该文件**，
只在 `check` 阶段提示「口令未设置时后续 TCP 连接会失败」。

> 因为认证已由 OS 用户保证，部署脚本的所有 psql 调用都带 `-w`（`--no-password`）：
> 万一某次确实需要口令而凭据不存在，**立刻失败**，而不是弹提示等在那里。
> 备份与还原校验的每一条客户端调用都有这个参数。

### 3.2 密码：不进脚本、不进 Git、不进命令行

`01-create-roles.sql` **刻意不设置任何密码**，全文没有一个口令字节。这是它能够安全进 Git 的原因。

密码由 psql 的 `\password` 内建命令交互设置（走上面的 peer 路径，**不需要任何口令就能进去**）：

```bash
sudo -u postgres psql -d chaoge_prod
```

```sql
\password chaoge_migrator
-- Enter new password for user "chaoge_migrator":
-- Enter it again:
\password chaoge_app
```

`\password` 的好处是它在**客户端**算好 SCRAM 验证器再发给服务端，因此：

- 明文口令**不出现在 shell 历史**（不是命令行参数）
- **不出现在 psql 历史**（是元命令，不是 SQL 语句）
- **不出现在服务端日志**（服务端收到的是验证器）
- **不回显**

> ❌ **不要**写成 `psql -c "ALTER ROLE chaoge_migrator PASSWORD '...'"`——
> 明文会进 shell 历史，也会进服务端的语句日志。
> ❌ **不要**用 `PGPASSWORD=... psql`——同样进历史与环境变量。

### 3.3 密码怎么交给应用：`/etc/chaoge/db.env`

**用脚本生成，不要手写再上传：**

```bash
sudo deploy/db/setup-credentials.sh
```

它从**终端**读口令（`read -s`，不接受命令行参数、不读环境变量、不读管道），然后原子地写出：

```
/etc/chaoge/          root:chaoge   0750     ← 目录：组外连 ls 都进不去
/etc/chaoge/db.env    root:chaoge   0640     ← 服务账号可读，others 一律不可读
```

**为什么必须是脚本而不是 `cp`。** 手写一个 `.env` 再传上去，最容易出岔子的不是内容而是**权限**：
`cp` 出来的文件默认 0644 ——任何本地用户都能读到生产库口令，而且这件事**不会报错、不会被提醒**。
脚本把「写入时机、属主、权限」固化成一条原子路径：

```
mktemp 建 0600 临时文件 → 写完 → chown/chmod → mv 就位
```

临时文件全程在 0600 下，`mv` 是同目录内的原子替换，因此**不存在任何一刻让这个文件对 others 可读**。
直接 `>` 重定向做不到这点：它先创建（受当时 umask 影响）再写入，中间那一下就是敞口。

脚本还会：写入前校验服务账号/组**确实存在**（否则会留下一个 `root:root` 的 0640 文件，
服务账号读不到、服务起不来，而报错发生在几步之后）；写完**自检** `stat` 结果是 `root:<组> 640`，
不符即报错；并用一个临时 `.pgpass`（0600，用完即删）以 `chaoge_app` 试连一次，
**口令不进 argv、不进环境变量、不留日志**。

> `.pgpass` 里写的是**明文**口令，不做百分号解码。若从写好的 URL 反推口令，
> `@` 会以 `%40` 的形式落进去，试连就会**假失败**——而假失败比不检查更糟，
> 它会让人去查网络和授权，查很久。脚本直接持有明文变量，不从 URL 反推。

内容（`db.env.example` 是同一份模板，不含任何真实凭据）：

```bash
DATA_SOURCE=postgres
DATABASE_URL=postgresql://chaoge_app:<百分号编码后的口令>@127.0.0.1:5432/chaoge_prod
```

连接串里的口令会被**百分号编码**：口令里一个 `@` 会让 host 被解析错，
一个 `:` 会让端口被解析错，而这两种错误都表现为「连不上」。**不要手工拼这个串。**

**刻意不写** `ENABLE_MOCK_AUTH` / `ENABLE_MOCK_PAYMENT` / `ENABLE_MOCK_ADMIN` /
`ENABLE_MOCK_STAFF` / `ENABLE_MOCK_DEBUG` —— 这五个开关的规则是「显式等于字符串 `true` 才开启」，
所以「不写」就等于关闭；而 `ENABLE_MOCK_DEBUG` 会开放 `POST /api/debug/reset` 这个**清库接口**，
生产上不能有任何一行写着它。脚本生成的整个文件里没有一处提到 `ENABLE_MOCK_`（有测试守着这一点）。

`NODE_ENV` 也不放这里：它由 systemd 服务单元设置，是 `db:seed` / `db:reset` 守卫的一部分，
让凭据文件与运行模式脱钩更安全。

迁移那次**单独**用 `chaoge_migrator` 的连接串（见 §4 第 6 步），
**不要**把它写进应用的常驻环境文件——应用的进程自始至终不该持有迁移角色的凭据。

---

## 4. 执行顺序

在**生产服务器上**，按顺序执行。每一步都给出「怎么确认这一步真的成了」。

### 第 0 步 · 预检（只读）

```bash
sudo deploy/db/deploy.sh check
```

报告连通性、两个角色是否已存在、PUBLIC 是否已收紧、口令是否已设、待执行迁移数、备份目录是否可写。
**不改任何东西**，可以随时重跑。

### 第 1 步 · 备份 + 恢复验证

```bash
sudo deploy/db/deploy.sh backup
```

备份目录默认 `/var/backups/chaoge`（`--backup-dir` 或 `CHAOGE_BACKUP_DIR` 可改），
脚本会**强制** `mkdir -p` 成 `0700` 并**实写一个探针文件**确认可写——
目录不存在、属主不对、磁盘满，都在这一步暴露，而不是在需要恢复的那天。

产出 `chaoge_prod_<时间戳>.dump`（`pg_dump -Fc`，权限 **0600**）与同名 `.sha256`。
恢复时先 `sha256sum -c chaoge_prod_<时间戳>.dump.sha256` 确认手上这份还是当初那份——
备份出问题多半发生在「从别处复制回来」这一步，而复制坏掉不会报错。

> **脚本不做自动轮转清理。** 删备份是不可逆的，「留多久」是运维策略不是脚本该替人决定的事；
> 万一某次备份刚好是唯一可用的一份，自动删掉它就是灾难。定期清理请写在别处，
> 并且**先确认新备份的恢复验证过了再删旧的**。

**备份不止是「跑完 pg_dump 就完事」**，脚本紧接着做两级验证：

| 级别 | 做什么 | 能证明什么 |
|---|---|---|
| 轻 | `pg_restore --list` 解出目录 | 归档没被截断，格式可读 |
| 重 | **真的还原一次**（默认执行） | 数据确实能恢复到可用状态 |

「重」这一级才是有意义的那个：`pg_dump` 写出一个**结构性损坏但能顺利退出**的文件是完全可能的，
而 `--list` 只能看目录页。真实还原会：

1. 建临时库 `chaoge_restore_verify_<pid>`（`createdb -T template0`，不继承任何模板状态）
2. `pg_restore -w --no-owner --no-acl` 灌进去
3. 比对**内容指纹**（见下）与源库完全一致
4. **删掉临时库**

临时库名有硬编码前缀 + 正则守卫，`dropdb` 只对匹配该前缀的库执行；
`trap` 同时挂在 `EXIT` / `INT` / `TERM` 上，**脚本被 Ctrl-C 或 kill 也会清掉临时库**，
不会给你留下一个没人管的半拉数据库。`-w` 保证任何一步缺少凭据时**立刻失败**而不是挂起等待。

#### 为什么不能只比表数量

`pg_dump -Fc --section=pre-data`（只导结构、不导数据）出来的备份，还原之后
**表一张不少**、`pg_restore` 退出码 **0**、stderr **为空**。
只数表数量会把它判成「恢复成功」——而这份备份里没有一行业务数据。

所以现在比的是**内容**，五类指纹逐项对：

| 指纹 | 查询 | 少了会怎样 |
|---|---|---|
| 表与行数 | 每张表的真实 `count(*)` | 表在、数据没了（就是上面那种） |
| 约束 | `pg_constraint` 的表/名/类型 | 主键退化成普通索引，能读不能用 |
| 索引 | `pg_index` 的表/名/唯一性 | 唯一约束形同虚设 |
| 序列 | 每个序列的 `last_value` | 下一个 id 从头开始，撞主键 |
| 迁移元数据 | `schema_migrations` 的版本/名/校验和 | 应用与库对不上版本，且**不会报错** |

> 用 `count(*)` 而不是 `reltuples`：后者是 ANALYZE 的估计值（实测同一份数据
> 源库 291 / 还原库 315，从没 ANALYZE 过的表是 `-42`），拿它判定会**又假通过又假失败**。

判定规则，三条都是实测出来的：

1. **`pg_restore` 退出码非 0 → 失败，立刻中止。** 退出码是与语言无关的判据。
   刻意**不**用 `grep 'pg_restore: error:'` 去匹配 stderr：本机中文 locale 下
   实测 1651 行错误，文本是 `pg_restore: 错误:`，那条 grep 匹配 **0** 行——
   按字符串判定会在生产（`en_US.UTF-8`）和本地之间悄悄失配。
2. **退出码 0 但 stderr 有内容 → 原样打印，不判失败。** `--no-owner --no-acl`
   已经去掉了最常见的 warning 来源（角色不存在、ACL 无法重建），实测健康备份的
   stderr 是空的；即便将来出现无害 NOTICE，退出码仍是 0，不会误停。
3. **任何一项指纹取不到（SQL 报错）→ 失败，立刻中止。** 这是最隐蔽的一种假通过：
   查询写错时两边都返回空，diff 也是空，一次真失败会被读成「两边一致」。

源库为空时（比如首次部署前的 `chaoge_prod`）每一项都是 N/A，脚本会**明说**
「本次校验只证明了『一个空库能还原成空库』」，而不是把空转报成验收通过。

> 用 `--no-restore-verify` 可以只做 `--list`（备份库很大时省时间）。
> 但**首次部署不要跳过**：此时库里还没什么数据，验证几乎不花时间。

#### 单独校验一个已有的备份

```bash
sudo deploy/db/deploy.sh backup --verify-dump /var/backups/chaoge/chaoge_prod_20261014_031500.dump
```

只跑第 3～4 级验证，**不新建备份**、不碰备份目录、不写校验和。
用在「从归档里翻出一份旧备份，想知道它还能不能用」的时候。
文件不存在或是空的会直接拒绝。校验失败时退出码非 0，可直接接进 CI 或监控。

此时 `chaoge_prod` 里还没有业务表，备份很小。**但这一步仍然要做**：
后面的步骤会改动数据库级 ACL，一旦 `REVOKE CONNECT` 发错，你会需要一条**已验证可用**的恢复路径。

### 第 2 步 · 权限初始化（写操作，需确认）

```bash
sudo deploy/db/deploy.sh init
```

01→05 在**同一个事务**里执行，`COMMIT` 或什么都不留。各步的细节见本节末尾的对照表。

执行前**必须**通过两道关：

1. **必须有交互式终端**（`-t 0`）。管道、cron、CI 里跑会直接拒绝——
   理由不是「防手滑」，而是「无人审批时不该写生产库」。
2. **必须逐字输入目标库名**（`chaoge_prod`）确认。输错、输别的、直接回车，都**在连库之前**中止，不做任何改动。

先看要执行什么，不写库：

```bash
sudo deploy/db/deploy.sh init --dry-run     # 打印将要执行的完整 SQL 流
```

`--rollback-selftest` 让事务以 `ROLLBACK` 结束（本地验证用，**对 `chaoge_prod` 会被直接拒绝**）。

> **01～05 为什么是一个事务，而不是五条命令。**
> 02 收回 PUBLIC 的 `CONNECT`，03 再把连接权发给两个角色。
> 分成五条命令跑，两者之间就存在一个**真实的窗口**：此刻除 `postgres` 外**谁也连不上这个库**——
> 如果这时 03 因为任何原因没跑成（网络断、终端关掉、人走开），你会停在一个人为制造的
> 「所有角色都连不上」的状态里，而恢复要靠 `postgres` 超级用户绕过去。
> 放进一个事务后这个窗口**根本不存在**：要么全部生效，要么全部没有。
> 中途失败时 psql 在第一个错误处退出，连接关闭，未提交的事务由服务端回滚——
> 不需要任何手工清理。

> **为什么这不影响 `\password`（第 3 步）。**
> `\password` 是以 `postgres` 身份经**本地 socket（peer 认证）**进去执行的一条元命令。
> peer 认证是**操作系统层面**的判定，发生在 SQL 权限检查之前；
> 而 `REVOKE CONNECT` 拿走的是**连接特权**，两回事。
> 加上 `postgres` 是超级用户，本身绕过特权检查。
> 所以「第 2 步必须在第 3 步之前，否则连不上库就设不了密码」这个说法**不成立**——
> 口令在**任何时刻**都能设，`init` 之后再设也完全可以。
> 真正的约束只有一个：**口令必须在第 6 步（迁移）之前设置好**，
> 因为那是整条路径上**第一次走 TCP**、第一次真正需要口令的连接。

### 第 3 步 · 设置密码

见 §3.2。**在 `init` 之前或之后都行**（理由见上），但必须在第 6 步（迁移）之前。

```bash
sudo -u postgres psql -d chaoge_prod
\password chaoge_migrator
\password chaoge_app
```

两个角色都要设：`chaoge_migrator` 给第 6 步的迁移，`chaoge_app` 给应用运行时。

### 第 4 步 · 验收（只读）

```bash
sudo deploy/db/deploy.sh verify
```

`init` 之后的 `verify` 应当 `FAIL`——此时 `chaoge_app` 的默认权限虽已记好，
但 `05` 还是空跑（public 里没有表）。**这是预期**，第 8 步之后才会 `PASS`。

### 第 5 步 · 生成应用凭据文件

见 §3.3。`init` 已经跑完、两个角色的权限都已就位，此刻试连才验得准。

```bash
sudo deploy/db/setup-credentials.sh
```

### 第 6 步 · 执行迁移（**整条路径上唯一需要人工审批的一步**）

`deploy.sh` **不会**替你跑这一步，`init` 结束时只把命令**打印**出来。
`db:migrate` / `db:seed` / `db:reset` 都不在脚本能力范围内，传进去会被当未知阶段拒绝——
`db:seed` 和 `db:reset` 在非生产环境之外本就有守卫（`assertSeedAllowed` / `assertResetAllowed`），
这一层是刻意的重复：**没有人看着的时候，这三个命令任何一个都不该被执行。**

用一个临时环境文件，只在这一步使用：

用一个临时环境文件，只在这一步使用：

```bash
cd /opt/chaoge/web
NODE_ENV=production \
DATABASE_URL='postgresql://chaoge_migrator:<口令>@127.0.0.1:5432/chaoge_prod' \
  pnpm db:migrate
```

- `NODE_ENV=production` 同时关掉 `db:seed` / `db:reset` 的守卫（本项目 `assertSeedAllowed` / `assertResetAllowed`
  只在非生产环境放行），**不要**在这条命令里带 `--target=app`。
- 运行器会在一个事务里取 `pg_advisory_xact_lock(48201996)`、引导建 `schema_migrations`、
  然后逐条执行 0001～0016。`chaoge_migrator` 现在拥有的权限刚好覆盖这些动作。

确认——**这一步要用 `chaoge_app` 的连接串**：

```bash
NODE_ENV=production DATABASE_URL='postgresql://chaoge_app:<口令>@127.0.0.1:5432/chaoge_prod' \
  pnpm db:health
```

用应用角色而不是迁移角色，是因为它同时验证了两件事：迁移确实跑完了，
以及 `chaoge_app` 真的读得到 `schema_migrations`——`lib/data/pg/health.ts` 需要它，
而 `instrumentation.ts` 在进程启动时就会调用这条路径，读不到的话服务**起不来**。
用迁移角色跑 `db:health` 会恒成功（它是表的属主），验不出这条依赖。

### 第 7 步 · 补一次表级授权

```bash
sudo -u postgres psql -d chaoge_prod -v ON_ERROR_STOP=1 \
  -c "SET ROLE chaoge_migrator" \
  -f deploy/db/05-app-table-grants.sql
```

**这一步不能省。** `init` 里跑的 `05` 是空跑（那时 public 里还没有表，输出
`[05] 自检通过：0 张表…` 是**正确结果**，不是漏跑）；迁移建出来的 40 张表要再跑一次才会被逐张授权。
确认输出里的表数应为 **40**（39 张业务表 + `schema_migrations`）。

重跑同时也是**收敛**：即便 `chaoge_migrator` 之外的任何人手工建过表、或某次授权被误删，
重跑一次即可回到已知正确状态。

> 为什么 `04` 和 `05` 要一起用：默认权限只管**将来**，显式授权只管**此刻**。
> 只有默认权限，绕过迁移手工建的表会拿不到授权；只有显式授权，每次新增迁移都得记得重跑。
> 两者一起，新表默认就是对的，而「现在到底对不对」还能被第 8 步验证。

### 第 8 步 · 验收

```bash
sudo deploy/db/deploy.sh verify
```

**只读**，任何时刻都可以重复执行。看最后一行：

```
 section | check_name | verdict | detail
       8 | OVERALL    | PASS    | 角色 2/2 · 特权属性违规 0 · …
```

`PASS` 需要同时满足：角色属性全为最小权限、PUBLIC 在库与 schema 上均无权限、
两条默认权限记录都在 `chaoge_migrator` 名下、40 张表权限全部正确、应用不能建对象。

各节内容：

| 节 | 内容 |
|---|---|
| 1 | 环境（库名、执行角色、表数） |
| 2 / 2b | 角色属性；口令**是否已设置**（只输出布尔值，绝不输出校验子） |
| 3 / 3b | 数据库级 ACL；PUBLIC 是否已收紧；非 PUBLIC 的显式授权清单 |
| 4 | `public` schema 的属主与各角色权限 |
| 5 / 5b | 默认权限逐条展开；存在性汇总（记在谁名下） |
| 6 / 6b | **逐表**权限矩阵（40 行）；序列权限 |
| 7 | 违规计数汇总 |
| 8 | 总体判定 |

### 后续每次部署要跑什么

首次部署（上面 8 步）之后，日常只有两条：

```bash
sudo deploy/db/deploy.sh check      # 部署前看一眼
sudo deploy/db/deploy.sh verify     # 部署后确认权限没被改坏
```

**不需要**再跑 `init`。`init` 是幂等的（见 §6），重跑无害，
但它的作用是「把权限收敛回已知状态」，不是「每次部署都要走一遍」——
而它需要人工确认，不该被塞进自动化流水线。
新增迁移之后，按第 6 → 第 7 步再来一次即可（迁移 + 补一次 `05`）。

### `init` 与逐条手工命令的对应

如果确实需要单独跑某一步（比如排查），下面是等价的命令。
**注意 `04` / `05` 的身份**——这是本方案最容易踩的坑：

| `init` 内部 | 等价手工命令 |
|---|---|
| 01 | `sudo -u postgres psql -d chaoge_prod -v ON_ERROR_STOP=1 -f deploy/db/01-create-roles.sql` |
| 02 | 同上，换成 `02-harden-public.sql` |
| 03 | 同上，换成 `03-migrator-grants.sql` |
| 04 | 同上，加 `-c "SET ROLE chaoge_migrator"`，换成 `04-app-default-privileges.sql` |
| 05 | 同上，加 `-c "SET ROLE chaoge_migrator"`，换成 `05-app-table-grants.sql` |

手工跑时库名守卫仍然生效：连到非 `chaoge_prod` 的库会直接抛 `42501` 并中止，
本地验证时先 `SET chaoge.expected_database = '<库名>';` 即可放行。

---

## 5. 各脚本需要什么 PostgreSQL 特权

| 脚本 | 需要 | 为什么 |
|---|---|---|
| `01` | `CREATEROLE`（或超级用户） | `CREATE ROLE` / `ALTER ROLE` 是集群级操作 |
| `02` | 库属主或超级用户 | `REVOKE … ON DATABASE` 需库属主；`REVOKE … ON SCHEMA` 需 schema 属主 |
| `03` | 库属主 + schema 属主 | `GRANT CONNECT` 与 `GRANT CREATE/USAGE ON SCHEMA` |
| `04` | 目标角色本身 | `ALTER DEFAULT PRIVILEGES` 无 `FOR ROLE` 时作用于**执行者** |
| `05` | 表属主或超级用户 | `GRANT` 要求拥有该对象或持有授权选项 |
| `99` | `postgres`（仅第 2b 节） | 读 `pg_authid` 判断口令是否设置；其余各节任意角色可读 |

**全部步骤都可以用 `postgres` 完成**，且不需要把 `chaoge_migrator` 的成员关系授予任何人——
超级用户对任何角色都能 `SET ROLE`。

> `pg_roles.rolpassword` 对所有用户恒返回 `********`，**无法**用来判断口令是否为空。
> 判断必须走 `pg_authid`，这是 `99-verify.sql` 第 2b 节需要超级用户的原因。

---

## 6. 幂等与作用域：重跑安全，且动不到别的库

### 6.1 所有阶段都可重复执行

**不需要「先回滚再重来」。** 每个 SQL 脚本都以「收敛到目标状态」写成，
而不是「假设当前是空的」：

- `01` 角色已存在就跳过创建，**且不碰它的密码**（不会把设好的口令重置掉）
- `02` / `03` 的 `REVOKE` 对本来就没有的权限只发一条 `WARNING: no privileges could be revoked` ——
  **这不是错误**，是幂等运行的预期输出
- `04` 的 `ALTER DEFAULT PRIVILEGES` 是幂等的（重复授权同一件事等于没做）
- `05` 逐张表 `GRANT`，重复执行收敛到同一状态
- `verify` / `check` 只读

`init` 重跑一次的结果与首次完全一致——这一点有测试守着
（`deploy.sh init 可以重复执行`：连跑两次，两次都断言全过且集群零残留）。

### 6.2 作用域：动不到别的库

三层独立守卫，任何一层拦下都会**在中止前不做任何改动**：

**① 库名白名单。** `deploy.sh` 只接受 `^[a-z_][a-z0-9_]*$`。
`chaoge_prod; DROP DATABASE x` 这类名字、带空格/引号/分号的名字，全部在连库之前拒绝。

**② 系统库/模板库按阶段拦截。**

| 库 | `check` / `verify` | `backup` | `init` |
|---|---|---|---|
| `chaoge_prod` 等业务库 | ✅ | ✅ | ✅（需确认） |
| `postgres` | ✅ | ✅ | ❌（仅 `--rollback-selftest` 例外） |
| `template0` / `template1` | ✅ | ✅ | ❌ |

`backup` 不禁 `postgres` 是刻意的：`pg_dump` 对源库只读，备份系统库没有危害。
`init` 禁则是必须的——它要 `REVOKE` 库级 ACL、`CREATE ROLE`。

**③ 每个 SQL 脚本自带库名守卫。** 脚本内部用 `current_database()` 与
`current_setting('chaoge.expected_database')` 比对，不符直接抛 `42501` 并中止。
这一层保护的是**绕过 `deploy.sh` 手工 `psql -f`** 的场景——
连错库是运维里最容易发生、后果又最难收拾的一类失误。

三层是冗余的，这是刻意的：① 挡手滑，② 挡流程错误，③ 挡「有人直接敲了 psql」。

> `--rollback-selftest` 是一个**仅用于本地验证**的开关，它让事务以 `ROLLBACK` 结束，
> 因此可以在一个真实集群上完整跑一遍 01～05 而**零残留**。
> 对 `chaoge_prod` 使用会被直接拒绝（见 §8）——它在生产库上没有任何正当用途。

---

## 7. 可选加固（未默认启用）

**`CONNECTION LIMIT`。** 可以限制每个角色的并发连接数，但它是一颗暗雷：
`lib/data/pg/pool.ts` 里生产环境的连接池上限是 `PG_POOL_MAX`（默认 10），
将来把这个值调大，超限的进程会直接连接失败。**如果确实要设**，
必须同时保证 `连接数 × 进程数 < 限制值`，否则故障会以「间歇性连不上」的形式出现——
比稳定报错难排查得多。

**`search_path`。** 可以给角色固定 `search_path`，但本项目所有查询都写全限定名或
只访问 `public`，收益为零；反而会在将来引入新 schema 时造成「本地能跑、线上找不到表」。

**新增任何访问角色（备份、监控、只读分析）时，必须显式授权。**
`02` 收回了 PUBLIC 的 `CONNECT`，从此默认值不再兜底——这是本方案带来的一条长期纪律。

---

## 8. 没有人工审批，这三个命令不会被执行

`db:migrate` / `db:seed` / `db:reset` 都不在 `deploy.sh` 的能力范围内。这不是「暂时没做」，
是**刻意的边界**，由四层独立防线保证：

| 层 | 机制 | 挡住什么 |
|---|---|---|
| 1 | 阶段名是**白名单**：只有 `check`/`backup`/`init`/`verify` | 把 `migrate` 当阶段传进去会被当未知阶段拒绝 |
| 2 | 脚本里**没有任何**执行这三个命令的语句 | 有人改代码「顺手加上去」会踩到测试 |
| 3 | `init` 是唯一的写阶段，且需要**交互式终端 + 逐字输入库名** | 无人值守（cron / CI / 管道）时写操作直接被拒 |
| 4 | `db:seed` / `db:reset` 自身的守卫（`assertSeedAllowed` / `assertResetAllowed`） | 非生产环境才放行，是最后一道 |

第 1、2 层有测试守着（`tests/deployScripts.test.mjs`）：既断言 `migrate`/`seed`/`reset`
作为阶段名被拒绝，也**用剥离注释与字符串后的源码**断言不存在
`pnpm/npx/node/npm … db:migrate|db:seed|db:reset` 这样的可执行语句。
源码断言之所以要剥掉字符串，是因为脚本**应该**在提示里打印 `pnpm db:migrate` 告诉运维该敲什么——
「打印命令」与「执行命令」的区别必须能被测试区分开。

`init` 结束时会打印下一步的迁移命令，**由人复制执行**。这是设计，不是缺功能。

---

## 9. 出错时怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| `[01] … 拒绝执行：当前连接的是数据库「x」` | 库名守卫拦下了 | 确认连的是 `chaoge_prod`；或 `SET chaoge.expected_database` |
| `[04] 拒绝执行：必须以 chaoge_migrator 身份运行` | 忘了 `SET ROLE` | 用 `init` 重跑（它自己会 `SET ROLE`） |
| `拒绝对系统库「postgres」执行 init` | 在维护库上跑了 `init` | 加 `--database chaoge_prod` |
| `写操作需要交互式确认，但标准输入不是终端` | cron / CI / 管道里跑了 `init` | **这是预期行为**。写生产库必须有人在场 |
| `确认失败（输入「x」，期望「chaoge_prod」）` | 库名输错了 | **未做任何改动**，重新跑 |
| `备份目录 … 不可写` | 目录属主不是执行 `pg_dump` 的账号 | 按脚本给出的 `chown postgres:postgres` 修 |
| `无法以「sudo -u postgres」身份执行命令` | sudo 需要口令但没有交互式终端（cron / CI / 非交互 ssh），或当前用户不在 sudoers | **这不是数据库的问题**。以 root 直接跑 `sudo deploy/db/deploy.sh …`，或设 `CHAOGE_SUDO=` |
| `只读查询失败（psql 退出码 N）` | 连接中途断了 / 权限不足 / SQL 里的非 ASCII 被客户端编码弄坏 | 看它原样打印的 psql 报错。**不要**把它当成「查询结果为空」——那正是它现在要拦住的误读 |
| `恢复验证失败：备份无法完整还原（pg_restore 退出码 N）` | 备份文件坏了（截断、复制中断、介质问题） | **换一份备份**。这份不要用于恢复，也**不要**继续 `init` / `migrate` |
| `恢复验证失败：还原库与源库内容不一致` | 备份缺内容（典型：`--section=pre-data` 出来的只有结构没有数据） | 同上。确认备份是完整的一次 `pg_dump -Fc`，而不是分段导出拼的 |
| 应用报 `permission denied for table orders` | 04 记录在了错误的角色名下，或 05 没跑 | 跑 `verify` 看第 5 节 `defaclrole`；重跑第 7 步 |
| 应用报 `permission denied for table schema_migrations` | `health.ts` 的启动自检读不到记账表 | 同上；重跑第 7 步 |
| 迁移报 `permission denied for schema public` | `chaoge_migrator` 缺 `CREATE` | 重跑 `init` |
| `no privileges could be revoked`（WARNING） | `REVOKE` 一个本来就没有的权限 | **不是错误**，是幂等运行的预期输出 |

---

## 10. 本地验证

### 权限矩阵

`tests/pgDeployPrivileges.test.mjs` 会在**一个回滚事务**里跑完整套脚本 + 真实的 0001～0016，
逐项核对权限矩阵，最后 `ROLLBACK` 并断言零残留。默认跳过：

```bash
PG_PERMS_VERIFY=1 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --env-file-if-exists=.env --test tests/pgDeployPrivileges.test.mjs
```

- 连的是**维护库**（默认 `postgres`），不碰开发库、测试库。
  用 `PG_PERMS_DB=<库名>` 改。**指向 `chaoge_prod` 会在模块加载期直接抛错**。
- 已实测 `CREATE ROLE` / `GRANT` / `REVOKE` / `ALTER DEFAULT PRIVILEGES` / `CREATE TABLE`
  在 PostgreSQL 里全部可回滚，因此这条路径**零集群残留**。
- 之所以可以这样验：`ALTER DEFAULT PRIVILEGES` 的记账键是 `current_user` 而非 `session_user`，
  所以 `SET ROLE` 与生产上的直接连接效果一致（这一点由用例的第 E 段实测确认）。

### 部署脚本本身

`tests/deployScripts.test.mjs` 验证 `deploy.sh` / `setup-credentials.sh` 的行为。
**大部分用例不需要数据库**，默认就跟着 `pnpm test` 跑：

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/deployScripts.test.mjs
```

覆盖：`--help`、拒绝未知阶段、把 `migrate`/`seed`/`reset` 当未知阶段拒绝、
注入式库名（7 种变体）、`--rollback-selftest` 用在生产库上被拒、系统库/模板库守卫、
**非终端下拒绝写操作**、dry-run 不需要连得上库、生成的流带 BEGIN/COMMIT 与五个文件标记、
`SET ROLE` 出现在 `04` 之前、**生成的流里没有 ESC 字节**、
源码里不存在执行三个禁用命令的语句、`setup-credentials.sh` 不接受命令行口令、
生成的文件不含任何 `ENABLE_MOCK_` 开关、`urlencode` 对会破坏连接串的字符处理正确
（从**真实脚本里抽出来**测，不是抄一份副本）。

需要真实集群的用例默认跳过，用 `PG_DEPLOY_SH_VERIFY=1` 打开：

```bash
PG_DEPLOY_SH_VERIFY=1 PG_DEPLOY_DB=postgres \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --env-file-if-exists=.env --test tests/deployScripts.test.mjs
```

- 这组用例**会真的跑 `init`**，但一律带 `--rollback-selftest`（事务以 `ROLLBACK` 结束），
  并且逐个断言五个 `[0N] 自检通过` 都出现了、且执行前后集群状态**逐字节相同**。
- `PG_DEPLOY_DB` 指向 `chaoge_prod` 会在**模块加载期直接抛错**，不会跑起来再拦。
- 非终端用例总是走管道喂标准输入，**刻意复现无人值守的形态**——
  这正是 `init` 必须拒绝的那条路径。
