# P0-14 — 交付记录

Round ID: P0-14
Title: 打手订单聊天 + 换人后的聊天隔离
Status: **`AWAITING_ACCEPTANCE`**（⚠️ Claude 不得自行 `DONE`）
基线: `HEAD = c2c9360`（`fix(p0-13): paid/accepted 不允许批准售后退款申请`）
分支: `feat/order-lifecycle-alignment`
交付时点: 2026-09-27

> ⚠️ 本批次**禁止任何 Git 写操作**。因此本文件里的「Git 状态」一节记录的是
> **只读观测结果**，`Git Commit` 一栏留空是该时点的**正确状态**，不是遗漏。

---

## 一、本轮交付是什么，以及它为什么现在才做

**一句话**：「一次实际履约 = 一份 Conversation」这条规则在 `BF-23`（`业务流程表.md:769`）
里**早就冻结了**，`EX-CHAT-01` / `EX-CHAT-02` / `EX-SERVICE-04` 也逐条写死了行为的四条，
`用户权限表.md:112-113` 甚至明确标注了 Companion 的聊天范围是「**⏳ 当前 assignment**」、
「查看其他打手历史聊天」为 ❌——但**零实现**。P0-14 之前，会话记录
（`OrderConversationRecord`）**只有 `orderId` 一个维度**，结构上就装不下「多次 assignment」。

本轮把它落地，并且**刻意选择了一条不需要改动任何履约写入路径的实现方式**（见 §2.2）。

**本轮的核心难点不是「建会话」，是「失效」**：换人 / 回池 / 封禁之后，
旧打手必须**立刻**失去权限，而且这个失效**不能被漏写**。
任何「在释放事务里补一行 `conversation.revoked = true`」的方案，都要在
`cancelAcceptedOrder` / `releaseOrderByStaff` / `replaceOrderCompanionByStaff` /
`releaseOrdersForCompanion` **四处**各写一遍——漏一处就是一个静默的越权口子，
而且没有任何测试会红。

---

## 二、实现内容

### 2.1 模型变更（本轮唯一的数据结构升级，最小的那一种）

| 对象 | 变更前 | 变更后 |
|---|---|---|
| `OrderConversationRecord` | `Map<orderId, record>`，`orderId` 即主键 | 新增 `id` 为主键；`orderId` 降为**普通字段**；新增 `kind: "service" \| "assignment"`、`companionId: string \| null`、`assignmentSeq: number`、`assignmentKey: string \| null`、`companionLastReadAt` |
| `OrderMessage` | 无归属字段 | 新增 `conversationId`（**只存在于内部记录**，不外发） |
| 会话种类 | 只有「用户 ↔ 客服」一种 | `service`（保留原样，**不动**）+ `assignment`（每次履约一段，**新增**） |
| 仓储接口 | `findConversation(orderId)` 单键 | `listConversationsByOrder(orderId)` → 有序数组；`findServiceConversation` / `findAssignmentConversation`；旧 `findConversation` **已无残留调用** |

**明确没有做的事**：没有建立完整的 Assignment 聚合。`assignmentKey` 只是一个**派生字符串**，
没有新的实体、没有新的仓储、没有新的伪事务（`cmd_p0-14.md` §3 的明文约束）。

### 2.2 `assignmentKey` 的设计（**本轮最关键的决策**）

```
assignmentSeq(order)  = 该订单 append-only 的 CompanionReleaseRecord 条数
assignmentKey         = `${orderId}#s${assignmentSeq}`
```

- **创建时冻结**：`assignmentKey` 写进会话记录后不再变。
- **每次请求现算**：「这是不是当前那一段」= 把会话上冻结的键，与**现在**算出来的键比较。
- 因此**换人 = 序号递增**，旧会话的键**当场**就不再等于当前键——旧打手失权。

**为什么这是关键**：`releaseCurrentAssignment`（`lib/data/companionOrderTransaction.ts`）
及其 4 个调用点 **P0-14 零改动**（已用 `git diff` 确认，不是凭记忆）。
释放事务**不需要知道聊天的存在**，失效是**结构性副作用**，不是被谁显式写下的。
⇒ **不存在「某条释放路径忘了失效」这种缺陷形态。**

### 2.3 访问判据：三条腿同时成立

`canCompanionAccessConversation`（`lib/constants/conversations.ts`）：

| 腿 | 内容 | 挡的是 |
|---|---|---|
| ① | `order.actualCompanionId === me` | 不是这单的打手 |
| ② | `conversation.companionId === me` | **别人的段**（新打手看旧打手聊天） |
| ③ | `conversation.assignmentKey === currentAssignmentKey` | **自己的旧段**（A→B→A 复用） |

③ 单独负责 A→B→A：第二个 A 拿到的键是 `#s2`，第一段是 `#s0`，**同一个 companionId 也不放行**。

**四个打手路由（list / detail / send / read）全部**经
`resolveChatContext` / `resolveChatContextWithConversation` 走到这条判据——
读取与写入**同一条**判据，不存在「读得到但发不出」或反过来的缝。

### 2.4 会话惰性创建 + 失效结构性发生

`ensureAssignmentConversation` 在**读**的时候建段（打手第一次打开聊天即建），
幂等键是「订单 + 当前 `assignmentSeq`」，因此重复读不会建出第二条。

**与 `cmd §4.1` 字面的取舍**：指令写「订单首次进入 `accepted` 且存在 `actualCompanionId` 时创建」。
本轮**没有**把创建塞进接单事务，理由是那会让 P0-11 的伪事务多出一处
「聊天」依赖，而 `releaseCurrentAssignment` 的零改动是本轮最重要的安全性质。
代价是「换人后、新打手还没开口之前，客服看不到那一段」——这是**诚实的**：
那一段确实还不存在。已在 §六 R3 登记，并写进了 HTTP 测试
（`HTTP 32` 先断言换人后是**两段**，再让新打手打开聊天，再断言**三段**）。

### 2.5 三端 DTO 各自显式挑字段

| 端 | 转换点 | 字段数 | 刻意不返回 |
|---|---|---|---|
| 用户 | `toMessageView()` · `lib/constants/conversations.ts:255` | 9 | `conversationId`；段落 DTO 另**不带** `companionId` / `companionLastReadAt` |
| 打手 | `toCompanionChatMessage()` · `lib/services/companionConversations.ts:157`（模块私有） | 7 | 全部内部键；**别的段落的消息**（服务层就判掉，不是靠页面不显示） |
| 客服 | `toStaffConversationMessage()` · `lib/constants/staff.ts:504` | — | 另**加上** `companionId` / `companionName`（**刻意**的调查视角）；`gameAccountId` / `remark` / `clubNetIncome` 均不返回 |

⚠️ 三端**故意不共用一个函数**（形状不同）。「每一条出站路径都自己显式挑字段」才是本轮的不变量。
——这一条是本轮 reviewer 的 MINOR-1 整改结果，原先的注释错误地声称「单一转换点」，已改正（§六.1）。

