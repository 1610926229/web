# PROD-3 · 交付记录

**Status:** 应用侧守卫已发布并验证；Nginx 已在服务器安装并通过回环全量验收；等待腾讯云放行 TCP 80
**Release:** `20261017T172639Z-aa1c966`
**App Git SHA:** `aa1c9663b0d6cc1b33add82f68a68dd35dd8ad2b`
**Artifact SHA-256:** `b2da92ffbec258246f51774511f23d88ce83a4574e638904c5a4d138d002d741`
**Database:** `chaoge_staging`（PostgreSQL），`chaoge_prod` 未触碰

## 已发布

受控入口 `sudo -n /usr/local/sbin/chaoge-deploy deploy` 完成：

- 产物 SHA-256、Git SHA、`BUILD_INFO`、tar 结构校验通过；
- 新版本目录 `releases/20261017T172639Z-aa1c966`，`current` 已切换；
- 健康检查通过，`chaoge-staging` active/enabled；
- 监听实测仍只有 `127.0.0.1:3000`；
- 上一个版本 `20261017T163758Z-8ad9d6b` 保留，可 `chaoge-deploy rollback`。

## 质量门禁

| 命令 | 结果 |
|---|---|
| `pnpm test` | 2307 tests · 1891 pass · 0 fail · 416 skipped（HTTP 用例需要 `APP_BASE_URL`；本机无 nginx 时真实配置测试跳过） |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `tests/publicPreview.test.mjs` | 29 tests · 28 pass · 1 skipped（真实 nginx -t，本机无 nginx） |
| `tests/stagingDeploy.test.mjs` | 58 tests · 56 pass · 0 fail · 2 skipped（POSIX 执行位） |

## 部署后实测（服务器回环）

| 请求 | 私有（无标记） | 公网标记（`X-Chaoge-Public-Preview: 1`） |
|---|---|---|
| `GET /` | 200，含「开发工具」面板 | 200，**不含**面板 |
| `POST /api/auth/mock-login` | 200（Mock 会话可用） | **405** |
| `GET /api/admin/dashboard` | 401（需管理员会话） | **404** |
| `GET /api/me` | 依赖会话 | **404** |
| `GET /api/home` | 200 | 200 |
| `GET /api/catalog/products?gameId=g-delta` | 200 | 200 |
| `GET /api/companions`、`/api/agreements`、两个榜单 | 200 | 200 |
| `GET /category`、`/product/p-400w`、`/companions`、`/rank` | 200 | 200 |
| `GET /_next/static/...css` | 200 | 200 |
| `GET /admin`、`/staff`、`/companion`、`/orders`、`/mine` | 正常路由 | **404** |

首页 API 数据：公告 2、活动图 1、快捷入口 4、两个分区共 8 个商品。

## 一次性授权记录（安装已完成）

1. **安装 Nginx（root，已执行；2026-10-18 第二次安装成功启用）**

   当前生效配置与本地一致；安装器的验收探针 bug 已修复（见后文），
   **不需要重新执行安装**。已上传到 `/home/deploy/chaoge-proxy/`，
   与本地提交的哈希一致：

   ```
   0f85ae7f02a117869fe5eb3c4b5cce4ececb2cd0a81a193bf5bd0642b29a051d  chaoge-public.conf
   2a1a2bde392ba95aeac1063dfef29f7429acea04b0e7633ffa0a4d2cbb4b0551  install-public-proxy.sh
   7d8e3b8d7a8f89a58b6e306b8c7556f8bacd2aae2af2e70c68c5817cd8904b30  rollback-public-proxy.sh
   ```

   以下命令保留为将来重装/审计用的标准入口（需要一次性 sudo 密码）：

   ```bash
   ssh deploy@43.128.13.181
   sudo bash -c '
     set -euo pipefail
     TMP="$(mktemp -d)"; chmod 700 "$TMP"
     cp -a /home/deploy/chaoge-proxy/. "$TMP/"
     bash "$TMP/install-public-proxy.sh"
     rm -rf "$TMP"
   '
   ```

   脚本会装 nginx（如未装）、备份默认站点、安装配置、`nginx -t` 后启动并
   开机自启，并做本地验收。**不修改**防火墙、SSH、sudoers、数据库、
   `chaoge-staging`。失败时自动移除新配置，不会留下公网入口。

