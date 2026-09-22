# P0-5.5 Decisions

> 本文件是**追加式**历史：后来改变的决定不删除，只追加新版本并给旧版本标
> `SUPERSEDED`。见 `development-workflow.md` §十九。

---

# 一、Requirement Check（§五 的 14 项）

在写任何业务代码之前完成。资料来自 `docs/01-requirements/`、`docs/02-tech-design/`、
`docs/03-dev/总需求进度表.md`、本轮 `01-prompt.md` 与相关源码 / 测试。

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 本轮产品规则是否完整 | ✅ 完整 | `architecture-rules.md` §7.1「产品裁定 2026-09-19」已逐项冻结；转移表内容亦已冻结 |
| 2 | 成功状态 | ✅ 明确 | 四项各自的成功态见下方《最终执行口径》，不新增任何业务成功态 |
| 3 | 失败状态 | ✅ 明确 | 迁移非法 → `canTransitionOrder` 返回 `false`；退款失败沿用既有 `AdminRefundWriteFailure` 五种情形 |
| 4 | 权限 | ✅ 明确 | Companion 接口一律 `requireCompanion()`；退款批准一律 `requireAdmin()`。本轮不新增权限、不改守卫 |
| 5 | 金额 | ✅ 明确 | `refunded` = **全额退款**，成功批准后 `refundedAmount === actualPaidAmount`；部分退款本轮不实现 |
| 6 | 幂等 | ✅ 明确 | 沿用既有 `takeReplayForAction` 重放判定 + `applyOrderRefund` 对已 `refunded` 的短路（`changed: false`） |
| 7 | 并发 | ✅ 明确 | 沿用伪事务「原子区段内无 `await`」惯例，本轮不新增并发语义 |
| 8 | Notification | ✅ 明确 | **本轮不动通知**：不改事件词表、不改幂等键、不引入 Event Bus |
| 9 | DTO / privacy | ✅ 明确 | 本轮不改任何 DTO 形状，池子字段白名单（BF-16）不变 |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ✅ 无 | 四项裁定均已给出可执行口径 |
| 11 | 是否与 `docs/01-requirements/` 冲突 | ✅ 无冲突 | 转移表与冻结语义（`refunded` = 全额）与需求文档一致 |
| 12 | 是否与 `docs/02-tech-design/` 冲突 | ✅ 无实质冲突 | 见下方《已记录的文档不一致（非 OPEN）》 |
| 13 | 是否与现有代码行为冲突 | ✅ 无冲突 | 现有三条状态写入路径（新建 `paid` / `applyOrderAccepted` / `applyOrderRefund`）都在冻结表内；未发现任何 `refunded → 其它` 的合法路径 |
| 14 | 是否存在会扩大 Scope 的诱因 | ⚠️ 有，已明确拒绝 | 见下方《本轮明确不做》 |

**结论：不存在 `Status: OPEN` 的决策。** 按 `development-workflow.md` §八，凡能用
仓库回答的问题一律不询问用户；上述 14 项中没有一项留下「两个以上合理方案且会改变
业务结果 / 权限 / 资金 / 状态机 / 长期架构」的歧义。

→ Round 状态：`PLANNED` → `READY`。

---

# 二、已记录的文档不一致（非 OPEN，不改动）

## N1 — `/companion/orders` 的轮次编号

Status: RECORDED（不阻塞，本轮不修改，也不扩范围）

### 事实

- `docs/03-dev/总需求进度表.md`：`开始服务 — accepted → serving` 的 `Round` 列是
  **`UNASSIGNED`**，并明确规定「编号由用户 / ChatGPT 在正式启动该轮时分配，
  **Claude 不得自行创造**」。
- `docs/02-tech-design/architecture-rules.md` §7.1 的落地批次列里，
  `/companion/orders`、`/companion/orders/[id]` 被写作 **`P0-6`**。
- 本轮 `01-prompt.md` §二十二明确：「不要把未来『开始服务』顺手编号成 P0-6。
  它继续保持 `UNASSIGNED`。」

### 为什么不进入 CLARIFYING

三份材料对**本轮应当做什么**的结论完全一致：不实现、不编号、不创建 Round。
分歧只在一个**未来轮次的标签**上，不改变业务结果 / 权限 / 资金 / 状态机 / 长期架构，
因此不满足 `development-workflow.md` §九的阻塞判定标准。

### 本轮处置

- 不改 `architecture-rules.md` 中该行（不在本轮 6 项范围内）；
- 不把 `/companion/orders` 登记进 Companion 路由清单（§九 明令禁止把 TARGET 写成 CURRENT）；
- 在 `03-delivery.md` 的「已知问题」中如实记录，交由用户在正式启动该轮时统一编号。

---

# 三、本轮最终执行口径

以下每一条都是**可执行规则**，实现与测试都以此为准。

## R1 — `ORDER_TRANSITIONS` / `canTransitionOrder`

**位置**：`lib/constants/orders.ts`（该文件当前的依赖全是 `import type` + 纯函数，
加入一张常量表与一个纯函数不会破坏「可被客户端组件引用」这一既有性质）。

**表内容（已冻结，不得改动）**：

