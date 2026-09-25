# P0-13 — Requirement Check 与执行口径

Round ID: P0-13
**Round Status: `AWAITING_ACCEPTANCE`**（沿革：`CLARIFYING`（2026-09-25 建档）→ **`READY`**（2026-09-25 Q1/Q2 裁定，§十）→ `IN_PROGRESS`（开始编码）→ **`AWAITING_ACCEPTANCE`**（开发与门禁完成；只读审查后整改 B-1，见 §十一 D18））
本文件性质：§一–§九 是 **Requirement Check**（记录时点状态 `CLARIFYING`）；§十 起是**裁定后的实现决策**。
⚠️ §三 / §四 / §七 的**原始提问保持原样不被覆盖**（`development-workflow.md` §十二：追加，不覆盖）。

---

## 一、执行前确认

### 1.1 已读文档（本轮 Requirement Check 的全部依据）

| 文档 | 读法 |
|---|---|
| `docs/03-dev/rounds/cmd_p0-13.md`（76 行） | **全文逐字**。已存为 `01-prompt.md`（逐字节一致） |
| `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md:34-39` | P0-13 特别停止条件原文 |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` | `EX-REFUND-02/03/05/07/08`（`:562-655`）· `EX-WITHDRAW-01/02/03`（`:888-918`）· `:470` · `:1029` · `:1100` · 待确认清单 `:1063` |
| `docs/01-requirements/超哥电竞_业务流程表.md` | `BF-22A` 未确认清单（`:745-763`）· `:102` |
| `docs/01-requirements/超哥电竞_用户权限表.md` | `:149`（释放时机）· `:536` · `:574` · `:656`（PR-09） |
| `docs/02-tech-design/api-contract.md` | `:617`（`serving` 行）· `:700-713`（TBD 清单） |
| `docs/02-tech-design/database-schema.md` | `:814-829`（TBD 清单）· `T2` 收益表 · `T3` 状态机表 |
| `lib/types/earning.ts` / `lib/constants/earnings.ts` | 代码现状（§4.2 用） |
| `lib/types/refund.ts` | 确认 `RefundRequest.amount` 已存在（§六 用） |

### 1.2 工作区 baseline（本轮开始前，**不含本轮改动**）

- `HEAD = 3fbae6263794bda316b2b48dac03efd7f62afa01`（与 P0-10 起始时**一致**，本批次零 Git 写）
- P0-10 / P0-11 / P0-12 均为 `AWAITING_ACCEPTANCE`；`docs/03-dev/rounds/P0-13/` 在本轮之前**不存在**
- 上一轮（P0-12）交付物全部在树上未提交：`lib/data/directRefundTransaction.ts`、`app/api/orders/[id]/direct-refund/`、`components/refunds/DirectRefundButton.tsx`、`tests/directRefund.test.mjs` 等

---

## 二、Requirement Check：**已确认**的部分（这些**不是**问题）

`cmd_p0-13.md` 的目标段列了 7 件事。逐条对权威文档核对，**其中 5 件已经冻结**，不需要问：

| # | `cmd_p0-13.md` 的要求 | 权威依据 | 结论 |
|---|---|---|---|
| 1 | `serving` 不允许 direct refund、进入售后 | `EX-REFUND-08:648-655`（`serving`｜进入售后，客服调查，管理员决定退款比例）· `EX-REFUND-07:635`（前置只有 `paid`/`accepted`） | ✅ **已冻结**。P0-12 已把 `REFUNDABLE_ORDER_STATUSES` 与 `DIRECT_REFUNDABLE_ORDER_STATUSES` 拆成互不相交的两个集合，`serving` 天然落在售后侧 |
| 2 | `completed` 普通投诉只在 `now <= complaintDeadlineAt` 开放，**必须用订单冻结 deadline，不读当前 `PlatformConfig` 追溯历史** | `用户权限表.md:574`（`frozen → available`｜投诉窗口结束且无冻结原因）· `EX-REFUND-08:653` · `lib/constants/earnings.ts:103-104` 同一条口径（「窗口不随后续平台参数修改而变化」） | ✅ **已冻结**，且**代码里已有同一口径**（`Earning.availableAt` 是订单冻结快照、永不刷新） |
| 3 | 售后存在时 `Earning.frozen` 不得释放 | `用户权限表.md:149`（投诉窗口到期后释放打手冻结收益）· `lib/constants/earnings.ts:73-77`（「有没有阻塞」只有一条定义，复用 `isCompletionAutoApprovalBlocked()`） | ✅ **已冻结**，且**已有单一真值源**可复用 |
| 4 | 只有 Admin 能最终决定 reject / partial / full 及金额；Staff 只可查看/沟通/记录/建议 | `EX-REFUND-08:652`（管理员决定退款比例）· `用户权限表.md:438-448`（§7.3 退款边界）· `lib/constants/refunds.ts` 既有 `adminRefundAllowedActions` | ✅ **已冻结**（**客服端无 `approve`**，只有 `start-review`/`reject`；P0-12 已在 `02-decisions.md` §五.1 更正过同一处误述） |
| 5 | 金额约束：单次 > 0、累计 `refundedAmount <= actualPaidAmount`、整数分、repeated approval 幂等、partial 不置 `refunded`、累计满额才置 `refunded` | `EX-REFUND-01:550-557`（幂等）· `EX-REFUND-02:562-571`（`refundedAmount` 不超过应退金额）· `cmd_p0-13.md:51-57` 本身即约束 | ✅ **已冻结**。P0-12 的 `applyOrderRefund` 已经是「唯一 `Order → refunded` 原语」，partial 只需累计而不调它 |
| 6 | 收益释放：售后解决后仍需 `now >= complaintDeadlineAt` 且无其它阻塞，下一次 sweep 才 `available`；**不得因 UI 点「处理完成」提前释放** | 同 #3 | ✅ **已冻结**，口径与 #3 同源 |
| 7 | 复用现有 Refund / Payment core，不新建第二套 | `cmd_batch:44-45`「禁止第二套 Order、Refund、Notification、PlatformConfig、Auth、复杂 Assignment」· `api-contract.md:617`「申请与人工审批链路已存在」 | ✅ **已冻结**。且 `lib/types/refund.ts:41` 的 `RefundRequest.amount` **已存在**，partial 不需要新实体 |
| 8 | 已提现后的退款**本轮 DEFER**，不得做负余额/追偿 | `cmd_p0-13.md:27-28`（可明确 DEFER）· `:71`（明确不做「已提现追回、负余额」）· `EX-REFUND-05:611`（见 `EX-WITHDRAW-03`）· `EX-WITHDRAW-03:917`（❓ 完全未拍板） | ✅ **可以 DEFER，本轮不阻塞**（见 §五） |
| 9 | 金额必须基于**订单冻结经济快照**（`companionBaseIncome` / `actualPaidAmount`），不得按当前商品/分账比例重算 | `cmd_p0-13.md:62` · `lib/types/earning.ts:14-19`（「只做搬运，不做计算…事后用今天的规则重算等于改承诺」） | ✅ **已冻结**，且代码里已有同一原则的成文表述 |
| 10 | 必须复用 `Earning` 既有模型，不另造平行模型 | `lib/types/earning.ts:38`（「取值与 `database-schema.md` T2 完全一致，**不另造平行模型**」）· `lib/constants/earnings.ts:10-15` | ✅ **已冻结** |

**⚠️ Requirement Check 结论：`cmd_p0-13.md` 的 10 项中 10 项有权威依据；但 Q1 的第三个子问题与 Q2 的整体仍为 OPEN（§三 / §四）。因此 `P0-13 = CLARIFYING`。**

---

## 三、⛔ 阻塞项 **Q1** — `completed` 部分退款如何影响打手 Earning

`cmd_p0-13.md:18-21` 把 Q1 拆成三个子问题。**前两个有答案，第三个没有**——这正是 CLARIFYING 的触发点。

### 3.1 已冻结的部分（**不要重复问**）

`EX-REFUND-03`（`:575-584`，标题「部分退款时用户使用过优惠券」）的表**逐字**是：

| 项目 | 处理 |
|---|---|
| 用户退款 | `floor(actualPaidAmount × refundRate)` |
| 打手冲回 | `floor(companionBaseIncome × refundRate)` |
| 平台调整 | `userRefundAmount - companionReversal` |
| 平台调整可负 | 是 |
| 优惠券成本 | 平台承担 |
| 状态 | **✅ 公式已确认，功能 ⏳** |

因此：
- **「是否按退款比例同比减少？」→ ✅ 是**，冲回额 = `floor(companionBaseIncome × refundRate)`。**且这是唯一已冻结的公式**；`cmd_p0-13.md:62` 同时要求它只作用在订单冻结快照上，本文件与代码两者一致。
- **「是否由平台承担？」→ ✅ 部分回答**：平台承担的是**公式算出的差额**（`userRefundAmount - companionReversal`，可负 ⇒ 平台可能反而多收），以及**优惠券成本**。

### 3.2 未冻结的部分 — 「是否区分打手责任 / 平台责任？」

**这一问在全仓权威文档里没有任何答案。** 证据是可复现的 grep：

```bash
grep -rn "打手责任\|平台责任\|责任归属\|责任划分\|责任认定\|责任方" docs/
```

**唯一命中是 `docs/03-dev/rounds/cmd_p0-13.md:21`——也就是这个问题本身。**
`docs/01-requirements/` 与 `docs/02-tech-design/` 下 0 命中。

`EX-REFUND-03` 的表里也**没有**责任这一行：它只给了一条**无条件**的公式。

### 3.3 为什么这一半**不能**自行补

两种读法都说得通，而**它们的钱不一样**：

| 读法 | 规则 | 对同一单的结果（`companionBaseIncome = 10000`，`refundRate = 0.5`，打手无过错） |
|---|---|---|
| **读法 A** — 公式无条件 | 冲回**恒为** `floor(10000 × 0.5) = 5000`，不因责任而变；「平台承担」只指差额 | 打手少 5000 分 |
| **读法 B** — 责任决定冲回 | 打手无过错 ⇒ 冲回 = 0，全部由平台承担；有责 ⇒ 按 A 冲 | 打手少 0 分 |

「A 更省事」**不构成理由**——`development-workflow.md` §十一 明文把「为了赶进度选择「比较合理」的方案」列为 ❌。
而 `EX-REFUND-08:652` 的措辞是「**管理员决定退款比例**」（只提比例，不提责任），
`EX-REFUND-03` 的公式也确实无条件——**这些是「A 更可能」的旁证，不是 A 已冻结的证据**：
若责任本就要参与，那它本该出现在 `EX-REFUND-03` 的表里，而它不在；反过来，若责任确定不参与，
`cmd_p0-13.md:21` 就没有理由把它列成必答问题。

**两边都推不出结论 ⇒ 属 `TBD — DO NOT INVENT`（`architecture-rules.md:22`）⇒ 必须问。**

### 3.4 需要产品负责人选的口径

- **Q1-a（必答）** 部分退款的打手冲回，是否**恒按** `floor(companionBaseIncome × refundRate)`
  （= 读法 A，不区分责任），还是**先看责任**（= 读法 B）？
- **Q1-b（若选 B 才需要答）** 责任由谁认定、有哪几个取值、每个取值对应的冲回规则？
  （Admin 在批准时选，还是 Staff 提建议？）
- **Q1-c（必答）** 若最终规则是「有责才冲回」，那么**无责时平台承担的那部分**是否要留资金记录？
  还是仅体现为「不生成冲回」？

---

## 四、⛔ 阻塞项 **Q2** — `Earning` 已 `available` 但尚未提现时发生退款

`cmd_p0-13.md:23-25` 的两问是「是否直接减少 available earning？」与「是否需要 adjustment record / 新状态？」。
**两个都没有答案，而且文档给的是一句带斜杠的话。**

### 4.1 文档原文（逐字，含它自己的状态标记）

`EX-REFUND-05`（`:604-612`，标题「用户提交退款时，打手收益已经变为 available」）：

| 项目 | 处理 |
|---|---|
| 如果仍属于允许退款窗口 | 应执行 Earning 冲正，而不是忽略 |
| 打手收益 | **available 部分减少/生成 reversal** |
| 平台 | 按部分退款公式调整 |
| 如果已提现 | 见 EX-WITHDRAW-03 |
| 状态 | **⏳ 资金域后续实现** |

⚠️ **注意状态栏：只有 `⏳`，没有任何 `✅`。** 对比同文件 `EX-REFUND-03:584` 写的是
「**✅ 公式已确认，功能 ⏳**」——它把「规则已定」与「功能未写」分得清清楚楚。
`EX-REFUND-05` 没有那个 `✅`，说明**规则本身也没定**。

### 4.2 「`available 部分减少/生成 reversal`」这一句里的两个未定项

**未定项 ①：「减少」的是哪个对象？**

「减少 available earning」在两个层面上是不同的事：
- 减少**那条 `Earning` 记录的金额**（`incomeAmount` 变小）；
- 减少**打手可用余额桶**（`Earning` 记录不动，余额被扣）。

`用户权限表.md:536` 与 `:656`（PR-09）说得很直白：「具体**余额桶**、负余额和失败补偿规则仍为 **TBD**」，
`业务流程表.md:757-763` 把「手工调整可作用于哪些余额桶（frozen / available / 其他）」列进
**「以上未确认项：TBD — DO NOT INVENT」**。

⚠️ 而且**第一种解读与代码里已写死的原则冲突**：`lib/types/earning.ts:14-19` 明文

> `incomeAmount` 在下单那一刻就已经确定…创建 Earning 时**只做搬运，不做计算**…
> 那是一个已经承诺给打手的数，事后用今天的规则重算等于改承诺。

`incomeAmount` 是**不可变快照**。要「减少」它，就必须先决定是**改快照**（与本原则冲突）
还是**用另一个字段/记录表达扣减**——而后者正是下一个未定项。**这一步跨不过去，也无法自行选边。**

**未定项 ②：「/ 生成 reversal」是「或」还是「且」？**

- 若是**或**：二选一即可 —— 但**选哪个**没写。
- 若是**且**：既改金额又留一条 reversal 记录 —— 那 reversal **记在哪**？
  全仓**没有任何 adjustment / reversal 实体**：

  ```bash
  grep -rln "adjustment\|Adjustment\|reversal\|Reversal" lib/    # → 无输出
  ```

  `database-schema.md:814-829` 的 TBD 清单里也没有它——**它是「不存在且未被设计」，不是「已设计未实现」**。

### 4.3 代码现状：类型上有位置，**语义上一个字都没定**

`lib/types/earning.ts:46` 的 `EarningStatus` **已经含** `"reversed"`，`:85` 也有 `reversedAmount` 字段。
但同一份文件 `:21-27` 与 `:82-87` 说得非常清楚：

> `withdrawnAt` / `reversedAmount` / `fineAmount` 三个字段按 `database-schema.md` T2 保留在类型上，
> 但**没有任何写入路径**…它们不是「预留字段」——它们是同一张表在完整设计里的字段，写入者是后续批次。
> 当前它们恒为初始值。

`lib/constants/earnings.ts:20-22` 同样写「`withdrawn` / `reversed` 在本阶段**不可达**」。

⚠️ **因此「类型里有 `reversed`」绝对不能读成「Q2 已答」**——它只说明这张表在设计里有一个冲正取值，
**没有说明**：部分冲正时该不该置 `reversed`（`reversed` 听起来是「整笔被冲」，无法表达「冲了 50% 还剩 50%」）、
`reversedAmount` 记的是累计冲正额还是本次冲正额、部分冲正后 `status` 留在 `available` 还是转 `reversed`。

P0-9 是**刻意**把这三个字段留成空壳的，它明确拒绝替后续批次回答语义。本轮就是那个「后续批次」。

### 4.4 需要产品负责人选的口径

- **Q2-a（必答）** 已 `available` 的 Earning 被退款冲减时，冲减的是
  **① `Earning` 记录本身**，还是 **② 打手的可用余额桶**（记录不动）？
  （若是 ②，则本轮**没有**可写入的余额实体——`用户权限表.md:536` 说余额桶是 TBD。）
- **Q2-b（必答）** 是否需要一条**独立的 adjustment / reversal 记录**？
  若需要，它是**新实体**（则它属 `TBD — DO NOT INVENT`，需产品先定义字段）
  还是复用既有 `Earning` 上的 `reversedAmount`？
- **Q2-c（必答）** 部分冲减后 `Earning.status` 取什么？
  · 留在 `available`（则 `availableAmount` 合计怎么算）　· 转 `reversed`（则「只冲了一半」无处表达）
  · 还是需要**新状态**（则要同步 `database-schema.md` T2 与 `EARNING_STATUSES`）？
- **Q2-d（必答）** 冲减后是否**恢复** `availableAt` 的既有语义？
  即：这笔收益曾 `available` 过、被冲减后若又发生一次全额退款，是否允许**再次**冲减到 0？
  （`Earning` 是「一单一记录、`orderId` 唯一」，两次冲减必须落在同一条上。）

---

## 五、**Q3 已提现后的退款** — 本轮**不阻塞**，可以 DEFER

`cmd_p0-13.md:27-28` 自己就写了「本轮可以明确 DEFER，但不得自行做负余额/追偿」，
`:71` 的「明确不做」里也列了「已提现追回、负余额」。文档侧同样未拍板：

- `EX-REFUND-05:611`「如果已提现 → 见 `EX-WITHDRAW-03`」
- `EX-WITHDRAW-03:911-918`：可能处理「形成负余额/待扣款/平台承担/追偿」，**「当前规则｜❓ 完全未拍板」**，**「❓ 资金域的重要待确认项」**
- `EX-WITHDRAW-01:892` 提现流程本身「❓ 尚未正式设计」
- `特殊情况与异常处理表.md:1063` `Q-EX-09`「打手收益已提现后发生退款如何追偿」= **资金一致性核心**

⇒ **结论：Q3 的正确答案就是「不做」**，与 `cmd_p0-13.md` 的明文一致，**不需要产品现在裁定**。
本轮据此把「已提现后的退款」整体排除在 P0-13 范围外（见 §六）。
⚠️ 但它是**上线前 production blocker**：真支付接入前必须有结论，建议与 `EX-WITHDRAW-01`（提现域）一并裁定。

---

## 六、**不**阻塞本轮的项（记录以免重复提问）

| 项 | 为什么不是问题 |
|---|---|
| `RefundRequest` 能不能承载 partial | ✅ `lib/types/refund.ts:41` **已有** `amount: number`；复用既有 Refund core，不新建实体 |
| partial 的累计字段 `Order.refundedAmount` | ✅ P0-12 已建立（`refundedAmount >= actualPaidAmount` 的守卫也在 `directRefundTransaction.ts` 内）。⚠️ 原先这里写「partial **只累计、不调** `applyOrderRefund`」——**2026-09-25 更正**：实现里 partial 恰恰**调**它（`adminRefundTransaction.ts:460` 就是那个累加入口），D3 改的正是它的第三个参数语义。见 D18 |
| 「售后 case」是否要新建 `AfterSalesCase` 实体 | ⚠️ `database-schema.md:824` 把 `AfterSalesCase` 结构列为 **`TBD — DO NOT INVENT`（计划 R4）**。但 `api-contract.md:617` 说明**申请与人工审批链路已存在** ⇒ P0-13 应**复用既有 Refund**，把 `AfterSalesCase` 留给 R4。这一点在 `cmd_batch:44-45`「禁止第二套 Refund」下是**唯一**合规落点，不需要问 |
| `deadline` 之后是否存在「特殊人工申诉」 | `EX-REFUND-08:654` 写「特殊人工申诉是否存在仍 TBD」——但 `cmd_p0-13.md:71` 的「明确不做」含「特殊过期申诉」，本轮不做，**不阻塞** |
| 管理员误点退款通过（`EX-REFUND-06`） | `:627`「⏳ 真实支付前必须细化」，本轮无真支付，**不阻塞** |
| 消费累计/排行榜补偿（`EX-REFUND-04`） | `:600`「⏳ 需要消费累计重构时实现」，不在 P0-13 目标内 |

---

## 七、请产品负责人裁定

> 以下用**能直接回答**的形式列出。Q1-a 与 Q2-a/b/c/d 各有 `⚠️ OPEN`；
> 回答会按 `development-workflow.md` §十二 追加到本文件（`### User Answer` / `### Final Execution Rule` / `Status: RESOLVED`），
> 全部 `RESOLVED` 后本文件头部状态才由 `CLARIFYING` 转 `READY`（§十三：**只有 READY 才能编码**）。

