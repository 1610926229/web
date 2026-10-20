# Acceptance

Status: PENDING

Round: PROD-5 · 微信登录接入、认证体系完善与模拟支付保留
Deployed release: `20261018T175352Z-7fdf185`（App Git SHA `7fdf185adc4f44155d3181fc7a14444f8192d55b`）
Private entry: SSH 隧道 `127.0.0.1:3101` → Staging `127.0.0.1:3000`；公网 `http://43.128.13.181` 保持匿名只读
Database: `chaoge_staging`（迁移 18 个 / 46 张表）；`chaoge_prod` 未触碰

## Manual Acceptance Checklist

以下步骤全部针对**私有 Staging**（经 SSH 隧道打开），公网不得出现微信登录 / 登录 / 下单 / 后台入口。

### A. 普通用户微信登录与身份绑定

- [ ] 未登录打开 `/mine`，页面显示登录拦截；微信入口文案为「模拟微信登录（Staging）」，
      没有把 Mock 伪装成真实微信。
- [ ] 点击入口进入 `/wechat-mock`，可见三个 Mock 身份；页面明确说明登录不授予任何角色。
- [ ] 选择「微信用户·阿超」后回到 `/mine`；浏览器 Cookie 中只有 `chaoge_user_session`，
      没有 `mock_user_id`，也没有客服 / 管理员 Cookie。
- [ ] 退出后用同一身份再次登录，仍是同一 `user.id`（个人资料与订单不丢）。
- [ ] 选择「微信用户·小目」登录，得到另一个独立用户，与阿超的 `user.id` 不同。
- [ ] 在用户会话下直接访问 `/admin`、`/staff`，均回到各自登录页；
      直接请求 `/api/admin/staff`、`/api/staff/orders` 返回 401。
- [ ] 构造带 `role=admin` / `companionId` 的微信登录请求，仍只得到普通用户身份。

### B. 打手绑定（不新增登录方式）

- [ ] 未绑定用户打开 `/companion`，显示「你还不是护航」，并说明微信登录不会自动获得接单权限。
- [ ] 用「微信用户·小陈」登录，进入 `/join` 提交入驻申请；提交后可在 `/join/status` 查看状态。
- [ ] 管理员账号密码登录后审批该申请；小陈刷新 `/companion` 可进入护航工作台。
- [ ] 护航身份使用的 `user.id` 与微信登录身份完全一致（没有第二套打手账号）。
- [ ] 未绑定的「小目」仍无法进入护航工作台。
- [ ] 已绑定但被下架的打手仍显示 `disabled` 并引导联系客服（如有可用测试数据）。

### C. 客服 / 管理员原有登录

- [ ] `/admin/login` 使用既有管理员账号密码登录成功，能进入后台概览。
- [ ] `/staff/login` 使用既有客服账号密码登录成功，能进入客服工作台。
      ⚠️ 自动验收时 `kefu-xiaoyu` 用 `.env.staging-e2e` 中的现有口令返回 401；
      该账号未被修改 / 重置。请在私下核对现有口令后确认。
- [ ] 管理员可以新建一个客服账号并设置密码；新账号可登录。
- [ ] 客服 / 管理员登录页没有微信入口；用微信用户会话无法进入两端。

### D. Mock 支付与订单

- [ ] 用普通用户进入商品详情，选择规格后进入结算页；金额由服务端重算。
- [ ] 填写游戏内 ID，提交支付请求，进入待支付结果页。
- [ ] 点击「模拟支付成功」，页面显示成功并生成订单。
- [ ] 进入订单详情，状态为「已付款」，金额与商品页一致；订单号可在订单列表查到。
- [ ] 刷新页面 / 重新登录后订单仍存在，状态不变。

### E. 服务重启后的持久化

- [ ] 重启后原用户会话仍有效（或重新登录后仍是同一用户）。
- [ ] 原订单仍存在，状态仍为「已付款」。
- [ ] 同一 Mock 微信身份重新登录仍解析为同一 `user.id`。
- [ ] 已审批的护航资格仍在，仍可进入工作台。
- [ ] 匿名访问 `/mine` 仍需登录。

### F. 公网边界与真实支付

- [ ] 公网 `http://43.128.13.181/`、`/api/home`、商品详情、`/companions`、`/rank`、
      `/agreements` 正常返回 200。
- [ ] 公网直接访问 `/wechat-mock`、`/wechat-login`、`/api/auth/wechat/*` 均为 404。
- [ ] 公网访问 `/admin`、`/staff/login`、`/mine`、`/orders`、`/checkout`、
      `/api/orders`、`/api/debug/reset`、`/api/admin/*`、`/api/staff/*`、`/api/auth/login`
      均为 404。
- [ ] 公网 POST 任何登录 / 下单 / 支付 / 管理写接口均为 404。
- [ ] 公网响应带 `X-Chaoge-Public-Proxy: 1`；3000 / 5432 端口公网不可达。
- [ ] 支付页只有「模拟支付成功 / 失败 / 取消」，没有真实微信支付入口。
- [ ] `chaoge_prod` 未被修改；`chaoge_staging` 未被重置，测试订单与用户仍保留。

## Automated Result

| 项目 | 结果 |
|---|---|
| 浏览器验收（23 项） | **23 / 23 PASS** — `evidence/browser-acceptance.json` |
| 重启后复验（6 项） | **6 / 6 PASS** — `evidence/post-restart.json` |
| 公网边界 | 白名单 GET 200；登录 / 后台 / 微信 / 写接口全部 404 — `evidence/public-boundary.json` |
| 单元 / HTTP 门禁 | 2411 用例 · pass 1946 · fail 0 · skipped 465（环境门禁） |
| PostgreSQL 门禁 | 280 用例 · pass 275 · fail 0 · skipped 5 |
| typecheck / lint | 均 exit 0 |
| 部署与迁移 | release `20261018T175352Z-7fdf185` · 迁移 18 · 表 46 · verify / isolation PASS |

截图：`evidence/01-…19-*.png`（用户登录、Mock 身份、权限隔离、打手绑定、
管理后台、客服工作台、结算、支付、订单、重启后）。

## User Result

待用户填写 / 确认。

## Issues Found

自动验收阶段未发现未修复的产品缺陷。

如实记录两项非产品缺陷：

1. 既有客服 `kefu-xiaoyu` 用 `.env.staging-e2e` 中的现有口令登录返回 401；
   未重置该账号，改用管理员新建的临时客服账号完成客服端验证（该临时账号已软删除）。
2. 安装器最后提示「服务尚未启动、没有发布过版本」，与实际运行状态不符；
   已按实际状态核对后继续，未触发任何重置。

验收脚本自身修复过的问题（不影响产品结论）：

- 环境文件解析正则漏掉数字，导致管理员登录缺少凭据；
- Secure Cookie 经 `http://127.0.0.1:3101` 隧道不发送，改为浏览器上下文内重写 Cookie；
- 登录 Client Component 水合未完成时填表，等待 `networkidle` 后重试；
- 客服创建接口要求白名单头像，补 `avatarUrl`；
- 支付接口断言路径写错，改为 `/api/orders/pay`；
- 订单刷新后读取早于渲染，改为等待订单号出现。

## Rework

无产品返工。

## Final Result

PENDING

## Git Commit

实现提交：`77401df`（功能）· `7fdf185`（信任清单）
人工验收通过后的最终提交：待用户本人完成。
