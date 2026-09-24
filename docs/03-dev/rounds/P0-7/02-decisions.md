# P0-7 · 02-decisions.md

Round ID: P0-7
Title: `accepted → serving`（打手「开始服务」）
Status: AWAITING_ACCEPTANCE

> 本文件只记录**本轮开始前**的 Requirement Check 结论与**实现口径**（D1–D8）。
> 发现的新事实在末尾「追加记录」里写，**不改写上面已经定下的口径**
> （`development-workflow.md` 的 `02-decisions.md` 是 append-only）。

---

## 结论先行

- **没有任何 `Status: OPEN` 决策**，**不进入 `CLARIFYING`**。
- 产品规则（谁能在什么状态下开始服务、不允许哪些自动路径）由
  `docs/01-requirements/超哥电竞_业务流程表.md` 的 **BF-17** 冻结，与本轮指令 `01-prompt.md` §二**逐条一致**；
- 接口形态由 `docs/02-tech-design/api-contract.md` §3.1 的 TARGET 行冻结
  （`POST /api/companion/orders/[id]/start` + `requireCompanion` + 服务模块 `companionOrders`），
  本轮**照抄落地**，不自己换地址、不自己换模块；
- **唯一一处「指令提到、但权威文档没冻结」的事是通知**：`01-prompt.md` §七 要求
  「若未冻结，不要自行新增产品通知」，而需求里确实没有为「开始服务」冻结任何通知 →
  **本轮不加通知**（见 **D6**，含检索证据）。这不是一个待确认的产品问题，
  而是指令已经把「未冻结时该怎么做」写清楚了。

---

## 一、Requirement Check

| # | 检查项 | 结论 | 依据（已逐条核对到行） |
|---|---|---|---|
| 1 | 「开始服务」是否已冻结？ | ✅ 已冻结 | `docs/01-requirements/超哥电竞_业务流程表.md:534` 「# 11. 开始服务」/ `:536` 「## BF-17 accepted → serving」/ `:544`「对应的实际打手点击“开始服务”」/ `:549` 状态转换 `accepted → serving` |
| 2 | 触发者是谁？ | ✅ 唯一：当前 `actualCompanionId` | 同上 `:538-546`；`:474`（另一条需求）明确「只有当前 `actualCompanionId` 对应的打手可以…」，同一归属口径 |
| 3 | 有没有「自动开始」的合法路径？ | ✅ **没有**，且需求显式列了 5 条禁止路径 | `:551-558`：不得按时间 / 预约备注 / 打开页面 / 聊天自动开始，不得客服代替 |
| 4 | 前置状态？ | ✅ **恰好 `accepted`** | `:549`（起点是 accepted）；`:56`（`serving` = 正在履约）；`:55`（`accepted` = 已有实际打手接单，但尚未开始服务） |
| 5 | 中央状态机是否允许这条边？ | ✅ 允许 | `lib/constants/orders.ts:96` `accepted: ["paid", "serving", "refunded"]`；`canTransitionOrder` 在 `:111` |
| 6 | 订单模型有没有承载它的字段？ | ✅ 有，且**不需要新增字段** | `lib/types/order.ts:69-70`：`acceptedAt: string \| null` / `servingAt: string \| null`（注释：「未发生时为 null，详情页只展示已存在的节点」） |
| 7 | 用户端 / 后台会不会自动显示 `serving`？ | ✅ 会，无需改动 | `lib/services/orders.ts:44-50` 的 `TIMELINE_SOURCE` 已含 `{ key: "serving", at: (order) => order.servingAt }`（`:47`）；`lib/constants/orders.ts:22-30` 的 `ORDER_STATUS_LABELS.serving = "护航中"`、`:44-50` 的 `ORDER_STATUS_CLASS.serving`、`:54-60` 的 `ORDER_STATUS_HINTS.serving` 全部已存在 |
| 8 | 接口地址 / 守卫 / 服务模块是否已冻结？ | ✅ 已冻结 | `docs/02-tech-design/api-contract.md:507`：`POST /api/companion/orders/[id]/start` \| `requireCompanion`（预期）\| `companionOrders` \| `accepted → serving`；共同约束在 `:511-516` |
| 9 | 详情页落点是否已定？ | ✅ 已定：**同一个详情页** | `api-contract.md:518`「打手端页面入口：`/companion/orders`、`/companion/orders/[id]`」+ `:520`「同一个详情页继续承载 `accepted` 的“开始服务”和 `serving` 的“提交完成材料”，**不得**为后续阶段复制第二套订单详情」 |
| 10 | 幂等 / 并发要求是否冻结？ | ✅ 已冻结（结果级） | `api-contract.md:515`：幂等/并发下只允许**一次真实状态推进**，不重复通知，**不刷新已经成功写入的时间** |
| 11 | 是否有为「开始服务」冻结的生命周期通知？ | ❌ **未冻结** → 本轮不加 | 见 **D6** 的检索证据 |
| 12 | Manifest 门禁怎么处理？ | ✅ 指令已明确要求同步 | `api-contract.md:516`「新增 Companion API 落地时必须同步扩充 `tests/companion.test.mjs` 的 manifest」；当前负向门禁在 `tests/companion.test.mjs:338-364` |
| 13 | 有没有与需求冲突的既有实现？ | ✅ 没有冲突，且**当前完全没有实现** | `grep -rn '"serving"' lib app components`（排除种子）只命中：状态枚举、中央状态表、退款规则表、用户端 `TIMELINE_SOURCE`、状态文案——**没有任何写入口**；`lib/data/mockPaymentRepository.ts` 只有 `applyOrderAccepted`（`:222`）/ `applyOrderAcceptanceReleased`（`:273`）/ `applyOrderRefund`（`:309`）三个订单写入器，**没有** serving 写入器 |
| 14 | 有没有需要向产品确认的 TBD？ | ✅ 没有 | 触发者、前置状态、结果状态、时间字段、幂等语义、页面落点、通知（指令已给出「未冻结就不做」的处置规则）全部有明确答案 |

