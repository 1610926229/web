# P1-1 — 交付记录

Round: P1-1 · 管理员首页经营概览 + 待办聚合
**Status: `AWAITING_ACCEPTANCE`**
Round Status: 编码与自动门禁已完成，等待产品负责人人工验收
Development Completed At: 2026-09-27
Review: 第一轮见 §4；**R6 fix 之后的第二轮见 §8.4**
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**）
Git Commit: `—`（⚠️ 本批次**禁止任何 Git 写操作**，此栏留空是该时点的正确状态）

> ⚠️ **`P0-14` 仍停在 `AWAITING_ACCEPTANCE`，本轮不改变它。** 本文件只记录 `P1-1`。

---

## §1 本轮做了什么（一句话）

把 `/admin` 从「入口页」升级为**管理后台经营首页**：首屏给出「今日订单 / 今日 GMV / 今日退款」
三个经营数字与「待办申请 / 待办退款 / 待办投诉」三个待办数字，外加指向**真实模块**的快捷入口；
原有 7 张「全量累计」卡一片没少，只是被归到「申请与护航规模（全量累计）」标题之下。

**本轮零写入**：不审批、不退款、不换人、不封禁、不改任何状态。

---

## §2 落点

### 2.1 新增文件

| 文件 | 作用 |
|---|---|
| `lib/constants/adminDashboard.ts` | **经营口径的唯一真值源**：业务日键 `beijingDateKey`、今日订单 / GMV / 退款三个纯函数、全部文案与跳转地址。⚠️ R6 之后它**不再持有待办的状态集合与计数**——那两项分别落在三个领域文件里（见 §8.2），本文件只留「怎么算」 |
| `lib/services/adminDashboard.ts` | `getAdminDashboard()`：四次并发只读取数 → 纯函数 → `AdminDashboardDTO`；承载 `?mockError` / `?mockEmpty=dashboard` |
| `app/api/admin/dashboard/route.ts` | `GET /api/admin/dashboard`：`requireAdmin()` → 转发服务层。**统计逻辑一行都不在这个文件里** |
| `components/admin/AdminDashboardBoard.tsx` | 客户端组件：渲染「今日经营 / 当前待办」两段；持有 `ready / loading / error` 三态与 `refresh()` |
| `components/admin/AdminQuickEntries.tsx` | 服务端组件：渲染快捷入口网格（清单来自 `ADMIN_DASHBOARD_QUICK_ENTRIES`） |
| `tests/adminDashboard.test.mjs` | **47 条**（今日口径纯函数 1–17 · 待办口径与筛选解析 18–23 · 服务接线与 DTO 24–32 · UI 与源码探针 33–39 · HTTP 契约 40–42 · **R6 卡==列表 43–47**） |

### 2.2 修改文件

| 文件 | 改了什么 |
|---|---|
| `app/admin/(console)/(overview)/page.tsx` | **重写**：`Promise.all([getAdminDashboard, getAdminOverview])`，四段结构 |
| `app/admin/(console)/(overview)/loading.tsx` | **重写**：骨架改成与新四段布局同形（3 + 3 + 6 + 4×7） |
| `lib/constants/admin.ts` | 改写 `ADMIN_OVERVIEW_NOTICE`（说清「今日」与「全量累计」两件事）；新增 `ADMIN_OVERVIEW_CUMULATIVE_TITLE` |
| `lib/types/admin.ts` | 新增 `AdminDashboardDTO`（**只加类型，不改既有 DTO**） |
| `lib/services/adminHttp.ts` | 新增 `fetchAdminDashboard()`（一行的薄封装） |
| `lib/mocks/debug.ts` | `MockEmptyScope` 加 `"dashboard"` + `SCOPE_VALUES` 同步登记 |
| `tests/admin.test.mjs` | 管理端路由清单门禁：`dashboard/route.ts` 入列（标题 `+ 经营首页一件`） |
| `docs/02-tech-design/api-contract.md` | 接口总数 135 → 136（`admin` 62 → 63）；新增 §12.7 经营首页（1 条）与 DTO 最小化行 |

### 2.3 **没有**碰的东西（逐条声明，可 `git status` 对拍）

- ❌ `lib/data/**` 既有仓储的**语义**零改动（只**新增调用**读取方法，没有新增 Repository）；
- ❌ `lib/services/adminConsole.ts`（既有「全量累计」）零改动——累计那一段**行为逐字不变**；
- ❌ 任何 `OrderStatus` / 退款状态机 / 派单状态机 / 售后规则；
- ❌ `P0-14` 的任何实现与测试（它仍在 `AWAITING_ACCEPTANCE`）。

---

## §3 门禁读数

### 3.1 第一轮（R6 裁定之前，保留原文不改写）

**全部读数均取自「reviewer 回报之后、全部改动落盘之后」的最后一次复跑**（`pnpm typecheck` 会先
`next typegen`，因此 `PageProps` / `LayoutProps` 一类全局类型在跑之前已生成）。

| 步骤 | 命令 | 读数 |
|---|---|---|
| 1 · targeted | `node --test tests/adminDashboard.test.mjs` | **41 tests · 38 pass · 0 fail · 3 skipped**（3 条 HTTP 用例因未设 `APP_BASE_URL` 而跳过，是预期的） |
| 2 · 全量单测 | `pnpm test` | **1487 tests · 1328 pass · 0 fail · 159 skipped** |
| 3 · 类型 | `pnpm typecheck` | exit 0（`Types generated successfully`，`tsc --noEmit` 无输出） |
| 4 · Lint | `pnpm lint` | exit 0（`eslint` 无输出） |
| 5 · 构建 | `pnpm build` | exit 0（Turbopack 生产构建，路由表正常输出） |
| 6 · 生产全量 | `APP_BASE_URL=http://localhost:3217 pnpm test` | **1487 tests · 1487 pass · 0 fail · 0 skipped** |
| 7 · 生产定向复核 | `APP_BASE_URL=http://localhost:3217 node --test tests/adminDashboard.test.mjs` | **41 / 41 pass / 0 fail / 0 skipped**；经营 39 / 40 / 41 **三条均实跑通过**（耗时 484ms / 822ms / 6ms），不是静默跳过 |

