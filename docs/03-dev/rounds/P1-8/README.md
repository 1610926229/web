Round ID: P1-8
Title: 订单评价闭环（商品 + 打手双维度评价 · 管理员审核后方可公开 · 可隐藏）
Status: IN_PROGRESS   # 2026-10-02 —— D1–D22 + R1–R5 已全部 RESOLVED，第二次 Requirement Check 无新 BLOCKING，开始编码
Blocked On:（无）—— ⛔ **2026-10-02 产品裁定：`D1`–`D22` + `R1`–`R5` 全部 `RESOLVED`**，逐字见 `02-decisions.md` §一 / §二。本节以下的审查原文**一字未改**，作为「裁定当时的事实基线」保留
Depends On:
- P0-9（订单 `completed` 与投诉窗口 —— 评价的准入前提）
- P1-7（`CompanionServiceEvent` 服务历史 —— 决定「实际服务打手」能否精确回答）
- P0-11 / P0-14（客服换人与 `assignmentKey` —— 决定换人场景下评价对象的可得性）
Goal: 把「订单完成后用户评价 → 管理员审核 → 审核通过才公开 → 可隐藏」这条闭环补完
前一轮的暂缓项: **打手经营数据面板**（暂缓、后置，**需求不删除**；本轮不做，也不在本轮登记为 `DONE`）
Started At: 2026-10-02
Git Commit: ——（本轮**零 Git 写操作**，文档改动保留在工作区）

---

## 产品背景（用户下达，2026-10-02）

评价的原始产品目标：

1. 订单完成后，用户可以评价；
2. 一次订单最多评价一次；
3. 评价对象包括：**本单商品** + **本单实际服务打手**；
4. 用户提交后**不可修改**；
5. 评价提交后**不是立即公开**；
6. **必须经过管理员审核后**才允许公开；
7. 管理员**可以隐藏已公开评价**；
8. **打手不能回复评价**。

> ⚠️ **纪律**：不得因为当前代码只实现了一部分，就把「当前实现」反推成「产品需求」。

---

# Phase 1 · 当前 Review / Rating 实现审查（只读）

## 0. 涉及的文件（全仓清点）

| 层 | 文件 |
|---|---|
| 类型 | `lib/types/review.ts` |
| 常量 / 规则 | `lib/constants/reviews.ts` |
| 仓储 | `lib/data/reviewRepository.ts` · `lib/data/mockReviewRepository.ts` |
| 服务（服务端） | `lib/services/reviews.ts` |
| 服务（浏览器） | `lib/services/reviewsHttp.ts` |
| 种子 | `lib/mocks/fixtures/reviewSeed.ts` |
| 组件 | `components/reviews/ReviewForm.tsx` · `components/reviews/ReviewList.tsx` |
| 页面 | `app/(mobile)/reviews/page.tsx` · `app/(mobile)/reviews/new/[orderId]/page.tsx` |
| 接口 | `GET /api/reviews` · `POST /api/orders/[id]/reviews` |
| 测试 | `tests/reviews.test.mjs`（704 行） |
| 原型 | `docs/ui-reference/prototype/CommentPage.jpg`（**只有「我的评价」列表页，没有发表评价页**） |

## 1. 用户入口 —— **入口存在**

- `/reviews/new/[orderId]` 页面**确实存在**（`app/(mobile)/reviews/new/[orderId]/page.tsx`）。
- 实际入口有 **两处**：
  1. `app/(mobile)/orders/[id]/page.tsx:299-301` —— `allowedActions.canReview` 为真时渲染 `<ActionRow href={/reviews/new/${detail.id}} label="评价服务" hint="已完成，可以评价" />`；
  2. `components/reviews/ReviewList.tsx:391` —— 「待评价」Tab 里每张卡片右下角链到 `/reviews/new/${order.orderId}`。
- `/reviews`（我的评价列表）入口：`lib/constants/mine.ts:63`（「我的」页 → 我的评价）。
- **已评价后订单详情显示什么**：`canReview` 变假 ⇒「评价服务」入口消失；同时 `reviewSummary` 非空 ⇒ 改渲染 `<ActionRow href="/reviews" label="我的评价" hint={"已评价 · N 星"} />`（`app/(mobile)/orders/[id]/page.tsx:303-309`）。两个入口**互斥**。
- ⚠️ 但**公开侧没有入口**：商品详情、打手详情都没有「评价」区块可点（见 §6 / §7）。

