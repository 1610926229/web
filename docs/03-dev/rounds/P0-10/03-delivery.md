# P0-10 — 交付记录

Round: P0-10 · 客服全量订单查询工作台（`/staff/orders` + `/staff/orders/[id]`）
Status: `AWAITING_ACCEPTANCE`
Delivered At: 2026-09-24
原始指令: `01-prompt.md`（= `docs/03-dev/rounds/cmd_p0-10.md` 原样拷贝）
批次: `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md`（第一站：**P0-10** → P0-11 → P0-12 → P0-13）
Git: 本批次**禁止任何 Git 写操作**，因此本轮交付**未提交**，全部改动留在工作区（见 §十）。

---

## 一、本轮做了什么

`cmd_p0-10.md` 的每一节逐条对照：

| 指令（`cmd_p0-10.md`） | 落点 |
|---|---|
| 新增 `/staff/orders` 列表 + `/staff/orders/[id]` 详情 | `app/staff/(console)/orders/(list)/page.tsx` · `app/staff/(console)/orders/[id]/page.tsx` |
| Staff 导航新增「订单」入口 | `components/staff/StaffHeader.tsx`（`NAV_ITEMS` 第 2 位）· `app/staff/(console)/layout.tsx`（壳层注释同步） |
| 列表：搜索订单号 / 用户昵称 / 平台 ID / 商品名 | `lib/constants/orderFilters.ts` 的 `orderMatchesKeyword`（与后台**同一个**函数） |
| 列表：筛选状态 / 游戏 / 时间范围 | `resolveStaffOrderListQuery()` → `queryOrdersForAdmin()`（数据层） |
| 列表：分页、创建时间降序 + 稳定次级排序 | `buildStaffOrderListQuery()` + `compareOrdersByCreatedAt`（共享） |
| 详情：订单号 / 状态 / 用户 / 商品规格 / 增值服务 / 金额 / 当前打手 / Dispatch / Completion / Complaint / Refund 摘要 / `CompanionReleaseRecord` 历史 | `getStaffOrderDetail()` |
| Staff 独立 DTO（最小化，不暴露 Admin-only 财务字段） | `StaffOrderListItem` / `StaffOrderDetail` / `StaffOrderDispatchSummary`（`lib/constants/staff.ts` 的转换函数，**显式挑字段**） |
| 复用现有数据，**不创建第二套订单系统** | 零新增仓储方法：订单走 `queryOrdersForAdmin`，用户走 `getDataSource().findUserById()` |
| **不做**换打手 / re-pool（P0-11） | 未实现；服务层没有任何 `*Transaction` 处置依赖（见 §四 门禁） |
| **不做**退款 / 售后资金动作（P0-12 / P0-13） | 未实现 |
| **不做**任何**客服可触发**的订单状态变更 | 未实现；详见 `02-decisions.md` §九 **A9-4** |

### 1.1 本轮唯一的结构性取舍：`orderFilters.ts` 的**纯上移**

七个**与身份无关**的纯函数原先住在 `lib/constants/adminOrders.ts`。P0-10 需要同一套规则，
按 `architecture-rules.md` §十「无第二套实现」，把它们**上移**到新的
`lib/constants/orderFilters.ts`，并让 `adminOrders.ts` **按原名 re-export**——
因此**既有引用点一个都没改**，管理端行为逐字不变。

（为什么不能塞进 `lib/constants/orders.ts`：那个文件的文件头明令「不得出现任何运行时的 `import`」，
而 `orderBeijingDate` 依赖 `formatDateTime`。理由写在 `orderFilters.ts` 文件头。）

### 1.2 两个接口各挂一次**幂等的惰性物化**（`02-decisions.md` §九 A9-4）

`listOrdersForStaff()` 与 `getStaffOrderDetail()` 各自在**读仓储之前**调用
`sweepExpiredDispatches()` 与 `sweepCompletionAutoApprovals()`。

这不是新增的写路径，而是本项目在**读取路径上**的既有惯例。
⚠️ 两个 sweep 的调用方**不是同一批**，逐个数清楚（本轮之前 / 之后）：

| sweep | 本轮之前 | 本轮之后 |
|---|---|---|
| `sweepExpiredDispatches()`（派单超时） | 3 个文件 / 4 处：`adminOrders.ts` ×2、`orders.ts`、`companionDispatch.ts` | **4 个文件 / 6 处**（+ `staffOrders.ts` ×2） |
| `sweepCompletionAutoApprovals()`（完成材料到期） | 5 个文件 / 7 处：`adminOrders.ts` ×2、`orders.ts`、`companionOrders.ts`、`staffCompletions.ts` ×2、`companionEarnings.ts` | **6 个文件 / 10 处**（+ `staffOrders.ts` ×2） |

