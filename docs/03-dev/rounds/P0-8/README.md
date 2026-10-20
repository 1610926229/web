# P0-8 — CompletionSubmission：提交完成材料 + 客服审核 + 10 分钟自动审核

> 协议见 `docs/03-dev/development-workflow.md`。
> 本轮处于批次 `docs/03-dev/rounds/cmd_batch_p0-6.1_to_p0-9.md` 的**第三站**（P0-6.1 → P0-7 → **P0-8** → P0-9）。

Round ID: P0-8
Title: `serving` → 完成材料（`CompletionSubmission`）→ 客服人工审核 / 到期 System 自动审核 → `completed`
Status: DONE
Depends On: P0-7（`accepted → serving` + `servingAt` 冻结，`DONE`）· P0-6.1（工作台返回入口）· P0-6（打手主动取消 + 回池）· P0-5（派单 / 接单）· P0-5.5（订单状态迁移中央定义）· P0-1（平台参数真值源 `PlatformConfig`）· P0-4（打手身份来自 User 会话）· P8D-2（客服工作台壳层 / auth / DTO 组织）
Goal: 让 `serving` 订单经由**打手提交完成材料**、**客服人工审核**或**到期 System 自动审核**进入 `completed`；同时保证「同一订单最多一份 pending」「配置改动不追溯已 pending 的 deadline」「自动通过与人工通过并发只能产生一个完成事实」「自动审核不伪装成客服人工审核」
Primary Domain: Order 状态迁移 · 完成材料（CompletionSubmission）· 平台配置（PlatformConfig）· 伪事务原子性
Primary State Transition: **`serving → completed`**（本轮唯一新增的 Order 迁移）
Secondary State Machine: **`CompletionSubmission`：`pending → approved | rejected`**（`invalidated` 仅保留兼容，本轮无写入路径）
Started At: 2026-09-24
Development Completed At: 2026-09-24（含首轮 review 后的 A / B / M1 / M2 修复与门禁 22 / 23 补测）
Accepted At: 2026-09-24
Git Commit: eef4e62

> ⚠️ **本轮不实现**：Earning / `frozen → available` / withdrawal、部分退款冲正、
> 封禁回池及 pending invalidation 动作、客服换人、`serving` 普通主动取消、
> 真 Scheduler、DB / ORM、新对象存储基础设施（`01-prompt.md` §十二）。
>
> ⚠️ **`completion_review` 不是 `Order.status`**：它只是 `Order.serving + CompletionSubmission.pending`
> 的派生展示阶段，**禁止**进入 `OrderStatus`（`01-prompt.md` §零、§七）。

---

## 本轮范围（以 `01-prompt.md` 原文为准）

### 一、提交完成材料（打手）

只有同时满足：

```
Order.status === "serving"
Order.actualCompanionId === 当前 companionId
```

的**当前实际打手**可以提交。内容 = 截图 / 证明材料 + **5～50 字**完成说明。

证明材料复用仓库现有 evidence 约定（`SupportEvidence` / `parseEvidenceInput` / `toStoredEvidence`），
**不引入**对象存储、上传服务或新基础设施。

### 二、CompletionSubmission 生命周期

`pending | approved | rejected`（`invalidated` 仅保留兼容）。同一订单同时**最多 1 份 pending**；
rejected 后允许重新提交，且**不覆盖旧审核历史**；重提**重新读取配置并重新计时**；
approved 后不得再次提交改变 `completed` 事实。

### 三、自动审核配置（唯一真值源：`PlatformConfig`）

默认 **10 分钟**，后台可配置。提交进入 pending 时冻结
`autoApprovalMinutesSnapshot` / `autoApprovalDeadlineAt`（`= submittedAt + snapshot`）。
后台之后修改配置**不影响**已 pending 的提交，只影响未来新提交 / rejected 后重提。

### 四、客服人工审核

`approve`：submission `pending` + Order `serving` → submission `approved` + Order `completed`
（`completedAt = at`），审核来源记为 **staff**，保留审核人 / 审核时间。
`reject`：submission → `rejected`，**Order 保持 `serving`**，必须记录驳回原因、审核人、审核时间。
客服**不能绕过 CompletionSubmission** 把任意订单直接改 `completed`。

### 五、System 自动审核

