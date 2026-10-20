# P1-5 — 交付记录

Round: P1-5 · 打手排行榜闭环
**Status: `AWAITING_ACCEPTANCE`**
Round Status: 编码与自动门禁已完成，等待产品负责人人工验收
Development Completed At: 2026-09-29
Review: 第一轮见 §6.1；**修完 MAJOR/MINOR 后的第二轮见 §6.3**；**§九-F 裁定轮见 §6.5 · 对该轮的独立复核见 §6.6**
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**）
Git Commit: `—`（⚠️ 本批次**禁止任何 Git 写操作**，此栏留空是该时点的正确状态）

> ⚠️ **`P0-14` / `P1-1` / `P1-2` 仍停在 `AWAITING_ACCEPTANCE`，本轮不改变它们。**
> ⚠️ 本文件**取代**同名文件此前的 `BLOCKED` 报告；那份报告的原貌逐字保留在 §0。

---

## §0 历史：本文件此前的 `BLOCKED` 报告（**逐字保留，只作凭证**）

> ⚠️ **本文件不是交付记录，是 `BLOCKED` 报告。**
> P1-5 **没有进入 `IN_PROGRESS`**，**没有交付任何代码**，因此本文件不列文件清单、不列门禁读数。
> 阻塞的完整证据与最小提问清单在 **`02-decisions.md`**，本文件只做导航与状态确认。
>
> Round ID: P1-5 / Title: 打手排行榜闭环 / Status: **`BLOCKED`** / 交付日期: 2026-09-29 / 指令: `docs/03-dev/rounds/cmd_p1-5.md`
>
> **一、结论**：**P1-5 = `BLOCKED`。** 阻塞发生在 **Requirement Check 阶段**，早于任何编码。
> 按 `cmd_p1-5.md` 的结束条件「若排名指标或周期仍未冻结 → 标 `BLOCKED`」以及夜间防卡死规则
> 第 1 / 2 / 4 条（「不猜 · 将该 Round 标为 `BLOCKED` · **不修改争议业务代码**」），
> 因此本轮**一行业务代码都没有改动**。
>
> **二、为什么不能「先按一个口径做出来」**：权威需求把「打手排行榜」列成了**四个不同口径的功能点**，
> 且在数据模型里留了一条点名 P1-5 的 `TBD — DO NOT INVENT`（B/A/S 档门槛是固定还是管理员可配）。
> 在这两条没解冻之前动手，等于**替产品负责人选一个口径**。逐条证据见 `02-decisions.md` §二。
>
> **三、需要产品负责人回答的问题**：**只有一份，在 `02-decisions.md` §三「最小阻塞问题」**（7 问）。
>
> **四、「没碰有争议的业务代码」的凭证**：`02-decisions.md` §四列出了**本轮未改动的文件清单**。
>
> **五、解除阻塞后要接着做的事**：见 `02-decisions.md` 末尾（备忘）。
>
> **六、Git 状态**：⚠️ 本批次**全程禁止任何 Git 写操作**。本轮无产物，`Git Commit:` 保持 `—`。

**阻塞的解除**：2026-09-29 晚段收到产品负责人**完整裁定**（`02-decisions.md` §六 中段 + §七 完整段），
§三 的 7 个问题**全部 `RESOLVED`**（§八），Round 按 `BLOCKED → READY → IN_PROGRESS` 推进。

---

## §1 本轮做了什么（一句话）

在用户端**新建**一条与消费榜**并列**的打手榜 `/rank/companions`，同页三张子榜
（**接单榜 / 完成榜 / 收入榜**）共用现有六个周期与 UTC+8 实现；为此新增一张
**只增不改**的「接单事件」历史表（`CompanionAcceptEvent`）作为接单榜的底座。
**消费榜一个字都没有改写**。

---

## §2 落点

### 2.1 新增文件

| 文件 | 作用 |
|---|---|
| `lib/types/companionAccept.ts` | 接单事件 `CompanionAcceptEvent` + 存量派生 `DerivedAcceptEvent`（含「它是**下界**」的如实说明） |
| `lib/types/companionRanking.ts` | `CompanionRankingEntry`（**恰好 6 个公开字段**）、`CompanionRankingRow`、`CompanionRankingPage` DTO |
| `lib/constants/companionRankings.ts` | **三张榜口径的唯一真值源**：`metricFor()` 三个独立分支、竞赛排名 `assignCompanionRanks()`、稳定键排序、分页、`mergeAcceptEvents()`、DTO 组装、全部文案 |
| `lib/data/companionAcceptRepository.ts` | 只读仓储接口（`listAcceptEvents` / `listLegacyAcceptEvents`） |
| `lib/data/mockCompanionAcceptRepository.ts` | 进程内 store + **同步写原语** `appendCompanionAccept()` + `deriveLegacyAcceptEvents()` |
| `lib/services/companionRankings.ts` | `getCompanionRanking()`：并发只读取数 → 聚合 → DTO；承载 `?mockError` / `?mockEmpty=companionRankings` |
| `lib/services/companionRankingsHttp.ts` | 浏览器侧薄封装 |
| `app/api/rankings/companions/route.ts` | `GET /api/rankings/companions`：**无守卫（公开、游客可读）**；非法 `board` / `period` 回 400 |
| `app/(mobile)/rank/companions/{page,loading,error}.tsx` | 二级页面，**自带同段的加载与错误边界**（不在 `(tabs)` 里，无底部 TabBar） |
| `components/rank/CompanionRankingBoard.tsx` | 客户端组件：榜切换 + 周期页签 + 前三名 + 完整榜单 + 分页；竞态用 `shouldApplyCompanionRankingResponse` 挡 |
| `components/rank/RankBoardSwitch.tsx` | 消费榜 / 打手榜的**导航**组件（只做跳转，不共享状态） |
| `tests/companionRankings.test.mjs` | **58 条**（纯函数与并列 · 聚合与资格 · DTO 隐私 · 周期与时区 · 服务层独立重算 · 落点结构 · 加载窗口 · **8 条端到端**：接单写事件与重放 · **客服直换不计入接单榜** · **被直换者完成榜 +1 / 接单榜 +0，之后自己接一单才 +1** · `A→B→A` · **`acceptedVia` 为 `null` 时不派生** · 完成并解冻后进收入榜 · 有已批准退款不进完成榜 · **全树源码门禁**）（58 是裁定轮之后的实测值：`node --test tests/companionRankings.test.mjs` ⇒ `tests 58 / pass 58 / fail 0`；裁定前是 55） |

### 2.2 修改文件

