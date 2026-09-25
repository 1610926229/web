# P0-11 — 交付记录

Round: P0-11 · 客服换打手（re-pool / direct replace）+ 打手被禁用后的自动释放 + pending `CompletionSubmission` → `invalidated`
Status: **`AWAITING_ACCEPTANCE`**
Delivered At: 2026-09-24
原始指令: `01-prompt.md`（= `docs/03-dev/rounds/cmd_p0-11.md` 原样拷贝）
批次: `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md`（第二站：P0-10 → **P0-11** → P0-12 → P0-13）
Git: 本批次**禁止任何 Git 写操作**，因此本轮交付**未提交**，全部改动留在工作区（见 §十）。

> ⚠️ **本文件曾经是一份 `CLARIFYING` 状态的空档案**（原文写着「本轮**没有任何交付**」）。
> Q1 / Q2 于 2026-09-24 裁定后本轮开始开发，本文件已按事实**整篇重写**。
> `CLARIFYING` 期间**确实没有写过任何业务代码**——这句话仍然成立，不是事后修饰。

---

## 一、本轮做了什么

`cmd_p0-11.md` 的每一节逐条对照：

| 指令（`cmd_p0-11.md`） | 落点 |
|---|---|
| 释放原语：解除当前履约（订单 / 派单 / 绑定三处同段变） | `lib/data/companionOrderTransaction.ts` 的 `releaseCurrentAssignment`（**1 处定义、4 处调用**） |
| 客服「重新进入公共池」，原因必填，`accepted` / `serving` 均支持 | `POST /api/staff/orders/[id]/release` → `releaseStaffOrder` → `releaseOrderByStaff` |
| 客服「直接指定新打手」，**不需要管理员批准** | `POST /api/staff/orders/[id]/replace` → `replaceStaffOrderCompanion` → `replaceOrderCompanionByStaff` |
| 可指定的候选打手 | `GET /api/staff/orders/[id]/replace-candidates` → `listStaffOrderReplaceCandidates` |
| `serving` 单被退回：同段 `serving → paid` | `releaseCurrentAssignment` 不区分 `accepted` / `serving`（两条边都在状态表里，都走领域 Guard） |
| `servingAt` 的口径（**Q1 裁定**） | 释放写入器 `applyOrderAcceptanceReleased` 多写一个 `servingAt: null`；`applyOrderServing` 的 `servingAt ?? at` **保留** |
| 封禁护航 → 手上的单自动回池 | `setCompanionFlags` 的**同一原子区段**内调用同步的 `releaseOrdersForCompanion`（全量读 → 全量校验 → 全量写） |
| pending `CompletionSubmission` → `invalidated`（不删历史） | `invalidatePendingCompletionForOrder()` + 新写原语 `applyCompletionInvalidation()` |
| Staff 不得再 approve / reject 作废材料；auto sweep **永不** approve | 三条路径各自拒绝（`canTransitionCompletion` + 各自领域 Guard + sweep 白名单） |
| 多次换人 `A→B→C→public→D`，不设次数上限，每次留痕 | `CompanionReleaseRecord` 一次一条；`tests/staffOrderActions.test.mjs` 的「多次换人」用例跑完整链路 |
| 客服侧 UI：退回 / 换人 | `components/staff/StaffOrderActionsConsole.tsx`（详情页**唯一写入口**，完全按服务端 `allowedActions` 渲染） |
| **不做**退款 / 售后资金动作 | 未实现；`staffOrderActions.ts` 与事务文件里**没有任何** `refund*` / `earning*` 依赖（有门禁） |
| **不做**第二套 Order / Notification / Auth / 复杂 Assignment | 零新增仓储、零新增 `OrderStatus`、通知复用 `appendNotification` |
| **不做**任何 Git 写操作 | 见 §十 |

### 1.1 本轮唯一的结构性取舍：把**释放**收成一个原语，而不是四条路径

四件「解除当前履约」的事（打手取消接单 / 客服退回 / 客服换人 / 封禁回池）**共用**
`releaseCurrentAssignment`——写 `CompanionReleaseRecord` + 清订单绑定 + 派单回 public。
四条路径的**差别只在「谁触发、记什么 source、通知什么文案」**，那部分留在各自的调用点上。

这不是为了少写代码，是为了让「订单回到公共池」这件事**只有一份实现**：
四份实现里漏掉一处「清 `servingAt`」或「清 `actualCompanionId`」的组合，
症状是**某一种退回方式**留下一条脏数据，而另外三种是干净的。

⚠️ 与 P0-10 的 `orderFilters.ts` 上移不同：那一次是**纯搬移**（行为逐字不变），
这一次是**把三条新路径接到一个既有能力上**（打手取消那条路径的对外行为也不变）。

### 1.2 `serving → paid` 本轮**第一次**有入口（Q1 裁定的唯一落点）

`ORDER_TRANSITIONS` 里一直有这条边，但**零调用**——P0-9 的 **D14** 因此把它挂成 `DEFERRED`，
并写明「**任何轮次准备给 `serving → paid` 接入口之前**」必须裁定。本轮正是那个轮次，
裁定结果是「**改写为本次 assignment 的时刻**」，实现口径见 `02-decisions.md` §九 D-Q1：

