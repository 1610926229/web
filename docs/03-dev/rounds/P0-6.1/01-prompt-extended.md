# P0-6.1｜打手工作台返回入口 + 订单池等待最久优先

## 零、Round 定位

本轮只处理 P0-6 人工验收后发现的两个整改项：

```text
FIX-1 打手工作台缺少返回用户端入口
FIX-2 订单池排序未按“当前池等待最久优先”
```

不得扩大范围。

本轮不修改 P0-6 的历史验收结论。

P0-6 已人工验收通过，本轮属于后续整改。

---

# 一、执行前

完整阅读：

* `CLAUDE.md`
* `AGENTS.md`
* `docs/01-requirements/`
* `docs/02-tech-design/`
* `docs/03-dev/development-workflow.md`
* `docs/03-dev/总需求进度表.md`
* `docs/03-dev/rounds/P0-6/`
* `docs/03-dev/rounds/DEV-1/`

检查：

```text
git status
git log -5 --oneline
git rev-parse HEAD
```

如果存在与本轮无关的未提交业务代码，停止并报告。

---

# 二、FIX-1：打手工作台返回用户端

## 2.1 问题

当前进入：

```text
/companion
```

及打手工作台相关页面后，没有明显入口返回普通用户界面。

User 与 Companion 共用同一 User Session。

因此这里需要的是：

```text
界面导航
```

不是：

```text
退出登录
身份切换
重新认证
```

---

## 2.2 目标

在打手工作台统一顶部区域左侧增加明确的返回入口。

表现类似：

```text
← 返回用户端
```

或符合现有 UI 风格的返回图标 + 文案。

点击后返回普通用户端合理主入口。

优先返回：

```text
/
```

如果项目已经存在明确的用户主入口常量或导航约定，则复用现有定义，不重复硬编码。

---

## 2.3 放置位置

优先放在：

```text
app/companion/(console)/layout.tsx
```

或该工作台已经统一复用的 Header 组件。

目标是：

```text
pool
exclusive
orders
orders/[id]
```

等打手工作台页面都能统一看到返回入口。

不要每个页面各复制一个按钮。

---

## 2.4 明确禁止

不得：

* logout；
* 调 `/api/auth/logout`；
* 清 Cookie；
* 切换 Mock Identity；
* 新建 Companion Auth；
* 修改 User / Companion 共用 Session；
* 修改打手资格；
* 跳到管理员/客服后台。

点击返回后，同一个登录用户仍保持登录状态。

---

# 三、FIX-2：订单池等待最久优先

## 3.1 产品目标

打手看到订单池时：

```text
列表顶部
= 在当前池中等待最久的订单

越往下
= 越晚进入当前池

列表底部
= 最新进入当前池的订单
```

业务目的：

> 优先暴露已经等待较久的老板订单，降低用户等待体感。

正式排序方向：

```text
oldest waiting first
```

---

# 四、公共池排序规则

公共池唯一主要排序真值：

```text
publicPoolEnteredAt ASC
```

即：

```text
09:00
09:10
09:20
09:30
```

从上往下越来越新。

禁止依赖：

* Map 插入顺序；
* seed 数组顺序；
* Order.createdAt；
* publicDeadlineAt 作为主要排序；
* 前端收到数据后自行补排序。

排序应在服务端池查询结果形成时统一完成。

---

# 五、专属池排序规则

专属池唯一主要排序真值：

```text
exclusiveEnteredAt ASC
```

即：

> 谁最早进入当前打手的专属池，谁排在最上面。

同样禁止依赖数组插入顺序。

---

# 六、重新回池的关键语义

必须特别验证 P0-6 场景：

```text
订单很早创建
→ A 接单
→ A 主动取消
→ 订单重新进入 public
```

这时排序使用新的：

```text
publicPoolEnteredAt
```

而不是：

```text
Order.createdAt
```

例如：

```text
订单创建：09:00
第一次进入 public：09:01
A 接单：09:05
A 取消并重新进入 public：10:30
```

当前公共池排序时间：

```text
10:30
```

因此它应该被视为 10:30 新进入公共池的订单。

