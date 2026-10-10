# P0-5.5 Delivery

Status: AWAITING_ACCEPTANCE（编码 / 测试 / Reviewer 均已完成；**`DONE` 需用户人工验收通过 + 用户自行 Git commit**）

> 本文件记录**实际执行过**的内容。未运行的验证不写「通过」。

---

## Implemented

本轮只做 `02-decisions.md` §三 冻结的四项代码改动，**没有新增任何可执行的状态迁移**。

### 1. `ORDER_TRANSITIONS` + `canTransitionOrder`（`lib/constants/orders.ts`）

- 新增声明式迁移表（内容按冻结值，逐字一致）：

  ```text
  paid      -> accepted | refunded
  accepted  -> serving  | refunded
  serving   -> completed | refunded
  completed -> refunded
  refunded  -> []
  ```

- 写法沿用仓库既有状态机惯用法（`Record<Status, readonly Status[]>` + 派生谓词），
  与 `ADMIN_REFUND_TRANSITIONS` / `ADMIN_COMPLAINT_TRANSITIONS` /
  `ADMIN_APPLICATION_TRANSITIONS` 同形；终态写空数组而不是省略。
- `canTransitionOrder(from, to)`：`from === to` 一律 `false`（表里没有自环）。
- 注释明确写死了边界：**只回答结构上是否允许，不是业务 Guard，也不得用来绕过 Guard**——
  `paid → accepted` 仍必须满足 Dispatch / deadline / Companion 资格 / 禁止自接单 /
  enabled-available / 并发 / 原子抢单；`serving → completed` 未来仍必须满足完成材料 +
  客服审核通过；`completed → refunded` 只能走合法的投诉 / 售后 / 退款流程，
  **不得因为表允许就提供一个按钮**。
- **本轮不接入任何写入路径**：`applyOrderAccepted` / `applyOrderRefund` 行为未变，
  全仓没有新增调用点。「用表替换 Guard」是明确错误的方向。
- ⚠️ 该文件的运行时依赖约束（可被客户端组件引用）保持不变：新增内容不含任何运行时 `import`。

### 2. 管理员全额退款写入 `refundedAmount`（`lib/data/adminRefundTransaction.ts:247`）

```ts
const orderWritten = applyOrderRefund(existing.orderId, ctx.at, order.actualPaidAmount);
```

- 修复前：省略第三个参数 ⇒ 订单变成 `refunded` 但 `refundedAmount` 保持原值（通常是 0），
  用户会看到「已退款」却「累计已退 0 元」。
- 金额取自**被修改的那张订单**（原子区段开头取到的写入前快照 `order.actualPaidAmount`），
  **不取**退款申请上的 `amount` 快照——同一事实只有一个真值源。
- 幂等由 `applyOrderRefund` 兜底：对已 `refunded` 的订单短路返回 `changed: false`，
  不重复累计 `refundedAmount`、也不刷新 `refundedAt`。「已退款不能二次退款」仍由
  `canTransitionRefund` + 重放判定负责，**没有新增第二套判定**。
- **P0-5 公共池 timeout 自动退款路径一字未改**（`companionDispatchTransaction.ts:439`
  本来就在传金额）。

### 3. Companion API 路由清单门禁（新建 `tests/companion.test.mjs`）

- 覆盖范围：**只扫描 `app/api/companion/**` 下当前真实存在的 `route.ts`**，恰好两个。
  不登记任何 TARGET 路由，不为未来接口预留位置。
- 清单逐条列出（不是只断言数量）：地址、导出的 HTTP 方法、身份守卫、预期服务层函数与模块。
- 断言内容：清单固定；导出方法与清单一致；守卫是 `requireCompanion()` 且是**第一个动作**
  （任何参数 / 请求体解析、以及调用服务层，都不能排在它前面）；守卫还必须来自
  `@/lib/api/companionRoute`；不混入 `requireUser` / `requireAdmin` / `requireStaff` /
  `getSessionUser` / `getSessionAdmin`；只调约定的服务层函数；
  且**不存在** `/companion/orders`（「开始服务」属后续业务 Round）。
