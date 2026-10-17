# Delivery

Round: PROD-1B

> ⚠️ **Verification 不得伪造**（`development-workflow.md` §十四）：
> **实际执行了哪些就记录哪些。没跑就说没跑，跳过就说跳过，红了就贴出红的输出。**

---

## 1. Implemented

本轮交付物 = `02-decisions.md` Q1 Final Execution Rule 第 1 条规定的那三样，缺一不可。

### 1.1 Schema（6 个新迁移，17 张表）

| Migration | 表 |
|---|---|
| `0003_companions.sql` | `companions` |
| `0004_orders_and_payments.sql` | `orders` · `payment_requests` · `payments` |
| `0005_dispatch_and_fulfillment.sql` | `dispatch_records` · `completion_submissions` · `companion_accept_events` · `companion_release_records` · `companion_service_events` |
| `0006_settlement.sql` | `refund_requests` · `earnings` · `earning_adjustments` · `notifications` |
| `0007_coupon.sql` | `coupon_claims` · `coupon_templates` |
| `0008_transaction_reads.sql` | `complaints` · `platform_config` |

即 Q1 §13a 裁定的 **17 张** = **13 张写参与者 + 4 张事务内读参与者**（§13a 的两条判据）。
其中第 14–17 张（`companions` / `complaints` / `platform_config` / `coupon_templates`）是**事务内读参与者**：
被某个写事务在事务内读取，因而必须与写入同库（`orderBlocking.ts:32-33` 已把这条写成硬要求）；
本轮**不要求**它们的 Pg 写者到位。
⚠️ 别与本轮别处的「**W1 写实体 15 张**」（`README.md:11`、`02-decisions.md:44`）混淆——
那 15 张是**闭包口径**（= 上列 13 张 + `admin_audit_entries` + `companions`），
其中 `admin_audit_entries` 本轮**不建**。两个数字出自不同划分，均以 `02-decisions.md` 为准。

**闭包内**引用一律建真 FK（`dispatch_records.order_id → orders`、`completion_submissions.order_id → orders`、
`earnings.order_id → orders`、`earning_adjustments.earning_id → earnings`、`companion_*_events.dispatch_id → dispatch_records` 等）。
**闭包外**引用（`users.id`、商品 / 目录 ID）以稳定 ID 文本存储、**不建 FK**，逐条登记在 §6。

约束（对应 `database-schema.md` C1–C10）：

- **C2 幂等键 → 唯一约束**（逐条对照迁移文件列出的**实际**索引，不凭印象）：

  | 索引 | 定义 | 迁移 |
  |---|---|---|
  | `dispatch_records_order_key` | `UNIQUE (order_id)` | `0005` |
  | `completion_submissions_pending_order_key` | `UNIQUE (order_id) WHERE status = 'pending'` | `0005` |
  | `companion_release_records_idempotency_key` | `UNIQUE (companion_id, idempotency_key) WHERE idempotency_key IS NOT NULL`（部分唯一索引） | `0005` |
  | `companion_service_events_segment_key` | `UNIQUE (order_id, companion_id, serving_at)` | `0005` |
  | `earnings_order_key` | `UNIQUE (order_id)` | `0006` |
  | `earning_adjustments_refund_key` | `UNIQUE (refund_id)` | `0006` |
  | `refund_requests_order_key` | `UNIQUE (order_id)` | `0006` |
  | `refund_requests_refund_no_key` | `UNIQUE (refund_no)` | `0006` |
  | `refund_requests_user_idempotency_key` | `UNIQUE (user_id, idempotency_key)` | `0006` |
  | `payment_requests_order_key` | `UNIQUE (order_id)` | `0004` |
  | `payment_requests_user_idempotency_key` | `UNIQUE (user_id, idempotency_key)` | `0004` |
  | `payments_payment_request_key` / `payments_order_key` | `UNIQUE (payment_request_id)` / `UNIQUE (order_id)` | `0004` |
  | `coupon_claims_self_claim_key` | `UNIQUE (user_id, coupon_id) WHERE source = 'self_claim'` | `0007` |
  | `coupon_claims_idempotency_key` | `UNIQUE (user_id, idempotency_key)` | `0007` |
  | `companions_user_active_key` | `UNIQUE (user_id) WHERE removed_at IS NULL` | `0003` |
  | `complaints_complaint_no_key` / `complaints_user_idempotency_key` | `UNIQUE (complaint_no)` / `UNIQUE (user_id, idempotency_key)` | `0008` |
  | `orders_order_no_key` | `UNIQUE (order_no)` | `0004` |

  ⚠️ **两处必须说清楚的「没有」**（评审时抓到本文档上一版写错，此处订正）：
  - `complaints` **没有** `order_id` 级唯一索引。即「同一订单最多一条未完结投诉」**不是**数据库保证的，
    与 Mock 一致，只在应用层判定（`mockComplaintRepository.createComplaint` 同样只查幂等键）。
    **两侧行为等价**，因此不是业务分歧；但任何「它在 DB 上被保护」的说法都是错的。
  - `coupon_claims` **根本没有 `order_id` 列**。它与订单的关联经 `coupon_claims.id` 存在
    `orders.coupon ->> 'claimId'` 这个 JSON 快照里（`0007` 的注释写明了理由）。
    因此「一单只能用一张券」由**订单侧的快照**表达，不是 `coupon_claims` 上的唯一约束。
- **C6 金额快照恒等式**：`orders` 上 `CHECK (club_net_income = actual_paid_amount - companion_base_income)`。
- **C8**：全部时间列 `timestamptz`；`pool.ts` 注册 OID 1184 解析器 → 读回**恒为 ISO 字符串**。
- **C9**：金额一律整数分（`integer` / `bigint`），比例用基点整数。
- **C4**：deadline 与其快照字段随对象**同表持久化**，不靠运行时重算。

### 1.2 Pg 实现（13 个仓储工厂 + 11 个 Pg 事务）

13 个 `createXxxRepository(db: PgQueryable)`：`companionAccept` · `companionRelease` · `companion` ·
`companionService` · `complaint` · `completion` · `coupon` · `dispatch` · `earning` · `notification` ·
`payment` · `platformConfig` · `refund`。每个工厂**同时**产出「进程级仓储」（传 `lazyPgExecutor()`）
与「事务内仓储」（传 `withTransaction` 给的 `TxHandle`），接口完全相同。

