# P1-3 决策记录

Round: P1-3｜管理员售后 / 投诉统一工作台
Status: IN_PROGRESS → AWAITING_ACCEPTANCE
日期: 2026-09-29（夜间连续开发批次）

---

## 一、Requirement Check 结论：**不需要任何新产品规则，可以开工**

`cmd_p1-3.md` 的 Requirement Check 要求确认「权威需求是否定义了新的 resolution 枚举」，并规定
「如果权威需求未定义新的 resolution 枚举，**不得发明**」。

核查结果：

| 检查项 | 结论 | 凭证 |
|---|---|---|
| 要不要新的「处置结论」类型 | **不要**。退款结论 = 既有的 `pending/reviewing/approved/rejected/cancelled` 五态；投诉结论 = 既有的 `pending/processing/resolved/closed` 四态 | `lib/types/refund.ts:15`、`lib/types/complaint.ts:15` |
| 要不要新的动作 | **不要**。退款三动作（开始审核 / 通过 / 驳回）、投诉三动作（开始处理 / 解决 / 关闭）**全部已存在** | `lib/constants/adminRefunds.ts:226` `ADMIN_REFUND_TRANSITIONS`、`lib/constants/adminComplaints.ts:220` `ADMIN_COMPLAINT_TRANSITIONS` |
| 要不要新的服务或事务 | **不要**。只需把既有列表/详情服务**聚合**起来 | `lib/services/adminRefunds.ts`、`lib/services/adminComplaints.ts`、`lib/services/adminOrders.ts` |
| 「open」的口径要不要重新定义 | **不要**，也**不许**。既有唯一常量在 `lib/constants/refunds.ts:249`（`OPEN_REFUND_STATUSES`）与 `lib/constants/complaints.ts:35`（`OPEN_COMPLAINT_STATUSES`） | cmd：「open 集合必须复用现有唯一常量，**不能复制第二套**」 |
| 有没有 OPEN 的决策 | **没有**。本轮不产生任何需要产品负责人回答的问题 | — |

→ 因此本轮**没有 BLOCKED 子项**，全量实现。

---

## 二、设计决策

### D-P1-3-1｜统一入口是**新增第三条**，既有的两条一条不删

`cmd_p1-3.md` 指定「统一入口 `/admin/aftersales`（如已有则复用）」。核查确认 `app/admin/**` 下
**没有** aftersales 相关页面，因此新建。

⚠️ **这与仓库里一条既有判断直接相抵触，必须说清楚而不是悄悄绕过**：

`lib/constants/admin.ts:198-199` 与 `tests/admin.test.mjs` 的导航用例里都写着——
「**退款与投诉是两个模块，不是一个「售后」模块**：一边动订单与金额，一边只写平台侧结论，
合成的入口会让人分不清。」

**裁定：那句话仍然成立，而导航里也确实多了一条「售后工作台」，两者不矛盾。**

- 原判断针对的是「把两种**处置动作**合成一个入口」。本工作台**不改这个分工**：
  它是**只读的分流队列**，点进去之后案件本体渲染的正是各自既有的
  `AdminRefundConsole` / `AdminComplaintConsole`（见 D-P1-3-3），
  处置动作仍然只在各自的工作面上发生。
- 两个原有入口（`/admin/refunds`、`/admin/complaints`）**保留不动**，
  `cmd_p1-3.md` 测试第 15 条「既有 refund/complaint 页面不回归」由测试守住。
- 既有注释**不删**，在它旁边补记 P1-3 的这一层说明（照仓库「历史判断只批注、不改写」的习惯）。

### D-P1-3-2｜`open` 沿用唯一常量；`processing` 是它的**子集**；`closed` 是补集

三个视图的定义（**这是本轮唯一有设计含量的一处，写清楚**）：

| 视图 | 定义 | 落点 |
|---|---|---|
| `open`（未完结） | **该领域自己的 `OPEN_*` 常量本身** | `OPEN_REFUND_STATUSES` / `OPEN_COMPLAINT_STATUSES`，**不复制第二套** |
| `processing`（处理中） | `open` 的子集：已被接手、尚未终结 | 新增 `AFTERSALE_IN_PROGRESS_STATUSES = { refund: ["reviewing"], complaint: ["processing"] }` |
| `closed`（已结束） | `open` 的**补集** | 由该领域全部状态**减去** `OPEN_*` 导出，不另写清单 |
| `all`（全部） | 不加状态限制 | `null` |