### Q1（必答）— 部分退款时打手冲回是否区分责任

- **Q1-a** 冲回是否**恒按** `floor(companionBaseIncome × refundRate)`（不区分责任，`EX-REFUND-03` 读法 A）？
  还是**先看责任**（读法 B）？
- **Q1-b** 若选 B：责任由谁认定、有哪几个取值、各自对应的冲回规则是什么？
- **Q1-c** 若最终规则是「有责才冲回」：无责时平台承担的那部分是否要留资金记录，还是仅体现为「不生成冲回」？

### Q2（必答）— 已 `available` 的 Earning 被退款冲减

- **Q2-a** 冲减对象是 **① `Earning` 记录本身** 还是 **② 打手可用余额桶**？
- **Q2-b** 是否需要**独立的 adjustment / reversal 记录**？（若需要，是**新实体**还是复用 `Earning.reversedAmount`？）
- **Q2-c** 部分冲减后 `Earning.status` 取什么：留 `available` / 转 `reversed` / **新状态**？
- **Q2-d** 同一笔 `Earning` 是否允许**被冲减多次**（直至 0）？

### Q3（**可不答**，本轮已 DEFER）— 已提现后的退款

`cmd_p0-13.md:27-28` 已授权本轮 DEFER。**若产品现在没有结论，本轮按「不做」执行，无需回答。**

