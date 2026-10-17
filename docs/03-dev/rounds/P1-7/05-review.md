# P1-7 · 交付前审查

> Round：`P1-7` 老板数据面板 + 消费累计口径统一
> 审查日期：**2026-10-01**
> 审查方式：**只读**代码审查（对照 `docs/01-requirements/**`、`architecture-rules.md`、
> `lib/constants/levels.ts` 口径链、状态机与仓储、DTO 隐私、幂等并发、测试缺口）。
> **审查方未修改任何文件、未执行任何写操作。**
> 处置日期：**2026-10-01**（同日返工并重跑全部门禁）

---

## 一、审查结论

| 级别 | 条数 |
|---|---|
| `BLOCKER` | **0** |
| `MAJOR` | **2** |
| `MINOR` | **3** |
| `NOTE` | **4** |

审查方对**口径主线**的判断是干净且可信的：`effectiveSpendOf` 确实是全仓唯一一份
`actualPaidAmount − refundedAmount`，`sumEffectiveSpend` 与 `sumSpendWithinRange` 都汇流到它；
`/api/me/boss-stats` 的鉴权、DTO 键集、服务端/浏览器分层**未发现问题**；
`appendCompanionService` 落在无 `await` 的原子区段内且由状态迁移唯一驱动；
`D1`–`D12` 的语义逐条比对后**未发现落地错误**。

两条 `MAJOR` 都不是「当前功能错」，而是**「下一个改这里的人会改错地方 / 静默回退没人发现」**。
按用户指令「修复全部 `BLOCKER` / `MAJOR`」，**两条都已修**；顺带把三条 `MINOR` 也收掉了。

---

## 二、逐条处置

### M1 · 「累计订单数」有两条实现，其中一条是死代码 —— ✅ 已修

**问题**：`lib/constants/levels.ts` 的 `countLifetimeOrders()` 全仓零调用点、无任何测试，
而它正是 `02-decisions.md` 的 `D1` **点名**的落点；实际生效的是 `lib/constants/bossStats.ts`
里一份**逐字相同**的 `countOrders()`。下一个按 `D1` 去改落点的人会改到死的那一份，
改完无调用方受影响、无测试变红，**面板上的数字一动不动**。

**修法**：**只保留一份实现**——删掉 `bossStats.ts` 的 `countOrders()`，
`buildBossStatsSummary` 直接调用 `levels.ts` 的 `countLifetimeOrders()`
（与它在同一函数里调用 `sumEffectiveSpend` 是同一条纪律：口径住在 `levels.ts`，面板只组装）。
原地留一段注释说明「这里曾经有一份副本、为什么不能再写一份」。

**同时加固**：`tests/bossStats.test.mjs` §二 现在直接单测那个唯一实现，并补了一条
`countLifetimeOrders(orders) !== countEffectiveOrders(orders)`——
若将来有人把「历史总量」与「参与消费统计的有效量」合并成一份语义，这条会红。

### M2 · `appendCompanionService` 的生产写入点无测试覆盖 —— ✅ 已修（含红绿验证）

**问题**：唯一的生产调用点 `lib/data/companionOrderTransaction.ts:547` 从未被任何测试走到
（原有测试只**直接调用原语**）。**把那一整段删掉，没有任何测试会失败**：
「常用打手」不会报错，而是悄悄退回 `deriveLegacyServiceEvents()` 的下界——
换过人的历史服务永久丢失，而那正是 `D7` / `D10` 要解决的原始缺陷。

**修法**：`tests/companionServing.test.mjs` 新增 **`开始 3c`**，驱动真实 `startCompanionOrder`：

1. 事件表**恰好新增 1 条**，且 `orderId` / `companionId` / `servingAt` / `dispatchId` /
   `companionName` / `companionAvatarUrl` 与订单上冻结的那一份**逐项一致**（名字是快照，不读当前实体）；
2. **重放不新增**（重复点击不得让次数虚高）；
3. 端到端：这一单**同时**出现在事件表与 legacy 派生里（派生照旧看得到它），
   因此把两者合并喂给 `buildCompanionUsage` 后必须**只算一次**——
   去重坏了页面上不会报错，只会让次数偏大。

