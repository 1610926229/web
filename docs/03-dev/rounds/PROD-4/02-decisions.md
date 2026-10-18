# PROD-4 · 决策与阶段 1 审计

Round: PROD-4
Status: DECIDED（无 OPEN 决策，可进入编码）

---

## 一、阶段 1 功能矩阵（只读审计结论）

审计范围：`app/` 四个端、`lib/services/`、`lib/data/`（含 `lib/data/pg/`）、
`db/migrations/0001–0016`、`deploy/db/staging/06-bootstrap-data.sql`、
`deploy/entry/chaoge-deploy.sh`。

图例：**可用** = 页面 + 接口 + 服务端规则 + PostgreSQL 实现齐全；
**部分可用** = 有真实实现但缺关键前置/闭环；**未实现** = 只有界面或只有 Mock。

### 1. 用户账号

| 能力 | 结论 | 证据 |
|---|---|---|
| 注册 | **未实现** | 无注册接口/页面；`users` 表无 email / password 列（`0010_identity_and_accounts.sql`） |
| 真实登录 | **未实现** | 仅 `POST /api/auth/mock-login`；Cookie `mock_user_id` 里是明文用户 id，无签名、无凭据（`lib/auth/session.ts`） |
| 退出登录 | **部分可用** | 只清 Mock Cookie；没有服务端会话可吊销 |
| 用户只能看自己的数据 | **可用** | 订单/支付请求均按 `requireUser()` 的 `userId` 收敛；他人订单一律 404（`lib/services/orders.ts`、`checkout.ts`） |
| 三种身份隔离 | **可用（结构上）** | 三个独立 Cookie、三个仓储、三个 Guard，无“A 换 B”的转换函数 |
| 密码哈希 | **未实现** | 仓库内无任何密码字段或哈希依赖 |

### 2. 商品与订单

| 能力 | 结论 | 证据 |
|---|---|---|
| PostgreSQL 商品/规格/上下架 | **可用** | `0011_catalog.sql`、`pg/catalogRepository.ts`、管理端商品写事务 |
| 前端不传金额 | **可用** | `parseSelectionInput` 白名单丢弃金额；`resolveSelection` 服务端重算 |
| 重复提交 | **可用** | `(user_id, idempotency_key)` 唯一索引 + `INSERT … ON CONFLICT` |
| 支付前“订单”语义 | **可用（既有设计）** | `payment_requests` 是待支付请求；订单只在支付成功后生成；不新增 `OrderStatus` |
| 模拟支付 | **可用（仅私有环境）** | `/api/payments/mock-confirm`，`ENABLE_MOCK_PAYMENT` 控制；公网白名单不含该路径 |
| 用户订单列表/详情 | **可用** | `/orders`、`/orders/[id]`，服务端所有权校验 |
| PostgreSQL 建单原子性 | **部分可用（关键缺口）** | `confirmPaymentRequestPg()` 已实现但**生产路径未调用**；`services/checkout.ts` 仍走进程级自动提交 |
| 订单号碰撞 | **部分可用** | `makeOrderNo` 使用 `Math.random()`，唯一索引冲突时无重试 |

### 3. 客服工作台

| 能力 | 结论 | 证据 |
|---|---|---|
| 客服登录 | **未实现（真实凭据）** | 仅 `mock_staff_id` 选账号；`staff_accounts` 无密码列 |
| 查看订单 | **可用** | 全平台只读列表/详情，DTO 已做数据最小化 |
| 接单/指派 | **未实现** | 客服只能对 `accepted/serving` 做换人/回池；不能处理 `paid` 待接单 |
| 处理/状态更新 | **部分可用** | 回池（→`paid`）、换人（→`accepted`）、完成材料审核（→`completed`）可用；无任意跳状态 |
| 非法状态提示 | **可用** | `allowedActions` 服务端计算 + 明确 400 文案；状态机 `ORDER_TRANSITIONS` 唯一出处 |
| 操作审计 | **部分可用** | 投诉/退款有 `admin_audit_entries`；订单回池/换人只有退出历史；完成审核只有提交单字段 |
| 按客服收窄可见范围 | **未实现（刻意）** | 客服工作台按全平台订单设计；需求表未定义客服分摊规则（不自行发明） |

