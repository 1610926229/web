# PROD-6 · 交付记录

**Status:** 代码、测试与私有 Staging 部署完成；真实公网 HTTPS **未开放**（等待域名 / DNS / 443 / root 授权）；真实微信登录未配置
**Round:** PROD-6 · 公网 HTTPS 登录：客服 / 管理员密码登录、用户微信登录入口与公网边界重构
**Release:** `20261020T123422Z-2b06b77`
**App Git SHA:** `2b06b77272ae5eed36388f5603c4e4ce94ad4ae1`
**Artifact SHA-256:** `12c704607fc83d82f664050a0b767a34f99886076477985f978380769e2bc57c`
**Database:** `chaoge_staging`（未新增迁移；仍为 18 个迁移 / 46 张表）；`chaoge_prod` 未触碰
**Public boundary:** 现有 `http://43.128.13.181` 仍是匿名只读；443 未开放；登录 / 工作台 / 后台接口尚未通过公网 Nginx 暴露

---

## 一、交付范围

本轮把「登录能力已经存在，但只能在 SSH 隧道里使用」推进到「公网入口与安全前置就绪」：

1. 公网放行客服登录页、管理员登录页、两端工作台页面与其 API；
2. 公网放行用户微信登录入口（`/mine`、`/wechat-login`、`/api/auth/wechat/*`）与用户会话 API；
3. Mock 登录、Mock 支付、调试接口即使落在已放行前缀内也一律拒绝；
4. 公网非安全方法强制同源校验（Origin / Referer），并由 SameSite=Lax 兜底；
5. 登录失败按「身份 + IP」双维度限流，超限返回 429 与 `Retry-After`；
6. 客服 / 管理员登录页、工作台、接口继续由服务端会话与 `requireStaff` / `requireAdmin` 鉴权；
7. 准备 root 级 HTTPS 安装器、Nginx 模板与回滚脚本，**不自动执行**。

## 二、实现

### 1. 公网访问策略（应用层）

新增 `lib/config/publicAccess.ts`，作为公网可达性的唯一策略：

| 类别 | 路径 | 方法 |
|---|---|---|
| 登录页 / 工作台 | `/staff/login`、`/admin/login`、`/staff/**`、`/admin/**` | GET / HEAD |
| 用户登录入口 | `/mine`、`/wechat-login` | GET / HEAD |
| 登录 / 退出 API | `/api/staff/auth/login|logout`、`/api/admin/auth/login|logout`、`/api/auth/logout` | POST |
| 用户会话 / OAuth | `/api/me`、`/api/auth/wechat/{status,start,callback}` | GET / HEAD |
| 客服 / 管理 API | `/api/staff/**`、`/api/admin/**` | 标准读写方法（无 OPTIONS / TRACE） |
| 原只读预览 | `publicPreview.ts` 既有白名单 | GET / HEAD |

拒绝列表优先于放行列表：

- `/wechat-mock`
- `/api/auth/mock-login`
- `/api/auth/wechat/mock/complete`
- `/api/staff/auth/mock-login`
- `/api/admin/auth/mock-login`
- `/api/payments/mock-confirm`
- `/api/debug/**`

`proxy.ts` 的判定顺序：公网标记头 → 路径 → 方法 → 同源 → 按路径决定是否清 Cookie → 放行。
只读预览仍清空 `Cookie` / `Authorization`；登录页、工作台与用户登录入口保留 Cookie。

### 2. CSRF

`isSameOriginPublicRequest()` 对公网非安全方法要求：

- `Origin`（缺失时回退 `Referer`）必须是合法 URL；
- host 必须等于 `X-Forwarded-Host`（优先）或 `Host`；
- 若存在 `X-Forwarded-Proto`，协议也必须一致；
- `Sec-Fetch-Site: cross-site`、`Origin: null`、缺少 Host 一律拒绝。

### 3. 登录失败限流

