# P0-15 — 交付记录

Round ID: P0-15
Title: **一个订单只退一次** + 退款批准后打手收益**整笔**归零 + 结算冻结闭环钉死
Status: **`AWAITING_ACCEPTANCE`**（⚠️ Claude 不得自行 `DONE`）
基线: `HEAD = c2c9360`（`fix(p0-13): paid/accepted 不允许批准售后退款申请（服务端状态闸 + 读侧同口径）`）
分支: `feat/order-lifecycle-alignment`
交付时点: 2026-09-28

> ⚠️ 本批次**禁止任何 Git 写操作**。因此本文件「Git 状态」一节记录的是**只读观测结果**，
> `Git Commit` 一栏留空是该时点的**正确状态**，不是遗漏。
> ⚠️ 工作区是**混合未提交**的：`P0-14` 与 `P0-15` 两轮都因「禁止 Git 写操作」而未提交，
> `git diff` 无法区分两者。本文件列出的文件清单是**按内容归属**归到本轮的。

---

## 一、一句话，以及这一轮真正难在哪

**把「一次订单可以被多次部分退款、每次按责任比例冲掉打手一点」这套模型，
换成「一次订单只退一次、退了就把打手这一单的钱全部取消」。**

「删掉多步退款」「删掉责任模型」本身不难——难的是**删掉之后状态机还站得住**。

原来的模型里，「打手这一单白干了」有一个**专属状态**（`reversed`）来表达。
新规则一来，退款批准这件事**必须发生在结算冻结期内**（②§五：正常业务设计保证
退款处理完成之前收益根本进不到可提现阶段），于是产品把 `Earning.status`
**钉在 `frozen`**（②§四 / §十(8)）。

这一钉，产生了本轮**唯一的真问题**：

> `frozen` 这个状态**同时**表示「正常冻结中，到期会解冻」和「已被退款冲光，永远不会解冻」。
> 于是释放判据如果只看「状态 + 时间 + 无阻塞」这三件事，**被冲光的那笔收益照样会被放行**——
> 一笔净额为 0 的收益变成「可提现」，指令 ②§十(10)「refund approved 后不得再释放该 earning」当场落空。

**裁定与落地见 §2.4。** 这是本轮最需要人工验收确认的一条。

---

## 二、实现内容

### 2.1 被删除的东西（**不是 DEAD CODE，是从类型里删掉**）

| 被删除 | 原先是什么 | 删除依据 |
|---|---|---|
| `RefundDecision.responsibility` | `platform` / `companion` / `shared` 三选一 | ①§五 |
| `RefundDecision.companionLiabilityRateBp` | 只有 `shared` 才有值的打手责任比例 | ①§五 |
| `RefundDecision.platformBorneAmount` | 本次退款里平台承担了多少 | ①§四 |
| `EarningAdjustment.responsibility` | 同名字段（原 P0-13 D12 打算「保留不填」，本轮**改为删除**，见 `02-decisions.md` D18） | ①§五 |
| `refundFullRemaining` | 「退满剩余」一等公民（P0-14 为**多步退款的尾差**而引入） | ①§一 / ①§二：一单一退 ⇒ 尾差不存在 |
| 累计退款的一切 | 「同一 Earning 允许**多次**冲减」「累计冲满才 `reversed`」 | ①§一 / ①§九 |

**理由（D18）**：本仓**没有真库、没有历史持久化数据**，「历史明细要能读」这个前提不存在。
留一个恒为 `null` 的字段只会误导下一个人去给它赋值。字段**整体删除**，
在类型文件里留一句墓碑注释说明它为什么不在（`lib/types/refund.ts:48-51`、
`lib/types/earning.ts:2` / `:178`）。

### 2.2 一单一退：硬约束在**仓储的原子区段**里，不在界面

两层，第二层才是真正生效的那一层：

| 层 | 位置 | 作用 |
|---|---|---|
| 纯函数（**提前**给界面好提示） | `lib/constants/refunds.ts:397 canRequestRefund(status, hasRefundRecord)` | 订单状态可退 **且** 这一单**从来没提交过**申请 |
| **仓储原子区段（真正生效）** | `lib/data/refundRepository.ts` 约束 1 · `lib/data/mockRefundRepository.ts` | 创建申请时，**同一订单已有任何一条申请**即拒绝（`order_already_has_refund`），并把既有那条返回给调用方 |

