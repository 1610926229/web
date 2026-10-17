# PROD-1A Decisions

> 本文件是本轮**唯一**的口径来源。开头一节是 Requirement Check 的结论，
> 其后是真正需要产品负责人裁定的问题（`Q*`），以及**开发者自行决定、不属于提问范围**的
> 实现细节（`D*`）。两者分开，是为了让将来回看时知道**哪些是问出来的、哪些是自己定的**。

---

# 〇、Requirement Check（12 项）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 产品规则是否完整 | **不适用**——本轮不新增业务规则，只建数据访问基础设施 |
| 2 | 前置状态是否明确 | ✅ 全部不涉及 |
| 3 | 成功状态是否明确 | ✅ 不涉及 |
| 4 | 失败状态是否明确 | ✅ 「连不上库 / 迁移失败 / 唯一冲突 / 回滚」四类失败状态在 16 项 Scope 里逐条写明 |
| 5 | 权限是否明确 | ✅ 本轮不新增任何 HTTP 入口；破坏性操作**只有命令行与测试进程**能调用 |
| 6 | 金额是否明确 | ✅ **完全不涉及金额**——这正是竖切片挑选判据里「不参与跨域资金事务」那一条的意义 |
| 7 | 幂等是否明确 | ✅ 三条：迁移重复执行幂等、seed 幂等、`addFavorite` / `createSuggestion` 的业务幂等 |
| 8 | 并发是否明确 | ✅ 本轮**以并发为核心验收项**：8 路并发写同一业务键只能得到 1 行 |
| 9 | 通知是否明确 | ✅ 不涉及 |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ⚠️ 有——见 `Q1`/`Q3`，均已在本轮由产品负责人裁定并同步长期文档 |
| 11 | 与现有架构规范是否冲突 | ⚠️ 有一处**表述**冲突：`architecture-rules.md` §2.4 的「全仓 23 个仓储同一形态」在本轮之后不再成立（数字也早已过期）。**已同步更新**，见 `D9` |
| 12 | 是否与已有业务代码事实冲突 | ⚠️ 有一处**真冲突**：P0-15 的禁用词门禁在 `lib/**` 禁 `/ledger/i`，本轮原先的命名撞上它。见 `D8` |

**结论**：无「必须先问才能开工」的架构阻塞（`Q1` 与 `Q3` 是**选型落定前**遗留的 TBD，
在本轮开工时已有裁定）。因此按指令 `直接实现 PROD-1A`。

---

# 一、需要产品负责人裁定的问题

## Q1

Status: RESOLVED

### Claude Question

数据库与数据访问方式选型。旧文档在 `architecture-rules.md` §7.2、`tech-stack.md` §十一、
`database-schema.md` 头部与 §三 多处逐字写着
`**数据库选型（PostgreSQL / MySQL）与 ORM 选型（Prisma / Drizzle）均未确认，禁止自行选定。**`

### Why This Is Blocking

选型不同会改变：数据访问层的全部实现形态、事务语义的表达方式、迁移工具链、
以及**未来所有 Round 的落点规则**。这是长期架构，不是实现细节。

### Affected Areas

- `lib/data/**`（新的 `pg/` 子层）
- `db/migrations/**`（新增）
- `package.json` / `pnpm-workspace.yaml`
- `docs/02-tech-design/{architecture-rules,tech-stack,database-schema,directory-structure}.md`
- 测试：契约对照、并发、守卫

### Known Facts

- 项目**已有**稳定的 Repository 接口层（28 个仓储，接口 + Mock 实现分离）；
- 核心难点是**跨实体数据库事务**，不是 CRUD 生成；
- 现有并发正确性靠**伪事务惯用法**（Node 单线程 + 原子区段内无 `await`），
  该惯用法在真实数据库下**必然失效**（每次查询都是 `await`）。

### Remaining Decision

选哪个数据库、用不用 ORM、结构变更怎么管。

### User Answer

> 「**数据库** — 正式选择：`PostgreSQL`。MySQL 不再作为本项目当前候选。」
> 「**数据访问** — 使用：`node-postgres (pg)`。不使用 ORM。」
> 「**Migration** — 使用：`versioned SQL migration files`。不要使用运行时
> `CREATE TABLE IF NOT EXISTS` 代替正式 migration。」