（`tests/completions.test.mjs` 的门禁 23 钉的是**后者的文件集合**，期望值 `5 → 6`，与上表一致。
⚠️ 该门禁只覆盖完成材料那一个 sweep：派单超时的调用方目前**没有同等门禁**，
本轮**没有顺手加**——那会是一处新的、与本轮无关的结构约束，登记为遗留观察。）

不挂的后果是具体的：客服会对着一条「公共池等待接单」的单去催一个**已经不存在的接单**，
而它按规则早已超时关闭。

`README.md` 与 `api-contract.md` 里原先「本轮不引入任何状态迁移路径」「纯读」的表述**已按事实更正**；
本轮的两条 `Requirement Check` 条目（#3 / #7 / #8）也因此被 A9-4 **取代**，理由与前后对照写在该条里。

---

## 二、本轮新增文件（9 个，**2453** 行）

> ⚠️ 行数为**复核整改之后**的最终值（整改前 2236）。差额来自 `tests/staffOrders.test.mjs`
> （659 → **875**，补 5 条 HTTP 用例与两处注释更正）与 `lib/services/staffOrders.ts`（409 → **410**，注释 +1 行）。

| 文件 | 行数 | 说明 |
|---|---|---|
| `app/api/staff/orders/route.ts` | 38 | `GET` 列表。`requireStaff()` 第一句，`export const dynamic = "force-dynamic"` |
| `app/api/staff/orders/[id]/route.ts` | 37 | `GET` 详情。订单不存在 → `404` `STAFF_ORDER_NOT_FOUND_MESSAGE` |
| `app/staff/(console)/orders/(list)/page.tsx` | 59 | 列表页。`(list)` 路由组**刻意存在**：详情目录下不能有 `loading.tsx`（见 §四 门禁） |
| `app/staff/(console)/orders/[id]/page.tsx` | 79 | 详情页。Server Component，直接调服务层（**不经** `staffHttp`） |
| `components/staff/StaffOrderTable.tsx` | 368 | 列表表格 + 筛选栏 + 分页。客户端组件，只通过 `fetchStaffOrders()` 取数 |
| `components/staff/StaffOrderDetailPanels.tsx` | 424 | 详情的七个只读区块。**纯展示**：无 `"use client"`、无取数、无金额计算 |
| `lib/services/staffOrders.ts` | 410 | 服务层。导出恰好 `resolveStaffOrderListQuery` / `listOrdersForStaff` / `getStaffOrderDetail` |
| `lib/constants/orderFilters.ts` | 163 | 七个与身份无关的纯函数（从 `adminOrders.ts` 上移） |
| `tests/staffOrders.test.mjs` | 875 | **22** 条用例（17 条服务层 + 5 条 HTTP），见 §四 |

未计入本表：`docs/03-dev/rounds/P0-10/`（本轮的五个档案）与批次的四个 `cmd_*.md`。

---

## 三、本轮修改的**共享文件**（8 个）

| 文件 | 增/删 | 本轮改了哪一段 |
|---|---|---|
| `lib/types/staff.ts` | +207 | 新增 `StaffOrderListItem` / `StaffOrderListData` / `StaffOrderDispatchSummary` / `StaffOrderDetail` 与两个请求类型。字段表的「刻意不含什么、为什么」写在各类型的注释里 |
| `lib/constants/staff.ts` | +186 | 新增订单状态筛选、错误文案、`buildStaffOrderListQuery`、三个 DTO 转换函数与派单摘要转换 |
| `lib/constants/adminOrders.ts` | −129 / +21 | **纯上移**：删掉七个本地实现，改为从 `orderFilters.ts` import 后按原名 re-export。`buildAdminOrderListQuery` 改调本地 import 的 `readOrderFilterDate`（**re-export 的名字不在模块作用域里**） |
| `lib/services/staffHttp.ts` | +56 | 新增 `fetchStaffOrders()`（列表页的浏览器出口）。**刻意不加** `fetchStaffOrderDetail()` + 一段「为什么详情不对称」的说明 |
| `app/staff/(console)/layout.tsx` | ±10 | 只改注释：原文写「客服**没有订单全量查询**」，本轮把它做出来了，那句话必须跟着改 |
| `components/staff/StaffHeader.tsx` | +7 | `NAV_ITEMS` 新增「订单」，**排在「工作台」之后、其余待办之前**（先看事实、再看待办） |
| `docs/02-tech-design/api-contract.md` | +31 | 接口数 `125 → 127`、staff `20 → 22`；§11 的 ⚠️ 段落改写为「客服端**没有任何可触发的处置路径**，唯一例外是两个读取路径上的惰性物化」 |
| `docs/02-tech-design/directory-structure.md` | +36 | 路由数 `125 → 127`；重测并刷新 `lib/` 各目录的 LOC 快照（2026-09-24 实测）；§4.2 的 `orderFilters` 条目补上「五类规则 / 七个函数」 |

`lib/data/**` 与 `lib/mocks/**`：**零改动**（已用 `git status --short` 核实）。
这是「本轮没有第二套订单读取实现」最直接的证据。

