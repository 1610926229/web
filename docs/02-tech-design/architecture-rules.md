# 架构规则（Architecture Rules）

> 本文件是 `docs/02-tech-design/` 的最高级别规范。
>
> **它描述的是当前仓库已经形成的、可被源码验证的架构，不是教科书 Clean Architecture 的理想形态。**
> 每一条规则的存在理由都是「不这样做就会出错」，不是「这样更优雅」。
>
> 若某条规则与源码冲突，以源码为准，并立刻修正本文件——文档失真比没有文档更危险。

---

## 状态标签约定

本目录所有文档统一使用三种标签。**没有标签的陈述视为 CURRENT。**

| 标签 | 含义 | 读者必须知道 |
|---|---|---|
| **CURRENT** | 当前仓库已实现，可从源码验证 | 只能写真实代码事实。不许写「应该」「建议」 |
| **TARGET** | 产品或架构已明确确认，但代码尚未实现 | 一律标注 `NOT IMPLEMENTED`，不得让读者以为已经存在 |
| **TBD** | 没实现，且产品/架构规则也未最终确认 | 一律标注 `DO NOT INVENT`。碰到 TBD **必须先问产品负责人**，禁止按行业经验自行补齐 |

---

# 一、标准调用链

## 1.1 服务端渲染链路（CURRENT）

```
Page (app/**/page.tsx, Server Component)
  → Service (lib/services/*.ts)
    → Repository (lib/data/*Repository.ts)
      → Store (lib/data/mock*Repository.ts → lib/data/mockStore.ts → globalThis)
```

Server Component 直接 `await` 取数，**不通过 HTTP 请求本项目自身的 Route Handler**。
理由（`lib/data/source.ts` 顶部注释原文）：那会在构建期产生自请求、依赖部署地址，还多一次无意义的网络跳转。

**CURRENT 的一个例外**：一部分只读取数走 `lib/data/source.ts` 的 `DataSource` 门面，另一部分走 `getXxxRepository()`。
两条路都存在，见 §六「Observed Current」。

## 1.2 浏览器交互链路（CURRENT）

```
Component (components/**.tsx, "use client")
  → *Http.ts (lib/services/*Http.ts)
    → API Route (app/api/**/route.ts)
      → Service (lib/services/*.ts)   ← 与服务端链路共用同一批 service
        → Repository
          → Store
```

浏览器端唯一 HTTP 出口是 `lib/api/client.ts`（`apiGet` / `apiPost` / `apiPatch` / `apiDelete`）。
**页面与组件不得直接 `fetch`。** 换后端时只改 `lib/api/client.ts` 一处。

---

# 二、分层职责（CURRENT）

## 2.1 `app/` 与 `components/` —— 展示层

**必须**：

- 只负责渲染与交互。
- 服务端页面调 `lib/services/*`；客户端组件调 `lib/services/*Http.ts`。

**禁止**：

- ❌ **`app/` 与 `components/` 不得直接 import `lib/data`。**
  （CURRENT 的唯一实际破例见 §六 Observed Current。）
- ❌ 不得直接 `fetch`。
- ❌ 不得 import `lib/mocks/*`（种子数据不得进浏览器产物）。
- ❌ 不得做金额计算。

## 2.2 API Route（`app/api/**/route.ts`）—— 边界层

Route Handler **只做四件事**：

1. **auth guard** —— 第一步，且必须是第一步；
2. **参数解析** —— 读 query / body；
3. **调用 service**；
4. **response** —— 成功 `ok(data)`，失败 `fail(toApiError(e))`。

**禁止**：Route **不得承载主要业务规则**。
（CURRENT 唯一例外见 §六 Observed Current。）

## 2.3 Service（`lib/services/*.ts`）—— 业务编排层

**负责**：业务编排、DTO 裁剪、把仓储结果转成对外结构、抛出 `ApiError`。

**禁止**：不做数据访问（交给 Repository）。

**⚠️ 服务端与浏览器的同名文件必须分开。**
`lib/services/companionDispatch.ts` 顶部注释把理由写得很清楚：

> 本模块依赖 `lib/data` 与 `lib/mocks`，浏览器端取数走 `lib/services/companionHttp.ts`。
> 两者分开是必须的，否则 Mock 存储与种子数据会被打进浏览器产物。

## 2.4 Repository（`lib/data/*Repository.ts`）—— 数据访问层

