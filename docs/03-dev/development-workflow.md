# 开发轮次记录协议（Development Round Protocol）

> **状态：CURRENT** —— 本文件是**强制协议**，不是建议。
> 自 2026-09-20 起，**所有 P0-x / P1-x / P2-x 业务开发批次**都必须按本协议执行。
>
> **本文件不定义业务规则。** 业务规则的唯一真值源是 `docs/01-requirements/`；
> 架构规则的唯一真值源是 `docs/02-tech-design/architecture-rules.md`。
> 本文件只定义**开发过程本身如何被记录**。

---

# 一、这套机制要解决什么

一个 Claude 会话是有寿命的。三个月后回来的新会话，只能看到代码和最后的文档，
**看不到「当时为什么这么决定」**。

本协议用**追加式**的 Round 档案把决策历史固化下来，使未来任何新会话都能恢复
某一轮开发的完整上下文：

- 当时的原始指令是什么；
- Claude 提出了哪些问题；
- 用户是怎么回答的；
- 最终执行口径是什么；
- 实际做了什么、测了什么、人工验收结果如何、最终 commit 是哪个。

---

# 二、唯一真值源

| 事项 | 唯一真值源 |
|---|---|
| **全局项目进度** | **`docs/03-dev/总需求进度表.md`** |
| 业务规则 | `docs/01-requirements/` |
| 架构与技术设计 | `docs/02-tech-design/` |
| 单轮开发的完整决策历史 | `docs/03-dev/rounds/<ROUND_ID>/` |

> **⚠️ 禁止创建第二份 `PROJECT_PROGRESS.md` 或任何竞争性的进度文件。**
> 全局进度真值源的**真实文件名是 `总需求进度表.md`**，保持这个文件名。
> **所有 Round 都链接到这一个文件**，不各自维护进度副本。

---

# 三、目录结构

```
docs/03-dev/
├── development-workflow.md      ← 本文件
├── 总需求进度表.md               ← 全局进度唯一真值源
└── rounds/
    ├── README.md                ← Round 目录说明
    └── <ROUND_ID>/              ← 每轮真正开始时才创建
        ├── README.md            ← 快速索引
        ├── 01-prompt.md         ← 原始开发指令档案
        ├── 02-decisions.md      ← 问题、回答与最终执行口径
        ├── 03-delivery.md       ← 实现结果与验证
        └── 04-acceptance.md     ← 人工验收记录
```

`<ROUND_ID>` 用批次编号：`P0-5.5` / `P0-6` / `P1-1` …

> **⚠️ 不要提前为未来的 Round 创建空目录。** 只有某轮**真正准备开始**时才创建。
> **不要额外创建一堆没有明确职责的文档**——每个 Round 就这五个文件。

---

# 四、Round 状态机

```
PLANNED
   ↓
CLARIFYING（如果存在问题）   ← 有 OPEN 决策时停在这里
   ↓
READY
   ↓
IN_PROGRESS
   ↓
AWAITING_ACCEPTANCE
   ↓
DONE
```

另有独立状态 **`BLOCKED`**（被外部因素卡住，区别于「等用户回答」的 `CLARIFYING`）。

## ⚠️ 最重要的一条规则

> **Claude 完成编码后，只能把状态改为 `AWAITING_ACCEPTANCE`。**
> **Claude 无权自行标记 `DONE`。**

只有**同时**满足两个条件才允许标记 `DONE`：

1. **用户明确说「人工验收通过」**；
2. **用户已自行完成 Git commit**，并提供 commit hash 或明确表示提交完成。

**缺任何一个条件，Round 都停在 `AWAITING_ACCEPTANCE`。**

「Claude 编码完成」**不等于**「完成」。「自动测试全绿」**不等于**「完成」。

---

# 五、`README.md` —— 快速索引

每轮固定记录：

```markdown
Round ID:
Title:
Status:                 # 只能是上面七个之一
Depends On:
Goal:
Primary Domain:
Primary State Transition:   # 如果存在；没有就写「无」
Started At:
Development Completed At:
Accepted At:
Git Commit:             # 用户提交前留空
```