**结论：页面存在，且用户有入口。** 不存在「页面存在但用户无入口」。

## 2. 一单一次 —— 约束在**仓储层**，共两道

| 位置 | 内容 |
|---|---|
| UI | `ReviewForm` 提交后 `router.replace("/reviews")`；订单详情不再显示入口（**只是提示，不是约束**） |
| Service | `lib/services/reviews.ts:309-310` 先查 `findReviewByOrderId`，命中直接返回第一次的结果（`created: false`，**不报错**） |
| Repository | `mockReviewRepository.createReview()`（:94-120）在**无 `await` 的原子区段**内做业务唯一键判定 |
| 唯一索引语义 | `reviewIdByOrder: Map<"${userId}:${orderId}", reviewId>`（`mockReviewRepository.ts:25`），建仓时对种子也校验重复并直接 `throw`（:44-48） |
| 幂等 | `reviewIdByKey: Map<"${userId}:${idempotencyKey}", reviewId>`，独立于业务唯一键 |

**并发下一单会不会生成两条？不会。** 两条防线：

1. 服务层的预检（`findReviewByOrderId`）与写入之间存在 `await` 窗口，**两个并发请求都可能通过预检**；
2. 但仓储的原子区段（无 `await`）内第二次进入时会命中 `reviewIdByOrder` ⇒ 返回 `{ ok: false, reason: "order_already_reviewed" }`，服务层把它翻译成「和第一次一样的结果」（`lib/services/reviews.ts:349-353`）。

`tests/reviews.test.mjs:314`「幂等重试与并发提交都只产生一条评价」用 **8 个并发提交**钉住了这一点。

## 3. 当前 Review 数据模型（exact schema）

`lib/types/review.ts:35-58` —— `OrderReview`：

```
id, userId, orderId, orderNo,
rating: 1|2|3|4|5,          // 单一星级
content: string,            // 单一正文（去首尾空格，≤200 字符）
evidence: SupportEvidence[] // 图片，≤4 张
createdAt: string,
productTitle, productCoverUrl, specName, quantity,  // 商品快照
completedAt: string,
companion: OrderCompanionSnapshot | null            // 打手快照，未绑定为 null
```

**只能表达 `rating + content`，不能分别表达 `productRating / productContent / companionRating / companionContent`。**
不存在任何双维度字段（`grep productRating|companionRating` 全仓 0 命中）。

**也没有任何状态字段**：没有 `status`、没有 `pending/approved/rejected/hidden`、没有 `reviewedBy`、没有 `hiddenAt`/`hiddenReason`。`grep ReviewStatus` 全仓 0 命中。

## 4. 当前评价对象 —— **订单与快照有，稳定 ID 没有**

| 关系 | 是否存在 | 说明 |
|---|---|---|
| `orderId` | ✅ | 仓储主键之一（业务唯一键 `${userId}:${orderId}`） |
| `orderNo` | ✅ | 快照 |
| 商品 | ⚠️ **只有快照，没有 `productId`** | `productTitle / productCoverUrl / specName / quantity` 在提交那一刻从订单抄下来。**没有商品 id**，因此**无法按商品聚合**评价 |
| 规格 | ⚠️ 只有 `specName` 字符串 | 同样没有 `specId` |
| 打手 | ⚠️ **只有快照，`companion.id` 是有的** | `OrderCompanionSnapshot = { id, name, avatarUrl }`，`id` 即打手 id ⇒ **理论上可按打手聚合**，且快照使得打手改名/换头像不影响历史 |
| `actualCompanionId` | ❌ 不单独存 | 只以 `companion.id` 快照形式存在 |
| Assignment identity（`assignmentKey` / `seq`） | ❌ 不存在 | 与 P1-7 的裁定同一口径：本轮没有 Assignment 聚合 |

⚠️ **`order.companion` 是「实际接单打手」的快照，不是「用户当初指定的人」**——`lib/types/order.ts:250-258` 明写它和 `actualCompanionId` 在**同一段无 `await` 的代码**里一起写；用户指定的那位是 `exclusiveCompanionId`，两者是不同字段。

