# 交付记录（PROD-1E）

Round: PROD-1E — Complete PostgreSQL Migration & Runtime Activation
Status: **`AWAITING_ACCEPTANCE`**

> 本文件是**实现结果与验证记录**。判据（Phase 0 真值表与取舍）在 `02-decisions.md`（D1–D13），
> 人工验收步骤在 `04-acceptance.md`。
>
> **本轮 Claude 未执行任何 Git 写操作**（`git add` / `commit` / `push` / `reset` / `restore` /
> `checkout` / `rebase` / `amend` 一律未用；只用过 `status` / `diff` / `log` / `show`）。
> 全部改动留在工作区，由产品负责人一次性 review + commit。

---

## §1 交付物总览

本轮内部按**六个 Wave** 推进，**作为一个完整的 PostgreSQL migration / activation Round 交付**
（不拆成 PROD-1E / 1F / 1G 多个小 Round）。

| Wave | 主题 | 交付物 |
|---|---|---|
| **A** | Schema | 7 个新 migration（`0010`–`0016`）/ 19 张表；`0001`–`0009` 一字未动 |
| **B** | Repositories | 18 个新 `lib/data/pg/*Repository.ts` · `lib/data/datasource.ts`（装配契约）· 28 个 accessor 全部改为 `pickRepository` |
| **C** | Admin transactions | 6 组管理端写闭包的 Pg 实现（`agreement` / `catalog` / `content` / `staff` / `review` / `companion`）⇒ Mock-only AdminAudit writer 清零 |
| **D** | Runtime wiring | `lib/data/runtime.ts` · `instrumentation.ts` · 15 个 `*Transaction.ts` 的门面化（53 个门面）· 8 个 `lib/services/*.ts` 的 `await` 补全 |
| **E** | Activation | `DATA_SOURCE` 门禁的启动自检 + 正/反两向实证（D11） |
| **F** | E2E + Regression | `tests/pgHttpE2E.test.mjs`（真库全业务 E2E）· `tests/pgRoutingGates.test.mjs`（源码门禁）· `tests/datasourceActivation.test.mjs` · `pgFoundation` / `pgW1Transactions` 扩充 |

### 1.1 新增文件（未跟踪）

```
db/migrations/0010_identity_and_accounts.sql     users · admin_accounts · staff_accounts
db/migrations/0011_catalog.sql                   games · categories · products · product_specs
db/migrations/0012_operations_content.sql        announcements · banners · quick_entries · agreements
db/migrations/0013_companion_onboarding.sql      companion_applications · user_qualifications
db/migrations/0014_member_benefits.sql           consumption_levels · tip_records
db/migrations/0015_reviews.sql                   order_reviews
db/migrations/0016_conversations.sql             conversations · messages · staff_reads

instrumentation.ts                               启动自检（Phase 12 的 fail-fast 落点）
lib/data/datasource.ts                           RepositoryBacking / pickRepository /
                                                 MissingPgImplementationError / CORE_REPOSITORY_COUNT = 28 /
                                                 assertAllRepositoriesWired
lib/data/runtime.ts                              真实仓储清单 + assertRepositoriesReadyOnce（memo）

lib/data/pg/adminRepository.ts
lib/data/pg/adminReviewTransactions.ts
lib/data/pg/agreementRepository.ts
lib/data/pg/agreementTransactions.ts
lib/data/pg/catalogRepository.ts
lib/data/pg/catalogTransactions.ts
lib/data/pg/companionApplicationRepository.ts
lib/data/pg/companionReviewTransactions.ts
lib/data/pg/contentRepository.ts
lib/data/pg/contentTransactions.ts
lib/data/pg/levelRepository.ts
lib/data/pg/messageRepository.ts
lib/data/pg/qualificationRepository.ts
lib/data/pg/reviewRepository.ts
lib/data/pg/staffRepository.ts
lib/data/pg/staffTransactions.ts
lib/data/pg/tipRepository.ts
lib/data/pg/userRepository.ts

tests/datasourceActivation.test.mjs
tests/pgHttpE2E.test.mjs
tests/pgRoutingGates.test.mjs
```

### 1.2 修改文件（已跟踪）

- **`lib/data/*Repository.ts`（28 个）**：accessor 从「硬返回 Mock」改成 `pickRepository({ name, mock, pg })`。
- **`lib/data/*Transaction.ts`（15 个）**：原实现改名 `*Mock`，对外名成为「按 `DATA_SOURCE` 二选一」的门面。
- **`lib/data/pg/config.ts`**：判据注释重写（调用时读、三类调用方）。
- **`lib/data/pg/seed.ts`**：预置数据扩到 30 个领域。
- **`lib/data/source.ts`**：数据源装配接到 `runtime.ts`。
- **`lib/services/*.ts`（8 个）**：`sweep*` 调用点补 `await`（`adminOrders` / `companionDispatch` /
  `companionEarnings` / `companionOrders` / `companionRankings` / `orders` / `staffCompletions` / `staffOrders`）。
- **`tests/*.test.mjs`（17 个）**：见 §3.6。

---

## §2 逐 Wave 说明

### Wave A · Schema

- 新增 7 个 migration，建 19 张表，覆盖本轮补齐的 12 个仓储所需的全部存储。
- **金额一律整数分**（`integer`），**时间一律 `timestamptz`（UTC）**，状态枚举用 `CHECK` 钉死，
  与 `database-schema.md` 的逻辑模型一致。
- `0001`–`0009` **一字未动**（判据：`git status --short db/` 只列出 7 个 `??`，无 `M`）。
- **D1**：只给**新表**建 FK，不回头改 `0003`–`0009`——旧表之间的 FK 回填是登记项，不是本轮范围。

### Wave B · Repositories

- 18 个新 Pg 仓储实现：`admin` / `adminReview`(事务) / `agreement` / `catalog` /
  `companionApplication` / `content` / `level` / `message` / `qualification` / `review` /
  `staff` / `tip` / `user` 等域。