`lib/data/pg/w1Transactions.ts` 把 Mock 侧的**伪事务**（`// —— 原子区段开始（无 await）——` 那套，
正确性建立在「Node 单线程 + 段内不 await」上）重写为 PostgreSQL 真事务：

| # | Pg 事务 | 对应 Mock 原型 | 内容 |
|---|---|---|---|
| T2 | `acceptDispatchPg` | `companionDispatchTransaction.ts` `acceptDispatch` | 接单 |
| T3 | `sweepExpiredDispatchesPg` | 同上 `sweepExpiredDispatches` | 派单超时清扫（转公共池 / 自动退款） |
| T4 | `cancelAcceptedOrderPg` | `companionOrderTransaction.ts` `cancelAcceptedOrder` | 护航主动取消接单 |
| T5 | `startCompanionOrderPg` | 同上 `startCompanionOrder` | 护航开始服务 |
| T6 | `releaseOrderByStaffPg` | 同上 `releaseOrderByStaff` | 客服退回公共池 |
| T7 | `replaceOrderCompanionByStaffPg` | 同上 `replaceOrderCompanionByStaff` | 客服直接换人 |
| T9 | `submitCompletionPg` | `completionTransaction.ts` `submitCompletion` | 提交完成材料 |
| T10 | `approveCompletionPg` / `rejectCompletionPg` | 同上 `approveCompletion` / `rejectCompletion` | 客服审核 |
| T11 | `sweepCompletionAutoApprovalsPg` | 同上 `sweepCompletionAutoApprovals` | 到期自动通过 |
| T12 | `directRefundOrderPg` | `directRefundTransaction.ts` `directRefundOrder` | 直接退款 |
| T13 | `sweepMaturedEarningsPg` | `earningTransaction.ts` `sweepMaturedEarnings` | 收益到期解冻 |
| T1 | `pgPaymentRepository.createPaymentRequest` / `confirmPaymentRequest` | `mockPaymentRepository.ts` 同名 | 支付请求与确认（T1 落在仓储上，不在 `w1Transactions.ts`） |

**共 11 个入口文件内的事务 + T1 的仓储内实现。** T4 / T6 / T7 共用同一个事务内写入器
`releaseCurrentAssignmentTx`（对应 Mock 的 `releaseCurrentAssignment`）。

#### 事务入口边界审计（本轮补做，判定标准见下）

评审时抓到本文件上一版把 `sweepExpiredDispatchesPg`（T3）列进了「已交付」——
**它当时确实不存在**（全仓 grep 零命中）。上一版的处置是把它连同 T4 / T5 / T6 / T7 一起
推给下一轮，理由是「不在这两份清单里」。**这个理由不成立**：判据不该是「清单里有没有写」，
而应该是**该事务的完整原子写集合是否已经全部属于本轮已建的 17 张表**。
按这个统一标准重判，T3 / T4 / T5 / T6 / T7 **必须在本轮实现**，已补齐：

| Tx | 当前业务动作 | 完整写集合 | 是否全部属于已建 W1 表 | 未实现原因 | 裁定 |
|---|---|---|---|---|---|
| **T3** | 派单超时清扫（专属→公共池；公共池→关闭 + 自动退款） | `dispatch_records` · `orders` · `notifications` · `coupon_claims` | ✅ 全部 | 无 | **本轮实现**（补齐） |
| **T4** | 护航主动取消接单 | `orders` · `dispatch_records` · `completion_submissions` · `companion_release_records` · `notifications` | ✅ 全部 | 无 | **本轮实现**（补齐） |
| **T5** | 护航开始服务 | `orders` · `companion_service_events` | ✅ 全部 | 无 | **本轮实现**（补齐） |
| **T6** | 客服退回公共池 | 同 T4（`source = staff_reassign`） | ✅ 全部 | 无 | **本轮实现**（补齐） |
| **T7** | 客服直接换人 | 同 T4（`source = staff_reassign` + 派单改绑，不写 `companion_accept_events`） | ✅ 全部 | 无 | **本轮实现**（补齐） |
| **T8** | `releaseOrdersForCompanion` ← `setCompanionFlags` | 同 T6/T7 **＋ `admin_audit_entries`** | ❌ 跨边界 | 原子段含 `writeAudit`；`admin_audit_entries` 按 Q1 规则 10 本轮不进 Pg | 可延期 PROD-1C |
| **T14** | 售后台审 `approveRefund` / `rejectRefund` | `refund_requests` · `orders` · `earnings` · `earning_adjustments` · `notifications` **＋ `admin_audit_entries`** | ❌ 跨边界 | 同上 | 可延期 PROD-1C |
| **T15** | 售后发起 / 进入审核 `startReviewRefund` | `refund_requests` · `orders` **＋ `admin_audit_entries`** | ❌ 跨边界 | 同上 | 可延期 PROD-1C |

T8 / T14 / T15 的延期理由按统一格式登记：
**`Pg implementation deferred because full atomic write closure crosses PROD-1B boundary`**
——即它们的原子写闭包必须**同时**写 `admin_audit_entries`，而该表不在本轮已建的 17 张表内；
拆开写就违反 Hard Rule 1（禁止半事务），把 `admin_audit_entries` 顺手迁进来则违反 Q1 规则 10 与
「不擅自扩 Scope」。**不是「暂未实现」，是一条明确的边界裁定**，且是 **PROD-1C 的前置条件**。

形态一律 `BEGIN → 条件 UPDATE / SELECT … FOR UPDATE → 业务闸 → 写入 → COMMIT`，
隔离级别 **READ COMMITTED**（未擅自上 SERIALIZABLE——正确性靠条件更新与唯一约束，
不靠隔离级别），时钟**由调用方传入**（`at` 参数），事务内不读墙钟。

#### ⚠️ 加锁顺序全库统一为「`orders` 永远是第一把锁」

补齐 T4 / T6 / T7 时发现一处**真实缺陷**（不是本轮新引入的，是「把 Mock 翻译成真锁」才暴露的）：
T4 / T6 / T7 必须**同时**动 `orders` 与 `completion_submissions`（订单回 `paid` ＋ 作废在途完成材料），
而此前 T10 / T11 的取锁顺序是 `completion_submissions → orders`。两条互补顺序**立刻成环**，
并发下会被 PostgreSQL 死锁检测杀掉（SQLSTATE `40P01`）——而 Mock 的同一段业务**永远不会**失败。

