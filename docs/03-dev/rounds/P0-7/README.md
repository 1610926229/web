# P0-7 — accepted → serving（打手「开始服务」）

> 协议见 `docs/03-dev/development-workflow.md`。
> 本轮处于批次 `docs/03-dev/rounds/cmd_batch_p0-6.1_to_p0-9.md` 的**第二站**（P0-6.1 → **P0-7** → P0-8 → P0-9）。

Round ID: P0-7
Title: `accepted → serving` —— 由当前实际打手主动点击「开始服务」
Status: AWAITING_ACCEPTANCE
Depends On: P0-6.1（`AWAITING_ACCEPTANCE`，工作台返回入口 + 订单池等待最久优先）· P0-6（打手主动取消 + 回池，`53481ea`）· P0-5（派单 / 接单，`77877e0`）· P0-5.5（订单状态迁移中央定义，`6bd10fc`）· P0-4（打手身份来自 User 会话）
Goal: 让**当前实际履约的打手**把一张 `accepted` 订单推进到 `serving`，并冻结 `servingAt`；同时保证「不能自动开始、不能由客服代替、不能由别的打手开始」
Primary Domain: Order 状态迁移 · 打手订单动作（Companion）· 伪事务原子性
Primary State Transition: **`accepted → serving`**（本轮唯一新增的迁移）
Started At: 2026-09-24
Development Completed At: 2026-09-24
Accepted At: 2026-09-24
Git Commit:

> ⚠️ **本轮不实现**：CompletionSubmission、客服完成审核、10 分钟自动审核、Earning、
> complaint settlement、`serving` 的普通主动取消、封禁回池、客服换人、新退款资金联动、
> 打手聊天、Scheduler、DB / ORM（`01-prompt.md` §九）。

---

## 本轮范围（以 `01-prompt.md` 原文为准）

### 一、正式产品规则

只有同时满足：

```
Order.status === "accepted"
Order.actualCompanionId === 当前 companionId
```

的**当前实际打手**可以执行「开始服务」。`companionId` **必须**来自 `requireCompanion()`；
**禁止**从请求体接收 `companionId` 作为身份依据。

状态变化 `accepted → serving`，同时记录 `servingAt = at`。

**不得**：根据时间自动开始 / 根据预约备注自动开始 / 打开页面自动开始 / 聊天开始自动开始 /
客服代替正常打手执行普通开始服务 / 其他 Companion 开始这张订单。

`actualCompanionId` 保持不变；`acceptedAt` 是历史事实，**不因进入 serving 被抹掉**。

### 二、API

`POST /api/companion/orders/[id]/start`（已冻结 TARGET，见 `api-contract.md` §3.1）：

- 第一动作 `requireCompanion()`；
- 服务端重新校验 ownership；
- 主要业务规则放 service / transaction，不堆 Route Handler；
- 用中央 `ORDER_TRANSITIONS / canTransitionOrder` 作为**结构校验之一**，领域 Guard 仍单独存在；
- **不因状态机允许其它迁移而开放其它动作**；
- 同步 Companion API manifest gate。

### 三、原子性与幂等

原子区段内**不得 `await`**；`读 Order → 校验 accepted/ownership → 写 serving/servingAt`
必须在同一段同步代码里。重复点击**不得刷新 `servingAt`**、不得产生重复副作用；
复用现有动作的安全重放模式，**不新建通用幂等框架**。

### 四、Companion UI（`/companion/orders/[id]`）

仅当前 `actualCompanion` 且 `status === "accepted"` 显示「开始服务」；
成功后页面反映 `serving`、「开始服务」按钮消失、**普通「取消接单」按钮也必须消失**
（`serving` 不允许打手普通主动取消）；**不要求重新登录或重新进入订单**。
客户端只负责交互，服务端必须完整 Guard。

### 五、用户侧 / 后台

既有用户订单详情、管理员订单详情若本来展示 status，应正确看到 `serving`。
**本轮不要新增 `completion_review`**（属于 P0-8）。

### 六、通知

需求 / 技术设计**未冻结**「开始服务」的生命周期通知 → **本轮不新增任何产品通知**
（结论与依据见 `02-decisions.md` D6）。

---

## 本轮明确不做（`01-prompt.md` §九）

CompletionSubmission · 客服完成审核 · 10min 自动审核 · Earning · complaint settlement ·
`serving` 普通主动取消 · 封禁回池 · 客服换人 · 新退款资金联动 · 打手聊天 · Scheduler · DB / ORM。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（**`docs/03-dev/rounds/cmd_p0-7.md` 的逐字副本**，`cmp` 校验一致） |
| `02-decisions.md` | Requirement Check 结论与本轮执行口径（D1–D8） |
| `03-delivery.md` | 实现结果与验证（含本轮 delta、门禁、reviewer） |
| `04-acceptance.md` | 人工验收 Checklist 与验收记录 |

---

## 批次模式

- 批次在每轮 `AWAITING_ACCEPTANCE` 且满足 batch §四 的 10 条继续条件后，
  **不等待用户逐轮确认，自动进入下一轮**（本轮的下一站是 P0-8）；
- 四轮的 `User Result` / `Final Result` 一律保持 `PENDING`，由用户在 **P0-9 完成后一次性验收**；
  📌 **该统一验收已于 2026-09-24 完成，四轮全部 `PASSED`**（见下方「人工验收」一节）；
- ⚠️ 因此本轮**不会**出现 P0-6 / DEV-1 那样的「验收通过 + 用户本人提交」双门槛收口——
  它停在 `AWAITING_ACCEPTANCE`，等待批次结束后的统一验收。

---

## 人工验收（2026-09-24，批次统一验收）

> 📌 **验收已通过。** 用户本人于 **2026-09-24** 走完 `04-acceptance.md` 的 A–F 各组验收，
> 覆盖 `accepted → serving` 的本人入口、两个动作入口同时消失、归属边界（404 / 401）、
> 状态守卫（400、不越界）、幂等重放（`changed: false`、`servingAt` 不刷新）与回归组，
> 并确认**全部通过**：`User Result = PASSED` / `Final Result = PASSED`，`Issues Found` 无。

| 项 | 值 |
|---|---|
| Accepted At | **2026-09-24** |
| User Result | **PASSED** |
| Final Result | **PASSED** |
| Git Commit | （**由用户本人提交**，待填） |
| Status | **仍为 `AWAITING_ACCEPTANCE`** |

> ⚠️ **为什么验收通过了状态还不是 `DONE`**：按 `development-workflow.md` §十七 的「DONE 双门槛」，
> 需要 ① 用户本人说明验收通过 **且** ② 用户本人完成 Git 提交。**② 尚未发生**——
> 整个批次（P0-6.1 → P0-9）的改动至今全部躺在工作区，Claude 全程**零 Git 写操作**。
> 用户本人提交之后，本轮的 Status 才改为 `DONE`。