- **装配契约（`lib/data/datasource.ts`）**：
  `RepositoryBacking<T> = { name; mock: T; pg: T | null }`；
  `pickRepository` 在 `DATA_SOURCE=postgres` 且 `pg === null` 时**抛 `MissingPgImplementationError`**
  ——**没有静默回退到 Mock**（Phase 5 的硬要求）。
- `CORE_REPOSITORY_COUNT = 28` 与实际 accessor 数量互相钉死：`assertAllRepositoriesWired`
  会核对清单条数，条数不符即抛（`tests/datasourceActivation.test.mjs` 有正反例）。

### Wave C · Admin transactions

- 6 组管理端写闭包补齐 Pg 实现，且**业务写入与它的那一条审计在同一事务内**
  （Hard Rule 2）：`appendAuditEntryTx` 的 Pg 调用点 **33 处 / 10 个文件**，与 Mock 侧
  `writeAudit(` 的 33 处**一一对应**。
- ⇒ **Mock-only AdminAudit writer = 0**（本轮目标之一达成）。
- 既有的 Pg 实现（PROD-1B/1C/1D 写的）**第一次被接上线时不重写**（D10）。

### Wave D · Runtime wiring

- **门面化**：15 个 Mock 伪事务文件的 53 个对外函数变成
  `return isPostgresDataSourceEnabled() ? <name>Pg(...) : <name>Mock(...)`。
  Mock 半边**原名原体保留**（只改名为 `<name>Mock`），业务语义零漂移。
- **刻意不路由**的同步原子原语（5 个，D6）：`settleOrderCompletion` ·
  `invalidatePendingCompletionForOrder` · `canInvalidatePendingCompletionForOrder` ·
  `createDispatchForOrder` · `releaseOrdersForCompanion`——它们是**同步**函数，
  Pg 路径由 `*Tx` 原语承接，因此没有门面。
- **`sweep*` 的 `await` 补全（D7）**：`sweepExpiredDispatches` / `sweepCompletionAutoApprovals` /
  `sweepMaturedEarnings` 由同步变异步，17 个调用点全部补 `await`，由门禁 (D) 机械保证。
- **判据读取时机**：`isPostgresDataSourceEnabled()` **调用时**读 `process.env["DATA_SOURCE"]`，
  不在模块顶层算常量（否则测试里改环境变量失效）。

### Wave E · Activation

- `lib/data/runtime.ts` 的 `assertRepositoriesReadyOnce()` 是 memo 的，**但不缓存失败**
  （只有成功调用后才置 `asserted = true`）。
- `instrumentation.ts` 在 `NEXT_RUNTIME === "nodejs"` 时调用它：抛错即**拒绝启动**。
- 通过时，**只在 `DATA_SOURCE=postgres`** 打一行 `[datasource] 启动自检通过…`；
  Mock 模式保持静默（那时自检是空操作，打「通过」是在报告一件没发生的事）。D11 记录了正反两向实证。

### Wave F · E2E + Regression

- `tests/pgHttpE2E.test.mjs`：**纯 HTTP** 的真库 E2E，覆盖主链路
  （下单→支付→派单→接单→开始→完成→审核→收益冻结→评价→审核）与三条支线（退款 / 投诉 / 优惠券），
  每条都给**两类证据**（HTTP 响应 + 直连 SQL 回查）。
- `tests/pgRoutingGates.test.mjs`：源码文本门禁，四组 (A)(B)(C)(D)，见 §4。
- `tests/datasourceActivation.test.mjs`：激活语义的 17 条用例。
- `pgFoundation`：预置数量推导从 11 域扩到 **30 域**（改用 fixtures 算期望值），
  `SEEDED_HUB_TABLES` 从 9 张扩到 30 张。
- `pgW1Transactions`：新增 2 条并发/清扫用例（见 §3.4）。

---

## §3 验证记录

> 全部命令在 `D:\vs\微信小程序\web` 下执行。`TEST_DATABASE_URL` 指向测试库（库名以 `_test` 结尾，
> `resetDatabase` 自带守卫）。**未打印任何连接串。**

### §3.1 静态门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | **通过**（0 error） |
| `pnpm lint`（ESLint CLI） | **通过**（0 error / 0 warning） |
| `pnpm build`（Turbopack 生产构建） | **通过**（exit 0） |

⚠️ 过程中 `pnpm typecheck` 曾失败一次，报 `.next/dev/types/routes.d.ts` 语法错误。
**根因不是本轮代码**：那是 `next dev` 被中途杀掉时**写了一半的生成产物**
（文件里出现了一行没有任何注释前缀的 `r Next.js App Router page components`）。
删掉 `.next/dev/types/` 后 `next typegen` 重新生成，即刻复绿。
登记在 §6.4——它会在任何「dev 服务被强杀」之后重现，修法是删目录重生成，与代码无关。

### §3.2 `pnpm test`（未起服务、未设 `APP_BASE_URL`）

```
tests 2127 / pass 1718 / fail 0 / skipped 409
```

409 条跳过**全部是环境门禁**：需要运行中的服务（`APP_BASE_URL`）或测试库（`TEST_DATABASE_URL`）。
`0 fail` 是本条命令要证明的那件事。

### §3.3 `pnpm test:pg`（真库 + 真库 E2E 同时开启）

```bash
PG_E2E=1 PG_E2E_BASE=http://localhost:3101 pnpm test:pg
```

```
tests 248 / pass 248 / fail 0 / skipped 0
```

**246 → 248**：新增 §3.4 的两条用例。**0 skipped** 表示 4 条真库 E2E 也真的跑了。

### §3.4 PostgreSQL 并发回归（Phase 14）

定向跑「并发 / 同时 / 竞态 / 串行 / 唯一」命名的用例：

```
tests 21 / pass 21 / fail 0 / skipped 0
```

覆盖：管理端审计的两写幂等与行锁串行化（T14/T15/T8）、同券并发双花（恰好一单成功）、
T2 并发接单（恰好一个赢家）、T12 并发退款（只出一次款）、T5 唯一约束兜底。

