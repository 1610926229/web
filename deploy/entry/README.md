# 受控部署入口（`/usr/local/sbin/chaoge-deploy`）

PROD-2 的服务器侧部署只经过两个文件：

| 文件 | 运行身份 | 作用 |
|---|---|---|
| `deploy/entry/install.sh` | root，**只运行一次** | 安装固定入口、固定库、凭据、数据库、systemd 与 sudoers |
| `deploy/entry/chaoge-deploy.sh` | root（经 sudoers），日常 | `deploy` / `rollback` / `status` / `check-artifact` |

安装后的布局：

```text
/usr/local/sbin/chaoge-deploy             root:root 0755
/usr/local/lib/chaoge/
  app/{_common.sh,install-release.sh,rollback.sh,setup-staging-env.sh,README.md}
  db/{deploy-staging.sh,01..99.sql}
  src/                                    root:root 迁移源码快照（含 pg 依赖）
/etc/chaoge/staging.secrets               root:root 0600
/etc/chaoge/staging.env                   root:root 0600
/etc/sudoers.d/chaoge-deploy              root:root 0440
/etc/systemd/system/chaoge-staging.service
```

## 一次性人工授权 vs 后续自动执行

| 动作 | 谁做 | 需要人工输入 |
|---|---|---|
| 构建并上传部署 bundle | Claude / deploy | 否 |
| **运行 `deploy/entry/install.sh`（sudo）** | **人工执行一次** | **是：sudo 密码** |
| 沿用数据库现有角色口令 | 安装器（真实 TCP 登录验证） | 无 secrets 文件时：终端输入现有口令（不回显） |
| 为尚无口令的角色生成口令 | 安装器 | 否（随机生成，不显示） |
| 建库 / 初始化 / 设置新角色口令 | 安装器（`runuser -u postgres`） | 否 |
| 写 secrets / env / systemd / sudoers | 安装器（root） | 否 |
| 上传应用产物 | Claude / deploy | 否 |
| `chaoge-deploy deploy` / `rollback` / `status` | Claude / deploy | **否**（`sudo -n`） |
| 数据库迁移 | 受控入口以 `deploy` 身份执行 | 否 |

安装器先读取 `pg_authid` 判断两个 staging 角色是否已有口令：

- 两个都有：只沿用，不生成、不 `ALTER ROLE`；有 secrets 文件就验证文件，
  没有就提示在终端输入现有口令并做真实 TCP 登录验证。
- 两个都没有：按新角色处理，随机生成口令并写入 secrets。
- 只有一个有：状态不一致，安装器中止，不做任何口令改写。

因此「保留已有 `chaoge_staging` 账号与密码」是安装器的硬约束，不是操作提醒。

一次性安装完成后，sudoers 中只有这一条规则：

```text
deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy
```

没有通配符、没有 `ALL` 命令、没有 shell、没有 `systemctl`、没有 psql。

## 命令

```bash
# 只读校验产物（必须由普通用户运行；root 会被明确拒绝）
/usr/local/sbin/chaoge-deploy check-artifact \
  /home/deploy/incoming/staging-standalone-<git-sha>.tar.gz <sha256> <git-sha>

# 部署（root；sudoers 允许 deploy 免密）
sudo -n /usr/local/sbin/chaoge-deploy deploy \
  /home/deploy/incoming/staging-standalone-<git-sha>.tar.gz <sha256> <git-sha>

# 回滚到最近的非当前版本
sudo -n /usr/local/sbin/chaoge-deploy rollback

# 只读状态
sudo -n /usr/local/sbin/chaoge-deploy status
```

入口的硬编码目标：`chaoge_staging`、`127.0.0.1:5432`、`chaoge_staging_migrator`、
`chaoge_staging_app`、`chaoge-staging`、`/opt/chaoge-staging`。调用者不能传库名、
服务名、可执行路径或版本名。

`check-artifact` **拒绝 root**（`id -u == 0` 直接失败）。sudoers 给 deploy 的
授权覆盖整个入口，如果允许 root 运行这个子命令，deploy 就能让 root 对任意
普通文件做 SHA-256 / tar 检查，形成文件读取 oracle。普通用户运行时，读取能力
完全受原有文件权限约束，不会获得额外权限。

## 产物校验

入口先把产物复制到 root 拥有的 `0700` 临时目录（TOCTOU 消除），然后：