处置：把 T10 / T11 的**取锁顺序倒过来**（先用一次普通读拿到 `order_id`，再按统一顺序加锁；
**判定与写入一个字未改**），全库收敛到「订单永远是第一把锁」。
规则与逐事务的顺序表写在 `lib/data/pg/w1Transactions.ts` 文件头，并注明「若将来新增一条
先锁 `completion_submissions` 再锁 `orders` 的路径，必须回头改这里」。

⚠️ 精确定义（复审订正）：**唯一必须守住的不变量是「第一把锁是 `orders`」**，
它只约束**既要动 `orders`、又要动别的行**的事务。第一把锁**之后**的次级顺序不影响正确性
（订单锁已把同一张订单上的后来者串行化）。两条**不碰 `orders`** 的路径因此天然无环，
已在文件头表中显式列为例外：`rejectCompletionPg`（仅 `completion_submissions`）与
`sweepMaturedEarningsPg`（仅 `earnings`）。

### 1.3 行映射收敛（本轮新增的防漂移结构）

新增 `lib/data/pg/w1Rows.ts`：W1 写闭包内**每一张表 ↔ 领域对象**的**唯一**一份映射
（列名数组 / 行类型 / `toXxx` 映射函数）。13 个仓储与 `w1Transactions.ts` 全部从这里取，
不在各自文件里再写一份 `orders` 的 38 列副本——**漏掉一个列不会报错，只会让某个页面悄悄少显示一个字段**。
这是等价翻译的**可读、可核对**形式。

### 1.4 明确**没有**做的事

- 没有切换 active datasource：`DATA_SOURCE` 保持不设置，应用真实业务路径仍 **100% Mock**。
- 没有新增 / 修改任何业务规则（Hard Rule 2）。
- 没有把任何 Pg 实现接进 `lib/services/**`、`app/api/**` 或仓储 accessor。
- 没有修改 `0001` / `0002`。

## 2. Files Changed

**修改（5）**

| 文件 | 改动 |
|---|---|
| `docs/03-dev/总需求进度表.md` | +1 / −0 行：新增 PROD-1B 行（状态 `⏳ AWAITING_ACCEPTANCE`） |
| `lib/data/pg/seed.ts` | +555 / −1 行：为 17 张新表补种子数据（让 Pg 测试与 Mock 种子在同一起点；parity 测试依赖它） |
| `tests/pgContract.test.mjs` | +864 / −0 行：W1 parity 段（**W1 读侧 10 条**覆盖 13 组仓储 + **W1 写侧 6 条**覆盖 12 个写方法，Mock ↔ Pg 逐方法对照）；全文件另有 PROD-1A 6 条 |
| `tests/pgFoundation.test.mjs` | +211 / −25 行：新表的迁移 / 约束 / 解析器覆盖 |
| `tests/pgConfig.test.mjs` | +13 / −1 行：随新表调整配置断言 |

> 行数口径：`+A / −B` 一律是 `git diff --numstat` 的「新增 / 删除」两列，两数相加即该文件的总改动行数。

**新增（23）**

```
db/migrations/0003_companions.sql                        75
db/migrations/0004_orders_and_payments.sql              238
db/migrations/0005_dispatch_and_fulfillment.sql          253
db/migrations/0006_settlement.sql                        244
db/migrations/0007_coupon.sql                            114
db/migrations/0008_transaction_reads.sql                 116

lib/data/pg/w1Rows.ts                                    436
lib/data/pg/w1Transactions.ts                           1924
lib/data/pg/companionAcceptRepository.ts                 123
lib/data/pg/companionReleaseRepository.ts                 94
lib/data/pg/companionRepository.ts                       349
lib/data/pg/companionServiceRepository.ts                155
lib/data/pg/complaintRepository.ts                       307
lib/data/pg/completionRepository.ts                      107
lib/data/pg/couponRepository.ts                          437
lib/data/pg/dispatchRepository.ts                         81
lib/data/pg/earningRepository.ts                         130
lib/data/pg/notificationRepository.ts                    109
lib/data/pg/paymentRepository.ts                         566
lib/data/pg/platformConfigRepository.ts                   90
lib/data/pg/refundRepository.ts                          315

tests/pgW1Transactions.test.mjs                         1973

docs/03-dev/rounds/PROD-1B/                             （本轮文档）
```

⚠️ `0001` / `0002`（PROD-1A）**未改动**。`lib/data/pg/` 下既有的 `favoriteRepository.ts` /
`suggestionRepository.ts` / `pool.ts` / `executor.ts` / `migrate.ts` / `reset.ts` / `health.ts` /
`cli.ts` / `config.ts` **未改动**。

## 3. Business Rules Implemented

**无。** 本轮是对同一批写入的**等价翻译**（Hard Rule 2），不新增、不修改任何业务规则。
（若实现过程中发现旧逻辑疑似缺陷，按 Hard Rule 2 登记到 §7，不擅自改。）

## 4. Tests Added / Updated

### 4.1 `tests/pgW1Transactions.test.mjs`（新增，1973 行，66 个用例）

本轮的核心实证套件，**全部真连 `TEST_DATABASE_URL`**，无 fake / stub client。

