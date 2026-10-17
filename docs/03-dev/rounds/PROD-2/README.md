# PROD-2 · 受控 Staging 部署与最小权限凭据

**Round ID:** PROD-2
**Title:** 无需重复人工输入口令的受控 Staging 部署
**Status:** IN_PROGRESS——本地设计、代码、测试与安全审查完成；等待一次人工 root 安装与部署验收
**Started At:** 2026-10-17
**Primary Domain:** `deploy/**`、`tests/stagingEntry.test.mjs`、`tests/stagingDeploy.test.mjs`
**Primary State Transition:** 无业务状态机变更；只改变部署与凭据管理方式
**Production database:** **不修改 `chaoge_prod`**（脚本层硬拒绝，审查见 `03-delivery.md`）
**Artifacts:** 本地未执行最终部署；未修改服务器 sudoers/SSH/防火墙

## 一句话

> 把「反复输入 sudo 密码 + 数据库密码」改成「root 安装一次固定入口，
> 之后 `sudo -n` 自动部署」；凭据只存在于 root:root 0600 文件里，
> 部署调用者拿不到任意 root 命令。

## 结论

| 项 | 状态 |
|---|---|
| 受控入口 `/usr/local/sbin/chaoge-deploy` | 已实现（`deploy/entry/chaoge-deploy.sh`） |
| 一次性 root 安装器 | 已实现（`deploy/entry/install.sh`） |
| 严格 sudoers 规则 | 已实现（安装器写入并 `visudo -cf` 校验；**本轮未在服务器执行**） |
| 数据库口令 | 服务器生成、root:root 0600、不输出、不进 Git/CI |
| 产物校验 | SHA-256 + Git SHA + tar 结构 + 路径/链接 + `.env` 拒绝 |
| 迁移/应用账号隔离 | `chaoge_staging_migrator` / `chaoge_staging_app` |
| 生产库隔离 | 库名白名单 + 硬拒绝 `chaoge_prod` |
| 3000 端口 | systemd 与 `_common.sh` 双重绑定/实测回环 |
| 旧 bootstrap/finalize 流程 | 已废弃，启动即拒绝（保留历史代码） |
| `check-artifact` 权限边界 | 拒绝 root；普通用户按自身文件权限校验 |
| 旧日志敏感信息 | 安装器归档到 `root:root 0700`，不删除、不读取内容 |
| 安装前 sudo 审计 | 发现入口以外 `NOPASSWD` 即中止 |

## 文档

- `01-prompt.md`：本轮原始要求与安全边界
- `02-decisions.md`：D1–D10 设计决策与取舍
- `03-delivery.md`：实现、测试证据、威胁模型与残余风险
- `deploy/entry/README.md`：运维手册（一次性 vs 自动动作矩阵）
- `deploy/trust/README.md`：bundle 构建与一次性人工命令

## 下一门槛

1. 人工执行一次 `deploy/entry/install.sh`（唯一需要 sudo 密码的动作）。
2. 上传 CI 产物并以 `sudo -n chaoge-deploy deploy` 发布首版。
3. 人工验收：状态、监听地址、SSH 隧道页面、数据库隔离。
