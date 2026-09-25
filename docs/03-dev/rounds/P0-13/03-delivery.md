# P0-13 — 交付记录

Round ID: P0-13
Round Status: **`AWAITING_ACCEPTANCE`**
Development Status: **`DONE`（自动门禁全绿，等用户本人验收）**

> ⚠️ 「`DONE`」在此**只描述开发与门禁已经做完**。按「DONE 双门槛」
> （① 用户本人验收 **且** ② 用户本人提交），**Claude 无权把本轮标为 `DONE`**。

---

## 一、本轮交付是什么，以及它为什么先停过一次

本轮的形态是 `CLARIFYING → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`：

| 阶段 | 时点 | 依据 |
|---|---|---|
| `CLARIFYING` | 2026-09-25 建档 | `cmd_p0-13.md:30` · `cmd_batch:34-39`：Q1/Q2 未冻结 ⇒ 停止，不得自行假设 |
| `READY` | 2026-09-25 | 产品负责人正式裁定 Q1-a/b/c · Q2-a/b/c/d（`02-decisions.md` §十） |
| `IN_PROGRESS` | 2026-09-25 | `development-workflow.md` §十三：**只有 READY 才能编码** |
| `AWAITING_ACCEPTANCE` | 2026-09-25 | 本文件 |

⛔ **第一阶段「不编码」是本轮唯一合规的结局**，不是执行缺口：
`development-workflow.md` §十一明文禁止「一边问问题一边实现自己的假设版本」
「为了赶进度选择『比较合理』的方案」「根据行业惯例填补 TBD」；
`CLAUDE.md` 亦写明「若 Round 存在 OPEN decision，**禁止开始业务编码**」。
`02-decisions.md` §三 / §四 / §七 的**原始提问保持原样未被覆盖**（§十二：追加，不覆盖）。

---

## 二、实现内容（逐项对应产品裁定）

### 2.1 冻结真值表 → 落点

产品裁定后的真值表在 `02-decisions.md` §十.一，实现决策 **D1–D19** 在 §十一
（**D18 是复核整改**——reviewer 的 BLOCKER B-1，见 §六）。逐条落点：

| 裁定 | 规则 | 落点 |
|---|---|---|
| Q1-a | 责任三分类 `platform` / `companion` / `shared` | `lib/types/refund.ts` `RefundResponsibility` · `lib/constants/refunds.ts:323` `REFUND_RESPONSIBILITIES` |
| Q1-a | `platform` ⇒ 冲回 0 | `computeRefundDecisionAmounts`（`lib/constants/refunds.ts:455`） |
| Q1-a | `companion` ⇒ `floor(companionBaseIncome × refundRateBp / 10000)` | 同上 |
| Q1-a | `shared` ⇒ `floor(base × rateBp × liabilityBp / 10000 / 10000)` | 同上 |
| Q1-a | `platformBorneAmount = refundAmount − companionReversalAmount`（**可为负**） | 同上（**减法构造，不做 `floor`**） |
| Q1-b | 责任认定权**只属 Admin**；Staff 只能调查 / 记录 / 建议 | `lib/constants/staffRefunds.ts` 无 `canApprove`；`app/api/staff/refunds/[id]/` 只有 `start-review` / `reject` |
| Q1-c | 平台承担必须留下**明确、可审计**的记录 | `platformBorneAmount` 是 `RefundRequest.decision` 的**一个字段**，不再靠「没有 reversal」间接推断；D14 进审计快照 |
| Q2-a | **不改** `Earning.incomeAmount`；不建余额桶；退款用独立 reversal 表达 | `lib/types/earning.ts:35-37` 注释 + `applyEarningReversal` 只写 `reversedAmount` |
| Q2-a | `netAvailableAmount = incomeAmount − cumulativeReversalAmount` | `EarningRecord.netAmount`（派生值，**不另存字段**） |
| Q2-b | 最小独立实体 `EarningAdjustment` | `lib/types/earning.ts:149` · `lib/data/earningRepository.ts:44` · `mockEarningRepository.ts:148` `appendEarningAdjustment` |
| Q2-c | 部分冲减 ⇒ `status` **留在原状态** | `applyEarningReversal`（`mockEarningRepository.ts:171`） |
| Q2-c | 累计冲满 ⇒ `status = reversed`，净额 0 | 同上 |
| Q2-d | 允许多次冲减；**不变式 `0 <= 累计冲减 <= incomeAmount`** | D4 的单次钳制 `min(公式值, max(0, base − 已冲))` + `applyEarningReversal` 的护栏 |
| Q2-d | 每次 refund / adjustment **幂等** | `EarningAdjustment.refundId` 即幂等键（D8）+ `refundIdsByOrder` 多值索引（D10） |
| Q3 | 已提现后继续 **DEFER** | `withdrawn` ⇒ 冲回 0、平台承担（D17） |

### 2.2 实现决策 D1–D19 的落点

> **D19 补记于本节之后**（2026-09-25 人工验收第 1 项整改），完整说明见 **§十**。

