# P1-7 · 交付记录

> Round：`P1-7` 老板数据面板 + 消费累计口径统一
> 交付日期：**2026-10-01**
> 状态：**`AWAITING_ACCEPTANCE`**（未 `DONE`，等人工验收）
> ⚠️ 本轮**零 Git 写操作**：`git add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend` 全程未执行，全部改动保留在工作区。

---

## 一、本轮做了什么

一句话：**把 `P0-9` / `P0-13` 遗留的两段灰色口径一次裁定清楚，并让老板在「我的」页看到自己的五个数据指标。**

分三块：

### 1.1 消费累计口径统一（`F1` + 总规则 `R1` / `R2`）

| 项 | 改前 | 改后 |
|---|---|---|
| 公式 | 只按状态过滤（`completed` 的 `actualPaidAmount` 全额计入） | `max(0, actualPaidAmount − refundedAmount)`（**净留存**） |
| 部分退款 | 整单按原价计入 | **即时降低**（实付 100、退 60 ⇒ 计 40） |
| 全额退款 | 状态 `refunded` ⇒ 整单不计 | 整单不计（**与净额公式等价**：`refundedAmount ≥ actualPaidAmount` ⇒ 净额必为 0） |
| 实现处数 | 累计在一处，最近 30 天尚不存在 | **一处**：`lib/constants/levels.ts` 的 `effectiveSpendOf()` |

`R2` 的落点：`sumEffectiveSpend()`（累计消费 / 消费等级 / 消费排行榜）与
`sumSpendWithinRange()`（最近 30 天消费）**都消费同一个 `effectiveSpendOf()`**。
为防回退，`tests/bossStats.test.mjs` 里有一条**扫源码的门禁**：
`lib/constants/bossStats.ts` 与 `lib/services/bossStats.ts` 去掉注释后
**不得出现 `refundedAmount`** —— 在那里自己写一份减法会立刻红。

> 📌 `P0-9` 记下的 TARGET `Σ max(0, actualPaidAmount − refundedAmount)`
> （`docs/01-requirements/超哥电竞_业务流程表.md` §19、`database-schema.md` §16）**至此实现**，
> 那两处 `⏳ 真实金额回滚` 的注记已同步作废。

### 1.2 总规则 `R1`：「钱」与「行为历史」分开

| 类别 | 指标 | 退款的影响 |
|---|---|---|
| **钱** | 累计消费 / 最近 30 天消费 / 消费等级 / 消费排行榜 | **实时**变化（净额） |
| **行为历史** | 累计订单数 / 常玩游戏频次 / 常用打手服务频次 | **不抹掉**（「退款 ≠ 删除历史」） |

这两条方向相反，因此测试里「全额退款」这个场景**同时**断言「金额为 0」与「计数仍为 1」——
只测其中一边会漏掉另一边的静默回退。

### 1.3 老板数据面板（`D1`–`D12`）

`/mine` 页内白纸最上方新增一块「我的数据」：累计订单数 / 累计消费 / 最近 30 天消费 /
常玩游戏 Top3 / 常用打手 Top3，外加三句口径说明。

**新增基础设施 `CompanionServiceEvent`**（`D7` 的前置）：`D7` 要求「常用打手」按
**真实进入过 `serving` 的次数**统计，而这句话在旧模型里**读不出来**：

| 旧有载体 | 它记的是什么 | 为什么答不了 `D7` |
|---|---|---|
| `Order.servingAt` | **当前/最终**那位打手的开始时间 | 换人时被**清成 `null`**（`applyOrderAcceptanceReleased`） |
| `DispatchRecord` | 这一单的派单（一单**一行**） | 一行装不下「先后有几个人服务过」 |
| `CompanionReleaseRecord` | 谁**走**了 | 记的是退出，不是进入 |
| `CompanionAcceptEvent` | 谁**接单**了 | 接单 ≠ 开始服务（可能 `accepted → cancel`） |

因此新增一张**只增不改**的服务历史表，写入点是 `companionOrderTransaction.startCompanionOrder`
的**原子区段**（与订单 `accepted → serving` 同一段无 `await` 的代码），
去重键 `(orderId, companionId, servingAt)`。存量数据由 `deriveLegacyServiceEvents()`
**读时派生**（`fail-closed`，不 backfill、不猜），因此历史数字是**下界**（只少不多）。

