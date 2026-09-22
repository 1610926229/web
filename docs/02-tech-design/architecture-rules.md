# 架构规则（Architecture Rules）

> 本文件是 `docs/02-tech-design/` 的最高级别规范。
>
> **它描述的是当前仓库已经形成的、可被源码验证的架构，不是教科书 Clean Architecture 的理想形态。**
> 每一条规则的存在理由都是「不这样做就会出错」，不是「这样更优雅」。
>
> 若某条规则与源码冲突，以源码为准，并立刻修正本文件——文档失真比没有文档更危险。

> **2026-09-23 需求重校准说明**：`docs/01-requirements/` V0.3 已改变若干 P0 规则。本文必须继续区分 **CURRENT 源码事实** 与 **TARGET — NOT IMPLEMENTED**：旧代码仍按 P0-5.5 时的状态机运行，但新目标已经改为支持 `accepted → paid` / `serving → paid` 回池、未服务直接退款、完成材料 10 分钟默认自动审核（可配置 + snapshot）、封禁回池、客服直接换人。**不得把 TARGET 写成已经实现。**

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

**CURRENT（P0-5.5 已实现，源码尚未按 2026-09-23 新需求整改）**：`lib/constants/orders.ts:83` 的 `ORDER_TRANSITIONS` + 派生 `canTransitionOrder`（`:100`）仍是当前源码事实。`Order` 已有声明式状态机，但**表内容属于旧需求基线**，不能再写成“最终不得改动”。

**TARGET — NOT IMPLEMENTED（2026-09-23 已确认）**：主 `OrderStatus` 仍只保留五个值，但结构允许关系调整为：

```text
paid      -> accepted | refunded
accepted  -> paid | serving | refunded
serving   -> paid | completed | refunded
completed -> refunded
refunded  -> []
```

结构迁移的领域含义：

- `accepted → paid`：当前实际打手在尚未开始服务时主动取消；必须提交原因、记录最小退出历史、通知用户、当前 P0 不处罚，然后重新进入 public Dispatch。
- `serving → paid`：当前实际打手被 `enabled=false` / 封禁，或未来客服按已确认售后规则执行换人时，解除当前履约并重新进入 public Dispatch；若存在该打手的 pending CompletionSubmission，必须先作废其自动审核资格。
- `paid/accepted → refunded`：用户未开始服务直接全额退款；`accepted` 情况打手收益为 0、不生成 Earning、通知打手，终态退款保留 `actualCompanionId` 历史事实。
- `serving → completed`：可以由客服人工审核通过，**也可以**由 System 在 pending 到 `autoApprovalDeadlineAt`、仍未人工处理且无投诉/有效售后阻塞时自动通过。
- `completed → refunded`：仍只能通过合法投诉 / 售后 / 退款流程进入。

**⚠️ 状态机表永远只表达“结构上允许”**，不能替代动作级 Guard。回池、退款、自动审核、封禁与客服换人都必须各自校验权限、资源归属、当前状态、deadline、幂等和跨实体一致性。

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

## 5.3 TARGET（NOT IMPLEMENTED）—— 生命周期 deadline 统一使用“配置 + snapshot + 同一 domain service”

**这是硬约束，不是建议。** 2026-09-23 后，P0 至少存在四类 deadline：

| 生命周期 | 配置/来源 | snapshot 时点 |
|---|---|---|
| public Dispatch timeout | `PlatformConfig.publicPoolTimeoutMinutes`（CURRENT 已有） | 真正进入 public 时 |
| exclusive Dispatch timeout | TARGET：后台可配置 | 真正进入 exclusive 时 |
| CompletionSubmission 自动审核 | TARGET：后台可配置，默认 **10 分钟** | 每次 submission 进入 pending 时；驳回后重提重新计时 |
| completed 投诉窗口 | TARGET：后台可配置 | Order 真正进入 completed 时 |

已经冻结的 deadline **不被后续平台配置修改追溯改变**。

将来接入后台定时调度器时，调度器**必须**调用同一套同步、幂等、可重复调用的业务入口，例如：

```
sweepExpiredDispatches(now)          // CURRENT domain 入口
sweepCompletionAutoApprovals(now)    // TARGET
sweepMaturedEarnings(now)             // TARGET
```

