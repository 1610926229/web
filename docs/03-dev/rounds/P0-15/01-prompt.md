# P0-15 原始指令档案

Round: P0-15
Received At: 2026-09-28
Source: User

> **本文件是原始档案。** 下面两段是产品负责人在同一轮里先后发来的指令，
> **逐字保存，未作任何总结、改写、美化或删减**。
> 它们很口语、有重复、有错别字，**这正是它们的价值**——
> 将来回看时需要知道用户当时到底说了什么，而不是 Claude 理解成了什么。
>
> - **指令 ①**（先到）：退款规则覆盖（一个订单最多一次退款 / 打手收益一律归零 /
>   废弃责任模型 / Companion 展示状态与订单状态分离）。
> - **指令 ②**（后到）：**补充并修正**。它部分推翻了指令 ① 的**框架**，
>   并新增了一整个**结算冻结域**（`complaintWindowMinutes` snapshot → `complaintDeadlineAt`）。
>
> **两者冲突时以 ② 为准**（② 明确自称「补充并修正」）。

---

# 指令 ① · 退款产品规则覆盖

修正上一版产品规则：**一个订单最多只允许一次退款，不存在多次退款、累计退款、第二次退款申请。** 请按这个前提重新收敛退款模型。

## 一、订单退款次数

每个 Order：

- 最多一个 RefundRequest；
- 最多一次实际退款执行；
- 不存在第一次 30%、第二次 20%、第三次退满；
- 不存在 cumulative refund 业务。

用户提交退款申请后,不允许针对同一订单再次创建新的退款申请。管理员对该申请一次性决定最终退款比例/金额。审批通过并执行退款后：该订单退款流程终结。不得再次退款。

## 二、退款金额

管理员一次性决定 10%/30%/50%/100% 或现有 UI 支持的合法比例。

`refundAmount = floor(actualPaidAmount × refundRate)`；全额退款时 `refundAmount = actualPaidAmount`。

由于不存在前序退款,因此不再需要：remaining refundable、cumulative refunded amount、多次退款补尾差、第二次「退满剩余」。如果 UI 仍保留「退满剩余」表达,可以将其收敛为：全额退款。

## 三、打手收益新规则

只要这唯一一次退款被管理员批准：该订单打手最终收益立即归零。无论退款比例 10%/30%/50%/100% 均为 `Companion final net income = 0`。`Earning.incomeAmount` 继续保留原始历史快照。通过 `EarningAdjustment` 一次性将 `netIncome → 0`。不得根据退款比例只冲减部分打手收益。

## 四、平台最终收入

唯一退款执行后：`Platform net income = actualPaidAmount − refundAmount`。

（示例：实付 100、退 10% → User 10 / Companion 0 / Platform 90；退 50% → 50/0/50；退 100% → 100/0/0。）

不再需要：platform / companion / shared、companionLiabilityRate、多次 EarningAdjustment 累计冲回。

## 五、责任模型

废弃新退款写路径中的 platform / companion / shared / companionLiabilityRate。管理员不再选择责任归属。

统一业务规则：一旦退款审批通过,打手本单收益全部取消；用户获得管理员核定退款额；剩余金额归平台。

历史数据中的旧责任字段如迁移成本较高,可以只读兼容,但新写路径不得继续依赖。

## 六、订单状态与打手展示状态

必须分离。部分退款（如 10%）：`Order.status` 保持当前真实生命周期（serving / completed）；但 Companion 侧 `displayStatus = refunded`、`displayStatusLabel = 已退款`,并显示「本单收益 = ¥0」。

100% 全额退款：`Order.status = refunded`,Companion 同样显示「已退款」。

## 七、聊天

部分退款：若真实 Order.status 仍是 serving / completed 等有效状态,assignment chat 按真实生命周期继续运行,不得因为 Companion displayStatus = 已退款 就锁聊天。

