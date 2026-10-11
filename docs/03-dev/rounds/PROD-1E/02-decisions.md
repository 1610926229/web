# 决策记录（PROD-1E）

> 本文件记录本轮**重新建立的当前真值**（§0）与本轮**真正做过取舍**的地方（D1 起）。
> 只有一处答案的事不写进来。

---

## 0｜Phase 0 —— 重新建立的当前真值（**全部现读代码，不引旧数字**）

HEAD = `d73ffa2 PROD-1D Admin write closure and T1 coupon closure`；`git status --short` 为空。

### 0.1 Repository migration matrix（28 个接口仓储）

| # | 域（接口文件 `lib/data/<X>Repository.ts`） | 已有 Pg 实现（HEAD） | accessor 是否查开关（HEAD） |
|---|---|---|---|
| 1 | `adminAudit` | ✅ | ❌ 硬返回 Mock |
| 2 | `admin` | ❌ **缺** | ❌ |
| 3 | `agreement` | ❌ **缺** | ❌ |
| 4 | `catalog` | ❌ **缺** | ❌ |
| 5 | `companionAccept` | ✅ | ❌ |
| 6 | `companionApplication` | ❌ **缺** | ❌ |
| 7 | `companionRelease` | ✅ | ❌ |
| 8 | `companion` | ✅ | ❌ |
| 9 | `companionService` | ✅ | ❌ |
| 10 | `complaint` | ✅ | ❌ |
| 11 | `completion` | ✅ | ❌ |
| 12 | `content` | ❌ **缺** | ❌ |
| 13 | `coupon` | ✅ | ❌ |
| 14 | `dispatch` | ✅ | ❌ |
| 15 | `earning` | ✅ | ❌ |
| 16 | `favorite` | ✅ | ✅ **有** |
| 17 | `level` | ❌ **缺** | ❌ |
| 18 | `message` | ❌ **缺** | ❌ |
| 19 | `notification` | ✅ | ❌ |
| 20 | `payment` | ✅ | ❌ |
| 21 | `platformConfig` | ✅ | ❌ |
| 22 | `qualification` | ❌ **缺** | ❌ |
| 23 | `refund` | ✅ | ❌ |
| 24 | `review` | ❌ **缺** | ❌ |
| 25 | `staff` | ❌ **缺** | ❌ |
| 26 | `suggestion` | ✅ | ✅ **有** |
| 27 | `tip` | ❌ **缺** | ❌ |
| 28 | `user` | ❌ **缺** | ❌ |

**合计：Pg 实现已有 16 / 28，缺 12 / 28；accessor 真正切过开关的只有 2（favorite、suggestion）。**

### 0.2 Transaction matrix

Mock 事务文件共 17 个（`lib/data/*Transaction.ts`，不含 `lib/data/pg/**`）。
「Pg 对应」指 HEAD 上是否已存在等价的事务入口。

| Mock 事务文件 | 公开函数数 | Pg 对应（HEAD） |
|---|---|---|
| `adminAgreementTransaction` | 2 | ❌ **无** |
| `adminCatalogTransaction` | 8 | ❌ **无** |
| `adminCompanionTransaction` | 6 | ⚠️ **部分**（仅 `setCompanionFlagsPg`） |
| `adminComplaintTransaction` | 1（+2 判定辅助） | ✅ `pg/complaintTransactions.ts` |
| `adminContentTransaction` | 12 | ❌ **无** |
| `adminPlatformConfigTransaction` | 1 | ✅ `pg/platformConfigTransactions.ts` |
| `adminRefundTransaction` | 3 | ✅ `pg/adminAuditTransactions.ts` |
| `adminReviewTransaction` | 1 | ❌ **无** |
| `adminStaffTransaction` | 4 | ❌ **无** |
| `checkoutCommitTransaction` | 1 | ✅ `pg/w1Transactions.ts` |
| `companionDispatchTransaction` | 4 | ✅ `pg/w1Transactions.ts` |
| `companionOrderTransaction` | 5 | ✅ `pg/w1Transactions.ts`（5/5） |
| `completionTransaction` | 6 | ✅ `pg/w1Transactions.ts` |
| `couponRedemptionTransaction` | 2 | ✅ `pg/w1Transactions.ts` |
| `couponTemplateTransaction` | 3 | ✅ `pg/couponTemplateTransactions.ts` |
| `directRefundTransaction` | 1 | ✅ `pg/w1Transactions.ts` |
| `earningTransaction` | 2 | ✅ `pg/w1Transactions.ts` |

