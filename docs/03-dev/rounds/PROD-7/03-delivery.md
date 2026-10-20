# 03 · 交付记录

Round: PROD-7
Date: 2026-10-20
Status: Staging 安全修复部署与验收完成；生产方案已准备；生产只读审计被权限阻塞；未执行任何生产写入

---

## 一、Staging 部署

### 1.1 SHA 核对

| 项目 | 值 |
|---|---|
| 本地分支 | `feat/order-lifecycle-alignment` |
| 本地 HEAD | `3768cb5f5036e68ac7137a8d454ee0db594daf84` |
| GitHub 远端同名分支 | 同一 SHA `3768cb5…` |
| 部署前服务器版本 | `20261020T123422Z-2b06b77`（`2b06b77272ae5eed36388f5603c4e4ce94ad4ae1`） |

### 1.2 构建方式（需明确披露）

本机没有 `gh` CLI，也没有 `GITHUB_TOKEN`，无法触发 GitHub Actions 的 `workflow_dispatch`。因此使用**与 CI 相同的构建脚本**在本地构建：

```bash
EXPECTED_SHA=3768cb5… deploy/app/build-standalone.sh
```

产物：

| 项目 | 值 |
|---|---|
| 文件 | `staging-standalone-3768cb5f5036e68ac7137a8d454ee0db594daf84.tar.gz` |
| 大小 | 6.7 MB |
| SHA-256 | `648729c9fd78ff82c2a2d3724e6f4ff0b616dd175d01fe737a654829644701c4` |
| BUILD_INFO | `sha=3768cb5…` / `built_at=2026-10-20T13:17:32Z` / node v24.15.0 / pnpm 12.3.4 |

**没有绕过 CI**：产物仍经受控入口独立校验 SHA-256、Git SHA、结构与文件权限；但「产物来自 GitHub Actions」这一点本轮不成立，需在报告中明确。

### 1.3 root 信任清单检查

`2b06b77..3768cb5` 之间：

- `deploy/**` **无改动**；
- `db/migrations/**` **无改动**；
- 只有 `lib/auth/**`、`proxy.ts`、测试与文档变化，因此 `deploy/trust/migration-code.sha256` 随源码更新，但**不需要更新 root 拥有的迁移快照**。

结论：本次正常部署允许，无需新的 root 授权，未绕过任何信任边界。

### 1.4 部署结果

| 项目 | 值 |
|---|---|
| 入口 | `sudo -n /usr/local/sbin/chaoge-deploy deploy …` |
| 新 release | **`20261020T132016Z-3768cb5`** |
| 上一版本 | `20261020T123422Z-2b06b77` |
| 状态 | `enabled` / `active` |
| 监听 | 仅 `127.0.0.1:3000` |
| 数据库隔离验收 | **OVERALL PASS**（18 个迁移 / 46 张表） |
| `chaoge_staging` | 未删除、未重置、未清空 |
| `chaoge_prod` | 未读取、未写入 |

---

## 二、回归测试

| 项目 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | **2454 tests / 1988 pass / 466 skipped / 0 fail** |

466 skipped 仍为需要 `APP_BASE_URL` / PostgreSQL 运行环境的门禁，与本轮改动无关。`pnpm test:pg` 本轮未重复执行；部署入口内的数据库隔离验收 PASS。

---

## 三、安全修复验证

### 3.1 伪造 Mock 身份 Cookie

请求携带公网标记头 `X-Chaoge-Public-Preview: 1`，模拟公网路径：

| 请求 | 伪造 Cookie | 结果 |
|---|---|---|
| `GET /api/admin/dashboard` | `mock_admin_id=admin-1` | **401** |
| `GET /admin` | `mock_admin_id=admin-1` | **307 → /admin/login** |
| `GET /api/staff/orders` | `mock_staff_id=staff-1` | **401** |
| `GET /staff/orders` | `mock_staff_id=staff-1` | **307 → /staff/login** |
| `GET /api/me` | `mock_user_id=u-1001` | **401** |

私有请求（无标记头）对照：三个接口均为 **200**，说明 Staging 的 Mock 能力未被误伤，拒绝只发生在公网路径。

### 3.2 登录限流 IP

| 场景 | 结果 |
|---|---|
| A. 经模拟可信代理（覆盖 `X-Real-IP` / `X-Forwarded-For` 为真实对端） | 连续 20 次错误口令均 401；第 21 次 **429，`Retry-After: 900`** |
| B. 直接请求，轮换伪造的 XFF 第一段、固定最后一段 | 20 次 401；第 21 次 **429**（应用取最后一段，第一段无效） |
| C. 同一登录名轮换 `X-Real-IP` | 5 次 401；第 6 次 **429**（身份维度独立生效） |