100% 全额退款（`Order.status = refunded`）：User ↔ Companion assignment 历史可读；User 不可再向打手发送；Companion 不可再发送；User ↔ Staff service conversation 继续可读写；Staff 调查读取继续可用。

## 八、退款唯一性

服务端必须强制：同一个 orderId 已存在退款申请时,不允许创建第二个；已经执行退款后,不允许再次退款；Admin approve 必须具备幂等性；重复请求不得产生第二笔真实退款；不得产生第二份 Earning reversal。不要只在 UI 隐藏按钮。Repository / transaction 层必须有硬约束。

## 九、需要清理的旧逻辑

检查并删除/废弃：cumulative refund 逻辑；多次 partial refund 测试；refundFullRemaining 用于"补最后一次余额"的设计；第二次退款；多次 EarningAdjustment 累加至 incomeAmount；多次 RefundRequest。如果某字段还因历史兼容需要保留,明确标记 deprecated,不要继续让新业务路径依赖。

## 十、测试

至少覆盖 20 项：

1. 一个订单只能创建一个退款申请；
2. 第二次申请服务端拒绝；
3. 退款执行成功后再次退款拒绝；
4. 10%退款 → User refund 正确；
5. 10%退款 → Companion net = 0；
6. 10%退款 → Platform net = 90%；
7. 50%退款 → Companion net = 0；
8. 50%退款 → Platform net = 50%；
9. 100%退款 → Order.status = refunded；
10. 部分退款 → Order.status 不误变 refunded；
11. 部分退款 → Companion displayStatus = 已退款；
12. 部分退款 → Companion earning = 0；
13. 部分退款 → assignment chat 不误锁；
14. 全额退款 → assignment chat 只读；
15. service 客服聊天继续可写；
16. Earning.incomeAmount 历史值不变；
17. EarningAdjustment 只产生一次完整冲回；
18. 重复 approve 幂等；
19. 不存在第二次实际退款；
20. 新写路径不再依赖 responsibility / companionLiabilityRate。

这是当前退款产品规则的正式覆盖版本。不得按上一版"多次累计退款"规则继续开发。P0-14 / P1-1 / P1-2 继续保持 AWAITING_ACCEPTANCE。禁止 Git 写操作。

---

# 指令 ② · 补充并修正当前退款 / Earning 产品规则

补充并修正当前退款 / Earning 产品规则。

注意：

此前关于"withdrawn 后如何追偿"的讨论没有作为正式产品裁定发送，不要按该方向实现。

当前正式规则如下。

## 一、投诉 / 售后窗口不是固定 2 天

投诉期长度由：

`PlatformConfig.complaintWindowMinutes`

决定。

不得再在业务文档或代码中写死：

"固定两天"。

订单完成时：

1. 读取当时的 `complaintWindowMinutes`；
2. snapshot 到该订单；
3. 生成 `complaintDeadlineAt`。

之后管理员调整平台配置：

- 只影响之后新完成的订单；
- 不追溯修改已有订单的投诉截止时间。

继续遵守 P1-2 已冻结的 snapshot 语义。

## 二、订单完成后的收益冻结

订单进入：

`completed`

后，在其自身 `complaintDeadlineAt` 到期之前：

`Earning.status = frozen`

该笔收益：

- 不可提现；
- 不可转为 withdrawn；
- 不得提前释放为 available。

## 三、退款 / 投诉会阻塞结算

只要存在仍然有效的：

- refund request；
- complaint；
- aftersales processing；
- 或当前已有的 settlement block；

该订单 Earning 必须继续保持：

`frozen`

即使原 `complaintDeadlineAt` 已经过期，也不得直接释放。

只有同时满足：

1. `complaintDeadlineAt` 已到；
2. 没有待处理退款；
3. 没有待处理投诉；
4. 没有其它 settlement block；

才能：

`frozen → available`

## 四、退款批准后的新收益规则

只要管理员批准该订单唯一一次退款：

**打手本单收益全部取消。**

因为正常退款发生在结算冻结阶段，所以处理对象应当仍是：

