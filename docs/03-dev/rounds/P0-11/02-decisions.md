# P0-11 — Requirement Check 与执行口径

Round: P0-11
Recorded At: 2026-09-24
**本轮结论：停在 `CLARIFYING`，不进入 `READY`，不写任何业务代码。**

---

## 一、执行前确认

### 1.1 已读文档

`docs/03-dev/rounds/P0-11/01-prompt.md`（逐字，54 行）· `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md`（逐字）·
`docs/01-requirements/` 三份（业务流程表 / 用户权限表 / 特殊情况与异常处理表）·
`docs/02-tech-design/` 五份 · `docs/03-dev/总需求进度表.md` · `docs/03-dev/development-workflow.md` ·
`P0-9` / `P0-8` / `P0-7` / `P0-6` 的 Round 档案 · `BATCH_p0-6.1_to_p0-9_最终报告.md` ·
相关现有代码（`lib/constants/orders.ts`、`lib/constants/completions.ts`、`lib/data/mockPaymentRepository.ts`、
`lib/data/companionOrderTransaction.ts`、`lib/data/adminCompanionTransaction.ts`）。

### 1.2 工作区 baseline（本轮开始前，**不含本轮改动**）

```
HEAD        = 3fbae6263794bda316b2b48dac03efd7f62afa01   （= 3fbae62「docs: close P0-6.1 through P0-9」）
tracked     = 17 files changed, 712 insertions(+), 199 deletions(-)
untracked   = 13 项（目录折叠计数）
```

该 baseline **全部是 P0-10 的产物**（批次第一站，`AWAITING_ACCEPTANCE`，未提交）——
明细见 `docs/03-dev/rounds/P0-10/03-delivery.md` §二 / §三。⚠️ 按 batch §累积工作区，
本轮**先报告**这一点，**不把 P0-10 的 diff 算作本轮 delta**（本轮 delta 见 `03-delivery.md` §一）。
P0-10 的改动**经复核确实都在工作区里、没有被本轮吸收或改写**（`git status --short` 与 P0-10 交付时逐条一致）。

---

## 二、Requirement Check：**已确认**的部分（这些**不是**问题）

先记清楚哪些不需要产品裁定，免得问题被放大。以下全部经**逐条核对原文**：

| 项 | 结论 | 依据 |
|---|---|---|
| 客服有权换人、**不需 Admin 批准**、**次数不设上限** | ✅ **已确认**（四处独立表述） | `用户权限表.md:118`（`售后更换打手 \| … \| ✅ 可直接执行，不需管理员批准；次数不设上限`）· `:424` · `:652`（PR-05 ✅ 已确认 2026-09-23）· `特殊情况表.md:345` |
| `available=false` **不**动已有 `accepted`/`serving` | ✅ 已确认 | `lib/types/companion.ts:26-33`（`available` 与 `enabled` 是两件事）· `lib/constants/companions.ts:212-213` · `特殊情况表.md:370-371` |
| `enabled=false` **必须**释放 accepted/serving | ✅ 已确认 | `用户权限表.md:497-498`（accepted：解除履约回公共池并通知用户；serving：同样）· `特殊情况表.md:386` / `:401` |
| 禁用释放要**通知用户** | ✅ 已确认 | 同上；通知设施**已存在**（`lib/types/notification.ts:18-34`、`lib/data/notificationRepository.ts:41`、`appendNotification`），只是**缺这一场景的文案** |
| pending `CompletionSubmission` 在封禁/回池时**必须失效**、且**不可**被人工或自动通过 | ✅ 已确认（行为层面） | `database-schema.md:663` · `业务流程表.md:1111` · `特殊情况表.md:403` |
| 禁用这个动作**本身存在** | ✅ 已实现（但无订单联动） | `app/api/admin/companions/[id]/disable/route.ts`（`POST`，`requireAdmin()`）· `lib/data/adminCompanionTransaction.ts:503-548` `setCompanionFlags`，`:577-579` 的 `disable` 分支 |
| 释放复用的原语**已存在** | ✅ | `applyOrderAcceptanceReleased`（`lib/data/mockPaymentRepository.ts:274`）· `writeAcceptanceRelease`（`lib/data/companionOrderTransaction.ts:146-181`，一个原子段里写 4 件事：release record → 订单回 paid → Dispatch 回 public → 通知） |
| 退出历史保留 | ✅ | `CompanionReleaseRecord` = `{ id, orderId, companionId, source, reason, actorId, createdAt }`（`lib/types/companionRelease.ts:49-72`） |

**结论**：P0-11 的**绝大部分**规格是冻结的、可以直接开发。卡住的是下面**两件事**。

---

## 三、⛔ 阻塞项 **Q1** — `servingAt` 在换人回池后该保留还是改写

### 3.1 状态：仍是 `DEFERRED`，且**本轮正是它说的那个「必须裁定」的时刻**

`docs/03-dev/rounds/P0-9/02-decisions.md:229`：

> ### D14（DEFERRED）— `servingAt` 在「换人 / 回池后重新开始服务」时该保留还是改写
> …**何时必须裁定**：**任何轮次准备给 `serving → paid` 接入口之前**。

`:246-247` 记录了当时不裁定的理由：

> **为什么现在不裁定**：`serving → paid` 今天**没有任何入口**（`ORDER_TRANSITIONS` 里有这条边，
> 但零调用），现在改写入器就是**替未来乱定规则**。P0-7 与 P0-8 都刻意未动。

`BATCH_p0-6.1_to_p0-9_最终报告.md:404` 把它列为遗留第 1 条，并写明：