⚠️ **为什么 `open` 不能改成「待接手」**：`open` 在管理端**已经有确定含义**（未完结，见
`refundStatusesForFilter` / `complaintStatusesForFilter` 与首页待办卡计数）。若在工作台里把
`open` 用来表示「待接手」，同一个后台就会出现两个 `open`——这正是本仓库反复防的那类事故。
因此 `processing` 做成 **open 的细化视图**（⊆ open），而不是把三个视图做成互斥的三桶。

`processing` 的两个取值**都取自既有枚举**，不新增任何状态：
- 退款的 `reviewing`：`REFUND_STATUS_LABELS.reviewing = "审核中"`；
- 投诉的 `processing`：`COMPLAINT_STATUS_LABELS.processing = "处理中"`。

因此本常量是**视图分组**，不是新枚举——直接对应 `cmd_p1-3.md` 的
「本轮不创造新的处置结论类型」。

**双向函数由同一组常量导出，但二者是包含关系、不是字面意义的「互为反函数」**
（测试按 `inExactBucket` 逐格断言）：
`aftersaleRefundStatusesForView(view)` / `aftersaleComplaintStatusesForView(view)` 回答
「这个视图要哪些状态」，`aftersaleRefundViewOf(status)` / `aftersaleComplaintViewOf(status)` 回答
「这一行属于哪个视图」。两者**由同一组常量导出**，不得各写一份判断——否则
「按未完结筛出来的行里混进一个已结束」这类错误只会表现为页面上一个说不清的数字。

> ⛔ **2026-09-29 交付前复核修正**：本条原文写的是「双向函数必须**互为反函数**」，
> 与同轮改写后的 `D-P1-3-8`（`processing ⊆ open`，两者**不互斥**）直接冲突，
> 也与代码注释冲突（`lib/constants/adminAftersales.ts:296` 明写
> 「**它不是 `aftersaleRefundStatusesForView` 的反函数**」）。
> 正确的口径是：`viewOf` 返回**最细的那一桶**，因此 `open` 桶的**精确集合 = `OPEN_*` − `processing`**；
> 测试逐格断言时对 `open` 视图要扣掉 `processing`（`tests/aftersalesWorkbench.test.mjs` 的 `inExactBucket`）。
> **`aftersaleRowInView`（按状态集合收窄）与 `viewOf`（精确桶）是两条不同路径**，
> 前者用于筛选、后者用于 `counts` 分批——两者同源、数值等价，但不是反函数。

### D-P1-3-3｜案件本体**直接复用既有 Console 组件**，工作台不新增任何动作接口

这是「聚合页不得复制事务逻辑，只调用既有 service」的落点，也是本设计里最省事、最不容易走样的一处：

- 既有 `components/admin/AdminRefundConsole.tsx` 与 `AdminComplaintConsole.tsx`
  **已经是**独立客户端组件，props 就是完整详情 DTO（`AdminRefundDetail` / `AdminComplaintDetail`），
  内部已经渲染了三个动作按钮、决策比例表单、确认框与幂等键。
- 聚合详情页因此只做两件事：调 `getAdminAftersaleDetail()` 拿 DTO，然后把 DTO **原样交给**同一个 Console。
- **结论：工作台里没有第二个动作按钮、没有第二份 fetch 写入逻辑、没有第二个确认文案。**
  新增的管理端接口**只有 1 个**（`GET /api/admin/aftersales`，只读列表）；
  **没有**详情接口、**没有**动作接口（`tests/admin.test.mjs` 的接口清单里写明了这条理由）。

### D-P1-3-4｜订单侧聚合**直接复用 `getAdminOrderDetail()`**，不新建会话/退出查询

`cmd_p1-3.md` 要求详情页聚合「订单、退款、投诉、打手、调查历史」。核查发现这些**已经有一个现成的管理端入口**：
`getAdminOrderDetail(orderId, params, surface)`（`lib/services/adminOrders.ts:250`）并发取回
订单 + `actualCompanion` + `conversationSummary` + `releaseHistory` + `refundSummary` + `complaintSummary`。

