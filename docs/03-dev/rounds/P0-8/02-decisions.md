# P0-8 — Requirement Check 与执行口径

> 本轮档案的正式组成部分。`01-prompt.md` 是**唯一范围来源**；本文件记录
> 「需求 / 技术设计里到底写了什么」与「本轮据此怎么落地」——**不新增产品规则**。
> 本文件**只追加**：口径变化时新增 `### Decision V2`，旧条目标 `**SUPERSEDED**`，不覆盖历史。

Round: P0-8
Status: AWAITING_ACCEPTANCE
Recorded At: 2026-09-24

---

## 一、执行前确认（`01-prompt.md` §一）

### 1.1 已读文档

| 文档 | 本轮用它回答的问题 |
|---|---|
| `docs/01-requirements/超哥电竞_业务流程表.md` BF-18 / BF-19 / BF-19A / BF-20 / BF-21 / BF-22 | 提交、人工通过、系统自动通过、驳回、收益（本轮不做）、投诉窗口（P0-9）的原文规则 |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` EX-COMPLETE-05 / EX-COMPLAINT-03 / EX-CONFIG-06 | 自动通过的前置条件、投诉对自动通过的阻塞、pending 期间改配置的处理 |
| `docs/01-requirements/超哥电竞_用户权限表.md`（完成材料审核行 / §配置项） | 谁能审核、谁能自动通过、配置项归属 |
| `docs/02-tech-design/api-contract.md` §3.2 / §3.4 / §3.5 / §3.7 | 五个已冻结 TARGET 路由、平台配置扩展项、封禁联动（本轮不做）、Earning（本轮不做） |
| `docs/02-tech-design/database-schema.md` §T1 / §T2 / 迁移要求 / 幂等约束表 | `CompletionSubmission` 实体、`Earning`（本轮不做）、`pendingCompletionIdByOrder` 幂等、lifecycle deadline 持久化约束 |
| `docs/02-tech-design/architecture-rules.md`（状态迁移表 / 生命周期配置表 / TARGET 标记） | `serving → completed` 的目标、`completion_review` 不是状态、每轮必须区分 CURRENT 与 TARGET |
| `docs/02-tech-design/directory-structure.md`（`lib/data` 伪事务 / 完成材料落点） | 新目录职责与落点 |
| `docs/03-dev/总需求进度表.md` | 全局进度唯一真值源 |
| `docs/03-dev/development-workflow.md` | Round Protocol 与本轮档案要求 |
| `docs/03-dev/rounds/P0-7/` 五件档案 | 上一轮的结论、未决事项与已知局限 |
| `docs/03-dev/rounds/cmd_p0-8.md` | **本轮唯一范围来源**（已逐字归档为 `01-prompt.md`） |

### 1.2 工作区 baseline（本轮开始前，**不含本轮改动**）

```
HEAD = 249f7c1adefc2c9d9e7f37bb26adde0bc45808df
tracked 改动：17 files changed, 848 insertions(+), 101 deletions(-)
untracked  ：14 项（P0-6.1 / P0-7 / P0-8 档案目录、4 个 cmd_*.md、4 个新测试文件、
              1 个 GBK 乱码文件 docs03-devroundscmd_p0-6.1.md）
