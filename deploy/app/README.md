# 私有 Staging 部署手册（PROD-2 / Step 5.8.1）

> 本目录只负责**运行 Next.js 应用**。数据库角色的创建、迁移、授权与备份在
> `deploy/db/`，按那套 README 执行。两者共用 `/etc/chaoge/` 目录，但**互不依赖运行顺序**：
> 应用启动只需要「库已迁移 + 环境变量文件存在」。

## 1. 这一层是什么

把当前 Next.js 项目部署成一台**只监听回环地址**的私有 Staging：

| 能力 | 实现 |
|---|---|
| 构建 | GitHub Actions（`ubuntu-latest`）跑 `next build`，产出 standalone tar.gz |
| 服务器 | **不装 pnpm、不跑 next build**，只接收、解包、切换、重启 |
| 长驻 / 开机自启 | systemd `WantedBy=multi-user.target` |
| 异常重启 | systemd `Restart=always` + `RestartSec=5` |
| 版本化发布 | `releases/<时间>-<SHA>/` 不可变目录 + `current` 原子符号链接 |
| 失败回滚 | `install-release.sh` 健康检查失败自动切回上一版；`rollback.sh` 手动回滚 |
| 运行账号 | 独立的 `chaoge` 系统账号（nologin、不在 sudo 组） |
| 网络面 | **只监听 `127.0.0.1:3000`**，验收走 SSH 隧道 |

### 为什么构建要和服务器分开

服务器是 2 vCPU / 2GB，`next build` 在这台机器上会把内存吃满，并且需要
安装 pnpm 与完整的 `node_modules`——这些对「运行产物」毫无用处。
把构建放到 CI，服务器上只留下一个几十 MB 的 tar.gz 和一个 Node 进程，
故障面小得多。

### 为什么运行时目录不是 `/opt/chaoge-deploy`

源码目录 `/opt/chaoge-deploy` 由 root 管理（数据库脚本需要 root）。
把 Next.js 进程指向那个目录、再让它以非特权账号运行，会制造一个持续的权限矛盾：
应用需要读源码树，而源码树将来还要被 root 更新。

因此运行产物落在**另一棵独立的树** `/opt/chaoge-staging/`，由 root 写入、
`chaoge` 只读。两棵树没有任何写权限交叉。

## 2. 拓扑与目录

```
/opt/chaoge-deploy/                     源码（root 管理，本手册的脚本在这里）
  deploy/app/                           本目录
  deploy/db/                            数据库脚本

/opt/chaoge-staging/                    root:chaoge  0750
  releases/
    20261017T101500Z-f7ec35a/           root:root  0755 每个版本一个完整产物
      server.js
      node_modules/
      .next/
      public/
      BUILD_INFO
    20261017T090000Z-a9bfc0a/           ← 回滚目标
  current -> releases/20261017.../      ← 原子切换（root:root 符号链接）

/etc/chaoge/
  staging.secrets                       root:root  0600  ← 两个数据库角色口令
  staging.env                           root:root  0600  ← DATABASE_URL 等

/usr/local/sbin/chaoge-deploy           root:root  0755  ← 唯一受控入口
/usr/local/lib/chaoge/                  root:root  0755  ← 被入口调用的固定脚本
  app/ db/ src/                         src = root 拥有的迁移代码快照
/etc/sudoers.d/chaoge-deploy            root:root  0440  ← 单命令 NOPASSWD
/etc/systemd/system/chaoge-staging.service
```

## 3. 构建（GitHub Actions，手动触发）

产物必须绑定到一个**完整 40 位 commit SHA**，不接受分支名。

```bash
git rev-parse HEAD          # 取到 SHA
gh workflow run staging-build.yml -f commit_sha=<40位SHA>
gh run watch
gh run download -n staging-standalone-<40位SHA>
```

workflow 会依次执行：校验 SHA → 检出该 SHA 并复核 → `pnpm typecheck` →
`pnpm lint` → `pnpm test` → `build-standalone.sh` → 上传 artifact（保留 14 天）。

