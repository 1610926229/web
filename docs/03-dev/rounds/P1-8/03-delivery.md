# P1-8 · 交付记录

> Round：`P1-8` 订单评价闭环
> 交付日期：**2026-10-02**
> 状态：**`AWAITING_ACCEPTANCE`**（未 `DONE`，等人工验收）
> ⚠️ 本轮**零 Git 写操作**：`git add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend` 全程未执行，全部改动保留在工作区。

---

## 一、本轮做了什么

一句话：**把评价从「能写一条记录」做成一个闭环——双维度、有审核、公开面由真实评价算出来。**

分五块。

### 1.1 数据模型：单维度 → 双维度，补上聚合身份

| 项 | 改前 | 改后 |
|---|---|---|
| 评价对象 | 一份合并的 `rating` + `content` | `productReview` 与 `companionReview` **各自独立**的 `{ rating, content }`（`D1`/`D2`） |
| 是否可只评一项 | 结构上不可能 | 允许，**至少一项非空**（`D3`）；未评的维度恒为 `null` |
| 聚合身份 | **没有** `productId`（`C5`） | 新增 `productId`；打手侧取 `companion.id`（`R4`） |
| 谁被打分 | 未区分 | **最终实际履约打手**（`D4`）：A→B 换人后只评 B（`D5`） |
| 状态 | **无状态**（提交即终态） | `pending \| approved \| rejected \| hidden` 四态五迁移（`D7`） |

⚠️ **`productId` 与三个快照字段的分工是硬性的**（`R4`）：`productId` 是聚合身份
（决定这条评价计入哪件商品），`productTitle` / `productCoverUrl` / `specName` 是
**下单那一刻的事实**（商品改名或下架后，历史评价仍显示当时的名字）。两者不可互相替代——
用快照反推身份会让改名后的评价整批漂到别的对象上；用身份替代展示会显示今天的名字。

⚠️ **迁移纪律**（`R5`）：**不猜**存量旧数据。本仓库的存量**全部是 Mock 预置**，
因此按末句处理——**重建为符合新模型的真实 fixture**（`reviewSeed.ts`），
不为兼容一份演示数据在长期模型里留兼容字段。**没有**把旧的那份合并 `rating` / `content`
复制进两个维度——那会凭空造出「用户给打手也打了分」的事实。

### 1.2 审核闸门（`D7`–`D12`）

```
pending  → [approved, rejected]      新提交一律 pending
approved → [hidden]                  管理员认为不该继续公开
rejected → [pending]                 作者重新提交（同一条记录，D9）
hidden   → [approved]                恢复公开（D11）
```

- **四个动作是四个接口地址**，不是 `PATCH /reviews/[id]`：审计的 `action`
  直接取自地址（`review.approve` / `review.reject` / `review.hide` / `review.unhide`），
  若用一个 `PATCH` 带 `{action}`，审计就得**再从请求体里解析一次动作名**——
  而请求体是调用方可以写错的，URL 不是。
- **必须填原因的是 `reject` 与 `hide`**（`D10`）；`approve` 与 `unhide` 不读原因，
  但 `unhide` **必须**写审计（`D11`）：要能回答「谁在什么时候把它放回公开列表」。
- **管理员改不了内容**（`D12`）：四个动作只写 `status` 与两个原因字段，
  `productReview` / `companionReview` / `evidence` / `createdAt` / `updatedAt` 一个都不动。
  `tests/reviewClosure.test.mjs` 有一条断言逐字段比对审核前后的内容，
  并在请求体里塞进 `productReview` / `rating` / `content` 证明服务端**根本不读**这些键。
- **`reject` 不是删除**（`R2`）：记录、内容、凭证原样留着，作者看到状态与驳回原因，
  点「重新提交」回到 `pending`——**同一条记录**，不产生第二条。
- **状态机外的动作一律 400，且文案说出该用哪个**：对已通过的点「驳回」→ 提示改用「隐藏」；
  对隐藏中的点「通过」→ 提示必须用「恢复公开」。若把 `hidden → approved` 放行成 `approve`，
  审计里会留下 `review.approve`，读起来像「通过了一条新评价」。

### 1.3 公开面：静态假分数退出业务真值（`D17`、`R3`、`D14`、`D15`）

