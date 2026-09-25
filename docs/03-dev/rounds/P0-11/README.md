# P0-11 · 客服换打手 + 打手禁用回池 + pending CompletionSubmission 失效

Round ID: P0-11
Title: 客服换打手（re-pool / direct replace）+ 打手被禁用后的自动释放 + pending `CompletionSubmission` → `invalidated`
**Status: `AWAITING_ACCEPTANCE`**（Q1 / Q2 已于 2026-09-24 裁定，见 `02-decisions.md` §九；开发与门禁已完成）
Depends On: P0-10（`AWAITING_ACCEPTANCE`）· P0-9 / P0-8 / P0-7 / P0-6（均 `DONE`）
Goal: 统一处理两类「释放当前打手并重新安排履约」的异常——① Staff 主动换打手 / re-pool；② Companion 被平台禁用后，已有 `accepted` / `serving` 订单自动释放回公共池。复用现有 release / dispatch 原语，**不创建复杂 Assignment**。
Primary Domain: Order · Dispatch · CompanionReleaseRecord · CompletionSubmission
Primary State Transition: `accepted → paid`（释放）· **`serving → paid`（本轮首次给它接入口）** · `paid → accepted`（新打手）· submission `pending → invalidated`
Started At: 2026-09-24
Development Completed At: 2026-09-24（门禁全绿：`pnpm test` 1324 / fail 0 / skip 143；生产 HTTP 全量 **1324/1324 / skipped 0** / typecheck / lint / build 各 exit 0）
Review: **reviewer 初判 BLOCKER 0 / MAJOR 2 / MINOR 4 / NOTE 2 → 整改后 0 / 0**（明细见 `03-delivery.md` §七、`02-decisions.md` §十三）
Accepted At: ——（等用户本人验收，见 `04-acceptance.md`）
Git Commit: ——（本批次禁止 Git 写操作；提交由用户本人完成，Claude 无权代填）

---

## ✅ 两个阻塞问题**均已裁定**（2026-09-24）

| 问题 | 裁定 | 实现口径 |
|---|---|---|
| **Q1** `servingAt` | **改写为本次 assignment 的时刻** | 释放时**清 `servingAt`**；`applyOrderServing` 的 `order.servingAt ?? at` **保留** |
| **Q2** direct replace | **B — 做最小 direct-replace** | 复用既有原语与字段，**不新增聚合/字段/`OrderStatus`**；产品确认 `database-schema.md:812` 的 `DO NOT INVENT` **不覆盖**这个最小实现，该文档已按裁定同步收窄 |

> 裁定原文与证据链见 `02-decisions.md` **§九 D-Q1 / D-Q2**；
> §三 / §四 是提问原文，保留不动。
> ⚠️ **`CLARIFYING` 期间没有写过任何业务代码**；本轮全部实现均发生在裁定之后。

### 交付摘要（明细见 `03-delivery.md`）

| 落点 | 内容 |
|---|---|
| 释放原语 | `lib/data/companionOrderTransaction.ts` 的 `releaseCurrentAssignment`（1 处定义、**4 处调用**），整个文件**零 `await`** |
| 客服退回公共池 | `POST /api/staff/orders/[id]/release`（`reason` 必填）→ `releaseOrderByStaff` |
| 客服指定换人 | `POST /api/staff/orders/[id]/replace` → `replaceOrderCompanionByStaff`，终态 `accepted` + 新 `actualCompanionId` + 新 `acceptedAt` |
| 换人候选名单 | `GET /api/staff/orders/[id]/replace-candidates`（服务端按资格筛，`activeOrderCount` 一并返回） |
| 封禁回池 | `setCompanionFlags` 的**同一原子区段**内调用同步的 `releaseOrdersForCompanion`（全量读 → 全量校验 → 全量写） |
| 完成材料作废 | `pending → invalidated`，唯一入口 `invalidatePendingCompletionForOrder()`；**记录保留、只改状态**，且 `approve` / `reject` / 自动通过三条路径都拒绝它 |
| 唯一写入口 | `components/staff/StaffOrderActionsConsole.tsx`，完全按服务端 `allowedActions` 渲染 |

### reviewer 复核与整改（**已完成，0 / 0**）

初判 **BLOCKER 0 / MAJOR 2 / MINOR 4 / NOTE 2**，全部处置完毕、重跑门禁后**现为 0 / 0**：

