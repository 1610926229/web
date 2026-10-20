# PROD-6 · 公网登录（客服 / 管理员 / 用户微信入口）

Round ID: PROD-6
Title: 公网 HTTPS 登录：客服与管理员密码登录、用户微信登录入口与公网边界重构
Status: IN_PROGRESS（代码 / 测试 / 私有 Staging 部署完成；公网 HTTPS 与客服口令待外部前置）
Depends On: PROD-4（真实认证与会话）· PROD-5（微信 OAuth 与身份绑定）· PROD-3（公网 Nginx 预览）
Goal: 让客服 / 管理员无需 SSH 隧道即可在公网 HTTPS 登录各自工作台；用户微信登录入口就绪；Mock 与危险接口不进入公网
Primary Domain: 公网访问边界 · 认证 · HTTPS
Primary State Transition: 无业务状态机变更
Started At: 2026-10-20
Development Completed At: 2026-10-20
Accepted At:
Git Commit: 2b06b77272ae5eed36388f5603c4e4ce94ad4ae1（实现与清单提交；部署 release `20261020T123422Z-2b06b77`）

## 文档

- `01-prompt.md`：原始任务与安全边界
- `02-decisions.md`：公网阻断审计、D1–D8 决策、最小实施步骤
- `03-delivery.md`：实现、测试、部署与模拟公网验收
- `04-acceptance.md`：私有自动验收结果、公网 HTTPS 人工验收清单、微信真实平台状态

## 当前状态

- ✅ 公网访问策略、CSRF、登录失败限流、Mock 隐藏、HTTPS 模板与安装器已完成并部署到私有 Staging。
- ✅ 模拟公网头验收通过：管理员登录 / 工作台 / 退出、429 限流、Mock 404、CSRF 403。
- ⛔ 真实公网 HTTPS **未开放**：缺域名 / DNS / 443 / root 授权；现有公网仍为 HTTP 匿名只读。
- ⚠️ `kefu-xiaoyu` 现有口令复验 401，账号未重置；需有效口令或新建测试账号。
- ⛔ 真实微信登录未配置（`realConfigured:false`），不标记为可用。

## 关键约束

- 真实密码不得在明文 HTTP 上传输；公网登录必须 HTTPS。
- 客服 / 管理员登录页公网可达；工作台与接口由服务端会话和角色守卫。
- 不使用开放全部 `/api/*` 的方式；Mock 登录、Mock 支付、调试接口一律拒绝。
- 用户微信登录仅准备入口；真实平台未配置时明确显示，不标记可用。
- 不修改 `chaoge_prod`、不重置 `chaoge_staging`、不开放 5432。
- Nginx / TLS / 域名变更需产品负责人批准。