| 覆盖 | 用例 |
|---|---|
| **T2 接单** | 成功接单（状态 / 快照 / 事件 / 通知）；**并发抢单恰好一个成功**；重放**幂等**（不产生第二条事件 / 通知）；已超时不可接；专属池资格；不能接自己的单；订单已关闭不可接 |
| **T3 超时清扫** | 专属池到点 → 转公共池（进池时刻取**到点那一刻**、按当下配置重冻）且订单 / 金额不动；公共池到点 → 关池 + **自动全额退款**；重复清扫一个字节不写；**停摆后一次调用连跳两级**；已出过款的单只关池、**不出第二笔钱**并**不发重复通知**；同一条连接；中途失败整笔回滚 |
| **T4 主动取消** | 订单回 `paid` / 派单回公共池 / 退出历史 / 通知用户；**`ever_accepted_at` 保留**；重放（同幂等键）不写第二条历史、不刷新时刻；幂等键被用到别的单上 → `not-found`；非本人 → `not-found`；状态非 `accepted` → `not-accepted`；**作废在途完成材料**；中途失败四项全回滚 |
| **T5 开始服务** | 订单转 `serving` + `serving_at` + **服务历史**（含当时那份公开快照）；重放（状态本身即幂等判据）不刷新时刻；非本人 → `not-found`；状态非 `accepted` → `not-startable`；**同一服务段唯一约束只留一行**；中途失败订单与服务历史一起回滚 |
| **T6 客服回池** | `accepted` 与 **`serving`** 都能回 `paid`（`serving_at` 一并清空）；退出历史记**被解除的那位**与客服为触发者、无幂等键；非履约中 → `not-releasable`；订单不存在 → `not-found`；派单丢失 → `dispatch-missing`；中途失败整笔回滚 |
| **T7 客服换人** | 订单连写两次到 `accepted`（中间那个 `paid` 不对读者可见）、派单改绑、`accepted_via = 'staff'`、**不产生接单事件**；换人时作废在途完成材料；`same-companion` / `companion-not-found` / `companion-unavailable` / `self-order` / `not-replaceable` 五条拒绝路径；中途失败含派单改绑一起回滚 |
| **同事务实证** | 事务内所有参与者写入的 `pg_backend_pid()` **完全相同**（`TxHandle.connectionId`） |
| **回滚实证** | 事务中途强制失败（`w1_probe` 触发器 `RAISE EXCEPTION`）→ 业务表与通知表**行数与失败前逐表相等** |
| **持久化实证** | `closePool()` 关闭连接池后重连，数据仍在 |
| **T9 提交完成材料** | deadline 快照往返（写入 `auto_approval_minutes_snapshot` / `auto_approval_deadline_at` 与读回一致）；非履约人取不到；订单非 `serving` 拒绝；已有 pending 拒绝 |
| **T10 审核** | 通过后重放不重复写；驳回后旧提交不被覆盖；「过期提交」（stale submission）不被误审 |
| **T11 自动通过扫描** | 到点的被自动通过且 `review_source = 'system'`；**没到点的不扫**；被「进行中的退款」挡住 |
| **T13 收益解冻扫描** | 到期的从 `frozen` 转 `available`；净额为 0 不解冻；被「未完结投诉」挡住且**不重复解冻** |
| **T12 直接退款** | 整笔退款且给**打手所在用户账号**发通知；重复调用是 no-op；**并发只产生一次出款**；订单非可退状态拒绝；金额非法拒绝；优惠券恢复 / 不恢复；中途失败整笔回滚 |

⚠️ 探针（`PROBED_TABLES`）在补 T4 / T5 / T6 / T7 时扩到 **10 张**：除原先的 8 张外，
加了 `companion_release_records` 与 `companion_service_events`——否则
「中途失败时退出历史 / 服务历史也一起回滚了吗」这句话在本文件里**无法证伪**。

测试的可证伪性依赖三个自建 fixture（写在测试文件里，不是生产代码）：

- `makeExclusiveDispatch()`：把一张**公共池**待接单**改造成**专属池（种子数据里没有现成的
  `paid + exclusive` 组合），因此每个用例的前置状态是**显式构造**的，不是「碰巧找到的」。
- `findRefundableOrder()`：选一名 `user_id IS NOT NULL AND removed_at IS NULL` 的护航并
  把订单的 `actual_companion_id` 接上。**为什么必须这么造**：退款通知的收件人是**打手所在的用户账号**
  （`REFUND_NOTIFICATION_COMPANION_REFUNDED`），公共池订单**不会产生任何通知**——
  用公共池订单测「退款通知」等于在测一条不存在的路径。
- `findServingOrder({ clean = true })`：选一张 `serving` 订单并 **DELETE** 掉它身上的
  `refund_requests` / `complaints` 行（**只能 DELETE，不能改状态**：`refund_requests_order_key`
  是 `UNIQUE(order_id)`，改状态会与其它用例撞键）。种子里两张 `serving` 订单各带一条阻断事实
  （一张有 `reviewing` 退款、一张有 `pending` 投诉），因此这条清理是**必要**的。

### 4.2 `tests/pgContract.test.mjs`（288 → 693 行，6 → 16 个用例）

> ⚠️ 本节只覆盖**读侧**。写侧那一组是交付后按 reviewer `M2` 补的，见 **§4.3**——

W1 的 Mock ↔ Pg **契约对照**（`directory-structure.md` §迁移四步的第 4 步）。
新增 13 组对照，逐方法断言两侧返回**逐字段相同**（`assertSameObservation`：先比方法键集合，再 `deepEqual`）。

对照两侧**有意不同的排序**时（Mock 是 Map 插入顺序，Pg 是显式 `ORDER BY`），
在 `observe` 里用 `byId()` / `byIdField()` 归一化后再比 —— 归一化的是**顺序**，不是**内容**。
`DerivedAcceptEvent` / `DerivedServiceEvent` 没有 `id` 字段，按 `dispatchId` / `orderId` 排，
否则排序是「碰巧对的」（`String(undefined)` 比较结果恒定），会让真实的内容差异被误报成顺序差异。

**登记的已知差异（1 条，不修）**：`queryCompanions({ availability: "" })` 两侧口径不同——
Mock 的三元链把 `""` 解析成 `!companion.available`（只看休息中的），
Pg 把 `""` 当成「不加条件」（等价于 `all`）。已验证 `lib/services/companions.ts:69` 的公开路径
**永远**传 `availability ?? "all"`，因此 `""` 在公开路径上不可达。
按 Hard Rule 2 **两侧实现都不动**，改为把 parity fixture 换成 `availability: "all"`，
并**显式**留一条用例把两种行为都钉住：

```js
test("已知差异：queryCompanions 传空 availability 时两侧口径不同（登记，不修）", ...)
```

### 4.3 `tests/pgContract.test.mjs` 写侧对照（评审 `M2` 的整改；693 → 1152 行，16 → 22 个用例）

**为什么必须补**：上面那一大组只比**读**。它有一个结构性盲区——种子的每一行当初就是
按「列清单」写进去的，所以「`INSERT` 的列名顺序」与「取值数组顺序」一旦错位，
两侧读到的仍是各自已经写好的种子行，**错位的那条 SQL 根本没被任何用例执行到**。

