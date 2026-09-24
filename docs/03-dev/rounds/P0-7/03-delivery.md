# P0-7 · 03-delivery.md

Round ID: P0-7
Title: `accepted → serving`（打手「开始服务」）
Status: AWAITING_ACCEPTANCE

> ⚠️ 本文件记录**本轮交付的事实**。批次模式下 `User Result` / `Final Result` 一律
> 保持 `PENDING`，本文件**不写 `PASSED`**（批次 §七）。
> 📌 **验收结论晚于本文件**：四轮的统一人工验收已于 **2026-09-24 全部通过**
> （`User Result` / `Final Result` = `PASSED`），记录在 `04-acceptance.md` 与 `README.md`。
> 本文件作为交付时点的记录**保持原样不改写**（「追加历史、不覆盖历史」）。

---

## 一、交付概览

| 项 | 值 |
|---|---|
| 本轮唯一新增的状态迁移 | **`accepted → serving`**（`OrderStatus` 枚举与中央状态表**零改动**） |
| 新增公开写入口 | `POST /api/companion/orders/[id]/start`（Companion API 清单 5 → **6** 条） |
| 新增项目文件 | 3（路由 1 · 组件 1 · 测试 1） |
| 修改的项目文件 | 9（types 1 · constants 1 · data 2 · services 2 · app 1 · tests 2） |
| 修改的文档 | 4（api-contract · directory-structure · 总需求进度表 · rounds/README） |
| 新增产品通知 | **0**（D6：需求未为「开始服务」冻结通知） |
| 新增幂等键字段 | **0**（D2：状态即幂等判据） |
| 新增状态枚举值 | **0**（批次 §十一：不得把 `completion_review` / `settling` / `settled` 塞进 `OrderStatus`） |

### 1.1 本轮 delta（基线、归属与「不把它当成本轮改动」的边界）

**本轮开工基线：`HEAD = 249f7c1`**（`docs: close P0-6 and DEV-1 after acceptance`），
开工时工作区**并不干净**——P0-6.1 的四道门禁已跑完但**尚未提交**，
因此它的改动仍留在工作区里。**本轮没有做任何 Git 写操作**（§九），
下面按文件把「谁的改动」分开，**不把 `git diff` 的总量当成本轮 delta**。

**P0-7 新建的文件**

| 文件 | 内容 |
|---|---|
| `app/api/companion/orders/[id]/start/route.ts` | `POST` 开始服务；`requireCompanion()` 第一动作；**不读请求体** |
| `components/companion/CompanionOrderStartPanel.tsx` | 详情页上的「开始服务」入口（两下确认，成功后 `router.refresh()`） |
| `tests/companionServing.test.mjs` | 本轮 16 条要求的回归保护（见 §六） |
| `docs/03-dev/rounds/P0-7/`（5 个文件） | 本轮档案 |

**P0-7 修改的文件**

| 文件 | 本轮改了什么 |
|---|---|
| `lib/types/order.ts` | 新增 `CompanionStartOutcome`；`CompanionOrderListItem` 增 `canStart`；`CompanionOrderDetail` 增 `servingAt` |
| `lib/constants/dispatch.ts` | 新增 `COMPANION_ORDER_NOT_STARTABLE_MESSAGE` 与 5 条开始服务文案 |
| `lib/data/mockPaymentRepository.ts` | 新增同步写入器 `applyOrderServing`（只写 `status` + `servingAt`） |
| `lib/data/companionOrderTransaction.ts` | 新增伪事务 `startCompanionOrder`；头部「唯一入口」表述改为两个 |
| `lib/services/companionOrders.ts` | 新增服务函数 `startCompanionOrder`；DTO 增 `canStart` / `servingAt`；导出 `CompanionStartSuccess` |
| `lib/services/companionHttp.ts` | 新增浏览器客户端 `startCompanionOrderRequest`（**不带 body、不带幂等键**） |
| `app/companion/(console)/orders/[id]/page.tsx` | 接入开始服务面板 + 新增「开始服务时间」一行 |
| `tests/companion.test.mjs` | 清单 5 → 6 条；负向门禁改写为「写入口恰好两个」；新增「接口不读请求体」门禁 |
| `tests/companionOrders.test.mjs` | 两份 DTO 白名单加字段；结构约束断言改写（见 §五）；权限矩阵路由 3 → 4 |

**P0-7 修改的文档**

| 文件 | 本轮改了什么 |
|---|---|
| `docs/02-tech-design/api-contract.md` | §8 清单 5 → 6 条、负向门禁对象改为下一站的 `completion`；§3.1 从 TARGET 表改为「四条全部已实现」 |
| `docs/02-tech-design/directory-structure.md` | A 段 `start/route.ts` 从 TARGET 改为 CURRENT；C 段「只有一个公开入口」改为两个 |
| `docs/03-dev/总需求进度表.md` | 新增 P0-7 行；状态机整改行补上「P0-7 接入 `accepted → serving`」 |
| `docs/03-dev/rounds/README.md` | 索引新增 P0-7 行 |

**⚠️ 下列改动属于 P0-6.1，不是本轮 delta**（本轮**一个字节都没碰**，
它们仍未提交，因此在 `git status` / `git diff` 里与本节同时出现）：