### 4. 管理后台

| 能力 | 结论 | 证据 |
|---|---|---|
| 管理员登录 | **未实现（真实凭据）** | 仅 `mock_admin_id` 固定账号 |
| 商品/规格管理 | **可用** | 新增/编辑/上下架/移除 + 类目 + 审计，PG 真事务 |
| 订单查看 | **可用（只读）** | `adminOrders` 列表/详情；无直接改状态接口（刻意） |
| 订单异常管理 | **可用** | 退款审批、投诉处理、售后队列 |
| 客服账号管理 | **可用** | 新增/编辑/启用/停用/移除 + 审计；角色写死 `customer_service` |
| 客服密码管理 | **未实现** | 账号模型无凭据 |
| 普通用户绕过前端调管理接口 | **不可行** | 77 个 admin 路由中 75 个 `requireAdmin()`，另外两个是登录/登出；用户 Cookie 身份域不相交 |

### 5. 权限 / 并发 / 状态一致性缺口

1. **T1 建单事务未激活**：`confirmPaymentRequest` 在 PG 下逐条自动提交，
   “认领支付 → 建订单 → 建支付 → 建派单 → 核销券 → 回填 order_id”可能半成品。
2. **订单号碰撞无重试**：`Math.random()` 尾号 + `orders_order_no_key` 唯一索引。
3. **Mock Cookie 无签名**：私有环境可接受；公网由 Nginx + `proxy.ts` 双重白名单挡住。
4. **订单处置审计缺口**：客服回池/换人、完成审核没有统一审计行。
5. **无登录限流**：真实登录上线公网前必须补。
6. **无 CSRF token**：当前依赖 `SameSite=Lax` + 公网只读白名单；公网开放前需评估。

---

## 二、决策

### D1 · 真实认证与 Mock 认证并存，真实认证自动随 PostgreSQL 启用

- 真实认证只在 `DATA_SOURCE=postgres` 时可用（Staging 已是）。
- 真实会话 Cookie 与 Mock Cookie **分开**：`chaoge_user_session` / `chaoge_staff_session` /
  `chaoge_admin_session`。服务端优先解析真实会话；没有真实会话时才回落到既有 Mock 开关。
- 真实认证始终只写自己的 Cookie，**永不**读写另一端的 Cookie。
- 公网只读边界不变：Nginx 白名单 + `proxy.ts` 在真实认证端点之前就拒绝非白名单请求，
  公网访客仍拿不到任何身份。

**理由**：复用现有三套身份架构；不改部署环境变量（`staging.env` 由 root 管理），
避免为一个开关触发新的 root 授权。

### D2 · 凭据独立建表，scrypt 哈希，服务端不透明会话

新增迁移 `0017_real_auth.sql`（纯增量、无删改）：

- `user_credentials(user_id PK → users.id, email, email_normalized UNIQUE, password_hash, …)`
- `staff_credentials(staff_id PK → staff_accounts.id, password_hash, …)`
- `admin_credentials(admin_id PK → admin_accounts.id, password_hash, …)`
- `auth_sessions(id PK, subject_kind ∈ user/staff/admin, subject_id, token_hash UNIQUE,
  created_at, expires_at, revoked_at, last_seen_at)`

- 密码：Node 内置 `crypto.scrypt`（N=16384, r=8, p=1, 64B），随机盐，输出
  `scrypt$N$r$p$salt$hash`；校验用 `timingSafeEqual`。
- 会话：32 字节随机 token 只出现在 HttpOnly Cookie；数据库只存 SHA-256。
  7 天固定有效期，退出/改密时吊销。
- Cookie：`httpOnly`、`sameSite=lax`、`path=/`、生产 `secure`（与现有三套一致）。

**理由**：密码哈希不进入账号实体/DTO；不新增依赖；可以按 subject 统一吊销。

### D3 · “创建订单”= 待支付请求，真实 Order 仍在支付成功后诞生

- 不新增 `OrderStatus`，不把显示阶段塞进状态枚举（需求表明确禁止）。
- 用户提交后得到持久化的 `payment_requests`（`pending`），刷新不丢；页面上明确标为
  **待支付 / 测试支付**。