### 2.6 本轮改动集合

**新增（12 个代码 / 测试文件；另有本轮五件档案与指令档案）**

| 文件 | 行数 | 内容 |
|---|---|---|
| `lib/constants/conversations.ts` | 484 | 判据、`assignmentKey` 派生、分段构建、三端文案常量、`toMessageView`、**`isOrderChatClosed`** |
| `lib/services/companionConversations.ts` | 424 | 打手侧聊天服务（列表 / 详情 / 发送 / 已读） |
| `lib/types/companionChat.ts` | 104 | 打手侧 DTO |
| `app/api/companion/conversations/route.ts` 等 **4 个** `route.ts` | — | 列表 / 详情 / 发送 / 已读 |
| `components/companion/CompanionChatConsole.tsx` | 258 | 打手聊天界面 |
| `app/companion/(console)/chats/page.tsx` | 145 | 聊天列表页 |
| `app/companion/(console)/chats/[orderId]/page.tsx` | 98 | 聊天详情页 |
| `tests/assignmentConversations.test.mjs` | 1813 | 38 条 |
| `tests/companionChatHttp.test.mjs` | 740 | 10 条（`APP_BASE_URL` 门控） |

> 📌 行数是**含 `TBD-P0-14-1` 裁定 fix（含 reviewer NOTE-4/5/6 整改）
> 与第三轮只读审查 NOTE 处置（只读 11 + `beforeEach` 两条 store 重置）之后**的终值。

**修改（26 个已跟踪文件，`+2129 / −309`）**

> 📌 该读数为**交付时点**实测（`git diff --shortstat`，只读），**已含**本轮收尾的档案回填
> （`api-contract.md` 与两份进度表）、`TBD-P0-14-1` 裁定 fix、以及 reviewer NOTE-4/5/6 的整改。
> 本文件自身是**未跟踪**新增文件，不计入此数。
> P0-14 交付时是 **25** 个；裁定 fix 让 25 → **26**，**新增的那一个**是
> `app/(mobile)/orders/[id]/page.tsx`（原先把角色词写死在页面里，见 §10.5）。
> 其余改动都落在既有的 12 个代码文件 + 2 个测试 + 3 份文档里，**没有新增 route / service /
> repository / DTO / 第二套 conversation 模型**（`cmd_p0-14.md` §三 约束）。

核心：`lib/data/messageRepository.ts` · `lib/data/mockMessageRepository.ts` ·
`lib/types/message.ts` · `lib/services/conversations.ts` · `lib/services/staffConversations.ts` ·
`lib/constants/service.ts` · `lib/constants/staff.ts` · `lib/constants/companionConsole.ts` ·
`lib/services/companionHttp.ts` · `lib/mocks/fixtures/messageSeed.ts`
界面：`components/service/OrderChat.tsx` · `components/staff/StaffConversationConsole.tsx` ·
`app/(mobile)/service/chat/[orderId]/page.tsx` · `app/companion/(console)/orders/[id]/page.tsx`
门禁：`tests/companion.test.mjs`（清单 8→12）· `tests/companionAccess.test.mjs`（调用点 6→8）·
`tests/companionConsoleNav.test.mjs`（页面 6→8）· `tests/staffReleaseHistory.test.mjs`
文档：`docs/02-tech-design/api-contract.md` · 两份进度表

**仓库计数变化**

| 指标 | 前 | 后 |
|---|---|---|
| `page.tsx` | 80 | **82** |
| `route.ts` | 131 | **135**（companion 8 → 12） |
| 测试文件 | 69 | **71** |

**零改动的关键文件**（`git diff` 确认）：`lib/data/companionOrderTransaction.ts` ·
`lib/data/adminRefundTransaction.ts`。

### 2.7 一个真实缺陷的修复（不是重构，是 bug）

`components/service/OrderChat.tsx` 的发送目标选择器原先**硬编码** `label: "护航"`，
而用户端同一屏幕上的段落标题是「**打手**沟通」——同一个界面自相矛盾。
根因是三端角色词没有单一来源。已改为全部取自
`MESSAGE_ROLE_LABELS` / `STAFF_MESSAGE_ROLE_LABELS` / `COMPANION_MESSAGE_ROLE_LABELS`，
并新增源码结构门禁：**三端页面里不许出现「打手」或「护航」字面量**
（`tests/assignmentConversations.test.mjs` 最后一条）。

---

## 三、门禁读数

### 3.1 最终树（2026-09-27 实跑，**已含 reviewer MINOR-1 整改 + `TBD-P0-14-1` 裁定 fix + 第三轮只读审查的 NOTE 处置**）

| 门禁 | 命令 | 读数 |
|---|---|---|
| targeted | `node --test tests/assignmentConversations.test.mjs` | **38 / 38 pass · 0 fail · 0 skipped** |
| 全量（离线） | `pnpm test` | **1446 tests · 1290 pass · 0 fail · 156 skipped** |
| 类型 | `pnpm typecheck` | **exit 0** |
| Lint | `pnpm lint` | **exit 0**（无输出） |
| 构建 | `pnpm build` | **exit 0**，路由表含 `/companion/chats` 与 `/companion/chats/[orderId]` |
| **全量（生产）** | `APP_BASE_URL=http://127.0.0.1:3214 pnpm test` | **1446 tests · 1446 pass · 0 fail · 0 skipped** |

生产跑的是 `pnpm build` 产物 + `npx next start -p 3214`。
**`fail = 0` 且 `skipped = 0`**——HTTP 契约用例**全部真跑**，没有一条被跳过。

> 收尾时 `next start` 已停止，并用 `netstat -ano | grep ":3214"` 确认端口**已释放**
> （不是只看 TaskStop 的返回，见 memory「后台服务的 TaskStop 杀不干净」）。
> ⚠️ **口径要说准**：停掉之后 `grep ":3214"` 仍会打出几行 `TIME_WAIT` 的**客户端**套接字
> （形如 `127.0.0.1:58xxx → 127.0.0.1:3214`），那**不是**监听。真正的判据是
> **`grep LISTENING` 为空**——实测收尾时 `0.0.0.0:3214` 的 LISTENING 行已消失，
> 只剩 4 行 TIME_WAIT 自行散去。只看「grep 有没有输出」会误判成「还占着」。

### 3.2 用例数沿革

| 阶段 | tests | pass | fail | skipped |
|---|---|---|---|---|
| P0-14 开工前（`HEAD = c2c9360`） | 1398 | 1252 | 0 | 146 |
| P0-14 开发完成（离线） | 1432 | 1278 | 0 | 154 |
| P0-14 交付（生产） | 1432 | 1432 | 0 | 0 |
| **`TBD-P0-14-1` 裁定 fix（离线）** | **1445** | **1289** | **0** | **156** |
| **`TBD-P0-14-1` 裁定 fix（生产）** | **1445** | **1445** | **0** | **0** |
| **第三轮只读审查 NOTE 处置后（离线）** | **1446** | **1290** | **0** | **156** |
| **第三轮只读审查 NOTE 处置后（生产）** | **1446** | **1446** | **0** | **0** |

