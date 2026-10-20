# P0-6 交付记录

- **Round ID**：`P0-6`
- **标题**：`accepted` 主动取消接单 + 重新进入公共池（含打手「我的订单」最小入口）
- **状态**：`DONE`
- **交付时间**：2026-09-23
- **基线提交**：`551c15a`（**交付时点**的基线；本轮改动的实现提交见下）
- **实现提交**：`53481ea`（**用户本人**提交）
- **主状态迁移**：`accepted → paid`

> ✅ **`P0-6 DONE — implementation committed in 53481ea`**
>
> 「DONE 的双重门槛」（Round Protocol §十七）两个条件均已满足：
> 用户本人说明人工验收通过（2026-09-24，`User Result` / `Final Result` = `PASSED`，
> 多角色链路全程未进管理端，见 `04-acceptance.md`）**且** 用户本人完成 Git 提交
> （`53481ea`）。提交前本轮未执行任何 Git 写操作。
>
> ⚠️ **本文件正文是交付时点的记录，不回溯改写**。验收后发现的 FIX-1 / FIX-2 两个整改项
> **不属于本轮冻结范围**、**不推翻本轮 `DONE`**，记在 `04-acceptance.md` 的 `Issues Found`
> 与 `../总需求进度表.md`，**不回写本文件的实现描述**。

---

## 1. Requirement Check 结果

**结论：无产品/架构冲突，未进入 `CLARIFYING`，无 `Status: OPEN` 的决策。**

本轮直接以 `docs/03-dev/rounds/P0-6/01-prompt.md`（= `cmd_p0-6.md` 原文逐字保存）为依据编码。裁决记录见同目录 `02-decisions.md`（D1–D10、观察 N1–N7）。

### 1.1 首次交付时曾记为「已知缺口」的一项（**已按用户裁定补齐**）

首次交付报告里，客服侧的取消历史可见性被记为一个「待用户裁定的缺口」——
理由是 `canEnterAdminConsole(role)` 只对 `role === "admin"` 为真（`lib/constants/admin.ts` 头部把「只有 admin 能进管理后台」写成了一条明确边界），客服进不了 `/admin/orders/[id]`；而客服的落点有「投诉详情 / 退款详情 / 新建客服订单页」三个都说得通。

**用户在人工验收阶段明确裁定这不是待确认项**：客服可查看打手 accepted 后主动取消记录是最新需求**已经冻结**的要求，P0-6 必须补齐客服可见性后才能进入人工验收；且「落点是哪个页面」属于**技术组织**，不该拿去问产品。

因此本轮已补齐（见 §9、§11.4），并把 `02-decisions.md` 的 D6 记为
`Decision V2 (SUPERSEDED)` → `Decision V3 (CURRENT)`。**这是本轮唯一一次决策反转**，其余判断未变。

---

## 2. 实际修改文件

### 2.1 新增（15 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/types/companionRelease.ts` | 72 | `CompanionReleaseRecord` / `CompanionReleaseSource` |
| `lib/data/companionReleaseRepository.ts` | 36 | 退出历史仓储接口 |
| `lib/data/mockCompanionReleaseRepository.ts` | 157 | Mock 实现 + `globalThis` store + 幂等键索引 |
| `lib/data/companionOrderTransaction.ts` | 272 | **伪事务**：写退出历史 → 清履约绑定 → 派单回池 → 通知 |
| `lib/services/companionOrders.ts` | 198 | 列表 / 详情 / 取消的**唯一**服务端入口 + DTO 收窄 |
| `app/api/companion/orders/route.ts` | 31 | `GET` 我的订单 |
| `app/api/companion/orders/[id]/route.ts` | 42 | `GET` 订单详情 |
| `app/api/companion/orders/[id]/cancel/route.ts` | 52 | `POST` 主动取消接单 |
| `app/companion/(console)/orders/page.tsx` | 57 | 「我的订单」列表页 |
| `app/companion/(console)/orders/[id]/page.tsx` | 229 | 订单详情页（含取消面板） |
| `app/companion/(console)/orders/[id]/not-found.tsx` | 43 | 404 页（「不存在」与「不是你的」共用同一页同一句） |
| `components/companion/CompanionOrderList.tsx` | 46 | 纯展示列表 |
| `components/companion/CompanionOrderCard.tsx` | 74 | 纯展示卡片（**刻意不渲染 `canCancel`**） |
| `components/companion/CompanionOrderCancelPanel.tsx` | 194 | 客户端取消面板 |
| `tests/companionOrders.test.mjs` | 1013 | 本轮新增测试（20 条） |

### 2.2 修改（22 个已跟踪文件，`+814 / −104`）

```
app/admin/(console)/orders/[id]/page.tsx         ← 渲染 releaseHistory
components/companion/CompanionDispatchCard.tsx   ← 仅注释（见 §2.3）
lib/constants/adminOrders.ts                     ← AdminOrderDetailExtras 加 releaseHistory
lib/constants/companionConsole.ts                ← 导航加「我的订单」
lib/constants/dispatch.ts                        ← 通知/文案/来源标签常量
lib/constants/orders.ts                          ← ORDER_TRANSITIONS 改为目标结构
lib/data/mockDispatchRepository.ts               ← applyDispatchToPublic 补清接单绑定
lib/data/mockPaymentRepository.ts                ← applyOrderAcceptanceReleased + queryOrdersByCompanion
lib/data/mockStore.ts                            ← 注册新 store
lib/data/paymentRepository.ts                    ← 加 queryOrdersByCompanion（见 §11.3）
lib/services/adminOrders.ts                      ← 并行查询里加入 releaseHistory
lib/services/companionHttp.ts                    ← cancelCompanionOrderRequest
lib/types/order.ts                               ← +154 行：CompanionCancelOutcome / DTO 类型
tests/companion.test.mjs                         ← 清单 2 → 5、负向门禁重写
tests/companionAccess.test.mjs                   ← 调用点清单 3 → 5
tests/orders.test.mjs                            ← +2 条用例
docs/02-tech-design/{api-contract,architecture-rules,database-schema,directory-structure}.md
docs/03-dev/rounds/README.md
docs/03-dev/总需求进度表.md
```

### 2.3 注释漂移修正（不在 Prompt 显式范围内，属一致性）

`components/companion/CompanionDispatchCard.tsx` 的注释原文写着「接单是**不可逆**的：接下之后不能自行退回、不能换人」。这条规则本轮已被改掉，留着会让读代码的人以为下面那段确认逻辑的代价算错了。已改为「接单之后不能一键反悔：要退出得在开始服务前提交原因取消接单」。

