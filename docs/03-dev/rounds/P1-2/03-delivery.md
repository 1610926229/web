# P1-2 — 交付记录

> **Round**：`P1-2` — 管理员生命周期参数配置中心
> **状态**：🟣 `AWAITING_ACCEPTANCE`（⚠️ **Claude 不自行 `DONE`**）
> **日期**：2026-09-27
> **依赖**：`P0-1`（`PlatformConfig` 与 `/api/admin/platform-config` 已存在）、
> `P0-5`（专属池超时清扫）、`P0-6`（打手取消接单回池）、`P0-9`（投诉窗口）
> **前置轮次**：`P0-14`（🟣 待验收）· `P1-1`（🟣 待验收）——三者**同处一个未提交工作区**
> **本批次无任何 Git 写操作**（无 `add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase`）
> **未开始**：`P1-3`

---

## §1 本轮做了什么（一句话）

把「专属池超时」从**源码常量**（`lib/constants/dispatch.ts` 的 `EXCLUSIVE_WAIT_MINUTES = 10`，
注释写着「固定 10 分钟，不可配置」）改成**管理员可配置的平台参数**，并给它
**快照语义**：订单**进入专属池那一刻**把当时的取值冻结到派单记录上，此后管理员再改配置
**不影响已经进池的订单**。

同时把另外三项时长（公共池超时 / 完成材料自动审核 / 投诉窗口）纳入同一轮审计，
**确认它们本来就已是同一套 `PlatformConfig` + 同一份快照语义**，没有重复字段、
也没有第二套配置域。

> **本轮最高优先级的不变量**（写进代码注释、写进验收清单、写进测试）：
> **`PlatformConfig` 是未来生命周期事件的模板；对象上已经生成的 snapshot / deadline 才是历史事实。**

**零新增地址、零新增状态、零金额口径改动。**

---

## §2 落点

### 2.1 改动面（`git diff --stat`，仅列 P1-2 相关）

| 文件 | 增删 | 本轮做了什么 |
|---|---|---|
| `lib/constants/platformConfig.ts` | +81 / −? | 新增 `EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES = 10`、`_MIN_` / `_MAX_`（**引用**公共池那一对，不复制数字）、`isValidExclusivePoolTimeoutMinutes()`、`PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT`、`PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE` |
| `lib/types/platformConfig.ts` | +38 | `PlatformConfig` 加 `exclusivePoolTimeoutMinutes: number`；`AdminPlatformConfigPatch` 加同名**可选**字段（四个字段仍都可选） |
| `lib/data/mockPlatformConfigRepository.ts` | +73 | 新增读边界归一化 `normalizePlatformConfig()`：旧 store 缺字段 / 脏值时**补成默认 10**，读函数本身**不改写存储** |
| `lib/data/adminPlatformConfigTransaction.ts` | +28 | `PlatformConfigInput` 加字段；`PATCHABLE_FIELDS` 加一个键（**编译期保险**：漏加会让 `tsc` 报错）；no-op / replay 分支的返回值过一遍归一化 |
| `lib/services/adminPlatformConfig.ts` | +34 | 输入解析 + `isValidExclusivePoolTimeoutMinutes()` 校验 + 专属池专属错误文案 |
| `app/api/admin/platform-config/route.ts` | +12 | PATCH 透传新字段（`requireAdmin()` 与 405 语义**未变**） |
| `lib/constants/adminAudit.ts` | +1 | 审计快照 `toPlatformConfigAuditSnapshot` 带上新字段 |
| `lib/mocks/fixtures/platformConfigSeed.ts` | +10 | 预置配置带默认值 10 |
| `components/admin/AdminPlatformConfigConsole.tsx` | +102 | 第四个独立保存的输入框 + 业务含义提示 + 当前值区 |
| `lib/types/dispatch.ts` | +24 | 新增 `DispatchRecord.exclusiveTimeoutMinutesSnapshot`（与 `publicTimeoutMinutesSnapshot` 对仗） |
| `lib/data/companionDispatchTransaction.ts` | +15 | ⭐ **核心**：专属池分支改用 `config.exclusivePoolTimeoutMinutes` 计算 `exclusiveDeadlineAt` 并**同时冻结快照**；删除 `EXCLUSIVE_WAIT_MINUTES` import |
| `lib/constants/dispatch.ts` | — | **删除** `EXCLUSIVE_WAIT_MINUTES`，原地留一段 `superseded by P1-2` 说明；`COMPANION_POOL_NOTICE` 不再承诺一个具体分钟数（改成「留一段时间」） |
| `tests/platformConfig.test.mjs` | +725 | 本轮全部新增用例（见 §3） |