| 写入器 | 改动 |
|---|---|
| `applyOrderAcceptanceReleased`（`lib/data/mockPaymentRepository.ts`） | **多写一行 `servingAt: null`**——释放之后「谁在给我做」是空的，那么「他什么时候开始做的」也必须是空的 |
| `applyOrderServing`（同文件） | **不动**，仍是 `order.servingAt ?? at`。保留 `??` 是防「状态还是 `accepted` 但 `servingAt` 已有值」的历史脏数据，不是 `servingAt` 的语义 |

⚠️ 这一处**只有两个写入器、共两行**，但它决定用户端时间轴、打手端「护航中」起始时间，
以及将来按实际服务时长做任何统计 / 结算的基准。E 段验收专门验它。

### 1.3 P0-9 **D15** 的解除：作废**没有**复用 `applyCompletionReview`

`P0-9/02-decisions.md` 的 D15 记着一条约束：未来的**作废**路径**不得直接复用**
`applyCompletionReview`——那个函数不校验起始状态、且 `pendingSubmissionIdByOrder`
索引只在它内部清除。作废需要一个**走中央状态机**、并**明确处理 pending 索引**的新入口。

本轮实现的正是那个新入口，并且把 D15 写进了代码注释（`mockCompletionRepository.ts`
的 `applyCompletionInvalidation` 文件头第一段就点名 D15）：

| 要求（D15） | `invalidatePendingCompletionForOrder` 的第几步 |
|---|---|
| 走中央状态机 | **第 3 步**：`canTransitionCompletion(submission.status, "invalidated")` |
| 明确处理 pending 索引 | **第 5 步**：`applyCompletionInvalidation` 内 `pendingSubmissionIdByOrder.delete(orderId)` |
| 复用的是新原语而不是 `applyCompletionReview` | **新函数 `applyCompletionInvalidation`**：只改 `status` + `invalidatedAt`，**审核人三个字段与 `rejectReason` 一律不动**（从未有人审过它，填一个值就是伪造） |

⚠️ **索引必须同段清**这件事不是洁癖：忘了清，「这一单已有一份待审」会**永远为真**，
新打手提交完成材料时会被 `submitCompletion` 的第 3 步永久挡住——
而这条路径**只有真的走一遍才看得出来**（H5 就是验它）。测试里有两条专门钉它。

---

## 二、本轮新增文件（**6** 个代码 / 测试 + **5** 个档案）

| 文件 | 行数 | 说明 |
|---|---|---|
| `app/api/staff/orders/[id]/release/route.ts` | 36 | `POST`。`requireStaff()` 第一句，`export const dynamic = "force-dynamic"` |
| `app/api/staff/orders/[id]/replace/route.ts` | 35 | `POST`。同上 |
| `app/api/staff/orders/[id]/replace-candidates/route.ts` | 36 | `GET`。同上 |
| `lib/services/staffOrderActions.ts` | 292 | 服务层三个入口 + 错误码映射。**零 `refund*` / `earning*` 依赖**（门禁 4）。MINOR-2 之后不再回读订单 |
| `components/staff/StaffOrderActionsConsole.tsx` | 351 | 详情页**唯一写入口**。完全按 `allowedActions` 渲染，不拿 `status` 自己写 `if` |
| `tests/staffOrderActions.test.mjs` | 1924 | **46 条用例**，见 §四 |
| `docs/03-dev/rounds/P0-11/01-prompt.md` | 54 | 指令原样拷贝 |
| `docs/03-dev/rounds/P0-11/02-decisions.md` | 516 | Requirement Check + Q1/Q2 裁定 + D1–D13 + §十二 待复核 + **§十三 reviewer 处置（追加）** |
| `docs/03-dev/rounds/P0-11/03-delivery.md` | 本文件 | —— |
| `docs/03-dev/rounds/P0-11/04-acceptance.md` | 299 | 人工验收清单（含 4 条待追认） |
| `docs/03-dev/rounds/P0-11/README.md` | 173 | 本轮索引 |

⚠️ **`app/staff/(console)/orders/**` 下的四个文件（`(list)/page.tsx`、`(list)/loading.tsx`、
`[id]/page.tsx`、`[id]/not-found.tsx`）是 P0-10 的新增文件**，不是本轮的——
本轮只**改了** `[id]/page.tsx` 一处（追加写操作区），见 §三。

---

## 三、本轮修改的**文件**（14 个本轮专属 + 6 个与 P0-10 共享）

> ⚠️ 工作区里同时躺着 **P0-10 与 P0-11** 两轮的未提交改动（批次禁止 Git 写操作）。
> 下表把「本轮专属」与「两轮共享」分开；共享文件上**哪些行属于哪一轮**无法在不写 Git 的前提下
> 逐行切分，因此共享文件只说明本轮改了哪一段，不给行数。

### 3.1 本轮专属（14 个，合计 **+1053 / −65**）

> ⚠️ 下表是**复核整改之后**重测的 `git diff --numstat 3fbae62` 读数（整改前合计 +984）。
> 增删只相对批次 baseline `3fbae62`，因此**含 P0-11 这一轮的全部改动**，就是下面这 14 个文件的和。

