# 交付记录（PROD-1D）

> Round: **PROD-1D — Admin Write Closure A + T1 Coupon Closure**
> 状态：实现完成 + 全门禁通过 + 独立 reviewer 0 BLOCKER / 0 MAJOR → **待人工验收**
> 完成时间：2026-10-11
> 覆盖阶段：Phase 0–13（Phase 14 reviewer 结论见 §7；Phase 15 即本文件与 `04-acceptance.md`）

---

## 1｜交付物

### 1.1 新增文件（5 个，987 行）

| 文件 | 行数 | 作用 |
|---|---|---|
| `lib/data/checkoutCommitTransaction.ts` | 109 | **Mock 侧**结算参与者：`commitMockCheckoutParticipants()`——同步、无 `await`，核销券 → 建派单，跑在 Mock 支付仓储的原子区段内（D4） |
| `lib/data/pg/adminWriteTx.ts` | 103 | 幂等账本**事务内**读取原语：`takeReplayTx` / `takeReplayForActionTx` / `takeCreateReplayTx`（从 PROD-1C 的私有函数搬出，判定未改，D3） |
| `lib/data/pg/platformConfigTransactions.ts` | 183 | **B** 平台参数写闭包 |
| `lib/data/pg/complaintTransactions.ts` | 177 | **C** 投诉写闭包 |
| `lib/data/pg/couponTemplateTransactions.ts` | 415 | **D** 券模板写闭包（create / update / toggle 三个入口） |

### 1.2 修改文件（15 个，+922 / −140）

| 文件 | 改动性质 |
|---|---|
| `lib/services/checkout.ts` | `buildOrderFromRequest` **变纯函数**（删掉券核销与派单两处写、两个 import），D1 |
| `lib/data/mockPaymentRepository.ts` | 原子区段内改调 `commitMockCheckoutParticipants()` |
| `lib/data/paymentRepository.ts` | `confirmPaymentRequest` 契约加注「`buildOrder` 必须纯」 |
| `lib/data/pg/paymentRepository.ts` | 新增 `confirmPaymentRequestPg()` + 券核销 / 派单进入同一事务（**A**） |
| `lib/data/pg/w1Transactions.ts` | 新增 `redeemCouponClaimForOrderTx()` / `insertDispatchForOrderTx()`；`readPlatformConfig` 拆出可复用私有读 |
| `lib/data/pg/couponRepository.ts` | 追加券模板锁 / 读 / 插 / 窄 UPDATE 原语 |
| `lib/data/pg/complaintRepository.ts` | 追加 `lockComplaintTx` / `applyComplaintStatusTx` |
| `lib/data/pg/platformConfigRepository.ts` | 追加 `lockPlatformConfigForUpdateTx` / `applyPlatformConfigTx` |
| `lib/data/pg/adminAuditTransactions.ts` | 私有账本读函数**搬家**到 `adminWriteTx.ts`（D3） |
| `lib/data/adminWriteSupport.ts` | 新增纯函数 `evaluateCreateReplay`（从 Mock 内联逻辑原样搬出） |
| `lib/data/adminPlatformConfigTransaction.ts` | 仅 `export` `PATCHABLE_FIELDS`（**共用同一对象**，非复制） |
| `lib/data/adminComplaintTransaction.ts` | 仅 `export` `INTENT_TO_STATUS` / `auditActionOf` |
| `lib/constants/coupons.ts` | `COUPON_CLAIM_NOT_FOUND_REASON` 提为共享常量 |
| `lib/data/couponRedemptionTransaction.ts` | 复用共享常量 |
| `tests/couponCheckoutChain.test.mjs` | 加 4 条**源码结构断言**（纯 / 同步 / 核销排派单前 / 参与者在原子区段内） |

### 1.3 新增测试（4 个文件，67 用例）

| 文件 | 用例 |
|---|---|
| `tests/pgCheckoutTransactions.test.mjs` | 17 |
| `tests/pgPlatformConfigTransactions.test.mjs` | 11 |
| `tests/pgComplaintTransactions.test.mjs` | 20 |
| `tests/pgCouponTemplateTransactions.test.mjs` | 19 |

---

## 2｜四块闭包逐条对照（Phase 7 等价性核对）

