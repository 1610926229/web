Round ID: P1-7
Title: 老板数据面板 + 消费累计口径统一（累计订单数 / 累计消费 / 最近 30 天消费 / 常玩游戏 / 常用打手）
Status: AWAITING_ACCEPTANCE   # 2026-10-01 —— 已交付，门禁走完，**等人工验收**。⚠️ 未 `DONE`，不得由 Claude 自行 `DONE`
Blocked On:（无）
- ✅ `D1`–`D12` 已由产品负责人一次性裁定（`02-decisions.md` §五 / §六 `R1` `R2`）
- ✅ F1–F5 五条冻结规则已在 `02-decisions.md`（**第二次 Requirement Check** 的 §一「产品已冻结、本轮不再提问的规则」）登记；其中 F1 / F3 本轮落地，F4 / F5 只登记不实现；§19 消费累计那条 `⏳ 真实金额回滚` 由 F1 兑现
- ✅ **验收前裁定（2026-10-02，`02-decisions.md` §八）**：`D10` 附加要求第 3 条**正式收窄**（服务事件不承担跨域 Assignment identity，三元组只是本轮去重语义）；`setMockSeedNow()` 作为 Mock / test 时钟稳定化**接受**（仅限 Mock / test，生产业务代码不得依赖）。**未再修改业务代码**
Depends On:
- `AUDIT-122`（前置，已完成 2026-09-30）
- P1-4（优惠券交易链路与结算口径校准）
- P0-15（退款与收益归零） / P0-13（管理员退款裁定）
- P1-5（排行榜口径 —— 复用其 UTC+8 周期原语与稳定排序惯例）
Goal: 让老板（下单用户）在自己的页面看到五项本人统计数据（累计订单数 / 累计消费 / 最近 30 天消费 / 常玩游戏 / 常用打手），并把**累计消费 / 消费等级 / 用户消费排行榜**三处收敛到**唯一**口径 `effectiveSpend = max(0, actualPaidAmount − refundedAmount)`
Primary Domain: 用户端「我的」页 + 消费金额统计口径（`lib/constants/levels.ts`）
Primary State Transition: 无（只读聚合，不新增状态机）
Started At: 2026-10-01
Development Completed At: 2026-10-01
Accepted At: ——（等用户人工验收）
Git Commit: ——（本轮**零 Git 写操作**，改动保留在工作区）

---

## 交付摘要（2026-10-01）

> ⚠️ **下面 `## 一句话` 及之后的「本轮不做什么」是 `2026-10-01` 之前的旧结论
> （`P1-7 BLOCKED`）。它已被产品裁定推翻，但按本轮纪律**逐字保留**，
> 作为「为什么当时停下来了」的取证记录。当前状态以上面的 header 为准。**

**已交付**：`D1`–`D12` 全部 `RESOLVED`（`02-decisions.md` §五）+ 总规则 `R1` / `R2`（§六），
第二次 Requirement Check 未发现新的产品级 BLOCKING，据此完成开发。

| 项 | 结果 |
|---|---|
| 交付内容 | 消费累计口径统一（净额，`R2` 单点）+ 总规则 `R1` + `/mine` 页内老板数据面板五项 |
| 新增基础设施 | `CompanionServiceEvent`（只增不改的服务历史，`D7` 的前置），见 `database-schema.md` §T4c |
| 测试 | `tests/bossStats.test.mjs` **36 条** + `tests/companionServing.test.mjs` 新增 `开始 3c` **1 条**；生产构建下 **37/37 全绿** |
| 全量门禁 | `pnpm test`（生产构建 `APP_BASE_URL`）**1831 total / 1831 pass / 0 fail / 0 skip** |
| typecheck / lint / build | 全部通过 |
| reviewer | **0 BLOCKER / 2 MAJOR / 3 MINOR / 4 NOTE**；BLOCKER 与 MAJOR **已全部修复**（M2 含红绿验证），MINOR 已收，NOTE 已逐条记录处置 —— 见 `05-review.md` |
| 人工验收 | **待办** —— 见 `04-acceptance.md` |
| 验收前裁定（2026-10-02） | ① `setMockSeedNow()` **接受**（Mock / test 时钟稳定化，生产业务代码不得依赖）② `D10` 附加要求第 3 条**正式收窄**（`CompanionServiceEvent` 不承担跨域 Assignment identity）—— 逐字见 `02-decisions.md` §八。**两项均未改业务代码** |