### 2.2 注释口径修订（**纯注释，零行为改动**）

`EXCLUSIVE_WAIT_MINUTES` 删除后，一批注释里仍写着「固定 10 分钟」——
「注释写着固定、代码里其实可配置」正是本轮要消除的那种自相矛盾。已修订 7 处：

`app/companion/(console)/exclusive/page.tsx` · `components/companion/CompanionDispatchCard.tsx` ·
`app/api/companion/dispatches/route.ts` · `lib/constants/companionConsole.ts` ·
`lib/data/companionDispatchTransaction.ts:238` · `lib/types/dispatch.ts`（2 处）·
`lib/types/order.ts`（2 处）· `app/admin/(console)/orders/[id]/page.tsx`

统一改成「**默认 10 分钟，可由管理员配置**」这一形态。

### 2.3 **没有**碰的东西（逐条声明，可 `git status` 对拍）

- ❌ 没有新建第二个配置域 / 第二个 `PlatformConfig` / 第二个配置页——`/admin/platform-config` 仍是**唯一**入口；
- ❌ 没有新增任何 `OrderStatus` / `DispatchState` / 状态迁移；
- ❌ 没有实现 Scheduler（超时仍是**惰性清扫**）；
- ❌ 没有动金额口径（分账 / 退款 / 打手收益一分未改）；
- ❌ 没有改 `requireAdmin()` / 405 / 幂等键格式等既有协议；
- ❌ 没有改写任何历史 Round 文档（只在 `P1-1` 的验收 / 交付记录里**追加**了「P1-2 已开工」的留痕标注）。

---

## §3 门禁读数

> ⚠️ 以下数字全部是**最终复跑**（即 MINOR 修复**之后**）在本机真实跑出来的读数，
> 不是估算、也不是修复前的旧读数。命令与退出码逐条列出。

### 3.1 targeted tests（本轮改动面：`platformConfig` + `dispatch` + `admin`）

```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs \
  --test tests/platformConfig.test.mjs tests/dispatch.test.mjs tests/admin.test.mjs
```

```
ℹ tests 131      ℹ pass 113      ℹ fail 0      ℹ skipped 18
```

（18 skipped 全部是「未设置 `APP_BASE_URL`」的 HTTP 用例，见 §3.5。）

### 3.2 离线全量 `pnpm test`

```
ℹ tests 1525     ℹ pass 1357     ℹ fail 0      ℹ skipped 168
```

### 3.3 `pnpm typecheck`（`next typegen && tsc --noEmit`）

```
✓ Types generated successfully
```

**退出码 0。** 含新增的 `PATCHABLE_FIELDS` 编译期保险——漏加字段会在这里报错。

### 3.4 `pnpm lint` / `pnpm build`

```
$ eslint                    → 退出码 0
$ next build                → 退出码 0（Turbopack）
```

### 3.5 ⭐ 生产构建 + `APP_BASE_URL` 全量（**本批次交付读数**）

服务器**新起**（先把原先占用 3105 的旧进程按 PID `taskkill /T /F`，
`netstat -ano | grep :3105` 确认端口已释放，再 `npx next start -p 3105`），
**不是**复用一个跑着旧构建的进程——那是本仓踩过的坑（见记忆「后台服务的 TaskStop 杀不干净」）。

```
APP_BASE_URL=http://localhost:3105 pnpm test
```

```
ℹ tests 1525     ℹ pass 1525     ℹ fail 0      ℹ skipped 0
```

