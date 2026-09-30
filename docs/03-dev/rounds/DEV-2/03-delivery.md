# DEV-2 · 交付证据

> 本文件的作用是**把不可复现的口头结论变成可核对的行**。
> 上一轮审查指出的最大缺口就是：本轮声称的「production full × 5、每轮 fail = 0 / skipped = 0」
> **没有任何落盘证据**。§2 就是补上这一块。

---

## 一、改动面（可直接核对 diff）

| # | 文件 | 性质 | 说明 |
|---|---|---|---|
| 1 | `lib/data/mockStore.ts` | 改（**纯新增**） | 新增导出 `resetAllMockStores()`；既有函数签名与语义**一字未动**。同文件给 `resetMockStore` 补了一句「只作用于调用者所在进程」的说明 |
| 2 | `lib/services/mockStores.ts` | **新增** | 唯一导出 `resetMockStores()`，转发到上面那个函数。存在的唯一理由是分层（见 §4） |
| 3 | `app/api/debug/reset/route.ts` | **新增** | POST only；`ENABLE_MOCK_DEBUG` 关闭时 404 |
| 4 | `tests/httpReset.mjs` | **新增** | 测试侧助手 `resetServerStores()` |
| 5 | `tests/httpIsolation.test.mjs` | **新增** | 门禁 6 条 |
| 6 | `tests/*.test.mjs` × 23 | 改 | 各加 **+5 行**（1 行 import、1 行顶格 `await resetServerStores()`、3 行说明注释）。**没有一条既有断言被改动**。这 23 个里 22 个在 `git status` 里可见为 `M`，第 23 个 `adminCouponTemplates.test.mjs` 是 **P1-6** 新建的（未跟踪），本轮补上这一行。第 24 个 HTTP 文件 `httpIsolation.test.mjs` 是本轮新建，天生带这一行 |
| 7 | `package.json` | 改 | test 脚本加 `--test-concurrency=1` |
| 8 | `.env.example` / `README.md` / `api-contract.md` | 改 | `ENABLE_MOCK_DEBUG` 的语义（见 §4） |
| 9 | `architecture-rules.md` | 改 | §2.1 两处**断掉的**交叉引用（见 §4） |
| 10 | `tech-stack.md` / `directory-structure.md` / `.claude/agents/test-agent.md` | 改 | 测试命令与计数同步 |

**业务代码**：`lib/services/**` 的业务逻辑、`lib/data/**` 的事务、`app/api/**` 下**既有**接口的
handler —— **零改动**。第 2 项虽然落在 `lib/services/`，但它是新增文件，不含任何业务逻辑。

---

## 二、门禁结果（**最终的树**）

### 2.1 production 全量 ×5，中途不重启服务

环境：`pnpm build`（exit 0）→ `pnpm exec next start -p 3105`（`ENABLE_MOCK_DEBUG=true`）→
`APP_BASE_URL=http://localhost:3105 pnpm test`。

跑法就是 `04-acceptance.md` §C 给的那条命令（`for i in $(seq 1 5)`），**不做「失败就重跑」的筛选**。

```
run 1: exit=0 elapsed=165s | tests 1794 pass 1794 fail 0 skipped 0
run 2: exit=0 elapsed=164s | tests 1794 pass 1794 fail 0 skipped 0
run 3: exit=0 elapsed=164s | tests 1794 pass 1794 fail 0 skipped 0
run 4: exit=0 elapsed=164s | tests 1794 pass 1794 fail 0 skipped 0
run 5: exit=0 elapsed=164s | tests 1794 pass 1794 fail 0 skipped 0
=== PRODUCTION GATE DONE ===
```

**5/5 全绿；每轮 `fail 0`、`skipped 0`；五轮数字完全相同。**

对照：同一命令在**整改前**的代码上跑到第 3 轮就掉到 `549 / 540 / 9`，
第 4 轮起永久 `347 / 324 / 23`（数据见 `02-decisions.md` §2.3）。
**这是本赛季最直接的「改动前后」对照。**

