# P0-10 · 02-decisions.md

Round: P0-10（客服全量订单查询工作台）
阶段: Requirement Check → RESOLVED
Status: **RESOLVED**（无 OPEN decision，可进入开发）
记录时间: 2026-09-24

> 本文件按协议 §五 **只追加、不覆盖历史**。Requirement Check 的十二项与执行口径一经写下，
> 后续如需变更，在文末「追加」而不是改上面的结论。

---

## 一、Requirement Check（协议 §七，十二项）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | **产品规则** | 补齐 P0「客服查看订单」。客服可「查看工作所需订单」（用户权限表 §7.1），但适用数据最小化（§10「只开放履职需要的信息」），且**不可**查看分账比例、**不拥有**最终资金裁决权（§7.2）。本轮是**只读查询**，不涉及任何裁决。 |
| 2 | **前置状态** | 无业务状态前置条件——列表/详情对**任意状态的订单**都要能查（这正是「全量查询」的含义）。唯一前置是**身份**：客服会话有效且 `enabled`。 |
| 3 | **成功状态** | 返回列表 DTO / 详情 DTO。**不改变任何订单状态、不写任何仓储**。 |
| 4 | **失败状态** | 未登录 → 401 `UNAUTHORIZED`；非客服角色 / 已停用 / 已移除 → 403 `FORBIDDEN`；订单不存在 → 404 `NOT_FOUND`；筛选参数非法 → 400 `BAD_REQUEST`。页面侧未登录 → `redirect("/staff/login")`，订单不存在 → `notFound()`。 |
| 5 | **权限** | API 用 `requireStaff()`（`lib/api/staffRoute.ts`）；页面用 `getStaffSession()` + `redirect`。与既有客服页面**同一套守卫**，不新增参数化守卫（architecture-rules §4.2 四套身份并行、刻意不合并）。 |
| 6 | **金额** | 只读展示，**不做任何金额计算**，不重算分账、不重算退款。展示口径见 §三 D3。 |
| 7 | **幂等** | 纯 GET，天然幂等。本轮**没有任何写入路径**，因此不涉及幂等键 / 重放。 |
| 8 | **并发** | 无写入 → 无并发问题。不涉及伪事务原子区段。 |
| 9 | **通知** | 无。本轮不产生任何通知（P0-11 / P0-12 才涉及）。 |
| 10 | **TBD** | 无新增 TBD。`architecture-rules.md` §7.2 的 R4/R5/R6/R7/R10 与本轮无关；提现、自动罚款、用户封禁、复杂 Assignment 均未触碰。**没有需要产品负责人裁定的问题。** |
| 11 | **架构冲突** | 无。全量订单读取复用既有 `PaymentRepository.queryOrdersForAdmin` / `listAllOrders`；**不创建 `OrderRepository`、不创建第二套订单系统**。DTO 复用既有 `StaffOrderSummary` / `StaffUserSummary` / `StaffCompanionReleaseEntry` / 三份既有 staff 列表项 DTO。 |
| 12 | **与现有代码事实冲突** | 有一处**过时注释**需同批修正：`app/staff/(console)/layout.tsx` 写着「客服**没有订单全量查询**（只看得见有会话的订单）」——本轮正是来补它，注释必须随代码一起改，否则新代码与旁边的说明互相矛盾。另有 `api-contract.md` §11「客服工作台（staff）—— 16 条」与 `directory-structure.md` 的同类计数过时（见 §五）。 |

**结论：十二项全部有明确答案，无 OPEN。允许进入开发。**

---

## 二、权威依据

| 事项 | 依据 |
|---|---|
| 客服可查看工作所需订单 / 数据最小化 / 不得看分账与最终资金 | `docs/01-requirements/超哥电竞_用户权限表.md` §7.1 / §7.2 / §10 |
| 权限开发纪律（服务端鉴权、DTO 最小化、401/403/404 测试、禁止用隐藏按钮代替权限） | 同上 §十三 |
| 分层与 DTO 裁剪职责（Route 只做四件事；Service 做编排 + DTO 裁剪） | `docs/02-tech-design/architecture-rules.md` §2.2 / §2.3 |
| 四套身份守卫并行、不合并 | 同上 §4.2 |
| 客服接口清单门禁须同批扩充 | 同上 §十.4 |
| 401/403/404 语义、DTO 最小化硬约束、整数分、ISO 时间 | `docs/02-tech-design/api-contract.md` §2.1–§2.6 |
| 本批原始指令 | `docs/03-dev/rounds/cmd_p0-10.md` → 同目录 `01-prompt.md` |
| 批次约束（自动继续 / 停止 / 累积工作区 / 架构硬约束 / Git 禁令） | `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md` |

---

## 三、执行规则（RESOLVED）

### D1 — 路径与文件

| 类型 | 路径 |
|---|---|
| 列表页 | `app/staff/(console)/orders/(list)/page.tsx` + `(list)/loading.tsx` |
| 详情页 | `app/staff/(console)/orders/[id]/page.tsx` + `[id]/not-found.tsx` |
| 列表接口 | `app/api/staff/orders/route.ts` |
| 详情接口 | `app/api/staff/orders/[id]/route.ts` |
| 服务 | `lib/services/staffOrders.ts` |
| 浏览器端取数 | `lib/services/staffHttp.ts` 新增两个函数（只拼地址、只发请求） |
| 常量 / 转换 | `lib/constants/staff.ts` 追加 |
| 类型 | `lib/types/staff.ts` 追加 |
| 组件 | `components/staff/StaffOrderTable.tsx`（客户端表格）+ 详情展示组件 |
| 导航 | `components/staff/StaffHeader.tsx` 的 `NAV_ITEMS` 追加一项 |