| 文件 | 改了什么 |
|---|---|
| `lib/data/companionDispatchTransaction.ts` | 打手**自己**接单成功时，在**同一段无 await 的原子区段**内追加一条接单事件（与「派单被接走 / 订单变 `accepted` / 发通知」一起落库）；裁定轮起显式传 `"companion"`（见 §6.5） |
| `lib/data/companionOrderTransaction.ts` | **客服直接换人**：裁定轮起**不再**追加接单事件，改为 `applyDispatchAccepted(..., "staff")`（见 §6.5；⚠️ 与第一轮 M1 的处置**相反**） |
| `lib/types/dispatch.ts` | 裁定轮新增 `DispatchAcceptSource = "companion" \| "staff"`，`DispatchRecord` 新增 `acceptedVia`（见 §6.5） |
| `lib/data/mockDispatchRepository.ts` | 裁定轮：`applyDispatchAccepted()` 的 `via` 做成**必填第 4 参**并写进记录；`applyDispatchToPublic()` 回池时**一并清空** `acceptedVia` |
| `lib/data/mockCompanionAcceptRepository.ts` | 裁定轮：派生通道只认 `acceptedVia === "companion"`，`"staff"` 与 `null` 一律**不派生**（fail-closed，见 §6.5） |
| `lib/mocks/fixtures/dispatchSeed.ts` | 裁定轮：已接单的预置记录标 `"companion"`、等待池标 `null`，文件头写明这是**对种子本身的陈述**及其一行开关 |
| `lib/constants/earnings.ts` | 新增**全仓唯一**的净额算式 `earningNetAmount()`（见 §6.2 m5） |
| `lib/services/companionEarnings.ts` | 改用 `earningNetAmount()`（行为不变，去掉第二份算式） |
| `lib/constants/mine.ts` | 「我的」页新增入口 `打手排行榜 → /rank/companions`（照「打手工作台」先例，注释说明原型里没有） |
| `app/(mobile)/rank/page.tsx` | 顶部加榜单切换条（消费榜自身逻辑**逐字未动**） |
| `lib/mocks/debug.ts` | `MockEmptyScope` 新增 `"companionRankings"`（**与消费榜的 `"rankings"` 各自独立**） |
| `tests/http-smoke.test.mjs` | 追加 5 条 HTTP 契约（六键白名单、降序、禁用子串、400、参数不可注入） |
| `tests/earningSettlementFreeze.test.mjs` | 追加 `earningNetAmount` 的边界与「两处下游共用同一算式」的源码门禁（见 §7 已知缺口第 5 条） |

**文档**：`02-decisions.md`（§九-F 新增 + 裁定段）· `api-contract.md`（总数与 admin 计数、新增接口行）·
`需求功能点进度表.md`（三行翻 `AWAITING_ACCEPTANCE`）· `database-schema.md`（T4b）·
`directory-structure.md`（计数）· `总需求进度表.md` · `04-acceptance.md`（§6.1 / **§6.2 裁定轮**）。

### 2.3 **没有**碰的东西（逐条声明）

- ❌ **消费榜任何实现**：`lib/constants/rankings.ts`、`lib/services/rankings.ts`、
  `lib/data/mockRankingRepository.ts` **零改动**；`viewerUserId` 与「我的排名」原样保留。
  唯一的改动是 `app/(mobile)/rank/page.tsx` **顶部多了一条导航**（`<RankBoardSwitch>`），
  它下面的一切逐字未动 —— 这一点由 `tests/companionRankings.test.mjs` 的源码级断言守着。
- ❌ 任何 `OrderStatus` / 退款状态机 / 派单状态机 / 完成材料规则；
- ❌ `P0-14` / `P1-1` / `P1-2` / `P1-4` 的任何实现与状态；
- ❌ Scheduler、微信 OAuth、真支付、钱包 / withdrawn 追偿、chat retention（本轮**不启动 P1-6**）。

---

## §3 三张榜的口径（12 项交付说明的技术部分）

| # | 事项 | 落地 |
|---|---|---|
| 1 | **接单榜数据来源** | 接单**事件**（`CompanionAcceptEvent` 只增表）+ 存量派生；`metricFor("dispatch")` 只数事件、`isWithinRankingPeriod(event.acceptedAt)`。⚠️ 存量派生**只认** `acceptedVia === "companion"`（**见第 5 行**） |
| 2 | **完成榜数据来源** | `Order`：`status === "completed"` ∧ `actualCompanionId === 该打手` ∧ **`!hasRefundBeenExecuted(order)`**；按 `completedAt` 切周期 |
| 3 | **收入榜数据来源** | `Earning`：`status === "available"` 的 **`earningNetAmount()`** 之和；按 **`frozenAt`** 切周期。⚠️ 读榜**前**先 `materializeEarningReleases(now)` 把已到期的收益写成 `available`（见 §6.4） |
| 4 | **周期计算** | **复用** `lib/constants/rankingPeriods.ts`（`resolveRankingPeriodRange` / `isWithinRankingPeriod`），六个周期、UTC+8 —— **没有第二套周期算法**（源码级门禁守着） |
| 5 | **接单榜事件口径** | **只数打手自己成功执行的接单动作**（`acceptDispatch`）：一次 ⇒ +1。`A → B → A`（三次都是打手自己接）⇒ `A=2、B=1`；取消 / 换人 / 退款 / 完成**都不回改历史**。⚠️ **客服「直接换人 / 直接指定新打手」计入 0**（P1-5 §九-F 产品裁定，见 §6.5）——被直换的那位**仍然**正常贡献完成榜 / 收入榜，只是没有接单榜贡献。**「订单进入 `accepted`」与「产生接单事件」是两个概念**，代码里可复用的只有状态迁移函数，不是这个计数 |
| 6 | **完成榜退款排除** | 用 `hasRefundBeenExecuted(order)`（退款**已实际批准 / 出款**），**不读** `Order.status === "refunded"` —— 部分退款时订单真实状态仍是 `completed` |
| 7 | **并列排名** | **竞赛排名**：100/80/80/50 ⇒ **1/2/2/4**；稳定键（打手编号）只决定显示先后、**不改变 `rank`**；名次是**全局**的，翻页不重排 |
| 8 | **资格** | 只展示 `isCompanionListed()`（`enabled && removedAt === null`）**且该周期指标 > 0** 的打手；**没有最低单量门槛**；`available=false`（休息中）**仍然上榜** |
| 9 | **DTO 隐私** | **恰好 6 个键**：`rank` / `companionId` / `avatarUrl` / `nickname` / `metricValue` / `metricLabel`；测试对序列化结果扫禁用子串，并精确钉死键集合 |
| 10 | **与消费榜隔离** | 两个**独立地址**、两套服务、两个空榜调试键；打手榜服务**不读会话**（源码断言：不出现 `getSessionUser` / `requireUser` / `@/lib/auth/session`） |
| 11 | **测试与 review** | §4 / §5 / §6 |
| 12 | **人工验收最短路径** | `04-acceptance.md` §三 |

---

