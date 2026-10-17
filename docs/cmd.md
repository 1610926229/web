# OBSOLETE — DO NOT EXECUTE

> **本文件当前不含任何待执行的开发指令。**
>
> 若你是 Claude / Agent：**不要**把本文件当作 Prompt，**不要**依据它开始任何开发。
> 请先读 `docs/03-dev/development-workflow.md`、`docs/03-dev/总需求进度表.md`
> 与最新 Round 档案，并等待用户明确给出新一轮 Prompt。

---

## 为什么废弃

本文件此前保存的是 **P0-6「开始服务」（`accepted → serving`）** 的开发指令。

该指令**已被 2026-09-23 的需求重校准取代**。重校准涉及：

- `ORDER_TRANSITIONS` 目标变化（新增 `accepted → paid`、`serving → paid` 回池迁移）；
- 打手主动取消接单（`accepted → paid → public`）；
- 封禁回池、客服直接换人；
- 生命周期配置化（专属池 timeout / 完成材料自动审核 / 投诉期后台可配置）；
- 完成材料 10 分钟默认自动审核（可配置 + 提交时冻结 snapshot）；
- 未开始服务直接退款（`paid` / `accepted` 用户直接全额退款，不走人工审批）。

旧 P0-6 指令是在**旧需求基线**上写的，直接执行会与已确认的新规则冲突。

原文全文仍保留在 Git 历史中：提交 `6bd10fc` 的 `docs/cmd.md`。
**无需**、也**不得**为取回它而修改 Git 历史。

---

## 当前状态

- **当前开发 Round 尚未重新编号。** 编号由用户分配，Claude 不得自行创造。
- 下一 Round 必须以**最新**的下列文件为准：

```text
docs/01-requirements/超哥电竞_业务流程表.md
docs/01-requirements/超哥电竞_用户权限表.md
docs/01-requirements/超哥电竞_特殊情况与异常处理表.md

docs/02-tech-design/architecture-rules.md
docs/02-tech-design/api-contract.md
docs/02-tech-design/database-schema.md
docs/02-tech-design/directory-structure.md

docs/03-dev/总需求进度表.md
docs/03-dev/development-workflow.md
```

- **在用户明确给出新一轮 Round Prompt 之前，不得执行本文件的历史内容，也不得开始任何业务编码。**

---

## 本文件的用途

保留 `docs/cmd.md` 作为**长 Prompt 的临时传输入口**：
用户可以把下一轮的完整开发指令写入本文件，再由 Claude 读取执行。

⚠️ 新一轮指令写入本文件后，其原文必须**原样**另存为
`docs/03-dev/rounds/<ROUND_ID>/01-prompt.md`（不得摘要、改写或重新生成）。