### 2.2 不设 `APP_BASE_URL`（不起服务）

```
exit=0 elapsed=31s
tests 1794 / pass 1617 / fail 0 / skipped 177
```

即：**不开服务的 `pnpm test` 依旧全绿**，只是 177 条 HTTP 用例按既有规则跳过。
这条同时证明「本轮没有把 HTTP 隔离的成本转嫁到日常跑测上」。

### 2.3 定点验证（整改机制本身）

`tests/httpIsolation.test.mjs` 的 6 条，红绿两向都验过：

- 第 3 条（每个 HTTP 文件都接上重置）：**删掉任一文件的那一行 → 立刻变红**，加回 → 变绿；
- 第 4 条（`--test-concurrency=1`）：从 `package.json` 删掉 → **立刻变红**；
- 第 6 条（真实可达性）：`POST /api/debug/reset` → 200；`GET` → **405**（实测）。

### 2.4 塌陷不再复现（整改前的复现条件上重跑）

整改前的复现条件：**同一个服务进程、连续跑同一批 HTTP 用例、中途不重启**。

| | 迭代 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| **整改后** | 711 ✅ | 711 ✅ | 711 ✅ | 711 ✅ | 711 ✅ | 711 ✅ | 711 ✅ | 711 ✅ |
| **整改前** | 760 ✅ | 760 ✅ | **549 / 540 / 9** ❌ | 347 / 324 / 23 ❌ | 同左 | 同左 | 同左 | 同左 |

**⚠️ 两行的绝对用例数不可直接相减**（760 → 711 看着像「变少了」，其实不是）：
这两列是**不同时点、不同文件集**上测的——整改前的 760 是在 `httpIsolation.test.mjs`
还不存在、且 P1-6 的文件仍在增补时取的，我**无法从现有材料重建当时那一份文件集**。
（这一版定稿时重测，「整改后」那一批已经从 705 变成 **711**——文件集在动，
数字就跟着动；这本身就是「两列不可相减」的实证。）
所以这一张表能支持的结论是**形状**，不是计数：

- 老代码：第 1、2 轮绿 → **第 3 轮塌** → 第 4 轮起**永久**失败，**不会自己恢复**；
- 新机制：连续 8 轮**完全相同**，每轮全绿。

**不能**从这张表得出「本轮让用例数减少了 55 条」——没有任何改动会删用例
（§五 逐条核过：零删断言、零 skip）。老代码那几列是当时的真实输出，
完整表见 `02-decisions.md` §2.3。

### 2.5 接口行为实测（`04-acceptance.md` §A / §B 的原始证据）

| 场景 | 命令 | 实测 |
|---|---|---|
| 开关**开**着（3105） | `curl -X POST …/api/debug/reset` | **200** `{"data":{"reset":["catalog","content"]}}` |
| 开关**开**着 | `curl …/api/debug/reset`（GET） | **405** |
| 开关**关**着（`ENABLE_MOCK_DEBUG=false`，另起 3106） | `curl -X POST …/api/debug/reset` | **404** `{"error":{"code":"NOT_FOUND","message":"调试接口未启用"}}` |

3106 那个进程已 `taskkill //PID … //F //T`，`netstat` 无监听、`curl` 返回 `000`
（本项目踩过「TaskStop 杀不干净、测到旧进程」的坑，所以每次都验）。

### 2.6 静态门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | **通过**，0 error |
| `pnpm lint`（ESLint CLI） | **通过**，0 problem |
| `pnpm build` | **通过**，exit 0 |

---

## 三、审查处置

见 §3.2（**最终一轮审查回执**）。§3.1 是第一轮审查（在「Route 直接 import `lib/data`、
缺 §2 交付文档」的那一版代码上做的）。