> **不必现在决定**。任何轮次准备给 `serving → paid` 接入口**之前**必须先裁定

### 3.2 为什么「本轮必须依赖它」——**已在代码里逐行核实，不是照抄文档**

`cmd_p0-11.md:42` 要求：

> 若原 serving：同一同步事务内 `serving → paid → accepted`

即本轮**第一次**给 `serving → paid` 接入口。两条路径都会踩到它（**禁用释放**与**直接换人**）。

触发链三处代码事实（**我逐条读过**）：

| # | 事实 | 位置 |
|---|---|---|
| 1 | 状态机**有**这条边，但**零调用**（注释自己写明「本批次不实现、也不提供任何 API 或按钮」，并且它是**留给未来的结构位置**） | `lib/constants/orders.ts:94-100`（`serving: ["paid", "completed", "refunded"]`）、`:86-92`（注释） |
| 2 | 释放写入器 **不碰 `servingAt`**——只写 `status: "paid"` / `acceptedAt: null` / `actualCompanionId: null` / `companion: null` | `lib/data/mockPaymentRepository.ts:274-293` |
| 3 | 开始服务写入器写的是 **`servingAt: order.servingAt ?? at`**（注释：「只在**第一次**进入 `serving` 时写入」） | `lib/data/mockPaymentRepository.ts:340` |

**合起来**：`serving` 单被释放回 `paid` 后 `servingAt` **残留** → 新打手接单 → 点「开始服务」→
`??` 命中 → **上一任打手的开始时间成了这一单的开始时间**。这正是 D14 描述的链条，
而它是**用户可见**的（用户端时间轴、打手端「护航中」开始时间），
也是将来按「实际服务时长」做任何统计 / 结算的基准。

⚠️ 因此：**不是**「可以顺手先写一版、以后再改」——写入器写哪一行就是裁定本身。
按 `README.md` 的第二条不可协商规则与 batch §自动继续条件「Requirement Check 无 OPEN」，
**本轮不写这一行**，停下来问。

### 3.3 两个方案（原文照录，各有道理）

`P0-9/02-decisions.md:240-241`：

> 1. **保留最早时刻**（今天 `??` 的写法）：`servingAt` = 本单**第一次**开始服务的时刻；
> 2. **改写为本次 assignment 的时刻**：`servingAt` 表达「**当前这位**打手从何时开始服务」。

---

## 四、⛔ 阻塞项 **Q2** — 「Staff 直接指定新打手」是否在 P0 范围内

### 4.1 冲突

`cmd_p0-11.md:39-42` 要求：

> ## Staff direct replace
> Staff 可直接指定新打手，不需要 Admin 批准。…
> 最终订单为 `accepted`，新 `actualCompanionId`，新 `acceptedAt`。

而**权威技术设计**把「指定新打手」明确后置、并把「指定改派模型」列入**禁止自行设计**：

`docs/02-tech-design/database-schema.md:812`（位于 **「第三部分：TBD — DO NOT INVENT」**，
该部分前言为「**以下领域既未实现，规则也未确认。禁止自行设计任何结构、字段或约束。**」）：

> \| **复杂 Replacement / Assignment 聚合** \| **TBD — DO NOT INVENT**。P0 仅采用 T4 最小退出历史 + 回 public；
> 客服换人权限与不限次数已确认，但**完整 Assignment/指定改派模型不做** \|

`database-schema.md:801`：

> 完整 AfterSalesCase 实体、复杂 Assignment、**指定新打手**等**仍可后置**，不应为了模型完整阻塞 P0。

`database-schema.md:790`（T4）：

> 客服换人：允许直接执行且次数不限；P0 最小技术映射同样是“写 release → 回 public”，**由新打手正常 accept**。

`docs/02-tech-design/api-contract.md:629`（§3.6）：

> 为避免提前引入复杂 Assignment 聚合，P0 技术映射采用“解除当前履约 → 回 public → **由新打手重新接单**”的最小路径

### 4.2 「指定新打手」在权威需求里**没有授权**

我在 `docs/01-requirements/` 与 `docs/02-tech-design/` 全文检索 `指定新打手` / `直接指定`，
**只有两处命中，都不是授权**：

- `用户权限表.md:210`：「User 无权**直接指定**：」——这是**用户侧禁止**；
- `database-schema.md:801`：……**仍可后置**——这是**后置**。

而**客服有权「换人」这件事本身是明确授权的**（见 §二）。
差别在于：**权威文档给「换人」这个动作确认的技术映射是「回 public → 由新打手正常接单」**，
而「由客服点名指定某一位新打手、直接把订单写成他的 `accepted`」**没有**对应授权文本。

⚠️ 这属于 batch §停止条件里的「**需求/技术设计冲突**」，也属于 CLAUDE.md 的
「若上述文档中出现 **TBD**：**禁止自行决定**，先问产品负责人」。

### 4.3 需要产品负责人选的口径（三选一，或第四种）