**行为核对**：该文件的运行时分支只有 `!canAccept` / `done` / `confirming` / `pending` 四种，文件内没有任何按订单状态隐藏或禁用入口的逻辑（`disabled` 只用于双击防重）。全仓扫描「不可逆 / 不能自行退回 / 不能换人」，剩余命中全是「说明该规则已被改掉」的注释，以及两个与派单无关的组件（`WithdrawApplicationButton` / `RefundCancelButton` 里各自成立的「撤销不可逆」）。

### 2.4 修复批次（用户验收阶段要求补齐客服可见性）

⚠️ 上一版 §2.1–2.3 描述的是**首次交付**。用户验收时裁定「客服查看取消历史」不是待确认项、必须补齐，下面是该批次的文件清单。

**新增（1 个）**

| 文件 | 职责 |
|---|---|
| `components/staff/StaffReleaseHistory.tsx` | 客服侧只读展示组件（无 `"use client"`、不取数、无按钮；空数组返回 `null`） |

**修改（8 个）**

| 文件 | 变化 |
|---|---|
| `lib/types/staff.ts` | 新增 `StaffCompanionReleaseEntry`；`StaffOrderSummary` 加 `releaseHistory` |
| `lib/types/complaint.ts` | `StaffComplaintOrderSummary` 加 `releaseHistory` |
| `lib/types/refund.ts` | `StaffRefundDetail` 加 `releaseHistory` |
| `lib/constants/staff.ts` | 新增唯一转换点 `toStaffCompanionReleaseEntry()`；新增 6 条文案常量；`toStaffOrderSummary` 加第三个必填参数 |
| `lib/constants/staffComplaints.ts` | `StaffComplaintOrderInput` 加 `releaseHistory`，构造器透传（**理由见 §11.5**） |
| `lib/constants/staffRefunds.ts` | `toStaffRefundDetail` 加第五个参数并透传（**理由见 §11.5**） |
| `lib/services/staffConversations.ts` · `staffComplaints.ts` · `staffRefunds.ts` | 各新增私有 `releaseHistoryFor(orderId)`；组装 DTO 时传入（**重复理由见 §11.4**） |
| `app/staff/(console)/conversations/[orderId]/page.tsx` · `complaints/[id]/page.tsx` · `refunds/[id]/page.tsx` | 各挂一个 `<StaffReleaseHistory>` |
| `app/admin/(console)/orders/[id]/page.tsx` | **仅注释**：两处已成假话的断言改正（**见 §15.6**），渲染行为一行未动 |

**没有动**：`app/api/**` 一行未新增（客服侧零新接口）；`lib/types/companionRelease.ts`（`CompanionReleaseRecord` 仍是冻结的 7 字段）；`lib/data/**`；用户端与打手端任何 DTO。

---

## 3. 新增的数据结构

### 3.1 `CompanionReleaseRecord`（`lib/types/companionRelease.ts`）

```ts
type CompanionReleaseSource = "companion_cancel" | "companion_disabled" | "staff_reassign";

type CompanionReleaseRecord = {
  id: string;
  orderId: string;
  companionId: string;
  source: CompanionReleaseSource;
  reason: string | null;
  actorId: string | null;
  createdAt: string;
};
```

本轮**只会**写入 `source: "companion_cancel"`。另两个 source 是 TARGET：类型与文案标签已备好，但**没有任何写入路径**，`01-prompt.md` §十四 明确不做封禁回池与客服换人。

> 设计取舍：`reason` / `actorId` 可空，是为了让「封禁」（无原因、actor 是管理员）与「客服换人」（actor 是客服）将来能复用同一条记录而不必改类型；本轮两个字段都有值。

### 3.2 打手端 DTO（`lib/types/order.ts`）

- `CompanionOrderListItem` —— 13 个字段；
- `CompanionOrderDetail` —— 21 个字段（列表项 + 服务与金额所需）；
- `CompanionOrderListData` = `{ items }`；
- `CompanionCancelOutcome` —— 四态：`ok` / `replayed` / `not-found` / `not-accepted`。

**两个 DTO 都是显式挑字段**，绝不复用 `OrderDetail`（带平台金额域与售后摘要）或 `AdminOrderDetail`（带用户指定的人、退款与投诉摘要）。给 `Order` 新增字段不会自动流到打手端响应里。

`CompanionOrderDetail` 含 `gameAccountId` 与 `remark`：这两项是**履约所必需**的，没有它们打不了这一单。除此之外没有联系方式、平台展示 ID、头像、金额域与售后摘要。

---

## 4. 新增 / 修改 API

| 方法 | 路径 | Guard | 服务 |
|---|---|---|---|
| `GET` | `/api/companion/orders` | `requireCompanion` | `listCompanionOrders` |
| `GET` | `/api/companion/orders/[id]` | `requireCompanion` | `getCompanionOrderDetail` |
| `POST` | `/api/companion/orders/[id]/cancel` | `requireCompanion` | `cancelCompanionOrder` |

三条都是**首个动作即 `requireCompanion()`**：未登录 401；登录了但名下无有效护航资料、或资料已下架 403。

`companionId` **只来自会话**，接口不读请求体、不读查询参数（`GET` 连参数都不接），因此「查别人的订单」在结构上不可能。

**业务失败的取舍与接单接口不同**：

- 非本人实际履约 → **404**（含订单不存在；两者对外表现必须完全相同，否则可用别人的订单 id 试探存在性）；
- 是本人的单但状态已不是 `accepted` → **400**（把 `serving` / `completed` / `refunded` 拉回 `paid` 是绝对错误的）；
- 同一幂等键第二次到达 → **200** + 第一次的结果（`kind: "replayed"`），不当作错误。

打手端接口清单在 `tests/companion.test.mjs` 中由 **2 条扩至 5 条**；负向门禁改为 `/companion/orders/[id]/start`（不得入清单、磁盘上不得存在、`orders/[id]` 下只允许 `cancel` 一个 `POST` 写入口，按「导出 `POST` 的文件集合」判定，因此改名成 `begin` / `serve` 也绕不过去）。

---

## 5. Order / Dispatch 状态变化

### 5.1 `ORDER_TRANSITIONS`（`lib/constants/orders.ts`）

改为 2026-09-23 目标结构：

```ts
paid:      ["accepted", "refunded"]
accepted:  ["paid", "serving", "refunded"]
serving:   ["paid", "completed", "refunded"]
completed: ["refunded"]
refunded:  []
```

