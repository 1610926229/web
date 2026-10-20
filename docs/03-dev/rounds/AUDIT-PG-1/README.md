# AUDIT-PG-1｜PostgreSQL 迁移现状审计

Status: `DONE`（**审计结论** + **产品 / 架构裁定登记**；本轮**不写业务代码**，只记录事实）
Audit Date: 2026-10-10
Baseline: 工作区真实源码树。`HEAD = 7d7d099`（分支 `feat/order-lifecycle-alignment`），
其中 **PROD-1C 的全部改动仍未提交**（18 改 + 7 未跟踪）
Audit Of: 全部 PG 基础设施 · `db/migrations/**` 9 个迁移 · `lib/data/**` 28 个仓储 ·
16 个 Mock 事务文件 + 2 个 Pg 事务模块 · 运行时数据源选择器 · 四条业务面
Spec: 用户本轮即时指令《PostgreSQL Migration Status Audit》11 节（未落成 `cmd_*.md`）
Git: **全程零 Git 写操作**（无 `add` / `commit` / `push` / `stash` / `checkout` / `reset`）

---

## 〇、只读性说明

- **未修改任何业务代码**：`lib/` `app/` `components/` `tests/` 在本次审计中**零改动**。
- **未新建 migration**，未补 Repository，未补 Transaction，未开始下一 Round。
- 本文件**新增**（唯一写入）；未改写任何历史 Round 档案。
- ⚠️ **未动 Roadmap**：没有在 `总需求进度表.md` 里新建 Round 编号、未重排优先级、未补功能点行
  （沿用 `AUDIT-122` 立下的纪律）。
- 发现的问题**只登记、未修**。

### 审计方式

1. 四路只读并行扫描（基础设施 + 迁移 / 仓储 + accessor / 事务 / 运行时数据源 + 业务流），
   每路都要求 **file:line 证据**，不接受「文档这么说」。
2. **关键统计由本轮亲自复核**，不采信子代理报告：仓储数、表数、`writeAudit` 处数、
   切换点消费者、测试计数均逐一实跑。
3. **门禁由本轮亲自复跑**（见 §十一），不引用旧文档数字。

---

## 一、Round 状态

| Round | 开发完成 | 自动门禁 | Manual Acceptance | Git Commit | 正式状态 |
|---|---|---|---|---|---|
| **PROD-1A** | 2026-10-03 | ✅ 全绿 | ✅ PASSED 2026-10-03（A–E 五项） | `b9588cd`（**四轮合并提交**，非本轮独占） | ✅ **DONE** |
| **PROD-1B** | 2026-10-05 | ✅ 全绿 | ✅ PASSED 2026-10-05（A–E 五项） | `5acf616`（+ 收口 `7d7d099`） | ✅ **DONE** |
| **PROD-1C** | 2026-10-05 | ✅ 本次复跑通过 | ⏳ **未验收** | — | ⏳ **AWAITING_ACCEPTANCE** |

**不要把「代码写完」等同于 `DONE`。** `DONE` 仍是双门槛：
① 产品负责人明确「人工验收通过」；② 产品负责人**本人**完成 Git 提交。

**两点观察（非缺陷，登记备查）**

1. `7d7d099` 与 `5acf616` **提交信息完全相同**（`PROD-1B Order Hub PostgreSQL implementation and concurrency proof`），
   但内容不同：后者是实现提交，前者是 PROD-1B 的 DONE 收口（`README.md` / `04-acceptance.md` /
   `总需求进度表.md`，3 文件 41+ / 16−）。**不是重复提交**，但同名两条易被误读。
2. `docs/03-dev/需求功能点进度表.md` 中 **`PostgreSQL` / `PROD-1` / `DATA_SOURCE` 零命中**。
   迁移进度**只登记在 `总需求进度表.md`**——查迁移状态只有这一处入口。

---

## 二、PostgreSQL 基础设施