这不是假设。交付初版真的踩到了三处（评审 `B1`/`B2`/`B3`）：

| # | 文件 | 错位形态 | 逃过读侧测试的原因 |
|---|---|---|---|
| B1 | `lib/data/pg/refundRepository.ts` | `idempotencyKey` 写在第 12 位（`created_at` 的位置） | 只跑读查询，`INSERT` 从未执行 |
| B2 | `lib/data/pg/complaintRepository.ts` | 同上 | 同上 |
| B3 | `lib/data/pg/companionRepository.ts` | `insertValues` 按**建表 DDL 的列序**取值，列清单用的是 `w1Rows.ts` 的顺序 | 同上 |

三处的报错都不是编译错，而是 PG 运行时的 `22007`（无效 timestamptz 文本）/ `42804`（类型不匹配）。

**新增的 6 条写侧用例**（每个仓储一条，覆盖 12 个写方法）：
`createCompanion` / `updateCompanion` / `markCompanionRemoved` · `createComplaint` ·
`createClaim` / `createGrant` · `createNotification` / `markNotificationRead` ·
`createPaymentRequest` / `confirmPaymentRequest` · `createRefundRequest` / `cancelRefund`。

每条用例都**真的写一行进去再读回来**，仍用同一个对称的 `assertSameObservation`。
两个实现之间**本来就会不同**的两类值先归一化（并由类型断言补回）：

1. `createNotification` 生成的 `id` / `createdAt`（Mock 用 `newNotificationId()` + 进程墙钟，
   Pg 用 `crypto.randomUUID()` + 数据库 `now()`）→ 归一化成占位符，另断言 `id` 形状为 `nt_…`；
2. `confirmPaymentRequest` 的 `confirmedAt`（同上）→ 归一化成 `<确认时刻>`。

契约字段（金额、状态、快照、外键、幂等命中后返回哪一条）一个都没被抹掉。

**红-绿实证（这三条用例确实能抓住这一类错）**：把 B1 / B2 / B3 逐个临时改回去，重跑本文件，
**每次都恰好只有对应的那一条用例变红**，且报错就是当初那个 PG 错误：

| 临时改回 | 结果 | 报错 |
|---|---|---|
| B3（`companionRepository.insertValues` 换回 DDL 列序） | 22 条中 **1 红**（护航写侧） | `无效的类型 integer 输入语法: "true"` |
| B2（`complaintRepository.insertValues` 把幂等键放回第 12 位） | 22 条中 **1 红**（投诉写侧） | `无效的类型 timestamp with time zone 输入语法: "w-cmp-key-1"`（`22007`） |
| B1（`refundRepository.insertValues` 同上） | 22 条中 **1 红**（退款写侧） | `无效的类型 timestamp with time zone 输入语法: "w-rf-key-1"`（`22007`） |

三次都改回正确版本后才产出下面的 §5 结果。

### 4.4 `tests/pgFoundation.test.mjs`（+186）与 `tests/pgConfig.test.mjs`（±14）

新表的迁移可重放性、约束存在性、`timestamptz` 解析器覆盖与配置断言。

### 4.5 边界审计整改面的**收窄复审**（只审新增面，未重跑完整 reviewer）

补齐 T3–T7 之后按指令只对**新增整改面**做了一次只读复审
（`lib/data/pg/w1Transactions.ts` 的新增部分 + 被波及的 T10/T11 取锁倒置 + 34 个新用例 + 文档改动）。
**结论：`0 BLOCKER / 0 MAJOR`。**

复审确认（逐条对照 Mock 原型，非凭印象）：判定顺序 / 守卫 / 幂等判据 / 写入字段集合 / 写入时刻
与 Mock 逐条等价；`ever_accepted_at` 保留、`serving_at` 与 `accepted_via` 随解除清空、改绑写 `'staff'`；
T3 的追平与幂等成立且 `refundedOrderIds` 不报假账；五条回滚用例使探针在被测事务的**最后一笔写入**处失败，
`PROBED_TABLES` 的 10 张表覆盖了每条回滚断言涉及的全部表，且 `w1_probe_fail` 不跨用例泄漏；
`appendNotification` 未被降级为 `ON CONFLICT DO NOTHING`。

复审提出的 **2 条 MINOR（均为文档与代码事实不符，不影响运行正确性）已当场订正**：

1. 文件头「加锁顺序」表把 T4/T6/T7 的次级顺序写成 `completion_submissions` → `dispatch_records`，
   与代码事实相反（实际是 `orders` → `dispatch_records` → `completion_submissions`）。
   **已按代码事实改正**，并顺带把「唯一硬约束是第一把锁 `orders`」这一定义写精确，
   另补齐两条不碰 `orders` 的例外路径（见 §1.2）。
2. §6.6 原写 `complaints` 无 Pg 写者，与 `pgComplaintRepository.createComplaint` 及本文件 §4.3 自相矛盾。
   **已订正**为「`complaints` 有仓储级 Pg 写者，但不是任何 W1 事务的写目标」。

另据复审提醒，把测试里一句**过度声称**的断言注释改精确（T7 的「中间那个 `paid` 不可见」——
该断言证的是终态；「中间态不可见」是单事务 + 行锁的机制推论，没有并发读者就无法在一条断言里直接测到，
现已在测试里写明，不再假装测了它）。

⚠️ 复审提到 `pnpm test` 的**总量 1999 无法静态复算**（`test(` 声明约 1983 条）。
本文档记的 1999 是**真实运行输出**（`tests 1999 / pass 1999 / fail 0 / skipped 0`），
静态计数差异来自运行期生成的用例，不影响该数字；`pnpm test:pg` 的 **132** 复审已独立复算一致
（66 + 22 + 27 + 17）。

## 5. Verification

全部命令在本机 `D:\vs\微信小程序\web` 执行，时间为 2026-10-05。
**下面每一个数字都是本轮真实输出**，没有一处是「应该会过」。

### 5.1 迁移与静态门禁

| 命令 | 结果 |
|---|---|
| `pnpm db:migrate --target=test` | `迁移完成：本次执行 0 条，跳过 8 条。`（0001…0008 逐条「已是最新，跳过」），**无 checksum 不符** |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | `exit 0` |
| `pnpm lint`（`eslint`） | `exit 0` |
| `pnpm build` | `exit 0`（Turbopack） |