`Earning.status = frozen`

退款比例无论：

- 10%
- 30%
- 50%
- 100%

均为：

`Companion final net earning = 0`

保持：

`Earning.incomeAmount`

作为原始历史快照。

通过一次 adjustment / reversal 将该单净收益归零。

## 五、不设计 withdrawn 追偿

当前普通退款业务不需要：

- withdrawn recovery；
- negative balance；
- receivable ledger；
- future earning offset；
- 对打手追偿；
- 平台垫付后追债。

原因不是"withdrawn 后由谁承担"，而是：

**正常业务设计应保证退款处理完成之前收益根本不会进入可提现阶段。**

如果未来平台需要支持：

"结算完成、甚至已提现后仍由后台特殊强制退款"

那属于新的特殊财务业务，未来单独设计，不混入当前退款流程。

## 六、结算释放必须防竞态

重点检查：

`complaintDeadlineAt 到期释放收益`

与：

`用户提交退款 / 投诉`

是否可能并发。

收益释放 transaction 在真正执行：

`frozen → available`

前，必须在同一原子业务区域重新确认：

- deadline 已过；
- 没有有效退款；
- 没有有效投诉；
- 没有 settlement block。

不得只依赖之前页面 / service 层读取到的旧状态。

目标是从结构上保证：

**只要退款流程已经成立，该订单收益就不可能同时被释放。**

## 七、与当前退款新规则结合

每个订单：

- 最多一次退款；
- 管理员一次性核定退款比例 / 金额；
- refund approved 后打手本单收益归 0；
- 未退款部分归平台。

例如：

订单实付 100 元，退款 30 元：

- User refund = 30
- Companion net income = 0
- Platform net income = 70

这里不再使用：

- platform responsibility
- companion responsibility
- shared responsibility
- companionLiabilityRate

决定最终打手收益。

## 八、订单状态仍按真实退款程度处理

部分退款：

例如退款 10%：

- Order.status 不因为打手收益归零而强制变成 `refunded`；
- Companion 端可按已冻结产品规则显示派生的"已退款"；
- assignment chat 是否可写继续依据真实 Order 生命周期；
- 不得因为 Companion 展示"已退款"就提前关闭聊天。

真正全额退款：

- `Order.status = refunded`
- assignment conversation 历史只读
- User ↔ Staff service conversation 继续可写

## 九、文档修正

统一清理以下不准确表述：

- "固定两天投诉期"
- "退款后可能需要追偿已提现收益"
- "普通退款需要 negative balance"

改为：

**投诉窗口由 PlatformConfig 配置并在 completed 时 snapshot；窗口及未结售后期间收益保持 frozen，只有全部结算阻塞解除后才能 available。**

历史 Round 中当时真实的旧讨论不要篡改，只在当前规则文档中标记 superseded / current rule。

## 十、测试

至少覆盖：

1. complaintWindowMinutes 可配置；
2. completed 时 snapshot；
3. 修改配置不改变旧订单 complaintDeadlineAt；
4. deadline 前 Earning 始终 frozen；
5. deadline 到期但存在 refund → 仍 frozen；
6. deadline 到期但存在 complaint → 仍 frozen；
7. deadline 到期且无 block → available；
8. refund approved 时 Earning 仍 frozen；
9. refund approved → Companion net = 0；
10. refund approved 后不得再释放该 earning；
11. 结算释放与退款提交并发时不能错误释放；
12. 部分退款不错误修改全局 Order.status；
13. 全额退款才进入 Order.status = refunded；
14. 不存在普通退款 → withdrawn recovery 的业务路径。

本次不要引入钱包 / 负余额 / 追偿系统。

完成后给出：

1. complaint window snapshot 设计；
2. earning release 唯一条件；
3. refund 如何阻塞 settlement；
4. 为什么普通退款下 withdrawn 不可达；
5. 并发保护方式；
6. 退款批准后收益归零实现；
7. 测试和门禁结果。

禁止 Git 写操作。
