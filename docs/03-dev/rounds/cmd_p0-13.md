# P0-13｜serving / completed 售后 + Admin 最终退款金额 + Earning 联动

## 目标
实现：
- serving：用户进入售后，不允许 direct refund
- completed：投诉窗口内允许普通投诉/售后
- Staff 处理售后事实
- Admin 最终决定退款金额
- 支持 partial / full refund
- 售后阻塞 frozen Earning 释放
- 退款与 Earning 保持一致

这是高风险资金 Round。

## Requirement Check：必须先回答
写业务代码前，先核对权威 docs 是否已经冻结：

### Q1 completed 后部分退款如何影响打手收益？
- 是否按退款比例同比减少？
- 是否由平台承担？
- 是否区分打手责任 / 平台责任？

### Q2 Earning 已 available 但尚未提现时发生退款如何处理？
- 是否直接减少 available earning？
- 是否需要 adjustment record / 新状态？

### Q3 已提现后的退款
本轮可以明确 DEFER，但不得自行做负余额/追偿。

若 Q1/Q2 未冻结：`P0-13 = CLARIFYING`，停止整个 batch，不自行猜。

## serving 售后
- 用户不能 direct refund
- 可创建售后/退款请求
- Staff 查看/处理
- Staff 不拥有最终金额裁决权
- Admin 最终批准/拒绝及决定金额

full refund：可 Order→refunded，终止履约、关闭 Dispatch、通知相关方，不产生正常 completed Earning。

partial refund：只累计 `refundedAmount`，不得自动设 refunded。

## completed 售后
普通投诉只在 `now <= complaintDeadlineAt` 开放，必须使用订单冻结 deadline，不读取当前 PlatformConfig 追溯历史。

存在有效 complaint/after-sales 时，Earning.frozen 不得释放。

## Admin 最终金额
只有 Admin 可以最终决定 reject / partial / full refund。Staff 可查看、沟通、记录、提建议，但不得拍最终金额。

## 退款金额约束
- 单次 > 0
- 累计 `refundedAmount <= actualPaidAmount`
- 整数分
- repeated approval 幂等
- partial 不 refunded
- cumulative full refund 才 refunded

复用现有 Refund/Payment core。

## Earning 联动
仅在 Q1/Q2 已冻结后实现。不得重新按当前商品/分账比例计算，必须基于订单冻结经济快照，例如 `companionBaseIncome`、`actualPaidAmount`。

## 收益释放
售后解决后，仍需 `now >= complaintDeadlineAt` 且无其它阻塞，下一次 sweep 才能 available。不得因为 UI 点击“处理完成”就提前释放。

## 测试
覆盖 serving 不 direct refund、serving after-sales、completed deadline 前/后、Staff/Admin 权限、partial/full 状态、refundedAmount 累计、幂等、serving full refund 终止履约、complaint/after-sales 阻塞 Earning、deadline 条件、Earning 调整规则、available earning 退款规则、DTO 隐私、P0-12 不回归。

## 明确不做
已提现追回、负余额、特殊过期申诉、会员余额、自动处罚、完整会计总账、真 Scheduler。

## Round Protocol
创建 P0-13 五件档案。Q1/Q2 未解决则 CLARIFYING 并停；已解决则开发、全门禁、reviewer，最终 AWAITING_ACCEPTANCE。

禁止 Git 写。完成/停止后输出整批报告，不得开始 P0-14。