**结构**（CURRENT，全仓 23 个仓储同一形态）：

```
lib/data/xxxRepository.ts      类型 + 接口 + getXxxRepository()（硬编码返回 mock 单例）
lib/data/mockXxxRepository.ts  唯一实现，通过 getMockStore 拿 store
```

**禁止**：仓储不判断业务合法性。

## 2.5 Transaction（`lib/data/*Transaction.ts`）—— 原子性跨实体写入

**负责**：需要原子性的**跨实体**写入。判定合法性 + 调用同步写原语 + 写审计 + 生成通知，全部在同一原子区段内。

**CURRENT 的全部事务文件**：

```
adminAgreementTransaction.ts   adminCatalogTransaction.ts     adminCompanionTransaction.ts
adminComplaintTransaction.ts   adminContentTransaction.ts     adminPlatformConfigTransaction.ts
adminRefundTransaction.ts      adminStaffTransaction.ts        companionDispatchTransaction.ts
adminWriteSupport.ts（公共支持，不是事务）
```

**⚠️ 伪事务惯用法（本仓库最重要的并发约束）**：

```
// —— 原子区段开始（无 await）——
   读 → 判断合法性 → 写
// —— 原子区段结束 ——
```

依据是 **Node 单线程 + 区段内无 `await` ⇒ 请求串行化**。
**区段内出现 `await` 就是 bug。** 这是代码评审的逐段必查项。

```ts
// ⚠️ 仅 Mock 阶段成立。换成真实数据库后**必然失效**——
// 届时每次查询都是 await，区段不再原子，必须改为数据库事务。
```

## 2.6 types / constants

| 层 | 可承载 | 禁止承载 |
|---|---|---|
| `lib/types/*.ts` | 纯类型声明 | ❌ **业务逻辑** |
| `lib/constants/*.ts` | ✅ 状态机表、校验、业务规则、固定文案、DTO 映射函数 | —— |

`lib/constants/` 承载状态机是**明确的设计**，不是偶然：`ADMIN_REFUND_TRANSITIONS`、`ADMIN_COMPLAINT_TRANSITIONS`、`ADMIN_APPLICATION_TRANSITIONS`、`ORDER_TRANSITIONS` 都是 `Record<Status, readonly Status[]>` + 派生 `canTransitionXxx` + `xxxAllowedActions`。

**CURRENT（P0-5.5 已实现）**：`lib/constants/orders.ts:83` 的 `ORDER_TRANSITIONS`（键集合由 `Record<OrderStatus, …>` 保证与 `ORDER_STATUSES` 的五个状态一一对应，终态写空数组）+ 派生 `canTransitionOrder`（`:100`）。
`Order` 至此不再是「全仓唯一没有声明式状态机的实体」。见 `database-schema.md` T3 与 §七。

**⚠️ 本轮只交付「中央定义」，不接入任何写入路径**：`applyOrderAccepted` / `applyOrderRefund` 的行为不变，也没有新增调用点。「用表替换 Guard」是明确错误的方向。

**⚠️ 状态机表的边界（已由产品负责人正式确认，2026-09-19）**：
状态机表**只表达「这种状态迁移在结构上是否允许」，它不能代替具体领域 Guard**。
`paid → accepted` 仍必须检查 Dispatch / deadline / 接单资格 / 并发；
`serving → completed` 仍必须满足完成材料已提交且客服审核通过；
`completed → refunded` **只能通过合法的投诉 / 售后 / 退款流程进入**——不得因为状态机允许就提供任意按钮。

---

# 三、金额规则（CURRENT，硬约束）

1. **金额一律整数「分」。** 全系统禁止浮点「元」金额。
2. **金额只在服务端计算。** `*Http.ts` 与 `components/` 不得做金额算术。
3. **金额公式必须复用既有 money domain**，即 `lib/constants/orderAmount.ts`：
   - `resolveCompanionBaseIncome` —— 唯一取整点（`Math.floor`）
   - `resolveClubNetIncome`
   - `resolveCompanionRevenueBase`
   - `resolveOrderMoneyDomain` —— 唯一合成点