| 选项 | 含义 | 影响 |
|---|---|---|
| **A. 只做 re-pool（回 public）** | 换人 = 释放 → 回公共池 → **由新打手正常抢单**。严格贴合 `api-contract.md:629` / `database-schema.md:790` 的 P0 最小映射 | P0-11 只剩「回池」一种动作；`cmd_p0-11.md:39-42` 的 direct replace **本轮不做**，登记为后续轮次 |
| **B. 做 minimal direct-replace，并**明确它不属于被禁的「复杂 Assignment / 指定改派模型** | 复用既有原语与既有字段，**不新增聚合、不新增字段、不新增 `OrderStatus`**：写 release → 同一同步事务 `serving → paid → accepted` + 新 `actualCompanionId`/`acceptedAt` + Dispatch 绑到新打手 | 需要产品明确「`database-schema.md:812` 那条 TBD **不覆盖**这个最小实现」，否则实现者是在**替产品推翻自己写的 `DO NOT INVENT`** |
| **C. 先 A 后 B** | 本轮按 A 交付（`serving → paid` 入口 + 禁用释放 + `invalidated`），direct replace 单独一轮 | 同样需要先裁定 Q1 |
| **D. 其他** | 由产品给出 | —— |

> ⚠️ **无论选哪个，Q1（`servingAt`）都必须先裁定**：A 也有 `serving → paid`，
> 也不得不写「释放时清不清 `servingAt`」那一行。

---

## 五、**不**阻塞本轮的项（记录以免重复提问）

| 项 | 为什么不是问题 |
|---|---|
| **`pending → invalidated` 这条边在状态机里不存在** | `COMPLETION_TRANSITIONS`（`lib/constants/completions.ts:87-95`）现在是 `pending: ["approved","rejected"]`，`invalidated: []`。**行为**已由需求冻结（`database-schema.md:663` / `业务流程表.md:1111` / `特殊情况表.md:403`），而 `invalidated` **早已是**声明过的类型值（`lib/types/completion.ts:18`）。因此这是**实现缺口**（补一条边 + 一个新的写入路径），**不是**产品裁定。⚠️ 注意与 batch §架构硬约束「**不得擅自扩 OrderStatus**」无关：那条禁的是**订单**状态，不是完成材料状态 |
| **D15 — `applyCompletionReview` 不得被作废路径复用** | `P0-9/02-decisions.md:251-262`。这是**已登记的技术约束**（不是待产品选择）：作废需要一个**走中央状态机**、并**明确处理 `pendingSubmissionIdByOrder` 索引**的**新入口**。按它做即可 |
| **通知文案** | 「通知老板」的设施与写法**都已存在**（`appendNotification` 就在释放原子段里，且已有 `DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED` 同类文案）。本场景**缺一条文案**属于**撰写**，不是 TBD |
| **禁用释放没有入口** | 事实：`disable` 只写 Companion 标志位，**完全不联动订单**（`architecture-rules.md:346` 自己就写着「当前 Companion disable **尚未联动**这些实体」；`总需求进度表.md:96` 一行 `⏳ PLANNED`）。**行为已冻结**，只是没写。属实现缺口 |
| **`lib/constants/orders.ts:86-92` 注释说 `serving → paid`「本批次不实现」** | 那是**写它那一轮**的事实陈述（它同时称 `serving → paid` 是「封禁回池 / 客服换人的**结构位置**」）。D14 正是为「将来那一轮」留的口子——**不是冲突**。⚠️ 本轮实现后，**该注释会变成过期注释，必须同批更正**（登记为交付时的文档义务） |

---

## 六、请产品负责人裁定

### Q1（必答）— `servingAt` 保留还是改写

换人 / 封禁回池把 `serving` 单放回 `paid` 之后，`Order.servingAt` 应当：

- **1 = 保留最早时刻**（本单**第一次**开始服务的时刻，即今天 `??` 的行为，需**保持**释放写入器不清它）；
- **2 = 改写为本次 assignment 的时刻**（`servingAt` = 「**当前这位**打手从何时开始服务」，需**修改**释放写入器清掉它）。

### Q2（必答）— direct replace 是否在 P0 范围

按 §4.3 选 **A / B / C / D**。
若选 B，请明确一句「`database-schema.md:812` 的 `TBD — DO NOT INVENT` 不覆盖这个最小 direct-replace 实现」——
因为该文档正文明文禁止自行设计「指定改派模型」。

> 📌 这两个问题**互相独立**，但**都必须先答 Q1**才能动 `serving → paid`。

---

## 七、本轮的 Git 状态

**本批次（P0-10 → P0-13）禁止任何 Git 写操作。** 因此：

- 本轮**没有**任何 commit / add / push / reset / restore / checkout / rebase / amend；
- 本轮新增的只有 `docs/03-dev/rounds/P0-11/` 五个**纯文档**文件；
- HEAD 仍为 `3fbae62`，与批次开始时一致。

---

## 八、中间状态历史

按「追加历史、不覆盖历史」，此处记录本轮的**中间状态**：

1. **本轮曾短暂尝试先建档案再裁定**：五件档案已建（本文件在内），
   这是 `CLARIFYING` 状态**应当存在**的档案——不是「提前开发」。
   `03-delivery.md` §零 与 `04-acceptance.md` 均如实注明「本轮未写任何业务代码」。
2. **`README.md` 的 `Status` 曾先写成 `PLANNED`**，在 Requirement Check 得出
   `OPEN` 结论后改为 **`CLARIFYING`**——这是同一轮内的正常推进，不涉及历史结论的改写。
3. **Q2 是我原本没有预料到的**：本轮开工时的假设是「P0-11 只有 `servingAt` 一个阻塞项」。
   逐条核对技术设计文档后发现 direct replace 另有冲突，已一并提出——
   **避免让产品在两轮里各答一半**。

---

## 九、裁定记录（追加，不覆盖 §六 的提问）

### D-Q1（✅ 已裁定，2026-09-24）— `servingAt` 改写为**本次 assignment 的时刻**

**用户（产品侧）回答**：选 **2 = 改写为本次 assignment 的时刻**
（`servingAt` 表达「**当前这位**打手从何时开始服务」）。
§六 的提问原文**保留不动**，此处只追加结论。