| 项 | 状态 | 落点 / 事实 |
|---|---|---|
| pg Pool（单例） | **READY** | `lib/data/pg/pool.ts:46,68`，惰性单例；max 10(prod)/4，`statement_timeout` 15s，含 `error` 监听 |
| TxHandle / executor | **READY** | `lib/data/pg/executor.ts:30-47`；`connectionId` = `pg_backend_pid()`，用于证「一次事务一条连接」 |
| `withTransaction` | **READY** | `executor.ts:75-121`；BEGIN→COMMIT，抛错 ROLLBACK 后**抛原始错误**。**隔离级别未设置 ⇒ READ COMMITTED**；**无自动重试**；**不读时钟** |
| migration runner | **READY** | `migrate.ts:143-211`；按版本号排序、拒绝重号、sha256 校验、`pg_advisory_xact_lock`，**每支迁移各自一个事务** |
| migration history | **READY** | 表 `schema_migrations`（`migrate.ts:49`）：version/name/checksum/applied_at |
| seed | **READY** | `seed.ts:506`；11 个域，单事务、全 `ON CONFLICT DO NOTHING`，先做 fixture 唯一性断言 |
| reset | **READY** | `reset.ts:78,106`；`resetDatabase` 保留 `schema_migrations`，`dropDatabaseObjects` 全删 |
| health check | **READY** | `health.ts:52-125`；**不抛错**、**只读**、endpoint 打码 |
| `DATABASE_URL` | **READY** | `config.ts:75`；`.env` 已配 |
| `TEST_DATABASE_URL` | **READY** | `config.ts:80`；`.env` 已配 |
| `DATA_SOURCE` | **PARTIAL** | 判据 `config.ts:59-61`（`=== "postgres"`）；**只有 2 个仓储读它**（§四）。**`.env` / `.env.local` 均未设置** |
| 生产 seed/reset 守卫 | **READY** | seed 拒 `NODE_ENV=production`；reset **双重**：拒生产 + 实际库名须以 `_test` 结尾；**均在碰库之前生效** |
| timestamptz / UTC | **READY** | `pool.ts:44` 全局 `setTypeParser(TIMESTAMPTZ, → toISOString())`，定长 UTC ISO 字符串；无时区 `timestamp(1114)` **刻意不注册** |

---

## 三、Migrations

9 个文件，编号 `0001`–`0009` **连续、无重号、无断号**。
**无任何 `ALTER` / `DROP`**（grep 0 命中）——没有任何迁移改动过更早迁移的对象。

| 版本 | 建了什么 | 表数 | 域 | 归属 |
|---|---|---|---|---|
| 0001 | `favorites` | 1 | 收藏 | **PROD-1A** |
| 0002 | `suggestions` | 1 | 反馈 | **PROD-1A** |
| 0003 | `companions` | 1 | 打手 | **PROD-1B** |
| 0004 | `orders` · `payment_requests` · `payments` | 3 | 订单·支付 | **PROD-1B** |
| 0005 | `dispatch_records` · `completion_submissions` · `companion_accept_events` · `companion_release_records` · `companion_service_events` | 5 | 派单·履约 | **PROD-1B** |
| 0006 | `refund_requests` · `earnings` · `earning_adjustments` · `notifications` | 4 | 退款·收益·通知 | **PROD-1B** |
| 0007 | `coupon_templates` · `coupon_claims` | 2 | 券 | **PROD-1B** |
| 0008 | `complaints` · `platform_config` | 2 | 投诉·平台参数（**只读参与者**） | **PROD-1B** |
| 0009 | `admin_audit_entries` | 1 | 管理审计 | **PROD-1C** |

- **最新版本号 = `0009`**；**一共 20 张业务表**（1+1+1+3+5+4+2+2+1）。
  PROD-1A **2** 张 · PROD-1B **17** 张 · PROD-1C **1** 张。