构建期**不需要任何生产凭据**：`DATA_SOURCE` / `DATABASE_URL` 都是运行期读取，
构建不连数据库。workflow 里也没有 `secrets.*`。

本地复现构建：

```bash
EXPECTED_SHA=$(git rev-parse HEAD) bash deploy/app/build-standalone.sh
```

> ⚠️ Next 的 standalone 输出会把仓库根目录的 `.env` / `.env.*` **原样复制**进去
> （实测 Next 16.3.4）。本地 `.env` 里通常有 `DATABASE_URL` / `TEST_DATABASE_URL`，
> 不处理就会随产物上传到服务器。`build-standalone.sh` 会先删除这些文件，
> 再断言一个都不剩；服务器上的配置只来自 `/etc/chaoge/staging.env`。
>
> ⚠️ pnpm 默认用符号链接组织 `node_modules`，Next 会把这些链接**按原样**复制进
> standalone，而它们是**构建机的绝对路径**。产物离开构建机后链接全部悬空，
> 实测表现为 `Cannot find module '@swc/helpers/...'`。
> 因此 `pnpm-workspace.yaml` 固定了 `nodeLinker: hoisted`（扁平真实目录，无符号链接）。
>
> 仍有**一个**链接是 hoisted 也去不掉的：Next 为服务端外部包生成的
> `.next/node_modules/pg-<hash> -> <构建机>/node_modules/pg`。
> `build-standalone.sh` 会把它改写为指向产物内部的相对链接，并断言不残留任何绝对链接。

## 4. 服务器一次性准备（受控入口）

从 PROD-2 安全整改起，服务器上只有一个 root 拥有的固定入口；`deploy` 只能
通过 sudoers 里**唯一一条**规则免密执行它：

```text
deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
```

初始化是**一次** root 操作：从人工校验过 SHA-256 的 bundle 运行
`deploy/entry/install.sh --bundle-dir <root 解压目录>`。安装器完成：

1. 校验 `deploy/trust/deploy-files.sha256` 与 `migration-code.sha256`；
2. 把固定入口、`_common.sh`、发布/回滚/环境脚本、SQL 安装到
   `/usr/local/lib/chaoge/`（root:root，deploy 只读）；
3. 把迁移源码安装到 `/usr/local/lib/chaoge/src`（root:root），并从
   `/home/deploy/chaoge-deploy-src/node_modules` 复制 `pg` 依赖；
4. 生成两个 64 位十六进制随机口令，写入 `/etc/chaoge/staging.secrets`
   （root:root 0600，内容不输出）；
5. 以 `runuser -u postgres` 建库 / 初始化 / 设置 SCRAM 校验子；
6. 原子写入 `/etc/chaoge/staging.env`（root:root 0600）与 systemd 单元；
7. 写入并 `visudo -cf` 校验 sudoers 单命令规则。

**初始化之后**，所有发布/回滚/状态查询都不再需要人工输入 sudo 或数据库口令：

```bash
sudo -n /usr/local/sbin/chaoge-deploy deploy   /home/deploy/incoming/staging-standalone-<SHA>.tar.gz <ARTIFACT_SHA256> <GIT_SHA>
sudo -n /usr/local/sbin/chaoge-deploy rollback
sudo -n /usr/local/sbin/chaoge-deploy status
```

> 旧的 `deploy/trust/bootstrap.sh` 与 `deploy/app/finalize-staging.sh` 已废弃，
> 仅保留用于历史取证与本地回归，脚本启动即拒绝运行（除非显式设置
> `CHAOGE_ENABLE_LEGACY_PROD2_FLOW=1`）。

### 4.1 版本与哈希不要混淆

| 名称 | 含义 |
|---|---|
| `GIT_SHA` | CI 产物的提交（40 位），必须与文件名和 `BUILD_INFO` 一致 |
| `ARTIFACT_SHA256` | 该 tar.gz 的 SHA-256（64 位） |
| bundle SHA-256 | **部署脚本**打包的哈希，只在一次性安装时人工核对 |