**本轮新增 2 条**（`tests/pgW1Transactions.test.mjs`）：

1. `T3 连续清扫不会把已被接走的单退掉`——与 Mock 半边
   `dispatchConcurrency.test.mjs` 的「连续清扫与接单交错」同一条判据（「当前池」是**状态谓词**，
   不是冻结名单）。接单后连扫 10 次，一次都不该退、不该转池、不该多出第二条接单历史。
2. `T3 并发 · 清扫与接单同时到达：要么接单成功、要么退款关闭，二者必居其一`——让清扫事务与接单事务
   **真的同时在跑**，由行锁决定谁赢；两条分支各有完整断言（赢的分支不再被退、输的分支一个字节没写），
   并断言「既退款又有人接单」「退款两笔」「接单历史两条」三种情况**都不出现**。
   连跑 5 次，5/5 稳定。

#### §3.4.1 并发用例的**可证伪性**（R3 MAJOR 的整改）

并发用例最容易假绿：连接池是**冷**的时候，`Promise.all` 里两个事务经常排在**同一个连接上串行跑完**，
于是「锁」这条被测对象**一次都没被争用**，用例永远是绿的——哪怕把 `FOR UPDATE` 整行删掉。

本轮把新增的 T3 并发用例、以及两条既有同类用例（T2 并发接单、T12 并发退款）统一改成仓库既有的标准写法：

- `warmPool(2)`：先并发跑两条 `SELECT 1` 把两条连接**热起来**，确保接下来两个事务落在**不同**连接上；
- `withWideLockWindow(fn)`：临时装上 `BEFORE UPDATE ON orders` 触发器（函数体 `PERFORM pg_sleep(0.3)`），
  把行锁持有时长**人为撑宽**到远大于事务调度抖动，用完在 `finally` 里 `DROP TRIGGER IF EXISTS`。
  触发器装在 `orders` 上，是因为这三个用例的**第一把锁**都落在订单行。

**红-绿证明**（临时改写 `lib/data/pg/w1Transactions.ts`，验完用 `git diff --numstat` 确认**逐字节还原**）：

| 临时改动 | T2 并发接单 | T3 清扫×接单 | T12 并发退款 |
|---|---|---|---|
| 删 `lockOrder` 的 `FOR UPDATE` | 仍绿 | **红** | **红**（`恰好一个真正执行了退款` actual: 2） |
| 再删 `lockDispatch` 的 `FOR UPDATE` | **红**（`恰好一个赢家` actual: 2） | 红 | 红 |
| 全部还原 | 绿 | 绿 | 绿 |

即：这三条用例**确实在测行锁**——把锁拿掉，它们必红。还原后 `grep -c "FOR UPDATE"` 回到 16。

> 仍有**未撑宽**的并发用例（`pgAdminAuditTransactions` 7 条、`pgContract` 2 条、`pgFoundation` 4 条，
> 其中 2 条因环境跳过），Phase 14 的「21/21」**同时包含**可证伪用例与可能假绿的用例。
> 该残留已登记在 §6.7，R3 明确表示本轮不必改（属于已验收轮次的既有测试文件）。

### §3.5 生产全量（Phase 15 的最后一条）

两个服务同时在线：**Mock 模式生产服务**（`:3100`，给那 30 个 HTTP 契约文件，
它们靠 `POST /api/debug/reset` 做文件级隔离）＋ **真库模式生产服务**（`:3101`，给 4 条真库 E2E）。

```bash
APP_BASE_URL=http://localhost:3100 PG_E2E=1 PG_E2E_BASE=http://localhost:3101 \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env \
  --import ./tests/alias-hook.mjs --test-concurrency=1 --test "tests/*.test.mjs"
```

```
tests 2127 / pass 2127 / fail 0 / skipped 0
```

**这一条是「跑完全部用例、一条不跳」的证据。** 之所以要两个服务，是因为两类 HTTP 用例要求的
服务端**互斥**（`/api/debug/reset` 在 pg 模式下是空操作）；`PG_E2E_BASE` 这个变量就是为此引入的，
取舍见 `02-decisions.md` **D13**。

对照：只起 Mock 服务、不开 `PG_E2E` 时，同一条命令是 `2127 / 2123 / 0 / 4 skipped`——
少的正是那 4 条真库用例。

### §3.6 测试文件的改动清单

| 测试文件 | 为什么改 |
|---|---|
| `tests/datasourceActivation.test.mjs`（新） | 激活语义的 17 条用例：28 条清单自描述、每域都有 Pg 实现、三档 `DATA_SOURCE` 的返回值、fail-fast 正反例、memo 幂等、条数兜底 |
| `tests/pgRoutingGates.test.mjs`（新） | 源码门禁 (A)(B)(C)(D)，见 §4 |
| `tests/pgHttpE2E.test.mjs`（新） | 真库全业务 E2E |
| `tests/completions.test.mjs` | 门禁 21 改为**逐函数**「`*Mock` 体内无 `await`」＋断言门面是纯派发；门禁 22 重定向到 `approveCompletionMock` |
| `tests/earning.test.mjs` / `tests/earningSettlementFreeze.test.mjs` | 同上：文件级「无 `await`」改为逐函数；结构 C 的定位从 `indexOf` 改为 `functionBody(...)` |
| `tests/companionOrders.test.mjs` | `functionBody` 正则加词边界；导出清单改为「去掉 `*Mock` 后等于 5 个」＋逐个断言 `*Mock` 存在、门面含判据与 `<name>Pg(` |
| `tests/companionServing.test.mjs` | 两处源码断言重定向到 `startCompanionOrderMock` |
| `tests/pgConfig.test.mjs` | 补 `0001`–`0016` 迁移版本清单 |
| `tests/pgFoundation.test.mjs` | 预置数量从 11 域扩到 30 域；`SEEDED_HUB_TABLES` 9→30；`user_qualifications` 进 `EMPTY_HUB_TABLES` |
| `tests/pgW1Transactions.test.mjs` | 新增 §3.4 的两条用例 |
| 其余 7 个（`adminOrderDispatchFields` / `companionRankings` / `couponReturnAndGrant` / `directRefund` / `dispatch` / `dispatchConcurrency` / `refundMoneyChain` / `refundOnePerOrder` / `staffOrderActions`） | `sweep*` 由同步变异步 ⇒ 调用点补 `await`（一处回调改为 `async`） |

