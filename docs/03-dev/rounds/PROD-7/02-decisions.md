# 02 · 决策与方案

Round: PROD-7
Date: 2026-10-20
Status: 设计完成；生产只读审计被权限阻塞；未执行任何生产写入

---

## 一、需求核对

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 产品规则是否完整 | 本方案不改变业务规则；只涉及环境隔离、部署与访问边界 |
| 2 | 前置状态是否明确 | 明确：`chaoge_staging` 继续运行；`chaoge_prod` 状态待人工只读审计 |
| 3 | 成功状态是否明确 | 生产应用独立运行于 `127.0.0.1:3001`，Mock 全关，库/账号/凭据独立，可回滚 |
| 4 | 失败状态是否明确 | 任一隔离验收失败即不切换公网；保持 Staging 现状 |
| 5 | 权限是否明确 | 生产安装、sudoers、Nginx、443、数据库初始化均需人工批准 |
| 6 | 金额是否明确 | 本方案不改变金额；`platform_config` 的派单/自动完成/投诉窗口值需产品负责人确认 |
| 7 | 幂等是否明确 | 部署入口按 release / SHA 幂等；数据库初始化脚本已有守卫与幂等设计 |
| 8 | 并发是否明确 | 不涉及；单机双进程 + 单 PostgreSQL 集群 |
| 9 | 通知是否明确 | 不涉及 |
| 10 | 是否存在 TBD | 是：`platform_config` 的生产取值、首次管理员身份、生产目录/域名/证书参数需产品负责人确认 |
| 11 | 与架构规范是否冲突 | 否；沿用 `deploy/` 既有分层与 `docs/02-tech-design/architecture-rules.md` |
| 12 | 与现有代码事实是否冲突 | 否；生产角色 `chaoge_migrator` / `chaoge_app` 已由 `deploy/db/` 设计，Staging 使用独立的 `chaoge_staging_*` |

---

## 二、本轮已确认的事实

- 服务器：腾讯云单机，2 vCPU / 1930 MB RAM / 2047 MB swap / 39 GB 磁盘（截至 2026-10-20）。
- 当前运行：`chaoge-staging`（`127.0.0.1:3000`，RSS ≈ 208 MB）、PostgreSQL（`127.0.0.1:5432`）、Nginx（`:80`）。
- `chaoge_staging` 已有 18 个迁移 / 46 张表；Staging 部署验收 `OVERALL PASS`。
- 生产应用尚未建立；`chaoge_prod` 的角色、迁移版本与数据量**本轮未能读取**（见 §七）。
- 会话实现：服务端生成随机不透明令牌，数据库只存 SHA-256；没有跨环境共享的签名密钥。因此只要生产/Staging 使用不同数据库，会话天然不可互用。
- Mock 开关读取 `process.env` 的精确字符串 `"true"`；未设置或设为其他值即为关闭。

---

## 三、资源测量与结论

### 3.1 测量（2026-10-20，Staging 空载 / 低负载）

| 项目 | 测量值 |
|---|---|
| CPU | 2 vCPU |
| 内存总量 | 1930 MB |
| 已用 | 738 MB |
| free | 143 MB |
| buff/cache | 1288 MB |
| available | **1191 MB** |
| Swap | 2047 MB（已用 69 MB） |
| 磁盘 `/` | 39 GB（已用 8.8 GB，可用 29 GB） |
| Staging `next-server` RSS | **208 MB** |
| PostgreSQL 进程 RSS 合计 | ≈ 80 MB（checkpointer / backend / writer） |
| systemd-journald | 95 MB |
| 腾讯云 agent（YDService / YDLive / barad） | ≈ 120 MB |

### 3.2 结论

**当前 2 GB 服务器可以同时运行两套 Next.js 应用 + 一个 PostgreSQL 集群，但余量有限，必须加约束与监控。**

- 第二个 Next.js 进程按 Staging 实测估计 **180–250 MB RSS**；两套合计约 400–460 MB。
- 启动后预计 available 仍有 **约 900–1000 MB**，加上 2 GB swap，足够低并发生产首期。
- 2 vCPU 是更紧的资源；不在服务器上构建（只接收产物）是硬约束。
- 磁盘充足：每个 release 约 100–200 MB，保留 5 个版本约 1 GB。

### 3.3 选择方案

| 方案 | 内容 | 结论 |
|---|---|---|
| **A. 同机双应用（推荐首期）** | Staging `:3000` + 生产 `:3001` + 同一 PostgreSQL 集群的两个独立库 | 成本最低、隔离足够；需设置连接池与内存上限 |
| B. 生产应用独立服务器 | 应用迁到新 2C2G/2C4G 机器，数据库暂留 | 隔离更强；增加运维与费用，当前非必需 |
| C. 数据库独立服务器 | PostgreSQL 迁出 | 当前规模不需要 |