| # | 决策 | 落点 |
|---|---|---|
| D1 | 比例是入参，金额是派生值（不新造公式） | `computeRefundDecisionAmounts` |
| D2 | 服务端校验清单，改不了就 400 | `validateRefundDecisionInput` · `readAdminRefundDecisionInput` |
| D3 | `applyOrderRefund` 改为**累加**，退满才置 `refunded` | `lib/data/mockPaymentRepository.ts` `applyOrderRefund(orderId, at, 本次金额)` |
| D4 | 冲回额只算一次，带**单次钳制** | `lib/data/adminRefundTransaction.ts:459-466` |
| D5 | 冲减范围含 `frozen`，状态规则「留在原状态」 | `applyEarningReversal` |
| D6 | 不变式由 D4 的钳制保证（不是结构性成立） | 同上 |
| D7 | 六项决策落在 `RefundRequest.decision` | `lib/types/refund.ts` |
| D8 | `EarningAdjustment.refundId` 唯一 | `mockEarningRepository.ts` 索引 |
| D9 | `serving` 退款时 Earning 还不存在 ⇒ 决策先落退款，结算时回填 | `lib/data/earningTransaction.ts:186` `backfillRefundReversals` |
| D10 | `refundIdByOrder` 单值 → **多值** | `lib/data/mockRefundRepository.ts` |
| D11 | `completed` 投诉窗口复用既有判定，不读当前配置 | `lib/constants/earnings.ts` / `isCompletionAutoApprovalBlocked` |
| D12 | 全额退款终止履约 + 通知打手，保留 `actualCompanionId` | `lib/data/adminRefundTransaction.ts`（`applyDispatchTimedOut`） |
| D13 | 六项只给管理端 | `lib/services/{adminRefunds,staffRefunds,refunds}.ts` 的 DTO |
| D14 | 沿用 `refund.approve` 审计，六项进快照 | `lib/constants/adminAudit.ts` `toRefundAuditSnapshot` |
| D15 | 客户端只传百分比，不做金额算术 | `components/admin/AdminRefundConsole.tsx` · `lib/services/adminHttp.ts`。⚠️ **后半句「确认框不预览金额」已被 D19 取代**（前半句不变） |
| D16 | **不新增 Route、不扩枚举** | —（`app/api/**` 本轮零新增） |
| D17 | `withdrawn` 不冲回 | `computeRefundDecisionAmounts` 的 `withdrawn` 分支 |
| **D18** | **整改 B-1**：两条全额路径传差额；写入器自己钳一次；UI 报本次金额 | `directRefundTransaction.ts:254` · `companionDispatchTransaction.ts:415` · `mockPaymentRepository.ts:515-518` · `lib/types/order.ts` 的两个金额字段 · `components/refunds/DirectRefundButton.tsx`。详见 §6.1 / §6.2 |
| **D19** | **验收第 1 项整改**：先答「真实口径」，再让管理员**提交前看见金额**；公式**只提取、不改写** | `lib/constants/refunds.ts`（`resolveFinalDecisionAmounts` / `sumApprovedCompanionReversal` / 责任 hint 改写） · `lib/data/adminRefundTransaction.ts`（改调共享函数） · `lib/types/refund.ts`（`AdminRefundOrderMoney`） · `lib/constants/adminRefunds.ts`（`toAdminRefundOrderMoney` / `previewRefundDecisionAmounts` / 文案） · `lib/services/adminRefunds.ts` · `components/admin/{AdminRefundConsole,AdminConfirmDialog}.tsx` · `app/admin/(console)/refunds/[id]/page.tsx`。详见 **§十** |

### 2.3 本轮改动集合

**新增（P0-13 自身）**

| 路径 | 内容 |
|---|---|
| `tests/refundMoneyChain.test.mjs` | **37 用例**：纯公式（含手算字面量）+ 接口层 400 + 打手链路 + 累计与幂等 + D9/D12/D13/D14/D17 + 累计不变式 + **第八节「部分退款 × 客服回池」组合路径 3 条**（B-1 回归，见 §6.1）+ **第十节 8 条 D19**（公式复用与预览一致性，见 §十） |
| `docs/03-dev/rounds/P0-13/` | 本目录 5 件档案 |

**修改（P0-13 触碰的既有文件）**

| 层 | 文件 |
|---|---|
| `lib/types/` | `refund.ts`（`RefundDecision`） · `earning.ts`（`reversedAmount` / `EarningAdjustment` / `netAmount`） · `order.ts` |
| `lib/constants/` | `refunds.ts`（责任 / 公式 / 校验 / 文案） · `earnings.ts` · `adminRefunds.ts` · `adminAudit.ts` · `orders.ts` |
| `lib/data/` | `mockEarningRepository.ts` · `earningRepository.ts` · `earningTransaction.ts` · `refundRepository.ts` · `mockRefundRepository.ts` · `adminRefundTransaction.ts` · `mockPaymentRepository.ts`（`applyOrderRefund` 累计化） |
| `lib/services/` | `adminRefunds.ts` · `refunds.ts` · `refundsHttp.ts` · `staffRefunds.ts` · `companionEarnings.ts` |
| `components/` · `app/` | `components/admin/{AdminRefundConsole,AdminRefundTable}.tsx` · `components/companion/CompanionEarningList.tsx` · `app/admin/(console)/refunds/[id]/page.tsx` · `app/(mobile)/refunds/[id]/page.tsx` |
| `tests/` | `adminRefunds.test.mjs` · `staffRefunds.test.mjs` · `earning.test.mjs` · `completions.test.mjs` |
| `docs/02-tech-design/` | `api-contract.md` · `database-schema.md` · `architecture-rules.md` |

⚠️ **本批次四轮的改动全部未提交**，工作区里堆着四轮的累计 diff。
「上面这批是本轮的」**无法由 `git status` 自动复核**——它会把四轮的改动一起列出来，区分不了轮次。
复核方式是**逐项核对**上表，而不是跑 `git status` 然后相信。
可自动验证的只有一处：`docs/03-dev/rounds/P0-13/` 是 `git status` 里 `P0-13` 相关的唯一新增目录。
四轮共享文件的累计清单见 §四。

---

## 三、门禁读数

### 3.1 本轮最终树（2026-09-25 实跑；**已含验收第 1 项整改 D19**）

