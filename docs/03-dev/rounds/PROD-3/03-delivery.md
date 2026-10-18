# PROD-3 · 交付记录

**Status:** 全站巡检修复批次已发布；root 配置已由产品负责人授权安装，公网与私有复验全部通过
**Release:** `20261018T040809Z-dfaf06c`
**App Git SHA:** `dfaf06cd6bcdf1a148224d482adc69fa1058da34`
**Artifact SHA-256:** `261ab647a3f178343b62611ce235e2637607bab591ab7a71d7e8c83b6efaccdd`
**Database:** `chaoge_staging`（PostgreSQL），`chaoge_prod` 未触碰

## 已发布（首次 aa1c966，历史记录）

> 本节记录首次上线；后续发布与最终状态见文末「全站巡检与修复批次」及「第二轮」。

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

第 1 步已完成，回环全量验收见后文。验收时公网 80 已处于可达状态
（见「公网侧验收」），本轮未修改防火墙；若该规则不是产品负责人放行的，
请先确认来源与规则内容。

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
（SHA-256 `2a1a2bde…`），供以后重装/审计使用。

## 公网侧验收（TCP 80 已可达）

完成回环验收后，从开发机直接访问 `http://43.128.13.181/` 时发现公网 80
**已经可达**：`chaoge-public.access.log` 记录了来自 `59.57.232.97`、
`117.28.108.95`、`124.72.54.101` 等公网地址的请求。**这不是本轮开放的**；
本轮没有修改腾讯云安全组、UFW 或 iptables。若产品负责人尚未在控制台添加
80 规则，应确认该规则是否由其他人或既有配置放行。

公网侧实测（与回环结果一致）：

| 验收项 | 结果 |
|---|---|
| `GET /` | 200，标记头，47,527 字节，`<title>超哥电竞</title>`，无「开发工具」，无 `X-Powered-By` |
| `GET /api/home` | 200，标记头，响应体含 `"announcements"` |
| `GET /api/admin/dashboard` | 404 + 标记头，146 字节 |
| `POST /api/auth/mock-login` | 404 + 标记头，146 字节 |
| `/admin`、`/staff`、`/companion`、`/orders`、`/mine` | 全部 404 + 标记头 |
| `/api/orders`、`/api/payments/mock-confirm`、`/api/me` | 全部 404 + 标记头 |
| `POST /` | 405（应用守卫只允许 GET/HEAD） |
| `POST /api/home`，70,000 字节请求体 | 413 + 标记头（`client_max_body_size 64k` 生效） |
| CSS / JS / SVG | 200，`text/css` / `application/javascript` / `image/svg+xml` |
| 伪造 Cookie（`mock_user_id` / `mock_admin_id` / `mock_staff_id`） | 首页 HTML 与不带 Cookie **逐字节相同**（sha256 `c161d858…`），无 Mock 面板 |
| 安全响应头 | 8 个响应头齐全；`Server: nginx` 不带版本 |
| 429 / limiting | 0 条；error log 仅有本次故意触发 413 的 `too large body` 一条 |

**结论：公网入口已满足开放条件并通过公网验收。** 若 TCP 80 规则由产品
负责人有意放行，无需再操作；若不是，请先确认该规则来源。

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

## 全站巡检与修复批次（2026-10-18）

本轮用真实浏览器（Playwright 驱动本机 Edge，移动 390×844 / 桌面 1440×900）
巡检公网与私有隧道，并完成代码修复、CI、受控部署与公网复验。

### 发布

| 项 | 值 |
|---|---|
| Git 提交（应用） | `1674765eb7ab80625e34d9611d68fec40f2af538` |
| GitHub Actions | run `39088862203` · success |
| 产物 | `staging-standalone-1674765….tar.gz` |
| Artifact SHA-256 | `5b0bf95de21246eb0898fd1021de0e7b73fa83ead0c862d9d954d749c008d2f4` |
| Release | `20261018T021719Z-1674765` |
| 受控入口 | `sudo -n /usr/local/sbin/chaoge-deploy deploy` 通过；`BUILD_INFO` SHA 一致 |
| 服务/监听 | `chaoge-staging` active/enabled；仅 `127.0.0.1:3000`；PostgreSQL 仅回环 |
| 数据库隔离 | 部署自带 99-verify `OVERALL=PASS`；`chaoge_prod` 未触碰，`chaoge_staging` 未重置 |

### 分类结论

- **A 真实 Bug（已修）**：公网底部导航「订单/客服/我的」与首页快捷入口指向受保护
  路由，点击后 404。改为展示「暂不可用」占位页，安全白名单不放宽。