- ⚠️ `0009` 注释里的「已建的 17 张表」是 **PROD-1B 闭包口径**（0003–0008），
  不是仓库总数 20——**不是数字打架**。
- **schema 已建、runtime 从未使用的表：18 / 20。**
  只有 `favorites` / `suggestions` 能被 accessor 选中（且今天仍是 Mock）。
  其余 18 张只被 `lib/data/pg/**` 与 `tests/pg*.test.mjs` 引用；
  `app/**` 与 `lib/services/**` 对 `lib/data/pg` 的引用数为 **0**。

---

## 四、28 个 Repository

`lib/data/*Repository.ts` 共 56 个文件 = **28 个接口/accessor + 28 个 Mock 实现**。
`lib/data/pg/` 有 **16** 个 Pg 实现文件。

**切换点只有一个**，且只覆盖 2 个仓储：

```ts
// lib/data/favoriteRepository.ts:73
return isPostgresDataSourceEnabled() ? pgFavoriteRepository : mockFavoriteRepository;
// lib/data/suggestionRepository.ts:66
return isPostgresDataSourceEnabled() ? pgSuggestionRepository : mockSuggestionRepository;
```

`grep "return mock*Repository;"` = **26 处**（硬返回 Mock，永远回不到 Pg）。

| 分类 | 数量 | 仓储 |
|---|---|---|
| **A** 只有 Mock（无 Pg 实现、无表） | **12** | user · catalog · content · staff · agreement · qualification · level · tip · message · review · admin · companionApplication |
| **B** 有 Pg 实现，但**只有测试引用** | **14** | payment · dispatch · companion · companionAccept · companionRelease · companionService · completion · earning · refund · complaint · notification · platformConfig · coupon · adminAudit |
| **C** 可通过 `DATA_SOURCE` 切 Pg | **2** | favorite · suggestion |
| **D** 默认走 Pg | **0** | — |

> **⚠️ 「写了 PgRepository」≠「系统现在就在用 PostgreSQL」。**
> 16 个 Pg 实现里 **14 个是死代码**——没有任何 accessor 分支指向它们，
> `app/**` / `lib/services/**` 一个都不 import。
>
> **有 Pg 实现的仓储 = B + C = 14 + 2 = `16 / 28` ≈ `57%`。**

---

## 五、Transaction 盘点（回代码复核，不采信旧文档）

Mock 事务共 **16 个 `lib/data/*Transaction.ts`**；Pg 事务模块 **2 个**
（`pg/w1Transactions.ts`、`pg/adminAuditTransactions.ts`）+ T1 在 `pg/paymentRepository.ts`。

| Tx | 业务动作 | Mock 落点 | Pg 落点 | 打真库验证 | Runtime 已激活 |
|---|---|---|---|---|---|
| T1 | 建支付请求 / 确认支付（建单·支付记录·派单·核销券） | `mockPaymentRepository.ts:96,114` | `pg/paymentRepository.ts:349,376` | ✅ `pgContract.test.mjs:972` | **否** |
| T2 | 接单 `paid→accepted` | `companionDispatchTransaction.ts:216` | `w1Transactions.ts:352` | ✅ | **否** |
| T3 | 派单超时清扫 | `companionDispatchTransaction.ts:383` | `w1Transactions.ts:1199` | ✅ | **否** |
| T4 | 打手主动取消 | `companionOrderTransaction.ts:341` | `w1Transactions.ts:1535` | ✅ | **否** |
| T5 | 开始服务 | `companionOrderTransaction.ts:478` | `w1Transactions.ts:1659` | ✅ | **否** |
| T6 | 客服回池 | `companionOrderTransaction.ts:597` | `w1Transactions.ts:1766` | ✅ | **否** |
| T7 | 客服换人 | `companionOrderTransaction.ts:707` | `w1Transactions.ts:1868` | ✅ | **否** |
| T8 | 停用/启用护航 + 解除在履约单 | `adminCompanionTransaction.ts:520` | `adminAuditTransactions.ts:460,326` | ✅ `pgAdminAuditTransactions.test.mjs:261,498` | **否** |
| T9 | 提交完成材料 | `completionTransaction.ts:196` | `w1Transactions.ts:466` | ✅ | **否** |
| T10 | 通过 / 驳回完成材料 | `completionTransaction.ts:287,391` | `w1Transactions.ts:687,758` | ✅ | **否** |
| T11 | 到期自动通过 | `completionTransaction.ts:459` | `w1Transactions.ts:821` | ✅ | **否** |
| T12 | 用户全额退款 | `directRefundTransaction.ts:191` | `w1Transactions.ts:956` | ✅ | **否** |
| T13 | 收益解冻 | `earningTransaction.ts:316` | `w1Transactions.ts:897` | ✅ | **否** |
| T14 | 退款审核通过 / 拒绝 | `adminRefundTransaction.ts:396,654` | `adminAuditTransactions.ts:680,943` | ✅ `:588,777` | **否** |
| T15 | 开始审核退款 | `adminRefundTransaction.ts:194` | `adminAuditTransactions.ts:553` | ✅ `:517` | **否** |