`sweepCompletionAutoApprovals(at)`（同步、可测试）条件：submission `pending`、
`autoApprovalDeadlineAt <= at`、Order 仍 `serving`、尚未被人工处理、**不存在投诉 / 有效售后阻塞**。
成功 = submission `approved` + Order `completed` + `completedAt = at` + 来源 **System**。
重复 sweep 不重复完成、不刷新 `completedAt`、不重复产生副作用。

### 六、API（已冻结 TARGET，见 `api-contract.md` §3.2）

| Method | URL | Guard | Service |
|---|---|---|---|
| POST | `/api/companion/orders/[id]/completion` | `requireCompanion` | `companionCompletions` |
| GET | `/api/staff/completions` | `requireStaff` | `staffCompletions` |
| GET | `/api/staff/completions/[id]` | `requireStaff` | `staffCompletions` |
| POST | `/api/staff/completions/[id]/approve` | `requireStaff` | `staffCompletions` |
| POST | `/api/staff/completions/[id]/reject` | `requireStaff` | `staffCompletions` |

### 七、原子性

人工 approve 与 System auto approve 的核心写入必须保证 Order 与 Submission 一致；
Mock 伪事务原子区段**不得 `await`**。至少不能出现：submission approved 但 Order 仍 serving ·
Order completed 但 submission 仍 pending · reject 与 auto-approve 同时成功 ·
staff approve 与 auto-approve 重复完成。

---

## 本轮明确不做（`01-prompt.md` §十二）

Earning · `frozen → available` · withdrawal · 部分退款冲正 · 封禁回池及 pending invalidation 动作 ·
客服换人 · `serving` 普通主动取消 · 真 Scheduler · DB / ORM · 新对象存储基础设施。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（**`docs/03-dev/rounds/cmd_p0-8.md` 的逐字副本**，`cmp` 校验一致） |
| `02-decisions.md` | Requirement Check 结论与本轮执行口径（D1–Dn） |
| `03-delivery.md` | 实现结果与验证（含本轮 delta、门禁、reviewer） |
| `04-acceptance.md` | 人工验收 Checklist 与验收记录 |

---

## 批次模式

- 批次在每轮 `AWAITING_ACCEPTANCE` 且满足 batch §四 的 10 条继续条件后，
  **不等待用户逐轮确认，自动进入下一轮**（本轮的下一站是 P0-9）；
- 四轮的 `User Result` / `Final Result` 一律保持 `PENDING`，由用户在 **P0-9 完成后一次性验收**；
  📌 **该统一验收已于 2026-09-24 完成，四轮全部 `PASSED`**（见下方「人工验收」一节）；
- ✅ **该批次已于 2026-09-24 结束并统一验收通过**；四轮实现由**用户本人**提交于 **`eef4e62`**，
  本轮 Status 已随之收口为 `DONE`（「验收通过 + 用户本人提交」双门槛均已满足）。

---

## 人工验收（2026-09-24，批次统一验收）

> 📌 **验收已通过。** 用户本人于 **2026-09-24** 走完 `04-acceptance.md` 的 A–G 七组验收，
> 覆盖打手提交、客服人工通过 / 驳回 + 重提、到期自动通过、投诉 / 退款阻塞、
> 状态枚举与不越界、以及前四轮回归，并确认**全部通过**：
> `User Result = PASSED` / `Final Result = PASSED`，`Issues Found` 无。
> 📌 `D4`（已完结投诉不阻塞）与 `D5`（沿用 `1～1440` 上下限）两点在验收中**未提出异议**，按现有口径通过。

| 项 | 值 |
|---|---|
| Accepted At | **2026-09-24** |
| User Result | **PASSED** |
| Final Result | **PASSED** |
| Git Commit | **`eef4e62`**（用户本人提交） |
| Status | **`DONE`** |

> ✅ **收口（2026-09-24）**：按 `development-workflow.md` §十七 的「DONE 双门槛」，两个条件**均已满足** ——
> ① 用户本人说明验收通过（2026-09-24）；② 用户本人完成 Git 提交（**`eef4e62`**，本批次实现随该提交进入版本库）。
> 因此本轮 Status 已由 `AWAITING_ACCEPTANCE` 收口为 `DONE`。
> ⚠️ **这是纯文档收口**：`User Result` / `Final Result` / `Accepted At` 与验收结论**一律未改动**，业务代码与测试未被触碰。
