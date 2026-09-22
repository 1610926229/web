现在开始新的正式开发 Round：

# P0-6 — 开始服务

本轮是订单主生命周期从：

```text
accepted
→ serving
```

真正落地的一轮。

本轮核心目标：

**已经成功接单的实际履约打手，可以在自己的订单详情中明确点击“开始服务”，由服务端将订单从 accepted 推进到 serving。**

本轮同时补齐 Companion 自己的订单列表与订单详情入口。

---

# 一、开始前先完成上一 Round 基线检查

首先只读执行：

```text
git status
git branch --show-current
git rev-parse HEAD
git log -3 --oneline
```

必须确认：

P0-5.5 已经由用户人工验收通过，并已经由用户本人完成 Git commit。

如果当前仍存在明显属于 P0-5.5 的未提交：

* 业务代码；
* 测试；
* Round 文档；
* 技术文档；

则：

```text
BLOCKED
```

不要开始 P0-6。

禁止替用户执行：

* git add
* git commit
* git push
* git reset
* git restore
* git checkout
* rebase
* amend

---

# 二、关闭 P0-5.5 的状态要求

如果仓库与 Round 文档已经明确证明：

1. P0-5.5 人工验收通过；
2. 用户已经自行 Git commit；

则根据 `development-workflow.md` 将 P0-5.5 视为满足 DONE 条件。

如 P0-5.5 的：

```text
README.md
04-acceptance.md
总需求进度表
```

仍只是 `AWAITING_ACCEPTANCE`，按照现有 Round Protocol 做最小状态同步。

不得借此修改 P0-5.5 业务代码。

如果这会产生必须单独提交的上一 Round 收尾文档，先报告，不要把来源不清的历史修改混进 P0-6。

---

# 三、正式创建 P0-6 Round

确认前置基线满足以后：

创建：

```text
docs/03-dev/rounds/P0-6/
```

包含：

```text
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

本消息原文必须原样保存到：

```text
01-prompt.md
```

不能摘要或改写。

---

# 四、更新全局进度表

此前：

“开始服务”

在：

```text
docs/03-dev/总需求进度表.md
```

中为：

```text
UNASSIGNED
```

现在本轮正式启动，因此将它正式分配为：

```text
P0-6
```

初始状态按 Round 实际阶段维护。

不要顺便给：

* 完成材料；
* 客服完成审核；
* 打手收益；
* 48h 结算；

分配编号。

它们继续保持：

```text
UNASSIGNED
```

---

# 五、开始实现前读取

必须读取：

```text
CLAUDE.md

docs/01-requirements/
docs/02-tech-design/
docs/03-dev/development-workflow.md
docs/03-dev/总需求进度表.md