P0-14 开发增量 `+34` = `assignmentConversations.test.mjs` 的 26 条（离线也跑）+
`companionChatHttp.test.mjs` 的 8 条（需 `APP_BASE_URL`，离线时计入 `skipped`）。

裁定 fix 增量 `+47` = `assignmentConversations.test.mjs` 26 → **37** +
`companionChatHttp.test.mjs` 8 → **10**。其中 37 条的构成：
裁定第 6 条要求的那 8 条（只读 1–8）+ 后续增补 3 条（只读 9 零副作用、只读 10 不重复文案、
「没先打开聊天页也能直接发第一条」）+ 「称呼来源」原有用例**扩写**成第 4 条。
**`skipped` 从 154 涨到 156，涨的正是新增的那 2 条 HTTP 用例**——
离线时它们被跳过，生产跑时它们**真跑**（所以生产行 `skipped = 0` 依然成立）。

第三轮只读审查 NOTE 处置增量 `+1` = `assignmentConversations.test.mjs` 37 → **38**
（新增「只读 11：退款单 + 非本人发送仍是 404」，见 §10.8）。
`skipped` 不动（156 → 156）：这一条**不进** HTTP 文件，离线生产都真跑。

### 3.3 `cmd_p0-14.md` §十四 的 38 项逐条落点

| # | 要求 | 落点（用例标题关键词） |
|---|---|---|
| 1 | 一订单可有多段 assignment conversation | 模型 1 |
| 2 | 同一 assignment 不重复创建 | 模型 2 |
| 3 | A→B 建两条 | 模型 3/4 |
| 4 | A→B→A 建**第三条** | 模型 3/4（断言 `seq=[0,1,2]`、`companionId=[A,B,A]`、id 互不相同） |
| 5 | 历史消息不丢 | 模型 5/6 |
| 6 | 不以 orderId 单键覆盖 | 模型 1 + 模型 5/6 |
| 7 | 当前 Companion 可读 | 打手 7/8 |
| 8 | 当前 Companion 可发 | 打手 7/8 |
| 9 | 非当前 Companion 拒绝 | 打手 9/13/14（三种「查不到」**同形**） |
| 10 | release 后立即失权 | 打手 10（读 / 写 / 已读**三条路径一起断**） |
| 11 | replace 后失权 | 打手 11 |
| 12 | disable release 后失权 | 打手 12 |
| 13 | 新 Companion 看不到旧消息 | 打手 9/13/14 |
| 14 | 新 Companion 只看得到自己的 | 打手 11 + HTTP 29 |
| 15 | 新 Companion unread 独立 | 打手 15/16 |
| 16 | 旧 unread 不污染新 | 打手 15/16 |
| 17 | owner 可看全部历史 | 用户 17/21 |
| 18 | owner 可对当前段发 | 用户 18/19 |
| 19 | owner 不向历史段发 | 用户 18/19 |
| 20 | non-owner 不可读 | 用户 20 |
| 21 | 多段 DTO 顺序稳定 | 用户 17/21 + 模型「订单内排序是全序」 |
| 22 | Staff 可看全部历史 | 客服 22/23 |
| 23 | release history 与 conversation history 对得上 | 客服 22/23 |
| 24 | Staff read 不被 Companion 污染 | 客服 24 |
| 25 | companion chat 401 | HTTP 25（含**伪造 cookie**） |
| 26 | 403 / 404 权限边界 | HTTP 26（两种 404 **同形**） |
| 27 | GET happy path | HTTP 27/28 |
| 28 | POST happy path | HTTP 27/28（**伪造的发送者字段被忽略**） |
| 29 | 旧 Companion route 拒绝 | HTTP 29（**四个路由全 404**） |
| 30 | 新 Companion 只返回自己的 | HTTP 30 |
| 31 | User 完整历史但不泄露内部键 | HTTP 31（含 DTO 键集合精确断言） |
| 32 | Staff 调查历史但不泄露隐私 | HTTP 32（含 `gameAccountId` / `remark` 全 false） |
| 33 | 用户 ↔ Staff 现有聊天不回归 | 客服 33 + HTTP 32（客服发言**只进客服段**） |
| 34 | P0-11 cancel/release/replace 不回归 | 交易文件**零改动** + 全量门禁 |
| 35 | P0-12 / P0-13 refund 不回归 | `adminRefundTransaction.ts` **零改动** + 全量门禁 |
| 36 | completion / complaint 不回归 | 既有套件 + 全量门禁 |
| 37 | route manifest / API 契约更新 | `companion.test.mjs` 8→12 · `api-contract.md` §8 表 5→12 · 总数 131→135 |
| 38 | DTO key 精确边界 | DTO 38（`keysOf + assert.deepEqual`，**键集增删都会红**） |

### 3.4 三处「显式清单」门禁（**它们先红过，这才是对的**）

| 门禁 | 文件 | 变化 | 为什么红是对的 |
|---|---|---|---|
| 打手接口清单 | `tests/companion.test.mjs` | 8 → 12 | 新增 4 个 route —— 清单不扩充就说明**没被盘点** |
| 工作台页面清单 | `tests/companionConsoleNav.test.mjs` | 6 → 8 | 新增 2 页，必须落在 `(console)` 下才能自动吃顶栏 |
| 资格判定调用点清单 | `tests/companionAccess.test.mjs` | 6 → 8 | 新页面调 `resolveCompanionAccess` |

三处都加了 **P0-14 修订说明**（写明「从 N 变 M、为什么」），不是静默改数字。

---

## 四、累计工作区状态

**本批次的全部产物交付时点均在工作区、未提交**（本批次禁止 Git 写操作）。

- 修改（已跟踪）：26 个文件，`+2129 / −309`
- 新增（未跟踪）：**12 个**代码 / 测试文件（4 个 `route.ts` ＋ 2 个页面 ＋ 1 个组件 ＋ 3 个 `lib` 模块 ＋ 2 个测试文件），另有本轮档案与指令档案
- 另有两份**工作区既存**的未跟踪项与 P0-14 无关：`.claude/hooks/`、`docs/03-dev/rounds/cmd_p0-14.md`、`docs/03-dev/rounds/start_p0-14.txt`（后两者是本轮的指令与启动档案）

---

## 五、遗留 / MINOR / NOTE / TBD

### 5.1 已 DEFER（有明文授权，本轮不做，**上线前是 production blocker**）

| 项 | 内容 | 授权 |
|---|---|---|
| **D-1** | 聊天 **retention / 物理删除** | `cmd_p0-14.md` §十三 · §十五 明文允许本轮 DEFER；`BF-24` / `BR-02` / `EX-CHAT-04` / `Q-EX-07` / `PR-06` **四处同时未决** |
| **D-2** | 用户端可见 `companionRateBp`（分账比例暴露） | P0-13 遗留，**上线前移除**（既有 memory 已登记） |

