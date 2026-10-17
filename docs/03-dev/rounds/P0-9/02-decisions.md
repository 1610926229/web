# P0-9 — Requirement Check 与执行口径

Round: P0-9
Recorded At: 2026-09-24
**本轮结论：停在 `CLARIFYING`，不进入 `READY`，不写任何业务代码。**

---

## 一、执行前确认（`01-prompt.md` §一）

### 1.1 已读文档

`docs/03-dev/rounds/P0-9/01-prompt.md`（逐字，243 行）· `docs/01-requirements/` 三份 ·
`docs/02-tech-design/` 五份 · `docs/03-dev/total需求进度表` · `docs/03-dev/development-workflow.md` ·
P0-7 / P0-8 的 Round 档案 · 相关现有代码与测试。

### 1.2 工作区 baseline（本轮开始前，**不含本轮改动**）

```
HEAD = 249f7c1adefc2c9d9e7f37bb26adde0bc45808df
tracked 改动 = 35 files changed, 1628 insertions(+), 191 deletions(-)
untracked    = 51 项
```

该 baseline 是 **P0-6.1 + P0-7 + P0-8 三轮的累计产物**（批次前三站），
明细见各自 `03-delivery.md` 的 delta 节。⚠️ 因为 batch §十二 禁止一切 Git 写操作，
三轮**都没有提交**，所以它们的改动同时躺在同一个工作区里——本轮**先报告**这一点
（`development-workflow.md` 第 670 行要求「有未提交内容先报告，不要偷偷吸收到下一批」），
**不把前三轮的改动算作本轮 delta**。

### 1.3 P0-8 自动门禁与 reviewer 状态

P0-8 已跑完全部门禁并**最终复核 BLOCKER=0 / MAJOR=0**（`pnpm test` 1222 用例 / fail 0，
生产 `APP_BASE_URL` 模式 1222/1222 / fail 0 / **skipped 0**，typegen / tsc / lint / build 皆 exit 0），
停在 `AWAITING_ACCEPTANCE`。P0-9 的前置**能力**确实存在。

---

## 二、Requirement Check（12 项）

| # | 检查项 | 明确了吗？ | 依据 / 缺口 |
|---|---|---|---|
| 1 | 产品规则是否完整 | **否** | 见 `Q1`——投诉窗口的**默认值**无定义 |
| 2 | 前置状态是否明确 | ✅ | 前置是 `Order.status === "completed"`；两个合法完成来源（staff approve / System auto approve）已由 P0-8 落地 |
| 3 | 成功状态是否明确 | ✅ | `Earning.status: frozen → available`；`complaintDeadlineAt = completedAt + snapshot` |
| 4 | 失败状态是否明确 | ✅ | 有阻塞继续 `frozen`；阻塞解除后下一次 sweep 可释放（仍需满足 deadline）；重复 sweep 幂等 |
| 5 | 权限是否明确 | ✅ | 用户端投诉只对自己的订单；打手端「我的收益」只看自己（`01-prompt.md` §九）；管理端配置沿用现有 admin 权限 |
| 6 | 金额是否明确 | ✅ | **直接取 `Order.companionBaseIncome` 快照**；禁止重查商品价 / 分账比例 / 因优惠券重算 / 客户端重算；保持整数分 |
| 7 | 幂等是否明确 | ✅ | 「一个 order → 一条有效 Earning」；重复请求 / sweep 不重复入账；`availableAt` 不重复刷新 |
| 8 | 并发是否明确 | ✅ | 两条完成来源共用同一约束；伪事务原子区段不得 `await` |
| 9 | 通知是否明确 | ✅ | `01-prompt.md` **未要求任何通知**；沿用 P0-8 的 D6 口径，本轮不新增产品通知 |
| 10 | 是否存在 `TBD — DO NOT INVENT` | **⚠️ 是** | `cmd_p0-9.md` §二：「如果最新权威 requirements / tech-design 已定义当前 Mock 默认值，严格使用；**如果没有定义默认值，不得自行拍值，进入 CLARIFYING**」→ 见 `Q1` |
| 11 | 与现有架构规范是否冲突 | ✅ | 复用 `PlatformConfig`（不新建第二套配置域）、Earning **不进 `OrderStatus`**、沿用 lazy sweep（不接 Scheduler）、复用现有投诉/退款模块 |
| 12 | 是否与已有业务代码事实冲突 | ✅ | `Earning` 在仓库中**尚不存在**（`grep` 确认），本轮为新建；`complaintDeadlineAt` 在代码里只有一处 **P0-9 的 TODO 注释**（`lib/data/mockPaymentRepository.ts:370`），**没有任何既有实现** |