- ⚠️ 未重复 `tests/companionAccess.test.mjs` 已覆盖的「`api/companion` 下无 `auth/` 段」。
- ⚠️ 未新建测试框架，沿用 `tests/*.test.mjs` + 源码扫描的既有写法。
- ⚠️ **复审后修正（M1）**：首轮那版「守卫是第一个动作」的断言**恒为真**——它在**带 import**
  的源码上取 `indexOf`，而 `import { requireCompanion } …` 永远先在第 1 行命中，
  于是「守卫比任何解析点都靠前」对**任何** import 了守卫的文件无条件成立
  （连「只 import 不调用、上来就 `await request.json()`」都能过）；且对
  `dispatches/route.ts`（GET、不读参数）整段判定被跳过。
  现已改为：先 `withoutImports()` 再比位置（与 `tests/staff.test.mjs` 既有写法一致），
  且判定边界取「解析点 ∪ 服务层调用」中最早的一处，两类都必须在守卫之后。
  补强后的 5 个变异（含「守卫挪到 `await context.params` 之后」）**全部变红**，见下节。

### 4. Checkout 复用中央接单资格判断（`lib/services/checkout.ts:143`）

```ts
if (!isCompanionAcceptingOrders(companion)) {
```

- 替换前是内联的 `!isCompanionListed(companion) || !companion.available`——同一规则的
  **第三份拷贝**。替换后语义完全等价，回到「一个业务谓词、多处复用」。
- **文案、错误码、抛错位置、函数签名、对外行为一字未变**；`isCompanionListed` 的 import
  随之移除（该文件已无其它使用点）。
- 未借此重构 Checkout / Companion、未重写数据层、未改接口形状。

### 5. 技术设计文档同步

`docs/02-tech-design/` 下 `architecture-rules.md`（§2.6 / §三 第 7 条 / §4.1 / §7.1）、
`api-contract.md`（§2.11 / §8）、`database-schema.md`（`refundedAmount` / 状态机段 / T3 / `:278`）、
`directory-structure.md`（§4.2 / 未来 Round 示例块）按事实同步。

⚠️ **复审后修正（M2）**：首轮交付时，上述三份文档里仍留着「`app/api/companion/**`
**没有任何清单门禁**」「`tests/companion.test.mjs` **至今不存在**」这类**现在时**陈述——
门禁测试正是本批的交付物，于是文档与交付物**互相矛盾**。现已改为事实陈述
（`architecture-rules.md` §7.1、`directory-structure.md` §5 第 1 类、`api-contract.md` §8）。
这样做**不等于**宣称 Round 已完成：Round 状态仍由 `README.md` 单独记录，且本轮
**没有**把任何能力标 ✅、**没有**把 `/companion/orders` 登记为 CURRENT。

⚠️ **`companions.ts:341` 的第四份内联拷贝未收敛**（复审 m4）：`architecture-rules.md` §4.1
原先写成「回到一个业务谓词、多处复用」，比事实更满。现已改为如实记录
「Checkout 已收敛，`lib/constants/companions.ts:341` 的 DTO 投影仍是第四份内联，
本轮有意不动（属 Companion 模块改动，超出冻结范围）」。**代码一字未改**。

---

## Files Changed

**代码（4 个，全部在 `lib/`）**

| 文件 | 改动 |
|---|---|
| `lib/constants/orders.ts` | 新增 `ORDER_TRANSITIONS`（`:83`）与 `canTransitionOrder`（`:100`）；文件头 JSDoc 按事实微调，保留「可被客户端组件引用」结论 |
| `lib/data/adminRefundTransaction.ts` | `approveRefund()` 显式传入 `order.actualPaidAmount`（`:247`）；文件头与函数 JSDoc 去掉「金额一个字都不写」的旧表述 |
| `lib/data/mockPaymentRepository.ts` | **仅 JSDoc**：`applyOrderRefund` 第三参数的说明改为事实（两条退款路径都显式传金额）。签名与行为零变化 |
| `lib/services/checkout.ts` | `resolveCompanion()` 改调 `isCompanionAcceptingOrders`（`:143`），import 同步替换，JSDoc 按事实更新 |

