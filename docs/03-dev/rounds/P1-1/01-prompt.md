Round: P1-1
Received At: 2026-09-27
Source: User（原文逐字保存，未经加工）

---

继续开发，不等待人工验收。

## 第一阶段：登记 P0-14 四项产品追认

将以下裁定写入 P0-14 决策/交付文档，但 **P0-14 继续保持 AWAITING_ACCEPTANCE，不得 DONE**：

### R1
Staff 对 assignment 历史聊天只读。

注意：

- 这里只限制 Staff 对“履约 assignment 会话”的写入；
- 原有 Staff ↔ User 客服会话继续按既有规则运行，不受影响；
- 不创建 Staff ↔ Companion 新直连聊天。

### R2
用户端多 assignment 聊天采用：

- 当前服务会话
- 历史服务会话

分段展示。

当前段可写，历史段只读。

### R3
允许 assignment conversation 惰性物化。

规则：

- 不要求 assignment 创建时立即制造空 conversation；
- 第一次合法访问 / 合法发送等真正需要 conversation 时可以创建；
- 越权、退款只读发送、旧打手发送等失败请求不得产生空 conversation；
- 惰性创建不能改变 assignmentKey / 权限语义。

### R4
用户端历史 assignment 分段不强制显示 Companion 姓名。

使用中性：

- 当前服务会话
- 历史服务会话

即可。

Staff 调查视角仍可看到 companionId / companionName。

登记完成后，不重开 P0-14 开发，不开始 retention。

---

# 第二阶段：正式启动 P1-1

Round：

`P1-1｜管理员首页经营概览 + 待办聚合`

创建标准 Round 档案：

`docs/03-dev/rounds/P1-1/`

- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

状态：

`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`

不得自行 DONE。

---

# 一、目标

把现有 `/admin` 从入口页升级为真正可用的管理员经营首页。

本轮完成：

1. 今日订单数；
2. 今日 GMV；
3. 今日退款金额；
4. 管理员当前待办；
5. 已有管理模块快捷入口；
6. loading / error / retry / zero-state；
7. Admin 权限与最小 DTO。

本轮是读侧 Dashboard，不修改交易状态机。

---

# 二、Requirement Check

编码前检查：

- `docs/01-requirements/`
- `docs/02-tech-design/`
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- 当前 `/admin`
- Admin Order
- Refund / Aftersales
- Complaint
- Companion Application
- 当前 repository / service / auth

优先采用权威需求已有口径。

若没有更明确的冲突定义，本轮统一采用下面的产品口径。

---

# 三、经营指标产品口径

## 3.1 今日订单数

定义：

**业务日内成功形成的已支付订单数量。**

优先使用明确的 `paidAt`。

若当前模型没有独立 `paidAt`，且订单只有支付成功后才正式创建，则使用该正式订单的 `createdAt`，并在 decisions 中明确这是当前数据模型下的等价 CURRENT 口径。

不得统计：

- preview
- payment attempt
- 未成功形成正式订单的数据

---

## 3.2 今日 GMV

定义：

**今日成功支付订单的实际支付金额之和，退款不从 GMV 中倒扣。**

即：

```text
今日 GMV = Σ 今日成功支付订单 actualPaidAmount
```

GMV 是成交规模指标。

退款单独体现在“今日退款金额”。

不得：

- 使用商品原价替代实际支付额；
- 因退款把原 GMV 回滚；
- 使用 companion 收益 / 平台收入代替 GMV。

内部继续以整数“分”计算。

---

## 3.3 今日退款金额

定义：

**今天实际执行成功的退款金额之和。**

按退款发生时间归属日期，而不是原订单创建日期。

例如：

```text
9 月 26 日订单
9 月 27 日退款 ¥30
```

则：

```text
9/26 GMV 包含该订单原支付金额
9/27 今日退款金额 +¥30
```

包括：

- direct full refund
- aftersales partial refund
- aftersales full refund

多次部分退款按当天实际退款事件金额累加。

不得按 `Order.refundedAmount` 当前累计值直接统计，否则跨日多次退款会重复。

必须从真实 refund / refund event 记录聚合。

---

# 四、业务日边界

统一沿用项目当前业务时区。

如当前项目仍采用 UTC+8，则 Dashboard 今日边界必须与既有 `formatDateTime` / 业务规则保持一致。

不得：

- 浏览器本地时区算一套；
- Service 再按 UTC 算另一套。

日期边界逻辑应抽成可测试纯函数或复用已有工具。

---

# 五、待办聚合

首页展示管理员真正需要处理的 pending 工作。

优先包括已有业务：

### 5.1 待审核申请

尚未终结的 Companion / 平台已有申请。

只统计真正需要管理员动作的状态。

