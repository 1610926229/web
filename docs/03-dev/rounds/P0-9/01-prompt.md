# P0-9｜Earning.frozen + 可配置投诉窗口 + frozen → available

## 零、Round 目标
把正常履约链闭合到：

`completed`
→ 生成实际打手 Earning
→ `Earning.frozen`
→ 投诉窗口结束且无阻塞
→ `Earning.available`

同时把投诉窗口改为后台可配置，并在每张订单完成时冻结本单 snapshot/deadline。

本轮不做提现。

## 一、执行前
阅读最新 requirements、tech-design、P0-8 Round 档案、总需求进度表、development-workflow。

确认 P0-8 的人工 approve、自动 approve、Order.completed 均通过自动门禁且 reviewer 无 BLOCKER/MAJOR。记录本轮 baseline 与 P0-8 delta。

## 二、投诉窗口配置
投诉窗口时长来自现有 PlatformConfig 真值源。

要求：
- 后台可配置
- 不把“48h”写死为不可变业务规则
- Order 进入 completed 时冻结：
  - `complaintWindowSnapshot`
  - `complaintDeadlineAt`

`complaintDeadlineAt = completedAt + snapshot`

后台之后修改配置：
- 不改变历史 completed 订单
- 只影响未来进入 completed 的订单

如果最新权威 requirements / tech-design 已定义当前 Mock 默认值，严格使用；如果没有定义默认值，不得自行拍值，进入 CLARIFYING。

## 三、completed 的统一完成事务
P0-8 有两个完成来源：
- staff approve
- System auto approve

P0-9 必须把“投诉窗口快照 + Earning 创建”接入这两个合法完成来源的统一业务路径。

禁止复制成两套金额/收益逻辑。

两种来源完成后都得到同样经济事实：
- Order.completedAt
- complaint snapshot/deadline
- Earning.frozen

审核来源差异继续由 CompletionSubmission 保存。

## 四、Earning
Earning 是独立领域，不加入 OrderStatus。

每个完成订单针对实际履约打手生成实际收益记录。

金额必须直接使用订单冻结的：
`Order.companionBaseIncome`

禁止：
- 重新查当前商品价格
- 重新查当前分账比例
- 因优惠券重新降低理论 companionBaseIncome
- 客户端重算金额

字段命名以最新 `database-schema.md` 为准，不另造平行模型。

## 五、Earning 初始状态
订单 completed 时：
`Earning.status = frozen`

同一 order 不得重复创建第二条有效 Earning。

staff approve 与 System auto approve 必须共用该约束。

重复请求 / sweep 不得重复入账。

## 六、投诉窗口
普通投诉入口：
- `complaintDeadlineAt` 前：按现有投诉规则允许用户对自己的 completed 订单发起普通投诉
- deadline 后：普通投诉入口关闭

特殊人工申诉属于后续 TBD，不在本轮实现。

不要把“过期后没有任何人工处理可能”写成永久规则。

## 七、冻结收益释放
提供可测试的 `sweepMaturedEarnings(at)` 或最新技术设计中的等价服务。

当：
- Earning = frozen
- `complaintDeadlineAt <= at`
- 不存在 requirements 定义的有效投诉 / 售后 / 其它冻结原因

则：
`Earning.frozen → available`

要求：
- repeated sweep 幂等
- available 后不刷新 availableAt
- 有阻塞继续 frozen
- 阻塞解除后，下一次 sweep 可释放（仍需满足 deadline）

真实 Scheduler 仍是 production blocker；Mock 阶段沿用现有 lazy sweep / 显式 sweep 测试模式，不在本轮接后台任务基础设施。

## 八、退款/投诉边界
本轮只把“普通投诉窗口是否开放”和“是否阻塞收益释放”接入正常链路。

不得扩大为：
- serving 部分退款
- completed 部分退款
- 已提现冲正
- 负余额追偿
- 提现
- 会员费

现有投诉/退款模块只做必要最小联动，不重构整个售后系统。