**结论：Requirement Check 通过，直接开发。**

---

## 二、本轮要满足的 16 条测试要求（`01-prompt.md` §八）与落点

| # | 指令要求 | 落在哪 |
|---|---|---|
| 1 | actualCompanion 可以 start 自己的 accepted 订单 | `tests/companionServing.test.mjs` 开始 1 |
| 2 | 非 actualCompanion 不能 start | 开始 4(a)（另一位护航） |
| 3 | 普通 User 不能调用 Companion start API | HTTP 用例 1（未登录 401）· 2（已登录非打手 403）· 3 |
| 4 | `accepted → serving` | 开始 1（状态断言） |
| 5 | `servingAt` 正确写入 | 开始 1（等于传入的 `at`）· 开始 2（接口返回的与写进订单的是同一个时刻） |
| 6 | `actualCompanionId` 不变 | 开始 1 |
| 7 | `acceptedAt` 历史不丢 | 开始 1（值逐字不变）· 开始 7 |
| 8 | `serving` 不能再次 start | 开始 3（新建单）· 开始 3b（预置 serving 单）：重放不报错、**不刷新 `servingAt`**、无重复副作用 |
| 9 | `paid` / `completed` / `refunded` 不能 start | 开始 5（三种状态各一条） |
| 10 | start 后取消按钮不可再用 | 开始 6（`cancelAcceptedOrder` 返回 `not-accepted`）+ 门禁（`canCancel === false`） |
| 11 | start 后订单仍属于当前 Companion | 开始 7（列表 / 详情仍返回它） |
| 12 | 其他打手无法操作 | 开始 4(a)(d) · 开始 7(4) · HTTP 用例 3(b)（他人调用一律 `not-found`） |
| 13 | route manifest gate 更新 | `tests/companion.test.mjs`（清单 + 正/负向门禁改写）· 开始 11（写入口集合） |
| 14 | 状态机结构允许但不能替代 ownership / status Guard | 开始 8（`canTransitionOrder("accepted","serving") === true` 而服务仍拒绝非本人 / 非 accepted） |
| 15 | P0-6 主动取消链不回归 | 开始 9 + `tests/companionOrders.test.mjs` 全量通过（⚠️ **本轮改写了它两条既有断言**，见 `03-delivery.md` §五：改写是**强化**，不是用来把这条要求做绿的） |
| 16 | P0-6.1 排序不回归 | `tests/companionPoolOrder.test.mjs` 全量通过（该文件**本轮一个字节未改**） |

> ⚠️ **上表在实现后校正过一次**（不是覆盖历史，只是把「计划落点」对齐到「实际用例名」）：
> 开工时按设想写的用例号与最终用例号并不一致（重放被写在了「用例 4」，实际是 **开始 3**），
> 而 #15 那一行原写「**不改它的既有断言**」——实现完成后**与事实不符**，
> 本轮确实改写了 `tests/companionOrders.test.mjs` 的两条断言。改写的性质与前后对照
> 记在 `03-delivery.md` §五，此处只把它标成事实，不重复论证。