### 5.2 待处理售后 / 退款

统计仍处于管理员处理流程中的售后。

如果现有状态区分：

- pending
- processing
- approved
- rejected
- closed

则卡片应统计所有**尚未终结且仍需 Admin 处理**的状态，不把 approved/rejected/closed 算进去。

### 5.3 待处理投诉

同理，仅统计需要处理的开放投诉。

### 5.4 其它 Admin pending

只有权威需求和现有业务已经明确属于 Admin 的事项才可以加入。

禁止为了 Dashboard 发明新的业务状态。

---

# 六、首页职责

Dashboard 只负责：

```text
聚合
展示
跳转
```

不负责：

- 审批
- 退款
- 换人
- 封禁
- 修改商品
- 修改申请状态

用户点击卡片后进入已有管理页面处理。

不得把业务动作复制进 Dashboard。

---

# 七、架构

遵守：

Browser
→ `*Http.ts`
→ Route
→ Service
→ Repository

如果 `/admin` 当前 Server Component 架构适合服务端直调 Service，可以沿用项目既有规则。

建议：

`AdminDashboardService`

聚合已有 Repository 的只读能力。

禁止：

- 页面直接访问 mock store；
- Route Handler 写统计逻辑；
- 创建第二套 OrderRepository；
- 创建第二套 RefundRepository；
- 为 Dashboard 复制已有业务规则。

---

# 八、DTO

建立最小 Dashboard DTO，例如：

```text
AdminDashboardDTO
  businessDate

  metrics
    todayOrderCount
    todayGmvAmount
    todayRefundAmount

  pending
    applications
    aftersales
    complaints
```

具体字段按现有项目命名风格调整。

不得返回：

- 完整 Order[]
- User 对象
- 游戏账号
- remark
- companionRateSnapshot
- 内部分账
- repository 原始记录

必须做精确 DTO keys 测试。

---

# 九、UI

保持现有 PC Admin 设计体系。

至少：

## 今日经营

三张核心卡：

- 今日订单
- 今日 GMV
- 今日退款

## 当前待办

卡片展示：

- 类型
- 数量
- 对应真实管理入口

0 条仍正常显示 `0`。

## 快捷入口

只链接已经真实存在的模块，例如：

- 订单
- 商品
- 打手
- 申请
- 售后 / 退款
- 公告 / 配置

禁止假入口。

---

# 十、状态

必须支持：

- loading
- error
- retry
- 正常零数据

注意：

`今日订单 = 0`

是一个完全正常的 Dashboard，不得显示整页 EmptyState。

---

# 十一、权限

Dashboard API / Service 必须保证：

- 未登录拒绝；
- User 拒绝；
- Companion 拒绝；
- Staff 拒绝；
- Admin 成功。

复用现有 Admin auth。

不得创建第二套管理员身份系统。

---

# 十二、测试

至少覆盖：

### 今日订单

1. 空数据 = 0；
2. 今日成功订单计数；
3. 昨日订单不计；
4. 日期边界。

### GMV

5. 今日实际支付金额累加；
6. 原价 ≠ 实付时使用实付；
7. 今日退款不倒扣 GMV；
8. 昨日订单不进入今日 GMV。

### 今日退款

9. direct full refund；
10. partial refund；
11. full aftersales refund；
12. 同订单多次部分退款；
13. 昨日订单今日退款计入今日；
14. 昨日退款不计；
15. 不使用累计 refundedAmount 重复统计。

### Pending

16. applications；
17. aftersales pending；
18. aftersales processing；
19. terminal refund 不计；
20. complaint pending；
21. complaint processing；
22. terminal complaint 不计；
23. 多模块聚合。

### Auth

24. anonymous；
25. User；
26. Companion；
27. Staff；
28. Admin。

### DTO

29. exact keys；
30. 无内部敏感字段。

### UI

31. 正常；
32. 全 0；
33. error；
34. retry；
35. 所有快捷入口真实存在。

---

# 十三、明确不做

P1-1 不做：

- 趋势图
- DAU
- 留存
- 复购
- LTV
- 用户画像
- 打手画像
- WebSocket 实时 Dashboard
- 数据仓库
- 真数据库
- Scheduler
- 提现
- 钱包
- 会员
- P0-14 retention
- 新售后处置规则

---

# 十四、门禁

执行：

targeted tests  
→ `pnpm test`  
→ `pnpm typecheck`  
→ `pnpm lint`  
→ `pnpm build`  
→ production `APP_BASE_URL` 全量测试  
→ reviewer-agent

BLOCKER / MAJOR 必须全部修完，然后完整复跑。

最终：

- fail = 0
- production skipped = 0
- BLOCKER = 0
- MAJOR = 0