自动完成审核必须再次检查 submission 仍为 `pending`、Order 仍为 `serving`、deadline 已到、无投诉/有效售后阻塞；客服人工审核、封禁回池等并发动作一旦先成功，后续 sweep 必须安全 no-op。

**严禁**在调度器里另写第二套超时退款、自动完成或收益释放逻辑。

（真实 Scheduler 仍是上线前阻塞项；当前 Mock 阶段允许惰性 sweep / 显式测试调用。）

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

> 2026-09-23 需求重排后，旧的 P0-6 / P0-7 / P0-8 编号不再作为未来开发顺序真值；**具体 Round 由 `docs/03-dev/总需求进度表.md` 与 Round Protocol 重新分配**。下表只描述已经确认的目标能力。

| 项 | 已确认目标 | 当前差距 |
|---|---|---|
| Order 结构状态机整改 | 新增 `accepted → paid`、`serving → paid`，并保留五状态主枚举 | P0-5.5 源码仍是旧转移表，需新 Round `NEEDS_FIX` |
| accepted 主动取消 | actualCompanion 可在未 serving 前提交原因取消；通知用户；当前不处罚；回 public；保留最小退出历史 | 未实现 |
| 未服务直接退款 | `paid/accepted` 用户直接全额退款；accepted 打手收益 0、通知打手、保留终态 `actualCompanionId` | 当前 `/refunds` 仍按旧人工申请链路，需要整改 |
| Companion 我的订单 | `/companion/orders` + `/companion/orders/[id]`，只允许 actualCompanion 查看 | 未实现 |
| 开始服务 | actualCompanion 显式 `accepted → serving`，不得由时间/备注/聊天自动触发 | 未实现 |
| CompletionSubmission | 截图 + 5~50 字；同一订单最多 1 个 pending；驳回可重提并重新计时 | 未实现 |
| 完成自动审核 | 默认 10 分钟、后台可配置；pending 时冻结 snapshot/deadline；无投诉/售后阻塞时 System 自动通过 | 未实现 |
| completed 投诉窗口 | 后台可配置；进入 completed 时冻结本单 deadline；Earning 解冻消费该 deadline | 未实现 |
| Companion 封禁联动 | accepted/serving 均解除当前履约并回 public；通知用户；旧 pending completion 作废 | 当前 Companion disable 尚未联动这些实体 |
| 客服直接换人 | 客服无需管理员批准；P0 不设次数上限；涉及退款资金仍由管理员最终决定 | 权限已确认，最小回池实现尚未落地 |
| 最小履约退出历史 | 不引入复杂 Assignment 聚合；只保留“订单、原打手、退出来源/原因、时间、操作者”满足追溯 | 未实现 |
| Earning / 结算域 | completed 后生成 frozen；到本单 complaint deadline 且无阻塞后 available | 未实现 |
| 后台 Scheduler | 必须复用同一 domain sweep 入口 | 不存在 |

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
| — | **自动罚款规则**仍未定义；但 2026-09-23 已确认 accepted 主动取消当前 P0 **不处罚**。管理员人工余额调整/会费批扣是后续独立资金能力，不等于自动罚款 | V0.3 |
| — | **用户封禁** | 全仓无对应实体 |
| — | **换人/改派的复杂 Assignment 最终结构**仍不做；P0 已确认采用最小可用方案：客服可直接换人、次数不限，并保留最小退出历史。复杂聚合/统一操作史仍 TBD | V0.3 |
| — | **真正的数据库选型（PostgreSQL / MySQL）与 ORM 选型（Prisma / Drizzle）** | **均未确认，禁止自行选定** |

## 7.3 P0-5.5 批次边界（**已确认**）

产品负责人已确认将单独安排一个很小的 **P0-5.5 订单生命周期架构收口**批次。

**只允许做这 6 件事**：

1. `ORDER_TRANSITIONS` + `canTransitionOrder`（这是 P0-5.5 当时的历史冻结内容；**2026-09-23 产品规则已 supersede 旧转移表，后续必须在新的需求整改 Round 中修改，不能回写篡改 P0-5.5 历史**）；
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
   当前清单**恰好两条**：`GET /api/companion/dispatches`、`POST /api/companion/dispatches/[id]/accept`；未来任何 Companion 订单/取消/开始服务接口真正落地时，必须同批扩充清单。
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
