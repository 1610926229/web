# Agent 协作规范（Agent Collaboration）

> **状态：CURRENT** —— 本文件描述的是**已经落地**的 Agent 定义与协作方式，不是规划。
> 四个 Agent 文件已存在于 `.claude/agents/`。
>
> **本文件不定义任何业务规则。** 业务规则的唯一真值源仍然是 `docs/01-requirements/`；
> 架构规则的唯一真值源仍然是 `architecture-rules.md`。本文件只回答一个问题：
> **一件活该由谁做、按什么顺序做、谁能碰哪些文件。**

---

# 一、这是什么，不是什么

**是：** 四个**专业执行者**的职责边界，和 Coordinator 编排它们的固定流程。

**不是：** 一支能自行决定产品方向的团队。Agent 没有产品决策权、没有架构例外权、
没有解释需求的权力。它们执行，并且只在被授权的范围内执行。

**本项目的 Agent 是为这个仓库量身定义的**——它们引用真实的文档路径、真实的
行号、真实的已知缺陷、真实的测试基础设施。**不要替换成通用的
「frontend developer / backend developer」模板**，那会让它们丢掉全部价值。

---

# 二、主会话就是 Coordinator

**Coordinator 不是第五个 Agent。** 它就是主 Claude Code 会话本身。

不存在 `coordinator-agent.md`，**也不应该创建**——创建它等于把编排权交给一个
和被编排者同级的 Agent。

## Coordinator 的职责

1. **读用户需求**——完整读，不跳。
2. **对照 `docs/01-requirements/` 与 `docs/02-tech-design/` 判断是否存在 TBD。**
   存在就**先问产品负责人**，不往下拆。
3. **把任务拆成明确的子任务**——每个子任务有清晰的输入、输出、验收标准。
4. **决定调用哪个 Agent**，以及**串行还是并行**（见 §五）。
5. **控制每个 Agent 的修改范围**——在派发时明确写「你只能改 X」。
6. **合并结果**，解决冲突。
7. **运行最终验收**：`pnpm test` + `pnpm typecheck` + `pnpm lint`（必要时 `pnpm build`）。
8. **输出统一交付报告**——不是把四个 Agent 的报告原样拼起来，而是综合成一份。
9. **提醒人工验收**，给出**建议的 Git 提交描述**。
10. **停止**，等验收。**不自动开始下一批。**

## 铁律

> **禁止让多个 Agent 自行竞争架构决策权。**

两个 Agent 对同一件事给出不同方案时，**由 Coordinator 裁决**——
裁决不了就升级给用户。**不允许让它们互相说服，也不允许让它们各写一套。**

---

# 三、四个 Agent

| Agent | 文件 | 角色 |
|---|---|---|
| `frontend-agent` | `.claude/agents/frontend-agent.md` | 界面与浏览器交互实现者 |
| `backend-agent` | `.claude/agents/backend-agent.md` | 领域逻辑、API、数据与一致性实现者 |
| `test-agent` | `.claude/agents/test-agent.md` | 测试设计与回归保护工程师 |
| `reviewer-agent` | `.claude/agents/reviewer-agent.md` | **只读**代码审查者 |

## 3.1 允许修改范围（互不重叠，这是并行的前提）

| Agent | 可以改 | 不可以改 |
|---|---|---|
| `frontend-agent` | `app/**/page.tsx` `layout.tsx` `loading.tsx` `error.tsx`、`components/**`、`lib/services/*Http.ts`、`lib/constants/*.ts` 的**展示层**部分 | `lib/data/**`、`lib/mocks/**`、`app/api/**`、金额计算、状态机、`tests/**` |
| `backend-agent` | `lib/types/**`、`lib/constants/**`、`lib/data/**`、服务端 `lib/services/*.ts`、`lib/api/**`、`app/api/**/route.ts`、`lib/mocks/fixtures/**` | `app/**/page.tsx`、`components/**`、`tests/**`（除非 Coordinator 明确指派） |
| `test-agent` | `tests/**` | **任何生产代码**。发现 Bug 就报，不修 |
| `reviewer-agent` | **无。只读。** | 一切写操作 |

## 3.2 每个 Agent 的硬性禁令（一句话版）

- **`frontend-agent`** —— 不 `import lib/data`、不 import `lib/mocks`、不在组件里
  `fetch()`、不算金额、不定义状态迁移、不新增认证体系、不定义 API 契约。
  缺后端能力时输出 **`BACKEND_DEPENDENCY`**。