**「任何一条」= 不看状态**：待审核 / 审核中 / 已通过 / 已拒绝 / 已撤销**全都挡**。
这是产品裁定「提交过即封死，一次机会」（`02-decisions.md` Q2），
已知后果「管理员拒一次，用户此单再无退款渠道」是**被看见并被接受**的。

⚠️ **形参名在 P0-13 与 P0-15 之间来回改过一次，这不是笔误**——
P0-13 叫 `hasActiveRefund`（只挡进行中的，为让部分退款能退第二次），
P0-15 改回 `hasRefundRecord`。名字必须跟着语义走：叫 `hasActiveRefund`
而让调用方传「有没有任何记录」，下一个人会照着名字去传 `isActiveRefundStatus(...)`，
于是**被拒绝的申请又能再申请一次**——一个只在名字上错的分叉。
该表格写死在 `lib/constants/refunds.ts:372-382`。

**三条退款写入路径**（直退 / 售后台审 / 公共池超时）**全部**汇到
`lib/data/mockPaymentRepository.ts` 的 `applyOrderRefund`，没有第四条。

### 2.3 收益整笔归零，**与退款比例无关**

`lib/data/mockEarningRepository.ts:246 applyEarningReversal`：

```
nextReversed = min(max(0, earning.reversedAmount + amount), earning.incomeAmount)
```

退款批准时传入的 `amount` **恒等于 `incomeAmount`**（`companionReversalAmount`），
因此 **10% 与 100% 的退款在收益侧的结果完全相同**：`reversedAmount = incomeAmount`，净额 0。

- `Earning.incomeAmount` **不变**——它是不可变的历史承诺额快照（①§三）；
- 冲销表达为**一次** `EarningAdjustment`（幂等键 `refundId`）；
- 平台最终净收入 = `actualPaidAmount − refundAmount`，**不存字段**，由订单与退款额直接算出。

### 2.4 ⚠️ 本轮最关键：状态停在 `frozen`，靠**净额闸**挡住释放（Q5 裁定）

`Earning.status` **不进入 `reversed`**，退款批准后**停在 `frozen`**
（①/②权威文本逐字，见 `02-decisions.md` §二 Q5）。

**为什么必须再补一道闸**：`frozen` 现在是一个**二义**状态——
「正常冻结中」与「已被冲光」共用它。释放判据若只答「状态是 `frozen` 吗、
到点了吗、有阻塞吗」，第二类会被**放行成可提现**，与 §十(10) 直接冲突。

落地四处，缺一处这道闸就是漏的：

| # | 落点 | 内容 |
|---|---|---|
| ① | `lib/constants/earnings.ts:154 isEarningFullyReversed({incomeAmount, reversedAmount})` | `reversedAmount >= incomeAmount`。**这是这条规则的唯一定义** |
| ② | `lib/data/mockEarningRepository.ts:264`（冲销写入器） | 整笔冲完 ⇒ 状态写回 `frozen`（**不是** `reversed`） |
| ③ | `lib/data/earningTransaction.ts:327`（`sweepMaturedEarnings` **计划层**） | 第三条 `if (isEarningFullyReversed(earning)) continue;` |
| ④ | `lib/data/mockEarningRepository.ts:126`（`applyEarningRelease` **存储层**兜底） | 净额已归零 ⇒ 原地返回，不改任何字段 |

**③ 和 ④ 不是重复，④ 也替代不了 ③**，这一点已用**受控 mutation 红-绿证伪**验证过（见 §3.3）。

**顺带必须改的一处**：`EARNING_STATUS_HINTS.frozen` 那句
「订单已完成，收益正在冻结期内，到期自动转为可提现」在「已被冲光」的那笔上是**假话**。
但状态区分不了这两者 ⇒ 打手看到的逐条说明改由
`lib/constants/earnings.ts:94 earningHintFor({ status, netAmount })` 按**净额**产出，
页面（`components/companion/CompanionEarningList.tsx:110`）不再自己拼这句话。
`withdrawn` **刻意排除在净额判断之外**：本阶段不可达，而真到可达那天，
「已提现的收益后来又归零」是一套新规则，不该在这里顺手替它选一句话。

