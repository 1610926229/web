# PROD-6 · 审计与决策

Round: PROD-6
Status: IN_PROGRESS（无业务规则 TBD；HTTPS/域名属外部前置）

---

## 一、公网阻断点审计

### 1. Nginx（第一层）

文件：`deploy/proxy/chaoge-public.conf` → 服务器 `/etc/nginx/sites-available/chaoge-public.conf`

- 只监听 80，`server_name _`；无 443、无证书、无域名。
- 白名单只有公开页面和 6 个只读 API；`location /api/ { return 404; }` 兜底。
- server 级 `proxy_set_header Cookie ""` 与 `Authorization ""`，所有公网请求无身份。
- 注入 `X-Chaoge-Public-Preview: 1`，应用据此进入只读模式。
- 通用限流 20r/s；没有登录专用限流。

### 2. Next.js（第二层）

- `proxy.ts`：带公网标记头的请求只允许 `GET/HEAD` 和 `isPublicPreviewPath()` 白名单；
  其余 404/405，并在转发前删除 Cookie / Authorization。
- `lib/config/publicPreview.ts`：白名单只有首页、分类、商品、陪玩、榜单、协议等公开页面与只读 API。
- `lib/auth/publicPreviewRequest.ts`：页面用它隐藏 Mock 控件。

### 3. 登录页 / API / 工作台

| 能力 | 位置 | 状态 |
|---|---|---|
| 客服登录页 | `app/staff/login/page.tsx` | 存在；真实认证开启时渲染登录名 + 密码 |
| 管理员登录页 | `app/admin/login/page.tsx` | 存在；真实认证开启时渲染登录名 + 密码 |
| 客服登录 API | `app/api/staff/auth/login/route.ts` | 查 PostgreSQL `staff_credentials`，scrypt 校验 |
| 管理员登录 API | `app/api/admin/auth/login/route.ts` | 查 PostgreSQL `admin_credentials`，scrypt 校验 |
| 客服工作台 | `app/staff/(console)/layout.tsx` | 服务端 `getStaffSession()`，无会话 307 `/staff/login` |
| 管理后台 | `app/admin/(console)/layout.tsx` | 服务端 `getAdminSession()`，无会话 307 `/admin/login` |
| 客服接口守卫 | `lib/api/staffRoute.ts` | 每个接口 `requireStaff()` |
| 管理接口守卫 | `lib/api/adminRoute.ts` | 每个接口 `requireAdmin()` |

结论：**能力已存在，缺的是公网访问策略与安全前置**，不是重新实现认证。

### 4. Session Cookie 与数据库

- `lib/auth/realSession.ts`：HttpOnly、SameSite=Lax、production Secure，Path=/，7 天。
- 数据库只存令牌 SHA-256，退出即吊销。
- 三端 Cookie 名不同、会话 kind 不同，互不通约。
- 公网与 SSH 隧道共用同一 Next 进程和 `chaoge_staging`；Mock 开关在 Staging 环境文件中仍开启。
- PostgreSQL 只监听 `127.0.0.1:5432`。

### 5. HTTPS / 域名

- 服务器 `ss -ltn`：仅 80、22、127.0.0.1:3000、127.0.0.1:5432。
- 无 certbot、无 `/etc/letsencrypt`、无 443。
- 主机名 `VM-0-13-ubuntu`，没有业务域名。
- 结论：公网真实密码登录**不能**在现有 HTTP 上开放；必须先完成域名 + TLS。

### 6. 既有客服账号 401 排查

只读查询管理端接口（管理员登录后）：

- `kefu-xiaoyu`：存在、启用中、未移除、角色客服；
- `lastLoginAt = 2026-10-18T15:33:17.405Z`，说明此前有过成功登录；
- 用 `.env.staging-e2e` 中的现有口令调用 `/api/staff/auth/login` 返回 401。

结论：账号本身正常，环境文件中的口令已过期/不一致。
**不重置该账号密码**；公网人工验收需由产品负责人提供当前有效口令。

---

## 二、决策

### D1 · 只扩展“公网可达路径”，不扩展权限模型

- 公网放行只到：公开只读页、客服登录页、管理员登录页、两端工作台及其 API、
  用户微信登录入口（`/mine`、`/wechat-login`、`/api/auth/wechat/*`）。