**终态核对（指令 §十四）**：`fail = 0` ✅ · `production skipped = 0` ✅ · `BLOCKER = 0` ✅ · `MAJOR = 0` ✅。

> ⚠️ 第 6 步的 `skipped = 0` 是**真的**，不只是计数器为 0：第 7 步单独复跑了那三条 HTTP 用例，
> 用它们的**实际耗时**证明它们确实执行了（跳过会显示 `﹣` 加跳过原因，不显示毫秒数）。
> 这一条专门回应 reviewer 的 NOTE n2（那三条用例在 `ENABLE_MOCK_ADMIN` 未开时会静默通过）。

生产服务按 PID 结束后，`netstat -ano | grep LISTENING | grep :3217` 已确认为空
（`TaskStop` 在 Windows 上杀不干净子进程，因此用 `taskkill //PID <pid> //T //F` 并回验端口）。

### 3.2 R6 fix 之后（**最终复跑**，本批次交付读数）

顺序与指令一致：targeted → `pnpm test` → `typecheck` → `lint` → `build` → 生产全量。
**全部读数都取自「第二轮 reviewer 回报、全部修复落盘之后」的最后一次复跑。**

| 步骤 | 命令 | 读数 |
|---|---|---|
| 1 · targeted | `node --test tests/adminDashboard.test.mjs tests/staff.test.mjs tests/admin.test.mjs` | **136 tests · 117 pass · 0 fail · 19 skipped** |
| 1b · 定向（含 HTTP） | 同上三条，`APP_BASE_URL=http://localhost:3217` | 全跑通过，见第 6 步的单文件复核 |
| 2 · 全量单测 | `pnpm test` | **1494 tests · 1335 pass · 0 fail · 159 skipped** |
| 3 · 类型 | `pnpm typecheck` | exit 0（`Types generated successfully`，`tsc --noEmit` 无输出） |
| 4 · Lint | `pnpm lint` | exit 0（`eslint` 无输出） |
| 5 · 构建 | `pnpm build` | exit 0（Turbopack 生产构建，路由表正常输出） |
| 6 · 生产全量 | `APP_BASE_URL=http://localhost:3217 pnpm test` | **1494 tests · 1494 pass · 0 fail · 0 skipped** |
| 7 · 生产定向复核 | `APP_BASE_URL=http://localhost:3217 node --test tests/adminDashboard.test.mjs` | **47 / 47 pass · 0 fail · 0 skipped**；经营 40 / 41 实跑 **890ms / 1663ms**，43–47 均显示真实耗时 |

**终态核对**：`fail = 0` ✅ · `production skipped = 0` ✅ · `BLOCKER = 0` ✅ · `MAJOR = 0` ✅。

**干净 store 的实测对拍**（在 `pnpm test` 跑之前、刚启动的生产实例上采集——HTTP 用例会改
那份内存 store，**跑完再量就不是干净值了**）：

```text
dashboard DTO pending        = {"applications":2,"refunds":4,"complaints":3}
?status=open  total          = {"applications":2,"refunds":4,"complaints":3}   ← 与卡片逐项相等
?status=pending  total       = {"applications":1,"refunds":3,"complaints":1}   ← 三域都严格更少
```

> ⚠️ 上一版档案里记的是 `{申请 2, 退款 3, 投诉 3}` / `pending {申请 1, 退款 2, 投诉 0}`——
> 那是**已经在同一实例上跑过 HTTP 用例之后**的读数（用例会往 store 里真的建退款、推进状态）。
> 已按干净 store 重新采集并更正（见 §8.5）。**不变量本身在两份读数上都成立**，错的只是数字。

---

## §4 只读审查（reviewer）

`reviewer-agent` 只读审查，**未改任何文件、未做任何 Git 写操作**，且已核对工作区里 `P0-14`
的改动与 `P1-1` 在**文件层面可分辨**、未混入本轮结论。

**结论：0 BLOCKER · 2 MAJOR · 4 MINOR · 6 NOTE。两条 MAJOR 均已修掉，MINOR 四条全部处置，
NOTE 六条逐条登记。** 复跑读数见 §3。

### 4.1 MAJOR（2 条，均已修）

| # | 结论 | 处置 |
|---|---|---|
| **M1** | 一条**每天必然变红约 5 小时 20 分**的测试 | **已修** |
| **M2** | 三张「当前待办」卡上的数字与它点进去的列表**对不上**（实测 2/4/3 → 1/3/1） | **部分修复 + 登记后续项**（见 4.3，**需产品复核**） |

**M1 —— 时间炸弹测试（已修）**

原 `经营 23` 用 `assert.equal(real.metrics.todayOrderCount > 0, true)`，前提是「预置数据里今天必然有单」。
reviewer 读源码定位出前提不成立的窗口并**实跑验证**（把 `seedNow` 换成模拟启动时刻）：

- `lib/mocks/fixtures/orderSeed.ts` 里三条「今日」排行订单的 `completedAt` 被 `clampToPeriod` 钳在
  `now - 1ms` 之前，且 `paidAt = completedAt − COMPLETION_LEAD_MINUTES(320min)`；
- 因此进程在**北京时间 00:00:00 ~ 05:19:59** 启动时，`paidAt` 一律落到**昨天** ⇒ 今天 0 单；
- 实测：北京 01:00 → `{todayOrderCount: 0}`；北京 04:00 → `{0}`；北京 05:21 → `{3}`（恢复）。