---

# 六、`01-prompt.md` —— 原始指令档案

**收到一轮开发提示词后，在开始任何业务分析或编码之前，先把该提示词的完整内容
保存到 `01-prompt.md`。**

## 文件头

```markdown
Round:
Received At:
Source: User / ChatGPT-assisted specification
```

## ⚠️ 正文保持原始指令

**不要**：

- 总结；
- 改写；
- 美化；
- 删除边界条件；
- 把它变成自己的开发计划。

**这是原始档案。** 它可以很长、可以口语化、可以前后重复。
**它的价值恰恰在于未被加工**——将来回看时，需要知道用户当时到底说了什么，
而不是 Claude 理解成了什么。

---

# 七、开发前的 Requirement Check

收到开发指令后**不要立刻编码**。先走完：

```
开发提示词
   ↓
读取 docs（01-requirements / 02-tech-design）
   ↓
读取相关现有代码
   ↓
读取相关现有测试
   ↓
Requirement Check
```

## 必须逐项确认的 12 件事

| # | 检查项 | 明确了吗？ |
|---|---|---|
| 1 | 产品规则是否完整 | |
| 2 | 前置状态是否明确 | |
| 3 | 成功状态是否明确 | |
| 4 | 失败状态是否明确 | |
| 5 | 权限是否明确 | |
| 6 | 金额是否明确 | |
| 7 | 幂等是否明确 | |
| 8 | 并发是否明确 | |
| 9 | 通知是否明确 | |
| 10 | 是否存在 `TBD — DO NOT INVENT` | |
| 11 | 与现有架构规范是否冲突 | |
| 12 | 是否与已有业务代码事实冲突 | |

---

# 八、什么必须自己解决（不要问用户）

以下问题**不得询问用户**，先搜索仓库：

- 文件在哪里；
- 某个函数叫什么；
- 某个类型是什么；
- 当前 Route 是什么；
- 当前测试怎么写；
- 当前 Repository 怎么组织；
- 当前组件如何组织；
- `package.json` 使用什么依赖；
- 任何**当前代码已经明确给出的事实**。

> **先搜索仓库。** 用 `Glob` / `Grep` / `Read`。
> 用代码就能回答的问题去问用户，是在浪费用户的时间。

---

# 九、什么必须先问用户

## 判定标准

> **查询现有需求文档 + 技术设计文档 + 源码以后，仍存在两个或以上合理方案，
> 并且不同方案会改变业务结果、权限、资金、状态机或长期架构时** ——
> 这才是真正的阻塞问题。

## 典型阻塞问题

- 产品语义（这个词到底指什么）；
- 状态迁移（能不能从 A 到 B）；
- 谁拥有权限；
- 钱如何变化；
- 是否退款；
- 是否换人；
- 是否保留数据；
- 是否允许某种操作；
- 出现 `TBD — DO NOT INVENT`；
- **两份权威文档发生冲突**；
- **用户最新指令与冻结规则发生冲突**。

> **⚠️ 这时禁止自行选择。** 包括：禁止按行业经验补齐、禁止「先按常见做法实现，
> 以后再改」、禁止选「比较合理」的那个。

**普通技术实现细节不需要反复询问**（变量命名、内部函数拆分、循环怎么写）。

---

# 十、`02-decisions.md` —— 提出问题

**如果存在任何阻塞问题，写进 `02-decisions.md`，然后停止开发。**

## 格式

```markdown
# P?-? Decisions

## Q1

Status: OPEN

### Claude Question

<完整问题>

### Why This Is Blocking

<为什么不同答案会改变业务结果>

### Affected Areas

- 文件 / 模块
- 状态机
- API
- UI
- 测试

### Known Facts

<已经从需求、技术设计、代码确认的事实>

### Remaining Decision

<真正需要用户决定的部分>
```

多个问题用 `Q1` / `Q2` / `Q3` 编号。

## ⚠️ 一次性集中提出