`components/companion/CompanionHeader.tsx`、`lib/constants/companionConsole.ts`、
`lib/services/companionDispatch.ts`、`docs/02-tech-design/database-schema.md`、
`tests/companionConsoleNav.test.mjs`、`tests/companionPoolOrder.test.mjs`、
`docs/03-dev/rounds/P0-6.1/**`。
另有三份文件**两个轮次都改过**（`api-contract.md` / `rounds/README.md` /
`总需求进度表.md`）——上面两张表里写的是**本轮新增的行**，不是这三个文件 diff 的全部。

**⚠️ 与产品无关的工作区残留**（**不是**本轮产物，建议提交前处理，见 §八）：

- `docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md`（未跟踪，文件名被 GBK 破坏的
  P0-6.1 指令副本；内容已逐字保存在 `P0-6.1/01-prompt-extended.md`，P0-6.1 已记录）；
- `docs/03-dev/rounds/cmd_p0-6.1.md` / `cmd_p0-7.md` / `cmd_p0-8.md` / `cmd_p0-9.md` /
  `cmd_batch_p0-6.1_to_p0-9.md`（未跟踪，**用户提供的指令原件**，本轮只读不改）。

---

## 二、实现清单（按数据流：常量 → 类型 → 写入器 → 伪事务 → 服务 → 接口 → 客户端 → 页面）

### 2.1 `lib/constants/dispatch.ts`

新增 6 条常量（P0-7 块）：`COMPANION_ORDER_NOT_STARTABLE_MESSAGE`（400 文案）、
`COMPANION_START_LABEL` / `COMPANION_START_CONFIRM_LABEL` / `COMPANION_START_PENDING_LABEL`、
`COMPANION_START_CONFIRM_NOTICE`（展开确认区时的说明，点明**单向门**）、
`COMPANION_START_SUCCESS_LABEL`（成功反馈）。

⚠️ 文案里**不写**任何需求没有冻结的规则：不写「服务时长从此刻开始计算」、
不写「请立即联系用户」、不写「已为你通知用户」——`servingAt` 目前只用于展示。

### 2.2 `lib/types/order.ts`

- **`CompanionStartOutcome`**（新）：`ok` / `replayed` / `not-found` / `not-startable` 四个分支。
  与 `CompanionCancelOutcome` 差一处：**没有幂等键**，因此没有「键命中」这条路径。
  两个成功分支的 `servingAt` 允许为 `null`——只有「历史数据里状态已是 `serving` 而
  `servingAt` 从未写下」这一种情况会给出 null，**不编一个开始时间**。
- **`CompanionOrderListItem.canStart`**（新）：与 `canCancel` 成对，服务端算好。
- **`CompanionOrderDetail.servingAt`**（新）：**只进详情、不进列表项**。

### 2.3 `lib/data/mockPaymentRepository.ts` — `applyOrderServing`（新，同步写入器）

与同文件另外三个写入器同一套路：**只负责写**，不判断这次迁移合不合法。

**只写两个字段**：`status: "serving"`、`servingAt`（`order.servingAt ?? at`）。
**不碰** `actualCompanionId` / `companion`（履约绑定）、`acceptedAt`（历史事实）、
金额域五个字段。已经是 `serving` 时返回 `changed: false` 且**不刷新时间戳**。

### 2.4 `lib/data/companionOrderTransaction.ts` — `startCompanionOrder`（新，伪事务）

判定顺序（全部在同一段**无 `await`** 的同步代码里，与 D3 一致）：

```
1. 不存在 / actualCompanionId ≠ 我  → not-found
2. status === "serving"             → replayed（一个字节都不写）
3. canTransitionOrder(status,"serving") 为假 → not-startable（结构校验）
4. status !== "accepted"            → not-startable（领域 Guard）
5. applyOrderServing(...)           → ok
```

⚠️ **第 2 步必须早于第 3 步**：`serving → serving` 不在中央状态表里，
顺序反过来会把一次重复点击判成「非法迁移」（400）。这条顺序是本轮最容易写错的地方，
`tests/companionServing.test.mjs` 与 `tests/companionOrders.test.mjs` 各有一条断言守着它。

同时改写文件头部的「当前唯一的公开入口是「主动取消接单」」——现在有两个公开入口。

### 2.5 `lib/services/companionOrders.ts`

新增 `startCompanionOrder(companionId, orderId)`：只做两件事——取**一个** `at`、
把事务结果转成对外结果（`not-found` → 404，`not-startable` → 400）。
**没有 `body` 参数、没有任何字段校验**（这正是它没有 400「参数非法」这一类失败的原因）。

`toCompanionOrderListItem` 增 `canStart: order.status === "accepted"`；
`getCompanionOrderDetail` 增 `servingAt: order.servingAt`。

### 2.6 `app/api/companion/orders/[id]/start/route.ts`（新）

`requireCompanion()` 第一动作 → 取 `id` → 调服务 → `ok` / `fail(toApiError)`。
**不调用 `readJsonBody`**：调了它，空体 POST 会变成 400「请求体格式无效」，
等于给这个接口发明一条服务端文档里没有的必填体规则。
（有一条新门禁钉着这件事，见 §六。）

### 2.7 `lib/services/companionHttp.ts`

`startCompanionOrderRequest(orderId)`：`apiPost(path)` **不带 body**，`CompanionStartResult`
从 `lib/types/order.ts` 里挑（不从服务端模块 import——那会把 Mock 存储带进浏览器产物）。

### 2.8 `components/companion/CompanionOrderStartPanel.tsx` + 详情页（新 / 改）