**结论：第 1 项与第 10 项不通过。存在一个真正的阻塞问题，进入 `CLARIFYING`。**

---

## 三、阻塞问题

## Q1

> 🟢 **本节已由产品负责人裁定（2026-09-24）。回答见下方 §八。**
> 以下为**提问当时**的内容，按「追加历史、不覆盖历史」原样保留。

Status: OPEN

### Claude Question

**「投诉窗口」的 Mock 默认值取多少？单位与上下限是什么？**

具体需要三个数：
1. **默认值**——后台可配置，但种子/初值必须有一个数（相当于 `completionAutoApprovalMinutes`
   的「默认 10 分钟」那个位置）；
2. **单位**——字段名是 `complaintWindowMinutes`（`database-schema.md:710`
   `complaintWindowMinutesSnapshot: number | null`），即**分钟**。请确认按分钟配置，
   还是希望后台按**小时 / 天**呈现（存储仍为分钟）；
3. **上下限**——`completionAutoApprovalMinutes` 复用了平台时长的 `1~1440` 分钟。
   投诉窗口如果也是「几天」的量级，`1440`（= 1 天）就明显偏小，故上下限需要单独确认。

### Why This Is Blocking

这个数字**直接决定业务结果**，不是实现细节：

- 它决定**用户在多长时间内还能对自己的已完成订单发起普通投诉**（`01-prompt.md` §六：
  deadline 前允许、deadline 后关闭）——即售后权利的窗口长度；
- 它决定**打手的冻结收益多久能变成可提现**（`Earning.frozen → available` 消费的正是这个
  `complaintDeadlineAt`）——即打手的资金到账时点；
- 它是**冻结进每一张订单的快照**（`complaintWindowSnapshot`），
  后台改配置**不追溯**历史订单，所以第一批写进种子的那个数字，会成为此后所有 completed
  订单的既定事实，**改起来要动数据**。

三个合理方案（例如 24 小时 / 48 小时 / 7 天）都说得通，且给出的业务结果完全不同。
按 `development-workflow.md` §九 的判定标准——「仍存在两个或以上合理方案，并且不同方案会
改变业务结果 / 资金」——这是**真正的阻塞问题**。

### Affected Areas

- **文件 / 模块**：`lib/constants/platformConfig.ts`（新参数与边界）、
  `lib/mocks/fixtures/platformConfigSeed.ts`（种子初值）、
  `lib/types/platformConfig.ts`、`lib/data/adminPlatformConfigTransaction.ts`、
  `lib/types/earning.ts`（新建）、`lib/data/earningTransaction.ts`（新建）、
  `lib/data/mockEarningRepository.ts`（新建）、`lib/services/`（收益读 / 平台配置）、
  `components/admin/AdminPlatformConfigConsole.tsx`（第二个新输入项）
- **状态机**：`Earning.frozen → available` 的**触发时点**由这个数字决定
- **API**：`api-contract.md` §3.4 的 `complaintWindowMinutes`（默认值栏位将新增）、§3.7（Earning）
- **UI**：管理端平台参数页（默认值与单位文案）；用户端投诉入口的开放/关闭提示
- **测试**：`01-prompt.md` §十二 的 24 条要求中，第 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 15 / 22 条
  都以这个数字为构造前提（第 22 条更是逐字要求「不出现固定 48h 的业务硬编码」）

