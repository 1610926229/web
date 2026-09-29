# P0-15 Decisions

> **本文件的两类内容必须分清：**
> - **§二（Q1–Q4）**：**真正的阻塞问题**，已由产品负责人裁定。
> - **§三（D5–D19）**：**不满足「两个以上合理方案且改变业务结果」的技术裁定**，
>   由 Claude 按协议 §八 自行决定并**登记在此**，供产品负责人否决。
>   **它们不是产品决策，不占用产品负责人的时间**；若其中任何一条你认为改变了业务结果，
>   请直接指出，我会转成 Q 重新走流程。

---

# 一、Requirement Check（协议 §七 · 12 项）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 产品规则是否完整 | **是**。指令 ② 明确自称「补充并修正」，两者冲突处以 ② 为准 |
| 2 | 前置状态是否明确 | **是**。售后审批仅对 `serving` / `completed` 开放（EX-REFUND-07）；`paid` / `accepted` 只走免审批全额直退（P0-13 状态闸，`HEAD = c2c9360`） |
| 3 | 成功状态是否明确 | **是**。部分退款 → `Order.status` 不变；全额 → `refunded`；打手侧 `displayStatus = refunded` |
| 4 | 失败状态是否明确 | **是**。第二次申请 / 已执行后再退 → 服务端拒绝（§八） |
| 5 | 权限是否明确 | **是**。用户提交申请；管理员一次性核定；打手与客服只读 |
| 6 | 金额是否明确 | **是**。`refundAmount = floor(actualPaidAmount × rateBp / 10000)`；全额时等于 `actualPaidAmount` |
| 7 | 幂等是否明确 | **是**。§八 明写 approve 必须幂等 |
| 8 | 并发是否明确 | **是**。§八（唯一性落库）+ ②§六（释放原子区段） |
| 9 | 通知是否明确 | **未提及 → 本轮不动通知**（P0-13 已建的退款通知按场景分档保持不变） |
| 10 | 是否存在 `TBD — DO NOT INVENT` | **否**。原 `EX-WITHDRAW-03`（`:943-951`，❓ 完全未拍板、标注上线前 production blocker）**已被 ②§五 移出范围**，不再是 TBD |
| 11 | 与现有架构规范是否冲突 | **是，2 处**，需 `SUPERSEDED`：D17（已提现不冲回）· `earning.ts` Q2-c（部分冲回不改状态）。详见 §四 |
| 12 | 与已有业务代码事实冲突 | **是，3 处**：D10（拒绝后可再申请，有测试钉着）· 责任模型三分支 · P0-14 的 `refundFullRemaining`。详见 §四 |

**结论：无 `OPEN` 决策。Round Status = `READY`。**

---

# 二、真正的阻塞问题（已裁定）

## Q1 · 已提现收益（`EX-WITHDRAW-03`）怎么处理

Status: **RESOLVED**（**但裁定已被指令 ②§五 取代**，见下方 V2）

### Claude Question

指令 ①§三 说「不论比例，打手收益一律归零」。但 `EX-WITHDRAW-03`（收益已被打手提现）
在 `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md:943-951` 是 ❓完全未拍板、
且被标为**上线前 production blocker**；当前 D17 规则正相反（已提现不冲回，多出的由平台承担）。

### Why This Is Blocking

两种答案让**钱的方向相反**：打手承担 vs 平台承担。

### Known Facts

- `Earning.status = "withdrawn"` **当前没有任何写入路径**，不可达（`lib/types/earning.ts:97-98`：不做提现）。
- D17 实现于 `resolveFinalDecisionAmounts`（`lib/constants/refunds.ts:727-739`），
  被 `adminRefundTransaction.ts` 与 `adminRefunds.ts` 调用。
- 全库**不存在**钱包 / 负余额 / 应收台账实体。

### User Answer（第一次）

> 本批次仍不处理。维持 D17：已提现的收益不动、由平台承担。新规则的「一律归零」只对
> frozen / available 生效。withdrawn 目前无写入路径、不可达，这一档暂时观察不到；
> 继续挂 production blocker，等钱包域统一设计。

### Decision V1

维持 D17，`withdrawn` 档继续 DEFER。

Status: **SUPERSEDED**

### 指令 ② 带来的修正