## §4 门禁读数（2026-09-29，冻结工作区）

> ⚠️ **下表是"收完 §6.5 / §6.6 全部整改之后"在最终树上重跑的读数**（顺序：targeted →
> `pnpm test` → `typecheck` → `lint` → `build` → 生产 `APP_BASE_URL` 全量 → 杀干净并验端口）。
> 目标文件：`tests/companionRankings.test.mjs` + `tests/refundOnePerOrder.test.mjs` 先单独跑，
> **85 / 85 · fail 0 · skipped 0**，再做全量。

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单元 / 集成（离线） | `pnpm test` | **1701 条 · pass 1527 · fail 0 · skipped 174**（skipped 是 HTTP 组，离线本就跳过；裁定轮之后重跑，⚠️ 这个数是**变动**的：命中并发共用 store 时会出现个别文件失败，见 §4.2） |
| 类型 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | 干净，exit 0 |
| 静态检查 | `pnpm lint` | 干净，exit 0 |
| 生产构建 | `pnpm build` | exit 0；两条新路由都出现在构建产物里：`ƒ /rank/companions`、`ƒ /api/rankings/companions` |
| **全量（含 HTTP，生产服务）** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **1701 / pass 1701 / fail 0 / skipped 0**（裁定轮之后重跑；⚠️ **不是必绿**——多次复跑里出现过 1 次 `staffRefunds` 间歇失败，**见 §4.2**） |

**生产服务复跑后已关闭**：`taskkill //PID <pid> //F`，随后 `netstat` 在 3105 上 **0 个 LISTENING**、
`curl` 返回 **000**（⚠️ 只信 `TaskStop` 会杀不干净，必须验端口）。

### 4.1 人工验收用的实测读数（**全新进程**，未跑过任何测试）

⚠️ **必须说明读数是怎么取的**：这些数取自**刚启动、没有跑过测试的服务器**。
跑一遍 HTTP 全量测试会**改动同一份内存 store**（测试会真的接单、真的完成），
之后再读就会得到一份被测试污染过的数字——这一点在验收时会直接影响「数对不对」的判断。

```
接单榜  今日   1#阿泽 3 单
        昨日   1#阿泽 4 单
        本周   1#阿泽 7 单
        本月   1#阿泽 11 单 ｜ 2#老K 5 单 ｜ 3#小北 2 单
        上月   1#阿泽 7 单  ｜ 2#小北 4 单 ｜ 3#老K 3 单
        累计   1#阿泽 18 单 ｜ 2#老K 8 单 ｜ 3#小北 7 单

完成榜  今日   1#阿泽 3 单
        昨日   1#阿泽 4 单
        本周   1#阿泽 7 单
        本月   1#阿泽 10 单 ｜ 2#老K 4 单
        上月   1#阿泽 7 单  ｜ 2#小北 4 单 ｜ 3#老K 3 单
        累计   1#阿泽 17 单 ｜ 2#老K 7 单 ｜ 3#小北 5 单

收入榜  六个周期**全部为空**（见 §7 已知缺口第 1 条）
```

**这几组数本身就是一次交叉验证**（同一个人，三张榜三个数）：

| 周期 | 阿泽 接单 | 阿泽 完成 | 差 |
|---|---|---|---|
| 本月 | **11** | **10** | 1 |
| 累计 | **18** | **17** | 1 |

差的那 1 单正是「接了但没有算作有效完成」的单（接了之后被取消 / 被换人 / 未完成，
或完成后有过已批准的退款）。**若三张榜其实是一份数据的三种排序，这两个数不可能不相等**；
而「本月」这一档更能看出差别：接单榜有 3 个人，完成榜只有 2 个——**同一个月，
两张榜的上榜人数都不一样**。**建议验收时就用这一对数字。**

⚠️ **读数必须在全新进程上取**：跑一遍 HTTP 全量测试会真的接单、真的完成，**同一个端口上的内存 store 会被改掉**（本轮就是这样：先取数，后跑全量）。

### 4.2 ⚠️ 全量 HTTP 门禁的间歇性失败（**如实登记**）

§4 那一行全绿是**实测**，但它**不是必绿**。

**统计口径**：生产服务全量复跑**共执行 5 次**（每次都是**全新进程**的服务）——
**4 次全绿**，**1 次失败**，失败文件为 `tests/staffRefunds.test.mjs`：

```
✖ tests\staffRefunds.test.mjs (744.3588ms)
  'test failed'
```

（该次的完整输出未留存，只剩文件级这一行——这是本次登记的**证据缺口**，如实说明。
该文件**单独**运行是 **28 / 28 通过**；单独并发跑 `adminRefunds` + `staffRefunds` 是 **70 / 70 通过**。）

**归属**：本轮**未改动退款域的任何代码或测试**（`tests/staffRefunds.test.mjs` 不在 §2.1 / §2.2 清单内），
改动面是排行榜域，因此这不是本轮引入的问题。

**最可能的成因（未证实）**：`pnpm test` 并发跑多个测试文件、共用**同一份 `globalThis` 内存 store**，
而 HTTP 用例真的会改数据（§4.1 的警告同源）。已定位到一个**共享写入点**：
`rf-seed-1002-01` 同时被 `tests/adminRefunds.test.mjs`（`LEGACY_PAID_REFUND`）与
`tests/staffRefunds.test.mjs`（`HTTP_TARGET`）写入。⚠️ **但按这个假设复现失败**（上面那次
两文件并发是 70/70 绿），因此**成因未坐实**，登记为**未定位的间歇失败**，不猜结论。

**处置**：**本轮不修**（属测试隔离问题，发生在 P1-5 之前，改它要动的是别的 Round 的测试）。
建议**单独开一轮**处理「并发用例共写同一份 mock store」。

---

## §5 变异探针（证明测试真的有鉴别力，不是「写完就绿」）

