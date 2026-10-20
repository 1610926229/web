# P0-6.1 · 02-decisions.md

> 本文件是**追加历史**：决定改变时保留旧版本并标注 `SUPERSEDED`，不覆盖。
> 格式见 `docs/03-dev/development-workflow.md` §十九。

Round ID: P0-6.1
Requirement Check 执行时间: 2026-09-24

---

## 结论先行

**本轮不存在 `Status: OPEN` 的决策，不进入 `CLARIFYING`。**

`01-prompt.md` §十四 给了本轮唯一一个可能进入 `CLARIFYING` 的判据，逐条对照后**两条都不成立**：

| §十四 的判据 | 实际情况 | 结论 |
|---|---|---|
| `publicPoolEnteredAt` / `exclusiveEnteredAt` 与真实数据结构冲突 | 两个字段**确实存在**且在真实链路上被写入（见下表） | 不成立 → 不进入 `CLARIFYING` |
| 只是旧 comparator 与最新需求不一致 | `compareByDeadline` 按 `deadlineAt` 排序，与「按进入当前池的时刻排序」不一致 | 这是**本轮的 FIX 本身**，§十四 明确要求直接修 |

> §十四 同时点名：**不得因为函数组织、按钮组件位置等纯技术问题询问产品负责人**。
> 本轮 D1 / D3 / D4 / D5 全部属于这一类，因此**一次都没有拿去问产品**。

---

## 一、Requirement Check

### 1.1 两个排序真值字段在真实数据模型里存在且被写入

| 字段 | 类型定义 | 写入点 | 文档引用 |
|---|---|---|---|
| `publicPoolEnteredAt` | `lib/types/dispatch.ts:80` | 种子 `lib/mocks/fixtures/dispatchSeed.ts:104`（专属单为 `:68` / `:88` 的 `null`）；转入公共池走 `mockDispatchRepository` 的 `applyDispatchToPublic`（`lib/data/mockDispatchRepository.ts:166`）——首次进公共池 / 专属超时转入 / **P0-6 取消后回池**三条路径都走它 | `业务流程表.md:247,335,496`（三处都把 public 三件套列在一起）、`api-contract.md` §8.1 / §3.1、`database-schema.md` §7 |
| `exclusiveEnteredAt` | `lib/types/dispatch.ts:71` | 种子 `lib/mocks/fixtures/dispatchSeed.ts:66` / `:86`；建派单时冻结（`lib/data/companionDispatchTransaction.ts:94`） | `database-schema.md` §7、`api-contract.md` §8.1 |

> ⚠️ **Requirement Check 时发现 `database-schema.md` §7 的「关键字段」一行漏列了 public 侧三个字段**
> （`publicPoolEnteredAt` / `publicTimeoutMinutesSnapshot` / `publicDeadlineAt`）与
> `acceptedByCompanionId`。字段本身一直是真实的，只是数据模型文档没有列；
> 而本轮的排序真值正是 `publicPoolEnteredAt`，一份查不到该字段的文档会让人以为排序键不存在。
> **已在本轮补全**（§十三 允许「同步技术文档」），见 `03-delivery.md` §四。

> ⚠️ **技术设计文档（`docs/02-tech-design/`）此前对「池子排序」是沉默的**——
> 已对该目录做了一次针对性检索，未命中任何排序断言。
> 但**这条规则并非无人记载**：它作为验收发现完整记录在
> `docs/03-dev/rounds/P0-6/04-acceptance.md` 的「FIX-2」一节（含两个排序键的表格、
> 「重新回池取新时刻」的关键约束、并列的 secondary key 要求）。
> 因此本轮的判据是「实现落后于**已记录**的要求」，**不是**「文档说 A、需求说 B」的冲突——
> 不存在 CLARIFYING 的理由。技术设计文档的空白在本轮补齐（见 `03-delivery.md` §四）；
> ⚠️ `P0-6/04-acceptance.md` 属**已 DONE 轮次的历史档案**，本轮**不改动它**。

