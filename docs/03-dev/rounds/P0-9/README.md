# P0-9 — Earning.frozen + 可配置投诉窗口 + frozen → available

> 协议见 `docs/03-dev/development-workflow.md`。
> 本轮处于批次 `docs/03-dev/rounds/cmd_batch_p0-6.1_to_p0-9.md` 的**第四站（最后一站）**
> （P0-6.1 → P0-7 → P0-8 → **P0-9**）。

Round ID: P0-9
Title: `completed` → 生成实际打手 `Earning.frozen` → 可配置投诉窗口结束且无阻塞 → `Earning.available`
**Status: DONE**
Depends On: P0-8（`serving → completed` 的两条合法完成来源，`DONE`）· P0-1（平台参数真值源 `PlatformConfig`）· P0-5（投诉 / 售后模块）· P0-6 / P0-7（打手工作台与订单生命周期）
Goal: 把正常履约链闭合到 `completed → Earning.frozen →（投诉窗口结束且无阻塞）→ Earning.available`；把投诉窗口改为后台可配置并在订单进入 `completed` 时冻结本单 snapshot/deadline
Primary Domain: Earning（新领域，**不进 `OrderStatus`**）· 平台配置（`PlatformConfig`）· 伪事务原子性
Primary State Transition: **`Earning.frozen → Earning.available`**（`Earning` 是**独立领域**，不加入 `OrderStatus`）
Started At: 2026-09-24
Development Completed At: 2026-09-24（`Q1` 裁定后继续开发并交付）
Accepted At: 2026-09-24
Git Commit: eef4e62

> ⚠️ **本轮先停在 `CLARIFYING`，后经产品裁定继续开发并交付。**
> 第一次开工时「投诉窗口的 Mock 默认值」在**所有权威文档里都没有定义**，
> 按 `cmd_p0-9.md` §二 与批次 §五 / §十 的**真停止条件**停在 `CLARIFYING`
> 向产品提问（`Q1`），**当时一行业务代码都没写**。
> 产品负责人于 **2026-09-24** 裁定 `Q1`（`02-decisions.md` §八 D16~D18）后，
> 本轮继续开发、跑门禁、送 reviewer，现止于 `AWAITING_ACCEPTANCE`。
> **`CLARIFYING` 那一版记录的是中间状态，不是本轮结论**，其提问原文与证据链
> 按「追加历史、不覆盖历史」保留在 `02-decisions.md` §三 / §八。

---

## 本轮范围（以 `01-prompt.md` 原文为准）

1. **投诉窗口配置**（§二）：来自现有 `PlatformConfig` 真值源，后台可配置，
   不把「48h」写死为不可变业务规则；订单进入 `completed` 时冻结
   `complaintWindowMinutesSnapshot` 与 `complaintDeadlineAt`（`= completedAt + snapshot`）；
   后台之后改配置**不改变**历史 completed 订单，只影响未来进入 completed 的订单。
2. **`completed` 的统一完成事务**（§三）：把「投诉窗口快照 + Earning 创建」接入
   **staff approve** 与 **System auto approve** 这两个合法完成来源的**统一业务路径**，
   禁止复制成两套金额/收益逻辑。
3. **Earning**（§四 / §五）：独立领域；每个完成订单针对**实际履约打手**生成一条收益记录；
   金额**直接使用订单冻结的 `Order.companionBaseIncome`**；初始 `status = frozen`；
   同一 order 不得重复创建第二条有效 Earning；重复请求 / sweep 不得重复入账。
4. **投诉窗口的开放区间**（§六）：`complaintDeadlineAt` 前允许普通投诉，deadline 后关闭；
   **特殊人工申诉属后续 TBD，本轮不做**；不得把「过期后没有任何人工处理可能」写成永久规则。
5. **冻结收益释放**（§七）：`sweepMaturedEarnings(at)`（同步、幂等）；
   `frozen` + `complaintDeadlineAt <= at` + 无有效投诉/售后/其它冻结原因 → `available`；
   重复 sweep 幂等、`availableAt` 不重复刷新、有阻塞继续 `frozen`、阻塞解除后下次 sweep 可释放。
   真实 Scheduler 仍是 production blocker，本轮沿用 lazy sweep / 显式 sweep，不接后台任务基础设施。
6. **Companion 收益查看**（§九）：只在**技术设计已确认**时提供最小「我的收益」读取能力
   （复用打手工作台、只看自己的、不看平台净利润、不做提现）。
7. **Admin Platform Config**（§十）：在现有平台参数管理中加入投诉窗口配置，
   复用现有 service/repository/audit，**不新建第二套配置表**，明确单位，旧订单 snapshot 不变。