**复跑方式统一为「按 PID 杀掉旧进程 → `netstat` 确认端口释放 → `npx next start -p 3105` 新起」**，
一共跑了 6 次：**4 次捕获到完整汇总、4 次读数完全一致（`1525 / 1525 / 0 / 0`）**，
另 1 次只确认了「无失败」而没有留存汇总（故不计入），还有 1 次是一次性偶发（见下）。
最后一次是「重新 `pnpm build` → 重起服务 → 整轮」。

> ⚠️ **如实记录一次一次性失败**：3 次之中有 1 次，`tests/adminCategories.test.mjs`
> 以**文件级**（不是某条具名用例）报 `'test failed'`、耗时 1127ms 提前中止；
> 该文件**单独跑 31/31 全绿**，此后 4 次整轮复跑（含**新起的干净服务**与**重新构建后的服务**）也不再出现。
> 没有拿到该次的服务端报错文本，因此**不声称已知根因**：从「文件级中止、无具名失败用例」
> 这一形态看，最可能是并行执行下的连接层抖动，**没有任何证据指向 P1-2 的业务代码**
> （P1-2 不改类目、不改并行度）。此处登记为**观察到的偶发**，不粉饰成「全绿」。

> **`skipped 0`** 是本轮验收的硬指标之一：只要有一条 HTTP 用例被跳过，
> 就说明生产环境下有接口没被真正打过。

### 3.6 门禁汇总（对照指令 §二十二）

| 门禁 | 要求 | 实测 | 判定 |
|---|---|---|---|
| require 失败 | 0 | 0 | ✅ |
| 生产跳过 | 0 | `skipped 0` | ✅ |
| BLOCKER | 0 | 0（§4） | ✅ |
| MAJOR | 0 | 0（§4） | ✅ |

---

## §4 只读审查（`reviewer-agent`）

### 4.1 第一轮结论

**0 BLOCKER · 0 MAJOR · 4 MINOR · 4 NOTE。**

四条 MINOR **全部已修**（都不是「记录为已知问题」），逐条：

| # | 问题 | 处置 |
|---|---|---|
| **MINOR-1** | **真缺陷**：伪事务 no-op / replay 分支是**唯一**一条不经过 `writePlatformConfig()` 就返回配置的路径。它把从 store 展开出来的原始记录直接交回，旧 store 缺 `exclusivePoolTimeoutMinutes` 时该键是 `undefined`——JSON 序列化后**键直接消失**，管理端页面 `setConfig(result.config)` 会显示「`undefined` 分钟」 | 返回值过一遍 `normalizePlatformConfig()`。⚠️ **只归一化返回值，不动 `previous`**——`previous` 是 no-op 判据的合并基准，归一化它会让「脏 store + 恰好提交默认值」落进 `nothingChanged` 而**永不写盘**。两个目标各由一条新用例钉住（§4.3） |
| **MINOR-2** | HTTP 测试里「改回默认」的恢复动作写在「平台参数 5」的成功路径末尾——**上面任何一条断言失败都会让它不执行**，后面依赖默认值的用例跟着无故变红，把一次失败放大成一片噪声 | 拆成**独立用例**「平台参数 5c」（`{ skip: SKIP_HTTP }`，与前一条互不影响） |
| **MINOR-3** | 公共池提示缺「修改后生效范围」 | 补齐，并写明「**从专属池超时转进来的订单会重新冻结一次——本项是每次进入公共池时都冻结，不是一单只冻结一次**」（与 `applyDispatchToPublic` 的实际行为一致） |
| **MINOR-4** | `docs/02-tech-design/directory-structure.md` §D 漂移：仍写「`AdminPlatformConfigPatch` 的**三个**字段」，且把 `exclusivePoolTimeoutMinutes` 列为 TARGET | 已改为「**四个**字段」+「已于 P1-2 落地」；标题「新增第四个参数时要动的地方」改为「第五个」（改动面清单同步） |

### 4.2 四条 NOTE（**本轮不修**，登记备查）

