# P0-13 · serving / completed 售后 + Admin 最终退款金额 + Earning 联动

Round ID: P0-13
Title: `serving` / `completed` 售后 + Admin 最终退款金额 + Earning 联动
**Status: `AWAITING_ACCEPTANCE`**（沿革：`CLARIFYING`（2026-09-25 建档）→ `READY`（产品裁定 Q1/Q2）→ `IN_PROGRESS` → 开发与门禁完成）
Depends On: P0-12（`AWAITING_ACCEPTANCE`）· P0-11（`AWAITING_ACCEPTANCE`）· P0-10（`AWAITING_ACCEPTANCE`）· P0-9 / P0-8 / P0-7 / P0-6 / P0-5.5 / P0-5（均 `DONE`）
Goal: 实现 `serving` 售后（不允许 direct refund）、`completed` 投诉窗口内的售后、Staff 处理售后事实、
Admin 最终决定退款金额、partial / full refund、售后阻塞 `frozen` Earning 释放、退款与 Earning 一致。
Primary Domain: Refund（既有核心，不新建）· Order · Earning · Dispatch
Primary State Transition: `completed → refunded`（**触发条件收窄为累计退满**）· `Earning`：`frozen/available → reversed`（**仅累计冲满**）
Started At: 2026-09-25
Development Completed At: 2026-09-25（门禁全绿。⚠️ 交付当时是 `pnpm test` **1374** / pass 1228 / fail 0 / skipped 146、生产 **1374/1374**；**复核整改 B-1 之后**为 `pnpm test` **1377** / pass 1231 / fail 0 / skipped 146、生产 **1377/1377 / skipped 0**；**人工验收第 1 项整改 D19 之后**为 `pnpm test` **1385** / pass 1239 / fail 0 / skipped 146、生产 **1385/1385 / skipped 0**，typecheck / lint / build 各 exit 0。今日以 **1385** 为准，明细见 `03-delivery.md` §十）
Review: **reviewer 初判 1 BLOCKER / 2 MAJOR / 3 MINOR / 若干 NOTE → 整改后 0 / 0**（明细见 `03-delivery.md` §六）
Accepted At: ——（等用户本人验收，见 `04-acceptance.md`）
Git Commit: ——（本批次禁止 Git 写操作；提交由用户本人完成，Claude 无权代填）

> ⚠️ **`Status` 不由 Claude 改成 `DONE`**：按「DONE 双门槛」，需要 ① 用户本人说明验收通过
> **且** ② 用户本人提交。在此之前本轮停在 `AWAITING_ACCEPTANCE`。

---

## 本轮沿革（一句话）

本轮**先停在 `CLARIFYING`**（Q1 的责任子问 + Q2 整体在权威文档里 0 命中），
产品负责人于 2026-09-25 给出 Q1-a/b/c · Q2-a/b/c/d 的正式裁定后，
`CLARIFYING → READY → IN_PROGRESS`，按原 `cmd_p0-13.md` 完成开发，停在本状态。

裁定原文、冻结真值表与 **D1–D19** 实现决策见 [`02-decisions.md`](./02-decisions.md) §十 / §十.一 / §十一。
⚠️ **D18 是复核后的整改**：reviewer 的 BLOCKER **B-1** 是真缺陷（两张路径可退到**超过实付**，
1300/1000，全程合法 UI 可达且**整改前零测试覆盖**），三层修法 + 3 条回归用例见 §十一 D18
与 [`03-delivery.md`](./03-delivery.md) §六。
⚠️ **D19 是人工验收第 1 项的整改**（2026-09-25）：验收方要求先说清「退款比例 30% 的基准是谁」，
再让管理员**提交前就看得见金额**。整改**只提取既有公式供预览复用、未改任何一条口径**——
原先「确认框不预览金额」的取舍被取代，但「客户端只传百分比、不做金额算术」不变。
详见 §十一 D19 与 `03-delivery.md` **§十**。

---

## 本轮做了什么

