# Acceptance

Status: PENDING

Round: PROD-4 · 真实业务闭环
Deployed release: `20261018T131303Z-909cfab`（App Git SHA `909cfaba070bb46e7fa717311b06942be67b6337`）
Private entry: SSH 隧道 `127.0.0.1:3100` → Staging `127.0.0.1:3000`；公网 `http://43.128.13.181` 保持匿名只读

## Manual Acceptance Checklist

以下步骤全部针对**私有 Staging**（经 SSH 隧道打开），公网不得出现登录/下单入口。

- [ ] 打开 `/orders`，切换到「注册」，用一个新邮箱注册；注册后直接进入订单页，
      浏览器 Cookie 中只有 `chaoge_user_session`，没有 `mock_user_id`。
- [ ] 退出登录，回到 `/orders` 用同一邮箱（可大写）登录；登录成功。
- [ ] 打开 `/product/p-400w`，选择「机密400万」规格，点击「立即购买」进入结算页；
      填写游戏内 ID 后点击「去支付」。
- [ ] 在测试支付页点击「模拟支付成功」；页面显示支付成功，进入订单详情后状态为「待接单/已支付」，
      金额与商品页一致。
- [ ] 刷新订单详情；订单号与状态不变。
- [ ] 打开 `/staff/login`，用客服账号登录（不再使用 Mock 账号选择器），进入客服工作台。
- [ ] 打开该订单，点击「指派护航」，选择一位护航并确认；订单变为「已接单」，
      页面不再提供非法状态按钮。
- [ ] 回到用户端刷新订单详情；能看到「已接单」，订单号一致。
- [ ] 打开 `/admin/login` 用管理员账号登录；在 `/admin/orders` 与订单详情中
      看到同一订单与「已接单」。
- [ ] 用另一个普通用户账号打开该订单 URL：页面显示「订单不存在」，直接请求
      `/api/orders/<id>` 返回 404。
- [ ] 公网 `http://43.128.13.181/` 首页与商品详情正常；直接访问 `/orders`、
      `/admin`、`/staff`、`/api/auth/login`、`/api/auth/register` 均为 404。
- [ ] 公网无法通过任何界面注册、登录、下单或进入后台。
- [ ] `chaoge_prod` 未被修改；`chaoge_staging` 未被重置，测试订单仍保留。

> 自动化已在 2026-10-18 走完上述流程（含服务重启后的持久化复验），
> 截图见 `evidence/`；本清单用于产品负责人独立复核。

## User Result

待用户填写/确认。

## Issues Found

无（自动验收阶段未发现未修复的产品缺陷）。

验收脚本自身曾有两处错误，已修复且不影响产品结论：

1. 初次断言把订单 id 前缀写成 `o_`，实际为 `ord_`；
2. 持久化阶段脚本从 `state.orderId` 读取订单 id，实际只存在于 `state.steps`，
   导致访问 `/orders/undefined`；修正后全部通过。

## Rework

无产品返工。

## Final Result

PENDING

## Git Commit

App: `909cfaba070bb46e7fa717311b06942be67b6337`
Docs: 待本轮文档提交后补充。