**测试（5 个，全部在 `tests/`）**

| 文件 | 改动 |
|---|---|
| `tests/orders.test.mjs` | +8 条 |
| `tests/adminRefunds.test.mjs` | +5 条 |
| `tests/checkout.test.mjs` | +6 条（另修正一条被中断留下的残缺用例：补 `const answers = []`） |
| `tests/companion.test.mjs` | **新建**，7 条 |
| `tests/source-text.mjs` | **新建**共享文本 helper（`stripComments` / `readSource` / `withoutImports` / `collectFiles`）；不含 `test(...)`，只被 import |

**文档（6 个）**

`docs/02-tech-design/` 下 4 份；`docs/03-dev/总需求进度表.md`（新增 `P0-5.5` 一行，
**未改动任何其它行**，也未给「开始服务」编号）；`docs/03-dev/rounds/README.md`
（「当前 Round：尚无」→ 指向 P0-5.5）。

---

## Business Rules Implemented

| 规则 | 来源 | 落地形式 |
|---|---|---|
| 订单状态迁移的**结构边界**集中定义 | `architecture-rules.md` §2.6 / `database-schema.md` T3（转移表已冻结） | `ORDER_TRANSITIONS` + `canTransitionOrder` |
| `refunded` = **全额退款**；成功批准后 `refundedAmount === actualPaidAmount` | `architecture-rules.md` §三 第 7 条（2026-09-19 裁定） | `approveRefund` 显式传金额 |
| 部分退款**不得**因 `refundedAmount > 0` 自动置 `refunded` | `architecture-rules.md` §三 第 8 条 | 本轮不实现部分退款；语义写入注释 |
| 「打手当前能不能接新单」只有一个真值源 | `architecture-rules.md` §4.1 | Checkout 复用 `isCompanionAcceptingOrders()` |
| 打手端接口契约可自动检查 | 产品裁定 2026-09-19 | `tests/companion.test.mjs` 清单门禁 |

---

## Tests Added / Updated

新增 **26 条**：`tests/orders.test.mjs` +8、`tests/adminRefunds.test.mjs` +5、
`tests/checkout.test.mjs` +6、`tests/companion.test.mjs` +7（新建文件）。

| 覆盖的不变量 | 用例 |
|---|---|
| 迁移表逐项冻结（值 + 顺序）、键集合与 `ORDER_STATUSES` 一致 | orders › 迁移表逐项冻结 / 键集合 |
| 合法迁移为 true、非法迁移为 false、`from === to` 恒 false | orders › 合法迁移 / 非法迁移 / 原地不动 |
| **25 格穷举**（预期矩阵手写，不用实现反推） | orders › 穷举 25 格 |
| `refunded` 是终态 | orders › refunded 是终态 |
| `orders.ts` 无运行时 import（可被客户端引用） | orders › 源码约束 |
| 批准后 `status` 与 `refundedAmount` 同时到位 | adminRefunds › 通过全额退款 |
| **金额真值源**：申请 `amount` 与订单 `actualPaidAmount` 被人为改开时写订单值 | adminRefunds › 金额真值源 |
| 换幂等键重复批准被状态机挡住、金额与时间戳不变 | adminRefunds › 重复批准 |
| 同幂等键重放：`replayed=true`、`changed/orderChanged=false`、审计仍一条 | adminRefunds › 同幂等键重放 |
| 不重复累计（批准 + 重放 + 换键重批之后仍只退一次） | adminRefunds › 金额不重复累计 |
| 三类否定（已下架 / 已被移除 / 暂停接单）均为 `BAD_REQUEST` + 原文案 | checkout › 三条 |
| 正向不变（金额、快照、返回结构） | checkout › 指定正常陪玩 |
| 结算页行为与中央谓词对同一份资料给出同一答案 | checkout › 行为一致 |
| **源码防回流**：不再内联「名单 + available」判断 | checkout › 源码防回流 |
| 清单固定 / 方法与清单一致 / 守卫是第一个动作（剥 import 后仍早于「解析点 ∪ 服务层调用」，且来自约定模块） / 不混入别的守卫 / 只调约定服务层 | companion › 五条 |
| 不得提前落地 `/companion/orders` | companion › 不存在「开始服务」的接口 |
| 清单自检（无重复地址、每个地址有方法、守卫统一） | companion › 清单自己先自检 |