- **A 真实 Bug（已修）**：协议页五个页签在 390px 溢出（`overflow-x-auto`）。
  改为 `flex flex-wrap` 后实测 `scrollWidth == clientWidth == 366`。
- **B 预期安全阻断（保持）**：`/orders`、`/service`、`/mine`、`/join`、
  `/complaints` 及 `/api/orders`、`/api/me`、admin/staff/companion/payments/auth
  相关接口在公网一律 404。伪造 Cookie 不会获得身份。
- **C 缺失功能（明确提示）**：`/help`、`/placeholder` 显示「页面待实现」，
  不再用 404 伪装成故障。
- **D 数据问题（已核对）**：商品 id 为 `p-400w` 等连字符格式；护航 id 为
  `cp-demo`。此前巡检使用本地 Mock 的下划线 id，属于巡检脚本错误，不是站点 Bug。
- **待修（需 root 授权）**：`/companions` 301↔308 重定向环；订单/客服/打手
  专属池与订单池 React #441（`platform_config` 单行配置缺失）。

### 公网真实浏览器复验

| 范围 | 结果 |
|---|---|
| 公开页面 12 条（首页、分类、榜单、陪玩列表/详情、商品详情、协议、帮助、活动、占位） | 全部 200；0 console error、0 pageerror、0 资源 4xx/5xx、0 破图 |
| 底部导航 5 项 + 快捷入口 4 项 | 首页/分类正常；其余落到「暂不可用」占位；点单权益为「页面待实现」 |
| 受保护页面直接访问 6 条 | 全部 404（安全边界保持） |
| 刷新、后退、前进、深链 `/product/p-400w` | 均正常 |
| 移动端/桌面端 | 无横向溢出；协议页签 390px 实测不溢出 |
| 公网 HTTP 矩阵 50 条 | 50/50 通过（公开页面/API 200；危险接口 404；`POST /` 405；静态资源 200） |

> 巡检时本机 Edge 走了系统代理，曾出现偶发 502；使用 `--no-proxy-server`
> 后 12/12 稳定 200，Nginx 访问日志也无 502。这是本机网络代理问题，不是站点缺陷。

### 私有 Staging 真实浏览器复验（SSH 隧道 13000）

| 端 | 结果 |
|---|---|
| 用户端（18 条） | 我的、入驻、投诉、优惠券、收藏、评价、设置、资料、鸡腿、建议、榜单、分类、商品、陪玩列表/详情均 200；**订单、客服** 为 #441 |
| 管理后台（14 条） | 概览、商品、护航、入驻、退款、投诉、售后、类目、内容、评价、客服账号、优惠券、平台参数均 200；**订单** 为 #441 |
| 客服工作台（6 条） | 工作台、会话、退款、投诉、完成材料均 200；**订单** 为 #441 |
| 打手工作台（6 条） | 工作台、我的订单、收益、聊天均 200；**专属池、订单池** 返回 500（服务端 #441） |

`#441` 的共同根因是 `platform_config` 缺少 `id = 1` 的单行配置；派单超时扫描与
完成材料自动通过会在事务中读取该行并抛错。修复已在 `06-bootstrap-data.sql`
与 `99-verify.sql` 中完成并通过本地回归，但服务器上的 `/usr/local/lib/chaoge`
是 root 快照，需一次性重装受控入口才能让下一次 `deploy` 的 bootstrap 生效。

### 待人工授权的一次性 root 操作

以下两条命令均使用已上传、哈希固定的文件；已由产品负责人于 2026-10-18
授权执行，执行后的自动部署与复验见文末「第二轮」。

1. **重装 Nginx 配置（修复 `/companions` 重定向环）**

```bash
ssh deploy@43.128.13.181
sudo bash -c '
set -euo pipefail
TMP="$(mktemp -d)"
trap "rm -rf -- \"$TMP\"" EXIT
install -o root -g root -m 0600 /home/deploy/chaoge-proxy/install-public-proxy.sh "$TMP/install-public-proxy.sh"
install -o root -g root -m 0600 /home/deploy/chaoge-proxy/chaoge-public.conf "$TMP/chaoge-public.conf"
[[ "$(sha256sum "$TMP/install-public-proxy.sh" | cut -d" " -f1)" == "2a1a2bde392ba95aeac1063dfef29f7429acea04b0e7633ffa0a4d2cbb4b0551" ]]
[[ "$(sha256sum "$TMP/chaoge-public.conf" | cut -d" " -f1)" == "40a0449d6e8e186748167585f4d4bea7a94981477d9bfb6304b58d16079deed4" ]]
bash "$TMP/install-public-proxy.sh"
'
```