修法：**不再依赖预置数据**，改成先用该文件已有的 `placeOrderToday()` 自造一单今天的订单，
再断言 `real.metrics.todayOrderCount > 0`，并在用例里写清 `COMPLETION_LEAD_MINUTES = 320` /
北京 05:20 的根因链。（另两条反向断言 `pending` 与 `businessDate` 本来就不随时刻变化，未动。）

**M2 —— 卡片与落点不一致（部分修复，**需产品复核**）**

> ⚠️ **本节已被 R6 裁定推翻并改正，保留原文不改写。** 下面的「披露式处置」（不改三个列表的查询契约、
> 只在 hint 里说明「点进去是子集」）已由产品负责人在 `cmd_p1-1.md` §六 明确否决——
> 判据是「**卡片上的数就是点进去能看到多少条**」。完整裁定与落地见 **§8**。
> 原文中「第 1 条越出本轮范围、会造出第二份『未终态』的实现」这段判断是**错的**：
> 给查询层加一个虚拟筛选值 `open`、并让每个领域只定义一次 `OPEN_*_STATUSES`，
> 恰恰是**消除**重复定义的做法，而不是制造第二份实现。

事实（reviewer 实测）：三张待办卡数的是**多状态之和**（申请 `pending+reviewing`、退款
`pending+reviewing`、投诉 `pending+processing`），而链接写的是**单值** `?status=pending`；
三个列表页的 `status` 是**精确匹配的单值枚举**，所以点进去必然更少。

reviewer 给出两个修法并**明确把选择权留给 Coordinator**。本轮的选择是**第 2 条**，理由如下：

- 第 1 条（给三个列表加「未终态」筛选别名 `status=open`）是**唯一能让两者相等**的改法，
  但要同时改**三个别的模块**的：筛选值联合类型、`readAdmin*StatusFilter` 解析、仓储查询签名
  （当前是 `status: X | null` 单值）、非法值报错文案、以及它们各自的测试。这**越出本轮
  「只读 Dashboard」的范围**（指令 §六 / §七），并且会在项目里造出**第二份「未终态」的实现**——
  正是 §七 点名禁止的「复制既有业务规则」。
- 因此本轮**不动那三个模块的查询契约**，改为**不让卡片假装两者相等**：
  - 三条 hint 各自补上「列表默认只筛「待审核」一档」/「待处理」一档
    （`ADMIN_DASHBOARD_PENDING_HINTS`），管理员点进去看到筛选栏就知道自己在看子集；
  - 在 `ADMIN_DASHBOARD_PENDING_HINTS` 上写了一段**长注释**记录这个判断与代价；
  - 「未终态筛选别名」**登记为后续项**（见 4.2 m4 同级的登记区）。

⚠️ **这一条请产品负责人复核**：如果要求「卡片数字与列表条数必须相等」，那就需要**另开一批**
去给申请 / 退款 / 投诉三个列表加「未终态」筛选别名；本轮按「只读 Dashboard、不扩散到三个模块」
的范围做了披露式处置，**没有**把口径改小、也**没有**改那三个列表的行为。

### 4.2 MINOR（4 条）与 NOTE（6 条）

**MINOR —— 四条全部处置（不是记录后放行）**

| # | 结论 | 处置 |
|---|---|---|
| **m1** | 两处面向管理员的文案带着 Markdown `**`，经 `<p>{…}</p>` 直出会显示成四个字面星号 | **已修**：`ADMIN_DASHBOARD_REFUND_NOTICE` 与 `ADMIN_OVERVIEW_NOTICE` 改用「」强调，并在两处常量上各加一条「本串由 `<p>{…}</p>` 原样渲染，React 不解析 Markdown」的注释 |
| **m2** | 注释声称「卡的提示文案里说明了」，而提示文案并没有；且 `/admin/refunds` 默认筛 `pending` | **已修**：`ADMIN_DASHBOARD_REFUNDS_HREF` 改为 `/admin/refunds?status=all`，注释重写（说明默认筛是 `pending`、说明为什么不能落到它上面），`todayRefundAmount` 的 hint 补上「退款列表没有日期维度，对不上这个数是正常的」。**并补了一条测试**（见下） |
| **m3** | 口径文案说「两类 / 两个来源」，实际有**三条**执行路径 | **已修**：`computeTodayRefundAmount` 的文档注释重写成「三条执行路径，两个取数通道」表格，逐条点名三个写入点（`adminRefundTransaction.ts` / `directRefundTransaction.ts` / `companionDispatchTransaction.ts`）；面向管理员的文案也补齐三条路径 |
| **m4** | 全量扫描式取数在真实 DB 下会变成「为算 3 个数字扫三张全表」 | **仅登记，本轮不改**（见下方登记区） |

> **m2 的补充测试**：`经营 37` 新增断言时**不比对字符串常量**，而是把地址里的 `status`
> 解出来喂给**退款列表自己的解析函数**（`isAdminRefundStatusFilter` / `readAdminRefundStatusFilter`
> / `DEFAULT_ADMIN_REFUND_STATUS_FILTER`）。理由：常量表与地址栏各写一遍 `"all"` 是**两份实现**，
> 改了一处另一处不会报错，只会让这张卡悄悄跳到一个 400 上。同时断言它**不等于**默认筛选值——
> 把「一张『今天已退出去多少钱』的卡不能落到『待审核申请』列表上」这句判断钉进测试。

**NOTE —— 六条逐条登记**

