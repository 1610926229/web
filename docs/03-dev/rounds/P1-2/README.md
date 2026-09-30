# P1-2 · 管理员生命周期参数配置中心

Round ID: P1-2
Title: 把「专属池超时」从源码常量改成**可配置的平台参数**，并让它与另外三项走**同一套快照语义** —— 只影响此后进入专属池的订单，绝不追溯
**Status: `AWAITING_ACCEPTANCE`**
Depends On: P0-1（平台参数与写入伪事务）· P0-8 / P0-9（另两项的既有快照语义）· P0-5（派单专属池）—— 均为 `DONE`
Goal: 落实产品裁定「专属池超时**必须可配置**」，并把这件改动做成**不会事后改掉已承诺规则**的形态：进入专属池那一刻冻结取值，之后改配置只影响新进入的订单。**不新建第二套配置实体，不新建第二个配置页，不改任何状态机。**
Primary Domain: PlatformConfig（本轮**唯一**被扩展的领域）· Dispatch（新增一个快照字段）· Admin（配置页与审计）
Primary State Transition: **无**。本轮不新增任何状态、不迁移任何订单状态；`Dispatch.state` 的四个取值一个没多、一个没少
Started At: 2026-09-27
Development Completed At: 2026-09-27
Review: **两轮** `reviewer-agent` 只读审查（第一轮 0 BLOCKER / 0 MAJOR / 4 MINOR / 4 NOTE；修复后第二轮复核 0 BLOCKER / 0 MAJOR / 1 MINOR（测试可靠性）/ 3 NOTE，均已处置。结论见 `03-delivery.md` §4）
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**，等待产品负责人人工验收）
Git Commit: —（⚠️ 本批次**禁止任何 Git 写操作**，交付时点 `Git Commit` 留空是该时点的正确状态）

> ⚠️ **Claude 不得自行 `DONE`。** 本轮交付后停在 `AWAITING_ACCEPTANCE`，等待产品负责人人工验收。
> **不得开始 `P1-3`。**

---

## 状态沿革

| 时点 | 状态 | 依据 |
|---|---|---|
| 2026-09-27 | `PLANNED` | 档案建立（`01-prompt.md` 逐字保存，630 行） |
| 2026-09-27 | `READY` | Requirement Check 完成，**无 `OPEN` 决策**（见 `02-decisions.md` §一 / §1.3） |
| 2026-09-27 | `IN_PROGRESS` | 开始按 `01-prompt.md` + `02-decisions.md` 开发 |
| 2026-09-27 | `AWAITING_ACCEPTANCE` | 门禁全绿 + `reviewer-agent` 第一轮回报 → 4 条 MINOR 全部修完 → **整套复跑**（读数见 `03-delivery.md` §3） |
| 2026-09-27 | `AWAITING_ACCEPTANCE`（不变） | **第二轮只读复核**（0 BLOCKER / 0 MAJOR / 1 MINOR / 3 NOTE）→ 该 MINOR 修完并做**红绿实测** → 再次完整复跑，读数不变（见 `03-delivery.md` §4.4） |

> `AWAITING_ACCEPTANCE` 一行在门禁与 reviewer **真的跑完之后**才追加（`03-delivery.md`）——
> **没有跑过的门禁不写进档案**。

---

## 这一轮到底在改什么（一句话）

改之前，「指定打手独占接单权持续多久」是**源码里的一个 10**：

```ts
// lib/constants/dispatch.ts（P1-2 之前）
export const EXCLUSIVE_WAIT_MINUTES = 10;  // 固定 10 分钟，不可配置
```

改之后，它是**平台参数里的一个字段**，而且**进入专属池那一刻会把当时的取值冻在派单记录上**：

```ts
// lib/data/companionDispatchTransaction.ts（P1-2 之后）
const config = readPlatformConfig();
exclusiveDeadlineAt: exclusive ? plusMinutes(input.at, config.exclusivePoolTimeoutMinutes) : null,
exclusiveTimeoutMinutesSnapshot: exclusive ? config.exclusivePoolTimeoutMinutes : null,
```

**核心不变量（本轮存在的理由）**：

> **`PlatformConfig` 是未来生命周期事件的模板；对象上已经生成的 snapshot / deadline 才是历史事实。**

因此「管理员改了配置，为什么这张单的截止时间没变」有且只有一个正确答案：
**因为那张单在进入专属池时已经冻结了当时的时长**。禁止按当前配置重算旧 deadline、
禁止批量改写旧快照、禁止用配置覆盖历史生命周期事实。

### 工作示例（`01-prompt.md` §五 原文）

| 时刻 | 事件 | 结果 |
|---|---|---|
| 12:00 | 配置 = 10 | — |
| 12:01 | 订单 A 进入专属池 | 冻结 10 → 截止 **12:11** |
| 12:05 | 管理员把配置改成 20 | **A 不受影响**（仍是 12:11） |
| 12:06 | 订单 B 进入专属池 | 冻结 20 → 截止 **12:26** |