| 级别 | 结论 | 处置 |
|---|---|---|
| **MAJOR-1** | 三个新写接口**没有 HTTP 正例**（权限矩阵缺「正常结果」那一格） | 补 **2 条 HTTP 正例**：HTTP 现场造一单 → 客服真的打过去 → **回读只读接口自证**；各做一次**受控 mutation** 证明咬得动 |
| **MAJOR-2** | 本轮档案与计数**没有回填** | 回填 `需求功能点进度表.md` / `CLAUDE.md`（`130 route.ts`、`67 files, 1324 cases`）/ `api-contract.md` / `directory-structure.md` / `总需求进度表.md` |
| MINOR-1 | `releaseOrdersForCompanion` 的「全量校验」漏了**作废 pending 材料**这一步 | 把只读判据 `canInvalidatePendingCompletionForOrder` 提进校验循环；新增 `可用性 6` |
| MINOR-2 | 写成功后**回读订单**只为拿 `orderNo` | 事务层 `ok` 直接带 `orderId` / `orderNo` / `releasedAt`，删掉回读与那条「写成功却报 404」的出口 |
| MINOR-3 | `inconsistent → 500` 只有实现、没有对外契约用例 | 新增 `作废 6`（两条入口都断言 500 + 一笔未写） |
| MINOR-4 | 三处注释指向已不存在的事实 | 逐个更正（`writeAcceptanceRelease` → `releaseCurrentAssignment`、空 `reason` 的兜底理由、释放记录消费方段落） |

⚠️ 整改过程中**自查出一个自己的缺陷**：两条 HTTP 正例最初是**假绿**的——探测逻辑把
「支付通道关着」与「支付请求不存在」两个 404 混为一谈，导致每次提前 `return`、**零断言**。
是**受控 mutation 没变红**才把它暴露出来的。详见 `03-delivery.md` §4.3 / `02-decisions.md` §13.4。
**教训：「全绿」只有在能被证伪的时候才是证据。**

### ⚠️ 验收时**必须一并复核**的四条（超出 `cmd_p0-11.md` 明文或需求未冻结）

见 `02-decisions.md` §十二：① 候选资格比 cmd 字面**多一条 `available`**；② 客服回池 / 换人**也发通知**（cmd 只对封禁明文要求）；③ 「重复停用不补做释放」（`areFlagsUnchanged` 提前返回所致）；④ 「移除是否应释放」与「会话按 assignment 隔离」登记为遗留。

### Q1（✅ **已裁定 2026-09-24**）— `servingAt` 保留还是改写

> **产品裁定：选 2 = 改写为本次 assignment 的时刻。**
> 实现口径（释放时清 `servingAt` + 保留 `applyOrderServing` 的 `??`）见
> `02-decisions.md` §九 D-Q1。以下为提问原文，保留不动。

本轮要求把 `serving → paid` 这条状态边**第一次接上入口**（`cmd_p0-11.md:42`
「若原 serving：同一同步事务内 `serving → paid → accepted`」），
而**最新权威文档对这一条边的前置问题仍是 `DEFERRED`**：

> `docs/03-dev/rounds/P0-9/02-decisions.md:229` **D14（DEFERRED）**——
> 「`servingAt` 在『换人 / 回池后重新开始服务』时该保留还是改写」
> 「**何时必须裁定**：**任何轮次准备给 `serving → paid` 接入口之前**。」

`P0-9/02-decisions.md:246-247` 写明当时不裁定的理由是
「`serving → paid` 今天**没有任何入口**……现在改写入器就是**替未来乱定规则**」——
**本轮正是那个「未来」**。

⚠️ 这不是「照抄文档就停下」：触发链已在**代码里逐行核实**——
释放写入器 `applyOrderAcceptanceReleased`（`lib/data/mockPaymentRepository.ts:274`）**不清 `servingAt`**，
而开始服务写入器写的是 `servingAt: order.servingAt ?? at`（同文件 `:340`）。
因此 `serving` 单被放回 `paid` 后，**新打手点「开始服务」会沿用上一任的开始时间**——
用户端时间轴与打手端「护航中」开始时间都会显示错，且这是将来按实际服务时长结算的基准。

- **1 = 保留最早时刻**（本单第一次开始服务，即今天 `??` 的行为）
- **2 = 改写为本次 assignment 的时刻**（「当前这位」打手从何时开始服务）

### Q2（✅ **已裁定 2026-09-24**）— 「Staff 直接指定新打手」是否在 P0 范围内

> **产品裁定：选 2 = B，做最小 direct-replace**（复用既有原语与字段，不新增聚合 / 字段 / `OrderStatus`），
> 且 `database-schema.md:812` 的 `DO NOT INVENT` **不覆盖**它——该文档已按裁定同步收窄。
> 裁定原文与实现口径见 `02-decisions.md` §九 D-Q2。以下为提问原文，保留不动。

`cmd_p0-11.md:39-42` 要求客服**可直接指定新打手**并把订单写成新 `actualCompanionId` 的 `accepted`；
但**权威技术设计把「指定新打手」明确后置、且列入禁止自行设计**：

> `docs/02-tech-design/database-schema.md:812`（位于**「第三部分：TBD — DO NOT INVENT」**，
> 前言为「既未实现，规则也未确认。**禁止自行设计任何结构、字段或约束**」）——
> 「**复杂 Replacement / Assignment 聚合** \| **TBD — DO NOT INVENT**……
> 客服换人权限与不限次数已确认，但**完整 Assignment/指定改派模型不做**」
>
> `:801`——「完整 AfterSalesCase 实体、复杂 Assignment、**指定新打手**等**仍可后置**」
> `:790`——「P0 最小技术映射同样是『写 release → 回 public』，**由新打手正常 accept**」
> `api-contract.md:629`（§3.6）——「P0 技术映射采用『解除当前履约 → 回 public →
> **由新打手重新接单**』的最小路径」

