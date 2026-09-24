# P0-8｜CompletionSubmission + 客服审核 + 10 分钟自动审核

## 零、Round 目标
实现：
`serving`
→ 打手提交完成材料
→ `CompletionSubmission.pending`
→ 客服人工通过 / 驳回
或
→ 到期后 System 自动通过
→ `Order.completed`

主 OrderStatus 仍只有：
`paid | accepted | serving | completed | refunded`

`completion_review` 只是派生展示阶段：
`Order.serving + CompletionSubmission.pending`

禁止把 `completion_review` 加入 OrderStatus。

## 一、执行前
阅读最新 requirements 三份、最新 tech-design、P0-7 Round 档案、总需求进度表、development-workflow。

确认 P0-7 自动门禁全绿、Reviewer 无 BLOCKER/MAJOR、无 OPEN 决策。记录本轮开始前工作区 baseline 与 P0-7 delta。

## 二、提交完成材料
只有：
- `Order.status === "serving"`
- 当前 Companion == `actualCompanionId`

可以提交。

内容：
- 截图 / 证明材料
- 5～50 字完成说明

证明材料的存储/DTO 形式优先复用仓库现有 evidence/image/URL 约定。不要为了 Mock P0 自行引入对象存储、上传服务或新基础设施。

如果仓库不存在可复用表示方式，且最新技术设计也没有定义到足以实现，进入 CLARIFYING，不自行发明生产存储架构。

## 三、CompletionSubmission 生命周期
至少支持：
`pending | approved | rejected`

规则：
- 同一订单同时最多一个 pending
- pending 存在时禁止第二份并行 pending
- rejected 后允许重新提交
- rejected 后新提交是新业务事实，不覆盖旧审核历史
- 重新提交重新开始自动审核计时
- approved 后不得再次提交改变 completed 事实

如果最新技术设计已定义 `invalidated` 等额外状态/字段，可保留兼容，但 P0-8 不实现封禁动作。

## 四、自动审核配置
默认自动审核等待时间：
`10 分钟`

后台可配置。

提交 pending 时冻结：
- `autoApprovalMinutesSnapshot`
- `autoApprovalDeadlineAt`

`deadline = submittedAt + snapshot`

后台后续修改配置：
- 不影响已 pending 的 submission
- 只影响未来新提交 / rejected 后重提

重新提交必须重新读取当前配置并冻结新的 snapshot/deadline。

配置必须进入现有 PlatformConfig 真值源，不新建第二套配置系统。

## 五、客服人工审核
客服可以 approve / reject。

### approve
前置：
- submission = pending
- Order = serving
- submission 属于当前有效完成材料

成功：
- submission → approved
- Order → completed
- `completedAt = at`
- 审核来源记录为 staff
- 保留审核人、审核时间

### reject
成功：
- submission → rejected
- Order 仍 serving
- 必须记录驳回原因、审核人、审核时间
- 打手可重新提交
- 重提重新计时

客服不能绕过 CompletionSubmission 随意把任意订单直接改 completed。

## 六、System 自动审核
提供可测试的 `sweepCompletionAutoApprovals(at)` 或最新技术设计中的等价服务。

条件至少包括：
- submission = pending
- `autoApprovalDeadlineAt <= at`
- Order 仍 serving
- 尚未被人工处理
- 不存在最新 requirements 定义的投诉 / 有效售后阻塞

阻塞语义必须服从最新需求和现有 Complaint/Refund 状态语义，不自行发明。

成功：
- submission → approved
- Order → completed
- `completedAt = at`
- 审核来源明确为 System

重复 sweep：
- 不重复完成
- 不刷新 completedAt
- 不重复产生副作用

P0-9 尚未实现 Earning，所以本轮不得偷偷创建临时收益。

## 七、展示阶段
用户端 / Companion / Staff 可派生显示 `completion_review`。

底层必须仍是：
`Order.status = serving`
+
`CompletionSubmission.status = pending`

不得污染主状态枚举。

## 八、Companion UI
在 serving 的本人订单详情：
- 提供提交完成材料
- 校验说明 5～50 字
- pending 后显示“完成审核中”
- pending 时禁止重复提交
- rejected 后显示驳回原因并允许重新提交
- approved/completed 后不能继续提交

服务端必须完整 Guard。

## 九、Staff UI
使用现有客服工作台结构增加最小完成审核能力：
- 查看待审核材料
- 查看证明材料/说明
- approve
- reject（必填驳回原因）

优先复用现有 Staff auth、DTO、service、页面组织。不要顺手建设完整的新客服订单系统。

如 tech-design 已给具体 route/API，按其实现；否则在现有客服域内选择最小一致落点，这属于技术组织问题。

## 十、原子性
人工 approve / System auto approve 的核心写入必须保证 Order 与 Submission 一致。

Mock 伪事务原子区段不得 await。

至少不能出现：
- submission approved 但 Order 仍 serving
- Order completed 但 submission 仍 pending
- reject 与 auto-approve 同时都成功
- staff approve 与 auto-approve 重复完成

真实 DB transaction 仍是未来约束，本轮不选 ORM/DB。

## 十一、测试
至少覆盖：
1. actualCompanion + serving 可提交；
2. 非本人 / 非 serving 不可提交；
3. 说明少于 5 / 超过 50 拒绝；
4. pending 唯一；
5. pending 时禁止第二份；
6. rejected 后可重提；
7. 重提得到新的 snapshot/deadline；
8. 默认 10min；
9. 后台改配置不追溯旧 pending；
10. staff approve → approved + completed；
11. staff reject → rejected + serving；
12. reject reason 必填；
13. 人工审核来源正确；
14. deadline 未到不自动通过；
15. 到期且无阻塞自动通过；
16. 有投诉/有效售后阻塞不自动通过；
17. System 来源正确；
18. repeated sweep 幂等；
19. staff approve vs auto approve 并发只能一个完成事实；
20. `completion_review` 不进入 OrderStatus；
21. approved 后不能再次提交；
22. P0-7 serving 链不回归；
23. Companion / Staff DTO 不泄露无关内部字段；
24. API manifest / route guard 门禁同步。

## 十二、明确不做
不得实现：
- Earning
- frozen→available
- withdrawal
- 部分退款冲正
- 封禁回池及 pending invalidation 动作
- 客服换人
- serving 普通主动取消
- 真 Scheduler
- DB / ORM
- 新对象存储基础设施

## 十三、Round Protocol
创建 `docs/03-dev/rounds/P0-8/` 五件档案，本 Prompt 原样归档到 `01-prompt.md`。

状态到 `AWAITING_ACCEPTANCE`。

批次模式下，自动门禁全绿 + reviewer 无 BLOCKER/MAJOR 后自动进入 P0-9。

## 十四、门禁与 Reviewer
每轮运行：
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production APP_BASE_URL 全量 HTTP（fail=0, skipped=0）

Reviewer 重点：
- one-pending invariant
- snapshot/deadline
- 10min 默认是否只在正确配置源
- reject 重提重新计时
- auto vs manual 并发
- completion_review 是否污染 OrderStatus
- 是否提前引入 Earning
- 是否有第二套配置/订单系统

BLOCKER/MAJOR 必须清零。

## 十五、Git与交付
禁止 Git 写。

记录本轮 delta、实体/API/UI、配置、自动审核、并发、测试、reviewer、git status。完成后在 batch 允许时自动进入 P0-9。
