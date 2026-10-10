# 交付与验证

Round: PROD-1C
记录人: Claude
记录时间: 2026-10-05
状态: `AWAITING_ACCEPTANCE`

> 所有数字均为**本文件写作时实际命令输出**。命令与退出码逐条列在 §4。
> 本轮 **Claude 全程未执行任何 Git 写操作**。

---

## 1｜交付内容

### 1.1 四件交付物

| # | 交付物 | 文件 | 说明 |
|---|---|---|---|
| ① | **新 migration** | `db/migrations/0009_admin_audit_entries.sql` | 续号新增（`0001`–`0008` 未动），已应用到测试库 |
| ② | **Pg 审计仓储** | `lib/data/pg/adminAuditRepository.ts` | `createAdminAuditRepository(db)` + `pgAdminAuditRepository`；读侧三方法 + 两个**事务内**原语 |
| ③ | **Pg 事务实现** | `lib/data/pg/adminAuditTransactions.ts` | T8 / T14 / T15；5 个导出（4 个自开事务 + 1 个 Tx 级原语） |
| ④ | **真实 PostgreSQL 实证** | `tests/pgAdminAuditTransactions.test.mjs` | 37 个用例：等价 / 并发 / 回滚 |

外加（为②③服务的**纯新增**改动）：`lib/constants/{adminRefunds,earnings,adminCompanions,refunds}.ts`
的纯函数抽取、`lib/data/adminWriteSupport.ts` 的读写分离、`lib/data/pg/{companionRepository,w1Rows,w1Transactions}.ts`
的可见性与返回值加宽。判据见 `02-decisions.md` D3 / D4。

### 1.2 逐事务的完整原子写集合

**判据**：一个事务的**全部**写入是否在**同一个** `BEGIN … COMMIT` 里。

| Tx | Mock 真值源 | 写入的表（按加锁顺序） | Pg 入口 |
|---|---|---|---|
| **T8** | `adminCompanionTransaction.setCompanionFlags`<br>+ `companionOrderTransaction.releaseOrdersForCompanion` | `companions`（3 列）<br>`orders`（解除：`status`, `actual_companion_id`, `accepted_at`, `serving_at`）<br>`dispatch_records`（`state`, `accepted_by_companion_id`）<br>`completion_submissions`（作废待审材料）<br>`companion_release_records`（退出历史）<br>`notifications`<br>**`admin_audit_entries`** | `setCompanionFlagsPg`<br>`releaseOrdersForCompanionTx` |
| **T14 通过** | `adminRefundTransaction.approveRefund` | `orders`（`status`, `refunded_at`, `refunded_amount`）<br>`refund_requests`（状态 + 决策 + 审核人）<br>`earnings`（`reversed_amount`, `status`）<br>`earning_adjustments`（冲回明细）<br>`dispatch_records`（退满时 `timed_out`）<br>`notifications`（退满时通知打手）<br>**`admin_audit_entries`** | `approveRefundPg` |
| **T14 拒绝** | `adminRefundTransaction.rejectRefund` | `refund_requests`（状态 + 审核人）<br>**`admin_audit_entries`** | `rejectRefundPg` |
| **T15** | `adminRefundTransaction.startReviewRefund` | `refund_requests`（`status`, `reviewing_at`）<br>**`admin_audit_entries`** | `startReviewRefundPg` |

⚠️ 三者都是**一个** `getPgExecutor().withTransaction(...)` 闭包——`adminAuditTransactions.ts`
里 `getPgExecutor()` 只出现 **4 次**（每个自开事务的入口各一次），事务体内**没有任何一处**
再向池子索要第二条连接。已核对。

### 1.3 等价性核对表（Mock ↔ Pg，逐条）

迁移的**唯一判据**是「同一批业务规则」。下表是逐条核对的结果，每一条都在
`tests/pgAdminAuditTransactions.test.mjs` 里有一条可证伪的断言。