4. **下单那一刻冻结快照**：`originalAmount` / `couponDiscountAmount` / `actualPaidAmount` / `companionRateSnapshot` / `companionBaseIncome` / `clubNetIncome` 全部写进订单。改商品配置不影响历史订单。
5. **恒等式必须永远成立**：`actualPaidAmount = companionBaseIncome + clubNetIncome`（允许 `clubNetIncome` 为负）。
6. **显示**：统一走 `lib/utils/format.ts` 的 `formatYuan` 与 `components/common/PriceText.tsx`。
   CURRENT 的唯一显示层 `/100` 在 `components/admin/AdminSpecEditor.tsx:42`，是纯展示。
7. **`refundedAmount` = 该订单累计实际已经退还给用户的金额**（已正式定义，2026-09-19）。
   当前只有全额退款，故 `refundedAmount === actualPaidAmount`；
   管理员批准退款时**必须**把 `actualPaidAmount` 写入 `refundedAmount`
   （P0-5.5 已落地：金额取自**订单字段**，不取退款申请上的 `amount` 快照）。
   未来部分退款上线后扩展为**累计**金额。
8. **⚠️ 部分退款不得自动把 `Order.status` 改成 `refunded`。**
   `status === "refunded"` 的正式含义是**该订单已经全额退款**。

> 资金公式的完整定义与验算表见 `docs/superpowers/plans/2026-09-17-order-lifecycle-alignment.md` §2.6。
> **该公式已正式冻结**，改动需产品负责人确认。

---

# 四、唯一真值源（CURRENT，硬约束）

## 4.1 一条业务事实只能有一个真值源

**已被明确执行的三条**：

| 业务事实 | 唯一真值源 | 谁不能自己再判一次 |
|---|---|---|
| 一个人是不是打手 | `resolveCompanionAccess()`（`lib/services/companionAccess.ts`） | `requireCompanion()` 不自己查仓储 |
| 打手当前能不能接新单 | `isCompanionAcceptingOrders()`（`lib/constants/companions.ts:215`） | 列表与原子接单区段用**同一个函数** |
| 商品 / 类目数据 | `catalogRepository`（唯一一份） | `source.ts` 不持有任何商品数据，全部转发 |

**为什么这条被反复强调**：两处判定的分叉不会以「报错」的样子出现，而是以「池子里空空如也」「界面上能选、数据里筛不出任何结果」这类**最难查的形态**出现。

**曾经的一处重复（已收敛，P0-5.5）**：`lib/services/checkout.ts` 一度内联了 `!isCompanionListed(companion) || !companion.available`——
与 `isCompanionAcceptingOrders` 语义等价但未复用，是同一规则的**第三份拷贝**（前两份是 `isCompanionAcceptingOrders` 自身与池子过滤那处）。
**整改结果**：`checkout.ts:143` 已改为复用 `isCompanionAcceptingOrders(companion)`；
对外文案、错误码与失败语义一字未变。

**⚠️ 收敛尚未走到「全仓只剩一处」**：`lib/constants/companions.ts:341` 的 DTO 投影
（`selectable: isCompanionListed(companion) && companion.available`）仍是同一规则的**第四份内联**，
同一文件 `:208` 的「谁该用它」清单也未把它列为使用点。
P0-5.5 **有意不收敛它**——那属于改动 Companion 模块，超出该轮冻结范围
（`isCompanionAcceptingOrders` 的 JSDoc 已把「结算页指定护航」列为使用点，与 §4.1 一致）。
**收敛它需要单独一批。**

**⚠️ 收敛时不得借机重构整个 Checkout / Companion 模块**（本轮确实没做）。

## 4.2 会话与身份

- **User / Companion 共用 User Session。** 「同一个人可以既是老板又是打手」这条产品决定，表现为**不需要任何身份切换**。
- **禁止第二套 Companion Auth。** 没有打手 Cookie、没有打手登录页、没有打手认证接口、没有打手会话开关。

**CURRENT 的四套身份**：

| 身份 | 会话模块 | 守卫 | 独立开关 |
|---|---|---|---|
| 用户 | `lib/auth/session.ts` | `requireUser()`（`lib/api/route.ts`） | `ENABLE_MOCK_AUTH` |
| 管理员 | `lib/auth/adminSession.ts` | `requireAdmin()`（`lib/api/adminRoute.ts`） | `ENABLE_MOCK_ADMIN` |
| 客服 | `lib/auth/staffSession.ts` | `requireStaff()`（`lib/api/staffRoute.ts`） | `ENABLE_MOCK_STAFF` |
| 打手 | **无**（复用用户会话） | `requireCompanion()`（`lib/api/companionRoute.ts`） | **无**（跟随用户开关） |

