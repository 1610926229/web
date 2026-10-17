# 受控部署 bundle（PROD-2 安全整改）

服务器上的 `deploy` 用户负责 CI 检出与传输，因此 `/home/deploy` 下的任何脚本
**都不能被 root 直接执行**：deploy 可以在 root 运行前替换它（TOCTOU），而 root
执行 deploy 可写的代码等于把整机交给 deploy。

本目录把「一次性初始化」与「日常部署」分开：

```text
一次性（人工输入一次 sudo 密码）
  bundle（人工核对 SHA-256）
    └─ root 私有副本（0700 临时目录）
         ├─ 再算 SHA-256、检查 tar 路径
         └─ deploy/entry/install.sh
              ├─ 校验 deploy-files.sha256 / migration-code.sha256
              ├─ 安装 /usr/local/sbin/chaoge-deploy（root:root 0755）
              ├─ 安装 /usr/local/lib/chaoge/{app,db,src}（root:root）
              ├─ 生成 /etc/chaoge/staging.secrets（root:root 0600）
              ├─ 建库 / 初始化 / 设置 SCRAM 校验子
              ├─ 写 /etc/chaoge/staging.env（root:root 0600）与 systemd 单元
              └─ 写入单命令 sudoers 规则并用 visudo 校验

日常（无需人工输入任何口令）
  sudo -n /usr/local/sbin/chaoge-deploy deploy <artifact> <sha256> <git-sha>
  sudo -n /usr/local/sbin/chaoge-deploy rollback
  sudo -n /usr/local/sbin/chaoge-deploy status
```

`deploy/trust/bootstrap.sh` 与 `deploy/app/finalize-staging.sh` 是旧流程，
已废弃并在启动时拒绝执行（仅保留历史取证与本地回归）。

## 版本号

| 名称 | 来源 | 用途 |
|---|---|---|
| `APP_GIT_SHA` = `8ad9d6ba9dcd…` | 已构建并验证的 CI 产物 | 安装哪个应用；迁移代码取同一提交 |
| `ARTIFACT_SHA256` = `f1070077…` | 该产物的 tar.gz | 每次 `deploy` 时由入口强制校验 |
| bundle SHA-256 | 本次部署脚本修复的打包 | 人工命令中钉死；不写进 `BUILD_INFO` |

部署脚本的提交与 `APP_GIT_SHA` 不同是正常的。**永远不要**用部署脚本的
提交 SHA 去覆盖 `BUILD_INFO` 或 `deploy` 的 `<git-sha>` 参数。

## 构建 bundle（开发机）

```bash
bash deploy/trust/generate-manifests.sh                 # 生成两个 manifest
git add deploy/ tests/stagingEntry.test.mjs
git commit -m "feat(prod-2): controlled staging deployment entry"
STAGE=$(mktemp -d)
git -c core.autocrlf=false archive --format=tar HEAD deploy | tar -x -C "$STAGE"
git -c core.autocrlf=false archive --format=tar 8ad9d6b \
  package.json tests/alias-hook.mjs tests/alias-loader.mjs lib db/migrations \
  | tar -x -C "$STAGE/src"
tar -czf prod2-deploy-bundle-<sha8>.tar.gz -C "$STAGE" .
sha256sum prod2-deploy-bundle-<sha8>.tar.gz
```

上传（deploy 身份即可——root 命令会用期望值校验内容）：

```bash
scp prod2-deploy-bundle-<sha8>.tar.gz deploy@<server-ip>:~
```

## 一次性人工执行（唯一的 sudo 密码输入点）

```bash
sudo bash -c '
set -euo pipefail
BUNDLE=/home/deploy/prod2-deploy-bundle-<sha8>.tar.gz
EXPECTED=<bundle-sha256>
TMP="$(mktemp -d)"
trap "rm -rf -- \"$TMP\"" EXIT
# 1) 只把 root 私有副本用于校验和解压（消除 deploy 可写路径上的 TOCTOU）
install -o root -g root -m 0600 -- "$BUNDLE" "$TMP/bundle.tar.gz"
[[ "$(sha256sum "$TMP/bundle.tar.gz" | cut -d" " -f1)" == "$EXPECTED" ]] \
  || { echo "bundle SHA-256 不匹配"; exit 1; }
# 2) 解包前检查 tar 路径与条目类型
#    bundle 只应包含普通文件与目录。符号链接/硬链接/设备/FIFO 一律拒绝，
#    否则 root 解包时可能被「先建链接、再经链接写入」的组合穿越到 TMP 之外。
tar -tzf "$TMP/bundle.tar.gz" \
  | awk "/^\// || /(^|\/)\.\.(\/|$)/ { print \"unsafe: \" \$0; bad=1 } END { exit bad }"
tar -tvzf "$TMP/bundle.tar.gz" \
  | awk "\$1 !~ /^[-d]/ { print \"unsafe type: \" \$0; bad=1 } END { exit bad }"
mkdir -m 0700 "$TMP/root"
tar -xzf "$TMP/bundle.tar.gz" -C "$TMP/root" --no-same-owner --no-same-permissions
# 3) 只执行 root 私有副本中的安装器
bash "$TMP/root/deploy/entry/install.sh" --bundle-dir "$TMP/root"
'
```

安装器本身不再要求输入数据库口令：两个角色口令由 `openssl rand -hex 32`
生成，只写入 `/etc/chaoge/staging.secrets`（root:root 0600），不输出。
安装器也不接收、不解包任何应用产物；首版发布随后走受控入口。

## 日志与只读访问

- `/var/log/chaoge/install.log`（一次性安装）
- `/var/log/chaoge/chaoge-deploy.log`（每次 deploy/rollback）
- 目录 `root:deploy 0750`，文件 `root:deploy 0640`；deploy 可读、不可写/删除。

## 安全边界

- `chaoge_prod` 在 `deploy-staging.sh` 参数解析阶段被拒绝；本流程只创建/迁移
  `chaoge_staging`。
- root 不执行迁移代码：迁移以 `runuser -u deploy` 运行，读取 root 拥有的快照。
- `deploy-files.sha256` 覆盖 `deploy/entry/*`；bundle 中任何组/其他用户可写路径
  或符号链接都会被安装器拒绝。
- 快照的「组/其他可写」断言跳过符号链接：Linux 上链接权限恒为 `0777`
  （`chmod` 无法修改）。链接目标已在复制前校验为快照内部路径。
- root 不使用 deploy 的 pnpm/corepack 缓存；迁移直接用绝对路径 Node。
- 不修改 SSH / 防火墙；唯一写入的 sudoers 规则是
  `deploy ALL=(root) NOPASSWD: /usr/local/sbin/chaoge-deploy`。
- 不监听公网端口（unit 固定 `127.0.0.1:3000`）。
- 管理端/客服端 Secure Cookie 在纯 HTTP 隧道下不工作，见 `deploy/app/README.md` §4.3。