| 规则 | Mock 的位置 | Pg 的位置 | 一致性 |
|---|---|---|---|
| 幂等账本判定（replay / conflict） | `takeReplay` / `takeReplayForAction` | `takeReplayTx` / `takeReplayForActionTx`（同一组纯函数） | ✅（两读设计，见 D1） |
| **判定顺序**：先账本、后业务数据 | `takeReplay` 注释与实现 | 早读 `conflict` → 锁 → 业务判定 → 权威读 | ✅ |
| `pending → reviewing` 合法；`reviewing → reviewing` 非法 | `canTransitionRefund` | 同一函数 | ✅（用 `rf-seed-1001-02` 验） |
| `reviewingAt` **只在** `to === "reviewing"` 时写 | `resolveRefundReview` | 同一函数 | ✅ |
| `reviewedAt/By/Role/Name/Note` **只在终态**写 | `resolveRefundReview` | 同一函数 | ✅ |
| 订单档位闸：只有 `serving` / `completed` 可批 | `assertRefundApprovalOrderStatus` | 同一函数 | ✅（`accepted` 单上的存量申请被拒） |
| `refundAmount = floor(actualPaid × rateBp / 10000)` | `computeRefundDecisionAmounts` | 同一函数 | ✅ |
| 算出来 ≤ 0 → `decision-invalid` | `assertRefundAmountWithinPaid` | 同一函数 | ✅ |
| **`companionReversalAmount ≡ order.companionBaseIncome`（整笔，与比例无关）** | `computeRefundDecisionAmounts` | 同一函数 | ✅（50% 也整笔） |
| 退满 ⇒ 订单 `refunded` + `refunded_at`；**部分退款不改订单状态** | `applyOrderRefundTx` | 同一函数 | ✅ |
| 收益：`incomeAmount` 不动，只加 `reversedAmount`（钳制到 `incomeAmount`） | `resolveEarningReversal` | 同一函数 | ✅ |
| 收益整笔冲完 ⇒ `status` 回到 `frozen`（不是 `reversed`） | `resolveEarningReversal` | 同一函数 | ✅ |
| 冲回明细幂等键 = `refundId`（`SELECT … WHERE refund_id = $1` 守卫） | `earningAdjustments` 索引 | 同一守卫 | ✅ |
| 退满 ⇒ 派单 `timed_out` | `applyDispatchTimedOut` | 同一列集合 | ✅ |
| 退满 ⇒ 通知**打手的用户账号**，文案按**退款前**档位三选一 | `resolveCompanionRefundCopy` | 同一函数 | ✅ |
| T8 `pause` / `resume` / `enable` / `disable` 的目标三字段 | `nextCompanionFlags` | 同一函数 | ✅ |
| T8 「没有变化就什么都不做」（不写审计） | `areCompanionFlagsUnchanged` | 同一函数 | ✅ |
| T8 `disable` ⇒ 强制 `available = false` | `nextCompanionFlags` | 同一函数 | ✅ |
| T8 `disable` ⇒ 解除在履约单，**保留**已完成单的履约人 | `releaseOrdersForCompanion` | `releaseOrdersForCompanionTx` | ✅（EX-COMP-01） |
| 审计记录拼装（`aud_` 前缀 / `operationId` = 幂等键 / `createdAt` = `ctx.at`） | `buildAuditEntry` | 同一函数 | ✅ |
| 审计 before/after 快照内容 | `toCompanionAuditSnapshot` / `toRefundAuditSnapshot` | 同一函数 | ✅ |

### 1.4 两处**刻意保留**的等价翻译（不是缺陷）

**① `restoreCouponClaimForOrderTx` 在 approve 路径上实际是 no-op。**
它有一句早退：`everAcceptedAt !== null` 时直接返回。而 approve 的资格闸只放行
`serving` / `completed` 的订单，这两者的 `ever_accepted_at` 必然非空。
因此这一支在本轮的种子数据上**走不到**。**保留的理由**是 Mock 有这一步
（`approveRefund` 里确有一次退券判定），删掉就是行为漂移；保留则两侧同为 no-op，
等价成立。已登记，不删除、不「优化」。

**② `applyOrderRefundTx` 短路时返回 `updated: null`。**
Mock 那一步 `updated` 与 `previous` 是同一份对象。Pg 侧用 `RETURNING` 取真实行，
短路时没有行可返回，于是 `updated: null`，调用方统一写 `updated ?? previous`——
这是 Mock「同一份」的精确等价。已有注释写明，见 D4。