⚠️ 全文检索 `docs/01-requirements/` 与 `docs/02-tech-design/` 后确认：
「指定新打手 / 直接指定」**没有任何授权文本**（两处命中分别是**用户侧禁止**
`用户权限表.md:210` 与**后置** `database-schema.md:801`）。
**客服有权「换人」本身是明确授权的**（`用户权限表.md:118` / `:424` / `:652`、`特殊情况表.md:345`）——
差别在于权威文档给「换人」确认的技术映射是「回 public → 由新打手正常接单」。

**三个选项**（详见 `02-decisions.md` §4.3）：

| 选项 | 含义 |
|---|---|
| **A** | 只做 re-pool（回 public → 新打手正常抢单），严格贴合 P0 最小映射；direct replace 后置 |
| **B** | 做最小 direct-replace（复用既有原语与字段，**不新增聚合/字段/`OrderStatus`**），并需产品明确「`:812` 的 `DO NOT INVENT` **不覆盖**它」 |
| **C** | 先 A 后 B：本轮只交付「释放 + 禁用回池 + `invalidated`」，direct replace 单独一轮 |

> 📌 Q1 与 Q2 相互独立，但**都必须先答 Q1** 才能动 `serving → paid`。

---

## 本轮范围（裁定后已全部执行，见 `03-delivery.md`）

**做**（✅ 全部完成）：

- `available` 与 `enabled` 的语义分离（**禁止混淆**）：`available=false` 只是不接新公共单，
  不影响已有 `accepted` / `serving`；`enabled=false` 则必须释放。
- 禁用释放：`accepted` / `serving` → `paid`，清履约绑定，Dispatch → public，
  fresh `publicPoolEnteredAt`，fresh 超时快照，保留历史，写 `CompanionReleaseRecord`，通知老板，旧打手失去操作权。
- pending `CompletionSubmission` → `invalidated`（不删历史；Staff 不得再 approve / reject；auto sweep 永不 approve）。
- Staff re-pool：`/staff/orders/[id]` 提供「重新进入公共池」，**原因必填**，`accepted` / `serving` 均支持。
- Staff direct replace：直接指定新打手，**不需要 Admin 批准**；新打手必须 `enabled`、未 removed、
  资格有效、**不是订单用户本人**；终态 `accepted` + 新 `actualCompanionId` + 新 `acceptedAt`。
  ⚠️ 「资格有效」的实现比这行字面**多一条 `available`**，理由与追认请求见 `02-decisions.md` §12.1。
- 多次换人 `A→B→C→public→D`，不设次数上限，每次保留 release history。

**不做**：

- ❌ 退款 / 售后资金动作（P0-12 / P0-13）
- ❌ 第二套 Order / Notification / Auth / **复杂 Assignment**
- ❌ 擅自扩 `OrderStatus`
- ❌ 任何 Git 写操作

---

## 权威依据

| 事项 | 文档 |
|---|---|
| 本批原始指令 | `docs/03-dev/rounds/cmd_p0-11.md` → `01-prompt.md` |
| 批次约束 | `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md` |
| **本轮解除的 `DEFERRED` 决策** | `docs/03-dev/rounds/P0-9/02-decisions.md` **D14**（`:229`）。⚠️ **D14 未回填**：`P0-9/02-decisions.md` 是 append-only，本轮**没有**去改它——裁定与理由全部记在**本轮**的 `02-decisions.md` §九 D-Q1。读 D14 的人应顺着这里找到它 |
| 该 `DEFERRED` 的来源与「何时必须裁定」 | `docs/03-dev/rounds/BATCH_p0-6.1_to_p0-9_最终报告.md:404` |
| 禁用释放的历史语义（cancel / ban / staff re-pool 清绑定） | 批次文件 §历史语义 |
| 权限开发纪律 | `docs/01-requirements/超哥电竞_用户权限表.md` §十三 |
| 分层与 DTO 裁剪 | `docs/02-tech-design/architecture-rules.md` §2.2 / §2.3 |

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（`cmd_p0-11.md` 原样拷贝，54 行） |
| `02-decisions.md` | Requirement Check 结果、Q1 / Q2 的提问原文与**裁定记录**、D1–D13、§十二 待产品复核、**§十三 reviewer 复核结论的处置**（追加，不改写上文） |
| `03-delivery.md` | 实现结果与验证、reviewer 结论与整改（§七）、门禁读数（§六）、Git 状态 |
| `04-acceptance.md` | 人工验收清单（含四条「超出 cmd 明文」的复核项） |
| `README.md` | 本文件 |