> ⚠️ **编号注意**：`docs/03-dev/rounds/P0-15/02-decisions.md` 里 **D8**（原先写
> 「退款成功后 `Earning.status = "reversed"`」）**已被 Q5 推翻**，只作为判断痕迹保留。

### 2.5 结算释放的**唯一**条件：三条同时成立

```
到期 (isEarningMatured)
  && 无阻塞 (isCompletionAutoApprovalBlocked(readOrderBlockingFacts(orderId)))
  && 净额未被冲光 (!isEarningFullyReversed(earning))
```

第 ①② 条是 P0-9 已有的；**第 ③ 条是本轮补的**。
这三条**只在 `lib/data/earningTransaction.ts` 的 `sweepMaturedEarnings` 里拼一次**，
判据本身各自是纯函数（`lib/constants/earnings.ts` / `lib/constants/completions.ts`），
没有第二处副本。

### 2.6 并发保护：靠「单一原子区段」，**本轮零代码改动**

②§六 要求「释放事务必须在**同一原子业务区域**内、执行 `frozen → available` **之前**
重新确认 deadline / 无退款 / 无投诉 / 无阻塞」。

**结构上已经成立**（`02-decisions.md` D14 / D19）：`sweepMaturedEarnings` 是
「**先只读地列计划、再逐条提交**」两段式，两段之间**没有 `await`**
（`lib/data/earningTransaction.ts` 全文件零 `await`），因此在 Node 单线程模型里
这个函数对 mock store 是**原子的**——退款提交不可能插进「计划」与「提交」之间。

⇒ 本轮的活是**补测试把它钉死**，不是重写（`tests/refundOnePerOrder.test.mjs` 的并发用例）。

### 2.7 投诉窗口：**早已实现**，②§一 是**文档纠偏**

`PlatformConfig.complaintWindowMinutes` **已于 P0-9 落地**（默认 1440、范围 60~10080）：

- `settleOrderCompletion()` 是**唯一写入者**：订单 → `completed` 的同时冻结
  `Order.complaintWindowMinutesSnapshot`、算出 `complaintDeadlineAt`，
  并建一条 `frozen` 的 Earning；
- `Earning.availableAt` **直接复制**该 deadline，**不另加一次分钟数**；
- **不追溯**：改配置只影响**之后**完成的订单，历史订单的 deadline 是已写下的事实（P1-2 快照语义）。

全库普查确认：权威文档与代码里**没有**「固定两天 / 48 小时」的硬编码残留
（唯一一处 `业务流程表.md:701` 写的正是「**不再**把 48 小时写死」，是纠偏后的正确表述）。

### 2.8 订单状态与打手展示状态**分离**

- **部分退款**：`Order.status` **保持真实生命周期**，不因为打手收益归零而变成 `refunded`；
  打手端的「已退款」是**派生展示值**（`lib/constants/orders.ts resolveCompanionDisplayStatus`），
  永久显示（Q3 裁定），并显示「本单收益 ¥0」；
- **全额（100%）退款**：`Order.status = "refunded"`；
- **聊天**：是否可写**只看真实订单生命周期**——
  `isOrderChatClosed(orderStatus)` = `orderStatus === "refunded"`。
  ⇒ 部分退款**不会**因为打手端显示「已退款」而提前关闭聊天（②§八）。

### 2.9 顺带修掉的一个用户可见缺陷（不是重构，是 bug）

管理端退款决策的**实时预览**原先复用了一个名为 `ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE`
的布尔标志，但**「超过实付」与「有闸未过」被塞进了同一个字段**。
结果是填 `0%`（或任何被闸拦下的输入）时，界面会显示「退款金额超过订单实付金额」——
**用户看到一句与事实无关的话**，且它正好长在本轮负责的那条流程上。