口径：**与对应 Mock 伪事务逐条等价**（判定顺序、no-op / replay 语义、写入字段集合、审计 action / before / after、返回值形状）。

| 维度 | **A** T1 券核销闭包 | **B** 平台参数 | **C** 投诉 | **D** 券模板 |
|---|---|---|---|---|
| 入口 | `confirmPaymentRequestPg` | `updatePlatformConfigPg` | `applyAdminComplaintIntentPg` | `create` / `update` / `setCouponTemplateEnabled` **`…Pg`** |
| 前置读 | — | 账本：只判 `conflict` | 账本：只判 `conflict` | create：账本（锁后）；update/toggle：账本（只判 conflict） |
| 取锁 | `payment_requests` 条件 UPDATE；`coupon_claims` 条件 UPDATE | `platform_config` 单行 `FOR UPDATE` | `complaints` 单行 `FOR UPDATE` | create：`pg_advisory_xact_lock(operationId)`；update/toggle：`coupon_templates` 单行 `FOR UPDATE` |
| 权威读 | 券归属 / 模板 `enabled` / `resolveCouponApplication` **在锁下** | 锁下重读账本 | 锁下重读账本 + `canTransitionComplaint` | 锁下重读账本 |
| 业务写 | 认领请求 → 核销券 → `orders` / `payments` / `dispatch_records` INSERT | `platform_config` 窄 UPDATE（4 字段 + `updatedAt/by`） | `complaints` 两路窄 UPDATE | `coupon_templates` INSERT / 窄 UPDATE（9 列）/ 仅 `enabled` |
| 审计 | **无**（用户侧支付确认不写 AdminAudit） | `appendAuditEntryTx`（`platformConfig.update`） | `appendAuditEntryTx` | `appendAuditEntryTx` ×3 |
| 幂等 | 请求 `status='pending'` 条件认领 + `order_id` 重放 | `operation_id` 两读账本 | `operation_id` 两读账本 + 意图收窄 | `operation_id` 两读账本（create 走类型比对） |
| 通知 | 无 | 无 | 无（Mock 当前亦无） | 无 |
| 外部依赖 | 无 | 无 | 无 | 无 |

**共享而非复制**（`tsc` 双保险）：`PATCHABLE_FIELDS`（`Record<keyof PlatformConfigInput, true>`）、`INTENT_TO_STATUS`、`auditActionOf`、券模板的 `buildThresholdCouponLabels` / `isComputableCouponForm` / `isCouponTemplateUnchanged` / `adminCouponTemplateActionFromPatch` 全部由 Pg 侧 `import` Mock 模块导出——漏加一个键，**两边同时**编译失败。

---

## 3｜真库测试（Phase 9）

**全部连真实 PostgreSQL**（`TEST_DATABASE_URL`），无任何 fake client。探针机制沿用 PROD-1B/1C 的
`w1_write_log` + `w1_probe()` 触发器，本轮把 `coupon_claims` 与 `dispatch_records` **新增进
`PROBED_TABLES`**（D7）——否则「券核销之后失败会不会回滚」这条只有数据库能回答的问题无法观测。

覆盖要点：

- **A**：等价（建单 / 核销 / 派单字段逐条对齐）、券不可用回滚、核销后失败回滚、**同券并发双花**、重复确认重放、单连接、金额恒等式、Mock↔Pg 契约等价。
- **B**：4 字段 PATCH 等价、no-op（提交同值不刷新 `updatedAt`）、replay、`operation-conflict`、**锁下权威读并发**、审计失败回滚、单连接。
- **C**：三个意图等价、`start-processing` 忽略 `result`、非法迁移零写入、意图收窄 `operation-conflict`、not-found、**行锁并发三条**、审计失败回滚、跨域真值同源。
- **D**：create / update / toggle 等价、`form_key` / `created_at` 不被改动、同键新建收敛为一行一审计（顾问锁）、不同键并发编辑不丢改动、审计失败回滚、单连接。

---

## 4｜红绿证明（Phase 10）

**四条** mutation，全部实测「去掉被守护的机制 ⇒ 用例变红 ⇒ 还原后复绿」。

