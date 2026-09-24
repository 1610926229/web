# Round 目录说明

本目录保存**每一个开发批次的完整决策档案**。

**协议正文见 [`../development-workflow.md`](../development-workflow.md)。**

---

## 目录命名

```
docs/03-dev/rounds/<ROUND_ID>/
```

`<ROUND_ID>` = 批次编号，与全局进度表一致：`P0-5.5` / `P0-6` / `P1-1` …

## 每个 Round 固定五个文件

| 文件 | 职责 |
|---|---|
| `README.md` | 快速索引：Round ID、状态、依赖、时间、commit |
| `01-prompt.md` | **原始开发指令档案**——原样保存，不总结不改写 |
| `02-decisions.md` | 问题、用户回答、最终执行口径 |
| `03-delivery.md` | 实现结果、文件变更、测试、验证记录 |
| `04-acceptance.md` | 人工验收结果 |

**不要额外创建没有明确职责的文档。**

---

## 状态

```
PLANNED → CLARIFYING → READY → IN_PROGRESS → AWAITING_ACCEPTANCE → DONE
                                                                    ↑
                                            （另：BLOCKED）
```

**⚠️ Claude 完成编码后只能标 `AWAITING_ACCEPTANCE`。**
**`DONE` 需要两个条件同时满足：用户明确说验收通过 + 用户已自行 Git commit。**

---

## 两条不可协商的规则

1. **`02-decisions.md` 是追加历史，不覆盖历史。**
   决定改变时保留 `Decision V1 (SUPERSEDED)` 与 `Decision V2 (CURRENT)`。

2. **存在 `Status: OPEN` 的决策时，禁止开始业务编码。**
   停在 `CLARIFYING`，向用户提问，等待回答。

---

## Round 索引

| Round | Title | Status | Git Commit |
|---|---|---|---|
| [`P0-5.5`](./P0-5.5/README.md) | 小型架构稳定化 | `DONE` | `6bd10fc` |
| [`P0-6`](./P0-6/README.md) | accepted 主动取消接单 + 重新进入公共池 | `DONE` | `53481ea` |
| [`DEV-1`](./DEV-1/README.md) | Mock 身份切换验收工具（开发 / 测试基础设施） | `DONE` | `53481ea` |
| [`P0-6.1`](./P0-6.1/README.md) | 验收后整改：FIX-1 工作台返回用户端 + FIX-2 订单池「等待最久优先」 | `AWAITING_ACCEPTANCE` | — |
| [`P0-7`](./P0-7/README.md) | `accepted → serving` —— 由当前实际打手点击「开始服务」 | `AWAITING_ACCEPTANCE` | — |
| [`P0-8`](./P0-8/README.md) | CompletionSubmission + 客服审核 + 10 分钟自动审核 | `AWAITING_ACCEPTANCE` | — |
| [`P0-9`](./P0-9/README.md) | Earning.frozen + 可配置投诉窗口 + `frozen → available` | `AWAITING_ACCEPTANCE` | — |

> 🟡 **`P0-6.1` / `P0-7` / `P0-8` / `P0-9` 四轮全部止于 `AWAITING_ACCEPTANCE`**：它们都在批次
> [`cmd_batch_p0-6.1_to_p0-9.md`](./cmd_batch_p0-6.1_to_p0-9.md) 之内（P0-6.1 → P0-7 → P0-8 → P0-9）。
> 批次模式要求**每轮自动门禁全绿 + reviewer 无 BLOCKER/MAJOR 后不等待逐轮确认、自动进入下一轮**。
>
> ✅ **2026-09-24：四轮的统一人工验收已全部通过**——用户本人走完批次报告 §D 的完整清单，
> 确认 P0-6.1 / P0-7 / P0-8 / P0-9 **四轮全部 `User Result = PASSED` / `Final Result = PASSED`**，
> `Issues Found` 无。四轮的 `Accepted At` 均为 **2026-09-24**。
> ⚠️ **状态仍为 `AWAITING_ACCEPTANCE`，这不矛盾**：按 `development-workflow.md` §十七 的
> 「DONE 双门槛」，还需要**用户本人完成 Git 提交**——而四轮的改动至今全部躺在工作区，
> 本批次**零 Git 写操作**。因此 `Git Commit` 一列留空是**正确状态**，
> 用户本人提交之后才改为 `DONE`。Claude 不得自行标 `DONE`。