---

## 三、决策

### D1 伪事务落点：`lib/data/companionOrderTransaction.ts`（同一个域模块，不新建文件）

`api-contract.md:507` 已经把服务模块钉成 `companionOrders`；数据层这边，
`lib/data/companionOrderTransaction.ts` 的头部写着「**打手订单域的伪事务**」——
「开始服务」与「主动取消接单」是同一个域的两个动作，共用同一份原子性依据
（Node 单线程 + 段内不许 `await`）与同一套「先验证意图、再原子写事实」的判定顺序。

**不新建 `companionServingTransaction.ts`**：那会让「打手订单动作」这一个域有两个文件，
两边各自的头部注释都要重复论证同一件事的原子性；而 `lib/services/companionOrders.ts`
的模块注释已经为「列表 / 详情 / 取消三件套走同一模块」给过同一个理由——
「拆成两个模块就迟早会有一边判错归属」。

⚠️ **连带必须改掉的三处「唯一入口」表述**（不改就是文档说谎）：
`lib/data/companionOrderTransaction.ts:19`（「当前唯一的公开入口是「主动取消接单」」）、
`docs/02-tech-design/directory-structure.md:349`（「本轮只有 `cancelAcceptedOrder` 一个公开入口」）、
`tests/companion.test.mjs:102`（「全轮**唯一**的**写**入口」）。

### D2 幂等：**状态即幂等键**，本轮**不引入新的幂等键字段**

`api-contract.md:515` 要的是结果级约束（只允许一次真实推进、不刷新已写入的时间），
而 `acceptDispatch`（`lib/data/companionDispatchTransaction.ts:206`，重放分支在 `:222`）
已经给出这个域里**现成**的重放模式：**用状态本身当幂等判据**——
「已经是 `serving` 且是我的单」就是重放，原样返回、**一个字节都不写**。

**为什么不给 start 加 `idempotencyKey`**：

- 取消需要键，是因为它**结束一段绑定**并要返回「第一次写的那条退出历史 id」
  （`lib/data/companionOrderTransaction.ts:196-219`）——键让第二次到达能找回**第一次的结果**；
  而 start 是一次**只有结果状态、没有附属记录**的推进，状态本身就是那次结果；
- 需求 / 技术设计**没有**为这个接口冻结任何请求体字段（`api-contract.md:507` 只有一行 URL），
  自己发明一个「必填幂等键」等于给客户端加一条服务端文档里不存在的规则；
- 指令 §四 明确「优先复用现有动作的幂等/安全重放模式，**不为本轮新建通用幂等框架**」。

⚠️ 因此 start 的**请求体为空**，客户端也不生成任何键。

### D3 取键与判定顺序：ownership 先行，状态其次，结构校验与领域 Guard 并存

顺序（全部在**同一段同步代码**里）：

```
1. 订单不存在 / actualCompanionId ≠ 我        → not-found（对外 404，不泄露存在性）
2. status === "serving"                        → replayed（已经是我的服务中订单，不写）
3. 结构校验 canTransitionOrder(status,"serving") → false 则 not-startable（对外 400）
4. 领域 Guard：status 必须恰好是 "accepted"     → false 则 not-startable（对外 400）
```

- **第 1 步先于第 2 步**：归属是**事实**，状态只是它的属性；先看状态会让别人拿订单 id
  试探出「这一单已经开始服务了」。
- **第 3、4 步今天在同一个集合上成立**（走完第 2 步之后，结构表允许的只剩 `accepted`），
  这不是冗余而是**语义不同**的两道门（指令 §三 明确要求二者并存）：
  结构表回答「这条边存不存在」（将来状态表变了，它先知道），
  领域 Guard 回答「这一单此刻就站在这条边的起点上吗」。
  ⚠️ **不得**因为「看起来重复」删掉其中一条，也**不得**用第 3 步替代第 4 步
  ——「状态机允许」不是权限（指令 §八 第 14 条要求的正是这件事）。
- **不因状态机允许其它迁移而开放其它动作**：`serving → paid/completed/refunded` 都在表里，
  本轮**一个都不开**（`serving` 的普通取消是明确的不做项）。

### D4 写入器：`applyOrderServing`（新）放在 `mockPaymentRepository.ts`，与既有三个写入器同一套路

