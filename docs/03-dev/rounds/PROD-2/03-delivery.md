# PROD-2 · 交付与安全审查

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `deploy/entry/install.sh` | 一次性 root 安装器 |
| `deploy/entry/chaoge-deploy.sh` | 受控入口：`deploy` / `rollback` / `status` / `check-artifact` |
| `deploy/entry/README.md` | 运维手册与人工/自动动作矩阵 |
| `deploy/trust/README.md` | bundle 构建与 TOCTOU 安全的一次性人工命令 |
| `deploy/trust/generate-manifests.sh` | 重新生成两个 manifest（含 `deploy/entry/*`） |
| `tests/stagingEntry.test.mjs` | 入口/安装器静态安全不变量 + 产物校验功能测试 |
| `tests/stagingDeploy.test.mjs` | 既有部署测试更新（root:root 0600、新文档路径） |
| `deploy/app/setup-staging-env.sh` | 目标目录符号链接防护、`/etc/<dir>/<file>` 约束 |
| `deploy/app/rollback.sh` | `--to` 版本名白名单 |
| `deploy/app/install-release.sh` | 安全相对链接 + 解包后真实路径复核 |
| `deploy/app/chaoge-staging.service` | 回环绑定、最小权限、无 capability |
| `deploy/trust/bootstrap.sh`、`deploy/app/finalize-staging.sh` | 已废弃，启动即拒绝 |

## 2. 十项要求的落点

| # | 要求 | 实现 | 证据 |
|---|---|---|---|
| 1 | 口令不在 Git/聊天/CI | `/etc/chaoge/staging.secrets` root:root 0600；`openssl rand` 服务器生成 | `install.sh` §4；测试 9/15 |
| 2 | Claude 不读/输出明文 | 无任何 `echo` 口令路径；SCRAM 校验子经 stdin；日志只打印变量名 | `install.sh` §4/§5；测试 15 |
| 3 | 不保存 deploy sudo 密码 | 安装后使用 `sudo -n`；无密码文件、无 expect | sudoers 单命令规则；测试 12 |
| 4 | root 固定入口 + 严格 sudoers | `/usr/local/sbin/chaoge-deploy` 0755 root:root；一行规则；`visudo -cf` | 测试 12/13 |
| 5 | 只操作固定库/服务 | 常量写死；子命令与参数个数严格；不接受库名/服务名/路径 | 测试 1/2/3 |
| 6 | 产物三重校验 | SHA-256 + BUILD_INFO Git SHA + tar 结构/路径/链接 | 测试 5/6/7/8/17–21 |
| 7 | 迁移/应用账号隔离 | migrate 以 `deploy` 读取 root 快照；systemd `User=chaoge` | 测试 10/11 |
| 8 | 不动 prod、不暴露 3000 | 库名白名单 + `chaoge_prod` 硬拒绝；`HOSTNAME=127.0.0.1`；发布后实测 | `deploy-staging.sh`；测试 11；unit |
| 9 | 审查旧脚本/systemd | 旧脚本硬停；env 目录/文件拒绝符号链接；unit 加固 | 测试 13/14/16 |
| 10 | 无法参数注入/替换脚本 | 固定命令、固定参数、root 私有副本、root-owned lib | 测试 2/3/5/12/13 |

## 3. 威胁模型

### 3.1 攻击者能力假设

1. `deploy` 账号被完全控制（可上传任意文件、修改 `/home/deploy/**`、设置环境变量）。
2. 网络可被观察，但 SSH 与 PostgreSQL 均只在本机/加密通道。
3. 攻击者没有 root，也不能修改 `/usr/local`、`/etc`、`/opt` 下 root 拥有的路径。

### 3.2 关键攻击与防线