**本轮的实现口径（由该裁定直接决定，不再有自由度）**：

| 项 | 口径 |
|---|---|
| 释放（`serving → paid`，禁用回池 / re-pool / direct replace 三条路径**都要**） | 释放写入器**必须清掉 `servingAt`**（写 `null`）。⚠️ 这是**对 `applyOrderAcceptanceReleased`（`lib/data/mockPaymentRepository.ts:274-293`）的修改**：它今天只写 `status`/`acceptedAt`/`actualCompanionId`/`companion`，**不碰 `servingAt`** |
| 下一次开始服务 | 继续走 `applyOrderServing` 的 `servingAt: order.servingAt ?? at`（同文件 `:340`）——**`??` 保留**。清空之后它必然写本次的 `at`，因此「重复点击不刷新」（P0-7 的幂等要求）**不受影响** |
| 为什么不改成「无条件写 `at`」 | 那会让 `??` 失去作用，并削弱 P0-7 那两条「已经是 `serving` 时原样返回、不刷新 `servingAt`」的既有断言的防线。**最小改动 = 清空 + 保留 `??`** |
| `serving → completed`（正常完成） | **不动**。`applyOrderCompleted` 本来就「`servingAt` 不动」（同文件 `:362` 的注释：历史事实）。本裁定**只**管回池那一条路径 |
| 历史是否丢失 | ⚠️ 会：`servingAt` 被清后，「上一任打手什么时候开始服务」在**订单上不再保留**。`CompanionReleaseRecord`（`{ id, orderId, companionId, source, reason, actorId, createdAt }`）**没有** `servingAt` 字段，只有 `createdAt` 作为下界。**这是本裁定的直接后果，不改结构去补偿它**（batch §架构硬约束：不得擅自扩字段/第二套结构）。若产品将来需要「上一任的开始时刻」，那是一个新的需求项，不是本轮的实现细节 |

### D-Q2（✅ **已裁定，2026-09-24**）— direct replace **在 P0 范围内**，按**最小实现**做

**用户（产品侧）回答**：选 **B = 做最小 direct-replace**。
§六 的提问与 §4.3 的选项表**原文保留**，此处只追加结论。

⚠️ **选项 B 的文字自带一个条件，随本次选择一并生效**（这是选项定义的一部分，
不是我的推断）：B 的选项描述原文为——

> 「…需你明确一句：`:812` 那条 TBD **不覆盖**这个最小实现
> （否则等于我替你推翻你自己写的 DO NOT INVENT）」

用户在选择 B 的同时即接受了该条。**因此记录为**：
**产品确认 `database-schema.md:812`（「复杂 Replacement / Assignment 聚合 \| TBD — DO NOT INVENT」）
不覆盖本轮这个最小 direct-replace 实现。**
👉 **请在人工验收时复核这一句**——它是本轮唯一一处「由选项语义承载、而非独立成句」的授权。

**本轮 direct-replace 的最小化边界（不得越过的自我约束）**：

| 允许 | 禁止 |
|---|---|
| 复用既有原语 `writeAcceptanceRelease` / `applyOrderAcceptanceReleased` / `applyOrderAccepted` 与既有字段 | ❌ 新增 Assignment / AfterSalesCase 聚合或任何新实体 |
| 同一**同步**事务内 `serving → paid → accepted`（原子段内**无 `await`**，见 batch §架构硬约束） | ❌ 新增任何字段（尤其不得给 `CompanionReleaseRecord` 加 `servingAt`——D-Q1 已裁定不改结构补偿） |
| 写 `CompanionReleaseRecord`（`source` 区分既有取值） | ❌ 新增 `OrderStatus` 值 |
| Dispatch 从上一任解绑、绑到新打手 | ❌ 新增第二套 Dispatch / Notification / Auth |
| 新 `actualCompanionId` + 新 `acceptedAt`（终态 `accepted`） | ❌ 让客户端决定「谁是新打手合不合法」（资格校验在服务端） |

**新打手资格（沿用本轮范围里的既有规格，非新增）**：必须 `enabled=true`、未 removed、
资格有效、**不是订单用户本人**。


---

## 十、实现决策（裁定之后、编码之前）

> 本节记的是**在 Q1/Q2 裁定范围内**的实现落点。凡属「产品规则」的一律不在此自行决定，
> 已裁定的两条见 §九；仍无权威依据的写在 §十一「本轮**不**自行决定的事」。

### D1 — 释放时清 `servingAt`（执行 §九 D-Q1）

`applyOrderAcceptanceReleased`（`lib/data/mockPaymentRepository.ts:274`）**增加一行** `servingAt: null`。
它今天写四个字段，本轮的第五个字段就是这条裁定的唯一落点。
⚠️ 该写入器**同时**服务 `accepted → paid`（主动取消 / 换人）与 `serving → paid`（封禁 / 换人），
清空对前者是恒等操作（那时本来就该是 null），因此**不需要第二个释放写入器**。
`applyOrderServing` 的 `order.servingAt ?? at` **原样保留**：清空之后它必然写本次的 `at`，
P0-7 的「重复点击不刷新」断言不受影响。

### D2 — pending `CompletionSubmission` 作废

- `COMPLETION_TRANSITIONS` 增加 **`pending → invalidated`**（`lib/constants/completions.ts:91`）。
  今天这条边**不存在**，而作废路径必须走中央状态机（D15），因此不补它就无法合法作废。