> 注意：此前关于"withdrawn 后如何追偿"的讨论没有作为正式产品裁定发送，不要按该方向实现。
> ……
> 原因不是"withdrawn 后由谁承担"，而是：**正常业务设计应保证退款处理完成之前
> 收益根本不会进入可提现阶段。**

### Decision V2（CURRENT）

**问题本身被取消，而不是被回答。**

- **不设计** withdrawn recovery / negative balance / receivable ledger / future earning offset /
  对打手追偿 / 平台垫付后追债。本轮**不引入**钱包、负余额、追偿系统。
- `withdrawn` 的正确性质不是「一个需要决定谁承担的分支」，而是
  **普通退款流程下结构上不可达的一个状态**：订单进入 `completed` 后收益进 `frozen`，
  而退款只能发生在 `serving` / `completed`（即 `frozen` 期间或更早），
  因此**退款决策落地时收益必然还没到可提现**。
- 因此 **D17 的 `withdrawn` 分支整体废止**：不再存在「平台承担」这条语义。
  若未来要支持「结算完成、甚至已提现后仍由后台特殊强制退款」，
  **那是新的特殊财务业务，未来单独设计**，不混入当前退款流程。

Status: **RESOLVED**

---

## Q2 · 「提交过即封死」是否按字面执行

Status: **RESOLVED**

### Claude Question

指令 ①§一 说「用户提交退款申请后，不允许针对同一订单再次创建新的退款申请」。
这推翻了既有裁定 **D10**（「已拒绝 / 已撤销**不**消耗退款机会」，代码注释与测试都钉着）。

### Why This Is Blocking

它决定「管理员拒一次之后，用户此单还有没有退款渠道」——这是**用户救济**，
不是实现细节。

### Known Facts

- 当前唯一性**只挡进行中**：服务层 `lib/services/refunds.ts` 的 `createRefundForOrder`，
  仓库原子区段 `lib/data/mockRefundRepository.ts` 返回 `order_has_active_refund`。
- `rejected` / `cancelled` 之后**可以**再创建新申请，有测试钉着
  （`tests/refunds.test.mjs` 的「拒绝后可再次申请」「撤销后可再次申请」两条）。

### User Answer

> 是：提交过即封死，一次机会。

### Final Execution Rule

> **同一 `orderId` 只要存在过任意一条 `RefundRequest`（不论状态为
> `pending` / `reviewing` / `approved` / `rejected` / `cancelled`），
> 服务端永久拒绝创建新的 `RefundRequest`。**
>
> 判定必须在 **Repository 原子区段**内基于**全量**退款记录完成，
> 不得只看「进行中」的那几条、不得只在 UI 隐藏入口。

**D10 标记 `SUPERSEDED`。**

---

## Q3 · 打手侧「已退款」的持久性

Status: **RESOLVED**

### Claude Question

部分退款后 Companion 显示「已退款」，而 `Order.status` 仍是 `serving` / `completed`。
当**订单真实生命周期走完**之后，打手侧应显示什么？

### Why This Is Blocking

它决定打手在自己的工作台上**永久**看到什么，以及该展示是否随订单流转而变化。

### User Answer

> 永久显示「已退款」。

### Final Execution Rule

> **退款一旦执行，`CompanionOrderListItem.displayStatus` 恒为 `refunded`、
> `displayStatusLabel` 恒为「已退款」，且「本单收益 = ¥0」一并显示；
> 不再随 `Order.status` 的后续流转（如进入 `completed`）而变化。**
>
> `displayStatus` 是**派生字段**，由服务端从「该订单是否存在已执行的退款」算出，
> **不写回 `Order.status`**，也不新增 `OrderStatus` 取值。

---

## Q4 · `01-requirements` 里被覆盖的 ✅ 条目怎么处理

Status: **RESOLVED**

### Claude Question

本规则正式覆盖了 `docs/01-requirements/` 里 2026-09-25 **已确认（✅）** 的两条：
`EX-REFUND-03` 的责任认定（`platform` / `companion` / `shared`）与
`EX-REFUND-05` 的「允许同一 Earning 被**多次**退款冲减」。这两处 ✅ 条目怎么处理？

### Why This Is Blocking

协议 §十三 要求「同步长期需求文档」并「保留旧规则被 `SUPERSEDED` 的历史」，
但改写一份**已确认**的权威文档是产品负责人的动作，不是 Claude 的。

### User Answer

