# Staging 公网只读预览 · Nginx 反向代理

> 状态：**配置与脚本已就绪，尚未安装。** 安装 Nginx 与在腾讯云放行 80 端口
> 都属于系统级变更，必须先获得产品负责人的一次性明确批准。

## 目标

让公网访客无需 SSH 隧道即可浏览 Staging 的展示页面：

```
Internet :80 → Nginx → 127.0.0.1:3000 (chaoge-staging / Next.js)
```

- 只新增 80 端口；SSH 保持原样。
- Next.js 仍只监听 `127.0.0.1:3000`，PostgreSQL 仍只监听 `127.0.0.1:5432`。
- `DATA_SOURCE=postgres`、现有 systemd 单元、受控入口 `chaoge-deploy` 均不改变。
- 公网只读：不能登录、不能切换 Mock 身份、不能下单/支付/退款/改后台数据。
- 私有 Staging（SSH 隧道）能力保持不变。

## 两层防护，各自独立成立

公网请求与隧道请求进入**同一个** Next.js 进程，来源 IP 无法可靠区分。
因此不是「只靠 Nginx 挡路径」，而是两层使用**同一份白名单**：

### 第一层：Nginx 显式白名单（`chaoge-public.conf`）

- 只有列出的页面与六个只读 API 被 `proxy_pass`；其余一律 `return 404`。
- `proxy_set_header Cookie "";` 与 `Authorization ""`：公网请求即使携带
  `mock_user_id` / `mock_admin_id` / `mock_staff_id` 等 Cookie，也不会到达应用。
- 注入 `X-Chaoge-Public-Preview: 1`，供第二层识别公网请求。
- 返回 `X-Chaoge-Public-Proxy: 1` **响应头**，安装脚本据此确认请求确实经过
  本配置。默认站点同样返回 200，不能只凭状态码验收；`reload` 后旧 worker
  可能还会接几个请求。
- 安全响应头（nosniff / DENY / Referrer-Policy / Permissions-Policy /
  frame-ancestors）、限流（`limit_req` + `limit_conn`）、请求体上限 64 KB。

### 第二层：应用守卫（仓库根 `proxy.ts`）

- 只有请求头标记为公网预览时才生效；隧道请求没有该头，行为完全不变。
- 同一份路径白名单（`lib/config/publicPreview.ts`），只允许 `GET` / `HEAD`。
- 再次删除 `Cookie` / `Authorization`，即使 Nginx 配置被误改也不会透传会话。
- 公网请求不渲染「开发工具」Mock 身份切换面板
  （`app/(mobile)/layout.tsx`、商品详情页）。

Nginx 白名单被意外放开时，应用守卫仍会拒绝；应用守卫被误改时，Nginx
仍不会转发私有路径。两层都失效才会暴露，测试对两层都有断言
（`tests/publicPreview.test.mjs`）。

### 公网允许清单

页面：
`/`、`/category`、`/product/*`、`/companions`、`/companions/*`、
`/rank`、`/rank/companions`、`/agreements`、`/activities`、`/help`、
`/placeholder`，以及静态资源 `/_next/static/*`、`/_next/image`、`/mock/*`、`/favicon.ico`。

只读 API：
`/api/home`、`/api/catalog/products`、`/api/companions`、`/api/agreements`、
`/api/rankings/consumption`、`/api/rankings/companions`。

其余全部拒绝：`/admin`、`/staff`、`/companion`、`/orders`、`/mine` 等页面，
以及 `/api/auth/*`、`/api/admin/*`、`/api/staff/*`、`/api/companion/*`、
`/api/payments/*`、`/api/orders*`、`/api/debug/*` 等接口。

## 安装（需批准后、由 root 执行）

```bash
# 1. 在服务器上、仓库内执行
sudo bash deploy/proxy/install-public-proxy.sh
```

脚本会：

1. 若未安装则 `apt-get install nginx`（不装推荐包）；
2. 备份并停用 Ubuntu 默认站点；
3. 安装本目录配置到 `/etc/nginx/sites-available/` 并建立启用链接；
4. `nginx -t` 通过后才 reload/start；失败自动移除新配置；
5. 启用开机自启；
6. 本地验收：首页 200 且含「超哥电竞」、**不含**「开发工具」；
   `/api/home` 200；`/api/admin/dashboard`、POST `/api/auth/mock-login`、
   `/admin` 均 404；80 在听；3000/5432 仍仅回环。

此脚本**不碰**：腾讯云安全组 / 防火墙、UFW、iptables、SSH、sudoers、
数据库、应用发布目录、`chaoge-staging` 服务。

### 然后（人工、一次）

腾讯云控制台 → Lighthouse → 实例 → 防火墙 → 添加规则：

- 协议 **TCP**
- 端口 **80**
- 来源 **0.0.0.0/0**

顺序不能反：先装好并本地验证，再放行端口。

## 安装后验收

```bash
curl -I http://43.128.13.181/                                        # 200
curl -o /dev/null -w '%{http_code}\n' http://43.128.13.181/api/home  # 200
curl -o /dev/null -w '%{http_code}\n' \
  http://43.128.13.181/api/admin/dashboard                           # 404
curl -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://43.128.13.181/api/auth/mock-login                           # 404
```

再用 SSH 隧道确认私有能力未受影响：

```bash
ssh -N -L 3000:127.0.0.1:3000 <server>   # 本地访问 http://127.0.0.1:3000
```

隧道访问仍可看到 Mock 身份面板、访问管理端与全部 API——它没有公网标记头。

## 回滚

```bash
sudo bash deploy/proxy/rollback-public-proxy.sh
```

移除站点链接、停止并禁用 Nginx，80 不再监听；配置与备份保留在
`/etc/nginx/sites-available/chaoge-public.conf` 和
`/var/backups/chaoge-public-proxy/`。腾讯云 80 规则可保留（无监听即不可达），
也可在控制台删除。应用与 SSH 隧道不受影响。

## 日常更新与授权边界

公网开放后，**普通网站更新不需要重新授权**：代码提交、推送、CI 构建、
上传产物、`sudo -n /usr/local/sbin/chaoge-deploy deploy`、健康检查与回滚
都沿现有受控入口完成；Nginx 配置无需改动，也不会重启。

仍需人工批准：

- 修改本目录配置或重新运行 `install-public-proxy.sh` / `rollback-public-proxy.sh`
  （root 系统配置）；
- 修改腾讯云安全组 / 防火墙；
- 修改 sudoers、受控入口、安装器；
- 新装系统软件；
- 新的/有风险的数据库迁移，或任何删除数据库数据的操作。

## 与 HTTPS 的关系

当前只有 HTTP。公网预览是**匿名只读**，不传输任何登录凭据；
管理端与客服端的 Mock 登录 Cookie 在 production 下是 `Secure`，
本来就不会在纯 HTTP 下持久化。若后续需要公网 HTTPS，应另行设计
（域名 + 证书），不在本次范围内。
