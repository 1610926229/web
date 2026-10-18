# PROD-5 · 决策与阶段 A 审计

Round: PROD-5
Status: DECIDED（无 OPEN 决策，可进入编码）

---

## 一、阶段 A 审计结论

审计范围：`lib/auth/*`、`lib/data/pg/authRepository.ts`、`db/migrations/0010–0017`、
`lib/services/realUserAuth.ts` / `staffAuth.ts` / `adminAuth.ts`、
`app/api/auth/*`、`app/api/staff/auth/*`、`app/api/admin/auth/*`、
`app/companion/(console)/layout.tsx`、`lib/services/companionAccess.ts`、
`lib/services/checkout.ts` / `confirmPaymentRequest`、`lib/config/publicPreview.ts`、
`deploy/proxy/chaoge-public.conf`、`deploy/entry/chaoge-deploy.sh`。

图例：**可用** = 页面 + 接口 + 服务端规则 + PostgreSQL 实现齐全；
**部分可用** = 有真实实现但缺关键前置/闭环；**未实现** = 只有界面或只有 Mock。

| 能力 | 结论 | 证据 / 复用点 |
|---|---|---|
| 用户真实注册 / 登录 / 退出 | **可用** | `POST /api/auth/{register,login,logout}`；邮箱 scrypt 凭据、`auth_sessions`、`chaoge_user_session` |
| 用户会话校验 | **可用** | `lookupRealSession("user")` → `auth_sessions` → `users`；真实 Cookie 失效不回退 Mock |
| 客服 / 管理员密码登录 | **可用** | 独立 Cookie / 独立会话 kind / 独立 Guard；本轮**不改** |
| 四端权限隔离 | **可用** | `requireUser` / `requireStaff` / `requireAdmin` / `requireCompanion`；身份 cookie 域不相交 |
| 打手身份 | **可用（派生）** | 打手没有第二套账号：`resolveCompanionAccess(user.id)` 查 `companions.user_id` |
| 打手入驻 / 审核 | **可用** | `companion_applications` → 管理员审批事务写 `companions.user_id` 与 `user_qualifications` |
| 微信身份 / OAuth | **未实现** | 无 openid/unionid 表、无 state、无 provider |
| 支付 | **可用（仅 Mock）** | `ENABLE_MOCK_PAYMENT`、`/api/payments/mock-confirm`、服务端重算金额、幂等键、PG 事务 |
| 真实微信支付 | **未实现（刻意）** | 无商户号/证书/APIv3 key；不得启用 |
| 公网边界 | **可用** | Nginx 白名单 + `proxy.ts` 双层；仅 GET/HEAD；公网清 Cookie |
| 受控部署 | **可用** | `chaoge-deploy deploy <artifact> <sha256> <git-sha>`；迁移只从 root 快照执行 |

### 关键复用点

1. **会话基础设施**：微信登录成功后只需调用既有 `createRealSession("user", userId)`，
   不新增 Cookie、不新增会话表、不新增第二个身份域。
2. **打手资格**：微信登录只确认「这个用户是谁」；是否能进工作台仍由
   `resolveCompanionAccess()` 决定。现有入驻申请 + 管理员审批就是安全的首次绑定流程。
3. **用户实体**：`users(id, display_id, nickname, avatar_url, bio)` 已存在；
   微信昵称/头像只作为新用户初始资料写入，之后仍由用户在资料页维护。
4. **Mock 开关**：`ENABLE_MOCK_AUTH` 已存在于 Staging，复用它开启 Mock 微信登录，
   不需要修改 root 管理的 `staging.env`。

### 差距

- 没有 `external_identities`（provider + appid + openid / unionid → user）。
- 没有一次性 OAuth `state` 的持久化与消费机制。
- 没有真实微信 provider（authorize URL / code 交换 / userinfo）。
- 登录界面没有微信入口；没有「真实微信未配置」的明确提示。
- 没有 Mock 微信身份选择页。
- 支付层没有 provider 接口（当前只有 Mock 确认函数）。