> 改写为已被覆盖，保留原确认痕迹。

### Final Execution Rule

> 把 `EX-REFUND-03` / `EX-REFUND-05` 的 ✅ 状态改为
> **「2026-09-25 确认，2026-09-28 被 `P0-15` 覆盖」**，
> 正文换成新规则，**原条款以引用形式保留**以便追溯。
>
> **历史 Round 文档（`rounds/P0-13/`、`rounds/P0-14/`、`BATCH_*.md`）只加批注、
> 不改写**——协议 §十九：Round 档案是追加历史，不覆盖历史。

---

## Q5 · 退款批准后 `Earning.status` 停在 `frozen` 还是进入 `reversed`

Status: **RESOLVED**（2026-09-28，本轮交付前最后一处规则级裁定）

### Claude Question

指令 ② 里有两处字面说法指向「状态保持 `frozen`」：

- §四：「因为正常退款发生在结算冻结阶段，所以处理对象应当仍是 `Earning.status = frozen`」
- §十(8)：「refund approved 时 Earning 仍 frozen」

而本轮 `D8` 把 §四 读成**前提**（退款作用在一笔冻结中的收益上，不是已提现的），
于是批准后状态进入 `reversed`。两种读法打手端看到的字不一样，且**行为后果不同**：
若字面保持 `frozen`，`isEarningMatured()` 会对这笔已经归零的收益返回 `true`，
清扫会把它写成 `available`——**直接违反 §十(10)**。

### Why This Is Blocking

它不是措辞问题，而是决定「一笔已被退款冲光的收益还能不能被释放」。
自裁会出两种可能都错的实现：字面照做而不加闸 ⇒ 违反 §十(10)；
按 D8 走 ⇒ 与指令字面不符。

### User Answer

> **维持 `frozen`，加一道净额闸（按字面读）。**

### Decision（CURRENT）

**`Earning.status` 在整笔冲销后写回 `frozen`，不进入 `reversed`；释放判据增加第三道闸。**

落地四处（一一对应，缺一条这个规则就是假的）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `lib/data/mockEarningRepository.ts` `applyEarningReversal` | 整笔冲完 ⇒ 状态写 `frozen`（覆盖 `frozen → frozen` 与 `available → frozen` 两种起点） |
| 2 | `lib/constants/earnings.ts` `isEarningFullyReversed()` | 净额闸的**唯一定义**：`reversedAmount >= incomeAmount` |
| 3 | `lib/data/earningTransaction.ts` `sweepMaturedEarnings` | 计划阶段 AND 上第三道判据 ⇒ 「到期 && !阻塞 && !已冲光」 |
| 4 | `lib/data/mockEarningRepository.ts` `applyEarningRelease` | 存储层同口径拒绝（§六：不得只依赖上层读到的旧状态） |

**连带的两处（同一裁定带出来的，不是新的决定）：**

- **打手端那一句话改按净额取**（`earningHintFor()`）：`frozen` 现在同时装着
  「到期就解冻」与「永远不解冻」两种，直接查 `EARNING_STATUS_HINTS` 会对后者说
  「到期自动转为可提现」——那是一句**假话**。
- **状态名与颜色仍只看状态**（`EARNING_STATUS_LABELS` / `_CLASS`）：同一个状态
  在两个组件里得到两种颜色，比一句略微保守的措辞更糟；「冻结中」在这个裁定下
  本来就是事实（这笔钱确实没有、也不会进入可提现阶段）。

### 被推翻的历史裁定

- **`D8`（本轮）**：见下，已标 `SUPERSEDED`。
- **`P0-13` Q2-c**：它当年说「部分冲回不改状态」，理由是「别让打手以为自己白干」。
  该理由的前提在新规则下反转（他确实白干了），而「部分冲回」这个情形本身
  已随责任模型消失。

---

# 三、Claude 自行裁定的技术点（登记，可被否决）

> 依据协议 §八：这些用代码就能回答、或两个方案的**业务结果相同**，只差实现形态。
> **登记在这里是让产品负责人有机会否决，不是征求同意。**

## D5 · `refundFullRemaining` 整体删除，「全额退款」= 100%

**决定**：删除 `refundFullRemaining` 这个意图，不留字段、不留兼容分支。
UI 上把「全额退款」作为一等选项，提交 `refundRatePercent = 100`。