**结论：T1–T15 全部有对等 Pg 实现，全部打过真库，Runtime 激活数 = 0。**
没有任何 `app/**` / `lib/services/**` 文件 import 过 `w1Transactions` / `adminAuditTransactions`；
`getPaymentRepository()` 硬返回 Mock（`paymentRepository.ts:159-161`）。

**另有 9 个「管理端事务」Mock-only，连 Pg 实现都没有：**

| 事务文件 | writeAudit 处数 | 落表 | Pg 实现 |
|---|---|---|---|
| `adminCatalogTransaction.ts` | 8 | categories/products/specs + audit | **无表和实现** |
| `adminCompanionTransaction.ts`（T8 之外的 5 处） | 5 | companion_applications/qualifications + audit | **无表和实现** |
| `adminContentTransaction.ts` | 4 | announcements/banners/quick_entries + audit | **无表和实现** |
| `adminStaffTransaction.ts` | 4 | staff + audit | **无表和实现** |
| `couponTemplateTransaction.ts` | 3 | coupon_templates + audit | 表已建，**写方法无** |
| `adminAgreementTransaction.ts` | 2 | agreements + audit | **无表和实现** |
| `adminComplaintTransaction.ts` | 1 | complaints + audit | 表已建，**写方法无** |
| `adminReviewTransaction.ts` | 1 | reviews + audit | **无表和实现** |
| `adminPlatformConfigTransaction.ts` | 1 | platform_config + audit | 表已建，**写方法无** |

**`writeAudit` 普查：`lib/data/` 内 33 处调用点 + 1 处定义（`adminWriteSupport.ts:205`），
分布在 10 个 Mock 事务文件。** 与文档「33 处 / 10 文件」**完全一致**。
Pg 侧**没有**任何一处调用 Mock 的 `writeAudit`——它走 `appendAuditEntryTx`
（`pg/adminAuditRepository.ts:126`）。

> 补充：`couponRedemptionTransaction.ts`（`redeemCouponClaimForOrder` / `restoreCouponClaimForOrder`）
> 是 T1 原子段内的**同步助手**，不是独立事务。它的**退券方向**有 Pg 版
> （`w1Transactions.ts:1081 restoreCouponClaimForOrderTx`），**核销方向没有**——见 §六 A。

---

## 六、运行时数据源与业务流

**`pnpm dev` 现在：100% Mock。**
`grep -c '^DATA_SOURCE' .env` = **0**，`.env.local` = **0**。
`.env` 只有 `DATABASE_URL` / `TEST_DATABASE_URL`；`.env.local` 只有 5 个 `ENABLE_MOCK_*`。

**如果现在设 `DATA_SOURCE=postgres`：**