- 位置：与 `applyOrderAccepted`（`:222`）/ `applyOrderAcceptanceReleased`（`:273`）/
  `applyOrderRefund`（`:309`）并列——订单的写入器只有这一个文件，**不新增第二处写 `Order` 的地方**。
- **同步**（无 `await`）：它会被伪事务的原子区段调用（与 `applyOrderAccepted` 同一条理由）。
- **只写两个字段**：`status: "serving"` 与 `servingAt`。
  ⚠️ **不碰** `actualCompanionId` / `companion`（那是履约绑定，进入 serving 恰恰是它成立的证明）、
  **不碰** `acceptedAt`（历史事实，指令 §二 明令不得抹掉）、不碰任何金额字段。
- **幂等防御写在写入器里**（照 `applyOrderRefund` 的既有先例：重复调用不刷新时间戳）：
  已经是 `serving` 时原样返回、不刷新 `servingAt`。
- 它**只负责写**，不判断这次迁移合不合法——与同文件另外三个写入器完全一致。

### D5 DTO：`canStart` 与 `canCancel` **成对**放在共享列表项上；`servingAt` **只进详情**

- `canStart: order.status === "accepted"`，写在 `toCompanionOrderListItem`
  （`lib/services/companionOrders.ts:62`），与既有的 `canCancel`（`:77`）并列。

  ⚠️ **虽然列表卡片不渲染它，仍然放在共享项上**：`CompanionOrderCard` 的注释已经把这件
  说清楚了——「不渲染 `canCancel`：按钮长在详情页上」，「能不能点由详情页回答」。
  两个动作旗标的契约是同一条（**服务端算，前端只显示**），把它们拆到两个类型上，
  第一次有人只改一处时就会分叉。**前端不得自己用状态推断**（与 `canCancel` 同一条规则）。
- `servingAt` **只加在 `CompanionOrderDetail`**（详情字面量里，不放进共享项）：
  它是**展示**字段，而列表卡片没有展示它的要求（`CompanionOrderCard` 只显示下单 / 接单
  两个节点，列表里 `serving` 单已经由状态文案「护航中」表达）。
  DTO 最小化与 `gameAccountId` / `remark` / 金额域只进详情是同一条取舍。
- ⚠️ 两个 DTO 的字段集都被 `tests/companionOrders.test.mjs` 用白名单钉着
  （`:572-615`），加字段必须同步更新那里的**两份**清单，否则门禁变红——这正是它存在的意义。

### D6 通知：**本轮不新增任何通知**（含检索证据）

`01-prompt.md` §七 的规则是「需求 / 技术设计已明确要求则复用既有通道；**未冻结就不要自行新增**」。
检索结果：

- `docs/01-requirements/超哥电竞_业务流程表.md` 里被冻结的通知只有：
  接单（`DISPATCH_NOTIFICATION_ACCEPTED`）、主动取消（`DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED`）、
  专属池超时、公共池超时、退款 / 投诉相关、封禁回池通知用户（`:1066-1084`）、换人通知（`:732`）；
- 「开始服务」只出现在 BF-17（`:536-558`）与完成材料章节的前置条件里，**没有任何一处**要求通知；
- 用户端状态文案 `ORDER_STATUS_HINTS.serving = "护航进行中，请留意打手消息。"`
  已经覆盖了「用户怎么知道已经开始」这件事（用户端订单详情读的是 `Order`，不依赖通知）。

**因此本轮 `start` 不写通知、不新增通知常量**。⚠️ 以后若产品要求补，
那是**新增一条产品通知**（新的 `DISPATCH_NOTIFICATION_*` 常量 + 新的 kind 取舍），
必须在那一轮里单独确认，不得在这一轮顺手加。

### D7 UI：新增 `CompanionOrderStartPanel`，成功后 `router.refresh()`（与取消**刻意相反**）

- 详情页按 `detail.canStart` 渲染「开始服务」，按 `detail.canCancel` 渲染「取消接单」——
  两者是**互斥**的（`accepted` 只可能出现前者，`serving` 两者都不出现），页面不自己推状态。
- **两下确认**（先展开确认区、再点「确认开始服务」）：与接单
  （`CompanionDispatchCard:33` 「第一次点击只把按钮换成确认区」）和取消
  （`CompanionOrderCancelPanel`）同一取舍。这里更必要：`serving` **没有**普通主动取消，
  这是一扇**单向门**，误触的代价比接单更大。