详见 `docs/02-tech-design/database-schema.md` §T4c。

---

## 二、门禁（自动化部分）

### 2.1 逐条

| # | 门禁 | 命令 | 结果 |
|---|---|---|---|
| 1 | targeted | `node --test tests/bossStats.test.mjs` | ✅ **36 / 36 pass**（无服务时 33 pass + 3 skip；带 `APP_BASE_URL` 时 36 pass） |
| 2 | targeted（口径回归） | `tests/levels` `tests/rankings` `tests/rankingPeriods` `tests/companionRankings` | ✅ 121 / 121 pass |
| 3 | targeted（退款 / 履约） | `tests/adminRefunds` `tests/refunds` `tests/directRefund` `tests/companionServing` | ✅ 101 pass / 0 fail / 0 skip（服务在跑时 6 条 HTTP 用例不跳过） |
| 4 | 全量 | `pnpm test`（带 `APP_BASE_URL`） | ✅ **1831 total / 1831 pass / 0 fail / 0 skip** |
| 5 | typecheck | `pnpm typecheck`（= `next typegen && tsc --noEmit`） | ✅ 无错误 |
| 6 | lint | `pnpm lint` | ✅ 无输出（0 error / 0 warning） |
| 7 | build | `pnpm build` | ✅ exit 0，`/api/me/boss-stats` 出现在路由表（`ƒ` 动态） |
| 8 | production gate | `ENABLE_MOCK_AUTH=true ENABLE_MOCK_DEBUG=true npx next start -p 3105` + `APP_BASE_URL=http://localhost:3105 pnpm test` | ✅ 同上（**1831 total / 1831 pass / 0 fail / 0 skip**） |
| 9 | 人工冒烟（见 §2.2） | `curl` 打生产构建 | ✅ |

> 📌 上表是**验收前收尾之后**重跑一轮的终值（见 §六）。`P1-7` 自己贡献的用例：
> `tests/bossStats.test.mjs` **36 条** + `tests/companionServing.test.mjs` 里新增的 `开始 3c` **1 条** = **37 条**，
> 全部在生产构建下通过（0 skip）。
>
> 📌 **本轮全量门禁已是全绿**（此前登记的那条既有 CRLF 失败已在本轮收尾中修掉，
> 见 §2.3；同时收尾中修掉了它暴露出的第二条**随日历漂移**的假失败，见 §2.4）。

### 2.2 端到端冒烟（生产构建 `next start`）

| 检查 | 命令 | 结果 |
|---|---|---|
| 未登录 | `GET /api/me/boss-stats` | `401` ✅ |
| 登录 `u-1001` | 同上 | `orderCount=16` · `totalSpendAmount=24060` · `recent30dSpendAmount=14780` · `recentGames=[三角洲行动 3, 无畏契约 2]` · `recentCompanions=[cp-1 ×3, cp-3 ×3, cp-4 ×1]` ✅ |
| 金额与消费等级同口径 | 同上 vs `GET /api/me/consumption-level` | 两者都是 `24060`（`R2` 的对外表现）✅ |
| `/mine` 页面渲染 | 带会话 `GET /mine` | 出现「我的数据」+ 三个数值（`16` / `¥240.60` / `¥147.80`）+ 「常玩游戏」「常用打手」两块 ✅ |
| **`D12` 空数据** | 登录 `u-1009`（有订单、无已完成） | 累计订单数 `2`、累计消费 `¥0.00`、最近 30 天 `¥0.00`，**恰好 1 处**「暂无数据」（空的那个榜单），整块**不隐藏** ✅ |
| 换人不影响 | 登录 `u-1002` | 得到与 `u-1001` **不同**的一份 ✅ |

> ⚠️ **上表取自「刚起服务」的进程。** 带 `APP_BASE_URL` 跑完 `pnpm test` 之后，
> 同一个服务的 `globalThis` 存储已被测试**写脏**（HTTP 用例真的建单 / 接单 / 开始服务），
> 此时 `u-1001` 的累计订单数会变成 **18**（多出的两张是未完成的测试单，
> 因此 `totalSpendAmount` 仍是 `24060`——这恰好又一次印证了「行为历史 +1、钱不变」）。
> **上表与 `04-acceptance.md` §〇 的数字都以刚起服务的进程为准**；
> 要复算请先重启服务。