| # | 去掉什么 | 预期 | **实测** |
|---|---|---|---|
| ① | T1 券核销条件 UPDATE 的 `AND status = 'unused'` 谓词 | 同券并发红 | ✅ `2 !== 1`（两笔都建单 = 双花） |
| ② | Admin 事务边界（审计写入移出事务 / 审计失败不再回滚业务写） | 回滚用例红 | ✅ `999 !== 60`（平台参数未随审计失败回滚） |
| ③ | 锁下**权威读**账本 | 同键并发红 | ✅ `23505` on `admin_audit_entries_operation_key` |
| ④ | 投诉 `lockComplaintTx` 的 `FOR UPDATE` | 三条并发用例红 | ✅ `★ 恰好一个真正迁移了状态 2 !== 1`（三条全红） |

### ⚠️ 本轮实测到的**假绿**（必须写下来）

① 起初**没有变红**。根因：该并发用例是一个**裸 `Promise.all` 跑在冷连接池上**——
池里只有一条空闲连接时，先发的请求拿走它**跑完整段事务并提交**，后发的还在 TCP 握手，
两个请求**根本没有重叠**，于是无论并发保护在不在，后到者都读到 `used`。
它测到的其实是「顺序执行」。

修正手法（三处同款，现已**四个并发测试文件一致**）：

1. `warmPool(size)`：`Promise.all` 发 `size` 条 `SELECT 1`，让池里先有就绪连接；
2. 在**争用的那一行**上挂一个**测试专用**的 `BEFORE UPDATE … pg_sleep(0.3)` 触发器，
   把赢家**持有行锁**的窗口确定性撑开，`finally` 摘除——它**不进 `db/migrations/`**，不是 schema。

> 这也是 **NOTE→修复** 的来源：投诉的三条并发用例最初只有 `warmPool(2)`，
> 判别力弱于另两组。本轮已补上同款撑窗触发器（`withWideLockWindow()`），
> 并用 mutation ④ 证明它现在真的有判别力。

**没有为凑数量制造恒真断言**：本轮的四条红绿全部来自「删掉机制」这一条可复现路径。

---

## 5｜回归门禁（Phase 13）

全部命令在仓库根目录执行。下表**每一条都是本轮实际运行过的**，含退出结果。

| # | 命令 | 结果 | 状态 |
|---|---|---|---|
| 1 | `pnpm test:pg` | `tests 237 / pass 237 / fail 0 / skipped 0` | ✅ 运行过 |
| 2 | `pnpm test` | `tests 2104 / pass 1701 / fail 0 / skipped 403` | ✅ 运行过 |
| 3 | `pnpm typecheck` | `next typegen` + `tsc --noEmit` 无输出 | ✅ 运行过 |
| 4 | `pnpm lint` | `eslint` 无输出 | ✅ 运行过 |
| 5 | `pnpm build` | 成功（Next.js 16.3.4 生产构建） | ✅ 运行过 |
| 6 | `APP_BASE_URL=http://127.0.0.1:3000 pnpm test` | `tests 2104 / pass 1884 / fail 0 / skipped 220` | ✅ 运行过 |

**pg 套件明细**：`pgW1Transactions 66` · `pgAdminAuditTransactions 37` · `pgFoundation 27` ·
`pgContract 23` · `pgComplaintTransactions 20` · `pgCouponTemplateTransactions 19` ·
`pgCheckoutTransactions 17` · `pgConfig 17` · `pgPlatformConfigTransactions 11` = **237**。

### skipped 说明（区分「没跑过」与「跳过」）

| 场景 | skipped | 原因 |
|---|---|---|
| `pnpm test`（未设 `APP_BASE_URL`） | 403 | 24 个 HTTP 用例文件需要运行中的 server；pg 用例需要 `TEST_DATABASE_URL` |
| `APP_BASE_URL=… pnpm test` | 220 | 仅剩 pg 用例（需 `TEST_DATABASE_URL`，已被第 1 行 `pnpm test:pg` **完整覆盖**） |

**无任何 0 覆盖的用例**：HTTP 用例在门禁 6 跑过，pg 用例在门禁 1 跑过。

### 运行环境纪律（实测踩到过）

