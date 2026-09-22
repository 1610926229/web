# P0-5.5 — 小型架构稳定化

> 这是 **Development Round Protocol 建立后的第一个完整 Round**。
> 协议见 `docs/03-dev/development-workflow.md`。

Round ID: P0-5.5
Title: 小型架构稳定化（订单状态迁移中央定义 / 管理员退款金额修复 / Companion 接口清单门禁 / Checkout 接单资格收敛）
Status: AWAITING_ACCEPTANCE
Depends On: P0-5（派单 / 接单，已完成编码并人工验收通过，commit `77877e0`）
Goal: 在不扩大业务范围的前提下，收口四处已经架构审查确认的结构性问题
Primary Domain: Order 生命周期 · 退款金额 · Companion API 契约 · Checkout 资格判定
Primary State Transition: 无新增可执行迁移。本轮只**声明**订单状态迁移表（`ORDER_TRANSITIONS`），不新增任何一条会真正改状态的业务路径
Started At: 2026-09-21
Development Completed At: 2026-09-21
Accepted At:
Git Commit:

> ⚠️ **`AWAITING_ACCEPTANCE` 不是完成。** 转为 `DONE` 需要**两个条件同时满足**：
> 用户明确说人工验收通过 **+** 用户已自行完成 Git commit。
> Claude **不得**自行标 `DONE`、**不得**执行任何 Git 写操作。
> 人工验收清单见 `04-acceptance.md`。

---

## 本轮范围（已冻结，不得增删）

1. `ORDER_TRANSITIONS` + `canTransitionOrder(...)` —— 结构性状态迁移合法性；
2. 修复 `adminRefundTransaction` 的人工退款金额（`refundedAmount`）；
3. Companion API 路由清单门禁（只覆盖**当前真实存在**的接口）；
4. Checkout 复用中央接单资格判断（`isCompanionAcceptingOrders`）；
5. 以上四项的对应测试；
6. 对应的技术设计文档同步。

范围原文见 `01-prompt.md`（未摘要、未改写）；已冻结的裁定见
`docs/02-tech-design/architecture-rules.md` §7.1 与「产品裁定 2026-09-19」。

---

## 本轮明确不做

- 不开始「开始服务」（`/companion/orders`、`/companion/orders/[id]`、`accepted → serving`）；
- 不实现完成材料、客服完成审核、Earning / Ledger、部分退款；
- 不重构 Notification、不拆 `adminHttp`、不重构 Session、不动 `source.ts`、
  不重构 `OrderRepository` / `PaymentRepository`、不拆大文件、不引入 DI / Event Bus / DB / ORM；
- 不抽 `isOwnOrder()`（self-order 的两层手写重复是已知 `P0-5 NON-BLOCKING`）。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（原文，未加工） |
| `02-decisions.md` | Requirement Check 结论与本轮最终执行口径 |
| `03-delivery.md` | 实现结果与验证 |
| `04-acceptance.md` | 人工验收 Checklist 与验收记录 |