---

## 四、本轮修改的测试文件（**5** 个）

| 文件 | 改动 | 为什么这不是「放宽断言」 |
|---|---|---|
| `tests/staff.test.mjs` | ① 接口清单门禁登记两个新路由；② **修复一条本来就红的结构门禁**；③ 加固 loading 边界门禁 | 见 §4.1 / §4.2 |
| `tests/completions.test.mjs` | 门禁 23「自动审核清扫必须挂在全部读取路径上」的期望集合由 5 条改成 **6 条**（+ `staffOrders.ts`），标题 `五条 → 六条` | 这是**同批 manifest 登记**：本轮合法地新增了一个挂点，门禁的职责就是「不多不少」，因此必须同步登记。集合相等断言本身没有被削弱 |
| `tests/companionOrders.test.mjs` | 上一轮（P0-7）改写的两条断言的后续同步 | 见 §九（中间状态历史） |
| `tests/staffTableRefresh.test.mjs` | 与导航新增「订单」入口相关的刷新断言同步 | —— |
| `tests/staffReleaseHistory.test.mjs` | ⚠️ **复核整改（m4）**：「唯一转换点」门禁的调用方清单 `3 → 4`，补上 `staffOrders`（本轮新增的第四个调用方） | 这是**收紧**不是放宽：漏登记一个调用方，就有一个服务能自己拼退出历史条目而不被拦住。同批把 `lib/services/staffOrders.ts` 注释里的「三处不会出现三种口径」改为「四处……四种口径」 |

### 4.1 修掉的那条红门禁：`findAppFile` 会剥掉**路由组**，但只从候选路径上剥

原门禁写的是 `path.dirname(findAppFile("staff/orders/(list)/page.tsx"))`，报错
`app/ 下找不到 staff/orders/(list)/page.tsx（路由组已忽略…）`。

根因在 `tests/app-path.mjs`：`findAppFile(relative)` **只对文件系统上的候选路径**剥掉路由组段，
**不剥入参**。因此：

- `findAppFile("staff/orders/(list)/page.tsx")` **永远匹配不到任何东西**；
- `findAppFile("staff/orders/page.tsx")` 会解析到 `app/staff/(console)/orders/(list)/page.tsx`。

已改成按**路由**找（`findAppFile("staff/orders/page.tsx")`），并把这个事实写在测试注释里。

### 4.2 由同一个事实暴露出的**执行漏洞**，已加固

`findAppFile` 无法区分 `orders/page.tsx` 与 `orders/(list)/page.tsx`，因此原先「详情目录下没有
`loading.tsx`」的断言**可以靠把 `loading.tsx` 往上挪一层绕过**。已改写为**从详情目录一路走到 `app/`**：

```js
for (let dir = path.dirname(findAppFile(detailRoute)); ; dir = path.dirname(dir)) {
  assert.equal(readdirSync(dir).some((name) => /^loading\.(tsx|js)$/.test(name)), false, …);
  if (dir === APP_ROOT) break;
}
```

已核实 `app/`、`app/staff/`、`app/staff/(console)/` 三处都没有 `loading.tsx`。

### 4.3 新增 `tests/staffOrders.test.mjs`（**22** 条）

| 组 | 条 | 钉住的 |
|---|---|---|
| 解析 1–3 | 3 | 严格模式非法枚举 / 日期 / 区间一律 400；宽松模式回落默认；分页规范化；关键词**只去空白不截断** |
| 列表 1–6 | 6 | 创建时间降序**且三层比较真的发生**（把三张单的 `createdAt`/`paidAt` 写成同一值，断言按 id 升序）；三个筛选真实改变结果集；关键词命中四处；空关键词 = 不搜索；**翻页拼接 == 一次取回**；games 与当前筛选无关 |
| 详情 1–3 | 3 | 不存在返回 `null`；三个 DTO 的 **key 集合精确相等**（全集相等，不是「不含某几个」）+ 嵌套禁用字段扫描；「没有时」是 `null` / `[]` |
| 物化 1–2 | 2 | 见 §4.4 |
| 门禁 1–3 | 3 | 服务层的 `*Transaction` 依赖**恰好是两个惰性物化**；`staffHttp` 里没有无人调用的 `fetchStaffOrderDetail`；`app/staff/**/orders/**` 不 import `lib/data` |
| **HTTP 1–5** | **5** | 见 §七 §7.2——**复核整改补上的**，需要 `APP_BASE_URL`，没有则整组跳过 |

⚠️ 前 17 条只覆盖**服务层及以下**。「谁可以读」与 `null → 404` 都是**接口层**的规则
（服务层两个读函数连 `staffId` 参数都没有），**原理上测不到**——这个盲区由 §7.2 的 5 条补上。
⚠️ 计数类断言一律 **seed 无关**：先把自己的单筛出来，或用自洽式（`total === items.length`）；
`createdAt` / `paidAt` / `id` 三层比较那一条是**构造出来的**重值，不依赖 seed 里有几单。