- 新增同步写原语 `applyCompletionInvalidation(id, at)`（`lib/data/mockCompletionRepository.ts`）：
  `status → invalidated`、写 `invalidatedAt`、**并清掉 `pendingSubmissionIdByOrder` 索引**。
  索引必须与状态同段变——否则「记录已失效、索引还占着 pending 额度」会让新打手提交不了新材料。
- 新增入口 `invalidatePendingCompletionForOrder({ orderId, at })`（`lib/data/completionTransaction.ts`）：
  走**中央状态机**（`canTransitionCompletion`）判定，**不复用** `applyCompletionReview`（D15 明令）。
  只作废该订单当前 pending 的那一条；没有 pending 时**什么都不做**（不是错误）。
- 作废的含义是**保留历史**：那条 submission 记录原样留在 store 里，只改状态与时间。
  「新打手重新 serving 后可提交新 submission」由 D2 第二段清索引保证。
- 「Staff 不得再 approve/reject」「auto sweep 永不 approve」**不需要新代码**：
  `approveCompletion` / `rejectCompletion` 的领域 Guard 要求恰好 `pending`，
  `sweepCompletionAutoApprovals` 的**白名单**只认 `pending`。因此它们天然拒绝 `invalidated`。

### D3 — 释放原语的复用方式（不新增第二套）

`writeAcceptanceRelease`（`lib/data/companionOrderTransaction.ts:146`）**改为可服务三种 source**：

| 改动 | 理由 |
|---|---|
| `idempotencyKey: string → string \| null` | 主动取消靠幂等键（调用方给的串）；**封禁与客服换人不靠它**——它们的幂等判据是**状态本身**（P0-6 D5 的既有裁决）。为它们编一个键会污染 `releaseIdByKey` 这个「打手 × 他自己的键」的索引空间 |
| 键为空时**跳过** `bindCompanionReleaseKey` | 同上：不往索引里写不属于它的条目 |
| 新增一步：`invalidatePendingCompletionForOrder` | 见 D2；**在本段原子区段之内** |

`source` 取值**不新增**：`staff_reassign` 承载「客服重新进公共池」与「客服指定新打手」两种，
`companion_disabled` 承载封禁。三者正好用满 `database-schema.md` T4 已定义的三个值。

### D4 — `serving → paid` 的接入（cmd:42）

释放入口同时接受 `accepted` 与 `serving`：结构校验用 `canTransitionOrder(status, "paid")`，
领域 Guard 写成 `status === "accepted" || status === "serving"`（两道门都要，理由同 P0-7）。
`serving` 时**同一段同步代码**内继续走 D2 作废与 D1 清 `servingAt`。
**不新增 `serving → accepted` 状态边**：direct replace 走的是 `serving → paid → accepted`
两步写入（同一原子段，中间那个 `paid` 对外不可见，也不经过任何读取路径）。

### D5 — 直接指定新打手的「资格有效」= `isCompanionAcceptingOrders()`（**复用，不新写**）

cmd 只列了四条：`enabled`、未 `removed`、资格有效、不是订单用户本人。
其中「资格有效」**没有第二处定义可依**，因此**复用仓库里唯一那个「这位打手此刻能不能接新单」的谓词**
`isCompanionAcceptingOrders()`（`lib/constants/companions.ts:215`）——它正是
结算页指定、公共池列表、原子接单区段三处用的同一个函数（该函数的注释自己列了这三处调用方）。
⚠️ 它**包含 `available`**：一位「暂停接单（休息中 / 已排满）」的打手**不能被指定**。
这是「资格有效」在本仓库唯一一个可依的既有口径（「禁止自行发明第二条口径」），
但**它不是 cmd 字面列出的四条之一**，因此已列入 §十二 待产品复核。

「不是订单用户本人」判据与 `acceptDispatch` **同一条**：`companion.userId !== null && order.userId === companion.userId`
（`lib/data/companionDispatchTransaction.ts:277`）。`userId === null` 的平台早期护航照常可指定。

### D6 — 封禁联动的挂点：`setCompanionFlags` 的原子区段内（不新开第二条禁用路径）

`intent === "disable"` 时，在 **同一段无 `await` 的代码**里追加「释放该打手当前全部 accepted/serving 订单」。
不新增第二个禁用入口——两条入口就是两份规则。
- **同一原子段**：不这样做会出现「已停用但订单还挂着他」或「订单释放了但他还是 enabled」，两者都自相矛盾。
- **`changed` 的口径**：`AdminCompanionWriteResult.changed` 的文档写的是「这一次是否真的改动了数据」，
  因此改成 `标志位有变 || 释放了至少一单`。仅改标志位却报「什么都没发生」与事实不符。
- **幂等键重放（`replay`）仍然早退、一个字节都不写**（既有语义不变）。
- **`available=false`（暂停接单）不释放**（EX-SERVICE-05 明文）；`intent === "pause"` 路径一行都不动。

### D7 — 通知：三种释放**都通知下单用户**

- 封禁：EX-COMP-01 / EX-COMP-02 明文「必须收到通知」；
- 主动取消：EX-SERVICE-01 明文；P0-6 已实现；
- **客服换人 / 回池：cmd 没有明文要求通知**，但用户可见的事实与上面两种**完全相同**
  （「谁在给我做」变了）。不通知 = 用户只能靠自己刷新发现履约人换了。
  因此复用 `appendNotification`（**不新建通知系统**）并新增一条文案。
  ⚠️ 这一条**超出了 cmd 明文**，理由与文案已列入 §十二 待产品复核。

### D8 — 接口与页面落点