**首期采用 A，不购买新服务器。** 触发升级的观察阈值：

- 持续 available < 300 MB，或 swap 使用持续 > 500 MB；
- 2 vCPU 持续 > 70%，或登录/首屏 p95 明显恶化；
- 真实微信登录与支付接入后并发显著上升。

达到任一阈值再评估 B（先加内存/升配，而不是直接买新机器）。

### 3.4 同机运行约束

- 两个应用都写死 `HOSTNAME=127.0.0.1`，端口分别为 `3000` / `3001`。
- `PG_POOL_MAX=5`（每套应用），避免两套连接池叠加打满 PostgreSQL。
- systemd 建议加 `MemoryHigh=512M`、`MemoryMax=640M`（生产与 Staging 各自），超限先回收而不是拖垮整机。
- 保留现有 2 GB swap；不新增构建任务到服务器。
- 监控：`systemctl status`、`ss -ltn`、`free -m`、`pg_isready`、磁盘、应用健康检查。

---

## 四、独立生产应用设计

### 4.1 目录与身份

| 项目 | Staging（现状） | 生产（拟建） |
|---|---|---|
| 发布目录 | `/opt/chaoge-staging/releases/<UTC>-<sha>` | `/opt/chaoge-prod/releases/<UTC>-<sha>` |
| current | `/opt/chaoge-staging/current` | `/opt/chaoge-prod/current` |
| 服务账号 | `chaoge` | **`chaoge-prod`**（独立 system 用户，nologin、无 home、无 sudo） |
| systemd | `chaoge-staging.service` | **`chaoge-prod.service`** |
| 监听 | `127.0.0.1:3000` | **`127.0.0.1:3001`** |
| 环境文件 | `/etc/chaoge/staging.env`（root:root 0600） | **`/etc/chaoge/prod.env`**（root:root 0600） |
| 日志 | journal `chaoge-staging` | journal `chaoge-prod` |

生产 unit 沿用 Staging 的加固项：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、`CapabilityBoundingSet=`、`RestrictAddressFamilies`、`UMask=0027` 等；`ExecStart` 中写死 `HOSTNAME=127.0.0.1 PORT=3001`，环境文件不允许出现 `HOSTNAME` / `PORT`。

### 4.2 生产环境变量（`/etc/chaoge/prod.env`）

```ini
NODE_ENV=production
DATA_SOURCE=postgres
DATABASE_URL=postgresql://chaoge_app:<URL-encoded-password>@127.0.0.1:5432/chaoge_prod
PG_POOL_MAX=5

# 四个 Mock 开关全部关闭（显式写 false，便于审计）
ENABLE_MOCK_AUTH=false
ENABLE_MOCK_ADMIN=false
ENABLE_MOCK_STAFF=false
ENABLE_MOCK_PAYMENT=false

# ENABLE_MOCK_DEBUG 刻意不写入（等同关闭；它会开放破坏性的 /api/debug/reset）
```

- 生产**不得**使用 `chaoge_staging_app`、`chaoge_staging_migrator` 或任何 Staging 口令。
- 不设置 `WECHAT_*`，直到真实开放平台凭据获批；此时 `realConfigured:false` 是诚实状态。
- 当前代码没有需要共享的会话签名密钥；会话令牌是随机不透明串，只存在于各自数据库的 `auth_sessions`。
- `prod.env` 由 root 拥有、0600；服务账号通过 systemd 注入读取，不能直接读文件。

### 4.3 生产部署入口

拟新增**独立**入口，不复用 Staging 入口：

| 项目 | 拟建 |
|---|---|
| 入口 | `/usr/local/sbin/chaoge-deploy-prod`（root:root 0755） |
| sudoers | `deploy-prod ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy-prod` |
| 部署账号 | `deploy-prod`（独立 SSH key / 独立 `incoming` 目录） |
| 迁移源码快照 | `/usr/local/lib/chaoge-prod/src`（root 拥有） |
| 日志 | `/var/log/chaoge-prod/` |
| 硬编码目标 | `chaoge_prod`、`127.0.0.1:5432`、`chaoge_migrator`、`chaoge_app`、`chaoge-prod`、`/opt/chaoge-prod` |

入口子命令与 Staging 对齐：`check-artifact` / `deploy` / `rollback` / `status`；产物命名 `prod-standalone-<sha>.tar.gz`。**新增 NOPASSWD 授权与 root 安装器都需要人工批准，本轮未执行。**

### 4.4 CI 与产物