### 4.4 物化 1–2 的**受控 mutation 复核**（交付方自己做，2026-09-24）

这两条是本轮最重要的一组：它们**不显式调用**两个 sweep，只读一次列表 / 详情，断言超时事实
已被物化。为证明它们不是空转，做了两轮受控 mutation（每次改完立即还原，`diff` 核对与备份逐字节相同）：

| Mutation | 结果 |
|---|---|
| 删掉 `staffOrders.ts` 里**全部 4 处** sweep 调用 | 物化 1 / 物化 2 **都变红**，其余 15 条仍绿 |
| 把 4 处 sweep **挪到读仓储之后**（列表挪到 `return` 前、详情挪到 `Promise.all` 之后） | 物化 1 / 物化 2 **都变红**，其余 15 条仍绿 |

第二种 mutation 是关键：源码字符串扫描挡不住「调用还在、但被挪到了读之后」，
而这两条行为用例挡得住。

---

## 五、本轮**刻意不做**的事

| 不做 | 归属 |
|---|---|
| 换打手 / re-pool / Staff 直接指定新打手 | P0-11 |
| 退款 / 售后资金动作 / Admin 最终退款金额 | P0-12 / P0-13 |
| 任何客服可触发的订单状态变更 | 本轮边界（`cmd_p0-10.md` L16） |
| 第二套 Order / Refund / Notification / Auth / 复杂 Assignment | 永久约束 |
| 真 Scheduler | 上线前阻塞项，非本轮遗漏 |
| 提现 / 负余额 / 会计总账 | 批次外 |

---

## 六、门禁结果（2026-09-24）

命令按 `cmd_p0-10.md` L19 与批次文件规定的顺序执行。
⚠️ 下表的读数是**复核整改之后**的最终读数（整改前的旧读数见 §九）。

| 门禁 | 命令 | 读数 | 结论 |
|---|---|---|---|
| 目标测试 | `APP_BASE_URL=http://localhost:3105 node --import ./tests/alias-hook.mjs --test tests/staffOrders.test.mjs` | **22 / pass 22 / fail 0 / skipped 0** | ✅ |
| 全量测试 | `pnpm test` | tests **1278** / pass 1141 / fail 0 / skipped 137 | ✅ |
| 类型 | `pnpm typecheck`（= `next typegen && tsc --noEmit`） | `✓ Types generated successfully`，exit 0 | ✅ |
| Lint | `pnpm lint` | **0 error / 0 warning** | ✅ |
| 构建 | `pnpm build` | exit 0；路由表含 `ƒ /staff/orders` 与 `ƒ /staff/orders/[id]` | ✅ |
| **生产全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | tests **1278** / pass **1278** / fail **0** / skipped **0** | ✅ |

生产门禁的服务器是 `npx next start -p 3105`，每次都从**当次** `pnpm build` 的产物**重启**一个新实例：
整改前 **PID 30340** → 整改后 **PID 8128** → 最终复跑 **PID 9272**。
⚠️ 每次重启前都先 `taskkill` 旧实例并 `netstat -ano | grep :3105` **复核端口确实释放**，
否则会在旧进程上跑出一份看起来很绿的读数（这是本项目踩过的坑）。
⚠️ 上表读数是**最终复跑**（PID 9272）的，改完文档后**逐条重跑**，不是引用整改过程中的旧数字。
未登录 `GET /api/staff/orders` → **401**；带 `mock_staff_id=staff-1` → **200**。

`skipped 137 → 0`：那 137 条是 HTTP 套件，没有 `APP_BASE_URL` 时自动跳过；生产模式下全部真跑。

> ⚠️ `1273 → 1278`：复核整改新增了 5 条 HTTP 用例（`skipped` 同步 `132 → 137`，
> 因为不带 `APP_BASE_URL` 时它们正是被跳过的那 5 条）。生产模式下 `1278 / 1278` 全跑，无跳过。

---

## 七、reviewer 结论与整改

### 7.1 复核方式与结论

交付后由**只读 reviewer**（`reviewer-agent`，不持有任何写权限）对照
`docs/01-requirements/` 与 `architecture-rules.md` 复核本轮全部改动。

| 项 | 数量 |
|---|---|
| **BLOCKER** | **0** |
| **MAJOR** | **1** |
| MINOR | 4 |
| NOTE | 7 |

reviewer 自行在生产服务上**手工复验**过全部 HTTP 行为，确认**行为本身当前都是对的**——
唯一那条 MAJOR 是**回归保护缺失**，不是行为缺陷。按批次 §自动继续条件
（`reviewer BLOCKER=0 / MAJOR=0`），MAJOR 必须修完才能进入 P0-11。

### 7.2 MAJOR（1 条，已修）