不用 ORM 的五条理由（用户逐条给出）：已有 Repository 接口层 / DB 实现只是「再加一个实现」/
核心难点是跨实体事务而非 CRUD 生成 / 原生 SQL 让事务与约束语义显式 /
避免在基本能跑的项目上叠 schema-DSL-生成器三层抽象。

### Final Execution Rule

1. 数据库 = `PostgreSQL`。驱动 = `pg`（`node-postgres`）。**不引入任何 ORM。**
2. 结构变更**只有一条路**：`db/migrations/<版本号>_<名字>.sql` + 迁移记账表。
   **禁止**用运行时 `CREATE TABLE IF NOT EXISTS` 代替正式迁移。
   唯一例外是迁移运行器**自己引导**建记账表（`lib/data/pg/migrate.ts` 的 `ensureMigrationTable`），
   理由仅此一条：「记账表已存在」是正常状态，不是异常。
3. `pg` **只允许**出现在 `lib/data/pg/**`。`lib/services/**` 与 `app/**` 不得 `import "pg"`、
   不得引 `lib/data/pg`、不得自行读 `DATA_SOURCE`。**切换点只有 `lib/data/*Repository.ts` 的 accessor 一处。**
   由 `tests/pgConfig.test.mjs` 扫源码强制。
4. `.env.example` 必须登记新变量，且**不得**包含任何真实凭据。

## Q2

Status: RESOLVED

### Claude Question

竖切片选哪 1~2 个仓储。

### Why This Is Blocking

选错了会让「基础层对不对」与「业务逻辑对不对」两件事混在一起，出问题无法归因；
若选了参与跨域资金事务的实体，还会直接踩到本轮自己立的迁移纪律。

### Known Facts

- 已扫过全部 16 个 `*Transaction.ts` + `adminWriteSupport` + `orderBlocking` + `mockSource`：
  `favorite` 与 `suggestion` **零命中**——它们不参与任何跨域事务；
- 只有 `lib/services/favorites.ts` 与 `lib/services/suggestions.ts` 调用这两个 accessor，
  且都是**每请求调用**，不存在模块加载期副作用；
- 两者都有真实读写、都有天然的**业务唯一键**：
  `favorite` = `(userId, productId)`，`suggestion` = `(userId, idempotencyKey)`。

### User Answer

> 「选择『不参与复杂跨域资金事务；有真实 read + write；能验证唯一约束；
> 能验证 Repository interface；不会因为只迁它就产生业务半持久化』的 1~2 个实体。
> **不要为了方便直接选最复杂的 payment/refund。**」

### Final Execution Rule

竖切片 = `favorite` + `suggestion`，两条判据逐条对得上：

| 判据 | favorite | suggestion |
|---|---|---|
| 不参与复杂跨域资金事务 | ✅ 零命中 | ✅ 零命中 |
| 有真实 read + write | ✅ 列表 / 单查 / 新增 / 取消 | ✅ 列表 / 按幂等键查 / 新建 |
| 能验证唯一约束 | ✅ `(user_id, product_id)` | ✅ `(user_id, idempotency_key)` |
| 能验证 Repository 接口 | ✅ | ✅ |
| 只迁它不产生业务半持久化 | ✅ 不参与事务 | ✅ 不参与事务 |

**Mock 实现一律保留**（`D7`）。

## Q3

Status: RESOLVED

### Claude Question

时间列用什么类型、时区策略是什么。`database-schema.md` C8 原文：

> 「当前所有时间字段都是 `string`（ISO 8601），不是 `Date`。⚠️ 迁移时需决定：是继续用字符串，
> 还是改用数据库原生时间类型。⚠️ **时区策略未确认**——属 TBD。」

### Why This Is Blocking

全仓的时间字段都是 ISO 字符串，且**代码里存在字符串字典序比较**（`a.createdAt > b.createdAt`
的排序与分页 tie-break）。若读出来变成 `Date` 对象，那些比较会静默变成另一种语义；
若列类型无时区，同一时刻的两条记录可能比较不等。

