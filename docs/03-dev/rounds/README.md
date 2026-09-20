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

## 当前 Round

> 尚无。**不要提前创建空目录**——某轮真正准备开始时才创建。

全局进度真值源：[`../总需求进度表.md`](../总需求进度表.md)