| # | 结论 | 处置 |
|---|---|---|
| **n1** | Round 档案缺 `03-delivery.md`；`README.md` 的 `Status:` 仍是 `PLANNED`，而全局进度表已写「已交付」 | **已修**：`03-delivery.md` 即本文件；`README.md` 状态改为 `AWAITING_ACCEPTANCE` 并补状态沿革行（在门禁与 reviewer 真正跑完之后才改，reviewer 指出的「『已交付』早于门禁」这一点已按事实纠正） |
| **n2** | 三条 HTTP 权限用例在未开 `ENABLE_MOCK_ADMIN` 时会**静默通过** | **登记，未改代码**（见下方说明）。已用**非机密键名**核对 `.env.local`：`ENABLE_MOCK_ADMIN=true` / `ENABLE_MOCK_AUTH=true` / `ENABLE_MOCK_DEBUG=true` / `ENABLE_MOCK_PAYMENT=true` / `ENABLE_MOCK_STAFF=true`；并在 §3 第 7 步用**实际耗时**证明那三条确实执行了 |
| **n3** | `getAdminDashboard` 内部取时钟，无可注入的 `at`，因此测试只能做增量断言，理论上有极窄的跨午夜窗口 | **登记**。对「纯读快照」这是必要的（「今天」就是查询时刻），且与 `adminConsole` 的既有写法一致，不算缺陷 |
| **n4** | `?mockEmpty=dashboard` 在四次取数**之后**才判定 | **登记**。与 `lib/mocks/debug.ts` 的既有套路一致，只影响调试时的延迟，**不影响任何数字** |
| **n5** | `ADMIN_DASHBOARD_QUICK_ENTRIES` 在**模块加载期**构造并抛错，同一模块也被客户端组件引用 | **登记**。抛错是刻意的（静默丢一项只会让首页悄悄少一个入口）；已记录「将来改 `ADMIN_NAV_ITEMS` 时要先动这里」 |
| **n6** | `ADMIN_DASHBOARD_TODAY_ORDERS_HREF` 的落点口径正确，但**这层一致性靠 `createdAt === paidAt` 恰好相等支撑**，不是结构性保证 | **已修（注释）**：在 `ADMIN_DASHBOARD_TODAY_ORDERS_HREF` 上写清这层依赖——列表筛 `createdAt`、本卡算 `paidAt`、当前两个建单点用同一个 `at` 写这两个字段；并点名「将来若出现『先建单、后支付成功』的模型，届时必须同步改这里的跳转口径」。原注释只说了时区同口径，没点出字段这层 |

**登记区（本轮明确不改，留给后续批次）**

1. **M2 的根治**：给申请 / 退款 / 投诉三个列表加「未终态」筛选别名，让待办卡的数字与列表条数相等。
   ✅ **产品负责人已裁定「要改」**（`cmd_p1-1.md` §六 R6），并已在本轮落地——见 **§8**。
   这一项**不再是后续项**。
2. **m4 的迁移项**：把 `getAdminDashboard` 的三次全量读改成**仓储层聚合**
   （`countOrdersByPaidDate` / `sumGmvByPaidDate` / `sumRefundEventsByDate`），把「今天的口径」作为
   参数**下推**而不是把数据**上拉**。Mock 阶段正确，换真实 DB 前必须做。
3. **n3 的可测性**：若将来要求「钉住业务日」的测试，需要给 `getAdminDashboard` 加一个可注入的
   `at`（本轮不加，因为它是纯读快照）。

### 4.3 一句话总结这次审查

**数没有算错。** reviewer 按指令逐条**实跑**验证了最难的三项（今日退款的三条来源、
同单多次退款不重复、GMV 不倒扣），并做了**独立重算对拍**（不复用实现，按事件 + 按订单差额两条
路径重算 → `{todayOrderCount:3, todayGmv:25200, todayRefund:40840}` 与 DTO **完全一致**），
还验证了 44 张订单上「`refundedAt` 有值 ⇒ `refundedAmount === actualPaidAmount`」的不变式
**0 处破裂**。两条 MAJOR 一条是**测试的脆弱性**（已修）、一条是**卡片与落点的表达不一致**
（当时按「披露式处置」登记，**随后被 R6 裁定推翻并改为真正修掉**——见 §8.1），都不是计算缺陷。
BLOCKER 为 0。

---

## §5 口径实现对照（逐条回应指令 §三 / §四 / §五）