### Affected Areas

- `db/migrations/**` 的列类型
- `lib/data/pg/pool.ts` 的类型解析注册
- 全部涉及时间排序的仓储方法
- `database-schema.md` C8

### Known Facts

- `pg` 默认把 `timestamptz`（OID 1184）解析成 JS `Date`；
- ISO 8601 在 UTC（`Z`）下的**字典序等于时间序**；
- 本机 PostgreSQL 18.6，服务器 TimeZone `Asia/Shanghai`。

### User Answer

> 「**`timestamptz` + 驱动层统一转 ISO**」——列类型 `timestamptz`（内部存 UTC）；
> 在 `lib/data/pg` 初始化处用 `pg.types.setTypeParser` 把 `1184` 全局改成返回 ISO 字符串；
> 仓储边界**零改动**、字符串字典序比较原样成立；代价是一次模块级全局覆盖。

### Final Execution Rule

1. 所有时间列**一律** `timestamptz`。**不是** `timestamp`，**不是** `text`。
2. `lib/data/pg/pool.ts` 模块级注册一次：
   `types.setTypeParser(types.builtins.TIMESTAMPTZ, v => new Date(v).toISOString())`。
3. **刻意不注册** `timestamp`（OID 1114）。于是误用无时区列时，读出来会是 `Date` 对象
   而非字符串，`string` 声明与排序会立刻炸掉。**这是特性**：宁可让错误的列类型大声失败。
4. `database-schema.md` C8 从 TBD 改为已裁定，并记录上面的机制与代价。

---

# 二、开发者自行决定（**不属于提问范围**）

以下都是 `development-workflow.md` §八 明列的「必须自己解决」类问题，
记录在此是为了让将来回看时知道**这些不是产品裁定，而是实现选择**，可以被后续 Round 修订。

## D1. 连接池：单池，不用「按 target 建两个池」

**决定**：进程内**一个**池，由 `DATABASE_URL` 唯一决定连哪。`--target=test` 做的唯一一件事是
`process.env["DATABASE_URL"] = requireTestDatabaseUrl()`。

**理由**：如果允许「app 池 + test 池」并存，就永远存在「这条语句打到了哪个库」的推理成本，
而这恰恰是最难查的一类测试污染。收敛成一次赋值之后，「连的是哪个库」只有一个答案。

**代价**：`--target=test` 会**修改进程环境变量**。这是有意的——它就是那次切换本身。

## D2. `withTransaction` 的抽象形状

**决定**：

```ts
type PgQueryable = { query<T>(text: string, values?: readonly unknown[]): Promise<T[]> };
type TxHandle    = PgQueryable & { readonly connectionId: number };
type PgExecutor  = PgQueryable & { withTransaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> };
```

`TxHandle` **也是** `PgQueryable`，所以「同一个仓储工厂既能接受池、也能接受事务句柄」
不需要任何类型体操——`createFavoriteRepository(db: PgQueryable)` 同时接受两者。
这正是 Scope 第 15 项要证的「普通仓储与事务内仓储复用同一接口」。

`connectionId` 取自运行时的 `client.processID`（`@types/pg` **未声明**该属性，
用一次收窄断言读取，读不到给 `-1`）。它的用途是**在测试里**证明「同一事务的多条语句确实走同一条连接」。

**回滚失败的处理**：`ROLLBACK` 自身失败时销毁该连接，但**重新抛出原始错误**——
不要让「回滚也失败了」把真正的失败原因盖掉。

## D3. 记账表由运行器引导创建，且在**咨询锁事务内**

**决定**：`migrate()` 与 `appliedVersions()` 都在 `pg_advisory_xact_lock` **之内**引导记账表。

**理由**：`CREATE TABLE IF NOT EXISTS` 并不是原子的。两个会话同时判断「不存在」、双双去建，
其中一个会撞上系统目录的唯一索引（`duplicate key value violates … pg_type_typname_nsp_index`）。
部署时并行跑两次 migrate、或开发机上两个终端同时敲，都会碰上。