⚠️ 第一条是**专门用来证 §6.11 的门禁没被触发**的：`0005_dispatch_and_fulfillment.sql`
注释里那套 T 号与 `02-decisions.md` 对不上，本轮**故意不改那个注释**——
改动迁移文件一个字节，就会让已经跑过它的库被判定为「已执行的迁移被篡改」。
对账一律以 `02-decisions.md` 为准（见 §6.11）。

### 5.2 测试

| 命令 | tests | pass | fail | skipped |
|---|---|---|---|---|
| `pnpm test:pg` | 132 | **132** | 0 | **0** |
| `pnpm test`（不加载 `.env`：PG 与 HTTP 用例整体 skip） | 1999 | 1701 | **0** | 298 |
| 生产全量（见下） | 1999 | **1999** | **0** | **0** |

⚠️ 三行都是**补齐 T3–T7 之后**用同一份最终代码跑出的：合计从 1965 涨到 **1999**（+34 条），
`skipped` 从 264 涨到 **298**（PG 用例整体 skip 的那一支同样多了 34 条）。

生产全量那一行是仓库里 `test` 与 `test:pg` 两个脚本的**并集**，再补上 HTTP 用例要的 `APP_BASE_URL`：

```
APP_BASE_URL=http://localhost:3100 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
    --env-file-if-exists=.env --import ./tests/alias-hook.mjs --test-concurrency=1 \
    --test "tests/*.test.mjs"
```

前置：`pnpm build` 之后以 `PORT=3100 npx next start -p 3100` 起一个**生产构建**的服务
（服务端自己加载 `.env`）。HTTP 用例打的是真实进程，不是内存桩。

### 5.3 ⚠️ 必须如实记下的一次「红」，及其处置（**不是**回归）

同一天更早的一次全量运行出现过 **6 条失败**，全部集中在 `tests/http-smoke.test.mjs`，
症状完全相同：榜单「今日」桶为空（`today total = 0`、`yesterday total = 3`）。

**根因（先在活着的服务上取证，没有猜、也没有动任何断言）**：
`getMockSeedNow()`（`lib/mocks/fixtures/mockClock.ts`）**每进程只钉一次** `new Date()`，
而 `buildRankingPeriodOrders(now)` 把「今日」的订单夹进 `[北京时间当天 00:00, seedNow)`。
那一次服务进程是在**北京时间午夜之前**启动的，于是「今日」订单落在了 **10-04**；
榜单查询用的却是**真实** `now()` 的北京日边界（10-05）——`today` 自然是 0。
**重启服务后同一个接口立刻从 0 变成 5 条**，证实是环境时钟工件，不是代码问题。

**处置**：只重启服务（`TaskStop` → `netstat -ano | grep :3100` 找到残留 PID →
`taskkill //F` → 确认端口已释放 → 重新 `next start`）。
**没有**删断言、没有 skip、没有放宽任何业务要求——这三件事在任何情况下都不做。
上面 5.2 的三个数字全部来自**重启之后**的运行。

（记下这条的另一个理由：**这个坑会再犯**。种子时钟按进程钉死、榜单区间用真实时钟，
任何在午夜前后启动服务的同伴都会再看到同样那 6 条红，而它**不是**代码问题。）

## 6. Known Limitations

### 6.1 ⚠️ 本轮**不切数据源**；`DATA_SOURCE=postgres` **不是**可用的迁移验证模式

按 `02-decisions.md` Q1 Final Execution Rule 第 3 条（逐字）：

> 「`DATA_SOURCE` 本轮保持不设置。应用默认仍跑 Mock。
> `DATA_SOURCE=postgres` 在本轮**仍不是**可用的迁移验证模式 —— 因为闭包尚未含管理端审计分支。」

**实测现状**：`.env` 中**没有** `DATA_SOURCE` 这一项（只有 `DATABASE_URL` 指向 `chaoge_esports_dev`、
`TEST_DATABASE_URL` 指向 `chaoge_esports_test`）。应用真实业务路径仍 **100% Mock**。

**这意味着**：本轮验收**不能**用「打开页面看有没有变化」来验——不设置 `DATA_SOURCE` 时应用行为与上一轮**完全一致**，
这是裁定结果，不是漏做。（见 `04-acceptance.md` §〇。）

**为什么 `DATA_SOURCE=postgres` 现在仍不可用**：17 张表之外的 `admin_audit_entries` 没进 Pg，
而 T8 / T14 / T15 的原子段含 `writeAudit`。此时扳开关会**同时**踩中两条硬规则——
「同一张表两个住址」与「半 PG 半 Mock 事务」。因此本轮**不提供**任何可切换路径。

### 6.2 仓储迁移四步的第 3 步（accessor 分支）**本轮刻意不做**

`directory-structure.md` §迁移四步的第 3 步是在 `lib/data/<实体>Repository.ts` 里加
`isPostgresDataSourceEnabled() ? pgXxx : mockXxx` 分支。**本轮不加。**
理由：`orders` 的写者里还有 T8 / T14 / T15 只存在于 Mock，加了分支就等于**制造** 6.1 描述的那个禁止状态。
accessor 切换属于 **activation 轮**，不属本轮。

### 6.3 Pg 事务是**并行实现**，不是「换一个仓储」

`lib/data/pg/w1Transactions.ts` 与 `lib/data/*Transaction.ts`（Mock 原型）是**两份并存的编排代码**，
不是同一段代码换存储。因此本轮存在一处真实的长期成本：**Mock 原型改了业务规则，Pg 版本不会自动跟着改**。
缓解措施是 `tests/pgContract.test.mjs` 的逐方法对照与 `tests/pgW1Transactions.test.mjs` 的行为断言；
但在 activation 之前，**两边的一致性靠测试守，不靠类型守**。
（这也是 `01-prompt.md` Phase 12 明确要求的过渡形态：不得先删 Mock 事务。）

### 6.4 `dispatch_records.accepted_via` 当前**可空**，与 TARGET 不一致