**红绿验证（`verification-before-completion` 要求）**：临时把生产写入改成 `if (false) appendCompanionService({…})`，
重跑 → **`开始 3c` 失败，且只有它失败**（`tests 20 / pass 19 / fail 1`，断言落在
「一次 accepted → serving 恰好写一条服务历史」）。恢复后 → `tests 20 / pass 20 / fail 0`。
`git diff --stat` 复核该文件仍是 **+21 / −1**，即本轮原本的改动量，**没有残留的临时改动**。

### m1 · 服务层用例断言过弱 —— ✅ 已修

原有断言是 `orderCount > 0` / `recent30dSpendAmount > 0` / `recentGames.length > 0`，
且 `recentCompanions` 的 `for` 循环**没有非空断言**——列表为空时循环体一次都不执行，
用例照样绿。现在五个指标全部**逐一钉死**（`16 · 24060 · 14780` ·
游戏 `[三角洲行动 3, 无畏契约 2]` · 打手 `[cp-1 ×3, cp-3 ×3, cp-4 ×1]`），
并补 `recentCompanions.length === 3` 与另一用户 `u-1002` 的精确值。

### m2 · 「常用打手」Top3 截断路径从未被执行 —— ✅ 已修

原有夹具恰好都 ≤ 3 位打手，`slice(0, topN)` 那一步**从来没跑过**。
新增 5 位打手、且在**截断边界上制造并列**（cp-b / cp-c / cp-d 各 2 次）的夹具：
断言截断到 3 位、第三名由「最近服务时间」决定、**倒序输入结果不变**、
以及 `topN` 参数化（`5` 全出、`1` 只出第一名）确实生效。

### m3 · 新客户端组件未纳入「Mock 不得进浏览器产物」门禁 —— ✅ 已修

把 `components/mine/BossStatsCard.tsx` 与 `BossStatsPanel.tsx` 加进
`tests/levels.test.mjs` 那份清单，并在清单里注明「新增客户端组件要一起加到这里」。

---

## 三、`NOTE` 的处置

| 编号 | 内容 | 处置 |
|---|---|---|
| `n1` | `D10` 附加要求第 3 条（复用 assignment identity）**未落地**：去重键是 `(orderId, companionId, servingAt)` | **审查当时**如实登记为刻意偏离（`03-delivery.md` §6.1）。**2026-10-02 产品验收前裁定：接受当前实现，并正式收窄 `D10` 第 3 条**——`CompanionServiceEvent` 只管 `order + companion + servingAt` 的 append-only 服务历史，**不承担**跨域统一 Assignment identity，该三元组**只是本轮去重语义**、**不得**称作 Assignment identity；统一迁移**只在正式建立 Assignment 聚合时**做。逐字见 `02-decisions.md` §8.1。**故本条已不是待裁定的偏离，而是产品裁定的既定范围** |
| `n2` | `recent30DayRange` 的 `end` 取「现在」而非「明天 00:00」 | **不改**。`completedAt` 不可能是未来时刻，`at >= start && at < end` 在真实数据上与 `D2` 的 30 个自然日**等价**；注释已说明与 `resolveRankingPeriodRange` 的开放周期一致 |
| `n3` | `sumSpendWithinRange` 不做状态过滤——已核实安全；唯一残余不对称在**类型外脏数据**上 | **不改**，理由见 `03-delivery.md` §6.2（加兜底会掩盖一个本不该存在的状态）；登记备查 |
| `n4` | 全量门禁并非全绿：`tests/couponCheckoutChain.test.mjs:1109`（Windows CRLF） | 审查当时**确认与本轮无关**、按原计划不动；**验收前收尾中已由用户授权修掉**（见下节与 `03-delivery.md` §2.3） |

---

## 四、审查**未发现**问题的检查项（已查，无发现）

- **`R2` 口径唯一性**：全仓 `actualPaidAmount − refundedAmount` 形态的减法只出现在
  `lib/constants/levels.ts:74`；其余四处的减法算的是「本次可退 / 派发金额」，语义不同，不是漏改。
- **源码扫描门禁有效**：`refundedAmount` 扫描经 `tests/app-path.mjs` 的 `resolveSource`
  能正确解析到 `lib/...`，且 `stripComments` 后不残留（也不出现在字符串字面量里）。
