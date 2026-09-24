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
| [`P0-6`](./P0-6/README.md) | accepted 主动取消接单 + 重新进入公共池 | `AWAITING_ACCEPTANCE` | — |
| [`DEV-1`](./DEV-1/README.md) | Mock 身份切换验收工具（开发 / 测试基础设施） | `AWAITING_ACCEPTANCE` | — |

> **当前等待人工验收的 Round：P0-6 与 DEV-1**（两个独立 Round，互不阻塞）。
>
> `DEV-1` 是 2026-09-24 用户分配编号的开发 / 测试基础设施轮次，**不是产品功能**：
> 它只提供用户端的 Mock 身份切换面板，让 P0-6 的多角色人工验收在同一个窗口里完成。
> 验收清单见 [`DEV-1/04-acceptance.md`](./DEV-1/04-acceptance.md)。
> ⚠️ **DEV-1 曾被打回一次**（2026-09-24）：首轮把「至少两个具备有效 Companion 资格的 User」
> 读成了「名单里要有候选身份」，工具能切 User 却跑不完 P0-6 的 User → Companion A →
> Companion B 链路。重做批在既有 fixture 体系里**真的预置了两位有效打手**
> （`cp-10`/`u-1022`、`cp-11`/`u-1023`），验收链路从此不需要任何后台审核动作；
> 决策反转为 D6 **V2**，见 [`DEV-1/02-decisions.md`](./DEV-1/02-decisions.md)。
> ⚠️ **DEV-1 不修改 P0-6 的任何行为，也不修改 P0-6 的验收结果**，P0-6 保持
> `AWAITING_ACCEPTANCE`。
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