---

## 八、本轮的 Git 状态

- `HEAD = 3fbae6263794bda316b2b48dac03efd7f62afa01`，**与本批次开始时一致**
- **本批次全程零 Git 写操作**（无 `add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend`）；
  本轮只使用只读命令（`git status` / `git rev-parse` / `git diff` / `git log`）
- 本轮**新增**文件仅 `docs/03-dev/rounds/P0-13/` 下 5 个档案；**未修改任何业务代码、测试、配置**
- 未提交的累计改动是 P0-10 / P0-11 / P0-12 三轮的交付物，见 `03-delivery.md` §四

---

## 九、中间状态历史（追加，不覆盖）

| 时间 | 状态 | 事件 |
|---|---|---|
| 2026-09-25 | `CLARIFYING` | Requirement Check 完成：10 项已冻结、Q1 第三子问与 Q2 整体 OPEN ⇒ 本轮建档即停，**未写任何业务代码**，未开始 P0-14 |
| 2026-09-25 | `READY` | 产品负责人裁定 Q1 / Q2（见 §十），二者均 `Status: RESOLVED`；Q3 确认继续 DEFER |
| 2026-09-25 | `IN_PROGRESS` | 按裁定开始编码 |

---

## 十、裁定记录（追加，不覆盖 §三–§七 的原始提问）

> 按 `development-workflow.md` §十二 的格式：`### User Answer` 照录裁定原文，`### Final Execution Rule` 写本轮的执行口径，
> `Status: RESOLVED`。**§三 / §四 / §七 的原始提问一字未改**——裁定是追加，不是覆盖。

### D-Q1（✅ 已裁定，2026-09-25）— 部分退款**区分责任**，责任由 Admin 认定

#### User Answer（照录）

> **Q1-a**
>
> 选择责任制，不采用「所有退款一律同比扣打手」。
> 退款责任由 Admin 在最终退款决策时认定。
> 最小责任类型：
>
> - `platform`
> - `companion`
> - `shared`
>
> 规则：
>
> - `platform` → companion reversal = 0
> - `companion` → companion reversal = `floor(companionBaseIncome × refundRate)`
> - `shared` → companion reversal = `floor(companionBaseIncome × refundRate × companionLiabilityRate)`
>
> 其中 shared 时：`companionLiabilityRate = 0% ~ 100%`，由 Admin 在最终退款决策时填写。
> 所有金额继续使用整数分。
>
> **Q1-b**
>
> 责任认定权属于 Admin。
> Staff 只能调查、记录、提出处理意见，不能最终决定退款金额或资金责任。
>
> **Q1-c**
>
> 平台承担部分必须留下明确、可审计的业务记录，不能仅通过「没有 reversal」间接推断。
> Refund 最终决策至少应能表达：`responsibility` · `refundAmount` · `refundRate` ·
> `companionLiabilityRate` · `companionReversalAmount` · `platformBorneAmount`。
> 不要求本轮建设完整财务总账。