| 文件 | 增/删 | 本轮改了哪一段 |
|---|---|---|
| `lib/data/companionOrderTransaction.ts` | +497/−37 | 释放原语 `releaseCurrentAssignment`、客服两个入口 `releaseOrderByStaff` / `replaceOrderCompanionByStaff`、封禁批量 `releaseOrdersForCompanion`。**整个文件仍然零 `await`** |
| `lib/types/order.ts` | +127/−1 | `servingAt` 的语义说明；两个新写结果的类型 |
| `lib/data/completionTransaction.ts` | +124 | `inspectPendingCompletion`（唯一的只读判据）+ `invalidatePendingCompletionForOrder`（中央状态机 + 领域 Guard + pending 索引）+ **`canInvalidatePendingCompletionForOrder`（MINOR-1 的落点）** |
| `lib/constants/dispatch.ts` | +74/−3 | **3 条新通知常量**（合计 7 条）+ 它们各自的归属说明 |
| `lib/data/mockCompletionRepository.ts` | +54 | 新写原语 `applyCompletionInvalidation`（**文件头第一段点名 P0-9 的 D15**） |
| `lib/types/completion.ts` | +40/−2 | `invalidated` 相关的类型与字段说明 |
| `lib/data/adminCompanionTransaction.ts` | +32/−1 | 停用路径在同一原子区段内调用 `releaseOrdersForCompanion`（**排在 `applyCompanionFlags` 之前**，见下） |
| `tests/companionServing.test.mjs` | +27/−5 | 「开始 12」那条通知常量门禁由「四条、一条都不许长」改为「**逐条点名七条**」 |
| `lib/constants/completions.ts` | +18/−4 | `COMPLETION_TRANSITIONS.pending` 增加 `"invalidated"` + 触发点唯一的说明 |
| `lib/constants/orders.ts` | +17/−5 | TARGET 注释更正（原文说 `serving → paid`「本批次不实现、也不提供任何入口」——已不是事实） |
| `lib/data/mockPaymentRepository.ts` | +18 | `applyOrderAcceptanceReleased` 多写 `servingAt: null`（§1.2） |
| `lib/services/companionOrders.ts` | +11 | 打手侧入口同步 |
| `lib/types/companionRelease.ts` | +9/−7 | source 注释更正（原文说两个 source「尚未实现、也没有任何写入路径」——已不是事实） |
| `lib/services/adminCompanions.ts` | +5 | 停用联动同步 |

⚠️ `lib/services/staffOrderActions.ts` **不在这张表里**——它是本轮**新增**文件，登记在 §二。
（MINOR-2 之后它是 **292** 行，不再回读订单。）

⚠️ **`lib/mocks/**` 零改动**——本轮**没有**为了验收方便去动种子数据。
验收清单里的 `cp-4` / `cp-6` / `cp-7` 样本是**既有**的（`seed.ts` 的注释早已写明这三条按 id 写死）。

### 3.2 与 P0-10 共享的文件（6 个）

| 文件 | 本轮改了哪一段 |
|---|---|
| `tests/staff.test.mjs` | ① 客服接口清单门禁 `+3` 个地址（订单段由 2 个变 **5 个**），标题同步；② **详情页 `loading.tsx` 门禁扩到 `staff/orders/[id]`**——P0-10 为 `conversations` 写的那条逐级上溯断言，本轮把新详情路由也登记进去（漏登记 = 那条路由的 404 会悄悄退化成 200） |
| `lib/constants/staff.ts` | 本轮新增处置相关的文案、错误消息、两个 DTO 转换所需的常量 |
| `lib/types/staff.ts` | 新增 `StaffOrderAllowedActions` / `StaffOrderReplaceCandidate` / `StaffOrderReplaceCandidateListData` 等 |
| `tests/companionOrders.test.mjs` | ① §十一.23 的路由清单由 2 个只读地址扩到 **5 个**，并给三个新地址各加「只认一个方法」的断言；② 结构约束门禁：导出函数由 2 个扩到 **5 个**，`notYet` 禁令改为「每扇门各自带 Guard」的正面断言；③ `functionBody` 的边界由 `export async function` 改为**任意 `export`**（新来的 `releaseOrdersForCompanion` 是同步导出，旧边界会把它算进上一个函数） |
| `tests/completions.test.mjs` | 状态机一条：`pending` 出边由 2 条改 **3 条**（+ `invalidated`），标题与注释同步；三条出边全指向终态的那半**没有放宽** |
| `docs/02-tech-design/api-contract.md` | 接口数 `127 → 130`、staff `22 → 25`；§11 的 ⚠️ 段落重写（原文「客服端**没有任何客服可触发的处置路径**」已不成立），并明确「写的那三个写的是**当前履约绑定**，不是订单记录」 |
| `docs/02-tech-design/directory-structure.md` | 路由数 `127 → 130`；`lib/services/` 的 LOC 与文件数快照重测（68→69 / 14118→14488） |

### 3.3 从 D10 / D15 继承的四处**文档更正**（不是顺手改，是原文已不是事实）