见 `04-acceptance.md` **§五 R7** 与 **§五之二 N2–N4**。其中 **NOTE-1 是既有行为**
（专属池到点后由惰性清扫转入公共池时，回填的公共池 deadline / 快照用的是**清扫那一刻**
读到的配置，而不是订单**逻辑上转入公共池那一刻**的配置，`companionDispatchTransaction.ts:405,444`）。
它属于 `P0-5` / `P0-6` 的既有语义，**不该夹在 P1-2 里改**，已作为 **R7 交产品追认**。

### 4.3 修复之后的复审

修复（含 MINOR-1 的真实行为改动）在**第一轮审查之后**才落地，故按流程
**再跑一轮只读复审**，专判「四条 MINOR 是否真的修好、有没有引入新问题」。

### 4.4 第二轮（复审）结论

**0 BLOCKER · 0 MAJOR · 1 MINOR（新） · 3 NOTE。**

四条 MINOR **逐条判定为「已修复」**，其中 **MINOR-1 的修法经独立核对确认正确、
两个目标都达成**：返回值不再缺键（`snapshot = normalizePlatformConfig(previous)`），
同时 `previous` 保持原始（`nothingChanged` 的合并基准），脏 store + 提交默认值仍会真的写盘。
复审另确认「反向修法（把 `previous` 也归一化）会导致**永不写盘**」这个坑实现没有掉进去。

复审对本轮最高优先级**不变量**的核对：`exclusiveDeadlineAt` 唯一写入点是
`createDispatchForOrder()`（`companionDispatchTransaction.ts:99-100`），
`acceptDispatch()` 与 `sweepExpiredDispatches()` 都只读 `record.exclusiveDeadlineAt`
（经 `currentDeadlineAt(record)`）——**全仓不存在按当下配置重算旧 deadline 的路径**。
DTO 隐私、分层、伪事务原子性（`normalizePlatformConfig` 是纯同步函数，
未破坏「无 `await`」的原子区段）、审计快照 `before`/`after` 四项齐全，均已覆盖且无问题。

**新 MINOR（1 条）—— 测试可靠性，已修：**

| # | 问题 | 处置 |
|---|---|---|
| **MINOR-5** | 权限与契约用例在取不到管理员 Cookie 时 `if (!cookie) return;` —— 目标实例若未开 `ENABLE_MOCK_ADMIN`，这段门禁会**静默全绿**：`node --test` 既不计 skip 也不计 fail，而「生产跳过 = 0」本该证明权限矩阵真的被打过。依据：`04-acceptance.md` §F 要求「四条拒绝 + 一条放行」，而「一条放行」只在这些用例里 | `loginAdmin()` 改成**断言失败**（报错信息直接写明需要 `ENABLE_MOCK_ADMIN=true`），并删掉全部 8 处 `if (!cookie) return;`。**红绿已实测**（见下） |

**MINOR-5 的红绿验证**（受控环境对照，不是推理）：

- **绿**：目标实例开启开关（`mock-login` 返回 200）→ 整轮 **1525 / 1525 / 0 fail / 0 skipped**；
- **红**：另起一个 `ENABLE_MOCK_ADMIN=false` 的实例（实测 `mock-login` 返回 **404**），
  只跑本文件 → **`fail 8`、`skipped 0`**，失败集中在「平台参数 2 / 3 / 4 / 5 / 5b / 5c / 6 / 7」——
  正是**修复前会静默通过**的那一批。**证明这道门禁现在真的会红，不再可能冒充跑过。**

（红例实例已按 PID 关停，`netstat` 确认 3106 端口释放。）

### 4.5 三条 NOTE 的处置（复审提出）

