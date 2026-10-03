Round ID: P1-6
Title: Admin Coupon Template Management（管理端优惠券模板管理）
Status: DONE   # ✅ 2026-09-30 开发完成 + 门禁走完（targeted → pnpm test → typecheck → lint → build → production APP_BASE_URL ×13 → reviewer，未闭合 BLOCKER/MAJOR = 0）。⚠️ production 共 13 次里 **12 次全绿、1 次抖动**（1780 tests / fail 1，**不在本轮的用例里**）——那是 `DEV-2` 的取证材料，不是 P1-6 的回归，详见 `03-delivery.md` §2.2 / §2.3。✅ **DONE 双门槛均已满足**：① 用户本人「`P1-6 人工验收完成 / PASSED`」；② 用户本人提交 `138dc5b`。见 `04-acceptance.md` §四
Depends On:
- P1-4（优惠券交易链路与结算口径校准）——本轮补齐的就是 P1-4 `04-acceptance.md` §八 8.3 登记的**独立缺口**
- P0-15（退款与收益归零）
- P0-13（管理员退款裁定）
Goal: 为管理员提供优惠券**模板**的列表 / 新建 / 编辑 / 启用停用入口；管理对象只有 `formKey = "threshold"` 满减券；**不是重做营销系统**，不新建第二套审计，不改结算公式
Primary Domain: 管理端优惠券模板（`Coupon` 写入侧）
Primary State Transition: 无（只有字段写入与 `enabled` 两态切换；**不存在终态**，§6 不提供硬删除）
Started At: 2026-09-30
Development Completed At: 2026-09-30
Accepted At: 2026-09-30
Git Commit: 138dc5b  # `p1-6，1-7，1-8`（作者/提交者 1610926229）。只读核验：`git show --name-only` 确认含本轮全部 6 个归档文件