> ⚠️ 本节的读数是**整改 D19 之后**的最终树（与 §十 一致）。
> 整改只动了**界面与文案 + 两个既有纯函数被提取复用 + 新增用例**，
> **没有改任何一条金额公式**——`refundAmount` / `companionReversalAmount` /
> `platformBorneAmount` 的算法逐字未变（§十 3.1 有对照）。

| 项 | 命令 | 读数 |
|---|---|---|
| 离线全量 | `pnpm test` | **tests 1385 / pass 1239 / fail 0 / cancelled 0 / skipped 146 / todo 0** ✅ |
| 类型 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit 0，`✓ Types generated successfully` ✅ |
| 静态检查 | `pnpm lint`（`eslint`，flat config） | exit 0，**0 error / 0 warning** ✅ |
| 构建 | `pnpm build` | exit 0 ✅ |
| 生产 HTTP 全量 | `APP_BASE_URL=http://localhost:3105 pnpm test` | **tests 1385 / pass 1385 / fail 0 / skipped 0** ✅ |

**恒等式**：`1385 = 1239（离线 pass） + 146（离线 skip）`——
离线跳过的 146 条正是 HTTP 用例，带 `APP_BASE_URL` 时**全部真跑、无一跳过**。

> 📌 读数沿革：首次门禁 **1374** / pass 1228 → 整改 **B-1** 后 **1377** / pass 1231
> → 验收第 1 项整改 **D19** 后 **1385** / pass 1239。
> 三次的 `skip` 恒为 146（HTTP 用例数未变）。
> 1374 → 1377 的 +3 是 §6.1 M-1 新增的组合路径回归用例；
> 1377 → 1385 的 +8 全是 `tests/refundMoneyChain.test.mjs` §十（D19 的公式复用与预览一致性）。

⚠️ 端口 3105 在收尾时已确认释放：监听进程已 `taskkill`，`netstat -ano | grep :3105 | grep -i listening`
**无输出**（残留的只是客户端侧 `TIME_WAIT`，没有 LISTENING）。
按 `background-server-taskstop-keeps-child` 的教训，这一步是**验证过**的，不是假定的。

### 3.2 用例数沿革

| 轮 | `pnpm test`（离线） | 净增 |
|---|---|---|
| P0-10 | 1278 | —— |
| P0-11 | 1324 | +46 |
| P0-12 | 1346（pass 1200 / skip 146） | +22（其中 `tests/directRefund.test.mjs` 21 条） |
| **P0-13** | **1385（pass 1239 / skip 146）** | **+39**（`tests/refundMoneyChain.test.mjs` 37 条 + 既有文件补齐 2 条） |

> 数字变大**不代表**功能变多，而是同一批边界被钉得更死。

### 3.3 reviewer

见 §六。

---

## 四、累计工作区状态（本批次四轮交付物，均**未提交**）

⚠️ 下列改动**不是 P0-13 的 delta**，而是 P0-10 / P0-11 / P0-12 / P0-13 累计至今、
仍留在工作区的交付物。按 `cmd_batch:41-42`：「不得把累计 diff 冒充本轮 delta」——
故单列于此，供人工验收与用户本人提交时对照。

⚠️ **计数已于 2026-09-25 收尾时更新为 `?? 25` / ` M 75`（合计 100）**——收尾阶段又新增了本报告
`BATCH_p0-10_to_p0-13_最终报告.md` 等档案。**代码与测试的条目一个字没变**，多出来的都在 `docs/**`。

**新增（`??`，25 项）**

| 路径 | 轮次 |
|---|---|
| `app/api/staff/orders/` · `app/staff/(console)/orders/` | P0-10 |
| `components/staff/{StaffOrderTable,StaffOrderActionsConsole,StaffOrderDetailPanels}.tsx` · `lib/constants/orderFilters.ts` · `lib/services/staffOrders.ts` · `tests/staffOrders.test.mjs` | P0-10 |
| `lib/services/staffOrderActions.ts` · `tests/staffOrderActions.test.mjs` | P0-11 |
| `app/api/orders/[id]/direct-refund/` · `components/refunds/DirectRefundButton.tsx` · `lib/data/directRefundTransaction.ts` · `tests/directRefund.test.mjs` | P0-12 |
| `tests/refundMoneyChain.test.mjs` | **P0-13** |
| `docs/03-dev/rounds/{P0-10,P0-11,P0-12,P0-13}/` · `cmd_p0-1*.md` | 各轮 |

**修改（`M`，**76** 项）——跨轮共享文件**

> ⚠️ **计数更正**：本节原先写的是「**82** 项」，2026-09-25 收尾时实测 `git status --porcelain` 得
> ` M 75` / `?? 25`（合计 100）。**交付当时的 82 现在无法复现，本报告不替它编一个解释**——
> 以**实测值为准**。D19 整改（§十）后复测为 ` M 76` / `?? 25`（合计 **101**）：
> **`??` 25 项一个字没变**（D19 **没有新增任何文件**），`M` 的 +1 是
> `components/admin/AdminConfirmDialog.tsx`（新增可选 `size` 属性 + 内容区可滚动）。
> **逐条核对请直接跑 `git status --porcelain`，不要引用本表的数字。**
> ✅ 可以确认的一点：门禁每次都是在**当时的工作区**上跑的，§三 / §九.5 / §十.5 三组读数
> 与它们各自的树一一对应。

