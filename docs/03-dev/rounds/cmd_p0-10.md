# P0-10｜客服全量订单查询工作台

## 目标
补齐 P0「客服查看订单」。新增统一客服订单入口，优先使用：
- `/staff/orders`
- `/staff/orders/[id]`

复用现有 Staff Auth、Order/Refund/Complaint/Completion 数据，不创建第二套订单系统。

## 核心要求
- Staff 权限：复用 `requireStaff()` 或现有等价 Guard。
- 列表至少支持：订单号、用户昵称/平台 ID、商品名搜索；状态、游戏、时间范围筛选；分页；创建时间降序 + 稳定 secondary key。
- 详情至少展示：订单号、状态、用户摘要、商品/规格/增值服务快照、必要金额、当前打手、Dispatch 摘要、Completion/Complaint/Refund 摘要、CompanionReleaseRecord 历史。
- Staff DTO 独立，不得直接暴露 Admin-only 财务字段、平台净利润、分账比例、支付内部字段。
- 在现有 Staff 导航增加「订单」入口。
- 本轮只做查询/详情，不提前做换打手、退款、售后资金动作。

## 测试
至少覆盖：Staff 访问、未登录/非 Staff 拒绝、停用 Staff 拒绝、搜索筛选分页、稳定排序、详情 404、release history、current companion、Completion/Complaint/Refund 摘要、DTO 隐私、Staff route manifest、旧 Staff 页面不回归。

## Round Protocol
创建 `docs/03-dev/rounds/P0-10/` 五件档案。状态到 `AWAITING_ACCEPTANCE`。

## 门禁
执行 targeted tests、`pnpm test`、typecheck、lint、build、production APP_BASE_URL 全量测试、只读 reviewer。BLOCKER/MAJOR 必须清零。

## Git
禁止所有 Git 写操作。

满足批次继续条件后自动进入 P0-11。