## 5. Admin 审核 —— **整体 `NOT IMPLEMENTED`**

| 项 | 状态 |
|---|---|
| `pending` 状态 | **NOT IMPLEMENTED**（没有状态字段） |
| `approved` 状态 | **NOT IMPLEMENTED** |
| `rejected` 状态 | **NOT IMPLEMENTED** |
| `hidden` 状态 | **NOT IMPLEMENTED** |
| Admin review list | **NOT IMPLEMENTED**（`ls app/api/admin/` 下**没有** `reviews/`；`app/admin/**` 下**没有**评价页面） |
| Review detail（管理端） | **NOT IMPLEMENTED** |
| approve / reject / hide | **NOT IMPLEMENTED** |
| Admin 导航入口 | **NOT IMPLEMENTED**（`lib/constants/admin.ts` 无评价条目） |
| 审核审计 | **NOT IMPLEMENTED**（`lib/constants/adminAudit.ts` 无评价动作） |

管理端**唯一**与评价有关的读取是：`app/admin/(console)/orders/[id]/page.tsx:373-374`，在**订单详情**里以一行只读信息显示 `评分 N 星`（数据来自 `lib/services/adminOrders.ts:272` → `toReviewSummary`）。**没有任何操作按钮。**
管理端「打手列表 / 打手详情」显示的 `评分 / 评价数` 来自**静态种子**（见 §7），与真实评价无关。

## 6. 商品评价闭环 —— **完全不存在**

`app/(mobile)/product/[id]/page.tsx`：`grep rating|reviewCount|评价|评分` → **0 命中**。
商品详情页**没有**评分、**没有**评价数、**没有**评价列表。
商品 DTO 里也没有这些字段。

⇒ **商品评价闭环 = 0%。** 不是「来自 seed」，是**根本没有这一块**。

## 7. 打手评价闭环 —— **来自静态种子，与 reviewRepository 不连通**

数据链：`lib/mocks/fixtures/seed.ts:283+`（`companionSeed`，`reviews/rating/reviewCount` 是**手写字面量**，如 `:300 rating: 4.8, :302 reviewCount: 3, :305 reviews: [...]`）
→ `lib/data/mockCompanionRepository.ts:49`（原样放进 store）
→ `lib/constants/companions.ts:328-335`（`slice(0, COMPANION_DETAIL_REVIEW_LIMIT = 3)`，`:36`）
→ `components/companions/CompanionDetailView.tsx:73-74, 142-158`。

**`lib/data/mockReviewRepository.ts` 与 `mockCompanionRepository` 之间没有任何调用关系**（`getReviewRepository` 的消费方只有 `lib/services/reviews.ts` / `orders.ts` / `adminOrders.ts`）。

⇒ 进度表 `docs/03-dev/需求功能点进度表.md:194` 那句「**评价不回显到打手端/商品端——打手详情页的评分来自 seed 里写死的 reviews/reviewCount，与 reviewRepository 不连通**」**仍然成立，一字不差**。

⚠️ 这条同时对应一个已登记的 `TBD — DO NOT INVENT`：`docs/02-tech-design/database-schema.md:1183`「**`Companion.reviews[]` 与 `OrderReview` 是否统一** | **TBD — DO NOT INVENT**」（同 `:579-580`）。

## 8. 公开规则 —— **当前没有任何公开读路径**（但理由不是「审核」）

`getReviewRepository()` 的全部消费点：

- `lib/services/reviews.ts` —— 全部要求 `requireUser()`，且 `userId` 只来自会话（`/api/reviews`、`/api/orders/[id]/reviews`）；
- `lib/services/orders.ts:229` —— 用户读**自己的**订单详情，附 `reviewSummary`；
- `lib/services/adminOrders.ts:272` —— 管理端订单详情。

**没有任何游客可读的评价接口或页面。** 商品详情无评价；打手详情的评价来自种子。

⇒ 「未审核评价是否可能被公开页面读到」——**当前不可能，因为不存在公开读路径**。
⚠️ 但这是**结构性巧合**，不是「审核制」在起作用：系统里**根本没有审核概念**，也**没有公开面**。一旦按产品目标 6/7 补上公开面，**今天的实现会立刻变成「提交即公开」**。

