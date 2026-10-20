# Acceptance

Status: **PARTIAL**

- 私有 Staging 功能与自动验收：**PASS**
- 公网 HTTPS 登录功能：**PENDING**（域名 / DNS / 443 / root 授权未提供）
- 微信真实平台授权登录：**NOT CONFIGURED**

Round: PROD-6 · 公网 HTTPS 登录
Deployed release: `20261020T123422Z-2b06b77`（App Git SHA `2b06b77272ae5eed36388f5603c4e4ce94ad4ae1`）
Private entry: SSH 隧道 `127.0.0.1:3101` → Staging `127.0.0.1:3000`
Public entry: `http://43.128.13.181`（仍为匿名只读；443 未开放）
Database: `chaoge_staging`（18 个迁移 / 46 张表）；`chaoge_prod` 未触碰

---

## A. 私有 Staging 自动验收（2026-10-20，PASS）

以下检查均已执行并通过；详细命令与结果见 `03-delivery.md` §三。

### A1. 公网路径策略

- [x] 公网 `GET /staff/login`、`/admin/login` → 200
- [x] 公网未登录 `GET /staff`、`/staff/orders` → 307 `/staff/login`
- [x] 公网未登录 `GET /admin` → 307 `/admin/login`
- [x] 公网未登录 `GET /api/staff/orders`、`/api/admin/dashboard`、`/api/me` → 401
- [x] 公网 `GET /api/home`、`/mine`、`/wechat-login` → 200
- [x] 公网 Mock / 调试 / 模拟支付路径 → 404
- [x] 公网交易面 `/orders`、`/checkout`、`/api/orders` → 404

### A2. CSRF

- [x] 登录 POST 缺少 Origin → 403
- [x] 登录 POST 跨站 Origin → 403
- [x] 登录 POST 同源 Origin 到达路由 → 401 / 200（取决于口令）

### A3. 登录限流

- [x] 同一身份同一 IP 连续 5 次错误口令 → 401 × 5
- [x] 第 6 次 → 429，`Retry-After: 900`
- [x] 成功登录只清身份计数，不清 IP 计数（单元测试覆盖）

### A4. 真实账号闭环（管理员）

- [x] 管理员账号密码在模拟公网请求下登录 → 200
- [x] 带会话访问 `/api/admin/dashboard` → 200
- [x] 退出 → 200，再次访问 → 401

### A5. 客服账号

- [ ] 客服账号密码在模拟公网请求下登录 → 当前 `.env.staging-e2e` 中的 `kefu-xiaoyu` 口令返回 **401**
      （账号存在且启用；口令已过期 / 不一致；**未重置该账号**）
- [ ] 需要产品负责人提供当前有效口令，或批准管理员新建一个测试客服账号后复验

### A6. 用户微信入口

- [x] 公网 `/api/auth/wechat/status` → `mockAvailable:false`、`realConfigured:false`
- [x] 私有对照 → `mockAvailable:true`、`realConfigured:false`
- [x] 公网登录拦截页只渲染微信入口，不渲染邮箱密码 / 注册 / Mock
- [ ] 真实微信扫码登录：**未配置，不可验收**

### A7. Nginx HTTPS 模板

- [x] 服务器临时目录 + 自签证书 + 非特权端口执行真实 `nginx -t` → successful
- [x] 未修改系统 Nginx、未 reload、未安装 certbot

---

## B. 公网 HTTPS 人工验收（PENDING）

前置条件（全部满足后才可开始）：

1. 已提供域名，A 记录指向 `43.128.13.181`；
2. 云安全组已放行 443（80 已可用；3000 / 5432 保持关闭）；
3. 产品负责人已明确批准 root 安装 certbot 与新的 Nginx 配置；
4. 已通过 `install-public-https.sh` 预检，并保留可回滚的旧配置备份。

安装命令（**需 root 授权后执行**）：

```bash
# 1. 将安装器与模板上传到服务器（普通部署账号；只是暂存，不执行）
scp -i ~/.ssh/chaoge_deploy \
  deploy/proxy/chaoge-public-https.conf.template \
  deploy/proxy/chaoge-proxy-public.inc \
  deploy/proxy/chaoge-proxy-session.inc \
  deploy/proxy/install-public-https.sh \
  deploy/proxy/rollback-public-https.sh \
  deploy@43.128.13.181:/home/deploy/incoming/prod6-https/

# 2. 预检（不需要 root，不会改配置）
ssh -i ~/.ssh/chaoge_deploy deploy@43.128.13.181 \
  'bash /home/deploy/incoming/prod6-https/install-public-https.sh \
     --server-name <域名> --email <证书通知邮箱>'

# 3. 经批准后，先把脚本复制到 root 拥有的目录，再执行
#    （避免 root 直接执行 deploy 账号可写的文件）
ssh -i ~/.ssh/chaoge_deploy deploy@43.128.13.181 '
  sudo install -d -o root -g root -m 0755 /etc/chaoge/public-https &&
  sudo install -o root -g root -m 0644 \
    /home/deploy/incoming/prod6-https/chaoge-public-https.conf.template \
    /home/deploy/incoming/prod6-https/chaoge-proxy-public.inc \
    /home/deploy/incoming/prod6-https/chaoge-proxy-session.inc \
    /etc/chaoge/public-https/ &&
  sudo install -o root -g root -m 0755 \
    /home/deploy/incoming/prod6-https/install-public-https.sh \
    /home/deploy/incoming/prod6-https/rollback-public-https.sh \
    /etc/chaoge/public-https/ &&
  sudo /etc/chaoge/public-https/install-public-https.sh \
    --server-name <域名> --email <证书通知邮箱> --apply
'
```

