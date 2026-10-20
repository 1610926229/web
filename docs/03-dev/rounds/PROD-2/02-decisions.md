# PROD-2 · 设计决策

## D1 · 一个 root 拥有的固定入口，而不是给 deploy 更多 sudo 权限

**决定：** `/usr/local/sbin/chaoge-deploy` 由 root 拥有、0755，sudoers 只放：

```text
deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
```

**理由：** 需求 4/5/10。没有通配符、没有 `ALL` 命令、没有 shell、没有
`systemctl`/`psql` 直通。调用者能做什么完全由入口的子命令和硬编码目标决定。
参数注入无法改变数据库名、服务名、脚本路径或 Node 路径。

**代价：** 入口本身成为安全边界，必须由测试机械检查（`tests/stagingEntry.test.mjs`）。

## D2 · 安装与日常部署分离

**决定：** `deploy/entry/install.sh` 只在初始化时以 root 手工运行一次；
日常部署通过 `sudo -n` 调用固定入口。

**理由：** 需求 1/3。安装器做所有需要 root 的一次性动作（写 `/etc`、sudoers、
数据库角色、systemd），之后 Claude 不再需要 sudo 密码，也不需要数据库口令。

**代价：** 安装器本身必须防住「bundle 在人工哈希校验后被替换」与「root 跟随
deploy 可控符号链接」两类问题（见 D5/D6）。

## D3 · 数据库口令服务器端生成，明文不出现在任何输出

**决定：** 两个角色口令由 `openssl rand -hex 32` 生成，写入
`/etc/chaoge/staging.secrets`（root:root 0600）。设置数据库口令时，只在 Node 内
把明文转成 SCRAM-SHA-256 校验子，再通过 psql stdin 发送；明文不进 SQL、argv、
环境变量、日志或 Claude 对话。

**理由：** 需求 1/2、用户明确要求「由用户在安全终端输入 / 不让 Claude 看到」。
随机生成比人工输入更可控，也不再需要用户重复输入。

**代价：** deploy 在迁移时仍会短暂持有 migrator 连接串（迁移进程本身以 deploy
身份运行）；这是需求 7 的执行模型决定的，记录为残余风险。

## D4 · 运行时环境文件 root:root 0600

**决定：** `/etc/chaoge/staging.env` 由 root 读取并注入 systemd；
服务账号 `chaoge` 不能读取明文文件。

**理由：** 需求 1、最小权限。原先 `root:chaoge 0640` 会让应用账号直接拿到
数据库口令；应用只需要 systemd 注入的环境变量。

## D5 · 产物先复制到 root 私有目录，再校验与解包

**决定：** `deploy` 调用入口后，入口把产物复制到 root 拥有的 `mktemp -d`（0700），
后续 SHA、Git SHA、tar 结构与解包只针对该副本。

**理由：** 需求 6/10，消除 deploy 在「校验完成」和「root 使用」之间替换文件的
TOCTOU。校验后的副本 deploy 不可写。

**代价：** 多一次磁盘复制（上限 1 GiB），可接受。

## D6 · 迁移代码来自安装时固定的 root 快照

**决定：** 迁移代码不取自 CI 应用产物，而是安装器从人工校验过的 bundle `src/`
安装到 `/usr/local/lib/chaoge/src`（root:root，manifest 校验）。`pg` 依赖从
`/home/deploy/chaoge-deploy-src/node_modules` 复制后归 root，并校验链接不逃逸。

**理由：** CI standalone 产物不含 `package.json` / 迁移 CLI / alias hook；
若让部署产物提供迁移代码，deploy 就能替换迁移逻辑。快照把信任根固定在
「人工安装的那一次」。

**代价：** 迁移代码更新需要重新安装 bundle；这是刻意的。

## D7 · root 不执行产物或迁移代码

**决定：** root 只做校验、复制、解包、chown、原子切换和 systemctl；
迁移以 `deploy` 身份运行，应用以 `chaoge` 身份运行。

**理由：** 需求 7/9/10。即使产物是恶意代码，最高只能拿到 deploy / chaoge 的权限。

## D8 · 产物允许安全相对符号链接，但拒绝一切逃逸

**决定：** 不再「一律拒绝符号链接」（Next standalone 本身带合法链接），改为：

1. 解包前按 tar 条目做词法检查：相对目标、从链接所在目录出发不得越出产物根；
2. 解包后用 `realpath -m` 逐个复核，拒绝绝对、逃逸、悬空链接；
3. 拒绝硬链接、设备、FIFO、setuid/setgid、绝对路径、`..`、`.env*`。

**理由：** 真实产物必须能部署，同时不能把 tar 的链接语义直接交给 root。

## D9 · 旧 bootstrap/finalize 流程硬停

**决定：** `deploy/trust/bootstrap.sh` 与 `deploy/app/finalize-staging.sh` 在启动时
拒绝运行，除非显式设置 `CHAOGE_ENABLE_LEGACY_PROD2_FLOW=1`。

**理由：** 需求 9。旧流程接收 deploy 可写路径上的产物并让 root 执行，
与新模型冲突。保留代码用于历史取证与本地测试，但不再作为部署路径。

## D10 · systemd 绑定地址写死在 ExecStart

**决定：** `ExecStart=/usr/bin/env NODE_ENV=production PORT=3000
HOSTNAME=127.0.0.1 /usr/local/bin/node server.js`；env 文件中出现
`HOSTNAME=`/`PORT=` 直接拒绝。

**理由：** 需求 8。`EnvironmentFile` 会覆盖 `Environment=`，因此绑定地址不能
放在可被文件修改的位置；发布后还实测 `ss -ltn`，非回环即失败并回滚。