### Known Facts

**已经从需求、技术设计、代码确认过的事实**（用户不需要重新验证这些）：

1. **权威文档里没有任何一处给出投诉窗口的默认值。** 逐条查证：

   | 来源 | 原文 | 有默认值吗 |
   |---|---|---|
   | `cmd_p0-9.md` §二（`:37`） | 「如果最新权威 requirements / tech-design 已定义当前 Mock 默认值，严格使用；**如果没有定义默认值，不得自行拍值，进入 CLARIFYING**」 | —— 本条即判据 |
   | `超哥电竞_业务流程表.md` BF-22（`:693-722`） | 「投诉窗口时长来自后台平台配置，**不再把“48 小时”写死为不可变规则**」 | **没有**——只说明 48h 不再是不可变规则，**没有**说默认值就是 48h |
   | `超哥电竞_特殊情况与异常处理表.md` EX-CONFIG-05（`:781-789`） | 五行：已 completed 订单 `complaintDeadlineAt` 不变 / 新 completed 订单用新配置 / Earning·Chat 以各自冻结 deadline 为准 / 审计 / 状态 | **没有** |
   | 同文件紧邻的 EX-CONFIG-06（`:793` 起） | **有一行 `\| 默认值 \| 10 分钟 \|`** | 对照项 |
   | `database-schema.md:520` | 「后续至少扩展：exclusive pool timeout、**CompletionSubmission 自动审核时长（默认 10 分钟）**、投诉窗口时长」 | **没有**——同一句里给了一项默认值、**投诉窗口这项刻意没给** |
   | `architecture-rules.md:278-280` 生命周期参数表 | 三行相邻：`exclusive Dispatch timeout` =「后台可配置」、`CompletionSubmission 自动审核` =「后台可配置，**默认 10 分钟**」、`completed 投诉窗口` =「后台可配置」 | **没有** |
   | `api-contract.md` §3.4（`:581`） | 只说「进入 completed 时冻结本单 snapshot/deadline」 | **没有** |

   **最硬的一条是 EX-CONFIG-05 与 EX-CONFIG-06 的对照**：同一份文件里紧邻的两节、
   表格形状相同、都由「管理员改配置而历史单据已在途」触发，唯一的结构差异就是
   EX-CONFIG-06 多了一行 `| 默认值 | 10 分钟 |`。
   **一行之差把「故意不写」和「漏写」区分开了——如果默认值是 48h，那里就是写 48h 的地方。**

2. **代码里也查不到任何可继承的现值。** `grep -rnE "\b48\b|windowMinutes|complaintWindow" lib/ app/ components/`
   只有两处无关命中（`lib/mocks/fixtures/staffSeed.ts:75` 的 `lastLoginAt: minutesAgo(60 * 48)`
   与 `components/common/EmptyState.tsx:35` 的 SVG `viewBox="0 0 48 48"`）。
   `complaintDeadlineAt` 在代码里**只出现一次**，是 `lib/data/mockPaymentRepository.ts:370`
   的一句 P0-9 TODO 注释。**即：既没有文档默认值，也没有「保持现有行为」这条退路。**

3. **「48 小时」这个数字在权威文档中的每一次出现，都是在说「不要再硬编码它」**，
   而不是在说「它就是默认值」：BF-22 `:701`「不再把'48 小时'写死」、
   同文件 `:779`「不再硬编码'48h'」、`api-contract.md:611`「不再硬编码 `completedAt + 48h`」、
   `database-schema.md:15` 把「固定 48h 结算」列为 **CURRENT/历史事实**、
   `:661`「而不是写死 completed + 48h」。因此**不能**把它当作默认值反推。