> 🔵 **`P0-9` 曾经停在 `CLARIFYING`（已解除）。** 本轮第一次开工时，「投诉窗口的 Mock 默认值」
> 在**所有权威文档里都没有定义**，因此按 `cmd_p0-9.md` §二 / 批次 §五 / §十 的**真停止条件**
> 停在 `CLARIFYING` 向产品提问（`Q1`），**当时没有交付任何代码**。
> 产品负责人于 **2026-09-24** 裁定 `Q1`（默认 24 小时 / 单位分钟 / 取值 60~10080 分钟，
> 见 [`P0-9/02-decisions.md`](./P0-9/02-decisions.md) §八 D16~D18）后，本轮继续开发并**已交付**，
> 现止于 `AWAITING_ACCEPTANCE`。⚠️ **`CLARIFYING` 那一版记录的是中间状态，不是本轮结论**；
> 提问原文与证据链按「追加历史、不覆盖历史」保留在该文件 §三 / §八。
>
> 📋 **批次最终报告见 [`BATCH_p0-6.1_to_p0-9_最终报告.md`](./BATCH_p0-6.1_to_p0-9_最终报告.md)**
> （A 四轮状态表 · B 每轮交付 · C 最终领域链 · **D 统一人工验收清单** · E 遗留 · F Git）。
> ✅ 该报告 §D 的清单已于 **2026-09-24** 由用户本人走完，四轮**全部通过**；
> 报告 §A.1 / §A.2 与摘要已同步记录最终验收结果（见该文件 §G）。

> 🟡 **`P0-6.1` 止于 `AWAITING_ACCEPTANCE`**：它是 P0-6 / DEV-1 人工验收通过后登记的
> **两个整改项**（FIX-1 / FIX-2）的落地轮，**不是新功能**，也**不推翻** P0-6 / DEV-1 的 `DONE`。
> `Git Commit` 一列为空是**正确状态**——「DONE 的双重门槛」要求用户本人完成提交，
> 在提交之前该列必须留空、状态必须停在 `AWAITING_ACCEPTANCE`（Claude 不得自行标 `DONE`）。

> ✅ **P0-6 与 DEV-1 均已 `DONE` 收口**（两个独立 Round，互不阻塞）。
> 两者的 `User Result` / `Final Result` 均为 `PASSED`（2026-09-24 人工验收通过），
> 且由**用户本人**在同一个提交 **`53481ea`** 中完成提交——「DONE 的双重门槛」
> （`development-workflow.md` §十七）两个条件均已满足。
>
> ⚠️ **验收期间另发现两个独立整改项**（**均属 P0-6 域**，**不推翻 P0-6 的 `DONE` 结论**）：
> **FIX-1** 打手工作台缺少返回普通用户主界面的入口；**FIX-2** 订单池排序应改为
> 「等待最久优先」（公共池 `publicPoolEnteredAt` ASC / 专属池 `exclusiveEnteredAt` ASC）。
> 二者已登记为 `../总需求进度表.md` 中的独立 `NEEDS_FIX` 待办（**Round 编号仍为 `UNASSIGNED`**，
> 由用户 / ChatGPT 在正式启动时分配），明细见 [`P0-6/04-acceptance.md`](./P0-6/04-acceptance.md)
> 的 `Issues Found`。**它们不回写 P0-6 的历史实现描述。**
>
> `DEV-1` 是 2026-09-24 用户分配编号的开发 / 测试基础设施轮次，**不是产品功能**：
> 它只提供用户端的 Mock 身份切换面板，让 P0-6 的多角色人工验收在同一个窗口里完成。
> 验收清单见 [`DEV-1/04-acceptance.md`](./DEV-1/04-acceptance.md)。
> ⚠️ **DEV-1 曾被打回一次**（2026-09-24）：首轮把「至少两个具备有效 Companion 资格的 User」
> 读成了「名单里要有候选身份」，工具能切 User 却跑不完 P0-6 的 User → Companion A →
> Companion B 链路。重做批在既有 fixture 体系里**真的预置了两位有效打手**
> （`cp-10`/`u-1022`、`cp-11`/`u-1023`），验收链路从此不需要任何后台审核动作；
> 决策反转为 D6 **V2**，见 [`DEV-1/02-decisions.md`](./DEV-1/02-decisions.md)。
> ⚠️ **DEV-1 不修改 P0-6 的任何行为，也不修改 P0-6 的验收结果**；两者的验收各自独立记录，
> 只是按用户指令在同一个提交（`53481ea`）中一起收口。
>
> **P0-6**（2026-09-23 需求重校准后的第一轮，
> 编号由用户分配）。Requirement Check 已完成，无 `OPEN` 决策，见
> [`P0-6/02-decisions.md`](./P0-6/02-decisions.md)；实现与门禁结果见
> [`P0-6/03-delivery.md`](./P0-6/03-delivery.md)；验收清单见
> [`P0-6/04-acceptance.md`](./P0-6/04-acceptance.md)。
>
> ⚠️ 本轮**曾被用户打回一次**：首次交付把「客服查看取消历史」记成了待产品裁定的缺口，
> 用户裁定该需求**已冻结、必须补齐**。已按最小实现补齐（不新增任何 Staff 接口），
> 决策反转为 `02-decisions.md` D6 **V3 (CURRENT)**。E 组验收项已改写为可执行步骤。
>
> ⚠️ **`AWAITING_ACCEPTANCE` 不是完成**，`DONE` 需用户人工验收通过 + 用户自行提交。
>
> **不要提前创建空目录**——某轮真正准备开始时才创建。
> 上一轮 P0-5 建于本协议之前（`PRE-PROTOCOL`），不倒填历史档案。

全局进度真值源：[`../总需求进度表.md`](../总需求进度表.md)