| 指令要求 | 实现落点 | 关键判断 |
|---|---|---|
| 今日订单数 = 业务日内**支付成功**订单数，以显式 `paidAt` 为准 | `computeTodayOrderMetrics()` | 判据是 `isOnBusinessDate(order.paidAt, businessDate)`；**不按状态过滤**——今天支付、今天退款的单**仍算今天** |
| **不得**计入预览 / 支付尝试 / 未成单 | 同上 | 数据源是 `getPaymentRepository().listAllOrders()`（**已形成的订单**）；预览与支付尝试根本不在这张表里 |
| 今日 GMV = 今日订单 `actualPaidAmount` 之和 | `computeTodayOrderMetrics()` | 与订单数**同一个循环、同一个谓词** ⇒ 两者必然来自同一批订单 |
| **退款不倒扣** / 不用原价 / 不用打手或平台收益 / 整数分 | 同上 | 只累加 `actualPaidAmount`；**全程不读** `refundedAmount`、不读 `companionBaseIncome`、不读 `clubNetIncome` |
| 今日退款金额 = 今天**实际执行**的退款之和 | `computeTodayRefundAmount()` | **三条执行路径、两个取数通道**（详见 `api-contract.md` §2.12 前的说明）：① 售后审核通过（`decision.refundAmount` 按 `decision.decidedAt`）② 用户直接全额退款（订单 `refundedAt`）③ **公共池超时自动全额退款**（`companionDispatchTransaction.ts`，同样只写订单侧） |
| 按**退款事件时间**归属，不是原订单日期 | `isOnBusinessDate(event.at, …)` / `isOnBusinessDate(order.refundedAt, …)` | 两个来源都用**各自的事件时刻**，没有一处用 `order.paidAt` 归日 |
| 涵盖直退全额 / 售后部分 / 售后全额 | 见 §5.1 | 三条路径逐条有用例（经营 9 / 10 / 11） |
| 同单多次部分退款**按当日累加** | 逐 `RefundRequest` 累加 | 一笔申请 = 一个事件；跨日各归各日（经营 12 / 15） |
| **必须不得用 `Order.refundedAmount`** | `DashboardOrderFact` 这个 `Pick` 里**根本没有** `refundedAmount` 字段 | 结构上不可读——不是「约定不读」，是**类型里没有** |
| 业务日边界与项目既有口径一致、抽成可测纯函数、不得两套实现 | `beijingDateKey()` **复用 `formatDateTime`** | 全仓唯一的时区实现（固定 UTC+8，不用 `Intl`）；与管理端订单列表的日期筛选**同一个口径** |
| 待办 = 尚未终态且仍需 Admin 动作 | 三个领域各自的 **`OPEN_*_STATUSES`**：`OPEN_APPLICATION_STATUSES`（`adminApplications.ts`）/ `OPEN_REFUND_STATUSES`（`refunds.ts`）/ `OPEN_COMPLAINT_STATUSES`（`complaints.ts`） | 三条都取自**既有枚举**，`satisfies` 保证不发明新状态（经营 23 用源码提取 + deepEqual 钉住「`adminDashboard.ts` 里没有第二套」） |
| 退款待办**排除**已通过 / 已拒绝 / 已关闭 | 同上 | 未终态集合是 `pending` / `reviewing` |
| 只聚合已确权归管理员的项 | 计数**直接取三个列表服务的 `total`**（`queryAdminApplicationList` / `queryAdminRefundList` / `queryAdminComplaintList`） | R6 起**不再自己重数一遍**：重数会与列表的口径分家（例如退款列表会丢掉找不到订单的退款），于是又变成「卡上 4 条、列表 3 条」 |
| 只做聚合 / 展示 / 跳转 | `page.tsx` + `AdminDashboardBoard.tsx` + `AdminQuickEntries.tsx` | 首页上**没有**任何会写数据的按钮（经营 39 是源码探针） |
| 架构：浏览器 → `*Http.ts` → Route → 新 Service → Repository | `fetchAdminDashboard()` → `route.ts` → `adminDashboard.ts` → 四个既有仓储 | 页面走 Server Component 直连 Service 的既有写法 |
| **禁止**：页面碰 mock store / 统计逻辑在 Route / 第二套仓储 / 复制业务规则 | 同上 | `lib/mocks/*` 只在**服务层**被引用；Route 只有守卫 + 转发；零新增 Repository |
| DTO 最小化 + 精确 key 测试 | `AdminDashboardDTO` | 经营 25 用**集合相等**断言（不是「不含某几个」）；经营 26 钉住无订单对象 / 用户 / 游戏账号 / 备注 / 分账快照 |
| 权限：匿名 / 用户 / 打手 / 客服**全拒**、Admin 放行、复用既有鉴权 | `requireAdmin()`（`lib/api/adminRoute.ts`） | 经营 40 是 HTTP 级四条拒绝，经营 41 是**正例**（Admin 200 且页面与接口同数） |
| UI：loading / error / retry / 正常空态；全 0 **不整页空态** | `loading.tsx` + `error.tsx` + `AdminDashboardBoard` 的局部三态 | 经营 35 钉住「不整页空态」；经营 36 钉住三态；经营 34 钉住「首屏不在浏览器里再取一次」 |
| 快捷入口**只指向真实存在的模块** | `dashboardQuickEntry()` 从 `ADMIN_NAV_ITEMS` 取，取不到**直接抛错** | 经营 37 逐项校验目标页面**真实存在**（`hasAppFile`），不是硬编码字符串比对 |
| 待办卡的落点必须是**卡上那个数**能筛出来的那一档（**R6 裁定**） | 三张卡一律跳 `?status=open`，`open` 在查询层解析为该领域的 `OPEN_*_STATUSES` | 经营 43 三域逐一断言「卡 == 列表」；经营 44 用「新来一条 + 推进到审核中」证明 `open` 与 `pending` 是**两个不同的数**；经营 45–47 钉住单状态与 `all` 的既有语义未回归 |

### 5.1 五条退款路径的逐条覆盖（本轮最容易出错的一格）

| 路径 | 数据长什么样 | 归日依据 | 用例 |
|---|---|---|---|
| 直接全额退款（`paid` / `accepted`，免审批） | **不写** `RefundRequest`，只写订单 `refundedAt` | `order.refundedAt` | 经营 9 |
| 售后审核通过 —— **部分**退款 | 一条 `RefundRequest{status: approved, decision}` | `decision.decidedAt` | 经营 10 |
| 售后审核通过 —— **全额**退满 | 同上 **且** 订单也写了 `refundedAt` | `decision.decidedAt`（**不**再加订单那一次） | 经营 11 |
| 同单**多次**部分退款 | 多条 `approved` 申请 | 各自 `decidedAt` | 经营 12 |
| 跨日部分退款 → 今天直退余款 | 历史申请 + 今天 `refundedAt` | 今天只算**差额**（`actualPaidAmount − Σ已通过`） | 经营 15 |

> ⚠️ **第 3 行是本轮唯一一处真正的「重复计数」陷阱**：售后退满时 `applyOrderRefund`
> **也会**写 `order.refundedAt`，因此「有 `refundedAt` = 一次直退」是**错的**。
> 判据必须是「这张单有没有已通过的退款申请」，差额为 0 就说明整单是售后退满的、已由第一类算过。

---

## §6 明确**没有**做的事

与 `01-prompt.md` §六 / §十三 逐条对齐：

