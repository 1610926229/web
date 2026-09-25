# P0-11｜客服换打手 + 打手禁用回池 + pending CompletionSubmission 失效

## 目标
统一处理两类“释放当前打手并重新安排履约”的异常：
1. Staff 主动换打手 / re-pool；
2. Companion 被平台禁用后，已有 accepted / serving 订单自动释放。

复用现有 release / dispatch 原语，不创建复杂 Assignment。

## available 与 enabled
- `available=false`：仍是有效 Companion；不能接新 public 单；已有 accepted/serving 不受影响。
- `enabled=false`：不能接新单，也不能继续操作已有 accepted/serving；这些订单必须释放回 public。

禁止混淆。

## 禁用释放
accepted / serving 当前订单均：
- 回到 `paid`
- 清当前履约绑定
- Dispatch → public
- fresh `publicPoolEnteredAt`
- fresh public timeout snapshot/deadline
- 保留历史
- 写 `CompanionReleaseRecord`
- 通知老板
- 旧打手失去操作权

## pending CompletionSubmission
若 serving 存在 pending：
- 先改为 `invalidated`
- 不删除历史
- Staff 不得再 approve/reject
- auto sweep 永远不得 approve
- 新打手重新 serving 后可提交新 submission

## Staff re-pool
从 `/staff/orders/[id]` 提供“重新进入公共池”，原因必填。accepted/serving 均支持。

## Staff direct replace
Staff 可直接指定新打手，不需要 Admin 批准。新打手必须 enabled、未 removed、资格有效、不是订单用户本人。

最终订单为 `accepted`，新 `actualCompanionId`，新 `acceptedAt`。若原 serving：同一同步事务内 `serving → paid → accepted`；不得新增 `serving → accepted` 状态边，也不得让中间 paid 暴露给并发抢单。

## 多次换人
允许 A→B→C→public→D，不设次数上限。每次保留 release history。

## servingAt
若最新权威 docs 对“换人回池时 servingAt 保留还是清理”仍是 DEFERRED，且实现必须依赖它，则进入 CLARIFYING，不自行决定。

## 测试
覆盖 available 不释放、enabled 释放、accepted/serving 回池、pending invalidated、invalidated 不可人工/自动审核、Staff re-pool、direct replace、self-order 禁止、disabled/removed 不可指定、新 acceptedAt、新打手可 start、旧打手不可操作、多次换人、权限矩阵、不需 Admin 审批、既有 P0-6/7/8 不回归。

## Round / 门禁 / Git
创建 P0-11 五件档案；跑 targeted/full tests、typecheck、lint、build、production HTTP、reviewer；BLOCKER/MAJOR=0 后停 AWAITING_ACCEPTANCE 并自动进入 P0-12。禁止 Git 写。