---

## 二、决策

### D1 · 微信登录只产生「普通用户会话」，不产生任何新角色

- 微信登录成功后调用既有 `createRealSession("user", userId)`，Cookie 仍是
  `chaoge_user_session`。
- 客服 / 管理员继续用户名密码登录，两端界面与接口**不出现微信入口**。
- 打手没有第二套登录：打手就是「已通过入驻审核的用户」。微信登录**不会**创建
  `companions` 记录、不会写 `user_qualifications`、不会修改任何角色字段。
- 请求体里的 `role` / `companionId` / `staffId` / `adminId` 一律不读。

**理由**：架构规则禁止第二套 Companion Auth；四端隔离已经由独立会话与 Guard 保证。
新增微信 provider 只扩展「用户如何证明自己是谁」，不扩展「你是谁」。

### D2 · 增量迁移 0018：外部身份 + OAuth state

`db/migrations/0018_wechat_identity.sql`（纯增量、不改既有列）：

- `external_identities(id, provider, app_id, open_id, union_id, user_id, 快照, 时间)`
  - `UNIQUE(provider, app_id, open_id)`——同一应用内 openid 唯一；
  - `UNIQUE(provider, union_id) WHERE union_id IS NOT NULL`——同一开放平台主体下
    unionid 唯一，供跨应用链接同一用户；
  - `user_id` → `users(id) ON DELETE CASCADE`。
- `auth_oauth_states(id, provider, state_hash UNIQUE, redirect_to, created_at,
  expires_at, consumed_at)`
  - 只存 state 的 SHA-256；10 分钟有效；`consumed_at` 一次消费；
  - 过期/已消费的行保留为审计痕迹（可后续清理）。

**理由**：openid 是「应用维度」身份，unionid 是「开放平台维度」身份，两者不能混为一列；
state 必须服务端持久化，否则多实例/重启后无法防重放。

### D3 · Mock 与真实 provider 完全分离

| | Mock | 真实 |
|---|---|---|
| provider 值 | `mock` | `wechat` |
| 入口 | `GET /wechat-mock` + `POST /api/auth/wechat/mock/complete` | `GET /api/auth/wechat/start` → 微信扫码 → `GET /api/auth/wechat/callback` |
| 开启条件 | `DATA_SOURCE=postgres` **且** `ENABLE_MOCK_AUTH=true` | `WECHAT_APP_ID` + `WECHAT_APP_SECRET` + `WECHAT_REDIRECT_URI` 三项齐全 |
| 文案 | 明确写「模拟微信登录（Staging）」 | 「微信扫码登录」 |
| 失败行为 | 未开启时页面/接口按不存在处理 | 未配置时明确提示「微信登录尚未配置」 |

- Mock 代码只在 mock 路由与 mock provider 内；真实 callback 的代码路径
  **不 import** mock provider。
- Mock 身份 openid 带 `mock-openid-` 前缀，永远不会与真实 openid 冲突；
  provider 列本身也不同。
- 缺少真实配置时，`/api/auth/wechat/start` 与登录按钮都明确显示未配置，
  **绝不**降级到 Mock、绝不伪造成功。

### D4 · OAuth state：服务端哈希 + 浏览器 Cookie 双绑定

1. `start` 生成 32 字节随机 state，写入 `auth_oauth_states`（只存 SHA-256），
   同时把原文写入 HttpOnly Cookie `chaoge_wechat_state`（10 分钟）。
2. `callback` 必须同时满足：query 里的 state 与 Cookie 相同、数据库里存在未消费且未过期的行。
3. 消费使用单条 `UPDATE … WHERE consumed_at IS NULL AND expires_at > now RETURNING redirect_to`，
   并发回调只有一个能成功。
4. 无论成功失败都清除 state Cookie；回调错误统一跳转 `/wechat-login?error=<code>`，
   不在 URL 或响应中回显 code / token / secret。
5. `redirect_to` 只接受站内路径（以 `/` 开头、不以 `//` 开头、不含反斜杠、不以 `/api` 开头）。

