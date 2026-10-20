# PROD-3 · 公网只读预览与自动化发布

**Round ID:** PROD-3
**Title:** 无需 SSH 隧道访问 Staging，并把日常发布收敛到受控入口
**Status:** IN_PROGRESS——代码、配置、测试完成；等待一次性人工授权（安装 Nginx + 放行 80）
**Started At:** 2026-10-18
**Primary Domain:** `proxy.ts`、`lib/config/publicPreview.ts`、`lib/auth/publicPreviewRequest.ts`、`deploy/proxy/**`、`tests/publicPreview.test.mjs`
**Primary State Transition:** 无业务状态机变更
**Production database:** **不修改 `chaoge_prod`**
**Artifacts:** Nginx 配置与安装/回滚脚本已就绪，**尚未在服务器执行**

## 一句话

> 公网 `:80` → Nginx（显式白名单 + 清 Cookie + 注入标记）→ `127.0.0.1:3000`；
> 应用层 `proxy.ts` 用同一份白名单再拦一次。只有匿名只读内容可见。

## 目标

1. 其他人无需 SSH 隧道即可通过 `http://43.128.13.181` 浏览首页、分类、商品、
   陪玩、榜单等公开内容；
2. 公网无法登录、切换 Mock 身份、下单、支付、退款、进后台或调用私有 API；
3. 私有 Staging（隧道）的完整开发测试能力保留；
4. 日常应用更新继续走 `sudo -n /usr/local/sbin/chaoge-deploy deploy`，
   不需要重复人工授权。

## 设计

| 层 | 位置 | 作用 |
|---|---|---|
| 边界 | 腾讯云 Lighthouse 防火墙 | 只放行 TCP 80（人工一次性） |
| 反向代理 | `deploy/proxy/chaoge-public.conf` | 路径白名单、方法/体积/限流、清 Cookie、注入标记 |
| 应用守卫 | `proxy.ts` + `lib/config/publicPreview.ts` | 同一白名单、仅 GET/HEAD、再次清 Cookie |
| UI 收敛 | `app/(mobile)/layout.tsx`、商品详情页 | 公网不渲染 Mock 身份面板 |
| 部署 | `chaoge-deploy deploy/rollback/status` | 沿用现有受控入口，无新增权限 |

### 为什么不是「只在 Nginx 封路径」

公网与隧道请求进入同一个 Next.js 进程，无法按来源 IP 区分。Nginx 配置一旦
被误改、或有其他入口绕过，只靠一层就会失守。因此应用层用 Nginx 覆盖写入的
`X-Chaoge-Public-Preview: 1` 识别公网请求，并用同一份白名单独立拒绝。
隧道请求没有该头，行为不变。

### 公网允许清单

页面：`/`、`/category`、`/product/*`、`/companions`、`/companions/*`、
`/rank`、`/rank/companions`、`/agreements`、`/activities`、`/help`、`/placeholder`。
API：`/api/home`、`/api/catalog/products`、`/api/companions`、`/api/agreements`、
`/api/rankings/consumption`、`/api/rankings/companions`。
静态资源：`/_next/static/*`、`/_next/image`、`/mock/*`、`/favicon.ico`。

## 自动化边界

无需人工批准、可自动执行：

- 代码修改、测试、lint、typecheck、commit、普通 push；
- CI 构建与产物校验（`.github/workflows/staging-build.yml`）；
- 上传产物、`chaoge-deploy check-artifact` / `deploy` / `rollback` / `status`；
- `demo-data`（只插入、幂等）；
- 健康检查与验收（经隧道与本机回环）。

必须人工批准：

- 首次安装 Nginx、修改 Nginx 配置、执行安装/回滚脚本（root 系统配置）；
- 腾讯云安全组 / 防火墙变更；
- 修改 sudoers、受控入口、安装器；
- 安装系统软件；
- 新的/有风险的数据库迁移，或任何删除数据库数据的操作。

## 文档

- `03-delivery.md`：实现、测试证据、验收清单与残余风险
- `deploy/proxy/README.md`：安装、验收、回滚与授权边界
- `deploy/entry/README.md`：受控入口的日常发布手册

## 下一门槛

1. 人工批准并执行 `sudo bash deploy/proxy/install-public-proxy.sh`；
2. 腾讯云控制台放行 TCP 80；
3. 完成 A4 公网验收，形成最终报告。
