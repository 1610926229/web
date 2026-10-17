# 决策记录（PROD-1D）

> 本文件记录本轮**真正做过取舍**的地方：问题是什么、裁定是什么、代价是什么、靠什么验证。
> 只有一处答案的事不写进来。

---

## 0｜Requirement Check 结论（以代码为唯一事实源，不引旧文档）

### T1 —— 六个问题的答案

| 问题 | 答案（读的是当前代码） |
|---|---|
| 1. Mock 券核销的完整语义 | `lib/data/couponRedemptionTransaction.ts` 的 `redeemCouponClaimForOrder()`：归属校验 → 读券模板 `enabled`（读不到按 `false`） → `resolveCouponApplication()` 判「已用 / 未开始 / 已过期 / 模板停用 / 门槛未达 / 形态不支持」 → 只改 `status` 与 `usedAt`（券面快照原样保留）。**同步、不抛错**，失败返回 `{ok:false, reason}` |
| 2. side effect 究竟发生在哪一层 | **服务层**：`lib/services/checkout.ts` 的 `buildOrderFromRequest()`——它被当作 `getPaymentRepository().confirmPaymentRequest(id, result, buildOrder)` 的**回调**传进仓储，而回调体里调了 Mock 的核销与派单 |
| 3. Pg 为什么会穿回 Mock | 回调是**存储无关**的：Pg 仓储调用同一个回调，回调里的两次写落在 `globalThis` 的 Mock store 上。Pg 侧**没有任何代码**提示这件事——这正是半迁移最难发现的地方 |
| 4. `coupon_claims` 的状态 / 字段 / 约束 | 状态 `unused / used`；`used_at` 可空；`snapshot`（jsonb，领取时冻结）；唯一约束 `(user_id, coupon_id)`（一人一券）与 `(user_id, idempotency_key)`。见 `db/migrations/0007_coupon.sql` |
| 5. 同券并发的唯一保证 | **只能是条件 `UPDATE`**（`WHERE … AND status = 'unused'`）——READ COMMITTED 下两个事务可以双双读到 `unused`，因此「先 SELECT 再判再 UPDATE」不构成互斥；写入语句上的谓词让两个 UPDATE 在同一行上串行化，后到者改 0 行。**返回 0 行**是唯一信号 |
| 6. T1 与退款退券是否可能死锁 | 不构成环。T1 的锁集合是「`payment_requests` 条件认领 → 新增行（`orders` / `payments` / `dispatch_records`，都无既有行争用）→ `coupon_claims` 条件 `UPDATE`」；退款退券（`restoreCouponClaimForOrderTx`）的锁集合以订单为第一把锁。**T1 取的是 `coupon_claims` 上的行锁，退款路径取的是同一张表上的行锁**，两条路径对 `orders` 的取锁方向不冲突（T1 不锁既有订单行），因此无环 |

### 三组后台写事务 —— read / write / lock / audit / 幂等 / 通知 / 外部依赖

逐条与 Mock 侧对照后的结果（完整七列对照表见 `03-delivery.md` §2）：

| 维度 | **B** 平台参数 | **C** 投诉 | **D** 券模板 |
|---|---|---|---|
| 入口 | `updatePlatformConfigPg` | `applyAdminComplaintIntentPg` | `create` / `update` / `setCouponTemplateEnabled` **`…Pg`** |
| 前置读 | 账本：**只判 `conflict`** | 账本：**只判 `conflict`** | update/toggle：账本（只判 conflict）；create：无前置读 |
| 取锁 | `platform_config` 单行 `FOR UPDATE` | `complaints` 单行 `FOR UPDATE` | create：`pg_advisory_xact_lock(operationId)`；update/toggle：`coupon_templates` 单行 `FOR UPDATE` |
| 权威读 | 锁下重读账本（判 replay 才作数） | 锁下重读账本 + `canTransitionComplaint` | 锁下重读账本 |
| 业务写 | `platform_config` 窄 UPDATE（4 字段 + `updatedAt/by`） | `complaints` 两路窄 UPDATE | `coupon_templates` INSERT / 窄 UPDATE（9 列）/ 仅 `enabled` |
| 审计 | `appendAuditEntryTx`（`platformConfig.update`） | `appendAuditEntryTx` | `appendAuditEntryTx` ×3 |
| 幂等 | `operation_id` 两读账本 | `operation_id` 两读账本 + **意图收窄** | `operation_id` 两读账本（create 走**类型**比对，D3） |
| 通知 | 无 | 无（Mock 当前亦无） | 无 |
| 外部依赖 | 无 | 无 | 无 |

