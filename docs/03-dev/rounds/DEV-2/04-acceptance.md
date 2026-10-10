# DEV-2 · 人工验收

> 本轮是**测试基础设施整改**，不改任何业务行为。因此验收的重点不是「页面对不对」，
> 而是**「这套隔离机制真的在起作用吗」**与**「它有没有顺手改坏别的什么」**。
> 取证与决定的完整记录见 `02-decisions.md`，门禁数字见 `03-delivery.md`。

---

## 〇、怎么把环境搭起来

```bash
pnpm build
pnpm exec next start -p 3105        # 另开一个终端
```

⚠️ **服务端必须带 `ENABLE_MOCK_DEBUG=true`**（本机 `.env.local` 已设）。
HTTP 用例开跑前会 `POST /api/debug/reset`，关掉这个开关该接口会返回 404，
测试会**直接报错**而不是静默退化——这是刻意的，理由见 `02-decisions.md` §4.2。

跑全量：

```bash
APP_BASE_URL=http://localhost:3105 pnpm test
```

---

## 一、哪些结论**不需要**人工判断

以下每一条都已经由自动化断言钉住，人工复核的意义不大，列出是为了让你知道
「不用去手点」：

| 结论 | 自动化证据 |
|---|---|
| 重置真的把服务端存储丢掉了（不只是回 200） | `tests/httpIsolation.test.mjs` 第 6 条：读一次 `/api/home` → 重置 → 再重置必须**无物可丢** |
| 重置只动 Mock 存储，不误删 `globalThis` 上的其它键 | `tests/httpIsolation.test.mjs` 第 2 条 |
| 每个 HTTP 文件都接上了重置（新增文件也不会漏） | `tests/httpIsolation.test.mjs` 第 3 条（**已做红绿验证**） |
| `--test-concurrency=1` 不会被悄悄删掉 | `tests/httpIsolation.test.mjs` 第 4 条 |
| 重置接口**只导出 POST** | `tests/httpIsolation.test.mjs` 第 5 条（静态）+ 运行时实测 `GET → 405` |
| 不设 `APP_BASE_URL` 时行为完全不变 | `pnpm test` 不开服务：**31s · 0 fail · 177 skipped** |

---

## 二、人工验收清单

### A. 接口确实在跑起来的服务上存在，且不是 GET

```bash
curl -s -X POST http://localhost:3105/api/debug/reset        # 期望 200 + {"data":{"reset":[...]}}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3105/api/debug/reset   # 期望 405
```

**本轮实测**（服务刚起、只探过 `/api/home`）：`POST` → `{"data":{"reset":["catalog","content"]}}`；
`GET` → `405`。

> 返回的名字列表**取决于此前建过哪些仓储**，不是一个固定集合——所以别把上面这组名字
> 当成预期值；要看的只有「200 且带 `data.reset` 数组」和「GET 是 405」。

### B. 关掉开关，接口就「不存在」

```bash
# 停掉服务，临时用空环境变量重启（不要改 .env.local，只在这次启动里覆盖）
ENABLE_MOCK_DEBUG=false pnpm exec next start -p 3106
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3106/api/debug/reset   # 期望 404
```

⚠️ 这一步**只是验证接口的开关行为**。验完请把它停掉（`taskkill //PID <pid> //F //T`），
否则你会留下一个 3106 端口的孤儿进程。

**本轮实测**（`ENABLE_MOCK_DEBUG=false pnpm exec next start -p 3106`）：
- 3106 → `POST /api/debug/reset` → **404**，正文 `{"error":{"code":"NOT_FOUND","message":"调试接口未启用"}}`
- 对照，同一时刻的 3105（开关为 `true`）→ **200**
- 3106 已 `taskkill`，`netstat` 无监听、`curl` 返回 `000`

⚠️ `.env.local` 里写着 `ENABLE_MOCK_DEBUG=true`，但上面这条命令行上的 `ENABLE_MOCK_DEBUG=false`
**优先**（Next 不覆盖已存在的进程环境变量），所以不必去改 `.env.local`——改它反而容易忘记改回来。

### C. ⭐ 关键的一条：塌陷不再发生

这是本轮最值得看的东西。**老代码**在同一个服务进程上连续跑同一批 HTTP 用例，
第 3 轮开始塌陷、第 4 轮起**永久**保持 23 个文件失败（数据见 `02-decisions.md` §2.3）。

```bash
export APP_BASE_URL=http://localhost:3105
FILES=$(grep -ln "process\.env\.APP_BASE_URL" tests/*.test.mjs | tr '\n' ' ')
for i in $(seq 1 5); do
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs \
    --test-concurrency=1 --test $FILES 2>&1 | grep -E "^ℹ (tests|pass|fail)"
  echo "--- iter $i ---"
done
```

**期望**：5 轮**每轮都一样**（本轮实测 `tests 711 · pass 711 · fail 0 / skipped 0`），
**中途不重启服务**。
老代码在这里的第 3 轮就会掉到 `549 / 540 / 9`。

> ⚠️ 上面的 `711` 是**本轮定稿时**那一份文件集下的数字。你跑来时若与它不同，
> 先看 `tests/*.test.mjs` 的条数有没有变——**同一个文件集必须给出同一个数字**，
> 那才是这条验收要看的；数字本身随文件集变，不是回归。

