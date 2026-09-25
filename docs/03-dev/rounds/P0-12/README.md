# P0-12 · paid / accepted 用户免审批全额退款

Round ID: P0-12
Title: `paid` / `accepted` 订单的用户**免审批直接全额退款**（`Order → refunded`）
**Status: `AWAITING_ACCEPTANCE`**（开发与自动门禁全部完成，等用户本人验收；见 `04-acceptance.md`）
Depends On: P0-11（`AWAITING_ACCEPTANCE`）· P0-10（`AWAITING_ACCEPTANCE`）· P0-9 / P0-8 / P0-7 / P0-6 / P0-5.5 / P0-5（均 `DONE`）
Goal: 把 2026-09-23 新规「`paid` / `accepted` 未开始服务 → 用户直接全额退款、**不需要客服/管理员审批**」落到既有退款/支付核心上：`Order.status → refunded`、`refundedAmount = actualPaidAmount`、派单关闭、不生成 Earning、`accepted` 时通知当前打手并**保留 `actualCompanionId`**。
Primary Domain: Order · Refund（既有核心，不新建）· Dispatch
Primary State Transition: `paid → refunded` · `accepted → refunded`（**两条边都已在 `ORDER_TRANSITIONS` 里，本轮第一次给它们接用户侧入口**）
Started At: 2026-09-24
Development Completed At: 2026-09-24
Accepted At: ——（等用户本人验收，见 `04-acceptance.md`）
Git Commit: ——（本批次禁止 Git 写操作；提交由用户本人完成，Claude 无权代填）

---

## 权威依据（Requirement Check 的结论）

| 事项 | 文档 | 结论 |
|---|---|---|
| 按服务是否开始区分退款路径 | `01-requirements/超哥电竞_业务流程表.md` **BF-26 A**（`:847-874`） | ✅ **已冻结**。`paid` / `accepted` = 「尚未开始服务」，**直接全额退款、不需要客服审批、不需要管理员决定比例、必须幂等**；`serving` 起才走售后 |
| 权限与状态表 | `01-requirements/超哥电竞_用户权限表.md` **PR-02**（`:224-236`，标注 **✅ 已确认 2026-09-23**） | ✅ `paid` / `accepted` 各行明文写「直接全额退款，不需要客服/管理员审批」；`accepted` 退款时「该打手本单收益为 0，不生成 Earning」「必须通知已接单打手」「`actualCompanionId` 保留为历史事实」 |
| 客服侧的边界 | 同文件 `:438-448`（§7.3 退款边界） | ✅ 明文「**客服不得把「未开始服务直接退款」强行转成人工审批**」 |
| 未开始服务订单直接退款（异常） | `01-requirements/超哥电竞_特殊情况与异常处理表.md` **EX-REFUND-07**（`:631-645`，标注 **✅ 2026-09-23 已确认**） | ✅ 前置 / 结果 / 打手收益 / 通知 / `actualCompanionId` / 幂等 六项逐条明文 |
| 幂等 | 同文件 **EX-REFUND-01**（`:550-557`，✅ 原则确认） | 「同一业务意图只创建一次有效退款事实/流程；钱不重复退、通知不重复」 |
| 与超时自动退款的并发 | 同文件 **EX-REFUND-02**（`:562-571`，✅ 原则确认；P0-5 已有基础） | 「退款写入必须幂等；自动退款先成功 → 后续退款不得再次执行；用户/人工退款先完成 → sweep 不得重复退款；`refundedAmount` 不超过应退金额；Order 只进入一次有效退款终态」 |
| `serving` / `completed` 不得走本路径 | 同文件 **EX-REFUND-08**（`:648-654`） | ✅ 路由原则确认：`serving` → 售后（客服调查、管理员决定比例），**属 P0-13** |
| 批次的历史语义 | `cmd_batch_p0-10_to_p0-13.md` §历史语义（`:47-51`） | ✅ 「cancel / ban / staff re-pool：清当前履约 binding，历史进 release record；**accepted direct refund：Order refunded，保留 `actualCompanionId`**。**不得为代码统一抹平**」 |
| 本轮不做部分退款 | `cmd_p0-12.md` §状态（`:44-45`） | ✅ 「`refunded` 只表示全额退款。本轮不提前实现 partial refund」 |

**⚠️ Requirement Check 结论：`cmd_p0-12.md` 的 12 项检查全部有权威依据，无 `TBD — DO NOT INVENT` 命中，无 OPEN。**

### 权威规则原文（三份文档一致，逐字）

```text
paid      → 用户可直接全额退款（免审批）
accepted  → 用户可直接全额退款（免审批，虽已有打手但尚未 serving）
serving   → 不得 direct refund，进入售后（P0-13）
completed → 投诉 / 售后（P0-13）
refunded  → 不允许再次退款
```

---

## 本轮范围

**做**：

