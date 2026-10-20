# P0-14 · 决策与需求核对（`02-decisions.md`）

> **本文件按「追加历史、不覆盖历史」维护**：后续裁定与 reviewer 处置**追加在文末**，
> 不改写已经写下的判断。被推翻的旧判断会**划线保留**并注明被哪一条取代。

---

## §一、Requirement Check（2026-09-27，基线 `HEAD = c2c9360`）

`cmd_p0-14.md` §十五 要求逐条检查五处。以下为**逐条核算结果**，
每一条都**读过原文**（不是凭文件名推断）。

### 1.1 `EX-SERVICE-04`（`特殊情况与异常处理表.md:351`）

原文（表格「聊天」行）：

> **每次新 assignment 建新会话；新打手看不到旧聊天**

该表 `状态` 行：**`✅ 2026-09-23 已确认`**。

同表「历史」行：`客服/管理员保留旧 assignment 记录`。
同表「当前规则」行：`不设置换人次数上限`。

⇒ **本轮要做的「新 assignment 新建会话 + 新打手看不到旧聊天」= 已冻结的硬规则。**

### 1.2 `EX-CHAT-01 更换打手`（`特殊情况与异常处理表.md:693`）

| 项目 | 处理 | 本轮落点 |
|---|---|---|
| 原打手聊天 | 保留历史 | 会话**不删**，只失权（§三 D2） |
| 新打手 | 创建新 Conversation | assignment 会话按 `assignmentKey` 区分 |
| 新打手看旧聊天 | 不允许 | 访问判据含「会话的 assignment 必须是**当前**那一段」 |
| 客服/管理员 | 可查看旧 assignment | Staff 可读全部会话（§五 D5） |
| 用户 | 仍可看到自己参与的聊天历史，**具体 UI 表现后续定** | 用户端分段展示；⚠️ **UI 表现未被需求冻结 ⇒ 由本轮实现选择**（§四 D4） |
| 状态 | ⏳ | 本轮落地 |

> 📌 **重要**：`EX-CHAT-01` 的「用户」一行**明文把 UI 表现后置**（「具体 UI 表现后续定」）。
> 因此本轮对用户端展示形态的选择**不是在替产品决定需求**，而是在需求明确留给实现的空间里选择；
> 本文件把它写成决策并说明理由，供验收时复核。

### 1.3 `EX-CHAT-02 原打手被换掉后继续发消息`（`:706`）

> 当前 assignment：已不属于原打手 / 原打手：**不得继续向新 assignment 会话发消息** / 历史会话：只读、可见范围按权限

⇒ 「旧打手失权」**同时**覆盖**读**与**写**，且失权对象是**新 assignment 会话**与**自己那一段旧会话**两者。
本轮实现：旧打手对该订单的**任何** assignment 会话都拿不到访问权（写入与读取同一判据）。

### 1.4 权限矩阵原文（`用户权限表.md:112-113`）

列头依次为 `游客 / 老板(下单用户) / 护航(Companion) / 客服 / 管理员 / System`：

| 行 | 原文 |
|---|---|
| 用户端订单聊天 | ❌ \| **条件：自己的订单** \| **⏳ 当前 assignment** \| ✅ \| ✅ \| 系统通知 |
| 查看其他打手历史聊天 | ❌ \| 自己参与部分按规则 \| **❌** \| ✅ \| ✅ \| ❌ |

⇒ 与 §1.2 / §1.3 完全一致：**Companion 只能碰「当前 assignment」**，看别的打手历史聊天是 **❌**。

其余相关原文：

- `:259`（`enabled=false` / removed）：「**不允许继续查看当前履约聊天**」——封禁场景的失权要求。
- `:508`：「原打手立即失去工作台、接单、**聊天**、提交完成材料权限」。
- `:422`（客服 §7.1 可以）：「**查看历史 assignment 聊天用于调查**」。
- `:414`：「查看订单相关会话」。
- ⚠️ `:417`（客服 §7.1 可以）：「**与当前实际打手沟通**」——见 §六 登记项 **R1**。

### 1.5 `BF-23 当前 assignment 聊天`（`业务流程表.md:769`）——**目标模型**

```
每次实际履约 assignment 对应一份 Conversation。

参与者：
- 订单用户；
- 当前实际打手；
- 客服/管理员按管理权限查看。

更换打手时：
旧打手 A → 旧 Conversation
新打手 B → 新 Conversation
B 不得看到 A 的聊天。
客服/管理员仍可查看历史 assignment 对话用于调查。

当前状态：
- 用户↔客服聊天已有基础；
- Companion 发消息、assignment 隔离尚未完成。
```

⇒ **「用户↔客服聊天已有基础」是被明确承认的现状**，`BF-23` 没有要求拆除它，只要求补上
「Companion 发消息 + assignment 隔离」。这直接决定了 §三 D1（**保留客服会话**）。

### 1.6 当前 message schema（已读原文）

`lib/types/message.ts`：`OrderConversationRecord = { orderId, userId, createdAt, userLastReadAt }`
——**以 `orderId` 为唯一维度，无 assignment 维度**。
`lib/data/mockMessageRepository.ts`：`conversations: Map<orderId, record>`，且 `createStore` 里
`conversationSeed.map((item) => [item.orderId, item])` 与 `assertNoDuplicateConversation`（种子层）
**两处都硬编码了「一单只能有一个会话」**。

⇒ `cmd_p0-14.md` §三 的判断成立：**结构上装不下**多次 assignment。

### 1.7 P0-11 release 原语（已读原文）

`lib/data/companionOrderTransaction.ts:227` `releaseCurrentAssignment`：**1 处定义 + 4 处调用**
（`:391` / `:602` / `:725` / `:840`），整段**无 `await`**。
内部依次同步调用：`invalidatePendingCompletionForOrder` → `appendCompanionRelease` →
`applyOrderAcceptanceReleased` → （`applyDispatchAccepted` + `applyOrderAccepted` | `applyDispatchToPublic`）→ `appendNotification`。

⇒ 满足 `cmd_p0-14.md` §十一「必须复用唯一释放原语，不要在 chat 模块重新判断『换人发生了没』」。

### 1.8 结论

**无 `OPEN` 决策，不需要 `CLARIFYING`。**

唯一可能被读成冲突的「assignment conversation 的**创建时点**」，经比对
`cmd §4.1`（订单首次进入 `accepted` 且存在 `actualCompanionId`）· `BF-23` · `EX-CHAT-01` · `EX-SERVICE-04`
——**四处说的是同一件事**（assignment 始于接单），**不构成冲突**，因此不触发 §十五 的 `CLARIFYING` 条件。

### 1.9 明确 `DEFER`（不自行决定）

**聊天 retention / 物理删除**。四处权威文本**同时**把它标为未决：

| 出处 | 原文 |
|---|---|
| `业务流程表.md:795` `BF-24` | 已确认部分是「普通 completed 订单**可**物理删除」「投诉订单永久保留」「换人的旧履约聊天永久可查」；**待确认 `BR-02`：仅发生退款、没有投诉的订单，聊天是否也永久保存？** |
| `特殊情况与异常处理表.md:717` `EX-CHAT-03` | 删除顺序与幂等**原则**已确认，`状态：✅ 原则确认，功能 ⏳` |
| `特殊情况与异常处理表.md:~730` `EX-CHAT-04` | 「只有退款、没有投诉的订单 — 是否永久保留聊天：**❓**」 |
| `特殊情况与异常处理表.md:1094` `Q-EX-07` | 「退款订单聊天是否无条件永久保留」 |
| `用户权限表.md:674` `PR-06` | 「只有退款、没有投诉的聊天是否永久保存？」 |

`cmd_p0-14.md` §十三 与 §十五 明文允许本轮 `DEFER`。
⇒ **本轮不实现任何删除路径、不建 retention scheduler、不写任何「到期」字段。**

### 1.10 本轮明确不做（照录 `cmd_p0-14.md` §十三，逐条遵守）

聊天物理删除 · retention scheduler · `EX-CHAT-04` 未冻结的永久保留规则 · 图片/附件/语音 ·
WebSocket · 在线状态 · typing indicator · 消息撤回 · 消息举报 · **完整 Assignment 聚合** ·
新 User/Companion Auth · 真数据库 · 真 Scheduler。

---

## §二、`cmd_p0-14.md` 的核心约束（本轮的设计红线）

| # | 约束 | 出处 |
|---|---|---|
| C1 | 允许**最小** assignment conversation 模型升级 | §三 |
| C2 | **禁止**为了聊天建立完整 Assignment 聚合 | §三 |
| C3 | 必须复用 P0-11 的 `releaseCurrentAssignment` 等既有履约事实 | §十一 |
| C4 | **不得改变 `OrderStatus`** | §三 |
| C5 | **不得**创建第二套 Order / Auth / Companion 身份系统 | §三 |
| C6 | 不自行创造第二套聊天系统；能复用 service 就复用 | §五 |
| C7 | 伪事务原子区段内**不得**加 `await` | §十一 |
| C8 | 聊天失效若需跨仓储写入，用**现有 transaction 模式**扩展，不在 Route Handler 拼业务 | §十一 |
| C9 | 已读必须按「角色 + conversation/assignment」隔离；**禁止**继续只按 `orderId` 保存 Companion 已读 cursor | §九 |
| C10 | retention `DEFER` | §十三 |

---

## §三、模型设计

### D1 — 会话分两类，**保留**客服会话（`kind: "service"` + `kind: "assignment"`）

**决策**：会话记录新增 `kind` 字段，取值 `"service"`（用户↔客服，**沿用现状**）与
`"assignment"`（某一次履约的订单用户↔当前打手）。

**理由（三条，均为已冻结事实）**：

1. `BF-23` 明文承认「**用户↔客服聊天已有基础**」，只要求补「Companion 发消息 + assignment 隔离」——
   拆除客服会话**没有任何授权文本**。
2. `cmd_p0-14.md` §4.1 明文：**「public pool 中没有 `actualCompanionId` 时：不创建打手 assignment conversation。」**
   ⇒ 存在「有订单、无 assignment」的状态（种子 `ord-seed-1001-01` 正是：用户问「这一单还没人接吗？」，
   此时**根本不存在**打手会话）。若把客服会话并入 assignment 会话，这类订单的沟通渠道会**整个消失**。
3. `用户权限表.md:112` 给「老板」的订单聊天权限是「**条件：自己的订单**」，**未附加任何 assignment 条件**——
   即用户对**自己订单**的沟通权不依赖是否存在打手。

**因此 `kind` 是本轮**唯一**新增的会话维度**，两个取值分别对应两种既有/新增渠道。

> ⚠️ **不做的事**：不新增 `OrderStatus`、不新增 Assignment 实体、不新增 Order/Auth/Companion 身份。

### D2 — `assignmentKey` 由 **P0-11 的退出历史条数**推导（**本轮最关键的决策**）

**决策**：