修法：把布尔换成**闸自己的那句话**（`RefundDecisionPreview` 的 `gateMessage`），
预览与提交**共用同一份文案常量**（`REFUND_DECISION_EXCEEDS_PAID_MESSAGE`），
从结构上消除「预览说 A、提交说 B」。同一常量补上了**补救方向**
（「填 100 表示全额退款」）——多步退款废止后 `100%` 是一个**真正的出路**，不再只是「你自己再想想」。

### 2.10 本轮改动集合

**代码（按内容归属本轮的，共 25 个文件）**

| 层 | 文件 |
|---|---|
| 纯规则 / 常量 | `lib/constants/earnings.ts` · `refunds.ts` · `adminRefunds.ts` · `orders.ts` · `completions.ts` · `adminAudit.ts` |
| 类型 | `lib/types/earning.ts` · `refund.ts` · `order.ts` |
| 仓储 / 事务 | `lib/data/mockEarningRepository.ts` · `earningTransaction.ts` · `adminRefundTransaction.ts` · `mockPaymentRepository.ts` · `mockRefundRepository.ts` · `refundRepository.ts` · `orderBlocking.ts` · `companionDispatchTransaction.ts` |
| 服务端服务 | `lib/services/adminRefunds.ts` · `companionEarnings.ts` · `refunds.ts` · `adminHttp.ts` · `companionOrders.ts` |
| 路由 | `app/api/admin/refunds/[id]/approve/route.ts` |
| 界面 | `components/admin/AdminRefundConsole.tsx` · `components/companion/CompanionEarningList.tsx` · `CompanionOrderCard.tsx` · `app/companion/(console)/earnings/page.tsx` · `orders/[id]/page.tsx` · `app/admin/(console)/refunds/[id]/page.tsx` |
| 种子 | `lib/mocks/fixtures/refundSeed.ts` |

**测试（新增 2 个文件 / 改动 5 个文件）**

| 文件 | 内容 |
|---|---|
| `tests/refundOnePerOrder.test.mjs` | **新增** · **27** 条 · 一单一退的硬约束：**申请侧**提交即封死 + **执行侧**三个出款入口共用同一判据、重复批准幂等、并发不误释放<br>⚠️ **交付前审查发现这里原先是 22 条、且只覆盖申请侧**（MAJOR-1）——「三条退款路径都封死」那句话当时是**不成立的**，见 §五。第二轮复核后又加 1 条（实付 0 的坏单子，D21.2）并把「判据一致性」那条改成断言**恒等**，共 27 条 |
| `tests/earningSettlementFreeze.test.mjs` | **新增** · 15 条 · 投诉窗口快照 + `frozen` 冻结期 + 释放三条件 + 净额闸边界 |
| `tests/refundMoneyChain.test.mjs` | 改动 · 37 条 · `preview.gateMessage` 口径 + 冲销后状态 `frozen` + 并发用例加强 |
| `tests/adminRefundDecisionBody.test.mjs` | 改动 · 4 条 · 请求体只有 `refundRatePercent` 一个字段 |
| `tests/refunds.test.mjs` · `tests/adminRefunds.test.mjs` · `tests/companionOrders.test.mjs` | 改动 · 一单一退与展示状态同口径 |

**文档（当前规则口径，共 8 个文件）**：`docs/02-tech-design/architecture-rules.md` ·
`api-contract.md` · `database-schema.md` · `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` ·
`超哥电竞_用户权限表.md` · `docs/03-dev/需求功能点进度表.md` · `docs/03-dev/总需求进度表.md` ·
`docs/03-dev/rounds/P0-13/02-decisions.md`（**只加批注**）

> ⚠️ **历史 Round 文档只可批注、不可改写**。`P0-13` / `P0-14` 里当时真实的旧讨论
> **保留原样**，只在**当前规则**文档里以 `⛔ 已被 P0-15 覆盖` 的形式追加。

---

## 三、门禁读数（2026-09-29 实跑，**本轮最终树**）

### 3.1 最终读数

