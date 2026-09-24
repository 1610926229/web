Round: P0-6
Received At: 2026-09-23
Source: User / ChatGPT-assisted specification

---

# P0-6｜accepted 主动取消接单 + 重新进入公共池

## 零、执行前提

本轮开始前，先完整阅读并服从：

* `CLAUDE.md`
* `AGENTS.md`
* `docs/01-requirements/` 三份最新需求文档
* `docs/02-tech-design/` 最新技术设计
* `docs/03-dev/development-workflow.md`
* `docs/03-dev/总需求进度表.md`
* `docs/03-dev/rounds/README.md`
* 已完成的 `docs/03-dev/rounds/P0-5.5/`

然后检查当前 branch / HEAD / git status。

P0-5 与 P0-5.5 已经完成并提交。本轮不得反向修改其历史结论。

如果工作区存在尚未提交的业务代码或测试改动，先停止并报告。

纯文档基线提交后的正常干净工作区才允许开始 P。

---

# 一、本轮目标

实现一个完整、可人工验收的业务闭环：

```text
打手成功接单
Order = accepted
Dispatch = accepted

↓
实际打手进入“我的订单”
↓
打开自己当前负责的 accepted 订单
↓
点击“取消接单”
↓
必须填写原因
↓
系统原子执行：

记录最小退出历史
Order: accepted → paid
actualCompanionId → null

Dispatch: accepted → public
acceptedByCompanionId → null
重新记录 publicPoolEnteredAt
重新冻结 publicTimeoutMinutesSnapshot
重新计算 publicDeadlineAt

↓
通知下单用户
↓
原打手不再拥有该订单
↓
其他合法打手可以从公共池重新接单
```

当前取消行为：

* 不处罚；
* 不罚款；
* 不进入人工售后；
* 不退款；
* 不限制以后继续接其他订单；
* 必须保留最小历史供客服/管理员查看。

本轮目标是“基本可用”，禁止引入复杂 Assignment 系统。

---

# 二、正式产品规则

## 2.1 谁可以取消

只有：

```text
Order.status === "accepted"
&&
Order.actualCompanionId === 当前 companionId
```

对应的实际打手可以执行普通主动取消。

必须由 `requireCompanion()` 从当前 User Session 推导 companionId。

禁止从 request body 接收 companionId 作为身份依据。

---

## 2.2 必须填写原因

取消请求必须提供非空原因。

只要求“必须填写有效非空文本”。

如果需求文档没有冻结具体字数限制：

**不要自行创造 5～50、10～200 等长度规则。**

允许做基础 trim / 空字符串拒绝。

---

## 2.3 取消后的 Order

成功后：

```text
accepted → paid
```

并且：

```text
Order.actualCompanionId = null
```

当前履约绑定必须解除。

但是历史上“谁曾经接过这一单”不能丢失，交由本轮最小退出历史记录保存。

---

# 三、最小退出历史

实现技术设计中已经确认的最小退出历史能力。

可以采用最新 `database-schema.md` 已定义的 TARGET，例如：

```text
CompanionReleaseRecord
```

只保存当前业务真正需要的最小事实：

```text
id
orderId
companionId
source
reason
actorId
createdAt
```

本轮至少支持：

```text
source = companion_cancel
```

不要为了未来封禁、客服换人提前设计复杂枚举体系或 Assignment 聚合。

如果最新技术设计已有正式字段命名，以技术设计为准。

要求：

* 原打手可追溯；
* 取消原因可追溯；
* 取消时间可追溯；
* 客服可看；
* 管理员可看；
* 普通公共池打手不可看到；
* 不覆盖旧记录。

---

# 四、Dispatch 回公共池

取消必须与 Order 变更处于同一原子业务区段。

成功后：

```text
Dispatch.state = public
```

当前接单事实解除：

```text
acceptedByCompanionId = null
```

与当前接单状态绑定的字段如果继续保留会导致状态自相矛盾，应按现有 Dispatch 模型进行一致性清理。

但是：

```text
exclusiveCompanionId
```

是历史“最初指定打手”事实，不得因为此次取消而删除或改写。

重新进入公共池时：

```text
publicPoolEnteredAt = at
publicTimeoutMinutesSnapshot = 当前平台公共池配置
publicDeadlineAt = at + snapshot
```

必须复用现有公共池配置与 deadline 逻辑。

不得写第二套 timeout 算法。

---

# 五、订单状态机

当前源码中的 `ORDER_TRANSITIONS` 是 P0-5.5 旧产品基线。

本轮按照 2026-09-23 最新需求调整为 TARGET 结构关系：

```text
paid      -> accepted | refunded
accepted  -> paid | serving | refunded
serving   -> paid | completed | refunded
completed -> refunded
refunded  -> []
```

