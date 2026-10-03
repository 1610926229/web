# PROD-1A Delivery

Status: AWAITING_ACCEPTANCE
Development Completed At: 2026-10-03

> ⚠️ 本文件里所有数字与命令输出均为**本机真实执行结果**，没有转述、没有推算。
> 凡未运行的，一律写明「未运行」。

---

# 一、Implemented

## 1.1 数据库结构（`db/migrations/`）

版本化 SQL 迁移，**文件里一律不写 `CREATE TABLE IF NOT EXISTS`**（有一条测试扫源码守着）。

| 迁移 | 表 | 关键结构 |
|---|---|---|
| `0001_favorites.sql` | `favorites` | `id text COLLATE "C"` 主键；`user_id` / `product_id` / `created_at timestamptz`；`CONSTRAINT favorites_user_product_key UNIQUE (user_id, product_id)`；索引 `favorites_user_created_idx (user_id, created_at DESC, id DESC)` |
| `0002_suggestions.sql` | `suggestions` | `id text COLLATE "C"` 主键；`contact text NOT NULL DEFAULT ''`；`evidence jsonb NOT NULL DEFAULT '[]'`；`reply text NOT NULL DEFAULT ''`；`replied_at timestamptz`（可空）；`created_at timestamptz NOT NULL`；**`idempotency_key text`（可空）**；`CONSTRAINT suggestions_user_idempotency_key UNIQUE (user_id, idempotency_key)`；索引 `suggestions_user_created_idx` |

两处结构选择值得记下来：

- **`COLLATE "C"`**：让 `id` 的排序与比较**不受服务器 locale 影响**，从而与 JS 的字符串比较
  给出同一个顺序。分页 tie-break（时间相同再看 id）因此跨实现一致。
- **`suggestions.idempotency_key` 可空**：这不是随手写的。Mock 的 `createStore()` 从不把预置数据
  放进 `suggestionIdByKey` 索引里，于是「用任何幂等键都查不到一条预置反馈」是**既有语义**。
  PostgreSQL 的 `UNIQUE` 默认 `NULLS DISTINCT`，把键留成 `NULL` 恰好精确复刻这个语义——
  契约对照测试里有专门一格验它。

## 1.2 PostgreSQL 基础层（`lib/data/pg/`，10 个模块，**仅服务端**）

| 文件 | 职责 |
|---|---|
| `config.ts` | 读 `DATABASE_URL` / `DATA_SOURCE`；**脱敏**（`redactDatabaseUrl`，密码→`***`）；`assertTestDatabase`（库名必须以 `_test` 结尾，**看的是实际要连的库**）；`assertSeedAllowed` / `assertResetAllowed`（生产拒绝） |
| `pool.ts` | 连接池**单例**；模块级注册 `TIMESTAMPTZ(1184) → ISO 字符串`；**刻意不注册** `timestamp`(1114)；`idle` 连接出错时不崩进程 |
| `executor.ts` | `PgQueryable` / `TxHandle` / `PgExecutor` 三个类型；`withTransaction(tx => …)` 的**唯一**入口；`lazyPgExecutor()` 保证仓储模块**加载期零副作用** |
| `migrate.ts` | 迁移运行器；记账表 `schema_migrations`；`pg_advisory_xact_lock` 互斥；checksum 校验；每条迁移各自一个事务 |
| `seed.ts` | 预置数据写入（`assertSeedAllowed` 先行）；`assertSeedFixtures()` 先校验 fixtures 自身无重复 |
| `reset.ts` | `resetDatabase`（`TRUNCATE … RESTART IDENTITY CASCADE`，**保留**记账表）；`dropDatabaseObjects`（连记账表一起删，**仅供迁移测试**）；表名从 `pg_tables` **读**而非硬编码 |
| `health.ts` | 探活，**从不抛错**；报库名 / 版本 / 延迟 / 脱敏端点 / 迁移进度 |
| `cli.ts` | `db:migrate` / `db:seed` / `db:reset` / `db:health`，`--target=app\|test` |
| `favoriteRepository.ts` | 竖切片实现；`createFavoriteRepository(db: PgQueryable)` 工厂 |
| `suggestionRepository.ts` | 同上 |