**理由**：指令 ①§二 明写「可以将其收敛为：全额退款」；§九 明写要清理
「`refundFullRemaining` 用于『补最后一次余额』的设计」。
而 `floor(actualPaidAmount × 10000 / 10000) === actualPaidAmount` 恒成立，
所以「100%」与「退满剩余」在**单次退款**下是同一个金额，保留两个意图等于留两条真值路径。

**⚠️ 连带后果（重要）**：**P0-14 的修复本身被本轮取代。**
P0-14 的根因是「多步部分退款会留下 1–99 分尾差，任何整数百分比都表达不了」。
新规则下**每个订单只退一次**，`floor(实付 × 比例)` 一步到位，**尾差不存在**。
P0-14 的 `refundFullRemaining` 因此从「一等公民」变成死代码。
P0-14 的档案**不改写**，在 `04-acceptance.md` 加一条批注指向本轮。

## D6 · 部分退款后订单永不进入 `refunded`

**决定**：`isFullyRefunded` 的语义改为「**唯一那次退款就是全额退款**」，
即 `refundAmount === actualPaidAmount`（在只有一次退款的前提下等价于旧式
`alreadyRefundedAmount >= actualPaidAmount`）。**保留 `actualPaidAmount > 0` 守卫。**

**理由**：指令 ①§六 + ②§八 明写部分退款**不得**把订单推成 `refunded`。
P0-14 验收时把「累计 ≥ 实付 ⇒ 必须 `refunded`」当成不变量，
**那条不变量的前提（可多次退款）已被删除**，它也随之失效。

**说明**：这**不是**「订单卡住了」。剩余金额按 ①§四 归平台，是**预期的终态**。

## D7 · 退款发生在 Earning 生成之前时的归零方式

**决定**：退款可在 `serving` 期批准，此时 `Earning` 尚不存在。
`settleOrderCompletion()` 生成冻结收益时**一并**写入完整冲销，
且**恰好写一条** `EarningAdjustment`（关联那笔已批准的退款）。

**理由**：指令 ①§三 要求「`Earning.incomeAmount` 保留原始历史快照」
且「通过**一次** `EarningAdjustment` 将净收益归零」——
所以记录必须**生成**（不能因为净额为 0 就不建），且冲销明细**恰好一条**。
两种写法（生成时即冲 vs 生成后再冲）**金额结果完全相同**，取生成时一并写、
避免出现「暂时为全额可提现」的中间态。

## D8 · 退款成功后 `Earning.status = "reversed"`

> ⛔ **本条已被 §二 `Q5` 推翻**（2026-09-28 产品裁定）：
> 整笔冲销后状态**写回 `frozen`**，不进入 `reversed`；释放判据增加一道净额闸。
> **下面这段文字保留原样作为当时的技术判断痕迹，不得作为实现依据。**
> 它错在把指令 ②§四 读成了「前提」（退款作用在一笔冻结中的收益上），
> 而产品确认该句是**结果**：批准后状态就停在 `frozen`。

**决定**：整笔冲销后状态进入 `reversed`，`reversedAmount === incomeAmount`。

**理由**：新规则下**每一次**批准的退款都是整笔冲销，
`lib/types/earning.ts:53-56` 那句「部分冲回**不改变状态**——把部分冲回也写成 `reversed`
会让打手以为自己这一单白干了」的**前提被反转**：
现在打手**确实**这一单白干了。旧注释标 `SUPERSEDED`，新语义写进去。

## D9 · 「settlement block」不新建第三类实体

**决定**：②§三 列的「或当前已有的 settlement block」，其**当前所指**就是
`isCompletionAutoApprovalBlocked`（`lib/constants/completions.ts:152-157`）——
即 `hasActiveRefund || hasUnresolvedComplaint`。**本轮不新增第三类阻塞实体。**

**理由**：全库普查确认不存在 `AFTERSALES` / `settlementBlock` 实体；
「aftersales processing」就是进行中的 `RefundRequest`。
指令原文说的是「**当前已有的** settlement block」，与代码事实不冲突。
阻塞定义**保持单一真值源**，改动点仍在常量文件一处。

## D10 · 被拒绝的申请**不**阻塞结算

**决定**：阻塞判据继续只看**进行中**的退款（`isActiveRefundStatus`），
**不**因为「该订单存在过退款申请」就永久阻塞。