`tests/dispatch.test.mjs` 的「专属池 1b」就是这个例子的自动化版本，并且**刻意**加了一条
`assert.notEqual(afterA.exclusiveDeadlineAt, plusMinutes(orderA.paidAt, 20))`——
只断言「A 的截止时间没变」是不够的：把实现改成「每次读最新配置重算」时，
只要没人改过配置，那些断言**照样全绿**。必须有「A ≠ 按 20 分钟算出来的那个时刻」才咬得住。

---

## 本轮改了什么（文件清单）

| 层 | 文件 | 改动 |
|---|---|---|
| 常量 | `lib/constants/platformConfig.ts` | **新增** `EXCLUSIVE_POOL_TIMEOUT_DEFAULT/MIN/MAX_MINUTES`、`isValidExclusivePoolTimeoutMinutes()`、`PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT`、`PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE`；`PLATFORM_CONFIG_NOTICE` 补上这一项 |
| 常量 | `lib/constants/dispatch.ts` | **删除** `EXCLUSIVE_WAIT_MINUTES`，留一段 `superseded by P1-2` 说明；`COMPANION_POOL_NOTICE` 不再承诺一个具体分钟数 |
| 常量 | `lib/constants/adminAudit.ts` | 审计快照带上新字段 |
| 类型 | `lib/types/platformConfig.ts` | `PlatformConfig` / `AdminPlatformConfigPatch` 各加一个字段 |
| 类型 | `lib/types/dispatch.ts` | `DispatchRecord` 加 `exclusiveTimeoutMinutesSnapshot` |
| 数据 | `lib/data/mockPlatformConfigRepository.ts` | **读边界兜底** `normalizePlatformConfig()`：旧 store 缺字段 / 字段是脏值时补默认 10 |
| 数据 | `lib/data/adminPlatformConfigTransaction.ts` | 白名单 `PATCHABLE_FIELDS` 与 PATCH 合并各加一行 |
| 数据 | `lib/data/companionDispatchTransaction.ts` | 进入专属池时读**当下**配置并**同时**冻结快照 |
| 种子 | `lib/mocks/fixtures/platformConfigSeed.ts` | 预置值取常量，不写字面量 |
| 种子 | `lib/mocks/fixtures/dispatchSeed.ts` | 三条构造路径都填快照（用**默认值常量**，不读当下配置） |
| 服务 | `lib/services/adminPlatformConfig.ts` | 第四个字段的读取与校验；空 PATCH 判据扩展 |
| 接口 | `app/api/admin/platform-config/route.ts` | 仅文档更正（**未新增地址**） |
| 界面 | `components/admin/AdminPlatformConfigConsole.tsx` | 第四个输入框 + 当前值行 + 提示语 + 保存反馈 + 放弃修改 |
| 测试 | `tests/platformConfig.test.mjs` 等 5 份 | 见 `03-delivery.md` §3 |

**零改动**：四个端口的 `page.tsx`、`app/api/(mobile)` 全部路由、`lib/data/orderRepository.ts`、
任何状态机、任何金额口径。

---

## ⚠️ 开工前的工作区检查（协议 §二十）

本批次开工时，工作区**已有前两批未提交内容**：`P0-14` 与 `P1-1` 的完整交付，且两者都停在
`AWAITING_ACCEPTANCE`、**用户尚未提交**。

按协议「发现仍有上一批未提交内容，**先报告**，不要偷偷吸收到下一批」——这里如实报告：

- P1-2 的落点**绝大多数可分辨**（上表列出的 13 个文件里，`lib/constants/dispatch.ts`、
  `lib/types/dispatch.ts`、`lib/data/companionDispatchTransaction.ts`、`lib/mocks/fixtures/dispatchSeed.ts`
  与四项配置页/服务/事务文件属于本轮新增改动；`docs/02-tech-design/*` 三份文档多批次共用）；
- ⚠️ **`docs/02-tech-design/api-contract.md` 与 `database-schema.md` 三批共用**，
  `git diff` 里分不开——这与 P1-1 报告里点名的情形同类；
- P1-2 **不在 `P0-14` / `P1-1` 的业务实现里加任何逻辑、不改它们的状态**；
- 提交由用户自行完成，**本轮禁止一切 Git 写操作**。

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（用户提示词原样保存） |
| `02-decisions.md` | Requirement Check 结论、四个字段的全表、口径裁决 D1–D7 |
| `03-delivery.md` | 实现结果、文件清单、门禁读数、reviewer 结论、Git 状态 |
| `04-acceptance.md` | 人工验收清单（编号步骤 + 预期结果） |
| `README.md` | 本文件 |