- 私有 Staging 使用既有、明确标注为模拟的 `mock-confirm` 完成“收款”；
  成功后生成真实 `Order`（`paid`）。**未确认的请求永远不会显示成已支付**。
- 同时修复 T1：PG 下 `confirmPaymentRequest` 改走 `confirmPaymentRequestPg()` 真事务。

**理由**：这是现有架构最小且语义诚实的落法；不重写订单/支付/分账。

### D4 · 初始管理员/客服凭据通过私有 Mock 通道一次性引导

1. 私有 Staging 用既有 Mock 管理员登录（`ENABLE_MOCK_ADMIN` 已开）进入后台；
2. 管理员在“账号安全”里设置自己的真实密码；
3. 管理员给客服账号重置密码；
4. 之后验收全部使用真实用户名/密码登录。

- 不在仓库、迁移或 Git 中写入任何明文密码。
- 验收密码只放在本地未跟踪的 `.env.staging-e2e`（gitignored），由 Playwright 读取。
- 不修改 `staging.env`、不新增 root 脚本。

**理由**：无需 root 权限即可引导；Mock 入口本来就是私有环境的开发能力，
公网仍被双层白名单挡住。

### D5 · 客服“接单”使用专用指派事务，复用规则但不伪造护航接单

- 新增客服动作：对 `paid` 且无履约人的订单，选择一位合格护航 **指派接单**。
- 不复用 `acceptDispatch()`：那个入口是**护航本人**接单的语义，会写
  `companion_accept_events`（接单事件属于护航行为）。让客服调用它等于伪造
  “护航本人接过这一单”，会把审计与后续统计带偏。
- 因此新增专用事务（PG：`assignOrderCompanionByStaffPg`；Mock：同构实现），
  一个事务内完成：派单 `accepted`（`accepted_via='staff'`）→ 订单 `accepted`
  （回填履约人快照与 `acceptedAt`）→ 通知 → 写 `order.assign` 审计
  （actor role = `customer_service`）。**不写** `companion_accept_events`。
- 资格、专属池、接单开关、截止时间、禁止自接单等规则与 `acceptDispatch()`
  完全一致；实现上是同一组校验，不是第二套状态机。
- 客服不获得“任意跳状态”接口；`serving/completed/refunded` 仍由既有
  护航流程、完成材料审核、退款审批产出。
- 回池/换人/完成审核继续沿用既有路径；本轮新增的指派动作有 `order.assign` 审计。
- 所有非法跳转沿用现有明确 400 文案。

**理由**：不新造第二套状态机，也不把客服动作伪装成护航动作；满足
“客服接单/处理/更新状态”的最小真实闭环。

### D6 · 迁移风险等级与执行前提

`0017_real_auth.sql` 只新增表与索引，不改既有列、不搬数据、不删数据；
数据风险等级为低，部署后如出现问题可回滚应用版本，新增表保持存在且不影响旧代码。

**但它不能只靠日常发布执行**：`chaoge-deploy deploy` 只从 root 拥有的
`/usr/local/lib/chaoge/src` 快照运行迁移，而该快照只能由一次性安装器更新。
因此让 0017 生效需要：

1. 本地完成代码、测试、commit；
2. 生成包含新 `src/` 与 `deploy/trust/migration-code.sha256` 的新 bundle，
   人工校验 SHA-256；
3. **重新运行一次 root 安装器**（高权限步骤，需产品负责人明确授权）；
4. 再走日常 `chaoge-deploy deploy`，由它以 migrator 身份执行 0017。

安装器是幂等的：沿用现有数据库角色口令、不重建/不清空 `chaoge_staging`，
只替换 root 快照与受控脚本，并附带一次 bundle manifest 校验。授权后仍需
在部署前后各做一次数据量核对。

---

## 三、明确不做（本轮）

- 不接真实微信登录 / 微信支付。
- 不做短信验证码、找回密码、登录限流（记录为公网开放前条件）。
- 不做客服按人分摊订单（需求未定义，不自行发明）。
- 不做管理员直接修改订单状态（既有设计禁止，状态由业务动作产出）。
- 不改 `chaoge_prod`、不重置 `chaoge_staging`、不扩大公网写权限。