**三块都与 Mock 伪事务逐字段等价**：判定顺序、no-op / replay 语义、写入字段集合、
审计 action / before / after、返回值形状——一处未改（证据：`pnpm test` 全量 0 fail；
三块的真库等价用例见 `03-delivery.md` §3）。

### 参与表是否都已存在

`coupon_claims` · `coupon_templates`（0007）· `complaints` · `platform_config`（0008）· `orders` / `payment_requests` / `payments` / `dispatch_records`（0004 / 0005）· `admin_audit_entries`（0009）。
**20 张表全部已存在，本轮不需要任何新 migration。**

---

## D1｜`buildOrder` 必须变成**纯函数**，副作用按存储分家

### 问题

`buildOrderFromRequest()` 里同时有「算金额」与「写券核销、写派单」。它是支付仓储的 `buildOrder` 回调——
**存储无关**，因此 Pg 仓储一调用它，券核销与派单就写进了 Mock。

在「不许 Pg 调 Mock」「不许 Service 手写 SQL」「不许 Route 管事务」三条同时成立时，
只剩一条路：**让回调不再承担写入**。

### 裁定

- `buildOrderFromRequest()` 只**算**（金额域 + 订单字面量），无 `await`、无副作用；
- 副作用成为**各存储自己的事务参与者**：
  - Mock：`lib/data/checkoutCommitTransaction.ts` 的 `commitMockCheckoutParticipants()`（同步，仍跑在 Mock 仓储那段无 `await` 的原子区段里）；
  - Pg：`lib/data/pg/w1Transactions.ts` 的 `redeemCouponClaimForOrderTx()` + `insertDispatchForOrderTx()`（同一个 `BEGIN … COMMIT`）。
- 两个存储**共用同一个纯构造函数**，因此「支付成功生成的订单长什么样」仍然只有一处定义。

### 代价

- 新增一个文件与一个仓储契约条款（`buildOrder` 必须纯）；
- 调用链多一跳（仓储 → 参与者）；
- 用**源码结构断言**把「纯」「同步」「核销排在派单之前」「参与者确实在原子区段内被调用」四条钉死
  （`tests/couponCheckoutChain.test.mjs`），否则上面那张表的任何一格失效都会**静默**让旧的双花测试失去意义。

### 验证

- `tests/couponCheckoutChain.test.mjs` 24 条全绿（含 4 条结构断言）；
- 用户在结算链路上的既有 103 条用例全绿；
- T1 真库用例（`tests/pgCheckoutTransactions.test.mjs`）。

---

## D2｜失败**不能**从事务里「正常返回」——必须掀翻事务

### 问题

券在核销那一刻不可用时，支付请求**已经被认领**（`payment_requests.status: pending → success`）。
若把失败当成一个普通的返回值交给 `withTransaction`，事务会**提交**——
留下「支付成功、没有订单」。这正是本轮明令禁止的状态。

### 裁定

Pg 的券核销返回 `{ok:false, reason}`，**仓储内部**把它当作失败种类返回；
**事务入口** `confirmPaymentRequestPg()` 见到这一支就抛出一个内部信号
（`CouponUnavailableSignal`）触发 `ROLLBACK`，再在事务**外面**把它翻译回
`{ kind: "coupon-unavailable", reason }` 这个联合分支。

