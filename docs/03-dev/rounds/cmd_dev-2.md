# DEV-2｜HTTP / Production Test Isolation Stabilization

Status: PLANNED

## 目标
解决 production full test 偶发文件级失败、共享 Mock store 互相污染的问题。

这是测试基础设施整改，不改变业务规则。

## 已知现象
历史上 production 全量曾偶发：
- `staffRefunds.test.mjs`
- `adminCategories.test.mjs`

isolated rerun 又全绿。HTTP tests 会真实修改共享 Mock store。

## 原则
先取证，再修改。

不得为了变绿：
- 删断言
- skip
- retry-until-green
- 单纯放大 timeout
- 改业务规则

优先方案：
- suite/file 独立 reset seed
- 独立 namespace/store
- 对真正共享状态的 HTTP tests 串行
- 测试环境专用 reset 能力
- 其它符合现有架构的最小隔离方案

## 要求
明确记录：
1. 共享写入点
2. 为什么会互相污染
3. 旧隔离机制
4. 新隔离机制
5. 为什么不改变业务行为

## 验证
至少：
- production full test 连续 5 次
- 每次 fail = 0
- 每次 skipped = 0

若旧失败无法稳定复现，也必须基于明确共享状态证据做隔离修正，不能声称问题不存在。

## 门禁
targeted → pnpm test → typecheck → lint → build → production full × 5 → reviewer

## Git
禁止 Git 写操作。

## 结束
完成后停在工程验收状态，等待人工确认。