**这不是推测出来的**——是**写并发迁移用例时先把它当成失败的测试**，再回生产代码修掉它。
`tests/pgFoundation.test.mjs` 有「两个并发 `migrate()` 各条迁移只执行一次」的用例守着。

## D4. 已执行迁移的 checksum 不可篡改

**决定**：记账表存 SQL 内容的 sha256（**先把 `\r\n` 归一化成 `\n`** 再算），
且 `migrate()` 在**执行任何一条之前**先整体校验全部已执行项的 checksum。

**理由**：迁移文件是历史，改一个字就应该报错，而不是让两个库各自跑出不同结构却都显示「已迁移到最新」。
换行归一化是必需的——否则同一个文件在 Windows（CRLF）与 Linux（LF）上 checksum 不同。

## D5. 迁移顺序按**版本号数字**排序，不按字符串

**决定**：`Number.parseInt(a.version, 10) - Number.parseInt(b.version, 10)`。

**理由**：`0010` 与 `0009` 在两种排法下一致，但 `10` 与 `9` 不一致；
而文件名宽度是**人的约定**，不是代码能强制的东西。按数字排对它免疫。
另：`.sql` 但不符合 `<版本号>_<名字>.sql` 的文件**一律报错**——
静默跳过一条拼错文件名的迁移，是那种「所有检查都显示正常」的故障。

## D6. `seed` 用**不带目标**的 `ON CONFLICT DO NOTHING`

**决定**：`INSERT … ON CONFLICT DO NOTHING RETURNING id`（不写冲突目标列）。

**理由**（一条真实的踩坑记录）：最初写的是 `ON CONFLICT (user_id, idempotency_key) DO NOTHING`。
第二次 `db:seed` 直接抛 `重复键违反唯一约束"suggestions_pkey"`。
原因是 PostgreSQL 把 `NULL` 视为互不相等：`suggestions.idempotency_key` 是**可空**的
（预置数据不带幂等键），于是那条 INSERT **根本没走到冲突分支**，直接插进去撞了主键。
不带目标的 `ON CONFLICT DO NOTHING` 才能接住这种情况。

**配套**：加 `assertSeedFixtures()`，在**插入之前**校验 fixtures 自身没有重复 id、
没有重复 `(userId, productId)`。真正的数据错误仍然大声报错，而不是被 `DO NOTHING` 吞掉。

## D7. Mock 实现**不删**

**决定**：`favorite` 与 `suggestion` 的 Mock 实现原样保留，是 `DATA_SOURCE` 未设为 `postgres` 时的默认路径。

**理由**：三条。① 它是契约对照测试的一半（没有 Mock 就没有对照）；② 迁移纪律要求
「事务闭包完整之前 Mock 仍可以是 active datasource」；③ 删掉它会把「切换数据源」变成
单向不可逆操作，而本轮只是打通路径。

## D8. 「账本」命名撞上 P0-15 禁用词门禁 → **改我自己的命名**

**冲突事实**：`tests/earningSettlementFreeze.test.mjs` 扫描 `lib/**`（剥注释后），
对 `/ledger/i` 判定为禁用词，理由列是「账本 / 台账（英文）」——它守的是
「**不得引入钱包 / 负余额 / 追偿 / 未来收益抵扣体系**」这条 P0-15 业务裁定。

**本轮的命名** `MIGRATION_LEDGER_TABLE` / `ensureLedger` 撞上了它，`pnpm test` 因此变红。

**决定**：**改本轮的命名**，改为 `MIGRATION_TABLE` / `ensureMigrationTable`。
**未删除断言、未 `skip`、未放宽业务要求。**

**为什么不让门禁放行**：那条门禁是**故意做成钝器**的——测试注释自己写着，
宁可将来误伤无关缩写，「那正是应该停下来重新裁定这条门禁的时刻，而不是让它静默放行的时刻」。
我这边的「迁移记账表」与它守的「钱包账本」是两个概念，但**这正是应该由我让步的场合**：
改一个标识符的成本，远低于让一条安全门禁从此开始收窄词表。

