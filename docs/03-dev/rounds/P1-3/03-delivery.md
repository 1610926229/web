# P1-3 — 交付记录

Round ID: P1-3
Title: 管理员售后 / 投诉统一工作台
Status: **AWAITING_ACCEPTANCE**（⚠️ **Claude 不得自行 `DONE`**）
交付日期: 2026-09-29
指令: `docs/03-dev/rounds/cmd_p1-3.md`
决策: `docs/03-dev/rounds/P1-3/02-decisions.md`（D-P1-3-1 … D-P1-3-10，**Open 决策：无**）

---

## 一、一句话，以及这一轮真正难在哪

**一句话**：新增一个**只读**的售后待办队列 `/admin/aftersales`——把退款与投诉按
「未完结 / 处理中 / 已结束」三个视图混在一起排队，点进去是一个聚合了订单、用户、
打手、客服会话与履约退出历史的详情页，而**处置动作一个都没搬进来**，仍然调用
既有那两个 Console。

**这一轮真正难的地方不是写代码，是三个「不许」**：

| # | 不许 | 为什么这次特别容易踩 |
|---|---|---|
| 1 | 不许复制第二套 `open` 集合 | 聚合页天然想写一个 `status !== 'resolved' && status !== 'closed'` 之类的判断，那样第三份定义就诞生了 |
| 2 | 不许在聚合页复制事务逻辑 | 详情页要显示退款金额与「能不能批准」，最省事的写法是把状态机抄过来 |
| 3 | 不许整包返回实体 | 列表要显示昵称与订单号，`return { ...refund, order, user, companion }` 是零成本写法，也是隐私事故的标准入口 |

三条都被**测试钉住**，不是靠约定（见 §三）。

---

## 二、实现内容

### 2.1 新增文件（12 个，全部为新增，无一处改写既有业务规则）

行数是**整改后**的实测值（`wc -l`），不是落笔时的估值——整改把服务层里 5 处重复的
索引辅助函数删掉换成 `adminIndex`，因此该文件**变短**了，其余因 BLOCKER-1 的收窄逻辑而变长。

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/types/aftersale.ts` | 160 | `AdminAftersaleRow` / `Counts` / `ListData` / `ListQuery` |
| `lib/constants/adminAftersales.ts` | 498 | 视图常量、两个方向的视图映射（**包含关系，非反函数**）、**收窄谓词 `aftersaleRowInView`**、关键词五路、日期区间、排序、视图解析 |
| `lib/services/adminAftersales.ts` | 414 | 取数与组装：`queryAdminAftersaleList` / `getAdminAftersaleDetail` |
| `lib/services/adminIndex.ts` | 65 | **共用** `adminUserIndex` / `adminOrderIndex` / `missingUser`（见 2.7） |
| `app/api/admin/aftersales/route.ts` | 40 | 仅 `GET`；`requireAdmin()` → 解析 → service |
| `app/admin/(console)/aftersales/(list)/page.tsx` | 46 | 列表页（`PageProps<"/admin/aftersales">`，`strict: false`） |
| `app/admin/(console)/aftersales/(list)/loading.tsx` | 17 | 骨架屏 |
| `app/admin/(console)/aftersales/[caseType]/[id]/page.tsx` | 365 | 聚合详情页；非法 `caseType` 或查不到 → `notFound()` |
| `components/admin/AdminAftersaleTable.tsx` | 462 | 混合列表：筛选栏 + 四态 + 分页 |
| `components/admin/AdminComplaintSections.tsx` | 253 | 从投诉详情页抽出的**只读正文区块** |
| `components/admin/AdminRefundSections.tsx` | 345 | 从退款详情页抽出的**只读正文区块** |
| `tests/aftersalesWorkbench.test.mjs` | 819 | **29** 条用例 |

### 2.2 `open` 集合：**复用**，不是重新定义（D-P1-3-2）

唯一真值源仍然是既有那两个常量，本轮**一个字都没改**：

- `lib/constants/refunds.ts:249` `OPEN_REFUND_STATUSES`
- `lib/constants/complaints.ts:35` `OPEN_COMPLAINT_STATUSES`

`lib/constants/adminAftersales.ts` 只做**两个方向的映射**（⚠️ **是包含关系、不是反函数**：
`processing ⊆ open`，逐格断言只在**精确桶**上成立，详见 §3.4 末与 `D-P1-3-2` 的改写说明）：

```
aftersaleRefundViewOf(status)    : RefundStatus    → AdminAftersaleView
aftersaleRefundStatusesForView(v): AdminAftersaleView → readonly RefundStatus[]
```

- `closed` **不是**一张手写清单，而是**全体状态减去 `OPEN_*`** 导出（补集），
  因此将来给某个领域加一个终态，`closed` 自动跟上，不会漏。
- `processing` 是 `open` 的**真子集**（`AFTERSALE_IN_PROGRESS_STATUSES` =
  `{ refund: ["reviewing"], complaint: ["processing"] }`）。
- 服务层与页面**没有任何一处**再写 `status === "pending"` 之类的平行判断。

> ⚠️ 这条之所以要单独写一段：`counts` 的分桶用的是 `row.view`，而 `row.view` 就是上面
> `aftersale*ViewOf` 的结论——**收窄（`aftersaleRowInView`，按状态集合）与计数（`row.view`，
> 精确桶）是两条不同路径，不是一对反函数**。**一旦有人在这里补一个 `includes`，
> 两个方向就会各自演化**，而它们的数值等价正是靠「同源于 `OPEN_*`」保证的。

### 2.3 `counts` 的口径（D-P1-3-8，**已改写**）—— 本轮修掉的**两个**真实缺陷

> ⚠️ **本节在交付前复核后重写。** 第一版把三个视图做成**互斥三桶**并断言
> `open + processing + closed === all`，那是**错的**——详见 §五 缺陷 9（BLOCKER）。
> 下面记的是**修正后**的口径。

`counts: { all, open, processing, closed }` 的最终实现：

```ts
const counts: AdminAftersaleCounts = { all: 0, open: 0, processing: 0, closed: 0 };
for (const row of matched) {          // ← matched = caseType + 日期 + 关键词过滤之后
  counts.all += 1;
  if (row.view === "closed") counts.closed += 1;   // closed 是唯一与其它两桶互斥的
  else counts.open += 1;                            // ← open 含 processing，不再互斥
  if (row.view === "processing") counts.processing += 1;
}