**详情路由上下不得有 `loading.tsx`**——`(list)` 路由组正是为此存在：详情若被 loading 边界包住，
外壳会先以 200 发出，迟到的 `notFound()` 只能改内容、改不了状态码。沿用既有两条详情路由的写法。

导航项位置：`工作台 / 订单 / 会话列表 / 退款处理 / 投诉处理 / 完成材料审核`。
`StaffHeader.isActive` 的既有前缀匹配使 `/staff/orders/[id]` 也能点亮「订单」。

### D2 — 不新增任何仓储方法

已确认所需读取**全部存在**，因此本轮**零新增仓储接口**：

| 需要的事实 | 既有方法 |
|---|---|
| 订单集合（筛选 + 排序） | `paymentRepository.queryOrdersForAdmin({status, gameName, from, to})` |
| 单订单 | `paymentRepository.findOrderById(id)` |
| 用户摘要 | `getDataSource().findUserById(userId)`（服务层已用同一写法） |
| 退款摘要 | `refundRepository.findRefundByOrderId(orderId)` |
| 投诉摘要 | `complaintRepository.listComplaintsByOrderId(orderId)` |
| 完成材料摘要 | `completionRepository.findLatestCompletionByOrderId(orderId)` |
| 派单摘要 | `dispatchRepository.findDispatchByOrderId(orderId)` |
| 退出历史 | `companionReleaseRepository.listReleasesByOrderId(orderId)` |
| 打手名回落 | `companionRepository.findCompanionById(id)` |

`queryOrdersForAdmin` 的签名虽然带 `ForAdmin`，但它回答的是**与身份无关**的问题
（状态 / 游戏 / 时间范围内有哪些订单、什么顺序）。为客服再写一份同义查询就是**第二套订单读取实现**，
被批次「架构硬约束」与 architecture-rules §十「无第二套实现」明确禁止。**直接复用。**

同理复用：`getDataSource().findUserById`（不新开用户读取路径）。

### D3 — Staff DTO 字段表（**这就是边界**）

#### 列表项

```ts
export type StaffOrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  createdAt: string;
  paidAt: string;
  gameName: string;        // 游戏名快照；用于筛选与展示
  productTitle: string;
  specName: string;
  quantity: number;
  totalAmount: number;     // 渠道实收（商品 + 增值服务）
  user: StaffUserSummary;  // 复用既有类型：id / nickname / avatarUrl
};
```

#### 列表查询条件

```ts
export type StaffOrderListQuery = {
  status: StaffOrderStatusFilter;  // 复用既有类型，含 "all"
  keyword: string;                 // 订单号 / 用户昵称 / 平台 ID / 商品名
  game: string;                    // 空串 = 全部游戏
  from: string;                    // YYYY-MM-DD（含当天，北京时间自然日）
  to: string;
  page: number;
  pageSize: number;
};
```

#### 列表响应

```ts
export type StaffOrderListData = {
  items: StaffOrderListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  games: string[];   // 筛选项，取自订单数据（与 Admin 同规则，复用同一个纯函数）
  notice: string;
};
```

#### 派单摘要

```ts
export type StaffOrderDispatchSummary = {
  state: DispatchState;
  stateLabel: string;
  exclusiveEnteredAt: string | null;
  exclusiveDeadlineAt: string | null;
  publicPoolEnteredAt: string | null;
  publicDeadlineAt: string | null;
  acceptedAt: string | null;
  timedOutAt: string | null;
};
```

#### 详情

```ts
export type StaffOrderDetail = {
  order: StaffOrderSummary;              // 复用既有：订单身份 / 状态 / 商品 / 打手 / 退出历史
  user: StaffUserSummary;                // 复用既有
  productCoverUrl: string;
  gameName: string;
  region: string;
  unitPrice: number;
  itemsAmount: number;
  addonsAmount: number;
  addons: OrderAddonSnapshot[];
  originalAmount: number;
  couponDiscountAmount: number;
  actualPaidAmount: number;
  refundedAmount: number;
  timeline: OrderTimelineEntry[];        // 复用 buildOrderTimeline
  dispatch: StaffOrderDispatchSummary | null;
  refund: StaffRefundListItem | null;              // 复用既有 staff 列表项 DTO
  complaints: StaffComplaintListItem[];            // 复用既有 staff 列表项 DTO
  completion: StaffCompletionListItem | null;      // 复用既有 staff 列表项 DTO
};
```

#### 明确**排除**的字段及理由