### 鉴别力验证（变异测试）

「绿」不等于「有鉴别力」。本轮**实际执行**了 **13 个**变异（首轮 8 个 + 复审补强 5 个），
每一个都被目标用例捕获，随后立即还原并确认工作区无残留
（`git status --porcelain app/ lib/` 为空）。首轮的 8 个：

| 变异 | 结果 |
|---|---|
| 去掉 `applyOrderRefund` 第三参数 | RED ✓ |
| 金额来源换成 `existing.amount`（取错真值源） | RED ✓ |
| Checkout 退回内联判断（第四份拷贝回流） | RED ✓ |
| 迁移表删一条出边（`paid → refunded`） | RED ✓ |
| 迁移表加一条出边（`refunded` 不再是终态） | RED ✓ |
| 打手接口多导出一个 HTTP 方法 | RED ✓ |
| 打手接口混入别的身份守卫 | RED ✓ |
| 新增未登记的 `/companion/orders` 路由 | RED ✓ |

⚠️ **第一轮 8 个变异全红，但盲区仍在**：没有一条打「守卫是第一个动作」这条断言——
而它恰好是恒为真的（M1，由 reviewer 只读探针发现）。**「变异全红」只证明被测到的那些
断言有鉴别力，不证明没被测到的也有。**

**复审后补强（第二轮 5 个变异，专打顺序断言）**：

| 变异 | 结果 |
|---|---|
| 守卫挪到 `await context.params` 之后（旧断言对此恒绿） | RED ✓ |
| 删掉守卫**调用**、保留 import（旧断言对「只 import 不调用」恒绿） | RED ✓ |
| `dispatches` 路由守卫挪到服务层调用之后（旧断言整段跳过） | RED ✓ |
| 守卫改从别的模块引入（只钉名字不钉模块时的洞） | RED ✓ |
| 用 `export { GET, DELETE }` 列表多导出一个方法 | RED ✓ |

---

## Verification

**全部为实际执行结果。**

**复审修正（M1 测试补强 + M2 文档同步）之后**重跑的全部闸门，下表是**最终树**的结果：

| 命令 | 结果 |
|---|---|
| `pnpm test` | `tests 1055` / `pass 944` / `fail 0` / `skipped 111` / `todo 0`，`EXIT=0` |
| `APP_BASE_URL=http://localhost:3105 pnpm test` | `tests 1055` / `pass 1055` / `fail 0` / `skipped 0` / `todo 0`，`EXIT=0` |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | `EXIT=0` |
| `pnpm lint`（ESLint CLI） | `EXIT=0`，无输出（无 error、无 warning） |
| `pnpm build`（Turbopack） | `EXIT=0`；`✓ Compiled successfully in 1876ms`；静态页 `101/101`；路由表 189 行 |

⚠️ 上表的退出码是用 `cmd > log 2>&1; echo "EXIT=$?"` 直接取命令自身的状态取得的
（早先曾用 `cmd | tail && echo EXIT=$?`，那取到的是 `tail` 的状态，证明不了任何事，已作废重取）。

**`skipped 111` 的说明**：未设 `APP_BASE_URL` 的那一轮里，需要真实服务的 HTTP 用例
（`http-smoke` / `admin` / `staff` 等）整组跳过。**不计入通过数**。
设了 `APP_BASE_URL` 之后 `skipped 0`，全部 1055 条真实通过。

**production server**：`pnpm exec next start -p 3105`，PID 24296，由 **00:59 那次生产构建**启动，
**不是**复用旧进程（上一轮遗留的 `next start`，PID 24704、占用 :3000，已先行清理；
期间有一次 `TaskStop` 未真正杀掉子进程，导致新服务 EADDRINUSE，已按 PID 手工清理后重起）。