### 3.1 第一轮审查：0 BLOCKER / 3 MAJOR / 5 MINOR / 7 NOTE

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| 1 | MAJOR | `app/api/debug/reset/route.ts` **直接 import `lib/data/mockStore`**，违反 `architecture-rules.md` §2.1；且 §2.1 里指向「§六 Observed Current」的交叉引用**是断的**（§六 里没有这条破例） | **已修**（§4.1、§4.2） |
| 2 | MAJOR | `DEV-2/README.md` 与 `03-delivery.md` 缺失 | **已修**（本文件 + README） |
| 3 | MAJOR | `ENABLE_MOCK_DEBUG` 的语义被拓宽（多了一个**破坏性写接口**），但 `.env.example` / `README.md` / `api-contract.md` 仍只描述读侧调试参数；新接口也没进接口清单 | **已修**（§4.3） |
| 4 | MINOR | 门禁第 3 条断言的是 `resetServerStores()` 而不是 `await resetServerStores()` | **已修**（§4.4） |
| 5 | MINOR | 门禁第 5 条断言字面量 `"404"`，等价的错误码重构会误红 | **已修**（§4.4） |
| 6 | MINOR | 我的数字自相矛盾（81 vs 82 文件、176 vs 177、23 vs 24） | **已修**（§4.5） |
| 7 | MINOR | `tech-stack.md` 写「删掉这个开关不会有任何测试立刻变红」，与门禁第 4 条**正好相反** | **已修**（§4.5） |
| 8 | MINOR | `http-smoke.test.mjs` 注释里「要跑门禁请**重启服务**」已过期 | **已修**（§4.5） |
| — | NOTE ×7 | 未要求改动 | 逐条看过，均属「可以更好」而非缺陷；本轮因范围约束未逐条落地，**不声称已处理** |

### 3.2 最终一轮审查（在**最终工作树**上）：0 BLOCKER / 1 MAJOR / 7 MINOR / 6 NOTE

审查者独立跑过的动作：`git status` / `git diff`、全仓 grep、`curl` 探 405、
`node --test tests/httpIsolation.test.mjs`（打 3105 上跑着的服务）。
**没有跑全量、没有重启服务、没有写任何文件。**

它的结论原话：**可以交付，0 BLOCKER**；第一轮的 4 条整改里，分层（第 1 条）真正修好了、
守卫的理由（第 2 条）**判定成立**、门禁（第 4 条）真能挡东西。

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| 1 | **MAJOR** | `tech-stack.md:148` 的**开关决策表**整行还是旧语义（`ENABLE_MOCK_DEBUG` = 「调试参数…参数失效」），没提它现在还会开放一个**破坏性写接口**。这张表是「这个开关能不能开在某台机器上」的唯一依据 | **已修**——该行补上 reset 接口与关闭时 404；`lib/config/env.ts:21` 的函数注释同步 |
| 2 | MINOR | `README.md` 与 `.env.example` 缺第三条边界（「接真实后端必须删除」）；`README.md` 的「关闭时行为」清单仍是旧文案（只说查询参数被忽略） | **已修**——三处补齐 |
| 3 | MINOR | `tests/httpReset.mjs:42` 写「那 **176** 条 HTTP 用例」，权威值是 **177** | **已修** |
| 4 | MINOR | 门禁第 4 条是字面量子串检查，`--test-concurrency 1`（空格形式，**合法的等价写法**）会误红 | **已修**——改正则 `[= ]+1`，并**实测**空格形式仍绿 |
| 5 | MINOR | 门禁第 5 条的注释写着「开关判断必须在**最前面**」，而断言只查「出现过」，**位置完全没查** | **已修**——改为截取 POST 函数体的头 400 字符，断言守卫是**第一条语句** |
| 6 | MINOR | `architecture-rules.md` §2.1 现在**推荐** `lib/services/mockStores.ts`，§2.3 却**禁止** service 做数据访问——同一文件一边推荐一边禁止 | **已修**——§2.3 补明「唯一例外，且只此一处」及理由 |
| 7 | MINOR | 「23 个文件各加 **2 行**」与 diff 对不上（实测每个文件 +5 行） | **已修**——见 §4.5 |
| 8 | MINOR | 「整改前 760 / 整改后 705」对不上，且方向反常（新增文件后用例数不可能变少） | **已修**——见 §2.4 的说明：两列是**不同文件集**，只能支持「形状」不能支持「计数」 |
| 9 | NOTE ×6 | 门禁第 3 条不查顺序 / 「哪些文件算 HTTP 文件」由源码字符串推出来（有逃逸面）/ 第 6 条在有别的客户端时误红 / `curl` 复核通过 / 一批统计值未同步（L6 已声明范围外）/ 守卫取舍的残留 | **部分已修**：第 3 条收紧为顶格匹配（`^…;` 多行）+ 第 6 条断言消息写明前提；**其余如实登记为已知边界**，不声称已解决 |