**理由**：①§八 只要求阻止**第二次退款**，没要求阻止结算；
把「存在过申请」当阻塞会让被拒一次的单**永远拿不到钱**，那是新规则没说的后果。

## D11 · 累计冲减相关代码按「不可达」处理

**决定**：`sumApprovedCompanionReversal`、`reversedSoFarAmount`、
`remainingRefundableAmount`、`backfillRefundReversals` 等只在「多次退款」下才有意义的
路径，逐条判定：**确已不可达的删除**（并在 `03-delivery.md` 列明），
**仍被历史数据读侧使用的保留并标 `@deprecated`**。

**理由**：①§九 要求「检查并删除/废弃」，同时允许「因历史兼容需要保留的明确标记 deprecated」。
`Earning.reversedAmount` 字段**保留**（它是「读用总数」的读侧真值源）。

## D12 · `EarningAdjustment.responsibility` 保留字段、新写入不再填

> ⛔ **本条已被同轮 `D18` 推翻**（2026-09-28，见下文 §三 D18）：
> 字段**整体删除**，不是「保留不填」。理由是本仓无真库、无历史持久化数据，
> 「历史明细要能读」这个前提不存在，留一个恒为 `null` 的字段只会误导读者。
> **下面这段文字保留原样，作为当时的判断痕迹，不得作为实现依据。**

**决定**：字段保留（历史明细要能读），新写路径写 `null` / 不填，
`responsibility` / `companionLiabilityRateBp` / `platformBorneAmount` /
`companionReversalAmount` 从**新**决策入参中移除。

**理由**：①§五 明写「历史数据中的旧责任字段……可以只读兼容，但新写路径不得继续依赖」。

## D13 · `complaintWindowMinutes` 已实现，本轮只做文档纠偏

**决定**：②§一 **不产生新实现**。

**事实**：该字段**已于 P0-9 落地**——`PlatformConfig.complaintWindowMinutes`
（默认 **1440** 分钟、取值 **60~10080**）、订单完成时冻结
`Order.complaintWindowMinutesSnapshot` 并算出 `Order.complaintDeadlineAt`，
唯一入口 `settleOrderCompletion()`；`Earning.availableAt` **直接复制**该 deadline，
不另算一次加法。「48 小时」当初已明确裁定为**可配置**而非默认值。

**遗留动作**：全库普查「固定两天」表述，**确认仅存于历史 plan 文档
（`docs/superpowers/plans/2026-09-17-order-lifecycle-alignment.md`）**，
属历史档案**不改写**；权威文档与代码里**无**硬编码残留，按 ②§九 补一句正面表述。

## D14 · 并发保护靠「单一原子区段」，不引入锁

**决定**：沿用既有 P0-9 形态——`sweepMaturedEarnings` 的
**计划（只读）/ 提交（写）两段之间无 `await`**，故「挑的时候没阻塞、写之前投诉才进来」
在结构上产生不出来。本轮**新增**的并发面（退款提交 vs 释放）同样落在**同一个原子区段**内
重读一次阻塞事实。**不引入锁 / 版本号 / 乐观并发控制。**

**理由**：与既有 `readOrderBlockingFacts` 的注释一致——真实 DB 阶段应在**同一条查询**
或同一事务内完成，Mock 阶段靠整段无 `await` 保证。本轮不改变这个架构约定。

---

## D15 · Companion 展示状态**从订单自己派生**，不查询退款域

**决定**：`resolveCompanionDisplayStatus(order)`（`lib/constants/orders.ts`）
= `order.refundedAmount > 0 ? "refunded" : order.status`。**纯函数、只吃订单快照。**

**理由**：判据的**唯一真值源**是 `Order.refundedAmount`——它由唯一的金额写入器
`applyOrderRefund` 维护，因此它**不可能**与退款域的第二份记录互相矛盾。
反过来（去 `listRefundsForOrder` 里找「有没有 `approved` 记录」）会让打手列表
每一行都多一次跨域查询，而且制造了**两个都能回答同一问题**的地方。
`0%` 退款在服务端被 `assertRefundAmountWithinPaid` 拒绝，因此
`> 0` 与「退过一次」在真实路径上**等价**。

**⚠️ 已知边界**：这是**派生展示**，不写回 `Order.status`、不新增 `OrderStatus` 取值
（与 Q3 的执行口径一致）。