| 排除字段 | 理由 |
|---|---|
| `clubNetIncome` | **平台净收入**。这是唯一一个「不进任何 DTO」的金额（`order.ts` 注释已确立）；`cmd_p0-10.md` 明令不得暴露平台净利润。 |
| `companionRateSnapshot` | **分账比例快照**。`cmd_p0-10.md` 明令不得暴露分账比例；同时用户权限表 §7.2 禁止客服查看分账比例。 |
| `companionBaseIncome` | **护航收益**。它不是被点名的两个字段之一，但 `companionBaseIncome / actualPaidAmount` 与 `companionRateSnapshot` 是同一个数的三种写法——给了它等于给了分账比例。且本轮客服不需要它：按 `cmd_p0-13.md`，**最终金额由 Admin 决定**，客服不参与金额裁决。 |
| `gameAccountId` | 游戏账号。既有 `StaffOrderSummary` / `StaffConversationDetail` 已确立其不进客服 DTO（§10 数据最小化）。本轮只读查询不需要它。 |
| `remark` | 用户备注。同上；且备注里可能含用户隐私内容。 |
| `userId`（订单上**平铺**的那个字段名） | 用户标识一律走 `user: StaffUserSummary`（`{ id, displayId, nickname, avatarUrl }`），不在订单上平铺一份 `userId`。⚠️ **本条排除的是「平铺」这种重复暴露，不是「内部 id 一律不给」**：`StaffUserSummary.id` **就是内部用户主键，它确实是给出的**——理由见下面 D4。原先这一行写成「不暴露内部用户主键」，与 D4、与实现、与用例三者都矛盾，2026-09-25 更正。 |
| 支付内部字段（`idempotencyKey`、`PaymentRequest.snapshot` 等） | `cmd_p0-10.md` 明令不得暴露支付内部字段；这些字段本就不在任何对外 DTO 里。 |
| `exclusiveCompanionId` | 用户当初指定的打手。`cmd_p0-10.md` 的详情必列清单里没有它，且它属于派单内部记录。**「原打手是谁」由退出历史回答**（§7.1 明确允许客服查看原打手记录），不需要额外暴露指定对象。 |
| `allowedActions` | 本轮**没有任何可执行动作**（换人 / 退款都属 P0-11 / P0-12 / P0-13）。不预留恒为 false 的字段——既有 DTO 注释已确立「一个恒为 false 的布尔值会被前端写成禁用按钮，而正确做法是这个按钮根本不存在」。 |

#### 关于「必要金额」的裁定

`totalAmount` / `originalAmount` / `couponDiscountAmount` / `actualPaidAmount` / `refundedAmount`
对客服是**履职必需**：客服要判断「这单还能退多少」就必须知道实付与已退。
`StaffRefundListItem.amount` 早已把退款金额给过客服，因此 `refundedAmount` 不构成新的暴露。

**边界一句话概括：客服看「用户侧的钱」（应付 / 实付 / 已退 / 已申请的退款额），
不看「分账与平台的账」（比例 / 护航收益 / 平台净收入）。**

### D4 — 「平台 ID」搜索键：决定暴露，且不构成新增暴露

`cmd_p0-10.md` 要求列表支持按「用户昵称 / 平台 ID」搜索。若命中理由不可见，客服会遇到
「搜到了但看不出来为什么搜到」。因此列表项带 `user: StaffUserSummary`（含 `id`）。

**这不构成新增暴露**：`StaffConversationDetail.user` 早已把同一个 `StaffUserSummary.id`
交给过客服（`lib/types/staff.ts` 对该字段的注释已写明「`StaffConversationDetail.user` 早就把它给了客服」）。
本轮只是让列表与既有详情同一口径。**不新增字段、不新增类型。**

### D5 — 排序：创建时间降序 + 稳定次级键（复用，不新写）

`cmd_p0-10.md` 要求「创建时间降序 + 稳定 secondary key」，且**排序字段必须与时间筛选字段一致**
（都是 `createdAt` 的北京时间自然日），否则「筛 9 月、按 8 月的时间交错」无法解释。

既有 `compareOrdersForAdmin` 正好是 `createdAt desc → paidAt desc → id asc`。
为客服再写一份 `compareStaffOrders` 就是同一规则的**第二套实现**，被架构硬约束禁止。
因此**上移共享**（见 §四），两端复用同一函数。

### D6 — 筛选解析：严格/宽松双模式（沿用既有惯例）

- **接口**：非法 `status` / `game` / `from` / `to` → 400 `BAD_REQUEST`，不静默回退。
- **页面**：非法值规范化回默认值（`status → "all"`，`game → ""`，日期 → 不限），不报错。

这与客服会话列表、管理端订单列表完全一致（`resolveXxxListQuery(params, strict)`）。
游戏筛选项用**订单数据里出现过的游戏名**，不用当前商品目录（目录新增游戏但无订单时，
放进筛选栏只会得到一次必然为空的查询；游戏下架后历史订单仍要能筛出来）。

`status` 复用既有 `readStaffOrderStatusFilter` / `normalizeStaffOrderStatusFilter` / `STAFF_ORDER_STATUS_FILTERS`。
日期与游戏解析复用 §四 上移的共享纯函数，**但错误文案用 Staff 自己的常量**
（与 `STAFF_ORDER_STATUS_INVALID_MESSAGE` 同例：每个界面拥有自己的文案，不跨界面共享）。

### D7 — 详情「当前打手」与「退出历史」

- 当前打手：`order.companion` 快照 → 复用 `toStaffOrderSummary` 产出的 `companionSummary`
  （无打手时为「等待接单」）。
- 退出历史：复用 `toStaffCompanionReleaseEntry`——**三份 staff DTO 的唯一转换点**。
  本轮不改它、不新增字段、不新增空态文案（既有约定：无退出记录时组件返回 `null`，
  Admin 侧才是显示空态的那一侧）。

### D8 — 「进入会话」入口本轮不做

`StaffComplaintDetail` 有 `conversationOrderId`，因为投诉正文经常正是在问对话内容。
订单详情不同：「会话列表」是并列的导航项，从订单跳到会话不是本轮必列项。
本轮**不新增** `conversationOrderId` / `hasConversation` 一类事实（那需要多查一次会话域），
记为 NOTE 留待 P0-11 或 P0-13（换人 / 售后处理时更需要它）。

### D9 — 同批必须更新的门禁测试（不更新就会红）

