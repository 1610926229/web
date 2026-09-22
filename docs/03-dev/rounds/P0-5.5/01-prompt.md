# P0-5.5 Round — 原始 Prompt（原样保存，不得摘要 / 改写 / 删除）

> 本文件是本轮 **Scope 的原始证据**。以下是用户发送的本轮开发 Prompt 原文，一字未改。

---

现在开始正式开发：

# P0-5.5 — 小型架构稳定化

这是 Development Round Protocol 正式建立后的：

**第一个完整 Round。**

本轮必须完整执行：

```text
Round 创建
→ 保存原始 Prompt
→ Requirement Check
→ 必要时 CLARIFYING
→ READY
→ Agent 实施
→ 自动测试
→ Reviewer
→ Delivery
→ 人工验收
→ 用户手动 Git commit
→ DONE
```

注意：

Claude 完成代码不等于 DONE。

只有：

1. 用户明确人工验收通过；
2. 用户明确告诉你已经手动 Git commit；

两个条件都满足后，本 Round 才允许标记：

`DONE`

---

# 一、开始前先确认 Git 基线

首先只读执行：

```text
git status
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
```

目标：

确认 P0-5 已经由用户手动提交。

如果仍存在明显属于 P0-5 的未提交业务代码：

不要开始 P0-5.5。

进入：

`BLOCKED`

并告诉用户：

P0-5 尚未形成干净提交基线。

禁止：

* git add
* git commit
* git push
* git reset
* git restore
* git checkout
* rebase
* amend

Git 写操作始终由用户本人执行。

---

# 二、正式创建 P0-5.5 Round

确认基线正确后创建：

```text
docs/03-dev/rounds/P0-5.5/
```

必须包含：

```text
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

这是第一个完整执行 Round Protocol 的 Round。

---

# 三、01-prompt.md 必须保存本消息原文

必须把用户发送的本轮开发 Prompt：

**原样保存**

到：

```text
docs/03-dev/rounds/P0-5.5/01-prompt.md
```

不能：

* 摘要；
* 改写；
* “优化”；
* 删除重复内容；
* 只保存范围列表。

01-prompt.md 是本轮 Scope 的原始证据。

---

# 四、读取项目权威资料

开始实现前必须读取：

```text
CLAUDE.md

docs/01-requirements/
docs/02-tech-design/
docs/03-dev/development-workflow.md
docs/03-dev/总需求进度表.md

docs/03-dev/rounds/P0-5.5/01-prompt.md
docs/03-dev/rounds/P0-5.5/02-decisions.md
```

同时检查与以下领域相关的源码和测试：

* Order
* Refund
* Companion
* Checkout
* API route manifest
* state transition
* repository / transaction
* HTTP tests

---

# 五、先做 Requirement Check

不要收到 Prompt 就直接写代码。

Coordinator 必须先检查：

1. 本轮产品规则是否完整；
2. 成功状态；
3. 失败状态；
4. 权限；
5. 金额；
6. 幂等；
7. 并发；
8. Notification；
9. DTO / privacy；
10. 是否存在 TBD；
11. 是否和 `docs/01-requirements/` 冲突；
12. 是否和 `docs/02-tech-design/` 冲突；
13. 是否和现有代码行为冲突；
14. 是否存在会扩大 Round Scope 的诱因。

如果存在真正阻塞开发的产品 / 架构歧义：

进入：

```text
CLARIFYING
```

并写入：

```text
02-decisions.md
```

然后统一向用户提问。

不要不懂装懂。

但代码中可以自己查清楚的问题不要问用户。

---

# 六、本轮唯一允许的业务 / 架构范围

P0-5.5 只允许以下 6 项：

## 1. Order 状态迁移中央定义

正式增加：

```text
ORDER_TRANSITIONS
```

以及：

```text
canTransitionOrder(...)
```

结构性允许关系已经冻结：

```text
paid
→ accepted
→ refunded

accepted
→ serving
→ refunded

serving
→ completed
→ refunded

completed
→ refunded