- 新增手动触发 workflow（`workflow_dispatch`），绑定 GitHub Environment `production`，要求人工 reviewer；
- 构建步骤与 Staging 相同：typecheck / lint / tests / standalone build；
- 制品包含 `BUILD_INFO`（Git SHA、构建时间、Node/pnpm 版本），不含 `.env`；
- 产物 SHA-256 由人工核对后再交给生产入口；可选后续增加签名。

### 4.5 回滚

- 保留最近 5 个 release；`rollback` 把 `current` 指回上一个版本并重启；
- 部署失败自动切回上一个 release 并健康检查；
- 数据库迁移是前向的：应用回滚不自动回滚 schema；
- 每次部署前做 `pg_dump -Fc` 快照；若必须回滚 schema，只能在获批后从快照恢复（会丢失快照之后的写入）；
- 回滚后必须复验：`ss -ltn` 仅回环、健康检查、登录/只读页面。

---

## 五、生产数据库与首次初始化

### 5.1 角色与库

沿用 `deploy/db/` 已设计的生产角色（与 Staging 完全独立）：

| 角色 | 用途 | 权限 |
|---|---|---|
| `chaoge_migrator` | 迁移 DDL | LOGIN，非 SUPERUSER / CREATEDB / CREATEROLE / REPLICATION / BYPASSRLS；`public` 有 USAGE + CREATE |
| `chaoge_app` | 运行时 DML | LOGIN，同上无特权；`public` 只有 USAGE；表 SELECT/INSERT/UPDATE/DELETE；序列 USAGE/SELECT；无 DDL |

- 数据库 `chaoge_prod`，属主 `postgres`；`REVOKE CONNECT/TEMPORARY/CREATE ... FROM PUBLIC`。
- 口令随机生成，存入 `/etc/chaoge/prod.secrets`（root:root 0600），不复用 Staging 口令。
- 交叉隔离验收：`chaoge_staging_app` 不能 CONNECT `chaoge_prod`，`chaoge_app` 不能 CONNECT `chaoge_staging`；两组角色无成员关系。
- 初始化顺序：`deploy/db/deploy.sh check` → `backup` → `init`（需交互确认）→ 迁移 → 再跑 05 授权 → `verify`。

### 5.2 首次数据

迁移只建结构，不插数据。生产首启需要：

| 数据 | 处理方式 |
|---|---|
| `platform_config`（单行） | **产品负责人确认取值后插入**；Staging 当前值 10 / 60 / 10 / 1440 只能作为占位参考，不得直接视为生产决策 |
| 游戏 / 分类 / 商品 / 规格 | 从 Staging 现有目录中人工挑选，或由管理员后台录入；**盲拷全部 demo 数据不可接受** |
| 公告 / 轮播 / 快捷入口 / 协议 | 从 Staging 审核后复制，去掉 demo 文案与占位图 |
| 初始管理员 | 新建 `admin-prod-1`（角色 admin、enabled），口令由人工在终端输入，用现有 `lib/auth/password.ts` 生成 scrypt 哈希写入 `admin_credentials`；不写入 Git / 日志 / 聊天 |
| 客服账号 | 管理员登录后通过后台创建；不复用 Staging 的 `staff-1` / `kefu-xiaoyu` |
| 用户 / 订单 / 支付 / 优惠券 / 退款 / 投诉 / 评价 / 会话 / 审计 | **不迁移** Staging 演示数据 |

### 5.3 数据迁移规则（未来如需要）

- 只允许**表级白名单**：`games`、`categories`、`products`、`product_specs`、`agreements`、`announcements`、`banners`、`quick_entries`、`platform_config`；
- 使用 `pg_dump --data-only --inserts --table=<allowlist>`，在 Staging 侧导出，人工审阅后再导入；
- 导入前备份生产；导入在单事务内执行；导入后核对行数、外键、关键商品价格；
- 禁止 `TRUNCATE` / `DROP` / 全库覆盖；
- 任何真实用户/订单数据迁移必须另开 Round 并按《特殊情况与异常处理》确认口径。

### 5.4 生产只读审计现状

本轮以 `deploy` 账号尝试读取 `chaoge_prod` 时被权限拒绝：

- `/etc/chaoge`、`/var/backups/chaoge` 不可读；
- 无 `~/.pgpass`；peer 角色 `deploy` 不存在；
- `postgres` / `chaoge_staging_migrator` 需要口令；
- `sudo -n -l` 仅有单条 `chaoge-deploy` NOPASSWD 规则。

**因此没有读取或修改 `chaoge_prod`。** 需要的只读命令与验收清单见 `04-acceptance.md` §B。

---

## 六、Nginx 公网切换到生产应用（仅设计，当前不改）

### 6.1 目标拓扑

```
Internet :80/:443 → Nginx → 127.0.0.1:3001 (chaoge-prod)
                                  └─ chaoge_prod
Staging 127.0.0.1:3000 仅 SSH 隧道 / 私有访问，不接公网
```