---

## 2｜全部 AdminAudit 写者登记（Phase 10）

**口径**：`writeAudit` 的调用点。全库 **33 处**，分布在 **10 个文件**
（与 PROD-1B `03-delivery.md` 的计数一致）。

| # | 文件 | `writeAudit` 处数 | 本轮状态 |
|---|---|---|---|
| 1 | `lib/data/adminCatalogTransaction.ts` | 8 | ⛔ 未迁（Mock 运行时） |
| 2 | `lib/data/adminCompanionTransaction.ts` | 6 | 🔶 **1 处已 Pg 化**（`setCompanionFlags`），其余 5 处未迁 |
| 3 | `lib/data/adminStaffTransaction.ts` | 4 | ⛔ 未迁 |
| 4 | `lib/data/adminContentTransaction.ts` | 4 | ⛔ 未迁 |
| 5 | `lib/data/couponTemplateTransaction.ts` | 3 | ⛔ 未迁 |
| 6 | `lib/data/adminRefundTransaction.ts` | 3 | ✅ **3 处全部已 Pg 化**（T14 ×2 + T15 ×1） |
| 7 | `lib/data/adminAgreementTransaction.ts` | 2 | ⛔ 未迁 |
| 8 | `lib/data/adminReviewTransaction.ts` | 1 | ⛔ 未迁 |
| 9 | `lib/data/adminPlatformConfigTransaction.ts` | 1 | ⛔ 未迁 |
| 10 | `lib/data/adminComplaintTransaction.ts` | 1 | ⛔ 未迁 |
| | **合计** | **33** | **已 Pg 化 4 处 / 未迁 29 处** |

### ⚠️ 「Pg 化」的含义（本轮**没有**做的事）

「已 Pg 化」= **存在一份可被测试证明的 PostgreSQL 事务实现**。
它**不等于**切换：`lib/data/adminAuditRepository.ts` 的 `getAdminAuditRepository()`
**仍然返回 Mock**，服务端调用链上没有任何一处指向 `adminAuditTransactions.ts`。

因此**当前不存在任何 half Pg 事务**（Hard Rule 1 的关键防线）：

| 潜在危险 | 现状 |
|---|---|
| `refund → PostgreSQL / adminAudit → Mock` | **不存在**：退款的 Mock 与 Pg 是两条互不调用的路径，服务端走 Mock 那条 |
| `companion release → PostgreSQL / audit → globalThis` | **不存在**：同上 |
| 事务提交后 best-effort 补写审计 | **不存在**：Pg 实现里审计写在 `withTransaction` 闭包内 |

**结论**：本轮**不激活**是正确的现状；激活的完整门槛见 §3 的 Q4。

---

## 3｜PostgreSQL Activation Readiness Report（Phase 11）

> ⚠️ **诚实性声明**：本轮指令要求回答「6 个问题」，但那 6 个问题的**逐字清单**在上下文压缩后
> 未能完整保留。下面的 6 问是按本仓**自己写下的激活门槛**
> （`docs/03-dev/rounds/PROD-1B/02-decisions.md` Q1 §13d）与本轮三条 Hard Rule 重建的。
> **若产品负责人手里的清单与此不同，以产品负责人的清单为准**，并请指出以修正本节。

### Q1｜`DATA_SOURCE=postgres` 之后，还会不会存在「一半 PostgreSQL、一半 Mock」的事务？

**答：若现在激活，不会产生半事务；但会产生一个更严重的问题——闭包根本没覆盖完，见 Q4。**

本轮新增的 Pg 实现与 Mock 实现是**两条互不调用的路径**。服务端目前只走 Mock。
**唯一可能制造半事务的动作是「把 `getAdminAuditRepository()` 切到 Pg」——
本轮没有做，也不该做**：一旦切过去，所有仍未迁移的 29 处 `writeAudit`
就会变成「业务写 Mock、审计写 Pg」，那是 Hard Rule 1 明令禁止的形态。

**证据**：`lib/data/adminAuditRepository.ts:57` 的 `getAdminAuditRepository()` 返回
`mockAdminAuditRepository`（本轮未改这一行）。

