# PROD-5 · 交付记录

**Status:** 已发布到私有 Staging；自动门禁、PostgreSQL 回归、真实浏览器验收、服务重启持久化与公网边界全部通过，等待产品负责人人工验收
**Round:** PROD-5 · 微信登录接入、认证体系完善与模拟支付保留
**Release:** `20261018T175352Z-7fdf185`
**App Git SHA:** `7fdf185adc4f44155d3181fc7a14444f8192d55b`
**Artifact SHA-256:** `5e336a02d193870a02c7c1298af11f8de567aea342303aa89716e87dd852c324`
**Database:** `chaoge_staging`（PostgreSQL，迁移 0018 已应用，共 18 个迁移 / 46 张表）；`chaoge_prod` 未触碰
**Public boundary:** `http://43.128.13.181` 仍为匿名只读；微信登录、真实登录、下单、支付与后台接口均未公网开放

---

## 一、交付范围

本轮在 PROD-4 已验收的真实认证 / 会话 / 订单体系之上，增量接入微信网页扫码登录：

1. 普通用户可使用微信身份登录，登录后仍是既有 `chaoge_user_session`，不新增身份域；
2. 打手不新增登录方式，继续由「用户会话 + 既有入驻申请 / 管理员审批」派生；
3. 客服 / 管理员保持用户名密码登录，界面与接口均不出现微信入口；
4. Mock 微信 provider 与真实微信 provider 严格分离；真实配置缺失时明确提示，绝不伪造成功；
5. Mock 支付 / 订单事务 / 幂等逻辑保持原样，只预留一个默认拒绝的真实微信支付 provider；
6. 数据库只做增量迁移，不重置、不清空、不改既有列。

## 二、实现

### 1. 数据库迁移 0018

`db/migrations/0018_wechat_identity.sql`（纯增量，111 行）：

- `external_identities`
  - `(provider, app_id, open_id)` 唯一——应用维度身份；
  - `(provider, union_id) WHERE union_id IS NOT NULL` 唯一——开放平台维度身份；
  - `user_id → users(id) ON DELETE CASCADE`；
  - `provider` 只允许 `wechat` / `mock`，openid 有长度下限，写入时间可审计。
- `auth_oauth_states`
  - 只存 state 的 SHA-256，10 分钟有效；
  - `consumed_at` 一次性消费；过期 / 已消费行保留为审计痕迹；
  - `redirect_to` 只接受站内路径（数据库 CHECK 拒绝 `//` 协议相对地址）。

迁移由受控部署入口以 `chaoge_staging_migrator` 身份执行，代码只来自 root 快照；
`deploy/trust/migration-code.sha256` 第 18 行为：

```text
dbb3afd95b159a25729bfed9597aeb1bd6d72ceb95a297222729e5825e53b8cd  db/migrations/0018_wechat_identity.sql
```

已与服务器 root 快照逐一比对一致。

### 2. Provider 与配置分离

| 项目 | Mock | 真实 |
|---|---|---|
| provider 值 | `mock` | `wechat` |
| 开启条件 | `DATA_SOURCE=postgres` **且** `ENABLE_MOCK_AUTH=true` | `WECHAT_APP_ID` + `WECHAT_APP_SECRET` + `WECHAT_REDIRECT_URI` 三项齐全 |
| 入口 | `/wechat-mock` + `POST /api/auth/wechat/mock/complete` | `GET /api/auth/wechat/start` → 扫码 → `GET /api/auth/wechat/callback` |
| 失败行为 | 未开启时页面 / 接口按不存在处理 | 明确「微信登录尚未配置」，降级为不可用而不是 Mock |

- Mock openid 统一带 `mock-openid-` 前缀，provider 列也不同，不会与真实 openid 冲突。
- 真实回调代码路径不 import Mock provider；`tests/wechatLogin.test.mjs` 用源码扫描守住这条边界。
- 客户端组件不引用任何服务端微信模块；状态接口只返回布尔值，不下发 AppID / AppSecret / 回调地址。

### 3. 登录闭环

- `GET /api/auth/wechat/start`
  - 生成 32 字节随机 state，数据库只存 SHA-256，同时写入 HttpOnly Cookie `chaoge_wechat_state`；
  - 真实配置缺失时返回明确的「尚未配置」，不生成授权地址。
- `GET /api/auth/wechat/callback`
  - query state 与 Cookie 必须一致；
  - 数据库单条 `UPDATE … WHERE consumed_at IS NULL AND expires_at > now RETURNING redirect_to` 原子消费；
  - 并发回调只有一个成功，重放与伪造统一失败；
  - 失败只跳转 `/wechat-login?error=<code>`，URL 与响应中不回显 code / token / secret。