**缺席的六个域全部是管理端写闭包：agreement(2) · catalog(8) · companion(5) · content(12) · review(1) · staff(4)。**

### 0.3 writeAudit matrix（`writeAudit(` 调用点）

| 文件 | 调用点数 | Pg 原子实现（HEAD） |
|---|---|---|
| `adminCatalogTransaction.ts` | 8 | ❌ |
| `adminCompanionTransaction.ts` | 6 | ⚠️ 1/6（T8 `setCompanionFlags`） |
| `adminStaffTransaction.ts` | 4 | ❌ |
| `adminContentTransaction.ts` | 4 | ❌ |
| `couponTemplateTransaction.ts` | 3 | ✅ |
| `adminRefundTransaction.ts` | 3 | ✅ |
| `adminAgreementTransaction.ts` | 2 | ❌ |
| `adminReviewTransaction.ts` | 1 | ❌ |
| `adminPlatformConfigTransaction.ts` | 1 | ✅ |
| `adminComplaintTransaction.ts` | 1 | ✅ |
| **合计（调用点）** | **33** | **已 Pg 9 / 33** |

另有 `adminWriteSupport.ts` 里 1 处是 `writeAudit` 的**定义**，不计入调用点。

**剩余 = 24 处 / 6 个文件**（catalog 8 · companion 5 · staff 4 · content 4 · agreement 2 · review 1）。
与 PROD-1D 交付时的数字一致——本轮的目标是把它清零。

### 0.4 Schema matrix

**HEAD 已有 20 张业务表**（migration `0001`–`0009`）：
`favorites` · `suggestions` · `companions` · `orders` / `payment_requests` / `payments` ·
`dispatch_records` / `completion_submissions` / `companion_accept_events` /
`companion_release_records` / `companion_service_events` ·
`refund_requests` / `earnings` / `earning_adjustments` / `notifications` ·
`coupon_templates` / `coupon_claims` · `complaints` / `platform_config` ·
`admin_audit_entries`。

**本轮新增 7 个 migration（`0010`–`0016`）/ 19 张表**（逐表设计与理由写在各文件头）：

| migration | 表 |
|---|---|
| `0010_identity_and_accounts` | `users` · `admin_accounts` · `staff_accounts` |
| `0011_catalog` | `games` · `categories` · `products` · `product_specs` |
| `0012_operations_content` | `announcements` · `banners` · `quick_entries` · `agreements` |
| `0013_companion_onboarding` | `companion_applications` · `user_qualifications` |
| `0014_member_benefits` | `consumption_levels` · `tip_records` |
| `0015_reviews` | `order_reviews` |
| `0016_conversations` | `conversations` · `messages` · `staff_reads` |

`0001`–`0009` **一字未动**。

### 0.5 Runtime datasource matrix（HEAD 行为）

| 入口 | HEAD 行为 |
|---|---|
| `getDataSource()`（`lib/data/source.ts:70`） | **无条件**返回 `mockDataSource`；不读任何环境变量 |
| 28 个 `get*Repository()` | 26 个**硬返回 Mock**；2 个（favorite / suggestion）按 `isPostgresDataSourceEnabled()` 选 |
| `isPostgresDataSourceEnabled()` | 读 `DATA_SOURCE === "postgres"`（`lib/data/pg/config.ts:59`） |
| 缺 Pg 实现时的行为 | **静默**——accessor 根本不看有没有 Pg 版本，返回值永远是 Mock ⇒ **无 fail-fast** |

---

## D1｜Phase 3 的边界：**只给新表建 FK，不回头改 0003–0009**

`0003_companions.sql:25`、`0007_coupon.sql`、`0008_transaction_reads.sql` 里有一批
「以稳定 ID 文本存储、暂不建 FK」的列（`companions.user_id` / `application_id`、
`platform_config.updated_by_admin_id`、`complaints.user_id` 等），理由是**被引用表本轮不迁**。

本轮把 `users` / `companion_applications` / `admin_accounts` 都迁过来了，**前提不成立了**。

### 裁定