- **鉴权与隐私**：`route.ts` 第一步 `requireUser()`，不接受任何查询参数，
  `userId` **只来自会话**；DTO 恰好 8 个键，不含 `companionRateBp`、不含订单明细。
- **分层**：`bossStatsHttp.ts` 只依赖 `@/lib/api/client`；`BossStatsCard` 纯展示、不遍历订单；
  `app/` 与 `components/` 无 `lib/data` / `lib/mocks` 直接引用或裸 `fetch`。
- **原子性**：`appendCompanionService` 位于无 `await` 区段内；replay 短路保证重放不重复写。
- **`D12`**：空列表给「暂无数据」、数值给 0、不隐藏整块、**不用 `—`**、金额复用 `formatYuan`。
- **`D9` / `D11`**：面板在 `/mine` 页内、无二级页、行不可点击、无「再来一单」入口。
- **`D5` / `D6`**：只对 `gameName` 做 `trim`、不与商品目录 join、不合并别名；
  纳入条件是 `completedAt != null`；三级排序与 Top3 截断都有断言。
- **`D3` / `D4`**：窗口只看 `completedAt`，金额只看当前净留存，没有第二套「按退款时刻」的模型。
- **既有链路回归**：夹具里不存在部分退款单，被钉死的 `24060` / `17460` 不会变；
  `lib/services/checkout.ts` 未被本轮触碰；重写的三条文案仍包含既有测试所断言的子串。

---

## 五、审查当时**刻意不修**的一条（**验收前收尾已修**）

审查当时：`tests/couponCheckoutChain.test.mjs:1109` 的失败
（`code.indexOf("\n}\n", start)` 在本机 `core.autocrlf=true` 下匹配不到 CRLF 的
`lib/services/checkout.ts`）**不属于本轮**，改它（即使用 `functionBody()` 这类正当改法）
是在无授权的情况下扩大本轮 diff，因此当时**只登记、不改**。

> **后续（验收前收尾）**：用户明确授权修掉这条假失败，并要求「不得删除断言、`skip`、
> `retry` 或放宽业务要求」。改法、红绿验证与它暴露出的**第二条**假失败
> （`bossStats.test.mjs` 的「最近 30 天」随日历漂移）见 `03-delivery.md` §2.3 / §2.4。
> 修完之后**全量门禁 1831 / 1831 pass / 0 fail / 0 skip**，本节所记的那条失败**已不存在**。

---

## 六、返工后的门禁终值

改动后**重跑了一轮**（生产构建 `next start -p 3105`）：

| 门禁 | 结果 |
|---|---|
| `tests/bossStats.test.mjs` | ✅ **36 / 36** |
| `tests/companionServing.test.mjs` | ✅ **20 / 20** |
| 口径回归（`levels` / `rankings` / `rankingPeriods` / `companionRankings`） | ✅ 121 / 121 |
| 退款 / 履约（`adminRefunds` / `refunds` / `directRefund` / `companionServing`） | ✅ 101 / 0 fail / 0 skip |
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm lint` | ✅ 0 error / 0 warning |
| `pnpm build` | ✅ exit 0，`/api/me/boss-stats` 在路由表 |
| **全量** `pnpm test`（带 `APP_BASE_URL`） | ✅ **1831 total / 1831 pass / 0 fail / 0 skip** |

> `P1-7` 自己的 **37 条**用例在生产构建下 **37/37 全绿**（0 skip）。
> 📌 上表的**全量**一行是**验收前收尾之后**重跑的生产构建终值；
> 审查当时它是「1830 pass + 1 条既有失败」，那条失败已按 §五 修掉
> （`fail=0` / `skipped=0`）。

---

## 七、结论

`BLOCKER` 0 条，`MAJOR` 2 条**已全部修复**并各自留下可红的回归用例（M2 另做了红绿验证），
`MINOR` 3 条已收，`NOTE` 4 条已逐条记录处置。
**`P1-7` 停在 `AWAITING_ACCEPTANCE`**——是否 `DONE` 由用户人工验收（`04-acceptance.md`）决定。