| # | 位置 | 原文 | 现在 |
|---|---|---|---|
| 1 | `lib/constants/orders.ts` | `serving → paid`「本批次不实现、也不提供任何 API 或按钮」 | 本轮接通了，注释改写 |
| 2 | `lib/types/companionRelease.ts` | 另外两个 source「尚未实现、也没有任何写入路径」 | 三条 source 各自都有写入路径了 |
| 3 | `app/staff/(console)/layout.tsx`（P0-10 改过） | —— | P0-11 追加：处置能力的说明 |
| 4 | `docs/02-tech-design/database-schema.md` | `:802` 「指定新打手仍可后置」· `:812` 的 `TBD — DO NOT INVENT` 行 · `:790` 的 T4 最小映射只写「回 public」一条 | 按 Q2 裁定**收窄而非删除**（仍然禁止自行设计「完整的 Assignment / 指定改派模型」），见 §八 |

⚠️ **P0-9 的 `02-decisions.md` 是 append-only，本轮没有回填 D14 / D15。**
D14 的裁定记在**本轮** `02-decisions.md` §九 D-Q1，D15 的解除记在 §1.3 与代码注释里。
`P0-11/README.md` 的「权威依据」表已把这条路径写清楚。

---

## 四、本轮修改的测试文件（**6** 个，其中 1 个新增）

| 文件 | 改动 | 为什么这不是「放宽断言」 |
|---|---|---|
| `tests/staffOrderActions.test.mjs`（新） | **46 条**用例 | 见 §4.1 |
| `tests/staff.test.mjs` | 接口清单 `+3`；`loading.tsx` 门禁扩到新详情路由 | 清单门禁的职责就是「**不多不少**」，新增地址必须同步登记；扩 `loading.tsx` 是**收紧**（多一条路由被守住） |
| `tests/companionOrders.test.mjs` | 路由清单 2 → 5；导出函数 2 → 5；`notYet` 禁令 → 正面 Guard 断言；`functionBody` 边界改为任意 `export` | 见 §4.2，四处都是**换一条更精确的断言** |
| `tests/companionServing.test.mjs` | 「开始 12」的通知常量名册 4 → 7 | 见 §4.2 |
| `tests/completions.test.mjs` | 状态机：`pending` 出边 2 → 3 | 见 §4.2 |
| `tests/staffReleaseHistory.test.mjs` / `tests/staffTableRefresh.test.mjs` | P0-10 已登记的同步，本轮**未再改** | —— |

### 4.1 `tests/staffOrderActions.test.mjs`（**46** 条）

| 组 | 条 | 钉住的 |
|---|---|---|
| 零 前置 | 1 | cp-5 干净可接单 / cp-4 暂停接单 / cp-7 已下架——后面几组的地基 |
| 一 回池 | **5** | 原因必填；`serving → paid` 与 `accepted → paid` **五件事一次完成**；`paid` / `completed` 一律 400；订单不存在 404；**旧打手在释放后立刻失去全部操作权** |
| 二 换人 | **8** | 状态表里**没有** `serving → accepted` 而落点是 `serving → paid → accepted`；新 `acceptedAt`、清 `servingAt`、派单改绑且**不经过**公共池；四种 400 分得开（没人 / 人不存在 / 就是当前那位 / 状态不对）；暂停接单 / 已下架 / 已移除都不能被指定；不能指定给**下单用户本人**；`paid` / `completed` 不得被直换；**不需要管理员审批**（客服会话 + 裸请求体就够） |
| 三 候选 | 4 | 只装此刻能接单的人，且排除当前履约人与下单用户本人；在履约单数只算 `accepted` + `serving`；这一单不该有换人动作时**报错**而不是回空名单；全部护航都暂停时给的是「没有谁可以换」而不是「加载失败」 |
| 四 可用性 | **6** | `available: false`（暂停接单）**不**释放已有订单（EX-SERVICE-05）；**下架**必须释放全部 `accepted` / `serving` 且 `completed` 不动；下架通知**不透露平台对他做了什么**；某一单派单缺失 → **整次下架失败，标志位与退出历史一笔都不写**；释放原语对「手上没有在跑单」是空操作不是错误；**某一单的 pending 索引与记录对不上 → 整次下架在「校验阶段」就失败，第一单也不得被解除**（MINOR-1，见 §4.3） |
| 五 作废 | **6** | 释放时 pending 材料立刻失效且**记录保留**（只改状态）；**pending 索引一起清**（否则这一单永远提交不上新材料）；`invalidated` 既不可人工通过也不可驳回；**自动通过永远不得通过一份作废材料**（即使 deadline 早已过去）；新打手能提交**新的**材料，旧的留在历史里；**数据不自洽时释放与换人都映射成 500 且一笔都没写**（MINOR-3，见 §4.3） |
| 六 多次换人 | 1 | `A→B→C→回池→再接` 完整链路；三次换人各留一条、**一位不漏** |
| 七 `allowedActions` | 3 | 真值表（含「状态说有人在履约、字段却是空」这一格）；**界面不给按钮时接口也拒绝、给按钮时接口也接受**（两边同一条判据）；详情接口发出来的就是服务端算的那份，**不是前端推断** |
| 八 既有能力不回归 | 2 | 打手主动取消仍按**幂等键**工作；正常人工审核仍能把订单推到 `completed` 且**不写**退出历史 |
| 九 结构门禁 | 4 | ① 事务文件**零 `await`**；② 释放原语**只有一份定义、三条路径共用**；③ 三个新地址都**先 `requireStaff()` 再读请求体**；④ 释放路径**不碰金额**（不写退款、不改订单金额、不动打手收益） |
| 十 HTTP | **6** | 身份矩阵（401 / 403 成对）；`404` 与 `400`；**每个地址只认自己那一个方法**（且 405 发生在身份门**之前**——这条写下来是为了下一个人不会把 405 读成「没鉴权就放行了」）；`500` 文案不与 `400` 复用；**两条 HTTP 正例**（回池 / 换人真的改了数据，见 §4.3） |