**仍然不动它们。** 理由不是「懒得改」，而是：

- 给既有表加 FK 的成败取决于**已经写进库里的那些行**，而不是新表建了没有。
  它是一次独立的、需要逐表逐行验证的历史数据体检；
- 与本轮的目标（把**剩余 Mock 迁到 Pg**）是两件事，混进来会让「本轮新增了什么」说不清；
- 仓库已有明确先例：`0008` 就写了「闭包外引用：`admin_accounts` 本轮不迁，预置数据为 null」，
  说明这种「先文本、后补 FK」在本仓是被承认的中间态。

**新表的新外键照建**（`products → categories/games`、`product_specs → products`、
`conversations → orders`、`messages → conversations`、`staff_reads → orders`、
`order_reviews → orders`）——它们是**同一轮一起设计**的，预置数据一次写对即可。

**登记为「已登记、未执行」项**：旧表回补 FK（`companions.user_id`、`orders.user_id` 等），
见 `03-delivery.md` §6。

---

## D2｜启用「缺 Pg 实现就 fail-fast」的**单一收口**

指令 Phase 6 要求「任何核心 repository 缺 Pg 实现时，在启动或首次 datasource 构造时 fail-fast」。

### 问题

HEAD 的 accessor 是 **26 份各自硬编码 `return mockXxxRepository;`**。要让它们切库，
最省事的写法是每个都改成
`return isPostgresDataSourceEnabled() ? pgXxxRepository : mockXxxRepository;`——
但那样「有没有 Pg 实现」这件事**没有任何人负责检查**：漏写一个 accessor，
它在 `DATA_SOURCE=postgres` 下静默用 Mock，而所有页面看起来都正常。

### 裁定

**所有 accessor 收敛到一个选择函数**，并把「Pg 实现表」变成**一份可枚举的清单**：

```ts
// lib/data/datasource.ts
export type RepositoryBacking<T> = { name: string; mock: T; pg: T | null };
export function pickRepository<T>(backing: RepositoryBacking<T>): T {
  if (!isPostgresDataSourceEnabled()) return backing.mock;
  if (!backing.pg) throw new MissingPgImplementationError(backing.name); // fail-fast
  return backing.pg;
}
export function assertAllRepositoriesWired(backings: readonly RepositoryBacking<unknown>[]): void;
```

- 每个 accessor 导出一份 `xxxBacking`（`{ name, mock, pg }`），**`pg` 为 `null` 就是没有实现**；
- `lib/data/runtime.ts` import 全部 28 份 backing，`assertAllRepositoriesWired()` 在其中
  逐个检查「Pg 是否非 null」，**并检查清单条数 === 28**——少写一个 backing 会在这里被抓住；
- `getDataSource()` 首次调用时跑一次（memoized），覆盖 Server Component 路径；
- 单个 accessor 的 `pickRepository` 仍然是自己那一份的即时守卫（Route Handler 路径）。

### 代价

多两个文件（`datasource.ts` / `runtime.ts`）与 28 处 accessor 改写。
换来的是一条**结构上成立**的保证：清单里任何一项 `pg: null`，
在 `DATA_SOURCE=postgres` 下都会**立刻抛错**，而不是安静地回退 Mock（Phase 5 明令禁止的「静默 fallback」）。

---

## D3｜事务的运行期接线：**同一文件内路由**，不新开一层目录

### 问题

服务层是 `import { updateAgreement } from "@/lib/data/adminAgreementTransaction"`。
`DATA_SOURCE=postgres` 时它必须改走 Pg 事务，且**不能**出现
「Repository 走 Pg、Transaction 走 Mock」的半事务（Phase 7 明令禁止）。

### 裁定

**在既有事务文件里加一层薄路由**，不改服务层的 import 路径：

- Mock 实现体**原样保留**，改名为同文件内的 `xxxMock`（或移到同文件的 `mock` 命名区）；
- 文件只导出的那个公开函数变成：
  ```ts
  export async function updateAgreement(...args) {
    return isPostgresDataSourceEnabled()
      ? updateAgreementPg(...args)
      : updateAgreementMock(...args);
  }
  ```
- Pg 实现放在 `lib/data/pg/<域>Transactions.ts`（与 `complaintTransactions.ts` 同构）。

