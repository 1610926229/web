Round: P1-4
Received At: 2026-09-29（夜间连续开发批次，用户指令：依次执行 cmd_p1-3 → cmd_p1-4 → cmd_p1-5，中途不等待人工回复）
Source: User（原文档案，未经加工）

> ⚠️ 本文件是**原始指令档案**，正文逐字来自 `docs/03-dev/rounds/cmd_p1-4.md`，
> 不做总结、不改写、不加工。

---

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


---

## 二、第二轮提示词：P1-4 验收整改（2026-09-29）

> 协议 §六：收到的提示词**按原文保存**，不摘要、不改写、不删节。以下为原文。

P1-4 人工验收发现问题并新增正式产品规则。

当前：

- P0-14：人工验收 PASSED
- P0-15：人工验收 PASSED
- P1-4：暂不通过，进入验收整改
- 禁止启动 P1-6
- 禁止任何 Git 写操作

本轮只修 P1-4。

# 一、退款后的优惠券返还规则

正式规则：

**优惠券是否返还，不看退款比例，也不能只看退款瞬间的 Order.status，而看订单是否曾经进入过“已被打手承接”的阶段。**

## 1. 应返券

如果订单从创建到退款为止：

**从未进入 accepted**

即没有任何打手真正承接该订单，则退款完成后：

- 用户退款正常执行；
- 本订单使用的 CouponClaim 恢复为可再次使用状态；
- 不得创建一张新的重复券；
- 原订单继续保留 Coupon snapshot 作为历史事实。

典型路径：

`paid → 用户主动全额退款`

或：

`paid → 专属池超时 → 公共池 → 无人接单 → 系统退款`

只要此前从未进入 accepted：

→ 返券。

---

## 2. 不返券

只要该订单历史上曾经进入：

`accepted`

则之后无论在哪个状态发生退款：

优惠券都不返还。

包括：

- accepted 时退款；
- serving 时退款；
- completed 后退款；
- accepted → Companion cancel/repool → 又回到 paid → 用户退款；
- Staff direct assignment / replacement 后退款。

不要仅写：

`if (order.status === "paid") returnCoupon`

这是错误的。

必须判断：

**订单历史上是否曾经被承接。**

---

## 3. Staff direct assignment 的语义

这里和 P1-5 接单榜是两个概念。

P1-5：

Staff 直接换人不算 Companion 主动“接单事件”。

但优惠券返还：

Staff 直接指定 Companion 后，订单已经产生真实服务承诺并进入 accepted，因此：

**视为已经被承接，不返券。**

不得复用排行榜的 `acceptedVia === companion` 判断优惠券返还。

---

# 二、CouponClaim 返还行为

退款满足“未曾被承接”时：

原来已经核销的 CouponClaim：

`used → unused`

同时清理当前使用态需要清理的：

`usedAt`

但：

原退款订单上的 coupon snapshot 必须保留。

不得因为返券：

- 删除历史订单券信息；
- 修改历史 actualPaidAmount；
- 修改历史 couponDiscountAmount。

订单历史必须仍然能说明：

“这张订单当时使用过该优惠券，只是订单退款后使用资格被返还。”

---

# 三、返还后的当前可用性

返还 CouponClaim 不等于无条件可再次使用。

返还后仍然要经过当前优惠券合法性判断。

例如：

- Coupon 模板已 `enabled=false`
  → Claim 虽已返还，但不能核销；
- 当前日期已经超过领取快照的 validTo
  → 不能核销；
- 新订单未达到 thresholdAmount
  → 不能选择。

也就是说：

**返还的是 CouponClaim 的“未使用资格”，不是绕过 enabled / expiry / threshold。**

---

# 四、管理员向指定用户发放优惠券

新增 Admin 能力：

**管理员可以选择一个 Coupon 模板，并向指定 User 发放优惠券。**

优先复用现有 Admin Coupon / User 管理结构，不创建第二套优惠券系统。

管理员至少能够：

