Round ID: PROD-1E
Title: Complete PostgreSQL Migration & Runtime Activation（把剩余 Mock 持久化全部迁到 PostgreSQL，并让核心业务**真的**跑在 PostgreSQL 上）
Status: AWAITING_ACCEPTANCE   # 实现完成 + 全门禁通过 + 独立 reviewer 0 BLOCKER / 0 MAJOR；等待产品负责人人工验收 + 本人 Git 提交
Depends On:
- PROD-1D（Admin Write Closure A + T1 Coupon Closure，已 DONE）
- PROD-1C（AdminAudit Closure + Deferred Transactions，已 DONE）
- PROD-1B（Order Hub PostgreSQL Implementation & Concurrency Proof，已 DONE）
- PROD-1A（PostgreSQL 基础层，已 DONE）——`withTransaction` / 版本化迁移 / 种子与重置 / 安全守卫
- `docs/02-tech-design/architecture-rules.md` §2.5（伪事务适用范围 / **半迁移禁令**）
- `docs/02-tech-design/tech-stack.md` §11.1（`pg` 只允许出现在 `lib/data/pg/**`）
- 本轮 `02-decisions.md`（D1–D13）
Goal: 不新增任何产品功能，把剩余 Mock persistence 全部迁移到 PostgreSQL，并最终让核心业务真实运行在 PostgreSQL 上。四个收口目标：
  **① 剩余 12 个缺 Pg 实现的仓储补齐（16/28 → 28/28）；② Mock-only AdminAudit writer 清零（9/33 → 33/33）；③ 数据源门面（accessor + 事务）全部按 `DATA_SOURCE` 在调用时路由；④ `DATA_SOURCE=postgres` 下应用**真的**跑 Pg，且缺实现就拒绝启动。**
Primary Domain: 数据访问层（`lib/data/**`）＋ 数据源激活接线（`lib/data/runtime.ts`、`lib/data/datasource.ts`、`instrumentation.ts`、28 个 accessor、15 个伪事务门面）
Primary State Transition: 无（不新增、不修改任何业务状态机与业务规则；本轮只替换**同一批业务写入**的持久化实现与**切换数据源**）
Started At: 2026-10-11
Development Completed At: 2026-10-11
Accepted At: （待回填）
Git Commit: （待用户本人提交后回填）

---

## 一句话

**把「还剩一半在内存里」的那一半搬进 PostgreSQL，然后扳开关，让应用真的跑在上面——
一行业务规则都没改。**

## 本轮的四个判断

**① 「缺 Pg 实现」必须是**启动即失败**，不能是「静默用 Mock」。**
PROD-1A…1D 的 accessor 从不检查有没有 Pg 版本——返回值永远是 Mock，于是「忘了一个仓储」
和「迁完了」在运行期长得一模一样。本轮把 28 个 accessor 全部收进 `pickRepository`
（`mock` / `pg` 两个半边的显式装配 + 缺失即抛 `MissingPgImplementationError`），
并在 `instrumentation.ts` 里做**启动自检**：`DATA_SOURCE=postgres` 而某个核心仓储没有 Pg 实现
时，服务**拒绝启动**，而不是带着半套数据源开始接请求。见 `02-decisions.md` D2 / D11。

**② 路由是**调用时**读开关，不是模块顶层算常量。**
`isPostgresDataSourceEnabled()` 若在模块初始化期被求值，测试里改环境变量就再也影响不到它，
而「改环境变量」正是本套测试切换模式的唯一手段。因此门面函数体里现读现判。
见 `00` 与 `lib/data/pg/config.ts` 的注释。

**③ 门面只是二选一，不是「再包一层」。**
每个被路由的伪事务保留**原样的 Mock 半边**（改名 `<name>Mock`），对外名 `<name>` 变成
`return isPostgresDataSourceEnabled() ? <name>Pg(...) : <name>Mock(...)`——函数体内**不得有 `await`**。
这条约束由源码文本门禁 `tests/pgRoutingGates.test.mjs` **机械**保证（逐门面双向核对），
而不是靠人记。**刻意不路由的同步原子原语**（`settleOrderCompletion` 等 5 个）另列清单。
见 `02-decisions.md` D3 / D6。

**④ `sweep*` 入口由同步变异步，是一次**顺序不变量**的变更，不是代码风格。**
到期自动通过 / 收益解冻 / 派单超时清扫在 Mock 里是同步函数（单线程 ⇒ 区段内天然原子）；
Pg 版是异步事务。因此**所有调用点必须 `await`**——漏一个 `await` 就是「清扫还没跑完，
后面的判断已经基于旧状态做了」。这条同样由门禁覆盖（17 个调用点逐个断言前面有 `await`）。
见 `02-decisions.md` D7。