**合计 46 条。** 前 **40** 条只覆盖**服务层及以下**；`404` / `401` / `403` / `405` 这几条规则
**只存在于接口层**（服务层三个入口里两个连订单存在性都要先问事务层），**原理上测不到**，
由第十组的 4 条补上——这也是本轮的 reviewer 复核重点（P0-10 的同类缺口曾被判 MAJOR）。
第十组**还要有正例**：只测「拒绝」那一半，权限矩阵就少一行（见 §4.3 的 MAJOR-1）。

### 4.2 四处既有门禁的改动，逐条说明「为什么是换而不是松」

**① `tests/companionOrders.test.mjs` 的路由清单（2 → 5）**
原文断言客服订单段**只有两个只读地址、一个写方法都没有**，理由是 P0-6 时「回池写入能力不导出」。
本轮按 `cmd_p0-11.md` 正式开了三个写入口，**那三个写的是「当前履约人」，不是订单记录**
（不改金额、不改商品、不写退款）。因此断言改成：逐条列出五个地址 + **两个只读的一个写方法都不许有**
+ **三个新地址各只认一个方法、且都不导出 `PATCH` / `PUT` / `DELETE`**。
后两条是**新增的**约束，不是把旧的删掉。

**② `tests/companionOrders.test.mjs` 的导出函数清单（2 → 5）+ `notYet` 禁令**
原文断言导出**恰好** `cancelAcceptedOrder` / `startCompanionOrder`，并断言
`companion_disabled` / `staff_reassign` **不得出现**（「还没有任何写入路径」）。
本轮这两扇门装上了，因此禁令换成**正面断言**：五个名字逐个列出、客服两个入口**各自**带
`order.status !== "accepted"` 的领域 Guard、封禁回池**必须是同步导出**（写 `async` 就是把原子性
交给调用方自觉），以及两个 source 字面**必须出现**（它们各自真的有一条写入路径了）。

**③ `tests/companionServing.test.mjs` 的通知常量名册（4 → 7）**
`.①`（start 路径不引用任何通知常量）**一个字没动**——那半不随时间放宽。
`.②`（名册）由「四条、一条都不许长大」改为**逐条点名七条并写出每条的主人**，
再加一条**新增**的断言：名册里**没有** `DISPATCH_NOTIFICATION_SERVING_STARTED`
（「开始服务仍然没有生命周期通知；要加必须先有产品确认」）。数字变大了，**边界反而更具体了**。

**④ `tests/completions.test.mjs` 的状态机（2 → 3 条出边）**
原文断言 `pending` 恰好两条出边。本轮给释放路径接了 `pending → invalidated`。
改法是：出边加一条 + 补一条 `canTransitionCompletion("pending","invalidated") === true`
+ 补一条 `invalidated → invalidated` **不是**可重入迁移。
「三条出边全指向终态、`invalidated` 没有回头路」这半**没有放宽**。

⚠️ **四处都不是「为了让测试变绿而放宽」。** 判据是：**把本轮的实现整体回滚，这四条会立刻变红**——
因为新期望值里的每一个字面（五个地址、五个函数名、七条常量、`invalidated`）
都只可能由本轮引入。

### 4.3 reviewer 复核后补的四条（42 → **46**）

| 补的用例 | 对治的复核结论 | 它钉住的 |
|---|---|---|
| **可用性 6** | MINOR-1（「全量校验」漏了一步） | 释放前的校验阶段必须**也问一遍「这一单的 pending 材料能否作废」**：把 `pendingSubmissionIdByOrder` 指到一个不存在的 submission，下架必须**在写第一单之前**报 `inconsistent`，且**第一单也不得被解除** |
| **作废 6** | MINOR-3（`inconsistent → 500` 只有实现、没有对外契约用例） | 数据不自洽时 `release` 与 `replace` **两条服务入口都映射成 500 文案**，且**一笔都没写**（`assertNothingWritten`） |
| **HTTP 正例（回池）** | MAJOR-1（三个新写接口没有 HTTP 正例） | `POST /api/staff/orders/[id]/release` **真的把订单退回公共池**——不是只回一个 200 |
| **HTTP 正例（换人）** | MAJOR-1（同上） | `POST /api/staff/orders/[id]/replace` **真的换成了指定的人**——新旧两人在候选名单里此消彼长 |

**两条正例怎么做到可重复跑的**：不碰任何种子订单，而是**用 HTTP 现场造一单**——
`POST /api/orders/pay` → `POST /api/payments/mock-confirm` → `GET /api/companion/dispatches`
→ 找到这一单的派单 → `POST /api/companion/dispatches/[id]/accept`。
拿到一单真的处于 `accepted`、真的绑着某位护航的订单之后，再让客服打过去。