```
assignmentSeq(订单)  = 该订单当前 CompanionReleaseRecord 的条数（append-only，只增不改）
assignmentKey        = `${orderId}#s${assignmentSeq}`
```

会话记录上**同时**冻结三样：`assignmentKey`、`assignmentSeq`、`companionId`。

**为什么不能用 `companionId` 当键**（这是本轮最容易被做错的地方）：

`cmd_p0-14.md` §4.3 + 测试项 4 要求 **`A → B → A` 第三次要新建会话**。
若键是 `${orderId}:${companionId}`，A 第二次接单会**命中自己第一次的会话**并复用 ⇒
A 会重新看到自己上一段履约的聊天，而且「旧会话只读」这条规则会被静默绕过。
**`companionId` 不足以区分履约阶段。**

**为什么用退出历史条数**：

| 要求 | 由该设计如何满足 |
|---|---|
| `A → B → C` 三段互不相同 | 每段开始时的退出条数依次为 `0,1,2` |
| `A → B → A` 第三次与第一次不同 | A 第二次接单时退出条数已 ≥ 2 ⇒ 键不同（**这正是 §4.3 要的**） |
| 复用 P0-11 既有事实（C3） | 直接读 `listCompanionReleasesByOrderId(orderId)`，**不新建任何追溯表** |
| 退出历史只增不改 | `lib/types/companionRelease.ts` 明文「只增不改」；`appendCompanionRelease` 不覆盖旧记录 |
| **不需要在释放事务里多写一行**（C7 / C8） | 释放动作**追加一条退出记录**，条数自然 +1 ⇒ 旧会话**结构性地**不再是「当前那一段」 |

**「失权」的判据（三段，必须同时成立）**：

```
① order.actualCompanionId === 请求的打手            （当前绑定的就是他）
② conversation.companionId === 请求的打手            （这一段会话本来就是他的）
③ conversation.assignmentKey === 当前 assignmentKey   （这一段仍然是「当前」那一段）
```

③ 是 **`A → B → A` 的胜负手**：①② 在 A 的两段会话上都成立，
**只有 ③ 能把 A 的第一段会话挡在外面**。
⇒ 本文件把它写成显式不变量，并对应测试项 4 / 13 / 16。

> ⚠️ **派生 vs 冻结的分工**：`assignmentSeq` 在**会话创建那一刻冻结**进记录，
> 之后**永不重算**；而「当前 assignmentKey」在**每次请求时现算**。
> 两者相等 ⇔ 这段会话仍是当前履约。这个设计**没有**「需要被记得去写的失效标记」，
> 所以不可能出现「换人时忘了标记失效」这类缺陷。

**唯一性论证（为什么惰性创建不会串键）**：
会话只在「它仍是当前 assignment」时才可能被创建（创建与访问共用同一判据，见 D3），
因此在创建的那一刻必然有 `assignmentSeq(记录) === 当前条数`。
而条数只在**释放**时 +1，释放之后该会话不再是当前 ⇒ 不会再有人以「当前」的身份创建它。
两段履约因此不可能拿到同一个键。

### D3 — 会话**惰性创建**，失效**结构性**发生（释放事务**零改动**）

**决策**：不在接单事务里创建会话。会话在该 assignment **第一次被访问**（读或写）时创建，
且创建与访问**共用同一判据**（D2 的 ①②③）。

**理由**：

1. **C7 / C8**：P0-14 的「旧会话失效」若要在释放事务里写，就要把 chat 仓储拉进
   `lib/data/companionOrderTransaction.ts` 的原子区段。而 D2 的设计让失效**自动发生**——
   释放已经追加了退出记录，条数 +1，判据 ③ 当场不再成立。
   **因此本轮对 `releaseCurrentAssignment` 的改动是：零行。**（这是对本轮风险的**净减少**。）
2. **`EX-CHAT-01` 明文的「保留历史」**：失效 ≠ 删除。会话记录**不被改动、不被删除**，
   只是不再满足「是当前那一段」。这正是「保留历史」在数据上的正确表达。
3. 既有代码本来就是惰性创建（`ensureConversation` 由用户「发起沟通」触发；种子 `ord-seed-1001-07`
   就是「刚发起、还没有消息」的会话）——**沿用同一种时序**，不引入第二种。

> ⚠️ **与 `cmd_p0-14.md` §4.1 字面的关系**：§4.1 说「若该 assignment 尚无 conversation：创建一条」。
> 本设计**满足**这条（该 assignment 第一次被访问时创建），只是把创建时点从「接单瞬间」
> 推迟到「首次访问」——**assignment 的身份不依赖这次创建**（它由退出条数决定，接单那一刻就确定）。
> 好处是不在接单/释放事务里引入第二份可变状态。**此取舍登记供验收复核。**

### D4 — 用户端：分段展示 + **发送目标显式指定**

**决策**：

- 用户 DTO 返回 `segments: [...]`：客服会话永远在，assignment 会话按 `assignmentSeq` 升序。
- 每段带 `kind` / `isCurrent` / `isReadOnly` / 打手显示名（快照）/ 消息列表。
- 发送接口接受**可选** `target: "service" | "current"`，**缺省 = `"service"`**。
- 历史 assignment 段 **`isReadOnly: true`**，发送到它一律拒绝（`cmd_p0-14.md` §2.1）。

**为什么缺省是 `service`**：这是**今天的行为**（唯一那个会话就是客服会话）。
缺省保持不变 ⇒ 现存的用户端调用与测试**零行为变化**，回归面最小。
UI 上每一段都有自己的输入框，**总是显式传 target**，不依赖缺省。

**为什么用户端不暴露 `assignmentKey`**：测试项 31 要求
「User route 返回完整历史但**不泄露内部 assignment key**」。
用户侧要区分「只能有一个」的当前段 ⇒ 用 `isCurrent` 布尔即可，**不需要内部键**。

**为什么这不是替产品定 UI**：`EX-CHAT-01` 明文把用户端 UI 表现后置（§1.2），
本决策只固定**数据契约**（段、只读标记、发送目标），不固定视觉形态。

### D5 — Staff **只读**全部 assignment 会话；**不**新增「客服向 assignment 会话发送」

**决策**：Staff 的订单沟通详情页展示该订单的**全部**会话（客服会话 + 各 assignment 会话），
客服的回复框**仍然写客服会话**（行为与今天一致）。**不新增** Staff → assignment 会话的写入路径。

**理由**：

1. `cmd_p0-14.md` §八 对 Staff 的要求是「**可查看**订单全部 assignment conversation 历史」——
   **是「查看」，不是「发送」**。§五 的接口最小集也只列了**打手侧**。
2. `cmd_p0-14.md` §十三 没有把「客服向打手发消息」列入本轮范围。
3. **加它会引入一个未冻结的产品问题**：订单有 N 段 assignment 会话 + 1 段客服会话时，
   客服的「回复」该落到哪一段？（`用户权限表.md:417` 只说「与**当前**实际打手沟通」，
   没说历史段的打手可否被回复、也没说界面如何选择。）**这是一个会改变业务结果的问题，
   按 CLAUDE.md「TBD 禁止自行决定」不得由本轮裁定。**

⇒ 登记为 **R1（§六）**，供产品裁定；本轮**不实现**，也不做「半个」（例如只在界面上留一个写不进去的框）。

### D6 — 已读隔离：Companion 侧**挂到会话上**；Staff 侧**维持按 orderId**

**决策**：

| 角色 | 已读状态位置 | 键 |
|---|---|---|
| 用户 | `OrderConversationRecord.userLastReadAt` | **每个会话一份**（新增维度） |
| **打手** | `OrderConversationRecord.companionLastReadAt` | **每个会话一份** |
| 客服 | `staffReads`（**不变**） | `${orderId}:${staffId}`（**不变**） |

**为什么 Companion 侧必须挂到会话上**（C9）：`cmd_p0-14.md` §九 明文
「**禁止继续只按 `orderId` 保存 Companion 已读 cursor**」。
挂在会话上还**顺带解决**了三条要求：
- 「Companion A 的 unread 不影响 Companion B」——两个不同的会话记录；
- 「新 Companion 初始 unread 只针对自己的新 conversation」——新记录 `companionLastReadAt: null`；
- 「新 Companion **不继承**旧打手 unread/read cursor」（§2.4）——**没有任何字段可以从旧记录继承过来**。

**为什么 Staff 侧不改**：`cmd_p0-14.md` §九 只要求「Staff 现有 read 状态**不可被打手侧改坏**」。
两者是**不同的 store 字段**（`companionLastReadAt` vs `staffReads`），**结构上无法互相污染**。
把 Staff 已读也改成分会话级，会**改动客服工作台的未读口径**——那是本轮没有要求、
且会改变客服工作台业务结果的变更。⇒ **维持原样**（最小改动）。

### D7 — `OrderMessage` 增加 `conversationId`

**决策**：`OrderMessage` 新增 `conversationId: string`，`orderId` / `userId` **保留**。

**理由**：消息必须能定位到「哪一段会话」。若不落字段、靠时间区间推导，
则「同一时刻的两段会话」「时间倒挂」这类情形会让归属变得不确定——
而归属不确定的聊天记录**无法用于投诉调查**，恰恰是本轮要保证的能力。
`orderId` / `userId` 保留是因为既有仓储方法、客服列表与多处以它们过滤/分组，
删掉会把改动面扩大到与需求无关的地方。

> ⚠️ `OrderConversationRecord.orderId` 依然保留（会话仍属于一笔订单），
> 只是**不再是主键**。主键改为新字段 `id`（见 D8）。

### D8 — 会话主键：新增 `id`，`orderId` 降为普通字段

**决策**：`OrderConversationRecord` 新增 `id`：

```
客服会话：      id = orderId                 （沿用旧键，便于阅读与排障）
履约会话：      id = `${orderId}#s${assignmentSeq}`
```

**理由**：`orderId` 作为键无法表达「一单多会话」（D1 的直接后果）。
让客服会话沿用 `orderId` 作为 id，使**现存数据与调试直觉**都不必迁移；
履约会话的 id 天然带序，可读且与 D2 的键一致。

> ⚠️ 会话 id 是**内部标识**：用户端 DTO **不返回**它（D4）；打手端 DTO 也不需要（读路径按订单定位自己的当前会话）。

---

## §四、权限矩阵（本轮实现口径）

| # | 场景 | 期望 | 落点 |
|---|---|---|---|
| 1 | 未登录访问打手聊天接口 | **401** | `requireCompanion()` |
| 2 | 普通 User 访问 `/api/companion/**` | **403**（既有语义） | `requireCompanion()` |
| 3 | 非 Companion（无资格） | **403**（既有语义） | `requireCompanion()` |
| 4 | Companion 读**自己当前** assignment 会话 | ✅ 200 | 判据 ①②③ |
| 5 | Companion 读**自己已被 replace 的旧**会话 | **404** | 判据 ③ 失败 |
| 6 | `enabled=false` 的打手 | **403** | `requireCompanion()`（既有）+ `actualCompanionId` 已被 P0-11 清空 ⇒ 404 |
| 7 | 新 Companion 读旧 assignment 会话 | **404**（看不到旧消息） | 判据 ③ |
| 8 | 订单 owner 读全部历史 | ✅ 200（分段） | `order.userId === 会话用户` |
| 9 | 非 owner 读 | **404** | 归属校验（既有一致语义：不区分「不是你的」与「不存在」） |
| 10 | Staff 读全部历史 | ✅ 200 | `requireStaff()` |
| 11 | Admin | **不新增** Admin Chat 系统；沿用既有权限边界 | `cmd §八` |
| 12 | 写入与读取权限**同一判据** | ✅ | 读/写共用同一个判定函数 |
| 13 | 用户向**历史** assignment 会话发送 | **400/404**（只读） | `isReadOnly` 判定 |
| 14 | 用户向**当前** assignment 会话发送 | ✅ 200 | `target: "current"` |
| 15 | 旧 Companion 发送 | **404** | 与读取同一判据 |

---

## §五、接口与页面落点

> 📌 与 `cmd_p0-14.md` §五 一致：**优先延续现有风格、不复制整套 service/repository**。
> 具体的路由清单与页面清单在开发完成后回填 `03-delivery.md` §三，避免把计划写成事实。

**原则**（先写下来，实现按此执行）：

1. 会话/消息的**读写逻辑只有一份**：`lib/data/messageRepository.ts` + 一个共用的判定函数。
2. **权限放在角色入口层**（Route Handler 的 `requireXxx()`），**不复制** service/repository。
3. 新增的只有**打手侧**的入口（列表 / 读 / 发 / 标记已读），因为打手侧今天**完全没有**聊天面。
4. 用户侧与客服侧**不新增第二套**：用户侧扩展现有 `segments`，客服侧扩展现有详情页的展示。

---

## §六、登记项（超出台面明文 / 需产品复核）

### R1 — 客服「与当前实际打手沟通」的写入路径（**本轮未实现**）

- **依据**：`用户权限表.md:417`（客服 §7.1「可以」）明文列有「**与当前实际打手沟通**」。
- **现状**：今天打手端**没有任何聊天面**，因此这条权限**从来就无法履行**（不是本轮造成的缺口）。
- **本轮未实现的原因**：`cmd_p0-14.md` §五 / §八 对 Staff 只要求「**可查看**」；
  且「客服的回复应落到哪一段会话」是一个**未被任何权威文本冻结**的产品问题（D5）。
- **需要产品确认**：客服向打手发消息时，目标会话如何确定？（只允许当前段？允许历史段？界面上如何选？）
- ⚠️ **本轮不做「半个」**：不在界面上留一个写不进去的输入框，也不让客服的回复静默落到客服会话
  却让客服以为自己回复了打手。

### R2 — 用户端 UI 形态（**需求明文后置，本轮按 D4 实现，供验收复核**）

- **依据**：`EX-CHAT-01` 的「用户」一行：「仍可看到自己参与的聊天历史，**具体 UI 表现后续定**」。
- **本轮选择**：分段（客服会话 + 各 assignment 会话），历史段只读并明确标示。
- **需要验收确认**：该形态是否符合产品预期。

### R3 — 会话惰性创建的时点（**与 `cmd §4.1` 字面的取舍，见 D3**）

- **依据**：`cmd_p0-14.md` §4.1 字面为「该 assignment 尚无 conversation：创建一条」（读起来像接单即建）。
- **本轮选择**：首次访问时创建（assignment 身份由退出条数决定，不依赖这次创建）。
- **好处**：释放/接单事务**零改动**（C7/C8 风险净减少），且失效不可能被漏写。
- **需要验收确认**：是否接受「接单后、首次打开聊天前，该会话尚不存在」这一时序。

### R4 — 聊天 retention / 物理删除（**明确 `DEFER`**）

- **依据**：`BR-02` / `EX-CHAT-04` / `Q-EX-07` / `PR-06` 四处同时未决（§1.9）。
- **本轮处置**：**不实现任何删除路径**，不建 scheduler，不写「到期」字段。
- **不影响本轮**：`cmd §十五` 明文「聊天保留期未冻结**不阻塞本轮**，只需明确 DEFER」。

---

## §七、风险与缓解

| 风险 | 缓解 |
|---|---|
| 主键从 `orderId` 改为 `id` 会波及既有仓储方法与测试 | 客服会话 id **沿用 orderId**，使既有键值不变；改动集中在仓储内部与 DTO |
| 现有测试大量断言「一单一会话」 | 逐条核出受影响用例（见 `03-delivery.md`），**改断言而不放宽断言**；不放宽任何业务不变量 |
| 用户端 DTO 扩容可能泄露内部键 | 用户 DTO **不含** `assignmentKey` / `assignmentSeq` / `companionId`；按测试项 38 做 **DTO 精确边界**断言 |
| 「失效」若做成显式标记，将来会有人忘了写 | 用 D2 的**结构性失效**，从设计上消除这个失败模式 |
| 打手侧是全新面，最易漏权限 | 读/写**共用同一判据函数**；权限矩阵（§四）逐格落测试 |

---

## §八、附录：本轮的「不做」清单与边界的对应

| 不做 | 边界依据 |
|---|---|
| 完整 Assignment 聚合 | C2 / `database-schema.md` 第三部分 `TBD — DO NOT INVENT` |
| 改 `OrderStatus` | C4 |
| 第二套 Order / Auth / Companion / 聊天 系统 | C5 / C6 |
| 图片、附件、语音、WebSocket、实时推送、在线状态、typing、撤回、举报 | `cmd §六` / §十三 |
| 物理删除 / retention scheduler | C10（§1.9） |
| 真数据库 / 真 Scheduler | §十三 |
| 任何 Git 写操作 | §十八 |
| `P0-15` | §十三（本轮不开始） |

---

## §九、执行期决策（开发阶段新增，逐条可追溯到具体文件）

> 本节是**追加**的：§三 的 D1–D8 在设计阶段写成，下面的 E 系列是在把它们落到代码时
> 才出现、且**当时没有明文可依**的取舍。每条都写清楚「为什么这么选」与「改回去要动哪里」。

### E1 — 用户端发送区：**一个输入框 + 显式的「发给 客服 / 打手」选择器**（D4 的落地形态）

- **D4 说的是**「发送目标显式指定」，但没说界面上长什么样。两种做法都能满足字面：
  (a) 每个段落各自一个输入框；(b) 一个输入框 + 一个目标选择器。
- **选 (b)**，两条理由都不是美观问题：
  1. **请求体里根本没有「段落」这个可寻址的东西**（`target` 只有 `service` / `current`）。
     做成分段输入框，界面就在暗示「可以写给某一段历史」，而接口**从结构上**不允许——
     用户会在一个看起来能用的输入框里打完一段话，再收到一个 400。
  2. **默认值的方向**：单个输入框必须有一个默认目标，而默认值是**安全决策**
     （见 `lib/constants/service.ts` 的 `DEFAULT_MESSAGE_TARGET` 注释：默认投客服，
     出错时消息落在用户与服务人员之间）。分段输入框没有默认值这个问题，
     也就等于把这个决策藏进了「用户先点哪个框」里。
- **选择器只在真的有两个去处时出现**（有当前履约段）。只有客服会话时多一个按钮，
  只会让人以为还有别的收件人。
- **目标失效时回落客服并提示**：页面停留期间护航被换下 → `current` 不再是合法目标，
  此时**不静默地继续用 `current`**（那会把消息发进一段已结束的会话），也不静默改目标
  （那会让用户以为发给了打手）。回落规则写在组件里（`effectiveTarget`）。
- **落点**：`components/service/OrderChat.tsx`。

### E2 — 用户端的角色词只有一个来源，页面里**不许写死**

- **发现**：分段标题由服务端按端生成（用户端「打手沟通」、客服端「护航沟通」），
  而发送目标选择器一度把「护航」**硬编码在组件里**——同一个屏幕上，
  标题写着「打手沟通」、上面的按钮写着「护航」，说的是同一个人。
- **处理**：选择器的两个词改从 `MESSAGE_ROLE_LABELS` 取（那张表就是用户端角色表）。
  这样改一处两边一起改，而不是靠 code review 记得住。
- **加了一条门禁**（`tests/assignmentConversations.test.mjs` 末条）：三张角色表的
  `companion` 分别是「打手」/「护航」/「护航」，且用户端聊天组件与客服会话组件
  **去掉注释后不得出现任何一个角色词**。这不是文案断言（那种断言改一个字就红），
  而是钉住「词的来源」。
- ⚠️ **一处已知的、本轮不动的偏差**：`app/(mobile)/orders/[id]/page.tsx` 的
  「**护航收益**」是用户端出现「护航」的唯一处。它是 P0-3 金额域的一部分，
  而那一整块（含 `companionBaseIncome`）是**已知的上线前技术债**
  （用户端不应看到分账明细，见 `companion-rate-bp-browser-exposure`），
  三份既有测试断言着这句文案。整块移除时它自然消失，**本轮不单独改词**——
  改了会让那三份测试与「分账块要整体下线」这件事脱钩。

### E3 — `segment` 带 `isCurrent`，但**不带**段的护航展示名（用户端）

- 用户端的 `OrderConversationSegment` 只有 `index / kind / title / isCurrent / isReadOnly / messages`。
- **不给用户端 `companionId`**：那是内部标识，`cmd §七` 明文不展示。
- **也不给「这一段的打手昵称」**：消息气泡上已经有**发送时的快照**
  （`senderName`，见 `sendMessageForCompanion` 的注释），而段级的名字在
  「那一段只有客服说话、打手一句话没说」时会指向一个**从未在这段里出现过的人**。
  历史段显示「当时是谁说的」比显示「这段归属过谁」更准确，也更少一个字段。
- **客服端相反**：`StaffConversationSegment` **必须**带 `companionId` + `companionName`
  ——「这段是谁在服务」正是售后调查要回答的问题。两者**刻意不是同一个类型**。

### E4 — 两处「显式清单」门禁随本轮扩充（**它们红了才是对的**）

本轮新增了打手端聊天页与聊天接口，两份源码级清单门禁因此各红一次，均已按设计扩充：

| 门禁 | 文件 | 变化 |
|---|---|---|
| 工作台页面集合 | `tests/companionConsoleNav.test.mjs` | 6 → 8（新增 `chats/page.tsx`、`chats/[orderId]/page.tsx`） |
| 打手资格调用点清单 | `tests/companionAccess.test.mjs` | 6 → 8（同上两页） |
| 打手接口清单 | `tests/companion.test.mjs` | 8 → 12（新增 `conversations` 四件套），`api-contract.md` §8 由 5 条改正为 12 条 |

⚠️ 第一、二条是**两条独立的清单**（一个查页面文件、一个查资格判定调用点），
两者都要改。只改一个会留下另一种漏检：页面在清单里但没走缓存的资格判定，或者反过来。

### E5 — 测试里发现并绕开的一个真实陷阱：**同毫秒写入的顺序不确定**

- **现象**：消息与退出记录都按 `createdAt` 升序排，**时间相同时用随机 uuid 兜底**
  （`readMessagesOfConversation`、`listCompanionReleasesByOrderId`）。测试里连续两次写入
  落在同一毫秒，于是「谁在前」由随机 id 决定。
- **后果**：任何对**同毫秒两条记录**做顺序断言的用例都会**偶发**失败——
  这不是被测代码的缺陷，是排序契约里那句「时间相同时用 id 兜底」的必然结果。
- **处理**：在真正关心内容而不关心次序的地方改用**多重集比较**（`bodiesOf()` 排序后比），
  并在注释里写明原因；**关心次序**的地方改用具**全序**的键
  （段落内 `assignmentSeq`，同一订单内 `compareConversationsWithinOrder` 是严格的）。
- ⚠️ **没有放宽任何断言**：每一条被改写的断言都换成了「同一件事的另一种等价表述」，
  不是删掉或弱化。新写的 HTTP 用例同样避开这一点（跨段取消息按**段序**而不是时间序）。

### E6 — 打手端聊天列表的「我 / 用户」称呼：与用户端会话列表**同一处理**

- 列表行只有 `lastMessageRole`（没有发送者 id），因此「是不是我发的」由
  `role === "companion"` 近似。这与**用户端会话列表**（`components/service/ServiceTabs.tsx`
  的 `messageSenderLabel(role, role === "user")`）是同一个做法。
- **它今天是等价的**：这一段会话只有当前这位打手与下单用户能写
  （`sendMessageForCompanion` 先过 `canCompanionAccessConversation`），因此
  `companion` 角色必定是自己。换人之后旧打手的消息在**另一段**会话里，读不到。
- ⚠️ **但这是近似，不是判据**。`lib/constants/conversations.ts` 的
  `companionMessageSenderLabel` 明文要求 `isSelf` 由 **id** 判定，详情 DTO
  （`CompanionChatMessage.isSelf` / `senderLabel`）正是那样做的。
  将来若列表 DTO 要显示更细的身份（例如同段出现多名护航），**必须先给它发送者 id**，
  不能继续用角色近似。**本轮记为 NOTE，不扩 DTO**——扩了就会与用户端列表分叉。

---

## §十、reviewer 结论（2026-09-27）与整改

本轮改动集合交给**只读** reviewer-agent（对照 `docs/01-requirements/` 与
`architecture-rules.md`，检查业务规则 / 状态机 / 金额 / 权限 / DTO 隐私 / 幂等并发 / 测试缺口）。

### 10.1 结论读数

**0 BLOCKER · 0 MAJOR · 1 MINOR · 2 NOTE。**

这**不等于**「审查没看出问题」：审查逐条核实了 8 个指定风险点并全部通过（见 10.4）。
六条核心承诺的判定如下：

| 承诺 | 判定依据（审查自己复核的，不是读注释） |
|---|---|
| 当前实际打手进聊天 | `resolveChatContextWithConversation` 读即建段；列表行来自 `actualCompanionId` |
| 每次换人独立会话 | `assignmentKey = ${orderId}#s${releaseCount}`，创建时冻结、每次请求现算「是不是当前」 |
| 换人 / 回池 / 封禁即失权 | 判据①②③中①③同时断；`releaseCurrentAssignment` **零改动**，失效靠 release 历史条数递增，**结构上不可被漏写** |
| 新打手看不到旧聊天 | ②挡会话归属、③挡 A→B→A 复用旧段 |
| 用户看完整历史 | `buildConversationSegments` + 扁平 `messages`，旧段标只读 |
| 客服看全部历史 | `toStaffConversationSegments` 带 `companionId` / `companionName`，已读游标按段隔离 |

### 10.2 MINOR-1（**已修**）：三处「唯一转换点」是不实陈述

- **问题**：`lib/constants/conversations.ts` 的 `toMessageView()` 注释、
  `docs/02-tech-design/api-contract.md` §2.5 表格、以及
  `tests/assignmentConversations.test.mjs` 里那条用例的**标题**，都声称
  「这是全仓**唯一**的消息 DTO 转换点，用户端与打手端都调它」。
  事实上三端**各有**一个转换点：
  用户端 `toMessageView()`（`lib/constants/conversations.ts:255`，被
  `lib/constants/conversations.ts:330` 与 `lib/services/conversations.ts:327` 调用）·
  打手端 `toCompanionChatMessage()`（`lib/services/companionConversations.ts:157`，模块私有）·
  客服端 `toStaffConversationMessage()`（`lib/constants/staff.ts:504`）。
- **为什么这是问题（不是洁癖）**：「唯一转换点」是本项目的**架构不变量话术**
  （`tests/staffReleaseHistory.test.mjs` 甚至用「数出现次数」来强制单实现）。
  在一个**不成立**的地方使用它，会让下一位开发者以为「改一处三端一起变」，
  而实际上三端 DTO 形状不同、各自独立——这正是「一端脱敏了、另一端忘了」得以发生的心态。
  **安全目标本身是达成的**（三处都是逐字段显式挑，审查已核实），错的是那句话。
- **整改**（4 个文件，**断言零改动**）：
  1. `lib/constants/conversations.ts` — 改写为「这是**用户端**那一个；三端故意不共用函数；
     真正的不变量是**每条出站路径都自己显式挑字段**」；
  2. `lib/types/message.ts` — `conversationId` 的注释从「对外一律用 `OrderMessageView`」
     改为分别点明三端各自的 DTO；
  3. `docs/02-tech-design/api-contract.md` §2.5 — 改为「三端各有一个显式转换点，
     **没有**「改一处三端一起变」的兜底」；
  4. `tests/assignmentConversations.test.mjs` — **只改用例标题**，
     并在其上写明「原先写『唯一的转换点』是不实陈述，已改正——断言未动」。

### 10.3 NOTE 登记（**不修，本轮无动作**）

- **NOTE-A（转 TBD，见 10.5）**：全额退款后打手仍可访问该订单聊天。
- **NOTE-B**：`app/companion/(console)/chats/page.tsx` 的列表行用
  `companionMessageSenderLabel(item.lastMessageRole, item.lastMessageRole === "companion")`
  以**角色**近似 `isSelf`。这与 `lib/constants/conversations.ts` 里
  `companionMessageSenderLabel` 的注释、以及 `companionConversations.ts` 的详情 DTO
  （由 id 判 `isSelf`）**方向相反**。**今天是安全的**（一段履约会话里只有当前这一位打手，
  `lastMessageRole === "companion"` ⟺ 是自己），且与用户端会话列表
  （`components/service/ServiceTabs.tsx:315`）做法一致——见本文档 **E6**。
  审查的判断与本轮 E6 相同：**记为 NOTE，不扩 DTO**。

### 10.4 审查明确核实**无问题**的维度（列出以免被读成「没看」）

- **`assignmentKey` 派生的结构性**：`releaseCurrentAssignment` 一处定义 +
  4 个调用点（`cancelAcceptedOrder` · `releaseOrderByStaff` ·
  `replaceOrderCompanionByStaff` · `releaseOrdersForCompanion`）**全部**追加 release 记录；
  `resolveAssignmentSeq = releaseCount`；换人 / 回池 / **停用**（`setCompanionFlags` 走
  `releaseOrdersForCompanion`）都会当场递增序号。**P0-14 对该文件零改动**（已用 diff 确认）。
  ⇒ **不存在「某条释放路径忘了失效」**。
- **A→B→A**：s0 / s1 / s2 三个不同键；断言 `seq=[0,1,2]`、`companionId=[A,B,A]`、会话 id 互不相同
  ⇒ 第三个 assignment **是新建**，不是复用 s0。
- **读取 / 写入 / 已读同一条判据**：四个打手路由（list / detail / send / read）**全部**
  经 `resolveChatContext` / `resolveChatContextWithConversation` → `canCompanionAccessConversation` ①②③。
  `markCompanionChatRead` 用**不建会话**的那个变体，未命中返回 `false` → 404，
  与「已读是记账，不该凭它建出一段会话」一致。
- **封禁 / 移除 / 暂停**：`enabled=false` → `requireCompanion` 403 **且** P0-11 已释放（双保险）；
  `removedAt` → `findCompanionByUser` 排除 → not-a-companion 403
  （`removeCompanion` 不释放订单是 P0-11 D10 的既有取舍，聊天由守卫挡住，**不构成泄漏**）；
  `available=false` **正确仍放行**（暂停接单 ≠ 失去已接订单，符合 `EX-SERVICE-05`）。
- **DTO 隐私**：用户端 9 字段（无 `conversationId` / `companionId` / `assignmentKey`）·
  打手端 7 字段（无内部键）· 客服端分段带 `companionId` / `companionName`（**刻意**的调查视角）。
  公共池 DTO 无 `gameAccountId` / `remark` / `userId`；客服聊天详情无
  `gameAccountId` / `remark` / `clubNetIncome`
  （**双重验证**：HTTP 32 的 `raw.includes(...)` 全 false ＋ `staffReleaseHistory.test.mjs:876` 的递归键检查）。
- **测试不是恒真**：`DTO 38` 的 `keysOf + assert.deepEqual` 会因键集**增删**而失败；
  「`toMessageView` 去掉 `conversationId` 恰好等于内部记录」那条**先断言内部记录确有
  `conversationId`**，否则自己会红——不是自证式断言。
- **权限矩阵无空格**：`cmd_p0-14.md` §十四 **38 项全部有落点**；§十 12 项权限矩阵逐条对应，
  401 / 403 / 404 / 正常四种结果都覆盖（见 `03-delivery.md` §3.3 的逐项对照表）。
- **回归**：`companionOrderTransaction.ts` / `adminRefundTransaction.ts` **零改动**；
  旧 `findConversation` 已无残留调用；`messageRepository` 重写与既有
  `staffReleaseHistory.test.mjs`（读会话详情）兼容。
- **清单门禁**：`companion.test.mjs` 路由清单 8 → 12 · `companionConsoleNav.test.mjs` 页面清单 6 → 8 ·
  `companionAccess.test.mjs` 调用点清单 6 → 8 · `api-contract.md` §8 表 5 → 12 条、
  route 总数 131 → 135 与「companion 12」一致。
- **UI**：三端页面无写死角色词（源码结构门禁钉住「打手 / 护航」零出现）；
  `CompanionChatConsole.tsx` 不 import `lib/data`、走 `companionHttp`；
  `OrderChat.tsx` 的 `effectiveTarget` 在护航被换下时**回落到 `service`**，不静默继续发 `current`。

### 10.5 🆕 NOTE-A **升级为登记 TBD**：全额退款后打手仍可访问该订单聊天

**这是本轮新发现、需要产品裁定的边界。代码保持现状，未自行决定。**

- **当前事实**：`lib/data/adminRefundTransaction.ts` 明文「不清 `actualCompanionId`」
  （P0-12 的硬约束，`applyOrderRefund` 不碰它）；而 `listCompanionChats` 走
  `queryOrdersByCompanion`（**不过滤订单状态**），`resolveChatContext` 也**不查**
  `order.status`。⇒ 订单累计退满变成 `refunded` 后，**打手聊天列表仍显示这一单，
  打手仍可读 / 写 / 发消息**。
- **为什么本轮不判为缺陷**：没有任何**已确认**的规则说退款单必须关聊天。
  `BF-23`（`业务流程表.md:769`）把打手聊天范围定为「当前 assignment」，但
  **未定义**「订单退款后，该 assignment 是否还算『当前』」。
- **四处未决问题问的都不是这件事**：`BR-02`（`业务流程表.md:803-805`）·
  `Q-EX-07` · `EX-CHAT-04` · `PR-06` 标记的都是 ❓，且它们问的是**「保留多久 / 要不要删」**，
  不是**「还能不能访问」**。
- **需要产品回答**：是否按订单状态收窄打手聊天入口（例如 `refunded` 不出现在聊天列表、
  不可读不可写）？**在得到裁定前，代码保持现状。**

### 10.6 与 R1–R4 的关系

§六 的四项登记项（R1 客服向 assignment 会话写入 / R2 用户端 UI 形态 / R3 惰性创建时点 /
R4 retention `DEFER`）**均未因审查而改变**。10.5 是**新增**的第五项登记，
编号上归入 §六 的 R 系列——为避免与已写好的 R1–R4 交叉引用错位，
它在本文档内以 **NOTE-A** 记录，并在 `03-delivery.md` §5.2 与 `04-acceptance.md` §五
以 **TBD-P0-14-1** 重复登记。

---

## §十一、产品裁定 `TBD-P0-14-1` 已落地（2026-09-27，**验收前 fix**）

> **状态：`TBD-P0-14-1` 已由产品负责人正式裁定并实现，不再是未决项。**
> 本节是**追加**记录，§十 及其 10.5 的原文一字未改——它们如实描述了裁定之前的认识。

### 11.1 裁定原文（产品负责人，2026-09-27）

> 订单全额退款后，当前 assignment 立即结束；对应聊天历史保留，但进入只读状态。

配套规则七条（本节逐条对照落地）：

1. 全额退款后：User 可继续查看该 assignment 历史聊天；原 Companion 可继续查看**自己**
   该 assignment 的历史聊天；User **不可**继续向该 assignment 发送消息；Companion **不可**发送；
   Staff / Admin 按既有调查权限继续可读。
2. `actualCompanionId` 可继续保留为历史接单事实，但**不得再作为「当前仍可聊天」的充分条件**。
3. 聊天**写**权限必须**额外**要求：assignment 仍为当前有效履约；Order 尚未进入 `refunded`；
   其它既有 Companion 权限条件继续成立。
4. 不删除聊天，不改变 retention 规则。
5. **partial refund 不结束 assignment**；只有**累计全额退款 / Order = `refunded`** 才进入只读。
6. 补测试至少覆盖六项（见 11.5）。
7. 这是 `P0-14` 验收前 fix：**不新开 Round，不开始 `P0-15`**。

### 11.2 落点：单一判据 `isOrderChatClosed(orderStatus)`

`lib/constants/conversations.ts` 新增：

```ts
export function isOrderChatClosed(orderStatus: OrderStatus): boolean {
  return orderStatus === "refunded";
}
```

**为什么判据读「订单状态」而不是清 `actualCompanionId`**：`applyOrderRefund`
明文「不清 `actualCompanionId`」（P0-12 批次硬约束「不得为代码统一抹平」），
而裁定第 2 条要的恰恰是「这个字段留着、但它不再是充要条件」。
清字段会把「历史接单事实」一并抹掉，用户与客服之后就查不出当初是谁接的单。

**为什么只是 `refunded`、不是 `refundedAmount > 0`**：这两件事在**部分退款**上分岔。
`applyOrderRefund` 只在**累计退满**时才把 `status` 写成 `refunded`，部分退款不动 `status`；
而 `refundedAmount > 0` 在部分退款时**同样成立**。用金额判会把
「退了一半、服务还在继续」的单子当场锁死——这正是裁定第 5 条禁止的。
`paid` / `accepted` / `serving` / `completed` 四档**一律不关**：
`completed` 尤其不能顺手关，已完结但未退款时售后 / 评价 / 投诉都还要在这一段里说话。

**追加的既有事实（决定了本 fix 的规模）**：`applyOrderRefund` 既不清
`actualCompanionId`，也**不追加退出记录**（`CompanionReleaseRecord`）——退款不是「换人」。
因此退款后 `assignmentKey` **不变**，`resolveChatContext` 的三条腿（①订单归属 ②会话归属
③会话键 === 当前键）**全部仍然成立**。⇒ **读路径一个字都不用改**，
本次 fix 只做两件事：**加两个写闸** + **给 DTO 补 `isReadOnly`**。

### 11.3 写闸落在哪、为什么是这个顺序

| 端 | 位置 | 顺序 | 拒绝方式 |
|---|---|---|---|
| 用户端 | `lib/services/conversations.ts` `sendMessageForUser` 的 `target === "current"` 分支 | **排在 `assignmentKey` 判定之前** | `BAD_REQUEST` → **400**，文案 `MESSAGE_ORDER_REFUNDED_MESSAGE` |
| 打手端 | `lib/services/companionConversations.ts` `sendMessageForCompanion` | **排在归属 / 段判定之后** | `BAD_REQUEST` → **400**，文案 `COMPANION_ORDER_REFUNDED_MESSAGE` |

两端顺序**不同**，各自的理由：

- **用户端为什么要提前**：退款**不会**清 `actualCompanionId`、也**不**追加释放记录，
  所以退款后 `assignmentKey` 仍然存在。把退款闸放在 `assignmentKey` 之后，
  对「已退款且有履约人」的单子永远不会触发——它只会被读到，不会被拦下，**是个死闸**。
  同时「这一单退掉了」比「你现在没有打手」更接近用户想知道的答案。
- **打手端为什么必须在后**：先确认「这段聊天确实是你的」，再告诉他「你的这段不能写了」。
  反过来会把「不是你的订单」也答成「已退款」——于是拿别人的订单 id 就能问出
  那张单退没退款（`api-contract.md` §2.9「不能当存在性预言机」）。
  这一条与 `cmd_p0-14.md` §七 的既有要求一致：三种「查不到」必须对外同形。

**为什么是 400 而不是 404**（两端一致）：这段会话确实存在、也确实属于他，
只是不能再写。回 404 会让聊天页把整段历史当成「不存在」而藏起来，
与裁定第 1 条「保留可查」直接冲突。这与「被换下 = 404」不矛盾：
**被换下是「这段聊天不再属于你」，已退款是「属于你、但不能写了」**——两件不同的事，
用两个不同的码回答，恰恰是让客户端分得清。

### 11.4 DTO 与界面

| 位置 | 新增 | 说明 |
|---|---|---|
| `OrderConversationSegment.isReadOnly`（用户端） | 计算式改为 `kind === "assignment" && (!isCurrent \|\| chatClosed)` | **客服会话永远可写**：裁定只谈 assignment，而退款之后恰恰是用户最需要问客服的时候 |
| `CompanionChatListItem.isReadOnly` / `CompanionChatDetail.isReadOnly` | 由服务端按 `isOrderChatClosed(order.status)` 算出 | 页面**不自己**拿 `orderStatus === "refunded"` 再判一次（源码结构门禁钉住） |
| `CompanionChatDetail.notice` | 只读时换成 `COMPANION_CHAT_REFUNDED_NOTICE` | **替换**而不是叠加：原来的「换人之后看不到」在这张单上既不是原因也不是答案 |
| `CONVERSATION_SEGMENT_REFUNDED_NOTICE` | 新增 | 与 `CONVERSATION_SEGMENT_HISTORY_NOTICE` **必须分开**：页面用 `isReadOnly && isCurrent` 二选一。合并成一句，用户在一张刚退款的订单上会看到「这段打手沟通已经结束」并去问客服「谁把我换了」 |
| `CompanionChatConsole` | `isReadOnly` prop，只读时**整块替换**输入区为一行说明 | 不用 `disabled` 输入框：灰掉的框会让人反复去点，而这里是「往后都不能发了」 |
| 打手端聊天列表 | 「已退款 · 只读」角标 | 标出来而不是把该行拿掉——裁定要记录**可查**，藏掉入口等于查不到 |

**`isCurrent` 与 `isReadOnly` 的组合因此变成三种**（`lib/types/message.ts` 有对照表）：

| 场景 | `isCurrent` | `isReadOnly` |
|---|---|---|
| 客服会话 | `false` | `false`（永远可写） |
| 被换下的历史履约段 | `false` | `true` |
| **当前段，但订单已全额退款** | **`true`** | **`true`** |

第三行是 P0-14 交付时**不存在**的组合。因此配送时 `OrderConversationSegment.isCurrent`
的文档（原文称「今天只有履约会话会出现 `isCurrent: false`」）已被裁定**反转**，
本次一并改正——**这是文档与实现一起变的，不是只改注释**。

### 11.5 裁定第 6 条要求的六项测试，逐条落点

| 裁定要求 | 落点 | HTTP 层 |
|---|---|---|
| accepted direct full refund 后 Companion 仍可读历史但不可发 | `只读 2` | 第五条第一组 |
| User 仍可读但不可发 | `只读 2` | 第五条第二组 |
| serving / completed full refund 同样只读 | `只读 4` / `只读 5` | — |
| partial refund 不影响当前聊天写权限 | `只读 6` | — |
| Staff 调查读取不受影响 | `只读 7` | 第五条第二组 |
| `actualCompanionId` 保留不导致写权限误放行 | `只读 3`（**先**断言字段仍等于本人，**再**断言发不出去） | — |

另加 `只读 1`（纯函数：只有 `refunded` 触发）与 `只读 8`（源码结构门禁：
两个页面与组件里不得出现写死的 `"refunded"`，只读判据只在服务端一处）。

**`只读 6` 是「判据不是金额」的唯一正向用例**，因此不能被简化掉：
它跑的是**真实的售后链路**（用户申请 → 管理员按 50% 通过），
先自检 `refundedAmount > 0` 且 `status !== "refunded"`，再断言这一段**照样可写**。

### 11.6 `TBD-P0-14-1` 的关闭与**未**关闭

- **已关闭**：「全额退款后能不能继续聊天」——裁定给出「只读」，本节 11.2–11.5 是落地。
- **仍未关闭**：**R4 / 聊天 retention 与物理删除**。裁定第 4 条明文
  「不删除聊天，不改变 retention 规则」⇒ 与 §六 R4、`EX-CHAT-04` / `PR-06` / `BR-02` /
  `Q-EX-07` 一致地**继续 `DEFER`**。本次 fix **没有**因此新增任何删除 / 归档 / 过期逻辑，
  也**没有**回答「保留多久」。
- §六 R1–R3 三项**未受影响**，仍待追认。

### 11.7 落地后被审查发现并修掉的两处（**追加，不改上文**）

只读 reviewer-agent 对本次 fix 做了第二轮审查，结论 **0 BLOCKER · 0 MAJOR · 0 MINOR · 6 NOTE**
（`03-delivery.md` §6.4）。其中**两条真的改了代码**：

1. **NOTE-4：被拒绝的发送留下了副作用**（reviewer 发现，我同时独立发现）。
   `sendMessageForCompanion` 原先「先确保会话存在（会惰性建）→ 再判退款 → 再写」，
   于是**一次被 400 拒绝的发送**在「退款 + 打手从未打开过聊天页」的路径上会**真的建出一段空会话**。
   本项目对状态闸的既有约定是**零副作用**（P0-13 `D22`），因此这是缺陷。
   改为先 `resolveChatContext`（**不建会话**）过闸、过了才建；归属判定仍在闸**之前**，
   §11.3 的理由不变。**代价是多一个分支，因此补了三条测试**（`03-delivery.md` §10.6），
   两侧都做了受控 mutation 确认会红。
   ⇒ **§11.3 表格里「打手端」那一行的位置描述仍然成立**（相对归属判定仍是「之后」），
   但它相对**建会话**的位置变了：现在是「之前」。这一条以本节为准。

2. **NOTE-6：注释与字符串不符**。`COMPANION_ORDER_REFUNDED_MESSAGE` 的注释声称
   「用『护航』而不是『打手』」，而该字符串**不含任何角色词**。已改为
   「**刻意不含角色词**，不要『统一措辞』往里加一个」（读它的人就是本人，主语天然是「你」）。

另有一条 **NOTE-5 只做了一半**（抽常量并加门禁，措辞分档不做），理由见 `03-delivery.md` §10.5。

**一处自发现的文案缺陷**：页顶 `COMPANION_CHAT_REFUNDED_NOTICE` 与底栏
`COMPANION_CHAT_READONLY_FOOTER` 原本是**完全相同的字符串**，而两者渲染在**同一块屏幕**上
（§11.4 那张表把两条都列了，但当时没注意到它们同文）。已改成两句分工不同的话：
页顶答「发生了什么、记录还在不在」，底栏答「这里为什么没有输入框」。

**§11.4 表格里的其余各行不受影响。**

---

## §十二、第三轮只读审查（对整改增量）与 NOTE 处置（2026-09-27 收尾）

第一轮审查之后代码又改了四处（写闸零副作用 / 抽入口文案常量 / 两条文案区分 /
NOTE-6 注释），因此在**最终树**上重开了一次**只读**审查，逐项核 A–E，结论
**0 BLOCKER · 0 MAJOR · 0 MINOR · 5 NOTE**（全文见 `03-delivery.md` §6.5）。

该 agent 独立复核了本仓库最要紧的那条性质——**反存在性预言机**：
`resolveChatContext` 对「订单不存在 / 不是本人 / 算不出段 / 会话归他人」四种失败
**统一返回 `null`**，调用方一律 404，退款闸（400）只在归属成立**之后**才可能到达；
并确认幂等键仍只被 `createMessage` 消费一次、被拒路径在它之前抛错（**键不被消耗**）。

### 12.1 第三轮 5 条 NOTE 的处置

| # | NOTE | 处置 |
|---|---|---|
| 1 | 源码探针可被字符串拼接绕过 | **不修，登记**——本仓库测试不剥 JSX，组件渲染无自动化断言，结构断言是这一约束下的上限 |
| 2 | 只读 10 只防「同文」、不防「放错位置」 | **转人工验收项**：`04-acceptance.md` §K 的 K4 已写明「两句话各自在正确位置且不同文，同文即 FAIL」，并注明只能靠人眼看 |
| 3 | 「退款 + 非本人 → 404 而非 400」无直接用例 | ✅ **已补**：`tests/assignmentConversations.test.mjs` 新增「只读 11」，**受控 mutation 红-绿**（把退款闸提到归属判定之前 ⇒ 38 条里**只有它**红） |
| 4 | §10.1 表格仍写 footer「打手端说『护航』」 | ✅ **已改**：footer 终稿**不含角色词**；说「护航」的是**页顶**那条 |
| 5 | `beforeEach` 未重置 `refund` / `earning` | ✅ **已修 + 实测复现**：补两条 `resetMockStore`；并用一次性探针复现了「同进程重跑因『已通过』再红一次」的隐患，实验后探针已删除 |

### 12.2 §11.3 「两端闸序不同」这一条的补充

§11.3 记的是**打手端退款闸排在归属判定之后**。第三轮的 NOTE-3 指出：
这条顺序的性质**原先没有用例守着**——闸若被提到归属判定之前，功能测试会**全绿**，
只有「退款单 + 非本人发送」这一格会红。**只读 11** 现在就是那一格。

⚠️ 它守的不是「闸在不在」，而是**闸的位置**；因此它对本轮以后的任何一次
「顺手把两个判断调个顺序」都是红的。§11.3 的口径本身**未变**。

---

## §十三、产品追认 R1–R4（2026-09-27，**登记，不重开开发**）

P0-14 交付时留了 4 项待追认（`04-acceptance.md` §五）。产品负责人现已逐条追认，
本节把它们**登记为已确认口径**。⚠️ **本轮不因此重开开发**：逐条比对下来，
四条**都已由现有实现满足**（R4 有一处措辞差异，见 13.4），因此**零代码改动**。

### 13.1 R1 —— 客服对 assignment 会话**只读**

> **追认**：Staff 对 assignment 历史聊天只读。只限制 Staff 对「履约 assignment 会话」的写入；
> 原有 Staff ↔ User 客服会话继续按既有规则运行，不受影响；不创建 Staff ↔ Companion 新直连聊天。

**实现已满足，证据**（`lib/services/staffConversations.ts`）：

- 客服的**唯一**写入路径 `sendMessageForStaff` **显式挑 `service` 那一段**
  （`conversations.find((c) => c.kind === "service")`），并在注释里写明为什么不能拿
  「这一单的会话」——P0-14 之后那个说法不再唯一，写错就成「用户与打手的私聊里插进一条客服的话」。
- 只有履约会话、客服会话尚未建立时，它**补建客服会话**再写，**不往履约会话里写**。
- 客服读全部段落走 `toStaffConversationSegments`，那条路径**没有**对应的写入口。
- 全仓**不存在** Staff ↔ Companion 的通道：消息的 `senderRole` 只有
  `user` / `companion` / `customer_service` 三种，且客服发出的恒为 `customer_service`
  并只落在 `service` 会话里。

### 13.2 R2 —— 用户端按「当前 / 历史」分段展示

> **追认**：用户端多 assignment 聊天采用「当前服务会话 / 历史服务会话」分段展示；
> 当前段可写，历史段只读。

**实现已满足，证据**（`lib/constants/conversations.ts`）：

- `buildConversationSegments()` 把订单的全部会话排成段（客服段在前，其后按履约序号），
  每段带 `isCurrent` 与 `isReadOnly`；
- 判据：`isReadOnly = kind === "assignment" && (!isCurrent || isOrderChatClosed(orderStatus))`
  ——**当前段可写、历史段只读**，且全额退款后连当前段也一起只读（§十一的裁定）；
- 客服段**永远可写**（裁定的原文只说 assignment，退款之后恰恰最需要找客服）。

⚠️ 交付时已就用户端形态做过一次产品裁定（`04-acceptance.md` §五 原 R2）：
**一个输入框 + 显式的「发给 客服 / 打手」选择器**，而不是每段各一个输入框。
该形态与本节的分段展示**不冲突**——分段是「看」，选择器是「发给谁」。
`components/service/OrderChat.tsx` 在没有可写的履约段时会**收起**「打手」这个选项，
不让用户选到一个注定被拒的目标。

### 13.3 R3 —— 允许 assignment conversation 惰性物化

> **追认**：不要求 assignment 创建时立即制造空 conversation；第一次合法访问 / 合法发送等
> 真正需要 conversation 时可以创建；**越权、退款只读发送、旧打手发送等失败请求不得产生
> 空 conversation**；惰性创建不能改变 assignmentKey / 权限语义。

**实现已满足，且这正是交付前那一处**真缺陷**的整改口径**：

- 创建只发生在 `ensureCurrentAssignmentConversation()` 一处，由**合法**的读或写触发；
- ⚠️ **失败请求零副作用**：`sendMessageForCompanion` 用**不建会话**的 `resolveChatContext`
  先过闸（归属 → 段 → 退款），**闸过了才建**；被 400 / 404 拒绝的发送不会留下一段空会话。
  这与 P0-13 `D22`「状态闸 400 且零副作用」是同一条既有约定，用例「只读 9」钉住它，
  并有**反向对照**（读路径**应当**建，以证明断言不是恒真）。
- 用户端同理：`sendMessageForUser` 的 `current` 分支把退款闸与「没有当前履约」两道
  判据都排在 `ensureCurrentAssignmentConversation` **之前**。
- **越权**（不是本人 / 订单不存在 / 段号对不上）在 `resolveChatContext` 里一律返回 `null`
  → 404，**根本不进创建分支**；用例「只读 11」钉住「退款单 + 非本人发送仍是 404」，
  并同时断言其**零副作用**（不建段、不落消息）。
- 惰性创建**不改变** `assignmentKey`：键由 P0-11 的 append-only 退出历史条数推导，
  每次请求现算，与会话是否存在无关；三条腿判据（订单归属 / 会话归属 / 键等于当前键）
  在会话**存在之后**再判一次，因此「建出来的当然是我的」这句话不成立时也会被挡住。

⚠️ **一条边界如实记录**：用户端的 `service` 分支会先 `ensureConversation` 再写。
那一步创建的是**客服会话**，而触发它的是一次**合法**发送（订单归属刚刚验过），
因此不落在 R3 点名的三类失败里。建完之后 `createMessage` 返回 `null`（→ 404）**只可能**
是存储被 `resetMockStore` 换掉，不是用户可达路径。

### 13.4 R4 —— 用户端历史段**不强制**显示打手展示名

> **追认**：用户端历史 assignment 分段不强制显示 Companion 姓名，中性即可；
> Staff 调查视角仍可看到 `companionId` / `companionName`。

**实现已满足，证据**：

- 用户端分段 DTO（`OrderConversationSegment`）**没有**打手的 id 或姓名，
  只有 `index` / `kind` / `title` / `isCurrent` / `isReadOnly` / `messages`；
  用例「DTO 38」精确断言过键集合，多一个内部键就红。
- 客服端的 `toStaffConversationSegments` **带** `companionId` / `companionName`，
  只在客服工作台可见。

⚠️ **一处措辞差异，记录在案、不要求改动**：用户端标题当前是
「**打手沟通**」/「**打手沟通（历史）**」，而不是追认文字里那对
「当前服务会话 / 历史服务会话」。两者**都不含姓名**，R4 的实质要求（不强制显示姓名）成立；
差异只在措辞。保留现措辞的理由：用户端的角色词表把 companion 叫「**打手**」
（`MESSAGE_ROLE_LABELS`），同一屏上每条消息的气泡标注也用这个词——
标题若改成「当前服务会话」，就会出现「标题说『服务会话』、气泡标注说『打手』」的错位。
若产品要求字面采用那对中性词，改动量是两个常量（`CONVERSATION_SEGMENT_*_TITLE_USER`
与历史后缀在用户端的取值），**登记为后续候选，不在本轮做**。

### 13.5 本轮**不**因追认而做的三件事

1. ❌ **没有**重开 P0-14 开发（产品明文「登记完成后，不重开 P0-14 开发」）。
2. ❌ **没有**开始 retention / 物理删除（追认没有回答它，§十一 的口径不变）。
3. ❌ **没有**改 `OrderStatus` / 权限判据 / 任何 DTO 字段（R1–R4 全是**既有实现的口径确认**）。

---

## §十四、人工验收 FAIL → 根因裁定与修复（2026-09-27，**验收修复，不新开 Round**）

> **状态**：`P0-14`、`P1-1`、`P1-2` 继续保持 `AWAITING_ACCEPTANCE`。本节是**追加**记录，
> §十 至 §十三 的原文一字未改——它们如实描述了当时的认识。
> ⚠️ §13.5 第 3 条说的「没有改任何 DTO 字段」只对 §十三 那批追认成立；
> **本节确实改了 DTO**（理由见 14.4），不构成对那句话的推翻。

### 14.1 人工验收的报告与复现事实

人工验收报 FAIL，复现步骤与现象：

1. 用户存在已接单订单；2. 用户发起退款；3. 全额退款处理成功；4. 退款成功后
User 仍能继续发订单聊天消息、Companion 仍能继续发、Companion 工作台该单仍显示**已接单**。

**根因分析确认（真机复现，非推断）**：`全额退款处理成功` 指的是**那一笔退款申请批准成功**，
**不是订单退满**。复现现场的读数：

| 字段 | 值 |
|---|---|
| `Order.status` | **`serving`**（不是 `refunded`） |
| `Order.refundedAmount` | **2989** / `actualPaidAmount` = 2990 —— **差 1 分** |
| `RefundRequest.status` | `approved` / 已通过，`decision.refundAmount` = 2003 |
| `actualCompanionId` | `cp-10`（保留，符合 P0-12 的硬约束） |
| Companion 订单 DTO | `serving` / 护航中 |
| Chat service 读到的 `order.status` | `serving` → `isOrderChatClosed` 为 false |

### 14.2 根因：售后审批的退款额**够不到**「退满」

`applyOrderRefund`（`lib/data/mockPaymentRepository.ts`）是**全仓唯一**写 `refundedAmount`、
也是**唯一**置 `status = "refunded"` 的地方，判据是唯一的纯函数 `isFullyRefunded`。
**写入者没有问题**——问题是写入者收到的增量**永远到不了** `actualPaidAmount`。

三条写入路径逐条核对：

| 路径 | 金额来源 | 能否退满 |
|---|---|---|
| `directRefundTransaction` | `actualPaidAmount − refundedAmount`（剩余额） | **恒能** ✅ |
| `companionDispatchTransaction`（公共池超时） | 同上，剩余额（计划阶段捕获） | **恒能** ✅ |
| `adminRefundTransaction`（**售后审批**） | `floor(actualPaidAmount × n / 100)`，`n` 是 **0~100 的整数** | **可能永远够不到** ❌ |

按比例那一条只有 **101 个离散取值**：

```
实付 2990：2990 个可能金额里 2890 个永远表达不出来
实付 6490：6490 个可能金额里 6390 个永远表达不出来
```

真机复现（`serving` 单，实付 2990，先批准 33% → 986，剩余 2004）：

```
[first33] 批准 33% → 200 已通过 → status=serving refunded=986/2990
          剩余 2004；不超过剩余的最大一档是 67% → 2003（仍差 1 分）
          再大一档 68% → 2033 超过剩余，服务端拒
[best67]  批准 67% → 200 已通过 → status=serving refunded=2989/2990 差 1 分
[last1]   批准 1%  → 400「累计退款金额超过订单实付金额，请调整退款比例」
```

⇒ 累计永远到不了 `actualPaidAmount` ⇒ `fullyRefunded` 永远为假 ⇒ 订单永远不转 `refunded`
⇒ **§十一 已落地的 `isOrderChatClosed` 闸永远不触发**、Companion DTO 永远报履约中。
报的三条症状全部由这一个结构性缺陷派生。

⚠️ **§十一 的 `TBD-P0-14-1` 规则本身是对的**：闸按 `refunded` 判、不按
`refundedAmount > 0` 判，这一条不变（见 14.6）。坏的是它上游永远送不到那个状态。

### 14.3 产品裁定原文（产品负责人，2026-09-27）

> **裁定一**：新增**「退满剩余」**意图。管理员在批准时可选「退满剩余」，
> 金额由服务端取 `实付 − 累计已退`，一步退满。
>
> ⛔ **2026-09-28 由 `P0-15` 覆盖（追加批注，不改写上面这句当时的裁定）**：
> 裁定一**已被正式取代**。产品负责人已把退款模型整体收敛为**一单一退**——
> 不再有「第二笔申请」，「累计已退」这个量也就**不存在**了，因此「取 `实付 − 累计已退`」
> 无从计算；`refundFullRemaining` 字段与界面选项**已整体删除**。
> **当前规则**：管理员只填**退款比例**，`refundAmount = floor(实付 × 比例)`，
> **`100%` 就是退满全部**（一趟到底、无尾差）。原文见
> `docs/03-dev/rounds/P0-15/01-prompt.md`。⚠️ 上面这段文字**原样保留**，
> 作为当时真实的判断痕迹，**不得作为实现或验收依据**。
>
> **裁定二**：「**客服沟通**」段**保持永久可写**。§四 的「User 不可发送」
> 按「**不可给打手发消息**」解释；退款用户仍可通过客服线追问退款去向。
>
> ✅ **裁定二在 `P0-15` 下仍然成立**，且被 `P0-15` 的 `04-acceptance.md` §G3 继续验收。

两条都改变了业务结果，因此由产品负责人裁定，实现方不自行选择。

### 14.4 修复落点（**唯一**新增的判断维度是「金额怎么表达」，不是「状态够不够」）

| 文件 | 改动 |
|---|---|
| `lib/constants/refunds.ts` | `RefundDecisionInput` 增 `refundFullRemaining`；`validateRefundDecisionInput` 在退满时跳过比例校验（**换**一道校验，不是放过）；`computeRefundDecisionAmounts` 增入参 `alreadyRefundedAmount`，退满时 `refundAmount = 实付 − 累计已退`；新增 `formatRefundDecisionRate` 与两条文案常量 |
| `lib/types/refund.ts` | `RefundDecision` 增 `refundFullRemaining: boolean`；`refundRateBp` 变 `number \| null`（退满时无比例可存） |
| `lib/constants/adminRefunds.ts` | 请求体读 `refundFullRemaining`（只认真布尔值）；**两条路互斥**：同时传比例与退满 → 400；`previewRefundDecisionAmounts` 透传该标志并传 `alreadyRefundedAmount` |
| `lib/data/adminRefundTransaction.ts` | 决策记录写入该标志；退满时 `refundRateBp` 存 `null` |
| `lib/constants/adminAudit.ts` | 审计快照增第七项 `refundFullRemaining` |
| `lib/services/adminHttp.ts` | `AdminRefundDecisionRequest` 扩成四个成员（金额表达方式 × 责任归属） |
| `lib/mocks/fixtures/refundSeed.ts` | 预置决策补该字段 |
| `components/admin/AdminRefundConsole.tsx`、`app/admin/(console)/refunds/[id]/page.tsx` | 管理员可选「退满剩余」并实时预览精确金额；详情页按形态显示 |

#### 14.4.1 为什么打手冲回在退满时用的是 `剩余 / 实付` 而**不是** 100%

`refundRateBp` 在退满路里是 `null`——管理员没有填比例，真正的比例是 `剩余 / 实付`，
它一般**写不成整数基点**（`2004/2990 = 67.023…%`）。因此 `computeRefundDecisionAmounts`
带着**分子分母**走、不在中间取整。

若图省事退回按 100% 算冲回：那样打手会被按「整单全退」冲回，而实际只退了 67%——
**钱一分没少，但责任分错了**（平台该承担的那部分被推给打手），正是 §17 不允许的那类错。
按比例那条路上分母恒为 10000、分子恒为 `refundRateBp`，代入后与改动前的式子**恒等**
（源码字面量变了：原来直接写 `input.refundRateBp` 与 `10000`，现在经 `rateNumerator` /
`rateDenominator` 转一手；取值与取整方向均未变），因此既有金额一分未变。

#### 14.4.2 为什么不是「把超限输入悄悄夹住」

按比例那条路上的超限**仍然照旧报错**。把 68% 静默夹成 67% 会让管理员以为 68% 生效了——
这种「填了但没生效」的错，账上要等对账才发现；与 `REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE`
是同一条理由（金额字段宁可报错）。「退满剩余」是一个**显式**选项，不是对脏输入的容忍。

### 14.5 为什么不新增状态判断

「累计是否已全额退款」仍然只由 `isFullyRefunded` 一个纯函数回答，
「写入 `refundedAmount` 与置 `refunded` 的原子性」仍然只在 `applyOrderRefund` 一处。
本次改的是**「这一次退多少」怎么算出来**，没有第二套状态判据、没有第二处写入。

### 14.6 **未**改动的部分及理由（反过来说明症状边界）

| 未改 | 理由 |
|---|---|
| `isOrderChatClosed(orderStatus)` 仍只认 `refunded` | §十一 裁定不变；**不得**改回「`refundedAmount > 0` 就锁」——部分退款时订单还要继续履约 |
| 「客服沟通」段仍永久可写 | 本次裁定二；`User 发(客服线)` 返回 200 是**符合预期**的，不是缺陷 |
| Companion DTO / 工作台状态 | 它直接读 `order.status`。订单真的变成 `refunded` 后自然显示「已退款」，**不需要改代码**——这正是要确认「DTO 状态来源正确」而非改文字 |
| `actualCompanionId` 仍保留 | P0-12 硬约束：保留历史事实。写权限由 `refunded` 状态收回，与保留事实不冲突 |
| `assertRefundApprovalOrderStatus`（`paid`/`accepted` 不得批准售后） | P0-13 裁定不变 |

### 14.7 一处**未能复现**的症状，如实登记

症状 3 的字面文案是「Companion 工作台显示**已接单**」，而 `accepted` 档在结构上
**卡不住**：它只能走直接全额退款，那条路恒退剩余额（见 14.2 表）。
复现到的是 `serving` 单卡住、工作台显示 **护航中**（同属「未反映真实最终状态」）。

⇒ 需要产品/验收方提供那张单的**订单号**，才能确认是不是另一种成因（例如预置数据、
或某个未经上述三条路径的入口）。**根因与修复点不受此影响**：
无论标签是「已接单」还是「护航中」，都是「订单没进 `refunded`」的同一个后果。

### 14.8 修复过程中发现的第二个缺陷：请求体没带上新字段（已修）

`lib/services/adminHttp.ts` 的 `approveRefund()` 只改了**类型**，请求体仍然是老的拼法：

```ts
refundRatePercent: decision.refundRatePercent,   // 退满剩余时是 undefined → 被 JSON.stringify 丢掉
```

后果是**运行时**的：界面选「退满剩余」提交，实际发出去的是
`{ idempotencyKey, reviewNote, responsibility }`，服务端在 `readAdminRefundDecisionInput`
走到「既没比例、也没有退满标志」→ 400「请填写退款比例」。
界面看起来完全正常（它已经按契约把 `refundFullRemaining` 传进了 `approveRefund`）。

⚠️ **`pnpm typecheck` 抓不到这一类**：`AdminRefundDecisionRequest` 的两个退满成员上
`refundRatePercent` 是 `string | undefined`，赋给 `apiPost` 的 `unknown` 请求体合法；
`JSON.stringify` 丢键发生在运行时。**只有读序列化结果才看得见。**

⇒ 因此补的验证不是「读代码」，而是**截住 `fetch` 读 JSON**（发现缺陷时用的是一次性临时探针，
跑完即弃）断言三条（退满/平台、退满/分担、按比例/打手）的键集合
——退满两条必须**有** `refundFullRemaining` 且**没有** `refundRatePercent` 这个键，
按比例那条必须逐字与改动前相同。

⚠️ **上面那次探针只是「发现」，不是「守住」**——一次性探针不留痕，缺陷改回去不会有人知道。
常驻的回归测试见 §14.9 MAJOR-1：`tests/adminRefundDecisionBody.test.mjs`（4 条，已含红-绿证伪）。
本节描述的是发现过程；**仓库里现在是有常驻测试的**，别把这两件事读混。

修法就是显式二选一，与文件里 `companionLiabilityRatePercent` 的既有写法同形：

```ts
...(decision.refundFullRemaining === true
  ? { refundFullRemaining: true }
  : { refundRatePercent: decision.refundRatePercent }),
```

**教训（值得留给下一个人）**：给请求体加一个「与既有字段互斥」的新字段时，
类型只是第一道；**判别联合让写错编译不过，但让「漏写」编译得过**——
因为省略一个可选字段永远是合法的。

### 14.9 只读审查（2026-09-27）的处置与登记

审查结论：**0 BLOCKER · 1 MAJOR · 3 MINOR · 4 NOTE**。逐条处置如下。

**已修**

| 级别 | 内容 | 处置 |
|---|---|---|
| MAJOR-1 | §14.8 那个请求体漏键的缺陷**没有任何常驻测试**钉住（当时的验证是「用后即删的临时探针」）。将来任何人再给这个请求体加一个「与既有字段互斥」的可选字段、或把那句 `...(cond ? A : B)` 退回成直写，都会原样复发而全套测试仍绿 | 补常驻回归测试，用 `globalThis.fetch` 打桩断言**序列化之后的键集合**（不是「值等于 undefined」——那对「键被丢掉」与「键在但值 undefined」同样为真，钉不住）。含**受控 mutation 红-绿证伪** |
| MINOR-1 | `ADMIN_REFUND_PREVIEW_EXCEEDS_PAID_NOTE` 的补救建议指向「调低比例 / 下一笔申请」，而**下一笔同样退不完**——管理员照做一次、订单再卡一次，**正是本次 FAIL 的复现路径** | 改为点名「退满剩余」一次退完（标签取自 `REFUND_FULL_REMAINING_LABEL`，不另写一份字面量） |
| MINOR-2 | 验收结论表只有 A–K 三行，而「通过标准」写的是「§A–§M 每一组逐条成立」⇒ §L/§M 的验收结论**无处登记** | 补 `L 「退满剩余」/ 根因复验` 与 `M 端到端机器复现 + 门禁` 两行 |
| MINOR-3 | `alreadyRefundedAmount > actualPaidAmount` 时 `refundAmount` 为负，却与 0 共用「退款金额为 0」这句 ⇒ 运维会去查「为什么算出 0」，而该查的是「为什么已退超过实付」 | 拆出 `REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE`，负数分支排在 0 之前。⚠️ `=== 0` 那条**逐字未变**（`tests/refundMoneyChain.test.mjs:528` 与 `:1989` 钉着它） |
| NOTE-4 | `api-contract.md:192` 与同节上文自相矛盾（一处「七项」、一处「六项」） | 更正为「七项」 |

**登记不修（并说明理由）**

- **NOTE-2（真债，但不是本次引入的）**：`lib/data/mockPaymentRepository.ts:519` 的
  `nextRefundedAmount >= order.actualPaidAmount` 是**第二份**退满判据（且少了
  `actualPaidAmount > 0` 那一项），与 `isFullyRefunded` 并存。因此
  「退满只有一个判据」目前是**尽力的、不是结构性的**。
  ⚠️ 这是 **P0-13 既有债**，属 P0-5.5 收敛范围。**本次不顺手改**：
  它是**唯一写入点**的核心分支，在「验收修复」的批次里动它，风险远大于收益，
  且本次退满路径下两式同真（对修复正确性无影响）。
- **NOTE-1**：「退满剩余」是**显式选项**、默认仍是「按比例退」——这不是缺陷（裁定一即
  「管理员可选」），但它是复验的**操作前提**，已写进 `04-acceptance.md` §L 的开头警告。
- **NOTE-3**：`actualPaidAmount <= 0` 现在短路返回全 0（改动前按比例走时
  `companionReversalAmount` 可能非 0）。该输入下三条写入路径都会被金额闸拦下、
  实际不可达；新行为已被既有测试正面钉住。仅登记。
- 审查同时确认**未发现**的问题面（供追溯）：三条写入路径现在都能退满、状态与累计额在
  同一同步区段内到位；金额闸/状态闸在所有分支下都在写入之前（零副作用失败）；
  冲回钳制与 `platformBorneAmount` 定义式守恒；`refundFullRemaining` 未泄漏到
  用户端/客服端/打手端 DTO；`isOrderChatClosed` 仍只认 `refunded`，客服段无闸；
  Companion DTO 仍直接读 `order.status`。

**审查明确交还产品裁定的两条（不擅自决定）**

1. 管理员按 100% 被金额闸拒之后，**要不要主动提示改用「退满剩余」**、甚至把预览的
   补救建议默认指向它。（本次只把**文案**从「下一笔申请」改成点名「退满剩余」，
   没有改变任何默认值或自动切换行为。）
2. 确认框里「金额方式」的**默认值**是否应由「按比例退」改为「退满剩余」。
   ⚠️ 这**会改变操作员行为**，属产品裁定——本次**保持默认不变**。

## §14.10 第二轮 review：对「修复本身」的复验（2026-09-27）

第一轮的 4 条修复（§14.8 的 MAJOR-1 + MINOR-1/2/3 + NOTE-4）落下去之后，源码变了，
因此**重开一次 review 只审这批 delta**（不重审整批）。结论：**0 BLOCKER / 0 MAJOR /
3 MINOR / 3 NOTE**——没有发现这批修复新引入的问题，也没有发现处置表与实际不符的条目。

### 三条 MINOR 的处置

| 编号 | 内容 | 处置 |
|---|---|---|
| MINOR-1 | **「负数分档」零测试保护**：全仓没有任何测试引用 `REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE`，把闸退回改动前的 `if (refundAmount <= 0)`、或把两行顺序对调，1537 条测试**全绿** | **已修**：`tests/refundMoneyChain.test.mjs` 的金额闸用例补成对正反例（负额 → NEGATIVE 且 `!==` ZERO；0 → 仍是原来那句且 `!==` NEGATIVE）。⚠️ 只钉「负额有句子」不够——**顺序对调**才是要防的那个缺陷，所以必须有 `!==` 那一半。已做**受控 mutation 证伪**：把闸改成 `<= 0` 在前 → 恰好 1 条红（`已退超过实付 → 报「数据异常」`）、其余 48 条仍绿；还原 → 49/49 绿 |
| MINOR-2 | `04-acceptance.md` §M 的门禁数字**早于** MAJOR-1 的回归测试（1533/1365 vs 实际 1537/1369，差值恰好是新测试那 4 条） | **已修**：新增 §M4 记录**最终树**的复跑（本次取代 M1–M3 的效力），三行数字全部按新树更新，并补上 production 行 `APP_BASE_URL` 的实跑结果 |
| MINOR-3 | 「六项决策字段」的计数只改了 `api-contract.md` 一处，`lib/types/refund.ts`（**类型定义处，唯一真值源**）、`adminAudit.ts`、`architecture-rules.md`、`database-schema.md`、`page.tsx` 仍是旧数 | **已修**：统一为「七项」。⚠️ `P0-12/`、`P0-13/`、`BATCH_*.md` 等**历史 Round 文档不动**（只可批注不可改写）——那里的「六项」是 **P0-13 当时的真实状态**，本来就对；`adminAudit.ts` 里那句 P0-13 的叙述改成显式**历史语态**，并加一句「别拿它当现值」 |

⚠️ MINOR-3 顺带发现一处**同源残留**（review 未列）：`refunds.ts` 里解释
「实付 ≤ 0 必须先拦、否则 NaN 会被放行」的注释，原写成「金额闸的判据是
`refundAmount <= 0`，`NaN <= 0` 为 false」。闸拆成两档之后**这句引用失效了**
（虽然结论不变：`NaN < 0` 与 `NaN === 0` 同样都是 false，NaN 仍然被放行）。
已改为按两档表述——**引用失效的注释比没有注释更坏**，它会让下一个人以为闸还是老样子。

### 三条 NOTE

- **NOTE-A（已修）**：§14.8 说探针「用后即删、不留在仓库里」，与 §14.9 的
  「补常驻回归测试」并读会让人以为仓库里没有常驻测试。已在 §14.8 结尾加指向 §14.9 的一句。
- **NOTE-B（登记）**：§14.9 声称 MAJOR-1 含红-绿证伪，但 `03-delivery.md` 本次未更新，
  证据没落纸。审查者**独立复算**了键集合，确认该声明实质成立、不是虚报。属记录缺失。
- **NOTE-C（登记不修）**：预览区把「闸失败」一律显示成「超过剩余可退」
  （`previewRefundDecisionAmounts` 返回的 `exceedsPaid` 实为 `gateMessage !== null`），
  因此「填 0%」与「数据已坏（负额）」在**预览**里仍是同一句话；
  MINOR-3 想要的分档目前只在**提交后 400** 那条路上生效。这是**既有的命名/结构问题**
  （`exceedsPaid` 名不副实），不是本批 delta 引入的，登记备查、本批不动。

### 最终门禁（整改全部落地后，最终树）

| 门禁 | 结果 |
|---|---|
| targeted（refund / chat / companion 七个文件） | 163 tests · **152 pass · 0 fail** · 11 skip |
| `pnpm test` | 1537 tests · **1369 pass · 0 fail** · 168 skip |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 全部 exit 0 |
| 生产 `APP_BASE_URL` 全量 | 1537 tests · **1537 pass · 0 fail · 0 skipped** |
| 端到端复现（生产构建 + 真实 HTTP） | **38 项断言全过** |