### 2.3 假失败之一：`couponCheckoutChain.test.mjs:1109` 的行尾符断言（**已修**）

```
✖ tests/couponCheckoutChain.test.mjs:1109
  结构：建单原子区段里不许出现 await，核销点必须在区段内且排在派单之前
  AssertionError: 建单函数必须还能圈出函数体
```

**根因（本机 `core.autocrlf=true`）**：该断言用 `code.indexOf("\n}\n", start)`
圈函数体，而 `lib/services/checkout.ts` 检出为 **CRLF**——CRLF 里 `}` 后面跟的是
`\r` 不是 `\n`，所以 `"\n}\n"` **永远匹配不到**，`end` 恒为 `-1`：

```
start                                    9875
src.indexOf("\n}\n",   start)  →  -1     ← 断言读的就是这个
src.indexOf("\r\n}\r\n", start) →  12057
src.includes("\r\n")           →  true
```

**为什么必须修**：它红的原因与它要守护的「原子区段里没有 `await`」**毫无关系**——
真正的回归信号被这条噪音盖住，任何一次全量跑都带着一条恒红的用例。

**修法（对 LF / CRLF 都成立，且**没有**删除断言、`skip`、`retry` 或放宽业务要求）**：
把「圈函数体」从「匹配一个字面 `\n}\n`」换成「切到**下一个顶层声明**为止」——
`^` 配 `/m` 在 LF 与 CRLF 下都落在行首，与行尾符、缩进、函数在文件中的位置都无关：

```js
const rest = code.slice(start + 1);
const next = rest.search(
  /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|type|class|interface)\s/m,
);
const end = next === -1 ? code.length : start + 1 + next;
const body = code.slice(start, end);
```

**两条新增的完整性守卫**（防止把断言放到空片段上通过——那才是真的「把断言放空了」）：

```js
assert.ok(body.startsWith("function buildOrderFromRequest("), "圈出的片段必须以函数声明开头");
assert.ok(body.trimEnd().endsWith("}"), "圈出的片段必须以右花括号收尾（函数体是完整的）");
```

下面三条业务断言（**区段内不许有 `await`**、**核销点必须在区段内**、
**核销点必须排在派单之前**）**一字未动**。

**红绿验证（证明圈出的范围真的覆盖了整个原子区段）**：在
`createDispatchForOrder({` **之前**（即原子区段的**尾部**，不是开头）临时插入
`const __probe = "await";` →

```
tests/couponCheckoutChain.test.mjs   23 / 24 pass，1 fail
  → 失败项恰为上面那条结构用例（「原子区段里出现任何一个 await，
     双花测试就会静默失去意义…」）
```

撤掉探针后回到 **24 / 24**，且 `git status --porcelain -- lib/services/checkout.ts`
为**空**（生产文件一个字节都没动）。

### 2.4 假失败之二：`bossStats.test.mjs` 的「最近 30 天」断言**随日历漂移**（**已修**）

修掉 §2.3 之后，全量由「1 条既有失败」变成「另一条失败」，值得单独立节——
**它与 CRLF 同源：测试的时钟与数据的时钟不同源。**

```
✖ tests/bossStats.test.mjs  服务层：预置数据下五个指标都算得出来，且最近 30 天 ≤ 累计
  AssertionError: 8180 !== 14780
```

**根因**：预置数据里有一批订单是**相对 Mock 基准时间**构造的
（`buildRankingPeriodOrders`，见 `lib/mocks/fixtures/mockClock.ts`），其中 u-1001 的
「今日」那一单（`ord-rank-today-1001`，6600 分）落在**真实当天**；而这条用例把
`NOW` 钉成常量 `2026-10-01T12:00+08:00`。于是：

| 时钟 | `ord-rank-today-1001.completedAt` | `recent30dSpendAmount` |
|---|---|---|
| 钉住（`setMockSeedNow(NOW)`） | `2026-10-01T02:00:00.000Z`（常量） | **14780** ✅ |
| 不钉（真实时钟） | `2026-10-01T17:07:49.943Z`（真实此刻） | **8180** ❌ |

跨过 `NOW` 那一刻之后，那一单落到窗口**右端之外**，14780 − 6600 = 8180。
`orderCount`（16）与 `totalSpendAmount`（24060）在两种时钟下**完全相同**——
这也再次印证了口径：**窗口影响「最近 30 天」，不影响「累计」。**