> **这些重定向是不是「放宽断言」？** 这是本轮最需要自证的地方：门禁**没有**从「对外可见的门面」
> 变成「没人调用的内部名字」——门面另有专门断言（含判据、含两个 `<name>*` 调用、体内无 `await`），
> 逐函数断言恰恰是**加强**（原来一个文件里只要有 `await` 就整体豁免，现在是每个 `*Mock` 函数各查一次）。
> 独立 reviewer 对这一点的裁定见 §5。

---

## §4 门禁的**可证伪性**（`tests/pgRoutingGates.test.mjs`）

| 组 | 断言 | 什么会让它变红 |
|---|---|---|
| (A) | 每个路由门面的函数体**恰好**是 `isPostgresDataSourceEnabled() ? <name>Pg(...) : <name>Mock(...)`，且与手写清单 **53 条双向一致** | 门面里多写一行（例如加了日志、加了提前 `return`）；漏登记一个门面；多登记一个；函数体出现 `await` |
| (B) | 5 个刻意不路由的同步原语**不是 async**、**不含判据**、**不调 `*Pg(`** | 有人给 `settleOrderCompletion` 加了门面或加了 `async` |
| (C) | `isPostgresDataSourceEnabled()` 的**每一次出现都在某个导出函数体内** | 有人把它提到模块顶层算常量（调用时读的约束被破坏） |
| (D) | 三个 `sweep*` 在 `lib/services/**` + `lib/data/**` 的 **17 个调用点**前面都必须紧跟 `await` | 漏一个 `await` |

另有一条 `helper 正例`：证明解析器对「`<name>` 与 `<name>Mock` 同名 + 后缀」这一对能解析到**两个不同的函数体**
（否则 (A) 会因为解析器把两个名字搞混而变成恒真）。

---

## §5 独立 reviewer（Phase 16）

**只读**审查，不修改任何文件。分三个**互不重叠**的范围并行进行：
**R1** 运行期接线（门面一致性 / 判据时机 / fail-fast / 仓储装配 / Mock 隔离）·
**R2** Pg 语义等价（金额 / 时间 / 幂等并发 / 审计同生共死 / 状态机 / 迁移 / seed 一致性）·
**R3** 测试质量与安全边界（新门禁是否可证伪 / 断言是否被放宽 / E2E 夹具诚实性 / 鉴权与清单门禁 / 敏感值泄露）。

| 审查员 | BLOCKER | MAJOR | MINOR | NOTE |
|---|---|---|---|---|
| R1 运行期接线 | **0** | **0** | **0** | 4 |
| R2 Pg 语义等价 | **0** | **0** | **0** | 3 |
| R3 测试质量与安全 | **0** | **1（已修，见下）** | **1（已修，见下）** | 7 |

### R3 的 MAJOR：**已修**，并补上了红-绿证明

**问题**：本轮新增的 `T3 并发 · 清扫与接单同时到达`（以及同文件里两条**既有**的
`T2 并发接单` / `T12 并发退款`）用**裸 `Promise.all`**，没有沿用本仓**已确立**的
「撑开锁窗口」模式（`warmPool(size)` + 一道 `BEFORE UPDATE … PERFORM pg_sleep(0.3)` 的
测试专用触发器，用完即摘）。**后果是它守护的那件事无法被可靠证伪**：两个请求若被
连接建立/事件循环串行化，先发的跑完整段才轮到后发的，后发的自然读到新状态——
此时把 `FOR UPDATE` 整条删掉，用例**照样绿**，它测到的其实是「顺序执行」。
（`tests/pgCheckoutTransactions.test.mjs` / `pgComplaintTransactions.test.mjs` 的注释
把这段失效机理写死过，并注明「最初它们只做了预热，是一处已被修正的不对称」。）

**修法**：在 `tests/pgW1Transactions.test.mjs` 引入同款 `warmPool` +
`withWideLockWindow`（触发器挂在 **`orders`** 上——三条用例的第一把锁都在订单行，
挂在第一把锁上才能让**输家**在赢家持锁期间就阻塞住），三条用例一并套上。

**红-绿证明（实测，非推导）**——临时摘掉源码里的行锁，看用例是否如实变红：

| 被摘掉的锁 | T2 并发接单 | T12 并发退款 | T3 清扫 vs 接单 |
|---|---|---|---|
| `lockOrder` 的 `FOR UPDATE` | ✔ 仍绿 | **✖ 红**（`恰好一个真正执行了退款 actual: 2`） | **✖ 红** |
| `lockDispatch` 的 `FOR UPDATE` | ✔ 仍绿 | — | — |
| **两者同时**摘掉 | **✖ 红**（`恰好一个赢家 actual: 2`） | — | — |
| 还原 | ✔ 绿 | ✔ 绿 | ✔ 绿 |

读法：T2 有**两把**锁兜着（订单行锁与派单行锁互为冗余），因此只在两者都被摘掉时才红——
这是实现的冗余，不是测试的缺陷；T12 / T3 由订单行锁单独守护，摘掉即红。
**三条用例现在都是可证伪的**，且证明做完后源码已按 `git diff --numstat` 确认**逐字还原**。

### R3 的 MINOR：**已修**

