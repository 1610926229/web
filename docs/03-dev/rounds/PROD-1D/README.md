Round ID: PROD-1D
Title: Admin Write Closure A + T1 Coupon Closure（T1 券核销闭包的 PostgreSQL 化 + 平台参数 / 投诉 / 券模板三组后台写闭包的 Pg 实现；**intentionally not activated**）
Status: AWAITING_ACCEPTANCE   # 实现完成 + 全门禁通过 + reviewer 0 BLOCKER / 0 MAJOR；等待产品负责人人工验收 + 本人 Git 提交
Depends On:
- PROD-1C（AdminAudit Closure + Deferred Transactions，已 DONE）——`docs/03-dev/rounds/PROD-1C/`：`withTransaction` 的两读幂等模式、`appendAuditEntryTx`、`admin_audit_entries` 表
- PROD-1B（Order Hub PostgreSQL Implementation & Concurrency Proof，已 DONE）——订单写闭包、`w1Transactions` 原语、17 张表
- PROD-1A（PostgreSQL 基础层，已 DONE）——`withTransaction` / 版本化迁移 / 种子与重置 / 安全守卫
- `docs/02-tech-design/architecture-rules.md` §2.5（伪事务适用范围 / **半迁移禁令**）
- `docs/02-tech-design/tech-stack.md` §11.1（`pg` 只允许出现在 `lib/data/pg/**`；结构变更只走版本化迁移）
- AUDIT-PG-1（本轮四块业务所需基础表均已被 PROD-1B / PROD-1C 建好）
- 本轮 `02-decisions.md`
Goal: 关闭 PROD-1C 收口时登记的 **T1 P0 blocker**——Pg `confirmPaymentRequest` 把订单 / 支付 / 派单写进 PostgreSQL，却通过 `buildOrder` 回调把**券核销写进 Mock**（半迁移）。本轮把「支付确认 + 建单 + 派单 + 券核销」收进**同一个 Pg 事务**，并把平台参数、投诉、券模板三组管理端写闭包（业务写 + `admin_audit_entries`）一并迁到 Pg。
  **核心不变式：券核销与订单同生共死；审计失败必须回滚业务改动。**
  **本轮不改任何已冻结的业务规则，不切数据源**：`DATA_SOURCE` 不设置。
Primary Domain: 数据访问层（`lib/data/pg/**`、`lib/data/checkoutCommitTransaction.ts`、`lib/services/checkout.ts` 的纯构造化、`lib/data/adminWriteSupport.ts` 与 `lib/data/pg/adminWriteTx.ts` 的读写分离）
Primary State Transition: 无（不触碰任何业务状态机；仅替换同一批写入的持久化实现）
Started At: 2026-10-10
Development Completed At: 2026-10-11
Accepted At: （待回填）
Git Commit: （待用户本人提交后回填）

---

## 一句话

**本轮把「支付成功」这一串写入（认领支付请求 → 建单 → 收款 → 派单 → 核销券）收进同一个
PostgreSQL 事务，并顺手把三组后台写闭包搬过去——但一根开关都不扳。**

## 本轮的三个判断

**① 半迁移是**结构**问题，靠"记得别调 Mock"关不掉。**
`buildOrderFromRequest` 曾同时承担「算金额」与「写券核销、写派单」两件事，
而它被当作 `confirmPaymentRequest` 的**回调**传进仓储——于是只要仓储换成 Pg 实现，
回调里的两次写就落在 Mock 上。修复不是在那两行外面加判断，
而是把「构造」与「提交」分开：`buildOrder` 变纯函数，两个副作用成为**各存储自己**的事务参与者。
见 `02-decisions.md`。

**② 券的并发唯一性必须由**数据库**保证，不能由读写出顺序保证。**
`SELECT status='unused' → UPDATE` 在 READ COMMITTED 下两个事务可以双双读到 `unused`。
真正堵死双花的是写入语句上的 `AND status = 'unused'`——两个并发 UPDATE 在同一行上串行化，
后到者按新快照重求值该谓词，改 0 行。**返回 0 行**是「这张券已被别人用掉」的唯一信号。

**③ 失败不能"正常返回"给事务入口。**
券不可用时，支付请求**已经被认领**（`pending → success`）。若此时只是正常返回一个失败结论，
`withTransaction` 会把它当成成功**提交**——留下「支付成功、没有订单」。
因此事务入口必须在那条分支上**抛出一个内部信号**掀翻事务，再在事务**外面**把它翻译回
联合类型的失败分支（`{ kind: "coupon-unavailable", reason }`）。

## 实证（本轮的实际交付证据）

| 项 | 结果 |
|---|---|
| 新增测试 | 4 文件 / **67 用例**（17 + 11 + 20 + 19），全部连**真实 PostgreSQL**（`TEST_DATABASE_URL`），无 fake client |
| `pnpm test:pg` | **237 / pass 237 / fail 0 / skipped 0** |
| `pnpm test` | 2104 / pass **1701** / fail 0 / skipped 403（未设 `APP_BASE_URL`） |
| `APP_BASE_URL=… pnpm test`（生产全流程） | 2104 / pass **1884** / fail 0 / skipped 220 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 全部通过 |
| 红-绿证明 | **4 条**，全部实测「去掉机制 ⇒ 变红 ⇒ 还原复绿」：① 券核销条件谓词 ⇒ 双花 `2 !== 1`；② 事务边界 ⇒ 回滚 `999 !== 60`；③ 锁下权威读 ⇒ `23505`；④ 投诉行锁 ⇒ 三条并发用例红 `2 !== 1` |
| 独立 reviewer（只读） | **0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE** → 可进入人工验收（NOTE 1 已修，NOTE 2 有意保留） |
| Migration | **0 个新 migration**（`0001`–`0009` 一字未动，`git status --short db/` 为空） |

⚠️ **本轮实测到一次「假绿」**：冷连接池上的裸 `Promise.all` 并发用例**根本不重叠**，
删掉被守护的并发保护**照样绿**。修法与四条红-绿详见 `03-delivery.md` §4 与 `02-decisions.md` D12。

## 本轮**没有**做的事

不切数据源 · 不接 Service runtime · 不批量改 accessor · 不改任何业务规则 ·
不新增 migration（`0001`–`0009` 一字未动）· 不改历史轮次记录 · **零 Git 写操作**。

## 档案

`01-prompt.md`（本轮指令逐字 + 两条同轮补充指令）· `02-decisions.md` ·
`03-delivery.md` · `04-acceptance.md`。

## 下一轮

激活 `DATA_SOURCE=postgres` 的门槛（PROD-1B `02-decisions.md` Q1 §13d 逐字）：

> 17 张表的全部写者 + `admin_audit_entries` 的全部 33 处写者（10 个文件中的另外 8 个）
> 一并迁完，`DATA_SOURCE=postgres` 才允许被声明为可用。

PROD-1C 迁完 4 / 33。本轮再迁 5 处（平台参数 1 · 投诉 1 · 券模板 3）。
逐文件计数与剩余清单见 `03-delivery.md`。