2. **腾讯云 Lighthouse 放行 TCP 80**（控制台，来源 `0.0.0.0/0`）。

第 1 步已完成，回环全量验收见后文；现在只剩第 2 步。放行前公网 80
实测不可达（8 秒超时），符合预期。

## 首次安装失败与修复（2026-10-18）

**现象：** `nginx -t` 报
`zero size shared memory zone "zone=chaoge_public_conn"`。
安装脚本按设计移除了新配置链接并恢复默认站点，没有启用公网入口。

**根因：** `limit_conn` 的语法是 `limit_conn <zone> <number>`，**没有**
`zone=` 前缀。配置误写成 `limit_conn zone=chaoge_public_conn 20;`，Nginx 把
`zone=chaoge_public_conn` 整个当作区名，找不到同名共享内存区，于是报
`zero size shared memory zone "zone=..."`。带 `zone=` 的是
`limit_conn_zone`、`limit_req_zone` 的声明和 `limit_req` 的引用。

**修复：** 改为 `limit_conn chaoge_public_conn 20;`，白名单与限流策略不变。

**回归测试：**

- 新增 Nginx 指令 tokenizer/parser，校验 `limit_conn` 恰好两个参数、区名
  不带 `zone=`、连接数为数字、引用的区已在 http 作用域声明；`limit_req`
  同样校验 `zone=` 引用。故意还原旧写法可稳定复现失败（mutation check）。
- 本机有 `nginx` 可执行文件时额外运行真实 `nginx -t`（临时配置、高位端口、
  临时日志目录），不依赖字符串断言。

**服务器验证：** 以 deploy 身份在临时 wrapper 中对修复后的配置执行真实
`nginx -t`（nginx/1.28.3，监听临时改为 18080 以避开非 root 绑定 80）：

```
nginx: the configuration file .../nginx.conf syntax is ok
nginx: configuration file .../nginx.conf test is successful
```

只读诊断确认：`sites-enabled` 仅恢复的 `default`；`chaoge-public.conf`
留在 `sites-available` 未启用；Nginx active/enabled；80 在监听（腾讯云
安全组仍阻断公网）；应用仍只在 `127.0.0.1:3000`。

## 第二次安装：验收误判（reload 竞态）

**现象：** `nginx -t` 通过、站点已启用、经 80 访问首页 200，但安装器的
字符串检查报「首页 HTML 里没有产品名超哥电竞」。

**只读证据（不是代理配置错误）：**

- 安装时段 `chaoge-public.access.log` **没有**安装器的请求；该文件随后
  只有我们排查时的 3 条 `GET /`（01:47:02、01:47:14）；
- 默认站点 `/var/log/nginx/access.log` 的 mtime 正是安装时刻 01:46；
- `sites-enabled` 已是 `chaoge-public.conf -> sites-available/...`，
  内容哈希为 `010c2211…`（修复了 limit_conn 的版本）；
- 当前经 80 的响应：`Server: nginx`（`server_tokens off` 只在本配置里）、
  本配置的 6 个安全响应头、`<title>超哥电竞</title>`；直连 3000 的响应没有
  这些头且带 `X-Powered-By: Next.js`；
- 经 80 的 HTML 47,527 字节，直连 3000 为 48,614 字节，差异来自公网标记
  导致不渲染 Mock 身份面板；两者标题一致。

**根因：** `systemctl reload nginx` 返回时旧 worker 仍可能继续接少量请求；
Ubuntu 默认站点同样返回 200。安装器原先「看到 200 就继续」，恰好命中默认
站点，随后单字符串检查失败。站点本身在毫秒级后已由新 worker 正确服务。
**验收竞态，不是代理错误。**

**修复：**

1. Nginx 增加**响应头** `X-Chaoge-Public-Proxy: 1`（`always`，200/404 都带）。
   只有 chaoge 配置会返回它，默认站点不会。
2. 安装器最多等待 20 秒，直到「200 + 专属响应头」同时成立；不再把任意 200
   当成成功。
3. 首页校验完整 `<title>超哥电竞</title>`；`/api/home` 校验响应体含
   `"announcements"`；私有接口的 404 也必须带专属响应头。
4. 失败时打印状态、标题、响应头与字节数，并明确「不要放行 80」。
5. 验收失败**不自动回滚**（`nginx -t` 失败才回滚），避免把「应用暂时不可用」
   误判成配置错误；诊断输出会提示当前站点仍启用及回滚脚本名。