## 9. 退款 —— 代码**有**答案，产品文档**没有**

代码事实（`lib/constants/reviews.ts:231-246` `canReviewOrder()`）：

| 退款状态 | 能否评价 | 文案 |
|---|---|---|
| `approved`（已通过） | ❌ 不能 | 「该订单已退款，无法评价」 |
| `pending` / `reviewing`（进行中） | ❌ 不能 | 「该订单正在退款处理中，暂时无法评价」 |
| `rejected` / `cancelled` | ✅ 能 | ——（不受影响） |
| 无退款 | ✅ 能 | —— |

⚠️ **注意「部分退款」**：按现状，**任何** `approved` 退款（10% / 50% / 100% 一视同仁）都会**永久关闭**该订单的评价入口。这是**代码自行推导的**，`docs/01-requirements/` 三个权威文件里 `评价` 命中数为 **0**（见 §10）。

**「已评价后退款是否撤下评价」**：当前**没有**「撤下」这个概念——评价一旦写入就是终态，没有状态、没有隐藏、没有撤回路径。

⇒ **§9 整体列为决策点，不自行判断。**

## 10. 需求 / 技设 / 进度表里所有「评价」相关内容

| 文档 | 说了什么 |
|---|---|
| `docs/01-requirements/`（业务流程表 / 用户权限表 / 特殊情况与异常处理表） | ⚠️ **`评价` 命中数 = 0**。三个权威文件是围绕 P0 主线 `BF-01…BF-25` 写的，**从未定义过评价** |
| `docs/02-tech-design/database-schema.md` §13 | `OrderReview` 的表结构、唯一索引 `reviewIdByOrder`；`:579-580` 明确标 `TBD — DO NOT INVENT`（与 `Companion.reviews[]` 是否统一）；`:1183` 在 TBD 总表里再列一次 |
| `docs/02-tech-design/api-contract.md` | 只有两行：`:118` `POST /api/orders/[id]/reviews`、`:417` `GET /api/reviews`。**第四部分 TBD 清单里没有评价审核相关条目**（连 TBD 都没登记） |
| `docs/03-dev/需求功能点进度表.md:194-196` | `P1 · 评价 · 订单评价 = DONE`、`星级评分 = DONE`、`文字评价 = DONE`；并在备注里写明「⚠️ 评价不回显到打手端/商品端」 |
| `docs/03-dev/总需求进度表.md:491` | `| UNASSIGNED | 评价 — 一单一次评价、审核等 | ⏸ PAUSED |`；`:578` 把它列进「当前不作为核心 P0 主线阻塞项」 |
| `docs/ui-reference/prototype/CommentPage.jpg` | 只有「我的评价」页：时间筛选 chips（全部/近一月/近三月/近半年/今年）+ 空态「暂无评价记录」。**没有发表评价页，没有评价详情页，没有审核相关页面** |
| 历史 Round | `P0-6/02-decisions.md:85`（评价属用户侧写接口）、`P0-14/02-decisions.md:698`（completed 段售后/评价/投诉仍要能说话）、`P1-2/03-delivery.md:241`（`seed.ts` 里的评价文本是「用户当初写下的话」）——**均无产品裁定** |

⚠️ **「订单评价 DONE」的真实含义**：它只代表 **`OrderReview` 的基础写入成立**（提交、幂等、一单一评、归属校验、状态校验、列表读回、订单详情摘要、管理端订单详情只读展示）。

---

# Phase 2 · 差距报告

## 当前已有（可用、且与产品目标 1/2/4 一致）

- 用户**有入口**（订单详情「评价服务」+ 待评价 Tab），页面与接口都完整。
- 订单完成后可评价；**一单一评**有仓储级唯一索引 + 幂等键两道防线，并发已验证。
- 提交后**不可修改**：没有编辑路径，重复提交返回第一次的结果而不是覆盖。
- 归属校验（订单不属于你 = 404）、白名单入参（`userId`/`orderStatus`/`companionId`/`createdAt` 一律不读）、评分 1–5 与正文字数校验、凭据 ≤4 张图片。
- 「我的评价」列表：两个 Tab + 五档时间筛选 + 分页 + 角标，与原型 CommentPage 的列表版式一致。
- 订单详情有评价摘要（几星、何时），管理端订单详情有一行只读评分。
- `tests/reviews.test.mjs` 704 行覆盖幂等、并发、归属、校验、DTO 不泄漏私密字段。