`tests/pgRoutingGates.test.mjs` 的 `NOT_ROUTED_SYNC_PRIMITIVES` 与 `02-decisions.md` D6 的表
**不对齐**，且注释写「这五个」而实际列了 6 条。修法：把清单扩成 **D6 表 ∪ 同类同步原语**
（补入 `commitMockCheckoutParticipants` / `redeemCouponClaimForOrder` /
`restoreCouponClaimForOrder` / `readOrderBlockingFacts`，共 9 条），注释改为**说清清单范围**
（并注明 `orderBlocking.ts` 不是 `*Transaction.ts`、其余由门禁 (A) 与 `couponCheckoutChain` 兜底）。
**另加一条 `assert.notEqual(body, "")`**：下面三条都是**否定式**断言，名字写错导致解析不到函数时
会**真空通过**——先把「确实解析到了」钉住，否定式断言才有意义。

**R3 的 7 条 NOTE（择要，不要求动作）：**

1. 「整文件无 `await` → 按 `*Mock` 函数体无 `await`」的重定向**不是削弱，是校正**：
   若不改，`functionBody(code, "submitCompletion")` 会解析到 3 行的路由门面（本来就无 `await`），
   真正的原子区段反而没人查。改成 `*Mock` 后既锁住实现，又把「改名 ⇒ 找不到函数 ⇒ 红」变成强制更新门禁。
2. 两个新 T3 用例的**不变量本身不恒真**（连续清扫那条：sweep 若忽略状态谓词，10 轮里至少一轮会红）。
3. `pgHttpE2E` 的括号访问绕过**边界正确**：只绕开 `httpIsolation.test.mjs` 的点号子串检测，
   不绕过别的门禁；`PG_E2E_BASE` 的误配会因直查 SQL 的 `rows.length === 1` 而**响亮失败**（0 行）。
   证据层是真 SQL 双重读（四条金额恒等式 / 全额退款额 / 收益整笔冲回 / `earning_adjustments` / 通知与审计）。
4. `pgFoundation` 的 30 域种子计数**不是同义反复**：有独立 `countRows(table)` SQL 回读与
   `expected()` 两条读路径。
5. **安全边界全部过关**：`app/` 零处引用 `DATA_SOURCE` / `isPostgresDataSourceEnabled`（分层未穿透）·
   本轮无新增 admin 路由（`git status` 仅 `lib/` 与 `tests/`），`tests/admin.test.mjs` 清单门禁**无需改动**·
   `/api/debug/reset` 仍是 POST-only + `isMockDebugEnabled()` 第一条语句 + 关闭时 404（非 403）·
   所有连接串出日志的路径都过 `redactDatabaseUrl` / `describeConnection`·
   `instrumentation.ts` 只打一行固定文案、不含任何值。
6. 门禁 (C) 是 (A) 的反向兜底（若门面写成 `export const f = async () => …`，(A) 的正则不认，(C) 会红）。
7. `assertRepositoriesReadyOnce` 只跑一次、Mock 模式空转——与「只在 postgres 时 fail-fast」的裁定一致，
   代价已登记（§6.1）。

**R1 的四条 NOTE（登记，不要求动作）：**

1. **`assertAllRepositoriesWired` 的覆盖边界是「清单内的 28 个域」，不是「全仓自动发现」。**
   已登记的 28 个域漏 Pg 实现会在启动或首次 `getDataSource()` 时**一次报全**；但**新增第 29 个域
   且同时漏改 `runtime.ts` 清单与 `CORE_REPOSITORY_COUNT`** 时，两个常量仍是 28==28，
   启动检查不会发现——那个域只会被自己的 `pickRepository` 在**首次使用**时抓住（`pg: null` ⇒ 抛）。
   因此**不存在「静默回落 Mock」的缝**，只有「启动期不炸、首次访问才炸」的时序落差。
   这是 D2/D11 写下的**刻意的手动登记代价**（§6.1 已从 R1 这面重述）。
2. **`instrumentation.ts` 的启动钩子路径没有任何自动化测试触发**——`node --test` 够不到框架钩子；
   `assertAllRepositoriesWired` / `assertRepositoriesReadyOnce` 本身**被测试真正触发**
   （`datasourceActivation.test.mjs` 四条用例直接调用），但 `register()` 那条「启动即拒绝服务」的
   传播链只靠 §7 的一次人工探针。R1 复核确认该盲区**确实存在、且与 D11 的诚实口径一致**。
3. **memo 只缓存成功，但成功也会在 Mock 模式下被缓存**：`asserted = true` 在 Mock 模式下也会置位。
   若同一进程把 `DATA_SOURCE` 从 mock 翻到 postgres 而不先 `resetRepositoriesReadyAssertion()`，
   下一次自检会被跳过。**生产环境启动后 `DATA_SOURCE` 不变，测试 helper 每次都复位**，无实际风险；
   只是提醒**不要在生产代码里动态翻转 `DATA_SOURCE`**。
4. **风格不一致（按「文件风格不算问题」不报缺陷）**：`lib/data/adminContentTransaction.ts` 的 12 个
   `*Mock` 是 `export function`（同步返回内部 `async` 的 Promise），其余 15 个事务文件是
   `export async function *Mock`。运行正确（门面是 `async`），仅是阅读噪音。

**R1 明确核对通过的**：53 个门面（独立数过：覆盖 15 个有门面的文件；两个纯同步原语文件
`checkoutCommitTransaction.ts` / `couponRedemptionTransaction.ts` 正确地**不在**清单里）·
刻意不路由的 9 个同步原语全部保持同步、无门面、无 `*Pg(` 调用，Pg 侧各有内嵌等价物
（`settleOrderCompletionTx` / `releaseOrdersForCompanionTx` / `redeemCouponClaimForOrderTx` /
`insertDispatchForOrderTx` / `readOrderBlockingFacts(tx)`）·
判据**调用时求值**（全仓无模块顶层 `isPostgresDataSourceEnabled()` / `pickRepository(...)`）·
启动自检三条（失败不缓存 / Mock 空操作 / `NEXT_RUNTIME` 早退 + 动态 `import()` 避免非 Node runtime 静态加载 `pg`）·
28 个 accessor 全部经 `pickRepository`、`CORE_REPOSITORY_COUNT = 28` 与实际**一致**、
28 个 backing 的 `pg` 全部非 null 且都用 `lazyPgExecutor()`（模块加载不连库）·
**Mock 隔离**：`lib/services/**` 无一处直接 import `mock*Repository` / `mockStore`（仅 `mockStores.ts`
的 DEV-2 生命周期与 `@/lib/mocks/debug` 故障注入面，均不写业务数据）；pg 事务只 import 纯函数与类型，
**无一 import `writeAudit` 或任何 Mock store**。