**「真的改了」不靠接口自述**：写完**回读服务端只读接口**自证——
回池那条读 `allowedActions` 由 `{true,true}` 翻成 `{false,false}`（且候选名单转 400）；
换人那条读候选名单，**指定的人消失、原履约人出现**。

⚠️ **本轮最严重的一个缺陷是自查发现的，而且它曾经给出过假绿**：这两条正例最初写了一个
「支付通道关着就跳过」的探测（拿一个假 `paymentRequestId` 打 `mock-confirm`，404 就 `return`），
但**「支付通道关着」与「这个支付请求不存在」返回的都是 404**，
于是两条正例**每次都在探测处提前返回、一行断言都没执行**——连 `✔` 都是假的。
它是在**受控 mutation**（把两个路由的请求体换成 `{}`）第一次**没有变红**时暴露出来的；
人工 `curl` 确认那个 404 的文案是「支付请求不存在」（即支付通道其实是开着的），才定位到探测本身的逻辑错误。
**修法**：删掉探测，直接走真链路——支付通道真关着就让它在断言上炸出声，**不再有「静默跳过」这条出口**。

**两条正例各自咬得动的证据**（受控 mutation，每次改完都**重新 `build` 再重启**，
否则跑的是上一次构建的旧代码，读数无效）：

| 受控改动 | 预期 | 实测 |
|---|---|---|
| `release/route.ts` 传 `{}` 而非 `body` | **只有**回池正例变红 | `AssertionError: 回池必须成功：{"error":{"code":"BAD_REQUEST","message":"请填写退回公共池的原因"}}`，换人正例仍绿 |
| `replace/route.ts` 传 `{}` 而非 `body` | **只有**换人正例变红 | `AssertionError: …请选择要指定的护航`，回池正例仍绿 |

两次改动的现场**都已还原**，并以 `grep` 复核两个文件都仍是 `staff, body`。

---

## 五、本轮**刻意不做**的事

| 不做 | 归属 |
|---|---|
| 退款 / 售后资金动作 / Admin 最终退款金额 | P0-12 / P0-13 |
| 「移除（`removedAt`）」也释放当前履约 | **需求没有这条规则**，自行补 = 发明规则。登记为遗留（`02-decisions.md` §12.2-2） |
| 「重复停用」补扫在跑单 | 同上（R3） |
| 会话按 assignment 隔离（EX-SERVICE-04） | 今天不可达（打手端没有聊天面）。登记为遗留 |
| 第二套 Order / Refund / Notification / Auth / 复杂 Assignment | 永久约束 |
| 真 Scheduler | 上线前阻塞项，非本轮遗漏 |
| 提现 / 负余额 / 会计总账 | 批次外 |
| 顺手给「停用」的响应加 `releasedOrderIds` | 追溯已由每单的 `CompanionReleaseRecord` + 两个详情页满足。登记为 MINOR（§九） |

---

## 六、门禁结果（2026-09-24）

命令按 `cmd_p0-11.md` 与批次文件规定的顺序执行。

| # | 门禁 | 命令 | 读数 |
|---|---|---|---|
> ⚠️ 下面第 1 / 2 / 6 三行是**复核整改之后**重跑的读数（整改前的读数是 42 条用例 /
> 1320 用例 / skip 141；整改补了 4 条用例，全量基数因此变成 **1324**）。第 3–5 行同样在整改后重跑过。

| # | 门禁 | 命令 | 读数 |
|---|---|---|---|
| 1 | targeted tests | `node --import ./tests/alias-hook.mjs --test tests/staffOrderActions.test.mjs` | **46 / fail 0**（带 `APP_BASE_URL` 时；不带则 **42 / fail 0 / 4 skip**） |
| 2 | 全量测试（离线） | `pnpm test` | **1324 用例 / pass 1181 / fail 0 / skip 143** |
| 3 | 类型 | `next typegen && tsc --noEmit` | **exit 0** |
| 4 | lint | `pnpm lint` | **0 error / 0 warning** |
| 5 | 构建 | `pnpm build` | **exit 0**（Turbopack） |
| 6 | **生产 HTTP 全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **1324 / pass 1324 / fail 0 / skipped 0** |
| 7 | reviewer | 只读复核 | 见 §七 |

> 第 6 行是本轮**最重要的一行**：`skipped 0` 意味着 143 条 HTTP 用例全部**真的跑过**——
> 本轮的 6 条 HTTP 用例（身份矩阵 / 方法 / 404 与 400 / 500 文案 / **两条正例**）包含在内。
> 服务进程：`next start -p 3105`，**先 `netstat` 确认端口上没有上一次遗留的进程**再启动
> （停 `next start` 后端口不一定立刻释放，对着旧进程测会得到**旧代码的读数**）。
>
> ⚠️ 第 6 行读数是**离线全量（第 2 行）的镜像 + 143 条 HTTP**。第 2 行 skip 的 143 条
> 与第 6 行多出来的 143 条**是同一批**，因此 1324 = 1181 + 143 逐条对得上。

---