`CLAUDE.md` ·
`lib/types/{order,dispatch,completion,staff,companionRelease,refund,earning}.ts` ·
`lib/constants/{orders,refunds,dispatch,staff,completions,adminOrders,adminRefunds,adminAudit,earnings,staffRefunds}.ts` ·
`lib/data/{completionTransaction,companionOrderTransaction,adminCompanionTransaction,mockCompletionRepository,mockDispatchRepository,mockPaymentRepository,mockEarningRepository,earningRepository,earningTransaction,refundRepository,mockRefundRepository,adminRefundTransaction,orderBlocking}.ts` ·
`lib/mocks/fixtures/refundSeed.ts` ·
`lib/services/{adminCompanions,companionOrders,refunds,refundsHttp,staffHttp,adminHttp,adminRefunds,staffRefunds,companionEarnings}.ts` ·
`components/{admin/AdminConfirmDialog,admin/AdminRefundConsole,admin/AdminRefundTable,companion/CompanionEarningList,staff/StaffHeader,staff/StaffRefundTable,staff/StaffReleaseHistory}.tsx` ·
`app/(mobile)/orders/[id]/page.tsx` · `app/(mobile)/orders/[id]/refund/page.tsx` · `app/(mobile)/refunds/[id]/page.tsx` ·
`app/admin/(console)/refunds/[id]/page.tsx` · `app/staff/(console)/{layout.tsx,refunds/[id]/page.tsx}` ·
`tests/{companionOrders,companionServing,completions,platformConfig,refunds,staff,staffComplaintCrossRole,staffReleaseHistory,staffTableRefresh,adminRefunds,staffRefunds,earning}.test.mjs` ·
`docs/01-requirements/{特殊情况与异常处理表,用户权限表}.md` ·
`docs/02-tech-design/{api-contract,database-schema,architecture-rules,directory-structure}.md` ·
`docs/03-dev/{总需求进度表,需求功能点进度表}.md` · `docs/03-dev/rounds/README.md`

⚠️ **同一文件被多轮改动**是本批次的固有特征（如 `lib/constants/refunds.ts` 被 P0-11 / P0-12 / P0-13 先后改动）。
人工验收时请以**当前工作区**为准，不要按轮次切分文件——文件级归属在此不成立。

---

## 五、遗留 / MINOR / NOTE / TBD（跨四轮汇总）

### 5.1 已 DEFER（有明文授权，本轮不做，但**上线前是 production blocker**）

| 事项 | 授权 | 为什么上线前必须解决 |
|---|---|---|
| 已提现后的退款追偿 / 负余额 | `cmd_p0-13.md:27-28` · `:71`；Q3 裁定继续 DEFER | `EX-WITHDRAW-03:918`「❓ 资金域的重要待确认项」；`Q-EX-09:1063`「资金一致性核心」 |
| 提现域整体（入口 / 审核 / 打款 / 最小金额） | `EX-WITHDRAW-01:892`「❓ 尚未正式设计」 | `api-contract.md:706` · `database-schema.md:820` 均 `TBD — DO NOT INVENT` |
| 「自然到期后由**真 Scheduler** 自动释放」 | P0-9 已登记 | 仓库内所有「到点」都是读路径上的惰性物化；**P0-9 判为上线前 production blocker** |
| 「特殊人工申诉」（`deadline` 之后） | `EX-REFUND-08:654` | `cmd_p0-13.md:71` 本轮不做；`api-contract.md:713` 计划 R5 |
| `AfterSalesCase` 结构 | `database-schema.md:824`（计划 R4） | P0-13 复用既有 Refund 绕开了它；R4 开工前必须定 |

### 5.2 🆕 本轮新发现、需产品裁定的 **TBD**（**已登记，未自行决定，代码保持现状**）

| 编号 | 事项 | 落点 |
|---|---|---|
| **TBD-P13-1** | **部分退款的订单在「消费累计 / 消费等级 / 周期榜」里按什么口径计入？** 当前实现下，`completed` 订单即使发生**部分**退款，其 `actualPaidAmount` **全额**仍计入消费累计。两种读法都说得通：① 按**实付**计（`actualPaidAmount`）——但退款后实际留存的是 `actualPaidAmount − refundedAmount`；② 按**净留存**计。二者对**消费等级门槛**与**周期榜名次**有实际业务后果 | `docs/02-tech-design/database-schema.md`（已就地标注 TBD）· `lib/constants/levels.ts` / 榜单读取路径 |

> ⚠️ 按 `CLAUDE.md`「若上述文档中出现 **TBD**：**禁止自行决定**，先问产品负责人」——
> 本轮**只登记、未改代码**。这不是 P0-13 的验收阻塞项（退款本身的行为是对的），
> 但**接真实支付前必须裁定**。

### 5.3 需产品**追认**（已实现，但超出指令明文）

| 编号 | 事项 | 落点 |
|---|---|---|
| **R1 / R2**（P0-12） | 存量退款记录原样不动；且 R1/R2 在**接真实支付前**是**硬门禁**，不只是待追认 | `P0-12/04-acceptance.md` §五 · `P0-12/02-decisions.md` §五.1 |
| 12.1 两条（P0-11） | 超出 `cmd_p0-11.md` 明文的两条实现 | `P0-11/02-decisions.md` §12.1 |
| **R3（P0-13 · 新）** | **部分退款过的订单再走「全额直退」时，退的是「剩余可退额」**，而不是「挡住入口」。`cmd_p0-12.md` / `cmd_p0-13.md` 都没写这条组合（P0-12 只写了「未全额退款」这个前置） | `P0-13/02-decisions.md` §十一 **D18** · `P0-13/04-acceptance.md` §五 |

### 5.4 🆕 本轮登记为 NOTE / MINOR（不修）

