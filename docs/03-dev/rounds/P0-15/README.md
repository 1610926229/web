# P0-15 · 退款唯一化 + 收益全额归零 + 结算冻结闭环

Round ID: P0-15
Title: **一个订单只退一次** —— 把「多次累计退款」模型整体收敛为「一次性核定」，
退款批准即把打手本单收益**整笔**归零（不再按责任比例部分冲减），
并把 `PlatformConfig` 驱动的**投诉窗口快照 + 结算冻结**闭环补齐、钉死并发
**Status: `AWAITING_ACCEPTANCE`**
> ⚠️ **2026-09-29 头部字段纠偏（P1-3 夜间批次）**：此处原写 `IN_PROGRESS`，与本文件
> 下方「状态沿革」表里 2026-09-28 的 `AWAITING_ACCEPTANCE` 交付行、以及
> `docs/03-dev/总需求进度表.md` 的 P0-15 行**都不一致**——交付时更新了沿革表却漏改头部。
> 这里只是把头部同步成**沿革表已经记录过的那一个状态**，**不是**状态迁移，
> **更不是** `DONE`（`Accepted At` 仍为 `—`）。正文一字未改。
Depends On: `P0-13`（责任模型与 `EarningAdjustment`，**其责任模型被本轮取代**）·
`P0-9`（`complaintWindowMinutes` 快照 + `Earning.frozen` + 两个 sweep，**本轮复用不改写**）·
`P0-14`（`refundFullRemaining`，**其修复被本轮取代**）· `P1-2`（快照语义，**本轮遵守**）
Primary Domain: **Refund**（唯一性与金额口径）· **Earning**（整笔冲销）· **Settlement**（冻结释放）· Companion（派生展示）
Primary State Transition: **`Order` 状态机不新增、不迁移**（`OrderStatus` 仍是恰好五个取值）。
收益侧：退款批准 ⇒ 打手本单收益**整笔归零**，但 `Earning.status`
**停在 `frozen`**（Q5 裁定，**不**进入 `reversed`）——因此释放判据
**多了一道净额闸**（`isEarningFullyReversed`），否则「被冲光」的那笔会被放行成可提现
Started At: 2026-09-28
Development Completed At: —
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**）
Git Commit: —（⚠️ 本批次**禁止任何 Git 写操作**）

> ⚠️ **Claude 不得自行 `DONE`。** 本轮交付后停在 `AWAITING_ACCEPTANCE`。
> ⚠️ **`P0-14` / `P1-1` / `P1-2` 全部保持 `AWAITING_ACCEPTANCE`，本轮不改它们的状态。**
> ⚠️ **不得开始 `P1-3`。**

---

## 状态沿革

| 时点 | 状态 | 依据 |
|---|---|---|
| 2026-09-28 | `PLANNED` | 档案建立；指令 ① 与指令 ② **逐字**保存进 `01-prompt.md` |
| 2026-09-28 | `CLARIFYING` | Requirement Check 出 4 个阻塞问题（Q1–Q4），写入 `02-decisions.md` §二 → 停止 |
| 2026-09-28 | `READY` | Q1–Q4 全部 `RESOLVED`；**无 `OPEN`**。其中 **Q1 被指令 ②§五 整体取代**（问题本身取消） |
| 2026-09-28 | `IN_PROGRESS` | 按 `01-prompt.md` + `02-decisions.md` 开发 |
| 2026-09-28 | `IN_PROGRESS` | **Q5 出现并当场裁定**：②§四 / §十(8) 把 `Earning.status` 钉在 `frozen`，与 ①§十(10)（批准后不得再释放）字面冲突 ⇒ 停在 `CLARIFYING` 提问，产品负责人裁定 **「维持 `frozen`，加一道净额闸（按字面读）」**。**D8 被推翻**、**D18 推翻 D12** |
| 2026-09-28 | `AWAITING_ACCEPTANCE` | 交付；`03-delivery.md` / `04-acceptance.md` 写入。⚠️ **Claude 不得自行 `DONE`** |

---

## 这一轮到底在改什么

### 一句话

**把「一次订单可以被多次部分退款、每次按责任比例冲打手一点」这套模型，
换成「一次订单只退一次、退了就把打手这单的钱全部取消」。**

### 三条被取代的旧规则（**必须标 `SUPERSEDED`，不得静默删除**）