---

# 十五、Git

禁止一切 Git 写操作：

- add
- commit
- push
- reset
- restore
- checkout
- rebase
- amend

---

# 十六、结束

最终保持：

- P0-14 = AWAITING_ACCEPTANCE
- P1-1 = AWAITING_ACCEPTANCE

不得开始 P1-2。

输出：

1. P0-14 四项追认登记结果；
2. P1-1 Round Status；
3. Requirement Check；
4. 指标口径；
5. 今日订单 / GMV / 退款实现；
6. pending 聚合；
7. DTO；
8. API；
9. 页面；
10. targeted tests；
11. pnpm test；
12. production test；
13. typecheck/lint/build；
14. reviewer；
15. git status；
16. 人工验收入口。

完成后停止，等待统一验收。

---

# 【第二次指令】2026-09-27 · 本轮的正式执行令（原文逐字保存）

> ⚠️ **这一份取代上面那份，是 P1-1 的有效执行令。** 差别只有两处，都很关键：
>
> 1. **§六 是新的正式裁定（R6）**：上面那份里没有这一段。它推翻了本轮交付过程中
>    我对一条审查意见（M2）的处置——当时我把「卡片数与列表数对不上」写成
>    「在提示文案里说明对不上」，裁定要求**必须让两者真的相等**，并为此新增
>    查询层虚拟值 `status=open`。
> 2. **§十七 改成「完成后直接进入 P1-2，不等待人工回复」**：上面那份写的是
>    「不得开始 P1-2」。以本份为准。
>
> 其余章节（§一–§五、§七–§十六）与上面那份内容一致，此处一并留存，
> 以保证「用户到底要求了什么」在本档案里是一份**未经加工的全文**，
> 而不是我的转述。历史记录不做改写。

---

# P1-1｜管理员首页经营概览 + 待办聚合

## 一、目标
把现有 `/admin` 从入口页升级为可用的管理员经营首页。本轮完成：
- 今日订单数
- 今日 GMV
- 今日退款金额
- 待审核申请 / 待处理售后退款 / 待处理投诉
- 快捷入口
- loading / error / retry / zero-state
- Admin 权限与最小 DTO
- 修复 Dashboard 待办数量与目标列表数量不一致

本轮只做读侧 Dashboard，不修改订单状态机。

## 二、执行前
完整阅读：
- `CLAUDE.md`
- `AGENTS.md`
- `docs/01-requirements/`
- `docs/02-tech-design/`
- `docs/03-dev/development-workflow.md`
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- 当前 `/admin`
- admin orders / refunds / complaints / applications
- 当前 Admin auth、service、repository、route、DTO

记录 HEAD、分支、`git status --short`。P0-14 保持 `AWAITING_ACCEPTANCE`。

创建 `docs/03-dev/rounds/P1-1/`：
- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

状态：
`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`
不得自行 DONE。

## 三、经营指标口径

### 3.1 今日订单数
定义：业务日内支付成功订单数。
优先使用 `paidAt`。若当前模型无独立 paidAt 且订单仅支付成功后创建，可使用正式订单 `createdAt`，但必须在 decisions 中明确 CURRENT 口径。

不得统计 preview / payment attempt / 未成单。

### 3.2 今日 GMV
定义：今日成功支付订单的实际支付金额之和。

`今日 GMV = Σ 今日成功支付订单 actualPaidAmount`

要求：
- 退款不倒扣 GMV
- 不用原价
- 不用打手收益
- 不用平台收益
- 内部金额单位保持“分”

### 3.3 今日退款金额
定义：今天实际执行成功的退款金额之和，按退款发生时间归业务日。

包括：
- direct full refund
- aftersales partial refund
- aftersales full refund
- public pool timeout auto refund

多次部分退款按每次真实退款事件金额累计。
严禁直接使用 `Order.refundedAmount` 当前累计值做今日退款统计。

## 四、业务日
统一沿用项目既有业务时区规则。若当前为 UTC+8，三项指标必须使用同一业务日纯函数/工具。
优先复用现有 `formatDateTime` / `orderBeijingDate` 等实现。
不得浏览器算一套、服务端再算另一套。

## 五、待办聚合
只统计真正需要管理员动作的未终态。

- Application open = `pending + reviewing`
- Refund/Aftersales open = `pending + reviewing`
- Complaint open = `pending + processing`

不得发明新的领域状态。

## 六、R6 正式裁定：Dashboard 数量必须与点击后的列表一致
新增查询别名：

`status=open`

`open` 仅是查询层虚拟值：
- 不是领域状态
- 不写入 store/database
- 不进入业务状态机

Dashboard 三张待办卡统一跳转对应 `?status=open`。