## 页面存在但无入口

**无。** `/reviews` 与 `/reviews/new/[orderId]` 都有真实入口。

## 半实现

| 缺口 | 具体 |
|---|---|
| **评价对象只做了一半** | 产品目标 3 要求「商品 + 实际服务打手」**两个对象**，当前是**一份综合 `rating` + 一份 `content`**，无法区分维度 |
| **商品侧完全空** | 商品详情没有评分 / 评价数 / 评价列表；`OrderReview` 连 `productId` 都没有 ⇒ 即使以后要聚合也**聚合不了** |
| **打手侧假连通** | 打手详情**有**评分与评价列表，但来自 `seed.ts` 手写字面量，与真实评价**零连接** |
| **退款与评价的耦合未经裁定** | `canReviewOrder` 已实现「退款中/已退款不能评价」，但 `docs/01-requirements/` 对此**一个字都没有** |

## 完全未实现

| # | 项 | 产品目标 |
|---|---|---|
| 1 | 评价**状态字段**（`pending`/`approved`/`rejected`/`hidden`） | 5 / 6 / 7 |
| 2 | **审核**（提交后不立即公开） | 5 |
| 3 | **管理员审核界面**（列表 / 详情 / approve / reject） | 6 |
| 4 | **管理员隐藏**（hide，含已公开的） | 7 |
| 5 | **公开面**（评价在哪里对谁公开） | 5 / 6 |
| 6 | 商品维度评价（独立星级 / 文本 / 聚合 / 展示） | 3 |
| 7 | 打手维度评价（独立星级 / 文本 / 聚合 / 展示） | 3 |
| 8 | 评价 → 平均分 / 评价数的**真实聚合** | 3 |
| 9 | 审核相关的 AdminAudit | —— |
| 10 | 打手**不能**回复评价（当前是「没有回复功能」，**不等于**「禁止回复」这条规则被实现了） | 8 |

## 当前实现与原产品规则冲突

| # | 冲突 | 说明 |
|---|---|---|
| C1 | **目标 3「商品 + 打手」vs 单维度模型** | 当前只出一份星级/文本，**结构上表达不了两个对象**。这是**模型级**冲突，不是补个字段就能糊过去 |
| C2 | **目标 5/6「审核后才公开」vs 提交即终态** | 当前提交后无状态、不可撤回、无审核。一旦补上公开面，今天的行为**立刻变成「提交即公开」**，与目标 5 直接冲突 |
| C3 | **目标 7「可隐藏已公开」vs 无状态** | 隐藏需要状态位与反向可逆性，当前数据模型**无位置可写** |
| C4 | **打手详情评分来自 seed** | 用户看到的是**伪造的**平均分与评价（虽然是「Mock」）。若本轮补上真实评价而**不动**这块，会出现「真实评价与假评分并存」的自相矛盾 |
| C5 | **`OrderReview` 无 `productId`** | 与目标 3 的「评价本单商品」不相容；未来聚合必须先解决身份问题 |

> ⚠️ **不得用 `DONE` 掩盖缺口。** 「订单评价 DONE」= **`OrderReview` 基础写入成立**，仅此而已；产品目标 5/6/7（审核 → 公开 → 隐藏）与目标 3 的双维度**全部未实现**。

---

# Phase 3 · 一次性产品决策清单

**22 条，逐条见 `02-decisions.md`。**（每项含：问题 / 当前代码事实 / 原需求事实 / 选项 / 推荐 / 业务差异 / `BLOCKING` 判定）

