# PROD-7 · 正式生产环境隔离与上线方案

Round ID: PROD-7
Title: 正式生产环境隔离：独立应用 / 数据库 / 部署入口 / 资源评估 / Nginx 切换方案
Status: AWAITING_ACCEPTANCE
Depends On: PROD-2（私有 Staging 部署）· PROD-4（真实认证）· PROD-5（微信身份）· PROD-6（公网边界）
Goal: 在不触碰 `chaoge_prod`、不改变公网路由的前提下，给出可执行的生产环境隔离与首次上线方案，并把需要人工授权的最小清单固定下来
Primary Domain: 生产环境 · 数据库隔离 · 部署 · 公网切换
Primary State Transition: 无业务状态机变更
Started At: 2026-10-20
Development Completed At: 2026-10-20
Accepted At:
Git Commit:

## 文档

- `01-prompt.md`：本轮原始指令（逐字保存）
- `02-decisions.md`：需求核对、资源测量、生产架构、数据迁移、Nginx 切换与人工授权边界
- `03-delivery.md`：本轮已执行的 Staging 部署 / 测试 / 浏览器验收，以及未执行的生产操作
- `04-acceptance.md`：生产只读审计命令、人工验收清单、当前阻塞项

## 当前状态

- ✅ Staging 已部署安全修复版本 `20261020T132016Z-3768cb5`（Git SHA `3768cb5f5036e68ac7137a8d454ee0db594daf84`）。
- ✅ Mock 身份 Cookie 冒充、限流 IP 伪造、真实浏览器登录/退出、公网只读边界均已复验。
- ✅ 生产隔离方案、资源评估、首次初始化与数据迁移方案、Nginx 切换方案已写入 `02-decisions.md`。
- ⛔ `chaoge_prod` 只读审计**未能执行**：当前 `deploy` 账号没有 `/etc/chaoge`、`/var/backups/chaoge` 读取权限，没有数据库口令，`sudo -n` 仅允许 `chaoge-deploy`。需要人工以 root / `postgres` 执行 `04-acceptance.md` 的只读命令。
- ⛔ 未执行任何生产数据库初始化、写入、systemd/ sudoers / 目录安装或 Nginx 变更。

## 关键约束

- 不修改 `chaoge_prod`；不删除或重置 `chaoge_staging`。
- 生产首次初始化、数据迁移、部署入口安装、sudoers 变更、Nginx 与 443 开放均需人工批准。
- 生产四个 `ENABLE_MOCK_*` 全部关闭；Staging 继续保留 Mock 微信登录与模拟支付。
- Staging 与生产不共享数据库账号、连接口令或会话存储；会话令牌只在各自数据库内有效。
- 当前公网仍为匿名只读；不提前开放公网真实登录、Mock 支付或管理写接口。