- `lib/data/pg/wechatRepository.ts` 的 `resolveOrCreateUserFromIdentity()`
  - 先按 `(provider, app_id, open_id)` 查身份；
  - 再按 `(provider, union_id)` 复用已链接用户，并为当前应用追加一条 `union_id = NULL` 的 openid 行；
  - 新用户与身份在同一事务内创建；
  - 唯一索引冲突（并发首登）回滚后重新查询，最终收敛到同一用户。
- 登录成功只调用既有 `createRealSession("user", userId)`：
  - Cookie 仍是 `chaoge_user_session`；
  - 7 天有效期、数据库只存令牌 SHA-256；
  - 请求体中的 `role` / `companionId` / `staffId` / `adminId` 一律不读。

### 4. 界面

- `components/auth/WechatLoginButton.tsx`：登录拦截页的微信入口；真实未配置时显示明确提示，
  Mock 可用时显示「模拟微信登录（Staging）」。
- `app/(mobile)/wechat-login/page.tsx`：真实登录失败 / 未配置的落地页，不显示伪造成功。
- `app/(mobile)/wechat-mock/page.tsx` + `components/auth/MockWechatLoginPanel.tsx`：
  仅服务端开关满足条件时渲染三个 Mock 身份（阿超 / 小目 / 小陈），并明确写「不授予任何角色」。
- `components/companion/CompanionAccessNotice.tsx`：未绑定用户进入 `/companion` 时，
  除「你还不是护航」外明确说明「微信登录只确认用户身份，不会自动获得接单权限」。
- 客服 / 管理员登录页未增加任何微信控件。

### 5. 打手资格

- 不新增 `companions` 记录、不写 `user_qualifications`、不做 openid 与打手账号匹配。
- 打手资格仍由 `resolveCompanionAccess(user.id)` 决定；首次绑定继续走 `/join` 入驻申请 +
  管理员审批事务。
- 已下架打手仍显示 `disabled`，引导联系客服。

### 6. 支付边界

- `ENABLE_MOCK_PAYMENT`、`/api/payments/mock-confirm`、订单事务、金额服务端重算、幂等键
  **一行未改**。
- 新增 `lib/services/wechatPayProvider.ts`：只有接口定义与 `disabledWechatPayProvider`，
  所有方法立即抛出「真实微信支付尚未配置」。
- 没有新增任何支付路由；测试扫描 `app/api` 确认没有文件引用该 provider 或读取商户配置。
- 真实微信支付开关恒为 `false`。

### 7. 公网边界未放宽

- Nginx 白名单与 `proxy.ts` 双层边界保持原样；未因微信登录新增任何公网可写路径。
- `/wechat-mock`、`/wechat-login`、`/api/auth/wechat/*` 均不在公网白名单内。
- 公网仍只允许白名单 GET/HEAD，响应带 `X-Chaoge-Public-Proxy: 1`。

## 三、变更文件

`77401df`（36 files, +3855 / −6）主要新增：

- 迁移：`db/migrations/0018_wechat_identity.sql`
- 认证核心：`lib/auth/wechat/{config,errors,mockProvider,realProvider,redirect,state,stateToken}.ts`
- 数据层：`lib/data/pg/wechatRepository.ts`
- 服务层：`lib/services/{wechatLogin,mockWechatLogin,wechatAuthHttp,wechatPayProvider}.ts`
- API：`app/api/auth/wechat/{start,callback,status}/route.ts`、
  `app/api/auth/wechat/mock/complete/route.ts`
- 页面 / 组件：`app/(mobile)/wechat-login/page.tsx`、`app/(mobile)/wechat-mock/page.tsx`、
  `components/auth/{WechatLoginButton,MockWechatLoginPanel}.tsx`、
  `components/companion/CompanionAccessNotice.tsx`
- 测试：`tests/{wechatLogin,wechatAuthHttp,pgWechatIdentity}.test.mjs`（合计约 1,500 行）
- 文档：`docs/02-tech-design/{api-contract,database-schema}.md`、
  `docs/03-dev/rounds/PROD-5/`
- 部署信任清单：`deploy/trust/deploy-files.sha256`、`deploy/trust/migration-code.sha256`

`7fdf185` 只重新生成部署信任清单，使 `77401df` 成为可被受控入口验证的构建输入。

## 四、质量门禁（2026-10-19 本地复跑）

| 门禁 | 结果 |
|---|---|
| `pnpm test` | **2411** 用例 · pass **1946** · fail **0** · skipped **465**（全部为需要 `APP_BASE_URL` / PostgreSQL 的环境门禁） |
| `pnpm test:pg` | **280** 用例 · pass **275** · fail **0** · skipped **5** |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit 0 |
| `pnpm lint` | exit 0 |
| CI 构建 | 通过；部署产物由 CI 生成，部署前复核 SHA-256 |

