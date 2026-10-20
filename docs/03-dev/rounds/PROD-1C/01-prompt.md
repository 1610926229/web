# 原始开发指令档案

Round: PROD-1C
记录人: Claude
记录时间: 2026-10-05

> ⚠️ **来源说明（诚实性声明）**：本文件是产品负责人下达的 PROD-1C 指令的**存档复现**。
> 用户消息与后续上下文压缩摘要共同构成本文件的内容来源；标题与带引号的条文为**逐字**复现，
> 未带引号的小节为**要点归并**（原文为分点列表，此处合并为可读段落，**未增删任何要求语义**）。
> 如与实际指令有出入，**以产品负责人本人的指令为准**，请指出并修正本文件。
>
> ⚠️ 本轮的 **Phase 11 要求回答「6 个问题」**，但那 6 个问题的逐字清单在上下文压缩后
> **未能完整保留**。`03-delivery.md` §3 的《PostgreSQL Activation Readiness Report》
> 按本仓**自己写下的激活门槛**（`rounds/PROD-1B/02-decisions.md` Q1 §13d）重建了 6 个问题，
> 并在那里显式标注了这一点。若产品负责人手里的清单与此不同，请以产品负责人的清单为准。

---

## 标题

```
启动下一轮：# PROD-1C — AdminAudit Closure + Deferred Transactions
```

**中文题**：管理审计写闭包 + PROD-1B 延期事务（T8 / T14 / T15）。

## 目标（逐字要点）

把 PROD-1B 因 `admin_audit_entries` 边界而延期的事务迁到 PostgreSQL，
并**正式建立 `AdminAudit` 的 PostgreSQL 持久化**：

- **T8** `releaseOrdersForCompanion`（宿主事务 `setCompanionFlags`）
- **T14** `approveRefund` / `rejectRefund`
- **T15** `startReviewRefund`

> 「本轮的存在目的就是：**Audit failure must rollback business mutation**。」

## 三条 Hard Rule（逐字）

**Hard Rule 1｜完整事务闭包**

> 一个业务操作的**全部**写入必须在**同一个** PostgreSQL 事务里，否则整体留在 Mock。
> 禁止 `refund → PostgreSQL / adminAudit → Mock`；禁止
> `companion/order release → PostgreSQL / audit → globalThis`；
> 禁止事务提交后 best-effort 写审计。

**Hard Rule 2｜审计是强一致写**

> 业务改动与它的那一条审计必须**同生共死**
> （`BEGIN … INSERT admin_audit_entries … COMMIT`，任何失败 → `ROLLBACK ALL`）。
> 不得为了缩小闭包：异步写 audit / fire-and-forget / catch 后忽略 / outbox 化 / MQ 化。
> **本轮不重新设计审计架构。**

**Hard Rule 3｜业务规则零漂移**

> 本轮是**持久化迁移**，不是产品开发。如发现既有业务疑点：**登记，不顺手修。**

## Phase 列表（逐字要点）

| Phase | 内容 |
|---|---|
| 0 | 只读收口检查（HEAD / 工作树 / PROD-1B 是否 `DONE`）；**禁止任何 Git 写操作** |
| 1 | Requirement Check：从**真实代码**建立需求，产出 unresolved blocking decisions |
| 2 | `AdminAudit` PostgreSQL Schema：**续号新增** migration；**禁止修改已执行的旧 migration** |
| 3 | `PgAdminAuditRepository`：保持既有业务接口；必须接受**显式传入的同一个 `TxHandle`**；不允许事务内部偷偷从 Pool 取第二个 client；Service / Route 不写 SQL |
| 4 | T8 迁移，以**当前 Mock 事务为业务真值**逐行核对 |
| 5 | T14 迁移，同上 |
| 6 | T15 迁移，同上 |
| 7 | 加锁顺序：**第一把竞争锁优先锁 `orders` 行**；只锁真实竞争资源 |
| 8 | 并发实证（真 PostgreSQL）：T8 / T14 通过竞争 / T14 通过 vs 拒绝 / T15 开始审核竞争 |
| 9 | 回滚实证：每个事务类都要有「**最后一笔写入失败**」探针（业务表全部写完 → `admin_audit_entries` 的 `INSERT` 故意失败），证明此前全部业务写入回滚 |
| 10 | 重新列出**全部** AdminAudit 写者；但**不得**因为 `PgAdminAuditRepository` 建好了就自动把其它事务切 PG；**禁止 half Pg** |
| 11 | 产出《PostgreSQL Activation Readiness Report》，回答 6 个问题。**本轮不要自行切** |
| 12 | T8 / T14 / T15 测试数据 Schema / Seed：dev / test 可 seed；**production seed / reset 被拒绝**；`TEST_DATABASE_URL` 配错**必须 fail**；时间列 = `timestamptz`；仓储对外给 **canonical UTC ISO string**；**不得弱化 PROD-1A 的安全守卫** |
| 13 | Contract / Pg tests：**所有关键测试必须真实连接 PostgreSQL，不得 fake / stub pg client** |
| 14 | 回归门禁：定向 PROD-1C 用例 · `pnpm test:pg` · `pnpm test` · 生产 `APP_BASE_URL` 全量 · typecheck · lint · build。关键生产全量：`0 fail` `0 skipped` |
| 15 | 独立只读审查者：要求 `0 BLOCKER` `0 MAJOR` |
| 16 | 建立 `docs/03-dev/rounds/PROD-1C/` 标准五文件；最终 `PROD-1C = AWAITING_ACCEPTANCE`；**不得自行 `DONE`** |

## 全程约束（逐字）

> 「**禁止任何 Git 写操作：add / commit / push / reset / restore / checkout / rebase / amend。**」

> 「不得删除断言、skip、retry 或放宽业务要求。」

> 「任何 destructive 操作只允许作用于 test 数据库。」

> 「测试必须真实连接 `TEST_DATABASE_URL`。**不得通过 mock/stub Pg client 假验证。**」

> 「**默认不要擅自上 SERIALIZABLE 全局解决。**」

> 「特别注意 migration version：禁止创建重复编号或语义重复 migration。」

- dev 库 = `chaoge_esports_dev`；test 库 = `chaoge_esports_test`。
- `docs/03-dev/rounds/**` 下的历史轮次记录**不得改写**。
- Claude 只能把 Round 置为 `AWAITING_ACCEPTANCE`，**永远不得自行置 `DONE`**。

## 授权（逐字）

> 「如果：`0 unresolved blocking decisions` 直接开始实现，不等我。」

Phase 1 的结论为 **0 unresolved blocking decisions**，故本轮按此授权直接进入实现。