## 七、reviewer 结论与整改

本轮 reviewer 为只读复核，逐条对照 `docs/01-requirements` 与 `architecture-rules.md`。

**初判 BLOCKER 0 / MAJOR 2 / MINOR 4 / NOTE 2 → 整改后 0 / 0。**（同一行读数见 `04-acceptance.md` §五。）

| # | 判级 | 结论 | 处置 |
|---|---|---|---|
| **MAJOR-1** | MAJOR | 三个新写接口**没有任何 HTTP 正例**：「正常结果」那一格空着，而 `01-requirements/用户权限表.md` §十三第 8 条要求权限矩阵覆盖 **401 / 403 / 404 / 正常结果**四条 | **已补**：新增 **2 条 HTTP 正例**（真造一单 → 客服真的打过去 → 回读只读接口自证）。见 §4.3 |
| **MAJOR-2** | MAJOR | 本轮档案与计数**没有回填**：`需求功能点进度表.md` 仍把本轮的缺口写成未实现、`CLAUDE.md` / `api-contract.md` 的接口数仍是旧值 | **已补**：`需求功能点进度表.md` 新增 P0-11 行 + 缺口表 + 收口计划行；`CLAUDE.md` 改为 `130 route.ts（admin 62 · staff 25 · companion 8）` / `67 files, 1324 cases`；`api-contract.md` §11 改为 **25 条**并加扩充说明；`directory-structure.md` ⑤ 与 `总需求进度表.md` 的 P0-11 行同步 |
| **MINOR-1** | MINOR | `releaseOrdersForCompanion` 号称「全量校验」，但**漏了「作废 pending 材料」这一步**——它是写入循环里唯一可能失败的源，漏掉则第一单写完才发现第二单失败 | **已改**：把 `canInvalidatePendingCompletionForOrder` 提进第 2 步校验循环，并新增 **可用性 6** 钉住。见 §4.3 |
| **MINOR-2** | MINOR | `releaseStaffOrder` 成功后**回读订单**只为拿 `orderNo`，平白多出「写成功却报 404」的分支和两次 `await` 之间的中间态窗口 | **已改**：事务层的 `ok` 结果直接带上 `orderId` / `orderNo` / `releasedAt`，服务层不再回读；`releaseResult` 不再接收 `Order`，文件里那句 `import type { Order }` 一并删掉 |
| **MINOR-3** | MINOR | `inconsistent → 500` 这条映射**只有实现、没有对外契约用例**（`可用性 4` 测的是下架那条路径的原子性，不是接口的 500） | **已补**：新增 **作废 6**，两条服务入口都断言 500 文案 + `assertNothingWritten`。见 §4.3 |
| **MINOR-4** | MINOR | 三处注释**指向已不存在的事实**：`completionTransaction.ts` 文件头仍引用旧名 `writeAcceptanceRelease`、`StaffReleaseHistory.tsx` 的兜底理由没写清为什么 `reason` 会是空、`directory-structure.md` 的释放记录消费方段落漏了本轮新增的两条路径 | **已改**：`completionTransaction.ts` 改为点名 `releaseCurrentAssignment`（并注明旧名是它被抽出来之前的形状）；`StaffReleaseHistory.tsx` 写明空 `reason` 可达且只有 `companion_cancel` 带用户原话，兜底必须保留；`directory-structure.md` 逐条补上封禁回池与客服退回 / 换人，并注明该文件现有**五个**公开入口 |
| **NOTE-1** | NOTE | 两条 HTTP 正例依赖「造一单」的前置链路，若将来支付通道默认关闭会一起红 | **接受**：这正是设计意图——宁可红，也不要静默跳过（§4.3 记的假绿就是这么来的） |
| **NOTE-2** | NOTE | `02-decisions.md` 的 Q1 / Q2 裁定与 D1–D13 之间没有交叉引用 | **接受**：§九 D-Q1 与 D-Q2 已经各带一句指向正文对应小节 |

⚠️ **整改过程中自查出一个自己的缺陷，比上面任何一条都严重**：两条 HTTP 正例最初是**假绿**的
（探测逻辑把「支付通道关着」与「支付请求不存在」两个 404 混为一谈，导致每次都提前返回、零断言）。
它不在 reviewer 的结论里，是**受控 mutation 没变红**才暴露的。机制、证据与修法写在 §4.3。
这条记在这里的意义是：**「全绿」只有在能被证伪的时候才是证据**。

⚠️ reviewer 初判里有两条**当时已失效**：它指出 `P0-11/03-delivery.md` / `04-acceptance.md` / `README.md`
仍是 `CLARIFYING` 空档案——那是它**在我整篇重写之前**读到的版本，重写后已不成立。
本节不改动 reviewer 的原始结论，只记录处置。

---

## 八、与文档的同步（本轮同时完成）