### 1.2 `development-workflow.md` §七 的 12 件事

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 产品规则是否完整 | ✅ 完整 | `01-prompt.md` §二–§九 已把两条规则的**唯一真值**写到字段级 |
| 2 | 前置状态是否明确 | ✅ 明确 | FIX-1 前置 = 已进入 `/companion` 且资格 `granted`；FIX-2 前置 = 派单处于 `exclusive` / `public` |
| 3 | 成功状态是否明确 | ✅ 明确 | FIX-1 = 仍在同一会话下看到用户端；FIX-2 = 两张池子均按「进入当前池的时刻」升序 |
| 4 | 失败状态是否明确 | ✅ 不适用（两者都不产生新的失败态） | 本轮无新错误分支 |
| 5 | 权限是否明确 | ✅ 明确 | 本轮**不新增任何权限判定**：FIX-1 不产生认证行为，FIX-2 沿用既有可见性过滤 |
| 6 | 金额是否明确 | ✅ **不涉及金额** | `01-prompt.md` §十三 未含任何金额项 |
| 7 | 幂等是否明确 | ✅ 明确 | FIX-1 幂等（纯导航）；FIX-2 是**只读排序**，重复调用必须给出相同顺序（见 §十一 11.5） |
| 8 | 并发是否明确 | ✅ 明确 | 排序在**读路径**上完成，不写任何存储；排序的稳定性由 §三 D6 的 tie-break 保证 |
| 9 | 通知是否明确 | ✅ **不涉及通知** | 本轮不产生任何通知 |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ✅ 无 | 逐条比对 `docs/01-requirements/`、`docs/02-tech-design/` 后未命中 |
| 11 | 与现有架构规范是否冲突 | ✅ 不冲突 | 改动全部落在既有文件内：`app/companion/(console)/`（允许调整 console layout/header）、`lib/services/companionDispatch.ts`（允许修改池服务端排序）、`lib/constants/companionConsole.ts`、`tests/` |
| 12 | 是否与已有业务代码事实冲突 | ✅ 不冲突 | 与 `companionDispatchTransaction.currentDeadlineAt` 保持**同形状**（见 D3）；与 `CompanionPoolItem` 现有 DTO 零冲突（见 D4） |

**Requirement Check 结论：通过。不存在需要用户裁定的产品歧义，直接开发。**

---

## 二、FIX-1 的执行口径

### D1 — 入口挂在**共用顶栏组件**上，不挂在 layout 内联里、更不逐页复制

Status: CURRENT

**问题**：`01-prompt.md` §2.3 给出的落点是 `app/companion/(console)/layout.tsx`，同时要求
「不要每个页面各复制一个按钮」。layout 里已经有 `<CompanionHeader />`，那这个入口该写在哪？

**裁定：写在 `components/companion/CompanionHeader.tsx` 里。**

理由：`(console)` 路由组下 `/companion`、`/companion/orders`、`/companion/exclusive`、
`/companion/pool`、`/companion/orders/[id]` **共用这一个顶栏组件**。把入口放进该组件，
「覆盖全部工作台页面」是**结构上成立**的——将来新增一个 `(console)` 下的页面，
它自动就有这个入口，不需要任何人记得去补。而写在 layout 的 JSX 里虽然也能覆盖，
却会让这个入口与顶栏的**视觉一体性**（同一行、同一内边距、同一断行行为）需要人工维护两份。

> ⚠️ §2.3 给的是「优先落点」，不是排他约束；把入口放在 layout 渲染的那个顶栏组件内部，
> layout 依然是**唯一**的挂载点，因此没有偏离该条要求的实质。

**副作用（正向）**：`CompanionHeader` 在整个仓库里**只有一处 import**
（`app/companion/(console)/layout.tsx:3`），因此「用户端页面不会错误地出现工作台顶栏」
是**结构上成立**的，而不是靠人工检查保证的。该性质已由测试门禁固定（§十 第 10 条）。

### D2 — 目标固定 `/`，理由充分但不新造一个「用户端主入口」常量

Status: CURRENT

**问题**：`lib/constants/companionConsole.ts` 已有 `COMPANION_BACK_TO_MINE_LABEL = "返回我的"`（→ `/mine`）。
本次是否复用？

**裁定：不复用，新增 `COMPANION_BACK_TO_USER_LABEL` / `COMPANION_BACK_TO_USER_HREF`；目标为 `/`。**

1. **场景不同**：`返回我的` 是**进不去**工作台时（还不是护航 / 资格已下架，由 `CompanionAccessNotice`
   渲染）的退路，去 `/mine` 看自己的资料；本入口是**已经在工作台里**时的界面切换，去 `/` 继续逛。
   合并成一条会让「返回我的」出现在一个与「我的」无关的位置上。
2. **目标必须确定，不能用 `router.back()`**：工作台可以被**直接打开**（收藏、地址栏、微信里的分享），
   历史里没有上一页时 `back()` 会把人留在空页面上。`components/common/NavBar.tsx` 的返回键走历史回退，
   那适合「从列表进详情」，**不适合**回答「用户端在哪」这个固定问题。