1. 校验 64 位 SHA-256 与 40 位 Git SHA 格式；
2. `sha256sum` 与调用者给出的值比对；
3. 文件名必须是 `staging-standalone-<git-sha>.tar.gz`，且与参数一致；
4. 产物的 owner 必须是 root 或 deploy，必须位于 `/home/deploy/incoming/`；
5. tar 条目数 ≤ 500000、体积 ≤ 1 GiB；
6. 拒绝绝对路径、`..`、`.env*`、硬链接、设备、FIFO、setuid/setgid；
7. 相对符号链接必须解析在产物根目录内；
8. 必须有 `./server.js`、`./BUILD_INFO`、`./node_modules/`、`./.next/static/`、`./public/`；
9. `BUILD_INFO` 的 `sha=` 必须等于参数与文件名。

解包后又用 `realpath -m` 复核每个符号链接，拒绝悬空与逃逸。

## 权限分离

| 动作 | 身份 |
|---|---|
| 校验 / 复制 / 解包 / 切换链接 / systemctl | root |
| 执行数据库迁移 | `deploy`（`runuser -u deploy`，读取 root 快照） |
| 运行应用 | `chaoge`（nologin、无 sudo、无 home） |
| 管理数据库 | `runuser -u postgres -- psql`（仅 root 控制路径） |

root **从不执行产物或迁移源码里的模块**；迁移快照由安装器从人工校验过的
bundle `src/` 安装，而不是从 deploy 可替换的上传产物。

> ⚠️ 迁移快照固定绑定安装 bundle 时的 `APP_GIT_SHA`。应用升级如果包含新的
> `db/migrations/*`，必须用对应提交重新构建 bundle 并重跑安装器；只换应用产物
> 会让迁移代码停留在旧版本。

## systemd

- `User=chaoge`、`NoNewPrivileges=true`、`ProtectSystem=strict`、
  `CapabilityBoundingSet=`、`PrivateTmp=true`；
- `ExecStart` 固定 `HOSTNAME=127.0.0.1 PORT=3000`，`staging.env` 不允许出现
  `HOSTNAME`/`PORT`；
- 发布后实测 `ss -ltn`，非回环即判失败并自动回滚。

## 安装前审计与旧日志归档

一次性安装器在写入任何安装文件之前会：

1. 以 root 执行 `sudo -l -U deploy`，打印现有授权；只要发现本入口以外的
   `NOPASSWD` 命令（包括 `NOPASSWD: ALL`）就中止，不修改任何 sudo 规则。
   如果无法自动读取，安装器会中止并提示人工执行同一条命令。
2. 将 `/var/log/chaoge/bootstrap.log` 与 `/var/log/chaoge/prod2-finalize.log`
   移入 `/var/log/chaoge/archive/<UTC 时间>-<pid>/`（`root:root 0700`，
   文件 `root:root 0600`）。**不删除、不读取内容**；若历史路径是符号链接，
   只移动链接本身，不跟随目标。

归档完成后，`deploy` 不能读取这些历史日志；新的安装/部署日志仍在
`/var/log/chaoge/`，由 root 控制。

## 残余风险（明确接受）

1. **产物认证**：SHA-256 与 Git SHA 只能证明「调用者声明的产物未变」，不能证明
   产物来自可信 CI。deploy 可以把任意应用代码打包并用匹配的哈希部署为 `chaoge`。
   影响限于应用进程（无 root），但仍可获得数据库应用角色权限。缓解：CI 产物由
   人工核对；未来可加签名。
2. **deploy 可读取迁移凭据**：迁移进程以 deploy 身份运行，`DATABASE_URL` 只存在于
   该子进程环境；同 uid 的进程理论上可读 `/proc/<pid>/environ`。迁移角色本身即
   deploy 的执行身份，因此这不是额外扩权，但仍是可信边界内的暴露面。
3. **sudoers 入口接受参数**：规则本身不能限制参数，安全边界是
   `/usr/local/sbin/chaoge-deploy` 的参数解析与硬编码目标。该文件 root:root 0755，
   deploy 不可写。
4. **root 的固定库**：`/usr/local/lib/chaoge` 中的发布脚本由 root 执行。它们只接受
   入口传入的已验证参数；若有人能改这些文件，则已经拥有 root。
5. **3000 端口**：只绑回环；防火墙不在本流程中修改。公网访问必须被云安全组/
   防火墙阻断，这一点由部署环境保证。
