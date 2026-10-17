# P0-7｜accepted → serving

## 零、Round 目标
本轮只实现正常履约主线中的 `accepted → serving`，由当前实际打手主动点击“开始服务”。

本轮不实现完成材料、自动完成、收益、投诉结算。

## 一、执行前
完整阅读 `CLAUDE.md`、`AGENTS.md`、最新 requirements、最新 tech-design、development-workflow、总需求进度表、P0-6/P0-6.1 Round 档案。

确认 P0-6.1 自动门禁全绿、Reviewer 无 BLOCKER/MAJOR、无 OPEN 决策。记录本轮开始前工作区 baseline 与前一轮 delta。

## 二、正式产品规则
只有：
- `Order.status === "accepted"`
- `Order.actualCompanionId === 当前 companionId`

的当前实际打手可以执行“开始服务”。

Companion 身份必须来自 `requireCompanion()`；禁止从请求体接收 companionId 作为身份依据。

状态变化：
`accepted → serving`

同时记录：
`servingAt = at`

不得：
- 根据时间自动开始；
- 根据预约备注自动开始；
- 打开页面自动开始；
- 聊天开始自动开始；
- 客服代替正常打手执行普通开始服务；
- 其他 Companion 开始这张订单。

`actualCompanionId` 保持不变；`acceptedAt` 属于历史事实，不应因进入 serving 被抹掉，除非最新权威技术设计明确有不同语义。

## 三、API
优先按已冻结 TARGET 使用：
`POST /api/companion/orders/[id]/start`

要求：
- 第一动作 `requireCompanion()`
- 服务端重新校验 ownership
- 主要业务规则放 service / transaction，不堆 Route Handler
- 使用中央 `ORDER_TRANSITIONS / canTransitionOrder` 作为结构校验之一，但具体领域 Guard 仍单独存在
- 不因状态机允许其它迁移而开放其它动作
- 同步 Companion API manifest gate

## 四、原子性与幂等
Mock 阶段延续伪事务：原子区段内不得 `await`。

至少保证：
`读 Order → 校验 accepted/ownership → 写 serving/servingAt`
处于同一原子业务区段。

重复点击不得刷新 `servingAt` 或产生重复副作用。优先复用现有动作的幂等/安全重放模式，不为本轮新建通用幂等框架。

## 五、Companion UI
在 `/companion/orders/[id]`：
- 仅当前 actualCompanion 且 status=accepted 显示“开始服务”
- 成功后页面应反映 serving
- “开始服务”按钮消失
- 普通“取消接单”按钮也必须消失，因为 serving 不允许打手普通主动取消
- 不要求重新登录或重新进入订单

客户端只负责交互，服务端必须完整 Guard。

## 六、用户侧 / 后台
已有用户订单详情、管理员订单详情若本来展示 status，应正确看到 serving。

本轮不要新增 `completion_review`，那属于 P0-8。

## 七、通知
如果最新 requirements / tech-design 已明确“开始服务”需要生命周期通知，则复用既有 Notification 通道；若未冻结，不要自行新增产品通知。

## 八、测试
至少覆盖：
1. actualCompanion 可以 start 自己的 accepted 订单；
2. 非 actualCompanion 不能 start；
3. 普通 User 不能调用 Companion start API；
4. accepted→serving；
5. `servingAt` 正确写入；
6. `actualCompanionId` 不变；
7. `acceptedAt` 历史不丢；
8. serving 不能再次 start；
9. paid/completed/refunded 不能 start；
10. start 后取消按钮不可再用；
11. start 后订单仍属于当前 Companion；
12. 其他打手无法操作；
13. route manifest gate 更新；
14. 状态机结构允许但不能替代 ownership/status Guard；
15. P0-6 主动取消链不回归；
16. P0-6.1 排序不回归。

## 九、明确不做
不得实现：
- CompletionSubmission
- 客服完成审核
- 10min 自动审核
- Earning
- complaint settlement
- serving 普通主动取消
- 封禁回池
- 客服换人
- 新退款资金联动
- 打手聊天
- Scheduler
- DB / ORM

## 十、Round Protocol
创建 `docs/03-dev/rounds/P0-7/` 五件档案，本 Prompt 原样归档到 `01-prompt.md`。

状态：`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`。

批次模式下，自动门禁全绿 + reviewer 无 BLOCKER/MAJOR 后自动进入 P0-8，不等待用户逐轮确认。

## 十一、门禁与 Reviewer
运行：
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production APP_BASE_URL 全量测试

HTTP 要求 fail=0、skipped=0。

Reviewer 重点：
- ownership 是否只由 actualCompanion 决定
- 是否存在前端-only 权限
- 是否误开放 serving 普通取消
- 是否误清历史字段
- 是否原子区段出现 await
- 是否 Route 承载主要业务
- 是否产生第二套 Order / Dispatch 系统

BLOCKER/MAJOR 必须清零。

## 十二、Git与交付
禁止任何 Git 写操作。

记录本轮 delta、API、事务、UI、测试、门禁、reviewer 和 git status。完成后在 batch 允许时自动进入 P0-8。