**本轮不写任何删除路径**——不是忘了，是 `BF-24` 只冻结了「普通 completed 订单在投诉窗口
结束且无异常时**可**物理删除」，而「只有退款、没有投诉的订单聊天是否永久保存」
四处标记 ❓。

### 5.2 ✅ `TBD-P0-14-1` —— 已裁定、已实现（2026-09-27，**不再是待决项**）

> **裁定**：订单全额退款后，当前 assignment **立即结束**；对应聊天历史**保留**，但进入**只读**状态。
>
> **落地与理由**：`02-decisions.md` §十一（判据 `isOrderChatClosed` / 两个写闸及其**不同**顺序 /
> DTO 与文案 / 裁定第 6 条六项测试逐条落点）。
> **验收**：`04-acceptance.md` §五 + 新增的 **§K** 一组。

**当初登记的事实（如实保留，作为「裁定之前是什么样」的记录）**：
`adminRefundTransaction.ts` 明文「不清 `actualCompanionId`」（P0-12 硬约束）；
`listCompanionChats` 走 `queryOrdersByCompanion`（不过滤订单状态），`resolveChatContext` 也不查
`order.status` ⇒ 订单退满变 `refunded` 后，聊天列表仍显示这一单、打手仍可读 / 写 / 发消息。

**裁定之后的实现摘要**：

> ⛔ **2026-09-28 由 `P0-15` 批注（追加，不改写下表）**：下表里的**判据一行与刻意不用一行
> 在 `P0-15` 下**仍然成立、一字未改**——`isOrderChatClosed` 依旧**只认 `refunded`**。
> 被取代的是**上游怎么到达 `refunded`**：`P0-15` 起**一个订单只退一次**，
> `100%` 退款一步退满（`refundAmount = 实付`），**不存在**「部分退款累计够不到满额」
> 这条缺陷路径，`refundFullRemaining` 与「第二次申请」**已整体删除**。
> ⇒ 本表与下方「只读 1–8」的**落点依然有效**；但 `04-acceptance.md` **§L**（依赖
> 「再走一次售后」与「退满剩余」）**已失效**，该节顶部有 ⛔ 标记。
> 当前口径见 `docs/03-dev/rounds/P0-15/`。

| 项 | 内容 |
|---|---|
| 判据 | `isOrderChatClosed(order.status)`，**只认 `refunded`** |
| **刻意不用**的判据 | `refundedAmount > 0` —— 它在**部分退款**时也成立，会把「退了一半、服务还在继续」的单子当场锁死（裁定第 5 条禁止） |
| 读路径 | **零改动**。退款不清 `actualCompanionId`、不追加释放记录 ⇒ `assignmentKey` 不变 ⇒ 三条腿全部仍成立 |
| 写路径 | 两端各加一个闸，**顺序不同**（用户端在 `assignmentKey` 之前，打手端在归属判定之后），拒绝码 **400**（不是 404） |
| DTO | `OrderConversationSegment.isReadOnly` 计算式扩展 + `CompanionChatListItem/Detail.isReadOnly`（服务端算，页面不重判） |
| retention | **未动**。裁定第 4 条明文「不删聊天、不改 retention」⇒ R4 / `EX-CHAT-04` / `BR-02` / `PR-06` / `Q-EX-07` **继续 `DEFER`** |

**裁定第 6 条六项测试的落点**（详见 `02-decisions.md` §11.5）：
`只读 1`（纯函数）· `只读 2`（accepted 直接全额退款：双方可读 / 双方不可写）·
`只读 3`（`actualCompanionId` **保留但不放行**——**先**断言字段仍等于本人，**再**断言发不出去）·
`只读 4`（serving 全额退款）· `只读 5`（completed 全额退款）·
`只读 6`（**部分退款不影响写权限**，走真实售后链路）· `只读 7`（Staff 调查读取不受影响）·
`只读 8`（源码结构门禁：页面里不得写死 `"refunded"`）+ HTTP 层 2 条。

### 5.3 需产品**追认**（已实现，但超出指令字面）—— **2026-09-27 已逐条追认**

> **登记结论：四项全部由现有实现满足，追认零代码改动。**
> 逐条比对见 `02-decisions.md` §十三（13.1–13.4）；
> 验收档案对应节见 `04-acceptance.md` §五。

| 项 | 内容 | 追认状态 | 详见 |
|---|---|---|---|
| **R1** | 客服「与当前实际打手沟通」的**写入**路径本轮**未实现**（`D5`：客服只读全部段落） | ✅ 已追认 —— 只限制 Staff 对**履约 assignment 会话**的写入；Staff ↔ User 客服会话照旧；**不新增** Staff ↔ Companion 直连 | `02-decisions.md` §十三 13.1 |
| **R2** | 用户端 UI 形态（一个输入框 + 显式「发给 客服 / 打手」选择器），需求明文后置 | ✅ 已追认 —— 用户端按**当前 / 历史**分段，当前段可写、历史段只读 | §十三 13.2 |
| **R3** | 会话**惰性创建**时点与 `cmd §4.1` 字面的取舍 | ✅ 已追认 —— 允许惰性物化；**失败请求不得产生空 conversation**；不改 `assignmentKey` 与权限语义 | §十三 13.3 |
| **R4** | 段落带 `isCurrent`，但用户端**不带**段的护航展示名 | ✅ 已追认 —— 历史段**不强制**显示打手名；Staff 调查视角仍可见 `companionId` / `companionName`。⚠️ 有一处**措辞**差异（用户端标题是「打手沟通 / 打手沟通（历史）」而非「当前服务会话 / 历史服务会话」），**记录在案、不要求改动** | §十三 13.4 |

> **本轮不因追认而做的三件事**（`02-decisions.md` §13.5）：不改任何权限判据、
> 不改任何 DTO 形状、不动 retention。**追认的登记动作本身是零代码改动。**

### 5.4 本轮登记为 NOTE / MINOR（不修或已修）

| 项 | 内容 | 处置 |
|---|---|---|
| **MINOR-1** | 三处注释/文档声称 `toMessageView` 是「全仓唯一转换点」，实际三端各有转换点 | ✅ **已修**（4 文件，**断言零改动**），见 §六.1 |
| **NOTE-B** | 打手聊天列表用 `lastMessageRole === "companion"` 近似 `isSelf` | ⚪ **不修**。今天**可证等价**（一段履约会话只有当前这位打手能写），且与用户端会话列表同做法。**但这是近似不是判据**——将来若同段可能出现多名护航，**必须先给列表 DTO 发送者 id**。见 §九 E6 + §十.3 |
| **NOTE-C** | `removeCompanion` 不释放其已接订单（P0-11 D10 既有取舍） | ⚪ 不修。聊天由 `requireCompanion` 守卫挡住（`removedAt` → not-a-companion 403），**不构成泄漏** |
| **NOTE-D** | 同毫秒写入的顺序不确定（`createdAt` 相同则按随机 uuid 兜底） | ⚪ 不修（测试层面）。已改为**多重集比较**，**没有放宽断言**。见 §九 E5 |