1. 查找/选择目标 User；
2. 选择 enabled Coupon 模板；
3. 确认发放；
4. 成功后用户立即能在自己的优惠券账户看到。

---

# 五、管理员发券与普通领取的关系

普通用户主动领取：

维持现有限制：

**同一 User 对同一 Coupon 模板只能主动领取一次。**

但是：

**Admin grant 是独立发放行为。**

管理员允许：

- 向已经领取过该模板的用户再次发放；
- 向已经使用过该模板的用户再次发放；
- 多次发放同一模板。

每次 Admin grant 生成独立 CouponClaim。

每个 Claim 自己：

`unused → used`

且只能核销一次。

因此 checkout 必须以：

`couponClaimId`

识别具体哪一张用户持有券，

不能只靠 couponId 判断。

---

# 六、建议增加 Claim 来源

如果当前模型没有来源字段，增加最小来源信息，例如：

`source = "self_claim" | "admin_grant"`

Admin grant 同时保存最小审计信息，例如：

- grantedByAdminId
- claimedAt / grantedAt

不要建立复杂营销 Ledger。

普通 self-claim 的“一模板一次”限制：

只约束 `source=self_claim`。

Admin grant 不受此限制。

---

# 七、Admin 发放时的 snapshot

管理员发券时，同样按照当前 Coupon 模板生成 CouponClaim snapshot。

因此：

模板后续修改：

- thresholdAmount
- discountAmount
- 券面文案
- validFrom / validTo

不得追溯修改已经发出去的 Claim。

继续保持已经追认的规则：

**金额 / 门槛 / 有效期等承诺看 Claim snapshot。**

但：

**是否允许继续使用看 Coupon 模板当前 enabled。**

也就是：

- snapshot 决定“这张券是什么”
- current enabled 决定“平台现在是否允许它使用”

---

# 八、修复“账户有可用券，但 checkout 显示无可用券”

这是本轮人工验收真实发现的缺陷。

不要直接猜根因。

先复现并检查：

1. 用户优惠券账户实际返回哪些 CouponClaim；
2. Claim.status；
3. source；
4. snapshot.formKey；
5. snapshot.thresholdAmount；
6. snapshot.discountAmount；
7. snapshot.validFrom / validTo；
8. 当前 Coupon.enabled；
9. checkout 当前 originalAmount；
10. checkout 获取优惠券时使用的是 couponId 还是 couponClaimId；
11. 浏览器请求 → Route → Service → Repository 哪一层把券过滤掉。

找到真实原因后修复。

---

# 九、账户“可用”与 checkout 的一致性

当前 P1-4 真正参与结算的只有：

`threshold`

满减券。

因此用户账户中：

### 真正“可用”的券

至少必须满足：

- Claim.status = unused
- formKey = threshold
- Claim snapshot 在有效期
- 对应 Coupon 当前 enabled = true

这类券可以显示在：

`可用优惠券`

区域。

### discount / gift

由于 P1-4 尚未实现其 checkout 金额语义：

不得继续把它们标成“可用于当前下单”的券。

可以继续展示，但应明确：

`暂不可用于结算`

或放入其它分组。

不得出现：

账户页面写“可用”
→ checkout 永远无法使用

这种前后矛盾。

---

# 十、checkout 优惠券选择体验

checkout 应区分：

### 可立即使用

满足：

`originalAmount >= thresholdAmount`

允许选择。

### 当前金额未达门槛

如果用户确实持有一张合法满减券，但当前订单金额不足：

不要把整张券藏掉并简单显示：

`无可用优惠券`

应该展示该券但禁用，并明确原因，例如：

`满 ¥50 可用，还差 ¥12`

这样用户能知道自己有券，只是当前订单不满足条件。

### 真正没有任何可参与 checkout 的 Claim

才显示：

`暂无可用优惠券`

---

# 十一、服务端仍是最终真值

即使前端显示可使用，订单真正创建 / 支付前服务端仍必须重新校验：