**本轮真正新增可执行的迁移只有 `accepted → paid`。**

`serving → paid` 只进结构表、**不提供任何入口**：状态机允许不等于有人能走。它留给后续的封禁回池 / 合法换人 Round。`01-prompt.md` §五 原话即「不得因为状态机允许就新增对应 API」。

`canTransitionOrder()` 仍然**只表达结构许可，不代替领域 Guard**。取消接单的合法性判定在伪事务的原子区段里独立再做一次（本人 + 状态恰为 `accepted`），不依赖状态表放行。

### 5.2 取消时订单与派单的字段变化

| 对象 | 字段 | 变化 |
|---|---|---|
| `Order` | `status` | `accepted` → `paid` |
| `Order` | `acceptedAt` | → `null` |
| `Order` | `actualCompanionId` | → `null` |
| `Order` | `companion` | → `null` |
| `DispatchRecord` | `state` | → `public` |
| `DispatchRecord` | `publicPoolEnteredAt` | 重记为**此刻** |
| `DispatchRecord` | `publicDeadlineAt` | **按此刻配置重新冻结** |
| `DispatchRecord` | `publicTimeoutMinutesSnapshot` | **按此刻配置重新冻结** |
| `DispatchRecord` | `acceptedByCompanionId` / `acceptedAt` | → `null`（D3 补上） |
| `DispatchRecord` | `exclusiveCompanionId` / `exclusiveEnteredAt` / `exclusiveDeadlineAt` | **一个都不清**（历史事实） |

**为什么 `acceptedAt` 与 `companion` 也必须清**（不只清 `actualCompanionId`）：

1. `applyOrderAccepted` 一次写这四个字段，取消只回退一部分会留下永远对不齐的不变量；
2. `database-schema.md` 把 `actualCompanionId` 与 `companion` 归在「履约人」同一组；Prompt §2.3 说的是「当前**履约绑定**必须解除」——绑定指的就是这一组；
3. **不清会直接渲染出自相矛盾的界面**：`lib/services/orders.ts` 的 `TIMELINE_SOURCE` 把 `acceptedAt` 直接变成用户可见的时间轴节点（只判「时间戳非 null」），残留的 `acceptedAt` 会让一张已回到 `paid` 的订单在用户端显示「已接单」；而 `toOrderListItem()` 输出 `order.companion`，残留快照会让订单列表挂着一个并不在履约的打手。

**`applyDispatchToPublic` 的补充清理对既有路径是 no-op**：此前唯一调用点是专属池超时清扫，那条路径上从来没人接过单，两个字段本来就是 `null`，漏清看不见——一旦被取消接单复用，漏清就是 `state === "public"` 却留着 `acceptedByCompanionId` 这种自相矛盾。补上之后，这个写入器的契约才真正等于它名字的字面意思：**回到公共池 = 现在没人接**。

**订单会自动重新出现在公共池**，这不需要新代码：`lib/services/companionDispatch.ts` 的池子循环条件是 `order.status !== "paid"`，取消后订单恰好回到 `paid`；派单 `state === "public"` 且截止时间在未来，`toDispatchProgress` 非空，因此别的打手立刻可以从公共池接走。

---

## 6. `CompanionReleaseRecord` 行为

- **每次成功取消恰好写一条**；同一单被取消两次产生两条历史（按时间正序，旧记录不被覆盖）；
- 记录里保存**原因原文**（调用方 trim 后的值）与**触发者**（本轮恒为打手本人，`actorId = companionId`）；
- **不处罚**：本轮不写罚款、不扣信用分、不改任何金额字段（`01-prompt.md` §十四）；
- **管理端可见**：`getAdminOrderDetail` 的并行查询里加入 `listReleasesByOrderId`，空数组即「无退出记录」；
- **用户端不可见**：`releaseHistory` **不在**任何用户端 DTO 里（由测试钉住）；
- **客服端不可见**：见 §1 的缺口说明。

> ⚠️ 记录**不保存**「取消后这一单被谁接走了」：那是下一轮的退出历史，由下一条记录回答。

---

## 7. 通知行为

- **一条**，且只有成功取消的那一次写；重放（`replayed`）**不写第二条**；
- 收件人是**下单用户**（`order.userId`），不是打手；
- `kind: "dispatch"`，复用全站既有通知通道，不新开一类；
- `href` 只带订单 id（`/orders/<id>`），不带任何说明或理由——通知是只读展示，要看细节进订单详情页，那里会重新校验归属；
- 文案：`DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED`

  > **护航已取消接单**
  > 你的订单已重新进入公共订单池
  > 接单的护航在开始服务前取消了这一单，订单已重新进入公共订单池，等待其他护航接取。订单不会被取消，金额也不变。

  ⚠️ 正文末句在集成阶段被 Coordinator 修正过一次：原稿写「订单金额与**状态**均不受影响」，但用户订单的状态恰恰变了（已接单 → 等待接单），用户看完订单页会觉得自相矛盾。改为「订单不会被取消，金额也不变」——两句都只陈述真正没变的事实。

- **通知在原子区段之外构造并校验完**（含 id），区段内只做不会失败的 append。这是本仓既有的「先验证意图，再原子写入事实」裁决：文案格式错误、`href` 带查询串这类问题必须在订单已经回到 `paid` 之前抛出来。

---

## 8. 打手「我的订单」页面

| 路由 | 类型 | 说明 |
|---|---|---|
| `/companion/orders` | 动态 | 标题 + 说明 + 列表；空态「你还没有接过订单」 |
| `/companion/orders/[id]` | 动态 | 详情 + 取消面板；取不到一律 `notFound()` |
| `/companion/orders/[id]/not-found.tsx` | — | 「不存在」与「不是你的」共用同一页同一句 |

- 导航位置：`/companion 工作台` → **`/companion/orders 我的订单`** → 专属池 → 公共池。顺序理由是「我是谁 → 我手上的单 → 我还能接什么」：已接的单必须处理，池子是可选的。
- **列表卡片上没有金额，也没有取消按钮**：DTO 上没有金额；`canCancel` 会过期，按钮只长在详情页。
- 详情页按服务端给出的 `detail.canCancel` 布尔量分支，页面自身**不含任何状态判断**；`canCancel` 为假时渲染明确的不允许提示，而不是无按钮的空白。
- 三个页面都走 `resolveCompanionAccess`（`React.cache` 包装，与 `layout` 共享同一次读取）；调用点清单随之从 3 处变 5 处，由 `tests/companionAccess.test.mjs` 钉住。
- **取消成功后刻意不调 `router.refresh()`**：取消之后服务端再查这一单会 404，refresh 会把页面刷成「订单不存在」，让刚点完取消的人以为自己把单弄丢了。
- 幂等键 `crypto.randomUUID()` 在点开取消表单那一刻生成一次，同一业务意图内（改原因重试、双击）复用；点「再想想」时清空。
- 原因只校验 **trim 后非空**，输入框**没有 `maxLength`、占位文字没有任何字数提示**——需求只冻结了「非空」，Prompt 明确禁止发明 5~50 / 10~200 这类长度规则。