---

## 六、reviewer

### 6.1 首轮结论：**0 BLOCKER · 0 MAJOR · 1 MINOR · 2 NOTE**

只读 reviewer-agent（对照 `docs/01-requirements/` 与 `architecture-rules.md`）。
六条核心承诺的判定依据见 `02-decisions.md` §十.1。

**MINOR-1（已修）**：`lib/constants/conversations.ts` 的 `toMessageView()` 注释、
`api-contract.md` §2.5 表格、以及 `tests/assignmentConversations.test.mjs` 的一条**用例标题**，
都声称「这是全仓**唯一**的消息 DTO 转换点，用户端与打手端都调它」。
事实是三端各有转换点（用户 `toMessageView` / 打手 `toCompanionChatMessage`(模块私有) /
客服 `toStaffConversationMessage`）。

**为什么值得修**：「唯一转换点」是本项目的**架构不变量话术**
（`tests/staffReleaseHistory.test.mjs` 甚至用「数出现次数」强制单实现）。
在一个**不成立**的地方用它，会让下一位开发者以为「改一处三端一起变」——
而这正是「一端脱敏了、另一端忘了」得以发生的心态。
**安全目标本身是达成的**（三处都是逐字段显式挑，审查已核实），错的是那句话。

**整改**（4 个文件，**断言零改动**）：注释与文档改为陈述真实原则
（「每条出站路径自己显式挑字段，没有共享函数兜底」）；用例**只改标题**并在其上注明原因。

### 6.2 审查明确核实**无问题**的维度

完整列表见 `02-decisions.md` §十.4。其中最关键的几条：

- **`assignmentKey` 的结构性失效**：`releaseCurrentAssignment` 一处定义 + 4 个调用点
  （`cancelAcceptedOrder` · `releaseOrderByStaff` · `replaceOrderCompanionByStaff` ·
  `releaseOrdersForCompanion`）**全部**追加 release 记录；换人 / 回池 / **停用**都会当场递增序号。
  ⇒ **不存在「某条释放路径忘了失效」**。
- **A→B→A**：第三个 assignment **确实新建**，不是复用第一段。
- **四路由同判据**：list / detail / **send** / **read** 全部走①②③（`read` 用不建会话的变体）。
- **封禁三态区分正确**：`enabled=false` 失权 ✓ · `removedAt` 失权 ✓ ·
  `available=false`（暂停接单） **正确仍放行** ✓（符合 `EX-SERVICE-05`）。
- **测试不是恒真**：`DTO 38` 的键集合断言**增删都会红**；
  「`toMessageView` 去掉 `conversationId`」那条**先断言内部记录确有 `conversationId`**，不是自证。

### 6.3 审查**无法判断**的

无。TBD-P0-14-1 已作为「需产品决定」登记，不是需要猜的东西。

### 6.4 第二轮（`TBD-P0-14-1` 裁定 fix）：**0 BLOCKER · 0 MAJOR · 0 MINOR · 6 NOTE**

只读 reviewer-agent（opus）对裁定 fix 的完整实现做了 11 点逐条核对（7 条裁定规则、
400 vs 404 与信息泄漏、被拒写的副作用与幂等键、DTO 隐私、两套角色词、测试可证伪性、
**刻意漏掉的面**、批次约束）。结论：**7 条裁定规则全部落地，未发现 BLOCKER / MAJOR / MINOR**。

审查**已核对并确认正确**的关键点（原文摘要）：

- **读路径没有任何一条加了状态拦截**：用户端只把 `order.status` 传进 `buildConversationSegments`
  用于算 `isReadOnly`，从不返回 4xx；打手端只算 `isReadOnly` 并换 `notice`；
  客服端 `getStaffConversationDetail` / `toStaffConversationSegments` **根本没有 status 参数**。
- **`isOrderChatClosed` 全仓唯一**（1 处定义 + 2 处调用），无第二份拷贝——
  即 memory 里 P0-5 那个「第三份拷贝」风险**没有重演**。
- **状态只由金额写原语决定**：`applyOrderRefund` 是
  `nextRefundedAmount >= actualPaidAmount ? "refunded" : order.status`；
  `approveRefund` 用 `isFullyRefunded(...)`。因此**部分退款不改状态**，聊天继续可写。
- **被拒请求既不写消息、也不占幂等键**（幂等键只在 `createMessage` 原子区段内、
  且仅真正写入时才登记；退款闸在它之前）。
- **DTO 隐私**：`isReadOnly` 只出现在用户段 DTO 与打手列表/详情 DTO；
  客服段 DTO **没有** `isReadOnly`（客服端不存在「只读」这个概念）。
- **入口不设状态门是正确的**：用户订单详情 `canOpenConversation: true` 恒真、
  `queryOrdersByCompanion` 不过滤状态——**未发现任何一处应设闸而漏设**。
- **测试可证伪性（如实结论）**：只读 1–6 去掉实现都会红；只读 7/8 守的是
  「将来不要过度实现」（防有人给客服端也加状态闸、防页面硬编码 `"refunded"`），
  审查明确说**这不算缺陷**。

**6 条 NOTE 的逐条处置**：

| # | 内容 | 处置 |
|---|---|---|
| **NOTE-1** | 只读 8 是**结构断言**不是行为测试（只扫源码里有没有硬编码 `"refunded"`） | ⚪ **不修**。它自己就是这么写的，边界已在用例注释里声明；行为侧由只读 1–6 负责 |
| **NOTE-2** | 没有测试**直接**断言「被拒的发送不占用幂等键」 | ⚪ **不修**。结构上安全（幂等键在 `createMessage` 内、写入成功才登记）。⚠️ 本轮已补的「只读 9」覆盖的是**会话**不被建出来，**不是**幂等键——两者别混为一谈 |
| **NOTE-3** | 退款闸到 `createMessage` 之间跨 `await`（Mock 单线程安全，真实 DB 迁移时的 TOCTOU 假设） | ⚪ **不修**（与仓库既有伪事务同款假设，非本批次新债），登记备查 |
| **NOTE-4** | **打手发消息前会惰性创建空会话**：退款闸排在 `resolveChatContextWithConversation`（会建会话）之后 | ✅ **已修**（**与 reviewer 独立同时发现**，见 §10.4）。改为先 `resolveChatContext`（不建会话）过闸、过了才建。**新增「只读 9」钉住**，并做红-绿证伪（回退该重排 → 只读 9 红，35/36） |
| **NOTE-5** | 「订单沟通」入口提示文案轻微过时（退款后「打手」那一项已不可发） | 🟡 **部分修**（见 §10.5）。把写死的角色词抽成 `CONVERSATION_ENTRY_HINT` 并把「必须取自常量」写进门禁；**措辞按状态分档刻意不做**，理由见 §10.5 |
| **NOTE-6** | `COMPANION_ORDER_REFUNDED_MESSAGE` 的注释说「用『护航』而不是『打手』」，但字符串**不含任何角色词** | ✅ **已修**。注释改为「**刻意不含角色词**，不要『统一措辞』往里加一个」，并说明读它的人就是本人、主语天然是「你」 |