| # | 内容 | 处置 |
|---|---|---|
| **NOTE-A** | R7 的描述**说轻了**：同一份「清扫时刻的配置」还被用在 `companionDispatchTransaction.ts:405`（`deadlineAt = plusMinutes(atDeadline, config.publicPoolTimeoutMinutes)`）的**计划阶段**，因此一次清扫**连跳两级**时，`timedOutAt`（**自动退款时刻**）也由清扫时刻的配置决定——受影响的不止展示字段 | **采纳**。已在 `04-acceptance.md` §五 增补 **R7 补** 一行，把「退款时刻」明确写进追认范围 |
| **NOTE-B** | `directory-structure.md:405` 写「**四处都要改**」，但同段实际列了**七**个文件（P1-2 之前就有的笔误，本轮改「第四个参数」→「第五个」时顺手编辑了整段却没改这个数） | **采纳**。已改为「上面这**七**处都要改」并标注更正日期 |
| **NOTE-C** | 「平台参数 5c」是**用例间状态隔离**，**不是行为探针**——它在修复前的实现下不会变红，不构成「新增了一条会失败的用例」这类证据 | **采纳并在 §3/§4 的措辞上区分开**：本轮真正会在旧实现下变红的新用例只有一条，即「旧 store 缺字段时，写路径的 no-op 分支也不能把 undefined 交给调用方」（5c 与 5b 分别承担隔离与 no-op 契约，两者都不冒充「修复证据」） |

> **最终门禁（第二节复审的 MINOR 修复之后，重新完整复跑）**：见 §3 各条读数——
> 它们**就是**修复之后的读数，`skipped 0` 与「红绿已实测」同时成立。

---

## §5 「固定 10 分钟」清扫证据

### 5.1 删除的常量

`lib/constants/dispatch.ts` 的 `EXCLUSIVE_WAIT_MINUTES = 10` **已整体删除**，
原地留一段说明（`superseded by P1-2` + 指向 `platformConfig.ts` 的默认值常量）。
测试用两条探针钉住：源码里不许再有 `EXCLUSIVE_WAIT_MINUTES` **引用**
（`stripComments` 之后扫描 `lib` / `app` / `components` 的 `.ts` / `.tsx`），
且派单事务里不许再出现该标识符。

### 5.2 全仓搜索后**保留**的「10 分钟」只剩三类

| 类别 | 位置（举例） | 为什么保留 |
|---|---|---|
| ① **默认值**本身 | `lib/constants/platformConfig.ts:31`（`EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES`） | 这就是本轮要求的形态：10 是**默认值**，不是**固定值** |
| ② **历史说明** | `lib/constants/dispatch.ts:18`、`lib/types/dispatch.ts:89`、`lib/types/platformConfig.ts:55` 等「这里**曾经**是固定 10 分钟」 | 删掉它们等于抹掉「为什么会有这个字段」的来龙去脉 |
| ③ **业务数据** | `lib/mocks/fixtures/seed.ts:324`（用户评价文本「整体不错，中间等了十分钟。」） | 这是**用户当初写下的话**，改它等于篡改数据 |

> ⚠️ 「默认 10 分钟，**可由管理员配置**」这类句子（`lib/types/dispatch.ts:28,42`、
> `app/api/companion/dispatches/route.ts:20`、`app/companion/(console)/exclusive/page.tsx:20`、
> `components/companion/CompanionDispatchCard.tsx:23`）属于 ②——它们**明说了可配置**，
> 与「固定 10 分钟」是相反的表述。

### 5.3 页面承诺的修订

`COMPANION_POOL_NOTICE` 原文写死「**留 10 分钟**」——管理员把它改成 20 之后，
页面会继续对打手承诺「10 分钟」，**一句对不上的承诺比不写更糟**。
已改为「留**一段时间**」，要确切剩余时间看卡片上的截止时间。

---

## §6 Git 状态

> ⚠️ **本批次全程无任何 Git 写操作。** 以下为只读快照。

见最终一次性输出的 **D. `git status`**（与此处同源）。

**要点**：工作区同时承载 **P0-14 / P1-1 / P1-2 三个轮次**的未提交改动，
分支为 `feat/order-lifecycle-alignment`，HEAD = `c2c9360`。
`app/api/admin/platform-config/route.ts` 与 `docs/02-tech-design/` 三份文档
**被多个轮次共同修改**，因此对拍本轮的改动请用**具体文件的 diff**，不要用整仓 diff。

---

## §7 明确**没有**做的事

见 `04-acceptance.md` **§六**（同一份清单，避免两处写成两套说法）。