### 代价

- 事务入口多一层 try/catch 与一个内部类；
- 「为什么不能直接返回」必须写在两处（仓储与入口），否则下一个人会把 throw 当成多余的绕路删掉。

### 验证

真库用例「券不可用 ⇒ `payment_requests` 仍是 `pending`、无 orders / payments / dispatch、券未变」。
去掉 throw（改成正常返回）会让该用例**变红**——这正是 Phase 10 的第 2 条红绿证明。

---

## D3｜幂等账本的两读模式：五组事务共用一套原语

`takeReplayTx` / `takeReplayForActionTx` 在 PROD-1C 时是 `pg/adminAuditTransactions.ts` 的**私有**函数。
本轮又添三组写事务（平台参数 / 投诉 / 券模板），于是把它们抽到
**`lib/data/pg/adminWriteTx.ts`**，并新增 `takeCreateReplayTx`。

- **判定一个字没改**：纯函数仍在 `lib/data/adminWriteSupport.ts`（`evaluateReplay` / `refineReplayByAction` / 新增 `evaluateCreateReplay`）。
  新增 `evaluateCreateReplay` 是把 Mock `takeCreateReplay` 里内联的那几行**原样搬出来**，让「读哪里」成为参数。
- **不为收敛而合并**：`evaluateCreateReplay` 与 `evaluateReplay` 判据不同（一个比**目标类型**，一个比**目标 id**），
  合并成一个「有时比类型、有时比 id」的函数，等于把「这次是新建还是编辑」藏进运行期分支。

### 代价

改了 PROD-1C 的一个文件（删两个私有函数、加一个 import）。判定与调用位置都没变——
这是一种**搬家**，不是改动。

---

## D4｜Mock 侧不许再出现「第二个写入点」

`lib/data/pg/**` 调 Mock 显然不行；但反过来同样要防：`commitMockCheckoutParticipants` 只能被
**Mock 支付仓储的原子区段**调用。若有人从服务层直接调它，Pg 路径就会漏掉券核销与派单——
而代码看上去一切正常（服务层调用成功、订单也建出来了）。

结构断言因此落在**调用点**上（`mockPaymentRepository.ts` 的 `confirmPaymentRequest` 段内必须出现该调用，
且这一段里没有 `await`）。

---

## D5｜本轮**不切数据源**（指令 Phase 11 已裁定）

`DATA_SOURCE` 不设置；不接 Service runtime；不批量改 accessor；
新增的 Pg 实现**只被测试调用**。写进 `confirmPaymentRequestPg()` 与三组后台事务的文件头注释里，
避免下一个人「顺手接上」。

---

## D6｜Migration 纪律：**0 个新 migration**

本轮四块业务所需的基础表（`coupon_claims` / `coupon_templates` / `complaints` / `platform_config` /
`admin_audit_entries` / 订单四表）**全部已存在**，因此不需要任何 schema 变更。
`db/migrations/0001`–`0009` 一字未动（`git status --short db/` 为空即证据）。

若实现中发现「必须加约束才能保证正确性」，按指令要求先报告再决定是否动——
**本轮没有出现这种情况**：券并发靠既有行与条件 UPDATE，幂等靠既有 `operation_id` 唯一索引，
事务串行化靠行锁与（券模板新建路径的）顾问锁，都不需要新约束。

---

## D7｜本轮新增的两位参与者进测试探针名单

`coupon_claims` 与 `dispatch_records` 是本轮 T1 才第一次进 Pg 事务的表，
因此必须进 `PROBED_TABLES`（`w1_write_log` + `w1_probe_fail`）——
否则「券核销之后失败会不会回滚」这条只有数据库能回答的问题**无法被观测**。
理由与 PROD-1C 把 `admin_audit_entries` 进名单同。

---