审查**无法判断**的：无。裁定 7 条规则都有明确可执行口径，**不需要产品再决定任何事项**。

### 6.5 第三轮（对整改增量的重审）：**0 BLOCKER · 0 MAJOR · 0 MINOR · 5 NOTE**

第一轮审查之后代码又改了四处（§10.4 写闸零副作用 / §10.5 抽入口文案常量 /
两条文案区分 / NOTE-6 注释），因此在**最终树**上重开了一次**只读**审查，
逐项核 A–E（写闸重排 / 两条文案 / 入口常量 / 注释 / 新增测试），结论：

**A–E 全部通过。** 该 agent 独立复核了本仓库最要紧的那条性质——**反存在性预言机**：
`resolveChatContext` 对「订单不存在 / 不是本人 / 算不出段 / 会话归他人」四种失败
**统一返回 `null`**，调用方一律 404，退款闸（400）只在归属成立**之后**才可能到达；
并确认幂等键仍只被 `createMessage` 消费一次、被拒路径在它之前抛错（**键不被消耗**）。

**对第二轮 6 条 NOTE 的处置判定**（第三方复核我的整改，不是我自我评价）：

| 上轮 NOTE | 第三轮判定 |
|---|---|
| 1 只读 8 是结构断言 | **部分改善**——补了行为级的只读 9 与「打手首条直发」，关键路径已从结构断言升级为行为测试 |
| 2 无「被拒发送不消耗幂等键」用例 | **仍存在**（低风险；行为由代码结构保证，且退款单永久只读、无「重试后仍可写」的后续） |
| 3 退款闸到 `createMessage` 跨 await | **仍存在，非本批次新债**——重排未消除也未新增一类；Mock 单线程不可观测，属「Mock→真实 DB」迁移风险 |
| 4 发消息前惰性建空会话 | **已修掉** |
| 5 入口提示文案过时 | **部分修掉**（入口已常量化并进门禁；同页「护航收益」按冻结字段名刻意不动） |
| 6 注释与字符串不一致 | **已修掉** |

**第三轮新提的 5 条 NOTE，逐条处置：**

| # | NOTE | 处置 |
|---|---|---|
| 1 | 源码探针可被字符串拼接绕过（`includes("与客服")` 同理） | **不修，登记**——本仓库测试不剥 JSX，组件渲染无自动化断言，结构断言是这一约束下的上限（与上轮 NOTE-1 同类） |
| 2 | 只读 10 只防「同文」、不防「放错位置」 | **补人工验收项**——§K 的 K4 已写明「两句话各自在正确位置、且不同文，出现同文即 FAIL」，并注明这条**只能靠人眼看**（`04-acceptance.md` §K 下注） |
| 3 | 「退款 + 非本人 → 404 而非 400」无直接用例 | ✅ **已补**：新增**只读 11**（§10.8），并做**受控 mutation 红-绿** |
| 4 | `03-delivery.md` §10.1 表格仍写 footer「打手端说『护航』」 | ✅ **已改**：footers 终稿**不含角色词**，该格已更正并加注说明（说「护航」的是**页顶**那条） |
| 5 | `beforeEach` 未重置 `refund` / `earning`，同进程重跑会因「已审批」再红一次 | ✅ **已修 + 实测复现**：补上两条 `resetMockStore`，并用一次性探针**复现**了那个隐患（见 §10.8） |

审查**无法判断**的：无（原文「A–E 均可从代码与测试完整核对」）。

> ⚠️ 这三轮审查**都是只读**的：没有任何一个 reviewer 改过仓库里的文件，
> 所有的整改都由本会话完成并**逐条做了红-绿或实测验证**。

---

## 七、本轮**没有**做的事（明确声明，避免被读成遗漏）

1. ❌ **没有**建立完整 Assignment 聚合（无新实体 / 新仓储 / 新伪事务）。
2. ❌ **没有**改 `OrderStatus` 状态机（本轮无任何订单状态迁移）。
3. ❌ **没有**改 `companionOrderTransaction.ts` / `adminRefundTransaction.ts`（**零字节**）。
4. ❌ **没有**实现图片、附件、WebSocket、实时推送（`cmd §十三`）。
5. ❌ **没有**写任何聊天删除 / retention 路径（`DEFER`）。
6. ❌ **没有**实现客服向 assignment 会话的写入（`D5`，登记为 R1）。
7. ❌ **没有**开始 `P0-15`。
8. ❌ **没有**执行任何 Git 写操作。

---

## 八、Git 状态（**只读观测**）

```
分支：feat/order-lifecycle-alignment
HEAD：c2c9360  （= 开工时基线，本批次未产生任何提交）
```

**已跟踪修改 26 个**：
`app/(mobile)/orders/[id]/page.tsx`（📌 仅有这个文件是 **P0-14 交付之后**才进入改动集的，
原因是裁定 fix 的 NOTE-5 整改，见 §10.5）·
`app/(mobile)/service/chat/[orderId]/page.tsx` · `app/companion/(console)/orders/[id]/page.tsx` ·
`components/service/OrderChat.tsx` · `components/staff/StaffConversationConsole.tsx` ·
`docs/02-tech-design/api-contract.md` · `docs/03-dev/总需求进度表.md` ·
`docs/03-dev/需求功能点进度表.md` · `lib/constants/companionConsole.ts` · `lib/constants/service.ts` ·
`lib/constants/staff.ts` · `lib/data/messageRepository.ts` · `lib/data/mockMessageRepository.ts` ·
`lib/mocks/fixtures/messageSeed.ts` · `lib/services/adminOrders.ts` · `lib/services/companionHttp.ts` ·
`lib/services/conversations.ts` · `lib/services/orders.ts` · `lib/services/serviceHttp.ts` ·
`lib/services/staffConversations.ts` · `lib/types/message.ts` · `lib/types/staff.ts` ·
`tests/companion.test.mjs` · `tests/companionAccess.test.mjs` · `tests/companionConsoleNav.test.mjs` ·
`tests/staffReleaseHistory.test.mjs`