```

⚠️ 这些改动是 **P0-6.1 与 P0-7 的产物**，**不是本轮 delta**。本轮 delta 见 `03-delivery.md` §一。
⚠️ 该乱码文件与本批次无关（P0-6.1 时期产生），已在 `03-delivery.md` §九 记录，**本轮不动它**。

### 1.3 P0-7 自动门禁与 reviewer 状态

- 五道门禁全绿（两轮：修复前 / 修复后），production `APP_BASE_URL` 全量 HTTP
  `1154 / pass 1154 / fail 0 / skipped 0`；
- reviewer 终轮 **BLOCKER = 0 / MAJOR = 0**（第二轮中提出的 m7 / m8 已修复）；
- P0-7 无 OPEN 决策；
- P0-7 遗留两条已登记、**本轮均不触碰**的条目：
  1. Companion 写接口无 HTTP 200 happy path（跨轮测试基建决策，见 P0-7 `03-delivery.md` §8.4）；
  2. `applyOrderServing` 的 `servingAt: order.servingAt ?? at` 语义待裁决（reviewer n1）——
     它只在「同一订单第二次进入 `serving`」时才可达，**P0-8 不产生 `serving → 非 serving` 的任何迁移**，
     因此本轮不可达；裁决时点仍在 P0-9（`serving → paid` 回池）。

---

## 二、OPEN 决策检查（batch §四.1）

**结论：本轮无未解决的 OPEN 决策，可以开始业务编码。**

逐项核对：

| 检查点 | 结论 | 依据 |
|---|---|---|
| 需求 / 技术设计是否冲突 | 无冲突 | BF-19A、EX-COMPLETE-05、`api-contract.md` §3.2、`database-schema.md` §T1 对自动通过的前置条件表述一致 |
| 是否存在实现必须依赖的 TBD | 无 | 五个路由、实体字段、默认值 10 分钟、冻结时点均已冻结（见 §三 映射表） |
| 是否必须自行发明产品决定 | 无（两处按现有语义推导，见 D5 / D6） | 阻塞判据复用仓库存量状态语义；配置上下限复用同一平台时长上下限 |
| 是否要扩展状态枚举 | **不扩展 `OrderStatus`** | `01-prompt.md` §零 明文禁止；`CompletionSubmission` 的子状态机由 §T1 冻结 |
| 是否有第二套 Order / Refund / Notification / PlatformConfig / Auth | 无，且本轮不新建 | 平台配置扩展进现有 `PlatformConfig`（§三 表 R4） |
| 是否需要跨轮的「已完成」边界 | 不需要 | 本轮是 P0-9 的**前置**，P0-9 未完成前不声称批次完成 |

---

## 三、原文 → 落点映射表

| # | 需求 / 技术设计原文出处 | 原文要求 | 本轮落点 |
|---|---|---|---|
| R1 | BF-18 | `serving` + 当前 actualCompanion 才能提交；截图 + 5～50 字说明 | `lib/data/completionTransaction.ts` 的同步原子区段 Guard；5～50 字在 `lib/constants/completions.ts` |
| R2 | BF-18 / §T1 | 同一订单最多 1 份 pending | 仓储的 `pendingSubmissionIdByOrder` 索引 + 原子区段内先查后写 |
| R3 | BF-18 | rejected 后可重提，**不覆盖旧审核历史** | 每次提交**新建**一条 `CompletionSubmission`（旧记录保持原状，永不改写） |
| R4 | BF-18 / §3.4 / §T1 | 自动审核默认 10 分钟、后台可配置、提交时冻结 snapshot/deadline | `PlatformConfig.completionAutoApprovalMinutes`（默认 10）+ submission 上的 `autoApprovalMinutesSnapshot` / `autoApprovalDeadlineAt` |
| R5 | EX-CONFIG-06 / §T1 | 改配置不追溯已 pending；重提重新读配置并重新计时 | 快照只在**创建 submission 时**读一次；重提 = 新建 submission，自然重读 |
| R6 | BF-19 / §3.2 | staff approve → submission `approved` + Order `completed` + `completedAt = at` | `completionTransaction.ts` 的 `approveCompletion()` 同步写入器 |
| R7 | BF-20 / §3.2 | staff reject → submission `rejected`，Order 仍 `serving`；必填驳回原因、审核人、审核时间 | `rejectCompletion()`；驳回原因复用既有必填校验约定 |
| R8 | BF-19A / EX-COMPLETE-05 / §3.2 | 到期 + 仍 pending + Order 仍 serving + 未被人工处理 + 无投诉 / 有效售后阻塞 → System 自动通过 | `sweepCompletionAutoApprovals(at)`（同步、可测试、幂等） |
| R9 | EF-19A / §T1 | 来源必须记为 System，**不得伪装成 staff** | `reviewSource = "system"`，且 `reviewedByStaffId = null`（§T1 明文） |
| R10 | §3.2 | 人工 / 自动 / 驳回 / 失效之间并发安全，先成功的一方决定事实 | 全部写在同一段**无 `await`** 的同步区段内，且以**状态本身**为判据（与 P0-5 / P0-7 同一机制） |
| R11 | `01-prompt.md` §零 / §七 | `completion_review` 只是派生阶段，**不得**进 `OrderStatus` | 不新增枚举值；派生展示在 DTO 层计算（source-text 门禁保护） |
| R12 | `01-prompt.md` §二 | 证明材料复用现有 evidence 约定 | 复用 `lib/constants/evidence.ts` 的 `parseEvidenceInput()` / `toStoredEvidence()`；存储形态见 D4 |
| R13 | `01-prompt.md` §九 | 客服 UI 复用现有工作台结构，最小增量 | 新增 `/staff/completions`（列表 + 详情两个页面），复用 staff 壳层 / auth / DTO 组织 |
| R14 | `01-prompt.md` §十二 | 不得实现 Earning | 不建 `Earning` 实体、不建收益仓储、不写任何收益字段 |
| R15 | §3.5 / §T1 | 封禁回池时的 pending 作废 | **本轮不实现封禁动作**；`invalidated` 状态与 `invalidatedAt` 字段仅保留兼容（见 D3） |

---

## 四、本轮执行口径（决策）

### Decision V1

Status: **CURRENT**
At: 2026-09-24

#### D1 —— 结论：本轮范围与 `01-prompt.md` 完全一致，无缩减、无扩张

`01-prompt.md` §二～§十一 的每一项都有落点（见 §三 映射表 R1–R15）。
§十二「明确不做」的十项**一项都不做**，包括最容易顺手做掉的 `Earning`
（`serving → completed` 之后紧接着就是 BF-21，`database-schema.md` §T2 连字段都写好了——
本轮**不建**该实体、不建收益仓储、不写任何收益字段）。

#### D2 —— `CompletionSubmission` 的存储形态用 `SupportEvidence[]`，不照搬 `evidenceNames: string[]`

`database-schema.md` §T1 给的草图字段是 `evidenceNames: string[]`，但同一节末尾明确写着：

> 字段名属于技术设计；若实现 Round 发现已有仓库命名更合适，可做等价命名调整，但不得改变上面的业务语义。

而 `01-prompt.md` §二 明确要求「证明材料的存储 / DTO 形式**优先复用仓库现有 evidence / image / URL 约定**」。

仓库现有约定是 `SupportEvidence`（`lib/types/evidence.ts`）：客户端只提交 `{ kind, name }`，
`id` 与 `url` 一律由**服务端**生成（`toStoredEvidence()`），`url` 恒为本地 Mock 占位图。
退款申请与投诉的凭证都存这个类型，Staff 页面已经能渲染它。

因此本轮存 **`evidence: SupportEvidence[]`**：

- 满足 §T1 的「等价命名调整」许可；
- 满足 `01-prompt.md` §二 的复用要求；
- 不引入新基础设施，且客服审核页能直接复用既有的凭证展示组件；
- **业务语义不变**：客户端仍然无法注入外链或本地路径（`url` 由服务端写死）。

`evidenceNames: string[]` 被取代，**不是**被并行实现。

#### D3 —— `invalidated` 保留在类型里，但本轮**没有任何写入路径**

`01-prompt.md` §三 原文：「如果最新技术设计已定义 `invalidated` 等额外状态 / 字段，
**可保留兼容**，但 P0-8 不实现封禁动作。」

`database-schema.md` §T1 已定义 `invalidated` 与 `invalidatedAt`。因此：

- `CompletionSubmissionStatus` 含 `"invalidated"`；
- `CompletionSubmission` 含 `invalidatedAt: string | null`；
- 本轮产出的每一份 submission 的 `invalidatedAt` **恒为 `null`**，状态**永不**是 `invalidated`；
- 自动审核的判据是 `status === "pending"`（**白名单**，不是「非终态」）——
  这样即使将来有人手工往存储里塞一条 `invalidated`，它也不会被自动通过。

⚠️ 这与 batch §十一「不得擅自扩展状态枚举」不冲突：该枚举由 §T1 冻结，本轮只是**承接**。
`OrderStatus` **一个字都没有改**（D8）。

#### D4 —— 自动通过的「投诉 / 有效售后阻塞」判据：复用仓库存量语义，不新造

`01-prompt.md` §六 原文：「阻塞语义**必须服从最新需求和现有 Complaint / Refund 状态语义，不自行发明**。」

因此两条判据都从既有常量推导，不新增任何状态概念：

**（一）有效售后阻塞** = 该订单存在**进行中**的退款申请：

```
isActiveRefundStatus(refund?.status)      // lib/constants/refunds.ts
ACTIVE_REFUND_STATUSES = ["pending", "reviewing"]
```

这是仓库里**已经存在**的「进行中退款」定义（`REFUND_ALREADY_ACTIVE_MESSAGE` 用的就是它），
本轮**直接复用**，不另写一份「哪些退款算阻塞」的判断。

**（二）用户投诉** = 该订单存在**未完结**的投诉：

```
complaint.status ∈ { "pending", "processing" }        // 未完结
complaint.status ∈ { "resolved", "closed" }            // 完结（Complaint.handledAt 非 null）
```

依据是 `lib/types/complaint.ts` 自己的字段注释：「完结时间：已处理（`resolved`）与已关闭（`closed`）
都记在这里，**未完结时为 null**」——「是否还在处理中」这件事在仓库里已有唯一判据。

⚠️ **这是一处按现有语义推导的取舍，必须写清楚**：EX-COMPLETE-05 的原文是
「有投诉 / 售后时：不得自动通过，保持人工处理」，字面并未区分投诉是否已完结。
本轮取「未完结才算阻塞」，理由是 EX-COMPLAINT-03 的「投诉处理完成后再决定资金 / 聊天保留」
把**处理完成**当成事情已经决定的分界线；若一条已 `resolved` 的投诉永久阻塞自动审核，
则「保持人工处理」会退化成「此单永不自动通过」，与 §T1「到 deadline 后自动通过」
这条已确认规则互相取消。

**该取舍已列入 `04-acceptance.md` 的人工验收清单，请产品负责人明确确认。**
若产品认为「只要本单历史上出现过投诉就永久转人工」，改动点只有一处纯函数
（`isCompletionAutoApprovalBlocked()`），不涉及数据结构与落点。

#### D5 —— 配置上下限复用同一个「平台时长」上下限，**不发明新数字**

需求侧只冻结了**默认值 10 分钟**，没有给上下限（`01-prompt.md` §四 也只写默认值与可配置）。
但配置项必须校验：接受 `0` / 负数会让材料提交的同一瞬间就自动通过，
接受一个手滑多打一位的数会让订单静默挂上很久。

本轮的处理：**复用 `PlatformConfig` 里已有的平台时长上下限**（`1 ~ 1440` 分钟）：

```
COMPLETION_AUTO_APPROVAL_MIN_MINUTES = PUBLIC_POOL_TIMEOUT_MIN_MINUTES  // 1
COMPLETION_AUTO_APPROVAL_MAX_MINUTES = PUBLIC_POOL_TIMEOUT_MAX_MINUTES  // 1440
```

理由：这两项是**同一个配置实体上的同类量**（整数分钟、都按 snapshot 冻结、
都由同一位管理员在同一个页面改），分别定义一套上下限只会出现
「两个数字慢慢分叉」而无人察觉的情况——`lib/constants/platformConfig.ts` 顶部的注释
已经把「上下限只能有一处定义」写成本仓库的规则。

⚠️ 默认值 10 **落在该区间内**，因此这个复用不与任何已确认规则冲突。
⚠️ 若产品对自动审核另有量级要求（例如上界应远小于 1440），改动点同样只有常量层一处。
**已列入人工验收清单。**

#### D6 —— 本轮**不新增任何产品通知**

依据与 P0-7 的 D6 同一条：**需求 / 技术设计都没有冻结「完成材料提交 / 审核通过 / 驳回」的
生命周期通知**——`docs/01-requirements/` 里关于通知的补充确认（2026-09-23）只提到了
`accepted` 主动取消要通知用户、`accepted` 退款要通知打手，两者都属于 P0-6.1 / P0-9；
`api-contract.md` §3.2 的五条约束里也没有提通知。

因此本轮**不写任何 `Notification` 记录**——包括「审核通过」「被驳回」这两件最容易被顺手加上去的事。
自动审核与人工审核产生的是**同一种业务事实**（BF-19A 明文），本轮的职责是把事实写对，
通知是下一轮的独立增量。

#### D7 —— 自动审核的清扫入口沿用 `sweepExpiredDispatches` 的既有形态

`01-prompt.md` §六 要求「提供**可测试的** `sweepCompletionAutoApprovals(at)` 或等价服务」，
§十二 要求不做真 Scheduler。仓库里已经有一个完全同形的先例：
`sweepExpiredDispatches(at)`（`lib/data/companionDispatchTransaction.ts`），它的既有约定是：

- **同步**函数（因此可以在原子区段里被调用，也不需要 `await`）；
- 由**读取路径**调用（`lib/services/orders.ts`、`companionDispatch.ts`、`adminOrders.ts`），
  模块注释明确写着「业务事实由 deadline 决定，**不由「有没有运行 sweep」决定**」；
- 真实调度器上线后调用**同一个**函数，不另写一套。

本轮**照搬这一形态**：`sweepCompletionAutoApprovals(at)` 同样是同步函数，
挂在**同一批读取路径**上（用户订单读、打手订单读、管理端订单读、客服完成材料读），
不新建 Scheduler、不新建定时任务、不新增基础设施。

#### D8 —— `OrderStatus` 一个字都不改

`01-prompt.md` §零 / §七 明文禁止把 `completion_review` 加入 `OrderStatus`。
本轮新增的 Order 迁移只有 `serving → completed` 一条，它落在**既有取值**之间。
「完成审核中」这一阶段由 DTO 层派生（`serving` + 存在 pending submission），
不进枚举——这也是 §T1 与 `architecture-rules.md` 的 TARGET 表共同要求的口径。
该约束由一条 source-text 门禁保护（`01-prompt.md` §十一 第 20 条）。

---

## 五、明确不做（与 `01-prompt.md` §十二 一一对应）

Earning · `frozen → available` · withdrawal · 部分退款冲正 · 封禁回池及 pending invalidation 动作 ·
客服换人 · `serving` 普通主动取消 · 真 Scheduler · DB / ORM · 新对象存储基础设施。

⚠️ 另外三条**本轮同样不做**，因为它们不属于「完成材料」这件事：

- `Order.complaintDeadlineAt` 的冻结（P0-9：BF-22，在进入 `completed` 时冻）；
- 用户端投诉入口的窗口校验（P0-9）；
- 分账比例的浏览器端暴露清理（已知技术债，与状态机无关）。

---

## 六、本轮不裁决的既有悬置项

| 悬置项 | 出处 | 本轮为何不裁决 | 裁决时点 |
|---|---|---|---|
| `applyOrderServing` 的 `servingAt: order.servingAt ?? at` | P0-7 reviewer n1 | 本轮不产生任何 `serving → 非 serving` 迁移，不可达 | P0-9 |
| Companion 写接口无 HTTP 200 happy path | P0-7 `03-delivery.md` §8.4 | 属跨轮测试基建，本轮照既有约定沿用 | 批次汇总 |
| `CLAUDE.md` 的测试计数过期 | P0-7 已知项 | 文档维护，与本轮无关 | 批次汇总 |

---

## 七、首轮 Reviewer 之后的补充决策（追加，不回改上文）

> `02-decisions.md` 是**追加式**文件。下面四条是**代码写完之后**、由只读 reviewer
> 首轮审查暴露出来的问题及其处置口径。上文 D1–D8 一律保持原样，不改写。

### D9 —— 自动审核的清扫必须挂在**两处**打手端读取路径（复核项 A）

**问题**：D7 明写清扫挂「用户订单读、打手订单读、管理端订单读、客服完成材料读」，
但落地时**打手端一处都没挂**——D7 的声明、`completionTransaction.ts:302-303` 的注释、
`04-acceptance.md` 的触发说明三处都说了，代码里却只有三份文件（`orders.ts` /
`adminOrders.ts` / `staffCompletions.ts`）。

**决策**：挂**列表 + 详情两处**，不是只挂详情。
理由是 `CompanionOrderListItem` 自己带 `status` / `statusLabel`——
**列表卡片上的订单状态同样会过期**；只挂详情会让打手在列表里看到一张已经
`completed` 的单仍显示为 `serving`。这与「列表是纯只读所以不用物化」的直觉相反：
**是否物化取决于这一层展示不展示会过期的事实，而不是取决于它写不写库**。

**保护**：门禁 23 用**集合相等**把四条读取路径钉死（漏挂、多挂都红）。

### D10 —— 结构校验与领域 Guard **并列存在**，且结构校验在前（复核项 B）

**问题**：`approveCompletion` 只写了领域 Guard `order.status !== "serving"`，
**没有**走中央状态机 `canTransitionOrder`，与「`OrderStatus` 迁移的唯一真值源是
`ORDER_TRANSITIONS`」冲突（P0-7 的 `startCompanionOrder` 是两者的标准形态）。

**决策**：在**重放判定之后**、领域 Guard **之前**插入
`if (!canTransitionOrder(order.status, "completed")) return { kind: "order-not-serving", ... }`。

- **必须在重放判定之后**：否则合法的重复点击（submission 已 approved）会被结构校验判成失败，
  与 D3「状态自身即幂等判据」冲突。
- **与领域 Guard 并列，不二选一**：今天两者**严格等价**（已核实 `ORDER_TRANSITIONS` 里
  能到 `completed` 的状态**只有 `serving`**，且表里无自环），但只留领域 Guard 时，
  一旦状态表变宽/变窄就会**静默漂移**；只留结构校验则会把「表允许」误当成
  「这一单此刻就在起点上」。两句都留，各自的注释都写明自己回答的是哪个问题。
- **复用 `order-not-serving` 这个 kind**，不扩大联合类型（与 P0-7 两种失败共用
  `not-startable` 同一取舍）。

**保护**：门禁 22 断言「从中央状态机导入 + 真的调用 + 结构校验在领域 Guard 之前」，
顺序用 `indexOf` 相对位置——**挪到后面必然变红**。

### D11 —— 审核时间只写一次（复核项 M1）

`applyCompletionReview` 原先无条件写 `reviewedAt: input.at`，与本文件「不刷新时间」的注释
不符。改为 `reviewedAt: submission.reviewedAt ?? input.at`——与 `applyOrderCompletion` 的
`completedAt ?? at` **同一语义**。对**当前可达路径**（三个调用方传进来的都是 pending、
`reviewedAt` 必为 `null`）行为**完全不变**；改的是「注释与代码是否一致」这件事本身。

### D12 —— 平台参数说明必须覆盖**两个**参数（复核项 M2）

`PLATFORM_CONFIG_NOTICE` 原先只讲公共池超时。改为同时讲清两个参数**各自**的快照语义：
公共池超时只影响「此后进入公共池的订单」，完成材料时长只影响「此后提交的完成材料」。
这正是客服回答「为什么这张单还是 1 分钟」时要用到的那句话。

### D13 —— 测试文件里的 4 个 lint 警告清零

第一轮门禁的 lint 是 `0 error / 4 warning`（两个新测试文件里的无用局部变量）。
`pnpm lint` 退出码是 0、并不违反 batch §四，但**警告留在交付物里没有价值**，
故由协调者本人清掉（去掉未使用的解构绑定；**其中一处保留了对 `pendingSubmission(6)` 的调用**
——它是列表用例的干扰项，必须真的存在，只是用例不引用其返回值）。
**没有放宽任何断言**，清理后 `pnpm test` 仍是 1221 用例 / fail 0。