⚠️ 该服务与最终树**内容等价**：`app/**` 与 `lib/**` 自那次构建后**内容未变**
（`git status --porcelain app/` 为空）；`app/api/companion/dispatches/**` 两个文件的
mtime 被变异脚本的「写入—还原」刷新过，但内容与 HEAD 一致，因此不影响该服务的等价性。
本轮的第二次修改只落在 `tests/**` 与 `docs/**`。

**收尾时该服务已停止。** `TaskStop` **第三次**未能杀掉子进程（`netstat` 显示 PID 24296 仍在
LISTENING），已按 PID 强杀并确认 `:3000` / `:3105` 均已释放。

### 测试基线对照

| 阶段 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 本轮开始前（backend-agent 实测） | 1029 | 918 | 0 | 111 |
| 本轮完成后 | 1055 | 944 | 0 | 111 |
| 差值 | **+26** | +26 | 0 | 0 |

---

## Reviewer

`reviewer-agent` 只读审查（未修改任何文件），输出 BLOCKER / MAJOR / MINOR / NOTE。
**BLOCKER：0。** 下面是全部条目与处置——**处置都在本文件里可核对**，没有「口头通过」。

### BLOCKER

无。

### MAJOR

| # | 问题 | 处置 |
|---|---|---|
| **M1** | `tests/companion.test.mjs` 的「守卫是第一个动作」断言**恒为真**：在带 import 的源码上取 `indexOf`，`requireCompanion` 永远先在第 1 行的 import 命中；且 `dispatches/route.ts`（无解析点）整段被 `if (parseAt !== -1)` 跳过。reviewer 用只读探针构造了「只 import 不调用、先读请求体」的路由，**照样通过** | **已修**：改为 `withoutImports(code)` 后再比位置（与 `tests/staff.test.mjs` 既有写法一致），判定边界取「解析点 ∪ 服务层调用」最早一处，并新增「守卫必须来自 `@/lib/api/companionRoute`」。**补强后 5 个针对性变异全部变红**（含 reviewer 指出的那两种），见上节 |
| **M2** | `docs/02-tech-design/` 三处**现在时**陈述仍称打手门禁不存在（`architecture-rules.md` §7.1、`directory-structure.md` §5、`api-contract.md` §8），与本轮交付物自相矛盾 | **已修**：三处改为事实陈述（「已建立，P0-5.5」），并在 `architecture-rules.md` 注明门禁文件是 `companion.test.mjs` 而非 `companionAccess.test.mjs`。**未因此把 Round 标为完成**，也未把 `/companion/orders` 登记为 CURRENT |

### MINOR

| # | 问题 | 处置 |
|---|---|---|
| m1 | `03-delivery.md` 引用的行号错（`:84`/`:101`） | **已修** → `:83`/`:100`（已用 grep 复核） |
| m2 | `exportedMethods()` 看不见 `export { POST }` / `export let DELETE` 两种写法，标题的覆盖面略大于实现 | **已修**：补齐 `export { … }`（含 `as` 别名）与 `export let/var` 分支；并注明 `export default {}` 不是 App Router 的方法导出写法 |
| m3 | `applyOrderRefund(id, at, refundedAmount?)` 第三参数仍是**可选**，同一形状的 Bug 将来可能再次静默复发 | **未改，转入后续**：改签名属数据层接口形状变更，超出本轮冻结范围（本轮只修「取错真值源」这一个 Bug，且 P0-5 已正确的 timeout 路径一字未动）。已记入 Known Limitations 第 6 条 |
| m4 | `lib/constants/companions.ts:341` 仍是同一规则的**第四份内联**拷贝（就在定义谓词的同一文件里），`:208` 的「谁该用它」也未列它；而 `architecture-rules.md` §4.1 写成「回到一个业务谓词、多处复用」，比事实更满 | **代码未改**（收敛它属 Companion 模块改动，R5 冻结范围外）；**文档已改为如实记录**，并记入 Known Limitations 第 7 条 |
| m5 | `04-acceptance.md` 的人工验收清单与本文档的 Reviewer 段仍是占位符 | **已修**：本节已填；`04-acceptance.md` 清单已填（本文件与它同为 Coordinator 所有） |

### NOTE

共 7 条，均**无需改动**。其中两条实质性的：