**全部问题一次问完。** 不要「问一个 → 用户答 → 再问一个 → 用户答」。

**唯一例外**：后一个问题确实只有得到前一个答案后才可能出现
（例：用户回答「要支持换打手」之后，才产生「换人后旧聊天保留多久」）。

## `Known Facts` 为什么必须有

它把「已经查证的事实」与「需要人决定的部分」分开。
**用户只需要回答 `Remaining Decision`**，不必重新验证已经确认过的东西。

**这一节写得好不好，直接决定用户回答得快不快。**

---

# 十一、写完问题后必须停止

如果存在任何 `Status: OPEN`：

```markdown
Round Status = CLARIFYING
```

然后向用户输出这些问题，**停止开发**。

## 禁止

- ❌ 一边问问题一边实现自己的假设版本；
- ❌ 为了赶进度选择「比较合理」的方案；
- ❌ 根据行业惯例填补 TBD；
- ❌ 让 frontend-agent / backend-agent 各自采用不同假设。

**等待用户回答。** 停在一个干净的位置，比带着一个自作主张的决定继续往下写要好。

---

# 十二、用户回答后的记录

把答案**追加**到对应 Q：

```markdown
### User Answer

<尽量原样记录用户回答>

### Final Execution Rule

<把答案规范化成可执行业务规则>

Status: RESOLVED
```

- 如果答案本身**仍然存在关键歧义** → 再次提问，保持 `OPEN`。
- 如果**全部**问题 `RESOLVED` → `CLARIFYING → READY`。

> **⚠️ `Final Execution Rule` 必须足够可执行**——它会被 Agent 当作规则来源。
> 「按用户说的做」不算规则。

---

# 十三、只有 READY 才能编码

```markdown
READY → IN_PROGRESS
```

此后严格按 **`01-prompt.md` + `02-decisions.md` + `docs/01-requirements` +
`docs/02-tech-design`** 共同形成的最终规则开发。

## 规则优先级 —— 三维，不是单一线性

**不要把它当成一条链。** 产品语义、架构语义、本轮 Scope 是**三个独立维度**，
各自有不同的权威来源。

### A. 产品 / 业务语义优先级

```
用户最新明确裁定
        >
当前 Round 02-decisions.md 中 RESOLVED / CURRENT 的 Final Execution Rule
        >
docs/01-requirements/
        >
01-prompt.md
        >
现有代码行为
```

### B. 技术 / 架构语义优先级

```
用户最新明确架构裁定
        >
当前 Round 02-decisions.md 中 RESOLVED / CURRENT 的 Final Execution Rule
        >
docs/02-tech-design/
        >
01-prompt.md
        >
现有代码行为
```

### C. 本轮 Scope

**本轮做什么 / 不做什么 / 修改范围 / 验收目标**由 `01-prompt.md` 定义。

> **Prompt 对本轮 Scope 权威，但 Prompt 不是自动覆盖长期产品规则和架构规则的工具。**

## ⚠️ 关键结论

**`01-prompt.md` 排在 `docs/01-requirements/` 与 `docs/02-tech-design/` 之下。**

它**不能**因为「是这一轮的 Prompt」就静默推翻已经冻结的业务规则或架构规则。

**`docs/02-tech-design/` 排在「现有代码行为」之上** —— **现状不是规范。**
代码当前这么做，不代表它是对的。

## 发现冲突怎么办

**当 `01-prompt.md` 与 `docs/01-requirements/` 或 `docs/02-tech-design/`
存在实质冲突时：禁止自行选择其中一个。**

```
Status → CLARIFYING
   ↓
写入 02-decisions.md
   ↓
向用户说明冲突
   ↓
等待裁定
```

### 唯一的例外

Prompt **明确写明**：

> 本轮正式修改此前某条已冻结规则。

**即使如此**，最终确认结果仍必须：

1. 写进 `02-decisions.md`；
2. **同步长期需求 / 技术设计文档**；
3. **保留旧规则被 `SUPERSEDED` 的历史**。

> **不能只修改代码。**

见 §十九。

---