| 门禁 | 命令 | 读数 | 结论 |
|---|---|---|---|
| 定点 | `node --test tests/refundOnePerOrder.test.mjs` | tests **27** · pass **27** · fail **0** | ✅ |
| 离线测试 | `pnpm test` | tests **1568** · pass **1400** · fail **0** · cancelled 0 · **skipped 168** | ✅ |
| **生产全量** | `APP_BASE_URL=http://localhost:3106 pnpm test` | tests **1568** · pass **1568** · fail **0** · **skipped 0** | ✅ |
| 类型 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | 无输出，exit 0 | ✅ |
| Lint | `pnpm lint`（ESLint CLI） | 无输出，exit 0 | ✅ |
| 构建 | `pnpm build` | exit 0 | ✅ |

> **「skipped 168」是什么**：离线跑（没有 `APP_BASE_URL`）时，**HTTP 契约层**的用例
> 会自我跳过——它们需要一台真的在跑的生产服务。生产全量那一行 **skipped 0** 就是它们。
> 两行**都要看**：只看离线那行会把 168 条真实断言当成「通过」。

**生产服务生命周期（如实记录，2026-09-29 最终复跑）**：
`APP_BASE_URL=http://localhost:3106 PORT=3106 pnpm start` → **PID 3920** 监听
→ 全量跑完（1568/1568/0/0）。
**这次杀掉的是上一轮那台 PID 4716**（它服务的是**旧构建**，留着就会「测到旧进程」）：
`taskkill //F //T //PID 4716` 后 `netstat -ano | grep :3106` **无输出**，
端口确认释放后 PID 3920 才起。
更早一轮的 PID 28028（2026-09-28）同样记录在案。**三次都没有出现「测到旧进程」的读数**。

### 3.2 用例数沿革

| 时点 | tests | pass（离线） | fail | skipped |
|---|---|---|---|---|
| P0-13 收口（`c2c9360`，本批次基线） | 1385 | 1239 | 0 | 146 |
| P0-14 收口 | 1446 | 1290 | 0 | 156 |
| P0-15 初版（MAJOR-1 修正**之前**） | 1563 | 1395 | 0 | 168 |
| P0-15 交付（MAJOR-1 修正之后） | 1567 | 1399 | 0 | 168 |
| **P0-15 交付（第二轮复核 2 MINOR / 2 NOTE 处置之后，本文件）** | **1568** | **1400** | **0** | **168** |

### 3.3 净额闸的**受控 mutation 红-绿证伪**

新加的闸必须证明「拿掉它测试会红」，否则它可能是一条恒定放行的废码。
**前两次探针针对净额闸（Q5 裁定），第三、四次针对 D20 的一单一退执行侧闸，第五次针对 D21.2 的实付 0 闸**：

| 探针 | 动了什么 | 结果 |
|---|---|---|
| 1 | **两道闸一起拿掉**（计划层 ③ + 存储层 ④） | **恰好 2 条失败** |
| 2 | **只拿掉计划层 ③**，保留存储层 ④ | **同样 2 条失败**，且失败断言落在 `releasedEarningIds` 上 |
| 3 | **一单一退的执行侧闸拿掉**（`directRefundTransaction` guard ③ 改回 `>= actualPaidAmount`，并把 `buildRefundActions` 的新条件去掉） | **恰好 1 条失败**：「规则1（执行侧 1/3）」的 `canDirectRefund` 断言 |
| 4 | **公共池超时的计划层闸拿掉**（`refundAmount` 恒为数值 + 通知条件改回 `status !== "refunded"`） | **恰好 1 条失败**：「规则1（执行侧 2/3）」的 `refundedOrderIds` 断言 |
| 5 | **实付 0 闸拿掉**（`refundDue` 去掉 `&& order.actualPaidAmount > 0`） | **恰好 1 条失败**：「规则1（执行侧 4/4）」的 `没退成就不许报成退过` 断言（`actual: true, expected: false`） |

探针 2 是**关键证据**：它证明了 §2.4 里写下的那句警告是真的——
`applyEarningRelease` 在存储层静默拒掉一个 id 时，`sweepMaturedEarnings` 的返回值
仍然来自**计划清单**，那个 id **照样出现在 `releasedEarningIds` 里**，
调用方会以为释放成功了。⇒ **存储层兜底替代不了计划层判据**，两处都必须有。

### 3.4 净额闸的边界与正对照

