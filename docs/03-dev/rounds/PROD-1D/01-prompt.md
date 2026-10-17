# PROD-1D · 01-prompt（本轮指令，逐字保留）

> 本文件是**用户本人下达的原始指令**，逐字保存，不做编辑。
> 与它并列的还有两条同轮补充指令（正文末尾），同样是用户本人的原话。

---

启动下一轮：

# PROD-1D — Admin Write Closure A + T1 Coupon Closure

本轮只做 PostgreSQL 替换工程。

**禁止新增产品功能。**
**禁止 UI/UX 扩展。**
**禁止提前激活 DATA_SOURCE=postgres。**

---

# Phase 0｜Preflight

首先只读检查：

- `git status --short`
- `git log --oneline -10`
- PROD-1C README / acceptance
- AUDIT-PG-1
- 当前 migrations
- 当前 Pg repositories / transactions

要求：

1. PROD-1C = DONE
2. 用户本人已完成 PROD-1C implementation commit
3. PROD-1C closure docs 已由用户本人提交
4. 工作区不存在上一 Round 遗留修改

如果工作区不干净：

停止开发并报告。

禁止代替用户执行任何 Git 写操作。

---

# 本轮冻结范围

只允许处理以下四块：

## A. T1 Coupon Redemption Closure

修复已经确认的 P0 blocker：

当前 Pg `confirmPaymentRequest`：

- order/payment/dispatch 写 PostgreSQL
- coupon redemption 仍通过 `buildOrder` 路径写 Mock

正式规则已经冻结：

```text
payment confirmed
+ order created
+ dispatch created
+ coupon claim consumed（如果使用优惠券）
```

必须属于同一个 PostgreSQL transaction。

禁止：

- Pg Order + Mock Coupon
- commit 后 best-effort 核销
- 券核销成功但订单失败
- 订单成功但券未核销

---

## B. Platform Config Admin Write Closure

迁移当前：

`adminPlatformConfigTransaction`

对应管理端写操作。

要求：

业务修改 + `admin_audit_entries`

必须同一个 Pg transaction。

---

## C. Complaint Admin Write Closure

迁移当前：

`adminComplaintTransaction`

对应管理端投诉处置。

要求：

投诉状态修改 / 处置字段 / notification（如当前业务存在）/ AdminAudit

保持当前 Mock 业务语义，全部进入完整 Pg transaction。

---

## D. Coupon Template Admin Write Closure

迁移：

`couponTemplateTransaction`

当前 create / update / toggle 等既有管理动作。

要求：

Coupon Template 业务写 + AdminAudit

同事务。

不得新增新的券功能。

---

# Phase 1｜Requirement Check

编码前重新以当前代码为事实源。

必须读取并列出：

### T1

- `lib/services/checkout.ts`
- payment repository interface + Mock/Pg implementation
- coupon repository / redemption helper
- payment transaction
- coupon_claims schema
- orders/payment_requests/payments/dispatch schema
- T1 当前 Pg tests
- T12 / coupon restore Pg 路径

回答：

1. 当前 coupon redemption 的完整 Mock 语义是什么？
2. 当前 side effect 究竟发生在哪一层？
3. Pg T1 为什么会穿回 Mock？
4. coupon_claims 当前有哪些状态 / 字段 / 唯一约束？
5. 同一张 coupon 并发被两个订单消费，现在 Pg 层应如何保证 only one winner？
6. T1 与退款退券之间的锁顺序是否可能死锁？

不要凭旧文档猜。

### 三个 Admin Transaction

分别重建：

- read set
- write set
- lock set
- AdminAudit
- idempotency/replay identity
- notification
- external dependency

确认当前所有参与表都已经存在。

---

# Phase 2｜T1 设计要求

目标不是“把 coupon SQL 塞进 paymentRepository”这么简单。

必须先消除：

`Pg transaction callback → Mock couponStore side effect`

允许：

- 将当前 buildOrder 拆成纯构造 + transaction participant
- 增加明确的 Tx-aware coupon redemption helper
- 在 Pg confirm transaction 内调用 Pg coupon redemption
- Mock 路径继续维持原业务行为

不允许：

- Pg 层调用 Mock store
- Pg 层调用会偷偷获取第二条 Pool connection 的 helper
- Service 层手写 SQL
- Route 层处理事务

---

## Coupon 并发

真实数据库必须保证：

```text
同一 coupon claim
同时用于订单 A / B
→ 最多一个订单成功消费该券
```