| # | 人为把实现改错 | 期望 | 实测 |
|---|---|---|---|
| 1 | 收入榜改回用 `incomeAmount`（不用净额） | 必须红 | ✅ 红 |
| 2 | 名次改成顺序编号（1/2/3/4，不做并列） | 必须红 | ✅ 红 |
| 3 | 完成榜的排除判据改成 `status === "refunded"` | 必须红 | ✅ 红 |
| 4 | 接单榜改为读订单当前的归属人（而不是事件） | 必须红 | ⚠️ **第一次 0 失败**——夹具里事件的 `orderId` 不对应任何订单，探针打空了。补上对应的订单后重跑 → ✅ 红（那条测试因此被重写成「四个事件各自指向退款 / 被改派 / 未完成 / 他人完成的订单」） |
| 5 | **删掉客服直换那一处接单事件写入** | 必须红 | ✅ 红（`tests/companionRankings.test.mjs` 的直换端到端测试，1 条失败），随后 `diff -q` 确认已逐字节还原。⚠️ **该期望已被 §九-F 裁定推翻**——删掉这处写入现在**正是**要去的行为（= 探针 10 的相反方向）。此条**只作当时凭证保留，不再代表期望** |
| 9 | **把直换处传的 `"staff"` 改成 `"companion"`** | 必须红 | ✅ 红（**2 条**：直换端到端 + 全树源码门禁），还原后 `sha256` 与注入前**逐一相同**（`48f94b9f…`） |
| 10 | **让直换恢复「也写一条接单事件」**（即退回第一轮 M1 的处置） | 必须红 | ✅ 红（**3 条**：两条端到端 + 源码门禁），还原后 `sha256` 相同（`5f9dcbcc…`） |
| 11 | **把派生通道的 `acceptedVia !== "companion"` 闸门去掉** | 必须红 | ✅ 红（**2 条**：直换端到端 + `acceptedVia` 为 `null` 的存量派生），还原后 `sha256` 相同（`180d566e…`） |
| 12 | **把种子里那 33 条预置记录的 `acceptedVia` 由 `"companion"` 改为 `null`**（只读实验，**未落盘**） | 派生数应从 33 变 0 | ✅ 33 → **0**（与推导一致：**这条证明了那个「一行开关」真的有效**，不是写在注释里的空话） |
| 6 | **去掉收入榜读路径上的 `materializeEarningReleases(now)`** | 必须红 | ✅ 红（`端到端：订单完成并解冻后，收入榜按净额记上这位打手`，**只红这一条**），还原后 **55/55 绿**，`sha256` 与注入前**逐一相同** |
| 7 | **把 `lib/services/companionOrders.ts` 的净额改回内联算式**（即第二轮复核新发现 #1 的那处） | 必须红 | ✅ 红（`退款 10b：净额闸与那句说明`），还原后 **15/15 绿**，`sha256` 与注入前相同 |
| 8 | **把组件里 `noticeText` 的三元兜底改回 `result.notice`**（即第二轮复核新发现 #3） | 必须红 | ✅ 红（`加载窗口：切榜 / 切周期期间不得显示上一张榜的榜名、口径说明与统计范围`），还原后 **55/55 绿**，`sha256` 与注入前相同 |

> 探针 4 是**测试自己**被发现的缺陷：它当时是「绿的」，但绿得没有意义。
> 记在这里是因为「测试通过」这句话只有在知道它能红之后才有信息量。
>
> 探针 7 还额外验证了**门禁的扫描范围**：这条门禁第一版是**手写清单**（只列了收入榜与收益页
> 两个文件），**恰好漏掉** `companionOrders.ts`——手写清单漏一个文件时测试**仍然是绿的**。
> 现在它改成扫 `lib` / `components` / `app` 下全部 `.ts` / `.tsx`，并额外断言
> 「扫描结果里必须有这四个已知文件」，避免「扫了个空」也算通过。
> （另外还用一个**临时文件**做过一次同类探针：在 `lib/services/` 放一个含内联算式的新文件 ⇒
> 门禁点名报出该文件；用完已删。）

---

## §6 Review

### 6.1 第一轮结论

**0 BLOCKER · 3 MAJOR · 6 MINOR · 5 NOTE。**

### 6.2 处置

| 编号 | 内容 | 处置 |
|---|---|---|
| ~~**M1**~~ | 客服「直接换人」不写接单事件，而 `deriveLegacyAcceptEvents()` 会为 `state === "accepted"` 的派单记录派生一条 ⇒ **同一个业务动作，存量数据算 1、新数据算 0** | ⚠️ **处置已被推翻（见 §6.5）**——当时的修法是「在 `if (input.reassign)` 分支的原子区段内追加 `appendCompanionAccept()`」。**产品负责人裁定的方向恰好相反**：直换**不该**产生接单事件，并且**存量派生也必须跟着改**（原 M1 只改了写入侧、没动派生侧）。**新处置见 §6.5**。**探针 5 随之失效**（见 §5）|
| **M2** | 三份真值源文档没跟上源码 | **已修**：`api-contract.md`（138 / admin 64 / 新增接口行）、`需求功能点进度表.md`（三行 → `AWAITING_ACCEPTANCE`）、`database-schema.md`（T4b + 一处 P0-11 之后就没更新的旧断言），另发现并修 `directory-structure.md` 的两个陈旧计数 |
| **M3** | 接单写入路径（含直换分支）没有测试保护 | **已修**：见 M1 的测试与探针 5 |
| m1 | 三榜共用一句「时间以订单的完成时间为准」，与接单榜 / 收入榜不符 | **已修**：逐榜各写自己的时间基准（接单 `acceptedAt` / 完成 `completedAt` / 收入 `frozenAt`），并加断言 |
| m2 | 口径说明里的 `**` 在界面上原样显示 | **已修**：删掉全部 Markdown 星号，并加「不得出现 `*`」断言 |
| m3 | 前三名奖牌按数组下标发，并列时「并列第 2 名一个金一个银」 | **已修**：新增纯函数 `formatCompanionMedal(rank)` 按**名次**发牌，删掉 `MEDALS` 表，加并列断言与源码门禁 |
| m4 | 加载文案用上一张榜的榜名 | **已修**：改用当前选中的 `board` |
| m5 | 净额算式重复（且真的会分叉） | **已修（第二轮又补了一刀，见下）**：抽出 `earningNetAmount()`，收入榜与收益页共用，加源码门禁禁止重写 |
| **M2′** | 第一轮的 M2 **没同步干净**：`api-contract.md` 里还有三处旧数「63」（§12 标题 · 第 13 节的表 · 「清单数组本身是 63 条」），另有两处漂移（`:330` 的「管理端 63 / 客服端 16」是 P0-5.5 当时的数） | **已修**（第二轮复核提出）：三处改为 **64**；`:330` **保留历史数字并就地说明**「这是 P0-5.5 当时的数字，现为 64 / 25」，不把历史改写成现值；第 13 节的表补上 P1-3 的 `/api/admin/aftersales` 归属；顶部 changelog 把 **P1-3 的 +1** 与 **P1-5 的 +1** 拆成两行（136 → 137 → 138），并新增 **§12.8** 给这条一直只出现在计数里、没有小节的 admin 路由 |
| **#1′** | 净额算式**还有第三份**：`lib/services/companionOrders.ts:101`（打手订单列表的「本单收益」）自己抄了一遍——于是「全仓唯一算式」在当时是**假话** | **已修**：改走 `earningNetAmount()`。⚠️ 字面相同、当天行为也相同，它坏在**将来**：给算式加夹零 / 改口径时，收益页与收入榜会一起变，这一处不会——同一笔钱在三个界面上出现两个金额 |
| **#2′** | 「算式不得重写」的门禁**只扫两个文件**，而重复点恰在**没被扫的**第三个文件里 ⇒ 这条门禁给的是**假安全感** | **已修**：改成扫 `lib` / `components` / `app` 下全部 `.ts` / `.tsx`，只豁免算式定义处；并断言「扫描结果里必须有那四个已知文件」 |
| **#3′** | 切榜 / 切周期的加载窗口里，「口径说明」与「统计范围」仍然读上一张榜的 `result` ⇒ 屏幕上同时出现「加载完成榜…」与「统计范围：…（接单榜那一周）」 | **已修**：口径说明改为「响应就是当前榜时才用响应里那一句，否则调**同一个纯函数**兜底」；统计范围走完整的 `boardMatches` 闸门（它同时依赖周期），并对「加载中 / 失败」分别给话（失败时说「正在重新统计」会是一句永不兑现的承诺）。补 1 条测试 + 探针 8 |
| **#4′** | `directory-structure.md` 的**分目录计数**（companion 8 / staff 22 / admin 62）与同一份文档开头的 138 / 64 / 25 / 12 自相矛盾 | **已修**：改成 12 / 25 / 64 并写明实测时点与 101 + 37 的对账 |