| 测试 | 为什么必须改 |
|---|---|
| `tests/staff.test.mjs` | 客服接口清单从 **20 → 22** 条（新增 `orders/route.ts`、`orders/[id]/route.ts`） |
| `tests/staffTableRefresh.test.mjs` | `TABLES_WITH_SERVER_SNAPSHOT` 是**精确集合断言**，新增 `StaffOrderTable.tsx` 必须同步登记；`StaffRefreshButton` 检查列表也要加上新的 `(list)/page.tsx` |

**这不是「为了让测试变绿而放宽断言」**：两条门禁的用意正是「新增客服接口 / 新增客服表格时必须显式登记」。
登记 = 承认本轮扩大了客服攻击面与刷新面。

---

## 四、共享代码的处置：上移 `lib/constants/orderFilters.ts`

**问题**：既有六个订单筛选/排序纯函数住在 `lib/constants/adminOrders.ts`，但它们的语义**与身份无关**
（订单号 / 昵称 / 平台 ID / 游戏 / 北京时间自然日 / 创建时间倒序）。客服侧原样需要它们。

**三个选项**：

1. Staff 从 `adminOrders.ts` import —— 客服模块依赖管理端模块，命名（`readAdminOrderDate`）
   与分层都错；
2. 在 staff 侧复制一份 —— **第二套实现**，被批次架构硬约束明确禁止；
3. **上移为共享纯函数模块** —— 唯一真值源，两端复用。✅ 选它。

**做法**（保持既有引用点零改动）：

新建 `lib/constants/orderFilters.ts`，承载六个纯函数（保持「只有纯函数、可被浏览器与 node 直接加载」的纪律）：

| 新名（共享） | 原名（`adminOrders.ts` 保留为 re-export） |
|---|---|
| `readOrderFilterDate` | `readAdminOrderDate` |
| `orderBeijingDate` | 同名 |
| `orderInDateRange` | 同名 |
| `orderGameNames` | 同名 |
| `orderMatchesKeyword` | `orderMatchesAdminKeyword` |
| `compareOrdersByCreatedAt` | `compareOrdersForAdmin` |

`adminOrders.ts` 删除本地实现、改为**按原名 re-export 共享实现**，并在注释里写明「已上移，保留原名以免改动既有引用点、且不产生第二套实现」。

**为什么不用 `lib/constants/orders.ts`**：该文件的文件头明令「**不得出现任何运行时的 `import`**」
（它被客户端组件引用，靠这一点保证不把服务端模块打进浏览器产物）。
而 `orderBeijingDate` 依赖 `formatDateTime`（运行时的纯函数）。因此单独成文件，
遵守与 `adminOrders.ts` 相同的依赖纪律（类型 + `./pagination` + `lib/utils/format`，全是纯函数）。

**影响面（已核对，很小）**：`orderGameNames` / `orderMatchesAdminKeyword` 只被 `lib/services/adminOrders.ts` 引用；
`orderInDateRange` 还被 `lib/data/mockPaymentRepository.ts` 引用；`orderBeijingDate` 被 `tests/adminOrders.test.mjs` 引用。
**靠 re-export，这些引用点一个都不用改。**

---

## 五、同批必须同步的技术文档

| 文档 | 改什么 | 依据 |
|---|---|---|
| `docs/02-tech-design/api-contract.md` | 新增两条客服接口；§11「客服工作台（staff）—— 16 条」更新为 20 条现状 → 22 条（含本轮两条） | architecture-rules §十一「新增 API → 更新 api-contract.md」 |
| `docs/02-tech-design/directory-structure.md` | 若其中「staff/ 客服接口（16 个）」「`staff.test.mjs`（16 条）」一类计数与实际不符，按**实际值**订正 | 同上「新增目录惯例 → 更新」 |
| `app/staff/(console)/layout.tsx` | 修正过时注释「客服**没有订单全量查询**」 | Requirement Check #12 |

`database-schema.md` **不改**：本轮不新增领域实体、不新增数据关系（零新增仓储方法）。

---

## 六、本轮文件清单（计划，最终以 `03-delivery.md` 的实际 delta 为准）

**新增**

- `app/staff/(console)/orders/(list)/page.tsx`
- `app/staff/(console)/orders/(list)/loading.tsx`
- `app/staff/(console)/orders/[id]/page.tsx`
- `app/staff/(console)/orders/[id]/not-found.tsx`
- `app/api/staff/orders/route.ts`
- `app/api/staff/orders/[id]/route.ts`
- `lib/services/staffOrders.ts`
- `lib/constants/orderFilters.ts`（§四 上移）
- `components/staff/StaffOrderTable.tsx`
- `components/staff/StaffOrderDetailPanels.tsx`（详情各摘要区，若单文件过大则拆分）
- `tests/staffOrders.test.mjs`（本轮新增测试）

**修改**

- `lib/types/staff.ts`（追加 DTO）
- `lib/constants/staff.ts`（追加文案 / 筛选 / 转换）
- `lib/services/staffHttp.ts`（追加两个取数函数）
- `components/staff/StaffHeader.tsx`（导航追加「订单」）
- `lib/constants/adminOrders.ts`（六个纯函数改为 re-export，见 §四）
- `app/staff/(console)/layout.tsx`（过时注释）
- `tests/staff.test.mjs`（接口清单 20 → 22）
- `tests/staffTableRefresh.test.mjs`（登记新表格 + 新列表页）
- `docs/02-tech-design/api-contract.md`、`docs/02-tech-design/directory-structure.md`（§五）

**明确不动**：`lib/data/**` 任何文件（零新增仓储方法）；`lib/mocks/fixtures/**`（**不为了让测试变绿而加预置数据**——
若某个断言需要新数据，正确做法是测试自己造，不是改种子去迁就实现）；
所有用户端 / 管理端 / 打手端页面。