4. **`Earning` 实体的字段与语义已在技术设计中定义完毕**，本轮不需要发明模型：
   `database-schema.md` T2 给出
   `Earning { id, orderId, companionId, incomeAmount, status, frozenAt, availableAt, withdrawnAt, reversedAmount, fineAmount }`
   与 `EarningStatus = "frozen" | "available" | "withdrawn" | "reversed"`，
   并明确 `incomeAmount = Order.companionBaseIncome` 快照、
   `availableAt` **等于**本单 `complaintDeadlineAt`、
   `sweepMaturedEarnings()` **同步、幂等、可重复调用**、后台 Scheduler 必须复用它。
   `01-prompt.md` §四 也要求「字段命名以最新 `database-schema.md` 为准，不另造平行模型」。

5. **`01-prompt.md` 已自行给出落点**的地方（不需要用户决定）：
   §九 明确「如技术设计已给具体 route/page，按其实现；**否则选择最小一致落点**」；
   §十 明确「复用现有 admin platform config service/repository/audit，不新建第二套配置表」。

### Remaining Decision

**只需要一个答案：投诉窗口的默认值取多少（以及单位与上下限是否与自动审核时长一致）。**

如果希望省事，最简回答形如：

> 「投诉窗口默认 **X 小时**（存 `X*60` 分钟），上下限 A～B 分钟。」

⚠️ 也可以直接答「沿用 48 小时作为**可配置的**默认值」——但请注意这与
BF-22 的措辞有张力：需求只说了 48h 不再是**不可变规则**，没有说它是默认值。
所以**这条必须由产品明确说出口**，不能由实现者替它认领。

---

## 四、本轮**已自查**、因此**不提问**的事项（避免浪费产品时间）

按 `development-workflow.md` §八「什么必须自己解决」，下列事项已由代码 / 技术设计回答，
**不作为问题提出**：

| 事项 | 自查结论 |
|---|---|
| `Earning` 的字段与状态取值 | 技术设计 T2 已定义，照抄，不另造平行模型 |
| `incomeAmount` 的取值 | = `Order.companionBaseIncome` 快照，禁止重算 |
| 「我的收益」的落点（route / page） | 按 `01-prompt.md` §九「选择最小一致落点」，复用打手工作台；**属技术组织问题，自行决定** |
| 投诉窗口配置放哪儿 | 现有 `PlatformConfig`，不新建第二套配置表（`01-prompt.md` §十） |
| 释放机制 | `sweepMaturedEarnings(at)`，同步 + 幂等 + 挂在读取路径上惰性物化（与 `sweepExpiredDispatches` / `sweepCompletionAutoApprovals` 同形） |
| 是否接真实 Scheduler | 不接（`01-prompt.md` §七 / §十三） |
| 审计 | 复用现有平台配置审计，不新建 |
| 是否新增通知 | 不新增（`01-prompt.md` 未要求） |

---

## 五、继承自 P0-8 的**未决产品取舍**（本轮不重复提问，但会继承同一口径）

P0-8 的 `D4`：**已 `resolved` / `closed` 的投诉是否仍然阻塞自动审核？**
P0-8 取「**未完结**（`pending` / `processing`）才算阻塞」。

P0-9 的 `01-prompt.md` §七 要求「不存在 requirements 定义的有效投诉 / 售后 / 其它冻结原因」
才释放收益——**是与 D4 同一个口径问题**。为避免同一件事问两遍，
本轮**沿用 P0-8 的同一判据**（而且应当是**同一个纯函数**，不新写一份），
并在 P0-8 的 `04-acceptance.md` 与批次汇总里把它作为**一处**待产品确认项列出。
若产品在验收时改为「历史上出现过投诉就永久转人工」，改动点同样只有一处纯函数。

---

## 六、`01-prompt.md` 原文 → 落点映射（预填，待 `READY` 后开发时使用）