#### Final Execution Rule

**① 三个责任类型的冲回公式（唯一真值源：`lib/constants/refunds.ts`）**

| `responsibility` | `companionReversalAmount` | 平台承担 |
|---|---|---|
| `platform` | **0** | `refundAmount`（全部） |
| `companion` | `floor(companionBaseIncome × refundRateBp / 10000)` | `refundAmount − 冲回` |
| `shared` | `floor(companionBaseIncome × refundRateBp × companionLiabilityRateBp / 10000 / 10000)` | `refundAmount − 冲回` |

- 与 `EX-REFUND-03`（已冻结）一致：**平台承担 = 用户退款额 − 打手冲回**，即该表最后两列就是 `EX-REFUND-03` 的「平台调整」。
  `shared` 的乘积是**单次 floor**（不两次 floor），与裁定原文 `floor(a × r × l)` 的字面一致。
- 所有中间量与结果都是**整数分**；比例一律用**基点（bp，1 bp = 0.01%，10000 = 100%）**——
  与本仓既有约定相同（`companionBaseIncome = floor(分账基数 × 比例 / 10000)`，见 `lib/types/earning.ts:63`）。
- `companionLiabilityRateBp ∈ [0, 10000]`，**只对 `shared` 有意义**：`platform` / `companion` 一律以 `null` 存，
  不接受「传了但不生效」的值（`platform` 传 10000 与 `companion` 传 0 都是**校验错误**，不是等价写法）。

**② 责任认定权**

- **只有管理员**可以在最终退款决策里填写 `responsibility` / `refundRateBp` / `companionLiabilityRateBp`。
- 客服侧**不得**接受这三个参数：客服的 `allowedActions` 里**不新增**任何「决定金额/责任」的动作，
  `approve` 相关入口对客服**一律 403**（沿用既有 `staffRefundAllowedActions`，不新增 `canApprove`）。
- 客服可以做的三件事**本来就有**：`start-review`（调查）、`reject`、以及在驳回时写理由。

**③ 退款记录必须表达全部六项（可审计，不允许「没有 reversal」间接推断）**

`Refund` 的最终决策至少要能读出：`responsibility` · `refundAmount` · `refundRate`（bp）·
`companionLiabilityRate`（bp，仅 `shared`）· `companionReversalAmount` · `platformBorneAmount`。
**本轮不做完整财务总账/会计科目**——只做这一条决策记录 + Earning 侧的一条 adjustment。

`Status: RESOLVED`

---

### D-Q2（✅ 已裁定，2026-09-25）— `available` 收益的冲减走**独立 reversal 记录**，原 `incomeAmount` 不可改

#### User Answer（照录）

> **Q2-a**
>
> 不得修改原始 `Earning.incomeAmount`——它仍表示订单完成时根据订单经济快照确定的原始应得收益，
> 是不可篡改历史事实。
> 本轮也不建立余额桶。
> 退款通过独立 reversal / adjustment 记录表达。
> 实际剩余可用收益：`netAvailableAmount = incomeAmount - cumulativeReversalAmount`
>
> **Q2-b**
>
> 新增最小独立 `EarningAdjustment`（或符合项目现有命名习惯的等价 reversal 实体）。
> 至少关联：`earningId` · `orderId` · `refundId` · adjustment type / `refund_reversal` · `amount` ·
> `responsibility` · `createdAt`。
> 不得创建完整钱包/会计总账。
>
> **Q2-c**
>
> 部分冲回：`Earning.status = available`。
> 例：`incomeAmount = 10000` · `cumulativeReversal = 3000` · `netAvailableAmount = 7000` · `status = available`。
> 累计冲回达到全部 `incomeAmount`：`status = reversed` · `netAvailableAmount = 0`。
> 因此 `reversed` 只表示整笔收益已经完全冲销，不表示部分冲回。
>
> **Q2-d**
>
> 同一 Earning 允许被多次退款产生的 adjustment/reversal 冲减。
> 必须保证 `0 <= cumulativeReversalAmount <= incomeAmount`，不得冲成负数。
> 每次 refund / adjustment 必须保持幂等，不能因为重放重复冲回。

#### Final Execution Rule

**① `incomeAmount` 不可变 —— 但「累计冲回额」这个字段**已经存在**，不新增平行字段**

⚠️ `Earning` 上**已经有** `reversedAmount: number`（`lib/types/earning.ts:85`），其注释写着
「已冲正金额（分）。P0-9 **无写入路径**，恒为 0」，并且文件头 `:21-27` 明说这三个字段
「是按 `database-schema.md` T2 保留在类型上的…**写入者是后续批次**」。
**P0-13 就是那个后续批次** ⇒ 直接把 `reversedAmount` 用作**累计冲回额**，
**不新增 `cumulativeReversalAmount` 字段**（新增会成为同一事实的第二处存储，违反单一真值源）。

- `Earning.incomeAmount`：**永不修改**（裁定明文）。
- `Earning.reversedAmount`：**本轮起可写**，语义 = `cumulativeReversalAmount`，单调不减。
- `netAvailableAmount = incomeAmount − reversedAmount`：**派生值，不落库**，
  由纯函数 `earningNetAvailableAmount(earning)` 计算（`lib/constants/earnings.ts`）。

**② 状态判据（只有全冲才 `reversed`）**

```
reversedAmount === 0                  → status 保持原状态（`frozen` 仍是 `frozen`，`available` 仍是 `available`）
0 < reversedAmount < incomeAmount     → status = available        ← 部分冲回
reversedAmount === incomeAmount       → status = reversed          ← 整笔冲销
```

⚠️ 与 `isEarningMatured()` 的交互：它要求 `status === "frozen"`。**部分冲回是否会让一笔还在冻结期内的收益
「提前变成 available」？** ⇒ **不会**：`frozen` 的收益**这一轮压根不写冲回**（见 ③），
因此 §十 D-Q2 ② 的第二行只在收益**已经是 `available`** 时可达。

**③ 本轮冲减**只管**已经 `available` 的 Earning**

裁定 Q3 与本条的措辞（「已 available 但尚未提现」）都指向同一范围。因此：

| Earning 状态 | 遇到退款决策 |
|---|---|
| `frozen` | **不写 adjustment**。它还没解冻，退款通过**阻塞释放**表达（`isCompletionAutoApprovalBlocked()` 已实现），**等窗口到期且无阻塞后照常释放** |
| `available` | 写 `EarningAdjustment`，累加 `reversedAmount`，按 ② 更新 `status` |
| `withdrawn` / `reversed` | 不写（`withdrawn` 属 Q3 DEFER；`reversed` 已无余额可冲） |

⚠️ **本轮的「本轮不建余额桶」必须落在代码上**：不存在任何「余额」实体，
`reversedAmount` 是**收益记录上的累计数**，不是钱包余额。提现/钱包域另立。

**④ `EarningAdjustment` 实体（最小）**

| 字段 | 说明 |
|---|---|
| `id` | 主键（`adjustmentIdByRefund` 之类的单值索引保证幂等） |
| `earningId` | 被冲减的收益 |
| `orderId` | 冗余但必要：按订单检索与对账都靠它 |
| `refundId` | 产生这次冲回的退款记录 |
| `type` | 取值域 `"refund_reversal"`（留下扩展位，不预先造其它取值） |
| `amount` | 本次冲回额（分，正整数） |
| `responsibility` | `platform` / `companion` / `shared` |
| `createdAt` | 冲回时刻 |
| `adminId` | 决策管理员 |

**幂等键 = `refundId`**（一次退款决策**最多**产生一条 reversal）——这正是 Q2-d「不能因为重放重复冲回」的落点。
`adminId` 不属于裁定「至少关联」的清单，但 Q1-c 要求「可审计」，故补上；**不多加其它字段**。

