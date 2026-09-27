# P0-13｜serving / completed 售后 + Admin 最终退款金额 + Earning 联动（续开发版）

## 一、状态
继续使用现有 `P0-13`，不创建新 Round。
将状态从 `CLARIFYING → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`。

## 二、正式裁定的资金规则
Admin 在最终退款决策时认定责任：
- `platform`
- `companion`
- `shared`

Staff 只能调查、记录、提出建议，不能最终决定退款金额或责任。

### completed 部分退款与 Earning
- `platform`：`companionReversalAmount = 0`
- `companion`：`floor(companionBaseIncome × refundRate)`
- `shared`：`floor(companionBaseIncome × refundRate × companionLiabilityRate)`
- `companionLiabilityRate` 范围：0%～100%，由 Admin 填写。
- 金额单位继续使用整数分。

Refund 最终决策至少可审计：
- responsibility
- refundAmount
- refundRate
- companionLiabilityRate
- companionReversalAmount
- platformBorneAmount

## 三、Earning 历史事实
`Earning.incomeAmount` 是 completed 时基于订单经济快照确定的原始应得收益，永远不修改。
不得重新读取当前商品价格或当前分成比例重算历史收益。

退款通过独立 `EarningAdjustment`（或仓库现有等价命名）表达，不建立完整钱包/总账。

最小关联：
- id
- earningId
- orderId
- refundId
- type=`refund_reversal`
- amount
- responsibility
- createdAt

金额符号约定必须全项目唯一并通过测试固定。

## 四、available / frozen 收益退款
实际净收益：
`netAvailableAmount = incomeAmount - cumulativeReversalAmount`

部分冲回：
- incomeAmount 不变
- `0 < cumulativeReversalAmount < incomeAmount`
- frozen 仍 frozen；available 仍 available

全部冲回：
- `cumulativeReversalAmount == incomeAmount`
- `netAvailableAmount = 0`
- `Earning.status = reversed`

同一 Earning 允许多次 reversal，但必须：
`0 <= cumulativeReversalAmount <= incomeAmount`

同一个 Refund 重放不得重复 adjustment。

## 五、已提现
继续 DEFER。
本轮不实现：
- 已提现追回
- 负余额
- 后续收益抵扣
- 人工追偿
- 钱包余额桶
- withdrawal recovery

## 六、serving 售后
serving 订单：
- 用户不能走 P0-12 direct refund
- 进入售后/退款请求
- Staff 处理事实
- Admin 最终批准/拒绝并决定 refundAmount / responsibility

full refund：
- 终止履约
- Dispatch 关闭
- Order → refunded
- `refundedAmount = actualPaidAmount`
- 不生成正常 completed Earning

partial refund：
- 累计 refundedAmount
- Order 不因 partial 自动变 refunded

## 七、completed 售后
普通投诉仅在：
`now <= complaintDeadlineAt`

必须使用订单冻结的 deadline，不读取当前 PlatformConfig 改历史。

有效 complaint / after-sales 存在时，阻塞 frozen → available。

## 八、Admin 最终金额
Admin 支持：
- reject
- partial refund
- full refund

并决定：
- refundAmount / refundRate
- responsibility
- shared 时 companionLiabilityRate

要求：
- refundAmount > 0
- 累计 refundedAmount <= actualPaidAmount
- 金额整数分
- repeated approval 幂等
- partial 不设 refunded
- 累计 full 才 refunded

## 九、P0-10 displayId 补缺
检查 `/staff/orders` 是否支持用户实际展示 `displayId` 搜索。

如果当前只能搜内部 `u-1001`：
- 补 `displayId`
- 保留已有内部 ID 搜索
- 补测试
- 记录为 P0-10 acceptance fix，而不是 P0-13 新功能

## 十、权限
User：
- 可以发起允许的售后
- 不能定金额/责任
- 不能改 Earning

Staff：
- 可查看、处理、记录、提建议
- 不能最终定金额/责任

Admin：
- 可 reject / partial / full refund
- 可定 responsibility
- shared 时可定 companionLiabilityRate

## 十一、测试至少覆盖
1. serving 不能 direct refund
2. serving 可进入售后
3. completed deadline 前可投诉
4. deadline 后普通投诉关闭
5. Staff 不能最终定金额
6. Admin 可 partial/full/reject
7. partial 不设 refunded
8. 累计 full 才 refunded
9. refundedAmount 不超 actualPaidAmount
10. replay 幂等
11. platform reversal=0
12. companion reversal 公式
13. shared reversal 公式
14. liabilityRate 范围校验
15. incomeAmount 永远不改
16. frozen partial reversal 仍 frozen
17. frozen full reversal → reversed
18. available partial reversal 仍 available
19. available full reversal → reversed
20. 多次 adjustment 累计正确
21. 不超 incomeAmount
22. 同 refund 不重复 adjustment
23. complaint/after-sales 阻塞 release
24. resolved 但 deadline 未到仍 frozen
25. deadline + no blockers → available
26. withdrawn 路径未实现
27. 不建立余额桶
28. P0-12 不回归
29. P0-11 不回归
30. P0-9 sweep 不回归
31. User/Staff/Admin 权限矩阵
32. DTO 隐私
33. P0-10 displayId 搜索

## 十二、文档同步
把本轮裁定同步到：
- requirements
- `database-schema.md`
- `api-contract.md`
- `architecture-rules.md` / architecture plan
- `P0-13/02-decisions.md`

只追加最新裁定，不覆盖历史记录。

## 十三、门禁
执行：
- targeted tests
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production APP_BASE_URL 全量测试
- reviewer-agent 只读审查
- 修全部 BLOCKER / MAJOR
- 最终完整复跑

production HTTP 要求：
- fail = 0
- skipped = 0

## 十四、Git
禁止：
- git add
- git commit
- git push
- git reset
- git restore
- git checkout
- git rebase
- git amend

只允许只读 Git。

## 十五、最终状态
完成后：
- `P0-13 = AWAITING_ACCEPTANCE`
- User Result = PENDING
- Final Result = PENDING
- 不开始 P0-14
- 输出完整交付报告并停止