**为什么不新开 `lib/data/routing/` 目录**：那会让「这个域的事务到底怎么选」离它自己的语义
远了一整个目录，而现有的 `favoriteRepository.ts` / `suggestionRepository.ts` 已经把
「同文件内选实现」定成了本仓的既有做法（accessor 就是干这个的）。事务模块照搬它，是**一致**，不是发明。

**为什么不能只改服务层**：服务层有多处调用同一事务函数（`completionTransaction` 被 7 个服务引用），
逐个改调用点是 7 倍的改动面，且将来新增调用点会**忘记**——路由放在函数里，调用方无感。

### 代价

每个事务文件多一处 datasource 判断与一个 import。
换来的是「服务的每一个写入口都只有一条路径，且那条路径随 datasource 切换」。

---

## D4｜**不引入**新的运行时依赖（Phase 9 明文）

Chat/Message 只做**持久化迁移**，保持轮询 + HTTP：

- 不引入 websocket / SSE / Redis / MQ / 图片上传；
- 会话与消息的**冻结规则**一个字不改（按履约段分、A→B→A 不同会话、旧打手失去未来访问、
  历史分段只读、客服会话独立、全额退款只读），全部在服务层与常量里，**不进表结构**——
  落一个「只读」列，就得有人负责在退款那一刻把它翻过来，漏翻一次的表现是「全额退款后还能发言」。

---

## D5｜身份闭环的最小解释（Phase 8）

dev identity switcher **继续**作为鉴权机制（不改）。本轮只保证：
「身份所指向的用户 / 打手 / 管理员，其**持久化业务记录**来自 PostgreSQL」。

- 未接微信 OAuth **不阻塞** `users` 落库——`users` 表里放的是 `display_id` + 昵称 + 头像，
  与「凭据从哪来」无关；
- `admin_accounts` / `staff_accounts` **没有**密码/摘要/盐列（Mock 实体就没有，
  `docs/02-tech-design/database-schema.md:831` 明文），本轮也不加——
  「Mock 登录」是会话机制的问题，不是用户表的问题。

---

## D6｜「事务入口」与「同步原子原语」是两类东西：**后者不路由**

### 问题

`lib/data/` 里有一批**同步**函数，它们的正确性建立在「调用我的那段代码中间没有 `await`」上：

| 模块 | 同步原语 | 谁在同一段无 `await` 的区段里调它 |
|---|---|---|
| `checkoutCommitTransaction.ts` | `commitMockCheckoutParticipants` | `mockPaymentRepository.confirmPaymentRequest` 的原子区段 |
| `couponRedemptionTransaction.ts` | `redeemCouponClaimForOrder` / `restoreCouponClaimForOrder` | 结账、管理端退款、派单超时、直接退款四条伪事务 |
| `orderBlocking.ts` | `readOrderBlockingFacts` | 两个 `sweep*` 的原子区段 |
| `earningTransaction.ts` | `settleOrderCompletion` | `completionTransaction` 的 Mock 分支 |
| `companionDispatchTransaction.ts` | `createDispatchForOrder` | 结账伪事务 |

一个很自然的错误是「把它们也接上 Pg」——毕竟它们确实在读写数据。

### 裁定

**不路由。** 判据是「它是不是**外部可调用的写入口**」：

- 事务入口 = 服务层 import 的那个函数 → **路由**；
- 同步原子原语 = **只被别的伪事务调用**、且其语义就是「我是那段无 `await` 区段的一部分」→ **不路由**，
  它属于 Mock 半边；Pg 半边有各自的等价物（`w1Transactions` 的 `*Tx` 家族、
  `readOrderBlockingFacts(tx)`），由 Pg 事务在**同一个真事务**里调用。

「路由它」会造出最糟的组合：Mock 伪事务在无 `await` 区段里调一个会连库的异步函数——
原有原子性立刻消失，且**没有任何编译错误**。

### 代价

`lib/data/` 里于是同时存在「会连库的函数」与「只写 `globalThis` 的函数」，
区分它们的唯一标记是注释与「谁调用它」。本决策把这张表写下来，就是为了让这个区分有据可查。

---

## D7｜`sweep*` 入口由同步变异步 ⇒ **调用点必须 `await`**（这是顺序不变量，不是代码风格）

### 问题