- 谁能做什么仍只由服务端会话 + `requireStaff()` / `requireAdmin()` / `requireUser()` 决定。
- 前端隐藏不构成权限；所有接口继续逐个守卫。

### D2 · 只读页面继续清 Cookie，登录/工作台路径保留 Cookie

- 公开只读页面沿用 `Cookie ""`，保持匿名预览。
- 登录、工作台、用户登录入口需要会话，Nginx 对这些 location 使用
  `proxy_set_header Cookie $http_cookie;`，应用层不再删除 Cookie。
- 两层仍按同一份策略判断，避免“Nginx 放行但应用拒绝”以外的第三种状态。

### D3 · 明确拒绝 Mock 与危险接口

即使路径位于已放行的前缀内，也一律拒绝：

- `/wechat-mock`、`/api/auth/wechat/mock/complete`
- `/api/auth/mock-login`、`/api/staff/auth/mock-login`、`/api/admin/auth/mock-login`
- `/api/payments/mock-confirm`
- `/api/debug/*`

Nginx 对上述路径再加显式 404，应用层同样拒绝（双层）。

### D4 · CSRF：公网非安全方法必须同源

- 公网请求的 POST/PATCH/PUT/DELETE 必须带 `Origin` 或 `Referer`，
  且其 host 与 `Host` / `X-Forwarded-Host` 一致；`Sec-Fetch-Site: cross-site` 直接拒绝。
- 登录、退出、工作台写操作全部覆盖。
- SameSite=Lax 继续保留，作为第二道。

### D5 · 登录限流：Nginx + 应用双层

- Nginx：登录 API 专用 `limit_req_zone`（10r/m，burst 5）。
- 应用：按 IP + 用户名哈希统计失败次数，15 分钟窗口；
  单身份 5 次、单 IP 20 次；成功即清零。
- 单实例内存实现；Staging 单进程满足。多实例部署前需改为共享存储，
  这一条写入已知限制。

### D6 · Cookie 与传输

- 继续使用 HttpOnly + SameSite=Lax + Secure（production）。
- 公网只允许 HTTPS；80 只做 301 与 ACME 验证，不代理登录/工作台。
- 不新增 Cookie 名、不改变现有会话表结构。

### D7 · 用户 / 打手微信登录

- 保留 PROD-5 真实 provider、回调与身份绑定代码。
- 公网放行 `/wechat-login`、`/api/auth/wechat/start|callback|status` 与 `/mine` 登录入口。
- 公网状态接口强制 `mockAvailable=false`；Mock 入口继续只在私有 Staging 可达。
- 没有真实 AppID / AppSecret / 授权域名 / HTTPS 时，页面明确显示“尚未配置”，
  不标记为可用。
- 用户端下单/支付/打手工作台等交易面**本轮不公网开放**；
  公网登录完成后先以“身份可建立”为交付，交易面另轮评估。

### D8 · 生产环境边界

- 本轮仍只改 Staging；不把 Staging 直接当正式生产。
- 数据库、SSH、安全组、sudoers 不动。
- HTTPS/Nginx root 变更需产品负责人批准；安装器与配置模板先在仓库内准备并测试。

---

## 三、最小实施步骤

### A. 代码（本轮自主完成）

1. `lib/config/publicAccess.ts`：公网路径/方法策略、Mock 拦截、同源校验。
2. `proxy.ts`：按路径决定清 Cookie / 保留 Cookie；CSRF 检查。
3. 登录限流模块与 staff/admin 登录路由接入。
4. 微信状态接口在公网隐藏 Mock 可用性。
5. 测试：策略矩阵、CSRF、限流、Nginx 模板静态检查。
6. `pnpm typecheck` / `lint` / `test` / `test:pg`。
7. 生成产物并通过 `chaoge-deploy` 部署 Staging；用模拟公网头做行为验证。

### B. Root / HTTPS（需产品负责人操作或授权）

1. 提供域名并配置 A 记录 → `43.128.13.181`；安全组放行 443。
2. 批准 root 安装 certbot + 签发证书。
3. 批准安装新的 Nginx TLS 配置（80 → 443、登录限流、白名单）。
4. 在无 SSH 隧道设备上完成公网 HTTPS 验收。

### C. 微信真实平台（外部依赖）

- 开放平台网站应用 AppID / AppSecret / 授权回调域名。
- 配置后单独联调；未配置时状态明确为“尚未配置”，不标记完成。