- 并行跑 `pnpm test:pg` 会**跨进程死锁**（`40P01`）——pg 门禁全程**串行**执行，且在所有子 agent 停止后进行。
- `pnpm start` 的 `TaskStop` **杀不干净**子进程：本轮用 `taskkill //F //T //PID` 终止后，
  以 `netstat -ano | grep :3000` 复查确认**无 LISTENING**（仅剩 `TIME_WAIT`）才算通过。
- 清理了三个 agent 遗留测试库（`chaoge_esports_t1d` / `chaoge_prod1d_test` / `t1d_checkout_test`），
  保留配置内的 `chaoge_esports_dev` 与 `chaoge_esports_test`。

---

## 6｜未激活声明与激活缺口重估（Phase 11 / 12）

### 6.1 本轮**没有**接上 runtime（Phase 11）

- `DATA_SOURCE` **不设置**；`lib/data/source.ts` 的 `getDataSource()` 无条件返回 `mockDataSource`，**不读**环境变量；
- 本轮新增的 Pg 事务入口（`confirmPaymentRequestPg` / `applyAdminComplaintIntentPg` /
  `updatePlatformConfigPg` / `create|update|setCouponTemplateEnabledPg`）**只被 `tests/*.test.mjs` import**；
- `lib/services/**`、`app/**`、`components/**` **没有一处** `import … lib/data/pg/…`；
- 因此**不存在新的 half Pg / half Mock runtime**。Mock 的 `writeAudit` 与 Pg 的 `appendAuditEntryTx`
  是两条互不调用的路径，服务端只走 Mock 那条。

### 6.2 重新统计（Phase 12）

| 指标 | 数值 |
|---|---|
| Repository 接口模块 | **28** |
| Pg 仓储文件（`lib/data/pg/*Repository.ts`） | **16** |
| 查询 `isPostgresDataSourceEnabled()` 的仓储 | **2**（`favoriteRepository` / `suggestionRepository`） |
| **当前 runtime 走 Pg 的仓储** | **0** |
| 本轮新增 Pg 事务 | **4 文件 / 6 入口** |
| `db/migrations/` 变更 | **0**（`0001`–`0009` 一字未动，`git status --short db/` 为空） |
| 建表语句总数 | **21**（`CREATE TABLE`） |

### 6.3 AdminAudit 写者迁移进度

口径：Mock 侧 `writeAudit` 调用点，全库 **33 处 / 10 文件**（与 PROD-1B / 1C 计数一致）。

| 文件 | 处数 | 本轮后状态 |
|---|---|---|
| `adminCatalogTransaction.ts` | 8 | ⛔ 未迁 |
| `adminCompanionTransaction.ts` | 6 | 🔶 1 处已 Pg 化（PROD-1C），余 5 |
| `adminStaffTransaction.ts` | 4 | ⛔ 未迁 |
| `adminContentTransaction.ts` | 4 | ⛔ 未迁 |
| `couponTemplateTransaction.ts` | 3 | ✅ **本轮 3 处全部 Pg 化** |
| `adminRefundTransaction.ts` | 3 | ✅ PROD-1C 全部 Pg 化 |
| `adminAgreementTransaction.ts` | 2 | ⛔ 未迁 |
| `adminReviewTransaction.ts` | 1 | ⛔ 未迁 |
| `adminPlatformConfigTransaction.ts` | 1 | ✅ **本轮 Pg 化** |
| `adminComplaintTransaction.ts` | 1 | ✅ **本轮 Pg 化** |
| **合计** | **33** | **已 Pg 化 9 / 33** |

**剩余 24 处 / 6 个文件**：`adminCatalog 8` · `adminCompanion 5` · `adminStaff 4` ·
`adminContent 4` · `adminAgreement 2` · `adminReview 1`。

### 6.4 六个问题的答案

> ⚠️ **诚实性声明**：与本仓 PROD-1C 同，那 6 问的**逐字清单**在上下文压缩后未能完整保留。
> 下面按本仓自己写下的激活门槛（PROD-1B `02-decisions.md` Q1 §13d）重建。
> **若产品负责人手里的清单与此不同，以产品负责人的为准。**