### Q2｜每个已 Pg 化的管理写事务，业务写入与审计是否真的同生共死？审计失败时业务写入是否全部回滚？

**答：是，且已被真实数据库证伪过。**

四个 `withTransaction` 闭包内，审计的 `INSERT` 是**最后一步**，且**不写 `ON CONFLICT DO NOTHING`**
（D7）——冲突即 `23505`，整段回滚。

`tests/pgAdminAuditTransactions.test.mjs` 有 4 条「最后一笔写入失败」探针用例：

| 用例 | 让谁失败 | 断言回了什么 |
|---|---|---|
| T8 审计写不进去 | `admin_audit_entries` | 标志位 / 订单 `serving` / 退出历史 0 条 / 派单 `accepted` / 通知数回基线 |
| T8 退出历史写不进去 | `companion_release_records` | 订单 `serving` / 履约人未解绑 / 标志位未改 |
| T14 审计写不进去 | `admin_audit_entries` | 退款回 `pending` / `decision = null` / 订单状态与累计已退回 0 / `reversed_amount = 0` / 冲回明细 0 条 / 派单未关 / 通知回基线 |
| T14 收益明细写不进去 | `earning_adjustments` | 退款回 `pending` / 累计已退回 0 / `reversed_amount = 0` |

**这是本轮存在的全部理由**，因此它必须有**能失败**的探针——探针在
`tests/pgW1Transactions.test.mjs` 的 `PROBED_TABLES` 里，`admin_audit_entries` 是本轮新加的。

### Q3｜迁移是否只换了持久化，没有改动任何业务规则？

**答：是。**

本轮**没有改动任何判定顺序、金额公式、状态机或错误优先级**。
`lib/constants/**` 的改动是**纯新增**（`git diff --numstat`：65/0、57/0、42/0、47/0，
即 211 行新增、**0 行删除**）；`lib/data/adminWriteSupport.ts` 是把三个函数体里的内联逻辑
抽成纯函数并由原函数调用，语义逐条不变。

**零漂移的可复现证据**：`pnpm test` 全量 **2037 用例 / 0 fail / 0 skipped**
（Mock 行为未变的直接证据）；`pnpm test:pg` **170 / 0 fail / 0 skipped**。

**唯一一处「加宽」**是 `applyOrderRefundTx` 的返回值（只加字段，不改既有字段），见 D4。
**唯一一处「比 Mock 更严」**是审计写入拒绝同键覆盖（D7）——它只在**已经出错**时才有区别
（业务侧幂等漏判），不会改变任何正常路径的结果。

### Q4｜距「可以声明 `DATA_SOURCE=postgres` 可用」还差什么？

**答：还差 29 处 `writeAudit`（9 个文件）。门槛未满足，本轮明确不激活。**

PROD-1B 写下的门槛（逐字）：

> 「17 张表的全部写者 + `admin_audit_entries` 的全部 33 处写者（10 个文件中的另外 8 个）
> 一并迁完，`DATA_SOURCE=postgres` 才允许被声明为可用。」

按 §2 的登记表，**已迁 4 / 33**。剩余：

- `adminCompanionTransaction` 的另外 5 处（入驻申请三态 + 编辑资料 + 移除）
- 8 个完全未动的事务文件（agreement / catalog / content / complaint / platformConfig / review / staff / couponTemplate），共 24 处
- 以及这些事务各自的**业务写表**（商品、类目、内容、客服账号、协议、平台参数的 Pg 实现）

**判定：`NOT READY TO ACTIVATE`。「不激活」是本轮的正确状态，不是未完成。**

### Q5｜激活后 `DATA_SOURCE=postgres` 会连到哪张库？有没有防呆？

**答：连 `DATABASE_URL`；破坏性操作另有一道 `_test` 后缀守卫；生产环境拒绝 seed / reset。**

已在本轮实测（§4.6）：