---

## 9. 管理端 / 客服端取消历史展示

- **管理端（已实现）**：`/admin/orders/[id]` 在「护航」与「状态时间轴」之间插入 `ReleaseHistorySection`，渲染护航标识 / 动作 / 时间 / 原因。空数组显示「无退出记录」。**该页仍然只读**：没有新增任何按钮、没有引入客户端组件。
- **管理端的两块信息不矛盾**：取消后「护航」区显示「还没有人接单」，而「履约退出历史」区记着之前是谁——一个回答「现在是谁」，一个回答「之前是谁」。
- **客服端（已实现，P0-6 修复批次）**：**没有新增任何 Staff 接口**——退出历史搭在客服已经在用的三个只读详情接口上，通过扩充它们的 DTO 下发：
  - `GET /api/staff/conversations/[orderId]` → `StaffConversationDetail.order.releaseHistory`
  - `GET /api/staff/complaints/[id]` → `StaffComplaintDetail.orderSummary.releaseHistory`
  - `GET /api/staff/refunds/[id]` → `StaffRefundDetail.releaseHistory`
- **为什么是三个 DTO 而不是只挂会话页**：会话页确实已渲染完整订单摘要，但**投诉详情与退款详情的「进入会话」入口在订单没有沟通记录时是 `null`**（`conversationOrderId === null`），只挂会话页会让这两类工单看不到。而用户的要求是「客服在处理与某订单有关的**投诉 / 退款 / 会话**时都可以查看」，所以三处各自承载。
- **渲染**：`components/staff/StaffReleaseHistory.tsx`（**无 `"use client"`、不取数、无按钮**）挂在上述三个页面；排版件复用管理端同一套 `Section` / `DetailRow` / `FieldBlock`。
- **一处刻意的不对称**：管理端空数组显示「无退出记录」，客服端**空数组时整段不渲染**。客服这三页是作业面，占位句会出现在每一张正常订单上、久了就被当装饰；审计面要的则是「查过了，没有」这个明确结论。两边看起来像，**不要顺手统一**（理由写在组件头部注释里）。

---

## 10. 并发与幂等

### 10.1 原子性

`cancelAcceptedOrder` 是 `async` 但函数体**没有一个 `await`**，因此整个函数体就是一段原子区段（Node 单线程，「读—判断—写」之间不让出执行权，别的请求就插不进来）。与 `companionDispatchTransaction.ts` 同一条依据。

⚠️ **在标注的边界之后加一个 `await` 就是 bug**，哪怕加的是 `await Promise.resolve()`：「订单已回到 `paid`、派单还在 `accepted`」的那一瞬会被别的请求读到。由测试以结构约束钉住（该文件不含 `await`，且回池写入只有 `cancelAcceptedOrder` 一个出口）。

一次取消必须**同段**成立四件事，少任何一件都会留下自相矛盾的状态：

| 缺哪件 | 留下的矛盾 |
|---|---|
| 退出历史 | 客服再也答不出「刚才那个人为什么走了」 |
| 订单履约绑定解除 | 订单没主了但派单还说被 A 接了 |
| 派单回公共池 | 派单空着但订单还挂在 A 名下 |
| 通知用户 | 用户以为还有人给他做 |

订单与派单**必须同段写**：中间让出执行权就会出现「订单说等待接单、派单说被 A 接了」。

### 10.2 幂等

用的是 `api-contract.md` §2.8 的**第一种机制：幂等键索引**，落在退出历史 store 自己的 `releaseIdByKey` 上，与 `adminWriteSupport` 的管理操作审计表无关（那套配的是**管理操作**，取消接单不是管理行为，往里写会让审计表变成一本什么都记的流水）。

- 键格式复用全站现有格式（`lib/constants/writes.ts`，`/^[A-Za-z0-9_-]{8,64}$/`），不发明第二种；
- 作用域是 `${companionId}:${idempotencyKey}`——键属于打手，别人拿同一个键重放不到我的取消；
- 命中即返回第一次的结果，**一个字节都不写**：不新增记录、不重复通知、不刷新任何 deadline；
- 键被**误用到别的单上**时不返回那条记录（否则会把别人订单的状态当成这次请求的结果，用户会看到一张自己没操作过的单号）；
- 键与记录**一起存在**：`appendCompanionRelease` 后紧跟 `bindCompanionReleaseKey`，顺序反了会留下一个指向不存在记录的键。

⚠️ **索引只是让「同一打手连点两次」的第二次返回第一次的结果**（而不是一个令用户困惑的 404）；真正的安全边界仍然是**状态与归属**——键是调用方给的一个串，而 `order.actualCompanionId === companionId` 与 `order.status === "accepted"` 是**事实**。

### 10.3 判定顺序（先验证意图，再原子写入事实）

1. 查幂等索引（命中即返回，不进写入区段）；
2. 取订单，判归属（不存在 / 不是本人 → 一律 `not-found`）；
3. 判状态（不是 `accepted` → `not-accepted`）；
4. 找派单记录（订单说有人在履约却查不到派单 → **宁可整件事失败**，否则那张单会既不在任何池子里、也没人能再接）；
5. **区段之外**读一次平台配置、构造并校验通知（含 id）；
6. 进入原子区段，四件事一次写完。

公共池超时读的是**当下**的配置：用户与后来接单的打手被承诺的是「重新进池那一刻的规则」。用启动时的旧值或硬编码一个时长，都是第二套 timeout 算法。

### 10.4 已知的取舍：新键打已取消的单 → 404

对一张**已经取消过**的单，换一个**新**幂等键再取消，得到 `not-found`（404）而不是 `not-accepted`（400）。原因：取消动作已把 `actualCompanionId` 清空，此时「不是本人履约」与「订单不存在」在数据上已经无法区分——而这正是 §2.9 要求的：不泄露存在性。判定顺序「归属先于状态」是由此推出的结论，并有测试钉住。

---

## 11. 明确的实现取舍（记入交付报告备查）

### 11.1 `planNotification` 在两个伪事务里各留一份