- **N1 的处置被确认正确**：`architecture-rules.md` §7.1 里 `/companion/orders` 的 `P0-6`
  标签与 `总需求进度表.md` 的 `UNASSIGNED` 不一致——已**记录**（`02-decisions.md` N1）
  而**未擅自改写**，符合「轮次编号由用户分配」。
- **`README.md` 的 `IN_PROGRESS` 合规**：协议要求 Claude 完成后才能标 `AWAITING_ACCEPTANCE`，
  审查时点确实尚未完成，因此当时的状态是正确的。

其余 5 条为确认性说明（含对 `03-delivery.md` 「不得说测试通过除非实际执行过」这一纪律的
核对结果：本文档 Verification 段的每条命令都有实际执行记录）。

---

## Known Limitations

1. **`ORDER_TRANSITIONS` / `canTransitionOrder` 尚未被任何写入路径使用。**
   这是本轮的**有意交付形态**，不是遗漏：本轮只交付中央定义，接入要等到具体业务
   （如 `accepted → serving`）真正实现时由那一轮完成。
2. **门禁只覆盖 `app/api/companion/**`。** `/api/me/companion-application` 等服务端
   用户侧接口不在其中——它由 `requireUser()` 守卫，不属打手工作台接口面。
3. **`docs/02-tech-design/architecture-rules.md` §7.1 里 `/companion/orders` 两行的
   轮次标签仍是 `P0-6`。** 与 `总需求进度表.md` 的 `UNASSIGNED` 不一致（详见
   `02-decisions.md` N1）。本轮**没有修改**它：那一轮的编号由用户分配，Claude 不得
   自行创造或改写。**请在正式启动该轮时统一。**
4. **`docs/02-tech-design/agent-collaboration.md` §九 要求的后续同步尚未执行。**
   该节写明「**P0-5.5 完成后**，`reviewer-agent.md` 与 `backend-agent.md` 两份 Agent 文件
   里的对应段落需要同步更新，否则 Agent 会继续按『还没有』的前提工作」。
   本轮**刻意不提前做**：它的触发条件是「P0-5.5 完成」，而完成需要用户人工验收通过 +
   自行 Git commit。**建议在 Round 标 `DONE` 时一并执行。**
5. `tests/source-text.mjs` 是新的共享 helper，与仓库既有「每个测试文件各抄一份文本函数」的
   惯例并存。既有拷贝本轮**未**统一（那属于重构，不在任何一批范围内）。
6. **`applyOrderRefund(id, at, refundedAmount?)` 的第三参数仍是可选的**（复审 m3）。
   本轮的 Bug 正是「某个调用点省略了它」，而签名本身仍允许省略——同一形状的错误
   将来可能再次静默复发（表现为「已退款」却「累计已退 0 元」）。
   本轮只修**取错真值源**这一个 Bug、且不动 P0-5 已正确的 timeout 路径，因此
   **未改签名**（那属于数据层接口形状变更）。**建议单独一批把它改为必填。**
7. **「能否接新单」尚未收敛到全仓一处**（复审 m4）：`lib/constants/companions.ts:341`
   的 DTO 投影 `selectable: isCompanionListed(companion) && companion.available`
   仍是同一规则的**第四份内联**，同一文件 `:208` 的「谁该用它」清单也未把它列为使用点。
   本轮 Checkout 已收敛、这处**有意不动**（属 Companion 模块改动，超出冻结范围）。
   已在 `architecture-rules.md` §4.1 如实记录。**收敛它需要单独一批。**
8. **`docs/superpowers/plans/2026-09-17-order-lifecycle-alignment.md:1218` 写着
   「本批次打手端只新增 `app/api/companion/dispatches/**` 四个路由，因此清单初始为 4 条」，
   与实际存在的 **2 条**不符。**本轮未改它**：那是历史计划文档，既不在本轮点名的
   `docs/02-tech-design/` 同步范围内，事后改写计划也会抹掉当时的决策痕迹。
   门禁以**实际扫描**为准（清单固定这一条断言的就是真实路由集合），不受该行影响。

---

## Out Of Scope

本轮**没有**做（`01-prompt.md` §十七 与 `02-decisions.md` §四 的禁止清单）：