- 面板：两下确认（先展开确认区、再「确认开始服务」）；`pendingRef` 防双击；
  **成功后 `router.refresh()`**。
- ⚠️ 与 `CompanionOrderCancelPanel` **刻意相反**：取消之后这一单不再属于他，
  刷新会走 404、会把成功反馈换成「订单不存在」；开始服务之后这一单**仍然是他的**，
  刷新正是让状态改成「护航中」、两个入口一起消失的**正确**做法。
- 详情页：`detail.canStart` 为真时渲染面板；状态区在**已经发生过**时才多一行「开始服务时间」
  （`servingAt` 为 null 在打手端是常态，不显示成一行「—」）。

---

## 三、与 `02-decisions.md` 的对照

| 决策 | 落地情况 |
|---|---|
| D1 伪事务落在 `companionOrderTransaction.ts`，不新建文件 | ✅ 同文件新增 `startCompanionOrder`；三处「唯一入口」表述已同步（文件头 / `directory-structure.md` / `tests/companion.test.mjs`） |
| D2 幂等 = 状态即判据，**不加幂等键** | ✅ 事务/服务/接口/客户端四层都不出现 `idempotencyKey`；接口不读 body |
| D3 判定顺序 ownership → serving → 结构 → 领域 Guard | ✅ 见 §2.4；两条断言守着「第 2 步早于第 3 步」与「两道门都在」 |
| D4 写入器 `applyOrderServing`，只写两字段 | ✅ 见 §2.3；`tests/companionServing.test.mjs` 用「变化键集合恰好是 `servingAt` + `status`」钉住 |
| D5 DTO：`canStart` 进共享项、`servingAt` 只进详情 | ✅ 两份白名单已同步更新 |
| D6 不新增任何产品通知 | ✅ 本轮零通知常量、零 `appendNotification` 调用；有一条断言守着 |
| D7 新增 `CompanionOrderStartPanel` + 成功后 `router.refresh()` | ✅ 见 §2.8 |
| D8 文档同步（CURRENT / TARGET 两张表同时改） | ✅ api-contract §8 + §3.1、directory-structure A/C 段、进度表、rounds/README 四处全部改到 |

---

## 四、本轮明确不做（逐条对照 `01-prompt.md` §九）

CompletionSubmission · 客服完成审核 · 10 分钟自动审核 · Earning · complaint settlement ·
`serving` 的普通主动取消 · 封禁回池 · 客服换人 · 新退款资金联动 · 打手聊天 · Scheduler ·
DB / ORM —— **一条都没有实现**。其中三条另有门禁钉着：`serving` 无取消入口
（`canCancel === false` + 事务层 `not-accepted`）、`orders/**` 写入口恰好两个、
全仓不出现 `completion_review`。

---

## 五、⚠️ 本轮对**既有断言**的改写（都不是放宽）

P0-7 让两处 P0-6 的断言**必须**改变。两条都不是「为了让测试变绿」，
而是原断言的形式与新事实冲突；改写后**保护强度只增不减**，逐条对照如下。

### 5.1 `tests/companionOrders.test.mjs` 的结构约束断言

| | 原文（P0-6） | 现在（P0-7） |
|---|---|---|
| 断言 | 本文件**不得出现** `canTransitionOrder`（理由：表允许 ≠ 该动作有入口） | 表**可以**出现，但每条动作路径都必须有**直接看 `order.status` 的领域 Guard**，且 `canTransitionOrder` 必须排在它**之前** |
| 为什么必须改 | P0-6 的意图是「不许拿状态机替代权限」，而 `01-prompt.md` §三 **要求**「开始服务」用中央状态机做**一道结构校验**、领域 Guard 仍单独存在——原断言的字面形式与这条要求直接冲突 | |
| 改写后更强在哪 | 原来只作用于**一个文件**的「出现/不出现」；现在**逐函数**检查（`functionBody` 切片，A 函数的 Guard 不能替 B 函数背书），并额外钉住**顺序**。删掉领域 Guard、或用结构校验替代它，两种退化都会变红 | |
| P0-6 的取消链是否被削弱 | **没有**：`cancelAcceptedOrder` 仍必须含 `order.status !== "accepted"`；文件仍然全程无 `await`；四件事的写入器仍在；导出集合仍被逐字钉着（现在恰好两个名字） |

> ⚠️ **reviewer 在这一点上抓到了一处真实的收窄**（见 §八 m2）：原来的全文件级禁令
> 「本文件不得出现 `canTransitionOrder`」在被收窄成逐函数判断之后，
> **取消路径本身失去了「不得引用状态机」这一条**。已按 reviewer 的建议补回
> `assert.equal(functionBody(code, "cancelAcceptedOrder").includes("canTransitionOrder("), false)`，
> 于是「取消不需要结构校验」这半边重新有人守。这条补充是**本轮之内**完成的，
> 不是留给下一轮的技术债。 |

### 5.2 `tests/companionOrders.test.mjs` 的 HTTP 权限矩阵

`COMPANION_ORDER_ROUTES` 由 3 条扩到 4 条（新增 `POST /api/companion/orders/[id]/start`），
用例名「未登录打**这三**个接口都是 401」改为「**这四个**」。断言本身逐字未动，
覆盖范围**变宽**；并且刻意给这个「没有请求体」的接口发一个 cancel 形状的体，
以证明守卫**先于**任何请求体解读（带什么体到达都只能是 401 / 403，不是 400）。

### 5.3 未改动的既有断言