`companionOrderTransaction.ts` 与 `companionDispatchTransaction.ts` 各有一份形状相同的 `planNotification`。作者在注释里论证了这是**刻意**的：两处的收件人与文案都由各自的调用点决定，合并成一个带参数的公共函数就等于让「这条通知发给谁」变成调用方可声明的——而通知的归属只能由订单决定。它只有十几行且不含任何业务判断，重复的代价小于这个参数化的风险。

**记入此处的理由**：若后续出现第三处，就该重新评估是否抽公共模块。本轮不动（不在本轮文件清单内）。

### 11.2 `queryOrdersByCompanion` 加在 `PaymentRepository` 上

`directory-structure.md` §8.1 禁止**重构** PaymentRepository，不禁止扩展。加一个只读查询方法是扩展：方法与 `listOrdersByUser` 并列，复用同一个 Map，不改变既有方法。归属是**查询条件**而不是事后过滤，这正是 §8.1 与 D7 的要求。

### 11.3 打手端页面复用现有公共组件

`EmptyState`、`PriceText` 直接复用，没有新写空态、没有新写金额格式化；组件里没有 `fetch`（走 `lib/api/client.ts` 的 `apiPost`）；未 import 任何 `lib/data/**`。

### 11.4 修复批次：`releaseHistoryFor` 在三个客服服务里各留一份

三个客服服务（`staffConversations.ts` / `staffComplaints.ts` / `staffRefunds.ts`）各有一个约 14 行的**私有**同名小助手：查退出历史 → 按 `companionId` 去重 → `findCompanionById` 解展示名 → 交给共用构造器。

**为什么不抽公共模块**：`lib/services/` 下**没有任何跨 service import 的先例**，而「同名私有小助手在相关服务里各写一份」正是本仓库既有做法——`missingUser()` 在 5 个文件里各一份、`staffUserIndex()` 在 2 个文件里各一份（`lib/services/staffComplaints.ts:68,76` 与 `staffRefunds.ts:77,104`）。**转换规则本身（含名字回落）仍然只有一个出处**：`lib/constants/staff.ts` 的 `toStaffCompanionReleaseEntry`。重复的是「怎么取数」这一层机械步骤，不是业务判断。

**记入此处的理由**：与 §11.1 同一个尺度——若后续出现第四处，就该重新评估是否抽模块。本轮按用户「最小实现、不扩大范围」的要求不动。

### 11.5 修复批次：动了两个本不在独占清单里的常量文件

`lib/constants/staffComplaints.ts` 与 `lib/constants/staffRefunds.ts` 被修改，用于给 `StaffComplaintOrderInput` / `toStaffComplaintOrderSummary` / `toStaffRefundDetail` 加上 `releaseHistory` 的透传参数。

**这对 DTO 的构造器本来就在这两份文件里**，不扩展它们就编译不过。替代方案（在服务层用 `{...detail, ...}` 事后覆写）会造出**第二种装配风格**，与仓库既有惯例（`toAdminOrderDetail(order, user, extras)` 正是「构造器组装、服务层取数」）冲突，因此选择了扩展构造器。

---

## 12. 未实现内容（明确列表）

按 `01-prompt.md` §十四 未越界，以下**全部未实现**：

- 开始服务（`accepted → serving`）与 `POST /api/companion/orders/[id]/start`；
- 完成材料提交 `CompletionSubmission` 与自动审核；
- 收益结算 / 分账显示 / 打手端任何金额或收益字段；
- 罚款与信用分（本轮取消**只记录、不处罚**）；
- 客服改派（`staff_reassign`）；
- Companion 封禁回池（`companion_disabled`）——`serving → paid` 因此没有入口；
- 打手端聊天入口；
- 打手登录体系；
- 未实现 `serving` 的普通主动取消；未因状态机放行而新增任何 API；未绕过任何领域 Guard。

> ⚠️ 上一版这里还列着「**客服侧查看取消历史的入口**（§九 未兑现的一半）」。该项**已按用户裁定补齐**（§1.1 / §9），
> 不再是未实现内容。除此之外本列表**未变**——修复批次没有顺手扩大范围。

---

## 13. 测试新增数量

| 文件 | 变化 |
|---|---|
| `tests/companionOrders.test.mjs` | **新增文件，20 条**（18 条领域 + 2 条 HTTP） |
| `tests/orders.test.mjs` | 32 → **34**（+2：回池边冻结在首位；P0-6 未触及的三行不得被顺手改动） |
| `tests/companion.test.mjs` | 用例数 7 → 7，但**断言被扩充**：清单 2 → 5、负向门禁改为 `start` |
| `tests/companionAccess.test.mjs` | 用例数 13 → 13，但**清单被扩充**：调用点 3 → 5 |

**首次交付合计新增用例 22 条**（1077 − 1055）。

### 13.1 修复批次新增（客服可见性）

| 文件 | 变化 |
|---|---|
| `tests/staffReleaseHistory.test.mjs` | **新增文件，14 条** |
| `tests/companionOrders.test.mjs` | 20 → 20，但原「缺口」用例**被改写成正向断言**（见下） |
| `tests/staff.test.mjs` | 补 `toStaffOrderSummary` 第三参数；新增 1 条 HTTP |
| `tests/staffComplaints.test.mjs` | 新增 1 条 HTTP |
| `tests/staffRefunds.test.mjs` | 新增 1 条 HTTP |

**合计 1094 条**（1077 + 17）。

其中 2 条是复审之后补的（`03-delivery.md` §15.7 的 M4 与 N1）：
「字段清单本身被钉死」与「非 `companion_cancel` 的 source 也照原样透出」。

**关于那条被改写的用例**：`tests/companionOrders.test.mjs` 里原先有一条名为
「缺口：客服端目前没有查看取消历史的入口——§十一.23 的 Staff 那一半尚未兑现」的用例，
它断言的是「客服端**尚无**入口」。**修复后它如预期变红**——这正是它当初被写成那样的目的
（`02-decisions.md` D6 V2 的原文就写着「将来有人补上客服入口时它会变红，逼着那一轮更新断言」）。
已按「**更新它，不是删掉它**」改写为正向断言：客服仍进不了 `/admin`、`app/api/staff/**`
仍无 `orders` 段（本轮**未新增任何 Staff 接口**）、`app/staff/**` 渲染 `releaseHistory` 的页面
`deepEqual` 恰好是那三个具体路径、管理端那一处也仍在。

---

## 14. 门禁结果（全部实跑）