| # | 旧规则 | 出处 | 新规则 |
|---|---|---|---|
| 1 | 「**允许**同一 `Earning` 被**多次**退款产生的 reversal 冲减」 | `01-requirements/超哥电竞_特殊情况与异常处理表.md` `EX-REFUND-05`（**✅ 2026-09-25 已确认**） | ①§一：**绝不**允许第二次退款 |
| 2 | 责任认定 `platform` / `companion` / `shared` + 按比例冲减 | 同上 `EX-REFUND-03`（**✅ 2026-09-25 已确认**） | ①§五：**废弃**，一律全额归零 |
| 3 | D17「已提现不冲回，多出的由平台承担」 | `rounds/P0-13/02-decisions.md` §D17 | ②§五：**问题取消** —— 普通退款下 `withdrawn` 结构上不可达 |

### 一条被取代的**代码**裁定

`lib/types/earning.ts` 的 Q2-c 注释写着：

> 「`reversed` 只表示『整笔冲销』……部分冲回**不改变状态**——
> ……**把部分冲回也写成 `reversed` 会让打手以为自己这一单白干了**。」

新规则下，**打手确实这一单白干了**——理由被反转。该注释标 `SUPERSEDED`。

> ⛔ **补充（Q5 裁定之后）**：`reversed` 现在**连整笔冲销也不写了**。
> 退款批准后 `Earning.status` **停在 `frozen`**，所以 `reversed` 的**写入路径今天是一个零**。
> 「整笔冲销」这件事改由**净额**（`isEarningFullyReversed`）表达，不再由状态表达。

---

## ⚠️ 本轮最重要的两个「连带发现」

### 1. P0-14 的修复被本轮取代

P0-14 的根因是「**多步**部分退款会留下 1–99 分尾差，任何整数百分比都表达不了」，
因此引入了 `refundFullRemaining` 作为「退满剩余」的一等公民。
**新规则下每个订单只退一次**，`floor(实付 × 比例)` 一步到位，**尾差不存在**。
→ `refundFullRemaining` 整体删除（D5）。**P0-14 档案不改写**，只加批注指向本轮。

### 2. `complaintWindowMinutes` 早已实现，②§一 是文档纠偏

该字段**已于 P0-9 落地**（默认 1440 分钟、60~10080），
完成时冻结 `Order.complaintWindowMinutesSnapshot` 并算出 `complaintDeadlineAt`，
`Earning.availableAt` **直接复制**该 deadline。
全库普查确认「固定两天」**仅存于历史 plan 文档**，权威文档与代码无硬编码残留
（「48 小时」的历史裁定本来就是「**不要硬编码它**」，不是「它就是默认值」）。→ D13

---

## 已存在、本轮**复用不改写**的机制（②§二/§三/§六 的落点）

| 机制 | 位置 | 状态 |
|---|---|---|
| 阻塞事实读取（只读、同步） | `lib/data/orderBlocking.ts` `readOrderBlockingFacts()` | **已存在** |
| 阻塞判据（唯一定义） | `lib/constants/completions.ts` `isCompletionAutoApprovalBlocked()` | **已存在** |
| 到期判据（只回答时间那一半） | `lib/constants/earnings.ts` `isEarningMatured()` | **已存在** |
| 释放（计划/提交两段、无 `await`、幂等） | `lib/data/earningTransaction.ts` `sweepMaturedEarnings()` | **已存在** |

> ②§二 / §三 / §六 要求的三件事，**结构上已经成立**。
> 本轮的活是**补测试把它钉死**，不是重写。

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（**指令 ① + 指令 ② 逐字保存**） |
| `02-decisions.md` | 12 项 Requirement Check · **Q1–Q5**（已裁定，含 §二 **Q5 的 `frozen` + 净额闸裁定**）· **D5–D21 Claude 自裁技术点**（其中 **D8 被 Q5 推翻**、**D18 推翻 D12**、**D20 由交付前审查的 MAJOR-1 修正而来**、**D21 由第二轮独立复核的 2 MINOR / 2 NOTE 而来**） |
| `03-delivery.md` | 实现结果、文件清单、门禁读数、**净额闸的受控 mutation 红-绿证伪**、reviewer 结论 |
| `04-acceptance.md` | 人工验收清单（编号步骤 + 预期结果）+ **指令 ①20 项 / ②14 项 → 自动化落点的逐条对照表** |
| `README.md` | 本文件 |