**未跟踪新增**：
`app/api/companion/conversations/`（4 个 `route.ts`）· `app/companion/(console)/chats/`（2 页）·
`components/companion/CompanionChatConsole.tsx` · `lib/constants/conversations.ts` ·
`lib/services/companionConversations.ts` · `lib/types/companionChat.ts` ·
`tests/assignmentConversations.test.mjs` · `tests/companionChatHttp.test.mjs` ·
`docs/03-dev/rounds/P0-14/` · `docs/03-dev/rounds/cmd_p0-14.md` ·
`docs/03-dev/rounds/start_p0-14.txt` · `.claude/hooks/`

**Git Commit**：`—`（本批次禁止 Git 写操作，此处留空是**正确状态**）

---

## 九、收尾档案同步（2026-09-27，**只改文档，零代码改动**）

| 动作 | 文件 |
|---|---|
| 写齐本轮交付记录 | `03-delivery.md`（本文件） |
| 写齐人工验收清单 | `04-acceptance.md` |
| 回填交付摘要 + Status → `AWAITING_ACCEPTANCE` | `README.md` |
| 追加 reviewer 结论与整改 | `02-decisions.md` §十 |
| API 契约：三端转换点陈述更正 + §8 表 5→12 + 总数 131→135 | `docs/02-tech-design/api-contract.md` |
| 进度表回填 | 两份进度表 |

**状态**：`AWAITING_ACCEPTANCE`。⚠️ **Claude 不得自行 `DONE`**——等待产品负责人人工验收。

---

## 十、验收前 fix：`TBD-P0-14-1` 裁定落地（2026-09-27）

**性质**：产品裁定之后的**验收前 fix**，**不是**新一轮。没有新开 Round，没有开始 `P0-15`，
没有任何 Git 写操作（`cmd_p0-14.md` §十八）。

### 10.1 改了什么（12 个既有文件，**零新增文件**）

| 层 | 文件 | 改动 |
|---|---|---|
| 判据 | `lib/constants/conversations.ts` | 新增 `isOrderChatClosed(orderStatus)`；`buildConversationSegments` 增加 `orderStatus` 参数；`isReadOnly` 计算式扩展；新增 `CONVERSATION_SEGMENT_REFUNDED_NOTICE` |
| 文案 | `lib/constants/service.ts` | 新增 `MESSAGE_ORDER_REFUNDED_MESSAGE`（用户端说「打手」） |
| 文案 | `lib/constants/companionConsole.ts` | 新增 `COMPANION_CHAT_READONLY_FOOTER`（⚠️ **不含角色词**，见下注）、`COMPANION_CHAT_LIST_READONLY_LABEL` |
| 写闸 | `lib/services/conversations.ts` | 用户端 `sendMessageForUser` 的 `current` 分支加退款闸（排在 `assignmentKey` **之前**） |
| 写闸 | `lib/services/companionConversations.ts` | 打手端 `sendMessageForCompanion` 加退款闸（排在归属判定**之后**）；DTO 产出 `isReadOnly`；`notice` 只读时替换 |
| DTO 类型 | `lib/types/message.ts` | `isCurrent` 文档**反转改正**（三种组合表）；`isReadOnly` 文档扩写 |
| DTO 类型 | `lib/types/companionChat.ts` | 列表项与详情各加 `isReadOnly` |
| 界面 | `components/companion/CompanionChatConsole.tsx` | `isReadOnly` prop；只读时**整块替换**输入区为一行说明 |
| 界面 | `app/companion/(console)/chats/page.tsx` | 只读角标「已退款 · 只读」 |
| 界面 | `app/companion/(console)/chats/[orderId]/page.tsx` | 透传 `isReadOnly` |
| 界面 | `components/service/OrderChat.tsx` | 用户端段落说明按 `isCurrent` 二选一（已退款 / 已换人） |
| 测试 | `tests/assignmentConversations.test.mjs` · `tests/companionChatHttp.test.mjs` | 见 §3.2 增量 |

> ⚠️ **上表初稿的 `COMPANION_CHAT_READONLY_FOOTER` 一格曾写「打手端说『护航』」——已更正**：
> 该 footer **刻意不含任何角色词**（终稿为「已全额退款，无法继续发送消息。」），
> 说「护航」的是**页顶**那条 `COMPANION_CHAT_REFUNDED_NOTICE`。两条同屏、位置不同、
> 文案也必须不同（§10.6 / 用例「只读 10」）。第三轮只读审查的 NOTE-4 指出此处
> 文档小字过时，本节已改。

### 10.2 红-绿证伪（**测试确实会红**，不是恒真）

按 `verification-before-completion`：新增测试必须在**判据被破坏时变红**，否则不构成回归保护。

| 操作 | 结果 |
|---|---|
| 把 `isOrderChatClosed` 桩成恒 `false` | **5 红 / 29 绿**（只读 2/3/4/5/6 全红）——裁定第 6 条那六项**都受这条判据保护** |
| 把触发条件放宽成 `refunded \|\| serving` | **只读 6 红**（3 红 / 31 绿）——它**单独**负责「判据不是金额」 |
| 从 `/tmp/conv.bak` 还原 | 相关区段**逐字节一致**，复跑 **34 / 34 绿** |

> ⚠️ 上表两条 mutation 的读数（`5 红 / 29 绿`、`3 红 / 31 绿`、`34 / 34`）是**当时**的用例数——
> 那时本文件共 34 条。之后又补了 3 条（只读 9 / 只读 10 / 「打手没先打开聊天页也能直接发出第一条」），
> 故**当前**总数是 **37**，其红-绿见 §10.6。历史读数**不回头改**（改了就变成伪造证据），
> 只在此注明它属于哪个时点。

### 10.3 明确**没有**越界做的事

1. ❌ **没有**回答聊天 retention / 保留多久 / 要不要删（裁定第 4 条明文禁止本轮决定）——**继续 `DEFER`**。
2. ❌ **没有**新增任何删除 / 归档 / 过期逻辑。
3. ❌ **没有**改 `OrderStatus` 状态机（读 `order.status`，不写）。
4. ❌ **没有**清 `actualCompanionId`（裁定第 2 条要的正是「留着但不再是充分条件」）。
5. ❌ **没有**改 `companionOrderTransaction.ts` / `adminRefundTransaction.ts`（**依然零字节**）。
6. ❌ **没有**开始 `P0-15`，**没有**任何 Git 写操作。

### 10.4 被拒的写必须**零副作用**（reviewer NOTE-4，与审查同时独立发现）

`sendMessageForCompanion` 原先的次序是「**先确保会话存在** → 再判退款 → 再写」。
`resolveChatContextWithConversation` 会**惰性建会话**，于是一次**被 400 拒绝**的发送，
在「订单已退款、且打手从未打开过聊天页」的路径上会**真的建出一段空会话**。

- **为什么是缺陷**：本项目对「状态闸拒绝」的既有约定就是**零副作用**——
  `cmd_p0-13` 的 `D22` 明文写着「其余档位 400 **且零副作用**」。
  退款闸排在建会话之后，等于新开了一个不遵守该约定的口子。