### D. 业务功能没有被改动

本轮**不碰**任何业务规则、状态机、金额、权限、DTO；改动面只有「一个新增的存储重置函数」
「一个薄转发服务」「一个新增的 Mock 调试接口」「一个测试侧助手」「一个门禁文件」
「23 个既有 HTTP 文件各 5 行」「package.json 一个开关」。
抽查即可：

```bash
pnpm build && pnpm start        # 期望 ✓ Compiled successfully
pnpm typecheck                  # 期望 0 error
pnpm lint                       # 期望 0 problems
```

再随手打开几个页面确认还能用（首页 / 分类 / 订单 / 后台券模板列表）。

分层也可以顺手核一眼（本轮审查提过的一条）：

```bash
grep -c "lib/data" app/api/debug/reset/route.ts    # 期望 0 —— Route 不直接碰数据层
grep -n "resetMockStores" lib/services/mockStores.ts app/api/debug/reset/route.ts
```

⚠️ 注意：`POST /api/debug/reset` 会清掉**当前进程里**所有 Mock 数据，
手工验收时如果你点了它，页面上的演示数据会回到预置状态——**这是预期行为**，
不是 bug，重启服务也一样会回到预置状态。

### E. 归档与文档

- `docs/03-dev/rounds/DEV-2/` 五个文件齐全（README / 01-prompt / 02-decisions / 03-delivery / 04-acceptance）；
- `02-tech-design/tech-stack.md`、`directory-structure.md`、`.claude/agents/test-agent.md`
  三处引用的测试命令已同步 `--test-concurrency=1`；
- **`ENABLE_MOCK_DEBUG` 的语义变更已同步到它本来写着的地方**：
  `.env.example`、`README.md` 的开关表、`api-contract.md` §2.10（含新接口的登记行）。
  这三处原先只描述「读侧调试参数」，而本轮让这个开关**同时控制一个会清空存储的接口**——
  不同步就是**文档说 A、代码做 B**；
- `architecture-rules.md` §2.1 两处指向「§六 Observed Current」的交叉引用**是断的**
  （§六 里并没有这条破例，真正的登记处在 `api-contract.md` §1）。本轮顺手改正——
  本轮新增的 Route 正好落在这条规则上，不修就无法说明「为什么本轮没有再加一处破例」；
- 历史 Round 文档**只标注、未改写**。

---

## 三、已知限制（**请一并确认**）

| # | 限制 | 说明 |
|---|---|---|
| **L1** | **还有一个运行器层面的现象没能定性** | `tests/companionOrders.test.mjs` 曾出现「文件被判失败、无错误正文、最后两条用例整条消失、总数少 1」。已排除「数据污染」（该文件单独跑、且打的是**已被污染的服务**，连续 5 次 20/20）与「并发度」（并行模式下也出现过）。**机制未定，本轮的重置机制不一定能覆盖它。** 详见 `02-decisions.md` §2.4 |
| **L2** | 跑 HTTP 用例现在**硬依赖** `ENABLE_MOCK_DEBUG=true` | 关掉时不再是「跳过」而是「报错」。这是刻意的——静默放过等于隔离保证悄悄失效，但确实提高了对测试环境的要求 |
| **L3** | HTTP 用例改为**串行**，全量从 ~52s 变 ~164s | 重置是全局的，不串行就会互相清掉对方的状态。不开服务的 `pnpm test` 只从 ~20s 变 **31s**，几乎无感 |
| **L4** | 重置接口在**开着** `ENABLE_MOCK_DEBUG` 的环境里是**破坏性**的 | 任何能访问该服务的人都能清空 Mock 数据。数据本身是一次性的内存数据、无真实用户数据，但**这个开关不能开在任何有真实数据的部署上**——与既有 `mockEmpty`/`mockError` 同一前提 |
| **L5** | 接真实后端时**必须删除** `app/api/debug/reset` | 届时应当用独立的测试库，而不是给线上服务开一个清库接口。该文件头部已写明 |
| **L6** | 顺手发现、**只处理了一部分**的文档漂移 | `docs/02-tech-design/` 与 `CLAUDE.md` 里的路由数（131 vs 实测 146）等统计值在之前的轮次里就已经过期。本轮只同步了**与改动直接相关**的几处（测试命令与计数、`ENABLE_MOCK_DEBUG` 的语义、`architecture-rules.md` 那条断掉的交叉引用），**其余过期数字一律未动**——那不是本轮的范围，需要单独的文档轮。⚠️ 也就是说：**本文档里的路由数仍然是不准的** |

---

## 四、验收签署

- [ ] A 接口存在且 POST only
- [ ] B 关掉开关返回 404
- [ ] C 连续 5 轮不重启服务、每轮 `fail 0`
- [ ] D 构建 / 类型 / 静态检查通过，页面可用
- [ ] E 归档与文档同步完成
- [ ] 已阅读并确认 L1–L6（尤其是 **L1** 与 **L4**）

```
验收人：
验收日期：
结论：            （PASSED / 需返工：______）
```