| `01-prompt.md` 章节 | 计划落点 |
|---|---|
| §二 投诉窗口配置 | `lib/constants/platformConfig.ts` · `lib/types/platformConfig.ts` · `lib/mocks/fixtures/platformConfigSeed.ts` · `lib/data/adminPlatformConfigTransaction.ts` |
| §三 统一完成事务 | P0-8 的 `lib/data/completionTransaction.ts` 的**两条**通过路径共用同一段「完成副作用」——改一处，不复制 |
| §四 / §五 Earning | 新建 `lib/types/earning.ts` · `lib/data/earningRepository.ts` + `mockEarningRepository.ts` · `lib/data/earningTransaction.ts` |
| §六 投诉窗口区间 | 现有投诉模块 + `lib/constants/`（单位与文案） |
| §七 释放 | `sweepMaturedEarnings(at)`（同步），挂读取路径 |
| §九 Companion 收益查看 | 复用打手工作台；**最小一致落点**（具体 route/page 开发时定） |
| §十 Admin 配置 | 现有 `lib/services/adminPlatformConfig.ts` + `components/admin/AdminPlatformConfigConsole.tsx` |
| §十一 原子性 | 伪事务「计划 → 提交」两段，原子区段内无 `await` |
| §十二 测试 | 24 条要求逐条对应（其中 10 条以上依赖 `Q1` 的答案） |

---

## 七、承接自 P0-7 / P0-8 的**未裁定事项**（`Status: DEFERRED`，**不是本轮的阻塞项**）

P0-7 的 reviewer `n1` 明文要求「**必须带进 batch 汇总：请在 P0-9 的 `02-decisions.md` 里显式裁定**」，
P0-8 的 `03-delivery.md` §8.2(a) 又写「**必须在 P0-9 前 / 中裁决的两件事**」。
两处都指向本文件，因此在此登记。**它们都不在 P0-9 的范围里**（`01-prompt.md` §十三 明确排除
「封禁回池」与 Earning 的作废路径），所以：

- **不构成本轮的阻塞**——本轮本来就因为 `Q1` 停在 `CLARIFYING`，且这两件事都不会被本轮实现；
- **也不是可以忘掉的**——**任何未来实现对应迁移的轮次，开工前必须先把它们变成 `Status: OPEN` 并向产品提问**。

### D14（DEFERRED）— `servingAt` 在「换人 / 回池后重新开始服务」时该保留还是改写

**来源**：`P0-7/03-delivery.md` §8.5 的 reviewer `n1`（被称为「最重要的一条」）。

**现状**：`applyOrderServing` 写的是 `servingAt: order.servingAt ?? at`。

**触发链**（P0-7 已写明）：P0-9 或之后的轮次实现 `serving → paid`（封禁 / 合法换人回池）时，
若复用 `applyOrderAcceptanceReleased`（该写入器**不清 `servingAt`**）→ 订单回 `paid` 但 `servingAt` 残留
→ 新打手接单 → 点「开始服务」→ `??` 命中 → **上一任打手的开始时间成了这一单的开始时间**。

**两种方案**（各自都说得通，因此不能由实现者私自选）：
1. **保留最早时刻**（今天 `??` 的写法）：`servingAt` = 本单**第一次**开始服务的时刻；
2. **改写为本次 assignment 的时刻**：`servingAt` 表达「**当前这位**打手从何时开始服务」。

**为什么这不是实现细节**：它决定用户端时间轴与打手端「护航中」开始时间的显示口径，
也决定将来按「实际服务时长」做任何统计 / 结算时的基准。

**为什么现在不裁定**：`serving → paid` 今天**没有任何入口**（`ORDER_TRANSITIONS` 里有这条边，
但零调用），现在改写入器就是**替未来乱定规则**。P0-7 与 P0-8 都刻意未动。

**何时必须裁定**：**任何轮次准备给 `serving → paid` 接入口之前**。

### D15（DEFERRED）— `applyCompletionReview` 不可被「作废」路径复用