## 九、Companion 收益查看
如果最新 requirements / tech-design 已确认 Companion 可以查看自己的 Earning，则提供最小“我的收益”读取能力：

- 复用 Companion 工作台
- 只能查看当前 companion 自己的收益
- 展示订单号、金额、状态、冻结到期时间等必要字段
- 不看其他打手收益
- 不看平台净利润
- 不实现提现

如技术设计已给具体 route/page，按其实现；否则选择最小一致落点，不建设复杂钱包系统。

## 十、Admin Platform Config
在现有平台参数管理中加入投诉窗口配置。

要求：
- 复用现有 admin platform config service/repository/audit
- 配置变更留现有审计
- 不新建第二套配置表
- 明确单位
- 旧订单 snapshot 不变

不要顺手实现人工余额调整/会费。

## 十一、原子性与一致性
完成订单时需要保证：

`Order completed`
+
`complaint snapshot/deadline`
+
`Earning frozen`

不会出现半写状态。

Mock 伪事务区段不得 await。

未来真实 DB 需要 transaction / unique constraints，但不在本轮选 DB/ORM。

逻辑唯一性至少保证：
`一个 order → 一条有效 Earning`

## 十二、测试
至少覆盖：
1. staff approve 后创建 frozen Earning；
2. System auto approve 后同样创建 frozen Earning；
3. 两条完成来源共用同一收益规则；
4. amount == Order.companionBaseIncome；
5. companionId == 完成时实际履约打手；
6. 同一订单不能重复 Earning；
7. complaint snapshot/deadline 在 completed 时冻结；
8. 修改 complaint config 不改变旧订单 deadline；
9. 新 completed 使用新配置；
10. deadline 前普通投诉允许；
11. deadline 后普通投诉关闭；
12. deadline 未到 Earning 不释放；
13. deadline 到且无阻塞 → available；
14. 有有效投诉/售后阻塞继续 frozen；
15. 阻塞解除后可释放；
16. repeated sweep 幂等；
17. availableAt 不重复刷新；
18. Companion 只能看到自己的收益；
19. 不泄露 clubNetIncome / 其他打手收益；
20. 金额保持整数分；
21. 优惠券不重新降低 companionBaseIncome；
22. 不出现固定 48h 的业务硬编码（除非只是当前配置 fixture 值且文档明确可配置）；
23. P0-8 completion_review / approve/reject 不回归；
24. 平台配置审计不回归。

## 十三、明确不做
不得实现：
- withdrawal
- 钱包完整账本
- 人工余额调整
- 会费批扣
- 部分退款冲正
- 已提现退款追偿
- 封禁回池
- 客服换人
- 特殊过期申诉
- 真 Scheduler
- DB / ORM

## 十四、Round Protocol
创建 `docs/03-dev/rounds/P0-9/` 五件档案，本 Prompt 原样归档到 `01-prompt.md`。

完成后停在 `AWAITING_ACCEPTANCE`。本轮是本批次最后一轮，不得自动开始 P0-10。

## 十五、门禁 / Reviewer
运行：
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production APP_BASE_URL 全量测试，fail=0 / skipped=0

Reviewer 重点：
- completed 两来源是否共用收益逻辑
- 订单经济快照是否被重算
- complaint config 是否 snapshot
- 是否写死 48h
- 一个 order 是否可能重复 Earning
- frozen→available 是否受阻塞正确控制
- 是否提前实现提现/复杂账本
- 是否伪事务中出现 await
- 是否泄露财务 DTO

BLOCKER/MAJOR 必须清零。

## 十六、Git与最终交付
禁止所有 Git 写。

记录本轮 delta，并输出整个 P0-6.1→P0-9 批次汇总：
- 每轮状态
- 每轮 delta
- 所有门禁
- reviewer 结论
- 未解决 MINOR/NOTE
- 统一人工验收清单
- `git status --short`

完成后停止，等待用户统一人工验收。