3. **`/` 就是用户端主入口**：底部 TabBar 的「首页」那一格指向同一个地址
   （`components/common/TabBar.tsx` 的 `TABS`）。`TABS` 是组件内的局部常量、未导出，
   因此这里**不为了共用而把它提出来**——提出来会牵动用户端组件（§十三 未允许），
   而「两个地方写同一个 `/`」这个重复由测试门禁盯着（§十 第 1 条断言二者一致）。

> ⚠️ `COMPANION_BACK_TO_MINE_LABEL` **保持原样不动**，仍由两种「进不去」的提示页使用。

### D3 — 入口是**界面导航**，不含任何认证行为

Status: CURRENT

**裁定**：本入口的实现里**不得出现** logout、`/api/auth/logout`、清 Cookie、切换 Mock Identity、
新建 Companion Auth、修改 User / Companion 共用 Session、修改护航资格、跳转管理员 / 客服工作台。

落地方式：入口就是一个 `<Link href="/">`。`/` 的用户端布局（`app/(mobile)/layout.tsx`）
自己会用**同一个** `mock_user_id` 解析会话，因此「点完仍在登录」不需要本入口做任何事——
**这正是判据**：如果点完变成了未登录，那是本入口引入了副作用，是 bug。

---

## 三、FIX-2 的执行口径

### D4 — 排序键**按 `record.state` 取**，不按 `exclusiveCompanionId` 取

Status: CURRENT

**这是本轮最容易写错的一处，单独记一条。**

`currentPoolEnteredAt(record)` 的实现与 `companionDispatchTransaction.currentDeadlineAt` **同形状**：

```
record.state === "exclusive" ? record.exclusiveEnteredAt : record.publicPoolEnteredAt
```

**为什么不能写成「先看 `exclusiveCompanionId` 再看 state」**：存在这样一类记录——
用户当初指定了 A、A 没接单、订单已**转入公共池**。这种记录的
`exclusiveCompanionId` **非空**、`exclusiveEnteredAt` 也**非空**（那是历史事实，不该被抹掉），
但它的**当前池已经是 `public`**。按 `exclusiveCompanionId` 取键，就会拿「当初进专属池的时刻」
去排公共池，一张早就超时转过来的单会被顶到最前面——「等待最久优先」在**这一类记录**上失效，
而在只看种子数据的测试里完全看不出来。

选择与既有函数**同形状**还有一个好处：两个函数回答的是同一个问题的两个答案
（「这一单现在在哪个池、什么时候进的、什么时候到点」），形状一致就不可能在将来分叉。

### D5 — 排序键**不进 DTO**：用局部 `PoolEntry` 承载，排完再映射回 DTO

Status: CURRENT

**问题**：真值在派单记录上，而 `CompanionPoolItem` DTO **刻意不含**任何「进入池子的时刻」
（打手不需要看到「这单是什么时候进的池子」）。怎么排序？

**裁定：在收集阶段就把键带上，排序完成后取出 DTO。**

`listCompanionPools` 内部收集的是 `PoolEntry = { item, waitingSince }`，`sort` 之后
`map((entry) => entry.item)` 输出。收益：

1. **接口契约零改动**——不需要给 `CompanionPoolItem` 加字段，也就不需要为显示无关的时间戳
   改动 `api-contract.md` 的池子 DTO 定义；
2. **排序键不可能泄漏到接口**——这是结构上的（键在排完序后就不存在了），不是靠自觉；
3. 与 §九「服务端是唯一排序真值源」一致：排完序再取出 DTO，调用方拿到什么顺序就显示什么顺序。

> ⚠️ 被否决的方案：给 `toDispatchProgress` 加一个 `enteredAt` 字段再在外部取。
> 该函数有 4 个调用方，且 `tests/dispatch.test.mjs:211` 对它的返回形状有断言；
> 为了一个排序键去改一个被多处断言的共享形状，代价明显大于收益。

### D6 — 两张池子**共用同一个** comparator；tie-break 沿用既有 `dispatchId`

Status: CURRENT

**问题**：§八 允许拆成 `comparePublicPoolWaitingOrder` / `compareExclusivePoolWaitingOrder`
两个语义清晰的 comparator。要不要拆？

**裁定：不拆，共用一个 `compareByWaitingSince`。理由：规则是**同一条**。**