**⑤ 不变式的性质（结构成立 + 用例钉住，不加运行时守卫）**

`0 <= reversedAmount <= incomeAmount` 是**结构性成立**的，不需要再加一条运行时守卫：

- `earnings.reversedAmount` 只由本次决策增加，每次增加 `floor(companionBaseIncome × rate_i × l_i)`；
- 而**累计用户退款额** `Σ refundAmount_i <= actualPaidAmount`（`cmd_p0-13.md:53` 的既有约束）；
- 又 `companionBaseIncome <= actualPaidAmount`（订单快照的定义，见 `lib/types/order.ts`）；
- ⇒ `Σ 冲回 <= Σ floor(base × rate_i) <= base × Σ rate_i <= base × 1 = incomeAmount`
  （`Σ rate_i = Σ refundAmount_i / actualPaidAmount <= 1`，`base <= actualPaidAmount`）。

因此冲不成负数、也超不过 `incomeAmount`。按本仓既有风格（见 P0-12 的「结构性成立 + 用例钉住」），
**不写一条永远不会触发的守卫**，而是写**不变式用例**把它钉住。

`Status: RESOLVED`

---

### D-Q3（✅ 已裁定，2026-09-25）— 已提现后的退款**继续 DEFER**

#### User Answer（照录）

> 继续 DEFER。
> P0-13 只处理 `frozen`、`available` 但尚未提现。
> 不处理：已提现追回 · 负余额 · 后续收益抵扣 · 人工追偿。
> 上述内容与未来提现/钱包域统一设计。

#### Final Execution Rule

- **P0-13 的 Earning 影响面止于**：`frozen`（走阻塞，不写 adjustment）与 `available`（写 adjustment）。
- `withdrawn` / `reversed` 的 Earning **本轮不做任何写入**。
- 不建负余额、不建追偿、不做后续收益抵扣。
- 「已提现后的退款」在 P0-13 里**没有入口也没有实现**——它在 `EX-WITHDRAW-03`「❓ 完全未拍板」下的正确状态就是「不做」。

`Status: RESOLVED`

---

## 十.一、裁定后的冻结真值表（实现只许照此写）

| # | 事项 | 冻结值 | 出处 |
|---|---|---|---|
| 1 | 责任类型 | `platform` \| `companion` \| `shared` | D-Q1 ① |
| 2 | `platform` 冲回 | 0 | D-Q1 ① |
| 3 | `companion` 冲回 | `floor(base × refundRateBp / 10000)` | D-Q1 ① |
| 4 | `shared` 冲回 | `floor(base × refundRateBp × liabilityBp / 10000 / 10000)` | D-Q1 ① |
| 5 | 平台承担 | `refundAmount − companionReversalAmount` | D-Q1 ①（= `EX-REFUND-03` 的「平台调整」） |
| 6 | 谁认定责任 | **只有 Admin**；Staff 只有调查/记录/建议权 | D-Q1 ② |
| 7 | 决策记录必须能读出 | 六项（责任 / 退款额 / 退款比例 / 责任比例 / 冲回额 / 平台承担额） | D-Q1 ③ |
| 8 | `incomeAmount` | **不可变** | D-Q2 ① |
| 9 | 累计冲回字段 | 复用**已有** `Earning.reversedAmount`，不新增字段 | D-Q2 ① |
| 10 | 净可用额 | `incomeAmount − reversedAmount`，**派生不落库** | D-Q2 ① |
| 11 | `reversed` 的含义 | **只表示整笔冲销**（`reversedAmount === incomeAmount`），不代表部分冲回 | D-Q2 ② |
| 12 | 部分冲回后状态 | 留在 `available`（**已推广为「留在原状态」**，见 §十一 D5） | D-Q2 ② |
| 13 | 冲减范围 | 只对**已经 `available`** 的 Earning 写 adjustment；`frozen` 走阻塞（**已更正：`frozen` 也要冲减**，见 §十一 D5） | D-Q2 ③ |
| 14 | adjustment 幂等键 | `refundId`（一次决策最多一条 reversal） | D-Q2 ④ |
| 15 | 不变式 | `0 <= reversedAmount <= incomeAmount`；**结构性成立的推理已被证伪**，改由钳制保证（§十一 D4 / D6）；用例仍钉住 | D-Q2 ⑤ |
| 16 | 已提现 | **DEFER，零实现** | D-Q3 |

---

## 十一、实现决策（`D1`–`D19`）

> 标题里的区间会随追加而更新；**条目正文一律追加，不覆盖**。
> `D18` 是审查整改，`D19` 是人工验收整改（见本节末尾）。

> §十 记的是**产品裁定**；本节记的是**在裁定范围内把规则落到代码**所必须做的判断，以及
> 对 §十.一 冻结真值表**第 12 / 13 / 15 行**的三处**更正**（D5 / D6）。
> 更正不是推翻裁定：三处原措辞都只覆盖了「Earning 已 `available`」这一种情形，
> 而裁定本身的适用面更宽（见各条理由）。

### D1 退款比例是入参，金额是派生值（不新造公式）

`docs/01-requirements/超哥电竞_业务流程表.md:919` §17「部分退款资金公式」**规则已冻结**，
且写明了输入形态：**「管理员只输入退款比例，金额由系统计算」**。因此：

- 请求体里**没有**金额字段，只有 `refundRatePercent`；金额由服务端按冻结公式算：
  `refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`；
- 打手冲回同样按 §17：`companion` → `floor(base × rate / 10000)`，
  `shared` → `floor(base × rate × liability / 10000 / 10000)`（`base = order.companionBaseIncome`）；
- 平台承担 = `refundAmount − companionReversalAmount`，**允许为负**（§17 原文「允许 `clubIncomeAdjustment < 0`」）。

一句话：本轮**没有新公式**，只是把 §17 的输入输出接到既有 Refund/Order 写入器上。

### D2 服务端校验清单（都在审批那一刻，改不了就报 400）

| 校验 | 规则 | 依据 |
|---|---|---|
| 比例形态 | 整数 bp，`0 <= bp <= 10000` | §16.B「0% ～ 100%」+ 全仓 bp 口径 |
| 单次金额 | `refundAmount > 0` | `cmd_p0-13.md`「单次 > 0」（`bp = 0` 或实付过小被取整成 0 都落在这里） |
| 累计金额 | `order.refundedAmount + refundAmount <= order.actualPaidAmount` | `cmd_p0-13.md`「累计 `refundedAmount <= actualPaidAmount`」 |
| 责任枚举 | `platform` / `companion` / `shared` | D-Q1 ① |
| 责任比例 | **仅 `shared` 允许**且必填，整数 `0..10000`；其余两种给了就报 400 | D-Q1 ①（给了却无效比报错更危险，这一条是资金字段，不 silently ignore） |

### D3 订单退款累计语义（`applyOrderRefund` 改为累加）

`lib/data/mockPaymentRepository.ts` 的 `applyOrderRefund(id, at, delta?)` 第三个参数
**从「这次覆盖成多少」改为「这次退多少（增量）」**，累计写入 `refundedAmount`：

- 幂等短路条件从「`status === "refunded"`」放宽为「`status === "refunded"` **或**
  `refundedAmount >= actualPaidAmount`」——两者都表示「已经退满」，不再累加、不刷新 `refundedAt`；
- `status` **只在累计退满时**才改成 `refunded`（`architecture-rules.md:191`、
  `database-schema.md:184` 两条都是明写的硬规矩）；`refundedAt` 第一次退满时写下，之后不刷新；
- ~~既有两个调用方（用户直接全额退款、派单超时退款）都发生在「累计已退 = 0」的订单上，行为不变~~
  —— ⛔ **这句话是错的，2026-09-25 由只读审查证伪并整改，见下面的 D18。**
  它把「今天凑巧成立的前提」写成了「结构性成立的事实」；函数注释里那句
  「将来部分退款上线后，这里才是累计已退的累加入口」正是本轮兑现的东西。

### D4 冲回额在哪里算、以及那一次**钳制**

冲回额在**审批决策**里算一次，结果写进两个地方（退款决策 + `Earning`/adjustment），
**不重复计算**——同一件事实两处各算一遍正是「两处不一致」的来源。