> ⚠️ 下表是**修复批次之后的最终结果**（由 Coordinator 亲自复跑，非 Sub-Agent 自报）。
> 首次交付时的数字为 1077 / 964 / 113，已被本节取代。

| 门禁 | 结果 |
|---|---|
| `pnpm test` | **1094 tests / 978 pass / 0 fail / 116 skipped** |
| `APP_BASE_URL` 全量 HTTP | **1094 tests / 1094 pass / 0 fail / 0 skipped** |
| `pnpm typecheck` | 通过（`next typegen && tsc --noEmit`，退出码 0） |
| `pnpm lint` | 通过（`eslint`，退出码 0，无 error / 无 warning） |
| `pnpm build` | 通过（退出码 0）；`/companion/orders` 与 `/companion/orders/[id]` 均为 `ƒ`（动态） |

HTTP 环境：`pnpm build` → `pnpm start -p 3213`（**用新端口**，起服前先 `netstat` 确认
3210 / 3211 / 3212 / 3213 / 3000 全部空闲，避免测到上一轮的残留进程），跑完后
`taskkill //PID 29396 //T //F` 停服并**复查 `netstat` 确认端口 3213 已无 LISTENING 残留**。

116 条 skipped 是「未设置 `APP_BASE_URL` 时按设计跳过」的 HTTP 用例；设了之后为 **0 skipped**，
即 116 条全部真实执行。这与用户要求的 `fail = 0` / `skipped = 0` 一致。

---

## 15. Reviewer 结论

`reviewer-agent` 只读评审，对照 `01-prompt.md` §十三 的 13 项、并行技术设计与本轮裁决记录。

### 15.1 总体判定：**可以交付验收**

> 13 个受审问题**全部为「通过」**，未发现 BLOCKER 或 MAJOR。
> 取消接单的四件事在同一段无 await 的同步代码里完成，归属与状态判定也在同一段里重判一次；
> 前端只控制可见性、不构成保护。

| 档位 | 数量 |
|---|---|
| BLOCKER | **0** |
| MAJOR | **0** |
| MINOR | 2（均已修复，见 15.2） |
| NOTE | 3（NOTE-1 已修、NOTE-2 记录为有意取舍、**NOTE-3 经复核为误判并已推翻**，见 15.3） |

§十三 只要求「BLOCKER / MAJOR 必须修复后重新跑相关测试」。本轮无 BLOCKER / MAJOR，
两处 MINOR 仍已修复并**重跑全部四道门禁 + 全量 HTTP**。

> ⚠️ **本节是首次交付的结论。** 用户打回、补齐客服侧之后**又做过一次完整复审**，
> 结论同样是 0 BLOCKER / 0 MAJOR（4 MINOR + 6 NOTE，全部已处置），见 **§15.7**。
> §14 的门禁数字已被那次复审之后的最终复跑取代。

### 15.2 两处 MINOR（已修复）

**MINOR-1：守卫检查的是索引，不是派单记录本身。**

`cancelAcceptedOrder` 用 `dispatchIdByOrder.get(order.id)` 找派单，但「索引里有 id」不证明
「`dispatches` 里真有这条记录」。若出现「索引在、记录丢」的悬空状态，`if (!dispatchId)` 拦不住，
随后 `applyDispatchToPublic` 在记录缺失时**静默返回 `null`**，留下「订单已回 `paid`、派单记录却不存在」
——这张单既不在任何池子里、也没人能再接，正是该处注释声称要避免的后果。注释承诺了，代码没做到。

可达性低（全仓没有任何路径删除 `dispatches` 里的记录），但**同文件 `createDispatchRecord:85-91`
对同一状态已有显式防御**，两处不一致本身就该对齐。

**修法**：改为同时确认记录存在——`if (!dispatchId || !dispatches.dispatches.has(dispatchId))`，
并在注释里写明为什么不能只查索引。未新增第二套索引。

**MINOR-2：重放分支返回的 `status` 是硬编码 `"paid"`。**

Reviewer 的顾虑成立：A 取消成功（键 K）→ 订单回 `paid` → B 接走（订单变 `accepted`）→
A 用同一个键 K 重放，接口仍回答 `status: "paid"`，与订单真实状态矛盾。

**但修法不是去读实时状态**：`api-contract.md` §2.8 要求重放返回与第一次**完全相同**的响应，
读实时状态会让同一个请求在两次到达时给出不同答案，**那才是幂等被破坏**。
`CompanionCancelOutcome` 里该字段本来就声明为字面量 `"paid"`，类型已经钉住了它的含义，
缺的只是**把含义写出来**。

**修法**：在 `lib/types/order.ts` 的 `CompanionCancelOutcome` 上补语义说明——
`status` 是「这次取消把订单置成了什么状态」（本次操作的结果），**不是**「订单此刻的状态」；
并显式说明该重放场景不是 bug、消费方要看现状请查详情接口。
同时点明唯一例外：`not-accepted` 带的是**当前**状态（在 `order.status` 处现取），
因为那正是「你点了一个此刻不该存在的按钮」要回答的东西。

### 15.3 三条 NOTE

**NOTE-1（已处理）：`planNotification` 的重复理由与代码不符。**
原注释称两份副本「刻意各留一份」是为了让「这条通知发给谁」不能由调用方声明——
可本副本的签名恰恰以 `userId` 为参数，收件人**本来就是**由调用点决定的，论证自相矛盾。
结论（重复属刻意且无害）reviewer 认同，只是论证站不住。
**修法**：把理由改写为真正的动机——函数只有十几行、不含业务判断、两处的 `kind` 与文案各自独立，
而合并成公共模块就得为「将来第三种通知」预留参数与分支，那笔复杂度比重复两份纯函数更贵。

**NOTE-2（记录为已知取舍，不改行为）：取消成功后，页面标题下的状态区仍显示「已接单」。**
成功态只替换了取消面板那一段，上方的状态区仍按服务端首屏数据渲染旧状态，
于是同一屏会同时出现「状态：已接单」与「取消成功」。

**这是有意的取舍，不是缺陷**：备选方案是 `router.refresh()`，而取消之后服务端再查这一单会 404，
refresh 会把页面刷成「订单不存在」——让刚点完取消的人以为自己把单弄丢了，那是**更差**的结果。
组件头部注释已论证过这一点。若要打磨，可在成功文案里补一句「本页状态为进入本页时的快照」。
**已列入 `04-acceptance.md` 的 D 组**，让验收人知道这是预期行为而不是 bug。