- ❌ **趋势图** · **DAU** · **留存** · **复购** · **LTV** · **用户画像** · **打手画像**（§十三）；
- ❌ **WebSocket / 实时刷新**：首页只有「刷新数据」这个手动入口；
- ❌ **数据仓库 / 真数据库 / Scheduler**：本轮只读 Mock 仓储；
- ❌ **提现 / 钱包 / 会员**；
- ❌ **`P0-14` 的聊天 retention**（产品 `TBD`，明文 `DEFER`）——本轮**一个字都没碰**；
- ❌ **任何新的售后处置规则**：待办只是**数**已有的状态，不改任何处置口径；
- ❌ **任何写入路径**：首页没有审批、退款、换人、回池、封禁、改申请状态、改商品；
- ❌ **`P1-2`**：~~未开始。~~ → **留痕：`P1-1` 交付时点确实未开始；`P1-2` 已在此之后单独开轮**
  （`docs/03-dev/rounds/P1-2/`，2026-09-27，停在 `AWAITING_ACCEPTANCE`）。
  ⚠️ 两份档案**互不改写**：`P1-1` 的读数、文件清单与结论一个字未动，
  上面这一句是**追注**，不是修改。

另有三处**本轮刻意不做**、登记在 `04-acceptance.md` §五 供产品复核：

1. 待办第三类的字段名用了 `pending.refunds` 而不是示例里的 `aftersales`（照项目命名风格）；
2. 「今日 GMV」卡的跳转与「今日订单」卡**同一个地址**（同一天筛选的订单列表就是 GMV 的明细）；
3. 「今日退款」卡的跳转**不带日期**（退款列表没有日期筛选），卡上**不假装**能重新数出同一个数。

---

## §7 Git 状态

本轮**未执行任何写操作**（`add` / `commit` / `push` / `reset` / `restore` / `checkout` /
`rebase` / `amend` **一律未执行**，协议 §二十 + 指令 §十五）。

交付时点的只读 `git status --short` 里，**属于 `P1-1` 的部分**：

```text
 M app/admin/(console)/(overview)/loading.tsx
 M app/admin/(console)/(overview)/page.tsx
 M docs/02-tech-design/api-contract.md
 M lib/constants/admin.ts
 M lib/mocks/debug.ts
 M lib/services/adminHttp.ts
 M lib/types/admin.ts
 M tests/admin.test.mjs
?? app/api/admin/dashboard/
?? components/admin/AdminDashboardBoard.tsx
?? components/admin/AdminQuickEntries.tsx
?? docs/03-dev/rounds/P1-1/
?? lib/constants/adminDashboard.ts
?? lib/services/adminDashboard.ts
?? tests/adminDashboard.test.mjs
```

⚠️ 工作区里**同时存在 `P0-14` 的未提交改动**（它停在 `AWAITING_ACCEPTANCE`，用户尚未提交）。
**`P1-1` 不触碰 `P0-14` 的任何实现与测试，也不改它的状态。**
提交由**用户本人**完成。

**R6 追加的落点**（第二次指令之后，`git status --short` 里属于 `P1-1` 的 `M`）：

```text
 M app/admin/(console)/applications/(list)/page.tsx   ← 注释：?status=pending → ?status=open
 M components/admin/AdminApplicationTable.tsx         ← 角标走 applicationCountForFilter()；操作文案走 isOpenApplicationStatus()
 M components/admin/AdminComplaintTable.tsx           ← 操作文案走 isUnresolvedComplaintStatus()
 M components/admin/AdminRefundTable.tsx              ← 操作文案走 OPEN_REFUND_STATUSES
 M lib/constants/admin.ts                             ← 卡片的筛选地址类型放宽到「含虚拟值 open」
 M lib/constants/adminApplications.ts                 ← applicationCountForFilter() / isOpenApplicationStatus()
 M lib/constants/adminComplaints.ts                   ← 投诉筛选值 → 状态集合
 M lib/constants/adminRefunds.ts                      ← 退款筛选值 → 状态集合
 M lib/constants/complaints.ts                        ← OPEN_COMPLAINT_STATUSES（唯一定义处）
 M lib/constants/completions.ts                       ← isUnresolvedComplaintStatus() 指向该集合；注释按事实更正
 M lib/constants/refunds.ts                           ← OPEN_REFUND_STATUSES
 M lib/data/{complaint,refund}Repository.ts           ← 形参 status → statuses: readonly Status[] | null
 M lib/data/{companionApplication,mockComplaint,mockRefund,mockCompanionApplication}Repository.ts
 M lib/services/admin{CompanionApplications,Complaints,Refunds}.ts   ← 解析虚拟值 → 真实状态集合
 M lib/services/staffComplaints.ts · staffRefunds.ts   ← statuses 形参
 M lib/services/staffConversations.ts                  ← ⚠️ 见下
 M tests/{adminDashboard,staff,staffComplaints}.test.mjs
```

⚠️ **`lib/services/staffConversations.ts` 是唯一一个「两批改动同处一文件」的地方**：
它同时带着 `P0-14` 的「会话按订单合并」与本轮的 `statuses` 改名 + reviewer MAJOR 修复，
`git diff` 里交织在一起，按文件切不开。早先档案写的「P1-1 与 P0-14 完全按文件可分辨」
**不准确**，此处按事实更正。`docs/02-tech-design/api-contract.md` 同样被两批共用（契约文档本就如此）。
⇒ **按文件 `git add` 会把这两批改动一起带上**，如何处理留给产品负责人在验收时决定
（本轮禁止 Git 写操作，因此只报告、不动手）。

---

## §8 R6 裁定与验收前 fix（**第二次指令** `cmd_p1-1.md`）

### 8.1 裁定原文与它推翻了什么

指令 §六（逐字留存在 `01-prompt.md` 第二段）：

> Dashboard 数量必须与点击后的列表一致。