docs/03-dev/rounds/P0-6/01-prompt.md
docs/03-dev/rounds/P0-6/02-decisions.md
```

重点检查：

* Order 状态机；
* Companion 身份；
* actualCompanionId；
* Dispatch；
* Order DTO；
* 用户订单；
* Companion API manifest；
* 权限；
* Privacy；
* P0-5 / P0-5.5 已冻结规则。

同时读取现有：

```text
/companion
/companion/exclusive
/companion/pool
```

以及订单相关 Repository / Service / API / tests。

---

# 六、Requirement Check

不要收到 Prompt 后直接编码。

Coordinator 先检查：

1. accepted → serving 的业务前置条件；
2. 谁能操作；
3. 非 actual companion 行为；
4. 已 serving 时重复操作语义；
5. completed / refunded 是否拒绝；
6. Order 与 Dispatch 是否需要同时变化；
7. API DTO；
8. 用户隐私；
9. 并发；
10. 幂等；
11. Notification；
12. 是否存在 TBD；
13. 是否与长期需求 / 架构冲突。

代码或文档能查清的问题：

自己查。

如果存在真正会改变产品行为、状态语义或权限语义的未冻结问题：

```text
CLARIFYING
```

写入：

```text
02-decisions.md
```

统一向用户提问。

不要自行发明规则。

---

# 七、本轮新增 Companion 页面

正式实现：

```text
/companion/orders
/companion/orders/[id]
```

这是 Companion 自己的履约订单系统。

不要创建第二套完全不同的订单详情体系。

后续“完成材料”也会继续复用：

```text
/companion/orders/[id]
```

只是未来在 `serving` 状态增加新的操作。

本轮不实现完成材料。

---

# 八、/companion/orders

该页面展示：

**当前 Companion 实际负责的订单。**

判断依据必须是：

```text
Order.actualCompanionId
```

不是：

```text
exclusiveCompanionId
```

更不是：

```text
用户最初指定了谁
```

---

## 当前进行中

至少包括：

```text
accepted
serving
```

---

## 已结束

至少包括：

```text
completed
refunded
```

如果项目现有 UI / 信息架构已有合理分页或 Tab 模式：

复用。

不要为了本轮重新设计复杂订单中心。

---

# 九、Companion 订单列表权限

一个 Companion 只能看到：

```text
actualCompanionId === 当前 Companion.id
```

的订单。

不能看到：

* 其他 Companion 的订单；
* 曾经被指定给自己但最终由别人接走的订单；
* 仅仅因为在 public pool 看过就获得访问权限的订单。

---

# 十、/companion/orders/[id]

详情页必须再次在服务端校验：

```text
order.actualCompanionId === currentCompanion.id
```

禁止只依赖列表页跳转。

非本人订单统一按照项目现有隐私策略处理。

优先沿用：

```text
404
```

或项目已经冻结的等价“不可枚举”语义。

不要泄露：

“订单存在但不属于你”。

---

# 十一、Companion Detail DTO

详情只返回当前履约真正需要的信息。

允许根据现有业务需求提供例如：

* 订单号；
* 商品；
* 规格；
* 数量；
* 增值服务；
* 游戏 / 区服；
* 当前状态；
* 创建时间；
* accepted 时间；
* 开始服务后 serving 时间；
* 履约必要的游戏账号信息；
* 履约备注。

必须遵守现有 DTO / privacy 设计。

不要因为 Companion 是履约方，就顺手暴露：

* 用户内部管理字段；
* 平台内部利润字段；
* 管理端审计字段；
* 无关支付内部信息；
* 客服内部处理信息。

---

# 十二、accepted → serving

本轮真正新增的状态写操作：

```text
accepted
→ serving
```

必须由：

**当前 actualCompanion**

显式点击：

```text
开始服务
```

触发。

系统不得：

* 接单成功后自动 serving；
* 根据时间自动 serving；
* 管理员代替自动 serving；
* 用户触发 serving。

---

# 十三、服务端 Start Guard

至少必须满足：

```text
Order.status === accepted
```

以及：

```text
Order.actualCompanionId === currentCompanion.id
```

同时必须继续满足现有 Companion 身份门禁。

结构状态检查应复用 P0-5.5 已建立的：

```text
canTransitionOrder(order.status, "serving")
```

但：

**canTransitionOrder 只负责结构合法性。**

它不能替代：

```text
actualCompanionId
```

等领域 Guard。

---

# 十四、开始服务成功后的状态

成功以后：

```text
Order.status = serving
```

并记录项目现有命名规范下的：

```text
servingAt
```

或现有文档中已经冻结的等价时间字段。

如果字段名仍未定义：

Requirement Check 时确认。

不要凭感觉同时创造多个时间字段。

---

# 十五、Dispatch 在 accepted → serving 时的处理

先检查当前长期设计。

原则上：

Dispatch 已经在接单成功时完成“谁负责这单”的职责。

P0-6 不应为了 serving 再创建第二套派单状态机。

如果当前 Dispatch 模型没有 `serving` 状态：

不要擅自添加。

Order 生命周期与 Dispatch 生命周期继续分离。

---

# 十六、重复点击 / 并发

必须明确测试：

同一个 Companion 快速重复点击“开始服务”。

不得产生：

* 第二次状态推进；
* servingAt 被反复刷新；
* 重复副作用。

如果项目现有状态写操作有既定 replay / idempotency 语义：

复用。

如果当前文档未冻结“重复 start 返回成功 replay 还是明确失败”：

Requirement Check 后判断是否需要：

```text
PRODUCT_DECISION_REQUIRED
```

不要自行创造新的全局 idempotency framework。

---

# 十七、其他 Companion 调用 Start API

如果：

```text
actualCompanionId = A
```

则 B 即使：

* 是有效 Companion；
* enabled=true；
* available=true；

也绝对不能：

```text
accepted → serving
```

必须测试直接 API 绕过 UI 的情况。

---

# 十八、非法状态

至少验证：

```text
paid → serving
serving → serving
completed → serving
refunded → serving
```

不能形成新的状态推进。

其中 `paid → serving` 必须被拒。

`completed / refunded` 不能重新进入履约。

对于重复 `serving → serving` 的 API 返回语义：

按照 Requirement Check 后确认的当前项目约定执行。

---

# 十九、available / enabled 与已经接到手的订单

重点检查长期需求：

`available`

主要控制：

**是否接受新订单。**

不要未经需求支持就推导：

```text
available=false
→ 已经 accepted 的订单自动失去履约权
```

同理：

enabled / 封禁后已有订单怎么办，如果当前仍是：

```text
TBD — DO NOT INVENT
```

则不要在 P0-6 顺手解决“打手封禁联动”。

如果它真正阻塞 Start API 的行为：

进入 CLARIFYING。

---

# 二十、页面行为

`/companion/orders/[id]`

当状态：

```text
accepted
```

并且当前 Companion 是：

```text
actualCompanion
```

显示：

```text
开始服务
```

成功后页面进入：

```text
serving
```

并且按钮消失。

状态为：

```text
serving
```

时：

本轮只展示状态。

不要增加：

```text
提交完成材料
```

按钮。

那属于下一业务 Round。

---

# 二十一、导航入口

在现有 Companion 工作台中增加合理的：

```text
我的订单
```

入口。

复用现有 Companion UI 风格。

不要重新设计整个工作台导航系统。

---

# 二十二、API

根据现有项目风格实现所需 CURRENT API。

预计至少需要等价能力：

```text
GET /api/companion/orders
GET /api/companion/orders/[id]
POST /api/companion/orders/[id]/start
```

但最终路径必须以：

* 现有 API convention；
* tech design；
* Requirement Check；

为准。

不要仅因为本 Prompt 写了示例路径就覆盖现有冻结架构。

---

# 二十三、Companion API Manifest

P0-5.5 已经建立 Companion API route manifest gate。

因此 P0-6 新增任何真实 Companion API 后：

必须同步登记 manifest。

测试必须继续保证：

```text
新增 route
但忘记登记
→ test fail
```

不能为了让门禁通过而关闭门禁。

---

# 二十四、测试要求

使用：

```text
backend-agent
test-agent
frontend-agent
reviewer-agent
```

建议顺序：

```text
Coordinator
→ backend-agent
→ test-agent
→ frontend-agent
→ test-agent
→ reviewer-agent
→ Coordinator
```

涉及状态写入与权限时：

不要并行修改同一文件。

---

# 二十五、Backend 测试重点

至少覆盖：

## List

```text
actualCompanion=A
→ A 可以看到