**NOTE-3（❌ 评审结论有误，已由 Coordinator 推翻并复核）：`app/api/companion/**` 的接口清单门禁
并非不存在——它存在，且已完整覆盖本轮新增的三条路由。**

原 NOTE 声称「`app/api/companion/**` 尚无清单门禁，属 P0-5.5 遗留」「路由被改名或删掉时可能没有任何
测试失败」。**这两句都不成立**，复核证据如下（`tests/companion.test.mjs`）：

| 断言 | 位置 | 覆盖了什么 |
|---|---|---|
| `collectFiles(COMPANION_API_DIR)` 筛 `route.ts` → 与清单 `deepEqual` | `:210-217` | **扫描磁盘**，新增 / 改名 / 删除路由文件**都会红** |
| 清单恰好 5 条 + 无重复地址 + 守卫非空 | `:187-206` | 清单写坏了会让下面断言变假绿 |
| 每条路由**导出**的方法与清单一致 | `:219-230` | 多导出 / 少导出 `POST` 会红 |
| 守卫必须是 `requireCompanion` 且**来自** `@/lib/api/companionRoute` | `:249-300` | 只钉名字不够，防第二套宽松守卫 |
| 守卫必须排在读参数 / 请求体 / 调服务层**之前**（比较位置前先剥 import） | `:279-298` | 防「import 了守卫却不用、上来就 `request.json()`」 |
| 不得混入 `requireUser` / `requireAdmin` / `requireStaff` / `getSessionUser` / `getSessionAdmin` | `:302-315` | 防开第二条进工作台的路 |
| `orders/[id]` 下导出 `POST` 的只能有一个，且必须是 `cancel` | `:338-364` | 按**行为性质**判定，改名成 `begin`/`serve` 也绕不过 |

该文件头部第 9 行写明「（P0-5.5 建立）」，清单第 82-84 行的分组注释写明「P0-6：打手「我的订单」三件套」——
所以 §2 的「清单门禁由 2 条扩至 5 条」是**正确的**，与本 NOTE 原先的说法并不冲突，冲突来自本 NOTE 本身。

**误判的可能来源**：评审把「静态清单门禁」（永远运行）与「401/403 **HTTP** 权限矩阵」
（在 `tests/companionOrders.test.mjs`，受 `APP_BASE_URL` 门控、无服务时被 skip）混为一谈。
后者才是真正的暴露面——但它只是权限矩阵，不是清单门禁。

**据用户指令：不为这条错误 NOTE 另造第二套测试**，只订正文档。本轮**未新增任何测试**来「补」这个不存在的缺口。

### 15.4 复审确认的两条既有判定

- `planNotification` 的刻意重复（§11.1）：**无功能问题**，两份实现不共享状态、不产生第二真值源。
- `queryOrdersByCompanion` 加在 `PaymentRepository` 上（§11.2）：**在界内**，
  与已有订单读写方法同族，未新开第二仓储、未引入新的真值源。

### 15.5 Reviewer 明确声明无法判断的部分

- §14 自报的门禁数字未由 reviewer 独立复跑（超出只读工具边界），需 Coordinator 在验收环境自行验证——**已由本记录 §14 实跑**；
- `04-acceptance.md` 的验收标准是否符合本轮口径，属 Coordinator 与产品职责。

> ⚠️ 本节是**首次交付**时的 reviewer 结论。其中「客服侧入口是否应在后续 Round 补齐」一问
> **已被用户裁定**（属本轮范围，须补齐），见 §1.1。修复批次的复审结论记在 §15.6 之后。

### 15.6 修复批次新增的一条 NOTE（管理端与客服侧的观感不对称）

**现象**：同一份「履约退出历史」，管理端 `/admin/orders/[id]` 显示的是**内部标识**（形如 `cp_xxxx`），客服侧三个页面显示的是**打手名字**。

**这不是数据限制**。管理端源码注释原先写着「本页拿不到他的名字，也就不编一个出来」——**该断言不成立**：`getCompanionRepository().findCompanionById()` 按 id 查得到 `displayName`（连已下架的护航也查得到，客服侧就是靠它解析的）。管理端不解析是一个**当时的取舍**，不是能力缺失。

**本批次的处置**：**只改错话，不改行为**。管理端渲染逻辑一行未动（本轮修复范围是客服侧，改管理端属扩大批次），但把两处已成假话的注释改成了事实：
- 「这里是客服与管理员**唯一**能看到这段历史的地方」→ 客服侧另有三个入口；
- 「本页拿不到他的名字」→ 明确写成「查得到，管理端不解析是取舍；不要据此在客服侧也退回显示 id」。

**留给后续的判断**：管理端显示 `cp_xxxx` 这种内部标识是否合适、要不要与客服侧统一成名字，**本轮不决定**。同一个人在两处看到两种写法，属于已知不一致，**记在此处备查**。

### 15.7 修复批次的复审结论（第二次 reviewer）

`reviewer-agent` 只读复审，任务：独立复核「manifest gate 到底存不存在」（**不采信 Coordinator 的结论**）+ 复审客服侧实现。

**判定：可以交付人工验收；0 BLOCKER、0 MAJOR、4 MINOR、6 NOTE。**

**任务 2 的独立复核结果：与 Coordinator 一致——NOTE-3 是误判。** reviewer 给出四条独立证据，其中两条是 Coordinator 没有做的：

1. `git show HEAD:tests/companion.test.mjs | grep collectFiles` **在 P0-6 开工前的 HEAD 上就命中**——证明该门禁在 P0-5.5 就已存在，不是本轮补造的；
2. 它扫描的是 `readdirSync` 递归出来的真实文件集合，与清单做**双向** `deepEqual`（多一个 / 少一个 / 改名都红）；
3. 三条新路由逐条登记在册，实跑该文件 7/7 通过；
4. 容易被误认成「清单门禁」的那份东西（`tests/companionOrders.test.mjs` 的 401/403 权限矩阵）确实存在，但它测状态码、不测路由清单，且受 `APP_BASE_URL` 门控——这解释了误判的来源。

> ⚠️ reviewer 同时纠正了 Coordinator 一处**表述**（不影响结论）：`tests/companion.test.mjs` 的**用例数**一直是 7，
> 变的是**清单条数**（2 → 5）。全文不得写成「用例 2 → 5」。

**四条 MINOR：全部已修。**