## 1.3 数据源切换（唯一的切换点）

`lib/data/favoriteRepository.ts` 与 `lib/data/suggestionRepository.ts` 的 accessor：

```ts
export function getFavoriteRepository(): FavoriteRepository {
  return isPostgresDataSourceEnabled() ? pgFavoriteRepository : mockFavoriteRepository;
}
```

**默认仍是 Mock**（`DATA_SOURCE` 不设即为 Mock），因此本轮的引入**没有改变任何既有行为**。

## 1.4 运维命令与配置

- `package.json` 新增 `test:pg` 与 `db:migrate` / `db:seed` / `db:reset` / `db:health`。
  依赖只增加了 `pg@^8.23.1`。
- `.env.example` 新增 `DATA_SOURCE` / `DATABASE_URL` / `TEST_DATABASE_URL` / `PG_POOL_MAX` /
  `PG_MIGRATIONS_DIR`，并写明两道破坏性守卫**不可通过配置绕过**。**不含任何真实凭据。**

## 1.5 清理

删除 `prisma7.config.ts` 与 `prisma/`（**经用户明确授权**，见 `02-decisions.md` `Q4`）。
两者均**从未进入版本库**；删除前 `pnpm build` 与 `pnpm typecheck` 因它们恒红。

---

# 二、Files Changed

## 2.1 新增（本轮）

```
db/migrations/0001_favorites.sql
db/migrations/0002_suggestions.sql

lib/data/pg/config.ts
lib/data/pg/pool.ts
lib/data/pg/executor.ts
lib/data/pg/migrate.ts
lib/data/pg/seed.ts
lib/data/pg/reset.ts
lib/data/pg/health.ts
lib/data/pg/cli.ts
lib/data/pg/favoriteRepository.ts
lib/data/pg/suggestionRepository.ts

tests/pgConfig.test.mjs
tests/pgFoundation.test.mjs
tests/pgContract.test.mjs
```

## 2.2 修改（本轮）

```
lib/data/favoriteRepository.ts          accessor 改为按数据源二选一 + 文档字符串更新
lib/data/suggestionRepository.ts        同上
package.json                            新增 5 个 script；新增依赖 pg
pnpm-workspace.yaml                     把残留的 Prisma allowBuilds 占位串还原为 HEAD 状态
.gitignore                              移除被追加的 /app/generated/prisma
.env.example                            新增数据库相关变量与守卫说明
docs/02-tech-design/architecture-rules.md   §2.4 两种仓储形态；§2.5 收窄伪事务适用范围；§7.2 裁定行
docs/02-tech-design/tech-stack.md           §十 依赖表；§十一 裁定行；新增 §11.1
docs/02-tech-design/database-schema.md      头部、Mock store 计数、TBD 行、C8 裁定、C10、TD-1
docs/02-tech-design/directory-structure.md  顶层加 db/；§4.3 加 pg/ 与迁移清单；§8.2、§8.3
docs/03-dev/总需求进度表.md                  新增 PROD-1A 行；新增「全量迁移未完成」阻塞项；Scheduler 行补关联
```

## 2.3 删除（经授权）

```
prisma7.config.ts       （未被 git 跟踪）
prisma/schema.prisma    （未被 git 跟踪）
```

## ⚠️ 2.4 关于工作区状态的声明

**本轮开工时工作区已经是不干净的。** 它带着此前几轮（P1-6 / P1-7 / P1-8）的未提交内容：
**65 个已修改的受跟踪文件**，以及大量未跟踪目录（`app/admin/(console)/reviews/`、
`components/mine/BossStats*`、`lib/services/bossStats.ts`、`docs/03-dev/rounds/P1-7/`、
`docs/03-dev/rounds/P1-8/` 等）。

按 `development-workflow.md` §二十「开工前先检查工作区，发现上一批未提交内容先报告，
不要偷偷吸收到下一批」——此处如实报告：**上面 2.2 的清单只列本轮真正碰过的文件。**
请勿把整份工作区 diff 当作 PROD-1A 的交付范围。

---

# 三、Business Rules Implemented

**本轮不新增任何业务规则**，也不触碰任何业务状态机。这一点是竖切片挑选判据的直接结果
（见 `02-decisions.md` `Q2`）。