| 编号 | 内容 | 处置 |
|---|---|---|
| N-P13-1 | **打手退款通知的构造器已有第四份拷贝**（`adminRefundTransaction.ts:245` 与 `directRefundTransaction.ts:136` 是其中两份）。四份逻辑同源、各自手写 | 登记。收敛它属于「通知构造」重构，超出本轮范围 |
| N-P13-2 | `tests/staffOrders.test.mjs` 里有一条**注释自相矛盾**（P0-10 遗留，非本轮引入） | 登记 |
| N-P13-3 | 客服订单 DTO 仍携带内部 `userId`（用户资料页上那串 `displayId` 已一并给出，两个平台标识都在列表上显示） | 登记。是否为隐私问题需产品判断 |
| N-P13-4 | 订单详情页的退款卡片**只显示最新一条**退款，因此「先前一笔成功部分退款」可能被「后一笔被驳回」盖住 | 登记。D10 允许重复申请后此点更可见 |
| N-P13-5 | `approveRefund` **没有「订单必须处于 `serving` / `completed`」的领域 Guard**（只有 `RefundRequest` 自己的状态机）。今天只对**存量申请**可达（P0-12 D6 已把 `paid` / `accepted` 移出可申请集合，只剩两条预置记录） | **刻意不加**：加了会挡死管理员处置存量记录的路，而那条路正是 P0-12 R1/R2 待追认的内容——不能在追认之前替产品关掉它。理由见 §6.2(b) |
| N-P13-6 | `lib/constants/dispatch.ts` 的公共池超时通知写「订单已**全额**退款」 | **刻意不改**：整改后这一单确实退满实付，文案是一句真话；改成「退剩余额」反而会让更常见的那一类多一句没有信息量的话。见 §6.2(a) |

### 5.5 MINOR / NOTE（跨轮，登记不修或已修）

| 来源 | 内容 | 处置 |
|---|---|---|
| P0-12 §九 m5 | `totalAmount` 与 `actualPaidAmount` 存在发散可能（今日无优惠券 ⇒ 三者相等，已核到 `lib/types/order.ts:108`） | 登记 |
| P0-12 §九 m6 | `hasRefundPath` 的纪律只写在注释里，没有编译期约束 | **可选，刻意不做** |
| P0-12 §九 m7 | `amount-invalid` 判定在资格判定之前 | 登记，不改 |
| P0-12 §九 m8 | `refunded` 分支遮蔽 `amount` 判定 | 可辩护，登记 |
| P0-12 §3.3 | `tests/platformConfig.test.mjs` 的时间戳断言**本来就写错**（P0-9 遗留，diff 对 `3fbae62` 为空），已在 P0-12 修正 | **已修** |
| P0-10 / P0-11 | 各自的 MINOR / NOTE 明细 | 见各轮 `03-delivery.md` §七 |

### 5.6 一处**已更正的事实错误**（自查发现，非产品提出）

P0-12 档案中曾误述「**客服**审批退款申请」。**只有管理员可以最终批准**——客服端
`app/api/staff/refunds/[id]/` 只有 `start-review` / `reject`，没有 `approve`；
`staffRefundAllowedActions` 没有 `canApprove`；`api-contract.md` 亦如此。
已在 `P0-12/02-decisions.md`（R1 行 + §五.1）、`03-delivery.md`（§九 R1）、
`04-acceptance.md`（§五 R1）三处更正。P0-13 的 Q1-b 裁定与之一致。

---

## 六、reviewer

本轮改动经**只读代码审查**（`reviewer-agent`），范围：金额规则 / 原子性与幂等 / 权限边界 /
DTO 隐私 / D10 / P0-12 / P0-11 / 测试缺口。

### 6.1 首轮结论：**1 BLOCKER · 2 MAJOR · 3 MINOR · 若干 NOTE**

| 编号 | 结论 | 处置 |
|---|---|---|
| **B-1** | `applyOrderRefund` 改为增量后，两条**既有全额路径**仍传 `actualPaidAmount`，与「部分退款不改状态 + P0-11 回池不改 `refundedAmount`」组合起来可退到**超过实付**（1300/1000）。全程合法 UI 可达，**整改前零覆盖** | ✅ **已修**（D18）：两处调用点改传差额 + 写入器自己钳一次 + UI 报本次金额。新增 3 条回归用例，**已用变异验证**「还原调用点则两条同时变红」 |
| **M-1** | B-1 所在组合路径零用例覆盖 | ✅ **已修**：`tests/refundMoneyChain.test.mjs` 第八节 3 条 |
| **M-2** | `tests/staffOrders.test.mjs:861` 用例名写着「没有…用户主键」，而同一用例断言 `user` 键集合**含** `id`；`P0-10/02-decisions.md:192` 同一处也写反了 | ✅ **已修**：改标题 + 更正该行（两条留 D4 那一条） |
| MINOR-1 | 公共池超时通知写「已全额退款」，部分已退的订单只退剩余额 ⇒ 文案可能是假话 | ✅ **无需改**：整改后该单**确实**退满实付，文案成立（见 §6.2） |
| MINOR-2 | `lib/services/refunds.ts` 注释说金额那一半「由原子区段兜底」——那句兜底只判「退满」 | ✅ **已修**：注释重写，写明缺口与整改 |
| MINOR-3 / NOTE-1 | `approveRefund` 无订单状态领域 Guard | ⚠️ **刻意不加**，见 §6.2 |
| NOTE-2 | P0-10 档案内部矛盾 | ✅ **已修**（M-2 同处） |
| NOTE-4 | `02-decisions.md` 里 D3 与 §六 的两句错推理已被证伪 | ✅ **已修**：两处就地标注更正，并新增 D18 |

### 6.2 两条**刻意不改**的，以及理由