| 项 | 改前 | 改后 |
|---|---|---|
| 平均分来源 | `companionSeed` 里写死的 `rating = 4.7` | **`approved` 的 `OrderReview` 实时聚合** |
| 评价条数 | 写死的 `reviewCount = 3` + 内嵌 `reviews[]` | 聚合给出，**数的是维度不是条数** |
| 实体字段 | `Companion` 上有 `rating` / `reviewCount` / `reviews` | **三个字段全部删除**；公开 DTO 上仍有，但每次读取现算 |
| 无评价时 | 0 分 | **`null`**，展示「暂无评分」（`0.0` 是「真的被打了 0 分」，两件事） |
| 商品侧与打手侧 | 各自一套 | **同源**：唯一入口 `lib/services/reviewAggregates.ts` |

⚠️ **同源是本轮的硬约束**（`R3`）。商品详情与打手详情是两条互不相干的调用链，
如果各自写一遍「查评价 → 滤 approved → 算平均 → 脱敏」，两边迟早漂移——
一边漏了状态过滤、一边把 `reviewCount` 数成了条数，而**两套实现都能看起来正常**，
差别只在有没有人点进那一条被隐藏的评价。因此取数也收敛成一份：
两个页面服务都调 `loadReviewAggregate()`，内部固定走纯函数 `buildReviewAggregate()`。

⚠️ **昵称脱敏也在同一个模块**（`D13`）：聚合结果的 `nickname` 已经是脱敏值，
且 `ReviewAggregate` 的形状里**根本没有** `userId` 的位置。
「商品页一套脱敏规则、打手页另一套」在本结构下不可能发生。

⚠️ **聚合口径**：只有 `approved` 计入；`hidden` **立刻扣掉**、`hidden → approved` **立刻加回**
（`D14`）；平均分 1 位小数；最近 **3** 条按 `createdAt` 倒序并标记截断（`D15`）。

### 1.4 退款与评价是两条线（`D18`–`D20`）

| 场景 | 能否评价 | 判据 |
|---|---|---|
| 已完成，之后部分退款 | ✅ 能 | 状态仍是 `completed`，`completedAt` 在 |
| 已完成，之后**全额**退款 | ✅ **能** | 状态变 `refunded`，但 `completedAt` **没有被改写** |
| 完成前退款（`paid`/`accepted → refunded`） | ❌ 不能 | **没有** `completedAt` |
| 已 `approved` 之后发生退款 | 评价**保持公开** | 退款不构成撤下的理由（`D20`） |

⚠️ **判据是既有的 `completedAt` 这个事实**（`D19`），**不新增**「服务是否完成」这类状态。
⚠️ **不得**把退款偷偷映射成 `approved → hidden`（`D20`）：违规与否由管理员**独立**判定，
想撤下就显式隐藏，并且要写原因（走的是 `hide`，审计里留下 `review.hide`）。

### 1.5 权限（`D21`）

| 角色 | 能读什么 | 落点 |
|---|---|---|
| 作者本人 | 自己的**全部**四种状态 + 状态标签 + 驳回/隐藏原因 | `GET /api/reviews`（`requireUser()`） |
| 游客 / 普通用户 | 只有 `approved` | 公开聚合**没有会话参数**——读侧只有这一种查询 |
| 打手 | 只有自己的 `approved` | **没有打手端评价入口**（见下） |
| 客服 | 可读全部（含状态），只读 | **没有客服端评价入口**（见下） |
| 管理员 | 全部 + 处置权 | `requireAdmin()` **逐个接口**强制 |

⚠️ **打手端与客服端「不打表面」是有意的范围决定，不是遗漏**：
`D21` 说的是上限不是下限，而本轮这两个工作台**没有评价这项业务**。
建一个只读表面会凭空多出一个没有使用场景、却要长期维护权限的界面。
实质要求仍然成立——**它们拿不到任何评价数据**（`/api/companion/reviews` 与
`/api/staff/reviews` 都**不存在**，404），因此「不得提前看到未公开的评价与管理备注」成立。
将来若需要，`lib/services/adminReviews.ts` 是现成的只读取数层，不需要新写规则。

⚠️ **权限全部在 Route Handler 里强制**，不是靠隐藏按钮。
`tests/reviewClosure.test.mjs` 有一条断言守着「服务层不解析会话」：
`lib/services/adminReviews.ts` **去掉注释后**不得出现 `requireAdmin` / `requireStaff` /
`getSessionUser` / `cookies(` / `@/lib/auth`。