## D16 · `netIncomeAmount` 的三段语义与界面的「不渲染」

**决定**：`CompanionOrderListItem` / `CompanionOrderDetail` 新增
`netIncomeAmount: number | null`，取值三段：

| 情形 | 值 | 理由 |
|---|---|---|
| 该订单**有** `Earning` | `incomeAmount − reversedAmount` | 直接读账，**不写断言**——数据万一异常，界面显示的是真相而不是一句「应该是 0」 |
| 无 `Earning` 但 `refundedAmount > 0` | `0` | 退款发生在结算之前（`serving` 期），收益永远不会生成 |
| 其余（在途 / 未结算 / 无退款） | `null` | 这一单还没到谈钱的阶段 |

**界面规则**：`null` 时**整段不渲染**（卡片与详情页一致）。
写上「本单收益 ¥0.00」会让一张**正在护航**的单看起来像已经退款了。

**⚠️ 登记原因**：这是本轮**唯一**给打手端 DTO 加的金额字段。`lib/types/order.ts`
头部原本写着「打手端 DTO 上没有金额」，本字段是**被显式记录的例外**，
理由与三段语义已写进该文件的头注释。

## D17 · 详情页的「履约状态」额外行**只在两者不同时**出现

**决定**：打手订单详情的大字显示 `displayStatusLabel`；当
`displayStatus !== status`（即部分退款）时，**多一行**「履约状态」显示真实的
`statusLabel`。全额退款时两者相同，**不显示这一行**。

**理由**：「已退款」回答的是「这一单的钱怎么了」，答不出「我还需不需要继续打」——
而后者恰恰是打手此刻要决定的事。两个都显示，各回答一个问题。
但两者相同时多一行重复的文字，只会让人去找那两个词之间的差别。

## D18 · **推翻 D12**：`EarningAdjustment.responsibility` 由「保留不填」改为**删除**

**决定**：`EarningAdjustment` **不含** `responsibility` 字段。

**理由**：D12 的原意是「历史数据要能读」——但本仓**没有数据库**，
mock store 每次重启即重置，**不存在需要只读兼容的历史数据**。
于是「保留一个永远写 `null` 的字段」失去了它唯一的理由，
剩下的只有坏处：下一个读代码的人会以为「还有别的责任分支没写出来」。
本轮同时把「责任」从 `RefundDecision`、请求体、界面删干净，**保持一个方向**。

**⚠️ 这是对 D12 的**推翻**，不是补充**：D12 写在 §三 的同一个清单里，此处显式点名。

## D19 · ②§六 的并发要求**零代码改动**，本轮只补测试

**决定**：`sweepMaturedEarnings`（`lib/data/earningTransaction.ts`）**不改**。

**核查结论**：②§六 要求「释放事务必须在**同一原子区段内、真正执行 `frozen → available`
之前**重新确认 deadline / 无有效退款 / 无有效投诉 / 无 settlement block，
不得依赖页面或服务层先前读到的状态」。既有实现**已经**是这个形态：
计划段（只读挑候选）与提交段（写）之间**没有 `await`**，提交段内**重读**
阻塞事实后才落笔。因此本轮的活是**补测试把它钉死**（②§十 第 11 项
「并发 settle-release 与 refund-submit 不得错误释放」），**不是重写**。

**⚠️ 边界**：这条保证在 Mock 阶段靠「整段无 `await`」成立；
真实 DB 阶段必须在**同一条查询 / 同一事务**里做（与 `readOrderBlockingFacts`
的既有注释同一条约定），本轮不改变该架构约定。

## D20 · 一单一退的判据是「**出过款**」，不是「**退满**」——执行侧三处补齐

> **来源**：交付前 `reviewer-agent` 只读审查的 **MAJOR-1**（CONFIRMED）。
> 本条是**修正**，不是新增业务规则：①§一 从一开始写的就是「最多**一次**实际退款执行」。

**决定**：新增单点判据

```ts
hasRefundBeenExecuted(order) === order.refundedAmount > 0   // lib/constants/refunds.ts
```

并在**三条出款路径 + 一个展示面**上使用它：