不能因为订单最初创建于 09:00 就重新冲到最顶部。

---

# 七、并列时间

如果两条订单：

```text
publicPoolEnteredAt
```

完全相同，必须使用稳定、确定性的 secondary key。

优先检查项目已经存在的排序惯例。

可以复用：

```text
id
```

或：

```text
orderNo
```

只要：

* deterministic；
* 不随请求变化；
* 测试可稳定复现。

不要引入随机排序。

示意：

```text
publicPoolEnteredAt ASC
→ id ASC
```

专属池同理。

---

# 八、检查当前 compareByDeadline

总需求进度表已记录现有差距：

```text
lib/services/companionDispatch.ts
compareByDeadline
```

请先检查当前实现。

不要因为函数名叫：

```text
compareByDeadline
```

就机械保留 deadline 排序。

本轮业务规则已经明确：

```text
公共池 = publicPoolEnteredAt ASC
专属池 = exclusiveEnteredAt ASC
```

如果原 comparator 已经同时承担其它场景：

* 不要粗暴改到影响其它业务；
* 可以拆成语义明确的 comparator；
* 但不要大规模重构 companionDispatch。

例如可以使用：

```text
comparePublicPoolWaitingOrder
compareExclusivePoolWaitingOrder
```

具体命名按项目现有风格。

---

# 九、服务端是真值源

排序必须由服务端完成。

理由：

不同调用方必须得到一致顺序：

```text
页面
API
HTTP 测试
未来客户端
```

客户端组件不得再单独：

```text
.sort(...)
```

去复制业务排序。

如果当前前端已有同类排序，应收敛到服务端唯一真值源。

---

# 十、FIX-1 测试

至少覆盖：

1. Companion 工作台统一布局存在返回用户端入口；
2. pool 页面拥有该入口；
3. exclusive 页面拥有该入口；
4. orders 页面拥有该入口；
5. orders/[id] 页面拥有该入口；
6. 返回目标为用户端主入口；
7. 点击返回不调用 logout；
8. 不新增 Companion Session / Cookie；
9. 不影响 Mock Identity；
10. 普通用户端页面不错误出现 Companion Console Header。

JSX 如果不适合现有 Node 测试体系，可以做源码结构门禁 + 人工验收。

不要建立新测试框架。

---

# 十一、FIX-2 测试

必须重点覆盖顺序。

## 11.1 公共池

准备至少三单：

```text
A publicPoolEnteredAt = 10:00
B publicPoolEnteredAt = 10:10
C publicPoolEnteredAt = 10:20
```

返回：

```text
A
B
C
```

---

## 11.2 运行时新订单

已有：

```text
A = 10:00
B = 10:10
```

运行时新增：

```text
C = 10:30
```

必须：

```text
A
B
C
```

不能因为 Map append / prepend 行为导致顺序异常。

---

## 11.3 取消后重新回池

已有：

```text
B public = 10:10
C public = 10:20
```

A：

```text
09:00 创建
09:05 原来进过 public
后来被接单
10:30 主动取消重新回 public
```

最终：

```text
B
C
A
```

因为 A 当前：

```text
publicPoolEnteredAt = 10:30
```

---

## 11.4 专属池

至少三条：

```text
exclusiveEnteredAt:
10:00
10:10
10:20
```

按上述顺序返回。

---

## 11.5 同时间稳定排序

两单进入时间一致。

连续调用多次结果顺序必须相同。

---

## 11.6 不按 deadline 排序

构造一个场景证明：

```text
deadline 顺序
```

与：

```text
enteredAt 顺序
```

不同。

最终结果必须服从：

```text
enteredAt ASC
```

防止以后有人重新把 comparator 改回 deadline。

---

# 十二、人工验收

## A. 返回按钮

依次打开：

```text
/companion
/companion/exclusive
/companion/orders
```

以及一张：

```text
/companion/orders/[id]
```

确认：

* 左上角有统一返回入口；
* 样式一致；
* 不遮挡标题；
* 点击返回普通用户界面；
* 登录状态仍然存在；
* 再进 `/companion` 不需要重新登录。

