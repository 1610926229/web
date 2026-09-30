# P1-6｜Admin Coupon Template Management

Status: PLANNED

## 目标
补齐 P1-4 已登记的独立缺口：管理员优惠券模板管理。

只管理当前真正参与 checkout 的 `threshold` 满减券，不重新设计营销系统。

## Requirement Check
开工前读取并以其为准：
- `docs/01-requirements/**`
- `docs/02-tech-design/**`
- `docs/03-dev/rounds/P1-4/**`
- 当前 Coupon / CouponClaim / checkout / Admin grant 实现
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`

若与本文件冲突，以用户在 P1-4 已确认的规则为准，并写入 `02-decisions.md`。

## 已冻结规则
### 1. 管理对象
P1-6 只允许 Admin 新建/编辑 `formKey = "threshold"` 满减券。
`discount` / `gift` 可展示历史模板，但不得新建其计算规则，也不得接入 checkout。

### 2. 字段
至少：
- name
- thresholdAmount
- discountAmount
- validFrom
- validTo
- enabled

金额全部整数分。

校验：
- thresholdAmount > 0
- discountAmount > 0
- discountAmount <= thresholdAmount
- validTo > validFrom

非法输入服务端拒绝，不夹取、不自动修正。

### 3. 文案
`valueLabel` / `conditionLabel` 不作为业务真值。
应根据 thresholdAmount / discountAmount 统一派生或由服务端规范生成。

### 4. 历史快照
编辑 Template：
- 不追溯已有 CouponClaim snapshot；
- 不追溯历史 Order coupon snapshot；
- 不改变历史 actualPaidAmount；
- 不改变历史 couponDiscountAmount。

### 5. enabled
Claim snapshot 决定“这张券是什么”。
当前 `Coupon.enabled` 决定“平台现在是否允许核销”。

因此：
- disable 不删除 Claim；
- disable 不改历史订单；
- disable 后 checkout 禁止使用；
- re-enable 后，若 Claim 仍 unused / 未过期 / 满足门槛，可再次使用。

### 6. 不硬删除
本轮不提供 hard delete。
停用使用 `enabled=false`。

### 7. Admin grant
与 P1-4 已有指定用户发券联动：
- disabled Template 不允许发；
- enabled threshold Template 可发；
- grant 时 snapshot 当前 Template；
- 后改模板不追溯已发 Claim。

## Admin 页面
优先复用现有 Admin CRUD 风格：
- `/admin/coupons`
- `/admin/coupons/new`
- `/admin/coupons/[id]`

至少支持：
- 列表
- 新建
- 编辑
- 启用 / 停用
- 查看满减门槛、优惠金额、有效期、状态

## 权限
写操作 Admin only，不得只靠 UI 隐藏。

## Audit
若已有 AdminAudit：
- create
- update
- enable
- disable
复用现有体系，不新建第二套日志。

## 最低测试
覆盖：
1. list
2. create threshold
3. edit
4. enable / disable
5. disabled Claim checkout 不可用
6. re-enable 后合法 Claim 可用
7. edit 不追溯 Claim snapshot
8. edit 不追溯 Order snapshot
9. disabled Template 不允许 Admin grant
10. grant snapshot 正确
11. 金额 / 日期非法输入
12. label 与数值一致
13. 不允许新建 discount/gift
14. legacy discount/gift 不误进 checkout
15. DTO exact keys
16. 权限矩阵
17. AdminAudit
18. P1-4 checkout/refund/return coupon 回归

## 门禁
targeted → pnpm test → typecheck → lint → build → production APP_BASE_URL → reviewer

修完 BLOCKER / MAJOR。

## Git
禁止 Git 写操作。

## 结束
完成后：`P1-6 = AWAITING_ACCEPTANCE`
不得自行 DONE。