四个守卫**并列而不是复用**——这是刻意的。`lib/api/staffRoute.ts` 注释原文：

> 三者读的是不同的 Cookie、不同的仓储、不同的开关，混成一个 `requireUser({ staff: true })` 之类的参数化函数，迟早会出现「传错参数就当成客服放行」这种最难查的问题。

## 4.3 禁止重复创建并行业务系统

**全仓 grep 必须能确认**（每个批次收尾的不可协商检查项）：

- ❌ 没有第二套 Order Repository
- ❌ 没有第二套 Refund 系统
- ❌ 没有第二套 Notification 写入通道
- ❌ 没有第二套超时退款逻辑
- ❌ 没有第二套打手身份

---

# 五、时间与超时（CURRENT + TARGET）

## 5.1 CURRENT：时刻由调用方传入

`listCompanionPools(companionId, at)`、`sweepExpiredDispatches(at)` 等函数**不自己取 `new Date()`**。

**理由**（`lib/services/companionDispatch.ts` 注释原文）：一次读取里「清扫用什么时刻」与「剩余时间按什么时刻算」必须是同一个时刻，否则会出现「刚被清扫掉、剩余时间却还是正数」这种自相矛盾的显示。测试也因此能传入确定的时间。

⚠️ **但全仓仍有 53 处 `new Date()` 散落在 `lib/services` 与 `lib/data`**——传入 `at` 是**局部正确**，不是全局统一。

## 5.2 CURRENT：惰性物化

`deadline` 驱动的超时（派单转公共池、超时退款）目前**只在有人读取时被推进**，没有定时器。

## 5.3 TARGET（NOT IMPLEMENTED）—— 自动超时必须复用同一个 domain service

**这是硬约束，不是建议。**

将来接入后台定时调度器时，调度器**必须**调用**同一套**已经存在的同步、幂等、可重复调用的业务入口：

```
sweepExpiredDispatches(now)
sweepMaturedEarnings(now)     ← TARGET，随 P0-8 落地
```

**严禁**在调度器里另写一套超时退款逻辑——那会让两条路径的金额与状态判定迟早分叉。

（来源：计划 §九 TD-1。TD-1 是**真实支付上线前的阻塞项**。）

---

# 六、Observed Current 与 Normative Rule 的区分

**⚠️ 本节列出的全部内容都是「当前事实」，不是「未来必须遵守的规范」。**
未来新增代码**不得**以「仓库里已经这样了」为由模仿它们。

| # | Observed Current（当前事实） | 是否规范 | 说明 |
|---|---|---|---|
| 1 | **Order 方法位于 `PaymentRepository`**（`lib/data/paymentRepository.ts:61-142`） | ❌ **不是规范** | 不存在 `OrderRepository`。这是历史形成，**不表示 Order 必须永远属于 PaymentRepository** |
| 2 | `lib/services/adminHttp.ts` 1163 行 / 84 export，承载全部管理端浏览器客户端 | ❌ **不是规范** | 用户端拆成约 20 个 `*Http.ts`。**新接口不必须继续往这一个文件里塞** |
| 3 | `lib/data/source.ts` 的 `DataSource` 门面只覆盖 11 个读方法 | ❌ **不是规范** | 与 23 个 `getXxxRepository()` 并存，是**两个惯用法**。不要因为它存在就认为新增读取必须走它 |
| 4 | 三套会话模块（`session.ts` / `adminSession.ts` / `staffSession.ts`）近乎复制 | ❌ **不是规范** | 是 Mock 阶段的现状。**不表示第四种身份要再复制一套** |
| 5 | 18 个测试文件各有一份逐字节相同的 `stripComments` | ❌ **不是规范** | 重复，但只在测试内，不产生业务错误 |
| 6 | 400–600 行的表单组件与种子文件 | ❌ **不是规范** | 大文件本身不是问题，见 §八 |
| 7 | `lib/data/mockStore.ts` 的 23 个 store 名没有任何 schema 声明 | ❌ **不是规范** | Mock 阶段的现状 |

**判据**：一条规则只有在「不遵守就会产生业务错误」时才升级为规范。
「仓库里已经这样」不构成理由。

---

# 七、尚未形成的架构（TARGET / TBD）

## 7.1 TARGET — NOT IMPLEMENTED