- **「开始服务」**：未创建 `/companion/orders`、`/companion/orders/[id]`，未实现
  `accepted → serving`，未把这两条写进任何清单；**没有**自行编号为 P0-6；
- 完成材料、客服完成审核、Earning / Ledger、部分退款；
- Notification 重构（事件词表 / 幂等键 / Event Bus）；
- 拆 `adminHttp`、拆大文件、重构 `OrderRepository` / `PaymentRepository`；
- Session 重构（未合并 User / Admin / Staff 会话）、未删除或重构 `source.ts`；
- 未引入 DI / Event Bus / 数据库 / ORM；
- **未抽 `isOwnOrder()`**：两层 self-order 检查（池列表过滤 = 诚实性；
  `acceptDispatch` 原子区段 Guard = 安全性）保持现状，两处手写重复仍是已知
  `P0-5 NON-BLOCKING`；
- 未改任何 DTO 形状、未改任何对外文案、未改 `app/**` 下的页面与接口。

---

## Project Progress Change

`docs/03-dev/总需求进度表.md` 新增一行：

```text
| P0-5.5 | 小型架构稳定化 … | 🔵 IN_PROGRESS | P0-5 | — | docs/03-dev/rounds/P0-5.5/ | 等待人工验收（AWAITING_ACCEPTANCE，非 DONE） | … |
```

- **只新增这一行**，未改动 P0-5 或任何其它行。
- **`Status` 仍留 `🔵 IN_PROGRESS`**：该表的状态码里**没有**「等待验收」这一类
  （只有 `DONE` / `PARTIAL` / `IN_PROGRESS` / `PLANNED` / `NEEDS_FIX` / `PAUSED` /
  `PRODUCTION_BLOCKER`），而该表规则第 3 条写明「完成编码后状态**最多**进入『等待人工验收』，
  **不直接标记 DONE**」。因此只把 `Next Step`（规则第 2 条允许更新的列）改为
  「等待人工验收」，**没有**为了好看而动 `Status`，更**没有**标 `DONE`。
- 「开始服务 — `accepted → serving`」保持 **`UNASSIGNED`**（未编号、未开始）。
- 本轮**不**把任何业务能力标为 ✅ —— 只有 Round 真正 `DONE` 之后才允许。

---

## Recommended Commit

> Coordinator 只给 title 与 body，**不执行任何 Git 写操作**。

**Title**

```text
feat: P0-5.5 小型架构稳定化——订单状态迁移表、管理员退款金额、打手接口清单门禁、Checkout 资格收敛
```

**Body**

```text
四处结构性收口，不新增任何可执行的状态迁移。

1. ORDER_TRANSITIONS + canTransitionOrder（lib/constants/orders.ts）
   冻结的结构边界：paid → accepted|refunded；accepted → serving|refunded；
   serving → completed|refunded；completed → refunded；refunded → []。
   只是「结构上是否允许」，不替代业务 Guard，也未被任何写入路径调用。

2. 管理员全额退款写入 refundedAmount（adminRefundTransaction.ts）
   修复「status = refunded 但 refundedAmount = 0」。
   金额取自被修改的那张订单的 actualPaidAmount，不取退款申请的 amount 快照。
   幂等由 applyOrderRefund 对已 refunded 的短路兜底。
   P0-5 公共池 timeout 自动退款路径未改动。

3. Companion API 路由清单门禁（tests/companion.test.mjs）
   只覆盖当前真实存在的两个接口；清单逐条列出地址 / 方法 / 守卫 / 预期服务层。
   不登记 /companion/orders（「开始服务」属后续 Round，仍为 UNASSIGNED）。

4. Checkout 复用 isCompanionAcceptingOrders()
   去掉同一规则的第三份拷贝；文案、错误码、失败语义一字未变。

验证：pnpm test 1055/944/0/111；APP_BASE_URL 全量 1055/1055/0/0；
typecheck / lint / build 全部 exit 0；13 个变异测试全部被捕获（含专打「守卫是第一个动作」的 5 个）。
Round 档案：docs/03-dev/rounds/P0-5.5/
```