**修复后在服务器上的真实 Nginx 1.28.3 验证**（deploy 身份、临时目录、
127.0.0.1:18080，不触碰系统配置）：

| 请求 | 结果 |
|---|---|
| `GET /` | 200，`X-Chaoge-Public-Proxy: 1`，`<title>超哥电竞</title>`，无「开发工具」 |
| `GET /api/home` | 200 + 标记头，响应体含 `"announcements"` |
| `GET /api/admin/dashboard` | 404 + 标记头 |
| `POST /api/auth/mock-login` | 404 |
| `GET /admin` | 404 |
| 直连 `127.0.0.1:3000` | 200，但**没有**标记头（证明标记只由 Nginx 添加） |

`nginx -t` 对修复后配置再次通过。

## 第三次安装：验收探针参数错位（`000000000`）

**现象：** `nginx -t` 通过、Nginx 运行、首页 200 且标题正确、无 Mock 面板、
`/api/home` 200、`/api/admin/dashboard` 404；随后安装器在
`POST /api/auth/mock-login` 验收处输出 `000000000` 并退出。

**根因：验收脚本的参数顺序错误，不是接口返回 000。**

旧的 `http_of()` 把**第一个**参数当作路径：

```bash
http_of() {
  local path="$1"; shift
  curl ... "$@" "$PUBLIC_URL$path"
}
```

而 POST 调用是 `http_of -X POST ... /api/auth/mock-login`。于是：

- `path` 变成 `-X`；
- curl 的 URL 变成 `POST`、`/api/auth/mock-login`（无主机）和
  `http://127.0.0.1-X`；
- 三个 URL 各失败一次，`-w '%{http_code}'` 各输出一个 `000`，拼成
  `000000000`；
- `2>/dev/null` 把 curl 的 28/3/28 错误全部吞掉。

本地用安装器原样的调用复现，得到完全相同的九位输出与 stderr：

```
curl: (28) Resolving timed out after 2001 milliseconds   # POST
curl: (3) URL rejected: Port number was not a decimal number between 0 and 65535
curl: (28) Resolving timed out after 2014 milliseconds   # 127.0.0.1-X
CODE=[000000000]
```

**服务器证据（请求根本没有到达 Nginx）：**

- 安装时段 `chaoge-public.access.log`（01:57:47）只有
  `GET /`、`GET /api/home`、`GET /api/admin/dashboard`；
  **没有** `POST /api/auth/mock-login`。
- 修正参数后手动探测（02:01:17）才出现第一条
  `POST /api/auth/mock-login`，状态 404、响应体 146 字节。
- `chaoge-public.error.log` 为 0 字节；日志中没有 429 或
  `limiting requests/connections`。

**安全结论的独立证明（不依赖 000）：**

| 请求 | 结果 |
|---|---|
| 经 Nginx：`POST /api/auth/mock-login` | **404**，146 字节，响应体是 Nginx 自带 404 页，带 `X-Chaoge-Public-Proxy: 1` |
| 直连 3000，带公网标记头 | **405**（应用守卫只允许 GET/HEAD） |
| 直连 3000，不带标记头 | **200** + `Set-Cookie: mock_user_id=...`（私有 Mock 登录正常） |

Next.js 里该路由确实存在：带标记时应用层返回 405，不带标记时返回 200。
因此经 Nginx 得到的 404 只能来自 Nginx 的 `location /api/ { return 404; }`，
请求**没有**进入 Next.js。版本号响应头也没有 `X-Powered-By`。

**修复（最小改动，不新增权限入口）：**

1. `http_of` 改为把**最后一个**参数当路径，前面的参数原样传给 curl；
   非路径参数直接报错。
2. `http_of` 只接受恰好三位的状态码，任何拼接输出（如 `000000000`、
   `200200`）统一归一为 `000`。
3. curl 的退出码写入临时文件（函数在命令替换的子 shell 中运行，普通变量
   传不回调用方），stderr 写入 `CURL_ERR`；`die_probe` 失败时打印二者。
4. 没有修改 sudoers、没有新增 `NOPASSWD ALL`、没有建立新的 root 入口：
   现有 Nginx 配置已正确安装，剩余验收全部可用非特权命令完成。