**被推翻的是我上一轮对 reviewer M2 的处置。** 上一轮我选择「不改三个列表的查询契约，
只在 hint 里说明『点进去是子集』」，并把「加别名」登记为需产品裁定的后续项。这个处置是**错的**，
并非因为文书上越权，而是因为它把**一个看得见的缺陷**（卡片说 4、点进去 3）换成了**一句免责声明**——
管理员在首页看到的数与他点进去能处理的条数仍然不一致，只是旁边多了一行小字说「本来就该不一致」。
判据应该是「卡上的数就是点进去能看到多少条」，而不是「我们解释过为什么不一致」。

原文里「第 1 条会造出第二份『未终态』的实现」这个判断也是**反的**：给查询层加一个虚拟值 `open`、
并让每个领域**只定义一次** `OPEN_*_STATUSES`，正是消除重复定义的做法。

### 8.2 落地：`open` 是一个**只在查询层存在**的虚拟值

| 领域 | 唯一状态集合 | 定义处 | 解析函数 |
|---|---|---|---|
| 入驻申请 | `OPEN_APPLICATION_STATUSES` | `lib/constants/adminApplications.ts` | `applicationStatusesForFilter("open")` |
| 退款 | `OPEN_REFUND_STATUSES`（**别名** `ACTIVE_REFUND_STATUSES`） | `lib/constants/refunds.ts` | `refundStatusesForFilter("open")` |
| 投诉 | `OPEN_COMPLAINT_STATUSES` | `lib/constants/complaints.ts` | `complaintStatusesForFilter("open")` |

硬约束（都已被测试钉住）：

- **`open` 不是领域状态**：不写进 store、不进状态机、不进 `OrderStatus` / `RefundStatus` / `ComplaintStatus` 联合
  （经营 22 断言它是查询层的虚拟值；经营 21 断言 `all` / 单状态语义未变）。
- **数据层看不见 `open`**：三个仓储的筛选形参是 `statuses: readonly <领域状态>[] | null`，
  `"open"` / `"all"` 在类型上**放不进去**；经营 22 另有源码探针断言六个数据层文件里搜不到这两个字面量
  （`grep -rn '"open"' lib/data/` 为空）。这是**结构性**保证，不是约定。
- **只有管理端有它**：客服端的筛选联合类型不含 `open`，`readStaffRefundStatusFilter("open")` 返回 `null` → 400。
  同一份服务层解析器，两端共用，但联合类型不同——因此没有「顺手把客服端也放宽」。
- **单状态语义一字不改**：`?status=pending` 仍精确匹配 `pending`（经营 45），
  非法值仍按既有契约拒绝（接口 400 / 页面收敛到默认筛选）。
- **可与关键词、分页叠加**（经营 46），**`all` 与 `open` 的区别就是「要不要终态」**（经营 47）。

### 8.3 三处关键取舍

1. **卡片的数直接取三个列表服务的 `total`，不再自己重数一遍。**
   这是 R6 的必然结论：只要卡片和列表**各算一次**，就还有第二次分家的机会。退款列表会
   **丢掉找不到订单的退款**（既有语义），所以「仓储全量重数」与「列表 total」本来就可能差一条——
   R6 之前那种差法只是碰巧没出现。现在只有一个来源。
2. **筛选栏角标复用 `applicationCountForFilter()`，不写 `counts["open"]`。**
   `open` 不是领域状态，`counts` 里根本没有这个键——直接取会读成 `undefined`，
   界面显示成「待处理（）」：一个不报错、只安静少一个数的错。（同时它也是 `tsc` 报错点，
   说明**类型系统在这个问题上帮了忙**：虚拟值放不进 `Record<领域状态, number>`。）
3. **操作文案也走同一组状态**（`isOpenApplicationStatus()` / `OPEN_REFUND_STATUSES` /
   `isUnresolvedComplaintStatus()`，见 §8.4 的 m1）。文案决定操作员要不要点进去，
   它和计数必须看同一组状态，否则「卡片算了它、列表筛得出它、操作列却写『查看详情』」。

### 8.4 第二轮只读审查（R6 fix 之后）

`reviewer-agent` 只读复审本次 R6 改动。**结论：0 BLOCKER · 1 MAJOR · 4 MINOR · 4 NOTE。**
reviewer 独立另起进程复算了核心不变量（卡片 == `?status=open` 列表 `total`、`open` 未泄漏进数据层、
客服端仍拒绝 `open`、单状态与 `all` 未回归、路由清单门禁已含 `dashboard`），**1 条 MAJOR 与 4 条 MINOR 已全部修完**。

**MAJOR（1 条，已修 + 红绿验证）**

| # | 结论 | 处置 |
|---|---|---|
| **M1** | `lib/services/staffConversations.ts` 的 `countPendingPlatformWork()` 里**还藏着第二份「未处理」状态集合**（`=== "pending" \|\| === "reviewing"` / `=== "pending" \|\| === "processing"`）——正是本次改动刚动过的那个函数 | **已修**：改为 `OPEN_REFUND_STATUSES.includes(...)` 与 `isUnresolvedComplaintStatus(...)`（后者同样指向 `OPEN_COMPLAINT_STATUSES`）；并在 `tests/staff.test.mjs` 补一条新用例 |

失败场景（reviewer 原文要点）：产品将来把某个新状态并入「待处理」，后台首页与
`?status=open` 列表都会算上它，而客服工作台顶部的数字不会——同一个业务问题出现两个数，
**且没有任何测试会失败**（`countPendingPlatformWork` 的两个字段此前**没有任何测试钉住**）。
今天两份取值相同，所以**当前不会出错**；这是纯粹的「下次改错」风险。

新用例（`tests/staff.test.mjs`）：① 正例——种子里有 1 条 `reviewing` 退款、2 条 `processing` 投诉，
所以断言 `4` / `3`（写死只数 `pending` 的实现会得到 `3` / `1`）；
② **源码探针**——`staffConversations.ts` 里不得再出现 `"reviewing"` / `"processing"` 字面量。

**MINOR（4 条，全部处置）**