部署脚本的 Git 提交通常晚于产物提交。**不要**把部署脚本的提交写进
`BUILD_INFO`，也不要因为脚本版本变化而重新标记产物——服务器安装的必须是
已经构建、已经验证过的那一个产物。

### 4.2 手工排查（只读优先）

受控入口失败时先看 `/var/log/chaoge/chaoge-deploy.log`（root 写、deploy 只读）。
不要绕过入口直接改服务器状态；确需只读核对时：

```bash
sudo -n /usr/local/sbin/chaoge-deploy status
sudo runuser -u postgres -- psql -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'chaoge_staging%'"
```

任何手工修复都应回写成代码、测试与新的 bundle，再走安装器，而不是在服务器上
留下不可复现的改动。

### 4.3 Secure Cookie 限制（已知，不修改）

`NODE_ENV=production` 下管理端 / 客服端的会话 Cookie 带 `Secure`。
SSH 隧道是纯 HTTP，浏览器不会回传 `Secure` Cookie，因此**管理端 / 客服端的
Mock 登录在 `http://127.0.0.1:3000` 上不可用**；用户端 `mock_user_id`
不带 `Secure`，不受影响。

这是刻意保留的行为：为了「HTTP 隧道里能登录」而关闭 `Secure`，会把会话
Cookie 在 HTTPS 缺失时暴露出去。完整的管理端 / 客服端验收需要 HTTPS
（或后续接入真实登录）；当前 Staging 验收以用户端 + 只读接口为准。
日志位置：`/var/log/chaoge/{chaoge-deploy,install}.log`，`root:deploy 0640`，
deploy 只读、不可删除。

### 4.4 的环境变量文件

`/etc/chaoge/staging.env`，权限 `root:root 0600`，由受控入口经匿名 fd 原子写入。
systemd 以 root 读取后注入服务进程，服务账号无法直接读取文件。内容：

```
NODE_ENV=production
DATA_SOURCE=postgres
DATABASE_URL=postgresql://chaoge_staging_app:<URL编码口令>@127.0.0.1:5432/chaoge_staging
PG_POOL_MAX=5
ENABLE_MOCK_AUTH=true
ENABLE_MOCK_ADMIN=true
ENABLE_MOCK_STAFF=true
ENABLE_MOCK_PAYMENT=true
```

**库名与角色是硬守卫**：`setup-staging-env.sh` 只接受 `chaoge_staging*` 库与
`chaoge_staging_app` 角色；`chaoge_prod` / `chaoge_app` 在提示输入口令之前就被拒绝。
`install-release.sh` 在解包前再校验一次 `DATABASE_URL` 的角色、库名与回环地址。

**刻意不写 `HOSTNAME` / `PORT`**：systemd 的 `EnvironmentFile` 会覆盖 `Environment=`，
如果配置文件能写 `HOSTNAME`，一行误写就能把服务绑到 `0.0.0.0`。
绑定地址写死在 unit 的 `ExecStart` 里（`/usr/bin/env ... HOSTNAME=127.0.0.1`），
配置文件无法改变它。脚本在写入后还会**拒绝**含有 `HOSTNAME=` / `PORT=` 的文件。

## 5. 发布

```bash
# 本地：上传到 deploy 可写的固定上传目录
scp staging-standalone-<GIT_SHA>.tar.gz deploy@<server-ip>:/home/deploy/incoming/

# 服务器 / Claude 自动执行：受控入口（sudoers 已授权，无需口令）
sudo -n /usr/local/sbin/chaoge-deploy deploy \
     /home/deploy/incoming/staging-standalone-<GIT_SHA>.tar.gz \
     <ARTIFACT_SHA256> <GIT_SHA>
```

入口先做只读预检（不切换、不重启）：

```bash
/usr/local/sbin/chaoge-deploy check-artifact \
  /home/deploy/incoming/staging-standalone-<GIT_SHA>.tar.gz <ARTIFACT_SHA256> <GIT_SHA>
```

受控入口依次做：