8. **原子性与一致性**（§十一）：`Order completed` + `complaint snapshot/deadline` + `Earning frozen`
   不得出现半写状态；Mock 伪事务区段**不得 `await`**；逻辑唯一性至少保证「一个 order → 一条有效 Earning」。

---

## 本轮明确不做（`01-prompt.md` §十三）

withdrawal · 钱包完整账本 · 人工余额调整 · 会费批扣 · 部分退款冲正 · 已提现退款追偿 ·
封禁回池 · 客服换人 · 特殊过期申诉 · 真 Scheduler · DB / ORM。

另按 §八：**不得**扩大为 `serving` / `completed` 部分退款、负余额追偿、会员费；
现有投诉/退款模块只做**必要最小联动**，不重构整个售后系统。

---

## 产品裁定（`02-decisions.md` §八，CURRENT）

| 项 | 裁定值 |
|---|---|
| 投诉窗口默认值 | **24 小时** |
| 存储 / 配置单位 | **分钟**（默认存为 **1440**） |
| 最小值 | **60** 分钟 |
| 最大值 | **10080** 分钟（7 天） |

规则：订单进入 `completed` 时冻结快照 → `complaintDeadlineAt = completedAt + snapshot`
→ **后续改配置不追溯历史订单** → 新完成订单用新值。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（**`docs/03-dev/rounds/cmd_p0-9.md` 的逐字副本**，`cmp` 校验一致） |
| `02-decisions.md` | Requirement Check 结论 + `Q1`（**已 `RESOLVED`**）+ **D16~D18（产品裁定）** + **D19~D24（开发期自查决策）** |
| `03-delivery.md` | **交付记录**：逐节对照、11 个新增文件（1950 行）、18 个共享文件的区段归属、门禁结果 |
| `04-acceptance.md` | 人工验收清单（含「60 分钟最小窗口下怎么验解冻」的说明） |

---

## 批次模式

- 本轮是批次 `cmd_batch_p0-6.1_to_p0-9.md` 的**最后一站**；
- 四轮（P0-6.1 / P0-7 / P0-8 / P0-9）全部止于 `AWAITING_ACCEPTANCE`，
  `User Result` / `Final Result` 一律保持 `PENDING`，等待用户的**统一人工验收**；
  📌 **该统一验收已于 2026-09-24 完成，四轮全部 `PASSED`**（见下方「人工验收」一节）；
- ✅ **该批次已于 2026-09-24 结束并统一验收通过**；四轮实现由**用户本人**提交于 **`eef4e62`**，
  本轮 Status 已随之收口为 `DONE`（「验收通过 + 用户本人提交」双门槛均已满足）。

---

## 人工验收（2026-09-24，批次统一验收 · 本轮为批次最后一站）

> 📌 **四轮验收已全部通过。** 用户本人于 **2026-09-24** 走完本文件 `04-acceptance.md` 的 A–G 各组验收，
> 覆盖投诉窗口后台配置与取值边界、不追溯、完成即冻结、窗口内投诉阻止释放、
> 收益接口权限边界（403 / 401 / 405）与回归组，并确认**全部通过**：
> `User Result = PASSED` / `Final Result = PASSED`，`Issues Found` 无。
> 至此 **P0-6.1 / P0-7 / P0-8 / P0-9 四轮的人工验收全部通过**。

| 项 | 值 |
|---|---|
| Accepted At | **2026-09-24** |
| User Result | **PASSED** |
| Final Result | **PASSED** |
| Git Commit | **`eef4e62`**（用户本人提交） |
| Status | **`DONE`** |

> ⚠️ **未验的一条（如实声明）**：「自然到期后由**真 Scheduler** 自动释放」没有被验、也无法被验——
> 仓库里没有调度器，所有「到点」都是读路径上的惰性物化。它是**上线前的 production blocker**
> （批次报告 §E.3），不是本轮遗漏。验收用「把未来的 `at` 注入同一个 `sweepMaturedEarnings`」代替。

> ✅ **收口（2026-09-24）**：按 `development-workflow.md` §十七 的「DONE 双门槛」，两个条件**均已满足** ——
> ① 用户本人说明验收通过（2026-09-24）；② 用户本人完成 Git 提交（**`eef4e62`**，四轮实现随该提交进入版本库）。
> 因此本轮 Status 已由 `AWAITING_ACCEPTANCE` 收口为 `DONE`。
> ⚠️ **这是纯文档收口**：`User Result` / `Final Result` / `Accepted At` 与验收结论**一律未改动**，业务代码与测试未被触碰。
> ⚠️ 上一条「真 Scheduler 未验」的声明**继续有效**，不因本轮 `DONE` 而消失。