| 数据 | 去向 |
|---|---|
| `favorite`（我的收藏） | → **PostgreSQL** |
| `suggestion`（意见反馈） | → **PostgreSQL** |
| **其余 26 个仓储 + `getDataSource()`** | → **仍然 Mock**（硬编码，开关管不到） |
| **全部 15 个 Pg 事务** | → **仍然走 Mock**（没有任何调用方） |

- **没有任何一条完整用户流程会跑 Pg。** 下单 / 支付 / 派单 / 接单 / 完成 / 退款 / 收益 /
  评价 / 管理端——**逐条**仍走 Mock。
- **不会 fail-fast。** 没有 `instrumentation.ts`，`getPool()` 惰性；不存在
  「`DATA_SOURCE=postgres` 但某仓储没有 Pg 实现」的检查——缺实现就**静默回 Mock**。
- **一处真实的 half-Pg / half-Mock 窗口**：`lib/services/favorites.ts` 的 `addFavoriteForUser`
  先 `getDataSource().getProductDetail()`（**Mock** 目录校验），再
  `getFavoriteRepository().addFavorite()`（**Pg** INSERT）。`favorites` 表无 FK，
  **不报错、只静默漂移**。反方向（读 Pg 写 Mock）未发现。
- 另有一处**数据可见性断裂**（非半写）：切开关后 Mock 里已建的收藏/反馈**全部看不见**。

### 六 A、业务流逐条判定

| 面 | 现在 | 若切 `DATA_SOURCE=postgres` |
|---|---|---|
| **用户**：浏览商品 / 评价 | **MOCK ONLY**（无 Pg 实现） | MOCK ONLY |
| **用户**：下单 → 支付 → 派单 → 接单 → 完成 → 确认 → 收益 | MOCK（Pg 已实现未接线） | MOCK |
| **用户**：开始服务 | **MOCK ONLY** | MOCK |
| **售后**：申请退款 / 开始审核 / approve / reject | MOCK（T14/T15 Pg 已实现未接线） | MOCK |
| **售后**：实际退款 / earning adjustment / AdminAudit | **MOCK ONLY** | MOCK |
| **打手**：接单 / 禁用封禁 / 订单释放 | MOCK（T8 等 Pg 已实现未接线） | MOCK |
| **打手**：取消 | **MOCK ONLY** | MOCK |
| **管理员**：商品 / 券 / 投诉 / 退款 / 评价 / 平台配置 / 员工 / 打手 | **MOCK ONLY** | MOCK |

**没有任何一条是 `FULL PG`。**

### 六 B、⚠️ 本次审计的**新发现**：Pg T1 未实现「核销券」（登记，未修）

证据链：

1. PROD-1B `02-decisions.md:220` 把 `coupon_claims` 登记为「**写**（T1/T3/T12）」；
2. 但 `lib/data/pg/paymentRepository.ts` 的 `confirmPaymentRequest` 全程**没有**任何
   `coupon_claims` 写语句——`grep -rn "used_at" lib/data/pg/*.ts` 仅 `w1Transactions.ts:1091`
   一处，而且是**退券**（`SET status='unused'`）；
3. 核销实际由 `lib/services/checkout.ts:431 buildOrderFromRequest` →
   `redeemCouponClaimForOrder`（`couponRedemptionTransaction.ts:59`）执行，
   它写的是 **Mock** 的 `couponStore()`；
4. 该 `buildOrder` 回调是在 `confirmPaymentRequest` **事务内**被调用的
   （`pg/paymentRepository.ts:421`）——即：**一旦切到 Pg，T1 事务里会「订单写 Pg、券核销写 Mock」**；
5. 现有契约用例**测不到**：`pgContract.test.mjs:1040` 传的是 stub `buildOrder = () => order`，
   且请求里 `coupon: null`。

这不是 T1 实现写错，而是**闭包登记与代码不一致**：`coupon_claims` 被算作「T1 的写参与者」，
但那条写路径留在 Mock。**当前不可达**（`DATA_SOURCE` 未设置），但它是切库前必须关掉的一处，
且上一轮的《激活就绪报告》**未覆盖它**。
→ **产品裁定见 §十 10.1。**