refunded
→ []
```

更准确表示为：

```text
paid      -> accepted | refunded
accepted  -> serving  | refunded
serving   -> completed | refunded
completed -> refunded
refunded  -> []
```

注意：

这只是：

**结构性状态迁移合法性。**

它不能替代具体业务 Guard。

例如：

```text
paid → accepted
```

仍然必须满足：

* Dispatch 合法；
* deadline；
* Companion 资格；
* self-order 禁止；
* enabled / available；
* 并发；
* 原子抢单；

等现有业务规则。

再例如：

```text
serving → completed
```

未来仍然必须满足：

* CompletionSubmission；
* 客服审核通过。

因此：

`canTransitionOrder`

不能变成：

> 只要状态表允许，就可以直接改状态。

---

# 七、关于 refunded 状态的冻结语义

当前项目中：

```text
Order.status = refunded
```

表示：

**订单已全额退款。**

当前：

```text
refundedAmount = actualPaidAmount
```

部分退款未来实现时：

不得因为：

```text
refundedAmount > 0
```

就自动：

```text
Order.status = refunded
```

未来部分退款需要独立资金语义。

本轮：

不实现部分退款。

---

# 八、修复 adminRefundTransaction refundedAmount Bug

已有架构审查发现：

人工退款批准路径：

```text
adminRefundTransaction
```

调用：

```text
applyOrderRefund
```

时可能没有正确写入：

```text
refundedAmount
```

结果可能出现：

```text
Order.status = refunded
```

但：

```text
refundedAmount = 0
```

本轮必须修复。

当前人工批准退款仍然只有：

**全额退款。**

因此成功批准时：

```text
refundedAmount = actualPaidAmount
```

必须保持：

* 幂等；
* 重复批准不重复累计；
* 已退款状态不能二次退款；
* 不修改 P0-5 已正确的公共池 timeout 自动退款路径。

增加回归测试。

---

# 九、Companion API Route Manifest Gate

当前 Admin / Staff 已存在 route manifest / gate 模式。

Companion API 本轮补齐同类保护。

目标：

让 Companion API 的：

* 路由；
* 方法；
* Auth；
* 预期服务层；

有统一、可自动检查的契约。

至少覆盖当前已经存在的 Companion API。

不要因为未来已经规划：

```text
/companion/orders
/companion/orders/[id]
```

就提前创建这些路由。

它们属于后续“开始服务” Round。

本轮 gate 只描述：

**当前真实存在的 Companion API。**

不要伪造 TARGET route 为 CURRENT。

---

# 十、Checkout 接单资格判断收敛

当前审查发现 Checkout 内存在一份：

Companion 是否可接受订单

的重复判断。

本轮目标：

复用已有中央判断，例如：

```text
isCompanionAcceptingOrders(...)
```

或项目当前等价的中央 helper。

要求：

Checkout 不再自己维护第三套：

* enabled；
* available；
* qualification；

组合规则。

目标是：

```text
一个业务谓词
→ 多处复用
```

不要因此：

* 重构 Checkout；
* 重构 Companion；
* 重写数据层；
* 改接口形状。

只做最小收敛。

---

# 十一、不要顺手处理 self-order helper

P0-5 人工验收前已经确认：

self-order 当前存在两层检查：

```text
Pool list filter
```

负责：

UX / honesty

以及：

```text
accept transaction Guard
```

负责：

security / invariant

两层都必须存在。

目前两处判断条件手写重复：

这是已知：

`P0-5 NON-BLOCKING`

本轮：

**不要抽 `isOwnOrder()`。**

它不属于已经冻结的 P0-5.5 范围。

不要因为正在做“中央 predicate”就顺手把所有 predicate 都中央化。

---

# 十二、本轮必须补测试

使用 test-agent。

至少覆盖：

## ORDER_TRANSITIONS

测试：

```text
paid → accepted       true
paid → refunded       true

accepted → serving    true
accepted → refunded   true

serving → completed   true
serving → refunded    true

completed → refunded  true

refunded → any        false
```

同时验证非法迁移：

例如：

```text
paid → completed
paid → serving
accepted → completed
completed → serving
refunded → paid
```

必须 false。

---

## adminRefundTransaction

至少覆盖：

```text
批准全额退款
→ status = refunded
→ refundedAmount = actualPaidAmount
```

以及：

* 重复执行；
* 已退款保护；
* 不出现退款金额重复累计。

---

## Companion API route manifest

测试当前真实路由：

* 必须在 manifest；
* 方法正确；
* Auth gate 正确；
* 不允许 Companion API 静默新增未登记路由。

不要登记尚不存在的未来 API。

---

## Checkout predicate reuse

测试至少证明：

Checkout 与 Companion 中央接单资格规则不会因为：

* enabled；
* available；

不同而产生不一致。

不要通过复制相同判断到测试中制造“假统一”。

---

# 十三、Agent 使用顺序

本轮没有新 UI。

默认：

```text
Coordinator
↓
backend-agent
↓
test-agent
↓
reviewer-agent
↓
Coordinator
```

正常情况下：

不需要 frontend-agent。

如果确实发现某一修改必须触及 UI：

先判断是否已经越过 P0-5.5 Scope。

不要为了“让四个 Agent 都参与”强行使用 frontend-agent。

---

# 十四、Backend Agent 范围

backend-agent 负责：

* Order transition constants / helper；
* admin refund 修复；
* Companion route manifest；
* Checkout predicate reuse；
* 必要的类型 / 服务层最小修改。

如果遇到：

```text
PRODUCT_DECISION_REQUIRED
```

或：

```text
ARCHITECTURE_DECISION_REQUIRED
```

立即返回 Coordinator。

不要自行裁决。

---

# 十五、Test Agent 范围

test-agent：

只修改测试。

负责：

* 状态迁移测试；
* refund amount 回归测试；
* Companion route manifest 测试；
* Checkout predicate reuse 回归测试；
* 相关非法状态 / 边界测试。

不要通过修改业务代码让测试通过。

---

# 十六、Reviewer 范围

Reviewer：

只读。

不得修代码。

重点检查：

1. `ORDER_TRANSITIONS` 是否只是结构边界；
2. 是否错误绕过现有业务 Guard；
3. refunded 是否仍代表全额退款；
4. admin refund 是否正确写金额；
5. 是否破坏 timeout 自动退款；
6. route manifest 是否只覆盖 CURRENT API；
7. 是否提前加入 P0-6 API；
8. Checkout 是否真正复用中央 predicate；
9. 是否出现新的重复业务规则；
10. 是否越过 P0-5.5 范围。

输出仅：

```text
BLOCKER
MAJOR
MINOR
NOTE
```

---

# 十七、明确禁止的工作

P0-5.5 不允许：

## 不做 Notification 重构

包括：

* event vocabulary；
* idempotency key redesign；
* Event Bus。

---

## 不拆 adminHttp

即使文件很大也不处理。

---

## 不做 Session 重构

不合并：

* User；
* Admin；
* Staff；

Session。

---

## 不删除 / 重构 source.ts

---

## 不重构 OrderRepository / PaymentRepository

---

## 不拆大文件

---

## 不引入 DI

---

## 不引入 Event Bus

---

## 不引入数据库 / ORM

---

## 不开始“开始服务”

禁止：

```text
/companion/orders
/companion/orders/[id]
accepted → serving
```

它们属于下一业务 Round。

当前仍：

`UNASSIGNED`

不要自行编号为 P0-6。

---

## 不实现完成材料

---

## 不实现客服完成审核

---

## 不实现 Earning / Ledger

---

## 不实现部分退款

---

# 十八、Round 文档维护

只有：

**Coordinator**

可以修改：

```text
docs/03-dev/rounds/P0-5.5/README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