本轮落地的全是**技术约束**，其中四条会成为后续所有波次的长期规则，已同步进 `docs/02-tech-design/`：

| 约束 | 落点 |
|---|---|
| `pg` 只允许出现在 `lib/data/pg/**`；切换点只有 accessor 一处 | `tech-stack.md` §11.1，由测试扫源码强制 |
| 结构变更只有版本化迁移一条路 | `tech-stack.md` §11.1、`directory-structure.md` §4.3 |
| **禁止半 PostgreSQL 半 Mock**；active datasource 切换须事务闭包完整 | `tech-stack.md` §11.1、`architecture-rules.md` §2.5 |
| 时间列一律 `timestamptz`，驱动层统一转 ISO | `database-schema.md` C8 |

---

# 四、Tests Added / Updated

全部为**新增**文件，未修改任何既有测试的断言。

| 文件 | 条数 | 是否需要真库 | 覆盖 |
|---|---|---|---|
| `tests/pgConfig.test.mjs` | **17** | ❌ **不需要** | 守卫与静态性质 |
| `tests/pgFoundation.test.mjs` | **25** | ✅ | 6 组矩阵 |
| `tests/pgContract.test.mjs` | **6** | ✅ | Mock ↔ Pg 契约等价 |

## 4.1 为什么 `pgConfig.test.mjs` 必须与真库用例分开

守卫（生产拒 seed/reset、非测试库拒 reset）是**安全性质**，而真库用例在没配
`TEST_DATABASE_URL` 时会整体跳过——**跳过它们等于没有它们**。
所以这 17 条待在一个**无条件执行**的文件里，且在 `pnpm test`（不起服务器、不加载 `.env`）中照样跑。

其中两条的写法值得单独说明：`resetDatabase` 的两个拒绝用例传入一个
**「一旦被调用就抛错」的执行器**，于是它们证明的不只是「抛了错」，而是
「**守卫是在碰数据库之前拦下的**」。

## 4.2 六组矩阵的对应关系（Scope 第 16 项要求的证据）

| 组 | 关键用例 |
|---|---|
| Connection | 库不可达 → 脱敏错误（有 host:port、无密码），`checkDatabaseHealth` 与 `migrate` 两条路径都验；「连得上但没迁移」报 `{applied: 0, pending: 2}` |
| Migration | 空库 → `["0001","0002"]` 且表为 `["favorites","schema_migrations","suggestions"]`；重跑 `applied: []` / `skipped: ["0001","0002"]`；checksum 篡改 → 报错；**临时迁移目录里放一条坏 SQL → DDL 整体回滚**；两个并发 `migrate()` 各条只执行一次 |
| Transaction | 提交 → 写入全在；中途抛错 → **全部**回滚；事务内 `pg_backend_pid()` **等于** `tx.connectionId`；两个并发事务拿到不同 connectionId；回滚后连接仍可用 |
| Constraint | 绕过仓储直插重复行 → SQLSTATE `23505` + 约束名 `favorites_user_product_key`；**8 路并发 `addFavorite` 各带自己的 id → 恰好 1 行、恰好 1 个 `created:true`、8 个返回值指向同一条 id**；冲突后能读回既有记录；取消后可重新收藏；**8 路并发 `createSuggestion` 同键 → 1 行**；预置反馈用任何键都查不到 |
| Seed | 条数与 fixtures 一致；重跑全部跳过；**reset+reseed 两次快照 deep-equal**；ISO 时间往返**逐字节相同** |
| Compatibility | `DATA_SOURCE=postgres` 选到 Pg 实现且接口齐全；`createFavoriteRepository(tx)` 与 `pgFavoriteRepository` 共享**同一个提交点**；池是进程单例 |

## 4.3 `pgContract.test.mjs` 的做法：对称断言 + 一条反向用例

这 6 条**不写两套断言**。它把要观察的东西写成一段「快照函数」，
拿**同一个函数**分别去问 Mock 与 Pg，然后 `deepEqual` 两份结果。
断言因此是对称的——不偏向任何实现，也不会出现「只给 Pg 写了断言」。

