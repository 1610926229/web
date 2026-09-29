# P0-14 · 打手订单聊天 + 换人后的聊天隔离

Round ID: P0-14
Title: 打手加入订单聊天 + 每次履约 assignment 独立 conversation + 换人/回池/封禁后旧打手立即失权
**Status: `AWAITING_ACCEPTANCE`**
Depends On: P0-11（`DONE`，唯一释放写入器 `releaseCurrentAssignment`）· P0-6 / P0-7 / P0-8 / P0-9 / P0-10 / P0-12 / P0-13（均 `DONE`）
Goal: 把「一次履约 = 一份 Conversation」这条**已冻结但零实现**的规则落地——打手能参与订单聊天，换人后旧打手立即失权、新打手看不到旧会话、用户与客服仍看得到完整历史。**不做**物理删除 / retention。
Primary Domain: Conversation / Message · Order（只读）· CompanionReleaseRecord（只读）
Primary State Transition: **无 `OrderStatus` 变更**（本轮不改订单状态机）。变化的是**会话的 assignment 归属**：`无 → 当前 assignment`、`当前 → 历史（只读、对旧打手失权）`
Started At: 2026-09-27
Development Completed At: **2026-09-27**
Review: **已审查（三轮，全部只读）** —— reviewer-agent（对照 `docs/01-requirements/` 与 `architecture-rules.md`）。第一轮结论 **0 BLOCKER · 0 MAJOR · 1 MINOR · 2 NOTE**；MINOR-1（三处注释/文档错误声称 `toMessageView` 是「全仓唯一转换点」）**已修**，**断言零改动**；2 条 NOTE 登记不修（其一升级为需产品裁定的 `TBD-P0-14-1`）。第二轮（裁定 fix 增量）**0/0/0/6 NOTE**，第三轮（整改增量）**0/0/0/5 NOTE**。三轮累计 **0 BLOCKER · 0 MAJOR**。详见 `02-decisions.md` §十 / `03-delivery.md` §6.4 / §6.5
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**，等待产品负责人人工验收）
Git Commit: —（⚠️ 本批次**禁止任何 Git 写操作**，交付时点`Git Commit` 留空是该时点的正确状态）

> ⚠️ **Claude 不得自行 `DONE`。** 本轮交付后停在 `AWAITING_ACCEPTANCE`，等待产品负责人人工验收。

---

## Requirement Check 结论：**无 `OPEN` 决策，不需要 `CLARIFYING`**

逐条核对 `cmd_p0-14.md` §十五 要求检查的五处，并**全文检索** `docs/01-requirements/` 交叉验证：

| 检查项 | 结论 |
|---|---|
| `EX-SERVICE-04` | ✅ **已冻结**（`状态：✅ 2026-09-23 已确认`）：「每次新 assignment 建新会话；新打手看不到旧聊天」 |
| `EX-CHAT-01` | ✅ 四条规则逐条写死（原打手保留历史 / 新打手新建 Conversation / 新打手不得看旧聊天 / 客服与管理员可查旧 assignment） |
| `EX-CHAT-02` | ✅ 原打手不得继续向新会话发消息；历史会话按权限只读 |
| `BF-23`（`业务流程表.md:769`） | ✅ 权威模型：「**每次实际履约 assignment 对应一份 Conversation**」；参与者 = 订单用户 + 当前实际打手 + 客服/管理员按管理权限查看 |
| `用户权限表.md:112-113` | ✅ 「用户端订单聊天」一行明确：Companion **「⏳ 当前 assignment」**；「查看其他打手历史聊天」一行明确：Companion **❌**、Staff/Admin **✅** |
| `用户权限表.md:259` | ✅ `enabled=false`：「**不允许继续查看当前履约聊天**」——封闭禁场景的失权要求 |
| 当前 message schema | `OrderConversationRecord` **只以 `orderId` 为维度**，**结构上装不下**多次 assignment ⇒ 本轮允许的最小升级见下 |
| 当前 conversation repository | `lib/data/messageRepository.ts` → `mockMessageRepository`，`conversations: Map<orderId, record>` |
| P0-11 release 原语 | `lib/data/companionOrderTransaction.ts` 的 `releaseCurrentAssignment`（1 处定义 / 4 处调用），**整个伪事务文件零 `await`** |

**「assignment conversation 的创建时点」不存在冲突**：`cmd_p0-14.md` §4.1（订单首次进入 `accepted` 且存在 `actualCompanionId`）、`BF-23`、`EX-CHAT-01`、`EX-SERVICE-04` 说的是同一件事——**assignment 始于接单**。三处互不矛盾，因此**未进入 `CLARIFYING`**。

**明确 `DEFER`（本轮不做、不自行决定）**：聊天 retention / 物理删除。
依据：`BF-24` 只冻结了「普通 completed 订单：投诉窗口结束且无异常时**可**物理删除」与「投诉订单 / 换人产生的旧履约聊天永久保留」，而 `BR-02`（`业务流程表.md:805`）、`EX-CHAT-04`、`Q-EX-07`（`特殊情况与异常处理表.md:1094`）、`PR-06`（`用户权限表.md:674`）四处**同时**把「只有退款、没有投诉的订单聊天是否永久保存」标为未决。
`cmd_p0-14.md` §十三 / §十五 明文允许本轮 `DEFER` 它。**本轮不写任何删除路径。**