`tests/companion.test.mjs` 里除了清单本身（5 → 6 条）与负向门禁（见 §2 的两条）之外，
「守卫位置」「服务层引用」「不混进别的身份守卫」等断言逐字未动。
`tests/companionPoolOrder.test.mjs` / `tests/companionConsoleNav.test.mjs`（P0-6.1）
**一个字节都没碰**，全量跑过。

---

## 六、测试

### 6.1 新增 `tests/companionServing.test.mjs`（19 条）

`01-prompt.md` §八 的 16 条要求 → 实际落点，逐条对应如下（`02-decisions.md` §二 是开工时的**计划**落点，
用例号在实现后按实际文件名校正过，差异见本节末的说明）。

| 指令 §八 要求 | 本文件里的用例 | 钉住的是什么 |
|---|---|---|
| 1 · actualCompanion 可 start 自己的 accepted 单 | 开始 1 | 状态推进 + **变化键集合恰好 `["servingAt","status"]`** |
| 4 · `accepted → serving` | 开始 1 | 同上（状态断言） |
| 5 · `servingAt` 正确写入 | 开始 1（等于传入的 `at`）· 开始 2（接口返回的与写进订单的是**同一个**时刻） | 时刻只取一次 |
| 6 · `actualCompanionId` 不变 | 开始 1 | 逐字段点名，不靠集合断言代言 |
| 7 · `acceptedAt` 历史不丢 | 开始 1 · 开始 7 | 「我是几点接的、几点开始的」两问都要答得出 |
| 8 · `serving` 不能再次 start | 开始 3（新建单）· 开始 3b（**预置** serving 单） | 重放：`changed:false`、`servingAt` 不被刷新、零写入 |
| 2 · 非 actualCompanion 不能 start | 开始 4(a) | 状态对不构成理由 |
| 12 · 其他打手无法操作 | 开始 4(a)(d) · 开始 7(4) · HTTP 用例 3(b) | 含「别人手里**已经开始服务**的单」也只能拿到「与你无关」 |
| — · 用户结算时**指定**我不等于这一单归我 | 开始 4(c) | `exclusiveCompanionId === 我` 但 `status = paid`：正确答案是 404，**同时钉住判定顺序** |
| 9 · `paid` / `completed` / `refunded` 不能 start | 开始 5 | 三种状态各一条；两种情况分别验（见用例内注释） |
| 10 · start 后取消不可再用 | 开始 6 | 事务层 `not-accepted` + 接口层 400 + 状态不被拉回 |
| 11 · start 后订单仍属于当前 Companion | 开始 7 | 列表 / 详情都还返回，`canStart` 与 `canCancel` 同时为假 |
| — · 用户端与后台也看得到 `serving` | 开始 7b | 时间轴**同时保留**「已接单」与「护航中」两个节点 |
| 14 · 状态机允许 ≠ 权限 | 开始 8 | 表里为真的边对不满足 Guard 的调用照样被拒；表里**没有**的边另行正面确认 |
| 15 · P0-6 主动取消链不回归 | 开始 9 | 两条路径互不干扰，双向各验一次 |
| — · 身份只来自会话 | 开始 10 | 服务层无 body、事务层归属判据是订单上的事实字段、原子区段无 `await` |
| 13 · route manifest / 写入口门禁 | 开始 11 | `orders/**` 下写入口**恰好两个**；`start` 只导出 `POST`；浏览器端不发明幂等键、不带请求体 |
| — · 本轮不发通知（D6） | 开始 12 | start 路径上不出现任何通知常量；通知常量集合**仍然只有那四条** |
| — · UI 只按服务端旗标（D7） | 开始 13 | 页面读 `canStart` / `canCancel`；成功后刷新、取消成功后**不**刷新（刻意相反） |
| — · 本轮不做 `completion_review` | 开始 14 | 状态集合恰好五个；全仓 `lib/` + `app/` 源码里不出现该标识符 |
| 3 · 普通 User 不能调用 Companion start API | HTTP 用例 1（401）· 2（403）· 3 | 见 6.3 |

**未落进本文件的一条**：指令 §八 #16「P0-6.1 排序不回归」由 `tests/companionPoolOrder.test.mjs`
承担（该文件**本轮一个字节未改**，全量门禁通过即在守）。本文件刻意不复制它的排序用例——
同一约束在两处各写一遍，只会让将来改排序时多一处要同步。

### 6.2 对既有测试的改动

| 文件 | 改动 | 为什么不是放宽 |
|---|---|---|
| `tests/companion.test.mjs` | 清单 5 → 6 条；负向门禁从「只能有 cancel 一个写入口」改为「写入口**恰好两个**且集合逐字相等」；新增「start 接口源码里不出现 `readJsonBody` / `request.json(`」 | 覆盖范围**变宽**：原来只钉一个文件的存在性，现在钉集合相等 |
| `tests/companionOrders.test.mjs` | 两份 DTO 白名单加字段；结构约束断言改写；权限矩阵路由 3 → 4 | 见本文 §五（含逐条前后对照表） |

### 6.3 测试结果