1. 把产物复制到 root 拥有的 0700 临时目录（消除 TOCTOU），再校验
   SHA-256、Git SHA（`BUILD_INFO`）、tar 结构、路径与符号链接；
2. 以 `deploy` 身份、用 root 拥有的迁移快照执行数据库迁移；
3. 以 root 拥有的 SQL 写入最小测试数据并 `verify`；
4. 调用 root 固定库里的 `install-release.sh` 解包、原子切换 `current`、重启服务；
5. **实测**首页健康检查 + `ss -ltn` 确认只有回环地址；失败自动回滚。

产物要求：文件名 `staging-standalone-<40位SHA>.tar.gz`，位于
`/home/deploy/incoming/`，包含 `server.js`、`BUILD_INFO`、`node_modules/`、
`.next/static/`、`public/`，且不得含 `.env`。root 从不执行产物里的代码。

## 6. 回滚

```bash
sudo -n /usr/local/sbin/chaoge-deploy rollback       # 回到最近的非当前版本
```

受控入口**不接受**版本名参数；选择逻辑固定为「最近的一个非当前版本」。
`/usr/local/lib/chaoge/app/rollback.sh --list` 存在仅供 root 排查，deploy 无法
直接执行它。回滚不重新构建，只改符号链接并重启，因此是秒级且可重复的。

## 7. SSH 隧道验收

服务只监听 `127.0.0.1:3000`，**任何验收都必须经隧道**。

### 7.1 建隧道（本地终端保持不关）

```bash
ssh -N -L 3000:127.0.0.1:3000 deploy@<server-ip>
```

### 7.2 只读探测（另一个本地终端）

```bash
bash deploy/app/healthcheck.sh
# 等价于：
#   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
#   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/next.svg
#   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/favorites   # 期望 401
```

覆盖：页面、静态资源（验证 `public/` 与 `.next/static/` 都进了产物）、
未登录守卫（验证路由与鉴权都在）。

### 7.3 数据持久化（⚠️ 会写一条真实记录）

**前置：`users` 表必须有数据**，见 §8。没有数据时 mock 登录会返回 404。

```bash
B=http://127.0.0.1:3000
JAR=$(mktemp)

# 1) 登录
curl -sS -c "$JAR" -X POST -H 'content-type: application/json' \
     -d '{"userId":"u-1002"}' "$B/api/auth/mock-login"

# 2) 写入
curl -sS -b "$JAR" -X POST -H 'content-type: application/json' \
     -d '{"productId":"p-400w"}' "$B/api/favorites"

# 3) 在服务器上重启（重新走一次受控部署；deploy 没有直接 systemctl 权限）
ssh deploy@<server-ip> 'sudo -n /usr/local/sbin/chaoge-deploy deploy \
  /home/deploy/incoming/staging-standalone-<GIT_SHA>.tar.gz <ARTIFACT_SHA256> <GIT_SHA>'

# 4) 重启后读回（这一步证明数据在 PostgreSQL 里，不在进程内存里）
curl -sS -b "$JAR" "$B/api/favorites" | grep -o 'p-400w'

# 5) 清理
curl -sS -b "$JAR" -X DELETE "$B/api/favorites/p-400w"
rm -f "$JAR"
```

### 7.4 systemd 重启

```bash
ssh deploy@<server-ip> '
  sudo -n /usr/local/sbin/chaoge-deploy status
  ss -ltn "sport = :3000"
'
```

`ss` 的输出里**只允许出现** `127.0.0.1:3000`（或 `[::1]:3000`）。
出现 `0.0.0.0:3000` 或 `*:3000` 就是暴露到公网，必须立即停止服务。

### 7.5 开机自启

```bash
systemctl is-enabled chaoge-staging     # 期望 enabled
```

## 8. staging 数据从哪来（Step 5.8.2 已解决）

`db/migrations/0001～0016` 只建结构、不插数据。迁移完成后的空库会让
`POST /api/auth/mock-login` 返回 404（`users` 里没有 `u-1002`），三套 Mock 登录全部失效。