| 场景 | 结果 |
|---|---|
| `NODE_ENV=production` + `seedDatabase` | `PgConfigError`：生产环境不允许写入预置数据（seed） |
| `NODE_ENV=production` + `resetDatabase` | `PgConfigError`：生产环境不允许清空数据（reset） |
| `DATABASE_URL` 指向 `chaoge_esports_dev` + `resetDatabase` | `PgConfigError`：库名不以 `_test` 结尾 |
| `TEST_DATABASE_URL` 未配 + `requireTestDatabaseUrl` | `PgConfigError`：点名 `TEST_DATABASE_URL`（不伪装成 `DATABASE_URL` 缺失） |
| test 库 `resetDatabase` + `seedDatabase` | ✅ 成功；4 张关键表存在；审计 0 行（种子不带审计，D9） |

⚠️ 上述守卫是 **PROD-1A 建立的**，本轮**一行未改**，也未弱化（`tests/pgConfig.test.mjs` 17 个用例全绿）。

### Q6｜这些结论靠什么命令复现？

**答：**见 §4。全部命令**零依赖外部服务**（除了一个本地 PostgreSQL 测试库）。

---

## 4｜验证证据（Phase 14）

全部命令在仓库根目录 `D:\vs\微信小程序\web` 执行。**退出码为实测值**。

### 4.1 定向 PROD-1C 用例

```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env \
  --import ./tests/alias-hook.mjs --test-concurrency=1 \
  --test tests/pgAdminAuditTransactions.test.mjs
```

→ **exit 0**；`tests 37 / pass 37 / fail 0 / skipped 0`。

### 4.2 `pnpm test:pg`

```
pnpm test:pg
```

→ **exit 0**；`tests 170 / pass 170 / fail 0 / skipped 0`。

明细：`pgConfig 17` · `pgFoundation 27` · `pgContract 23` · `pgW1Transactions 66` ·
`pgAdminAuditTransactions 37`。

⚠️ 全部**真实连接** `TEST_DATABASE_URL`（**没有 mock / stub 的 Pg client**）。
无库时整体 `skip`（文案写明缺什么），**不假装通过**。

### 4.3 `pnpm test`（生产 `APP_BASE_URL` 全量）

```
PORT=3105 pnpm start                    # 生产构建，Mock 运行时
APP_BASE_URL=http://localhost:3105 \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env \
  --import ./tests/alias-hook.mjs --test-concurrency=1 --test "tests/*.test.mjs"
```

→ **exit 0**；`tests 2037 / pass 2037 / fail 0 / skipped 0 / todo 0`。

⚠️ **关键生产全量：`0 fail` `0 skipped`**，符合 Phase 14 要求。
（不同时给 `APP_BASE_URL` 与 `.env` 时会有 150 条跳过——那是 HTTP 与 Pg 两组用例的
正常跳过条件，**不是**本轮交付状态。）

### 4.4 typecheck / lint / build

| 命令 | 退出码 |
|---|---|
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | **0** |
| `pnpm lint`（ESLint CLI，flat config） | **0** |
| `pnpm build`（Turbopack 生产构建） | **0** |

### 4.5 测试用例清单（`tests/pgAdminAuditTransactions.test.mjs`，37 条）

| 组 | 条数 | 覆盖 |
|---|---|---|
| T8 只改开关 | 8 | 暂停 / 恢复 / 启用 / 停用（含 EX-COMP-01 保留已完成单履约人）/ 重放 / 幂等键混用 → conflict / 三种前置失败零写入 / 窄写入不碰别的列 |
| T8 解除原语 | 1 | 无在履约单 → 空集且零写入 |
| T15 开始审核 | 5 | 正常迁移 / 重放 / 非法迁移 / 跨意图 conflict / not-found |
| T14 审核通过 | 8 | 全额（退款+订单+派单+通知+审计同一提交点）/ 部分（不改订单状态、派单不关）/ 收益整笔冲回 / 订单档位闸 / 金额闸 / 重放 / 已终态 / not-found |
| T14 审核拒绝 | 3 | 只写申请 / 存量申请可拒 / 重放 |
| **并发** | 7 | T14 双通过只出一次款 · T14 通过与拒绝最终状态唯一 · T15 双开始审核 · T8 停用与订单完成不变量 · **同键 T15 双请求（一执行一重放）** · **同键 T14 双请求（只出一次款、只有一条审计/一条冲回明细）** · **同键 T8 双请求** |
| **回滚** | 5 | T8×2（审计 / 退出历史）· T14×2（审计 / 收益明细）· T15×1（审计） |