## D8｜平台参数的 no-op 口径：**提交同值也是一种「什么都没发生」**

平台参数在 Mock 里把两种结局归为同一支：**幂等重放**，或**提交的值与现状逐字段相同**
（`nothingChanged`）。两者都**不写数据、不写审计、不刷新 `updatedAt`**，且**都不是错误**。
Pg 逐条照搬，用 Mock 模块**导出的** `PATCHABLE_FIELDS` 判「这次到底改没改」。

一处**必须**照抄的细节：no-op 分支返回给调用方的两份配置要过**读边界归一化**
（`normalizePlatformConfig`，给旧数据补齐），但**不能把归一化后的结果当作合并基准**——
否则「脏记录 + 恰好提交默认值」会落进 `nothingChanged` 而**永不写盘**，那条脏记录就再也修不好。

### 代价

`PATCHABLE_FIELDS` 必须**导出**给 Pg 侧共用（不是复制一份）：它的类型是
`Record<keyof PlatformConfigInput, true>`，因此「加第五个参数时忘记更新判定」在**两边同时**
是编译错误。复制一份，这份保险就只对 Mock 生效。

### 验证

真库 no-op 用例（状态不变、审计 0 条、`updated_at` 未刷新）+ 全量 `pnpm test` 0 fail。

---

## D9｜投诉：只锁 `complaints`，**不锁 `orders`**

投诉事务的锁集合只有 `complaints` 的那一行。这不与全库「`orders` 永远是第一把锁」冲突——
那条不变量管的是**同时要锁订单与别的表**的路径，投诉路径**根本不锁订单**。

**为什么这样是对的**：投诉的写者与订单侧的读者必须读**同一份 PostgreSQL 真值**（本轮冻结
不变式之一），但「同源」靠的是**同一个库、同一张表**，不是靠锁。订单侧的阻塞读者在
投诉被解决后**立刻**看见新状态，因为它在同一张 `complaints` 表上读——`tests/pgComplaintTransactions.test.mjs`
的「跨域」用例走**真实公开入口**证明这一点，不自己写 SQL 模拟读者口径。

### 代价

投诉事务里**任何**对订单的访问都必须退化为**普通读**（不加锁），否则立刻引入一把跨表的锁、
与订单侧形成环。这一条写在 `complaintTransactions.ts` 的锁序注释里。

### 附：意图收窄

幂等键绑定的是**意图**（`start-processing` / `resolve` / `close`），不是「某张投诉」。
因此同一个键先 `start-processing`、再 `resolve`，第二次是 `operation-conflict`，不是安静的 200。
Pg 侧复用 Mock 导出的 `INTENT_TO_STATUS` 与 `auditActionOf` 判定，判据唯一真值源仍是 Mock 模块。

---

## D10｜券模板**新建**路径用顾问锁，而不是行锁

新建的目标行**尚不存在**，没有行可锁——而 Mock 的伪事务里，「第二个同键请求必然读到第一个
已经写下的账本」是自动成立的。Pg 里要把这条性质找回来，只能靠一把**不依赖目标行**的锁：
`pg_advisory_xact_lock(sha256(operationId) 的前 64 bit)`。

- **不构成新 schema**：顾问锁是 PostgreSQL 的**内存锁表**，不建表、不加列、不落盘 ⇒ **零 migration**；
- **碰撞无害**：两个不相关的新建撞进同一个键，只是**串行化**（一个稍等另一个提交），
  不报错、不改结果——因此不必引入「幂等键 → 锁」对照表；
- **只在新建路径用**：编辑 / 启停已有**更精确**的 `FOR UPDATE` 行锁，再叠一把按 `operationId`
  的锁只会让「同一张券的两次不同编辑」因为键不同而白等。**能挂在行上的就挂在行上。**