**R2 的三条 NOTE（登记，不要求动作）：**

1. `lib/data/pg/paymentRepository.ts:401` 与 `lib/data/pg/notificationRepository.ts:96` 用 `now()`
   取写入时刻，Mock 用 `new Date()`。**语义相同**（都是「写入那一刻」），差别只是 DB 时钟与
   应用时钟的毫秒级误差——**不是**「该传 `at` 却用了 `now()`」那种漂移。
2. `lib/data/pg/w1Transactions.ts:1125` `redeemCouponClaimForOrderTx` 读券模板 `enabled` 不加锁，
   代码内已自我登记为「已知残留」；落库状态不自相矛盾，**只在「管理员并发停用该模板」这一种
   情形**下与 Mock 有差异。
3. `lib/data/pg/reviewRepository.ts:191` `reviewRangeBoundary` 的
   `new Date(start - BEIJING_OFFSET_MINUTES*60_000)` **不是**本地时区构造，
   而是 Mock「偏移坐标系」的逆映射（复用共享纯函数 `reviewRangeStart`），与 Mock 判据**逐值等价**。

**R2 明确未发现问题的范围**：金额（整数分、CHECK 承载恒等式、部分退款不改 `status`、
**无新增 `companionRateBp` 暴露**）· 时间（全 `timestamptz`、sweep 取「到点那一刻」、
`deadline <= at` 判据一致）· 幂等并发（逐条列出锁序：T2 `orders→dispatch` 双 `FOR UPDATE`、
T9–T11 部分唯一索引 + `FOR UPDATE` + `canTransitionCompletion`、T13 `WHERE status='frozen'`、
T3 `ORDER BY id FOR UPDATE`、T12/T4/T6–T7 先锁订单、券领取/发放 `ON CONFLICT` 双索引仲裁、
核销/退回条件 `UPDATE`、管理端新建锁 + 编辑 `FOR UPDATE` + 幂等账本两段读、原子区段无 `await` 窗口）·
审计同生共死（**所有**新管理端写闭包同事务 `appendAuditEntryTx`；无 `ON CONFLICT DO NOTHING`，
同键撞 `23505` 回滚而非静默吞掉）· 状态机（无未声明迁移）· 迁移（`0001`–`0009` 无一改动、
无 `DROP`/`ALTER`、CHECK/NOT NULL/UNIQUE 齐备）· Seed/Reset（复用 Mock fixtures + `getMockSeedNow()`）。

**R2 无法判断的两点**：① 只读静态审查，未执行 `pnpm test`/`typecheck`（运行时并发行为以 §3 的实测为准）；
② 管理员的账号增改/启停/移除写闭包在 **Mock 侧也没有对应管理事务**（属于「对齐」，不是缺项），
若产品认为「管理员账号管理」应当有独立功能，那是**新需求**、不在本轮范围。

**结论**：三个审查员合计 **0 BLOCKER**；R3 报出 **1 MAJOR + 1 MINOR，均已在同一轮内修复并复验**
（MAJOR 附实测红-绿证明，见上表；修复后 `tests/pgRoutingGates.test.mjs` 5/5 通过、
`tests/pgW1Transactions.test.mjs` 三条并发用例 4/4 通过）。
**修复后达成 Phase 16 的门槛：0 BLOCKER / 0 MAJOR。**

---

## §6 未关闭项 / 已知登记项

> 全部**不是** blocker，也**不改变业务结果**；登记是为了让下一轮有人接手时不用重新发现。

### §6.1 `assertAllRepositoriesWired` 的启动期一半只有激活语义测试覆盖

启动自检（`instrumentation.ts` → `assertRepositoriesReadyOnce()`）是一条**进程启动期**的路径。
`tests/datasourceActivation.test.mjs` 覆盖了它的**语义**（28 条清单、缺实现即抛、memo 幂等、条数兜底），
真实启动期的**正反两向**则由 §7 的手工实证覆盖。**没有单条测试同时跨这两半**。

**R1 从运行期接线这一面复核后补充的边界（NOTE N1/N2，与本节同一件事）**：

- 覆盖边界是「**清单内的 28 个域**」，不是「全仓自动发现」。新增第 29 个域**且同时漏改**
  `runtime.ts` 清单与 `CORE_REPOSITORY_COUNT` 时，两个常量仍 28==28 ⇒ 启动检查不炸，
  该域要等**首次使用**才被自己的 `pickRepository` 抓住。**不存在「静默回落 Mock」的缝**，
  只有「启动期不炸、首次访问才炸」的时序落差——这是 D2/D11 **刻意**选的手动登记代价。
- `register()` 那条「启动即拒绝服务」的传播链**只能靠人工探针**（`node --test` 够不到框架钩子），
  R1 独立复核确认这个盲区存在且与文档口径一致。

### §6.1b D10 要求的 `SUSPECTED_PG_BUG` 登记：**本轮为 0**

D10 规定「Pg 实现第一次被接上线时只补路由、不重写；若在接线中发现疑似 Pg 缺陷，必须登记」。
本轮接线过程中，**修复组与 E2E 组均未报告 `SUSPECTED_PG_BUG` / GAP**。
唯一被发现的「行为差异」是 §6.8 的券模板 `enabled` 普通读（**已由 R2 归类为 NOTE，
且代码内就地写明是刻意保留**），它不是 `SUSPECTED_PG_BUG`，是**已知且书面的**语义边界。
R1 提出「由 Coordinator 对照 §6 确认」——确认结果：**0 条 SUSPECTED_PG_BUG**。