# 十四、多 Agent 协作：输出协议与 Round 归属

项目使用以下项目级 Agent（见 `agent-collaboration.md`）：

`frontend-agent` · `backend-agent` · `test-agent` · `reviewer-agent`

## 14.1 规则：Sub-Agent 不得自行决策

> **任何 Sub-Agent 发现产品 / 架构歧义，不得自行决策，必须返回给
> Main Claude / Coordinator。**

## 14.2 Sub-Agent 输出协议

Sub-Agent **只向 Coordinator 返回结构化结果**：

| Agent | 允许的输出标记 |
|---|---|
| `backend-agent` | `IMPLEMENTATION_RESULT` · `PRODUCT_DECISION_REQUIRED` · `ARCHITECTURE_DECISION_REQUIRED` |
| `frontend-agent` | `IMPLEMENTATION_RESULT` · `BACKEND_DEPENDENCY` · `PRODUCT_DECISION_REQUIRED` |
| `test-agent` | `TEST_PLAN` · `TEST_RESULT` · `PRODUCT_DECISION_REQUIRED` |
| `reviewer-agent` | `BLOCKER` · `MAJOR` · `MINOR` · `NOTE` |

### 返回 `PRODUCT_DECISION_REQUIRED` / `ARCHITECTURE_DECISION_REQUIRED` 时

> **Sub-Agent 必须停止相关实现。**
> 不是「先按假设做完再报告」，也不是「做完再提醒」。

## 14.3 Coordinator 的统一处理

1. **汇总**所有 Agent 返回的标记；
2. **统一写入** `02-decisions.md`（不重复提问、不遗漏）；
3. **将 Round 转为 `CLARIFYING`**；
4. **统一向用户提问**。

## 14.4 Round 文档只允许 Coordinator 维护

> **四个 Sub-Agent 不得自行创建、修改或维护 Round 历史文件。**

只有 **Main Claude / Coordinator** 负责维护：

```
README.md
01-prompt.md
02-decisions.md
03-delivery.md
04-acceptance.md
```

**原因**：避免多个 Agent 同时写同一个 Round 文档造成冲突，
或产生多个版本的「事实」。

## 14.5 禁止

> **禁止多个 Agent 自行形成不同规则。**
> 更禁止让 frontend-agent 与 backend-agent 按各自的理解各写一套。

---

# 十五、`03-delivery.md` —— 实现结果

开发完成后创建 / 更新。**至少**包含以下小节：

| 小节 | 内容 |
|---|---|
| **Implemented** | 本轮真正完成了什么 |
| **Files Changed** | 新增 / 修改文件 |
| **Business Rules Implemented** | 对应哪些状态、权限、金额、异常规则 |
| **Tests Added / Updated** | 测试名称与覆盖的不变量 |
| **Verification** | 实际跑了哪些命令、结果如何 |
| **Known Limitations** | 本轮明确**没有**做什么 |
| **Out Of Scope** | 原本就不属于本轮的内容 |
| **Project Progress Change** | 本轮完成后全局进度发生了什么变化 |
| **Recommended Commit** | 只给 commit title 与 body |

## ⚠️ Verification 不得伪造

```bash
pnpm test
APP_BASE_URL=... pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

**实际执行了哪些就记录哪些。**
**不得伪造未运行的测试结果**——没跑就说没跑，跳过就说跳过，红了就贴出红的输出。

## Recommended Commit

只给 **commit title** 和 **commit body**。

> **Claude 不执行 Git 写操作。** 见 §二十。

---

# 十六、人工验收

代码与自动门禁完成以后：

```markdown
IN_PROGRESS → AWAITING_ACCEPTANCE
```

Claude 输出**手工验收步骤**（编号步骤 + 预期结果，覆盖自动化测不到的部分，
尤其是组件行为），**然后停止**。

> **不要自动进入下一 Round。**

---

# 十七、`04-acceptance.md` —— 验收记录

```markdown
# Acceptance

Status: PENDING

## Manual Acceptance Checklist

- [ ] ...
- [ ] ...

## User Result