Sub-Agent：

不得直接写这些文件。

Sub-Agent 的结构化结果由 Coordinator 汇总后写入。

---

# 十九、README 状态流转

本轮开始：

```text
PLANNED
```

Requirement Check：

如无问题：

```text
READY
```

开始实现：

```text
IN_PROGRESS
```

编码 / 测试 / Reviewer 完成：

```text
AWAITING_ACCEPTANCE
```

只能在：

用户人工验收通过

并且：

用户明确告知 Git commit 已完成

之后：

```text
DONE
```

---

# 二十、03-delivery.md

编码结束后由 Coordinator 写入：

```text
03-delivery.md
```

至少记录：

* 本轮实现内容；
* 修改文件；
* 状态迁移规则；
* refund 修复；
* route manifest；
* Checkout predicate reuse；
* tests；
* typecheck；
* lint；
* build；
* full HTTP test；
* Reviewer 结果；
* 已知 NON-BLOCKING；
* 明确 out-of-scope；
* 推荐 Git commit message。

不得说：

“测试通过”

除非实际执行过。

---

# 二十一、04-acceptance.md

编码完成时：

只生成：

人工验收 Checklist。

此时状态：

```text
AWAITING_ACCEPTANCE
```

不要提前写：

“验收通过”。

用户验收后：

再记录：

* 用户验收结果；
* 发现的问题；
* 返工；
* 最终结果；
* Git commit。

历史只追加，不覆盖。

---

# 二十二、全局进度表

本轮开始时：

可以在：

```text
docs/03-dev/总需求进度表.md
```

中正式增加 / 更新：

```text
P0-5.5
```

因为本轮现在已经真正启动。

状态按真实阶段维护。

不要把未来：

“开始服务”

顺手编号成 P0-6。

它继续保持：

```text
UNASSIGNED
```

---

# 二十三、自动验证

实现完成后至少执行：

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

并按照项目现有方式：

启动 production server 后执行：

```text
APP_BASE_URL=<server> pnpm test
```

最终必须分别报告：

```text
普通 pnpm test
```

中的：

* total；
* pass；
* fail；
* skipped；

以及：

```text
APP_BASE_URL
```

完整测试中的：

* total；
* pass；
* fail；
* skipped。

不得把 skipped 当作 passed。

---

# 二十四、最终输出

完成实现后报告：

## A. Round 状态

应该为：

```text
AWAITING_ACCEPTANCE
```

而不是 DONE。

## B. 实现内容

逐项：

```text
ORDER_TRANSITIONS
admin refund refundedAmount
Companion API manifest
Checkout predicate reuse
```

## C. 测试

报告真实数字。

## D. Reviewer

分别报告：

```text
BLOCKER
MAJOR
MINOR
NOTE
```

## E. Scope Check

明确：

哪些 P0-5.5 项已完成；

确认：

没有实现：

* P0-6 / 开始服务；
* Notification 重构；
* DB / ORM；
* 部分退款；
* Earning。

## F. 人工验收 Checklist

给用户最小、明确的验收步骤。

---

# 二十五、停止条件

如果：

* 实现完成；
* 自动测试全绿；
* full HTTP test 全绿；
* Reviewer 无 BLOCKER；

则：

```text
P0-5.5 READY FOR MANUAL ACCEPTANCE
```

Round 状态：

```text
AWAITING_ACCEPTANCE
```

然后停止。

禁止：

* 自己标记 DONE；
* git add；
* git commit；
* git push；
* 自动开始下一 Round；
* 开始“开始服务”。

等待用户人工验收。