- **为什么原来没被发现**：建出来的是**空**会话，而列表按**订单**取行
  （`listCompanionChats` 走 `queryOrdersByCompanion`），**空会话看不出来**——
  没有任何界面会因此变化，因此没有任何一条既有的端到端断言会红。
- **改法**：先 `resolveChatContext`（**不建会话**）过闸 → 闸过了才建。
  归属判定仍在退款闸**之前**（反存在性预言机的性质不变）。
- **代价**：多出一个分支。因此**同时补了三条测试**（见 §3.2 与 §10.6），
  并用**受控 mutation** 验证两侧都会红。

### 10.5 抽 `CONVERSATION_ENTRY_HINT`：门禁没扫到 ≠ 没有第二份来源（reviewer NOTE-5）

`app/(mobile)/orders/[id]/page.tsx` 的「订单沟通」入口把 **`"与客服 / 打手沟通"` 写死在页面里**。
那个页面**不在**「页面里不许写死角色词」那道源码门禁的名单里——
而**门禁的范围是一份名单**，名单漏掉一个文件，不等于那个文件里就没有角色的第二份来源。

**已做**：抽出 `CONVERSATION_ENTRY_HINT = \`与客服 / ${MESSAGE_ROLE_LABELS.companion}沟通\``
（`lib/constants/service.ts`，与 `MESSAGE_ROLE_LABELS` 同一个文件），页面改为引用它；
门禁新增第 4 条：该页**必须**引用常量，且**整句文案不得内联**。

> ⚠️ 只断言「引用了常量」是**防不住**的：把用法换回字面量、留下那行 `import`，
> 断言照样绿（**受控 mutation 实测：第一版探针没红**）。因此补了
> `orderDetailPage.includes("与客服") === false` 这条。两版探针的红-绿都跑过。

**刻意不做**：同一页的金额行标签 **「护航收益」** 没有动。理由：

1. 它**不是**随手写的——`lib/types/order.ts:323` 的分账口径注释明文写着
   「用户可见，用于『**护航收益** ¥40』这一行」，改名是**改产品文案**，
   而本轮裁定只谈聊天的读 / 写权限，不含改钱的名字；
2. 判据同一处的原则（用例「只读 8」）意味着**页面不许自己拿 `order.status` 再判一次**，
   要让入口说明按退款状态分档，得往订单详情 DTO 的 `allowedActions` 加字段——
   那是下一批的事。

> ⚠️ **本节初稿有一处错误说法，已更正**：初稿写「该行已被既有技术债『上线前移除用户端分账比例暴露』
> 覆盖」——**不成立**。`需求功能点进度表.md:324` 那条技术债管的是用户端 DTO 里的
> **`companionRateSnapshot`（比例字段本身）**，与「护航收益」这行**金额标签**是两件事
> （该条技术债自己就写着「分账比例虽未在页面渲染」）。因此上面第 1 条**是唯一**的依据。

⇒ 因此**只**把「入口说明必须来自常量」写进门禁，**没有**把整页加进「不许出现角色词」那份名单。

### 10.6 裁定 fix 新增/改动的测试与红-绿证伪

| 用例 | 守什么 | 红-绿 |
|---|---|---|
| 只读 9 | 被拒的发送**零副作用**（会话不被建出来），并**反向对照**「读路径**应当**建」以证明不是恒真 | 回退闸序 → **35/36，只读 9 红** |
| 只读 10 | 页顶说明与底栏说明**不是同一句话**（同屏不许重复显示） | 把两条改成同文 → **35/36，只读 10 红** |
| 打手：没先打开聊天页也能直接发出第一条 | 守住 §10.4 引入的**新分支**（建了再发那一侧） | 把该分支改成恒 `null` → **36/37，该条红** |
| 称呼来源 第 4 条 | 入口说明必须取自常量、整句不许内联 | 换回字面量 → **36/37，该条红**（⚠️ 第一版探针**没红**，见 §10.5） |

**四条都做了受控 mutation，改坏必红，还原后 37/37 绿**（当时 37；再加只读 11 后为 38，见 §10.8）。

### 10.7 明确**没有**越界做的事（补）

7. ❌ **没有**给客服端加任何状态闸（客服段 DTO 连 `isReadOnly` 都没有）。
8. ❌ **没有**在页面上重算写权限（`orderStatus === "refunded"` 只出现在服务端一处）。
9. ❌ **没有**给用户端订单详情页加「退款后入口说明变样」的分档（理由见 §10.5）。

### 10.8 第三轮只读审查 NOTE-3 / NOTE-5 的处置（2026-09-27 收尾）

**（一）NOTE-3 ⇒ 补一条「反向预言机」用例：只读 11。**

原有用例覆盖了「非本人 → 404（非退款单）」与「本人退款 → 400」，
但**没有**「**退款单 + 非本人** → 404 而非 400」这一格——而这恰恰是
**闸序**（退款闸排在归属判定之后）唯一能守的东西：闸若被提到归属判定之前，
**任何不相干的护航拿别人的订单号发一条消息**，就能从 400 / 404 的区别里
读出「这张单退没退款」。这是一个**只读的订单状态预言机**，
而功能测试会**全绿**——只有这一格会红。

用例同时带**反向对照**（同一条订单、同一个动作，本人来发**确实**是 400），
否则「必须是 404」可能只是因为整条发送路径都坏成了 404；
并断言两种拒绝**必须是两句不同的话**，否则「同形」无从谈起。

**红-绿（受控 mutation）**：把退款闸提到归属判定**之前**
（在 `sendMessageForCompanion` 里先 `getPaymentRepository().findOrderById` 再判
`isOrderChatClosed`）⇒ **37 / 38，且红的只有只读 11 这一条**；
`cp /tmp/cc.bak` 还原后 `diff` **逐字节一致**，复跑 **38 / 38 绿**。

**（二）NOTE-5 ⇒ 补两条 `resetMockStore`**（并且**实测**了那个隐患真的存在）。

`beforeEach` 原先重置 7 个 store，**不含 `refund` / `earning`**——
而这两个 store 正是退款链路会写的。后果：「只读 5」拿**预置**的待审申请
（`rf-seed-1003-01`）去退一张预置的已完成订单；这条用例一旦失败并被
**同进程重跑**（`node --test-rerun-failures`），那张申请已经是「已审批」，
重跑会以一个**与真实缺陷无关**的理由再红一次——**失败信号被污染成噪声**。

⚠️ 这一条**没有**停在「分析上成立」：临时摘掉那两行重置、并临时追加一条
与「只读 5」争用同一份预置退款申请的探针，实跑得到
`ApiError: 当前状态是「已通过」，不能执行这个操作`（**探针红，其余 38 绿**）；
恢复重置后探针绿。探针与该实验已在同一轮内**全部删除**
（`grep -c PROBE` = 0），`/tmp/ac.bak` 还原后复跑 **38 / 38 绿**。

⇒ 结论：这不是「理论上可能」，而是**实测可复现**的脆弱性，**已修**。
