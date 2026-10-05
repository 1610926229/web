# 原始开发指令档案

Round: PROD-1B
记录人: Claude
记录时间: 2026-10-03

> ⚠️ **来源说明（诚实性声明）**：本文件是产品负责人下达的 PROD-1B 指令的**存档复现**。
> 用户消息与后续上下文压缩摘要共同构成本文件的内容来源；标题与带引号的条文为**逐字**复现，
> 未带引号的小节为**要点归并**（原文为分点列表，此处合并为可读段落，**未增删任何要求语义**）。
> 如与实际指令有出入，**以产品负责人本人的指令为准**，请指出并修正本文件。

---

## 标题

``` 
启动下一轮：# PROD-1B — Order Hub W1 PostgreSQL Migration
```

## 目标（逐字）

> 「将 W1 订单核心事务闭包从 Mock / globalThis 原子模型迁移到 PostgreSQL 真事务实现。不是全库迁移。
> 不是产品功能开发。不得改变已经冻结的订单 / 派单 / 履约 / 收益 / 退款业务规则。」

## Phase 0｜上一轮收口检查（逐字要点）

只读检查 `git status` / HEAD / `docs/03-dev/rounds/PROD-1A/**`，确认 PROD-1A 同时满足
「人工验收 PASSED」与「用户本人 Git commit」两个门槛。若只验收未提交：**不得替用户提交、不得自行标 DONE**。

> 「**禁止任何 Git 写操作：add / commit / push / reset / restore / checkout / rebase / amend。**」

## Phase 1｜Requirement Check（本轮先不编码）

完整读取 `docs/01-requirements/**`、`architecture-rules.md`、`database-schema.md`、`tech-stack.md`、
`api-contract.md`、`directory-structure.md`、`docs/03-dev/development-workflow.md`，以及 PROD-1A 全部轮次文档；
重新核对全部 `*Repository.ts`、W1 的 `mock*Repository.ts`、W1 的 `*Transaction.ts`、`adminWriteSupport.ts`、
`orderBlocking.ts` 与 `pg` 基础层。重点建立：**`W1 Repository Dependency Graph` + `W1 Transaction Closure Graph`**。

## Phase 2｜重新确认 W1 精确范围（逐字）

> 「**不要盲信这个列表。必须重新按当前代码逐文件核对。**」

需输出：W1 Stores/Repositories、W1 Transactions、每个事务的完整参与实体、W1 外部只读依赖、W1 外部写依赖。

## Hard Rule 1｜禁止半事务（逐字）

> 「任何一个真实业务事务：要么所有写入都在同一个 PostgreSQL transaction 内，要么继续完整使用 Mock。」

禁止：订单写 PostgreSQL 而 notification 写 Mock；dispatch 写 PG 而 earning 写 `globalThis`；任何
「半 PG + 半 Mock」的原子事务。

> 「若重新审计发现某个 W1 transaction 实际还依赖此前未列出的写实体：必须把该实体纳入闭包，
> 或者将整个 transaction 暂留 Mock。**不得偷偷跨边界。**」

## Hard Rule 2｜业务规则零漂移（逐字要点）

不是重新设计。保持当前已验收的全部规则：OrderStatus 语义、paid/accepted/serving/completed/refunded、
派单专属/公共池、原子接单、禁自接单、打手 available/enabled/banned、取消回池、完成材料提交/通过/驳回/自动审核、
收益 frozen/available、退款对收益的冲减、notification 行为、`CompanionServiceEvent`、`CompanionReleaseHistory`、
`acceptedVia`、`actualCompanionId`、快照语义、金额整数分、deadline 快照。

> 「本轮不得"顺手优化"这些业务。发现旧逻辑疑似有问题：**登记，不擅自改。**」

## Hard Rule 3｜时间策略沿用 PROD-1A（逐字）

PostgreSQL 用 `timestamptz`、会话 UTC、仓储出的时间一律 canonical ISO 8601 UTC 字符串；
业务日按既有 UTC+8 / Asia/Shanghai 规则。

> 「**不得重新讨论 C8。**」

## Phase 3｜PostgreSQL Schema

延续 PROD-1A 的版本化 SQL 迁移编号；**不得修改已执行的迁移文件**。数据库必须承载真实约束
（PK、唯一、幂等键、订单关系、用户/打手 ID、状态、金额整数、时间、deadline、指派/服务身份、
退款/收益唯一、支付请求唯一）。

> 「**不得仅靠 TypeScript 做本应由 DB 保证的唯一性。**」

## Phase 4｜Repository Migration

接口尽量不变；`Service → Repository 接口 → Mock 实现 → Pg 实现` 四段式；Service/Route/UI
**不得写 SQL、不得知道数据源**。契约测试必须对 Mock 与 Pg 跑**同一套用例**。

## Phase 5｜真实 Transaction 重写

必须是真正的 `BEGIN → 必要的 SELECT / lock → 业务闸 → INSERT / UPDATE → COMMIT`，
异常 `ROLLBACK`，全程同一个 PostgreSQL client。

> 不是机械的 `await SELECT → 判断 → await UPDATE`。

## Phase 6｜并发模型（最重要的验收面）