2. **重装受控入口（让新的 06 bootstrap 生效，修复 #441）**

```bash
sudo bash -c '
set -euo pipefail
BUNDLE=/home/deploy/prod2-deploy-bundle-1674765.tar.gz
EXPECTED=41f80ffb61dc430653ef45ec190c9d8b24a0dc6c009a1da9c4f25644955b6709
TMP="$(mktemp -d)"
trap "rm -rf -- \"$TMP\"" EXIT
install -o root -g root -m 0600 -- "$BUNDLE" "$TMP/bundle.tar.gz"
[[ "$(sha256sum "$TMP/bundle.tar.gz" | cut -d" " -f1)" == "$EXPECTED" ]]
tar -tzf "$TMP/bundle.tar.gz" | awk "/^\// || /(^|\/)\.\.(\/|$)/ { print \"unsafe: \" \$0; bad=1 } END { exit bad }"
tar -tvzf "$TMP/bundle.tar.gz" | awk "\$1 !~ /^[-d]/ { print \"unsafe type: \" \$0; bad=1 } END { exit bad }"
mkdir -m 0700 "$TMP/root"
tar -xzf "$TMP/bundle.tar.gz" -C "$TMP/root" --no-same-owner --no-same-permissions
bash "$TMP/root/deploy/entry/install.sh" --bundle-dir "$TMP/root"
'
```

两处都完成后，Claude 继续执行：

```bash
sudo -n /usr/local/sbin/chaoge-deploy deploy \
  /home/deploy/incoming/staging-standalone-1674765eb7ab80625e34d9611d68fec40f2af538.tar.gz \
  5b0bf95de21246eb0898fd1021de0e7b73fa83ead0c862d9d954d749c008d2f4 \
  1674765eb7ab80625e34d9611d68fec40f2af538
```

该命令会以新快照中的 06 执行 bootstrap（幂等插入 `platform_config.id=1`），
再用同一产物完成发布与 99-verify。

### 本轮质量门禁

| 命令 | 结果 |
|---|---|
| `pnpm test` | 2313 tests · 1897 pass · 0 fail · 416 skipped |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| GitHub Actions | `39088862203` success |
| 公网 HTTP 矩阵 | 50/50 |
| 公网真实浏览器 | 12 页面 + 15 导航/快捷入口 + 6 受保护探测 + 5 桌面路由，无应用错误 |
| 私有真实浏览器 | 44 条路由访问；仅 #441 相关 5 条失败 |

### 其他残余项

1. **Staging Mock 登录名单与 Postgres 数据不一致**：登录页列出 `u-1022` 等
   账号，但 `chaoge_staging` 只有 `u-1001`；点选不存在的账号会静默留在登录页。
   这是 staging 演示数据/UI 提示问题，不影响公网只读入口；建议后续在数据种子
   中补齐账号或在登录失败时给出提示。
2. **纯 HTTP**：公网匿名只读，不传凭据；HTTPS 另行设计。
3. 纯 HTTP 下浏览器会忽略 `Cross-Origin-Opener-Policy`，控制台出现一条
   Chromium 提示；这是协议限制，不是应用错误。

## 第二轮：root 授权后的复验与公网受限操作修复（2026-10-18）

### 1. 已授权的 root 配置生效

- `/etc/nginx/sites-available/chaoge-public.conf` 已更新为含 `location = /companions`
  的版本（SHA-256 `40a0449d…`）。公网实测：
  - `GET /companions` → **200**，0 次重定向；
  - `GET /companions/` → 308（单跳到 `/companions`），浏览器真实访问最终 200；
  - 原 301↔308 无限重定向消失。
- 受控入口已重装；再次执行 `chaoge-deploy deploy` 后 bootstrap 成功写入
  `platform_config`：
  - `06-bootstrap-data.sql` 自检通过；
  - `99-verify.sql` 的 `platform_config_1 = t`，`OVERALL = PASS`；
  - 迁移仍为 16 条、表 40 张，`chaoge_prod` 未触碰，`chaoge_staging` 未重置。

### 2. React #441 修复前后（私有隧道真实浏览器）

| 指标（48 次访问：4 登录页 + 44 业务路由） | 修复前 | 修复后 |
|---|---|---|
| HTTP 非 200 | 2（`/companion/exclusive`、`/companion/pool` 500） | **0** |
| 页面出现 #441 / 加载失败 | 4（用户订单、用户客服、管理订单、客服订单） | **0** |
| console error（不含 COOP 已知提示） | 10 | **0** |
| pageerror（未捕获异常） | 3 | **0** |
| 资源 4xx/5xx | 0 | **0** |