本轮真正新增可执行迁移只有：

```text
accepted → paid
```

用于“当前实际打手主动取消”。

虽然结构状态机允许：

```text
serving → paid
```

但本轮：

* 不实现封禁回池；
* 不实现客服换人；
* 不提供 serving 普通主动取消；
* 不得因为状态机允许就新增对应 API。

继续坚持：

> `canTransitionOrder()` 只表达结构许可，不代替领域 Guard。

---

# 六、通知

取消成功后必须通知下单用户。

复用已有 Notification 写入通道。

禁止：

* 新建第二套 Notification repository；
* 在页面里伪造通知；
* 只 toast、不写真实通知事实。

通知语义表达：

> 当前打手已取消接单，订单已重新进入等待接单状态。

具体文案风格复用项目现有通知规范，不需要逐字一致。

同一次成功取消只能产生一次通知。

重复请求不得重复通知。

---

# 七、Companion “我的订单”

为了让这个业务真正可操作，本轮补最小 Companion 已接订单页面。

目标页面：

```text
/companion/orders
/companion/orders/[id]
```

以及必要 API：

```text
GET /api/companion/orders
GET /api/companion/orders/[id]
POST /api/companion/orders/[id]/cancel
```

必须同步 Companion API route manifest gate。

## 7.1 列表归属

只能返回：

```text
Order.actualCompanionId === 当前 companionId
```

的订单。

`exclusiveCompanionId === 当前 companionId`

绝不等于订单归当前打手。

列表至少支持当前履约中的：

```text
accepted
serving
```

如果现有设计已经冻结“进行中 / 已结束”等展示结构，可以复用；不要为了本轮扩大范围。

---

## 7.2 详情权限

服务端必须重新校验：

```text
Order.actualCompanionId === 当前 companionId
```

不是本人实际履约订单：

按项目既有资源隐藏规则返回 404。

不能只依赖列表入口隐藏。

---

## 7.3 DTO 最小化

Companion 订单 DTO 只返回履约需要字段。

不得因为复用 Admin Order DTO 而泄露：

* 平台内部净收入；
* 管理员备注；
* 其他用户订单；
* 内部审计；
* 不属于当前 Companion 工作所需的敏感字段。

接单成功后的实际打手可以看到已确认的必要履约信息：

* 订单号；
* 商品；
* 规格；
* 游戏；
* 区服；
* 游戏账号；
* 服务要求；
* 用户备注；
* 增值服务；
* 必要用户信息。

---

# 八、取消 UI

只有：

```text
Order.status === accepted
```

的本人订单详情显示：

```text
取消接单
```

serving 不显示普通取消按钮。

点击后需要：

```text
填写取消原因
→ 二次确认/提交
→ 成功
```

要求：

* 原因为空不能提交；
* 成功后给出明确反馈；
* 成功后该订单已经不属于原打手；
* 返回合理页面，例如我的订单列表；
* 该单重新出现在其他合法打手公共池中。

不要做罚款 UI。

不要做信誉分 UI。

---

# 九、客服 / 管理员可见历史

本轮只需要让现有订单管理详情能够看到最小取消历史。

例如：

```text
打手：A
动作：主动取消接单
时间：xxxx
原因：临时有事无法服务
```

允许根据现有管理端/客服端 DTO 结构选择最小接入方式。

禁止借机：

* 重构整个 admin order DTO；
* 拆 adminHttp；
* 新做完整履约历史系统；
* 新做 Assignment 时间轴大系统。

---

# 十、原子性与并发

取消操作必须作为一个原子业务动作处理。

Mock 阶段继续遵守当前项目伪事务惯例：

```text
// 原子区段内不得 await

读 Order / Dispatch / Companion
→ 检查合法性
→ 写 ReleaseRecord
→ Order accepted → paid
→ 清除 actualCompanion
→ Dispatch accepted → public
→ 冻结新的 public deadline
→ 写通知
```

生产数据库约束继续作为 TARGET，不在本轮引入 DB/ORM。

必须考虑：

### 同一打手连续点两次取消

只能成功一次。

不得：

* 两条 ReleaseRecord；
* 两条用户通知；
* 重复刷新 publicDeadlineAt。

### 取消与其他并发动作

如果状态已经不再 accepted：

取消必须失败或按既有幂等语义返回安全结果。

不得把已经 serving / refunded / completed 的订单重新拉回 paid。

---

# 十一、测试要求

至少覆盖：

