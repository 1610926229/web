# P0-12｜paid / accepted 用户免审批全额退款

## 目标
实现：
- paid：用户直接全额退款
- accepted：用户直接全额退款
- serving：不得 direct refund，进入售后
- completed：投诉/售后

Direct refund 必须幂等。

## 用户入口
只有订单本人且 status=paid/accepted 且未全额退款时，服务器允许 direct refund。前端按钮不是权限真值。

## paid refund
成功：
- full refund
- Order → refunded
- `refundedAmount = actualPaidAmount`
- Dispatch 关闭，不能再被接单
- timeout sweep 不得再次退款
- 不创建 Earning

复用现有 Refund/Payment core。

## accepted refund
成功：
- full refund
- Order → refunded
- `refundedAmount = actualPaidAmount`
- Dispatch 关闭
- 当前打手不能再 start/cancel/submit
- 不生成 Earning
- 通知当前打手
- **保留 `actualCompanionId` 作为历史事实**

这与 cancel/ban/re-pool 不同，后者清当前履约 binding 并用 release record 保存历史。

## 幂等与并发
重复 direct refund 不重复出款、不重复通知、不刷新退款事实；`refundedAmount` 不得超过 `actualPaidAmount`。

用户 direct refund 与 public timeout automatic refund 并发只能形成一次 full refund。

## 状态
`refunded` 只表示全额退款。本轮不提前实现 partial refund。

## 测试
覆盖 paid/accepted owner refund、非本人、serving/completed 拒绝、幂等、退款金额、accepted 保留 actualCompanionId、通知一次、Dispatch 关闭、不生成 Earning、direct vs timeout 并发、refundedAmount 上限、现有 admin/system refund 不回归、DTO 隐私、UI 状态。

## Round / 门禁 / Git
创建 P0-12 五件档案；全门禁 + reviewer 通过后停 AWAITING_ACCEPTANCE 并进入 P0-13。禁止 Git 写。