最后一条是**反向**用例：人为把 Pg 实现的页大小改掉，确认比对**确实会红**。
没有它，「两个实现结果相同」有可能只是因为断言太松。

**⚠️ 这一条在编写过程中真的抓到了作者自己的 bug**：`assertSameObservation` 起初把收藏的
两个实现**硬编码在函数体里**，于是反馈那一格实际上拿收藏仓储去调 `querySuggestions`——
两边一起抛 `is not a function`，`deepEqual` 反而**通过**了（比对两个错误）。
修法是让实现**成对传参、不设默认值**，并在比对前先断言两个实现暴露**同一组方法**。

---

# 五、Verification

## 5.1 全量门禁（本机真实输出）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm lint` | **exit 0，0 problems** |
| 2 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | **exit 0** |
| 3 | `pnpm build` | **exit 0** |
| 4 | `pnpm test`（不起服务器） | **1915 total / 1701 pass / 0 fail / 214 skipped** |
| 5 | 生产 `APP_BASE_URL` + 测试库全量 | **1915 total / 1915 pass / 0 fail / 0 skipped** |
| 6 | `pnpm test:pg` | **48 total / 48 pass / 0 fail / 0 skipped** |

第 5 条用的命令（生产构建 + 真测试库，跳过归零）：

```bash
PORT=3100 npx next start -p 3100
APP_BASE_URL=http://127.0.0.1:3100 \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env \
       --import ./tests/alias-hook.mjs --test-concurrency=1 --test "tests/*.test.mjs"
```

第 4 条里那 214 条跳过中，**31 条**正是两组真库用例（`pnpm test` 不加载 `.env`，
因此 `TEST_DATABASE_URL` 不可见）——它们由第 5、6 条覆盖，不是未验证。

### 5.1.1 门禁过程中的两次红→绿（如实记录）

| 红 | 原因 | 处置 |
|---|---|---|
| `pnpm build` / `pnpm typecheck` | `prisma7.config.ts` 找不到 `prisma/config` | **经用户授权删除**该残留（见 `Q4`） |
| `pnpm test` | P0-15 禁用词门禁命中本轮的 `MIGRATION_LEDGER_TABLE` | **改本轮命名**，未动断言（见 `D8`） |

`pnpm lint` 在第一次运行时另有 **3 条 warning**（全部由本轮引入：`cli.ts` 未使用的 `target`
参数、`migrate.ts` 未使用的解构变量、`pgFoundation.test.mjs` 未使用的 import）。
已全部清理：前两条删除多余形参/变量；第三条不是删 import，而是**补上对称的反馈侧事务内用例**
（原先只验了收藏，两个竖切片实体的「换执行者不换接口」应当都验）。

## 5.2 运维命令实跑（不是「应该能跑」）

| 命令 | 实测结果 |
|---|---|
| `pnpm db:health --target=test` | `数据库可用：chaoge_esports_test（PostgreSQL 18.6，67ms）｜迁移 2 条已执行 / 0 条待执行`，连接串**已脱敏**（`postgres:***@…`） |
| `pnpm db:migrate --target=test` | `本次执行 0 条，跳过 2 条`（幂等） |
| `pnpm db:reset --target=app` | **被参数解析拒绝**，exit 1（打印用法） |
| `NODE_ENV=production pnpm db:reset --target=test` | **被拒绝**，exit 1：`生产环境不允许清空数据（reset）` |
| `NODE_ENV=production pnpm db:seed --target=test` | **被拒绝**，exit 1：`生产环境不允许写入预置数据（seed）` |
| `TEST_DATABASE_URL=…chaoge_esports_dev pnpm db:reset --target=test` | **被拒绝**，exit 1：`库名不以 _test 结尾` |

## 5.3 收尾纪律

生产服务器以 `npx next start -p 3100` 起在后台。测试结束后按纪律收口：
`netstat -ano | grep :3100` 取到监听 PID → `taskkill //PID <pid> //F` → **再查一次确认**：
端口已无 `LISTENING`（仅剩客户端侧 `TIME_WAIT`），`curl` 探活返回 `000`（连不上）。
**不依赖「命令返回成功」来判断服务器已停。**

---