**理由**：只校验 query state 无法防「攻击者构造自己的 state 让受害者回调」；
Cookie + 数据库双绑定同时覆盖 CSRF 与重放。

### D5 · 身份解析与用户创建在同一事务内，并发安全

`resolveOrCreateUserFromIdentity()`：

1. 按 `(provider, app_id, open_id)` 查已存在身份 → 直接返回其 user_id；
2. 有 unionid 时，按 `(provider, unionid)` 查同主体下已链接身份 → 复用同一 user，
   为当前应用新增一条 openid 身份行；
3. 否则新建 `users` + `external_identities`，两者同一事务；
4. 唯一索引冲突（并发首登）→ 事务回滚后重新按 1/2 查询，返回已存在的用户。

**补充（实现时确定）· unionid 只写在链接的第一行**：
`UNIQUE(provider, union_id)` 不允许两行持有同一 unionid，因此第二个应用登录时
**不能**把 unionid 复制到自己的新行上。实现规则是：

- 按 `(provider, app_id, openid)` 找到身份 → 直接返回；
- 否则按 `(provider, unionid)` 找到已链接用户 → 复用该用户，**追加**当前应用的
  openid 行，且该行 `union_id = NULL`；
- 只有「新建用户的那一行」写 unionid。

这样既保留了跨应用链接能力，又不会因唯一索引丢失第二个应用的 openid。
并发冲突（23505）由外层重试 + 重新查询收敛；测试见
`tests/pgWechatIdentity.test.mjs` 的并发 unionid 用例。

**理由**：不能只用昵称/头像匹配账号；openid 是唯一可靠键。并发首登不能产生两个用户。

### D6 · 打手绑定复用现有入驻审核，不做微信身份绑定捷径

- 微信登录后进入 `/join` 提交入驻申请；管理员审批事务写入 `companions.user_id`。
- `/companion` 对未绑定用户继续显示「尚未成为护航」，并新增一句说明：
  **微信登录只确认用户身份，不会自动获得接单权限**。
- 已绑定但被下架的用户仍显示 `disabled` 状态，引导联系客服。
- 本轮不提供「用微信 openid 直接匹配某个打手账号」的入口——不存在可靠的匹配依据。

### D7 · 支付保持原样，只预留 provider 接口

- `ENABLE_MOCK_PAYMENT`、`/api/payments/mock-confirm`、订单事务、幂等与金额重算
  **一行不改**。
- 新增 `lib/payments/wechatPayProvider.ts`：仅定义接口
  （统一下单 / 查询 / 关单 / 退款 / 回调验签 / 回调幂等 / 对账）与一个
  `disabledWechatPayProvider`，所有方法抛出「真实微信支付尚未配置」。
- 不新增支付路由、不读取任何商户凭据、不创建真实交易、不信任客户端 `paid=true`。

### D8 · 0018 迁移同样需要 root 快照更新后才可执行

与 PROD-4 的 0017 相同：`chaoge-deploy deploy` 只从 root 拥有的
`/usr/local/lib/chaoge/src` 快照执行迁移。0018 生效前需要：

1. 本地完成代码 / 测试 / commit；
2. 生成新 bundle 与 `deploy/trust/migration-code.sha256`，报告 SHA-256；
3. **人工授权后**重新运行一次 root 安装器（幂等，不重置数据库）；
4. 再走日常 `chaoge-deploy deploy` 执行 0018。

---

## 三、明确不做（本轮）

- 不接微信公众号 / 小程序登录，只实现开放平台网站应用扫码登录的适配器。
- 不启用真实微信支付，不读取商户资质。
- 不做短信、找回密码、登录限流（继续记录为公网开放前条件）。
- 不开放公网登录 / 注册 / 下单；不修改 Nginx、SSH、sudoers、系统服务。
- 不修改 `chaoge_prod`，不重置 `chaoge_staging`。
- 不新增第二套用户 / 密码 / 会话表。