| 动作 | 接口 | 页面 |
|---|---|---|
| 重新进入公共池 | `POST /api/staff/orders/[id]/release`，body `{ reason }`（**必填**） | `/staff/orders/[id]` 的写操作区 |
| 直接指定新打手 | `POST /api/staff/orders/[id]/replace`，body `{ companionId }` | 同上 |
| 可指定的候选打手 | `GET /api/staff/orders/[id]/replace-candidates?keyword=` | 同上面板按需拉取 |

候选列表**单独一个只读地址**而不是塞进 `StaffOrderDetail`：详情 DTO 是「一单的现状」，
而候选名单与这一单无关（只受它约束），塞进去会让每一次订单详情读取都白算一遍候选人。
资格过滤在**服务端**（复用 D5 的谓词），前端只渲染服务端给的名单——前端筛一遍就等于有了第二份资格规则。

### D9 — 客服侧 `allowedActions`（本轮第一次给客服动作）

`StaffOrderDetail` 增加 `allowedActions: { canRelease, canReplace }`，**由服务端算好**。
理由与 P0-8 的 `StaffCompletionAllowedActions` 同一条：终态订单天然没有按钮，
而不是前端拿 `status` 自己写 `if`。**不加一个恒为 false 的布尔值**（P0-10 的注释已明确反对）。

### D10 — 本轮发现的既有缺口（**不修，登记**）

| # | 缺口 | 处置 |
|---|---|---|
| 1 | `lib/constants/orders.ts:86-92` 的 TARGET 注释说 `serving → paid`「本批次不实现、也不提供任何 API 或按钮」 | **本轮必须改**：它描述的已不是事实。与 §五 记录的同一处 |
| 2 | `lib/types/companionRelease.ts` 的 source 注释说另外两个 source「尚未实现、也没有任何写入路径」 | **本轮必须改**（同上） |
| 3 | 会话按 `orderId` 单键存储（`lib/types/message.ts:51`），而 EX-SERVICE-04 要求「每次新 assignment 建新会话；新打手看不到旧聊天」 | **不修**：P0 打手端**没有任何聊天面**（无 `app/api/companion/**/messages`、无聊天页），因此今天无人能看到旧聊天；等打手端聊天上线时必须按 assignment 隔离。已登记为遗留 |
| 4 | 「移除（`removedAt`）是否也应释放当前履约」 | **不做**：需求只对 `enabled=false` / 封禁冻结了释放语义（EX-COMP-01/02）；`移除` 只有权限行（`用户权限表.md:137` / `:488`），**没有任何订单联动规则**。自行补一条就是发明规则。已登记为遗留 |

### D11 — 测试落点

新增 `tests/staffOrderActions.test.mjs`（纯逻辑 + 伪事务 + HTTP 三层），
并**同步扩充** `tests/staff.test.mjs` 的客服接口清单（那条门禁逐个列出地址，
新增三个地址而不改它 = 门禁失效）。

---

## 十一、实现落地后的更正（**追加，不覆盖**上面任何一条）

### D12 — D6 的 `changed` 口径**没有按原话实现，而且不应该实现**（更正 D6 第二段）

D6 写的是把 `AdminCompanionWriteResult.changed` 改成 `标志位有变 || 释放了至少一单`。
**落地时没有改**，因为复核后发现：按原话写出来的第二个析取项是**不可达的**。

`lib/data/adminCompanionTransaction.ts:536`：

```ts
if (replay?.kind === "replay" || areFlagsUnchanged(existing, flags)) {
  return { kind: "ok", value: { … }, changed: false, replayed: … };
}
```

**标志位逐个相同就提前返回**，永远走不到下面。因此「释放了至少一单」这个条件下
`changed` 只可能是 `true`（`= flagsChanged`），`flagsChanged || released > 0`
与 `flagsChanged` 恒等，多写的那个析取项是一句**永远为假**的代码。

- **结论**：`changed` 的现有语义**已经正确**——它就是「这一次是否真的改动了数据」，
  因为「真的改了」与「标志位变了」在本函数里是同一件事。D6 那句话按字面实现只会
  在源码里留下一段无法被测试覆盖的分支。**行为零变化**，因此不需要改代码。
- ⚠️ **但由此暴露出一条真正的边界，登记为遗留**：既然标志位未变就提前返回，
  那么**对一位已经 `enabled: false` 的打手再次执行停用，不会补做释放**。
  P0-11 起「停用」与「释放」在同一个原子段里，正常运行下不会出现「已停用但订单还挂着他」；
  能构造出这种状态的只有 P0-11 **之前**的历史数据（或一次失败的停用，而那时标志位也还没写，
  见 `adminCompanionTransaction.ts:545-563` 的排序理由）。
  这种数据的出路是**按单走客服回池**（`releaseOrderByStaff`），不是重新停用。
  「重复停用是否应补扫」**需求没有冻结**，不自行决定。

### D13 — 记录两件落地时**超出 D1–D11 原话**、需要产品在验收时一并复核的事