# 六、Known Limitations

1. **绝大多数业务数据仍不持久化。** 只有 `favorite` 与 `suggestion` 有真实表；
   其余 **26 个仓储**仍在 `globalThis` Mock store 里，**进程重启即清空**。
   ⚠️ **不得把本轮交付读成「已经有数据库了」。** 已登记为 `🔴 PRODUCTION_BLOCKER`。
2. **未接入任何业务链。** 运行时的 `DATA_SOURCE` 默认仍是 Mock，因此本轮**没有改变任何线上行为**。
3. **未做真并发压测。** 「8 路并发」是 `Promise.all` 起的 8 个并发请求，
   用来证明「不靠先查再插」这件事已经足够，但它**不是**性能测试。
4. **未验证连接池在长时间空闲后的重连行为。** 只配了 `idle` 出错时不崩进程，
   没有做「库重启后自动恢复」的验证。
5. **`schema_migrations` 的 checksum 只覆盖 SQL 文本**，不覆盖「这条迁移是否被人为跳过的执行顺序」。
6. **`*Repository.ts` 里仍有 26 个只有 Mock 实现的仓储**，它们与本轮新增的两种形态共存——
   这是预期的中间状态，但会让 grep「仓储怎么写的」得到两种答案。

---

# 七、Out Of Scope

按指令明确不做：

- 全量迁移其余 26 个仓储；微信 OAuth；微信支付；提现；Redis；Docker 强制化；**ORM**；
  调度器正式实现。
- 惰性 sweep / 真实 Scheduler：**本轮不新增该阻塞，也不解决它**——它继续登记在
  `总需求进度表.md` 的 `🔴 PRODUCTION_BLOCKER` 行与 `database-schema.md` TD-1，
  本轮只是让它的落地位置从「无处安放」变成「有 `withTransaction` 可用」。

---

# 八、Project Progress Change

- `总需求进度表.md` 新增 `PROD-1A` 行，状态 `🟣 AWAITING_ACCEPTANCE`。
  **未写 ✅**——按协议 §十八，只有 Round 真正 `DONE` 之后才能标完成。
- 新增一条 `🔴 PRODUCTION_BLOCKER`：**PostgreSQL 全量迁移 — 其余 26 个仓储尚未迁入**。
- 已有 `🔴 PRODUCTION_BLOCKER`（真实 Scheduler）**状态不变**，补充了与 PROD-1A 的关联说明。
- `docs/02-tech-design/` 四处文档的选型 TBD **全部关闭**（`PostgreSQL` + `pg` + 无 ORM +
  版本化迁移 + `timestamptz`/ISO）。

---

# 九、Recommended Commit

> **Claude 不执行 Git 写操作**（协议 §二十）。以下仅供用户参考。

```
feat(prod-1a): PostgreSQL 基础层 + 竖切片（收藏 / 反馈）

数据库选型落地为 PostgreSQL + node-postgres(pg)，不使用 ORM，结构变更走版本化
SQL 迁移文件。

新增：
- db/migrations/0001_favorites.sql / 0002_suggestions.sql
- lib/data/pg/{config,pool,executor,migrate,seed,reset,health,cli}.ts
- lib/data/pg/{favorite,suggestion}Repository.ts（竖切片，PgQueryable 工厂）
- tests/pg{Config,Foundation,Contract}.test.mjs（17 + 25 + 6）

改动：
- favorite / suggestion 的 accessor 按 DATA_SOURCE 二选一（默认仍 Mock）
- .env.example 新增数据库变量；package.json 新增 db:* 与 test:pg
- docs/02-tech-design 四处文档关闭选型 TBD；总需求进度表登记 PROD-1A

约束（写入 tech-stack.md §11.1）：
- pg 只允许出现在 lib/data/pg/**，切换点只有 accessor 一处
- 结构变更只有版本化迁移一条路，禁止运行时 CREATE TABLE IF NOT EXISTS
- 禁止半 PostgreSQL 半 Mock：active datasource 的切换须事务闭包完整
- 时间列一律 timestamptz，驱动层统一转 ISO

说明：本轮不做全量迁移，绝大多数业务数据仍在内存里，已登记为生产阻塞项。
```