---

## 七、累积工作区基线（批次规则「每轮开始记录」）

| 项 | 值 |
|---|---|
| HEAD | `3fbae6263794bda316b2b48dac03efd7f62afa01`（`docs: close P0-6.1 through P0-9`） |
| 分支 | `feat/order-lifecycle-alignment` |
| 开工前 `git status --short` | 未跟踪：`docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md`、`cmd_p0-10.md`、`cmd_p0-11.md`、`cmd_p0-12.md`、`cmd_p0-13.md`（用户提供，本批**不是**本轮 delta）；`docs/03-dev/rounds/P0-10/`（本轮档案） |
| 上一轮 delta | **无**。P0-9 及其文档收口已由用户提交在 `eef4e62` → `3fbae62`，工作区干净。因此本轮 delta = 本文件 §六 清单，**不冒充累计 diff**。 |
| Git 写操作 | **本批全程为零**（含 `add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend`）。 |

---

## 八、OPEN decision

**无。** 本轮的每一个分叉都满足「读完权威文档 + 代码事实后只有一个合理选项」：

- 路径 / 文件名 / 常量名 / 组件名 → 与既有客服页面同构，自己定（协议 §八）；
- 「字段该不该给客服看」→ 由 `cmd_p0-10.md` 的排除清单 + 用户权限表 §7.1 / §7.2 / §10 直接判定；
- 共享纯函数上移 → 唯一能同时满足「不产生第二套实现」与「不跨界面共享文案」的做法；
- 「进入会话」入口不做 → `cmd_p0-10.md` 的详情必列清单里没有，且属扩大范围。

**没有任何一项会改变业务结果、权限边界、资金口径或状态机。** 因此不上交、不阻塞，直接开发。

---

## 九、追加（开发中发现的冲突与其处置）

> 本节按协议「追加历史、不覆盖历史」写在最后。上面的一～八节保持原样。

### A9-1 与 P0-6 D6 V3 的冲突：本轮**取代**了「不新增任何 Staff 订单接口」

**发现**：`tests/companionOrders.test.mjs` 里有一条 P0-6 留下的门禁，标题是
「§十一.23 两半都在：客服在三个既有详情页看得到取消历史，**且没有为此新增任何 Staff 订单接口**」。
它断言 `app/api/staff/**` 下**没有任何含 `orders` 段的路径**（`assert.deepEqual(staffApiRoutes, [])`），
并且客服端**恰好三处**页面渲染 `releaseHistory`。

**为什么它和本轮冲突**：`cmd_p0-10.md` 明确要求新增 `/staff/orders` 与 `/staff/orders/[id]`。
两条指令不可能同时成立。

**处置：按协议 §十三 的优先级裁定，本轮指令胜出，并显式记录取代关系。**

| 维度 | 内容 |
|---|---|
| P0-6 D6 V3（2026-09-23 用户裁定） | 「**不新增任何 Staff API 路由**，而是把退出历史挂到客服已经在用的三个只读详情 DTO 上」 |
| 本批指令（2026-09-24） | 「新增统一客服订单入口，优先使用 `/staff/orders` `/staff/orders/[id]`」 |
| 优先级依据 | §十三：**用户最新裁定 > 本轮 RESOLVED Final Execution Rule > … > 现有代码行为**。P0-6 的表述属于「现有代码行为」一侧，且被**更晚的、同一来源的**指令取代 |
| 被取代的是**手段**，不是**目的** | P0-6 选择「不开路由」是为了让权限矩阵（`requireStaff()` 一处判定）继续是唯一入口，**避免多出一组需要各自复查越权的路由**。本轮新开的两个地址**都走同一个 `requireStaff()`**，且被接口清单门禁逐条登记——那条目的仍然成立 |
| 所以新的断言守什么 | 从「一个都不能有」改为「**恰好这两个只读地址，且不导出任何写方法**」——比原表述更贴近该规则真正要守的东西（客服端没有改订单的能力），而且**更强**：原来只数个数，现在逐条列出并要求验证写方法不存在 |
| 第四处渲染点 | 本轮的订单详情按 `cmd_p0-10.md` 必列项展示 `CompanionReleaseRecord` 历史，因此渲染点从三处变四处。**前三处不许因此被删**——同一个事实在客服顺手打开的那个页面上缺一块，比它压根没有更糟 |
| 为什么不 CLARIFYING | 冲突发生在**实现手段**层面（开不开路由），不在业务结果 / 权限边界 / 资金口径 / 状态机层面；且优先级规则**已经给出唯一答案**，不存在「两个都合理、需要产品裁定」的情形。协议要求 CLARIFYING 的是**无法自行判定**的冲突，不是「判定结果与旧代码不同」 |

**同步动作**（已完成）：`tests/companionOrders.test.mjs` 的测试标题、上方说明注释、
事实二与事实三的断言全部改写，并在注释里**保留 P0-6 的原始理由与被取代的原因**——
不抹平历史，否则下一个人会把「曾经禁止过、后来放开了」读成「从来没管过」。

### A9-2 关于 `lib/constants/orderFilters.ts` 的追加说明

§四 里说「六个纯函数」上移；实际实现时发现 `readAdminOrderGame`（严格读取游戏筛选）
同样与身份无关，因此**也一并上移**（共享名 `readOrderFilterGame`，`adminOrders.ts` 按原名 re-export）。
总数因此是**七个**，不是六个。§四 的表格保持原样（历史），以本行为准。

### A9-3 一处与本轮无关的既有不稳定测试（记录，不修改）