**档案**：`01-prompt.md`（本轮指令）· `02-decisions.md`（裁定）· `03-delivery.md`（交付）·
`04-acceptance.md`（验收清单）· `05-review.md`（审查）。
⚠️ 旧 README 的「不建 `P1-7` 的 5 件档案」那句话**随之作废**——那是 `BLOCKED` 状态下的结论，
本轮既已开发，5 件档案即按 Protocol 建立。

---

## 一句话

**P1 backlog 的每一族都卡在同一个地方：需求文档从未给它们定义过口径。**
`cmd_p1-next.md` 要求的第一个条件是「产品规则已经冻结」，而逐条核查下来，
**没有任何一项满足**——因此本轮**不选候选、不开发、不建 5 件档案**，
按规格给 `P1-7 BLOCKED` 与 `P1-8 NOT STARTED — no safe frozen candidate`。

## 这不是「没找到」，是「找到了不做的理由」

`cmd_p1-next.md` 写得很清楚：

> 遇到未冻结产品规则：**不猜，标 BLOCKED，继续下一项。**
> 如果没有第二个安全候选：`P1-8 NOT STARTED — no safe frozen candidate`
> **不得为了凑数量开发 P2 或生产功能。**

本轮据此执行。逐族证据见 `02-decisions.md`（每条都带 `文件:行` 引文）。

## 关键事实（三条，足以定案）

1. **权威需求里没有这些功能。** `docs/01-requirements/` 三个文件（业务流程表 / 用户权限表 /
   特殊情况与异常处理表）是围绕 **P0 主线业务流 `BF-01 … BF-25`** 写的；
   `再来一单` / `常玩游戏` / `接单数` / `完成率` / `帮助中心` / `高级订单筛选` / `按时间` / `按金额`
   **在这些文件里命中数全部为 0**。`api-contract.md` 对它们同样是 **0 命中**。
   ⇒ 「产品规则已冻结」**没有载体**。

2. **代码与历史 Round 里留着历次 Requirement Check 的结论——四次「拒绝发明」。**
   这不是我这一轮的判断，是**项目自己反复做出的判断**：
   - `components/orders/OrderList.tsx:38-39` —「原型里的筛选图标当前**没有业务定义**……**不自行发明日期 / 金额 / 商品等筛选规则**」（订单筛选族 ×5 卡住）；
   - `docs/03-dev/rounds/P1-3/02-decisions.md:115-124`（`D-P1-3-5`）—「**不造**「按打手 id 筛选」的参数（**那是替产品决定一个新的查询维度**）」（高级订单筛选卡住）；
   - `app/(mobile)/help/page.tsx` —「**不自行编造帮助文档内容**」（帮助中心卡住）；
   - `app/(mobile)/activities/page.tsx` —「**不自行编造活动规则** / **不自行设计活动规则**」（活动管理卡住）。

3. **最新一轮产品裁定刚刚说过口径不存在。** `docs/03-dev/rounds/P1-5/02-decisions.md:129`
   （2026-09-29，`P1-5` 的 BLOCKED 段，逐字保留）写明：综合榜所需的
   「完成率 / 评价 / 投诉率 三维度的**权重与各自的分子分母口径**——目前这三项数据**一个都不存在**」。
   ⇒ 打手数据的「完成率 / 取消率」**不但没冻结，还有一份一天前的书面裁定说它没冻结**。

4. **唯一被技设层「点名冻结为 TBD」的功能，恰好就是提现。** `api-contract.md:1013` 与
   `database-schema.md:1113` 各有一行逐字写着「**提现 API ｜ TBD — DO NOT INVENT**」/
   「**Withdrawal（提现）｜ TBD — DO NOT INVENT**。……全部未定」；
   需求侧 `EX-WITHDRAW-01` 标「完整流程 ❓ 尚未正式设计」。⇒ 判据 ⑤ 直接出局。

## 本轮不做什么

- **不改 Roadmap**：不新建 P1 功能点、不重排优先级、不为缺口补行。
- **不开发任何代码**（`cmd_p1-next.md`：「不得为了凑数量开发 P2 或生产功能」）。
- **不建 `P1-7` 的 5 件档案**：`01-prompt.md` / `03-delivery.md` / `04-acceptance.md`
  **不适用**（没有 prompt、没有交付、没有可验收物）。只留 `README.md` + `02-decisions.md`
  作为**本轮 Requirement Check 的取证记录**。
- **零 Git 写操作**。

## P1-8

```
P1-8 NOT STARTED — no safe frozen candidate
```

P1-7 的候选筛选已经穷举了 P1 backlog 的**全部 25 个未交付项**（见 `02-decisions.md` §二），
没有一项通过判据。因此**不存在**可供 P1-8 使用的第二个安全候选。