| # | 事项 | 为什么记在这里 |
|---|---|---|
| 1 | `available` 被加进候选资格（D5 的 `isCompanionAcceptingOrders()` 含 `available`） | `cmd_p0-11.md:44` 只列了「有效、`enabled`、未 `removed`、不是订单用户本人」四项。`isCompanionAcceptingOrders` 多判一条 `available`。**选它是因为它与打手正常接单用的是同一个谓词**（第二份资格规则会更糟），但确实比 cmd 的字面更严：一位被「暂停接单」但仍在册的护航<u>不能</u>被换到。已在验收清单里单列一条 |
| 2 | 客服退回 / 换人也发通知（D7） | `cmd_p0-11.md` 对这两种动作**没有明文要求通知**，只有封禁那一条明文。用户可见的事实与既有两种释放完全相同（「谁在给我做」变了），因此复用 `appendNotification` 补上。超出 cmd 明文，需产品确认 |
| 3 | `docs/02-tech-design/database-schema.md` 的三处同步 | 按产品裁定（D-Q2）更新：`:802` 的「指定新打手仍可后置」、`:812` 的 `TBD — DO NOT INVENT` 行、以及 `:790` 的 T4 最小映射（原来只写「回 public」一条）。**收窄而非删除**：仍然禁止自行设计「完整的 Assignment / 指定改派模型」 |

⚠️ **本章（§十一）在文档里的位置说明**：§十 末尾原来写着「仍无权威依据的写在 §十一
**『本轮不自行决定的事』**」。落地后「不自行决定的事」与「超出 cmd 明文、需要产品复核的事」
合并成了下面一章（§十二）——D7 与 D5 里两处「已列入 **§十二** 待产品复核」指向的**就是它**。
本章只记「实现与原决策不一致」的更正，不重复那些待复核项。

---

## 十二、本轮**不**自行决定的事 + **超出 `cmd_p0-11.md` 明文**、需要产品复核的事

> 这一章就是 D5 / D7 里两处「已列入 §十二 待产品复核」的落点。
> 下面每一条都**已经在代码里按某个具体口径实现了**（否则本轮无法交付），
> 但**没有权威文本**冻结它。产品复核的结论如果是「换一种」，那是改实现，不是改文档。

### 12.1 超出 `cmd_p0-11.md` 明文的两条（**已实现，需追认**）

| # | 事项 | cmd 的原话 | 本轮的实现与理由 |
|---|---|---|---|
| 1 | 候选打手的**资格判据**含 `available` | `cmd_p0-11.md:44` 只列了「有效、`enabled`、未 `removed`、**不是订单用户本人**」四项 | 复用 `isCompanionAcceptingOrders()`（= 在册 **且** `available`），即**与打手自己抢单时用的是同一条谓词**。比 cmd 字面**更严**：一位「暂停接单但仍在册」的护航**不能**被换到。选它的理由是「第二份资格规则」更糟——但确实超出了字面，必须由产品追认。见 D5 / D13-1 |
| 2 | 客服**退回公共池 / 换人**也给下单用户发通知 | cmd 只对**封禁**明文要求通知（EX-COMP-01 / EX-COMP-02）；对客服这两种动作**没有明文** | 用户可见的事实与既有两种释放**完全相同**（「谁在给我做」变了）。复用 `appendNotification` + 新增「你的护航换了」文案，**不新建通知系统**。见 D7 / D13-2 |

### 12.2 本轮**不做**的既有缺口（登记，`cmd_p0-11.md` 未要求）

| # | 缺口 | 为什么不做 |
|---|---|---|
| 1 | 会话按 `orderId` 单键存储，而 EX-SERVICE-04 要求「每次新 assignment 建新会话」 | P0 打手端**没有任何聊天面**，今天无人能看到旧聊天；等打手端聊天上线时必须按 assignment 隔离。见 D10-3 |
| 2 | 「移除（`removedAt`）」是否也应释放当前履约 | 需求只对 `enabled=false` / 封禁冻结了释放语义；`移除` 只有权限行，**没有任何订单联动规则**。自行补一条就是发明规则。见 D10-4 |
| 3 | 对一位**已经停用**的护航再次停用，不会补做释放 | `areFlagsUnchanged` 提前返回所致，正常运行下构造不出来（见 D12）。需求未冻结「重复停用是否补扫」，自行决定就是发明规则 |
| 4 | 客服搜不到用户资料页上的**平台展示 ID**（`displayId`） | P0-10 已登记的既有缺口（那段属 P0-10 的验收范围，本轮继承，未扩大） |

---

## 十三、reviewer 复核结论的处置（**追加，不覆盖**上面任何一条）

> 本节是**追加**的：上面 §四–§十二 的提问、裁定与实现决策**一个字都没有被改写**。
> 本节只记录「只读 reviewer 复核之后，哪一条被接受、怎么改的」。逐条证据见
> `03-delivery.md` §4.3 / §七；验收侧读数见 `04-acceptance.md` §五。

**初判 BLOCKER 0 / MAJOR 2 / MINOR 4 / NOTE 2 → 复核后重测 0 / 0。**

### 13.1 两条 MAJOR

| # | 结论 | 处置 | 依据 |
|---|---|---|---|
| MAJOR-1 | 三个新写接口**没有任何 HTTP 正例**——「正常结果」那一格空着，而 `01-requirements/用户权限表.md` §十三第 8 条要求权限矩阵覆盖 401 / 403 / 404 / **正常结果** | **接受并补测**：新增 **2 条 HTTP 正例**（回池 / 换人）。不碰种子订单，用 HTTP 现场造一单再打，写完**回读只读接口自证**，因此可重复跑。逐条证据与两次受控 mutation 见 `03-delivery.md` §4.3 | 本节不改动 D1–D13 的任何结论——**行为本身没有变**，变的是「有没有测」 |
| MAJOR-2 | 本轮档案与计数**没有回填**（`需求功能点进度表.md` 的缺口仍写成未实现；`CLAUDE.md` / `api-contract.md` 的接口数与测试数仍是旧值） | **接受并回填**：`需求功能点进度表.md`（P0-11 行 + 缺口表 + 收口计划行）、`CLAUDE.md`（`127 → 130` route.ts / staff `22 → 25` / `66 files, 1278 cases → 67 files, 1324 cases`）、`api-contract.md` §11（`25 条`）、`directory-structure.md`、`总需求进度表.md` 的 P0-11 行 | 计数漂移属于**记录错误**，不是设计选择，因此不需要产品裁定 |