| 运行 | 命令 | 结果 |
|---|---|---|
| 新文件（离线） | `node --test tests/companionServing.test.mjs` | `tests 19 · pass 16 · fail 0 · skipped 3`，`EXIT=0` |
| 定向回归 | `node --test tests/companion.test.mjs tests/companionOrders.test.mjs` | `tests 28 · pass 26 · fail 0 · skipped 2`，`EXIT=0` |
| 全量（离线） | `pnpm test` | `tests 1154 · pass 1030 · fail 0 · skipped 124`，`EXIT=0` |
| 全量（production + HTTP） | `APP_BASE_URL=http://localhost:<port> pnpm test`（首轮 `:3212` / 终轮 `:3213`） | 两轮同值：`tests 1154 · pass 1154 · fail 0 · skipped 0`，`EXIT=0` |

离线那 124 条 `skipped` 全部是既有的「需要 `APP_BASE_URL` / 需要登录态」条件跳过——
production 那一跑把它们全部打开，因此以 `skipped 0` 为准。

> 另有一次**旁证**（不是本轮门禁）：新文件的作者在写完后对着用户自己开在 `:3000` 的 dev
> 服务器跑过一遍新文件，`pass 19 · fail 0 · skipped 0`。那次只发了只读请求
> （401 / 403 / 404 与一次订单所有者的 `GET`），没有向那个实例写入任何数据。
> 本轮的正式门禁以第 7 节的 production（`:3212`）那一跑为准。

### 6.4 ⚠️ 对新增门禁做过的**变异验证**（证明断言不是空转）

新增的结构门禁如果写得太松，会变成「永远为真」的装饰。因此对最容易被写松的那一条
——「`start` 的浏览器端调用**只有一个实参**（即不携带请求体）」——做了一次变异测试：

1. 临时把 `lib/services/companionHttp.ts` 的调用改成 `apiPost<CompanionStartResult>(path, {})`；
2. 定向运行「开始 11」→ **变红**：`AssertionError: 开始服务不带请求体：apiPost(url) 只有一个实参`；
3. 还原（`diff` 确认与变异前**逐字节相同**）→ 再次变绿。

同一轮里 `functionBody` 的匹配也从「只认 `export async function`」修成了
「同时认 `export function` / `export async function`」并加了词边界——否则它会漏掉
`companionHttp.ts` 里那个**同步**导出的函数，而漏掉的表现是「找不到 → 抛错」还是
「静默命中别的函数」，取决于怎么写，后者才是真正危险的。

⚠️ **关于这次变异测试的边界纪律**：我原先把上面第 1–3 步派给测试作者代为执行，
但它**拒绝**了——理由是它接到的边界是「只改 `tests/`，不改任何生产代码」，
协调者的临时要求不足以解除那道边界。它改用「在内存里构造变体字符串喂给同一判据」
给出了等价证据（真实源码 → 1 个实参；内存变体 → 2 个实参，断言会红；
本来就带 `input` 的 `cancelCompanionOrderRequest` → 2 个实参作对照）。
**这个处理是对的**，本轮也据此把变异测试改由我**自己**执行并当场还原
（`diff` 逐字节确认），而不是让下游 Agent 替我去碰 `lib/`。

### 6.5 已知缺口（自动化测不到的部分，不掩饰）

| 缺口 | 为什么没覆盖 | 影响 |
|---|---|---|
| HTTP 的 happy path（真发一次 `POST /start` 拿到 200 并落进 `serving`） | 需要完整链路（下单 → 支付 → 接单 → start），是**写操作**；对着用户正在用的实例跑不合适 | 「接口能真的把订单推进到 serving」由数据层/服务层用例 + 手工验收 A 组承担 |
| 组件行为（入口是否消失、成功后页面是否反映 `serving`） | runner 不剥离 JSX，本项目组件一贯无自动化测试 | 手工验收 A 组 |
| `servingAt === null` 的**重放**分支 | 预置数据里不存在「状态已是 `serving` 但从未写下 `servingAt`」的单；为它造数据只能直接改 store，那不是真实路径 | 该分支的代码有注释说明，但没有测试守着；将来做数据迁移时值得补 |
| 真实数据库下的并发交错 | 本轮是 `globalThis` Mock 存储，原子性靠「Node 单线程 + 区段内无 `await`」 | **本轮的真实约束**，不是本次遗漏；`database-schema.md` 已把 DB 迁移列为未来约束 |
| 结构断言依赖源码文本 | 重命名 / 改写调用写法可能误报 | 属已知取舍：误报要求人工判断，比「静默不守」安全 |

---

## 七、门禁

⚠️ **门禁跑过两遍**：第一遍在实现与测试写完时（下文「首轮」），第二遍在**修完 reviewer 的
MAJOR 与 MINOR 之后**（下文「终轮」，即本节表格里的数字）。两份记录都留着，
是为了让「修完之后确实重跑过」这件事可查，而不是只留一个结论。

| # | 门禁 | 命令 | 终轮结果（**以此为准**） | 首轮结果 |
|---|---|---|---|---|
| 1 | 单元 / 回归（离线） | `pnpm test` | ✅ `tests 1154 · pass 1030 · fail 0 · cancelled 0 · skipped 124 · todo 0`，`EXIT=0` | 同左（1154 / 1030 / 0 / 124） |
| 2 | 类型 | `pnpm typecheck` | ✅ `next typegen && tsc --noEmit` 无输出，`EXIT=0` | 同左 |
| 3 | Lint | `pnpm lint` | ✅ `eslint` 无输出（0 problem），`EXIT=0` | 同左 |
| 4 | 构建 | `pnpm build` | ✅ `Next.js 16.3.4 (Turbopack)`，`/api/companion/orders/[id]/start` 已登记为 `ƒ (Dynamic)`，`EXIT=0` | 同左 |
| 5 | **production + HTTP 全量** | `APP_BASE_URL=http://localhost:<port> pnpm test` | ✅ `:3213` → `tests 1154 · pass 1154 · fail 0 · **skipped 0**`，`EXIT=0` | ✅ `:3212` → `1154 / 1154 / 0 / 0` |