- **`backend-agent`** —— 不违反调用链（Route 只做 guard/解析/调 service/response）、
  不用浮点「元」、不重写金额公式、不新增第二套 Order/Refund/Notification/
  超时退款/打手身份、不在原子区段里写 `await`。
  规则没定时输出 **`PRODUCT_DECISION_REQUIRED`**。
- **`test-agent`** —— 不为了让测试变绿改业务规则、不重写生产逻辑、不引入测试框架、
  不把源码字符串扫描当作行为测试的替代。
- **`reviewer-agent`** —— **不修改任何文件。** 只输出 `BLOCKER` / `MAJOR` / `MINOR` / `NOTE`。

## 3.3 推荐调用场景

| 场景 | 用谁 |
|---|---|
| 新增/修改页面、组件、加载/空/错误态、移动端布局、表单 | `frontend-agent` |
| 新增/修改接口、状态机、金额、幂等、并发、权限守卫、仓储 | `backend-agent` |
| 新功能需要测试保护；判断某改动是否破坏既有边界 | `test-agent` |
| 一批改动交付前审查；怀疑某实现违反已确认规则 | `reviewer-agent` |

## 3.4 Sub-Agent 输出协议（`development-workflow.md` §14.2）

Sub-Agent **只向 Coordinator 返回结构化结果**：

| Agent | 允许的输出标记 |
|---|---|
| `backend-agent` | `IMPLEMENTATION_RESULT` · `PRODUCT_DECISION_REQUIRED` · `ARCHITECTURE_DECISION_REQUIRED` |
| `frontend-agent` | `IMPLEMENTATION_RESULT` · `BACKEND_DEPENDENCY` · `PRODUCT_DECISION_REQUIRED` |
| `test-agent` | `TEST_PLAN` · `TEST_RESULT` · `PRODUCT_DECISION_REQUIRED` |
| `reviewer-agent` | `BLOCKER` · `MAJOR` · `MINOR` · `NOTE` |

> **返回 `PRODUCT_DECISION_REQUIRED` / `ARCHITECTURE_DECISION_REQUIRED` 时，
> Sub-Agent 必须停止相关实现**——不是「先按假设做完再报告」。

## 3.5 Round 文档归 Coordinator 独有

> **四个 Sub-Agent 不得自行创建、修改或维护 Round 历史文件。**

`README.md` · `01-prompt.md` · `02-decisions.md` · `03-delivery.md` ·
`04-acceptance.md` —— **只有 Main Claude / Coordinator 维护**。

**原因**：避免多个 Agent 同时写同一个 Round 文档造成冲突，
或产生多个版本的「事实」。

---

# 四、协作协议

## 4.1 Agent 之间不直接接管任务

**所有跨 Agent 的交接都经过 Coordinator。**

`frontend-agent` 发现缺接口 → 输出 `BACKEND_DEPENDENCY` **交回 Coordinator**，
不是自己去喊 `backend-agent`。

理由：Agent 之间的直接交接会绕过 Coordinator 的范围控制，
最终没人对「这批到底改了什么」负责。

## 4.2 默认执行顺序

```
Coordinator（拆任务、查 TBD）
  → backend-agent        实现领域 / API
  → test-agent           补测试与验证
  → frontend-agent       接 UI
  → test-agent           HTTP / 回归
  → reviewer-agent       只读审查
  → Coordinator          综合、跑全量验收、出报告
```

**先后端后前端**，因为前端要消费的 DTO 与接口必须先存在——
否则 `frontend-agent` 只能输出 `BACKEND_DEPENDENCY` 空跑一轮。

**审查放在最后**，因为审查的是成品。

## 4.3 四种任务类型的推荐链路

### A. 普通功能开发（跨前后端）

```
Coordinator → backend-agent → test-agent → frontend-agent → test-agent → reviewer-agent → Coordinator
```

### B. Bug 修复

```
Coordinator（先复现、定位根因）
  → backend-agent 或 frontend-agent（取决于根因位置）
  → test-agent（写一条**先失败**的回归测试钉住这个 Bug）
  → reviewer-agent
  → Coordinator
```

**⚠️ 顺序是「先写失败的测试，再修」。** 反过来会得到一个「测当前错误行为」的测试。

### C. 纯 UI 功能（后端能力已存在）

```
Coordinator → frontend-agent → reviewer-agent → Coordinator
```