> ⚠️ reviewer 初判里另有两条**当时已失效**：它指出 `P0-11/03-delivery.md` / `04-acceptance.md` /
> `README.md` 仍是 `CLARIFYING` 空档案。那是它**在本轮档案整篇重写之前**读到的版本，
> 重写后该结论不成立。**本节的处置表不改写 reviewer 的原始结论，只是标注其时效。**

### 13.2 四条 MINOR（全部**已改**，无一留作遗留）

| # | 结论 | 处置 | 类型 |
|---|---|---|---|
| MINOR-1 | `releaseOrdersForCompanion` 号称「全量读 → 全量校验 → 全量写」，但校验循环**漏了「作废 pending 材料」**——它是写入循环里**唯一**可能失败的源，漏掉则第一单写完才发现第二单失败 | **改实现**：把 `canInvalidatePendingCompletionForOrder`（与写入路径**同一个**只读判据）提进第 2 步校验循环；新增用例 `可用性 6` 钉住「第一单也不得被解除」 | 这是 D6「同一原子区段」的**正确化**，不改变 D6 的结论 |
| MINOR-2 | `releaseStaffOrder` 写成功后**回读订单**只为拿 `orderNo`，平白多出「写成功却报 404」的分支，以及两次 `await` 之间的中间态窗口 | **改实现**：事务层 `ok` 结果直接带 `orderId` / `orderNo` / `releasedAt`；`releaseResult` 不再接收 `Order`，`import type { Order }` 一并删除 | 与 D8 不冲突（对外 DTO 一个字段没变），删掉的是一条**不该存在**的错误出口 |
| MINOR-3 | `inconsistent → 500` **只有实现、没有对外契约用例**（`可用性 4` 测的是下架路径的原子性，不是接口的 500） | **补测**：新增 `作废 6`，`release` 与 `replace` 两条服务入口都断言 500 文案 + `assertNothingWritten` | 补的是 D11 测试落点里漏掉的一格 |
| MINOR-4 | 三处注释**指向已不存在的事实**：`completionTransaction.ts` 仍引用旧名 `writeAcceptanceRelease`；`StaffReleaseHistory.tsx` 没写清 `reason` 为什么会是空；`directory-structure.md` 的释放记录消费方段落漏了本轮新增的两条路径 | **改实现（注释 / 文档）**：前者改为点名 `releaseCurrentAssignment` 并注明旧名是它被抽出来之前的形状；中者写明空 `reason` 可达（客服直换 / 封禁回池）且只有 `companion_cancel` 带用户原话，故兜底必须保留；后者逐条补上封禁回池与客服退回 / 换人，并注明该文件现有**五个**公开入口 | D3 的命名收敛在**文档层面**的收尾 |

### 13.3 两条 NOTE（接受，不改）

| # | 结论 | 处置 |
|---|---|---|
| NOTE-1 | 两条 HTTP 正例依赖「造一单」的前置链路，若将来支付通道默认关闭会一起红 | **接受**：这正是设计意图——宁可红，也不要静默跳过。见下条 |
| NOTE-2 | `02-decisions.md` 的 Q1 / Q2 裁定与 D1–D13 之间没有交叉引用 | **接受**：§九 D-Q1 / D-Q2 已各带一句指向正文小节；本节亦不复述其内容 |

### 13.4 ⚠️ 复核过程中**自查**出的一个缺陷（不在 reviewer 的结论里）

两条 HTTP 正例**最初是假绿的**：它们先拿一个假 `paymentRequestId` 去探测支付通道开没开，
打算「关着就跳过」——但 `/api/payments/mock-confirm` 在**「通道关着」**与**「请求不存在」**两种情况下
**都返回 404**，于是探测**每次都判定为「关着」**，两条正例**每次都在探测处提前 `return`，
一行断言都没执行**（连 `✔` 都是假的）。

暴露方式：**受控 mutation 第一次没有变红**。人工 `curl` 那个 404 的文案是「支付请求不存在」，
说明支付通道其实是**开着**的，才定位到探测本身的逻辑错误。

修法：**删掉探测，直接走真链路**——支付通道真关着就让它在断言上炸出声，**不再有任何静默跳过的出口**。

> 这条记在这里的意义超出本轮：**「全绿」只有在能被证伪的时候才是证据。**
> 本轮的第一版门禁读数（42 条 / 1320 用例 / 全绿）在纸面上完全合格，
> 但它同时包含两条**零断言**的用例——只有 mutation 把它证伪了。
> 因此本轮最终交付的读数（46 条 / 1324 用例）才附上「两次 mutation 各自精确变红」作为佐证。

### 13.5 本节**没有**改变的事

- 没有新增任何产品决策：本轮的产品裁定仍然只有 **Q1 / Q2**（§九 D-Q1 / D-Q2）与
  **待追认的 R1–R4**（§十二）；
- 没有放宽任何断言：MINOR-1 / MINOR-3 是**加**用例，MAJOR-1 是**加**用例，
  MINOR-2 / MINOR-4 是删掉不该存在的分支与改注释——**没有一条是把期望值调松**；
- 没有扩 `OrderStatus`、没有新增仓储、没有碰金额（§五 的边界仍然成立）。