「等待最久优先」对两张池子是**同一条业务规则**；两张池子的差别只在
「进入当前池的时刻该取哪个字段」，而那个差别被 D4 的 `currentPoolEnteredAt` **一处**消化掉了。
拆成两个函数，就等于把同一条规则写成两份可以各自演化的代码——
而两份排序逻辑**迟早会分叉**，分叉的那一天，专属池与公共池会按不同的规则排，
且没有任何测试会失败（因为每个函数单独看都是「对的」）。

> §八 的原文是「**可以**拆成语义清晰的 comparator，**不一定**要拆」，
> 并同时要求「不要大规模重构 companionDispatch」。共用一个函数同时满足这两句。

**tie-break**：`waitingSince` 相同时按 **`dispatchId` 升序**——沿用本文件**原有**的 tie-break
（原 `compareByDeadline` 就是 `deadlineAt` ASC + `dispatchId` ASC），确定性、与请求顺序无关、
不随种子数据顺序变化、测试可稳定复现，且**不引入第二套优先级算法**。

#### ⚠️ 关于 `dispatchId` 是随机 UUID 这件事（本轮实测，预先说明）

`dispatchId` 形如 `dsp_${crypto.randomUUID()}`，因此**同一毫秒**进入池子的两单，
它们的先后是**随机的**、不跟随下单顺序。这是**已知且可接受**的，理由如下：

- **§七 要求的是「确定性」，不是「同毫秒内的公平性」**：`dispatchId` 不随请求变化、
  刷新多少次结果都一样、不依赖 Map / seed 顺序——要求全部满足；
- **数据模型里没有任何字段能支撑同毫秒内的到达先后**：已核查唯一候选 `orderNo`
  （`lib/services/checkout.ts:283` 的 `makeOrderNo`）是 `YM` + **日期(仅 YYYYMMDD)** + **6 位随机尾号**，
  同一天内同样是随机的，**比 `dispatchId` 更差**（还不保证唯一）。也就是说，
  「谁先到」这个信息在**同一毫秒内根本没有被记录过**；
- **真实场景下不构成问题**：真实支付由不同用户在不同时刻发起，进入池子的时刻
  天然相差秒级以上；毫秒碰撞是 **Mock 时钟精度 + 内存写入微秒级**共同造成的测试产物。
  实测（连放 4 单 × 5 轮）：5 轮里 4 轮的 4 个 `publicPoolEnteredAt` **完全相同**——
  这正说明它是内存写入速度的产物，而不是业务现象。

因此本轮**不引入**「按到达序号排」之类的第二套优先级（§七 亦明确禁止自造复杂优先级）。
测试也必须据此构造（见 `03-delivery.md` §六）：**不能**用「依次下单 ⇒ 断言按下单顺序」
来验证本规则，因为那在毫秒碰撞时断言的是随机值。

**`waitingSince` 为 `null`**（数据异常：进池时没把时刻冻结下来）时按 **`""` 参与比较，即按最旧处理**，
排在前面而**不是丢弃**。丢弃等于让一张确实在池子里的订单从列表上凭空消失，那比顺序不对更难查。

### D7 — 旧 `compareByDeadline` **删除**，不保留

Status: CURRENT

**裁定**：删除，不做「保留但不用」。§八 说「不要机械地保留 deadline 排序」；
一个不再被调用的旧 comparator 留在文件里，唯一的实际作用是**诱导**下一个人把它接回去。

**同时必须记住它为什么「看起来也对」**：`publicDeadlineAt = publicPoolEnteredAt + 当次冻结的时长快照`，
在「公共池时长从没被后台改过」时同一批单的时长一样，两者**恰好同序**。
但那是**巧合**而非规则：P0-1 起该时长**后台可配置**（`updateAdminPlatformConfig`），
改过之后一张**更晚**进入池子的订单反而**更早**到点，按 deadline 排就会把它顶到最上面，
而页面上看不出任何异常。§十一 11.6 专门构造了「`deadline` 顺序 ≠ `enteredAt` 顺序」的场景作为守卫，
防止以后有人把它改回去。

### D8 — 不修改池子的可见性过滤与 `canAccept` 判定

Status: CURRENT

**裁定**：本次只改**顺序**，一行过滤逻辑都不动。专属池只对 `exclusiveCompanionId` 本人可见、
公共池在暂停接单时一条都不返回、自己下的单不进池子（EX-DISPATCH-08）——
这三条与「暂停接单」的判定都**保持原样**。

理由：§十三 禁止改 Dispatch 状态模型与超时业务规则；而这三条过滤是**诚实性**设计
（「不给他看，他就不会去点一个必然失败的按钮」），顺序改动不会影响它们，
把两件事混在一轮里会让「顺序错了」和「过滤错了」难以区分。