```text
remaining = order.companionBaseIncome − 该订单此前已批准退款记录上的冲回额之和
companionReversalAmount = min(按 D1 公式算出的值, max(0, remaining))
```

钳制是 **Q2-d 那句强制要求的落点**（「必须保证 `0 <= cumulativeReversalAmount <= incomeAmount`」）：
裁定要求这个不变式**必须**成立，而单靠公式并不能保证（理由见 D6）。
钳制只在公式结果越界时才生效，此时多出来的部分由平台承担——正是 §17 允许的
`clubIncomeAdjustment < 0` 那一侧。

### D5 **更正 §十.一 第 12 / 13 行**：冲减范围含 `frozen`，状态规则是「留在原状态」

原措辞：「冲减范围：只对**已经 `available`** 的 Earning 写 adjustment；`frozen` 走阻塞」、
「部分冲回后状态：留在 `available`」。这两句只对「Earning 已 `available`」这一种情形成立，
而**本轮的主场景恰好是 `frozen`**：`completed` 订单的 `Earning.availableAt` 就是
`complaintDeadlineAt`，售后发生在窗口内 ⇒ 决策那一刻 Earning **一定还是 `frozen`**。

若照原措辞只“阻塞”而不冲减，那么阻塞在退款批准后就解除了、冻结期到点后
`frozen → available` 会按**全额** `incomeAmount` 解冻——等于售后白做。
因此更正为：

- 冲减对象是**该订单的 `Earning`，不论 `frozen` 还是 `available`**；
- 阻塞（`isCompletionAutoApprovalBlocked`）仍然只负责**时机**，不负责金额——它挡的是
  「进行中的退款/未完结的投诉」，与 D5 的金额冲减是两件事，两者都要有；
- 状态规则（与 D-Q2 ② 一致，只是把适用范围写全）：
  - `reversedAmount === 0` → 状态不变；
  - `0 < reversedAmount < incomeAmount` → **留在原状态**（`frozen` 仍 `frozen`、`available` 仍 `available`）；
  - `reversedAmount === incomeAmount` → `reversed`（此后 `isEarningMatured` 不再为真，不会被解冻）。
- 留原状态这一条同时守住了 `cmd_p0-13.md`「不得因为 UI 点击『处理完成』就提前释放」：
  部分冲回**不会**把 `frozen` 变成 `available`。

### D6 **更正 §十.一 第 15 行**：不变式不是「结构性成立」，而是由 D4 的钳制保证

§十 D-Q2 ⑤ 把 `0 <= reversedAmount <= incomeAmount` 记成「结构性成立」，理由是
`Σ冲回 ≤ base × Σ比例 ≤ base` 且 `base ≤ actualPaidAmount`。**后半句被侦察证伪**：

- `docs/01-requirements/超哥电竞_业务流程表.md:993` §18 原文示例：原价 50、分账 80%、
  券 10、实付 40 ⇒ **打手基础收益 = 40**，即分账基数走**原价**，
  `Order.companionBaseIncome` 与 `actualPaidAmount` 之间没有大小关系；
- `lib/types/order.ts:130` 明写 `clubNetIncome` **允许为负**（券由平台承担时），
  `lib/constants/orderAmount.ts` 的 `resolveClubNetIncome` 刻意不写 `Math.max(0, …)`。

所以 `base ≤ actualPaid` 只是「P0 无券 + 比例 ≤ 100%」的**结果**，不是不变量。
不变式改由 **D4 的钳制**保证（`min(公式值, remaining)`），仍然是「写进去的那一刻就成立」，
只是理由从「算出来必然 ≤」换成「算完再夹一次」。

### D7 决策落在退款记录上：`RefundRequest.decision`

六项（D-Q1 ③）**外加决策人与时刻**（`decidedBy` / `decidedAt`，为可审计）：

```ts
type RefundDecision = {
  refundRateBp: number;              // 本次退回用户的比例
  refundAmount: number;              // 本次实际退给用户的金额（分）
  responsibility: "platform" | "companion" | "shared";
  companionLiabilityRateBp: number | null;  // 仅 shared
  companionReversalAmount: number;   // 本次从打手收益冲回的金额（分）
  platformBorneAmount: number;       // = refundAmount − companionReversalAmount，可为负
  decidedBy: string;                 // AdminAccount.id
  decidedAt: string;
};
```

一条退款记录只有**一次**决策（`approved` 是终态），因此决策放在退款记录上是够的；
**幂等键 = `refundId`**（D-Q2 ④）。

### D8 `EarningAdjustment`：最小独立实体 + `refundId` 唯一

新增 `lib/types/earning.ts` 的 `EarningAdjustment`：
`{ id, earningId, orderId, refundId, type: "refund_reversal", amount, responsibility, createdAt }`
（Q2-b 的字段，`type` 预留其它 adjustment 种类但不实现其它种类）。

- 落在**收益域**的既有 mock store（`mockEarningRepository.ts` 的 store 加一张 `adjustments` 表），
  不新开第二个 store：adjustment 与 earning 是同一个域的两张表；
- `refundId` 建一条索引 ⇒「一次退款决策最多一条 reversal」在存储层成立（Q2-d ②的「幂等」）；
- 写原语 `appendEarningAdjustment` / `applyEarningReversal` 与既有两个写原语同样
  **只由伪事务在无 `await` 的原子区段里调用**（`EarningRepository` 对外仍然只有读方法）。

### D9 延迟冲回：`serving` 部分退款时 Earning 还不存在

`serving` 订单**没有** `Earning`（`settleOrderCompletion` 的守卫要求订单已是 `completed`）。
所以「`serving` 部分退款 → 订单后来完成了」这条路上，冲回无处可写。处理：

- 冲回额**仍然在决策时算好并写进退款记录**（D1 的公式只需要订单快照，不需要 Earning 存在）；
- 结算时（`settleOrderCompletion` 建 Earning 的那一段）**补记**该订单所有已批准退款的冲回额：
  累加进新 Earning 的 `reversedAmount`，并逐条补写 `EarningAdjustment`；
- 若该订单**永远不完成**（`serving` 全额退款 → 订单直接 `refunded`），冲回就不会物化——
  这是正确的：`cmd_p0-13.md` 要求这种情况**不产生 completed Earning**，打手本来就没有收益可冲。

### D10 允许重复申请：`refundIdByOrder` 由单值改为多值

「累计 `refundedAmount`」「cumulative full refund 才 refunded」「同一 Earning 允许多次冲减」
（D-Q2 ④）三句都要求**同一订单可以有多条退款记录**，而现状是硬性的一单一记录
（`refundIdByOrder` 单值索引 + `createRefundRequest` 的 `order_already_has_refund` 拒绝路径）。
本次按 `lib/constants/refunds.ts` 里 `canRequestRefund` 注释**自己写下的那份计划**放宽：

> 「将来放开重复申请时，只需把这一条放宽成 `isActiveRefundStatus`」

- `canRequestRefund(status, hasActiveRefund)`：第二条入参语义由「有**任何**记录」改为
  「有**进行中**记录」；`REFUND_RECORD_EXISTS_MESSAGE`（「本阶段不支持重复申请」）随之删除；
- 仓储：`refundIdByOrder` → 多值索引，新增「取该订单最新一条」与「取全部」两个读法；
- **披露的行为变化**（产品验收时可否决）：已**拒绝** / 已**撤销**过的订单，此后也能再次申请。
  这不是新增规则，而是上述放宽的必然结果；若产品要求「被拒过就不再受理」，那是一条**新规则**，
  需要另行裁定，本轮不自行加。

### D11 `completed` 售后的投诉窗口：复用既有判定，不读当前配置

`completed` 订单的退款申请必须在**该订单冻结的** `complaintDeadlineAt` 之前提交。
复用 `lib/constants/complaints.ts` 的 `isComplaintWindowClosed(order, at)` **原样**：
它读的是订单快照、且无快照时不算关闭（历史订单不回填），因此天然满足
`cmd_p0-13.md`「必须使用订单冻结 deadline，不读取当前 PlatformConfig 追溯历史」。

### D12 全额退款终止履约；`actualCompanionId` 保留

累计退满 ⇒ 订单 `refunded`。此时：