不能只靠：

```text
SELECT status='unused'
→ UPDATE
```

而没有数据库并发保护。

根据当前 schema 和行为选择：

- row lock
- conditional update
- constraint

或组合。

以当前业务语义最小改动为准。

---

## T1 Rollback

必须证明：

### Case 1

coupon 核销成功后，后续 order/payment/dispatch 任一最后阶段失败：

```text
coupon → 仍 unused
order → 不存在
payment → 不存在
dispatch → 不存在
```

### Case 2

order/payment 已写，但 coupon redemption 失败：

全部 rollback。

不得产生半状态。

---

# Phase 3｜Pg Repository 写能力

在当前已有 Pg repository 基础上，仅补本轮需要的 write method。

预计涉及：

- PgCouponRepository
- PgPlatformConfigRepository
- PgComplaintRepository

具体接口以当前代码为准。

保持：

Repository = 数据访问  
Transaction = 原子业务流程  
Service = 业务编排  
Route = auth/parse/response

不得把 transaction business logic 塞进 Repository。

---

# Phase 4｜AdminAudit Closure Pattern

复用 PROD-1C 已建立的模式：

```text
withTransaction(tx)
  ↓
业务权威读取 / row lock
  ↓
replay / idempotency 判定
  ↓
业务写
  ↓
notification（当前行为有则写）
  ↓
appendAuditEntryTx(tx)
  ↓
COMMIT
```

AdminAudit 必须强一致。

禁止：

- commit 后写 audit
- fire-and-forget audit
- catch audit error 后继续
- 为省事重新走 Mock `writeAudit`

---

# Phase 5｜Platform Config

严格复制当前 Mock transaction 行为。

特别确认：

- 哪些 config key 可修改
- 校验范围
- version/update time
- admin identity
- audit action / target / metadata
- replay semantics

不要顺手修改配置模型。

---

# Phase 6｜Complaint

严格复制当前投诉处置状态机。

检查：

- 合法 source status
- target status
- admin intent
- reason
- timestamps
- notification
- 对订单 blocking fact 的影响
- AdminAudit

重点：

`complaints` 已经是订单 Pg transaction 的 read participant。

因此本轮完成后：

投诉的写者和订单的读者必须读取同一 PostgreSQL 真值。

---

# Phase 7｜Coupon Template

仅迁移现有：

- create
- update
- toggle / enable-disable

如当前还有其它既有模板管理动作，以代码实际存在为准。

必须保持：

- 唯一性
- 时间范围
- 金额/门槛
- enabled 状态
- AdminAudit
- replay/idempotency

不得重新设计优惠券产品规则。

---

# Phase 8｜Schema Discipline

AUDIT-PG-1 结论显示：

本轮四块业务所需基础表均已存在。

因此：

**默认 0 个新 migration。**

如果实现过程中发现：

必须增加数据库约束才能保证当前业务正确性，

不要偷偷改旧 migration。

先输出：

- 缺哪个 constraint
- 为什么应用层锁不足
- 是否属于 correctness requirement

如果只是性能/index 优化：

登记后置，不做。

绝对禁止修改 0001–0009 历史 migration。

---

# Phase 9｜真实 PostgreSQL Tests

所有关键用例必须连接：

`TEST_DATABASE_URL`

不能 fake Pg client。

至少覆盖：

## T1

- 无 coupon 正常支付
- 有 coupon 正常支付
- coupon 真正在 coupon_claims 变 used
- coupon != null 的 contract test
- 同券两订单并发 → exactly one winner
- payment replay 不重复核销
- coupon 核销后后续失败 → 全 rollback
- order/payment 写后 coupon 失败 → 全 rollback
- restart persistence
- same transaction/backend pid proof

## Platform Config

- update success
- duplicate/replay
- audit success
- audit final-write failure → config rollback

## Complaint

- admin disposition success
- invalid transition
- duplicate/replay
- order blocking read immediately sees updated Pg complaint state
- audit failure → complaint rollback

## Coupon Template

- create
- update
- toggle
- duplicate/replay
- concurrency on same template
- audit failure → template mutation rollback

---

# Phase 10｜Red-Green Proof

针对本轮最关键的不变量做最少量有效 mutation proof。

至少证明：

1. 去掉 T1 coupon 原子性保护时，并发用例会红
2. 去掉 Admin transaction 的事务边界时，audit failure rollback 用例会红
3. 去掉权威 replay 判定时，同键并发用例会红

不要为了凑红绿数量制造恒真断言。