现在的答案是**独立的 staging 库 + 一份只插入的 bootstrap SQL**：

```bash
sudo deploy/db/staging/deploy-staging.sh bootstrap --database chaoge_staging
```

`deploy/db/staging/06-bootstrap-data.sql` 以 `chaoge_staging_app` 身份写入：

| 数据 | 用途 |
|---|---|
| `users` u-1001（默认 mock 用户）/ u-1002（持久化验收用户） | 用户端登录 |
| `admin_accounts` admin-1 | 管理后台 mock 登录 |
| `staff_accounts` staff-1 | 客服工作台 mock 登录 |
| `companions` cp-demo（挂在 u-1001） | 打手工作台 |
| `games` / `categories` / `products` / `product_specs` 各一条 | 商品详情与收藏链路 |

它不是 `pnpm db:seed`，也没有绕过它：

- `06` 由 psql 直接执行，不经过应用代码、不读 `NODE_ENV`；
- 只有 `INSERT ... ON CONFLICT DO NOTHING`，没有 UPDATE / DELETE / TRUNCATE；
- staging 的运行时仍是 `NODE_ENV=production`，`db:seed` 在该环境下依旧被拒绝；
- 数据库名守卫无条件拒绝 `chaoge_prod`，把 GUC 改成生产库名也一样拒绝。

`--persistence` 验收写的是 `chaoge_staging` 里的一条收藏（随后删除），
不会落到 `chaoge_prod`。重建 staging 时只需重建这一个库，生产库完全不受影响。

## 9. Mock 开关与私有 Staging

三套登录（用户 / 管理 / 客服）目前**全部是 Mock 实现**。把它们关掉，
staging 上就没有任何登录入口——这不是假设，是读代码得出的事实
（`lib/auth/*Session.ts` 在开关关闭时一律返回 null）。

因此 `staging.env` 默认开启：

| 变量 | 值 | 作用 |
|---|---|---|
| `ENABLE_MOCK_AUTH` | true | 用户端 mock 登录 / `mock_user_id` Cookie |
| `ENABLE_MOCK_ADMIN` | true | 管理端 mock 登录 |
| `ENABLE_MOCK_STAFF` | true | 客服端 mock 登录 |
| `ENABLE_MOCK_PAYMENT` | true | 模拟支付确认 |

**为什么仍然安全**：服务只绑 `127.0.0.1`，公网不可达；唯一入口是 SSH 隧道。
`install-release.sh` 在每次发布后都会用 `ss -ltn` 实测监听地址，非回环直接判失败。

**`ENABLE_MOCK_DEBUG` 刻意保持关闭**：它除了开放调试查询参数，还会开放
`POST /api/debug/reset`（清空进程内 Mock 存储）。staging 上没有人需要它。

关闭条件：接入真实登录后删掉那四行即可，无需改代码。

## 10. 安全边界自检

发布前逐条确认：

- [ ] `sudo -n /usr/local/sbin/chaoge-deploy status` 显示 sudoers 规则符合预期
- [ ] `/etc/chaoge/staging.secrets` 与 `staging.env` 都是 `root:root 600`
- [ ] `staging.env` 里没有 `HOSTNAME=` / `PORT=` / `ENABLE_MOCK_DEBUG=true`
- [ ] `staging.env` 的 `DATABASE_URL` 是 `chaoge_staging_app@.../chaoge_staging`
      （不是 `chaoge_app@.../chaoge_prod`）
- [ ] `deploy/db/staging/deploy-staging.sh verify`（受控入口 deploy 阶段内执行）通过
- [ ] `psql` 里 `has_database_privilege('chaoge_app','chaoge_staging','CONNECT')` 与
      `has_database_privilege('chaoge_staging_app','chaoge_prod','CONNECT')` 都是 false