- 关闭仍在开着的派单（复用 `applyDispatchTimedOut`——用户直接全额退款走的是同一个原语，
  本轮不另造一个「因退款关闭」的派单态，`DispatchState` 不扩）；
- 通知被退单的打手（复用 `REFUND_NOTIFICATION_COMPANION_REFUNDED` 的文案口径）；
- **`actualCompanionId` 保留**：批次硬约束「accepted direct refund 保留 `actualCompanionId`，
  不得为代码统一抹平」，`applyOrderRefund` 不碰它。

### D13 DTO 边界：决策六项只给管理端

| 端 | 给什么 | 理由 |
|---|---|---|
| 管理端 `AdminRefundDetail` | `decision` 全量六项 + 决策人/时刻 | D-Q1 ③ 要求决策「至少应能表达」这六项 |
| 客服端 `StaffRefundDetail` | **只给 `refundAmount`** | 客服要能回答用户「退了多少」（履职需要）；责任划分与平台承担额是**平台财务**，§10「客服只开放履职需要的信息」 |
| 用户端 `RefundDetail` | **只给 `refundAmount`** | 用户只关心退了多少，不该看到平台与打手之间怎么分 |
| 列表 DTO | `AdminRefundListItem` 增 `decidedAmount: number \| null` | 列表列名是「退款金额」，部分退款后只显示**申请时的实付快照**会误导 |

四处都**显式挑字段**（`api-contract.md` §2.5 硬约束），不是 `{ ...refund }`。

### D14 审计：沿用 `refund.approve`，把六项写进快照

不为「部分退款」新加审计动作：状态迁移仍是「批准」，只是金额不再是全额。
新增 `AdminAuditAction` 会让同一个迁移有两个动作名。做法是把决策六项加进
`toRefundAuditSnapshot` 的快照字段（既有五条审计硬边界不变：不存凭证、不存申请正文）。

### D15 客户端只传百分比；客户端不做金额算术

沿用商品表单的既有手法（`AdminProductForm` 传 `companionRatePercent`，服务端转 bp）：
管理端提交 `refundRatePercent` / `companionLiabilityRatePercent`（字符串），
服务端解析成 bp。~~**确认框不预览金额**~~ ——`architecture-rules.md` §三 禁止客户端做金额算术，
因此按钮文案只说「按 X% 退款，金额由系统计算」，实际金额在服务端返回后显示。
⚠️ **本条后半句已被 D19 取代**（2026-09-25 人工验收第 1 项整改）：管理端确认框**现在会实时显示**预计金额。
本条的**前半句继续有效**——客户端**仍然只传百分比**、**仍然不做金额算术**。
取代的方式见本文件 §十一 **D19**：预览调的是**服务端同一批纯函数**，不是客户端自己算。

### D16 本轮**不新增任何 Route**，也不扩枚举

决策走既有 `POST /api/admin/refunds/[id]/approve` 的请求体（D1/D2），
因此 `api-contract.md` 的接口总数不变、`tests/admin.test.mjs` 的后台接口清单门禁不变。
`OrderStatus` / `DispatchState` / `EarningStatus` 三个枚举**一个都不扩**（Q2-c 已裁定用既有 `reversed`）。

### D17 `withdrawn` 不冲回：Q3 DEFER 的落点

`Earning.status === "withdrawn"` 时**不做任何冲减**，冲回额按 0 记，
多出来的部分由平台承担。理由是 Q3 明确 DEFER「已提现追回」——若照常冲减，
写到「已提现」的收益上就等于**追回已提现的钱**，正是本轮被划出去的那件事。
`withdrawn` 在 P0 无写入路径（不可达），但这条规则要写下来并用例钉住边界在哪。

> 📌 **D18 起是 2026-09-25 只读审查后的整改记录**（追加，不覆盖上面任何一条）。
> 审查发现一条**资金 BLOCKER**（B-1），它正是 D3 那句错推理的后果。

### D18 整改 B-1：「本次增量」的两条全额路径必须传**差额**，且写入器自己钳一次

#### 缺陷是什么

D3 把 `applyOrderRefund` 的第三个参数改成「本次增量」，却在 D3 里断言
「两个既有调用方都发生在『累计已退 = 0』的订单上，因此行为不变」。
**这个前提在 P0-13 自己的规则下不成立**：

- 部分退款**不改订单状态**（本文件 §十.一 第 12 行）；
- P0-11 的「客服回池 / 打手取消」把订单打回 `paid`，且**不碰 `refundedAmount`**。

两条合起来造出一个此前不存在的状态：**一张「累计已退 > 0、状态是 `paid`」的订单**。
而「未开始服务 ⇒ 退全额」的两条路径（用户直接退款、公共池超时自动退款）
判的都是**状态**，于是都会作用在它身上，各传 `actualPaidAmount` 全额作为**增量**：

```text
已退 300（部分退款） + 传 1000（实付全额） = 1300  >  actualPaidAmount 1000
```

**退出去的钱超过实付**，直接违反 `EX-REFUND-02` 与 `cmd_p0-12.md:40` 冻结的
「累计 `refundedAmount` 不得超过实付」。

触发链**全程是合法 UI 操作，不需要改数据**：售后退 30% → 客服回池 → 用户点直退
（或公共池到点被清扫）。整改前这一格**零用例覆盖**，门禁不会红。

#### 整改：两道，都要

| # | 落点 | 做法 |
|---|---|---|
| 1 | `lib/data/directRefundTransaction.ts` | 传 `order.actualPaidAmount − order.refundedAmount`（本次应退的增量） |
| 2 | `lib/data/companionDispatchTransaction.ts` | 同上，差值在**计划阶段**捕获进 `plan`（原子区段里不能再读存储） |
| 3 | `lib/data/mockPaymentRepository.ts` | 写入器**自己钳一次**：`next = 已退 + max(0, min(传入, 实付 − 已退))` |

第 3 条是关键：`refundedAmount` 的**唯一写入点**就是 `applyOrderRefund`，
把钳制放在那里，`0 <= refundedAmount <= actualPaidAmount` 就从
「每个调用方自己记得算对」变成**结构性**的。第 1、2 条是让**意图**在调用点可见，
不是可以省掉第 3 条的理由；第 3 条也不是可以少改第 1、2 条的理由。
这与 D4 那次钳制同一条思路：不变式要落在唯一真值源上，再在调用点写明意图。

#### 连带：用户看到的金额

`canDirectRefund` 按**状态**给，回池后入口仍然（正确地）出现，但可退的只剩差额——
按实付播报会报出一个**到不了账的数**。因此：

- `OrderAllowedActions` 增 `directRefundAmountCents` / `alreadyRefundedAmountCents`（服务端算好，**客户端不做减法**，`architecture-rules.md` §三）；
- `DirectRefundButton` 报的是**本次退回多少**，已部分退过时补一句差额的来源。

#### 回归用例

`tests/refundMoneyChain.test.mjs` 第八节，三条：

1. 部分退款 → 客服回池 → 用户直退：`refundedAmount` **恰好**等于 `actualPaidAmount`；
2. 部分退款 → 客服回池 → 公共池超时清扫：同上；
3. 写入器护栏：调用方按「实付全额」当增量传，累计仍不超过实付。

前两条**在整改前是红的**（已用变异验证：还原两处调用点后两条同时失败），
因此它们钉的正是这个缺陷本身，不是「改完之后顺手补的一条」。

#### 口径需要产品追认

「部分退款过的订单再走全额直退时，退**剩余额**」这条组合口径，
`cmd_p0-12.md` 与 `cmd_p0-13.md` **都没有写**（P0-12 只写了「未全额退款」这个前置，
没写「部分已退」怎么办）。之所以按「退剩余额」实现而不按「挡住入口」：

- 公共池超时的自动退款是 P0-5 的冻结规则，**没有「拒绝」这一支**——
  它必然会把这一单退到实付为止。若直退选择「挡住」，同一张订单的两条路径就会互相矛盾；
- 该路径自己的名字与通知文案都是「**全额**退款」，「退到实付为止」才让它成立。

⚠️ 但它仍然是一次**未冻结的组合口径**，按 P0-12 R1/R2 的先例登记为**待追认**，
见 `04-acceptance.md` §五。若产品裁定「部分已退就不再给直退入口」，
那是**改实现**（改 `canDirectRefund` 的资格判据 + 原子区段 Guard），不是改文档。