每个领域必须建立唯一状态集合/纯函数，例如：
- `OPEN_APPLICATION_STATUSES`
- `OPEN_REFUND_STATUSES`
- `OPEN_COMPLAINT_STATUSES`

Dashboard 计数与列表 `status=open` 必须复用同一份定义，禁止复制第二套。

真实单状态过滤继续兼容；非法 status 保持既有契约；open 与搜索/分页/其它已有筛选可组合。

## 七、Dashboard 职责
只做：
- 聚合
- 展示
- 跳转

不在首页做审批、退款、换人、封禁、修改商品、修改申请状态。

## 八、架构
遵守：
Browser → `*Http.ts` → Route → Service → Repository

若 Admin 首页为 Server Component，可按现有规则直接调 Service。

建议建立单一 `AdminDashboardService` 聚合已有 Repository 只读结果。

禁止：
- 页面直接读 mock store
- Route 里计算复杂指标
- 第二套 Order/Refund/Application/Complaint repository
- 第二套 open 状态定义

## 九、DTO
最小 DTO，例如：
- businessDate
- metrics.todayOrderCount
- metrics.todayGmvAmount
- metrics.todayRefundAmount
- pending.applications
- pending.aftersales
- pending.complaints

不得返回：
- 完整 Order[]
- User 对象
- gameAccountId
- remark
- companionRateSnapshot
- 内部分账
- repository 原始记录

必须做 exact keys 测试。

## 十、UI
保持现有 PC Admin 风格。

### 今日经营
- 今日订单
- 今日 GMV
- 今日退款

### 当前待办
- 待审核申请
- 待处理售后
- 待处理投诉

数量必须和对应 `status=open` 列表一致。

### 快捷入口
仅允许真实存在的模块，如：
- 订单管理
- 商品管理
- 打手管理
- 申请管理
- 售后/退款
- 公告/配置

禁止假入口。

必须有：
- loading
- error
- retry
- 正常零数据

全 0 不是异常，不得整页 EmptyState。

## 十一、权限
Dashboard API / Service：
- anonymous 拒绝
- User 拒绝
- Companion 拒绝
- Staff 拒绝
- Admin 成功

复用现有 `requireAdmin()`。

## 十二、测试
至少覆盖：

### 今日订单/GMV/退款
1. 空数据=0
2. 今日订单计数
3. 昨日订单不计
4. 日期边界
5. actualPaidAmount 聚合
6. 原价≠实付时用实付
7. 退款不倒扣 GMV
8. direct full refund
9. partial refund
10. full aftersales refund
11. public timeout refund
12. 同单多次部分退款
13. 昨日订单今日退款计入今日
14. 昨日退款不计
15. 不使用累计 refundedAmount 重复统计

### Pending/open
16. applications open
17. refunds open
18. complaints open
19. terminal 状态不计
20. Dashboard count = `status=open` total
21. 三个 Dashboard 链接都是 open
22. open 不成为领域状态
23. 单状态筛选继续兼容
24. open + 搜索/分页组合正确

### 权限/DTO/UI
25. anonymous
26. User
27. Companion
28. Staff
29. Admin
30. DTO exact keys
31. 无敏感字段
32. 正常数据
33. 全0
34. error
35. retry
36. 快捷入口真实存在

## 十三、不做
- 趋势图/DAU/留存/复购/LTV
- 用户画像/打手画像
- WebSocket Dashboard
- 数据仓库
- 真数据库
- Scheduler
- 提现/钱包/会员
- 聊天 retention
- 新售后处置规则

## 十四、文档
更新：
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- API contract（如适用）
- P1-1 Round 档案

不得篡改历史 Round。

## 十五、门禁
执行：
targeted tests
→ `pnpm test`
→ `pnpm typecheck`
→ `pnpm lint`
→ `pnpm build`
→ production `APP_BASE_URL` 全量测试
→ reviewer-agent
→ 修复全部 BLOCKER / MAJOR
→ 最终完整复跑

最终：
- fail = 0
- production skipped = 0
- BLOCKER = 0
- MAJOR = 0

## 十六、Git
禁止：
git add / commit / push / reset / restore / checkout / rebase / amend

仅允许只读 Git。

## 十七、结束
P1-1 最终停在 `AWAITING_ACCEPTANCE`，不得 DONE。

输出：
1. Round Status
2. Requirement Check
3. 指标口径
4. 今日订单/GMV/退款实现
5. open alias 设计
6. Dashboard count/link 一致性证明
7. DTO
8. API
9. 页面
10. targeted tests
11. pnpm test
12. production tests
13. typecheck/lint/build
14. reviewer
15. git status
16. 人工验收入口

完成后直接进入 P1-2，不等待人工回复。