| 文档 | 改了什么 | 为什么必须改 |
|---|---|---|
| `docs/02-tech-design/api-contract.md` | 接口数 `127 → 130`、staff `22 → 25`；新增 3 行接口表；§11 的 ⚠️ 段落**重写** | 原文「客服端**没有任何客服可触发的处置路径**」本轮起不成立。同时补一句：客服**确实**有一条能间接改变完成材料状态的动作（作废），但**金额与状态机之外的字段仍然不能改** |
| `docs/02-tech-design/directory-structure.md` | 路由数 `127 → 130`；`lib/services/` 快照重测（68 → 69 文件） | 新增 3 个 route.ts 与 1 个服务文件 |
| **`docs/02-tech-design/database-schema.md`** | `:790` T4 最小映射由「回 public 一条」改为**两条**（回 public / direct replace）；`:801` 的「指定新打手仍可后置」加一句**它不再属于这一句**；`:812` 的 `TBD — DO NOT INVENT` 行**收窄** | **Q2 的产品裁定要求**：旧的 `DO NOT INVENT` 已被该裁定覆盖。⚠️ **收窄而非删除**——仍然禁止自行设计「完整的 Assignment / 指定改派模型」 |
| `lib/constants/orders.ts` / `lib/types/companionRelease.ts` | TARGET 注释更正 | 原文描述的两件事本轮都做了，注释必须跟着事实走（D10-1 / D10-2） |
| `docs/03-dev/rounds/P0-11/**` | 五个档案按事实重写 | 原本是 `CLARIFYING` 状态的空档案 |

---

## 九、MINOR / NOTE（交付方自己登记，不藏）

| # | 事项 | 为什么不做 |
|---|---|---|
| m1 | 「停用」的接口响应**没有**返回「释放了哪几单」 | 追溯已经满足：每单各写一条 `CompanionReleaseRecord`，`/staff/orders/[id]` 与 `/admin/orders/[id]` 都能看到。加字段要动 P0-10 的 DTO 与三处转换，**与本轮的范围不成比例** |
| m2 | 客服换人**没有幂等键**，幂等判据是**状态本身** | 与 `StaffCompletionConsole` 同一条机制（订单已不在履约中 → 服务端 400，不是重放）。与 `AdminApplicationActions`（幂等键）**刻意不同**，理由写在组件注释里 |
| m3 | `releaseOrdersForCompanion` 是**全量读 → 全量校验 → 全量写** | 一位护航手上的在跑单在 Mock 阶段是常数级。改增量写会引入「部分成功」这个**更糟**的状态——现在要么全成、要么一笔不写 |
| n1 | `setCompanionFlags` 的 `changed` 口径**没有**按 D6 的原话改成 `标志位有变 \|\| 释放了至少一单` | 复核后发现第二个析取项**不可达**（标志位未变时函数提前返回），按原话写只会留下一段无法被覆盖的分支。**行为零变化**。更正记在 `02-decisions.md` **D12**，并由此登记出一条真实边界（§三 已列：重复停用不补扫） |
| n2 | `functionBody` 测试辅助函数的边界由 `export async function` 改为任意 `export` | 本轮新增的 `releaseOrdersForCompanion` 是**同步**导出，旧边界会把它算进上一个函数的切片里——切片一长，别人的 Guard 就替它背书了。改后 `cancelAcceptedOrder` / `startCompanionOrder` 两个既有切片的范围**不变** |
| n3 | `tests/platformConfig.test.mjs` 的偶发（1 ms 时间戳）**仍然存在** | P0-10 已登记的既有 `A9-3`，**非本轮引入、本轮不修**（不在范围内）。本轮 8 次连跑未复现 |
| m4 | 两条 HTTP 正例**曾经是假绿**，且是靠**受控 mutation 没变红**才发现的 | **已修**，不是「登记不修」：删掉探测、改走真链路。机制与两次 mutation 的证据在 §4.3；为什么它比 reviewer 的任何一条都严重，记在 §七 末尾 |
| n4 | reviewer 的 MINOR-1（校验循环漏一步）与 MINOR-3（500 只有实现没有契约用例）登记为**已修**而非遗留 | 两条都在本轮范围内且各自只需几行，没有理由留给下一轮；对应新增的 `可用性 6` / `作废 6` 见 §4.3 |
| n5 | reviewer 的 MINOR-2（去掉回读）**删掉了**「写成功但回读 404」这条错误出口 | 这正是它被评为 MINOR 的原因：那条出口**不该存在**。删掉后服务层对 `ok` 不再有任何读取，因此也不该有「读不到」这种失败可能——`releaseResult` 现在连 `Order` 都不收 |

---

## 十、本轮的 Git 状态

**本批次（P0-10 → P0-13）禁止任何 Git 写操作。** 因此：

- 本轮交付**没有提交**，全部改动留在工作区；`HEAD` 仍是批次的 baseline
  `3fbae6263794bda316b2b48dac03efd7f62afa01`（= `3fbae62`，批次文件 §累积工作区所记）；
- ⚠️ **本轮的改动与 P0-10 的改动在同一个工作区里叠着**，因为两轮都没有提交。
  这不是「本轮改了 P0-10 的文件就说明 P0-10 有问题」——批次协议要求的正是「累积工作区」；
- 上面的「新增文件 / 修改文件」两张表来自 `git status --short` 与 `git diff --stat 3fbae62`
  在 2026-09-24 的读数；
- `README.md` 的 `Git Commit:` 字段**留空**——它只能由用户本人在提交后填写
  （「DONE 双门槛」第二条）。Claude **无权**自行标记 `DONE`。