**来源**：`P0-8/03-delivery.md` §8.2(a) 第 2 条（reviewer 的 `N1` 隐患）。

**事实**：`applyCompletionReview` 只按 id 改状态，**不校验起始状态是否允许这次迁移**；
`pendingSubmissionIdByOrder` 索引也**只在它内部清除**。

**约束**（P0-8 已写入 `api-contract.md` §2.8 的 ⚠️）：未来的**作废**（`invalidated`）路径
**不得直接复用它**——作废需要一个**走中央状态机**、并**明确处理 pending 索引**的新入口。

**性质**：这是**技术约束**，不是产品问题——不需要产品做选择，只需在未来实现「封禁回池 →
作废 pending CompletionSubmission」时遵守。**因此本轮不提问**，仅登记。

---

**⚠️ 本轮到此停止。`Status = CLARIFYING`。等待产品回答 `Q1` 后才进入 `READY`。**

---
---

# 八、`Q1` 的人工裁定（2026-09-24，**产品负责人**）

**`Q1` 已关闭。`Status: RESOLVED`。本节是 CURRENT，取代 §三 的提问状态（提问内容原样保留）。**

## D16（CURRENT）— 投诉窗口的参数口径

| 项 | 裁定值 |
|---|---|
| **默认值** | **24 小时** |
| **存储 / 配置单位** | **分钟**（即默认值存为 **1440**） |
| **最小值** | **60** 分钟（1 小时） |
| **最大值** | **10080** 分钟（7 天） |

**规则（用户原文，逐条落地）**：

1. Order 进入 `completed` 时冻结 `complaintWindowMinutesSnapshot`；
2. `complaintDeadlineAt = completedAt + snapshot`；
3. **后续修改平台配置不得追溯影响已经 completed 的历史订单**；
4. **新完成订单使用新的配置值**。

**裁定来源**：2026-09-24 产品负责人书面裁定（原文见用户指令）。本节记录的是**产品决定**，
不是实现者的推断；提问时的证据链（§三 `Known Facts`）保留，用于解释「为什么当时必须问」。

**注意与 BF-22 的关系**：裁定值**恰好等于 24 小时**，而需求文档历史上写的「48 小时」是
**旧硬编码**、且文档只说过「不要再写死它」。因此**没有任何一处的默认值是靠 48h 反推出来的**——
这正是当时必须由产品明确说出口的原因。裁定落地后，
`EX-CONFIG-05` / `BF-22` / `architecture-rules.md` / `database-schema.md` / `api-contract.md §3.4`
五处已同步补齐默认值与取值范围。

## D17（CURRENT）— 取值范围沿用「共用上下限」还是独立？

**裁定**：投诉窗口有**自己的**上下限 `60 ~ 10080`，**不复用**平台时长那条 `1 ~ 1440`。

**理由**：`1 ~ 1440`（最多 1 天）是为「池子超时 / 自动审核」这类**分钟级**参数定的；
投诉窗口是**天级**的售后权利窗口，用同一个上界会让「7 天」这种正常取值无法配置。
两个参数各自持有自己的边界常量，**不互相 import**（避免将来改一个动另一个）。

## D18（CURRENT）— 单位在 UI 上怎么呈现

**裁定**：**存储与配置单位一律是分钟**，接口字段名保持 `complaintWindowMinutes`。
后台输入框按**分钟**呈现（与现有「完成材料自动审核时长（分钟）」同形），
**不引入小时 / 天的换算输入**——多一套换算就多一处四舍五入与显示不一致。

---

**`Q1` 关闭 ⇒ `CLARIFYING` 的最初阻塞项解除。本轮 Requirement Check 12 项现已全部通过，
`Status: CLARIFYING → READY → IN_PROGRESS`。**

---

# 九、开发期自查决策（**追加**，2026-09-24）