### 6.3 第二轮（针对上述修改）

**结论：0 BLOCKER · 0 MAJOR（新开）· 2 条待整改的 MAJOR 级残留 + 2 条 MINOR，全部已修。**
第二轮复核的是**修改本身**，不是原始实现；它**逐条正面确认**了：

- **M1 的写入位置正确**（⚠️ **该结论本身仍然成立，但它证明的是「当时那处写入位置对」，不是「那处写入该存在」——该写入的存在性已被 §九-F 裁定推翻，见 §6.5**）：在 `releaseCurrentAssignment` 的**无 `await` 原子区段**内、
  在 `applyOrderAccepted` 之后；`same-companion` 闸（`replaceOrderCompanionByStaff`）
  使「同一人」不写第二条，**重试也不会追加**；三处 `acceptedAt` 同源（都吃 `input.at`）；
  无循环依赖；并**穷举**了 `applyDispatchAccepted(` 的全部调用点（全仓**仅两处**，
  另一处 `companionDispatchTransaction.ts` 本轮之前就有写入）——**没有第三个漏网的分支**。
- **m1** 三句时间基准与 `metricFor` 真正读的字段**一一对应**（`acceptedAt` / `completedAt` / `frozenAt`）；
- **m2** 界面无未渲染的 Markdown（含空态文案）；**m3** 奖牌按名次在 `1/1/3`、`1/2/2/4`、`1/1/1`
  三种并列下**都自洽**（`MEDALS` 已删且被源码门禁钉住）；
- **M2 的大部分**：`database-schema.md` 的 T4b（两处写入者 / 类型 / 「不得在 `dispatch_id` 上建唯一索引」）
  与源码一致；`需求功能点进度表.md` 三行状态正确；接口计数实测 138 / 64 / 25 / 12 与文档头部一致。

**它提出的 4 条（2 条 MAJOR 级残留 + 2 条 MINOR）已全部处置**，见 §6.2 的 **M2′ / #1′ / #2′ / #3′ / #4′**。
其中 **#1′ 是本轮唯一一条「文档里写的话当时是假的」**——`earningNetAmount` 的「唯一算式」
在三个地方（函数注释 / 需求功能点进度表 / 测试注释）都写了，而实际存在第三份副本。
**这条不是第二轮复核从代码里推出来的，是从「文档的说法」与「全仓 grep」对不上发现的**：
说明真值源文档与源码必须**互相校验**，只读其中一边都发现不了。

⚠️ **第二轮仍留 1 条 NOTE 未修（如实登记）**：**「直换两次」（A→B→C 都走客服直换）没有直接用例**。
判定为 NOTE 而非缺陷的理由：它与单次直换走的是**同一个 `reassign` 分支**、同一条写入原语，
计数结果 A=1 / B=1 / C=1 也不会错；**但「结构上覆盖」不等于「有用例」**——若将来有人把该分支
改成「只给最后一次」，聚合仍会正确，只有连换两次的形态会错。
登记在此，作为将来补用例的入口，**本轮不补**。

### 6.4 自查发现、**不在 reviewer 清单里**的一处二阶缺陷（收入榜读路径不物化到期收益）

**症状**：打手完成订单、投诉窗口到期之后，打开自己的收益页会看到那笔钱**已经可提现**，
而打开打手榜的收入榜却仍然是 **0**。**同一个事实，两个页面给出两个答案，且榜单那一个是错的。**

**根因**：裁定 §5 规定收入榜**只统计 `Earning.status === "available"`**，而一笔收益在
`availableAt` 到点之后**就已经**可提现了——它还没有被写成 `available`，只是因为
**还没有人走过会触发清扫的那条路径**。本仓既有的做法就是把 sweep 挂在读取路径上
（`architecture-rules.md` §392 明写：派单超时 / 完成自动审核 / 收益解冻三条目前都挂在读路径上，
将来接真 Scheduler 时让 Scheduler 调**同一批函数**）。收益页那条在
`lib/services/companionEarnings.ts` 的 `materializeEarningReleases()`。

**修法**：在 `lib/services/companionRankings.ts` 的 `getCompanionRanking()` 里、
`withMockDebug` 回调的**最前面**、读收益**之前**补上同一个 sweep：

```ts
// 必须在读收益**之前**：收益榜读的是清扫后的状态
materializeEarningReleases(now);
```

⚠️ 用注入的 `now` 而不是 `new Date()`：周期范围也是按 `now` 算的，
两处用不同的时刻会出现「范围说这一天、清扫按另一天」，测试也无法复现。

**为什么必须修而不是留着**：「谁碰巧先看了一眼」不能决定一个数字对不对。
若按「验收时先打开收益页、再打开榜单」的顺序走，会得到一个正确结果而**掩盖**这个缺陷；
按相反顺序走就会得到一个错误数字——**一个依赖访问顺序的榜单**在验收中是无法判定的。

**测试**：`tests/companionRankings.test.mjs` 的
`端到端：订单完成并解冻后，收入榜按净额记上这位打手` —— 它**不显式调用 sweep**，
只把 `now` 推到窗口之后**读一次榜单**，断言那笔收益出现且存储里真的解冻了
（即：读榜这一个动作本身必须完成任务）。

### 6.5 第三轮：§九-F 产品裁定之后的改动（**推翻第一轮 M1**）

**裁定正文**（逐字）：见 `02-decisions.md` §九-F 的「✅ 裁定结果」段。要点：