### 6.2 配置改造点

现有 HTTPS 模板 `deploy/proxy/chaoge-public-https.conf.template` 把 upstream 写死为 `127.0.0.1:3000`。切换前需要：

1. 将 upstream 参数化（例如 `__UPSTREAM__`），安装器增加 `--upstream 127.0.0.1:3001`，只允许回环地址；
2. 保留 server 级 `X-Real-IP $remote_addr`、`X-Forwarded-For $remote_addr`（覆盖，而非追加）、`X-Forwarded-Proto $scheme`，并增加 `X-Forwarded-Host $host`；
3. 登录/工作台/用户入口保留 Cookie；公开只读路径继续清空 Cookie；
4. Mock / 调试 / 模拟支付路径继续 404；
5. 登录 API 继续使用独立 `limit_req`；应用层限流以 `X-Real-IP` 为准；
6. `location` 内不得再写 `proxy_set_header`，避免覆盖 server 级注入（现有模板已如此）。

### 6.3 切换顺序（未来获批后）

1. 生产应用与数据库完成隔离验收；
2. 域名 A 记录指向 `43.128.13.181`；安全组仅放行 80 / 443；
3. 准备 root 拥有的新站点配置与证书；`nginx -t`；
4. 备份当前站点配置；reload；
5. 从**无 SSH 隧道的外部设备**验收登录 / 只读边界 / 429 / 404；
6. 观察期保留旧配置与回滚脚本；Staging 仍可通过 SSH 隧道访问。

### 6.4 回滚

- 恢复上一份 Nginx 配置并 reload；
- 生产应用可 `chaoge-deploy-prod rollback`；
- 数据库回滚只在获批后从部署前快照恢复；
- 不删除 Staging，不把生产流量回切到 Staging（二者数据不同）。

**当前未修改系统 Nginx、未开放 443、未更改公网路由。**

---

## 七、安全边界与残余风险

- 生产四个 `ENABLE_MOCK_*` 全关；`ENABLE_MOCK_DEBUG` 不设置。建议生产部署入口在启动前做一次 env 断言：出现任一 `ENABLE_MOCK_*=true` 即拒绝部署（实现时需更新信任清单）。
- Staging 与生产使用不同 OS 账号、目录、systemd、库、角色、口令、部署入口与 sudoers 规则。
- 会话令牌不共享；生产与 Staging 的 `auth_sessions` 完全分离。
- 生产入口与安装器尚未实现；本次未新增 NOPASSWD、未执行 root 安装器。
- 残余风险：
  1. 生产入口产物认证仍依赖人工核对 SHA（与 Staging 相同的已接受风险）；
  2. 同机运行意味着一个进程的资源失控可能影响另一个；用 systemd 内存上限与监控缓解；
  3. 本机端口探测受本地网络拦截干扰，云安全组状态需在腾讯云控制台人工复核（见 `04-acceptance.md` §B）；
  4. 生产初始化时的人工口令输入是唯一一次明文接触点，必须在本机 TTY 完成。

---

## 八、需要人工批准的最小清单

1. **生产只读审计**：以 root / `postgres` 执行 `04-acceptance.md` §B 的命令，并把结果交回（本轮被权限阻塞）。
2. **生产环境创建**：新建 `chaoge-prod` 用户、`/opt/chaoge-prod`、`/etc/chaoge/prod.env`、`chaoge-prod.service`、生产部署入口与 **sudoers 新规则**；执行 root 安装器。
3. **生产数据库初始化**：`chaoge_prod` 建库/角色/授权、18 个迁移、备份目录与保留策略；确认 `chaoge_prod` 当前是否已有数据，避免覆盖。
4. **生产首批数据口径**：确认 `platform_config` 四个业务参数、目录/内容来源、初始管理员身份与口令输入方式。
5. **域名与公网**：提供域名与 A 记录，批准安全组放行 443、root 安装 certbot 与新 Nginx 站点；批准生产 upstream `127.0.0.1:3001`。
6. **生产 CI 与环境保护**：批准新增 workflow、GitHub Environment reviewer、产物审核方式。
7. **客服验收口令**：提供当前有效的客服口令，或批准新建一个测试客服账号（Staging `kefu-xiaoyu` 口令仍为 401）。
8. **腾讯云安全组人工复核**：确认 3000 / 3001 / 5432 未对公网开放，80 / 443 仅按计划放行。
9. **信任清单更新**：实现生产入口/模板后，按顺序重新生成 `deploy/trust/*.sha256`；root 快照更新需单独授权。
10. **执行切换**：生产 DB 初始化、首次部署、公网 Nginx 切换均需逐项明确批准后执行。