三个惰性 sweep 在 HEAD 上是**同步**函数，服务层因此写成：

```ts
sweepExpiredDispatches(now);      // 没有 await——它当时不需要
const order = await getOrder(id); // 「先推进超时，再读订单」
```

Pg 实现必然是 `async`（它要连库）。把入口改成 `await getPgExecutor().withTransaction(...)`
之后，**不 `await` 的调用点会变成「发出了一个浮动 Promise，然后立刻去读订单」**——
读到的还是 sweep 之前的状态。这不是「少写一个 `await` 的 lint 问题」：
派单超时退款、完成材料超时自动通过、收益到期解冻这三条都靠「读之前先推进」保证读到的是当前真值。

### 裁定

1. 三个入口（`sweepExpiredDispatches` / `sweepCompletionAutoApprovals` / `sweepMaturedEarnings`）
   路由成 `async`，返回类型随之变成 `Promise<...>`；
2. **每一处调用点补 `await`**，包括**忽略返回值**的那些（这里要的是顺序，不是结果）；
3. 守卫这条不变量的测试写在交付里（见 `03-delivery.md` §4）。

### 代价

改动面从「只动 `lib/data/`」扩到「`lib/services/` 的若干处调用点」。
不这么做的替代方案（让 Pg 入口保持同步签名并返回 Promise）会把一个**竞态**伪装成
「函数签名没变」——那正是本仓最不能接受的失败形态：页面正常、数字是错的。

---

## D8｜**仓储不生成 id**：id 由调用方传入（沿用 Mock 与既有 Pg 仓储的取舍）

### 问题

Pg 的实现里判「这个 id 是否已存在」是**异步**的，而 Mock 用的是一个**同步**的
`nextRecordId(prefix, taken)`（读进程内 Map 就能算出下一个可用号）。

### 裁定

**不把 id 生成搬进仓储，也不改成「异步生成器」。** 三条路各自的事实：

- Mock 的 `nextRecordId` 本来就只是「造一个不撞的 id」，**不是业务规则**；
- Pg 侧改用 `<prefix>_${crypto.randomUUID()}`，把「撞 id」交给主键约束处理
  （撞了就是硬失败，而不是静默换一个号——后者会让「同一次提交两次」产生两个 id，
  而那正是幂等键要拦的东西）；
- 由此**调用方/事务层负责发 id**，仓储只管写。

这与 `pgCouponRepository` 已经采用的取舍**同一条**，不是本轮新发明。

### 代价

同一个实体在 Mock 下是 `c_1`、在 Pg 下是 `c_<uuid>`——**id 的形状不同**。
id 是不跨存储比较的（它是主键，不是业务键），因此这不构成业务漂移；
但任何「断言 id 等于某个具体值」的测试都只能断言**前缀与唯一性**，不能断言序号。

---

## D9｜Pg 侧的**确定性排序**归一化（登记，不修）

Mock 的列表读取沿用 `Map` 的插入序；Pg 侧一律显式 `ORDER BY <时间列> DESC, id`。

- 影响面：同一时刻写入的多条记录，返回顺序可能与 Mock 不同；
- 判定：**接受并登记**。Mock 的插入序是「进程内实现的副作用」，不是业务规则；
  而「分页必须完全确定」是本仓的明文要求（时间相同用 id 兜底），Pg 侧的写法**更符合**这条要求；
- 未观察到任何业务可观测差异（同一时刻落库多条、且调用方依赖其相对顺序的场景不存在）。

---

## D10｜已存在的 Pg 实现**第一次被接上线**时不重写

PROD-1B / 1C / 1D 已经把若干 Pg 事务写好并测试过，但它们**从来没有被运行期引用过**
（只有测试文件 import）。典型例子是 `setCompanionFlagsPg`：实现完整、有 8 条真库用例，
却 `grep` 不到任何调用方。

裁定：这一批**只补路由，实现一个字节不改**；路由函数直接委托既有 Pg 函数。
理由是「一个已经有真库用例保护的实现」比「为了接线路顺手重写的实现」更可信；
重写会把 PROD-1B/1C 的实证作废，而本轮的验收目标是**接线**，不是重做实现。

若接线过程中发现既有 Pg 实现与 Mock 的语义不一致：**上报，不自行修改**
（登记为 `SUSPECTED_PG_BUG`，进 `03-delivery.md` §6）。