**（a）MINOR-1 的通知文案**：不改不是「懒得改」。整改后这张订单在清扫时**确实退满实付**
（累计 = 实付），因此「订单已全额退款」是一句**真话**；把它改成「退剩余额」反而会让
更常见的那一类（从未退过的订单，退的就是实付全额）多一句没有信息量的话。

**（b）MINOR-3 的订单状态 Guard**：审查者自己也注明它**只对存量申请可达**
（P0-12 D6 已把 `paid` / `accepted` 移出 `REFUNDABLE_ORDER_STATUSES`）。
而给 `approveRefund` 加「订单必须处于 `serving` / `completed`」会**直接挡死**
管理员处置那些存量记录的路——那正是 P0-12 R1/R2 待追认的内容（§5.3）。
加 Guard 等于在追认之前替产品把那条路关掉。**登记为 NOTE，不动。**

### 6.3 审查确认**无问题**的维度（列出以免被读成没看）

金额公式与取整 · D4 钳制与 D6 更正 · D5/D17 的 Earning 规则 · D9 补记 ·
**原子性**（逐文件确认标注区段内无 `await`）· 幂等键与 id 抢占 ·
D10「只挡进行中」的两层一致 · D13 DTO 边界 · 打手收益 DTO 隐私 ·
D3/D15 客户端无金额算术 · 权限与 404 语义 · P0-11 释放原语收敛 ·
P0-11 完成材料作废 · P0-11 候选资格口径 · P0-12 直接退款 ·
路由/接口清单门禁。

---

## 七、本轮**没有**做的事（明确声明，避免被读成遗漏）

- ❌ **未新增任何 Route**（D16）；`app/api/**` 在 P0-13 零新增
- ❌ **未扩任何枚举**（`OrderStatus` / `RefundStatus` / `EarningStatus` / `DispatchState` 全部原样）
- ❌ **未建第二套** Order / Refund / Notification / Earning（`cmd_batch:44-45`）
- ❌ **未建完整财务总账 / 钱包 / 余额桶**（Q2-b 明令禁止；`EarningAdjustment` 是**最小**实体）
- ❌ **未改 `Earning.incomeAmount`**（Q2-a 明令禁止）
- ❌ **未触碰**已提现 / 负余额 / 追偿（Q3 继续 DEFER，§5.1）
- ❌ **未替产品回答** TBD-P13-1（§5.2，只登记）
- ❌ **未开始 P0-14**（`cmd_batch:62`）
- ❌ **未做任何 Git 写操作**（§八）
- ❌ **验收整改 D19 未改任何一条金额口径**（§10.1 先答口径、§10.3 只提取不复写公式）

---

## 八、Git 状态

- `HEAD = 3fbae6263794bda316b2b48dac03efd7f62afa01`，与本批次开始时**完全一致**
- **本批次全程零 Git 写操作**：无 `add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend`
- 仅使用只读命令：`git status` / `git rev-parse` / `git diff` / `git diff --stat` / `git log` / `git ls-files`
- 提交由**用户本人**完成。按「DONE 双门槛」（① 用户本人验收 **且** ② 用户本人提交），
  **Claude 无权把任何一轮标记为 `DONE`**——当前 P0-10 / P0-11 / P0-12 / P0-13 均停在 `AWAITING_ACCEPTANCE`

---

## 九、收尾档案同步（2026-09-25，**只改文档，零代码改动**）

> §四 那张「累计工作区状态」表是**交付当时的读数**；本节记录**收尾阶段**回填的档案。
> ⚠️ 本节的改动**全部在 `docs/` 与 `CLAUDE.md`**——**没有**再碰任何 `lib/` / `app/` / `components/` / `tests/` 文件，
> 因此 §三 的门禁读数**仍然有效**，不需要重跑（重跑的结论见 §9.3）。

### 9.1 写齐 P0-13 自己的五件档案

| 文件 | 状态 |
|---|---|
| `README.md` | ✅ 重写：状态 `CLARIFYING → READY → IN_PROGRESS → AWAITING_ACCEPTANCE` 沿革、12 项交付、变更清单、5 件档案索引 |
| `02-decisions.md` | ✅ 表头状态更新；追加 **§十**（Q1/Q2/Q3 裁定照录）、**§十一**（冻结真值表 **D1–D19**，其中 D19 为 2026-09-25 验收整改追加，见 §十）；两处已被证伪的陈述**划线更正**（不覆盖） |
| `03-delivery.md` | ✅ 本文件；§六 由占位符填成 reviewer 实际结论与整改 |
| `04-acceptance.md` | ✅ **重写**（原先还是 `CLARIFYING` 版，在问 Q1-a/b/c、Q2-a/b/c/d）：改为**可执行的七段人工验收清单**，含 **§1.1 收益没有预置数据**、**§1.3 必须用有账号的护航**两条前置说明，以及 §五 的 **R3 待追认** |
| `01-prompt.md` | ✅ 原样存档，未动 |

### 9.2 回填跨轮档案

