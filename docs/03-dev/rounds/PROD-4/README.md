# PROD-4 · 真实业务闭环开发

Round ID: PROD-4
Title: 用户登录 → 商品浏览 → 创建订单 → 客服处理 → 管理员管理 最小真实闭环
Status: IN_PROGRESS
Depends On: PROD-3（全站巡检与部署）
Goal: 在私有 Staging 打通真实 PostgreSQL 支撑的用户/订单/客服/管理员闭环，公网保持匿名只读
Primary Domain: 认证 · 商品 · 订单 · 客服工作台 · 管理后台
Primary State Transition: 未支付订单待接单 → 客服接单 → 服务中 → 已完成 / 已取消
Started At: 2026-10-17
Development Completed At:
Accepted At:
Git Commit:
