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
| `pnpm test` | 2299 tests · 1884 pass · 0 fail · 415 skipped（HTTP 用例需要 `APP_BASE_URL`） |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `tests/publicPreview.test.mjs` | 21/21 通过 |
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
   4ce2f833c591adda0645f81363b5e197de12c181e4a26d9b082451f4fc492837  chaoge-public.conf
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
