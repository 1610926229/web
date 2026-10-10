# 批次总控｜P0-10 → P0-11 → P0-12 → P0-13

## 批次目标
连续执行：
1. P0-10：客服全量订单查询
2. P0-11：客服换打手 + 打手禁用回池 + pending CompletionSubmission invalidated
3. P0-12：paid / accepted 用户免审批全额退款
4. P0-13：serving / completed 售后 + Admin 最终退款金额 + Earning 联动

目标：补齐剩余主要 P0 异常履约链。

## 执行顺序
严格 `P0-10 → P0-11 → P0-12 → P0-13`。进入每轮前完整读取对应 `cmd_*.md`，不得只凭 batch 摘要开发。

## Round 状态
正常：`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`。AI 不得自行 DONE。

P0-10/11/12 满足继续条件后自动进入下一轮，不等待用户逐轮验收。P0-13 完成或进入 CLARIFYING 后停止。

## 自动继续条件
必须全部满足：
- Requirement Check 无 OPEN
- targeted tests 通过
- full `pnpm test` fail=0
- typecheck/lint/build 全绿
- production HTTP fail=0 / skipped=0
- reviewer BLOCKER=0 / MAJOR=0
- 无无法解释外部工作区改动
- 下一轮前置真实存在

## 停止条件
任一即停：需求/技术设计冲突、产品或资金规则 TBD、门禁无法修绿、reviewer 仍有 BLOCKER/MAJOR、必须越过“不做”边界、工作区出现无法解释修改。

### P0-13 特别停止条件
若以下任一未冻结：
- completed partial refund 如何影响 Earning
- Earning 已 available 但未提现时如何处理退款

则 `P0-13 = CLARIFYING`，停止，不得自行假设。

## 累积工作区
每轮开始记录 HEAD/status/已有文件集合/前轮 delta；每轮结束精确记录本轮新增/修改文件及共享文件职责。不得把累计 diff 冒充本轮 delta。

## 架构硬约束
禁止第二套 Order、Refund、Notification、PlatformConfig、Auth、复杂 Assignment；Route 不堆主要业务；客户端不做权限/金额/退款真值；伪事务原子段无 await；不得擅自扩 OrderStatus。

## 历史语义
- cancel / ban / staff re-pool：清当前履约 binding，历史进 release record
- accepted direct refund：Order refunded，**保留 actualCompanionId**

不得为代码统一抹平。

## 测试策略
每轮 targeted → full test → typecheck → lint → build → production HTTP → reviewer → 修 BLOCKER/MAJOR → 完整复跑。

## Git
绝对禁止 add/commit/push/reset/restore/checkout/rebase/amend。

## 最终报告
输出：四轮状态表、每轮交付、异常链真实跑通情况、统一人工验收清单、遗留/CLARIFYING/MINOR/NOTE、HEAD/status/无 Git 写声明。

完成后停止，不得开始 P0-14。
