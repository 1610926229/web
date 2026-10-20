# P1-4｜优惠券交易链路与结算口径校准

## 目标
修复/补齐 Coupon 在结算、下单、支付、订单快照、退款、平台收入、打手收益中的一致性。不是重做营销系统。

## 已冻结经济规则
优惠券成本由平台承担，不降低打手原始分成基数。

必须区分：
- payableBeforeCoupon
- couponDiscountAmount
- actualPaidAmount
- companionBaseIncome
- platform net

P0-15 继续有效：
- 一单一退
- approved refund 后 companion net = 0
- platform net = actualPaidAmount - refundAmount
- 用户退款不得超过实际支付

## Requirement Check
检查当前 coupon 类型/仓储/API/UI、checkout preview、order creation/payment、Order snapshot、refund、Earning、Admin coupon 管理，以及 docs 中有效期/门槛/适用范围/次数规则。
未冻结的营销规则不得自行发明。

## 金额不变量
`actualPaidAmount = payableBeforeCoupon - couponDiscountAmount`

并保证：
- couponDiscountAmount >= 0
- actualPaidAmount >= 0
- 优惠不转嫁给 Companion
- refundAmount 基于 actualPaidAmount
- 不得超退
- approved refund 后 companion net 按 P0-15 归零
- platform final net = actualPaidAmount - refundAmount

## Coupon 快照
订单形成后冻结足够的 Coupon snapshot，后台后来改券不能改变历史订单金额。
至少核查 coupon id、展示信息（如需要）、discount amount、必要规则快照。
不建立复杂 versioning。

## 合法性
复用权威规则验证 enabled、有效期、门槛、适用范围、使用限制（仅已有需求）。
preview 与最终服务端校验必须一致，最终以服务端为准。

## 展示
用户结算页：原金额 / 优惠 / 实付。
订单详情和 Admin 金额摘要保持一致。
Admin 退款必须基于 actualPaidAmount。

## 测试
至少覆盖：
1. 无券
2. 有券
3. 实付计算
4. 优惠不压低 companion base income
5. platform 承担优惠
6. 券修改不追溯历史订单
7. disabled 券拒绝
8. 过期券拒绝
9. 门槛边界
10. preview 与最终创建一致
11. 退款不超过 actualPaidAmount
12. 10/50/100% refund + coupon
13. approved refund 后 companion net=0
14. platform net 正确
15. DTO exact keys
16. 金额整数分
17. checkout/order/admin 展示一致
18. 无券链路不回归

## 不做
新营销玩法、券叠加（除非已有需求明确）、会员、积分、钱包、真支付。

## 门禁 / Git
完整门禁；禁止 Git 写操作。

## 结束
P1-4 停 AWAITING_ACCEPTANCE。
如某营销子规则未冻结，只将对应子项 BLOCKED，不要让整批停止，继续 P1-5。