新增 `lib/auth/loginRateLimit.ts` 与 `lib/auth/publicLoginGuard.ts`：

- 窗口 15 分钟；
- 同一身份（登录名 SHA-256）最多 5 次失败；
- 同一 IP 最多 20 次失败；
- 成功登录只清除该身份的失败计数，不清 IP；
- 超限抛 `TOO_MANY_REQUESTS`（429），并设置 `Retry-After`；
- 只在公网请求上生效，SSH 隧道 / 本地测试不受影响；
- 内存实现，单实例；多实例部署前需改为共享存储。

登录路由先查额度，再校验密码；数据库异常不计入失败次数。

### 4. 公网界面收敛

- `RequireAuth` / `LoginGate`：公网未登录用户只看到微信入口，不再看到邮箱密码、注册或 Mock 选择器；
- 微信状态接口：公网请求强制 `mockAvailable: false`，`realConfigured` 照实返回；
- 底部导航与首页快捷入口：`/mine` 保留为登录入口，订单、客服、结算等交易面继续改写到「暂不可用」占位页。

### 5. HTTPS 前置（待授权执行）

- `deploy/proxy/chaoge-public-https.conf.template`：80 只做 ACME + 301；443 做 TLS、HSTS、安全头、登录限流、Mock/调试 404、路径白名单；
- `deploy/proxy/chaoge-proxy-public.inc`：只读路径清 Cookie；
- `deploy/proxy/chaoge-proxy-session.inc`：登录 / 工作台保留 Cookie；
- `deploy/proxy/install-public-https.sh`：安装 certbot、签发证书、备份旧配置、`nginx -t`、失败回滚、本机探针；
- `deploy/proxy/rollback-public-https.sh`：恢复最近一次 `.pre-https.*` 备份。

X-Forwarded-For 使用 `$remote_addr` **覆盖**，避免客户端伪造首段绕过应用层 IP 限流。

## 三、测试与验收

### 1. 代码门禁

| 项目 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | **2450 tests / 1984 pass / 466 skipped / 0 fail** |
| `pnpm test:pg` | 本轮无迁移与数据写入，未重复执行；部署脚本内的数据库隔离验收 PASS |

466 个 skipped 均为需要 `APP_BASE_URL` / `DATA_SOURCE=postgres` 运行服务的环境门禁，与 PROD-6 改动无关。

新增测试：

- `tests/publicAccess.test.mjs`：路径 / 方法矩阵、Mock 拦截优先级、Cookie 清空范围、CSRF、客户端 IP、限流双维度、界面与路由接线；
- `tests/publicHttps.test.mjs`：模板 / 安装器 / 回滚脚本静态断言，以及本机有 nginx 时的真实 `nginx -t`（无 nginx 时跳过）。

### 2. 私有 Staging 模拟公网验收

通过 SSH 隧道向 Staging 进程发送 `X-Chaoge-Public-Preview: 1`（与 Nginx 注入的头一致）：

| 检查 | 结果 |
|---|---|
| `GET /staff/login`、`/admin/login` | 200 |
| `GET /staff`、`/staff/orders` | 307 → `/staff/login` |
| `GET /admin` | 307 → `/admin/login` |
| `GET /api/staff/orders`、`/api/admin/dashboard`、`/api/me` | 401 |
| `GET /mine`、`/wechat-login` | 200 |
| `GET /api/home` | 200 |
| `/wechat-mock`、`/api/auth/mock-login`、`/api/staff/auth/mock-login`、`/api/admin/auth/mock-login`、`/api/payments/mock-confirm`、`/api/debug/reset` | 404 |
| `/orders`、`/checkout`、`/api/orders` | 404 |
| `POST /api/staff/auth/login` 无 Origin / 错误 Origin | 403 |
| `POST /api/staff/auth/login` 同源 Origin | 401（错误口令） |
| 连续 5 次错误后第 6 次 | **429，`Retry-After: 900`** |
| 管理员真实账号登录 | **200** |
| 带管理员会话访问 `/api/admin/dashboard` | **200** |
| 管理员退出后再访问 | **401** |
| 公网 `/api/auth/wechat/status` | `{"realConfigured":false,"mockAvailable":false}` |
| 私有 `/api/auth/wechat/status` | `{"realConfigured":false,"mockAvailable":true}` |