本轮新增的 PG 用例覆盖：

- 同一 unionid、两个应用的并发首登收敛到同一用户，两行身份都不丢；
- provider / openid 约束与 CHECK；
- state 一次性消费、过期、并发回调只有一个成功；
- state 唯一索引与回跳地址 CHECK；
- 清理只删过期且未消费的 state。

## 五、部署与迁移

### 1. 受控入口状态（部署前核对）

- `chaoge-deploy`：`prod2-entry-v4`，入口哈希 `b832e2f0…`，root:root 600 的凭据 / 环境文件，
  sudoers 为单命令 NOPASSWD 规则；
- 安装器提示「服务尚未启动、没有发布过版本」与实际不符：当时服务 `active`、
  已有 release `20261018T173715Z-7fdf185`、迁移 18 个 / 46 张表。已按实际状态继续，
  未因此重置任何内容。

### 2. 发布

```text
sudo -n /usr/local/sbin/chaoge-deploy deploy <artifact> <sha256> <git-sha>
```

- 产物：`staging-standalone-7fdf185….tar.gz`
- SHA-256：`5e336a02d193870a02c7c1298af11f8de567aea342303aa89716e87dd852c324`
- Git SHA：`7fdf185adc4f44155d3181fc7a14444f8192d55b`
- 首次发布 release：`20261018T173715Z-7fdf185`
- 重启复验发布 release：`20261018T175352Z-7fdf185`

### 3. 迁移结果

- 迁移 0018 已通过受控入口执行；
- 当前迁移总数 **18**，业务表 **46**；
- 幂等重新部署时输出「本次执行 0 条，跳过 18 条」；
- bootstrap 与隔离验证 `OVERALL PASS`：`chaoge_staging` 应用身份无法访问 `chaoge_prod`；
- 未重置 `chaoge_staging`、未清空订单 / 商品 / 用户、未修改任何既有数据库口令。

### 4. 运行状态

- `current`：`/opt/chaoge-staging/releases/20261018T175352Z-7fdf185`
- `BUILD_INFO sha`：`7fdf185adc4f44155d3181fc7a14444f8192d55b`
- `is-enabled: enabled` · `is-active: active`
- 监听：`127.0.0.1:3000`；PostgreSQL `127.0.0.1:5432`；Nginx `0.0.0.0:80`
- 健康检查通过

### 5. 重启验证

受控入口没有 `restart` 子命令，本轮用**同一产物幂等重新部署**作为唯一受控重启路径，
生成新 release `20261018T175352Z-7fdf185`，健康检查通过；随后执行 6 项重启后复验，
**6 / 6 PASS**（见 `evidence/post-restart.json`）。

## 六、真实浏览器验收

使用 Playwright + Edge（`playwright-core@1.51.1`，`channel: msedge`），
经 SSH 隧道 `127.0.0.1:3101 → Staging 127.0.0.1:3000` 访问**私有 Staging**。

**结果：23 / 23 PASS**。完整逐项记录见 `evidence/browser-acceptance.json`，
截图见 `evidence/01-…19-*.png`。

分组摘要：

1. **用户登录与身份**
   - 未登录访问 `/mine` 显示登录拦截与「模拟微信登录（Staging）」入口；
   - Mock 身份页可见 3 个身份，且明确写不授予角色；
   - alpha 登录后只建立 `chaoge_user_session`，无角色 Cookie；
   - 同一 Mock 身份重复登录仍是同一 `user.id`；
   - 伪造 `role=admin` 不产生管理员权限。
2. **权限隔离**
   - 用户会话访问 `/admin`、`/staff` 均回到登录页；
   - `/api/admin/*`、`/api/staff/*` 返回 401；
   - 普通微信用户访问 `/companion` 显示未绑定与「微信登录不授予护航资格」说明。
3. **打手绑定**
   - beta 是独立用户且仍未绑定；
   - gamma 经既有 `/join` 申请 + 管理员审批后进入护航工作台；
   - 护航身份的 `user.id` 与微信登录身份完全一致。
4. **客服 / 管理员**
   - 管理员既有账号密码登录成功；
   - 管理员新建客服账号并设置密码，该账号可登录工作台；
   - 本轮新建的测试客服账号已软删除，记录保留；
   - **既有客服 `kefu-xiaoyu` 用现有档案口令登录返回 401；未修改、未重置该账号的密码**
     （详见「已知限制」）。
5. **模拟支付与订单**
   - 结算页金额由服务端试算；
   - 提交支付请求 → 模拟支付成功 → 生成订单；
   - 订单 `YM20261018703439` 状态「已付款」；
   - 刷新订单列表后订单仍在。