| 组 | 编号 | 主题 | BLOCKING |
|---|---|---|---|
| A 评价对象 | `D1` | 一份评价是否同时评「商品 + 打手」 | 🔴 |
| | `D2` | 双维度是否各自独立星级与独立文本 | 🔴 |
| | `D3` | 是否允许只评其中一个 | 🔴 |
| | `D4` | 打手维度评的是谁（final `actualCompanion` / 全部曾 `serving`） | 🔴 |
| | `D5` | A→B 换人场景下 A 是否可得评价 | 🔴 |
| B 审核与可见性 | `D6` | 「公开」的落点在哪里 | 🔴 |
| | `D7` | 审核状态模型 | 🔴 |
| | `D8` | 待审核 / 驳回时作者本人是否可见 | 🔴 |
| | `D9` | `reject` 后能否重新提交 | 🔴 |
| | `D10` | `reject` / `hide` 是否必须填写原因 | 🟡 |
| | `D11` | `hide` 能否重新公开 | 🟡 |
| | `D12` | 管理员能否编辑评价内容 | 🟡 |
| | `D13` | 是否允许匿名展示 | 🟡 |
| C 聚合与展示 | `D14` | 何时进入平均分（pending / hidden / rejected 如何处理） | 🔴 |
| | `D15` | 平均分精度 + 无评价显示什么 + 条数展示 | 🟡 |
| | `D16` | 是否需要完整评价列表页 | 🟡 |
| | `D17` | 存量静态 seed 评分数据如何处置 | 🔴 |
| D 退款 | `D18` | 部分退款后能否评价 | 🔴 |
| | `D19` | 全额退款后能否评价 | 🔴 |
| | `D20` | 已 `approved` 后退款是否撤下评价 | 🔴 |
| E 其他 | `D21` | 评价是否回显到打手端 / 客服端 | 🟡 |
| | `D22` | 审核操作是否进 `AdminAudit` | 🟡 |

---

# Phase 4 · 状态

存在 **🔴 BLOCKING 决策** ⇒ 按用户指令：**统一问完后停止，不编码。**

```
P1-8 Status: BLOCKED — 22 open product decisions (D1–D22)
```

- 本轮**零业务代码改动**。
- 本轮**零 Git 写操作**。
- `D1`–`D22` 全部答复前，**不得开始任何业务编码**（`CLAUDE.md`：「若 Round 存在 OPEN decision，禁止开始业务编码」）。

---

# Phase 5 · 裁定与交付（2026-10-02）

> ⚠️ **上方 Phase 4 的 `BLOCKED` 已被本节取代。** 那一段是 Requirement Check 当天的
> 状态快照，保留原样是为了留下「问的是什么、当时卡在哪」的记录；**当前状态以本节为准**。

## 5.1 裁定

`D1`–`D22` 全部由产品负责人裁定为 `RESOLVED`，另有 5 条冻结规则 `R1`–`R5`。
逐条见 `02-decisions.md`（裁定以「追加」形式记入，问题原文未改）。

⇒ **本轮无 OPEN decision**，按 `CLAUDE.md` 可以开始业务编码。

## 5.2 交付范围（16 项）

1. 双维度 `OrderReview` 模型（`productReview` / `companionReview` 各自独立星级与正文）
2. 一单一条逻辑评价（`R1`）
3. 驳回后在**同一条**评价上重新提交（`D9`）
4. `ReviewStatus` 状态机（`pending → approved | rejected`，`approved → hidden`，`hidden → approved`，`rejected → pending`）
5. 管理端评价列表
6. 管理端详情 · 审核
7. `approve` / `reject` / `hide` / `unhide` 四个动作
8. 审核动作全部进 `AdminAudit`（`D22`）
9. 商品评分真实聚合
10. 打手评分真实聚合
11. 商品详情最近 3 条 `approved` 评价
12. 打手详情最近 3 条 `approved` 评价
13. 去除静态 fake `rating` / `reviewCount` 真值（`D17`）
14. 订单详情正确显示 去评价 / 审核中 / 已通过 / 已驳回·重新提交 / 已隐藏
15. 部分 / 全额退款规则按 `D18`–`D20`
16. DTO 与权限收口

## 5.3 落点（新增文件）