### 4.5.1 同键并发用例的红-绿证据（Phase 15 复审后补）

同键并发的三条用例是**两读设计**（`02-decisions.md` D1）的唯一保护网：
没有它们，把「加锁后的权威读」改回「只读一次」，全套测试仍会全绿。

**已实测它们能失败**（两条各做一次红-绿）：

| 破坏点 | 命令 | 实测失败信息 |
|---|---|---|
| `setCompanionFlagsPg`：`const replay = null as null;` | §4.1 定向命令 | `★ 恰好一个自认重放 0 !== 1` |
| `approveRefundPg`：`const replay = null as null;` | §4.1 定向命令 | `第二个必须正常返回（重放），实际 invalid-transition` |

每次破坏后从备份**逐字节还原**（md5 `166b62284f4815b8887195fc8b573197`），再跑 §4.1 得 **37/37 绿**。
即：**这三条用例在实现退化时会失败，在本轮实现下会通过**。

### 4.6 安全守卫实测（Phase 12）

见 Q5 的表格。命令为 `node -e` 直接调用守卫函数，并在探针执行器里放了一个
「一旦被调用就抛错」的 `query`，因此**守卫失效会以「不该碰数据库」失败**而不是悄悄连上。

### 4.7 migration 纪律

- `db/migrations/` 现有 `0001` … `0009`，**编号连续无重复**，**`0001`–`0008` 一个字节未改**。
- `tests/pgConfig.test.mjs` 的手写清单（防「悄悄变多」）与目录扫描（防「漏读」）
  **双向**断言前 9 个版本。
- `tests/pgFoundation.test.mjs` 的 `ALL_VERSIONS` / `ALL_TABLES` / `EMPTY_HUB_TABLES`
  已同步 `0009` / `admin_audit_entries`。

---

## 5｜本轮**没有做**的事（边界声明）

| 事项 | 为什么不做 |
|---|---|
| 切换 `DATA_SOURCE=postgres` | 指令明令「本轮不要自行切」；且 PROD-1B `13d` 门槛未满足（Q4） |
| 迁移其余 29 处 `writeAudit` | 超出本轮范围；已登记（§2） |
| 把 `getAdminAuditRepository()` 切到 Pg | 会造成 half Pg 事务（Q1），Hard Rule 1 禁止 |
| 改用 `SERIALIZABLE` 隔离级别 | 指令明令「默认不要擅自上 SERIALIZABLE 全局解决」 |
| 修改 `0001`–`0008` 任何 migration | 明令禁止 |
| 修改 `docs/03-dev/rounds/**` 历史记录 | 明令禁止 |
| 修改任何业务规则 / 顺手修疑点 | Hard Rule 3 |
| 任何 Git 写操作 | 全程约束 |

---

## 6｜已知事项（不阻塞，登记备查）

| # | 事项 | 性质 |
|---|---|---|
| 1 | `restoreCouponClaimForOrderTx` 在 approve 路径上是 no-op（D3/§1.4①） | 刻意保留的等价翻译 |
| 2 | 探针表 `w1_write_log` / `w1_probe_fail` 若在进程外手工脚本里留下 `w1_probe_fail` 行，会让后续探针失败 | 已知；`beforeEach` 与 `dropDatabaseObjects()` 都会清 |
| 3 | 用户端暂时可见 `companionRateBp` | 既有登记（上线前移除），非本轮范围 |
| 4 | 需求文档 §17 的按比例冲回表述与 P0-15 冲突 | PROD-1B 已登记，文档修订单独立轮次 |
| 5 | **同键 + 不同目标**并发：Pg 抛 `23505`，Mock 抛 `operation-conflict`（Phase 15 复审 NOTE 1） | **刻意不修**：要修得靠 `SAVEPOINT`，而一条失败语句会中止整个 PG 事务，风险落到「业务与审计同生共死」这条本轮核心不变式上；Hard Rule 2 明说「本轮不重新设计审计架构」。复审方也**未**将其列为缺陷。**当前不可达**（`DATA_SOURCE` 未设置，服务端走 Mock）。激活前须重新评估。 |
| 6 | `releasedOrderIds` 的顺序与 Mock 不同（Phase 15 复审 NOTE 2） | 当前**不可观测**（无调用方依赖其顺序）；登记备查，不修 |