**跳过 test-agent**——组件行为在本项目没有自动化测试（Node 24 不剥离 JSX），
`frontend-agent` 的交付物必须自带手工验收步骤。

### D. 资金 / 状态机功能（最高风险）

```
Coordinator → backend-agent
  → test-agent（不变量 + 并发 + 权限矩阵 401/403/404/正常）
  → reviewer-agent（金额与状态机专项）
  → frontend-agent（仅接线，不碰金额）
  → test-agent（HTTP 契约回归）
  → reviewer-agent（对前端改动再审一次）
  → Coordinator
```

**这类任务串行执行，不并行。** 见 §五。

---

# 五、并行与文件冲突边界

## 5.1 并行时必须修改范围互不重叠

| Agent | 修改范围 |
|---|---|
| 前端 | `components/**`、`app/companion/**`、`lib/services/*Http.ts` |
| 后端 | `lib/types/**`、`lib/constants/**`、`lib/data/**`、服务端 `lib/services/**`、`app/api/**` |
| 测试 | `tests/**` |
| 审查 | 只读 |

## 5.2 冲突处理

> **两个 Agent 必须修改同一文件时，不要并行**，由 Coordinator 串行安排。

**⚠️ 最高频的冲突点是 `lib/constants/`。** 前端要加展示常量、后端要加业务规则，
两边都会碰它。**同一个批次里，`lib/constants/` 只允许一个 Agent 改。**

**⚠️ 第二个冲突点是 `lib/services/`。** `ordersHttp.ts`（前端）与 `orders.ts`
（后端）同目录，改动时按文件划分，不按目录划分。

## 5.3 什么时候不要并行

- **任务 D（资金/状态机）**——处处是跨文件不变量，并行收益低于协调成本。
- **Coordinator 自己还没想清楚拆法时**——先想清楚，再并行。
- **同一个文件**。

---

# 六、四个 Agent 共享的五条规则

四个 Agent 文件里都写入了这五条，**它们是 Agent 的最低约束**：

1. **开发前必读** —— 先遵守 `CLAUDE.md`，再按任务阅读 `docs/01-requirements/`
   与 `docs/02-tech-design/` 的相关部分。
   **并按 [`../03-dev/development-workflow.md`](../03-dev/development-workflow.md)
   走开发轮次协议**；当前 Round 的 `docs/03-dev/rounds/<ROUND_ID>/02-decisions.md`
   是**最终执行口径**，优先级高于需求文档。
2. **不得自行决定 TBD** —— 文档里的 `TBD — DO NOT INVENT` 与需求文档的 `❓` 标记
   一律不自行设计。**禁止按行业经验补齐、禁止「先按常见做法实现以后再改」、
   禁止把未定规则写进 `lib/constants/` 当成已确认规则。**
3. **发现歧义不得自行决策，也不得维护 Round 文档** —— 见 §七 与 §3.5。
   任何产品 / 架构歧义返回 `PRODUCT_DECISION_REQUIRED` /
   `ARCHITECTURE_DECISION_REQUIRED` 给 Coordinator，由 Coordinator 统一写入
   `02-decisions.md` 后集中向用户提问。
   **禁止多个 Agent 各自形成不同规则。**
   **Round 历史文件（`README` / `01-prompt` / `02-decisions` / `03-delivery` /
   `04-acceptance`）只有 Coordinator 可以创建和修改。**
4. **不执行 Git 写操作** —— 禁止 `git add` / `commit` / `push` / `rebase` /
   `amend` / `reset --hard`。只读 Git 允许。**提交由项目负责人本人完成。**
5. **不扩大任务范围** —— 任务是 P0-6 就只做 P0-6。不顺手拆 `adminHttp.ts`、
   不重构 Auth、不删 `lib/data/source.ts`、不引入 Event Bus / 状态管理库 /
   测试框架 / ORM。**见 `architecture-rules.md` §八「什么不算问题」。**

---

# 七、禁止「Agent 自治开发」

> **Agent 是专业执行者，不是独立产品负责人。**

以下事项**必须回到 Coordinator / 用户**，Agent 无权自行决定：

- 最终产品决策
- 架构例外
- TBD 规则
- 跨模块重大改动
- 资金口径
- 权限边界的任何放宽