以下每条都是开发过程中**必须自己定、且不问产品**的实现取舍（判据：**不会改变业务结果**，
或权威文档已经给出唯一答案）。与 D16~D18 不同，这些是**实现者决定**，不是产品裁定。

## D19（CURRENT）— P0-9 之前 completed 的历史订单**不回填**

**决定**：`complaintWindowMinutesSnapshot` / `complaintDeadlineAt` 对旧订单保持 `null`，
**不补写**、也不为它们建 Earning。

**理由（两半，各自独立成立）**：

1. **补窗口 = 追溯**：旧订单没有「完成当时」的窗口值可用。用今天的配置补，直接违反 D16 第 3 条
   （不得追溯影响已完成订单）；用一个猜的值补，等于实现者发明一个产品数字。
2. **补 Earning = 凭空造钱**：旧订单的 `completedAt` 在过去，`completedAt + 1440 分钟`
   多半**已经到点**，于是补出来的收益在第一次 sweep 时立刻变成 `available`——
   那是一条「平台上从来没有过这笔负债、今天突然多出一笔可提现余额」的记录。

**判据的落点**：`isComplaintWindowClosed()` 对 `null` 返回 `false`，
即**旧订单与在途订单的投诉入口与本轮之前完全一致**，本轮不顺手收紧任何既有能力。

## D20（CURRENT）— 解冻 sweep 挂在**打手收益读取路径**上，且必须排在完成 sweep 之后

**决定**：`listCompanionEarnings()` 先 `sweepCompletionAutoApprovals()`、再 `sweepMaturedEarnings()`。

**理由**：Earning 是**完成**产生的。如果先扫解冻，一个「刚被自动通过、才生成收益」的订单
这一轮扫不到（收益还不存在），页面上会出现「订单已完成但收益没出现」的一拍。
两条 sweep 都幂等，因此顺序只影响**同一请求内能否立刻看到**，不影响最终一致性——
但「看得到」正是验收点在测的东西。

**不新增其它挂载点**：不为了「更及时」而在每个页面都挂一遍 sweep。
`Earning.frozen → available` 的权威触发时点由**本单 deadline** 决定，
读取路径只是恰好写下这个已经成立的事实（与 P0-1 / P0-8 同一条惰性物化机制）。

## D21（CURRENT）— 用户端投诉入口与接口**共用同一个纯函数**

**决定**：`OrderDetail.allowedActions.canSubmitComplaint` 由 `isComplaintWindowClosed()` 计算，
与 `createComplaintForUser()` 的写入门禁是**同一个函数**。

**理由**：若页面用一个判据、接口用另一个，就会出现「按钮还在、点了报错」的窗口期，
而那个窗口期的边界**取决于两个判据差在哪**——这种 bug 只能靠肉眼发现。
共用之后，`canSubmitComplaint` 从恒 `true` 变成一个会变的量，是**本轮唯一一处
用户端既有行为的变化**，已在 `03-delivery.md` 的 delta 里单列。

## D22（CURRENT）— 阻塞判据的数据读取抽成 `readOrderBlockingFacts()`

**决定**：`lib/data/orderBlocking.ts` 是「这一单有没有进行中的退款 / 未完结的投诉」的
**唯一读取处**；**判断**仍由 `isCompletionAutoApprovalBlocked()` 做（定义留在
`lib/constants/completions.ts`，grep 得到），P0-8 与 P0-9 共用这一对。

**理由**：P0-8 的自动通过与 P0-9 的收益解冻如果各读一遍，两份读取迟早不一致
（一处漏了「已关闭的投诉不算阻塞」这类修正）。**判据唯一**是「被投诉挡住却照样放款」
这类错误的唯一结构性防线，而它在页面上完全看不出来。

## D23（CURRENT）— 没有实际履约打手时**不建** Earning

**决定**：`settleOrderCompletion()` 在 `actualCompanionId` 为空时**如实不建记录**，
而不是建一条 `companionId: ""` / `incomeAmount: 0` 的占位。