---

## B. 公共池顺序

使用 DEV-1 切换到有效 Companion。

观察公共池：

```text
顶部 = 最早进入 public 的订单
底部 = 最新进入 public 的订单
```

新增一张订单后：

新单应该出现在更靠下的位置。

---

## C. P0-6 回池顺序

执行：

```text
User 下单
→ A 接单
→ A 主动取消
```

重新查看公共池。

该订单应该按照：

```text
本次重新进入 public 的时间
```

参与排序。

不能按照最初 Order.createdAt 排到老订单前面。

---

## D. 专属池

如果当前 fixture 有多条专属订单：

确认顶部为等待时间最长的一条。

---

# 十三、技术边界

本轮允许：

* 调整 Companion console layout/header；
* 修改池子服务端排序；
* 调整相关 comparator；
* 补测试；
* 同步技术文档；
* 更新进度表和 Round 档案。

本轮不得：

* accepted → serving；
* CompletionSubmission；
* 封禁回池；
* 客服换人；
* 退款新功能；
* 改 Dispatch 状态模型；
* 改 timeout 业务规则；
* 改 P0-6 取消逻辑；
* 开发账号系统；
* 重构整个 Companion 模块。

---

# 十四、Requirement Check

如果发现：

```text
publicPoolEnteredAt
exclusiveEnteredAt
```

当前真实数据结构与技术文档存在冲突，先进入 CLARIFYING。

如果只是旧 comparator 实现与最新需求不同：

这是本轮 FIX，不算产品歧义，直接修。

不要因为函数组织、按钮组件位置等纯技术问题询问产品负责人。

---

# 十五、Round Protocol

创建：

```text
docs/03-dev/rounds/P0-6.1/
```

五件档案：

```text
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

将：

```text
docs/03-dev/rounds/cmd_p0-6.1.md
```

原样保存到：

```text
P0-6.1/01-prompt.md
```

状态：

```text
PLANNED
→ READY
→ IN_PROGRESS
→ AWAITING_ACCEPTANCE
```

开发完成不得自行标 DONE。

---

# 十六、自动门禁

完成后必须执行：

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

由于订单池 API / 页面行为发生变化，还必须执行生产 HTTP 全量：

```text
pnpm start -p <空闲端口>

APP_BASE_URL=http://localhost:<port> pnpm test
```

要求：

```text
fail = 0
skipped = 0
```

完成后关闭服务并确认端口释放。

---

# 十七、Reviewer

调用 reviewer-agent 做只读审查。

重点检查：

### FIX-1

* 是否误做 logout；
* 是否新增 Companion Auth；
* 是否每个页面复制按钮；
* 是否影响用户端布局；
* 是否打手 Console 全页面覆盖一致。

### FIX-2

* 是否真的按 enteredAt 而不是 deadline；
* 是否依赖 Map 顺序；
* 是否使用 Order.createdAt；
* 是否取消重新回池后正确使用新 publicPoolEnteredAt；
* 是否服务端统一排序；
* 是否存在前后端两份排序逻辑；
* tie-breaker 是否稳定。

BLOCKER / MAJOR 必须修复。

---

# 十八、Git 纪律

禁止执行：

```text
git add
git commit
git push
git reset
git restore
git checkout
git rebase
git amend
```

所有 Git 写操作由用户本人执行。

---

# 十九、交付报告

最终必须输出：

1. Round 状态；
2. Requirement Check；
3. FIX-1 最终实现位置；
4. 返回按钮最终跳转目标；
5. 是否保持原 Session；
6. FIX-2 公共池排序公式；
7. FIX-2 专属池排序公式；
8. tie-breaker；
9. 取消重新回池排序验证；
10. 修改文件；
11. 新增/修改测试；
12. pnpm test；
13. HTTP 全量；
14. typecheck / lint / build；
15. Reviewer 结果；
16. 人工验收步骤；
17. git status；
18. 明确无 Git 写操作；
19. 明确未开始下一 Round。

执行到：

```text
AWAITING_ACCEPTANCE
```

后停止。

不得开始下一 Round。