必须证明：（1）两名打手抢同一单 → **恰好 1 人成功**，且由 PostgreSQL 层面保证，不是「先查 dispatch 状态 → 再 update」；
（2）同一打手重复接单按当前语义幂等；（3）重复提交/通过完成不产生第二份 completion 或 earning；
（4）收益不可二次释放；（5）重复直接退款不重复退款；（6）打手释放 / 服务事件并发重放不产生重复历史事件 ——
**数据库必须有与业务身份匹配的唯一约束**。

## Phase 7｜幂等

重新审计全部 `idempotencyKey` / `requestId` / `orderId` 唯一 / 支付请求 / 接单动作 / 完成动作 / 退款执行。
优先 `INSERT → UNIQUE 冲突 → 回读既有结果`，而非 `SELECT → 不存在 → INSERT`（避免 TOCTOU）。

## Phase 8｜Row Lock / Isolation

不得为求保险上全表锁；只锁真实争用资源。Requirement Check 必须写明哪些操作依赖
`SELECT ... FOR UPDATE`、条件 `UPDATE ... WHERE status = ?`、唯一约束或事务隔离级别。

> 「**默认不要擅自上 SERIALIZABLE 全局解决。**」倾向 READ COMMITTED + 精确锁/约束。

## Phase 9｜Seed / Reset

把 W1 fixtures 映射到 PG dev/test seed；dev/test 可 seed、test 可 reset、**production 禁止**；
不猜历史数据；Mock seed 与 Pg seed 必须业务事实一致。PROD-1A 的全部破坏性守卫**不得削弱**。

## Phase 10｜数据源切换纪律

`DATA_SOURCE` 不设 = Mock；显式 `DATA_SOURCE=postgres` = Pg。因为其余尚未迁移，
`DATA_SOURCE=postgres` 是**迁移验证模式**，不是生产可用，**必须写进文档**。
W1 内部强保护：Pg 模式下 W1 事务的全部写参与者必须拿到 PgRepository/tx 句柄；若某个 W1 写者仍解析到 Mock，
必须 **fail-fast**，不得静默混用。

## Phase 11｜不要扩 Scope

明确**不迁移**：admin refund（「若它依赖 refund + adminAudit 且不在 W1 完整闭包」）、complaint、review、
coupon、admin content、agreement、staff、qualification、platform config、chat/message（除非被证明是 W1 原子写参与者）、
user、catalog、activity、withdrawal。也不引入 Redis / ORM / Kafka / 队列 / outbox 架构升级 / 微服务 / 强制 Docker。

> 「如果 notification 当前只是事务内记录：直接 PostgreSQL 持久化即可。**不要趁机发明 MQ。**」

## Phase 12｜旧 Mock Transaction 去留

不得先删 Mock 事务；迁移期间 Mock 与 Pg 事务并存，由显式数据源选择；全量迁移完成后再清理。

## Phase 13｜Requirement Check 输出（逐字要点）

编码前输出：`PROD-1B Scope`、`W1 exact repositories`、`W1 exact transaction closure`、外部读依赖、
是否存在半事务风险、PostgreSQL schema / constraint plan、Concurrency plan、Migration plan、Test plan、Blocking Decisions。

> 「只允许提出：真正无法由现有代码 / 已冻结业务规则 / PROD-1A 架构推导出的架构级问题。不要问纯工程选择题。」
> 「如果：`0 unresolved blocking decisions` 直接进入实现，不等待。」
> 「如果存在 blocker：**一次性列出全部 blocker，然后停止。**」

## Phase 14｜必须增加的 PostgreSQL 实证测试

Repository parity（Mock vs Pg 契约）、Persistence（服务重启数据仍在）、Accept race（N 打手并发恰好 1 成功）、
Transaction rollback、Completion idempotency、Earning idempotency、Refund idempotency、Event uniqueness、
Deadline `timestamptz` roundtrip、Pg restart、Cross-repository transaction（多仓储同一 client 同一事务）、Mock regression。

## Phase 15｜回归

至少：PROD-1B targeted tests、`pnpm test:pg`、`pnpm test`、生产 build + `APP_BASE_URL` 全量、typecheck、lint、build。
PG 测试必须报 **`0 skipped due to missing DB`**；`TEST_DATABASE_URL` 配了但错，必须**失败**而非 skip。

## Phase 16｜Reviewer

独立只读复核，聚焦：事务边界、行锁、唯一约束、幂等、回滚、数据源泄漏、误访问 Mock、金额精度、时间处理、
seed/reset 安全、业务规则漂移。要求 `0 BLOCKER` / `0 MAJOR`；MINOR 逐条处理或明确接受。

## Round 状态

创建 `docs/03-dev/rounds/PROD-1B/` 的标准五个文件；开发完成后置 `PROD-1B = AWAITING_ACCEPTANCE`。

> 「**不得自行 DONE。最终必须给我人工验收步骤。**」

## 全程有效的安全 / 纪律约束（逐字）

> 「**禁止任何 Git 写操作：add / commit / push / reset / restore / checkout / rebase / amend。**」

> 「不得删除断言、skip、retry 或放宽业务要求。」

> 「任何 destructive 操作只允许作用于 test 数据库」

> 「不得自行猜命令」

> 「不要自行把 Round 改成 DONE」

dev 库 = `chaoge_esports_dev`，test 库 = `chaoge_esports_test`。
Claude 只能把 Round 置为 `AWAITING_ACCEPTANCE`，**永远不能**置为 `DONE`。
`docs/03-dev/rounds/**` 下的历史轮次档案**不得改写**。
