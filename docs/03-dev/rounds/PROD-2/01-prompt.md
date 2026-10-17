# PROD-2 · 原始请求（安全整改与受控部署）

把 PROD-2 的部署改造成无需反复人工输入 sudo 和数据库密码的自动化部署，
基于最小权限的凭据管理与受控部署机制。

要求：

1. 数据库密码保存在服务器受保护的位置，不放入 Git、聊天记录或 CI 构建产物。
2. Claude 不需要读取或输出数据库密码明文。
3. 不保存 `deploy` 用户的 sudo 密码。
4. 使用一个 root 拥有、普通用户不可写的固定部署入口，并评估配置严格限定该入口的
   sudoers 规则。
5. 受控部署入口只能操作 `chaoge_staging` 和 `chaoge-staging` 服务，不得接收任意
   Shell 命令、任意数据库名称、任意可执行路径。
6. 所有传入的构建产物必须经过 SHA-256、Git SHA 与结构验证。
7. 数据库迁移使用独立的 `chaoge_staging_migrator` 账号，应用运行使用
   `chaoge_staging_app`。
8. 不得修改 `chaoge_prod`，不得开放公网 3000 端口。
9. 审查现有 `finalize-staging.sh`、`bootstrap.sh`、`deploy-staging.sh` 和 systemd
   配置，避免通过可写文件、环境变量、符号链接等方式扩大权限。
10. 必须验证部署调用者无法通过参数注入或替换脚本获得任意 root 命令执行能力。

本轮边界（用户明确给出）：

- 先完成设计、本地代码、测试及安全审查。
- 本轮不直接修改 sudoers、不执行最终部署、不改生产数据库。
- 数据库密码由用户在安全的终端交互提示中输入，不进入 Claude 对话。
- 不配置 NOPASSWD ALL、不修改 sudoers、不关闭认证、不把密码写入脚本或日志。
- 只允许操作 `chaoge_staging` 与已批准的私有 Staging 部署资源。
- 最终报告说明哪些初始化动作需要人工授权一次、哪些后续动作 Claude 可以自动完成。