## 实证（本轮的实际交付证据）

| 项 | 结果 |
|---|---|
| 新增 migration | **7 个**（`0010`–`0016`）/ 19 张表；`0001`–`0009` **一字未动**（`git status --short db/` 只有 7 个 `??`） |
| 仓储补齐 | 缺 Pg 实现 **12 → 0**（28/28 全部经 `pickRepository` 装配） |
| AdminAudit 写者 | Mock 侧 33 处；**每一处都有 Pg 对应**（`appendAuditEntryTx` 33 处 / 10 个文件）⇒ Mock-only writer = **0** |
| 门面路由 | 15 个 `*Transaction.ts` / **53 个门面**全部按调用时开关二选一（源码门禁双向核对） |
| 新增测试 | **3 个文件**：`tests/pgRoutingGates.test.mjs`（源码门禁）· `tests/datasourceActivation.test.mjs`（激活语义）· `tests/pgHttpE2E.test.mjs`（真库 E2E，`PG_E2E=1` 才跑） |
| `pnpm test`（未起服务） | 2127 / pass **1718** / fail **0** / skipped 409（跳过=需要服务或测试库的用例，见下） |
| `pnpm test:pg`（`PG_E2E=1` + 真库服务） | 248 / pass **248** / fail **0** / skipped **0** |
| 生产全量（`APP_BASE_URL` + 两个服务同时在线） | 2127 / pass **2127** / fail **0** / skipped **0** |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 全部通过（0 error / 0 warning） |
| PostgreSQL 并发回归 | 21 条并发用例 **21 pass / 0 fail**（新增 2 条：连续清扫不被接单误退 · 清扫与接单真正同时到达）；其中 3 条「真正同时到达」型用例已用 `warmPool` + 撑宽行锁窗口改造成**可证伪**，并做了红-绿证明（故意删掉 `FOR UPDATE` ⇒ 必红），见 `03-delivery.md` §3.4.1 |
| 激活实证 | **正例**：`DATA_SOURCE=postgres` 启动日志出现 `[datasource] 启动自检通过…`，且在**任何请求之前**；**反例**：注入 `throw` ⇒ `Error: An error occurred while loading instrumentation hook`，进程退出、端口无人监听、`curl` 无响应 |
| 独立 reviewer（只读） | 3 份只读报告（R1 / R2 / R3），合计 **0 BLOCKER**；R3 提 1 MAJOR + 1 MINOR，**均已在本轮内修复并复验**（MAJOR 的红-绿证明见 §3.4.1）⇒ 修复后 **0 BLOCKER / 0 MAJOR**。详见 `03-delivery.md` §5 |

## 本轮**没有**做的事

不新增任何产品功能 · 不改任何业务规则或状态机 · 不修改 `0001`–`0009` · 不重写已存在且已验证的 Pg 实现 ·
不引入新的运行时依赖 · 不把 `/api/debug/reset` 接到真库上 · **零 Git 写操作**（全部改动留在工作区，由用户一次性 review + commit）。

## 激活的边界（必须写清）

`DATA_SOURCE` **不设置** ⇒ 100% Mock（与 PROD-1D 之前逐字相同，打开页面看不到任何变化）。
`DATA_SOURCE=postgres` ⇒ 全部核心仓储与事务走 PostgreSQL；缺任何一块实现则**拒绝启动**。
本轮的交付包含**切换能力**，但**是否在某个部署上打开**是运维/产品决定，不是本轮的默认状态。

## 档案

`01-prompt.md`（本轮指令逐字）· `02-decisions.md`（Phase 0 真值表 + D1–D13）·
`03-delivery.md`（逐 Wave 的改动、验证记录、红-绿证明、剩余清单；
**§9 = Phase 17《Activation Readiness Final Report》**）· `04-acceptance.md`（人工验收步骤）。

## 下一轮

无强制后继。本轮的「下一步」是**产品决定**：是否在目标环境把 `DATA_SOURCE=postgres` 打开。
未随本轮关闭的已知项（**不是** blocker，是登记项）**共九条**，全部见 `03-delivery.md` §6。举三条：
① `assertAllRepositoriesWired` 的启动期一半只被「激活语义」测试覆盖，Mock 模式的测试不会触发它；
② 旧表之间的 FK 回填（D1）与 D9 的排序归一化；
③ 测试库里两个探针表（`w1_probe_fail` / `w1_write_log`）在 `pnpm test:pg` 后残留——无业务影响。
另有 §6.6 `companionRateBp` 用户端可见（上线前技术债）、§6.7 部分并发用例未撑开锁窗口、
§6.8 券模板 `enabled` 核销时为普通读（有意登记的极窄偏离）。