全量 `pnpm test` 中，`tests/platformConfig.test.mjs` 的
「服务层写入：no-op 判据覆盖三个字段」在**单文件运行 5/5 通过**，但在全量套件里
**偶发失败**（同一命令连跑三次：两次红、一次绿）。本轮的 delta 不涉及
`lib/constants/platformConfig.ts` / `lib/services/adminPlatformConfig.ts` / 平台配置仓储的任何一行，
因此**判定为既有不稳定项，不在本轮修复**（修它属于另一个 Round 的范围，且需要先定位真正的触发条件）。
**它会挡住批次「full `pnpm test` fail=0」这条自动继续条件**，因此在最终门禁阶段会重跑确认；
若仍然复现，按批次「停止条件」上报，不擅自改那条测试。

> ✅ **后续（2026-09-25，P0-12）**：`pnpm test` 全量确实是 5/5 绿（本条担心的情况没有在本轮的门禁上复现），
> 但它**在 P0-12 的门禁上真实红了一次**，于是被查到底——**根因不是竞争、不是环境，而是一条本来就写错的断言**
> （毫秒级时钟精度）。已修复，命题未变。见下方 **A9-12**。
> ⚠️ 本条标题里的「不修改」在当时是**正确的处置**（先定位触发条件再改，见 A9-12 的教训段）；
> 它**不构成**「已知有问题却一直不改」的证据。

### A9-4 读取路径上的两个**惰性物化**必须挂上（修正 §一 第 3 / 7 / 8 项的字面读法）

**发现**：`lib/services/staffOrders.ts` 初稿按 §一 第 3 项「不改变任何订单状态、不写任何仓储」
的字面读法实现，**没有**调用 `sweepExpiredDispatches()` / `sweepCompletionAutoApprovals()`。

**为什么这是错的**：这两个函数不是本轮引入的写路径，而是本项目**读取路径上的既有惯例**：
`lib/services/adminOrders.ts`（列表与详情各一次）、`orders.ts`（用户端）、`companionOrders.ts`、
`companionDispatch.ts`、`companionEarnings.ts`、`staffCompletions.ts` 全部挂着它们
（`lib/data/earningTransaction.ts` 的注释把这条惯例写得很明确：「它挂在**读取路径**上」）。
`adminOrders.ts:180` 给出这条惯例的理由时**原文点名的就是客服场景**：

> 「否则**客服**会对着一条『等待接单』的单去催一个已经不存在的接单」

不挂的后果：客服打开 `/staff/orders`（或直接按订单号打开详情）时，`dispatch.state`
可能仍是「公共池等待接单」而 `publicDeadlineAt` 早已过去——客服据此告诉用户「还在等人接」，
而这一单按规则已经超时关闭。**触发条件是「期间没人在管理端 / 用户端 / 打手端访问过」，
也就是最难被复现、最容易在验收时被漏掉的那一类不一致。**

**处置**：在 `listOrdersForStaff` 与 `getStaffOrderDetail` 的**最前**各挂同样的两个调用
（幂等、同步函数、与 `adminOrders.ts` 同一个函数，不是第二套实现）。详情那一处比列表更必须：
客服往往是**直接按订单号打开详情**，列表可能根本没被访问过。

**因此 §一 第 3 / 7 / 8 项的字面读法被本行取代**，正确表述是：

| 原表述 | 修正后的表述 |
|---|---|
| 第 3 项「**不写任何仓储**」 | 第 3 项：**不产生任何业务处置**（不换人、不退款、不推进订单状态）。读取路径上的幂等惰性物化照常挂，与其余六个读服务一致 |
| 第 7 项「本轮没有任何写入路径」 | 本轮**不新增**任何写入路径；两个惰性物化是既有能力，本轮只是像其它读服务一样调用它 |
| 第 8 项「无并发问题」 | 仍然成立：两个物化函数是同步的、幂等的，且不构成「读—判断—写」的复合区段 |

**这不是「扩大范围」**：`cmd_p0-10.md` 第 16 行禁止的是「提前做换打手、退款、售后资金动作」，
惰性物化既不是换人也不是退款，它是**让这一页显示的状态与业务事实一致**的最小前提。

### A9-5 门禁加强：详情路由的 `loading` 边界必须**逐级上溯**检查

**发现**：`tests/staff.test.mjs` 原本只检查详情页**自己那一层**目录里有没有 `loading.tsx`。
把 `loading.tsx` 放到上一级（`orders/` 或 `(console)/`）同样会成为详情页的加载边界，
而那时「所在目录里没有 loading.tsx」仍然成立——**门禁红不了，等于没守**。

**处置**：改为从详情页所在目录**逐级上溯到 `app/`**，沿途任一层出现 `loading.tsx` 即失败。
当前 `app/`、`app/staff/`、`app/staff/(console)/` 都没有 `loading.tsx`，因此断言为绿——
但下一次有人把加载边界上提一层时，它会立刻红。

**同时记录一个工具事实**（写给下一个人）：`tests/app-path.mjs` 的 `findAppFile()` 会**剥掉
全部路由组段**，因此它按设计**无法区分** `orders/page.tsx` 与 `orders/(list)/page.tsx`
（两者归一化成同一个 key，同时存在时会抛「多个文件匹配」）。
所以「`loading.tsx` 必须收在 `(list)` 段内」这条断言**不能**靠 `resolveSource()`
硬写目录名来表达（那正是 `findAppFile` 存在的原因），它的正确写法就是本行的上溯检查。

### A9-6 计划外修复：页面文案里的一处 `**`（会原样渲染成两个星号）