> **客服「直接换人 / 直接指定新打手」不计入接单榜。** 接单榜统计的是
> **Companion 自己成功执行接单动作的次数**。即使底层为了订单状态迁移复用了
> `applyDispatchAccepted()`，也**不得**因为复用了同一个状态迁移函数，
> 就把 Staff assignment 当成 Companion accept event。需要把
> **「订单进入 `accepted` 状态」** 与 **「产生 `CompanionAcceptEvent`」** 这两个概念**分离**。
> 同时修正存量派生逻辑：`deriveLegacyAcceptEvents()` 不得把能够识别为 Staff direct
> replacement / assignment 的历史绑定记录推导成 `CompanionAcceptEvent`；
> 如果历史数据无法区分，**不得凭空补接单事件**。宁可继续保持
> 「存量接单榜是历史下界」。**不要为了让历史数字好看而伪造主动接单行为。**

#### 6.5.1 「订单进 accepted」与「产生接单事件」怎么在代码里分开

两者都要**可判**、且**默认安全**，因此加了一个**来源字段**而不是靠「谁调用的」去猜：

| 层 | 落点 | 作用 |
|---|---|---|
| 类型 | `lib/types/dispatch.ts` 的 `DispatchAcceptSource = "companion" \| "staff"` | 把「谁发起的这次绑定」写成**类型**，而不是注释里的约定 |
| 字段 | `DispatchRecord.acceptedVia` | 持久化来源；**与 `acceptedByCompanionId` 同生共死** |
| 写入 | `applyDispatchAccepted(id, companionId, at, via)` | `via` 是**必填第 4 参**：新加的绑定入口**不填就编译不过**（选必填而非可选+默认值，是因为「可选 + 默认」等于把这条保证交给记性） |
| 回池 | `applyDispatchToPublic()` | 绑定被清空时**一并清成 `null`**——否则会出现「没人接、却记着上次是谁发起的」，而那条自相矛盾的记录正好会被存量派生通道读到，**变成一次不存在的接单** |
| 派生 | `mockCompanionAcceptRepository.deriveLegacyAcceptEvents()` | 只认 `"companion"`；`"staff"` 与 `null` **一律不派生**（**fail-closed**，两档方向一致） |

**两处调用点，各自显式声明来源**（全仓仅两处，源码门禁钉住）：

- `lib/data/companionDispatchTransaction.ts` → `"companion"`（打手自己接单）
- `lib/data/companionOrderTransaction.ts` → `"staff"`（客服直换），**并删掉了原先的 `appendCompanionAccept(...)` 与它的 import**

**产品口径在代码里的落点**：「被直换的那位仍然正常贡献完成榜 / 收入榜」**不需要改任何代码**——
完成榜读的是 `Order.actualCompanionId` + `completedAt`，收入榜读的是 `Earning`，
它们**从来就没读过接单事件**。裁定影响的只是**接单榜这一个入口**。

#### 6.5.2 测试：58 条，覆盖裁定的六项要求

| 裁定的要求 | 用例 |
|---|---|
| ① 自己 `acceptDispatch` ⇒ +1 | 「一次真实接单正好写一条接单事件（重放不追加），接单榜 +1」 |
| ② A 自己接 → 客服直换 B：A +1、B +0 | 「客服「直接换人」不计入接单榜——订单进 `accepted`，但**不产生接单事件**」（断言 `acceptedVia === "staff"`、事件表里只有 A 那条、**该派单的存量派生为 0**、A +1 / B +0） |
| ③ 被直换的 B 完成：接单榜 +0、完成榜 +1 | 「被直换的人接单榜 +0、完成榜 +1；他之后**自己**接一单才 +1」（前半段） |
| ④ B 之后自己接另一单 ⇒ +1 | 同上（后半段） |
| ⑤ legacy 派生不得把可识别的 Staff 直换算成接单 | 同上（②③ 的派生断言）+「存量派生：`acceptedVia` 为 `null`（认不出来源）时**不派生**」 |
| ⑥ A→B→A 主动接单场景仍正确 | 原用例改为**差值断言**：A 恰好 `+2`、B 恰好 `+1` |

**另加一条全树源码门禁**（不是手写清单）：扫 `lib` / `app` / `components` 下全部 `.ts` / `.tsx`，
断言「全仓唯一写接单事件的地方是 `companionDispatchTransaction.ts`」，并断言两个
`applyDispatchAccepted(` 调用点**分别**传 `"companion"` / `"staff"`。
**刻意不维护名单**——上一轮 §5 探针 7 已经证明过手写清单漏一个文件时测试**仍然是绿的**。

⚠️ **种子的判断（本轮唯一一处需要产品负责人过目的选择）**：`dispatchSeed.ts` 把已接单的预置记录
标成 `"companion"`。**这不是在给历史背书，是在陈述种子本身**——依据**只有一条**：
这批预置记录在**其他所有**读取路径上都讲着同一个「普通接单 → 履约」的故事
（`actualCompanionId` / `acceptedAt` 与派单记录同源），**种子里没有第二套说法**。
（⚠️ 曾写过第二条依据「退出历史 store 建库时是空 Map，而客服直换必然写一条 release 记录，
所以种子里没有换人」——**那是自证**：那个 store 为空是因为**没人给它预置数据**。
该条已从种子文件与本节一并移除，理由留在种子文件里免得下次再被想出来。）
**若产品负责人认为存量接单榜应当连这批预置数据也排除**，
把 `dispatchSeed.ts` 里那个 `"companion"` 改成 `null` 即可（**一个值**，探针 12 已实测该开关有效）。
⚠️ **改的代价要先说清**：存量接单榜会**立刻变空**——`04-acceptance.md` §二 那份
「阿泽 18 / 老K 8 / 小北 7」的验收读数全部归零，只剩真实产生的接单事件（全新进程上为 0）。
这是 §九-F「不得凭空补」的**最严读法**，可由产品负责人一句话推翻。
选择理由与开关位置都写在该文件头部，`04-acceptance.md` §6.2 同样登记。

#### 6.5.3 基线**一个字都没变**（最该看的一行）

裁定轮之后，在**全新进程**上把六个周期逐一读过：接单榜 今日阿泽 3 / 昨日 4 / 本周 7 /
本月 阿泽 11、老K 5、小北 2 / 上月 阿泽 7、小北 4、老K 3 / 累计 阿泽 18、老K 8、小北 7；
完成榜与收入榜同 §4.1。**原因是种子里本来就没有客服换人的样本**——实测 33 条
`state === "accepted"` 的预置派单记录**全部**是 `acceptedVia: "companion"`，
派生出的存量事件数也是 33（探针 12：置 `null` ⇒ 0）。

**这一行同时说明了一件事**：如果这批预置数据里混着客服直换，数字**会**变——
所以「没变」是**被读出来的**，不是被假设的。

### 6.6 对 §九-F 改动的**独立只读复核**（裁决：**0 BLOCKER · 2 MAJOR · 5 MINOR · 3 NOTE**）