**M1 — 两条新接口没有任何 HTTP 级权限 / 契约测试；`null → 404` 这条映射在全仓无覆盖。**
引 `app/api/staff/orders/[id]/route.ts:30-31`、`app/api/staff/orders/route.ts:30`、
`cmd_p0-10.md:19`（「至少覆盖：Staff 访问、未登录 / Non-Staff 拒绝、停用 Staff 拒绝 …… 详情 404」）。

reviewer 指出的两点都对，且第二点是我此前**没有意识到**的结构性缺口：

1. **权限是接口层的规则，服务层原理上测不到。** `lib/services/staffOrders.ts` 的两个读函数
   **都没有 `staffId` 参数**（这是刻意的，理由写在该文件 §文件头），它假设
   「能调到它的人已经过了守卫」。因此「谁可以读」**只存在于 `app/api/staff/orders/**` 里**——
   而此前那里零覆盖。
2. `null → 404` 是**接口层**决定的映射（服务层返回 `null` 是它的接口约定，不是 HTTP 语义）。
   我原来的 `详情 1` 只断言了服务层返回 `null`，**恰好停在 404 之前一步**。
3. 客服其余领域（会话 / 退款 / 投诉 / 完成材料 / 订单池）各自都有 HTTP 矩阵，
   **只有订单这一块缺**，而它恰是**唯一一处「全量查询」**——客服能读到任意用户的订单，
   这条边界的回归保护比别处更该有。

reviewer 另指出 `tests/staff.test.mjs:1311-1326` 的「守卫必须是第一步」子句写作
`if (readsBody !== -1)`，对这两个**纯 GET** 路由**恒不进入**。
⚠️ 这一条我复核后认为**不是缺口**：那个子句防的是「先解析请求体再鉴权」，
纯 GET 路由没有请求体可解析，该风险结构上不存在；而「必须有守卫」是**无条件**断言的，
没有落空。**因此不改门禁**，但把这个判断记录在此，免得下次有人当成漏洞去「修」。

**整改**：向 `tests/staffOrders.test.mjs` 追加 **§六 HTTP 契约（5 条，需要真实服务）**，
沿用 `tests/staffComplaints.test.mjs` 的 `BASE` / `SKIP_HTTP` / `staffLogin()` /
`requestWithCookie()` 骨架，逐条对应 reviewer 的清单：

| 条 | 覆盖 |
|---|---|
| HTTP 身份矩阵 | 两个接口 × 匿名 / 用户端 Cookie / 管理端 Cookie / 三种伪造客服 Cookie → **401**；`staff-3`（停用）/ `staff-4`（护航）/ `staff-5`（已移除）→ **403**；**对照组：`staff-1` → 200** |
| HTTP 404 | `/api/staff/orders/<不存在>` → **404** + `{error:{code:NOT_FOUND,message:STAFF_ORDER_NOT_FOUND_MESSAGE}}`（**用权威常量比对，不写字面量**）；页面同 URL → **404**（不是 200 空壳） |
| HTTP 405 | 两个接口 `POST` → **405**；且**订单不存在时也是 405**（方法闸先于资源存在性） |
| HTTP 400 | `status=NOPE` / `game=NoSuchGame` / `from>to` → **400**；对照组：`page=999999&pageSize=100000` → **200**（分页收敛不是 400） |
| HTTP 200 + DTO | 列表响应**文本**里不出现 `companionRateSnapshot` / `companionBaseIncome` / `platformIncome` / `clubNetIncome` / `gameAccountId` / `idempotencyKey` / `displayId`；详情无 `allowedActions`；`user` 的 key 集合**精确相等**；派单摘要 key 集合**精确相等** |

⚠️ 注意最后一条是断言在**响应体文本**上，不是解析后的对象上：只删字段不够，
**连字段名都不该出现在线上响应里**。

### 7.3 MAJOR 的**受控 mutation 复核**（交付方自己做，2026-09-24）

新增的 HTTP 用例同样做了受控 mutation——否则「新加了几条绿测试」本身不构成任何证据。
为让源码改动即时生效，mutation 跑在 `pnpm dev`（:3000）而不是生产构建上；
**基线先跑一遍全绿**，每次改完立即还原并 `diff` 核对与备份逐字节相同。

| Mutation | 结果 | 说明 |
|---|---|---|
| 删掉详情路由的 `if (!detail) throw new ApiError("NOT_FOUND", …)` | **HTTP 404 → 红**，其余 21 条仍绿 | 正是 M1 声称「全仓无覆盖」的那条映射。**精准命中，无连带** |
| 给 `toStaffUserSummary()` 多返回一个 `displayId` | **详情 2 → 红**、**HTTP 200 + DTO → 红**，其余 20 条仍绿 | 同时证明**服务层**与 **HTTP 层**两条 DTO 断言读的都是真实响应，不是巧合通过的桩 |