| 文件 | 回填了什么 |
|---|---|
| `docs/03-dev/rounds/README.md` | P0-13 行 `CLARIFYING` → **`AWAITING_ACCEPTANCE`**；那段 `⛔ 停在 CLARIFYING` 的叙述**保留为历史**（`⛔→✅` 前缀），其后补上裁定、交付、reviewer 与整改的完整链 |
| `docs/03-dev/总需求进度表.md` | **新增 P0-13 行**（原表只有 P0-10/11/12 三行）；P0-10 行的 A9-9「待裁定」改为 **A0 已裁定并已修**；**修掉两条被本批次推翻却没人改的 `NEEDS_FIX` 行**（见下） |
| `docs/03-dev/需求功能点进度表.md` | 批次落点表**新增 P0-13 行**、`P0-10` 行补 A0；§5.3 **#4「管理员退款处理」`PARTIAL` → `AWAITING_ACCEPTANCE`**；§一之二 的叙述改为「四轮均已交付、统计按「验收+提交」才重算」 |
| `CLAUDE.md` | 事实表 `Tests 68 files / 1346 cases` → **`69 files / 1377 cases`**（P0-13 新增 `tests/refundMoneyChain.test.mjs`），D19 整改后进一步改为 **`69 files / 1385 cases`**（**文件数不变**——D19 只往既有文件里加用例）。**只改这一行计数**，未改任何一条指令。其余计数经复核**仍然正确**：Pages **80** · Layouts **8** · API routes **131**（admin 62 / staff 25 / companion 8）· Repositories **26** |
| `docs/03-dev/rounds/P0-10/{README.md,03-delivery.md}` | A0 整改的记录（见 §9.4） |

### 9.3 ⚠️ 收尾时**顺手修掉的两条陈旧行**（不是本轮引入，是 P0-11 / P0-12 漏回填）

`总需求进度表.md` 里两条 `🟠 NEEDS_FIX` 行，**在被本批次实现之后仍写着「未实现」**——
这正是 P0-11 的 **MAJOR-2**（「本轮档案与计数没有回填」）所指的同一类缺陷，只是当时只修了另一张表：

| 行 | 原状 | 实际 |
|---|---|---|
| 订单状态机整改 — `serving → paid` 等 | `🟠 NEEDS_FIX`，备注「`serving → paid` 仍只进结构表、**不提供任何入口**」 | **P0-11 已接入**（打手封禁 / 客服换人 / 退回公共池）。已改为 `⏸️ 已由 P0-11 补齐，等验收` |
| 未开始服务直接退款 — `paid/accepted → refunded` | `🟠 NEEDS_FIX` | **P0-12 已实现**（`POST /api/orders/[id]/direct-refund`）。已改为 `⏸️ 已由 P0-12 交付，等验收` |

⚠️ 两条都**只改成「已交付，等验收」**，**没有**改成 `✅ DONE`——它们所属的轮次本身还在 `AWAITING_ACCEPTANCE`。

### 9.4 P0-10 的验收前整改 A0（`displayId`）

产品负责人裁定 `P0-10/02-decisions.md` §九 **A9-9** 选**方案 B**，要求
「在不扩展业务范围的情况下，让 `/staff/orders` 搜索同时支持用户实际展示的 `displayId`，并补相应测试」。
已实现并记录在 `P0-10/03-delivery.md` **§十一**（`README.md` 与两张进度表的 P0-10 行同步）。
⚠️ 该整改**改动过业务代码与测试**（3 个业务文件 + 2 条既有用例的断言），
因此**本批次的门禁读数是在 A0 之后跑的**——§三 §3.1 的读数已经包含了它。

### 9.5 门禁复跑（收尾后）

> ⚠️ **本节是 2026-09-25「收尾档案同步」当时的读数（1377）**，保留为历史。
> 此后又做了**人工验收第 1 项整改 D19**，最终读数以 **§3.1 / §十.5** 的 **1385** 为准。

| 门禁 | 读数 | 结论 |
|---|---|---|
| `pnpm test` | tests **1377** / pass **1231** / fail **0** / skipped **146** | ✅ |
| 生产 `APP_BASE_URL=http://localhost:3105 pnpm test` | tests **1377** / pass **1377** / fail **0** / skipped **0** | ✅ |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit 0 | ✅ |
| `pnpm lint` | 0 error / 0 warning | ✅ |
| `pnpm build` | exit 0 | ✅ |

⚠️ 收尾阶段只改了 `docs/**` 与 `CLAUDE.md`，**没有再碰代码**；上表是这些文档改动**之后**的读数。

---

## 十、人工验收第 1 项整改（D19，2026-09-25 —— **改了界面与文案，未改任何金额公式**）

> 验收方原话（照录 `02-decisions.md` §十一 D19）：
> 「当前『管理员输入退款比例』功能本身可以正常使用，但**退款比例的业务语义和界面反馈不够清楚**。
> 请**先不要直接修改口径**，先检查当前代码和现有文档……然后对管理端退款确认界面做整改（A–E）。」

### 10.1 先回答「当前代码真实计算口径」（整改的前置，不是整改的一部分）

口径检查结论**逐字**记在 `02-decisions.md` §十一 D19 的检查结果表。三问三答：

| 问 | 答 |
|---|---|
| ① 「退款比例 30%」的基准是什么 | **用户实际支付金额**（`Order.actualPaidAmount`）。`refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`。「原价」`originalAmount` 与「分账基数」`companionRevenueBaseAmount` 是**另外两个**字段，不参与这条公式 |
| ② 有优惠 / 增值服务 / 后续部分退款时基于哪个金额 | 优惠：`actualPaidAmount = originalAmount − couponDiscountAmount`（P0 券额恒为 0，但**公式已经是减法构造**）。增值服务：进 `originalAmount`，也进分账基数。**后续部分退款不改本次决策的基数**——只经由累计闸门 `assertRefundAmountWithinPaid(…, order.refundedAmount, …)` 限制上限 |
| ③ 「按比例分担」是谁和谁、分什么、基数各是什么 | 主体是**平台 vs 打手**，分的是**本次退款金额**；但**打手那条腿的基数是 `companionBaseIncome`（打手收益），不是退款金额**：`shared` 为 `floor(companionBaseIncome × refundRateBp × liabilityBp / 10000 / 10000)`，再钳 `max(0, companionBaseIncome − 已冲回)`；**平台腿是余数** `refundAmount − companionReversalAmount`，**可为负**。⇒ **「责任比例 40%」不等于「打手承担退款的 40%」**——这正是 D19 要在界面上说清楚的那件事 |