→ 聚合详情因此 = 「案件的详情服务」+「这一单的订单详情服务」，两个调用，零新增查询逻辑。
**不新造**「按 orderId 取会话」「按 orderId 取退出历史」的封装。
`getAdminOrderDetail` 里的 `releaseHistory` / `conversationSummary` 正是
`cmd_p1-3.md` Requirement Check 里点名的「Staff conversations / release history」。

⚠️ 投诉可能**没有关联订单**（`Complaint.orderId` 可为 `null`），那时订单侧整块不渲染并给一行说明。

### D-P1-3-5｜「打手筛选」通过关键词第 5 路实现，不新造按打手 id 的筛选参数

`cmd_p1-3.md` 的筛选清单里有「打手」，但括号写着「**现有数据支持时**」。核查结论：

- 售后记录（`RefundRequest` / `Complaint`）**都没有指向打手的外键**；
- 打手在**订单**上（`Order.companion: OrderCompanionSnapshot | null`，`lib/types/order.ts:161`）；
- 要按打手 **id** 筛，需要先建一个「打手 → 案件」的反查，而那个反查在本阶段没有真库支撑。

→ 因此**不造**「按打手 id 筛选」的参数（那是替产品决定一个新的查询维度），
改为把**打手昵称**并入关键词搜索的第 5 路，并在列表里给出打手列。
筛选栏的占位文案会写清搜的是哪五处，用户不必猜。

关键词五路：**案件编号 / 订单号 / 用户昵称 / 平台展示 ID / 打手昵称**，
归一化严格照抄既有实现（`keyword.trim().toLowerCase()`，空串即不比）——
与 `complaintMatchesAdminKeyword`（`lib/constants/adminComplaints.ts:386`）和
`orderMatchesKeyword`（`lib/constants/orderFilters.ts:149`）同口径。

### D-P1-3-6｜日期筛选复用既有实现，口径与订单列表**完全一致**

- 参数校验**复用** `readOrderFilterDate()`（`lib/constants/orderFilters.ts:75`）——
  它是仓库里**唯一**的「地址栏日期参数」实现（含 `2026-13-45` 这类形状合法但语义非法的拦截）。
  ⚠️ 复用一个名字带 `order` 的函数而不另写正则，是刻意的：两套校验迟早会在边界值上分叉。
- 日期归属**复用** `formatDateTime()`（`lib/utils/format.ts:65`）取前 10 位——
  它是仓库里**唯一**的时区实现（固定 UTC+8、不用 `Intl`），
  因此「列表上显示 2026-09-12 的记录，按 09-12 筛一定筛得到」这条与订单列表同口径。
- 区间**含两端**，空串表示该侧不限，时间戳坏掉按「不在范围内」（照 `orderInDateRange`）。
- `from > to` 按**非法**处理（接口 400、页面回落），不静默返回空列表：
  空的筛选结果与写错的筛选条件必须能区分开。

### D-P1-3-7｜排序的稳定键是**非业务键**，不改变业务并列含义

`compareAftersaleRowsNewestFirst`：提交时间**倒序** → `caseType` 升序 → `id` 升序。

后两层**不是业务规则**，它们只保证同一份数据每次排出来的顺序完全一致（分页不重不漏）。
理由照抄 `compareOrdersByCreatedAt`（`lib/constants/orderFilters.ts:122`）：
预置数据里存在时间戳相同的记录，顺序不确定会让同一条在第一页出现过、翻到第二页再出现一次。
`cmd_p1-5.md` 里也明确允许这种用法（「可用非业务 ID 作为最后稳定排序键，并明确它不改变业务并列含义」）。

⚠️ 本工作台**不是排行榜**，没有名次概念，因此这里不存在「并列名次」的业务含义需要裁定。

### D-P1-3-8｜`counts` 的口径：**不含**视图筛选，**含**其它筛选

> ⛔ **2026-09-29 交付前复核推翻本条的第一版口径，已改写（见文末「改写说明」）。**
> **第一版要求 `open`/`processing`/`closed` 互斥且求和等于 `all`，与 `D-P1-3-2`、
> 与「未完结」这个标签、与页面上真的渲染着的 `ADMIN_AFTERSALE_LIST_NOTICE` 直接矛盾。**
> 实现照第一版做了，于是「未完结」页签里**只有 `pending`**，把正在等管理员批准的
> `reviewing` 退款排除在外——而页面说明原文写着「退款：待审核 / 审核中」。**以指令与文案为准，改写如下。**