---

## 七、Blockers

### P0 — 不解决不能切数据库

1. **订单写闭包其实没闭**：`coupon_claims` 的**核销**在 Pg 事务里仍写 Mock（§六 B），且无用例保护。
2. **管理端审计 33 处写者只迁了 4 处**，剩 **29 处 / 9 个文件**。
3. **9 个管理端事务完全没有 Pg 实现**，其中 5 个连**表都没有**
   （categories/products/specs · announcements/banners/quick_entries · agreements ·
   staff/admin_accounts · companion_applications/qualifications · reviews）。
4. **12 / 28 个仓储没有任何 Pg 实现**；其中 `user` / `catalog` / `content` / `staff` /
   `review` / `admin` 是核心业务实体，**没有表**。
5. **26 / 28 个 accessor 根本回不到 Pg**。

### P1 — 可以切，但上线前必须处理

6. **真实 Scheduler 缺失**：T3 / T11 / T13 目前**挂在读取路径上惰性触发**
   （`orders.ts:184`、`staffOrders.ts:31`、`companionEarnings.ts:52`…）。无访问则不执行。
   已登记为 `🔴 PRODUCTION_BLOCKER`（`总需求进度表.md:508`），与数据源切换**正交**。
7. **`/api/debug/reset` 只清 Mock**（`ENABLE_MOCK_DEBUG` 守卫），不碰 PostgreSQL。
8. **seed 覆盖不全**：只种 11 个域，且**刻意留空** payments / payment_requests /
   completions / earnings / 三类事件表。

### P2 — 与全量切换无关，可后置

9. `favorites` 无 FK（闭包外引用以文本存）——按 PROD-1B §13c 既定策略，待最终闭包阶段补。
10. `companionRateBp` 用户端暂时可见（既有登记，上线前移除）。
11. 需求文档 §17 按比例冲回 vs P0-15 整笔冲回——文档漂移，仅登记。

---

## 八、⚠️ 审计勘误（本文档已按修正值书写）

**审计首版正文的 Executive Summary 曾写「Pg 实现约 54%（15/28 仓储有 Pg 实现）」。**

**该数字错误。** 正确口径：

```
有 Pg 实现的仓储 = B（14，仅测试引用）+ C（2，可切换）= 16
16 / 28 ≈ 57.1%
```

正文各处（§四）本来就是 `14 + 2 = 16`，**只有 Executive Summary 那一行算错**——
属于**统计口径串行**，不是事实分歧。**已在本文件按 `16 / 28 ≈ 57%` 书写。**

> **只修文档统计口径，不改业务代码。** 该勘误不改变任何结论：
> B/C 的划分、`0` 个 runtime 激活、`15/15` Pg 事务未接线，全部不变。

---

## 九、本次实跑的门禁证据

| 命令 | 结果 |
|---|---|
| `pnpm lint` | `eslint` 无输出 ⇒ **0 problems** |
| `pnpm typecheck` | `next typegen` ✓ + `tsc --noEmit` **exit 0** |
| `pnpm test:pg` | **170 / pass 170 / fail 0 / skipped 0**（pgConfig 17 · pgFoundation 27 · pgContract 23 · pgW1 66 · pgAdminAudit 37） |
| `pnpm test`（不起服务） | **2037 total / 1701 pass / 0 fail / 336 skipped** |

⚠️ **诚实边界**：本次**未跑** `pnpm build`，**未起服务**跑「生产 `APP_BASE_URL` 全量」那一档。
PROD-1C 文档声称的 `2037 / 0 fail / 0 skipped` 是**服务端在跑**时的数字，**本次未独立复现**；
跳过数 `336 = 2037 − 1701`，与文档自洽。

---

## 十、产品 / 架构裁定（本轮登记，**尚未执行**）