**Agent 不得因为「实现起来更顺」而改变一条已确认的产品规则。**
遇到阻塞就输出 `PRODUCT_DECISION_REQUIRED` 或 `BACKEND_DEPENDENCY` 并停下——
**停在一个干净的位置，比带着一个自作主张的决定继续往下写要好。**

---

# 八、技术事实（Claude Code 2.1.278，本机核实）

> 以下是**在本机安装版本上逐项验证过**的事实，不是从旧文档回忆的。
> 版本升级后需重新确认。

## 8.1 目录与调用

- **标准位置**：`.claude/agents/*.md`（项目级）与 `~/.claude/agents/*.md`（用户级）。
  子目录也扫描。本项目用**项目级**。
- **调用方式**：主会话通过 **Agent 工具**，`subagent_type` 填 Agent 的 `name`。
  **不是** bash 命令。
- **⚠️ 新建 Agent 文件后需要新开会话。** 没有证据表明 `.claude/agents/` 有文件
  监听器——本次创建的四个 Agent，**重启会话后才会出现在可调用列表里**。
- **⚠️ `/agents` 斜杠命令在 2.1.278 已移除。** 管理 Agent 靠直接编辑
  `.claude/agents/*.md`。

## 8.2 frontmatter 字段（实际支持的）

`name`（必填，不得含 `:`、不得以 `-` 开头）· `description`（**必填**）·
`tools` · `disallowedTools` · `model` · `effort` · `color` · `permissionMode` ·
`maxTurns` · `memory` · `isolation` · `background` · `mcpServers` · `hooks` ·
`skills` · `initialPrompt` · `omitClaudeMd`

- **markdown 正文就是该 Agent 的 system prompt。**
- `model` 支持 `sonnet` / `opus` / `haiku` / `fable` / `inherit`。
- `effort` 取 `low` / `medium` / `high` / `xhigh` / `max`，或整数。
- `color` 只有 8 个有效值：`red blue green yellow purple orange pink cyan`。
  **非法值被静默丢弃，不报错**——写了不生效的名字不会有人告诉你。
- **⚠️ 不存在 `permission` 字段。**
  **⚠️ `allowed-tools`（连字符）是 skill 的字段，不是 agent 的字段**，写在这里无效。

## 8.3 只读是怎么实现的

本项目用**两层**：

```yaml
tools: Read, Glob, Grep, Bash
disallowedTools: Write, Edit, NotebookEdit
```

`tools` 白名单里不出现 `Write` / `Edit` —— 这是**主要机制**，
与 Claude Code 自带的只读 Agent（`Explore`、`Plan`）做法一致。

`disallowedTools` 是**冗余兜底**：即使将来有人往 `tools` 里加了 `Write`，
这一行仍然拦得住。

**为什么不用 `permissionMode: plan`**：它确实合法且能阻止编辑，但 plan 模式会
改变 Agent 的输出形态（向「提计划」倾斜），而 `reviewer-agent` 的产出**本身就是
审查报告**。为了一个已经由前两层覆盖的保证去扰动它的输出，得不偿失。

## 8.4 已知的未核实项

- **项目级 Agent 与用户级 Agent 同名时的优先级**——未能从本机二进制中确认。
  **规避方式：使用不易撞名的名字。** 当前四个名字（`frontend-agent` /
  `backend-agent` / `test-agent` / `reviewer-agent`）都是项目专用前缀。
- **同会话内编辑 `.claude/agents/*.md` 是否热加载**——未确认。**按需新开会话。**

---

# 九、与 P0-5.5 的关系

`reviewer-agent.md` 与 `backend-agent.md` 里都以「已知缺陷」的形式记录了几条
**属 P0-5.5 的既有事实**（`refundedAmount`、`ORDER_TRANSITIONS`、Checkout 重复
判定、companion 接口门禁）。

它们被写进 Agent 文件是为了**两条**：
1. 让 Agent 知道这些是**已裁定的方向**，不要另提一套；
2. 让 Agent 知道这些**不属于当前批次**，不要顺手改。

**⚠️ P0-5.5 完成后，这两份 Agent 文件里的对应段落需要同步更新。**
否则 Agent 会继续按「还没有」的前提工作。

---

# 十、本文件的维护

本文件与 `.claude/agents/*.md` 是**成对**的：Agent 清单、范围、协作顺序
发生变化时，两边都要改。

**本文件不承载业务规则**——业务规则变了改 `docs/01-requirements/`，
架构规则变了改 `architecture-rules.md`。**不要往这里抄。**
