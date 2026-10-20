# PROD-4 · 交付记录

**Status:** 已发布到私有 Staging；自动门禁、PostgreSQL 回归、真实浏览器闭环与服务重启持久化全部通过，等待产品负责人人工验收
**Release:** `20261018T131303Z-909cfab`
**App Git SHA:** `909cfaba070bb46e7fa717311b06942be67b6337`
**Artifact SHA-256:** `27d06ac47f102fbd2dcc4694e3cc8638847a42e13d8fce19ff37b7d8bdde3842`
**CI:** GitHub Actions run `39106543775` · success
**Database:** `chaoge_staging`（PostgreSQL，迁移 0017 已应用）；`chaoge_prod` 未触碰
**Public boundary:** `http://43.128.13.181` 仍为匿名只读，未开放真实登录/注册/订单/支付/后台接口

## Implemented

### 1. 用户账号（真实凭据）

- 新增 `POST /api/auth/register`、`POST /api/auth/login`，重写 `POST /api/auth/logout`。
- 密码使用 Node 内置 `crypto.scrypt`（N=16384、r=8、p=1、64B 输出、随机盐），
  存储格式 `scrypt$N$r$p$salt$hash`，校验使用 `timingSafeEqual`。
- 会话为 32 字节随机令牌，只以 HttpOnly Cookie `chaoge_user_session` 下发；
  数据库 `auth_sessions` 只存 SHA-256，7 天固定有效期，退出/改密即吊销。
- 真实会话与既有 Mock 身份完全分离：真实会话存在时优先；真实 Cookie 失效时
  **不会**回退到 `mock_user_id`；登录成功会自动清理同身份的 Mock Cookie。
- 用户只能读取自己的订单/支付数据；他人订单一律 404，不是 403。

### 2. 商品与订单

- 服务端重新计算商品/规格/加购项价格，前端提交的金额一律丢弃。
- 提交订单 = 持久化 `payment_requests`（待支付），未确认的请求不会显示成已支付。
- PostgreSQL 下 `confirmPaymentRequest` 改走 `confirmPaymentRequestPg()`：
  认领支付 → 建订单 → 建支付 → 建派单 → 核销券 → 回填 `order_id` 在一个事务内完成。
- 订单号生成增加唯一冲突重试；重复提交仍由 `(user_id, idempotency_key)` 唯一索引兜底。
- 订单状态仍由既有 `ORDER_TRANSITIONS` 产出，不新增状态、不允许任意跳转。

### 3. 客服工作台

- 新增真实客服登录 `POST /api/staff/auth/login`（Cookie `chaoge_staff_session`）。
- 新增“指派接单”：`GET /api/staff/orders/[id]/assign-candidates`、
  `POST /api/staff/orders/[id]/assign`。
- 指派使用专用事务 `assignOrderCompanionByStaffPg`：同一事务内写派单 `accepted`
  （`accepted_via='staff'`）、订单 `accepted`、通知与 `order.assign` 审计
  （actor role = `customer_service`）。**不伪造** `companion_accept_events`。
- 资格、专属池、接单开关、截止时间、禁止自接单等规则与护航本人接单完全一致；
  非法状态继续返回既有明确 400 文案。

### 4. 管理后台

- 新增真实管理员登录 `POST /api/admin/auth/login`（Cookie `chaoge_admin_session`）。
- 新增管理员改密 `POST /api/admin/auth/password`、管理员重置客服密码
  `POST /api/admin/staff/[id]/password`，并写审计。
- 管理员可查看同一订单的列表与详情；普通用户会话无法进入任何 admin/staff 接口，
  请求体里的角色字段不能提权。

### 5. 数据迁移

- `db/migrations/0017_real_auth.sql`：新增 `user_credentials`、`staff_credentials`、
  `admin_credentials`、`auth_sessions` 四张表及索引；纯增量，不改既有列、不搬数据。
- 迁移由受控入口以 migrator 身份执行，部署自带 `99-verify.sql` 输出 `OVERALL=PASS`。

## Files Changed

主要新增：

- `db/migrations/0017_real_auth.sql`
- `lib/auth/password.ts`、`sessionToken.ts`、`realSession.ts`、`cookieNames.ts`
- `lib/data/pg/authRepository.ts`、`lib/data/companionOrderTransaction.ts`
- `lib/services/realUserAuth.ts`、`staffAuth.ts`、`adminAuth.ts`、
  `adminCredentials.ts`、`staffOrderActions.ts`、`realAuthHttp.ts`