**顺带修掉一处真问题**：`reset.ts` 原先自己又写了一遍 `"schema_migrations"` 字面量。
那条「名字只有一个来源」的测试当时**照样是绿的**（它只断言常量等于某个字符串）。
已改为从 `migrate.ts` import，并把该测试改成**真的扫源码**：
除定义处外任何模块再写这个字面量即失败。

## D9. 同步既有文档中已被本轮推翻的表述

**决定**：本轮同时修正 `docs/02-tech-design/**` 里与本轮结论矛盾的表述，包括：

| 位置 | 原表述 | 修正为 |
|---|---|---|
| `architecture-rules.md` §2.4 | 「全仓 **23** 个仓储同一形态」 | 28 个，且**两种形态**（26 仅 Mock + 2 双实现） |
| `architecture-rules.md` §2.5 | 「伪事务 ⚠️ 仅 Mock 阶段成立」 | 适用范围**正在缩小但今天仍覆盖全部 16 个事务文件**；并写明「禁止半 PostgreSQL 半 Mock」 |
| `database-schema.md` | 「**当前项目没有数据库**，也没有 ORM」 | 已开始迁移；**并点名只有 2 个实体有真实表**，其余仍未迁 |
| `database-schema.md` | 「26 个 Mock store，26 个仓储」 | 28 / 28（P1-5 与 P1-7 各加了一个域，计数早已过期） |
| `directory-structure.md` §4.3 | 无 `pg/` 子层 | 补全 `pg/` 逐个文件的职责 + 迁移一个实体的四步清单与那条**门槛** |
| `tech-stack.md` §11.1 | 无 | 新增：不用 ORM 的理由 + 三条结构性约束 |

**理由**：`docs/02-tech-design/` 是架构语义的唯一真值源，而 `development-workflow.md` §十三
明确 **`docs/02-tech-design/` 排在「现有代码行为」之上**——现状不是规范。
让文档继续停留在「没有数据库」的状态，会让下一个会话按错误的前提规划。

**⚠️ 历史轮次档案（`docs/03-dev/rounds/**`）一律不改写。** 那里出现「本项目没有数据库」是正确的
历史记录，按协议 §十九 保留。

---

# 三、本轮唯一一次「非架构但必须请示」的事项

## Q4

Status: RESOLVED

### Claude Question

工作区里存在两个**未被 git 跟踪**的残留文件：`prisma7.config.ts` 与 `prisma/schema.prisma`，
来自上一段会话中一次**已被否决的 Prisma 尝试**（时间戳同属那次会话）。
它们使 `pnpm build` 与 `pnpm typecheck` **双双恒红**：

```
prisma7.config.ts(4,30): error TS2307: Cannot find module 'prisma/config' or its corresponding type declarations.
```

`tsconfig.json` 的 `include` 是 `**/*.ts`，因此这个文件必然进入类型检查。
它不属本轮功能范围，但**是本轮门禁唯一无法通过的原因**。

### Why This Is Blocking

`pnpm build` 是协议 §十五 明列的必跑门禁。任一必跑门禁为红，Round 就不可能走到
「门禁全绿 + 等验收」的干净位置。而删除文件**需要用户明确授权**——
此前一次删除尝试已被安全策略拒绝，理由是「未经用户明确指示删除既有项目文件」。
**不绕过、不代之以其他手段**。

### Known Facts

- 两个目标均**未被 git 跟踪**（`git status` 显示为 `??`），即**从未进入版本库**；
- 删除它们等于把工作区恢复到「已提交状态」，不丢失任何已提交内容；
- 它们的存在与产品负责人「**不使用 ORM**」的裁定直接矛盾。

### Options Presented

| 选项 | 内容 |
|---|---|
| A（推荐） | 删除 `prisma7.config.ts` 与 `prisma/` |
| B | 不删，改在 `tsconfig.json` 里 `exclude` 它 |
| C | 不处理，本轮红着交付并如实记录 |

### User Answer

> **「删除这两个残留（推荐）」**

### Final Execution Rule

删除 `prisma7.config.ts` 与 `prisma/` 目录（两个**具体目标**，已获明确授权）。
删除后 `pnpm typecheck` 与 `pnpm build` 恢复 exit 0。**本轮未因此改动任何其他配置。**