回滚（同样从 root 拥有的目录执行）：

```bash
ssh -i ~/.ssh/chaoge_deploy deploy@43.128.13.181 \
  'sudo /etc/chaoge/public-https/rollback-public-https.sh'
```

### B1. 无 SSH 隧道的普通设备

- [ ] 打开 `https://<域名>/staff/login`，页面 200，证书有效，无混合内容警告
- [ ] 打开 `https://<域名>/admin/login`，页面 200
- [ ] 直接打开 `http://<域名>/staff/login`，被 301 到 HTTPS
- [ ] 浏览器地址栏无「不安全」提示；响应头含 HSTS

### B2. 管理员

- [ ] 未登录直接打开 `https://<域名>/admin`，跳转 `/admin/login`
- [ ] 用真实管理员账号登录，进入后台概览
- [ ] 执行一次已授权的后台操作（例如查看订单 / 修改一条允许修改的资料）
- [ ] 退出登录后刷新，回到登录页；再次访问受保护接口返回 401

### B3. 客服

- [ ] 未登录直接打开 `https://<域名>/staff`，跳转 `/staff/login`
- [ ] 用**当前有效**的客服账号登录，进入客服工作台
- [ ] 执行一次已授权的客服操作（例如查看订单 / 回复会话）
- [ ] 退出登录后刷新，回到登录页；再次访问受保护接口返回 401

### B4. 负向检查

- [ ] 错误密码 → 401，文案不区分「账号不存在 / 密码错误」
- [ ] 连续 5 次错误后第 6 次 → 429，页面提示稍后再试
- [ ] 客服会话访问 `/api/admin/dashboard` → 401 / 403
- [ ] 管理员会话访问 `/api/staff/orders` → 401 / 403
- [ ] 未登录访问 `/api/staff/orders`、`/api/admin/dashboard` → 401
- [ ] `/wechat-mock`、`/api/auth/mock-login`、`/api/debug/**` → 404
- [ ] 用 `curl` 伪造跨站 Origin 的登录 POST → 403
- [ ] 从公网直接访问 3000 / 5432 → 连接失败

### B5. 用户微信入口

- [ ] `https://<域名>/mine` 未登录时只显示微信登录入口
- [ ] 微信状态接口返回 `realConfigured:false`、`mockAvailable:false`
- [ ] 页面明确提示「微信登录尚未配置」，不伪造成功
- [ ] 点击微信入口不会进入 Mock 页面

---

## C. 微信真实平台（NOT CONFIGURED）

| 项目 | 状态 |
|---|---|
| 开放平台网站应用 AppID | 未提供 |
| AppSecret | 未提供 |
| 授权回调域名 / `WECHAT_REDIRECT_URI` | 未提供 |
| 真实扫码登录 | **不可用** |
| 状态接口 | `realConfigured:false` |
| Mock 入口 | 仅私有 Staging 可用；公网强制隐藏 |

**不得把本节标记为完成。** 真实微信登录需要单独联调，且依赖公网 HTTPS 域名先就绪。

---

## D. 安全边界确认

- [x] 未修改 `chaoge_prod`
- [x] 未删除 / 重置 `chaoge_staging`
- [x] 未开放 3000 / 5432
- [x] 未修改 SSH、安全组、sudoers、root 配置
- [x] 未安装 certbot、未写系统 Nginx 配置（仅临时目录验证模板）
- [x] 未输出任何明文密码、数据库连接串或会话令牌
- [x] Mock 管理员 / 客服 / 身份冒用 / 支付接口未进入公网
- [x] `DATA_SOURCE` 仍为 `postgres`，未回退到 mock

---

## E. 结论

| 交付面 | 状态 |
|---|---|
| 私有 Staging 功能完成 | **YES**（代码 + 部署 + 模拟公网验收） |
| 公网 HTTPS 登录功能完成 | **NO**（等待域名 / DNS / 443 / root 授权） |
| 微信真实平台授权完成 | **NO**（未配置） |

在 B 节全部通过前，不得对外宣称「公网登录已上线」。