⚠️ **第三轮 mutation（删掉列表路由的 `await requireStaff()`）被安全策略拒绝执行**
（判定为「削弱鉴权控制」）。这个判断是对的，**我没有用任何方式绕过它**。
因此「身份矩阵真的在测守卫」这件事**不靠 mutation 证明**，而靠**成对断言**：
同一组里既有 401（六种非客服凭据）**又有 200（合法 `staff-1`）**——
若守卫失效，401 那一半必然变红；若路由不可达，200 那一半必然变红。两者同时为绿，
排除「恒 401」与「恒 200」两种空转。这套成对设计是本文件所有 HTTP 断言的共同形状
（404↔200、405↔200、400↔200 同理）。

还原核对：`grep -c MUTATION` 两处均为 **0**，两处 `diff` 均输出 `RESTORED-IDENTICAL`，
且还原后 5 条 HTTP 用例全部复绿。

### 7.4 MINOR（4 条，全部已修）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| m1 | `lib/constants/adminOrders.ts:8` / `:32-33` | 注释写「**六个**与身份无关的纯函数」，实际 re-export **七个**；又写「这**四条**规则」，与 `directory-structure.md` 的「五类规则（由七个函数实现）」不一致 | 改为「**七个**函数」/「这**四类**（由**七个**函数实现）」；并重写下面那段——原文说「筛选与排序的口径：状态、游戏、时间范围、关键词四类条件」留在这里，**但游戏 / 时间 / 关键词 / 排序已经搬走了**，原地只剩状态筛选与 DTO 转换。**这处比 reviewer 描述的更严重：它描述的是一个已经不存在的落点** |
| m2 | `lib/constants/staff.ts:116-122` | `STAFF_CONVERSATION_NOT_FOUND_MESSAGE` 的注释说「**客服只能访问有会话的订单**」——P0-10 之后**这句话已经是假的** | 重写：把「不可区分」这条规则**收窄到「会话」资源**，并明确写出 P0-10 之后客服**本来就该知道**订单存不存在（用户报订单号来问，必须查得到），订单侧 404 用的是 `STAFF_ORDER_NOT_FOUND_MESSAGE`。⚠️ 这是**修掉一句已经变成谎话的注释**，不是改行为 |
| m3 | `docs/02-tech-design/directory-structure.md` | 四处计数陈旧：`:16` components 121 / `:18` tests 51 / `:98` 28 个子目录、121 个 `.tsx` / `:231` 57 个测试文件；`:60` 的 `staff/(console)/` 树里缺 `completions` 与 `orders` | 按**实测**全部重算：components **132** `.tsx` / **26** 个子目录、tests **66** 个 `.test.mjs`；树里补上 `completions` 与 `orders`（全量订单查询，P0-10）。⚠️ `:63` 的 `127 个 route.ts（admin 62 · staff 22 …）` 本轮已经同步过，无需再改 |
| m4 | `tests/staffReleaseHistory.test.mjs:769` | 「唯一转换点」门禁登记了 3 个调用方，**漏掉本轮的 `staffOrders`** | 补为 **4** 个。⚠️ 这条门禁的清单**必须跟着调用方涨**：少登记一个，就有一个服务能自己拼退出历史条目而**不被拦住**——正是这条门禁存在的理由。同步把 `lib/services/staffOrders.ts` 注释里的「三处不会出现三种口径」改为「四处……四种口径」 |

### 7.5 另外自查出的一处（不在 reviewer 清单里）

- **`tests/staffOrders.test.mjs` 文件头曾断言「预置数据里没有属于 `u-1001` 的订单」——这是假的。**
  `lib/mocks/fixtures/orderSeed.ts` 里有 `ord-seed-1001-01` 等十余条。
  （我最初的 grep 用字面量 `"u-1001"` 去找，而订单 id 形如 `ord-seed-1001-NN`，因此漏掉。）
  断言当时已经改成 seed 无关的写法，但**注释留着就是给下一个人埋雷**。
  已改为「**有**属于 `u-1001` 的订单」+ 明确写出禁令：**不要用「按 `u-1001` 搜到几条」写死计数**，
  计数类断言一律先把自己的单筛出来，或写成自洽式。

### 7.6 NOTE（7 条）

reviewer 的 7 条 NOTE 属观察与建议，不构成交付阻塞。其中两条已被采纳：

- **NOTE 7（已采纳）**：建议验收时「把筛选条件改到只剩 1 条，再点页头刷新，确认筛选与结果**一起**重置」。
  已作为 **B13** 写进 `04-acceptance.md`——它测的是「状态与地址栏同步」这条容易被忽略的路径。
- **NOTE 4（已核对，无需改）**：`03-delivery.md` **没有**把 `staffHttp.ts` 说成「移除了死导出」；
  该文件本轮 diff 是**纯新增**（`git show HEAD:lib/services/staffHttp.ts | grep -c fetchStaffOrderDetail` = **0**，
  即它**从来没有存在过**）。误述出现在我交给 reviewer 的**提示词**里，不在交付文档里。