复核的是**改动本身**（不是原始实现）。它**逐条正面确认**了本次改动的核心：

- **两个概念确实分开了**（穷举，不是抽样）：全仓**唯一**写接单事件的地方是
  `companionDispatchTransaction.ts:327`（在重放分支**之后**、无 `await` 区段内）；
  会写「订单/派单进 `accepted`」的路径**恰好三条**——`applyDispatchAccepted` 的两个调用点
  （`"companion"` / `"staff"`）与新建派单（`acceptedVia: null`），其余命中都是
  **种子**或**响应 DTO 字面量**；`releaseCurrentAssignment` 的 4 个调用者里只有
  `replaceOrderCompanionByStaff` 传 `reassign`，管理端**没有任何指派 / 换人路由**。
  **不存在第三条绑定入口。**
- **`acceptedVia` 没有外泄**：`toStaffOrderDispatchSummary` / `toCompanionPoolItem` 都是显式挑字段，
  `grep acceptedVia` 在 `app/` 与 `components/` 下命中 **0**。
- **必填参数在 `.ts` 世界里真的挡得住**：两个 `.ts` 构造点都已补字段，全仓无
  `as unknown as` / `@ts-ignore`，`typecheck` exit 0。
- **裁定的六项要求在测试里逐条对得上**；**A→B→A 口径未被破坏**（实测：事件表 3 条，
  与 `mergeAcceptEvents` 的按 `dispatchId` 去重不冲突，派生那条被同 dispatchId 的真实事件挡掉，**不重复计数**）。

#### 6.6.1 两条 MAJOR（**都是文档**，已在 §6.5 的同步里修掉）

| 编号 | 内容 | 处置 |
|---|---|---|
| **M1′** | `database-schema.md` 的 T4b CURRENT 段仍写着「写入者是 …… 与 `lib/data/companionOrderTransaction.ts`（**客服直换——新打手同样留下一条**）」，与代码**相反**。复核指出这是「**会把下一个开发者引回被推翻的口径**」的真值源 | **已修**：改成**写入者表**（打手自接 ✅ / 客服直换 ❌）并把 §九-F 原文与「首版曾让直换也写一条、已被推翻」写在一起 |
| **M2′** | `总需求进度表.md`（全局进度唯一真值源）的 `:122-124` 与 P1-5 行仍写着**被推翻的处置**与「**待追认**」——而同一工作区里 `02-decisions.md` / `04-acceptance.md` / `需求功能点进度表.md` 三处都已改到位 ⇒「同一事实两个互相矛盾的账」 | **已修**：两处都改为「已裁定：不计入」，M1 栏改为「处置已被推翻，见 §6.5」，并把门禁读数同步到 **1701** |

⚠️ **这两条值得记一笔**：复核明确说代码层 **0 BLOCKER / 0 MAJOR**，MAJOR **全在文档**。
这与第二轮的经验**方向一致**（当时也是「文档里写的话当时是假的」最难被发现）：
**裁定推翻了实现，就要连"讲这件事的那几份文档"一起翻**，只改代码等于把矛盾搬了个家。

#### 6.6.2 五条 MINOR（全部已修）

| 编号 | 内容 | 处置 |
|---|---|---|
| m1′ | `lib/types/companionAccept.ts` 的 `DerivedAcceptEvent` 文件头**没跟上**——仍读作「凡是 `state === "accepted"` 的存量记录都会派生」 | **已修**：补「第二个前提是 `acceptedVia === "companion"`，`"staff"` 与 `null` 一条都不补」 |
| m2′ | `database-schema.md` 的 Dispatch **关键字段表**没登记 `acceptedVia`；T4b「迁移期数据」行没写来源前提 | **已修**：字段表补上；T4b 那一行改为「**且来源可辨识为打手自接**的记录只有最后一次可考据」 |
| m3′ | `tests/companionRankings.test.mjs` 那条自称**独立 oracle** 的重算用例，判据里**没有** `acceptedVia`。⚠️ 它今天绿**只因为**种子那 33 条恰好标了 `"companion"` | **已修**：重算循环补 `if (record.acceptedVia !== "companion") continue;`，并写明「少了这个条件，种子一改口径它就**假红**，而且它把被推翻的口径当成了判据」 |
| m4′ | `tests/refundOnePerOrder.test.mjs` 的手写派单夹具**缺** `acceptedVia` ⇒ 运行期是 `undefined`（`.mjs` 不进 `tsc`，**没有编译期保护**） | **已修**：默认值与两处「回池」覆盖都补 `acceptedVia: null`。⚠️ 今天无害（读者判 `!== "companion"`，`undefined` 走不派生，方向正确），**但它是一条"类型说必填、实际没人管"的现成范例，下一份夹具会照抄** |
| m5′ | **全树源码门禁的边界**：排除是**整文件**粒度 ⇒ ① 在定义所在文件里加第三个调用不红；② `repo["appendCompanionAccept"](...)` 不含字面子串；③ **直接写 store**（`companionAcceptStore().events.set(...)`）文本扫描完全无效 | **已修（改的是说法，不是门禁）**：在门禁用例的注释里逐条写清「拦什么 / **不拦什么**」，并点明「真正的行为保证在**端到端用例**里，本条只作补充」。⚠️ **不假装它是结构上不可能** —— 那正是上一轮「假安全感」的同一个形状 |

⚠️ **m3′ 是本轮最值得记的一条**：它绿得**没有信息量**——绿的原因恰好是种子被标成了它想验证的那个值。
**把「被推翻的口径」写进"独立 oracle"**，是裁定之后最容易留下的暗坑：测试改了实现、没改判据，
于是它继续为旧规则背书。**修完之后它与新口径一致，且不再系于种子那一行。**

#### 6.6.3 三条 NOTE（**1 条改说法、1 条如实登记、1 条不动**）

| 编号 | 内容 | 处置 |
|---|---|---|
| n1′ | 种子里 `"companion"` 的**依据 1 是自证**（「退出历史建仓为空」是因为没人预置，不是因为没发生过换人） | **已修（措辞）**：把那条不成立的依据**删掉并留在文件里明说为什么不成立**（免得下次再被想出来），只保留真正站得住的一条（**读路径说法一致**）；并补上「改成 `null` 的代价是验收读数归零」。⚠️ 复核实测：44 单 → 40 条派单（`public: 7`、`accepted: 33`），33 条里 `exclusiveCompanionId !== acceptedByCompanionId` 的**一条都没有** |
| n2′ | `applyDispatchTimedOut()` **不清**接单绑定 ⇒ `state === "timed_out"` 的记录上三个字段都留着旧值，而我写的「**同生共死**」那句话是**假的** | **已修（改说法，不改行为）**：`lib/types/dispatch.ts` 的注释改为「**回公共池时**必须一并清空」+ 明写 `applyDispatchTimedOut` 这一例外是 **P0-6 起的既有行为、本轮刻意不改**（改它会动别的 Round 的语义）+ 明写**读者必须把 `state` 当第一道闸**。⚠️ 今天无害：唯一读者 `deriveLegacyAcceptEvents()` 第一句就是 `if (record.state !== "accepted") continue;` |
| n3′ | 一批端到端断言用**差值**（`before + 1`）而不是绝对值，依赖种子成立 | **不动**（复核也建议保留）：这正是「不把种子数字钉死」的刻意约定 |