待用户填写/确认。

## Issues Found

无 / 具体问题。

## Rework

如果发生返工，记录对应修改。

## Final Result

PENDING / PASSED / FAILED

## Git Commit

待用户自行提交后记录。
```

## DONE 的双重门槛

用户明确说「人工验收通过」之后：

```markdown
Final Result = PASSED
```

**但如果用户尚未提交 Git**：

```markdown
Round Status 仍为 AWAITING_ACCEPTANCE
```

等用户明确告知**已自行 Git commit** 并提供 hash 或明确表示提交完成后：

```markdown
Status = DONE
Git Commit: <hash>
```

---

# 十八、全局进度文件的更新规则

## 只记录

- Round ID；
- 功能；
- 状态；
- 依赖；
- blocker；
- **对应 Round 链接**；
- 下一步。

## 不要复制

- ❌ 完整 prompt；
- ❌ 全部 Q&A；
- ❌ 完整测试日志；
- ❌ 大段实现报告。

**这些属于 Round 文件。**

## ⚠️ 什么时候才能写 ✅

开发过程中可以把 Round 标为「进行中 / 等待确认 / 等待验收」。

> **只有 Round 真正 `DONE` 之后，才能把对应业务能力标记为 ✅ 完成。**

**不要因为「Claude 编码完成」就在全局进度里写 ✅。**

---

# 十九、Round 文件是追加历史，不覆盖历史

## `02-decisions.md`

**不要因为后来改变决定就删除旧决定。** 保留演变过程：

```markdown
## Q3

### Decision V1

<当时的裁定>

Status: SUPERSEDED

### Decision V2

<新的裁定，以及为什么改>

Status: CURRENT
```

这样能够知道：**规则什么时候、为什么改变。**

## 返工

返工记录写在 `03-delivery.md` 或 `04-acceptance.md` 里，
**而不是抹掉第一次交付的历史。**

> **Round 档案的价值在于它记录了真实过程，包括走过的弯路。**
> 一份只剩完美结局的档案，对未来会话没有参考价值。

---

# 二十、与 Git 的关系

**所有 Round 文件跟随项目进入 Git。**

Claude **永远不执行**：

```
git add
git commit
git push
git amend
git rebase
```

仍由**用户亲自操作**。只读 Git 允许：`git status` / `git diff` / `git log`。

> **开工前先检查工作区。** 如果发现仍有上一批未提交内容，**先报告**，
> 不要偷偷吸收到下一批。

---

# 二十一、标准流程速查

```
1. 用户给出本轮开发提示词
2. 检查工作区（git status）——有未提交内容先报告
3. 创建 docs/03-dev/rounds/<ROUND_ID>/
4. 原样保存提示词 → 01-prompt.md
5. README.md：Status = PLANNED
6. 读取 docs + 相关代码 + 相关测试
7. Requirement Check（12 项）
8. ┌ 有阻塞问题？
   ├─ 是 → 写 02-decisions.md（全部集中）→ CLARIFYING → 输出问题 → 停止
   │        用户回答 → 追加 User Answer + Final Execution Rule
   │        → 全部 RESOLVED 后 → READY
   └─ 否 → READY
9. READY → IN_PROGRESS → 按优先级链开发
10. 自动门禁：pnpm test / typecheck / lint（必要时 build）
11. 写 03-delivery.md
12. IN_PROGRESS → AWAITING_ACCEPTANCE，输出手工验收步骤，停止
13. 用户人工验收 → 记录 04-acceptance.md
14. 用户自行 Git commit
15. 用户明确告知验收通过 + 已提交
16. Final Result = PASSED，Status = DONE，记录 Git Commit
17. 更新全局进度（此时才可写 ✅）
```

---

# 二十二、本协议的维护

本文件与 `docs/03-dev/rounds/` 是**成对**的：流程变化时两边都要改。

**本文件不承载业务规则。** 业务规则变了改 `docs/01-requirements/`，
架构规则变了改 `docs/02-tech-design/architecture-rules.md`。
**不要往这里抄。**