**Q1｜激活后还会不会出现「一半 Pg、一半 Mock」的事务？**
不会**新增**半事务：本轮四块闭包各自的业务写与审计都在**同一个** `withTransaction` 内，
新实现与 Mock 实现**互不调用**。唯一能制造半事务的动作是把 `getAdminAuditRepository()` 切到 Pg——
本轮**没有做**，且**不该做**：一切过去，仍未迁移的 24 处 `writeAudit` 立刻变成「业务写 Mock、审计写 Pg」。

**Q2｜每个已 Pg 化的写事务，业务写入与审计是否真同生共死？**
是，且被真实数据库证伪过。四组 Pg 事务的审计 `INSERT` 都是**最后一步**、**不写
`ON CONFLICT DO NOTHING`**（冲突即 `23505`，整段回滚）。四个测试文件各有「审计写不进去 ⇒
业务写入全部回滚」用例。见 §4 mutation ②。

**Q3｜迁移是否只换了持久化，没改任何业务规则？**
是。判定顺序、金额公式、状态机、错误优先级**一处未改**。共享常量一律**导出后共用**（§2 末），
Pg 侧不复制。零漂移的直接证据：`pnpm test` **1701 / 0 fail**（Mock 行为未变）。

**Q4｜距「可以声明 `DATA_SOURCE=postgres` 可用」还差什么？**
还差 **24 处 `writeAudit`（6 个文件）**，以及这些事务各自的业务写表。门槛未满足，
**本轮明确不激活**。判定：**`NOT READY TO ACTIVATE`**。

**Q5｜激活后连哪张库？防呆还在吗？**
连 `DATABASE_URL`；破坏性操作另有 `_test` 后缀守卫、生产环境拒绝 seed / reset。
这些守卫是 **PROD-1A 建立的，本轮一行未改**（`tests/pgConfig.test.mjs` 17 用例全绿）。

**Q6｜这些结论靠什么命令复现？**
见 §5。除一个本地 PostgreSQL 测试库外，**零外部服务依赖**。

### 6.5 P0 blocker 状态

| Blocker | 来源 | 本轮状态 |
|---|---|---|
| **T1 券核销半迁移**（Pg 建单 + Mock 核销券） | PROD-1C 收口登记 | ✅ **已关闭**（券核销进入同一 Pg 事务） |
| AdminPlatformConfig / Complaint / CouponTemplate 写闭包缺 Pg 实现 | AUDIT-PG-1 | ✅ **已关闭**（三块落地） |
| 剩余 24 处 `writeAudit` 未迁 | 本轮统计 | ⏸ 已登记，非本轮的 P0（属后续批次） |

---

## 7｜独立 reviewer 结论（Phase 14）

独立只读 reviewer（不参与实现的 agent）逐条检查 13 个点：T1 Pg→Mock 副作用、券并发双花、
券回滚 Case 1/2、支付重放、AdminAudit 强原子性、锁序 / 死锁、投诉⇄订单跨域真值、
券模板并发、第二连接泄漏、业务规则漂移、migration 纪律、意外激活、**测试判别力**。

**结果：BLOCKER 0 · MAJOR 0 · MINOR 0 · NOTE 2 → 可以进入人工验收。**

| NOTE | 内容 | 本轮处置 |
|---|---|---|
| 1 | 投诉三条并发用例只做 `warmPool(2)`，判别力弱于 T1 / 平台参数两组 | ✅ **已修**：补同款撑窗触发器，并以 mutation ④ 验证判别力 |
| 2 | 本轮新引入函数级循环依赖 `mockPaymentRepository → checkoutCommitTransaction → companionDispatchTransaction → mockPaymentRepository` | ⏸ **有意保留**：双方只在函数体内取对方导出，`couponCheckoutChain.test.mjs` 真实走过全链路；文件内已登记正确的修法（把 `createDispatchForOrder` 抽到叶子模块），属范围外重构 |

---

## 8｜本轮**没有**做的事

不切数据源 · 不接 Service runtime · 不批量改 accessor · 不新增任何产品功能 · 不做 UI/UX 扩展 ·
不改任何业务规则 · **0 个新 migration**（`0001`–`0009` 一字未动）· 不改历史轮次记录 ·
**零 Git 写操作**（`git add/commit/push/restore/reset/checkout/rebase/amend` 全部由用户本人执行）。