#### 6.6.4 整改后的重跑（**这是 §4 那些读数的来源**）

targeted（`companionRankings` + `refundOnePerOrder`）**85 / 85 · fail 0 · skipped 0** →
`pnpm test` **1701 · pass 1527 · fail 0 · skipped 174** → `typecheck` **exit 0** →
`lint` **exit 0** → `build` **exit 0** →
生产 `APP_BASE_URL=http://localhost:3105 pnpm test` **1701 / 1701 · fail 0 · skipped 0**。
服务 `taskkill //PID 19204 //F //T` 后 `netstat` 在 3105 上 **0 个 `LISTENING`**（只剩 `TIME_WAIT` 的
**客户端**套接字，不是监听）、`curl` 返回 **000**。

**预置基线在最终树上重取，逐字未变**：接单榜 今日 3 / 昨日 4 / 本周 7 / 本月 11·5·2 /
上月 7·4·3 / 累计 18·8·7；完成榜 3 / 4 / 7 / 10·4 / 7·4·3 / 17·7·5；收入榜六档全空。
⚠️ 这次是在**改完全部注释、文档与测试判据之后**、在**全新进程**上取的——
「基线没变」是**读出来的**，不是从「我只改了注释」推出来的。

⚠️ **本轮仍留一条 NOTE 未处置**（如实登记，非缺陷）：复核指出「`via` 做成必填**只在 `.ts` 生效**，
`.mjs` 夹具是唯一的漏洞面」——彻底的堵法是给 `applyDispatchAccepted` 加**运行期断言**。
**本轮不加**：那是一个**新的决定**（会给一个纯状态迁移函数引入运行期校验），
且既有测试全绿、方向 fail-closed，不属于「修 BLOCKER / MAJOR」的范围。

---

## §7 已知缺口（**如实列出，不要当成已完成**）

1. **收入榜在全新进程上是空的**（六个周期全空）。原因不是实现错，而是**没有任何预置的
   `available` 收益**：收益在订单完成后先 `frozen`，要等投诉窗口
   （`COMPLAINT_WINDOW_DEFAULT_MINUTES = 1440`，**最小 60**，`lib/constants/platformConfig.ts:105`）
   到期才 `available`。因此「看收入榜有数」这条验收**必须先真的跑完一单并等到解冻**。
   最短路径写在 `04-acceptance.md` §三。⚠️ **收益只在运行时产生、内存 store 随重启清空**，
   所以「重启后收入榜又空了」是**预期行为**，不是回归。
2. **接单榜在存量数据上是下界**（裁定轮起**更低**）：P1-5 之前的历史单只有派单记录上仍写着的
   那一位能派生出来（派单记录只保留当前接单人）。因此**历史上真的发生过 `A → B → A` 的存量单**
   只算最后一次。裁定轮之后又收窄两层：**能识别为客服直换的存量记录不派生**，
   **认不出来源（`acceptedVia === null`）的也不派生**——**宁可低，不补**。
   这是**数据可获得性**限制 + 产品裁定有意选择的保守方向，换真实数据库后前者不再有
   （`database-schema.md` T4b 的迁移约束），后者**保留**（它是口径，不是缺陷）。
3. **`P1-5` 第一版不做「我的排名」**（裁定 §10）；消费榜自己的「我的排名」**原样保留**。
   ⚠️ 两者是**两个独立业务维度**，不得合并。
4. **`P2` 的 综合榜 / 完成率 / 评价 / 投诉率 仍为 `NOT_IMPLEMENTED`**，B/A/S 档门槛的 `TBD` 继续保留。
5. **在 `tests/earningSettlementFreeze.test.mjs`（P0-15 的文件）里追加了断言** ——
   `earningNetAmount` 这个新函数的自然归宿就是它旁边那个 `isEarningFullyReversed`。
   ⚠️ 该文件在本批次**尚未提交**（`git status` 里是 `??`），因此这是**在一个未提交的
   他轮文件中追加**，不是改写已归档的历史 Round 文档。若 review 认为不应如此，挪走即可。
6. **`docs/CLAUDE.md` 的「Project state」表仍是旧数**（写着 131 条接口 / 80 个页面，
   实测 138 / 85）。⚠️ **本轮未改**：那是用户自己维护的指令文件，且历轮都未同步过，
   改它属于「动用户的文件」，留给产品负责人决定。
7. **收入榜的周期基准是 `frozenAt`（= 订单完成时刻）而不是解冻时刻** ——
   见 `02-decisions.md` §九-B，**需追认**（登记在 `04-acceptance.md` §五）。
8. **`applyDispatchTimedOut()` 不清接单绑定**（§6.6 n2′）：一条 `state === "timed_out"` 的记录上
   `acceptedByCompanionId` / `acceptedAt` / `acceptedVia` **三者都留着旧值**。
   ⚠️ 这是 **P0-6 起的既有行为，不是本轮引入**；本轮**刻意不改**（改它会动到别的 Round 的语义）。
   **今天的读者安全**：唯一读者 `deriveLegacyAcceptEvents()` 以 `state === "accepted"` 为第一道闸。
   **风险面**：将来新增读者若跳过 `state` 判断，会读到一次**不存在的接单**——
   已在 `lib/types/dispatch.ts` 的字段注释里明令「读者必须把 `state` 当第一道闸」。
9. **源码门禁只拦字面调用，不拦刻意绕路**（§6.6 m5′）：按文件粒度的排除会让定义所在文件被整体豁免；
   不含字面子串的取用（`repo["appendCompanionAccept"](...)`）与**直接写 store**
   （`companionAcceptStore().events.set(...)`）都扫不出来。⚠️ **不要把它读成「结构上不可能」**
   —— 真正的行为保证在**端到端用例**里，门禁只作补充。这条边界已写进用例注释。

---

## §8 Git 状态

⚠️ 本批次**全程禁止任何 Git 写操作**。`Git Commit:` 保持 `—`。
本轮所有产物都在**未提交的工作区**里，与 P0-14 / P1-1 / P1-2 / P1-4 的未提交工作区**并存**。
⚠️ **无法按 Round 归属这份脏工作区**（多轮改动交织在同一批文件上），
因此 §2 的清单是**按职责**列的，不是按 diff 归属列的。