// 这时才按当前视图收窄——**按状态集合**，不是按精确桶
const inView = query.view === "all"
  ? matched
  : matched.filter((row) => aftersaleRowInView(row, query.view));
```

于是成立的是这两条，**不是**三桶求和：

```
all === open + closed                ✅ 构造性成立
processing ⊆ open                    ✅ 构造性成立（「其中已经有人接手的那一部分」）
open + processing + closed === all   ⛔ 不成立（第一版就是错在这里）
```

`total` 随视图变化，而 `counts` **不受视图影响**（切到任意视图，四个角标都一样）。

#### 这个位置先后修过**两次**，两次的形状不同，都值得记

**第 1 次（视图下沉）**：把 `query.view` 下沉成仓储的 `statuses` 过滤参数，
`counts` 变成「在当前视图里数的」，另外两个角标恒为 0，而当时的恒等式仍然
**空洞地成立**（`x + 0 + 0 === x`）。修法是把视图收窄**移到计数之后**，
并**明令禁止**「查两次（一次不带 status、一次带）」的绕行方案。

**第 2 次（三桶互斥，即缺陷 9 / BLOCKER）**：修完第 1 次之后，为了让
`open + processing + closed === all` 成立，把三个视图做成了**互斥**三桶——
于是默认视图「未完结」里**只剩 `pending`**，把正在等管理员批准的 `reviewing` 退款
排除在外。**这个错误的来源是我自己写的 `D-P1-3-8`**：它要求那条恒等式，
而它与 `D-P1-3-2`（`open` = `OPEN_*` 全集、`processing` 是子集）、与标签「未完结」、
与页面上真的渲染着的 `ADMIN_AFTERSALE_LIST_NOTICE` **直接矛盾**。
修法是让代码回到已写下的意图：**收窄改为按状态集合**（`aftersaleRowInView`，
内部复用领域 `OPEN_*`），并把 `D-P1-3-8` 改写。

> **教训（写给后来人）**：规格里出现「求和恒等式」这类**好看的数学性质**时，
> 必须与「集合语义」那一条**对着读一遍**再落笔。两次缺陷都出在这个位置，
> 而且**第一次的修法直接引出了第二次**——第二次的测试还是照着第一次的错误口径写的，
> 因此它是**绿的**。缺陷 9 最终是被**页面上那句文案**揭出来的，不是被测试揭出来的。

### 2.4 聚合详情：**真的聚合了正文**，不是只有按钮

> ⚠️ 这是本轮第二个**真实缺陷**。第一版详情页只渲染了 `AdminRefundConsole` /
> `AdminComplaintConsole`——而这两个组件**只有操作区**（`AdminComplaintConsole.tsx:40`
> 自己写明了「用户提交的正文不在这里」）。结果是：页面能批准退款，却看不到用户写了什么。
> 违反 cmd 「订单、退款、投诉、打手、调查历史聚合详情」。

修法**不是**在聚合页里另写一份正文，而是把两个既有详情页的**只读区块抽成组件**：

| 抽出件 | 原来在 | 现在同时被 |
|---|---|---|
| `AdminRefundSections.tsx` | `refunds/[id]/page.tsx` | 原页 + 聚合页 |
| `AdminComplaintSections.tsx` | `complaints/[id]/page.tsx` | 原页 + 聚合页 |

抽取是**逐字节等价**的，不是重写：抽取后两页的 HTML 与抽取前**完全一致**（复核时对
三个 URL 做过字节级比对），区块文本 8/8 与 7/7 逐字相同。原页因此从 371 → 63 行、
269 → 55 行。

### 2.5 三个处置动作：**一个都没搬进来**（D-P1-3-3）

聚合页渲染的仍然是 `AdminRefundConsole` / `AdminComplaintConsole` 本体——
`start-review` / `reject` / `approve` / `close` 的按钮、幂等键、错误翻译、
服务端判定的 `allowedActions` **全部沿用**，聚合页**没有新增任何写接口**。

- `app/api/admin/aftersales/route.ts` **只有 `GET`**，测试第 13 条断言了这一点。
- 因此 P0-15 的三条规则（一单一退 / 批准后打手本单收益归零 / 部分退款不强制
  `Order.status = refunded`）在本轮**只可能被读错，不可能被改错**——
  工作台一行状态都不写。

### 2.6 权限：Admin only（D-P1-3-10）

- 接口：`requireAdmin()` 是处理函数的**第一个 `await`**，在解析查询参数**之前**。
  测试用的是「断言第一个 `await` 恰好是它」的写法（沿用 `tests/adminContentImages.test.mjs`
  里已验证过的模式），而不是 `indexOf` 比较——后者会被 import 块里的同名标识符骗过去。
- 页面：`app/admin/(console)/` 布局已经在会话层挡住非 admin（`canEnterAdminConsole()`）。
- **成对正反例**：匿名 401 / 客服 403 / 管理员 200，三条一起断言，
  避免「只测 200」这种不设防的写法。

### 2.7 顺带消除的一处四处重复（D-P1-3 之外，但属于本轮触发的整理）

`adminUserIndex` / `missingUser` 在 `adminOrders` / `adminComplaints` / `adminRefunds`
里**各有一份逐字节相同的副本**（`adminOrderIndex` 有两份），本轮新增的
`adminAftersales` 会成为第五份。因此在开始写之前先抽成 `lib/services/adminIndex.ts`。

- 行为等价由 7 个测试文件的 183 条用例 + `tsc` + `eslint` 全绿背书。
- **没有**顺手改任何语义：`missingUser` 的返回值、`adminOrderIndex` 的查询范围
  （`ADMIN_ORDER_UNFILTERED_QUERY`）逐字保持。
- ⚠️ 注意一处**刻意的不一致**：退款列表对「订单查不到」的处理是**当作这条退款不可读**
  （列表跳过 / 详情 404），与其它列表的「跳过该字段」相反。共用的是 `missingUser`
  这个函数，**不是**那条规则——`lib/services/adminRefunds.ts` 里留了注释说明。

### 2.8 本轮改动集合（tracked 文件，**9 个**）

⚠️ **这张表是「P1-3 动了哪些 tracked 文件」的归属判断，不是 `git` 给的事实。**
工作区里同时躺着 P0-13 fix / P0-14 / P0-15 / P1-1 / P1-2 的未提交改动
（`git status` 显示 **113 个** tracked 文件被改），**无法用 `git diff` 切出本轮范围**。
因此本表由**逐一读源码**得出：下面每个文件确实含 P1-3 的改动；
但**反过来不成立**——其中几个文件（尤其 `lib/constants/admin.ts`、`lib/mocks/debug.ts`、
`tests/admin.test.mjs`）**同时含其它轮次**的改动，不能把整份 diff 都算在本轮头上。

| 文件 | P1-3 的改动性质 |
|---|---|
| `lib/services/adminOrders.ts` / `adminComplaints.ts` / `adminRefunds.ts` | 删掉各自的索引函数副本，改为 import `./adminIndex` |
| `lib/services/adminHttp.ts` | 新增 `fetchAdminAftersales`（**只读**浏览器客户端） |
| `lib/constants/admin.ts` | 新增 `ADMIN_AFTERSALES_PAGE_TITLE` + 侧栏第 10 项；合并 `ADMIN_OVERVIEW_NOTICE` 上两段叠放的 JSDoc |
| `lib/mocks/debug.ts` | 新增 `aftersales` 空数据面（`?mockEmpty=aftersales`） |
| `app/admin/(console)/complaints/[id]/page.tsx`、`refunds/[id]/page.tsx` | 改为引用抽出的 Sections |
| `tests/admin.test.mjs` | 新页面/新接口登记进四张清单（页面、详情页、侧栏、接口） |

**未改动**：`lib/constants/refunds.ts`、`lib/constants/complaints.ts`、
`lib/constants/orderAmount.ts`、`lib/data/**`（一个文件都没有）。
——即：本轮**没有修改任何业务规则**，只新增了一个读取视图。
（这一条是**P1-3 未改**的声明，同样由读源码得出；`lib/data/**` 下那些被改的文件
属于 P0-14 / P0-15 / P1-2 等轮次，与本轮无关。）

---

## 三、门禁读数（2026-09-29 实跑，本轮最终树）

### 3.1 定点运行

```
$ node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs \
    --test tests/aftersalesWorkbench.test.mjs
ℹ tests 29   ℹ pass 28   ℹ fail 0   ℹ skipped 1
```
（skip 的那 1 条是需要 `APP_BASE_URL` 的 HTTP 鉴权用例，在 §3.2 的 production 全量里真实执行。）

### 3.2 全量门禁（**最终树**，第三轮）

本表是**整改后、且修完第二轮两条 MINOR 注释之后**在同一棵树上复跑的结果，
即交付读数。前两轮的读数见 §3.3 的沿革表——**不是**本表的数字被改写。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量测试（未起服务） | `pnpm test` | `tests 1612` · `pass 1443` · **`fail 0`** · `skipped 169` |
| 类型检查 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | **exit 0**，无输出 |
| Lint | `pnpm lint`（`eslint`） | **exit 0**，无输出 |
| 生产构建 | `pnpm build` | **exit 0**；`/admin/aftersales`、`/admin/aftersales/[caseType]/[id]`、`/api/admin/aftersales` 三条路由均出现在产物清单 |
| **production 全量** | `APP_BASE_URL=http://localhost:3106 pnpm test` | **`tests 1612` · `pass 1612` · `fail 0` · `skipped 0`** |

> **production 全量 169 条 `APP_BASE_URL` 用例全部真实执行且全绿**，`skipped` 归零。
> 服务确已停：`netstat -ano | grep :3106 | grep LISTENING` 无输出，`curl` 返回 `000`（连接被拒）；
> 停服务用的是 `taskkill //F //T //PID 11876`（`//T` 连子进程一起杀，否则会测到旧进程）。
>
> ⚠️ **第三轮与第二轮读数完全相同（1612 / 1443 / 0 / 169；production 1612 / 1612 / 0 / 0）**，
> 这不是「没跑」，而是**预期结果**：第三轮唯一改动是两条**注释**（`lib/types/aftersale.ts` 与
> `02-decisions.md`），不可能改变任何一条用例的结果。三连跑一致恰好是这次改动的**无害性证据**。

### 3.3 用例数沿革

| 时点 | tests | pass | skipped |
|---|---|---|---|
| P1-4 交付时（P1-3 未落盘） | 1583 | 1415 | 168 |
| P1-3 首版（**整改前**） | 1608 | 1439 | 169 |
| **P1-3 最终树（整改后）** | **1612** | **1443** | **169** |
| 差值（最终树 − P1-4） | **+29** | **+28** | **+1** |

`1612 − 1583 = 29` 正是 §2.1 里那个测试文件的用例数：首版 25 条，整改加了 4 条
（BLOCKER-1 的守门人、`aftersaleRowInView` 的结构约束、分页越界规范化等），**最终 29 条**。
`+28 pass / +1 skip` 是其中 28 条纯逻辑用例通过、1 条 HTTP 用例在未起服务时按设计跳过——
整改新增的 4 条全部是纯逻辑用例，因此 `skipped` 在整改前后**都是 169**，没有变。

### 3.4 受控 mutation 红-绿证伪

新增断言首跑即全绿，因此必须另外证明**它们有杀伤力**，否则可能只是一组恒真的空断言。
用受控注入（注入 → 观察变红 → 还原 → 观察回绿）证明。**共 3 个探针：2 个完成红绿，
1 个被安全策略正当拦截。** 还原一律用 `git hash-object` 与注入前比对。

> ⚠️ **协调者已独立复算下面三个哈希**（`git hash-object` 现跑，不是采信 agent 的转述）：
> 三个文件的**当前**哈希与 agent 声称的「还原后」哈希**逐一相同**——
> `342978ff…dcba53` · `e23765ff…5894f0d` · `e115d736…c61446`。
> 这同时证明两件事：还原是**字节级精确**的，且登记的哈希**不是编的**。
> （这三个文件里有两个是**未跟踪**文件，`git diff` 对它们无效——
> 这正是本轮要求「用 hash 而非 diff 证明还原」的原因。）

#### 探针 A — `lib/services/adminAftersales.ts`：把 `counts` 下沉到视图（不变量 #1）

把计数循环**整块移到** `inView` 声明之后，并改成 `for (const row of inView)`——
即 §2.3 描述的那个真实缺陷形态。

- **变红用例**：`counts 恒等式与四视图一致：counts 不含视图筛选（防视图下沉到仓储的缺陷）`
- **断言差异**（`view=open`）：
  ```
  actual:   { all: 4, open: 4, processing: 0, closed: 0 }
  expected: { all: 12, open: 4, processing: 3, closed: 5 }
  ```
  ⚠️ 注意这里 `open` **两边都是 4**——缺陷不会让当前视图的数错，只会让**另外两个角标恒为 0**，
  而 `open + processing + closed === all` 仍然**空洞地成立**（`4 + 0 + 0 === 4`）。
  这正是「测试全绿但功能是坏的」的标准形状，也是这条断言必须同时钉住**三个桶的绝对值**
  而不能只钉恒等式的原因。
- **还原**：`git hash-object` = `342978ff5e74bfd511add38e2240c5bb93dcba53`，与注入前一致。
  （另经**直接读源码**独立复核：计数循环迭代的是 `matched`，`inView` 在其后声明。）

#### 探针 B — `lib/constants/adminAftersales.ts`：把 `processing` 分支塌回 `open`（不变量 #3）

把 `aftersaleRefundViewOf` 末段 `? "processing" : "open"` 改成 `? "open" : "open"`。

- **变红 5 条**，最关键一条：`退款视图反函数对：对全部 RefundStatus 逐格断言「精确桶 ⟺ viewOf === view」`
  ```
  refund reviewing × view open 反函数不一致
  false !== true
  ```
- **连带变红 4 条**：counts 恒等式 / counts 独立分桶 / caseType 筛选 / 日期筛选
  （`reviewing` 被错归到 `open`，open 与 processing 各错一位）。
- **还原**：`git hash-object` = `e23765ff49da02d72a0724b56a25dcaf55894f0d`，与注入前一致。

> 探针 B 的价值在于证明**「唯一真值源」这条约束是被真的钉住的**：把状态往错误的桶里挪一格，
> 五个断言一起红。如果只有 `viewOf` 一侧被断言、另一侧没人管，这个注入会是全绿。

#### 探针 C — `app/api/admin/aftersales/route.ts`：把 `requireAdmin()` 移到解析之后 ⛔ **未产出红结果**

计划：把 `await requireAdmin()` 从第一个 `await` 挪到 `resolveAdminAftersaleListQuery` 之后。

- **结果：注入动作本身被 auto-mode 安全分类器拒绝**，理由是仓库既有规则
  **「受控 mutation 不能摘鉴权守卫」**——不允许为了红绿验证而把鉴权挪到业务之后，**哪怕临时的**。
  文件随即被还原，未尝试第二次。
- **还原凭证**：`git hash-object` = `e115d73622bf75e6e381c0d73ab49f48abc61446`；该文件为未跟踪文件，
  另以 `git diff --stat app/api/` 为空 + **直接读源码**双重确认。
- **诚实结论**：**cmd 第 13 条的「guard 先于解析」这一条断言，没有红-绿证据。**
  它目前的判别力来自**结构性断言**（handler 的第一个 `await` 必须**恰好是** `await requireAdmin()`，
  同 `tests/adminContentImages.test.mjs` 的既有模式；且 `indexOf(..., requireIdx)` 从守卫之后起搜，
  调用点若跑到守卫之前会返回 `-1` 而如实报错）。
  这是**已知的、可接受的缺口**：为了拿到这段证据而临时摘守卫，代价高于收益，且违反仓库安全约定。
  **登记在案，不补。**

#### 3.4.1 关于「恒真断言」的一次主动规避（记录，因为它差点写错）

`D-P1-3-2` 规定 `processing ⊆ open`，因此 `aftersaleRefundStatusesForView("open")`
**包含** `reviewing` / `processing`，而 `aftersaleRefundViewOf("reviewing") === "processing"`。
⇒ **字面上的「互为反函数」不成立**，只有对**精确桶**（`open` 扣除 `processing`）才成立。

test-agent 因此把断言写成「精确桶 ⟺ `viewOf === view`」，而不是字面的双向等价——
后者会**钉住一条与决策文件相矛盾的伪规则**，且它会恒绿（因为写的时候就是照着它写的）。
⚠️ 这是本轮唯一一处「差点为了好写而钉错规则」的地方，单独记一段。

---

## 四、本轮**没有**做的事（明确声明，避免被读成遗漏）

| 不做 | 依据 |
|---|---|
| 新 `resolution` / 处置结论枚举 | cmd「本轮不创造新的处置结论类型」· D-P1-3-10 |
| 钱包 / 追偿 / Scheduler / chat retention / 真支付 / 真数据库 | cmd §不做 · 批次限制 |
| 删除既有的 `/admin/refunds`、`/admin/complaints` 入口 | cmd「如已有则复用」· D-P1-3-1 |
| 任何写操作（工作台是只读队列） | D-P1-3-3；接口只有 `GET` |
| 按打手 id 的独立筛选参数 | D-P1-3-5（走关键词第 5 路，不新造参数） |
| 抽取订单详情页的「履约退出历史」区块 | 见下 |

### 关于「履约退出历史」的**未抽取**决定（登记，不是遗漏）

聚合页与订单详情页各有一段「履约退出历史」渲染，形状接近但**不是**同一份代码。
决定**不抽取**，理由：

- 抽取必然改动**已经验收过的订单详情页**的渲染（字段顺序或「原因」用的原语），
  属于「为了整洁去动一个无关的已验收页面」。
- 真正会出问题的分歧（多行长文本的原因被 `<span>` 折叠）**已经单独修掉**：
  聚合页用的是与订单页一致的 `FieldBlock`（`whitespace-pre-wrap`），
  不是会折叠换行的 `DetailRow`。
- **重新评估的条件**：若将来要改这两处中的任意一处，届时一并抽取。

---

## 五、本轮修掉的缺陷清单（全部在交付前，非事后追加）

| # | 级别 | 缺陷 | 发现方式 | 处置 |
|---|---|---|---|---|
| 1 | **MAJOR** | `counts` 被视图筛选影响 ⇒ 三个角标恒为 0 | 复核源码 + 构造四视图读数对比 | 视图收窄移到计数之后；禁止两次查询的绕行方案 |
| 2 | **MAJOR** | 聚合详情页**只有操作按钮**，看不到案件正文 | 复核 `AdminComplaintConsole.tsx:40` 的自述 | 抽出两个 Sections 并复用；原页 HTML 逐字节不变 |
| 3 | MINOR | 释放原因用了会折叠换行的 `DetailRow` | 对比订单页原语 | 改用 `FieldBlock` |
| 4 | MINOR | 页面说明写着「本页只读聚合」却渲染了操作按钮 | 阅读页面文案 | 改写为如实描述 |
| 5 | MINOR | 四个列表各有一份逐字节相同的索引函数 | 写新服务前普查 | 抽成 `lib/services/adminIndex.ts` |
| 6 | MINOR | 一条断言**恒不可能为真**（比较的两个 `indexOf` 落在 import 块顺序上） | 复核测试时发现 | 改为「断言第一个 `await`」模式；**明令禁止**删断言/调 import/改名绕开 |
| 7 | MINOR | `P0-15/README.md` 头部 `IN_PROGRESS` 与其自身状态沿革表矛盾 | 交叉核对 | **只同步头部**，正文一字未改，非状态迁移 |
| 8 | MINOR | `ADMIN_OVERVIEW_NOTICE` 上叠了两段 JSDoc，后者遮蔽前者 | 阅读源码 | 合并成一段，不新增内容 |
| 9 | **BLOCKER** | `view=open`（**默认视图**「未完结」）只装 `pending`，把 `reviewing` 退款与 `processing` 投诉漏在外面——而**同一个页面上渲染着的**说明原文写着「退款：待审核 / **审核中**」 | **交付前独立只读复核（BLOCKER-1）**；判据是页面自己那句文案 | 收窄改为**按状态集合**（`aftersaleRowInView` 复用领域 `OPEN_*`）；`counts` 改如实；**改写 `D-P1-3-8`**（错的是它） |
| 10 | **MAJOR** | 本轮为消除重复而新建的 `lib/services/adminIndex.ts`，被**同一轮新写**的 `adminAftersales.ts` 绕过——三个索引函数出现第 5 份副本 | 交付前独立只读复核（MAJOR-1）；我已独立复算确认 | 删除本地副本，改为 `import … from "./adminIndex"`；行为零变化 |
| 11 | MINOR ×4 | ① `NoOrderSection` 用投诉专属文案渲染退款；② `updatedAt` 进了 DTO 但无人渲染；③ 注释称操作区「位置与先前一致」与事实相反；④ 越界页码显示「没有案件」而分页显示「第 3 页 · 共 12 条」 | 交付前独立只读复核 | 四条全部修掉（②为删字段，与 D-P1-3-9 的 DTO 最小化口径对齐） |
| 12 | MINOR | `AdminAftersaleRowView` 的注释写「收窄**与计数**都走 `aftersaleRowInView`」，**指了一个不存在的调用点**——计数实际走 `row.view` 精确桶分批 | 整改后**第二轮独立复核**（M1） | 改写为「两条路径不同、同源数值等价」，并点明计数落在服务层 |
| 13 | MINOR | `D-P1-3-2` 仍写「双向函数必须**互为反函数**」，与同轮改写后的 `D-P1-3-8`（`processing ⊆ open`）和代码注释冲突 | 整改后第二轮独立复核（M2） | 改写为「包含关系，不是反函数」，附改写说明；本轮**未**因此改任何行为 |

> ⚠️ **缺陷 9 的发现方式值得单独记一句**：它不是被测试发现的——测试反而是**绿的**，
> 因为测试的期望值是照着那条错误的口径写的（见 §2.3 的「教训」）。
> 它最终是被**页面上那句已经写对的文案**揭出来的：文案说 `open` 含「审核中」，
> 代码说 `open` 只含「待审核」，两者不可能同时为真。
> **这正是「注释与文案在本仓库被当作证据」的价值所在。**

---

## 六、reviewer 结论

### 6.1 第一轮独立只读复核：**必须修复后重审**

结论原文：**1 BLOCKER · 1 MAJOR · 4 MINOR**，其余维度（分层、权限、DTO 隐私、金额口径、
分页排序、测试质量、抽出忠实性）**未发现问题**。

复核做的独立取证（不是读代码猜）：`git show HEAD:` 逐字比对抽出前后的 label / section 标题、
只读探测直接调服务层打印四视图的 `counts` 与 `total`、`node --test` 定点、`tests/admin.test.mjs` 的 diff 通读。

**未发现问题的部分（复核明确背书）**：

- **分层**：`app/**` / `components/**` 不 import `lib/data`、不直接 `fetch`；客户端走 `lib/services/adminHttp.ts`。
- **无第二套**：工作台不 import 任何 `*Transaction.ts`，新增接口只有 1 个且只有 `GET`。
- **无新枚举**：`open/processing/closed` 只是视图分桶，**没有**写进 `RefundStatus` / `ComplaintStatus`，
  未发明 `resolution`（D-P1-3-10 / cmd「不做」）。
- **DTO 隐私**：顶层字段被测试逐字钉死；序列化负例覆盖 `gameAccountId / remark / description / evidence /
  contact / reviewNote / reasonKey / result / companionBaseIncome / actualPaidAmount / refundedAmount /
  totalAmount / companionReversalAmount / openid / unionId`；**无** `companionRateBp`、成本、抽成。
- **金额**：投诉恒 `null` 而非 0；退款 `decidedAmount` 与既有 `toAdminRefundListItem`
  **同一表达式**，未就地重算；页面只 `formatYuan`，无算术。
- **抽出忠实性**：投诉页 10 个 label + 6 个 section 标题**完全相同**；退款页 16 个 label 中 15 个相同，
  唯一消失的是「平台承担」——**正是 P0-15 责任模型废止时删除的那一行**，新组件注释里有记录。

**两条被复核指出、我采纳并已修的**：缺陷 9（BLOCKER，见 §五）与缺陷 10（MAJOR），外加 4 条 MINOR。

> ⚠️ **关于缺陷 9 的修法方向**：复核给了两个方案，并说明「若按『只改文案/标签』方案收敛，
> 重审可只复核该处」。**本轮选的是另一条**——把**代码**改成符合已写下的文案
> （因为 cmd 的核心约束、`D-P1-3-2`、标签「未完结」与页面说明**四者一致**，只有代码是异类），
> 因此改动**比「改文案」大**（收窄逻辑 + counts 口径 + 类型注释 + 测试）。
> **相应地，重审不按窄范围走，做完整复核。**

**复核明确表示无法判断、我也不主张的两件事**（如实登记，不装作已解决）：

1. 「抽出前后逐字节等价」只能对齐到 `HEAD`——工作区 diff 同时含 P0-14 / P0-15 的改动，
   无法还原「P1-3 前一刻」的快照。复核比对到 label / 标题全部一致、无无法解释的内容丢失，
   但**这一条的证据强度低于 §2.4 里那三次 URL 的字节级比对**（那是抽取当场做的，窗口是对的）。
2. `loading` / `retry` 属组件行为，Node 24 不剥 JSX，**无自动化覆盖**——项目既有约定，转人工验收。

### 6.2 第二轮复核（对整改增量）：**0 BLOCKER · 0 MAJOR · 2 MINOR**

结论原文：**「BLOCKER 已真实修好……可以进 `AWAITING_ACCEPTANCE`。」**
按 §6.1 末尾的约定，这一轮**做的是完整复核、不是窄范围复核**。

复核独立复现了整改的正确性（**不是读我的报告**）：用
`node --import ./tests/alias-hook.mjs` 直接调服务层，打印四视图的 `total` 与 `counts`：

```
view=all         total=12  counts={"all":12,"open":7,"processing":3,"closed":5}
view=open        total=7   counts={"all":12,"open":7,"processing":3,"closed":5}
view=processing  total=3   counts={"all":12,"open":7,"processing":3,"closed":5}
view=closed      total=5   counts={"all":12,"open":7,"processing":3,"closed":5}
```

`counts` 在四个视图下**恒定**（不随视图下沉），`counts.open(7) === view=open 的 total(7)`、
`all(12) === open(7) + closed(5)`、`processing(3) ⊆ open(7)`，且
**`open + processing + closed = 15 ≠ all(12)`**——正是要求的有意不成立。
复核逐条列出了 `view=open` 的那 7 行及其精确桶，确认 `rf-seed-1001-02`（`reviewing`）与
两条 `processing` 投诉**都在里面**，并明确检查了「有没有人把 `open` 收窄回去凑恒等式」——结论是没有。

**复核确认已修的**：MAJOR-1（索引重复定义已删净，改为 `import … from "./adminIndex"`）、
4 条 MINOR（`NoOrderSection` 分支、`updatedAt` 已删、操作区位置注释已改对且**未抹平**两处布局差异、
越界页码与空数据已按 `total` 区分）。
**逐条核对测试未被削弱**：数值全部与复核的独立重算一致；断言都是 `deepEqual` / `equal`
精确值或显式 id 名单（3 条必须在、2 条必须不在、总数恰为 7），无「两者都接受」「只断言非空」「删一半」。
复核另确认第一轮「死代码」的提法在本轮**已不成立**（`aftersale*StatusesForView` 被
`aftersaleRowInView` 生产调用、`aftersale*ViewOf` 被服务层调用）。

**第二轮指出、我已修的两条 MINOR（均为注释/文档自相矛盾，不影响行为）**：

| # | 位置 | 矛盾 | 处置 |
|---|---|---|---|
| M1 | `lib/types/aftersale.ts` 中 `AdminAftersaleRowView` 的注释 | 写着「收窄**与计数**都走 `aftersaleRowInView`」，但计数实际走 `row.view` 精确桶分批（同文件另一处注释说的才是对的） | 已改写为「两条路径不同、同源数值等价」，并点明计数在服务层 |
| M2 | `docs/03-dev/rounds/P1-3/02-decisions.md` `D-P1-3-2` | 仍写「双向函数必须**互为反函数**」，与同轮改写后的 `D-P1-3-8`（`processing ⊆ open`）与代码注释直接冲突 | 已改写为「包含关系，不是反函数」，并附改写说明 |

> ⚠️ **M1 的性质值得记一笔**：它不是「注释写得不细」，而是**指了一个不存在的调用点**——
> 按它去服务层找「counts 调 `aftersaleRowInView`」会找不到。这正是复核该抓的那类缺陷：
> 两种写法数值等价，所以任何测试都不会变红，**只有读注释的人会走错路**。

**复核明确表示无法判断的一件事**（如实登记）：第一轮报告的 5 条「被更新」测试的旧文本
无法逐字比对——测试文件与 5 个范围文件都是 **untracked**，没有 diff 基线。
复核改用「按新语义独立重算事实」的方式验证，结论是断言未放宽；
但**要逐字比对需要第一轮快照，本批次没有留**（批次全程禁 Git 写操作，没有 stash/commit 可作基线）。

### 6.3 两轮结论的**性质**不同（沿用 P0-15 的记法）

第一轮是**独立只读复核**（不是我自己的声明），其 BLOCKER / MAJOR 是**外部发现**，
不是我「自查后宣布已修」。第一轮里我自己的自查结论（缺陷 1–8）与复核结论（缺陷 9–11）
**分开记录**，不混成一张表充当「全部已修」。

---

## 七、Git 状态（**只读观测**）

⚠️ 本批次**全程禁止任何 Git 写操作**——没有 `add` / `commit` / `stash` / `checkout` / `restore`。
`Git Commit:` 保持 `—`，由人工提交。

本轮全部产物**均为未跟踪文件或工作区改动**（12 个新增文件 + 9 个 tracked 文件改动），
与批次开始前就存在的未提交工作区**混在同一棵树上**，无法用 `git diff` 单独切出本轮范围。

⚠️ **这一点必须说准确，不能靠 `git` 的读数蒙混**：`git status` 显示工作区共
**113 个 tracked 文件**被改（含 P0-13 fix / P0-14 / P0-15 / P1-1 / P1-2 的累积改动）。
因此**「本轮只改了 §2.8 那 9 个文件」不是 `git` 能证明的**——它由**逐一读源码**得出，
其中几个文件还同时含其它轮次的改动。**读者若想独立核对，只能去读源码，不能去读 `git diff`。**

交付前做了**两项核对**，各自解决不同的问题：

1. **tracked 改动**：逐一读源码，确认 §2.8 那 9 个文件确实含 P1-3 的改动
   （**不声称**它们的整份 diff 都属于本轮）。
2. **未跟踪的新文件**：同样只能**直接读源码**核对——`git diff` 对未跟踪文件完全无效。
   这是本轮红-绿还原验证里栽过的坑：agent 承诺的 `git diff --stat lib/` 证明
   对 `lib/services/adminAftersales.ts` 是**无效证据**（它是未跟踪文件），
   最终只能靠**直接读源码**确认注入已还原。