### 3. 跨端会话隔离

在 Staging 进程内用私有 Mock 客服登录（`ENABLE_MOCK_STAFF`）取得客服会话：

| 请求 | 结果 |
|---|---|
| `POST /api/staff/auth/mock-login`（`staff-1`） | 200 |
| 客服会话 → `GET /api/staff/orders` | 200 |
| 客服会话 → `GET /api/admin/dashboard` | **401** |
| 客服会话 → `GET /api/me` | **401** |

即：客服会话只能进入客服端，不能换成管理员或普通用户身份。
真实客服口令登录仍受 `kefu-xiaoyu` 口令不一致影响（见 §五）。

### 4. Nginx 模板验证

在服务器 `/tmp` 下使用自签证书、非特权端口（18080 / 18443）运行真实 `nginx -t`：

- `syntax is ok`
- `test is successful`

未修改系统 Nginx、未 reload、未写 `/etc/nginx`、未安装 certbot。

### 5. 现有公网边界

从开发机直接访问 `http://43.128.13.181`：

| 路径 | 状态 |
|---|---|
| `/`、`/api/home` | 200 |
| `/staff/login`、`/admin/login` | 404 |
| `/api/staff/orders`、`/api/admin/dashboard` | 404 |
| `/api/auth/wechat/status` | 404 |
| `/wechat-mock`、`/api/auth/mock-login` | 404 |
| `https://43.128.13.181/` | 连接失败（443 未开放） |

即：**在 HTTPS 安装获得授权前，公网仍保持匿名只读，登录能力没有提前暴露。**

## 四、部署记录

- 受控入口：`sudo -n /usr/local/sbin/chaoge-deploy deploy <artifact> <sha256> <git-sha>`
- 产物：`staging-standalone-2b06b77272ae5eed36388f5603c4e4ce94ad4ae1.tar.gz`（6.7 MB）
- 版本目录：`/opt/chaoge-staging/releases/20261020T123422Z-2b06b77`
- 上一版本：`20261018T175352Z-7fdf185`
- 服务：`enabled` / `active`，仅监听 `127.0.0.1:3000`
- 数据库隔离验收：OVERALL PASS
- `chaoge_prod` 未读取、未写入；`chaoge_staging` 未删除、未重置、未清空

## 五、已知限制

1. **公网 HTTPS 尚未安装**：缺域名、A 记录、443 安全组与 root 授权；当前公网仍是 HTTP 匿名只读。
2. **客服账号口令不一致**：`.env.staging-e2e` 中的 `kefu-xiaoyu` 口令返回 401；账号存在且启用，未重置。公网人工验收需产品负责人提供当前有效口令，或由管理员新建一个客服账号。
3. **限流是单实例内存实现**：Staging 单进程有效；多实例前必须迁移到共享存储（Redis / 数据库）。
4. **真实微信登录未配置**：`realConfigured:false`；未取得开放平台网站应用资质与三项配置前，不标记为可用。
5. **交易面不公网开放**：本轮只交付「身份可建立」；下单、支付、打手工作台等仍为私有 Staging 能力。

## 六、下一步（需产品负责人）

1. 提供一个域名并配置 A 记录 → `43.128.13.181`；
2. 在云安全组放行 443（80 已可用；不要开放 3000 / 5432）；
3. 批准 root 执行 certbot 安装与新的 Nginx 站点配置；
4. 安装后在**无 SSH 隧道的普通设备**上完成 `04-acceptance.md` 的 B 节；
5. 提供有效客服口令或批准新建测试客服账号，完成客服端人工验收。