| 攻击 | 防线 |
|---|---|
| 在校验后替换产物（TOCTOU） | 先复制到 root 0700 私有目录，再校验/解包 |
| tar 路径穿越 / 绝对路径 | 条目检查 + 解包后 `realpath` 复核 |
| 符号链接逃逸 | 词法 + 真实路径双重检查；拒绝绝对/悬空 |
| setuid / 硬链接 / 设备 | tar 类型检查 + 解包后 setuid 清除与断言 |
| 产物带 `.env` 覆盖配置 | 显式拒绝 |
| 替换迁移脚本 | 迁移代码来自 root 快照，不来自产物 |
| 通过 sudo 执行任意命令 | sudoers 只有固定入口；入口不接受任意命令 |
| 参数注入库名/服务名 | 全部硬编码；`--database` 仅内部固定值 |
| root 跟随符号链接写文件 | `ensure_dir` 拒绝链接；安装前删除目标链接；env 路径检查 |
| 通过 env 文件改绑定地址 | 单元 ExecStart 写死；env 出现 HOSTNAME/PORT 即拒绝 |
| 公网访问 3000 | 绑定 127.0.0.1 + 发布后 `ss` 实测 + 失败回滚 |

## 4. 测试证据（本地）

```text
node --test tests/stagingEntry.test.mjs
# tests 23  pass 21  fail 0  skip 2（Linux 符号链接/执行位语义）

node --test tests/stagingDeploy.test.mjs tests/deployScripts.test.mjs tests/stagingDatabase.test.mjs
# tests 117  pass 114  fail 0  skip 3

bash -n deploy/entry/*.sh deploy/app/*.sh deploy/trust/*.sh deploy/db/staging/deploy-staging.sh
# SYNTAX_OK
```

`stagingEntry` 的功能用例用临时 tar.gz 验证：

- 合法产物通过；
- 错误 SHA-256 / 错误 Git SHA / 非法十六进制被拒绝；
- 缺 `server.js` / `node_modules` / `.next/static` / `public` 被拒绝；
- `.env`、绝对路径、`..` 被拒绝；
- 安全相对符号链接通过；绝对与 `../../../etc/passwd` 目标被拒绝（POSIX）。

## 5. 一次性人工授权 vs 后续自动执行

| 动作 | 执行者 | 人工输入 |
|---|---|---|
| 构建 bundle、上传 bundle / 产物 | Claude（deploy） | 否 |
| **运行 `install.sh`** | **人工（root）** | **sudo 密码（一次）** |
| 生成/保存数据库口令 | 安装器 | 否 |
| 建库、角色、权限、SCRAM | 安装器 | 否 |
| 写 systemd / env / sudoers | 安装器 | 否（sudoers 由安装器写入并校验） |
| `deploy` / `rollback` / `status` | Claude（`sudo -n`） | 否 |
| 测试、验证、只读诊断 | Claude | 否 |

> 本轮**没有**在服务器上执行安装器，也没有修改服务器 sudoers。sudoers 的写入
> 是安装器的一部分，必须在人工执行的那一次 root 操作中完成。

## 6. 残余风险（明确接受，需要产品/运维知情）

1. **产物来源未签名。** SHA-256/Git SHA 只证明调用者声明的产物未被改动，不能
   证明它来自可信 CI。deploy 可以部署任意应用代码（以 `chaoge` 身份运行）。
   建议后续加 CI 签名或人工核对。
2. **deploy 在迁移时短暂持有 migrator 连接串。** 迁移进程以 deploy 身份运行，
   连接串只在该子进程环境中；同 uid 进程理论上可读。迁移角色本来就是该进程的
   执行身份，不属于额外扩权。
3. **sudoers 规则无法限制参数。** 安全边界是入口的参数解析与硬编码；入口文件
   root:root 0755，deploy 不可写。
4. **root 固定库的可信性。** `/usr/local/lib/chaoge` 由 root 安装；能修改它的人
   已经拥有 root。
5. **端口 3000 的公网防护依赖环境。** systemd 只绑回环，但云安全组/主机防火墙
   不在本流程修改；部署环境必须确认没有公网映射。
6. **旧流程代码仍在仓库。** `bootstrap.sh` / `finalize-staging.sh` 保留但启动即
   拒绝；若有人显式设置 `CHAOGE_ENABLE_LEGACY_PROD2_FLOW=1`，仍可运行旧逻辑。
   这是人为逃生门，不是默认路径。

## 7. 未完成事项

- 在服务器上执行一次安装器（人工 sudo）。
- 上传首版产物并执行 `sudo -n chaoge-deploy deploy`。
- 人工验收：`status`、`ss` 回环、SSH 隧道页面、`chaoge_staging` 数据、生产库
  未被触碰。