---

## D11｜fail-fast 的**启动期**那一半落在 `instrumentation.ts`

### 问题

Phase 6 要求「`DATA_SOURCE=postgres` 时一个域都不许悄悄回落 Mock」，并且要在
**启动期或第一次构造数据源时** fail-fast。接线完成后，「第一次构造数据源」这一半
已经由 `getDataSource()` 里的 `assertRepositoriesReadyOnce()` 覆盖；**启动期**那一半
此前是空的。

### 裁定

新增根目录 `instrumentation.ts`，在 `register()` 里调用**同一个**
`assertRepositoriesReadyOnce()`（`lib/data/runtime.ts`）。

三条理由，按重要性排序：

1. **它是唯一能在「服务开始接请求之前」跑用户代码的位置**。`register()` 由 Next 在
   每个服务实例启动时调用一次，并且必须先完成服务才可用（见
   `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`）。
   放在布局里要等第一个页面渲染，放在路由里更晚——两者都已经先接受了请求。
2. **它把「编译期就能知道的事」与「运行期才知道的事」分开**。自检只看 28 个域的
   静态清单，**不连数据库**：连不上库是另一类故障，混在一起会让「服务起不来」
   有两种完全不同的原因。
3. **Mock 模式下它是空操作**：`assertRepositoriesReadyOnce()` 在 `DATA_SOURCE`
   不是 `postgres` 时直接返回。当前默认部署的启动行为与本次改动之前完全一致。

限定在 `process.env.NEXT_RUNTIME === "nodejs"` 下执行，并用动态 `import()`：
`lib/data/pg/**` 只能跑在 Node 里，非 Node runtime 下这个检查本来就没有意义。

### 代价与**没有**做到的事

`instrumentation.ts` 里那一次调用**没有**独立的回归测试去断言「它会抛」——
它住在框架的启动钩子里，`node --test` 够不到那个钩子。因此这里把「已验证的」
与「仍然只是推导的」分开写，不把后者说成前者。

**已实证（Phase 12 激活时做过，可复现）**：

| 场景 | 做法 | 观察到的结果 |
|---|---|---|
| 通过 | `DATA_SOURCE=postgres` + 测试库，`next start` | 启动日志出现 `[datasource] 启动自检通过：全部核心仓储都有 Pg 实现（DATA_SOURCE=postgres）`，且出现在**任何请求之前** |
| 失败 | 在 `register()` 顶部临时插一句 `throw`，`next dev` | 日志 `Error: An error occurred while loading instrumentation hook: …`，进程退出，`netstat` 显示端口**无人监听**，`curl` 无响应（探针已随后移除，仓库中无残留） |

失败那一行是本次裁剪的关键：它证明的是**「自检抛错 ⇒ 服务不接请求」这条链路真的成立**，
而不是「Next 的文档说它成立」。同时也可以看出一个细节——dev 启动器会先打
`✓ Ready in …ms` 再加载 instrumentation 钩子，因此**日志里出现 "Ready" 不等于服务可用**；
「端口无人监听 + curl 无响应」才是这条链路成立的判据。

**仍然只是推导的部分**：注入的 `throw` 与 `assertRepositoriesReadyOnce()` 抛出的
是同一个传播路径（同一个函数栈、同一个钩子），但**不是同一个异常**。真实缺实现时的
信息是 `assertAllRepositoriesWired` 里那条「以下 N 个仓储没有 Pg 实现：…」。
这个异常本身的语义由 `tests/datasourceActivation.test.mjs` 覆盖（含「一次报出**全部**
缺实现的域」）。两段拼起来是完整的，但**没有一条测试把两段连起来跑**——连接它们的
是一次人工探针。

---

## D12｜Phase 13 的「全业务真库 E2E」**不能复用**既有 24 个 HTTP 测试文件

### 问题

最省事的做法看起来是：把既有的 `tests/*.test.mjs` 那批 HTTP 用例直接指向一个
`DATA_SOURCE=postgres` 的服务端跑一遍。**做不到**，原因不是环境配置，是那批文件的写法：