1. actualCompanion 可以取消自己的 accepted 订单；
2. reason 必填；
3. 非 actualCompanion 不能取消；
4. 普通 User 不能调用 Companion API；
5. accepted → paid；
6. actualCompanionId 清空；
7. Dispatch accepted → public；
8. acceptedByCompanionId 当前绑定被清除；
9. exclusiveCompanionId 保留；
10. publicPoolEnteredAt 重置；
11. public timeout 使用当下平台配置重新冻结；
12. ReleaseRecord 正确写入；
13. 用户通知产生一次；
14. 重复取消不产生第二条记录；
15. 重复取消不重复通知；
16. 重复取消不刷新 deadline；
17. serving 不能普通主动取消；
18. paid / completed / refunded 不能使用该动作；
19. 取消后原打手不再能通过 companion order detail 查看该单；
20. 取消后其他合法打手能在公共池看到并接单；
21. self-order Guard 等 P0-5 规则不回归；
22. Companion route manifest 更新且通过；
23. Admin / Staff 可以看到取消历史；
24. 普通用户/其他打手看不到内部取消历史；
25. `ORDER_TRANSITIONS` 新结构准确且终态仍为 `[]`。

测试风格继续复用当前 `.test.mjs` 体系。

不要建立新测试框架。

---

# 十二、自动门禁

开发完成后必须运行：

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

随后启动本轮 production build：

```text
pnpm start -p <空闲端口>
```

执行：

```text
APP_BASE_URL=http://localhost:<port> pnpm test
```

要求 HTTP 套件：

```text
fail = 0
skipped = 0
```

结束后关闭服务并确认端口释放。

---

# 十三、Reviewer

业务 + 测试完成后调用 reviewer-agent。

Reviewer 重点检查：

* 是否出现第二套订单系统；
* 是否出现复杂 Assignment 设计；
* 是否把 `exclusiveCompanionId` 当 ownership；
* 是否只靠前端限制取消；
* 是否忘记服务端 actualCompanion ownership；
* 是否出现原子区段中的 await；
* 是否取消后留下 Order / Dispatch 不一致；
* 是否重复通知；
* 是否重复 ReleaseRecord；
* 是否 public deadline 被重复刷新；
* 是否泄露 DTO；
* 是否把 serving 普通取消偷偷实现；
* 是否因为新状态机表而绕过领域 Guard。

BLOCKER / MAJOR 必须修复后重新跑相关测试。

---

# 十四、明确不做

本轮不得实现：

* accepted → serving；
* CompletionSubmission；
* 自动完成审核；
* Earning；
* complaint settlement；
* serving 用户退款售后；
* accepted 用户直接退款；
* Companion 封禁回池；
* 客服主动换打手；
* Companion 聊天；
* 新聊天隔离；
* 罚款；
* 会费；
* B/A/S；
* 并发上限；
* 提现；
* 部分退款；
* 优惠券；
* Scheduler；
* DB / ORM；
* 微信 OAuth；
* 微信真实支付；
* 复杂 Assignment 系统；
* 与本轮无关的大型重构。

这些已有 TARGET 规则，但不是 P0-6 scope。

---

# 十五、Round Protocol

正式创建：

```text
docs/03-dev/rounds/P0-6/
```

并维护：

```text
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

要求：

* `01-prompt.md` 原样保存本指令；
* Coordinator 独占 Round 文档写入；
* 如发现真正产品歧义，进入 CLARIFYING；
* 不允许 Claude 自行补产品规则；
* 已经被 V0.3 冻结的规则不得重复询问。

状态流：

```text
PLANNED
→ READY
→ IN_PROGRESS
→ AWAITING_ACCEPTANCE
```

编码完成只能到：

```text
AWAITING_ACCEPTANCE
```

不能自己标 DONE。

---

# 十六、Git 纪律

绝对禁止执行：

```text
git add
git commit
git push
git rebase
git amend
git reset
git restore
git checkout
```

允许只读：

```text
git status
git diff
git log
git show
git rev-parse
```

Git 写操作由用户本人执行。

---

# 十七、交付报告

最终必须给出：

1. Round 状态；
2. Requirement Check 结果；
3. 实际修改文件；
4. 新增的数据结构；
5. 新增/修改 API；
6. Order / Dispatch 状态变化；
7. CompanionReleaseRecord 行为；
8. 通知行为；
9. Companion 我的订单页面；
10. Admin / Staff 取消历史展示；
11. 并发/幂等处理；
12. 测试新增数量；
13. `pnpm test` 结果；
14. 完整 HTTP 结果；
15. typecheck / lint / build；
16. Reviewer BLOCKER / MAJOR / MINOR / NOTE；
17. 明确列出未实现内容；
18. `git status --short`；
19. 明确声明没有执行任何 Git 写操作。

完成后停止。

等待用户人工验收。

不得自动开始下一 Round。