---

## 二、改动清单

### 2.1 新增

| 层 | 文件 |
|---|---|
| 类型 | `lib/types/review.ts`（`OrderReview` / `ReviewDimension` / `ReviewStatus` / `ReviewAggregate` / `PublicReviewItem` / `ReviewListItem` / `AdminReviewListItem`） |
| 规则 | `lib/constants/reviews.ts`（状态机、四动作、聚合纯函数、脱敏、DTO 转换）、`lib/constants/adminReviews.ts`（筛选、角标、可执行动作、错误文案） |
| 数据 | `lib/data/reviewRepository.ts`、`lib/data/mockReviewRepository.ts`、`lib/data/adminReviewTransaction.ts`、`lib/data/companionOrderTransaction.ts` |
| 取数 | **`lib/services/reviewAggregates.ts`（唯一的聚合入口）**、`lib/services/reviews.ts`、`lib/services/adminReviews.ts` |
| 接口 | `app/api/reviews/route.ts`、`app/api/reviews/[id]/resubmit/route.ts`、`app/api/orders/[id]/reviews/route.ts`、`app/api/admin/reviews/route.ts`、`app/api/admin/reviews/[id]/route.ts`、`app/api/admin/reviews/[id]/{approve,reject,hide,unhide}/route.ts` |
| 界面 | `components/reviews/ReviewAggregatePanel.tsx`（**商品页与打手页共用**）、`components/product/ProductReviews.tsx`、`components/admin/AdminReview*.tsx`、`app/admin/(console)/reviews/(list)/{page,loading}.tsx`、`app/admin/(console)/reviews/[id]/{page,not-found}.tsx` |
| 种子 | `lib/mocks/fixtures/reviewSeed.ts` —— **11 条真实 `OrderReview`**（9 `approved` / 1 `pending` / 1 `hidden`），每条用内部 `build()` 保证不变量 |
| 测试 | **`tests/reviewClosure.test.mjs`（26 例，本轮的闭环门禁）** |

### 2.2 改写

| 文件 | 改了什么 |
|---|---|
| `tests/reviews.test.mjs` | 用户侧门禁**整体重写**为双维度模型。⚠️ **断言只改口径、不删覆盖**：与裁定冲突的旧断言（「退款中/已退款不能评价」）**改写成守住裁定之后的规则**（「已完成之后发生退款仍然可以评价」+「完成前退款不可评价」），不是删掉 |
| `components/reviews/ReviewForm.tsx` | 双维度独立评价块；两种模式 `create` / `resubmit` |
| `components/reviews/ReviewList.tsx` | 按维度渲染星级与正文；状态恒显；`rejected` / `hidden` 显原因 |
| `app/(mobile)/reviews/new/[orderId]/page.tsx` | 五种状态分支：`missing` / `reviewed` / `rejected` / `blocked` / `ready` |
| `app/(mobile)/orders/[id]/page.tsx` | 评价入口改成只显示 `statusLabel`（删掉 `${rating} 星`）；`canResubmit` 时指向重提表单 |
| `app/(mobile)/product/[id]/page.tsx` | 挂上 `ProductReviews` |
| `components/companions/CompanionDetailView.tsx` | 评分改用 `formatAverageRating`（删掉「(N 条评价)」）；评价区换成 `ReviewAggregatePanel` |
| `app/admin/(console)/orders/[id]/page.tsx` | 订单评价摘要 `rating` → `statusLabel` |
| `lib/constants/admin.ts` | 「评价审核」导航项（排在售后工作台与客服账号之间）+ 两个页面标题 |
| `lib/services/adminHttp.ts` | 六个浏览器端写/读函数 |
| `lib/constants/companions.ts` | `toCompanionBase()` 增加 `stats` 入参；评分从聚合来 |
| `lib/mocks/fixtures/seed.ts` | 移除护航的 `rating` / `reviewCount` / `reviews` |
| **`tests/admin.test.mjs`** | ① 导航清单加 `/admin/reviews`（十三个 → **十四个**）；② 管理接口清单已是 6 条评价审核路由（早前落的），本轮只复核 |
| **`tests/routes.test.mjs`** | `toCompanionBase()` 的调用形状跟着新的 `stats` 入参更新，守的东西不变 |
| **`tests/adminCompanionManagement.test.mjs`** | 「新护航没有评分」这条断言换了落点：实体字段**不存在** → 改断言聚合结果 `averageRating === null`。**不变式一字未改**（`null` 与 `0` 分仍是两件事） |