`tests/earningSettlementFreeze.test.mjs` 的「退款 10b」同时钉了**边界**与**正对照**：

- `reversedAmount` = `0` / `3671` / `3672` / `9999`（对 `incomeAmount = 3672`）
  → `false` / `false` / **`true`** / `true`（`>=`，不是 `==`）；
- `earningHintFor` 在 `{frozen, 0}` 上给「这一单已退款」那句，在 `{frozen, 3672}` 上给正常那句；
  ⚠️ 这一句**不能**写成「已全额退款」（MAJOR-2/MINOR-1）：10% 的退款也会显示它，
  而那时订单并没有全额退款——措辞必须同时成立在部分退款与全额退款上；
- 同组用例还断言了 **`before.availableAt === deadline`** 与
  **`readOrderBlockingFacts(orderId).hasActiveRefund === false`**——
  没有这两条正对照，「到点了也没释放」可能是**因为别的原因**，用例会**为错误的理由变绿**。

---

## 四、本轮**没有**做的事（明确声明，避免被读成遗漏）

| 不做 | 依据 |
|---|---|
| 钱包 / 余额桶 / 负余额 / 应收账 / 未来收益抵扣 / 对打手追偿 | ②§五：普通退款业务下 `withdrawn` **结构上不可达**，因此**不设计**（不是「暂时 DEFER 一笔未决业务」） |
| 「结算完成、甚至已提现后由后台强制退款」 | ②§五：那是一条**新的特殊财务业务**，需单独设计（含钱包 / 负余额 / 抵扣 / 追偿与并发护栏） |
| 真 Scheduler | 仓库无调度器；`sweepMaturedEarnings` 是**读路径上的惰性物化**。P0-9 起就是**上线前 production blocker**，不是本轮遗漏 |
| 修改 `P0-13` / `P0-14` 的历史裁定正文 | 历史 Round 文档**只可批注、不可改写** |
| `P0-15` 标 `DONE` | ⚠️ **Claude 不得自行 `DONE`** |
| 改 `P0-14` / `P1-1` / `P1-2` 的状态 | 三条**全部保持 `AWAITING_ACCEPTANCE`** |
| 开始 `P1-3` | 明文禁止 |
| 任何 Git 写操作 | 明文禁止（`git add/commit/push/reset/restore/checkout/rebase/amend` 一律未执行） |

---

## 五、reviewer 结论

**本轮交付前经 `reviewer-agent` 只读审查**（范围：退款 / 收益 / 结算链条，
对照 `01-prompt.md` 逐字规则与 `02-decisions.md` 的 Q1–Q5 / D5–D21）。

**结论：`0 BLOCKER` / `0 MAJOR` / `2 MINOR` / `3 NOTE`。**

reviewer 同时独立确认了本轮的核心是对的：仓储层唯一性、冲回额与比例无关、
金额公式只有一份、三条释放判据口径一致、快照不被追溯覆盖、DTO 不泄漏、
所有原子区段内**没有真实 `await`**。

**⚠️ reviewer 对上一轮自评结论的态度，必须如实记录**：它明确写下
「`03-delivery.md` 里『0 BLOCKER / 2 MAJOR / 4 MINOR / 4 NOTE 全部修复』是**自我声明**，
我按代码独立核对后**不背书**其中每一条」。也就是说 §5.1–§5.4 里那 10 条
是**自评**，本节 5.5 的两条 MINOR 才是**独立复核**的产物。
两轮之间没有冲突（复核没有推翻自评的任何一条结论），但性质不同，不能混为一谈。

### 5.5 第二轮复核的 2 MINOR / 3 NOTE（全部已处置，D21）

两条 MINOR **都是注释与代码不一致，无行为缺陷**；但我没有按「改注释」处理——
不一致本身暴露的是一个定义缺口。处置与理由见 `02-decisions.md` **D21**：