| # | 位置 | 问题 | 处置 |
|---|---|---|---|
| M1 | `02-decisions.md` 的决策索引表与引言 | 索引仍写 `V2 CURRENT`、引言仍写「必须由用户在验收时裁定」，与本文件正文的 V3 及 README 冲突 | 索引改为 `V1 SUPERSEDED → V2 SUPERSEDED → V3 CURRENT`；引言改为**过去时**的历史说明，明确该例外**已关闭** |
| M2 | `architecture-rules.md:329` | 规范层能力表仍写「唯一缺口：客服侧没有查看退出历史的入口」并引用 **V2** | 改为「**本行无遗留缺口**」＋两半都可看＋「客服侧没有为此新增任何接口，见 D6 **V3**」 |
| M3 | `api-contract.md` §8 与 §3.1 | 同一份文档里打手端 CURRENT 有**两张表**：§8 说「只有这 2 个」、§3.1 列了 3 条 | §8 补齐为**五条**并声明它是打手端 CURRENT 的**唯一真值源**；§3.1 的 CURRENT 表**删除**，只留指针（同一份文档两张 CURRENT 表，迟早一张先改） |
| M4 | `tests/staffReleaseHistory.test.mjs` | 紧跟 `deepEqual(键集)` 之后的两段「逐字段 `in` 检查」「正则扫金额名」**恒真**，读起来像三层保护实际只有一层 | 删掉两段恒真断言并写明它们被 `deepEqual` 蕴含；**另加一条用例把字段清单本身钉死**（清单若被改宽，三处 `deepEqual` 会**一起**失效而无一变红——这才是真风险），并把金额名正则扫到**上游 `CompanionReleaseRecord`** 上（那里没有任何 `deepEqual` 兜底） |

**六条 NOTE**：N1（三方一致性素材只用 `companion_cancel`，**已补一条 `staff_reassign` 用例**）、
N2（三份私有 `releaseHistoryFor` 的重复**判定成立**，维持现状，出现第四个调用点再抽）、
N3（`companionId` 与「不给 `actorId`」不矛盾，**已按建议补注释**，免得后人删掉 `companionId` 反而违反需求）、
N4（空态不对称已被测试双向钉住，风险闭合）、N5（两条新 HTTP 用例在登录异常时会静默通过，影响极窄，**不改**）、
N6（负向门禁按「导出 `POST` 的文件集合」判定，改名绕不过去，复跑确认）。

**reviewer 明确声明无法验证的**：`APP_BASE_URL` 全量、`pnpm build`、以及浏览器里的视觉验收（超出只读边界）——
这三项由 Coordinator 在本节之外实跑，结果见 §14。

---

## 16. `git status --short`

> ⚠️ 本节为**修复批次之后的最终快照**。首次交付时的快照比这份少
> `components/staff/StaffReleaseHistory.tsx`、`tests/staffReleaseHistory.test.mjs`
> 与四个客服文件的修改。

```
 M app/admin/(console)/orders/[id]/page.tsx
 M app/staff/(console)/complaints/[id]/page.tsx
 M app/staff/(console)/conversations/[orderId]/page.tsx
 M app/staff/(console)/refunds/[id]/page.tsx
 M components/companion/CompanionDispatchCard.tsx
 M docs/02-tech-design/api-contract.md
 M docs/02-tech-design/architecture-rules.md
 M docs/02-tech-design/database-schema.md
 M docs/02-tech-design/directory-structure.md
 M docs/03-dev/rounds/README.md
 M docs/03-dev/总需求进度表.md
 M lib/constants/adminOrders.ts
 M lib/constants/companionConsole.ts
 M lib/constants/dispatch.ts
 M lib/constants/orders.ts
 M lib/constants/staff.ts
 M lib/constants/staffComplaints.ts
 M lib/constants/staffRefunds.ts
 M lib/data/mockDispatchRepository.ts
 M lib/data/mockPaymentRepository.ts
 M lib/data/mockStore.ts
 M lib/data/paymentRepository.ts
 M lib/services/adminOrders.ts
 M lib/services/companionHttp.ts
 M lib/services/staffComplaints.ts
 M lib/services/staffConversations.ts
 M lib/services/staffRefunds.ts
 M lib/types/complaint.ts
 M lib/types/order.ts
 M lib/types/refund.ts
 M lib/types/staff.ts
 M tests/companion.test.mjs
 M tests/companionAccess.test.mjs
 M tests/orders.test.mjs
 M tests/staff.test.mjs
 M tests/staffComplaints.test.mjs
 M tests/staffRefunds.test.mjs
?? app/api/companion/orders/
?? app/companion/(console)/orders/
?? components/companion/CompanionOrderCancelPanel.tsx
?? components/companion/CompanionOrderCard.tsx
?? components/companion/CompanionOrderList.tsx
?? components/staff/StaffReleaseHistory.tsx
?? docs/03-dev/rounds/P0-6/
?? docs/03-dev/rounds/cmd_p0-6.md
?? lib/data/companionOrderTransaction.ts
?? lib/data/companionReleaseRepository.ts
?? lib/data/mockCompanionReleaseRepository.ts
?? lib/services/companionOrders.ts
?? lib/types/companionRelease.ts
?? tests/companionOrders.test.mjs
?? tests/staffReleaseHistory.test.mjs
```

`HEAD` 仍是 `551c15a`（本轮未提交）。

---

## 17. Git 写操作声明

**本轮未执行任何 Git 写操作。** 没有 `git add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend`；只使用过只读的 `status` / `diff` / `show` / `rev-parse`。

`HEAD` 未移动，工作区即交付内容。

建议提交描述（**由用户本人执行**）：
`feat(companion+staff): accepted 主动取消接单、打手「我的订单」与客服可见的履约退出历史（P0-6）`

---

## 18. 停止位置

（交付时点）本轮止于 **`AWAITING_ACCEPTANCE`**，等待用户人工验收。

`DONE` 需要用户人工验收通过 **且** 用户本人提交，Claude 不得自行标记。下一 Round 不得自动开始。

人工验收清单见 `04-acceptance.md`。

> **2026-09-24 更新**：人工验收**已通过**（`User Result` / `Final Result` = `PASSED`），
> 实现由**用户本人**提交于 **`53481ea`**——「DONE 的双重门槛」两个条件均已满足，
> 本轮已收口为 **`DONE`**（上面那句「止于 `AWAITING_ACCEPTANCE`」是**交付时点**的记录）。
> 验收期间另发现两个整改项（**FIX-1** 打手工作台缺返回入口 / **FIX-2** 订单池排序改为「等待最久优先」），
> 二者**不属于本轮冻结范围**、**不推翻本轮 `DONE`**，已登记为独立 `NEEDS_FIX` 待办，
> **不回头改写上面的实现描述**。