### §6.2 旧表之间的 FK 回填（D1）

只给**新表**建了 FK，`0003`–`0009` 建的旧表之间的引用完整性没有回头补。这是**有意**的
（改历史迁移的语义风险大于收益），记录在 `02-decisions.md` D1。

### §6.3 Pg 侧确定性排序归一化（D9）

Pg 查询在某些等值排序下与 Mock 的返回顺序可能不同（Mock 按插入序，Pg 未显式 `ORDER BY`）。
**登记，不修**：本轮不改任何业务语义，且这些路径没有「顺序即语义」的业务规则。D9。

### §6.4 `.next/dev/types/` 的生成产物会被 dev 强杀写坏

见 §3.1 的 ⚠️。任何一次「`next dev` 被中途杀掉」之后都可能留下半截 `routes.d.ts`，
表现是 `tsc` 报一堆 `TS1434 / TS1005 / TS1128`。**修法**：删掉 `.next/dev/types/` 再 `next typegen`。
与代码无关，不修。

### §6.5 测试库里的探针表在 `pnpm test:pg` 后残留

`pgW1Transactions` / `pgAdminAuditTransactions` 等文件会建 `w1_probe_fail` / `w1_write_log`
与挂在 20 张表上的 `w1_probe_trg` 触发器；它们的 `after()` 只 `closePool()`，不拆探针。
因此跑完 `pnpm test:pg` 后测试库里会留下 **2 张表 + 一批触发器**（42 张 `public` 表 = 40 业务 + 2 探针）。
**无业务影响**：`pgFoundation` 的「删光一切」用例（按文件名排序先跑）会把它们一起删掉；
`w1_probe_fail` 平时为空，触发器不抛错。**只有在「先跑 pgFoundation、后被强杀」之后才可能看到残留。**

### §6.6 `companionRateBp` 在用户端可见（上线前技术债，非本轮引入）

PROD-1B 起的已知项：某用户端 DTO 暴露了分账比例 `companionRateBp`。本轮**没有**修它
（不在「不新增任何产品功能」的范围里要求）。**上线前必须移除。**
本轮改动是否意外扩大了暴露面，见 §5 的 R2 结论。

### §6.7 仍有并发用例没有撑开锁窗口（登记，不在本轮范围）

R3 的 MAJOR 指向的是「裸 `Promise.all` 让并发用例无法被证伪」。本轮修好了
`tests/pgW1Transactions.test.mjs` 里的三条（本轮新增的那条 + 同文件两条既有的）。
但同一形态还存在于**本轮未触碰**的文件里：

| 文件 | `Promise.all` | 撑窗辅助 | 备注 |
|---|---|---|---|
| `tests/pgAdminAuditTransactions.test.mjs` | 7 | **0** | PROD-1C 交付，已随该轮验收 |
| `tests/pgContract.test.mjs` | 2 | 0 | 契约类，多半不是并发用例 |
| `tests/pgFoundation.test.mjs` | 4 | 2 | 已有辅助，未逐条核对 |

**为什么不本轮一并改**：那几个文件属于**已验收的 PROD-1C / PROD-1B 交付物**，
本轮的范围是「迁移 + 激活」，不含重写历史轮次的测试；R3 也明确「不在本次范围内，本轮不强求一并改」。
**统一口径**：Phase 14 报出的「21 条并发用例 21 pass」**同时包含**已撑窗（因此可证伪）与
未撑窗（可能假绿）两类。**下一轮若要把「并发正确性」当作已证事实，应当先把上表清零。**

### §6.8 券模板 `enabled` 在核销时是普通读（有意登记的一处极窄偏离）

`lib/data/pg/w1Transactions.ts` 的 `redeemCouponClaimForOrderTx` 读券模板 `enabled` 时
**不加行锁**（与 `readCompanion` / `readPlatformConfig` 同口径）。含义是：一位管理员在本事务
读完之后、提交之前**停用**了该模板，本单仍按「启用」核销。这只在**真的发生并发停用**时与 Mock
有差别，且**不产生自相矛盾的落库状态**（券已核销 / 订单成立 / 模板停用，三者各自都是已提交的事实）。
**登记，不修**：加锁会把这个极窄窗口换成一个更宽的锁竞争面，而收益是让一条「管理员恰好在同一毫秒
停用模板」的路径与 Mock 逐字一致——不值得。代码内已就地写明。

---

## §7 激活实证（Phase 12，两向）

| 场景 | 做法 | 观察到的结果 |
|---|---|---|
| **正例** | `DATA_SOURCE=postgres` + 测试库，`next start` | 启动日志出现 `[datasource] 启动自检通过：全部核心仓储都有 Pg 实现（DATA_SOURCE=postgres）`，且出现在**任何请求之前** |
| **反例** | 在 `register()` 顶部临时插一句 `throw`，`next dev` | 日志 `Error: An error occurred while loading instrumentation hook: …`，进程退出；`netstat` 显示端口**无人监听**，`curl` 无响应 |

⚠️ **诚实的边界**：这两个观察里，反例注入的是**另一句** `throw`，它与
`assertRepositoriesReadyOnce()` 的 `throw` **共用传播路径但不是同一个异常**；
后者自身的语义由 `tests/datasourceActivation.test.mjs` 覆盖（含正反例）。
**没有任何一条测试同时覆盖这两半**（同 §6.1）。探针代码已随后**移除**
（`grep` 确认无残留），不留在工作区。

---

## §8 零 Git 写操作声明

本轮 Claude **未执行任何 Git 写操作**。可复现的只读命令：
`git status --short` · `git diff` · `git log --oneline` · `git show`。
所有改动（含 7 个新 migration、18 个新 `lib/data/pg/*.ts`、3 个新测试文件、3 个新运行期文件
`instrumentation.ts` / `lib/data/datasource.ts` / `lib/data/runtime.ts`）**都在工作区**，
由产品负责人一次性 review + commit。**没有创建第二套 migration / 第二套 repository / 重复 transaction。**