列表返回 `counts: { all, open, processing, closed }`。口径是：

- 在 **caseType + 日期 + 关键词** 命中的集合上计数；
- **不受当前选中视图影响**——切换视图时角标不会跟着变成 0；
- 三个数分别等于**各自标签下真实的行数**（角标必须等于点进去的条数）。

⚠️ **`open` 与 `processing` 不是互斥的**：`processing ⊆ open`（见 `D-P1-3-2`），
因此正确的关系是

```
all === open + closed          ← 成立
processing ⊆ open              ← 成立，且是「其中已经有人接手的那一部分」
open + processing + closed === all   ← ⛔ 不成立，第一版就是错在这里
```

`closed` 是 `open` 的**补集**（由 `OPEN_*` 减去得到，**不是**手写清单），
因此 `all === open + closed` 是构造性的。`processing` 与 `open` 的重叠是**有意的**：
它回答的是「未完结的这一批里，哪些已经有人动手了」。

### 改写说明（2026-09-29，交付前只读复核 BLOCKER-1）

第一版把三个视图做成**互斥三桶**，理由是「求和等于 all 更好看」。这个理由是**本末倒置**：

| 异类 | 说 `open` 是什么 |
|---|---|
| `cmd_p1-3.md` 核心约束第 1 条 | 必须**复用现有唯一常量** `OPEN_*` |
| `D-P1-3-2` 自己的表格 | `open` = `OPEN_*` **常量本身**；`processing` 是它的**子集** |
| `ADMIN_AFTERSALE_VIEW_LABELS.open` | 「**未完结**」 |
| `ADMIN_AFTERSALE_LIST_NOTICE`（**渲染在页面上**） | 「未完结沿用各领域自己的口径（退款：待审核 / **审核中**；投诉：待处理 / **处理中**）」、 「处理中**是其中**已经有人接手的那一部分」 |
| **第一版的代码** | `open` = 只有 `pending` ⛔ |

**五个来源里四个说同一件事，只有代码是异类**，所以方向不是「改文案」，是**把代码改回来**。
危害是真实的：`reviewing` 的退款**正是等着管理员批准的那一批**，却从默认视图里漏掉了。

⚠️ 本条与 `D-P1-3-2` 的冲突是**我写文档时自己制造的**（两条决策各写一半、没有交叉核对），
不是实现方理解错。**教训：规格里出现「求和恒等式」这类好看的数学性质时，
要与集合语义那一条对着读一遍再落笔。**

### D-P1-3-9｜DTO 最小化

行 DTO 只给界面**真的会渲染**的字段（`AdminAftersaleRow`，见 `lib/types/aftersale.ts`），
**不整包返回** `Order` / `User` / `Companion` 实体：

- 用户只给 `AdminUserSummary`（`id` / `nickname` / `displayId` 三项，复用既有类型）；
- 打手只给 `OrderCompanionSnapshot`（`id` / `name` / `avatarUrl` 三项）——
  ⚠️ **复用**这个既有类型而不是新造一个：全仓库只有这一个「订单上的打手公开快照」形状，
  新造第二个只会多一处需要同步的地方；
- 订单侧只给列表要显示的四个值（`orderId` / `orderNo` / `orderStatus(+Label)` / `productTitle`）；
- **不含**退款说明正文、凭证、审核意见、投诉正文、联系方式——那些只在详情页（且各自已有归属校验）。

### D-P1-3-10｜不发明新枚举、不碰边界外的东西

- 未新增任何 `resolution` / 处置结论枚举（cmd 明令）。
- 未引入钱包 / 追偿 / Scheduler / chat retention / 真支付 / 真数据库。
- P0-15 规则**原样保持**：一单一退；approved refund 后打手本单收益归零；
  部分退款**不**强制 `Order.status = refunded`，只有全额退款才进 `refunded`。
  工作台**不写任何状态**，因此这些规则在本轮只可能被「读错」而不可能被「改错」——
  测试第 7/8/9 条正是去读它们。

---

## 三、Open 决策

**无。** 本轮没有需要产品负责人回答的问题，因此不阻塞、不停在 `CLARIFYING`。