**这是纯测试侧缺陷，产品侧一直是自洽的**：服务进程里「数据的时钟」与「查询的时钟」
本来就是同一个（服务端用默认 `now = new Date()` 取窗口），因此**线上/生产构建
一直返回 14780**（§2.2 实测）。只有这条用例人为把两个时钟拆开了。

**修法**：给 `lib/mocks/fixtures/mockClock.ts` 补一个**仅供测试**的
`setMockSeedNow(now)`（与既有的 `resetMockSeedNow` 同一条纪律），并在
`tests/bossStats.test.mjs` 的 `beforeEach` 里把基准时间钉成用例自己的 `NOW`
——**必须在 `resetMockStore("payment")` 之前**，因为订单种子是在**建仓时**取基准时间的。
断言值 `14780` **原样保留**，只是它从此与数据的时钟同源、不再随执行日期变化。

> ⚠️ 该 setter 的生效范围已在函数注释里写清：只对「建仓时现取」的消费者
> （订单 / 派单）生效；`catalogSeed` / `messageSeed` / `seed.ts` / `staffSeed`
> 在**模块加载那一刻**就取走了基准时间，此后再改对它们无效——
> 这正是本用例需要的范围，函数注释里如实标注了。

> 📌 收尾后全量 **1831 / 1831 pass / 0 fail / 0 skip**（见 §六）。
> **`P1-7` 不再带有任何既有失败。**

---

## 三、文件清单

### 3.1 新增（11 个）

| 文件 | 行数 | 作用 |
|---|---|---|
| `lib/types/bossStats.ts` | 84 | `BossStatsSummary` / `BossGameStat` / `BossCompanionStat` |
| `lib/types/companionService.ts` | 100 | `CompanionServiceEvent` / `DerivedServiceEvent` |
| `lib/constants/bossStats.ts` | 322 | **五个指标的唯一致口径落点**（纯函数，服务端与浏览器共用）。⚠️ **不自己实现「累计订单数」**：调用 `levels.ts` 的 `countLifetimeOrders()`，见 §六 M1 |
| `lib/data/companionServiceRepository.ts` | 54 | 服务历史仓储接口（**只有读方法**） |
| `lib/data/mockCompanionServiceRepository.ts` | 173 | Mock 存储 + 同步写原语 `appendCompanionService()` + 存量派生 |
| `lib/services/bossStats.ts` | 52 | 服务端取数与注入时间（`getBossStatsForUser(userId, now)`） |
| `lib/services/bossStatsHttp.ts` | 17 | 浏览器端取数（只依赖 `@/lib/api/client`） |
| `app/api/me/boss-stats/route.ts` | 27 | `GET`，`requireUser`，**不接受任何查询参数** |
| `components/mine/BossStatsCard.tsx` | 139 | 面板（**纯展示**，不遍历订单） |
| `components/mine/BossStatsPanel.tsx` | 75 | 客户端降级 + 局部重试（与 `LevelSummaryPanel` 同策略） |
| `tests/bossStats.test.mjs` | 892 | 36 条用例（28 纯逻辑 + 5 HTTP + 3 store/service） |

### 3.2 修改（7 个业务文件）

| 文件 | +/− | 改了什么 |
|---|---|---|
| `lib/constants/levels.ts` | +68 / −9 | 新增 `effectiveSpendOf()`（净额，**全仓唯一**）；`sumEffectiveSpend()` 改为消费它；新增 `countLifetimeOrders()`（**也是「累计订单数」的全仓唯一实现**，`bossStats.ts` 调它）；重写 `CONSUMPTION_CALCULATION_NOTICE`（旧文案与实际口径不符） |
| `lib/constants/rankingPeriods.ts` | +48 / −5 | 新增 `RECENT_30D_DAYS` / `recent30DayRange(now)`（UTC+8 自然日，含今天）；重写 `RANKING_NOTICE` / `RANKING_PERIOD_NOTICE`（旧文案说「已完成且未退款」，在部分退款下是错的） |
| `lib/data/companionOrderTransaction.ts` | +21 / −1 | `startCompanionOrder` 的原子区段内追加 `appendCompanionService(...)`；更新步骤注释 |
| `lib/data/mockStore.ts` | +8 / −0 | `MockStoreName` 增加 `"companionService"` |
| `lib/services/levels.ts` | +4 / −2 | 仅修正过期文档注释（引用 `totalAmount` → 现口径） |
| `app/(mobile)/(tabs)/(protected)/mine/page.tsx` | +40 / −0 | 新增 `loadBossStats()`（与等级摘要**分开取数、分开降级**）+ 渲染 `BossStatsPanel` |
| `lib/mocks/fixtures/mockClock.ts` | +33 / −0 | **验收前收尾**：新增**仅供测试**的 `setMockSeedNow(now)`（与既有 `resetMockSeedNow` 同一条纪律），让用例能把 Mock 基准时间钉成自己的 `NOW`。理由与影响范围见 §2.4 与函数注释 |