门禁 5 的服务器起法与收尾（避免测到上一次跑剩的旧进程）：

- 先 `netstat -ano | grep LISTENING` 确认端口空闲；两轮分别用 **3212** / **3213**
  （避开用户正在用的 dev 服务器 3000，也未复用 P0-6.1 的 3211）；
- `PORT=<port> pnpm start`，确认 `✓ Ready` 且 `netstat` 显示该端口 `LISTENING` 及其 PID；
- 跑完后 `taskkill //PID <pid> //T //F`，再 `netstat` 复核该端口已无 `LISTENING`；
- 每次都复核用户自己的 `:3000` dev 服务器**仍在**（本轮的起停没有波及它）。

`skipped 0` 意味着一向依赖 `APP_BASE_URL` 的 HTTP 用例真的跑了，其中包括本轮新增的三条：

```
✔ 权限矩阵：未登录调开始服务接口是 401（不是 403，也不是 200）
✔ 权限矩阵：登录了但不是打手的普通用户拿到 403
✔ 权限矩阵：有效打手也只能拿到 404——身份塞不进请求体，别人的单一个字段都不动
```

后一条是**带体**打真实接口的：`none` / `{}` / 伪造了 `companionId` 的体三种到达方式
结果必须完全相同——身份只来自会话，体里塞什么都不作数。

---

## 八、Reviewer

只读审查（`reviewer-agent`，对照 `docs/01-requirements/` 与 `architecture-rules.md`，
未修改任何文件、未执行任何 Git 写操作）。结论原文：**BLOCKER = 0，MAJOR = 1**。

### 8.1 七条 Reviewer 重点的结论（全部成立）

| 重点 | 结论 | 证据 |
|---|---|---|
| ownership 只由 `actualCompanionId` 决定 | ✅ | 事务里唯一的归属判据是 `order.actualCompanionId !== ctx.companionId`；`exclusiveCompanionId` 在 start 路径上**从未被读过**；用例 4(c) 用「用户指定了我但我没接」的单正面钉住 |
| 无前端-only 权限 | ✅ | `canStart` 由服务端计算；页面只读 `detail.canStart`；面板不含 `status ===` 推断（用例 13 断言）；服务端在同一原子区段独立复核 |
| serving 普通取消仍关闭 | ✅ | 事务层 `not-accepted` + 接口层 400 + DTO `canCancel=false`，三层都有用例；**没有**顺手实现 `serving → completed` / `serving → paid` |
| 未误清历史字段 | ✅ | 用例 1 用「变化键集合恰好 `["servingAt","status"]`」+ 11 个金额字段逐个点名 + `acceptedAt` 逐字比较 + `companion` 快照 deepEqual |
| 原子区段无 `await` | ✅ | 文件级与函数级各一条断言 |
| Route 不承载业务 | ✅ | 路由只有「守卫 → 取路径参数 → 调服务 → 包装响应」，与 cancel 路由同形状 |
| 无第二套 Order / Dispatch / 幂等框架 | ✅ | 未新增仓储；派单记录在 start 路径零写入；幂等复用「状态即判据」（与 `acceptDispatch` 同模式） |

Reviewer 另外**独立复核**了本轮声明的门禁数字（`pnpm test` / `tsc` / `eslint`），
并 `diff` 确认 `01-prompt.md` 与 `cmd_p0-7.md` **逐字节相同**、P0-6.1 的排除清单**成立**。

### 8.2 MAJOR（1 条，**已修**）

| 编号 | 问题 | 处理 |
|---|---|---|
| M1 | `docs/02-tech-design/database-schema.md` §6.2 的 CURRENT 声明被本轮直接推翻：仍写「真实迁移只有三条」「`accepted → serving` 尚未实现」「订单写入点恰好两处」。P0-8（完成材料，同样要写 `Order.status`）正是会照着这张表决定「状态写在哪里」的那一轮——读到「恰好两处」的结论是**自己新开一条 status 写入路径**，那就立刻违反唯一真值源 | ✅ **已改**：迁移改为四条并标注哪条是本轮接入、哪条仍未实现；写入点改为**恰好四处**并按实际行号补齐 `applyOrderAcceptanceReleased`（P0-6）与 `applyOrderServing`（P0-7）两行（顺带修掉 P0-6 遗留的旧行号）；另加一句显式纪律「新增状态写入必须落在这里，P0-8 应照 `applyOrderServing` 的形状加第五个同步写入器」 |

⚠️ Reviewer 指出 `:194` 的「恰好两处」在 **P0-6 交付时就已经不准**（P0-6 加了
`applyOrderAcceptanceReleased` 却没同步这张表）。本轮把两条一起修了——这类「真值源落后于代码」
的漂移，靠的是每轮有人对着代码复核，而不是靠写的时候记得。

### 8.3 MINOR

Reviewer 报了 **6 条**（m1–m6），其中 **m3 下含三个子项**，因此下表共 **8 行**：
**已修 6 项**，**刻意不补 2 项**（m3-1 / m3-2，理由分别见 8.4 与 §6.5）。