其余 5 条为风格与观察类，记录在案、本轮不逐条展开。

---

## 八、与文档的同步（本轮同时完成）

| 文档 | 同步了什么 |
|---|---|
| `docs/02-tech-design/api-contract.md` | 接口数 125→127、staff 20→22、§11 客服端段落 |
| `docs/02-tech-design/directory-structure.md` | 路由数、`lib/` 各目录 LOC 快照（重测）；⚠️ **复核整改（m3）**：components 121→**132**、子目录 28→**26**、tests 51/57→**66**、`staff/(console)/` 树补 `completions` 与 `orders` |
| `docs/03-dev/rounds/P0-10/README.md` | `Primary State Transition` 改写；两个 ❌ 条目补 ⚠️ 指向 A9-4 / A9-9；复核整改后的门禁读数与 reviewer 结论 |
| `docs/03-dev/rounds/P0-10/03-delivery.md` | 本文件；§七 由占位符填成 reviewer 结论与整改（§7.1–§7.6） |
| `docs/03-dev/rounds/P0-10/04-acceptance.md` | 复核整改后：新增 **B13**（筛选后点刷新，状态与地址栏一起重置）、`§三` 补一条已知限制、`§四` 挂 reviewer 结论指针 |
| `docs/03-dev/rounds/P0-10/02-decisions.md` | 追加 §九 **A9-4 ~ A9-10**（append-only） |
| `docs/03-dev/总需求进度表.md` | P0-10 行（含复核整改后的门禁读数 1278） |
| `docs/03-dev/rounds/README.md` | P0-10 行 |
| `CLAUDE.md` | ⚠️ **本项目指令文件里的事实表也跟着过期了**（P0-10 自己造成的）：Pages 78→**80**、API routes 125→**127**（staff 20→**22**）、Tests 65 files / 1255→**66 files / 1278 cases**。只改了这三行**计数**，**没有改任何一条指令**。若产品负责人不希望本批次动这个文件，`git checkout -- CLAUDE.md` 可整体撤回，不影响任何代码或测试 |

---

## 九、中间状态的历史（不覆盖）

按 `development-workflow.md`「追加历史、不覆盖历史」：

1. **本轮的 `Requirement Check` 曾写下三条与事实不符的结论**（#3「纯读，一行都不写」、#7、#8）。
   三条都被 `02-decisions.md` §九 **A9-4** **取代**——A9-4 保留在原处并写明「取代哪一条、为什么」，
   被取代的条目**没有删改**。
2. **`README.md` 与 `api-contract.md` 里「本轮不引入任何状态迁移路径」「纯读」的表述**已按事实更正，
   更正的**理由**写在 A9-4 里，不是悄悄改掉。
3. **`tests/staff.test.mjs` 里那条结构门禁本来就是红的**（`findAppFile` 的路由组事实）。
   它是本轮**之前**就存在的问题，本轮顺手修掉并加固，不是本轮引入的回归。
4. **`?mockEmpty=orders` 未接线**（`02-decisions.md` A9-10）：管理端同类页面有这条调试开关，
   客服订单页没有接。当前不影响任何业务行为，登记为 NOTE。
5. **`tests/platformConfig.test.mjs` 的偶发**（A9-3，非本轮引入）在本次全量跑中**未复现**。
   它可能挡住批次门禁，登记备查，本轮**不修**（不在范围内）。
6. **复核整改前的门禁读数（区间快照，不作废）**：`pnpm test` tests **1273** / pass 1141 /
   fail 0 / skipped **132**；生产 `APP_BASE_URL` **1273 / 1273** / fail 0 / skipped 0；
   生产服务器 PID **30340**。这些数字是**整改前**的真实状态，
   有意义的差别只有一个：**新增了 5 条 HTTP 用例**（`skipped 132 → 137`，生产模式下真跑）。
   其余读数逐字未变。
7. **`03-delivery.md` §七 曾是一个占位符**（「（见 §7.x，由只读 reviewer 复核后填写）」）。
   占位符本身是**当时正确的状态**——reviewer 还没跑完，**不能预填结论**。
   现在填的是 reviewer 的实际结论与随后做的整改。

---

## 十、本轮的 Git 状态

**本批次（P0-10 → P0-13）禁止任何 Git 写操作。** 因此：

- 本轮交付**没有提交**，全部改动留在工作区；
- 上面的「新增文件 / 修改文件」两张表就是 `git status --short` 在 2026-09-24 的读数；
- `README.md` 的 `Git Commit:` 字段**留空**——它只能由用户本人在提交后填写
  （「DONE 双门槛」第二条）。Claude **无权**自行标记 `DONE`。

---

## 十一、验收前整改 A0：`displayId` 参与搜索与展示（2026-09-25）

> 本节按「追加历史、不覆盖历史」写在 §七 之后——**§七 记录的是 reviewer 那一轮的结论，
> 当时 A9-9 还停在「等产品裁定」，§七 的读数与结论都**没有**被本节改写。**