`db/migrations/0005_dispatch_and_fulfillment.sql:58-63`：该列可空，
`CHECK (accepted_via IN ('companion', 'staff'))`。原因是它是 P1-5 才加的，
存量 `accepted` 记录上为 null，与 `DispatchRecord.acceptedVia: DispatchAcceptSource | null` 一致。
`database-schema.md` 的 TARGET 要求「NOT NULL + 存量回填 `'unknown'`」。
**本轮不改**（改它要改存量业务数据，违反 Hard Rule 2）。登记为 **activation 前必须完成的 TARGET 项**。

### 6.5 8 张表本轮**不写种子数据**

17 张表里 **9 张**有种子（`companions` · `orders` · `dispatch_records` · `coupon_templates` ·
`coupon_claims` · `notifications` · `complaints` · `refund_requests` · `platform_config`），
**8 张为空**：`payment_requests` · `payments` · `completion_submissions` · `earnings` ·
`earning_adjustments` · `companion_accept_events` · `companion_release_records` · `companion_service_events`。

这 8 张的空态是**有意的**：它们的数据由**事务**产生，不是「预置事实」。测试需要它们时就地构造
（如 T2 的接单事件、T10 的收益）。**不猜历史数据**（`01-prompt.md` Phase 9）。
⚠️ 后果：`pgContract.test.mjs` 对这几张表的对照只能覆盖**空集与构造态**，不是「预置数据的逐行对照」。

### 6.6 第 14–17 张表是**只读叶子**，本轮不要求其 Pg 写者到位

`companions`（写者含 T8 与管理端事务）· `complaints` · `platform_config` · `coupon_templates`
进 Pg 的唯一理由是**「写事务的读必须与写同库」**（`lib/data/orderBlocking.ts:32-33` 自带注释已把这条写成硬要求），
不是「为了 FK 完整性」（用户规则 9 允许的范围）。
其中 `companions` 本轮**确实**有 Pg 写者（`pgCompanionRepository`）；
`complaints` **也有**仓储级 Pg 写者（`pgComplaintRepository.createComplaint`，
见 §4.3 的写侧契约用例），但它**不是**任何 W1 事务的写目标——它进闭包的唯一理由是
`readOrderBlockingFacts` 要在事务内读它；`platform_config` 与 `coupon_templates` **没有** Pg 写者
（`createPlatformConfigRepository` 只产 `getConfig`；coupon 仓储只 `listCouponTemplates`，
它写的是 `coupon_claims`）。**已按用户规则 9 逐条登记于此。**

### 6.7 闭包外引用以**稳定 ID 文本**存储，**不建 FK**

按用户规则 9（`02-decisions.md` Q1 §13c）：闭包内一律建真 FK；**闭包外**的引用本轮**不建 FK**，
以稳定 ID 文本存储，待最终闭包迁移阶段再补。清单：

| 列 | 指向 | 为什么本轮不建 FK |
|---|---|---|
| `orders.user_id` | `users.id` | `users` 属于其它业务域，本轮不迁 |
| `orders.product_id` / `spec_id` | 商品 / 目录 | 目录域未迁 |
| `orders.actual_companion_id`（文本侧） | `companions.id` | **闭包内**，已建 FK；此处仅说明它不指向 `users` |
| `favorites` / `suggestions` 的既有引用 | （PROD-1A，未改） | 同上 |
| `notifications.user_id` · `refund_requests.user_id` · `complaints.user_id` | `users.id` | 用户域未迁 |
| `coupon_claims.user_id` | `users.id` | 同上 |

⚠️ **不得**用这个策略让**闭包内**的表逃避迁移——本轮闭包内的 15 张表**全部**建了表。

### 6.8 T8 / T14 / T15 本轮**不产出可激活的 Pg 事务**

`setCompanionFlags`（T8）· `approveRefund`（T14）· `startReviewRefund` / `rejectRefund`（T15）
的原子段含 `writeAudit`，而 `admin_audit_entries` 按 Q1 规则 10 本轮**不进 Pg**。
按 Hard Rule 1 不得把原子段拆成「业务写 PG、审计写 Mock」，因此它们**整体留在 Mock**。

**延期登记（统一格式，不得只写「暂未实现」）**：
**`Pg implementation deferred because full atomic write closure crosses PROD-1B boundary`**
——判据是**完整原子写闭包**是否越过了本轮边界，而不是「在不在某份清单里」。
这三个事务的业务写入（`orders` / `refund_requests` / `earnings` / `companion_*`）本身**都在**
本轮已建的 17 张表内，唯独 `admin_audit_entries` 不在。完整的边界审计见 §1.2
（该表逐 Tx 列出写集合与裁定）。

⚠️ **`pgCompanionRepository` 的存在不等于 T8 可激活**——它是为「事务内读 `companions`」准备的，
不是 T8 的 Pg 实现。**这是 PROD-1C 的前置条件，不是本轮遗漏。**

### 6.9 登记的已知差异：`queryCompanions({ availability: "" })`

Mock 把空串解析成「只看休息中的」，Pg 把空串当成「不加条件」。已验证公开路径
（`lib/services/companions.ts:69`）**永远**传 `availability ?? "all"`，因此该输入在公开路径上不可达。
按 Hard Rule 2 **两侧实现都不改**，改为在 `tests/pgContract.test.mjs` 里留一条
**登记用例**把两种行为同时钉住。详见 §4.2。

### 6.10 登记的文档漂移：`docs/01-requirements/超哥电竞_业务流程表.md §17`

按 `02-decisions.md` Q2（Final Execution Rule）：该文件 §17 仍写着按比例的冲回公式
`companionReversal = floor(companionBaseIncome × refundRate)`，而 **P0-15** 已改为**整笔冲回**。
业务流程表自身 §7 规定了优先级（「最新明确产品决定 > …」），故 P0-15 是唯一有效规则。
**本轮不改该文档、不改任何冲减 / 退款金额代码**，仅在**此处登记**。文档修订单独立轮次处理。

### 6.11 迁移运行器的 checksum 门禁：本地已跑过旧版 `0006` 的库需先 reset

`lib/data/pg/migrate.ts` 对**已执行**的迁移做 checksum 比对（改一个字即报错，这是有意设计）。
开发期间 `0006_settlement.sql` 曾被修订，而 `resetDatabase()` **刻意保留** `schema_migrations`
（`lib/data/pg/reset.ts:60`）——因此**本地 test 库若跑过旧版 `0006`，需先 `pnpm db:reset`（仅允许作用于 test 库）**
才能重新迁移。本轮交付的测试库当前一致（`pnpm test:pg` 全绿即证），本条只为**换机器 / 换环境的同伴**登记。