一条**调用方义务**（与 Mock 的原注释同）：同一个幂等键只能用于**一类**动作。
`takeCreateReplayTx` 按**操作类型**（`targetType: "coupon"`）识别重放，因为新建的 id 是
事务里当场生成的，按 id 比对只会把它误判成「键被别的对象用了」。服务层每次都用
`crypto.randomUUID()` 现取新键，真实路径不会撞上。

### 验证

同键并发新建用例（两个请求返回**同一个 id**、一行一审计）+ 不同键并发编辑用例
（两次改动**都落库**、两条审计）+ mutation 红线（去掉顾问锁 ⇒ `23505`）。

---

## D11｜券模板**启停**的并发：断言「审计数 === 真实变更次数」，**不**硬断言「两条」

`enable` 与 `disable` 是一对**互斥的目标状态**，而 `setCouponTemplateEnabledPg` 有一条
「已经就是那个状态就什么都不做」的分支。两个并发请求谁先拿到行锁，谁就真翻转；
后到的若在锁下读到的状态**正是**它要的，就**正确地空转**。两种顺序的结局不同，
**两个都是对的**：

| 提交顺序 | 结果 |
|---|---|
| 先 enable（本就启用 → 空转）后 disable（真翻转） | 1 条审计，最终 `enabled = false` |
| 先 disable（真翻转）后 enable（真翻转） | 2 条审计，最终 `enabled = true` |

**把「两条」写死，等于要求上游那条合法顺序必须写一条不该写的审计**——那恰好是
`changed: false` 分支存在的理由（「与事实相反的成功」）。因此断言改为**能与事实对上的不变式**：
**审计条数 === 真实变更次数**，且**最终状态 = 最后一次真实变更写下的状态**。
（编辑那一组不同：两次编辑的目标名字互不相同、也与原值不同，两次都必然是真变更，
所以那里可以硬断言两条审计。）

---

## D12｜并发用例的判别力：撑窗触发器（本轮实测到一次**假绿**）

**问题**：Phase 10 的第 1 条红-绿证明（删掉券核销的 `AND status = 'unused'` 谓词）
起初**没有变红**。根因是那个并发用例是一个**裸 `Promise.all` 跑在冷连接池上**：
池里只有一条空闲连接时，先发的请求拿走它**跑完整段事务并提交**，后发的还在 TCP 握手，
两个请求**根本没有重叠**——于是无论并发保护在不在，后到者都读到 `used`。
**它测到的其实是「顺序执行」。**

**裁定**：并发用例必须具备**确定性**的判别力，手段两条并用：

1. `warmPool(size)`——先发 `size` 条 `SELECT 1`，让池里先有就绪连接，发出后立刻重叠；
2. 在**争用的那一行**上挂一个**测试专用**的 `BEFORE UPDATE … pg_sleep(0.3)` 触发器，
   把赢家**持有行锁**的窗口确定性撑开，`finally` 摘除。

⚠️ 触发器**不进 `db/migrations/`**，不是 schema 的一部分（`grep -rn "sleep_trg" db/` 应为空）。

**四个 pg 测试文件的并发用例现已全部采用同一手法**——投诉的三条最初只有 `warmPool(2)`，
判别力弱于另两组，是 reviewer 的 **NOTE 1**，本轮**已修**，并以 mutation「删掉
`lockComplaintTx` 的 `FOR UPDATE`」验证：三条并发用例**全红**（`2 !== 1`），还原后复绿。

**已复做的四条红-绿**（完整表见 `03-delivery.md` §4）：

| # | 删掉的机制 | 结果 |
|---|---|---|
| ① | 券核销条件 UPDATE 的 `AND status = 'unused'` | 同券并发红 `2 !== 1`（双花） |
| ② | Admin 事务边界（审计写入移出事务） | 回滚用例红 `999 !== 60` |
| ③ | 锁下**权威读**账本 | 同键并发红 `23505` |
| ④ | 投诉 `lockComplaintTx` 的 `FOR UPDATE` | 三条并发用例红 `2 !== 1` |