### 2.3 三处「为了让测试变绿」的边界（留档）

本轮有三条既有断言红了，**没有一条是靠删除或放宽解决的**：

| # | 断言 | 为什么红 | 怎么改的 |
|---|---|---|---|
| 1 | `tests/admin.test.mjs` 导航清单 | 多了一条真实导航项 | **加进清单**并把标题的「十三个」改成「十四个」。清单门禁的意义就是「导航与已建成页面一一对应」，**它红正是它该做的事** |
| 2 | `tests/routes.test.mjs` `toCompanionBase` 调用形状 | 共有字段多了一位入参（`stats`） | 更新字面量；**仍然断言「两份 DTO 从同一个函数出发」**，强度不变 |
| 3 | `tests/adminCompanionManagement.test.mjs`「新护航没有评分」 | `Companion.rating` 字段被删（`D17`） | 断言**实体不带这三个字段** + 断言**聚合结果是 `null`**。这是**同一句话的新落点**，不是放宽 |

⚠️ 第 3 条值得单独说：原断言 `companion.rating === null` 在 `D17` 之后会**永远为假**
（字段不存在 ⇒ `undefined`）。但直接删掉它，就等于**悄悄丢掉**「`null` 与 `0` 分是两件事」
这条业务要求。因此改法是**把它搬到新的真值源上**，而不是让它消失。

---

## 三、验证

> 全部命令在本机执行；`APP_BASE_URL` 指向**生产构建**（`next start`），不是 `next dev`。

### 3.1 门禁

| 步骤 | 命令 | 结果 |
|---|---|---|
| 类型生成 | `npx next typegen` | ✅ `Types generated successfully` |
| 类型检查 | `npx tsc --noEmit` | ✅ 退出码 0，无输出 |
| 静态检查 | `pnpm lint` | ✅ 退出码 0，无输出 |
| 构建 | `pnpm build` | ✅ 退出码 0 |
| 单元 / 集成 | `pnpm test`（无 `APP_BASE_URL`） | ✅ **1867 tests / 1684 pass / 0 fail / 183 skipped** |
| 全量（含 HTTP） | `pnpm test`（`APP_BASE_URL`） | 见 §3.2 |

⚠️ 「无 `APP_BASE_URL` 时 183 例 `skipped`」是**设计如此**：需要服务的用例自己带上
`{ skip: SKIP_HTTP }`，而不是静默通过。**它们在 §3.2 全部真的跑了。**

### 3.2 生产构建 + 全量 HTTP

```
PORT=3105 ENABLE_MOCK_DEBUG=true ENABLE_MOCK_ADMIN=true npx next start -p 3105
APP_BASE_URL=http://localhost:3105 pnpm test
```

```
ℹ tests 1867
ℹ pass 1867
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 989189
```

⚠️ **`skipped 0`** 是本行最关键的一个数字：无服务时那 183 例自己带 `{ skip }` 的用例，
这一次**全部真的连上了 `http://localhost:3105`**。它们不是「没跑」。
1867 = 1684（无服务时通过）+ 183（无服务时跳过），两个数字对得上。

⚠️ 生产构建**是审查后重建的**：5 处 `MINOR` 修复（`05-review.md` §二）之后重新
`pnpm build`、重启 `next start`、再跑全量——**没有**用审查前的构建结果冒充终值。
`duration_ms` 正是全量那一趟的墙钟时间（约 16 分钟，与 183 例 HTTP 用例的单例耗时量级一致）。

### 3.3 本轮新增门禁：`tests/reviewClosure.test.mjs`

**30 例**（审查后从 26 例增至 30 例），**0 `skip`**（带服务时）。覆盖产品下达的 25+ 条门禁要求：