| 编号 | 问题 | 处理 |
|---|---|---|
| m1 | `总需求进度表.md` 的 `UNASSIGNED · 开始服务` 行没标「已由 P0-7 实现」，与同文件另两条同类行的处理方式不一致 | ✅ 已按同一格式补上说明（状态列仍留 `PLANNED`——该轮止于 `AWAITING_ACCEPTANCE`，验收通过并由用户本人提交后才关闭） |
| m2 | 改写后的结构约束**收窄**了一项：原全文件级禁令「不得出现 `canTransitionOrder`」在被收窄成逐函数判断后，**取消路径失去了「不得引用状态机」这一条** | ✅ 已补 `assert.equal(functionBody(code,"cancelAcceptedOrder").includes("canTransitionOrder("), false)`，见 §5.1 的补充说明；这条补充在**本轮之内**完成，不留给下一轮 |
| m3-1 | HTTP 层没有 200 happy path（`ok(...)` 的包装路径无断言） | ⚠️ **刻意不补，理由见 8.4** |
| m3-2 | 重放分支 `servingAt === null` 无覆盖 | ⚠️ 保留为已知缺口（§6.5），预置数据造不出这条路径 |
| m3-3 | `canStart === false` 只对 `serving` 断言过，`completed` / `refunded` 的旗标只被间接覆盖 | ✅ 已在用例 5 的循环里补上「两种状态各断言一次旗标为假」——旗标写错的话页面上会先渲染出一个点下去必然失败的按钮 |
| m4 | `api-contract.md` §2.8 的「选哪种幂等机制」入口表只列三种，**没有收录本轮实际使用的第四种**（状态本身即判据），而 §3.1 又提了一句 | ✅ 已补第四行（`acceptDispatch` P0-5 / `startCompanionOrder` P0-7），并把标题改成「四种机制并存」、加了一句「先问这个动作有没有天然的状态判据」 |
| m6 | 本文 §一 的「修改的项目文件 8」与同表六组之和（9）不符 | ✅ 已改为 9（实际也是 9） |
| m5 | P0-7 档案自身状态不一致：`README.md` / `02-decisions.md` 仍 `IN_PROGRESS`，而本文与进度表已 `AWAITING_ACCEPTANCE` | ✅ 本文件交付时统一翻成 `AWAITING_ACCEPTANCE`（`02-decisions.md` 的 `Status` 行同步；它是**追加历史**，状态行与 `### Decision V1` 一起在收尾时写） |

### 8.4 ⚠️ 明确**不**采纳的一条：HTTP 200 happy path（m3-1 / reviewer 的「我无法判断」第 2 条）

Reviewer 问：`用户权限表` §13 第 8 条要求「测试覆盖 401 / 403 / 404 / **正常业务结果**」，
是否必须在 HTTP 层补一条 200？**裁定：本轮不补，且这是有意的取舍，不是遗漏。**

理由（三条，按重要性排）：

1. **这是全仓一致的既有约定，不是本轮的漏洞。** `cancel` 的 HTTP 用例同样只有 401 / 403 / 404——
   Companion 域**从来没有过** HTTP 200 用例。在一轮里只给 `start` 加一条，会让两条同形状的路由
   有两套测试标准；要加就应该作为一个独立批次统一加（属于测试基础设施，不属于 P0-7 的业务范围）。
2. **补它的代价与收益不成比例。** 服务器是**独立进程**，它有自己的 store；要让 `:3213` 上的接口
   真的返回一次 `changed:true` 的 200，测试必须走完「下单 → 支付 → 接单 → start」的完整**写**链路。
   那意味着门禁跑一次就会往被测实例里写一张完整生命周期的订单——而 `APP_BASE_URL` 这一跑
   **也被用来对着用户自己的 dev 服务器跑过**（见 §6.3 旁证）。让一条只读的门禁变成会写数据，
   风险大于它要防的那个「包装层写错」。
3. **那个风险已经有别的守卫。** 路由是 10 行、与 cancel 同形状，且 **§6.4 的变异测试**
   已经证明这类「包装层退化」能被结构断言抓住；`ok(...)` 的响应信封由 1154 条用例里
   既有的接口形状测试覆盖。真正缺的那一格是「HTTP 层的成功信封里字段名对不对」，
   而这一格在 `04-acceptance.md` 的 A 组（手工走一次完整链路）里被正面验证。

**⚠️ 已记入批次最终报告的已知限制**，避免它随着「门禁全绿」被忘掉：
整个批次（含 P0-8 / P0-9）都不会有 Companion 写接口的 HTTP 200 用例，
这是**跨轮次的测试基础设施决策**，应由用户决定是否单开一轮补齐。

### 8.5 Reviewer 的 NOTE（记录，不要求本轮动作）

- **n1（最重要的一条）**：`applyOrderServing` 的 `servingAt: order.servingAt ?? at` 今天**不可达**，
  但它把「换人 / 回池后重新开始服务，`servingAt` 保留本单最早时刻还是改写为本次 assignment 的时刻」
  **这个尚未裁定的产品问题默默选了一个答案**。触发链是明确的：**P0-9 实现 `serving → paid` 时**
  若复用 `applyOrderAcceptanceReleased`（该写入器**不清 `servingAt`**）→ 回 `paid` 且 `servingAt` 残留
  → 新打手接单 → 点「开始服务」→ `??` 命中，**上一任打手的开始时间会成为这一单的开始时间**。
  ⚠️ **本轮不做任何改动**（`serving → paid` 本轮无入口，改了反而是替未来乱定规则），
  但**必须带进 batch 汇总**：请在 P0-9 的 `02-decisions.md` 里显式裁定后再动写入器。