actualCompanion=B
→ A 看不到

exclusiveCompanion=A
actualCompanion=B
→ A 看不到
```

---

## Detail

```text
actualCompanion=A
→ A 可以读

actualCompanion=B
→ A 不能读
```

---

## Start

```text
accepted + actual=A + caller=A
→ serving
```

---

## 非本人

```text
accepted + actual=A + caller=B
→ reject
```

---

## 非法状态

覆盖：

```text
paid
completed
refunded
```

不能开始服务。

---

## 重复 / 并发

验证：

* 快速重复 start；
* 两个请求同时 start；

最终只能形成一个有效：

```text
accepted → serving
```

并且：

```text
servingAt
```

不被二次刷新。

---

# 二十六、HTTP / 权限测试

必须测试：

* 未登录；
* 普通用户但不是 Companion；
* Companion 访问自己的订单；
* Companion 访问别人的订单；
* 直接调用 start API；
* 错误 DTO 不泄露订单是否存在；
* 新 route 已进入 Companion manifest。

---

# 二十七、Frontend 测试重点

至少检查：

```text
/companion/orders
/companion/orders/[id]
```

状态：

* loading；
* error；
* empty；
* accepted；
* serving；
* completed；
* refunded。

accepted：

显示“开始服务”。

serving：

不再显示开始按钮。

completed / refunded：

只读。

不得出现：

* 完成材料；
* 客服审核；
* 收益；
* 结算；

等未来入口。

---

# 二十八、Notification

本轮不进行 Notification 架构重构。

如果现有长期需求已经明确：

“开始服务”必须产生某条通知，

则按现有 Notification writer 接入。

如果没有冻结：

不要发明新的通知事件。

---

# 二十九、明确 Out of Scope

本轮禁止实现：

## 完成材料

包括：

* 截图；
* 5~50 字说明；
* CompletionSubmission。

---

## 客服完成审核

禁止：

```text
serving → completed
```

真实业务入口。

虽然结构状态机允许：

```text
serving → completed
```

但 P0-6 不实现其领域 Guard 或 API。

---

## Earning / Ledger

不做。

---

## 48h frozen → available

不做。

---

## 部分退款

不做。

---

## 更换打手

不做。

---

## 打手聊天

不做。

---

## 打手封禁已有订单联动

除非现有冻结规则已经明确，否则继续：

```text
TBD — DO NOT INVENT
```

---

## B/A/S 并发上限

不做。

---

## Notification 重构

不做。

---

## DB / ORM / Scheduler

不做。

---

# 三十、Round 文档维护

只有 Coordinator 修改：

```text
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