`components/staff/StaffOrderDetailPanels.tsx` 的金额区块里有一句
`**本页不展示分账比例与平台收入**`。JSX 里的字符串是纯文本渲染的，
`**` 会在页面上**原样显示成两个星号**——这是本项目已经被记录过的一类缺陷
（`tests/staff.test.mjs` 里对常量做过同一条断言：「页面上的字符串是纯文本渲染的」）。

**处置**：去掉星号，改由措辞承担强调；并在新写的 `tests/staffOrders.test.mjs` 里
把这条守卫**扩展到 JSX 文本节点**（此前只覆盖 `lib/constants/**` 的常量字符串）。

### A9-7 两个接口都要 `export const dynamic = "force-dynamic"`

列表接口初稿漏了这一行，而**同目录的四个客服列表接口**
（`refunds` / `complaints` / `completions` / 以及它们的 `[id]`）**无一例外都有**。
已补齐。这不是风格问题：这一层的约定是每个客服接口都显式声明动态渲染，
漏一个就等于让「这个地址的缓存行为」变成靠默认值推断。

### A9-8 不加 `fetchStaffOrderDetail`（**偏离 D1 的「新增两个函数」**）

D1 的计划是 `lib/services/staffHttp.ts` 新增**两个**函数。实际只加了 `fetchStaffOrders`。

**为什么**：订单详情页是**服务端组件**（直接调 `getStaffOrderDetail()`），
浏览器侧没有任何调用方。留一个没人调用的取数函数，等于给同一份详情留**第二条读取路径**；
判断标准应是「有没有调用方」，不是「列表与详情对称」
（对照：`fetchStaffConversation()` 确实有客户端调用方，因此它存在）。
将来若出现需要客户端刷新的订单详情场景，那时再加。

**D1 的表格保持原样（历史），以本行为准。** `lib/services/staffHttp.ts` 在该位置留了注释说明这一点。

### A9-9 ⚠️ 需要产品负责人裁定：客服看到的「平台 ID」与用户自己看到的**不是同一个值**

**发现**（两个并行代理各自独立提到，已核实到代码与种子数据）：

| 事实 | 证据 |
|---|---|
| 客服端 `StaffUserSummary.id` = `UserRecord.id`，形如 **`u-1001`** | `lib/services/staffOrders.ts` 的 `toStaffUserSummary` → `getDataSource().findUserById()` → `lib/data/userRepository.ts:70` `toSessionUser` 直接取 `record.id`；`lib/mocks/fixtures/seed.ts:40` `id: "u-1001"` |
| 用户自己看到的 ID 是 `UserRecord.displayId`，形如 **`3f2a9c14-6b7d-4e58-9c21-8d4f0b7a5e63`** | 资料页渲染的是 `profile.displayId`（`app/(mobile)/settings/page.tsx:77`、`components/mine/ProfileCard.tsx:47`）；`lib/types/user.ts:22` 注释：「`displayId` 是平台给用户看的 ID（原型「ID: xxxx」那一行）」 |
| 因此用户**永远看不到** `u-1001`，客服**永远看不到** `displayId` | 两侧对同一个人引用的是两个不同的字符串 |
| 而权威注释写明 `displayId` 存在的理由正是**这个**场景 | `lib/types/user.ts:37`：`AdminUserSummary` 带 `displayId`，因为「**客服页面报单号时用它对人**」 |
| 既有客服 DTO 是**故意**不带 `displayId` 的 | `lib/constants/staffRefunds.ts:208`、`lib/constants/staffComplaints.ts:279`：「客服端**没有**平台展示 ID 这一路」、「`StaffUserSummary` **没有** `displayId`，因此客服端的关键词搜索不含平台展示 ID」 |
| **管理端**同一功能的做法恰好相反：搜索与展示用的都是 `displayId` | `lib/services/adminOrders.ts:217` 传给同一个共享匹配函数的就是 `user?.displayId`（而该函数的形参**就叫 `displayId`**）；`components/admin/AdminOrderTable.tsx:287` 列表里渲染的也是 `item.user.displayId`，旁边一句注释与客服列表**一字不差**：「它们是搜索命中的字段」 |

**结论**：`StaffUserSummary` 的形状（无 `displayId`）与 `cmd_p0-10.md` 的「平台 ID 搜索」在**功能目的上**对不上——
这**不是本轮实现的错误**（实现严格照抄了四个既有客服页面的口径），
而是**两条既有约定在本轮第一次正面相遇**：管理端约定「平台 ID = `displayId`」，
客服端约定「客服端没有 `displayId` 这一路」。**哪一条该让路，是产品裁定，不是实现选择。**

**因此 `cmd_p0-10.md` 第 12 行「用户昵称 / 平台 ID」搜索这一项，只满足了一半**：
按「订单号」「昵称」都完全可用；按**用户报出来的那串 ID** 搜不到。
这不是本轮引入的缺陷（会话 / 退款 / 投诉 / 完成材料四个客服页面同样如此），
但本轮是**第一次**把「按平台 ID 搜索」写进需求。

**为什么不在本轮自行决定**（协议 §九）：至少两个合理方案，且它们**改变权限与暴露面**：

| 方案 | 内容 | 代价 |
|---|---|---|
| A | 把客服端用户标识统一改成 `displayId` | 要同时改会话 / 退款 / 投诉 / 完成材料四个**已验收**轮次的 DTO，超出本批范围 |
| B | 只在订单列表 / 详情新增 `displayId` 并参与搜索 | 客服工作台内部出现两种「平台 ID」，正是本项目反复禁止的「两处规则不一致」 |
| C | 本轮保持现状（`id`），把缺口登记为遗留问题交后续轮次统一处理 | 需求第 12 行只满足一半，需要产品负责人明确接受 |