订单详情（用户 / 管理 / 客服）、客服会话、专属池、订单池、平台参数页均逐一
真实浏览器打开，无 #441、无 500、无控制台错误。管理端平台参数页正常渲染。

### 3. 本轮新发现并修复的 Bug（`dfaf06c`）

**P2 · 公网商品详情受限操作展示了模拟登录文案。**
游客在公网点击「客服 / 收藏 / 立即购买」时，登录浮层虽然已经没有模拟账号
选择器（服务端已关闭 Mock 登录），但仍显示「当前为开发阶段的模拟登录，不会
调用真实微信接口」，与公网只读策略矛盾，也没有告诉访客该功能暂不可用。

修复：商品页把 `publicPreview` 传给 `ProductPurchasePanel` → `LoginSheet`；
公网预览下浮层改为「暂不可用 / 该功能暂不可用 / 该功能仅对已登录用户开放，
公网预览暂不提供。请通过微信小程序访问完整功能」，按钮改为「返回」。
安全边界未改动：公网仍然不能登录、不能创建订单、不能支付。

- 提交：`dfaf06cd6bcdf1a148224d482adc69fa1058da34`
- CI：run `39095419722` success
- 产物 SHA-256：`261ab647a3f178343b62611ce235e2637607bab591ab7a71d7e8c83b6efaccdd`
- Release：`20261018T040809Z-dfaf06c`（上一版 `20261018T033708Z-1674765` 保留可回滚）
- 部署后私有限制/公网复验均通过。

### 4. 第二轮公网真实浏览器复验

| 范围 | 结果 |
|---|---|
| 公开页面 12 条（移动端）+ 5 条（桌面端） | 全部 200；0 console error、0 pageerror、0 破图、0 横向溢出 |
| 站内深链 20 条（8 个商品详情、榜单、协议、陪玩、占位页等） | 20/20 → 200；0 console error |
| 可点击按钮 21 次（规格、客服、收藏、购买、陪玩演示选择、分类筛选、榜单周期、协议页签） | 均产生预期反馈，0 崩溃、0 控制台错误 |
| 底部导航 5 项 + 快捷入口 4 项 | 公开项正常；受限项显示「暂不可用」；缺失功能显示「页面待实现」 |
| 刷新 / 后退 / 前进 / 深链 / 尾斜杠 | 全部正常；`/companions/` 单跳后 200 |
| 公网 HTTP 矩阵 45 条 | **45/45**：公开页面/API 200；受保护页面与危险 API 404；写入方法 405/404；全部响应带公网标记、无 `X-Powered-By` |
| 伪造 `mock_user_id` / `mock_admin_id` Cookie | 首页 HTML 不出现 Mock 身份面板，没有身份冒用 |
| 静态资源 | favicon、`/mock/*.svg`、`_next` 资源均 200；页面破图 0 |

### 5. 本轮验收结论

- **P0 / P1 / P2 代码 Bug：0 个未修复。**
- 原有 P0 安全暴露、权限绕过、数据破坏均无。
- 仍属「缺失功能」而非 Bug 的入口（均有明确提示）：
  - `/activities` 福利活动：页面待实现；
  - `/help` 帮助中心：页面待实现；
  - 首页快捷入口「点单权益」：页面待实现。
- 仍属「数据/运营内容未配置」而非代码 Bug：
  - 协议正文为空（页面显示「内容暂未配置」）；
  - 消费等级未配置（「我的」显示「等级配置暂不可用」，同时说明消费金额仍准确）；
  - 榜单当前周期没有已完成订单，显示空态而非错误；
  - Staging 登录名单中部分 Mock 账号在 Postgres 中不存在，点选会静默停留
    登录页（仅影响私有 Mock 登录，不影响公网）。
- 公网只读边界保持：登录、下单、支付、后台入口仍全部被 Nginx 与应用双重
  阻断；3000/5432 仍只在回环监听。

### 6. 第二轮质量门禁

| 命令 | 结果 |
|---|---|
| `pnpm test` | 2314 tests · 1898 pass · 0 fail · 416 skipped |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| GitHub Actions | `39095419722` success |
| 公网 HTTP 矩阵 | 45/45 |
| 公网真实浏览器 | 12 页面 + 20 深链 + 21 按钮 + 15 导航项，0 应用错误 |
| 私有真实浏览器 | 48 次访问 + 订单详情/池页深测，0 #441、0 500、0 控制台错误 |