> ⚠️ 本节是**裁定记录**，不是交付。**未开始任何实现。**
> 相关实现只能在 §十 10.3 的双门槛满足后、按 Development Round Protocol 建立
> `PROD-1D` Round 目录后才允许开工。

### 10.1 T1 Coupon Closure 裁定

**背景**：§六 B 的审计发现——Pg `confirmPaymentRequest` 的订单 / 支付 / 派单写入走
PostgreSQL，但 coupon claim 核销仍通过 `buildOrder()` 回调写 Mock coupon store。

**正式裁定**：

> **coupon claim 的成功核销属于 T1 支付确认 / 建单事务的原子写闭包。**

**业务要求**：

```text
payment confirmed
+ order created
+ dispatch created
+ coupon claim consumed（如果使用优惠券）
```

必须**同事务成功 / 同事务失败**。

**禁止**：

- Order Pg + Coupon Mock
- 支付成功但券未核销
- 券核销成功但订单 rollback
- transaction commit 之后再 best-effort 核销 coupon

**实现约束**：未来 Pg T1 必须在**同一个** `withTransaction(tx)` 内完成 `coupon_claims` 状态修改。

**验证要求**：需补**真实 PostgreSQL** 的 contract / rollback / concurrency 测试，
且**必须包含 `coupon != null` 场景**（现有用例传的是 `coupon: null` + stub `buildOrder`，测不到）。

**优先级**：**PostgreSQL activation P0 blocker。**

### 10.2 下一轮规划

暂定：

> **`PROD-1D — Admin Write Closure A + T1 Coupon Closure`**

范围：

- T1 coupon claim Pg redemption closure
- `adminPlatformConfigTransaction`
- `adminComplaintTransaction`
- `couponTemplateTransaction`
- 对应 `AdminAudit` 原子写
- 对应**真实 Pg** concurrency / rollback / idempotency proof

**不要现在开始。**（见 10.3）

**范围依据（审计 §五/§七）**：这 3 个管理端事务的**表都已存在**
（`platform_config` / `complaints` / `coupon_templates`，见 `0008` / `0007`），
**不需要新 migration**；共 5 处 `writeAudit`；且 `complaints` / `platform_config`
在 `0008` 中已被明文登记为**订单事务的事务内读参与者**——把它们切到 Pg
恰好关闭「管理员改了参数 / 用户刚提交投诉，Mock 看得见、Pg 看不见」的跨库窗口。

**做完**：`writeAudit` 未迁数 **29 → 24**；管理端事务缺 Pg 实现数 **9 → 6**。
**做完仍不能 activation**——之后还剩 3 个业务闭包波次 + 1 个接线激活轮（详见审计正文）。

### 10.3 当前 Round Gate

> 当前确认：**`PROD-1C = AWAITING_ACCEPTANCE`**

在以下**两条 DONE 门槛**满足之前：

1. **PROD-1C Manual Acceptance = PASSED**（产品负责人明确「人工验收通过」）
2. **用户本人 Git commit**

**禁止开始 `PROD-1D`。**

（依据：`docs/03-dev/development-workflow.md` §十七 —— `DONE` 的双门槛；
以及本仓「所有正式业务开发批次必须创建对应 `docs/03-dev/rounds/<ROUND_ID>/`」的纪律。）

---

## 十一、本次审计的边界（本文件不主张的事）

- **不主张**任何业务规则变更：本轮**零业务代码改动**。
- **不主张** `DATA_SOURCE=postgres` 可用：结论是 **NO**，理由见 §六 / §七。
- **不主张**能激活：§十 10.1 的裁定**尚未实现**，§七 的 P0 一条未动。
- **不代替** PROD-1C 的人工验收：`AWAITING_ACCEPTANCE` 的判定权在产品负责人。
- §六 B 的发现**只是登记**：修复范围取决于 §十 10.1 的裁定如何落到实现，本轮不做。