| # | 交付 |
|---|---|
| 1 | **退款决策的六项字段**：`RefundRequest.decision = { refundRateBp, refundAmount, responsibility, companionLiabilityRateBp, companionReversalAmount, platformBorneAmount }` + `decidedBy` / `decidedAt`（`lib/types/refund.ts`） |
| 2 | **责任三分类与冲回公式**（`lib/constants/refunds.ts`）：`platform` → 0；`companion` → `floor(base × rateBp / 10000)`；`shared` → `floor(base × rateBp × liabilityBp / 10000 / 10000)`；`platformBorneAmount = refundAmount − companionReversalAmount`（**可为负**） |
| 3 | **订单退款累计语义**：`applyOrderRefund` 由「写死全额」改为按本次金额**累加**，`refunded` 只在**累计退满**时置位 |
| 4 | **最小独立实体 `EarningAdjustment`**（`lib/types/earning.ts` + `lib/data/earningRepository.ts` + `mockEarningRepository.ts`）：`earningId` / `orderId` / `refundId` / `type: "refund_reversal"` / `amount` / `responsibility` / `createdAt`，`refundId` 即幂等键 |
| 5 | **`Earning.reversedAmount` 累计冲减**：`applyEarningReversal` 累加而非覆盖，**不变式 `0 <= reversedAmount <= incomeAmount`**；状态规则「部分冲减留在原状态，累计冲满才 `reversed`」 |
| 6 | **D9 延迟冲回**：`serving` 退款时 Earning 尚不存在 ⇒ 决策先落在退款记录上，结算时**回填**调整明细 |
| 7 | **D17 `withdrawn` 不冲回**：金额 0，全额由平台承担（Q3 仍 DEFER） |
| 8 | **D12 全额退款终止履约**：走 `applyDispatchTimedOut` + 通知打手，`actualCompanionId` 保留 |
| 9 | **D13 DTO 边界**：六项决策字段**只给管理端**；客服端与用户端只拿 `decidedAmount` |
| 10 | **D14 审计**：沿用 `refund.approve`，六项字段进 `toRefundAuditSnapshot` |
| 11 | **D15 客户端只传百分比**：`refundRatePercent` / `companionLiabilityRatePercent` 字符串，**客户端不做金额算术**；~~不预览金额~~（**后半句已由 D19 取代**） |
| 12 | **D10 重复申请**：`refundIdByOrder` 由单值改为**多值索引**；只有**进行中**状态阻塞新申请 |
| 13 | **D19（验收第 1 项整改）管理端可见金额**：新增 `AdminRefundOrderMoney`（原价 / 实付 / 已退 / 剩余可退 / 打手收益 / 平台收益 / 已冲回 / 收益状态）与纯函数 `previewRefundDecisionAmounts()`，管理端确认框**实时**显示预计金额；`resolveFinalDecisionAmounts` / `sumApprovedCompanionReversal` 从写入路径**提取为共享纯函数**，保证「金额公式只许有一份」 |

**未新增任何 Route、未扩任何枚举**（D16）。

---

## 本轮改动集合

### 新增（P0-13 自身）

| 路径 | 内容 |
|---|---|
| `tests/refundMoneyChain.test.mjs` | 1486 行 / **37 用例**：纯公式 + 接口层 400 + 打手链路 + 累计与幂等 + D9/D12/D13/D14/D17 + 累计不变式 + **部分退款 × 客服回池组合路径 3 条**（B-1 回归）+ **D19 8 条**（公式复用与预览一致性） |
| `docs/03-dev/rounds/P0-13/` | 本目录 5 件档案 |

### 修改（P0-13 触碰的既有文件）

`lib/types/{refund,earning,order}.ts` ·
`lib/constants/{refunds,earnings,adminRefunds,adminAudit,orders}.ts` ·
`lib/data/{mockEarningRepository,earningRepository,earningTransaction,refundRepository,mockRefundRepository,adminRefundTransaction}.ts` ·
`lib/services/{adminRefunds,refunds,refundsHttp,staffRefunds,companionEarnings}.ts` ·
`components/admin/{AdminConfirmDialog,AdminRefundConsole,AdminRefundTable}.tsx` ·
`components/companion/CompanionEarningList.tsx` ·
`app/admin/(console)/refunds/[id]/page.tsx` · `app/(mobile)/refunds/[id]/page.tsx` ·
`tests/{adminRefunds,staffRefunds,earning,completions}.test.mjs` ·
`docs/02-tech-design/{api-contract,database-schema,architecture-rules}.md`

⚠️ 本批次**四轮的改动全部未提交**，工作区里堆着四轮的累计 diff。
`git status` 会一起列出它们，**区分不了轮次**——上面的「本轮」是陈述，
复核方式是逐项核对，不是跑 `git status` 然后相信。详见 `03-delivery.md` §一 / §四。

---

## 四件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（`cmd_p0-13.md` 原样拷贝，逐字节一致） |
| `02-decisions.md` | §一–§九 Requirement Check（含原始提问，**未被覆盖**）· §十 产品裁定 · §十.一 冻结真值表 · §十一 **D1–D19**（D18 = B-1 整改，D19 = 验收第 1 项整改） |
| `03-delivery.md` | 本轮交付、门禁读数、累计工作区状态、遗留 / MINOR / NOTE / TBD、Git 状态 |
| `04-acceptance.md` | 人工验收清单（含资金链路的定向点法）、待产品追认项 |
| `README.md` | 本文件 |

**入口**：验收先看 [`04-acceptance.md`](./04-acceptance.md)；
想知道「为什么本轮先停再走」看 `02-decisions.md` §三 / §四 / §十。
