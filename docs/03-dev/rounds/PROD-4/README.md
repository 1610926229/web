# PROD-4 · 真实业务闭环开发

Round ID: PROD-4
Title: 用户登录 → 商品浏览 → 创建订单 → 客服处理 → 管理员管理 最小真实闭环
Status: AWAITING_ACCEPTANCE
Depends On: PROD-3（全站巡检与部署）
Goal: 在私有 Staging 打通真实 PostgreSQL 支撑的用户/订单/客服/管理员闭环，公网保持匿名只读
Primary Domain: 认证 · 商品 · 订单 · 客服工作台 · 管理后台
Primary State Transition: 待支付请求 → paid → 客服指派接单 → accepted（后续 serving/completed/refunded 沿用既有流程）
Started At: 2026-10-17
Development Completed At: 2026-10-18
Accepted At:
Git Commit: 909cfaba070bb46e7fa717311b06942be67b6337

## 已部署

- Release `20261018T131303Z-909cfab`
- 迁移 0017 已应用；`chaoge_prod` 未触碰，`chaoge_staging` 未重置
- 公网 `http://43.128.13.181` 仍为匿名只读；真实登录/注册/下单/支付/后台接口未开放

## 文档

- `01-prompt.md`：任务与安全边界
- `02-decisions.md`：阶段 1 审计、D1–D6 决策
- `03-delivery.md`：实现、测试、部署、真实浏览器验收、公网边界证据
- `04-acceptance.md`：人工验收清单（PENDING）
- `evidence/`：18 张真实浏览器验收截图

## 下一门槛

1. 产品负责人按 `04-acceptance.md` 在私有 Staging 人工验收；
2. 验收通过后由用户提交 Git，Round 状态改为 DONE；
3. 公网开放真实登录/下单需另行提交最小开放方案并获批（限流、CSRF、HTTPS、
   邮箱验证等前置条件见 `03-delivery.md`「Known Limitations」）。