| 意见 | 处置 |
|---|---|
| MINOR-1 `refunds.ts` 注释称调用点都写并集，而 `companionDispatchTransaction` 写的是**替代式** | 升级为**并集** + 新增单点定义 `isRefundExecutionClosed`（D21.1）；`tests/refundOnePerOrder.test.mjs` 的 3/3 门禁改为**逐文件钉死该引用哪一个判据**，并新增两条反例（不得自写 `refundedAmount > 0`、不得自拼 `status === "refunded" \|\|`） |
| MINOR-2 `adminDashboard.ts` 「同一订单可以有多条（部分退款不再是一次性的）」为假 | 已改写为「至多一条」，并说明遍历留着是守**本函数自己的口径**（按 `decidedAt` 归日）；顺带修正了我第一版改法里的一处**新错误**（见 D21.3） |
| NOTE 实付 0 的坏单在计划层会被算成 0 元退款、再由存储层静默拒掉 | **修代码**（D21.2）：计划层加 `actualPaidAmount > 0`；新增 `规则1（执行侧 4/4）` 并用例内**直接构造**该状态 |
| NOTE 「部分退款后仍可能进公共池超时」是否需产品决定 | **不上交**（D21.3）：①§一/§八 已写死「只出一次款」，`refundDue` 使结果正确，关池照发生。属技术组织问题 |
| NOTE `ORDER_TRANSITIONS` 已实现（旧前提过时） | 已核对为真；`architecture-rules.md` 差距表中相关表述本轮已改正 |

**红-绿证伪（新增，§3.3 探针 5）**：去掉 `&& order.actualPaidAmount > 0` 后
**恰好 1 条**失败，失败断言正是那句 `没退成就不许报成退过`（`actual: true, expected: false`）。

### 5.1 MAJOR-1：一单一退**只在申请侧**封死了（CONFIRMED，已修）

**reviewer 的说法**：规则 1 的硬约束落在「有没有申请记录」上，
而 `directRefundOrder` 与公共池超时这两条**执行**路径仍然只看「是否退满」，
因此「第二次实际退款执行」在 `serving` 单上可达。

**我没有采信报告，自己逐步核实过每一步**：

| 步 | 核实内容 | 结论 |
|---|---|---|
| 1 | `directRefundTransaction.ts:214` 的 guard ③ 是 `refundedAmount >= actualPaidAmount` | 确认：只挡「退满」，部分退款下不成立 |
| 2 | `:254` 的金额是 `actualPaidAmount − refundedAmount`（剩余额） | 确认：它会**真的算出**第二笔可退的钱 |
| 3 | `releaseOrderByStaff` 用 `canTransitionOrder(status, "paid")`，`serving → paid` 合法 | 确认：`serving` 部分退款后能被打回 `paid` |
| 4 | `buildRefundActions` 的 `canDirectRefund` 只调 `canDirectRefund(order.status)` | 确认：界面还会**照常给出按钮** |
| 5 | 公共池超时那一步的通知/计数条件是 `order.status !== "refunded"` | 确认：部分退款不改状态 ⇒ 条件为真 ⇒ 再次出款 |

**根因一句话**：一单一退被实现成**申请侧**的规则（「有没有记录」），
而 ①§一 要求的是**执行侧**的规则（「最多一次实际退款执行」）。
两者不是同一件事——一张单可以**有记录且已出过款**，于是申请侧没有入口、执行侧还有两条。

**裁定依据（全部来自 `01-prompt.md` 逐字原文，因此无需上产品）**：

- ①§一：「最多**一次**实际退款执行」「审批通过并执行退款后：该订单退款流程终结。**不得再次退款**。」
- ①§八：「**已经执行退款后,不允许再次退款**……Repository / transaction 层必须有硬约束。」
- ①§九：「检查并删除/废弃：cumulative refund 逻辑；……**第二次退款**；……」
- ①§四（经 `isFullyRefunded` 的注释）：「剩下的留在平台」是**正常结局**，
  因此挡住第二次出款**不是**让用户损失，而是让订单落到它应有的终态。

⇒ **判据是「出过款」，不是「退满」**（①§一 从没说「退满」）。改动落在四处：

| 落点 | 改动 | 判据 |
|---|---|---|
| `mockPaymentRepository.applyOrderRefund` 短路条件 | ⇒ 第二次出款在**存储层结构性不可能**（本函数是 `refundedAmount` 的唯一写入点） | `isRefundExecutionClosed` |
| `directRefundTransaction` guard ③ | `>= actualPaidAmount` → 出过款判据 | `hasRefundBeenExecuted` |
| `companionDispatchTransaction` 计划层 | `timed-out` 步新增 `refundAmount: number \| null`（`null` = **只关池、不出款、不通知**）；通知与 `refundedOrderIds` 同步跟着它，**不靠写入层静默拒绝** | `isRefundExecutionClosed`（+ `actualPaidAmount > 0`） |
| `services/refunds.buildRefundActions` | `canDirectRefund` 加 `&& !hasRefundBeenExecuted(order)`；两个金额字段随之变 `null` | `hasRefundBeenExecuted` |

两个判据都是 `lib/constants/refunds.ts` 里的**单点定义**（分工见 D21.1）：
窄的答「出过款吗」，宽的答「退款还能不能再发生」。

**红-绿证伪（§3.3 探针 3 / 4 / 5）**：分别拿掉这三处闸，各自**恰好 1 条失败**，
且失败断言正落在该闸负责的那一句话上。新增 4 条用例（`tests/refundOnePerOrder.test.mjs`
「规则1（执行侧 1/4–4/4）」），每条都配**正例**（没出过款的同一场景必须照旧放行）。

### 5.2 MAJOR-2：文档里还留着「累计退满」（CONFIRMED，已修）

| 位置 | 修法 |
|---|---|
| `architecture-rules.md` 结构迁移表 | 「累计退满」→「退满」，并加 ⛔ 说明：**被改的是量词，不是这条边**；一单一退下不存在「累计」 |
| `database-schema.md` `refundedAmount` 语义 | 「P0-13 起它是真正的累计值」加 ⛔：「累计」在 P0-15 之后不成立；补一条「出过款是独立判据」 |
| `architecture-rules.md` 差距表 | 「`serving → paid` 目前**没有**入口」**是错的**——`releaseOrderByStaff`（P0-11）就是入口，已改正并说明它为什么必须改 |

### 5.3 MINOR（4 条，全部已修）

| # | 问题 | 修法 |
|---|---|---|
| 1 | `EARNING_FULLY_REVERSED_HINT` 说「这一单**已全额退款**」，而它在 10% 退款上也会显示——**一句可被界面自证的假话** | 改为「这一单已退款」，两种比例下都真；同步改 `04-acceptance.md` C5 与用例注释 |
| 2 | `mockEarningRepository` / `earningTransaction` 仍说整笔冲完会进 `reversed` | 与函数体（写 `frozen`）对齐 |
| 3 | `orderBlocking.ts` 引用已被推翻的 D10（「同一单允许重复申请退款」） | 保留遍历，但把理由换成「守本函数自己的口径，不依赖别处的性质」 |
| 4 | `services/refunds.ts` / `refundSeed.ts` 仍引 §17 口径 | 换成 ①§二 / ①§三 |

### 5.4 NOTE（4 条，不改代码，记录在案）

真 Scheduler 缺失（上线前 blocker，非本轮）、`withdrawn` 零写入路径（已由
`EX-WITHDRAW-03` 论证为结构不可达）、`earningHintFor` 对 `withdrawn` 刻意不选文案、
以及 `P0-15` 不得 `DONE`——四条均与 §四「没有做的事」一致。

---

## 六、Git 状态（**只读观测**）

| 项 | 值 |
|---|---|
| 分支 | `feat/order-lifecycle-alignment` |
| `HEAD` | `c2c9360`（本批次基线，**未变**） |
| 本轮是否有新提交 | **没有** |
| `Git Commit`（本轮） | `—`（禁止 Git 写操作；此栏留空是该时点的**正确状态**） |
| 工作区 | 未提交改动 107 个已跟踪文件 + 25 个未跟踪文件/目录；其中 `P0-14` 与 `P0-15` **混合**，无法用 `git diff` 区分 |

> ⚠️ **「DONE 双门槛」**：① 产品负责人确认 `PASSED`；② 用户本人完成提交。
> 两条**都还没到**。本轮停在 `AWAITING_ACCEPTANCE`。