| 项 | 来源 | 现状 | 落地批次 |
|---|---|---|---|
| `ORDER_TRANSITIONS` + `canTransitionOrder`（转移表**已确认**） | 本文件 §2.6 / `database-schema.md` T3 | **已实现**（此前不存在）：`lib/constants/orders.ts:83` / `:100`；表内容按冻结值，未接入任何写入路径 | **P0-5.5**（Round `P0-5.5` 已完成） |
| 管理员全额退款写入 `refundedAmount` | 产品裁定 2026-09-19 | **已实现**（此前 `adminRefundTransaction.ts` 省略第三参数，退款金额为 0）：现传 `order.actualPaidAmount`，见 `adminRefundTransaction.ts:247` | **P0-5.5**（Round `P0-5.5` 已完成） |
| Companion API 清单门禁（扫描 `app/api/companion/**`） | 产品裁定 2026-09-19 | 路由清单契约已冻结并逐项核对：该目录下恰好两个 `route.ts`（`GET` / `POST`，均以 `requireCompanion()` 为第一动作）；门禁测试写入 `tests/`（同批交付） | **P0-5.5**（Round `P0-5.5`） |
| Checkout 复用 `isCompanionAcceptingOrders` | 产品裁定 2026-09-19 | **已实现**（此前 `checkout.ts` 内联等价判定，是第三份拷贝）：改调 `isCompanionAcceptingOrders(companion)`，见 `checkout.ts:143` | **P0-5.5**（Round `P0-5.5` 已完成） |
| 打手订单列表 `/companion/orders`（进行中 / 已结束） | 产品裁定 2026-09-19 | 打手端目前只有 `pool` / `exclusive` | P0-6 |
| 打手订单详情 `/companion/orders/[id]` | 产品裁定 2026-09-19 | 不存在 | P0-6 |
| `POST /api/companion/orders/[id]/start`（`accepted → serving`） | 计划 P0-6 | 不存在 | P0-6 |
| `CompletionSubmission`（完成材料） | 计划 §2.3 | `lib/types/completion.ts` 不存在 | P0-7 |
| P0-7 **复用**同一订单详情页，serving 状态增加「提交完成材料」 | 产品裁定 2026-09-19 | —— | P0-7 |
| `Earning` / 结算域 | 计划 §2.4 | `lib/types/earning.ts` 与 `earningRepository` 均不存在 | P0-8 |
| 后台定时调度器 | 计划 TD-1 | 不存在 | TBD |
| 提现 | 计划 TD-4 | 不存在，且**本轮范围外** | 范围外 |

## 7.2 TBD — DO NOT INVENT

**碰到以下任何一项，必须先询问产品负责人，禁止按行业经验自行补齐：**

| # | 未确认项 | 来源 |
|---|---|---|
| R4 | **「服务异常」的定义**：谁触发、什么条件、如何进入售后区 | 计划 §8.2 |
| R5 | **「非普通投诉通道」**：需求文档暗示存在普通之外的通道 | 计划 §8.2 |
| R6 | **B/A/S 的 3/4/5 是固定还是管理员可配** | 计划 §8.2 |
| R7 | **打手侧是否需要统一「操作史」查询**（跨 Dispatch / CompletionSubmission / Earning） | 计划 §8.2 |
| R10 | **`Order.companion` 快照是否要同时保留指定打手** | 计划 §8.2 |
| — | **提现**：入口、审核、打款渠道、最小金额 | 计划 TD-4 |
| — | **罚款 / 扣款**：`Earning.fineAmount` 恒为 0，无任何扣款操作 | 计划 §2.4 |
| — | **用户封禁** | 全仓无对应实体 |
| — | **换人 / 改派（Replacement / Assignment）的最终结构** | 全仓无对应实体 |
| — | **真正的数据库选型（PostgreSQL / MySQL）与 ORM 选型（Prisma / Drizzle）** | **均未确认，禁止自行选定** |

## 7.3 P0-5.5 批次边界（**已确认**）

产品负责人已确认将单独安排一个很小的 **P0-5.5 订单生命周期架构收口**批次。

**只允许做这 6 件事**：

1. `ORDER_TRANSITIONS` + `canTransitionOrder`（见 §2.6 与 `database-schema.md` T3，**转移表已确认，不得改动内容**）；
2. 修复管理员全额退款的 `refundedAmount`（见 §三 第 7 条）；
3. Companion API 清单门禁（扫描 `app/api/companion/**`，沿用现有 tests 的源码扫描方式，**不新建测试框架**，文件名遵循现有命名风格）；
4. Checkout 复用统一的 Companion 接单资格规则（见 §4.1）；
5. 以上四项的对应测试；
6. 对应的技术设计文档同步。

