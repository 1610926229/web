# 信任快照与 root 收尾（PROD-2 安全整改）

服务器上的 `deploy` 用户负责 CI 检出与传输，因此 `/home/deploy` 下的任何脚本
**都不能被 root 直接执行**：deploy 可以在 root 运行前替换它（TOCTOU），而 root
执行 deploy 可写的代码等于把整机交给 deploy。

本目录把 root 收尾收敛成一条链：

```text
人工命令（钉死 bundle SHA-256）
   └─ 解压到 root 临时目录
        └─ deploy/trust/bootstrap.sh
             ├─ 校验 deploy/trust/deploy-files.sha256
             ├─ 构建 /opt/chaoge-deploy-trust（root:root，go-w）
             ├─ 复制 node_modules，以 deploy 身份冒烟 import("pg")
             └─ deploy/app/finalize-staging.sh
                  ├─ 校验 deploy-files.sha256 与 migration-code.sha256
                  ├─ 产物复制到 root 临时文件 → 校验 SHA-256 与 BUILD_INFO SHA
                  ├─ 建库 / 授权 / 角色口令 / 迁移（runuser deploy）
                  ├─ 环境变量 / systemd / 首版发布 / 健康检查
                  └─ 持久化 / SIGKILL 恢复 / 可选回滚演练
```

## 版本号

| 名称 | 来源 | 用途 |
|---|---|---|
| `APP_GIT_SHA` = `8ad9d6ba9dcd…` | 已构建并验证的 CI 产物 | 安装哪个应用；迁移代码取同一提交 |
| `ARTIFACT_SHA256` = `f1070077…` | 该产物的 tar.gz | finalizer 复制后强制校验 |
| bundle SHA-256 | 本次部署脚本修复的打包 | 人工命令中钉死；不写进 `BUILD_INFO` |

部署脚本的提交与 `APP_GIT_SHA` 不同是正常的。**永远不要**用部署脚本的
提交 SHA 去覆盖 `BUILD_INFO` 或 `--expected-sha`。

## 构建 bundle（开发机）

```bash
# 1. 先提交本轮部署修复（APP_GIT_SHA 保持不变）
bash deploy/trust/generate-manifests.sh                 # 生成两个 manifest
git add deploy/ deploy/trust/*.sha256 tests/stagingDeploy.test.mjs
git commit -m "fix(prod-2): harden finalizer with root-owned trust snapshot"
git -c core.autocrlf=false archive --format=tar HEAD deploy | tar -x -C <staging>
git -c core.autocrlf=false archive --format=tar 8ad9d6b \
  package.json tests/alias-hook.mjs tests/alias-loader.mjs lib db/migrations \
  | tar -x -C <staging>/src
tar -czf prod2-trust-bundle-<sha8>.tar.gz -C <staging> .
sha256sum prod2-trust-bundle-<sha8>.tar.gz
```

上传（deploy 身份即可——人工命令会用期望值校验内容）：

```bash
scp prod2-trust-bundle-<sha8>.tar.gz deploy@<server-ip>:~
```

## 人工执行（唯一的 sudo 密码输入点）

```bash
cd ~ && sudo bash -c "$(cat <<'PROD2_BOOT'
set -euo pipefail
BUNDLE=/home/deploy/prod2-trust-bundle-<sha8>.tar.gz
EXPECTED=<bundle-sha256>
ART=/tmp/staging-standalone-<APP_SHA>.tar.gz
[[ "$(sha256sum "$BUNDLE" | cut -d' ' -f1)" == "$EXPECTED" ]] || { echo "bundle SHA 不匹配"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -tzf "$BUNDLE" | awk '/^\// || /(^|\/)\.\.(\/|$)/ { print "unsafe: " $0; bad=1 } END { exit bad }'
tar -xzf "$BUNDLE" -C "$TMP"
bash "$TMP/deploy/trust/bootstrap.sh" --bundle-dir "$TMP" --artifact "$ART" --drill
PROD2_BOOT
)"
```

`sudo bash -c "$(cat <<…)"` 让 stdin 仍然是终端：finalizer 的 psql
`\password` 与口令输入可以正常工作。执行过程中需要人工输入：

1. `chaoge_staging_migrator` 与 `chaoge_staging_app` 的口令（psql `\password`，各两次）；
2. `chaoge_staging_app` 的口令（生成 `staging.env`，一次）；
3. `chaoge_staging_migrator` 的口令（迁移，一次）；
4. 每个阶段要求重新输入的库名 `chaoge_staging`（防误操作确认）。
5. `sudo` 密码。

口令只从终端 `read -rs` 读入；migrator 连接串经 fd 9 传给迁移脚本，
不出现在 argv、子进程环境变量列表或日志里。

## 日志与只读访问

- `/var/log/chaoge/bootstrap.log`
- `/var/log/chaoge/prod2-finalize.log`
- 目录 `root:deploy 0750`，文件 `root:deploy 0640`；deploy 可读、不可写/删除。

## 回滚演练（`--drill`）

finalizer 用 `mktemp` 复制已验证产物，把 `server.js` 换成立即退出、并把
`BUILD_INFO` 改成 40 个 `f`，带上与之匹配的 `--sha256` 发布。期望：
健康检查失败 → `install-release.sh` 自动切回当前版本 → 首页 200。
演练版本目录随后被删除，临时产物由 `trap` 清理。

## 安全边界

- `chaoge_prod` 在 `deploy-staging.sh` 参数解析阶段被拒绝；本流程只创建/迁移
  `chaoge_staging`。
- root 不执行迁移代码：迁移以 `runuser -u deploy` 运行，读取 root 拥有的快照。
- 快照的「组/其他可写」断言只看真实文件与目录，跳过符号链接：Linux 上链接权限
  恒为 `0777`（`chmod` 无法修改），而 `node_modules/.bin` 的 23 个相对链接
  会在 `-perm` 下被误报。链接目标已在复制前校验为快照内部路径，并由同一断言覆盖。
- root 不使用 deploy 的 pnpm/corepack 缓存；迁移直接用绝对路径 Node。
- 不修改 sudoers / SSH / 防火墙；不监听公网端口（unit 固定 `127.0.0.1:3000`）。
- 管理端/客服端 Secure Cookie 在纯 HTTP 隧道下不工作，见 `deploy/app/README.md` §4.3。