- [ ] 服务账号 `chaoge` 不在 `sudo` 组、shell 是 `nologin`
- [ ] `systemctl cat chaoge-staging` 的 `ExecStart` 含 `HOSTNAME=127.0.0.1`
- [ ] `ss -ltn "sport = :3000"` **只有** `127.0.0.1` / `[::1]`
- [ ] 从公网直接访问 `http://<server-ip>:3000/` **超时**（不得 200）
- [ ] 产物里没有 `.env`（`tar -tzf ... | grep '\.env'` 无输出）
- [ ] `sudo -n /usr/local/sbin/chaoge-deploy check-artifact` 对产物返回通过
- [ ] `/usr/local/sbin/chaoge-deploy` 与 `/usr/local/lib/chaoge` 是 `root:root`，
      deploy 不可写；`/usr/local/lib/chaoge/src` 无组/其他用户可写路径
- [ ] `/etc/sudoers.d/chaoge-deploy` 是 `root:root 0440`，且只有一行
      `deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy`
- [ ] `/var/log/chaoge` 是 `root:deploy 0750`，日志文件 `0640`
- [ ] 迁移进程以 `deploy` 身份运行（部署日志「迁移完成」前可见 runuser 路径），
      root 未执行产物代码
- [ ] GitHub Actions 日志里没有任何连接串或口令

## 11. 故障排查

| 现象 | 先看哪里 | 常见原因 |
|---|---|---|
| 服务起不来，`status=1/FAILURE` | `journalctl -u chaoge-staging -n 100` | `staging.env` 缺字段 / 权限不对 / `DATABASE_URL` 连不上 |
| 日志出现「启动自检失败」 | `instrumentation.ts` | 某个域没有 Pg 实现（`DATA_SOURCE=postgres` 的 fail-fast） |
| 页面 200 但样式/JS 全 404 | `ls releases/<id>/public`、`.next/static` | 产物组装时漏拷（`build-standalone.sh` 会拒绝这种包） |
| mock 登录 404 + 「Mock 用户不存在」 | `users` 表行数 | 库是空的，见 §8 |
| mock 登录 404 + 「接口未启用」 | `staging.env` | `ENABLE_MOCK_AUTH` 没开 |
| 发布后健康检查失败并自动回滚 | `journalctl` + 上一版是否有同样问题 | 新版本本身有问题；回滚已生效，服务应已恢复 |
| `ss` 显示 `0.0.0.0:3000` | `systemctl cat chaoge-staging` | ExecStart 被改过，`HOSTNAME` 丢失 |
| 迁移报 `password authentication failed` | `/var/log/chaoge/chaoge-deploy.log` | 角色口令与 `/etc/chaoge/staging.secrets` 不一致；重跑 `deploy/entry/install.sh` 收敛即可（口令不输出） |
| `迁移代码目录不正确（缺少 package.json）` | `deploy/entry/install.sh` 是否装好 `/usr/local/lib/chaoge/src` | 受控入口固定使用该快照；重新运行安装器，不要手工传 `CHAOGE_APP_DIR` |
| `sudo -n ... 需要密码` | `/etc/sudoers.d/chaoge-deploy` | 规则缺失或被其它 sudoers 覆盖（如 `requiretty`）；重新运行安装器并核对 `visudo -c` |

## 12. 本地验证

不碰服务器也能验证的部分：

```bash
bash -n deploy/app/*.sh deploy/entry/*.sh deploy/trust/*.sh   # 语法
bash deploy/trust/generate-manifests.sh      # 重新生成两个 manifest（提交前）
EXPECTED_SHA=$(git rev-parse HEAD) bash deploy/app/build-standalone.sh
node --test tests/stagingEntry.test.mjs       # 入口/安装器安全不变量 + 产物校验
pnpm test                                     # 含 tests/stagingDeploy.test.mjs
```

产物结构验收（不启动服务）：

```bash
tar -tzf dist/staging-standalone-<SHA>.tar.gz | head -20
tar -tzf dist/staging-standalone-<SHA>.tar.gz | grep -E '^\./(server\.js|BUILD_INFO|public/|\.next/static/)'
```

> ⚠️ 本地启动 standalone 只能验证「进程能起、能响应」。
> 绑定地址、systemd 重启、开机自启、真实数据库往返**必须在服务器上验**。