| 层 | 文件 |
|---|---|
| 类型 | `lib/types/review.ts`（`OrderReview` / `ReviewListItem` / `AdminReviewListItem` / `ReviewAggregate` / `PublicReviewItem`） |
| 规则 | `lib/constants/reviews.ts`（状态机、四个动作、聚合、脱敏、DTO 转换）、`lib/constants/adminReviews.ts`（列表筛选、角标、可执行动作、错误文案） |
| 数据 | `lib/data/reviewRepository.ts` + `lib/data/mockReviewRepository.ts` + `lib/data/adminReviewTransaction.ts` + `lib/data/companionOrderTransaction.ts` |
| 取数 | `lib/services/reviewAggregates.ts`（**商品与打手唯一的聚合入口**，`R3`）、`lib/services/reviews.ts`、`lib/services/adminReviews.ts` |
| 接口 | `app/api/reviews/route.ts`、`app/api/reviews/[id]/resubmit/route.ts`、`app/api/orders/[id]/reviews/route.ts`、`app/api/admin/reviews/route.ts`、`app/api/admin/reviews/[id]/route.ts`、`app/api/admin/reviews/[id]/{approve,reject,hide,unhide}/route.ts` |
| 界面 | `components/reviews/ReviewAggregatePanel.tsx`（商品页与打手页**共用**）、`components/product/ProductReviews.tsx`、`components/admin/AdminReview{Table,Sections,Console,Dimensions,StatusBadge}.tsx`、`app/admin/(console)/reviews/(list)/{page,loading}.tsx`、`app/admin/(console)/reviews/[id]/{page,not-found}.tsx` |
| 种子 | `lib/mocks/fixtures/reviewSeed.ts`（11 条**真实** `OrderReview`：9 approved / 1 pending / 1 hidden） |

## 5.4 `D21` 的落地方式（范围决定，不是遗漏）

`D21` 要求：

| 角色 | 能读什么 |
|---|---|
| 作者本人 | 自己的**全部**状态 |
| 游客 / 普通用户 | 只有 `approved` |
| 打手 | 只有自己的 `approved`，**不得**提前看到 `pending` / `rejected` / `hidden` 与管理员备注 |
| 客服 | 可以读**全部**（含状态），但**只读**，无处置权 |
| 管理员 | 全部 + 处置权 |

落地情况：

- **作者本人 / 游客 / 普通用户**：由 `GET /api/reviews`（走 `requireUser()`）与公开聚合
  （`loadReviewAggregate`，**没有会话参数**）分别覆盖。聚合里根本没有 `status` 以外的视角，
  「游客只看 approved」不是靠一层过滤，而是**读侧只有这一种查询**。
- **打手**：**不打手端评价入口**。`/api/companion/reviews` **不存在**（404），
  打手工作台与评价数据之间没有任何通路——这比「只读自己的 approved」**更窄**，因此不可能提前看到未公开的评价。
- **客服**：**不做客服端评价入口**。`/api/staff/reviews` **不存在**（404）。
  `D21` 说客服「可以读全部」是**上限不是下限**；本轮客服工作台没有评价这一项业务，
  建一个只读入口会凭空多出一个没有使用场景、却要长期维护权限的表面。
  ⚠️ 这不影响 `D21` 的实质：客服**拿不到任何评价数据**，因此「不得提前看到」成立。
  将来若客服台需要评价，再按 `D21` 补一个只读表面即可——`lib/services/adminReviews.ts`
  是现成的只读取数层，不需要新写规则。
- **管理员**：`requireAdmin()` 逐个接口强制（服务端），页面按钮的禁用态只是 UI。

⚠️ 权限**全部在 Route Handler 里强制**，不是靠隐藏按钮。`lib/services/adminReviews.ts`
**不解析会话**（`tests/reviewClosure.test.mjs` 有一条断言守着这一点）。

## 5.5 状态

```
P1-8 Status: AWAITING_ACCEPTANCE
```

- 未经产品负责人验收，**不得自行标记 `DONE`**。
- 本轮**零 Git 写操作**。

## 5.6 本轮档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 轮次章程：Goal、为什么三件事必须一起做、不做什么、判据、纪律 |
| `02-decisions.md` | **`D1`–`D22` + `R1`–`R5` 的逐字裁定**（`RESOLVED`） |
| `03-delivery.md` | 交付记录：改了什么、为什么这么改、门禁数字、三处断言变更的留档 |
| `04-acceptance.md` | **人工验收清单**（§A–§I，含预置数据表与两处刻意的不对称） |
| `05-review.md` | 交付前审查结论（`BLOCKER` / `MAJOR` / `MINOR` / `NOTE`）与处置 |
