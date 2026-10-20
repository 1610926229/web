# PROD-5 · 微信登录接入、认证体系完善与模拟支付保留

Round ID: PROD-5
Title: 微信网页扫码登录（用户 / 打手）、四端权限隔离与模拟支付保留
Status: AWAITING_ACCEPTANCE
Depends On: PROD-4（真实业务闭环）
Goal: 在现有认证体系上增量接入微信登录；四端身份严格隔离；保留 Mock 支付与订单闭环；为真实微信支付预留接口但不启用
Primary Domain: 认证 · 身份绑定 · 打手入驻 · 支付边界
Started At: 2026-10-19
Development Completed At: 2026-10-19
Accepted At:
Git Commit: 7fdf185adc4f44155d3181fc7a14444f8192d55b（实现 / 部署提交；最终验收提交待用户本人完成）

## 已部署

- Release `20261018T175352Z-7fdf185`
- 迁移 0018 已应用：共 18 个迁移 / 46 张表；bootstrap + isolation verify PASS
- 真实浏览器验收 23 / 23 PASS；重启后复验 6 / 6 PASS
- 公网 `http://43.128.13.181` 仍为匿名只读；微信登录 / 真实登录 / 下单 / 后台接口未开放
- 真实微信登录未配置（`realConfigured:false`）；真实微信支付保持禁用
- `chaoge_prod` 未触碰，`chaoge_staging` 未重置

## 文档

- `01-prompt.md`：原始任务与安全边界
- `02-decisions.md`：阶段 A 审计、D1–D8 决策
- `03-delivery.md`：实现、测试、部署与验收记录（阶段 B–F 产出）
- `04-acceptance.md`：人工验收清单与自动验收结果
- `evidence/`：19 张真实浏览器截图 + 浏览器 / 重启 / 公网边界 JSON

## 下一门槛

1. 产品负责人按 `04-acceptance.md` 在私有 Staging 人工验收；
2. 验收通过后由用户本人提交 Git，状态方可改为 DONE；
3. 真实微信登录需另行提供开放平台资质与三项配置；真实支付保持禁用。

## 关键约束

- 微信登录只适用于普通用户；打手通过既有「用户会话 + 入驻审核」获得资格；
- 客服 / 管理员永远使用系统账号密码登录；
- Mock 与真实微信 provider 完全分离；缺少真实配置时明确提示，绝不伪造成功；
- Mock 支付、订单事务与幂等逻辑不改；
- 真实微信支付未启用，不新增支付写接口；
- 公网保持匿名只读；不修改 `chaoge_prod`，不重置 `chaoge_staging`。
