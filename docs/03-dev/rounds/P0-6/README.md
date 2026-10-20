# P0-6 — accepted 主动取消接单 + 重新进入公共池

> 协议见 `docs/03-dev/development-workflow.md`。
> 上一轮 P0-5.5 已 `DONE`（提交 `6bd10fc`）；本轮**不得反向修改其历史结论**。

Round ID: P0-6
Title: accepted 主动取消接单 + 重新进入公共池（含打手「我的订单」最小入口）
Status: DONE
Depends On: P0-5（派单 / 接单，`77877e0`）· P0-5.5（订单状态迁移中央定义，`6bd10fc`）· P0-1（公共池超时配置）· P0-2（通知写入）
Goal: 让已经成功接单、但尚未开始服务的实际打手能够填写原因后主动取消，订单原子地回到公共池等待他人接单；同时补齐打手「我的订单」最小入口，使该业务在界面上真正可操作
Primary Domain: Order 生命周期 · Dispatch 回池 · 履约退出历史 · Companion 订单归属 · 通知
Primary State Transition: **`accepted → paid`**（本轮唯一新增的可执行迁移；`serving → paid` 只进结构表、不提供入口）
Started At: 2026-09-23
Development Completed At: 2026-09-23
Accepted At: 2026-09-24
Git Commit: 53481ea

> ✅ **`P0-6 DONE — implementation committed in 53481ea`**
>
> 「DONE 的双重门槛」（`development-workflow.md` §十七）**两个条件均已满足**：
> 1. **用户明确说明人工验收通过**（2026-09-24，`User Result` / `Final Result` = `PASSED`，
>    多角色链路 `用户下单 → A 接单 → A 取消 → 回公共池 → B 抢单 → 用户看通知` 全程未进管理端）；
> 2. **用户本人完成 Git 提交**：`53481ea`（`打手取消订单后订单重回订单池`），
>    只读核对 `git show --name-only 53481ea` 确认同时包含本轮实现与测试。
>
> 提交由**用户本人**执行；Claude 未执行任何 Git 写操作。
>
> ⚠️ **验收后另发现两个整改项**（FIX-1 打手工作台缺返回入口 / FIX-2 订单池排序改为
> 「等待最久优先」）。二者**不属于本轮冻结范围**，**不推翻本轮 `DONE` 结论**，已登记为
> 独立的 `NEEDS_FIX` 待办（见 `04-acceptance.md` 的 `Issues Found` 与
> `../总需求进度表.md`），**不回写本轮历史实现描述**。

---

## 本轮范围（以 `01-prompt.md` 原文为准）

1. `accepted` 主动取消的事务与领域 Guard（仅当前 `actualCompanion`、必须填写原因）；
2. 最小履约退出历史 `CompanionReleaseRecord`（`source = companion_cancel`）；
3. Dispatch 原子回公共池并**重新冻结** `publicPoolEnteredAt` / `publicTimeoutMinutesSnapshot` / `publicDeadlineAt`；
4. `ORDER_TRANSITIONS` 按 2026-09-23 TARGET 结构更新（本轮只接入 `accepted → paid` 一条）；
5. 取消成功后通知下单用户（复用现有 Notification 写入通道与 `kind: "dispatch"`）；
6. 打手「我的订单」最小页面与三个接口 + Companion API route manifest 同步；
7. 客服 / 管理员可见最小取消历史（**两半均已兑现**）；
   - **管理员**：`/admin/orders/[id]` 的「履约退出历史」区（首次交付即已实现）。
   - **客服**：首次交付时曾记为「待裁定的缺口」，**用户在人工验收阶段明确裁定这是最新需求已冻结的要求**，
     已补齐——**不新增任何 Staff 接口**，把退出历史挂到客服已在用的三个只读详情 DTO 上
     （会话 / 投诉 / 退款详情）。详见 `02-decisions.md` **D6 V3 (CURRENT)**（V2 已标 SUPERSEDED）
     与 `03-delivery.md` §1.1 / §9 / §2.4；
8. 以上各项的回归测试与技术设计文档同步。

---

## 本轮明确不做（`01-prompt.md` §十四）

`accepted → serving` · CompletionSubmission · 自动完成审核 · Earning · 投诉结算 ·
serving 用户退款售后 · accepted 用户直接退款 · 打手封禁回池 · 客服主动换人 ·
打手聊天 · 新聊天隔离 · 罚款 · 会费 · B/A/S · 并发上限 · 提现 · 部分退款 · 优惠券 ·
Scheduler · DB / ORM · 微信 OAuth · 微信真实支付 · 复杂 Assignment 系统 · 无关大型重构。

> 均已存在 TARGET 规则，但**不属于本轮 scope**。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（原文，未加工） |
| `02-decisions.md` | Requirement Check 结论与本轮最终执行口径 |
| `03-delivery.md` | 实现结果与验证 |
| `04-acceptance.md` | 人工验收 Checklist 与验收记录 |