### 3.3 测试文件（4 个）

| 文件 | 改了什么 |
|---|---|
| `tests/bossStats.test.mjs` | **新增**（892 行 / 36 条）。见 §3.1 |
| `tests/companionServing.test.mjs` | **+1 条** `开始 3c`：真实 `accepted → serving` 必须留下恰好一条服务历史，且与 legacy 派生合并后只计一次（§六 M2） |
| `tests/levels.test.mjs` | 「客户端组件不得引用 `lib/mocks`」那份清单**加了 2 个文件**（`BossStatsCard` / `BossStatsPanel`，§六 m3） |
| `tests/couponCheckoutChain.test.mjs` | **验收前收尾**：把圈函数体的 `code.indexOf("\n}\n", start)` 换成对 LF / CRLF 都成立的「切到下一个顶层声明」写法，并补两条完整性守卫；**三条业务断言一字未动**。见 §2.3（含红绿验证） |

### 3.4 文档（9 个：轮次档案 6 + 技术/进度 3）

| 文件 | 改了什么 |
|---|---|
| `docs/03-dev/rounds/P1-7/01-prompt.md` | **新增**：本轮章程（`F1`–`F5` 五条冻结规则的摘要 + 开发纪律 + 结束条件） |
| `docs/03-dev/rounds/P1-7/02-decisions.md` | 追加 §五（`D1`–`D12` 全部 ✅ `RESOLVED`）/ §六（`R1`/`R2`）/ §七（结论）。**§一–§四 的旧 BLOCKED 结论逐字保留**，未删未改 |
| `docs/03-dev/rounds/P1-7/03-delivery.md` | 本文件 |
| `docs/03-dev/rounds/P1-7/04-acceptance.md` | **新增**：人工验收清单（10 组 + 预置数据表 + 「哪些无法人工复验」） |
| `docs/03-dev/rounds/P1-7/05-review.md` | **新增**：审查结论与逐条处置 |
| `docs/03-dev/rounds/P1-7/README.md` | 状态 `BLOCKED` → `IN_PROGRESS` → `AWAITING_ACCEPTANCE` |
| `docs/02-tech-design/api-contract.md` | 新增 §3.9（新接口的 DTO 契约 + 两处易改坏点）；§3 表格加一行；表头记 P1-7 的 `+1` 与**实测总数 147** |
| `docs/02-tech-design/database-schema.md` | 新增 §T4c（`CompanionServiceEvent` 的 CURRENT + 未来 DB 迁移约束）；§16 把两段已作废的 TBD 改成已裁定的现状 |
| `docs/03-dev/需求功能点进度表.md` | `P1 \| 老板数据` 五行改为 `AWAITING_ACCEPTANCE`；§5.1 / §5.2 **同步重算**；roadmap #8 标注已交付 |
| `docs/03-dev/总需求进度表.md` | 新增 `P1-7` 行（唯一真值源） |

---

## 四、文档同步里的两处**如实记录**（不是粉饰）

### 4.1 `api-contract.md` 的接口总数早已落后于仓库

实测 `find app/api -name route.ts | wc -l` = **147**（`admin` 71 · `staff` 25 · `companion` 12 · `me` 4），
而文档表头写的是 **138**（`admin` 64）。

**`P1-7` 只新增了 1 个 `route.ts`，因此 138 → 147 的其余 8 个不是本轮造成的。**
本轮**没有**去补记那段差额——逐条核对归属需要翻 P1-6 前后多轮的档案，
不属于 `P1-7` 的范围。文档里写的是**实测值 + 明确声明「差额不是本轮的」**，
**没有**按增量推算（推算正是上一版对不上的原因）。