**回归测试（行为测试，不是字符串断言）：**

- 从安装器提取真实的 `http_of`，把安装器里的**每一条**验收调用
  （`/`、`/api/home`、`/api/admin/dashboard`、POST mock-login、`/admin`）
  对着真实本地 HTTP 服务执行，核对服务器实际收到的 method/path；
  POST 必须带 `{}` 与 `application/json`。
- 多 URL 输出必须归一为单个 `000`。
- curl 连接失败必须返回单个 `000`，并保留退出码与非空 stderr。
- `tests/publicPreview.test.mjs`：29 tests · 28 pass · 1 skipped（本机无
  nginx）。全量 `pnpm test` 结果见下。

## 服务器回环全量验收（最终）

以下全部在服务器上以 `deploy` 身份、经 `127.0.0.1:80` 完成；腾讯云 80
仍处于阻断状态，未执行任何 root 操作。

| 验收项 | 结果 |
|---|---|
| 首页 `GET /` | 200，`X-Chaoge-Public-Proxy: 1`，`<title>超哥电竞</title>`，47,601 字节，无「开发工具」 |
| `HEAD /` | 200 + 标记头 |
| `GET /api/home` | 200 + 标记头，响应体含 `"announcements"` |
| `GET /api/admin/dashboard` | 404 + 标记头，146 字节 |
| `POST /api/auth/mock-login` | 404 + 标记头，146 字节；访问日志证实到达 Nginx、未到达 Next.js |
| `GET /admin` | 404 + 标记头 |
| CSS | `/_next/static/chunks/3wfp51fmpvhlh.css` → 200，`text/css`，38,312 字节 |
| JS | `/_next/static/chunks/310vm2bl3xxpt.js` → 200，`application/javascript`，5,364 字节 |
| 图片 | `/mock/promo-activity.svg` → 200，`image/svg+xml`，2,114 字节 |
| 限流/错误日志 | 无 429、无 limiting、error log 0 字节 |
| Nginx systemd | `active (running)`，`enabled`；reload 成功 |
| 80 监听 | `0.0.0.0:80` / `[::]:80` |
| Next.js | 仅 `127.0.0.1:3000` |
| PostgreSQL | 仅 `127.0.0.1:5432` 与 `[::1]:5432`（均为回环） |
| 生效配置 | `sites-enabled/chaoge-public.conf` → `sites-available/...`，哈希 `0f85ae7f…` |
| 回滚演练 | 用真实 Nginx 1.28.3 在 18080 启动同一份配置：200 + 标记头；停止后端口关闭；移除站点后的配置 `nginx -t` 通过 |
| 回滚脚本 | 服务器上的哈希 `7d8e3b8d…` 与本地一致，`bash -n` 通过；备份目录 3 份均在 |

安装器修复后的探针在同一台服务器的临时 Nginx（18080）上逐项通过；
停止 Nginx 后探针返回 `000`，curl 退出码 7、stderr 非空——失败诊断也按
预期工作。

**当前不需要重新安装 Nginx**：生效配置没有变化，仍是 `0f85ae7f…`；
本次只修改了安装器的验收逻辑，已上传到 `/home/deploy/chaoge-proxy/`
（SHA-256 `2a1a2bde…`），供以后重装/审计使用。唯一剩余的人工动作是
在腾讯云控制台放行 TCP 80。

## 回滚

```bash
sudo bash /home/deploy/chaoge-proxy/rollback-public-proxy.sh
```

移除站点、停止并禁用 Nginx；应用与 SSH 隧道不受影响。配置与备份保留。

## 残余风险

1. 纯 HTTP：公网为匿名只读，不传输登录凭据；如需 HTTPS 另行设计。
2. 公网与隧道共用 Next.js 进程：已用两层独立白名单缓解，但若两层同时被
   误改仍会失守；`tests/publicPreview.test.mjs` 对两层都有断言。
3. Nginx 限流为单 IP `20r/s`（burst 60、并发 20），共享出口 IP 的群体可能
   触发 429，可据实际访问调整。
4. 公网可见的是 Staging 演示数据；不包含真实用户敏感数据。
5. 例行的受控脚本/SQL 更新仍需重跑 root 安装器（迁移快照固定绑定
   `APP_GIT_SHA`）。普通应用更新不需要。