---

# Phase 11｜Runtime Boundary

本轮结束仍然：

`DATA_SOURCE=postgres NOT ACTIVATED`

要求：

- 不接 Service runtime
- 不批量改 accessor
- 不让部分 Admin transaction 偷跑 Pg
- 不产生新的 half Pg / half Mock runtime

Pg implementation 先通过真实数据库测试证明。

正式 runtime activation 留到最终 activation round。

---

# Phase 12｜重新做 Activation Gap

本轮完成后重新统计：

- 28 个 Repository：Mock-only / Pg implemented / switchable / active
- admin writeAudit：已迁 / 未迁
- Pg transactions：已实现 / 未实现
- schema table count
- remaining P0 blockers

特别回答：

1. T1 coupon half-PG 是否彻底关闭？
2. platform_config 是否读写都已 Pg-ready？
3. complaints 是否读写都已 Pg-ready？
4. coupon_templates 是否读写都已 Pg-ready？
5. 剩余多少 AdminAudit writer？
6. 距离 activation 还剩几个闭包波次？

---

# Phase 13｜Regression Gate

运行：

- 本轮 targeted tests
- `pnpm test:pg`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

如仓库已有生产 APP_BASE_URL 全量测试流程：

也执行。

最终报告必须区分：

- 实际运行过
- 没运行过
- skipped 原因

禁止把旧文档数字当本次实跑数字。

---

# Phase 14｜Reviewer

独立只读 reviewer 检查：

- T1 是否仍存在 Pg→Mock side effect
- coupon 并发双花
- coupon rollback
- payment replay
- AdminAudit strong atomicity
- lock order / deadlock
- complaint/order cross-domain truth
- coupon template concurrency
- 第二连接泄漏
- 业务规则漂移
- migration discipline
- accidental runtime activation

最终要求：

`0 BLOCKER`
`0 MAJOR`

MINOR 可评估是否本轮整改。

---

# Phase 15｜Round 文档

建立：

`docs/03-dev/rounds/PROD-1D/`

标准五文件：

- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

最终只能到：

`PROD-1D = AWAITING_ACCEPTANCE`

不得自行 DONE。

---

# 编码前输出

Requirement Check 完成后先输出：

- Exact T1 Coupon Closure
- T1 current Mock leak
- T1 lock order
- Coupon concurrency strategy
- PlatformConfig closure
- Complaint closure
- CouponTemplate closure
- AdminAudit closure
- Migration necessity
- Test / rollback / concurrency plan
- Remaining activation blockers
- Blocking Decisions

如果：

`0 unresolved blocking decisions`

直接实现。

如果发现真正需要产品负责人裁定的问题：

一次性提出后停止。

---

# Git discipline

Claude 禁止：

- git add
- git commit
- git push
- git restore
- git reset
- git checkout
- git rebase
- git amend

只允许只读：

- status
- diff
- log
- show

所有 Git 写操作由用户本人完成。

---

# 附：同轮补充指令（用户本人，逐字）

## 补充 1 — Phase 0 重跑与继续开发

```text
已提交 PROD-1C closure docs，继续 PROD-1D。请重新执行 Phase 0；若通过，直接进入 Phase 1 Requirement Check，并按上一条 PROD-1D 指令继续开发。禁止任何 Git 写操作
```

## 补充 2 — 连接中断后的现场恢复要求

```text
刚才响应过程中连接中断。

不要假设上一条已经完整执行，也不要从头重复整个 Round。

请先只读恢复现场：

- `git status --short`
- `git diff --stat`
- `git diff`
- `git log --oneline -10`
- `docs/03-dev/rounds/PROD-1D/**`（如果已经建立）
- 当前相关 migration / Pg repository / transaction / tests

然后判断连接中断前实际已经做到哪里。

要求：

1. 已经落盘且正确的改动不要重复生成。
2. 未完成的步骤从实际断点继续。
3. 如果 Phase 0 尚未通过，继续停在 Phase 0。
4. 如果 Phase 0 已通过，则恢复 PROD-1D：
   `Admin Write Closure A + T1 Coupon Closure`
5. 如果已经进入实现阶段，先汇报：
   - 已完成
   - 未完成
   - 当前测试状态
   - 是否存在半成品/重复 migration 风险
6. 不要因为连接中断创建第二套 migration、第二套 repository 或重复 transaction。
7. 禁止任何 Git 写操作。

恢复完成后，若无 blocking decision，直接从断点继续开发。
```