### 11.1 触发

用户本人在验收前裁定 `02-decisions.md` §九 **A9-9**（三选一）选**方案 B**，
把「客服搜不到用户在资料页上看到的平台 ID」从**待裁定**变成**必须修**：

> 请在不扩展业务范围的情况下，让 `/staff/orders` 搜索同时支持用户实际展示的 `displayId`，并补相应测试。

**这是 A0 的整改，不是 P0-10 的返工**——§七 记录的实现与结论**仍然成立**；
A0 是那条实现**当时正确地**照抄了四个既有客服页面的口径之后，产品决定让路的那一条。

### 11.2 改了什么（3 个文件）

| 文件 | 改动 |
|---|---|
| `lib/types/staff.ts:285` | 新增 `StaffOrderUserSummary = StaffUserSummary & { displayId: string }`。**不**给 `StaffUserSummary` 加字段——那个类型被会话 / 退款 / 投诉 / 完成材料**四处共用**，给它加字段等于让那四处**同时**多出一个字段，正是产品裁定里「不扩展业务范围」要挡住的事 |
| `lib/services/staffOrders.ts:145-157`、`:320-325` | 列表与详情两处摘要都填 `displayId`；关键词匹配函数**多接一路**。`displayId` 查不到时回落成**空串**而**不是**编一个占位值——空串不参与匹配，因此「查不到」= 「搜不到」，不会伪造命中 |
| `components/staff/StaffOrderTable.tsx:325`、`StaffOrderDetailPanels.tsx:97` | 列表行与详情页**显示**平台 ID。⚠️ 只改搜索**是不够的**：客服搜到那一行后如果看不到它，用户报的那串 UUID 在界面上依然无处对应，「对人」这件事仍然没完成——这正是 `lib/types/user.ts:37` 写明 `displayId` 存在的理由 |

**没改的**：会话 / 退款 / 投诉 / 完成材料四个客服页面**一个字没动**。它们是 P0-10 **之前**
就交付并验收过的轮次，产品裁定只覆盖 `/staff/orders`。由此产生的
「客服工作台内部有两种『平台 ID』」是**已权衡后的范围选择**，A9-11 已把它登记为遗留项。

### 11.3 测试（`tests/staffOrders.test.mjs`，**22 条不变**）

⚠️ **本轮没有新增顶层用例，而是把断言钉进既有的两条**——因为 A0 修的是**既有用例
宣言覆盖、实际没盖住**的地方：

| 用例 | 追加的断言 |
|---|---|
| **列表 3**（`:311`，标题本来就写着「平台 ID」） | 先用 `getUserRepository().findUserById()` 取真实 `displayId`，并 `assert.notEqual(displayId, ORDER_USER)`——**先证明这两串标识确实是两个不同的值**，否则整条断言钉的是空串、绿得毫无意义。再断言：按 `displayId` 搜**搜得到**、命中集合**只由这一个用户构成**、且两串标识**指向同一个人** |
| **详情 2 / HTTP 200 的 DTO 边界**（`:541`、`:923`） | 键集合由 `["id","nickname","avatarUrl"]` 扩为 `["id","displayId","nickname","avatarUrl"]`，**精确相等**。⚠️ 这个改动是**故意的**：`:880` 的注释写明 `displayId` 「曾经在这张**不允许出现**的名单上」，2026-09-25 移出——**暴露面变了，边界断言必须跟着变**，否则门禁会继续按旧口径放行 |

### 11.4 门禁（整改后，2026-09-25）

| 门禁 | 读数 | 结论 |
|---|---|---|
| 目标测试 `tests/staffOrders.test.mjs` | **22 / 22**，fail 0 | ✅ |
| 全量 `pnpm test` | 与本批次最终读数一致（见 `docs/03-dev/rounds/README.md` P0-13 行） | ✅ |
| typecheck / lint / build | 全部 exit 0 | ✅ |
| 生产 `APP_BASE_URL` 全量 | **fail 0 / skipped 0** | ✅ |

> ⚠️ 表里**没有写具体条数**：本轮（P0-10→P0-13）最后是在同一棵树上跑的终局门禁，
> 把 P0-13 的读数抄到本节会让人以为这是 P0-10 整改当时的独立读数。
> 权威读数只有一处：`docs/03-dev/rounds/P0-13/03-delivery.md` §三。

### 11.5 对验收清单的影响

`04-acceptance.md` 的 **A0** 已由「⚠️ 待产品裁定」改写为「✅ 已裁定并已修复」，
验收动作从「裁定要不要修」变成「**验一下真的搜得到了**」：
输入用户资料页那串 UUID → 能搜到；输入旧的 `u-1001` → **仍然搜得到**（新增一路，不是替换）。
§五 遗留表第 1、9 条同时**划掉**，第 10 条改为「残留不一致，非缺陷，验收时不必报」。
