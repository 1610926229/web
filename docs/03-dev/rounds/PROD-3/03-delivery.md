# PROD-3 · 交付记录

**Status:** 应用侧守卫已发布并验证；Nginx 安装与 80 端口放行等待一次性人工授权
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
| `pnpm test` | 2302 tests · 1886 pass · 0 fail · 416 skipped（HTTP 用例需要 `APP_BASE_URL`；本机无 nginx 时真实配置测试跳过） |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `tests/publicPreview.test.mjs` | 24 tests · 23 pass · 1 skipped（真实 nginx -t，本机无 nginx） |
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

## 一次性授权计划（尚未执行）

1. **安装 Nginx（root，人工输入一次 sudo 密码）**

   已上传到 `/home/deploy/chaoge-proxy/`，与本地提交的哈希一致：

   ```
   010c22113c6aac929bdff790f811e42d3fc35515f85aa1fd218fc9f845d9b5b4  chaoge-public.conf
   2abb7df6183d96297c5e50da4dfdaa66cebba7406c5ad98b2c8c9c22618a345a  install-public-proxy.sh
   7d8e3b8d7a8f89a58b6e306b8c7556f8bacd2aae2af2e70c68c5817cd8904b30  rollback-public-proxy.sh
   ```

   建议由 root 复制到私有临时目录后执行（避免 deploy 可写路径上的 TOCTOU）：

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

顺序：先第 1 步并在服务器本地验收，再第 2 步。当前公网 80 实测不可达
（8 秒超时），符合预期。

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
