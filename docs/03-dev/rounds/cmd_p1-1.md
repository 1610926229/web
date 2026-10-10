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