- API：`app/api/auth/{register,login}/route.ts`、`app/api/auth/logout/route.ts`、
  `app/api/staff/auth/login/route.ts`、`app/api/admin/auth/login/route.ts`、
  `app/api/admin/auth/password/route.ts`、`app/api/admin/staff/[id]/password/route.ts`、
  `app/api/staff/orders/[id]/{assign,assign-candidates}/route.ts`
- 页面/组件：`components/auth/RealAuthForm.tsx`、`components/admin/AdminPasswordForm.tsx`、
  `AdminStaffPasswordReset.tsx`、`app/admin/(console)/account/page.tsx`
- 测试：`tests/realAuth.test.mjs`、`tests/pgAuth.test.mjs`、`tests/realAuthHttp.test.mjs`、
  `tests/staffOrderAssign.test.mjs`、`tests/pgW1Transactions.test.mjs`
- 部署信任清单：`deploy/trust/deploy-files.sha256`、`deploy/trust/migration-code.sha256`

其他修改见 `git diff --stat 3e3dc9e..909cfab`（77 files, +5554/−210）。

## Business Rules Implemented

| 规则 | 落点 |
|---|---|
| 密码只存哈希、不出 DTO/日志 | `lib/auth/password.ts`、凭据仓储、`realAuthHttp` DTO 白名单 |
| Cookie 不可被脚本读取、不可伪造身份 | HttpOnly + 服务端不透明令牌 + 数据库存哈希 |
| 真实会话失效不得回退 Mock | `lib/auth/session.ts` 真实会话优先且失败即匿名 |
| 用户只能看自己的订单 | `requireUser()` + 服务端所有权校验，他人 404 |
| 金额服务端重算 | `parseSelectionInput` 白名单 + `resolveSelection` |
| 未支付不得显示已支付 | `payment_requests` 与 `orders` 分离；仅确认后建单 |
| 重复提交幂等 | `(user_id, idempotency_key)` 唯一索引 |
| 建单原子性 | `confirmPaymentRequestPg()` 单事务 |
| 订单号冲突可恢复 | 唯一索引冲突重试 |
| 客服指派不伪造护航行为 | `assignOrderCompanionByStaffPg`，不写 `companion_accept_events` |
| 非法状态跳转有明确提示 | 既有 `ORDER_TRANSITIONS` + 400 文案 |
| 管理动作可审计 | `order.assign`、改密/重置密码写 `admin_audit_entries` |
| 普通用户不可调用后台接口 | 三个独立 Guard 与 Cookie；用户会话 401/403 |

## Tests Added / Updated

| 文件 | 覆盖 |
|---|---|
| `tests/realAuth.test.mjs`（13） | 邮箱规范化/校验/长度、密码边界、scrypt 格式与校验、损坏哈希、时序 dummy、令牌形状/TTL、客户端组件导入门禁 |
| `tests/pgAuth.test.mjs`（12） | 注册原子性、邮箱并发唯一、主键冲突翻译、会话生命周期、过期清理、客服/管理员改密与审计详情 |
| `tests/realAuthHttp.test.mjs`（8） | 注册 Cookie HttpOnly/SameSite、订单归属 401/404、大小写不敏感登录、重复注册、退出吊销、失效真实 Cookie 不回退 Mock、角色隔离与伪造字段 |
| `tests/staffOrderAssign.test.mjs`（448 行） | 指派资格、专属池、截止时间、自接单禁止、状态机、审计、并发/幂等 |
| `tests/pgW1Transactions.test.mjs`（+195 行） | T1 建单事务原子性、失败回滚、订单号冲突重试、券核销 |
| `tests/staffOrderActions.test.mjs` / `staff.test.mjs` / `admin.test.mjs` / `companionOrders.test.mjs` | 新动作的权限、非法迁移、接口清单门禁同步 |

## Verification

以下均为实际执行结果。

| 命令 / 验收 | 结果 |
|---|---|
| `pnpm test`（本机全量） | **2366 tests · 1924 pass · 0 fail · 442 skipped** |
| PostgreSQL 门禁用例 | **85 pass · 0 fail · 4 skipped** |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| 部署后真实认证 HTTP 回归（`REAL_AUTH_HTTP=1 REAL_AUTH_BASE=http://127.0.0.1:3100`） | **8/8 通过** |
| 受控部署 `chaoge-deploy deploy` | 通过；迁移 0017 已应用；`99-verify` **OVERALL=PASS**；`chaoge_prod` 未触碰、`chaoge_staging` 未重置 |
| `chaoge-deploy status`（部署后） | `current=20261018T131303Z-909cfab`；`BUILD_INFO sha=909cfaba…`；`active/enabled`；仅 `127.0.0.1:3000` |
| 服务重启后复验 | 重新发布后 PID 变化；用户/客服/管理员会话与订单均存活，状态仍为 `accepted` |