- **用户侧直接退款入口**：只有**订单本人**、`Order.status ∈ {paid, accepted}`、且**未全额退款**时，服务端允许 direct refund（**前端按钮不是权限真值**）。
- `Order → refunded`、`refundedAmount = actualPaidAmount`、`refundedAt`（复用既有原语 `applyOrderRefund`）。
- **派单关闭**（复用既有 `applyDispatchTimedOut`）→ 公共池 / 专属池 / 已接单的派单都不再能被接单，且 `sweepExpiredDispatches` 不再把它当作待退款候选。
- `accepted` 退款：**保留 `actualCompanionId`**、**不清履约 binding**、**不写 release record**（与 cancel / ban / re-pool **刻意不同**）。
- `accepted` 退款：**通知当前打手**（打手身份建立在 user session 上，通知发给该打手的 `userId`）。
- **不生成 Earning**（本轮是**结构性成立** + 用例钉住，不是新增一条守卫）。
- **幂等与并发**：重复请求不重复出款、不重复通知、不刷新退款事实；与公共池超时自动退款并发只形成一次全额退款；`refundedAmount` 不得超过 `actualPaidAmount`。
- 用户端订单详情页：`paid` / `accepted` 的入口由「申请退款」（人工审核）改为「直接退款」。

**不做**：

- ❌ 部分退款 / 退款比例公式（`EX-REFUND-03`）→ P0-13
- ❌ `serving` / `completed` 的售后与「管理员决定最终退款金额」→ P0-13
- ❌ Earning 冲正 / 已 available 收益的处理 → P0-13（且需先裁定，见批次 §P0-13 特别停止条件）
- ❌ 第二套 Order / Refund / Notification / Auth / 复杂 Assignment
- ❌ 擅自扩 `OrderStatus`、擅自扩 `DispatchState`
- ❌ 任何 Git 写操作

---

## 已知冲突（**由本轮修正，不需产品裁定**）

**既有代码与 2026-09-23 新规冲突的地方只有一处**，且是本轮**必须改**的：

`lib/constants/refunds.ts:107-112` 的 `REFUNDABLE_ORDER_STATUSES` 今天含 **`paid` / `accepted` / `serving` / `completed`**，
因此 `paid` / `accepted` 的用户今天拿到的是**「提交退款申请 → 客服人工审核 → 管理员通过」**，
而新规要求这两档**直接全额退款、免审批**（PR-02 / BF-26 A / EX-REFUND-07），
且明文「**客服不得把「未开始服务直接退款」强行转成人工审批**」（`用户权限表.md:448`）。

⚠️ 这不是「两份权威文档冲突」，而是**代码落后于已冻结的需求**（`docs/03-dev/需求功能点进度表.md:109` / `:245` 早已把它挂成 🟠 `NEEDS_FIX`，并写明「**下批 `P0-12` 的目标**」）。
因此**不是 OPEN**，本轮按新规改写；具体口径（含「为什么不两条路并存」）见 `02-decisions.md` §二，实现决策见 §四 D1–D12。

---

## 本轮实际交付（一句话版）

| 事 | 落点 |
|---|---|
| 一个**新的**伪事务（既有退款审核那条一字未改） | `lib/data/directRefundTransaction.ts` |
| 一个用户接口 | `POST /api/orders/[id]/direct-refund`（**不读请求体**：没有可填的参数） |
| 一条**新的**通知（仓库里第一条收件人是打手的） | `REFUND_NOTIFICATION_COMPANION_REFUNDED` |
| 两个状态集合**拆开且互不相交** | `REFUNDABLE_ORDER_STATUSES`（两档）· `DIRECT_REFUNDABLE_ORDER_STATUSES`（两档） |
| 一个按钮（两下才退） | `components/refunds/DirectRefundButton.tsx` |
| **21 条**回归用例（含 2 条 HTTP 正例） | `tests/directRefund.test.mjs` |
| **2 条待产品追认**（存量退款记录原样不动） | `04-acceptance.md` §五 R1 / R2 |
| **两轮**只读复核，**0 BLOCKER / 0 MAJOR** | `03-delivery.md` §七 |

⚠️ **本轮顺带修正了一处既有文案失真**：派单状态「已超时关闭」→「已关闭」
（派单关闭从此有**两种**来路），连带同步 `lib/types/dispatch.ts` / `lib/types/staff.ts` /
`StaffOrderDetailPanels.tsx` 与 **P0-10 验收清单的 E4** —— 见 `02-decisions.md` D8。

---

## 五件档案

| 文件 | 行数 | 内容 |
|---|---|---|
| `01-prompt.md` | 51 | 原始指令档案（`cmd_p0-12.md` 原样拷贝） |
| `02-decisions.md` | 320 | Requirement Check 12 项逐条、与既有代码的唯一冲突、**D1–D12** 实现决策、待产品追认项 + §五.1 两处更正 |
| `03-delivery.md` | 489 | 实现结果与验证、**两轮 reviewer 结论与整改（§七）**、门禁读数、MINOR / NOTE、Git 状态 |
| `04-acceptance.md` | 295 | 人工验收清单（A–K 十一组 + 已知限制 + 两条待追认） |
| `README.md` | 本文件 | 本轮索引 |

**验收入口**：`04-acceptance.md` §二，**先看 A1 / A3 那一对**（两条路的分界线），
再看 **D 段**（保留绑定）与 **E 段**（打手真的收到通知，**必须用 `cp-10`**）。