**理由**：占位记录会在打手端变成一条**没有主人**的收益，而且在按 `companionId` 查询时
既不会出现在任何人名下、也不会消失——比缺失更难查。两条完成路径的领域 Guard
都已保证 `completed` 必有实际打手，因此这是防御性分支，不是正常路径。

## D24（CURRENT）— 平台配置新增字段的**编译期**完整性门禁

**决定**：`adminPlatformConfigTransaction.ts` 的 no-op 判定改成遍历
`PATCHABLE_FIELDS: Record<keyof PlatformConfigInput, true>`。

**理由**：原来的写法（逐个字段 `&&`）在新增第四个参数时**忘掉一处不会报错**，
而症状是「只改这个字段时接口返回『没有变化』、静默不写」——一个只在特定请求下出现的 bug。
改成 `Record<keyof ...>` 后，忘记登记字段直接 `tsc` 失败。这是本轮新增的模式，
后续平台参数一律照此办理。

---

## D25（CURRENT）— 投诉表单的订单选择器**本轮不改**（reviewer `m1` 的处置）

**问题**：`app/(mobile)/complaints/new/page.tsx` 的订单选项来自**全部**在售订单，
页面**不读** `isComplaintWindowClosed`。因此从「投诉专区」进来的用户可以先挑一张
窗口已关闭的已完成单、把 5~100 字描述与凭证都填完，提交时才拿到 400
`COMPLAINT_WINDOW_CLOSED_MESSAGE`——正是 D21 想避免的「页面还让填、接口已经拒绝」。

**决定**：**本轮不改，登记为独立待办。**

**理由**（两条，缺一不可）：

1. **最小修法要动 DTO**：`OrderListItem` 目前不带窗口信息，页面无从判断，只能在
   订单列表 DTO 上加一个服务端算好的布尔（与详情 DTO 的 `canSubmitComplaint` 同名同义）。
   那个 DTO 被用户端多处消费，且多个测试套件对 DTO 键集有断言——
   改动会外溢到与「收益 / 投诉窗口」无关的页面。
2. **P0-9 §八 明确划了边界**：「现有投诉/退款模块只做**必要最小联动**，不重构整个售后系统」。
   窗口门禁本身（接口层）已经是那条「必要最小联动」；再往页面选择器铺一层，
   属于把售后模块的交互一起重构，超出本轮范围。

**它是什么、不是什么**：**是一条真实的体验瑕疵，但不是资金或权限问题**——
规则出处仍只有 `isComplaintWindowClosed` 一处，接口层的拒绝是正确且已测试的。
因此按 §八 的边界留在原地。

**将来做的时候的口径**：把窗口字段加到订单列表 DTO 上（服务端算、页面只读），
**不要**在页面里重算规则——那会给同一条规则开第二个出处。

---

## D26（NOTE）— 完成后全额退款时 `Earning` 不会作废（reviewer `n1` 的处置）

**事实**：一张已经产生 `frozen` / `available` 收益的订单之后走退款流程，
它的 `Earning` 仍在原地——`sweepMaturedEarnings` 只在**进行中**的退款存在时挡一下，
退款一旦 `completed` 就不再是阻塞原因。

**决定**：**本轮不是缺陷**。`EX-REFUND-05` 属 ⏳（后续批次），
P0-9 §十三 也明文排除「部分退款冲正 / 已提现退款追偿」，因此本轮不实现、不发明规则。

**写在这里的唯一原因是给将来接手的人一条约束**：接这条迁移时**必须复用
`settleOrderCompletion` 的同一原子区段思路**（订单事实 + 收益事实在同一段同步代码里一起写），
**不要另起一条只改 `Earning` 的路径**——那会让「订单已退款」与「打手的钱还在」变成
两个可以不一致的真值源，而 P0-9 花了最大力气保住的就是「资金事实只有一条生成路径」。