### 4.2 进度表的加权完成率**变小了**

`P1 | 老板数据 | 累计消费金额` 由 `PARTIAL`（计 0.5 分）移入 `AWAITING_ACCEPTANCE`（计 0 分），
因此 **加权完成率 53.3% → 52.9%、P1 加权 19.7% → 18.4%**。

**这不是实现退化**：该行原本的 `PARTIAL` 记的是「只有消费等级卡、没有老板数据面板」，
现在面板有了但**尚未验收**，而本表的计分口径是**未经验收不计分**。
数字变小是口径的必然结果，已写在 §5.1 / §5.2 的注记里。

---

## 五、本轮**没有**做的事

- **没有**新增二级页 / 点击跳转 / 趋势图 / 复杂图表（`D11`：本轮是历史统计展示）。
- **没有**让打手行可点击、**没有**「再来一单」入口（`D9` / `D11`）。
- **没有**用 `Game.productId → 当前 gameId` 重新解释历史订单，**没有**合并游戏别名（`D5`）。
- **没有**为了统计反向改造历史订单或目录。
- **没有**伪造历史服务记录（`D10`：不 backfill、不猜）。
- **没有**为「常用打手」预埋「发消息 / 再约」等 TBD 能力。
- **没有**改任何**业务规则**之外的东西：状态机、派单、退款金额链、权限守卫的判定逻辑**逐字未动**。
- **没有**执行任何 Git 写操作。

---

## 六、审查返工（`BLOCKER` / `MAJOR` 的处置）

审查结论与逐条处置见 `05-review.md`。这里只记**因审查而改动的实现**——改完重跑了上表全部门禁。

| 编号 | 级别 | 问题 | 处置 |
|---|---|---|---|
| **M1** | MAJOR | 「累计订单数」有**两份逐字相同**的实现：`levels.ts` 的 `countLifetimeOrders()`（**零调用点**、无测试，却是 `D1` 点名的落点）与实际生效的 `bossStats.ts` 的 `countOrders()`。按 `D1` 去改落点的那个人会改到死的那一份，面板数字**一动不动且无测试变红** | **删掉 `bossStats.ts` 的 `countOrders()`，让面板直接调 `countLifetimeOrders()`**（与它调用 `sumEffectiveSpend` 同一条纪律）。同一份数据上再断言 `countLifetimeOrders() ≠ countEffectiveOrders()`，防止将来有人把两个指标合并成一份 |
| **M2** | MAJOR | `appendCompanionService()` 的**生产调用点零覆盖**：把 `companionOrderTransaction.ts:547` 整段删掉，**没有任何测试会失败**，「常用打手」会悄悄退回 legacy 派生的下界（换过人的历史服务永久丢失，正是 `D7`/`D10` 要修的原始缺陷） | 在 `tests/companionServing.test.mjs` 新增 `开始 3c`：驱动真实 `startCompanionOrder`，断言事件表**恰好新增 1 条**、字段与订单上冻结的那份逐项一致、重放不新增，并端到端断言「事件表 + legacy 派生」合并后**只算一次**。**已做红绿验证**：临时把生产写入关掉 → 该用例（且只有它）失败；恢复后 20/20 通过 |
| **m1** | MINOR | 服务层端到端用例用 `> 0` / `length > 0` 这类松断言，`recentCompanions` 为空时空转，等于没测 | 五个实测值全部改成 `assert.equal` / `deepEqual`（16 · 24060 · 14780 · 游戏两行 · 打手三行），并补 `recentCompanions.length === 3` |
| **m2** | MINOR | 「常用打手」的 **Top3 截断路径从未被执行**（所有夹具都 ≤ 3 位打手） | 新增 5 位打手、且在截断边界上制造并列的夹具：断言 `length === 3`、第三名由「最近服务时间」决定、倒序输入结果不变、`topN` 参数化生效 |
| **m3** | MINOR | 新加的两个客户端组件不在「Mock 不得进浏览器产物」的结构门禁清单里 | 把 `BossStatsCard.tsx` / `BossStatsPanel.tsx` 加进 `tests/levels.test.mjs` 的清单，并注明「新增客户端组件要一起加」 |