测试代理仅监听临时回环端口，模拟 Nginx 的 `proxy_set_header X-Real-IP $remote_addr` / 覆盖 XFF；测试结束后已停止并删除。**未修改系统 Nginx。**

### 3.3 真实浏览器验收（Edge，headless）

用 `playwright-core@1.51.1` + 本机 Edge 通过 SSH 隧道 `127.0.0.1:3101 → Staging:3000` 执行，结果 **25/25 PASS**：

- 伪造 `mock_admin_id` / `mock_staff_id` / `mock_user_id` 的浏览器上下文：管理端/客服端页面均跳登录页，三个 API 均 401；浏览器确实发送了这些 Cookie（被服务端剥离/忽略）。
- 公网 `/`、`/mine` 200；`/wechat-mock`、`/api/auth/mock-login` 404；微信状态 `mockAvailable:false`、`realConfigured:false`。
- 管理员真实账号在浏览器表单登录 → 进入 `/admin`；`/api/admin/dashboard` 200。
- 会话 Cookie 属性：`HttpOnly`、`SameSite=Lax`、`Secure`、`Path=/`。
- 通过页面「退出」按钮退出 → 回到 `/admin/login`；再访问管理接口 401。
- 客服登录页 200、密码表单渲染；**未做客服登录**，因为 `.env.staging-e2e` 中 `kefu-xiaoyu` 口令仍为 401（账号未重置）。

截图保存在本机临时目录 `C:\Users\16109\AppData\Local\Temp\chaoge-browser\screenshots\`（未提交仓库）。

---

## 四、公网只读边界

从开发机访问 `http://43.128.13.181`：

| 路径 | 状态 |
|---|---|
| `/`、`/api/home`、`/category` | 200 |
| `/staff/login`、`/admin/login` | 404 |
| `/api/staff/orders`、`/api/admin/dashboard`、`/api/me` | 404 |
| `/api/auth/wechat/status` | 404 |
| `/wechat-mock`、`/api/auth/mock-login`、`/api/debug/reset` | 404 |
| `/orders`、`/checkout`、`/api/orders` | 404 |

响应带 `X-Chaoge-Public-Proxy: 1`，确认经过 chaoge 站点。

### 端口探测说明

服务器 `ss -ltn` 确认：应用仅 `127.0.0.1:3000`，PostgreSQL 仅 `127.0.0.1/[::1]:5432`，Nginx 监听 `:80`；无 443。

开发机的原始端口探测**不可信**：本机网络对任意端口（3306 / 6379 / 12345 / 23456）都能瞬间完成 TCP 握手，明显是本地拦截/伪造。因此：

- 以服务器监听地址与公网 HTTP 响应作为本轮证据；
- **云安全组是否放行 3000 / 5432 仍需在腾讯云控制台人工复核**（见 `04-acceptance.md` §B）；
- 本轮未修改任何防火墙/安全组。

---

## 五、生产方案

见 `02-decisions.md`。要点：

- 同机双应用（Staging `:3000` / 生产 `:3001`），首期不购买新服务器；
- 独立 `chaoge-prod` 用户、目录、systemd、env、部署入口与 sudoers；
- 生产库 `chaoge_prod` + `chaoge_migrator` / `chaoge_app`，与 Staging 角色/口令完全独立；
- 四个 `ENABLE_MOCK_*` 全关，`ENABLE_MOCK_DEBUG` 不设置；
- 首次初始化只迁移审核后的目录/内容，不迁移用户/订单等演示数据；
- Nginx 未来把 upstream 指向 `127.0.0.1:3001`，当前不改路由。

---

## 六、未执行 / 被阻塞

| 项目 | 状态 | 原因 |
|---|---|---|
| `chaoge_prod` 只读审计 | **未执行** | `deploy` 无 `/etc/chaoge` / 备份目录权限，无数据库口令，`sudo -n` 仅允许 `chaoge-deploy` |
| 生产数据库初始化 / 写入 | 未执行 | 需人工批准 |
| 生产应用/systemd/目录/部署入口/sudoers | 未执行 | 需 root 授权 |
| Nginx / TLS / 443 / 公网路由 | 未修改 | 域名未就绪；需人工批准 |
| 真实微信登录 / 真实支付 | 未配置 | 凭据未提供；按计划暂缓 |
| 客服真实登录验收 | 未完成 | `kefu-xiaoyu` 口令 401，未重置账号 |

---

## 七、工作树

本轮未修改 `docs/03-dev/rounds/PROD-1E/**` 与 `docs/03-dev/总需求进度表.md` 的既有未提交改动；未提交部署 bundle、密钥或敏感配置。新增/更新的 Round 文档见 `PROD-6/` 与 `PROD-7/`。