6. **重启后**
   - 会话仍有效、订单仍在且状态不变；
   - 同一微信身份仍是同一用户；
   - gamma 仍是护航；匿名访问仍需登录。

## 七、公网边界（2026-10-19 复验）

`http://43.128.13.181`：

| 路径 | 方法 | 结果 |
|---|---|---|
| `/`、`/api/home`、`/product/p-400w`、`/companions`、`/rank`、`/agreements` | GET | 200 |
| `/wechat-mock`、`/wechat-login`、`/api/auth/wechat/*` | GET | 404 |
| `/admin`、`/staff/login`、`/mine`、`/orders`、`/checkout` | GET | 404 |
| `/api/orders`、`/api/debug/reset`、`/api/admin/*`、`/api/staff/*`、`/api/auth/login` | GET | 404 |
| `/api/orders/pay`、`/api/auth/login`、`/api/auth/wechat/mock/complete`、`/api/admin/*` 写操作 | POST | 404 |

- 白名单响应带 `X-Chaoge-Public-Proxy: 1`；
- 服务器实际监听只有 `127.0.0.1:3000` / `127.0.0.1:5432` / `0.0.0.0:80`；
  3000 与 5432 公网不可达；
- 未开放真实支付、真实微信登录、注册、下单或后台写接口。

证据：`evidence/public-boundary.json`。

## 八、已知限制与遗留

1. **真实微信登录未启用**：Staging 没有 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` /
   `WECHAT_REDIRECT_URI`，状态接口返回 `realConfigured:false`。真实 provider 代码已就绪，
   但未用真实微信账号验证；这是外部资质 / 凭据依赖，不是代码缺失。Mock 登录只在
   `DATA_SOURCE=postgres` + `ENABLE_MOCK_AUTH=true` 的 Staging 私有入口可用。
2. **既有客服账号复验**：`kefu-xiaoyu` 用现有档案口令登录返回 401。未重置、未修改该账号，
   也未尝试猜测口令；本轮用管理员新建的临时客服账号验证了客服登录与工作台，
   该临时账号已软删除。既有客服口令是否仍应与 `.env.staging-e2e` 中的值一致，
   需要产品 / 运维在私下核对，不应通过重置密码来「让测试变绿」。
3. **真实微信支付未启用**：只有默认拒绝的 provider 接口，没有路由、没有商户配置。
4. **测试数据为增量写入**：本轮新增 alpha / beta / gamma 三个 Mock 微信用户、
   一个 gamma 护航资格（申请 `ca_8ffa9e9c-20e1-43a2-a6cd-5ddd76d922e9`）、
   订单 `YM20261018574184` / `YM20261018981709` / `YM20261018703439`。
   按安全约束未做清库或数据回滚；这些记录保留在 `chaoge_staging`。
5. **重启路径**：受控入口没有独立 `restart`，重启验证通过同产物幂等重新部署完成；
   这同时验证了重复部署的幂等性。
6. **Mock 开关仅限 Staging**：`ENABLE_MOCK_AUTH=true` 只在 Staging 环境文件；
   公网预览层仍屏蔽 Mock 登录页与接口。

## 九、回滚

- 代码回滚：`sudo -n /usr/local/sbin/chaoge-deploy rollback`（回到上一个 release，
  即 `20261018T173715Z-7fdf185` 或更早）。
- 迁移 0018 是纯增量（只新增两张表与索引），代码回滚后保留不影响旧版本；
  **不得**以删除表或重置数据库的方式回滚。
- 若需回退本轮功能，回滚 release 即可；数据保留，禁止 `db:reset`。

## 十、安全约束遵守情况

- 未修改 `chaoge_prod`；未重置 `chaoge_staging`；未清空订单 / 商品 / 用户数据；
- 未开放 3000 / 5432 公网端口；未修改 SSH、安全组、sudoers 或系统 root 配置；
- 未读取或输出任何明文密码 / AppSecret；未新增 NOPASSWD 授权；
- 未执行新的 root 安装器；未绕过受控部署入口；
- 未修改与本任务无关的未提交文件；
- 未把 `DATA_SOURCE` 从 `postgres` 改为 `mock`；
- 未强制推送，未由 Claude 执行 Git commit。

## 十一、下一步

1. 产品负责人按 `04-acceptance.md` 在私有 Staging 人工验收；
2. 验收通过后由用户本人提交 Git，README 与总需求进度表状态才可推进为 `DONE`；
3. 如需真实微信登录，另行提供开放平台网站应用资质与三项配置，并单独安排真实环境验证；
4. 公网开放登录 / 下单仍需最小开放方案与批准（限流、CSRF、HTTPS、验证码等前置条件）。