### 6.1 `D10` 附加要求第 3 条：为什么最终**没有**把 assignment identity 存进服务事件

`D10` 附加要求第 3 条的原话是「服务历史**复用 assignment identity**
（`assignmentKey` / `seq` **若有**）」。仓里确实有这两样东西
（`lib/constants/conversations.ts` 的 `assignmentKeyOf` / `resolveAssignmentSeq` /
`resolveCurrentAssignmentKey`），但**最终 `CompanionServiceEvent` 没有保存它**：
去重与判据是三元组 `(orderId, companionId, servingAt)`，`dispatchId` 只作留档。

下面逐条回答「这是实现便利，还是架构约束」。

#### ① assignment identity 在进入 `serving` 时**是不是已经可得**？——**是，不是拿不到**

`listCompanionReleasesByOrderId(orderId)`（`lib/data/mockCompanionReleaseRepository.ts:143`）
是一个**同步读原语**，就在 `startCompanionOrder` 那段**无 `await` 的原子区段**里可直接调用。
于是当场可算出 `seq = resolveAssignmentSeq(releaseCount)`、
`assignmentKey = assignmentKeyOf(orderId, seq)`。旁证：**会话层就是这么算的**——
建 assignment 会话时走的是 `resolveCurrentAssignmentKey({ orderId, actualCompanionId, releaseCount })`
（`lib/services/conversations.ts:183`）。

所以「拿不到 identity」**不成立**。真正的理由是下面三条。

#### ② 不保存它的具体工程理由

**(a) 合并流的另一半（存量派生）**结构上**装不下** identity。**
服务历史是 `listServiceEvents()` ∪ `listLegacyServiceEvents()` 的并集
（`lib/services/bossStats.ts:46-49`）。后者由 `Order.servingAt + actualCompanionId`
**读时派生**，而 `Order.servingAt` **只保留当前/最终那一位**打手
（`lib/types/companionService.ts:88`）。历史里真发生过 A → B 的存量单，B 的 `seq`
**不可考**（退出历史建仓时是空的、且明文不 backfill）。
若给真事件加 `assignmentKey`、派生事件只能给 `null`，那这个字段在**合并后的流上就不是
identity**——一半为 `null` 的键，既当不了去重键，也当不了对账键，只能当注释看。

**(b) 这一层**没有一份「已存在」的 identity 可**复用**。**
`D10` 说的是「**若有**」。会话记录上确实冻结了一份 `seq`（会话创建那一刻写死、之后永不重算），
但那是**会话域**的字段。订单域里：`DispatchRecord` **一单一行**（换人复用并覆盖，
`dispatchIdByOrder` 保证唯一），`Order` 上也没有 `seq`——服务事件层**没有**现成的 identity，
只有一个**当场从退出历史数出来**的 `releaseCount`。「复用」是读到一份已有的；
在这里就地写一个，是**发明**一份新的。

**(c) 那就等于凭空造一个 Assignment 聚合。**
`database-schema.md` 把「复杂 Replacement / **Assignment 聚合**」明确列为
`TBD — DO NOT INVENT`（`lib/types/companionRelease.ts:16-19` 复述了这条禁令）。
为单张表加一个跨越边界的 assignment 标识，正是这条禁令针对的动作。

#### ③ A → B → A 同一订单下，能否**严格区分**两个 A assignment？——**能，当前设计已经区分了**

| 时刻 | 动作 | 服务事件 | 退出历史 |
|---|---|---|---|
| t1 | A 开始服务 | `(o, A, t1)` | — |
| — | A 退出 | | #1 |
| t2 | B 开始服务 | `(o, B, t2)` | — |
| — | B 退出 | | #2 |
| t3 | **A 再次开始服务** | `(o, A, t3)` | — |

A 的两条事件 `servingAt` 不同（`t1 ≠ t3`）⇒ 去重键不同 ⇒ **留下两条** ⇒
A 的 `serviceCount = 2`。这正是 `D8` 要的：**A 服务过两次就是两次**。
`mockCompanionServiceRepository.ts:91-93` 的注释就是为这件事写的。