- Claim 属于当前 User；
- Claim unused；
- Coupon current enabled；
- snapshot formKey === threshold；
- 当前时间处于 Claim snapshot 有效期；
- originalAmount >= snapshot.thresholdAmount；
- discountAmount 合法；
- Claim 没有被其它订单并发核销。

不得信任前端传：

- discountAmount
- thresholdAmount
- couponDiscountAmount

前端只传：

`couponClaimId`

金额由服务端计算。

---

# 十二、原子性

成功订单必须保证：

“CouponClaim 核销”

与：

“订单真正创建/支付成立”

处于当前 Mock 能做到的同一同步原子业务区域。

失败不得出现：

订单没创建
但券已经 used。

退款返券也必须：

退款实际成功
→ 才恢复 Claim。

不能先返券后退款失败。

---

# 十三、测试

至少覆盖：

1. paid 且从未 accepted → 用户退款 → 券 returned；
2. 公共池无人接单系统退款 → 券 returned；
3. accepted → refund → 不返券；
4. serving → refund → 不返券；
5. completed → refund → 不返券；
6. accepted → repool → paid → refund → 不返券；
7. Staff direct assignment → refund → 不返券；
8. returned Claim 恢复 unused；
9. returned Claim 的历史订单 snapshot 不变；
10. returned 后模板 disabled → 仍不可使用；
11. returned 后已过期 → 不可使用；
12. Admin 可以给指定 User 发券；
13. Admin grant 后用户账户立即可见；
14. 同一模板可以 Admin grant 多次；
15. 多个相同模板 Claim 由 claimId 区分；
16. self-claim 一模板一次规则不回归；
17. Admin grant 不占用 self-claim quota；
18. Claim snapshot 不随模板后改而改变；
19. 模板 disabled 后 Admin 已发 Claim 不能使用；
20. 用户账户可用券与 checkout 数据一致；
21. 未达门槛券在 checkout 显示但禁用，并有原因；
22. 满足门槛后可选择；
23. discount/gift 不再错误标为 checkout 可用；
24. checkout 只能使用自己的 claimId；
25. 重复核销拒绝；
26. preview 不消耗券；
27. 建单失败不消耗券；
28. 退款返券只有真实退款成功后发生；
29. 有券订单退款仍基于 actualPaidAmount；
30. P0-15 companion earning / platform net 不回归。

---

# 十四、人工验收发现的现象必须加入回归

必须构造与人工现场等价的测试：

“用户账户里存在多张被标为可用的优惠券”

→ 进入满足条件的商品 checkout

→ 至少对应的 threshold Claim 必须出现在选择列表

不得再次出现：

账户显示多张可用
但结算统一显示无可用优惠券。

这个回归测试必须真实经过当前 Service / Repository 选择链，而不是只测一个纯函数。

---

# 十五、状态

P0-14：
人工验收 PASSED。

P0-15：
人工验收 PASSED。

P1-4：
因本轮人工验收发现问题，保持非 DONE 状态，完成整改后重新等待人工复验。

不要回滚已经通过的 P0-14 / P0-15。

---

# 十六、门禁

修完后：

targeted coupon/refund/checkout/admin tests
→ pnpm test
→ typecheck
→ lint
→ build
→ production APP_BASE_URL full test
→ reviewer

要求：

- BLOCKER = 0
- MAJOR = 0
- fail = 0

如果发现产品规则之外的新问题，登记，不自行扩大到 P1-6。

全程禁止 Git 写操作。

最终报告重点回答：

1. 原“账户有券但 checkout 无券”的真实根因；
2. 优惠券何时返还；
3. 为什么 accepted→repool→paid 后退款仍不返；
4. Admin grant 数据模型；
5. self-claim 与 admin-grant 如何共存；
6. Claim snapshot 与 current enabled 如何分工；
7. checkout 如何展示“有券但门槛不足”；
8. 原子核销 / 退款返券如何保证；
9. 测试与 reviewer 结果；
10. 人工复验最短路径。