- 它们在**测试进程内**直接调用 service / 事务函数，并在**测试进程内**断言 Mock 存储
  （例：`import { paymentStore } from "../lib/data/mockPaymentRepository.ts"`、
  `resetMockStore`、`getMockSeedNow`）。测试进程要么是 Mock 模式（于是「HTTP 打真库」
  与「进程内断言 Mock」互相矛盾），要么是 Pg 模式（于是那些直接读 Mock 存储的断言
  读到的是另一份数据）。
- 它们的隔离靠 `POST /api/debug/reset`（`tests/httpReset.mjs`），而该接口清的是
  **进程内 Mock 存储**；真库模式下它是空操作，于是「重置成功了」是假象，
  文件之间会互相污染。

### 裁定

Phase 13 用**一个新建的、纯 HTTP 的**文件交付，且**不**把既有文件改造成双模式。两条配套：

1. **隔离方式改为「测试进程直连测试库」**：`migrate`（幂等）→ `resetDatabase` →
   `seedDatabase`，全部由测试进程自己执行。`resetDatabase` 自带「库名不以 `_test`
   结尾就拒绝执行」的守卫，被视为安全网而非障碍。
   **不动 `POST /api/debug/reset`**：该文件自己的注释已经写明「换成真数据库时这个文件
   应当直接删除——真实测试应当用独立的测试库，而不是给线上服务开一个清库接口」。
   把它接到数据库上会正好违反这条。
2. **只走 HTTP**：新文件里不调用任何业务函数、不 import 任何 Mock 模块，业务动作全部
   通过 `fetch` 打服务端；断言取两条证据——HTTP 响应 + 直连 SQL 查库内形态
   （订单状态、整数分金额、券核销、收益记录、审计条数）。

### 代价

- 覆盖范围是**手写的一条主链 + 若干支链**，比那 177 条既有 HTTP 用例窄。因此
  Phase 15 的「生产全量」仍然是那批既有文件跑在 **Mock 模式**生产服务上——
  两者是**两类**证据，不是同一件事的两个副本，`03-delivery.md` 里要分开写。
- 「既有 HTTP 用例在 Pg 模式下也全绿」这件事，本轮**没有**证明，也不在验收口径里。

---

## D13｜真库 E2E 的地址读 `PG_E2E_BASE`，让「生产全量」能在**一次运行**里跑到 0 skipped

### 问题

D12 把真库 E2E 做成独立文件之后，Phase 15 的「生产全量、`0 skipped`」出现一个**新的**
两难：那 30 个 HTTP 契约文件要求 `APP_BASE_URL` 指向一个开 `ENABLE_MOCK_DEBUG` 的
**Mock 服务**（`resetServerStores()` 的 `/api/debug/reset` 在 pg 模式下是空操作），
而 `pgHttpE2E.test.mjs` 要求地址指向一个 `DATA_SOURCE=postgres` 的**真库服务**。
这是**两个不同的进程**，共用一个 `APP_BASE_URL` 变量时只能二选一：
选 Mock 服务，那 4 条真库用例原样跳过（全量 4 skipped）；选真库服务，那 30 个文件失去隔离。

### 裁定

给真库 E2E 单独一个可选地址变量，**缺省退回 `APP_BASE_URL`**：

```ts
const BASE = process.env["PG_E2E_BASE"] ?? process.env["APP_BASE_URL"] ?? "";
```

于是「一次运行跑完整个套件」成为可能：Mock 服务给那 30 个文件，真库服务给这 4 条用例，
两者同时在线、各打各自的进程。`02-decisions.md` D12 说的「两类证据」仍然成立——
变的只是它们可以在**同一个 `node --test` 调用**里各就各位，而不是分成两次。

### 代价

- **多了一个环境变量**。为了不恶化单文件场景，缺省值是 `APP_BASE_URL`：老的
  `PG_E2E=1 APP_BASE_URL=… pnpm test:pg` 写法继续可用。
- **新增一个误配的失败场景**：若有人只设 `APP_BASE_URL`（指向 Mock 服务）又开了 `PG_E2E=1`，
  真库断言会在 Mock 服务上跑、然后失败。这是**响亮地失败**而不是静默假绿——
  断言里的「直查 SQL 双证据」会立刻发现「HTTP 回了 200 但库里没有这一行」。
  这是这个取舍**可接受**的代价：它把 D12 原来那句「本轮没有证明」的两难，
  换成了一个「配错了就红」的显式前置。