---

## §9 Phase 17 — Activation Readiness Final Report

> 全部数字为**本轮实测**（2026-10-11，HEAD = `d73ffa2`，工作区含本轮全部改动）。
> 复现命令写在每行后面，都是只读的。

### §9.1 五个指标

| 指标 | 总数 | 已 Pg 实现 | 运行时走 Pg（`DATA_SOURCE=postgres`） | Mock-only | 复现 |
|---|---|---|---|---|---|
| **Repository（核心仓储 accessor）** | **28** | **28** | **28** | **0** | `grep -rc "pickRepository(" lib/data/*Repository.ts \| grep -v ":0" \| wc -l` = 28 · `grep -n "CORE_REPOSITORY_COUNT = " lib/data/datasource.ts` = 28 |
| **Transaction（服务层可调用写入口 / 门面）** | **53** | **53** | **53** | **0** | `grep -rh "return isPostgresDataSourceEnabled()" lib/data/*Transaction.ts \| wc -l` = 53（分布在 15 个文件） |
| **AdminAudit（`writeAudit` 写入者）** | **33** | **33** | **33** | **0** | Mock 侧 `grep -rc "writeAudit(" lib/data/*Transaction.ts \| grep -v ":0"` = 33（10 个文件）；Pg 侧 `grep -rn "appendAuditEntryTx(" lib/data/pg/*.ts \| grep -v adminAuditRepository.ts \| wc -l` = **33** |
| **Schema migration / 业务表** | **16 个迁移** | — | — | — | `ls db/migrations/` = `0001`…`0016` 连续，新增 7 个（`0010`–`0016`）；`grep -rhi "create table" db/migrations/*.sql \| wc -l` = **40 张业务表** |
| **`DATA_SOURCE=postgres` 可用？** | **YES** | — | — | — | 见 §9.2 |

**另有 9 个「同步原子原语」刻意不走路由**（D6）——它们**不是**服务层写入口，而是 Mock 半边里
「处于某段无 `await` 区段内」的内部函数；Pg 半边有各自的真事务等价物。
它们被单列为 Mock-only 是**设计裁定**，不是遗漏（`tests/pgRoutingGates.test.mjs` gate (B) 逐条否定式断言）。

### §9.2 `DATA_SOURCE=postgres` = **YES**：完整证据链

| # | 证据 | 结果 |
|---|---|---|
| 1 | **缺实现即拒绝启动**（启动自检 `assertAllRepositoriesWired`，`instrumentation.ts`） | 正例：`[datasource] 启动自检通过：全部核心仓储都有 Pg 实现（DATA_SOURCE=postgres）`，出现在任何请求之前；反例：进程退出、端口无人监听、`curl` 无响应（§7） |
| 2 | **无静默回退**（`pickRepository` 抛 `MissingPgImplementationError`） | `tests/datasourceActivation.test.mjs` 17/17，含正反例与「清单条数不符」兜底 |
| 3 | **路由是调用时求值** | gate (C)：`isPostgresDataSourceEnabled()` 每一次出现都在导出函数体内，无一处于模块顶层 |
| 4 | **门面是纯二选一** | gate (A)：53 个门面逐个双向核对（Mock 分支 / Pg 分支都在、函数体内无 `await`） |
| 5 | **顺序不变量** | gate (D)：3 个 `sweep*` 的 17 个读取路径调用点全部紧跟 `await` |
| 6 | **真实业务跑在真库**（Phase 13 E2E） | `tests/pgHttpE2E.test.mjs`：两张券并发核销恰好一单成功、原始金额 ≥ 券门槛、券后实付与页面一致；真库地址读 `PG_E2E_BASE`（D13） |
| 7 | **并发正确性**（Phase 14） | 21 条并发用例 21 pass / 0 fail；其中 3 条「真正同时到达」型已做成**可证伪**（红-绿：删 `FOR UPDATE` ⇒ 必红，§3.4.1） |
| 8 | **生产全量一条不跳** | `tests 2127 / pass 2127 / fail 0 / skipped 0`（两个服务：Mock `:3100` + 真库 `:3101`，§3.5） |

### §9.3 结论

```
Repository      28 / 28 已 Pg 实现 / 28 运行时走 Pg / 0 Mock-only
Transaction     53 / 53 已 Pg 实现 / 53 运行时走 Pg / 0 Mock-only
                （另有 9 个同步原子原语按 D6 刻意不路由——设计裁定，非遗漏）
AdminAudit      33 / 33 Pg 原子     / 33 运行时走 Pg / 0 Mock-only writers
Schema          16 个迁移（0001–0016，0001–0009 一字未动）/ 40 张业务表
DATA_SOURCE=postgres  =  YES
```

**质量门槛**：独立只读 reviewer 3 份报告合计 **0 BLOCKER**；R3 所提 1 MAJOR + 1 MINOR
**已在本轮内修复并复验**（MAJOR 带红-绿证明）⇒ 修复后 **0 BLOCKER / 0 MAJOR**。

**回归四条 + 静态门禁**：`pnpm test` 2127 / 1718 pass / **0 fail** / 409 skipped（跳过=环境门禁）·
`pnpm test:pg` **248 / 248 / 0 / 0** · 生产全量 **2127 / 2127 / 0 fail / 0 skipped** ·
`pnpm typecheck` / `pnpm lint` / `pnpm build` 全部 exit 0。

**本轮交付的是「可以扳动的开关」，不是「另一套代码」**：`DATA_SOURCE` 不设置 ⇒ 100% Mock
（与 PROD-1D 之前逐字相同）；`DATA_SOURCE=postgres` ⇒ 核心业务真的跑在 PostgreSQL 上，缺一块即拒启动。
**是否在某个部署上打开是产品 / 运维决定**，不是本轮的默认状态。

**PROD-1E = `AWAITING_ACCEPTANCE`**（等产品负责人人工验收 + 本人 Git 提交，双门槛）。