唯一会让两条撞在一起的是 `t1 === t3`，而那要求两次开始服务落在**同一毫秒**、
且中间还完整发生过一次 B 的服务与退出。HTTP 路径上 `at` 由服务端生成
（`lib/services/companionOrders.ts:366` 的 `new Date().toISOString()`），
**调用方无法注入**——因此只有测试能构造出这种重合，不是可达的生产路径。

#### ④ 会不会影响以后「聊天 assignment / 履约历史 / 服务次数」三者对账？——**不影响；而且加了 identity 也帮不上**

这三张表按设计回答**三个不同问题**（`lib/types/companionService.ts:24-27`）：
接单事件答「谁**来**了」、退出历史答「谁**走**了」、服务事件答「谁**开始服务**了」。
更关键的是：退出历史**明文不记「换给了谁」**（`lib/types/companionRelease.ts:19`），
派单记录**一单一行**。因此跨表本来就不可能靠一个 id 做 1:1 对账，
只能靠 `(orderId, companionId, 时间区间)` 推理——加一个只在真事件上有的 `assignmentKey`
**不会**让这件事变得更可能，反而会给人「可以按 id join」的错觉。
真要一份可对账的 assignment，那正是 ②(c) 里被列为 `TBD — DO NOT INVENT` 的那件事，
属于产品 / 架构层决定，**不是本轮该自行发明的东西**。

#### ⑤ 结论 —— **已由产品正式裁定**

**属于架构约束，不是实现便利**。交付时按用户指令「如果确有充分架构理由，则先只汇报，
不要擅自改产品规则」，**当时未改实现、只如实登记**。

> ✅ **2026-10-02 产品验收前裁定：接受当前实现，并正式收窄 `D10` 附加要求第 3 条**
> （逐字见 `02-decisions.md` §8.1）。裁定要点：
>
> - 本轮 `CompanionServiceEvent` **负责**记录 `order + companion + servingAt` 的
>   真实、append-only 服务历史；
> - **不要求**它承担跨「聊天 assignment / release / service event」的**统一 Assignment identity**；
> - `(orderId, companionId, servingAt)` **可作为本轮的去重语义**；
> - **不得声称**它是正式 Assignment identity；
> - 未来**只有在项目正式建立 Assignment 聚合时**，才统一迁移三者的身份模型；
> - 本轮**不提前创造**半填充的 `assignmentId`。
>
> 因此 §6.1 所列的偏离**不再是一条「待产品知晓的偏离」，而是产品已裁定的既定范围**。
> 术语纪律随之生效：代码注释与交付文档都**不得**把该三元组称为「Assignment identity」
> （`database-schema.md` §T4c 已同步补注）。

> 说明（避免过度声明）：本条**不是**说「加了就一定错」。理论上可以只给真事件加一个
> `assignmentSeq: number | null` 当纯留档字段（派生事件给 `null`，去重键不动）。
> 产品的裁定是**本轮不做**：它会是一个**半填充**、读起来像 identity 却不是 identity 的字段，
> 且与 `DO NOT INVENT Assignment 聚合` 的既有约束正面相抵。
> 若将来认为**审计**价值大于这个代价，那应作为一次明确的规则变更、并**连同
> 聊天与 release 一起迁移**——不在此刻单点发明。

### 6.2 审查提出、但**本轮刻意不处理**的一条（`NOTE n3`）

`effectiveSpendOf()` 对**非有限** `refundedAmount` 当 0 处理，而 `sumSpendWithinRange()`
不额外看状态，于是「`status === "refunded"` 但 `refundedAmount` 缺失」的脏数据会让该单
全额计入最近 30 天、却在累计消费里计 0。`lib/types/order.ts` 声明该字段为必填 `number`，
因此**属类型外脏数据**；审查方也判为「无需动作」。本轮**不加**那句 `Number.isFinite` 兜底——
加了会让两个函数的形状更接近，但也会掩盖一个本不该存在的状态。登记在此备查。

---

## 七、⚠️ 未提交

按用户指令「**禁止任何 Git 写操作**」，本轮全部改动
（**11 个新增文件**（含 `tests/bossStats.test.mjs`）+ **7 个业务文件** +
**3 个既有测试文件**（`tests/companionServing.test.mjs` / `tests/levels.test.mjs` /
`tests/couponCheckoutChain.test.mjs`）+ **9 个文档**）
**保留在工作区、未提交**。`README.md` 的 `Git Commit` 一栏因此留空——**这是正确状态**。