**本轮的处置**：按 C 完成实现（D4 的原文），**不擅自改任何 DTO 边界**，
并把这个问题作为**统一人工验收清单的第一条**交给产品负责人裁定。
（这与本轮 `02-decisions.md` §八「OPEN = none」不冲突：那说的是**开发开始前**十二项检查里没有 OPEN，
开发中发现的**新增**问题按协议 §九 走「问，而不是自己定」。）

### A9-10 两个记录在案的 NOTE（不影响本轮完成）

1. **`?mockEmpty=orders` 未接到客服订单列表**。该调试参数现在清空的是**管理端**订单列表；
   `staffRefunds` / `staffComplaints` 的先例是复用同一个 scope。本轮按「不扩大范围」未接，
   空态仍可用「搜一个不存在的关键词」验收。若要统一，接上既有 `orders` scope 即可，
   但那会同时改变管理端的行为，属于另一件事。
2. **`followup`**：`tests/platformConfig.test.mjs` 的偶发失败见 A9-3，与本轮无关但会挡住批次门禁。
   ✅ **它的根因已于 P0-12 查清并修掉**——见下方 A9-12。

### A9-12 ✅ **A9-3「偶发失败」的根因已查清并修复（P0-12，2026-09-25）**

A9-3 当时把它记成「一处与本轮无关的既有**不稳定**测试（记录，不修改）」，
`docs/03-dev/需求功能点进度表.md` 一类地方也一直按「偶发 / 不稳定」描述它。
**P0-12 的门禁上它真实红了一次**（实际 `.409Z` vs 期望 `.408Z`），于是被查到底：

**它不是不稳定，是一条本来就写错的断言。** `tests/platformConfig.test.mjs` 里那条断言
在**一次真实写入之前**取了基线 `baselineUpdatedAt`，却在**那次写入之后**拿旧基线去比较
「no-op 不刷新 `updatedAt`」。而写入按语义**就该**刷新时间戳——于是该断言
**只在「取基线」与「那次真实写入」落在同一毫秒里时才碰巧成立**：
空闲机器上运行快、容易落在同一毫秒 ⇒ 绿；满载跑法下被拉开 ⇒ 红。
**「偶发」的来源是毫秒级时钟精度，不是竞态。**

- 该文件对批次 baseline `3fbae62` 的 diff 当时是**空的**，因此**不是** P0-12 的回归，属 **P0-9 遗留**。
- 修法是**把基线取在那次真实写入之后**，命题（「no-op 不刷新 `updatedAt`」）**一个字没改**——
  是**修好一条写错的断言，不是放宽**。P0-12 的第二轮 reviewer 独立复核确认了这一点。
- 详见 `docs/03-dev/rounds/P0-12/03-delivery.md` §3.3。

⚠️ **教训**：把它记成「偶发」让它安全地活了三个轮次，并两次挡在批次门禁上。
「偶发」是一个**待查的结论**，不是一个可以长期挂账的分类。

### A9-11 ✅ **A9-9 已由产品负责人裁定（2026-09-25）：选方案 B，并限定在 `/staff/orders`**

**裁定原文**（照录）：

> P0-10 人工验收前还有一项需要修正：
> Prompt 要求支持「用户昵称 / 平台 ID 搜索」。
> 如果当前只能搜索内部 `u-1001`，而用户资料页实际展示的是 `displayId`，则不满足该需求。
> 请在不扩展业务范围的情况下，让 `/staff/orders` 搜索同时支持用户实际展示的 `displayId`，并补相应测试。

**执行口径**

| 项 | 决定 |
|---|---|
| 选哪个方案 | **B**（在 §A9-9 的三选一里）——**只**给客服**订单**列表 / 详情补上 `displayId`，并让它参与关键词搜索 |
| 范围 | **仅 `/staff/orders`**。会话 / 退款 / 投诉 / 完成材料四个客服页面**一个字不改**（「不扩展业务范围」） |
| 「同时支持」的含义 | 既有 `u-1001` 这类内部标识**继续可搜**（不替换、不迁移）；`displayId` 是**新增的一路** |
| 是否改 DTO 边界 | **要**，理由见下 |

**为什么必须动 DTO，而不是只在搜索里偷偷匹配**

`displayId` 若不进客服订单的用户摘要，客服搜到那一行后**仍然看不到**它是谁——
行里显示的仍是 `u-1001`，用户报的那串 UUID 在界面上依然无处对应，「用人」这件事还是没有完成
（`lib/types/user.ts:37` 写明 `displayId` 存在的理由正是「**客服页面报单号时用它对人**」）。
因此 `displayId` 必须**既参与匹配、也可展示**。

**⚠️ 残留不一致（登记，不在本轮范围）**

A9-9 对方案 B 提出的反对意见——「客服工作台内部会出现两种『平台 ID』，
正是本项目反复禁止的『两处规则不一致』」——是**真实存在的**：改完之后 `/staff/orders` 有 `displayId`，
而会话 / 退款 / 投诉 / 完成材料四页**没有**。产品负责人**已权衡并选择 B**，该意见**不推翻裁定**，
但它作为**遗留项登记**（见 `04-acceptance.md` 遗留表），交后续轮次决定是否统一。
**本轮不顺手改那四个页面**（「不扩展业务范围」），也不因此把它们标成有缺陷。

**对验收清单 A0 的影响**：A0 由「⚠️ 待产品裁定」变为「✅ 已裁定、已修」，
验收动作从「裁定要不要修」变成「验一下真的搜得到了」。
