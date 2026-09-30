Round ID: P1-7
Title: （未选中）—— 安全 P1 候选筛选（Requirement Check 结论：BLOCKED）
Status: BLOCKED   # 不是「开发未完成」，是「没有任何候选能通过 `cmd_p1-next.md` 的 8 条判据」
Blocked On:
- 判据 ③「产品规则已经冻结」与判据 ④「没有 `TBD — DO NOT INVENT`」**对 P1 backlog 的每一族都不成立**
- 权威需求 `docs/01-requirements/**` 与接口契约 `docs/02-tech-design/api-contract.md` 对 P1 功能**零覆盖**（逐条 grep 命中数为 0）
- 项目自己的进度表把「消费累计」口径标为 🟠 `NEEDS_FIX`「需产品裁定后才可开工」
Depends On:
- `AUDIT-122`（前置，已完成 2026-09-30）
Goal: 从 P1 backlog 里选**至多两个**「规则已冻结、无 TBD、不依赖外部凭据 / 钱包 / 调度器」的功能，编号 P1-7 / P1-8
Primary Domain: 无（本轮**未进入开发**）
Primary State Transition: 无
Started At: 2026-09-30
Development Completed At: ——（未开始）
Accepted At: ——
Git Commit: ——（本轮**零 Git 写操作**）

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
