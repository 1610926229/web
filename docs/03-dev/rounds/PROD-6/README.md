# PROD-6 · 公网登录（客服 / 管理员 / 用户微信入口）

Round ID: PROD-6
Title: 公网 HTTPS 登录：客服与管理员密码登录、用户微信登录入口与公网边界重构
Status: IN_PROGRESS
Depends On: PROD-4（真实认证与会话）· PROD-5（微信 OAuth 与身份绑定）· PROD-3（公网 Nginx 预览）
Goal: 让客服 / 管理员无需 SSH 隧道即可在公网 HTTPS 登录各自工作台；用户微信登录入口就绪；Mock 与危险接口不进入公网
Primary Domain: 公网访问边界 · 认证 · HTTPS
Primary State Transition: 无业务状态机变更
Started At: 2026-10-20
Development Completed At:
Accepted At:
Git Commit:

## 文档

- `01-prompt.md`：原始任务与安全边界
- `02-decisions.md`：公网阻断审计、D1–D8 决策、最小实施步骤
- `03-delivery.md`：实现、测试、部署（完成后产出）
- `04-acceptance.md`：公网与私有验收记录（完成后产出）

## 关键约束

- 真实密码不得在明文 HTTP 上传输；公网登录必须 HTTPS。
- 客服 / 管理员登录页公网可达；工作台与接口由服务端会话和角色守卫。
- 不使用开放全部 `/api/*` 的方式；Mock 登录、Mock 支付、调试接口一律拒绝。
- 用户微信登录仅准备入口；真实平台未配置时明确显示，不标记可用。
- 不修改 `chaoge_prod`、不重置 `chaoge_staging`、不开放 5432。
- Nginx / TLS / 域名变更需产品负责人批准。