---

## 核心模型决策（一句话）

**会话从「一单一会话」升级为「一单一客服会话 + 每次 assignment 一会话」，而 assignment 的身份由 P0-11 已有的 append-only 退出历史**（`CompanionReleaseRecord`）**推导**——
因此「旧打手失权」是**结构性的**，不需要在释放事务里多写一行，也**不可能被漏写**。

详见 `02-decisions.md` §三（D1–D3）。

---

## 交付摘要

**六条承诺全部落地并**在**生产构建**上以 HTTP 契约实测通过（`fail=0` 且 `skipped=0`）：

| # | 承诺 | 落地方式 |
|---|---|---|
| 1 | 当前实际打手加入订单聊天 | 会话分 `service` / `assignment` 两类；读即建段（惰性创建） |
| 2 | 每次新 assignment 独立 conversation | `assignmentKey = ${orderId}#s${releaseCount}`，创建时冻结、每次请求现算 |
| 3 | 换人 / 回池 / 封禁后旧打手**立即**失权 | 判据①③同时断；`releaseCurrentAssignment` **零改动**，靠 release 历史条数递增**结构性失效** |
| 4 | 新打手**绝不能**看到旧打手聊天 | 判据②挡「别人的段」、③挡 A→B→A 复用旧段 |
| 5 | 用户看到订单下**完整**历史 | 分段展示 + 扁平 `messages`；旧段只读 |
| 6 | Staff 可为售后调查看**全部** assignment 历史 | `toStaffConversationSegments` 带 `companionId` / `companionName`；已读游标按段隔离 |

**关键设计取舍**：失效**不是**在释放事务里写一行标记，而是由 P0-11 已有的
**append-only 退出历史**推导出来 —— 因此「某条释放路径忘了失效」这种缺陷形态
**结构上不存在**。代价是会话惰性创建（登记为 R3）。

**门禁读数**（`03-delivery.md` §三，**含 `TBD-P0-14-1` 裁定 fix
与第三轮审查 NOTE 处置后的终值**）：
离线 `pnpm test` **1446 / pass 1290 / fail 0 / skip 156** ·
生产 `APP_BASE_URL` 全量 **1446 / pass 1446 / fail 0 / skipped 0** ·
targeted `tests/assignmentConversations.test.mjs` **38 / 38** ·
typecheck · lint · build 各 **exit 0**。

**审查（三轮，全部只读，未改任何文件）**：第一轮
**0 BLOCKER · 0 MAJOR · 1 MINOR（已修）· 2 NOTE**（`02-decisions.md` §十）；
裁定 fix 的第二轮 **0 BLOCKER · 0 MAJOR · 0 MINOR · 6 NOTE**（§6.4）；
对整改增量的第三轮 **0 BLOCKER · 0 MAJOR · 0 MINOR · 5 NOTE**（§6.5，
其中 NOTE-3 补了「只读 11」、NOTE-4 改了文档小字、NOTE-5 补了 store 重置并**实测复现**，
NOTE-1/NOTE-2 分别登记与转人工验收项）。三轮累计 **0 BLOCKER · 0 MAJOR**。

**新登记**：~~**`TBD-P0-14-1`**~~ —— 全额退款后打手是否仍可访问该订单聊天。
**已于 2026-09-27 由产品负责人裁定并实现**：**全额退款后当前 assignment 立即结束；
聊天历史保留，但进入只读状态**（`02-decisions.md` §十一 · `03-delivery.md` §5.2 / §十 ·
`04-acceptance.md` §五 + §K）。

**⚠️ 裁定只回答「还能不能访问」，没有回答「保留多久 / 要不要删」**——
聊天 retention 与物理删除**继续 `DEFER`**（R4 / `EX-CHAT-04` / `BR-02` / `PR-06` / `Q-EX-07`）。

**产品追认（2026-09-27，**登记动作零代码改动**）**：交付时**未冻结文本**的四项取舍
**R1–R4 已由产品负责人逐条追认**，四条**全部由现有实现满足**——R1 只限制 Staff 对履约
assignment 会话的写入（不新增 Staff ↔ Companion 直连）· R2 用户端按当前 / 历史分段 ·
R3 允许会话惰性物化且**失败请求不留空段** · R4 历史段不强制显示打手名（有一处**措辞**
差异：用户端标题为「打手沟通 / 打手沟通（历史）」，**已记录、不要求改动**）。
逐条比对见 `02-decisions.md` §十三 · `03-delivery.md` §5.3 · `04-acceptance.md` §五。
**本轮状态不因追认改变，仍为 `AWAITING_ACCEPTANCE`。**

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（`cmd_p0-14.md` 原样拷贝，498 行） |
| `02-decisions.md` | Requirement Check 结果、模型设计决策 D1–Dn、权限矩阵、DEFER 登记 |
| `03-delivery.md` | 实现结果与验证、门禁读数、reviewer 结论与整改、Git 状态 |
| `04-acceptance.md` | 人工验收清单（含超出台面明文的登记项） |
| `README.md` | 本文件 |
