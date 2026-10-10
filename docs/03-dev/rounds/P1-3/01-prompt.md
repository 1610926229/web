Round: P1-3
Received At: 2026-09-29（夜间连续开发批次，用户指令：依次执行 cmd_p1-3 → cmd_p1-4 → cmd_p1-5，中途不等待人工回复）
Source: User（原文档案，未经加工）

> ⚠️ 本文件是**原始指令档案**，正文逐字来自 `docs/03-dev/rounds/cmd_p1-3.md`，
> 不做总结、不改写、不加工。

---

# P1-3｜管理员售后 / 投诉统一工作台

## 目标
聚合既有 RefundRequest / Complaint / Order / Staff 调查能力，做一个真正可用的 Admin 售后工作台。本轮不创造新的处置结论类型。

## 范围
- 统一入口 `/admin/aftersales`（如已有则复用）
- refund / complaint 混合列表
- open / processing / closed 视图
- order/displayId、用户、打手、日期筛选（现有数据支持时）
- 订单、退款、投诉、打手、调查历史聚合详情
- 复用已有 start-review / reject / approve / close 等动作
- loading / error / retry / empty / pagination

## Requirement Check
完整读取 docs/01-requirements、docs/02-tech-design、P0-13、P0-15、现有 admin refund/complaint 页面与 API、Staff conversations/release history。
如果权威需求未定义新的 resolution 枚举，不得发明。

## 核心约束
- open 集合必须复用现有唯一常量，不能复制第二套
- P0-15 规则保持：一单一退；approved refund 后打手本单收益归零；部分退款不强制 Order.status=refunded；full refund 才进入 refunded
- 聚合页不得复制事务逻辑，只调用既有 service
- DTO 最小化，不整包返回 Order/User/Companion 实体
- Admin only

## 测试
至少覆盖：
1. refund + complaint 混合聚合
2. open 数量
3. terminal 不进入 open
4. caseType 筛选
5. order/displayId 搜索
6. 用户/打手摘要
7. 一单一退不回归
8. partial/full refund 状态正确
9. approved refund 后 companion earning 摘要为 0
10. Staff 调查历史可达
11. DTO exact keys
12. 无敏感字段泄漏
13. 权限矩阵
14. loading/error/retry/empty
15. 既有 refund/complaint 页面不回归

## 不做
新 resolution 枚举、钱包/追偿、Scheduler、chat retention、真支付、真数据库。

## 门禁
targeted → pnpm test → typecheck → lint → build → production APP_BASE_URL → reviewer。
修完全部 BLOCKER/MAJOR 后完整复跑。

## Git
禁止任何 Git 写操作。

## 结束
P1-3 停在 AWAITING_ACCEPTANCE。
若被未冻结产品规则真正阻塞：标 BLOCKED、写明最小阻塞问题、不要猜，然后继续 P1-4。