| # | 结论 | 处置 |
|---|---|---|
| **m1** | `AdminApplicationTable` / `AdminRefundTable` / `AdminComplaintTable` 的行内操作文案又各写了一遍「未终态」字面量 | **已修**：分别改用 `isOpenApplicationStatus()`（**本次新增**的领域谓词，见下）/ `OPEN_REFUND_STATUSES.includes()` / `isUnresolvedComplaintStatus()`。新增的 `isOpenApplicationStatus()` 放在 `OPEN_APPLICATION_STATUSES` 旁边，写法对齐 `isActiveRefundStatus()`，判据只从集合来 |
| **m2** | `tests/adminDashboard.test.mjs` 的循环里，`complaints` 那一轮也在断言**退款域**的解析函数 | **已修**：按 `key` 选本域的 `*StatusesForFilter`。原写法不是恒真断言，但它把「投诉单状态解析」这个事实挂在退款域函数上，退款域改坏时会以「投诉测试失败」的名义报错 |
| **m3** | `lib/constants/completions.ts` 头注释仍写「没有任何运行时依赖」，但它已 `import { OPEN_COMPLAINT_STATUSES } from "./complaints"` | **已修**：注释改成「运行时依赖只有一个：`./complaints`」，并说明两者都是客户端安全模块、原结论不变 |
| **m4** | Round 归档与本轮 diff 不一致（`03-delivery.md` 称 `adminDashboard.ts` 是「状态集合与计数的唯一真值源」、引用了**已删除**的 `PENDING_*` 三个名字、测试写「41 条」、§2.1 分段与 §5 逐条编号自经营 23 起整体偏移一条；`需求功能点进度表.md` 的证据行与实际取数来源不符） | **已修**：本文件 §2.1 / §5 已按实际重写（47 条、正确的分段与编号、`OPEN_*` 三个名字、计数来源改为三个列表服务的 `total`）；进度表同步 |

**NOTE（4 条，逐条登记）**

| # | 结论 | 处置 |
|---|---|---|
| **n1** | `04-acceptance.md` 与 `02-decisions.md` 里的实测数字在**干净 store 上复现不出来**（记的是被 HTTP 用例改过的实例） | **已修**：在刚启动的生产实例上（跑任何 HTTP 用例**之前**）重新采集，见 §3.2 的对拍块；两份文档已更正为 `{2,4,3}` / `{1,3,1}` |
| **n2** | 今日订单卡（按 `paidAt`）与其目标列表（按 `createdAt`）的口径差 | **登记，本轮不改**：reviewer 自己核对了 `orderSeed.ts`——所有种子订单与结算创建路径都是 `createdAt === paidAt`，**今天不产生差异**；该卡的目标不是 `?status=open`，不在 R6 操作范围内 |
| **n3** | 经营 43/44 的判别性依赖种子构成（每个域至少有两个未终态状态）；若将来种子改成单一未终态状态，`openTotal > pendingTotal` 会变成**误报**而不是漏报 | **登记**：可考虑在测试内直接对 `OPEN_*_STATUSES` 断言「长度 ≥ 2 且不等于 `["pending"]`」，让意图不依赖数据。本轮按 NOTE 处理，未扩大改动 |
| **n4** | `?mockEmpty=dashboard`（`ENABLE_MOCK_DEBUG`）会把卡片清零而点进去的列表仍有数据 | **登记**：这是既有且被文档化的调试开关行为，不是缺陷；仅提示人工验收时**勿在开启该开关的实例上比对卡片与列表** |

reviewer 提出的一个**产品口径问题**（不替产品决定，登记在此）：客服工作台「待处理退款/投诉」
与后台首页待办卡**是否被要求为同一个数**。本轮的技术处置是**消除分叉的可能**——
两处改为取自同一组 `OPEN_*_STATUSES`；若产品要求两者在业务上分开，那必须是一次**显式**改动
（改其中一处的判据），而不再是「两处各写一份、悄悄漂移」。

### 8.5 红绿验证（本轮最重要的一课）

第一版的 R6 用例（经营 43–47）在**故意把 `refundStatusesForFilter("open")` 改坏**的变异下
**全部通过**，只有定义式的经营 19 变红。根因：**种子退款里没有 `reviewing`**，
于是 `open` 与 `pending` 数出来恰好都是 3 —— 每一条「两者相等」的断言都成了**恒真式**。

修法：经营 44 改为**先造一条退款、再推进到 `reviewing`**，然后断言
`openTotal > pendingTotal` **严格成立**；经营 43 对申请与投诉补同样的「open > pending」见证。
重跑同一变异：**经营 44 按设计变红**，随后还原源码并核对锚点行。

⇒ **教训：测试里「两个数相等」在数据恰好相等时是恒真式。** 判别性断言必须构造出
两个数**本该不同**的场景，否则它只是在复述实现。

本轮 MAJOR 的修复同样做了红绿：把 `staffConversations.ts` 变异回字面量后，
新用例的**源码探针**变红（计数断言不变红——因为今天两种写法的取值相同，
这恰恰证明了「只有探针能挡住第二份定义回来」）；还原后重新变绿。

### 8.6 兼容性

| 项 | 结论 |
|---|---|
| 单状态筛选 | **行为不变**（经营 45 断言 `?status=pending` 仍精确匹配 `pending`） |
| 非法 `status` | **契约不变**：接口按严格模式拒绝（400），页面按宽松模式收敛到默认筛选 |
| 客服端 | **不受影响**：`open` 不在客服端的筛选联合里，解析为 `null` → 400（未被放宽） |
| 仓储层 | 形参 `status` → `statuses`，**类型更严**（`readonly 领域状态[]｜null`）：`open` / `all` 放不进去 |
| 与关键词 / 分页的组合 | 正交（经营 46） |
| 既有列表页 | 三个列表页**没有**新增任何写路径；本轮仍未产生任何业务写入 |