| 组 | 守什么 | 用例数 |
|---|---|---|
| 二 · 公开聚合 | 只认 `approved`、按**维度**计数、最近 3 条截断、暂无评分是 `null` 不是 `0` | 2 |
| 三 · 同源与脱敏 | 商品页与打手页值完全一致（同一次聚合）；公开评价**恰好 5 个键**，昵称脱敏，内部标识一个不出现 | 2 |
| 四 · 管理端审核 | 四动作、五迁移、状态机外的动作 400、原因必填的两种、内容不可改、幂等与 8 路并发、404 | 7 |
| 五 · `AdminAudit` | 四动作各一条、`before`/`after` 首尾相接可读出状态轨迹、空操作与重放都不写第二条 | 2 |
| 六 · 退款与评价 | 部分退款仍可评、完成后退满仍可评、完成前退款不可评、`approved` 后退款不撤评价且不得偷偷映射成 `hide` | 3 |
| 七 · 管理端列表与 DTO | 默认落 `pending`、角标不随筛选变、24 个键的 DTO 键集、空态注入只清列表 | 3 |
| 八 · 种子完整性 | 实体无评分字段、分数只能来自 `approved` 记录（改一条状态分数立刻变）、每条种子自洽 | 1 |
| 九 · 权限 | 服务层不解析会话；六个 admin 路由各自 `requireAdmin()`；三个用户路由各自 `requireUser()`；HTTP 权限矩阵（匿名/用户/客服 401 · 非管理员 403 且只有一句文案 · 管理员走到业务校验 · 打手端与客服端无评价入口 404） | 3 |
| 十 · HTTP 契约 | 审核端到端（通过后公开面立刻可读、重放 `changed:false`、驳回不写原因 400）、提交契约（零维度 400、缺幂等键 400、非本人订单 404、幂等键重发回同一条、一单一评换键也不产生第二条） | 3 |
| 十一 · 审查加固 | 审查后新增：不需要原因的动作**根本不读** `reason`（`D10`）；重提只能从 `rejected` 出发、已通过不能被打回（`D9` / `R2`）；打手快照只来自订单实体、写入路径不读派单记录（`D4` / `R5`）；提交幂等键**认单**——同键换单是 400 冲突而不是静默返回第一张单（`D14` 一致性） | 4 |
| — | 去重的 `productId` 断言：聚合身份必须从实体读（`getOrderDetailForUser` 是 DTO，按设计不带 `productId`，这本身就是 `D13` 的证据） | — |

⚠️ **两条取舍值得记下**：

1. **「游客只能读 `approved`」在服务层断言，不在 HTTP 层**。公开聚合
   `loadReviewAggregate(key, targetId)` **根本没有会话参数**——这比「接口挡了一下」更强：
   不存在一个「传了 userId 就能多看到几条」的分支可供写错。
   （商品详情也没有对应的 HTTP 路由，它由服务端组件直接调服务。）
2. **「客服只读」与「打手只看自己」用「接口不存在」断言**（404），
   而不是断言「读到了但是被过滤」。见 §1.5。

---

## 四、本轮**没有**做什么

| 没做 | 依据 |
|---|---|
| 完整评价列表页 | `D16` |
| 打手端 / 客服端评价表面 | `D21` 的上限语义（§1.5） |
| 让管理员编辑评价内容 | `D12` |
| 退款自动撤下评价 | `D20` |
| 新增「服务是否完成」状态 | `D19`（以既有 `completedAt` 为判据） |
| 猜着迁移存量旧评价 | `R5`（存量全是 Mock ⇒ 重建 fixture） |
| 评价回复 / 点赞 / 新凭证类型 | 不在裁定范围 |

---

## 五、收尾与遗留

- ⚠️ **本轮终点是 `AWAITING_ACCEPTANCE`**，**未 `DONE`**，且不得由 Claude 自行 `DONE`。
- ⚠️ **零 Git 写操作**：改动全部留在工作区，未提交。
- 📌 `lib/services/adminHttp.ts` 的 `fetchAdminReview` 目前**无客户端调用方**
  （详情页是 SSR，写成功后「就地更新 + `router.refresh()`」）。
  保留它是为了与 `fetchAdminRefund` / `fetchAdminComplaint` 对称，
  且 `GET /api/admin/reviews/[id]` 路由确实存在、有测试覆盖。
  **若验收认为不需要，删它不影响任何行为**——这是一处刻意的对称，不是死代码。
- 📌 空态文案「这件商品还没有公开评价。」「这位陪玩还没有公开评价。」
  写在两个组件里，`lib/constants/reviews.ts` 没有对应常量：
  它们**刻意各自独立**（商品与陪玩不是一回事），合并成一条会产生
  「商品页说『这位陪玩…』」这种错配。