## 7. Out Of Scope

按 `02-decisions.md` Q1 Final Execution Rule：

- 管理端审计级联的另外 8 个事务（agreement / catalog / content / complaint / platformConfig / review / staff / couponTemplate）
- 切换 active datasource（`DATA_SOURCE` 保持不设置）
- `docs/01-requirements/超哥电竞_业务流程表.md §17` 的文档修订（仅登记，见 Q2）

## 8. Project Progress Change

按 `development-workflow.md` §十八（「开发过程中可以把 Round 标为『进行中 / 等待确认 / 等待验收』」；
「**只有 Round 真正 `DONE` 之后，才能把对应业务能力标记为 ✅ 完成**」）：

**已在 `docs/03-dev/总需求进度表.md` 新增一行 `PROD-1B`**，位置在 `PROD-1A` 行之后、
`UNASSIGNED ｜ PostgreSQL 全量迁移` 行之前。该行：

| 列 | 值 |
|---|---|
| `Round` | `PROD-1B` |
| `Status` | ⏳ **`AWAITING_ACCEPTANCE`**（**不是** ✅ —— 未 `DONE`） |
| `Blocker` | `—`，并**显式写明「这不是 BLOCKED」** |
| `Round Record` | `docs/03-dev/rounds/PROD-1B/` |
| `Next Step` | 人工验收 → 用户提交后转 `DONE`；下一轮 `PROD-1C` 补 `admin_audit_entries` 与管理端审计的另外 8 个事务写者 |
| `Notes` | 六个要点：① 为什么「实现但不激活」（闭包实测 15 表 / 15 入口，`admin_audit` 切换时级联 ≈28 表，5 处规则禁止拆闭包）② `.env` 无 `DATA_SOURCE`，仍 100% Mock，页面看不出区别 ③ 交付物（17 表 + 13 仓储 + 11 真事务 + `w1Rows.ts` 单一映射）④ 实证（`pnpm test:pg` 132 条：`pgW1Transactions` 66 + `pgContract` 22〔读 16 + **写 6**〕+ `pgFoundation` 27 + `pgConfig` 17）⑤ 登记不修的 3 项 ⑥ 事务入口边界审计：T3/T4/T5/T6/T7 按「完整写闭包是否全部属于已建 17 表」判为**应本轮实现**，已补齐；T8/T14/T15 因闭包跨 `admin_audit_entries` 边界延至 PROD-1C（`Pg implementation deferred because full atomic write closure crosses PROD-1B boundary`） |

**未改动**既有行。「`UNASSIGNED ｜ PostgreSQL 全量迁移 — 其余 26 个仓储尚未迁入`」那一行**保持原文**：
本轮**不激活**，因此「绝大多数数据仍在 Mock」这一判断**依然成立**，不因本轮交付而改变。

⚠️ 本轮**不写 ✅**、**不把 `PROD-1B` 标为 `DONE`**——那需要用户先明确「人工验收通过」。
`Round` 文件 `README.md` 的 `Status:` 字段同步改为 `AWAITING_ACCEPTANCE`。

## 9. Recommended Commit

⚠️ **Claude 不执行任何 Git 写操作**（`add` / `commit` / `push` / `reset` / `restore` / `checkout` /
`rebase` / `amend` 一律不做）。以下仅为**建议**，由用户自行决定与执行。

建议的 commit message：

```
PROD-1B：Order Hub PostgreSQL 实现与并发实证（不激活数据源）

W1 订单核心事务闭包的 PostgreSQL 落地：为 17 张表建表与约束（6 个迁移，
编号自 0003 起，未改动已执行的 0001/0002），补 13 个 Pg 仓储工厂与 11 条
真事务（BEGIN → 条件更新 / FOR UPDATE → 业务闸 → 写入 → COMMIT，
READ COMMITTED，时钟由调用方传入）。

事务入口边界按「完整原子写集合是否已全部属于本轮已建的 17 张表」重判：
T3 / T4 / T5 / T6 / T7 全部属于，本轮补齐；T8 / T14 / T15 的闭包跨
admin_audit_entries 边界，延至 PROD-1C（Pg implementation deferred
because full atomic write closure crosses PROD-1B boundary）。
补齐时发现并修掉一处加锁顺序成环（T10/T11 改为「orders 永远是第一把锁」，
判定与写入未改）。

行映射收敛到 lib/data/pg/w1Rows.ts 单一来源，13 个仓储与事务共用，
杜绝列清单各自演化。

实证（全部真连 TEST_DATABASE_URL，无 mock / stub client）：
- tests/pgW1Transactions.test.mjs  66 用例：并发抢单恰好一人成功、
  重放幂等、回滚后逐表行数不变、pg_backend_pid() 证明同一条连接、
  closePool() 后数据仍在、deadline 快照往返
- tests/pgContract.test.mjs  W1 段：Mock ↔ Pg 逐方法对照

按 02-decisions.md Q1 裁定，本轮不切数据源：DATA_SOURCE 不设置，
应用真实业务路径仍 100% Mock；DATA_SOURCE=postgres 本轮不是可用的
迁移验证模式。

登记不修（Hard Rule 2）：queryCompanions({availability:""}) 两侧口径差异、
dispatch_records.accepted_via 可空 vs TARGET NOT NULL、
业务流程表.md §17 的比例冲回公式 vs P0-15 整笔冲回。

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

**提交范围**（本轮真正碰过的文件，即 `03-delivery.md` §2 的清单）：
**5 个修改**（`lib/data/pg/seed.ts` · `tests/pgContract.test.mjs` · `tests/pgFoundation.test.mjs` ·
`tests/pgConfig.test.mjs` · `docs/03-dev/总需求进度表.md`（本轮新增一行））+
23 个新增（6 个迁移、15 个 `lib/data/pg/**`、1 个测试、`docs/03-dev/rounds/PROD-1B/`）。

⚠️ 用户在提交前若发现工作区还有**不属于本轮**的未跟踪文件，应自行判断是否分开提交——
本轮不便替用户决定（`docs/03-dev/rounds/**` 的历史档案**不得改写**）。