Sub-Agent 不得写 Round 文档。

Sub-Agent 遇到产品 / 架构歧义：

返回：

```text
PRODUCT_DECISION_REQUIRED
ARCHITECTURE_DECISION_REQUIRED
```

Coordinator 统一进入 CLARIFYING。

---

# 三十一、状态流转

```text
PLANNED
→ CLARIFYING（如有）
→ READY
→ IN_PROGRESS
→ AWAITING_ACCEPTANCE
→ DONE
```

实现完成以后最多：

```text
AWAITING_ACCEPTANCE
```

只有：

1. 用户人工验收通过；
2. 用户明确告知 Git commit 已完成；

才允许：

```text
DONE
```

---

# 三十二、自动验证

完成后必须实际执行：

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

并运行：

```text
APP_BASE_URL=<production server> pnpm test
```

分别报告：

* total；
* pass；
* fail；
* skipped。

不能把 HTTP skipped 算通过。

---

# 三十三、Reviewer

Reviewer 只读。

重点审查：

1. Start 是否只能由 actualCompanion；
2. 是否真正要求 accepted；
3. 是否正确使用 canTransitionOrder 但没有依赖它代替业务 Guard；
4. 是否存在越权读取订单；
5. DTO 是否泄密；
6. servingAt 是否只能首次写入；
7. 重复 / 并发 Start 是否安全；
8. Dispatch 是否被错误扩展成第二套 Order 状态机；
9. Companion manifest 是否同步；
10. 是否偷偷实现完成材料；
11. 是否偷偷实现 P0-7 以后的能力。

输出：

```text
BLOCKER
MAJOR
MINOR
NOTE
```

---

# 三十四、03-delivery.md

至少记录：

* 本轮实现内容；
* 修改文件；
* API；
* DTO；
* 权限；
* accepted → serving；
* servingAt；
* 重复 / 并发行为；
* tests；
* HTTP tests；
* typecheck；
* lint；
* build；
* Reviewer；
* Known Limitations；
* Out of Scope；
* 推荐 commit message。

---

# 三十五、04-acceptance.md

编码完成后只生成：

**人工验收 Checklist。**

建议至少覆盖：

1. Companion A 接单；
2. `/companion/orders` 能看到该单；
3. `/companion/orders/[id]` 能看到详情；
4. accepted 时显示“开始服务”；
5. 点击后变 serving；
6. 刷新后仍 serving；
7. 按钮消失；
8. Companion B 无法访问 A 的订单；
9. 普通用户不能访问 Companion API；
10. serving 页面没有“提交完成材料”。

此时不得写：

“验收通过”。

---

# 三十六、完成标准

如果：

* 代码实现完成；
* tests 全绿；
* full HTTP tests 全绿；
* Reviewer 无 BLOCKER；

输出：

```text
P0-6 READY FOR MANUAL ACCEPTANCE
```

Round 状态：

```text
AWAITING_ACCEPTANCE
```

然后停止。

不要：

* Git commit；
* 标记 DONE；
* 自动开始下一 Round；
* 给“完成材料”分配新编号；
* 开始 P0-7。