### 真实浏览器端到端（Playwright + 本机 Edge，SSH 隧道到私有 Staging）

阶段 1（订单闭环，截图见 `evidence/01`–`14`）：

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 注册测试用户 | 成功，下发 HttpOnly `chaoge_user_session`，SameSite=Lax，无 Mock Cookie |
| 2 | 退出后用大写邮箱重新登录 | 成功（邮箱大小写不敏感） |
| 3 | 浏览商品、选择规格 | `/product/p-400w`「机密400万」正常 |
| 4 | 提交订单并模拟支付 | 生成 `ord_9c85af9f-e307-40c9-9e26-88bd7a3aa44e` / `YM20261018871014`，状态 `paid` |
| 5 | 刷新订单页 | 订单仍存在、订单号一致、状态仍 `paid` |
| 6 | 客服真实登录并指派护航 | 成功，订单变为 `accepted`（已接单），写 `order.assign` 审计 |
| 7 | 用户复查（含刷新） | 用户端看到「已接单」 |
| 8 | 管理员真实登录并查看 | 列表与详情均显示同一订单与「已接单」 |
| 9 | 他人账号访问该订单 | 页面「订单不存在」，接口 **404**，页面不含订单号 |
| 10 | 服务重启后复查 | 见阶段 2 |

阶段 2（服务重启持久化，截图见 `evidence/15`–`18`）：

- 受控入口重新发布后，服务 PID 已变化；
- 用户会话与订单仍存在，状态仍为 `accepted`，订单号一致；
- 客服、管理员会话均存活，仍能读取该订单；
- 他人仍无法查看（接口 404）。

浏览器控制台错误：阶段 1 断言为 0。

### 公网边界（`http://43.128.13.181`）

| 请求 | 结果 |
|---|---|
| `GET /` | 200 |
| `GET /product/p-400w` | 200 |
| `GET /orders`、`GET /admin`、`GET /staff` | 404 |
| `GET /api/products`、`/api/orders`、`/api/admin/orders` | 404 |
| `POST /api/auth/register`、`/api/auth/login` | 404 |
| `POST /api/payments/mock-confirm` | 404 |
| `POST /api/auth/mock-login`、`/api/admin/auth/mock-login`、`/api/staff/auth/mock-login` | 404 |
| `POST /api/admin/auth/password` | 404 |
| 公网 TCP 3000 / 5432 | 连接超时（不可达） |
| 对照：公网 TCP 22 | 可达（SSH 正常） |

结论：公网仍只提供匿名只读页面；真实注册、登录、下单、支付、客服与后台接口
均未开放。3000/5432 仍只在服务器回环监听。

## Known Limitations

1. **未接微信登录 / 微信支付**：本轮是邮箱+密码与私有环境模拟支付。
2. **登录限流、短信验证码、找回密码未实现**：公网开放真实登录前必须补齐。
3. **CSRF**：当前依赖 `SameSite=Lax` 与公网只读白名单；开放写操作前需评估。
4. **端到端订单只推进到 `accepted`**：`serving/completed/refunded` 由既有护航/审核/
   退款流程产出，本轮自动验收未覆盖这些后续动作。
5. **管理员端到端只验收了订单查看**：商品/客服账号/密码管理等沿用既有管理接口与
   单测/HTTP 回归，未在本次浏览器脚本中逐项操作。
6. **验证码/邮件发送**：注册不要求邮箱验证，测试邮箱域名为 `example.test`。
7. **私有 Staging 仍为 HTTP**：经 SSH 隧道验收；公网未传输任何凭据。

## Out Of Scope

- 真实微信生态（UnionID、订阅消息、微信支付）。
- 客服按人分摊订单（需求未定义）。
- 管理员直接修改订单状态（既有设计禁止）。
- 公网开放真实登录/下单/后台写入；需另行提交最小开放方案并获批。

## Project Progress Change

- 用户端从「只有 Mock 身份」升级为真实注册/登录/退出闭环。
- 订单链路在 PostgreSQL 下具备真实建单事务与真实持久化，可通过服务重启验证。
- 客服从「只能换人/回池」补齐「对 paid 订单指派接单」，并留下审计。
- 管理员具备真实登录、改密、重置客服密码；普通用户无法进入后台接口。
- 公网只读边界保持不变。

## Recommended Commit

```
docs(prod-4): record delivery, acceptance checklist and evidence

- record deployed release 20261018T131303Z-909cfab (app 909cfab)
- capture automated, PostgreSQL, HTTP and real-browser verification
- attach 18 screenshots for the 10-step private staging acceptance
- document public read-only boundary and remaining public-opening conditions
```