**明确不属于 P0-5.5**（不要顺手做）：

- ❌ Notification 重构
- ❌ `adminHttp.ts` 拆分
- ❌ Session 重构
- ❌ 删除 `lib/data/source.ts`
- ❌ `OrderRepository` / `PaymentRepository` 重构
- ❌ 大文件拆分
- ❌ DI
- ❌ Event Bus
- ❌ 数据库
- ❌ ORM
- ❌ **P0-6 业务功能**

**⚠️ 边界依据**：上面「不属于」的清单与 §六 Observed Current 表、§八「什么不算问题」是同一套判断——
**这些都不是债务，只是现状。**

---

# 八、什么不算问题（避免过度设计）

以下都是**当前阶段的正确选择**，不是债务。看到它们不要提议重构：

- **内存 Mock store、无 ORM、无真实数据库**——Mock 阶段的正确形态，且开关集中在 `lib/config/env.ts`。数据在 dev server 重启后丢失是**预期行为**。
- **单实现 Repository、无 DI 框架**——单实现就是不需要接口多态。
- **无 Redux / 无 Zustand / 无全局状态库 / 无事件总线**——没有需要它们的问题。
- **无测试框架**，用 Node 24 内置 `node --test`。
- **400–600 行的表单组件与种子文件**——文件大 ≠ 有问题。
- **伪事务而非数据库事务**——在 Node 单线程 + 无 `await` 前提下是**正确的**，且已被并发测试锁定。

---

# 九、开发前必读

开始业务开发前**必须**依次阅读：

```
docs/01-requirements/                                  ← 业务流程 / 权限 / 异常处理（权威需求）
docs/02-tech-design/architecture-rules.md              ← 本文件
docs/02-tech-design/tech-stack.md
docs/02-tech-design/directory-structure.md
docs/02-tech-design/api-contract.md
docs/02-tech-design/database-schema.md
```

若上述文档中出现 **TBD**：**禁止自行决定**，先问产品负责人。

---

# 十、批次收尾清单（CURRENT，不可协商）

每个开发批次结束时：

1. `pnpm test` + `pnpm typecheck` + `pnpm lint` **三者全绿**（必要时加 `pnpm build`）。
2. **原子区段审计**：任何新增的「读—判断—写」事务，区段内**不得出现 `await`**。逐段确认。
3. **无第二套实现**：按 §4.3 的五条 grep 确认。
4. **接口清单门禁**：涉及后台接口的批次必须同批扩充 `tests/admin.test.mjs`；涉及客服接口的扩充 `tests/staff.test.mjs`；涉及打手接口的扩充 `tests/companion.test.mjs`。
   ✅ **已建立**（产品裁定 2026-09-19，P0-5.5 落地）：与 Admin / Staff 同形的 Companion API route manifest / route gate，扫描 `app/api/companion/**` 并与预期清单比对——
   当前清单**恰好两条**：`GET /api/companion/dispatches`、`POST /api/companion/dispatches/[id]/accept`，P0-6 后加入对应订单接口。
   新增 / 删除 / 误改路径时测试**必须失败**。**沿用现有 tests 的源码扫描方式，不新建测试框架**。
   ⚠️ 打手接口的清单门禁在 `tests/companion.test.mjs`，**不是** `tests/companionAccess.test.mjs`（后者是「打手身份只有一套」的负向门禁，两者互补、互不替代）。
5. **同步技术设计文档**：见 §十一。

---

# 十一、文档更新规则

## 11.1 必须更新文档的情形

一个批次结束时，如果本批：

- 新增技术依赖 → 更新 `tech-stack.md`
- 新增目录惯例 → 更新 `directory-structure.md`
- 新增 API → 更新 `api-contract.md`
- 新增领域实体 → 更新 `database-schema.md`
- 改变数据关系 → 更新 `database-schema.md`
- 改变架构约束 → 更新 `architecture-rules.md`

## 11.2 不更新的情形

**不能因为每次小函数变化就更新架构文档。**

这些文档描述的是**稳定架构和业务边界**，不是源码逐行镜像。
判断标准：这次变化会不会改变**下一个开发者做决定的方式**？不会就不写。
