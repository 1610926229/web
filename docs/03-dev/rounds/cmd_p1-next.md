# P1-NEXT｜审计后自动选择最多两个安全 P1 功能

Status: PLANNED

## 前置
必须先完成 `AUDIT-122`。

## 授权
从权威需求原有 P1 backlog 中，最多选择两个下一功能：
- 第一个编号 P1-7
- 第二个编号 P1-8

## 候选必须同时满足
1. 已存在于需求文档 / 功能点进度表
2. 当前是 PARTIAL 或 NOT_IMPLEMENTED
3. 产品规则已经冻结
4. 没有 `TBD — DO NOT INVENT`
5. 不依赖微信 OAuth / 真实微信支付 / 真数据库 / 外部 Scheduler / 钱包 / 提现 / 负余额
6. 不需要用户现在回答问题
7. 不与 DONE 功能重复
8. 能独立人工验收

优先沿用现有需求顺序，不为了“好做”重排 Roadmap。

## P1-7
选中后建立标准 Round 档案：
- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

Requirement Check 后：
- 有产品 TBD → BLOCKED，不猜，继续 P1-8
- 无 TBD → 开发 + 完整门禁 → AWAITING_ACCEPTANCE

## P1-8
规则同 P1-7。

如果没有第二个安全候选：
`P1-8 NOT STARTED — no safe frozen candidate`

不得为了凑数量开发 P2 或生产功能。

## Git
禁止 Git 写操作。