| 落点 | 原来 | 现在 |
|---|---|---|
| `applyOrderRefund` 短路（`lib/data/mockPaymentRepository.ts`） | `status === "refunded"` 或 `refundedAmount >= actualPaidAmount` | **加上** `hasRefundBeenExecuted` |
| `directRefundOrder` guard ③ | `refundedAmount >= actualPaidAmount` | `hasRefundBeenExecuted` |
| `sweepExpiredDispatches` 计划层 | 只看 `order.status !== "refunded"` 决定「要不要退、要不要通知」 | 用 `hasRefundBeenExecuted` 判，结论写进 `refundAmount: number \| null`（`null` = 只关池） |
| `buildRefundActions.canDirectRefund`（`lib/services/refunds.ts`） | 只看 `canDirectRefund(order.status)` | **加上** `&& !hasRefundBeenExecuted(order)` |

> ⚠️ **D21 随后升级了其中两处**：`applyOrderRefund` 短路与 `sweepExpiredDispatches`
> 计划层改用并集判据 `isRefundExecutionClosed`（因为那两处问的是「退款还能不能再发生」，
> 不只是「出过款吗」）。本表的其余部分不变。

**理由**：判据必须回答 ①§一 问的那件事。「退满」在**部分退款**上不成立，
因此它挡不住下面这条**真实可达**的路径（逐步核实过，不是假想）：

```
serving 单被批准部分退款（第 1 次出款；部分退款不改状态）
  → 客服 releaseOrderByStaff 把它退回公共池（P0-11，serving → paid）
  → 订单此刻是 paid ⇒ canDirectRefund("paid") 为真
  → 用户点「直接退款」/ 或公共池到点 ⇒ 第 2 次出款
```

**为什么不问产品**：四段逐字原文已经把答案写死了——
①§一「最多一次实际退款执行」「不得再次退款」；①§八「已经执行退款后,不允许再次退款……
Repository / transaction 层必须有硬约束」；①§九「清理……第二次退款」；
①§四「剩下的留在平台」是**正常结局**（因此挡住不是让用户损失）。
**没有一处需要产品补一个决定**，所以按协议 §八 登记为技术裁定。

**⚠️ 「计划层放行、存储层静默拒绝」是必须避免的形态**：
`applyOrderRefund` 会在存储层拒掉第二次出款，但如果调用方**不自己判一次**，
它的返回清单（`refundedOrderIds`）里仍会出现那个 id——调用方会以为退款成功了。
这与 D14/§3.3 探针 2 记录的是同一个坑，因此公共池那一步是**显式的 `null`**，
不是一个「写入层会兜住」的侥幸。

**⚠️ 连带生效**：`architecture-rules.md:192` 那句「`refundedAmount` 在任何真实路径上
只被写一次」**在本条修完之后才真正成立**。修之前它是一句愿望。

**⚠️ 与 P0-13 R3（「退剩余」）的关系**：P0-13 的 R3 要求「第二笔退的是剩余额」，
其前提（可多次退款）已被 ①§一 删除，R3 随之失效，其**等待追认**的事项在此**结案**。
`applyOrderRefund` 的「增量」形参与钳制**保留**（形式正确、零成本），
但一单一退下调用时 `refundedAmount` 恒为 `0`，加法不再被加第二次。

## D21 · 并集也升级成单点定义；计划层不再依赖「实付一定为正」

> **来源**：同一轮 `reviewer-agent` 审查的 **MINOR-1 / MINOR-2 / NOTE-2**。
> 两条 MINOR 都是注释与代码不一致（无行为缺陷），但**修法不是改注释**——
> 不一致暴露的是一个真实的定义缺口，见下。

### D21.1 `isRefundExecutionClosed`：并集有了自己的名字

**决定**：D20 之后「这一单的退款能不能再发生」= `status === "refunded" || hasRefundBeenExecuted(order)`，
而 D20 把它留在**四个调用点各写一遍**。新增第二个单点定义：

```ts
isRefundExecutionClosed(order) === order.status === "refunded" || hasRefundBeenExecuted(order)
```

调用点从此各自引用**该引用的那一个**，两个判据的分工是刻意的：

| 问题 | 判据 | 谁在用 |
|---|---|---|
| 这一单**出过款**吗（哪怕只退了一部分） | `hasRefundBeenExecuted`（窄） | `applyOrderRefund` 的调用方语境、`buildRefundActions`、`resolveOrderNetIncome` |
| 这一单的退款**还能不能再发生** | `isRefundExecutionClosed`（宽） | `applyOrderRefund` 短路、`directRefundOrder` guard ③、`sweepExpiredDispatches` 计划层 |