**审查者提出、本轮明确否决的一条建议**：它建议门禁第 5 条改成
「在进程内直接 `delete process.env.ENABLE_MOCK_DEBUG` 再调 `POST()` 断言 404」
（理由是静态字符串检查可以被注释伪造）。

**做不到，已实测**：route 模块会拉进 `next/headers`，Node 的测试运行器加载不了——
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/node_modules/next/headers'
  imported from …/lib/auth/session.ts
```
这正是本项目「测试只覆盖非组件模块」那条约束的另一面。因此第 5 条保持静态检查，
但把「位置」真的查了（见上表第 5 行）；**运行时的 404 证据改由 `04-acceptance.md` §B
（关掉开关另起 3106 实测）与本文件第 6 条（开着开关实测 200）承担**。

**审查者已独立核对、结论为「无问题」的 10 项**（原文要点）：分层已修（`grep -c "lib/data"` = 0，
全仓 `app/`+`components/` 里 import `lib/data` 的仍**只有** `mock-login` 一处，「唯一破例」属实）；
断链改正属实；重置函数只有一条调用链、业务代码零调用；前缀扫描完整（无模块级 Map/Set 缓存漏网）；
HTTP 文件集合精确相等（两个 grep 结果逐名相同）；24 处重置都早于首个真实 `fetch(`；
既有断言没被动过（抽看的 diff 一律 +5）；门禁不是永真永假；数字与 4 份文档一致；五条禁令逐条核过。

**审查者声明「无法判断」的 4 项**（未猜，如实转抄）：
① 760 与 711 是否同一文件集（见 §2.4，已按「无法重建」如实说明）；
② `CLAUDE.md` 与 `app/api/` 目录树是否属本轮范围（**见 §七的处置**）；
③ 是否要加第二道守卫（判定现方案成立，若加建议用请求头令牌而非 `requireAdmin()`）；
④ `DEV-2` 未登记进 `docs/03-dev/总需求进度表.md`（`development-workflow.md` 里
没找到「测试基础设施轮是否必须登记」的明文）——**本轮按「未找到明文即不擅自登记」处理，
交回产品/协调者**。

---

## 四、上一轮审查提出的三条 MAJOR 是怎么修的

### 4.1 分层：Route 不再直接碰 `lib/data`

原实现：`app/api/debug/reset/route.ts` → `@/lib/data/mockStore`。

**为什么不选「登记第二处破例」**：`architecture-rules.md` §六 开头就把话说死了——
「未来新增代码**不得**以『仓库里已经这样了』为由模仿它们」。
登记第二处破例，等于用一条新破例去解释为什么可以有新破例。

**改法**：新增 `lib/services/mockStores.ts`，内容是一行转发
（`return resetAllMockStores()`）。链路变成
`route` → `lib/services/mockStores` → `lib/data/mockStore`，
`app/` 不再出现 `lib/data`（`grep -c "lib/data" app/api/debug/reset/route.ts` → **0**）。
于是 §2.1 那句「**唯一**实际破例」**仍然是真的**。

⚠️ 一处需要说明的张力：`architecture-rules.md` §2.3 说 service「**不做数据访问**（交给 Repository）」。
这个转发函数确实碰到了 `lib/data`——它转发的是**存储生命周期**操作（丢弃整族 store），
不是读业务数据、不是走仓储。这是本轮**唯一**的妥协，代价是用一个不含任何业务的文件，
换掉一处会让文档失真的破例。若不认可这个取舍，替代方案是把门禁的「唯一破例」改成「两处破例」，
但那需要同时改 §2.1 两处 + §六 的措辞。

### 4.2 断掉的交叉引用

`architecture-rules.md` §2.1 有两处写着「（CURRENT 的唯一实际破例见 §六 Observed Current）」，
但 **§六 的 7 行里没有任何一行是这件事**——真正的登记处在
`api-contract.md` §1 的 ⚠️ 注（`mock-login` 的 Route 直接调 `lib/data/userRepository`）。
两处已改为指向 `api-contract.md` §1，并明说「§六 不含此项」，
免得下一个人再按 §六 找一遍、找不到、然后以为规则本来就没破例。

### 4.3 `ENABLE_MOCK_DEBUG` 的语义变更同步

同一个开关，改动前只管**读**（`mockError` / `mockEmpty` / `mockDelay`），
改动后还管一个**会清空存储的写接口**。不同步就等于**文档说 A、代码做 B**——
而这个开关恰好是「能不能把它开在线上」的唯一依据，说错了代价很大。

三处已同步，各自写明同三条：

| 文件 | 改了什么 |
|---|---|
| `.env.example` | 开关说明加「并开放 `POST /api/debug/reset`」＋破坏性警告 |
| `README.md` | 开关表那一行加同样的内容（原表只写调试查询参数） |
| `api-contract.md` §2.10 | 新增 §2.10.1，登记 `POST /api/debug/reset` 的 Method / URL / Guard / Service / 作用，并把三条边界写全；§2.2 的「刻意使用 404」里补上它 |

### 4.4 门禁自身的两处收紧

- 第 3 条从 `resetServerStores()` 改成 `await resetServerStores()`：
  **漏写 `await` 正是这条门禁要防的那种「看起来接了、其实没生效」**——
  重置会在后台和服务端后续请求赛跑，而这正好是旧的静默失效模式。
- 第 5 条从断言字面量 `"404"` 改成断言 `NOT_FOUND` 且**不得出现** `FORBIDDEN`：
  原来那条把「实现里必须出现 404 这个字符串」当成了规范，
  将来换成等价的错误码常量就会误红；而真正要守的是「开关关闭 = 功能不存在」（404 语义），
  不是那三个字符。

### 4.5 数字与措辞

| 位置 | 原文 | 改为 | 依据 |
|---|---|---|---|
| `tech-stack.md` / `directory-structure.md` / `test-agent.md` | 文件数、用例数 | **82** 个文件 / **1794** 条用例 | `ls tests/*.test.mjs \| wc -l` |
| `directory-structure.md` / `02-decisions.md` | HTTP 文件 23 个 | **24** 个 | `grep -l "process\.env\.APP_BASE_URL" tests/*.test.mjs \| wc -l` |
| `02-decisions.md` §2.2 | 「81 个文件」、grep 写成 `tests/*.mjs` | 82；命令改为 `tests/*.test.mjs`，并注明 `tests/*.mjs` 会多数出一个工具文件 | 同上 |
| `02-decisions.md` §2.3 表 | 「25 个文件里 23 个恒失败」 | 「失败名单每轮完全相同」 | 原文的「25」没有可核对的证据，删掉不可证的细节而不是换个数字 |
| `tech-stack.md` | 「删掉这个开关不会有任何测试立刻变红」 | 「门禁第 2 条会立刻变红；但不会有任何**业务**断言当场失败」 | 与门禁第 4 条自相矛盾 |
| `http-smoke.test.mjs` | 「要跑门禁请**重启服务**」 | 注明该约定已被 `resetServerStores()` 取代 | 机制已变 |

**「23 个文件」这个数是**改动面**（23 个既有 HTTP 文件被改），不是**总数**
（总共有 24 个 HTTP 文件）。两件事被上一版混为一谈，现在两处都写清楚了。
「2 行」是上一版的**实际错误**：每个文件是 **+5 行**（`git diff --stat tests/` 每处都是 `5 +++++`）。
第二轮的审查者算出 22 个，因为它按 `git status` 里可见的 `M` 计数，
而第 23 个（`adminCouponTemplates.test.mjs`）是 P1-6 新建的未跟踪文件——
P1-6 时期这套机制还不存在，所以那一行只可能是本轮加的。

---

## 五、本地测试环境之外的证据边界

| 结论 | 当前状态 |
|---|---|
| `node --test` 每个文件一个子进程 → 进程内 store 天然隔离 | 本项目实测确认；本轮所有串行/并行数字都建立在这条之上 |
| 唯一共享状态是服务进程的 store | 结论来源是「整改后数字稳定 / 整改前单调塌陷」的对照，**不是**对 Node 运行器源码的阅读 |
| `companionOrders` 那次「文件判失败、无错误正文、末尾两条用例整条消失」 | **未定性**。已排除数据污染与并发度两条假设，机制未知。见 `02-decisions.md` §2.4 与 `04-acceptance.md` L1。**本轮的机制不一定覆盖它** |

---

## 六、本轮的边界（不声称做了没做的事）

- **没有**跑「真实数据库」下的任何验证——本项目没有数据库。
- **没有**改任何业务规则、状态机、金额、权限、DTO；**没有**删断言、加 skip、
  改超时、retry-until-green。
- **没有**顺手修与改动无关的文档漂移（路由数等统计值仍然过期，见 `04-acceptance.md` L6）。
- **没有**做 Git 写操作（用户指令「禁止任何 Git 写操作」）；本文件与全部改动**保持未提交**。
- **没有**自行把本 Round 标成 `DONE`。按规格：**`DEV-2 = AWAITING_ACCEPTANCE`**。

---

## 七、两处「交回协调者」的判断（本轮已决）

审查者把两件事标为「需要人 / 需要更多上下文」，按要求没有自己猜。作为本轮协调者，处置如下：

### 7.1 测试计数与 `app/api/` 目录树 —— **纳入本轮**

- `CLAUDE.md` 的 **Tests** 行 `69 files, 1385 cases` → **`82 files, 1794 cases`**，
  并补一句「其中 24 个文件带 HTTP 用例」。
- `directory-structure.md` 的 `app/api/` 树补上 `debug/`（本轮新增的目录）。

理由：L6 排除的是**与改动无关**的统计值（路由总数等）。这两处不是——它们正是**本轮改动本身**
（测试套件、本轮新增的 Route）。留着一个「本轮刚刚亲手改了它、却还写着旧数」的数字，
比留着一个本来就过期的数字更容易误导人。

**仍然未动**（维持 L6）：路由总数 131 / 138、`tech-stack.md` 的「23 个 store」、
`lib/*` 的代码行数快照等 —— 那些本轮没碰。

### 7.2 `DEV-2` 不登记进 `总需求进度表.md` —— **不登记**

`development-workflow.md` 只说那张表是「全局项目进度唯一真值源」，
**没有明文**说测试基础设施轮也必须占一行；而那张表的行是**业务功能点**（P0-x / P1-x）。
在没找到明文的地方自己发明一条规则，正是本项目反复禁止的做法。
因此：**不登记**，并在此登记「为什么不登记」，交回产品负责人定夺——
若确认要登记，加一行即可，不需要改任何代码。