```text
paid      -> accepted | refunded
accepted  -> serving  | refunded
serving   -> completed | refunded
completed -> refunded
refunded  -> []
```

**写法**：沿用仓库既有状态机惯用法 —— `Record<OrderStatus, readonly OrderStatus[]>`
+ `canTransitionOrder(from, to): boolean`。终态写空数组而不是省略，使「将来新增状态时
漏写迁移规则」成为编译错误。

**边界（必须写进注释，并被测试守住）**：

- 它只回答「这种迁移在结构上是否允许」，**不是**业务 Guard，也**不得**被用来绕过 Guard；
- `paid → accepted` 仍必须满足 Dispatch 合法 / deadline / Companion 资格 /
  self-order 禁止 / enabled-available / 并发 / 原子抢单；
- `serving → completed` 未来仍必须满足 CompletionSubmission + 客服审核通过；
- `completed → refunded` 只能通过合法的投诉 / 售后 / 退款流程进入，
  **不得因为表允许就提供任意按钮**。

**本轮不接入任何现有写入路径**：`applyOrderAccepted` / `applyOrderRefund` 的行为不变，
不新增调用点。本轮交付的是「中央定义 + 测试」，不是「用表替换 Guard」。

## R2 — `refunded` 的冻结语义

`Order.status === "refunded"` 表示**订单已全额退款**。当前
`refundedAmount === actualPaidAmount`。

未来实现部分退款时，**不得**因为 `refundedAmount > 0` 就自动把
`status` 置为 `refunded`——部分退款需要独立的资金语义。本轮不实现部分退款。

## R3 — 管理员人工退款写入 `refundedAmount`

**位置**：`lib/data/adminRefundTransaction.ts` 的 `approveRefund()`。

**规则**：批准成功时 `applyOrderRefund` 必须显式传入
**订单自己的 `actualPaidAmount`**（`Order.refundedAmount` 的类型注释即
「全额退款后等于 `actualPaidAmount`」）。

- 用**订单字段**而不是退款申请上的 `amount` 快照：同一事实只有一个真值源，
  金额一律取自被修改的那张订单；
- 必须保持**幂等**：重复批准不重复累计（`applyOrderRefund` 对已 `refunded`
  的订单返回 `changed: false`，不刷新 `refundedAt`，也不改 `refundedAmount`）；
- **已退款状态不能二次退款**：仍由 `canTransitionRefund` + 重放判定挡住；
- **不得改变 P0-5 公共池 timeout 自动退款路径**
  （`companionDispatchTransaction.ts` 已在传 `step.refundedAmount`，本来就是对的，不动）。

## R4 — Companion API 路由清单门禁

**范围**：只扫描 `app/api/companion/**` 下**当前真实存在**的 `route.ts`。
经核对，当前恰好两个：

```text
companion/dispatches/route.ts              GET    requireCompanion()   → listCompanionPools
companion/dispatches/[id]/accept/route.ts  POST   requireCompanion()   → acceptDispatchForCompanion
```

**必须断言**：路由清单固定（逐个写出而不是只断言数量）；每个路由**导出的 HTTP 方法**
与清单一致（多一个方法也要现形）；每个路由的第一动作是 `requireCompanion()`，
且不出现其它身份的守卫；每个路由引用的服务层函数与清单一致。

**不得**登记 `/companion/orders`、`/companion/orders/[id]` 等尚不存在的 TARGET 路由。
**不得**为本项新建测试框架或新目录结构，沿用现有 `tests/*.test.mjs` 的源码扫描写法。

## R5 — Checkout 复用中央接单资格判断

**位置**：`lib/services/checkout.ts` 的 `resolveCompanion()`（约 139 行）。

**规则**：`!isCompanionListed(companion) || !companion.available` 替换为
`!isCompanionAcceptingOrders(companion)`。两者语义本来就等价
（`isCompanionAcceptingOrders = isCompanionListed && available`），
替换后「打手当前能不能接新单」回到**一个业务谓词、多处复用**。

**不得**借此重构 Checkout 或 Companion、不得重写数据层、不得改接口形状、
不得改变任何对外文案与失败语义（仍是 `BAD_REQUEST` + 原文案）。

## R6 — 不抽 `isOwnOrder()`

self-order 的两层检查（池列表过滤 = 诚实性；原子区段 Guard = 安全性）本轮**都保留现状**，
两处手写重复仍是已知的 `P0-5 NON-BLOCKING`，不在已冻结的 P0-5.5 范围内。

---

# 四、本轮明确不做

- 不开始「开始服务」（`/companion/orders`、`/companion/orders/[id]`、`accepted → serving`）；
- 不实现完成材料、客服完成审核、Earning / Ledger、部分退款；
- 不做 Notification 重构（event vocabulary / idempotency key redesign / Event Bus）；
- 不拆 `adminHttp`、不拆大文件、不重构 OrderRepository / PaymentRepository；
- 不做 Session 重构（不合并 User / Admin / Staff 会话）、不删除或重构 `source.ts`；
- 不引入 DI / Event Bus / 数据库 / ORM；
- 不抽 `isOwnOrder()`；
- 不把 `/companion/orders` 提前登记为 CURRENT 路由；
- 不顺手修改 `architecture-rules.md` 中 N1 那一行的轮次标签。