⚠️ 口径检查是**只读**的：先回答、后整改，**没有**借整改之名调整任何口径。

### 10.2 A–E 的落点

| 项 | 要求 | 落点 |
|---|---|---|
| **A** | 说明比例基准 | `ADMIN_REFUND_DECISION_RATE_BASE_NOTE`（`lib/constants/adminRefunds.ts`）：明确写**按实际支付金额**；比例输入区下方、`AdminRefundConsole` 与 `refunds/[id]` 详情页各一处 |
| **B** | 说明「按比例分担」 | `ADMIN_REFUND_DECISION_SHARED_NOTE`；并把 `REFUND_RESPONSIBILITIES` 每个选项的 hint **改写成带公式的句子**（`shared` 明写「乘的是打手收益，不是退款金额」「平台承担 = 本次退款金额 − 打手冲回，可能为负」），三处（确认框 / 详情页 / 责任选项）同源 |
| **C** | 展示订单金额事实 | 新 DTO `AdminRefundOrderMoney`（`lib/types/refund.ts`）+ `toAdminRefundOrderMoney()`：订单原价(含券) / 用户实付 / 累计已退款 / **剩余可退款** / 打手收益 / 平台收益 / **已冲回** / 打手收益状态。管理端确认框用 `OrderMoneyTable`，详情页用 `OrderMoneySection` |
| **D** | 改比例即时出金额 | `previewRefundDecisionAmounts()`——**纯函数**，随 `refundRatePercent` 输入实时重算；按钮文案同时变成「按 X% 退款（预计 ¥Y）」。已退款 ¥20.00 时**剩余可退款**是独立一行（`remainingRefundableAmount`） |
| **E** | 不用读代码就能答 5 问 | `ADMIN_REFUND_DECISION_QUESTIONS`（5 条「这个 30% 是谁的 30% / 最终退多少 / 谁承担 / 各方收益少多少 / 最多还能退多少」）以 `<details>` 折叠在确认框、以 `<dl>` 展开在详情页 |

### 10.3 与 D15 的关系（**必须留痕，不是静默改口径**）

D15 当时写了两句：**「客户端只传百分比」** 与 **「确认框不预览金额」**。
D19 **只推翻后一句**，前一句继续有效：

- 客户端**仍然只传百分比与责任**，**没有金额输入框**，`POST` body 的形状**未变**；
- 被推翻的只是「管理员提交前看不见金额」这个**反馈**取舍。

为了让「预览」不以「第二份公式」的形式出现，把原来内联在写入路径里的两段算术**提取成共享纯函数**：

| 提取出的函数 | 原位置 | 现调用方 |
|---|---|---|
| `resolveFinalDecisionAmounts()` | `lib/data/adminRefundTransaction.ts` 的 `withdrawn` 分支 | 写入路径 **+** 预览 |
| `sumApprovedCompanionReversal()` | 同上，算 `reversedSoFar` 的 `filter/reduce` | 写入路径 **+** `lib/services/adminRefunds.ts`（详情 DTO） |

⇒ 「**金额公式只许有一份**」。这条纪律的**可执行验收方式**写在
`docs/02-tech-design/architecture-rules.md` §三 规则 9：
**`components/**` 里不出现任何金额算符**（预览调的是服务端同一批纯函数）。

### 10.4 新增的 8 条回归（`tests/refundMoneyChain.test.mjs` §十）

| # | 钉住的事实 |
|---|---|
| 1 | `resolveFinalDecisionAmounts`：**只有** `withdrawn` 改写为「冲回 0、平台承担全额」 |
| 2 | 同上：`null` / `frozen` / `available` / `reversed` **一律原样透传**（重构不得改变行为） |
| 3 | `sumApprovedCompanionReversal`：**只累加 `approved`**，`decision: null` 容忍为 0 |
| 4 | 详情 DTO 的 `orderMoney` 各字段与服务端真实值一致；`remainingRefundableAmount` **不钳 0** |
| 5 | 第二笔退款的 `remaining` / `reversedSoFar` 跟随第一笔 |
| 6 | **预览 == 服务端实写金额**：三种责任各一条，同时比 `written.decidedAmount` 与落库 `decision` 的三个字段 |
| 7 | 预览的 `exceedsPaid` 与服务端 400 **同判** |
| 8 | 非法预览（比例空/负数/超 100/责任缺失）与 `withdrawn` 钳制后的预览读数 |

### 10.5 门禁（整改后最终树）

| 门禁 | 读数 | 结论 |
|---|---|---|
| `pnpm test` | tests **1385** / pass **1239** / fail **0** / skipped **146** | ✅ |
| 生产 `APP_BASE_URL=http://localhost:3105 pnpm test` | tests **1385** / pass **1385** / fail **0** / skipped **0** | ✅ |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit 0 | ✅ |
| `pnpm lint` | 0 error / 0 warning | ✅ |
| `pnpm build` | exit 0 | ✅ |

⚠️ `tests/refundMoneyChain.test.mjs` 由 **29 条 → 37 条**（+8，即 §10.4）。
⚠️ 同步更新的档案：`02-decisions.md`（**追加** D19）、`architecture-rules.md` §三 规则 9、
`api-contract.md`（`orderMoney` 字段与 `decidedAmount` 仍需返回）、`04-acceptance.md`（§二 A 段重写为 A1–A13 + §三 PASS/FAIL 行 A）、
本节、`README.md`、`CLAUDE.md`。
⚠️ **零 Git 写操作**，`HEAD` 仍为批次 baseline `3fbae62`。