- ⚠️ **成功后 `router.refresh()`，而取消面板刻意不刷新**——两处相反，理由也相反：
  取消之后这一单**已经不属于他**，再取一次详情会走 404（服务端重新校验归属），
  刷新会把成功反馈换成「订单不存在」；开始服务之后这一单**仍然是他的**，
  刷新正是让页面反映 `serving`、让两个按钮一起消失的**正确**做法，
  也就满足指令 §五「不要求重新登录或重新进入订单」。
- 客户端**只负责交互**：服务端在事务的原子区段里完整 Guard，前端拿不到任何绕过方式。

### D8 文档同步：CURRENT / TARGET 两张表必须**同时**改

本轮把 `POST /api/companion/orders/[id]/start` 从 TARGET 搬进 CURRENT，
散落在三份文档里的四处表述必须一起改（只改一处就会留下自相矛盾的技术设计）：

| 位置 | 现状 | 本轮改成 |
|---|---|---|
| `api-contract.md:481` | 「**P0-6 起共五条**」+ 负向门禁说明 | 六条 + 负向门禁改写为「`start` 已落地」 |
| `api-contract.md:507` | §3.1 TARGET 表里的一行 | 移出 TARGET 表（CURRENT 只在 §8 列一次，与 `cancel` 同一处理） |
| `api-contract.md:518-520` | 「同一个详情页继续承载…」 | 保留，并补上「开始服务已落地（P0-7）」 |
| `directory-structure.md:307` | `start/route.ts ← TARGET — NOT IMPLEMENTED` | 改为 CURRENT（P0-7） |
| `directory-structure.md:349` | 「本轮只有 `cancelAcceptedOrder` 一个公开入口」 | 两个公开入口 |
| `docs/03-dev/总需求进度表.md` | BF-17 行仍是 ⏳ | 新增 P0-7 行（`AWAITING_ACCEPTANCE`） |
| `docs/03-dev/rounds/README.md` | 索引到 P0-6.1 | 新增 P0-7 行 |

---

## 四、追加记录（append-only）

### Decision V1 — 2026-09-24：实现、门禁与只读审查结束后追加

Status: **CURRENT**（只追加实现过程中发现的**事实**，不重写 D1–D8 的任何一条口径）

1. **§二 的落点表被校正过一次**，因为开工时写的用例号是按设想排的，与最终用例号不一致
   （例如「重放」写成了「用例 4」，实际是 `开始 3`）。另外 #15 那一行原写
   「**不改它的既有断言**」——实现完成后与事实不符：本轮**确实改写了**
   `tests/companionOrders.test.mjs` 的两条断言。改写性质与前后对照见 `03-delivery.md` §五，
   原文是**强化**（逐函数切片 + 顺序断言 + 集合相等），不是为了让要求变绿而放宽。
   这条校正让 §二 从「计划」变成「事实」，不改变任何 D 口径。

2. **判定顺序里「重放必须早于结构校验」是被现实逼出来的，不是设计偏好。**
   实现时先写成了「结构校验 → 领域 Guard」，随即发现 `serving → serving` **不在**
   `ORDER_TRANSITIONS` 里，于是**一次重复点击会被判成非法迁移（400）**。
   最终顺序定为 归属(404) → 重放 → 结构校验 → 领域 Guard（D3），
   并各写了一条断言守着「归属先于状态」与「重放先于结构校验」。
   ⚠️ 这一条是 D3 的**细化说明**，不是推翻——D3 本来就把重放写在结构校验之前。

3. **对新增门禁做了一次变异测试**（见 `03-delivery.md` §6.4）：把浏览器端调用临时改成
   带第二个实参，确认「不发明请求体」这条断言**会变红**，再逐字节还原。
   顺带修掉了 `functionBody` 只认 `export async function` 的漏洞——
   `companionHttp.ts` 里那个函数是**同步**导出的，漏掉它会让门禁静默失效。

4. **reviewer 抓到一处真实的收窄**（`03-delivery.md` §八 m2）：原来的全文件级禁令
   「本文件不得出现 `canTransitionOrder`」在被收窄成逐函数判断后，
   **取消路径失去了「不得引用状态机」那一半**。已补一条断言把它钉回来。

5. **reviewer 提出的一条建议被明确拒绝**：HTTP 层补 200 happy path。
   理由与取舍记在 `03-delivery.md` §8.4（全仓既有约定 + 会让只读门禁变成写数据 +
   该风险已有别的守卫）。这是**本轮的技术组织判断**，不需要产品裁定；
   但它作为**跨轮次的已知限制**带进了批次最终报告，请用户在批次收尾时决定是否单开一轮。