- **n2**：结构门禁是**源码文本**断言，能挡无意的退化，挡不住有意的绕过（例如
  `void (order.status !== "accepted");` 也能让断言命中）。这是本项目既有取舍，已在 §6.5 自陈。
- **n3**：GBK 文件名损坏的未跟踪文件仍在工作区，**属于 P0-6.1**，本轮不碰（见 §1.1）。
- **n4**：`COMPANION_START_CONFIRM_NOTICE` 里「下单用户会看到这一单已经开始」是**事实**
  （用例 7b 正向钉住了用户端时间轴出现 `serving` 节点），不是「已为你通知用户」那种未冻结承诺。
- **n5**：Reviewer 复核了 §五 的自我论证，确认 `tests/companion.test.mjs` 的写入口门禁改动
  **不是放宽**（`deepEqual` 集合相等保留，只是期望集合加入新路由）。

### 8.6 第二轮：修复后的只读**复核**（这一轮的结论才是批次 §四 第 8 条的依据）

⚠️ 我自己修完 MAJOR 之后**不能自己宣布「已清零」**——那正是「修的人给自己打分」。
因此把同一份修复清单交回给**同一个 reviewer** 复核，让它对着磁盘上的当前内容重判。
复核轮独立重跑了四道门禁（`pnpm test` 读数与本文件终轮**完全相同**）、逐行核对了四个写入器的
函数行号与 `status:` 字面量行号（全部命中），并单独验证了 m2 的切片边界
（`functionBody("cancelAcceptedOrder")` 恰好停在 `startCompanionOrder` 之前，
因此 start 里的 `canTransitionOrder(` 不会污染它 → 该断言既非空转也不会永远为红）。

**复核结论：`BLOCKER = 0，MAJOR = 0`** ✅ ——批次 §四 第 8 条由此满足。

⚠️ **复核轮又抓到两条 MINOR（已修）**，两条都是**在修 M1 的过程中留下/暴露的**，值得记下来：

| 编号 | 问题 | 处理 |
|---|---|---|
| m7 | 我修 M1 时写的「真实迁移共四条」**仍不完整**：遗漏了退款路径可达的三条边。`applyOrderRefund` **不校验起始状态**（只短路「已经是 `refunded`」），而 `REFUNDABLE_ORDER_STATUSES` 含 `accepted` / `serving` / `completed`——即 `accepted/serving/completed → refunded` 都是运行时真实可达的，且被既有测试跑过。原文会让 P0-8 / P0-9 得出「退款只可能发生在 `paid`」的错误结论 | ✅ 已改：拆成**两类**分别写（生命周期动作四条 / 退款路径三条），并显式点出「**『退款只可能发生在 `paid`』是错的**」与它的证据位置；同时保留「不要照 `ORDER_TRANSITIONS` 逐行对齐」的警告 |
| m8 | 本文 §8.3 表头写「6 条」而表体 **8 行**——与本轮被点名的 m6（「8 与六组之和 9 不符」）是**同一类**缺陷 | ✅ 已改：说明「6 条中 m3 含三个子项，故表体 8 行；已修 6 / 刻意不补 2」 |

⚠️ **为什么这两条不再开第三轮复核**：m7 / m8 **都是复核轮自己给出的修法**（m7 的原话是
「把四条改成『由生命周期动作产生的四条…；另有退款路径可达的三条…』」，我按它的口径落地），
且**只动文档、不动代码与测试**。执行审阅者自己开的药方不需要再请它确认一遍；
但它们**记在这里**，将来若发现 m7 的措辞仍有偏差，应当从这一行往下追。

⚠️ **m7 的教训值得单独记一笔**：同一段文字我**改了一次仍然不准**。
「有没有漏掉别的入口」这件事不是靠重读自己刚写的那句能查出来的，而是要靠
**反向查**（`grep` 调用点、看写入器有没有前置状态校验、看哪些测试真的跑过那条边）。
上一轮我修 M1 时只核了「订单生命周期动作」的入口，没有反过来问「还有谁在写 `status`」。

复核轮同时确认：**没有修出来的新问题**，生产代码自首轮复核以来**未再变化**
（路由仍 52 行、`companionHttp.ts` 仍是单实参 `apiPost(...)`）。

⚠️ **一条留给下一轮的提醒（复核轮提出，已确认属实）**：直接跑
`node --test tests/xxx.mjs` 会因为**缺少 `--import ./tests/alias-hook.mjs`** 而报
`ERR_MODULE_NOT_FOUND`。这不是本轮缺陷（`package.json` 的 `test` 脚本自带该 hook），
但**下一轮起用 `pnpm test` 或补上 hook**，否则会把环境问题误读成代码问题。

---

## 九、Git

本轮**没有任何 Git 写操作**：没有 `git add` / `commit` / `push` / `reset` / `restore` /
`checkout` / `rebase` / `amend`。只读命令用过 `git status` / `git diff` / `git rev-parse`。

| 项 | 值 |
|---|---|
| 开工基线 `HEAD` | `249f7c1` |
| 本轮提交 | **无**（批次 §十二：所有 Git 写操作由用户本人执行） |
| `Git Commit` 字段 | 保持空白，由用户在统一验收后填写 |