---

## 7｜独立复审结果（Phase 15）

**形式**：`reviewer-agent`（只读，工具集 Read/Glob/Grep/Bash，**不具备写能力**），
对照 `docs/01-requirements/**` 与 `docs/02-tech-design/architecture-rules.md` 审查本轮全部改动。
**复审方与本轮实现方相互独立**，其结论未由 Claude 代为改写。

**结果：`0 BLOCKER / 1 MAJOR / 1 MINOR / 2 NOTE`。已全部处置如下。**

| 级别 | 内容 | 处置 |
|---|---|---|
| **MAJOR** | 4 条并发用例全部使用**不同** `operationId`，因此**没有任何测试**保护本轮的核心设计（两读判定）。「一个会破坏本轮核心设计的回归，当前没有任何测试会失败。」 | ✅ **已修**：新增 3 条**同键**并发用例（T15 / T14 / T8），并如 §4.5.1 做红-绿证明它们能失败 |
| **MINOR** | 窄写入用例里 `assert.equal(after.sort_order, (await readCompanion("cp-1")).sort_order)` 是同义反复（右侧读的就是 `after`） | ✅ **已修**：改为前后快照对比，并补 `assert.notEqual(after.available, before.available)` 保证「这次动作确实改了点东西」 |
| **NOTE 1** | 同键 + 不同目标并发时 Pg 报 `23505`、Mock 报 `operation-conflict` | 📌 **已登记（§6 第 5 条），刻意不修**；理由见该行 |
| **NOTE 2** | `releasedOrderIds` 顺序与 Mock 不同 | 📌 **已登记（§6 第 6 条）**，当前不可观测 |

**修订后重新执行 §4 的全部门禁**（`pnpm test:pg` 170 / 生产全量 2037 / `typecheck` / `lint` / `build`）
**全部 exit 0**，即 MAJOR / MINOR 的修复未引入新失败。

**故当前状态：`0 BLOCKER`、`0 MAJOR`、`0 MINOR`（未修）——满足 Phase 15 的通过条件。**

### 7.1 复审方对整改的回执（第二遍，只读）

复审方对上述整改**逐条回读代码与文档**后确认：

- **MAJOR → 0**：三条同键并发用例位置与断言「判别式成立」——断言写的是「恰好一个真做事、恰好一个重放」，
  能排除「两边都真的执行一遍」这一错误结局；并指出两条红-绿失败信息**与实现语义精确吻合**
  （T8 走 `areCompanionFlagsUnchanged` ⇒ `replayed` 计数为 0；T14 走 `canTransitionRefund("approved","approved")` 为假 ⇒ `invalid-transition`），
  「不是编造的」。测试计数 `grep -c "^test("` = **37**，与 §4.5 一致。
- **MINOR → 0**：恒真断言已消除。
- **NOTE 1**：复审方**认同「刻意不修」**——在该约束下捕获 `23505` 重读确需 `SAVEPOINT`，
  会侵蚀「审计与业务同生共死」这条本轮唯一要守的不变量，而代价（跨目标复用键 + 真并发的偶发 500）
  当前不可达且无数据损坏。**NOTE 2** 维持登记备查。
- **未受影响的既有结论**：整改只落在测试与文档，生产代码（`lib/constants/**`、`lib/data/**`、`lib/data/pg/**`）
  与迁移 `0009` **一个字未动**，故首轮对判定顺序、金额、收益冲回、加锁顺序、事务闭包、
  审计唯一键纪律、迁移纪律的「已核对，等价」结论继续成立。

**复审方最终判定：`0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE`（两条 NOTE 均为已登记项，非要求动作）。**

> ⚠️ **诚实性边界**：复审方为只读审查，**未运行任何门禁命令**（`pnpm test:pg` 需独立测试库），
> 因此它**未独立复跑** §4 的 170 / 2037 / 37 等数字，只核对了「这些数字与当前代码语义自洽」。
> 本节所有门禁**数字的唯一依据是 Claude 侧在 §4 记录的实跑输出**，请以此为准。