**为什么不合成一个**：窄答案必须能对「只退了 10% 的 `serving` 单」回答「是」，
而净额与展示面只要窄答案；宽答案多出的那一半（状态）只在**写入路径**上有意义。
合并会让「出过款吗」这个语义被状态污染。

**⚠️ 为什么宽答案是必须的**：计划层若只问窄问题，`status === "refunded"` 而
`refundedAmount === 0` 的订单会被判成「还欠一次退款」而**放行**——通知发出去、
id 落进 `refundedOrderIds`，存储层却静默拒绝出款。那正是 D20 自己点名的假账形态。
**用并集，两层问的是同一句话，缝就没了。**

**⚠️ `resolveCompanionDisplayStatus` 与 `isRefundExecutionClosed` 恒等**（同一并集，
一个返回状态、一个返回布尔）。`lib/constants/orders.ts` 那一处**仍然**内联写
`refundedAmount > 0`：该文件头部禁止任何运行时 `import`，不是漏改。
恒等关系由 `tests/refundOnePerOrder.test.mjs` 的矩阵用例**逐格**钉住。

**⚠️ 这条恒等是测试自己逼出来的**：矩阵用例最早断言的是「与窄判据恒等」，
第一次运行就在 `status === "refunded" && refundedAmount === 0` 那格红了。
处理方式不是放宽断言，而是承认两个问题的分工，并**把并集提升成单点定义**。

### D21.2 计划层加 `actualPaidAmount > 0`，不再押在上游不变式上

**决定**：`sweepExpiredDispatches` 的出款判据收成

```ts
const refundDue = !isRefundExecutionClosed(order) && order.actualPaidAmount > 0;
```

**理由**：实付为 0 的坏单子会算出 `refundAmount = 0`，而 `applyOrderRefund` 会以
`0 >= 0`（退满）静默拒掉——又一次「放行 + 拒绝」。今天到不了（下单链强制券抵为 0、
种子单价为正），**但计划层不该把正确性押在一条上游不变式上**。
不出款、不通知，池子照收。

**验证**：新增 `规则1（执行侧 4/4）`，直接构造 `unitPrice: 0` 的订单。
红绿证据——去掉 `&& order.actualPaidAmount > 0` 后**恰好一条**用例失败，
且失败的正是那句 `没退成就不许报成退过`（`actual: true, expected: false`）。

### D21.3 审查意见的处置（含「不上交产品」的登记）

| 意见 | 处置 |
|---|---|
| MINOR-1 注释声称调用点都写并集，而 `companionDispatchTransaction` 写的是替代式 | **按 D21.1 修代码**（升级为并集 + 单点定义），不是改注释 |
| MINOR-2 `adminDashboard.ts` 「同一订单可以有多条（部分退款不再是一次性）」在 P0-15 后为假 | 已改：改为「至多一条」，并说明遍历留着是守**本函数自己的口径**；同时修正我第一版改法里的一处新错误（见下） |
| NOTE 「部分退款后的订单仍可能进公共池超时」是否需要产品决定 | **不上交**。①§一/§八 已把「只出一次款」写死，`refundDue` 判据使结果正确，且关池仍然发生——这是**技术组织问题**，不是业务结果问题 |
| NOTE `ORDER_TRANSITIONS` 已实现（旧任务前提过时） | 已核对：`lib/constants/orders.ts:160-179` 确实已实现；`architecture-rules.md` 的差距表已在本轮修正 |
| NOTE ¥0 单的计划层/存储层落差 | **按 D21.2 修代码**并加用例，不留作已知风险 |

**⚠️ 记录一处我自己改错又改回的地方**：MINOR-2 的注释我第一次写成
「减法的第二个操作数总是 0」。核对 `computeTodayRefundAmount` 的函数体后
**不成立**——`refundedAt` 只在**退满**那一刻写，所以一张有 `refundedAt` 的单要么
`Σ = 实付`（售后链路退满，差额 0）要么 `Σ = 0`（无记录路径退满，差额为实付），
两种都是**整笔**，不是「总是 0」。注释已按实际语义重写。
**教训**：注释修正同样要回函数体核对，不能只在待改的那一行上做局部推理。