---

> 📌 **D19 起是 2026-09-25 人工验收第 1 项整改的记录**（追加，不覆盖上面任何一条）。
> 它**显式取代 D15 的一半**：取代的是「不显示」，不是「另一套公式」。

### D19 整改（验收第 1 项）：显示口径 + 实时金额预览，取代 D15 的「不做预览」

#### 验收方的原话（照录要点）

> 「当前『管理员输入退款比例』功能本身可以正常使用，但退款比例的业务语义和界面反馈
> 不够清楚。」「请先不要直接修改口径，先检查当前代码和现有文档，明确回答……」
> 提出 A/B/C/D/E 五项整改要求，其中 D 是
> 「管理员修改退款比例时，本次预计退款金额必须立即更新，**不应等提交后才知道金额**」。

#### 检查结果（先回答口径，再动手）

| 问题 | 当前代码的真实口径 |
|---|---|
| 30% 的基准是什么 | **用户实际支付金额**（`Order.actualPaidAmount`）。`refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`。**不是**订单原价，**不是**打手收益 |
| 有优惠 / 增值服务 / 已部分退款时基于哪个金额 | 增值服务**进**原价也**进**分账基数（R3 已确认）；券当前恒为 0，但实付的定义是「原价 − 券」，将来有券则实付 < 原价，**基数跟着实付走**；**已部分退款不改变单次的基数**——基数始终是 `actualPaidAmount`，已退只在**累计闸**（`assertRefundAmountWithinPaid`，用 `order.refundedAmount`）里起作用 |
| 「按比例分担」是什么 | 分担**本次退款金额**，双方是**平台与打手**。但打手那一条腿的基数是**打手收益**（`companionBaseIncome`）而不是退款金额：`floor(companionBaseIncome × refundRateBp × liabilityBp / 10000 / 10000)`，再钳制在 `companionBaseIncome − reversedSoFar` 以内；平台腿是**余数** `refundAmount − companionReversalAmount`，**可以为负**。因此「责任比例 40%」**不等于**「打手承担退款金额的 40%」 |

#### 决定：D15 的「不显示」被取代，「只有一份公式」不变

D15 原文（保留在上面）里有两件事，必须分开看：

1. **「客户端只传百分比、不传金额」**——**继续成立**，一个字不改。
   请求体里仍然没有接收金额的字段，金额一律由服务端算。
2. **「确认框不预览金额」**——**由本 D19 取代**。

取代的理由是验收方的那句话：不显示金额，管理员就答不出
「最终会退多少钱」「各方收益会因此减少多少」这两个问题，
只能先提交再看结果——而通过是**不可撤销**的。

⚠️ **`architecture-rules.md` §三 第 9 条那条纪律的实质被重新表述**：
它要禁止的是「**存在第二份金额公式**」，不是「把服务端算出来的数显示给人看」。
因此实施方式是：

- 界面上的预计金额由 `previewRefundDecisionAmounts()`
  （`lib/constants/adminRefunds.ts`）计算；
- 该函数**只做两件事**：调用**服务端写入路径上的同一对函数**
  （`computeRefundDecisionAmounts` → `resolveFinalDecisionAmounts`），
  以及把服务端的金额闸 `assertRefundAmountWithinPaid` 问一遍；
- **组件文件里搜不到任何一个金额运算符**（没有 `× 比例 / 10000`）。
  这是这条纪律唯一可执行的验收方式。

#### 为「同一份公式」而做的两处抽取（都是消除重复，不是新规则）

| 抽取出来的函数 | 原来在哪重复 | 现在 |
|---|---|---|
| `sumApprovedCompanionReversal()`（`lib/constants/refunds.ts`） | 只在写入路径上内联了一段 `filter(approved) + reduce`；读取侧要显示「已冲回」就必须再抄一遍 | 写入路径与详情 DTO **同一个函数** |
| `resolveFinalDecisionAmounts()`（同文件） | D17 的「已提现不冲回」原来写成 `earning?.status === "withdrawn" ? 0 : …`，只存在于写入路径 | 写入路径与界面预览**同一个函数** |

#### 界面改了什么

| 要求 | 落点 |
|---|---|
| **A** 说清退款比例的**基数** | `ADMIN_REFUND_DECISION_RATE_BASE_NOTE`，紧贴比例输入框 |
| **B** 说清「按比例分担」是谁和谁、基数是什么 | `REFUND_RESPONSIBILITIES` 的 `hint` 改写：**每个选项直接写出冲回公式**，并显式写「乘的是打手收益，不是退款金额」；分摊制的额外一句 `ADMIN_REFUND_DECISION_SHARED_NOTE` |
| **C** 实时展示订单金额信息 | 新增 `AdminRefundOrderMoney`（`lib/types/refund.ts`）+ `AdminRefundDetail.orderMoney`；详情页新增「订单金额（退款比例的基准）」一段，确认框内也有同一张表 |
| **D** 改比例时预计金额立即更新 | 确认框内 `DecisionPreview`：每次渲染调用 `previewRefundDecisionAmounts()`（纯函数，无防抖必要）；确认按钮文案同时改为「按 X% 退款（预计 ¥Y）」 |
| **E** 无需理解代码即可回答 5 个问题 | `ADMIN_REFUND_DECISION_QUESTIONS`（常量，详情页直接列出；确认框内以 `<details>` 折起，需要时展开） |

#### 顺带修掉的

- `AdminConfirmDialog` 新增可选 `size`（`md` 默认 / `lg`）与**面板内滚动**
  （`flex-col + max-h-full` + 中间区 `overflow-y-auto`）：不加这一条时，
  内容一长，确认按钮会被推到视口外——而它正是这个框存在的理由。
  `md` 仍是默认值，既有调用方排版不变。
- 详情 DTO 新增两个**只给管理端**的字段（`companionEarningStatus` 与 `reversedSoFarAmount`）：
  少了它们，界面会对一笔已提现的收益显示「预计冲回 ¥X」，而服务端实际写下去的是 0。
- D17 的 `withdrawn` 在 P0 **仍无写入路径**（不可达），因此它的界面表现
  （`ADMIN_REFUND_PREVIEW_WITHDRAWN_NOTE`）与纯函数用例一起钉住，
  但它**不会**在人工验收里出现——验收时不必去找这个状态。

#### 回归用例

`tests/refundMoneyChain.test.mjs` §十 新增 8 条（总计 **1385** 用例 / fail 0）：

1. `resolveFinalDecisionAmounts`：只有 `withdrawn` 改写；`null`（`serving` 无收益，D9）
   与三个正常状态**原样返回**；改写后恒等式仍成立；
2. `sumApprovedCompanionReversal`：只认 `approved`、多笔累加、容忍 `decision: null`；
3. 详情 DTO 的 `orderMoney` 与服务端累计一致（`remaining = paid − refunded`）；
4. 退过一次之后剩余可退与已冲回跟着变；
5. **预览与服务端写下去的金额逐项相等**（三种责任归属各一次，比对
   响应里的 `decidedAmount` 与落库的 `decision` 三个字段）；
6. 预览的 `exceedsPaid` 与服务端金额闸是**同一个判断**（同一组入参，一边报 true、一边 400）；
7. 预览的四种失败态各自给出规则层的原话（比例缺失 / 未选责任 / 分担缺责任比例 / 非分担带了责任比例）；
8. 预览在 `withdrawn` 下冲回 0、在钳制下不超过剩余可冲回额。

⚠️ 第 5 条是这一节存在的理由：它一旦红了，就说明**界面上的预计金额与账上的钱
不是同一个公式算出来的**——而那正是本次整改要消灭的歧义。

#### 口径需要产品追认

本次整改**没有改动任何业务规则**，只改显示与文案，因此不需要追认。
但有一处**新增的展示口径**要说明它是怎么来的：

- 「冲回后打手剩余收益（预计）」= `companionBaseIncome − reversedSoFar − 本次冲回`。
  它是 Q2-a 那条 `netAvailableAmount = incomeAmount − cumulativeReversalAmount`
  的直接展开，**不是**新建的余额桶（Q2-a 明令不建桶）。
