# P0-12 Decisions

Round: P0-12 · `paid` / `accepted` 用户免审批全额退款
Status: `AWAITING_ACCEPTANCE`（2026-09-25 同步；本文件**记录时点**的状态是 `IN_PROGRESS`，沿革见 §六）
Recorded At: 2026-09-24
原始指令: `01-prompt.md`（= `docs/03-dev/rounds/cmd_p0-12.md` 原样拷贝）
批次: `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md`（第三站：P0-10 → P0-11 → **P0-12** → P0-13）

> ⚠️ 本文件是**追加式**的（`development-workflow.md`）：后面的更正写在新章节里，
> **不覆盖**前面已写下的提问、裁定与结论。

---

# 一、Requirement Check（12 项逐条）

`development-workflow.md` §七 要求逐项确认「明确了吗」。下表逐条给出**依据**（不是「我觉得」）：

| # | 检查项 | 明确？ | 依据与结论 |
|---|---|---|---|
| 1 | 产品规则是否完整 | ✅ | `业务流程表.md` **BF-26 A**（`:847-874`）逐条列出：直接全额退款、不需要客服审批、不需要管理员决定比例、必须幂等；`用户权限表.md` §5.3 **PR-02**（`:224-236`，✅ 已确认）给状态表；`特殊情况表.md` **EX-REFUND-07**（`:631-645`，✅ 已确认）给六项细则 |
| 2 | 前置状态是否明确 | ✅ | `Order.status ∈ {paid, accepted}`（BF-26 A：「以下状态都属于『尚未开始服务』」）；`cmd_p0-12.md:13` 再确认一次「status=paid/accepted 且**未全额退款**」 |
| 3 | 成功状态是否明确 | ✅ | `Order.status = refunded` + `refundedAmount = actualPaidAmount`（BF-26 A / EX-REFUND-07 / `cmd_p0-12.md:18-19`） |
| 4 | 失败状态是否明确 | ✅ | 非本人 / 非 `paid`·`accepted`（含 `serving` / `completed` / `refunded`）一律拒绝；`cmd_p0-12.md:7` 明写「`serving`：不得 direct refund，进入售后」「`completed`：投诉/售后」 |
| 5 | 权限是否明确 | ✅ | `用户权限表.md:115`「未开始服务直接退款 \| 条件：**自己的订单**且 Order=paid/accepted，直接全额退款」——User 列 ✅、客服列 ❌、管理员列 ❌；`cmd_p0-12.md:13`「前端按钮不是权限真值」 |
| 6 | 金额是否明确 | ✅ | 全额，`refundedAmount = actualPaidAmount`；**不含任何比例**（比例属 P0-13）。`cmd_p0-12.md:40`「`refundedAmount` 不得超过 `actualPaidAmount`」；`:45`「本轮不提前实现 partial refund」 |
| 7 | 幂等是否明确 | ✅ | EX-REFUND-01（✅ 原则确认）+ EX-REFUND-07「重复点击/并发请求只允许一次有效退款」+ `cmd_p0-12.md:10`「Direct refund 必须幂等」、`:40`「重复 direct refund 不重复出款、不重复通知、不刷新退款事实」 |
| 8 | 并发是否明确 | ✅ | EX-REFUND-02（✅ 原则确认，P0-5 已有基础）：与公共池超时自动退款并发「只能形成一次 full refund」；`cmd_p0-12.md:42` 同一句 |
| 9 | 通知是否明确 | ✅ | `accepted` 时**必须**通知已接单打手（PR-02 / BF-26 A / EX-REFUND-07 三处一致）；`paid` 时无打手可通知（**没有「通知用户」的条目**——退款结果在订单页可见，本轮**不自己加**一条） |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ✅ **无命中** | 全文检索 `docs/02-tech-design/database-schema.md` 的「第三部分：TBD — DO NOT INVENT」：命中的是「复杂 Replacement / Assignment 聚合」「AfterSalesCase 实体」「部分退款公式」——**都不是本轮要建的东西**。本轮**不建新实体、不建新聚合、不写金额公式**（比例公式属 P0-13，本轮只用 `actualPaidAmount`） |
| 11 | 与现有架构规范是否冲突 | ⚠️ **有一处，且是本轮必须改的** | 见 §二。结论是**代码落后于已冻结需求**，不是文档冲突 → **不是 OPEN** |
| 12 | 是否与已有业务代码事实冲突 | ⚠️ 同上（同一处） | 同上 |

## 1.1 权威规则原文（三份文档一致）

```text
paid      → 用户可直接全额退款（免审批）
accepted  → 用户可直接全额退款（免审批，虽已有打手但尚未 serving）
serving   → 不得 direct refund，进入售后（P0-13）
completed → 投诉 / 售后（P0-13）
refunded  → 不允许再次退款
```

**⚠️ 结论：12 项全部明确，无 OPEN，无需问产品负责人，可以开发。**

---

# 二、与既有业务代码的**唯一**冲突（本轮修正它，不是产品裁定）

## 2.1 冲突是什么

| 位置 | 今天的事实 | 新规要求的 |
|---|---|---|
| `lib/constants/refunds.ts:107-112` `REFUNDABLE_ORDER_STATUSES` | 含 **`paid` / `accepted` / `serving` / `completed`** 四档 | `paid` / `accepted` **不得**再走「申请 → 人工审核」 |
| `lib/services/refunds.ts` `createRefundForOrder()` | 写一条 `RefundRequest`（`status="pending"`），**明确不动订单**（文件头规则 3：「提交退款不改订单状态……订单进入 `refunded` 只能由将来的审核流程完成」） | `paid` / `accepted` 必须**当场全额退款**，无审批环节 |
| `app/(mobile)/orders/[id]/refund/page.tsx` | 让用户填原因 / 说明 / 凭证，提交**申请** | `paid` / `accepted` 不该出现这张表单 |

## 2.2 为什么这不是「两份权威文档冲突」

- 三份权威需求（`业务流程表` / `用户权限表` / `特殊情况表`）**口径完全一致**，
  且各自带 **2026-09-23 的确认标记**（PR-02 ✅ 已确认、EX-REFUND-07 ✅ 已确认）；
- 冲突的一方**不是文档，是代码**：`docs/03-dev/需求功能点进度表.md:109` 与 `:245`
  早已把这一项挂成 🟠 `NEEDS_FIX`，并写明「**下批 `P0-12` 的目标**」；
- `用户权限表.md:448` 甚至专门写了一句「**客服不得把『未开始服务直接退款』强行转成人工审批**」——
  即：保留今天这条人工审核路径**本身**就是违规的。

## 2.3 为什么不两条路并存

保留「申请」同时新增「直接退款」，会让 `paid` / `accepted` 出现**两套退款路径**，
正是批次 §架构硬约束禁止的「第二套 Refund」；而且两条路对同一档状态给出**不同的业务结果**
（一条等审核、一条当场退），用户看到的按钮会是哪个，取决于前端怎么写——那就把
「钱怎么退」变成了前端事实。

**因此：`paid` / `accepted` 从 `REFUNDABLE_ORDER_STATUSES` 中移出，
`serving` / `completed` 保留在「申请 → 售后」路径上（那条路属 P0-13 的资金联动）。**

---

# 三、本轮的 Git 状态

**本批次（P0-10 → P0-13）禁止任何 Git 写操作。** 本轮交付**不提交**，全部改动留在工作区；
`HEAD` 仍是批次 baseline `3fbae6263794bda316b2b48dac03efd7f62afa01`（= `3fbae62`）。

⚠️ 工作区里同时躺着 **P0-10、P0-11、P0-12 三轮**的未提交改动。`03-delivery.md` 的
「本轮新增 / 修改」两张表按**本轮 delta**记录，不把累计 diff 冒充本轮 delta。

---

# 四、实现决策（D1–D12）

以下每条都是**代码能回答的**问题（`development-workflow.md` §八），因此**没有**拿去问产品负责人；
但每条都写清了「为什么不选另一种」，以便验收时逐条质疑。

## D1 · 新建独立伪事务 `directRefundOrder`，不塞进 `adminRefundTransaction`

`lib/data/directRefundTransaction.ts`（新增）。

两条路径回答的是**两个问题**：管理员那条是「**审不审**这笔退款申请」（写 `RefundRequest`
的状态与审核人，订单只是副作用，且只有通过时才写）；本轮的这条是「**用户当场把这一单退掉**」
（没有申请、没有审核人、没有审批环，写订单、派单与一条给打手的通知）。

合并成一个函数就必须在里面按「谁在调用」分支——那正是「一个函数两种语义」，
比两份各自短小的实现更容易写错。**但两者共用同一个订单写入原语 `applyOrderRefund`**：
「订单怎么变成 `refunded`」这件事全世界仍然只有一份实现。
`adminRefundTransaction.ts` 与 `mockDispatchRepository.applyDispatchTimedOut` 都**一字未改**。

## D2 · 幂等靠**状态与已退金额**，不引入幂等键

`cmd_p0-12.md:13` 把前置写成「status=paid/accepted 且**未全额退款**」——金额本身就在前置里。
因此判据是**事实**而不是调用方给的一个串：

1. `order.status === "refunded"` → `already-refunded`（**在金额判断之前**：退款时刻要从订单上读，
   不能从本次请求的 `at` 编一个出来）；
2. `order.refundedAmount >= order.actualPaidAmount` → `already-refunded`（状态还没变但钱退满了）。

第 2 条同时是「`refundedAmount` 不得超过 `actualPaidAmount`」的实现依据。
比幂等键更强的地方在于：它天然覆盖**不是同一个人点的第二次**——
超时清扫、管理员退款都会把订单写成 `refunded`，用户再点一次同样落回 `already-refunded`。

与超时自动退款的并发（EX-REFUND-02）因此是**两道**独立锁：
① 派单被关闭后 `sweepExpiredDispatches` 根本不再看它（它只处理开着的池）；
② 即使抢在关闭之前，`applyOrderRefund` 对已 `refunded` 的订单返回 `changed: false`。
两道都删掉才会重复出款，用例把两段都钉住了。

## D3 · 派单缺失、或打手没有 `userId`：**不阻断退款**

用户的钱**优先于**内部记账。让用户拿不回钱来为一个内部记录的缺失买单，
比「少关一条派单」「少发一条通知」糟糕得多。

- 派单记录不存在（数据异常）→ 退款照常完成，`dispatchClosed: false` 如实上报；
  登记为 `03-delivery.md` 的 MINOR。
- 接单打手的资料没有关联用户账号（预置 Mock 打手 `cp-1..cp-4` 的 `userId` 为 `null`）
  → **不存在能收信的地址**，因此 `notifiedCompanionUserId: null`，而不是「通知功能坏了」。
  真实路径（打手自己登录接单）必然带 `userId`：接单的人必须先是登录用户。

**依据不是本轮发明的**：`adminRefundTransaction.approveRefund`（P0-5.5）同样在不关派单的情况下
退款，由 `sweepExpiredDispatches` 事后自愈（`if (order.status !== "refunded")` 跳过重复通知）。
即：本仓库**不把「派单没关」当作退款的不变量违反**。

## D4 · `accepted` 退款：保留 `actualCompanionId` 与快照，**不写** release record，**不**动 Earning

批次 §历史语义 明文「**不得为代码统一抹平**」：cancel / ban / re-pool 的语义是「**换个人接着做**」，
退款是「**这一单到此为止**」。因此：

- `actualCompanionId` **保留**——它是「谁曾实际接下该单」的历史事实（PR-02 / EX-REFUND-07）；
- **不写 `CompanionReleaseRecord`**——那是「换人 / 被换下」的记录，这一单没换人；
- **不生成、也不冲正 `Earning`**——这不是「记得不要去建」，而是**结构性**的：
  收益只在 `settleOrderCompletion` 里产生，且带 `order.status === "serving"` 守卫；
  `paid` / `accepted` 从未进入过 `serving`，因此这一档**不可能**存在 Earning。

⚠️ 保留绑定还有一个**功能性**后果，是本轮顺带验证的：给打手的那条通知
`href` 指向 `/companion/orders/[id]`，而 `getCompanionOrderDetail` 的守卫是
`order.actualCompanionId === companionId`（**不看状态**）。若按 cancel 的做法清掉绑定，
这条通知就会变成一条**点不开的死链接**。P0-12 的生产构建实测该页 200。

## D5 · 通知：收件人是打手的 `userId`，`href` 指向打手端

这是仓库里**第一条收件人是打手、而不是下单用户**的通知。打手没有独立账号体系
（身份建立在用户会话上，`requireCompanion()` 底层就是 `requireUser()`），
因此收件人写 `Companion.userId`——这是他今天唯一能被送达的地址，**不是**把打手当成了下单用户。

`href` 必须是 `/companion/orders/[id]`：发给下单用户的 `/orders/[id]` 对打手是 404（那里会重新校验归属）。

文案（`REFUND_NOTIFICATION_COMPANION_REFUNDED`）**不写平台对他做了什么**，
与 `DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED` 同一纪律：他被退单的原因是
**客户在服务开始前取消了订单**，不是平台对他有任何处置。写「你被取消」会让他以为自己出了问题。

**`paid` 退款不通知任何人**，也**没有一条「通知下单用户」的通知**：
需求三处（PR-02 / BF-26 A / EX-REFUND-07）都只写了「通知已接单打手」，
退款结果在用户自己的订单页上可见。本轮**不自己加**一条（加了就是发明需求）。

## D6 · 两个状态集合不相交，互斥由**集合性质**保证

`REFUNDABLE_ORDER_STATUSES` 缩到 `["serving", "completed"]`；
新增 `DIRECT_REFUNDABLE_ORDER_STATUSES = ["paid", "accepted"]`。

`buildRefundActions` **不写** `canDirectRefund: !canRequestRefund` 之类的补丁——
那种写法会让「两条路径不能同时存在」变成某一处的判断，而不是集合本身的性质。
用例逐档断言交集为空、并集恰好是原来那四档（少一档就意味着某种订单的钱退不出来）。

## D7 · 新增 `hasRefundPath`，并让 `refundSeed.ts` 的不变量 2 改用它

**这是本轮最容易被误读的一处改动，单独说明。**

`refundSeed.ts` 有一条构造期自检：`pending` / `reviewing` 的预置退款，对应订单
「必须是可退款的业务状态」。它原本用 `isOrderRefundable` 判——D6 之后这个词**只指申请那条路**，
于是预置数据里两条**存量**申请（`rf-seed-1001-01` 挂在一张**已接单**的订单上、
`rf-seed-1002-01` 挂在一张**已付款**的订单上）会让 **seed 构造直接抛错**，
整个应用与测试套件都起不来（已实测复现）。

修法不是改预置数据，而是**把那条自检的问题说准**：它问的是
「这一单还能不能退」（与走哪条路无关），不是「这条申请此刻还能不能再提交一次」。
新增 `hasRefundPath(status) = isOrderRefundable(status) || canDirectRefund(status)`
——「拆之前那个问题」的现名，因此它今天**恰好仍等于原来那四档**。

⚠️ `hasRefundPath` **不是** `isOrderRefundable` 的别名。若将来有人拿它去当「能不能申请」用，
就是把两条路重新合并成一条——用例里有一条专门断言它恒等于两条路径的并集。

存量数据本身**有意保留**：两条进行中的申请挂在已付款 / 已接单的订单上，
是 P0-12 之前留下的**真实业务历史**，删掉它们等于让预置数据否认历史。处置方式见 §六。

## D8 · `DISPATCH_STATE_LABELS.timed_out`：「已超时关闭」→ 「已关闭」

**这是本轮发现的一处既有文案失真**，不是本轮引入的。

`applyDispatchTimedOut` 原本只有一位调用方（公共池到点清扫），因此展示名写成「已超时关闭」
是贴切的。本轮让它有了**第二位**调用方（用户直接退款）——此时
「已超时关闭」就是**假话**：用户是主动取消的，不是等超时。而这条谎**可复现**：
一张已被接单的单被直接退款后，派单记录上 `acceptedAt` 仍然填着，「超时」两字会与
「接单时间有值」自相矛盾，客服看订单详情时无从判断真相。

改法是**让标签对原因中性**（`已关闭`），而不是新增一个枚举值——`DispatchState` 属批次
§架构硬约束的「不得擅自扩」，而两种关闭对下游**行为完全相同**（不能再被接单）。

⚠️ **连带影响已同步、未静默**：`lib/types/dispatch.ts`、`lib/types/staff.ts` 的
`timedOutAt` 字段文档由「超时关闭的时刻」改为「**派单关闭的时刻**」（字段名是历史名，不改名）；
`components/staff/StaffOrderDetailPanels.tsx` 的行标签「超时时间」→「关闭时间」；
`docs/03-dev/rounds/P0-10/04-acceptance.md` 的 **E4** 期望文案同步，并加了一条 📌 注明由 P0-12 同步、
E4 的性质（不再是「公共池等待接单」）未变。
`lib/data/mockDispatchRepository.ts` 的 `applyDispatchTimedOut` 头注释补上两位调用方，
并写明**刻意不做成两个函数**——「关闭之后就接不了单」这条性质必须只有一处在保证。

## D9 · `canDirectRefund` 只由服务端给值；退款页的新分支必须排在 `refundSummary` 之前

`OrderAllowedActions` 增 `canDirectRefund`（`lib/types/order.ts`），与 `canRequestRefund` 并列，
**页面不拿 `status` 自己推断**（用例断言订单详情页源码里连 `"paid"` / `"accepted"` 字面量都没有）。

退款表单页 `/orders/[id]/refund` 新增一支「该订单可直接全额退款」的空态，
且**必须排在 `detail.refundSummary` 那一支之前**：存量数据里存在「已付款 / 已接单 +
一条待审核申请」的组合（D7 的两条），两支会同时成立；若先渲染进度页，
用户会被引向一条**永远等不到**的审批。用例断言这个顺序。

## D10 · 订单详情页：按钮文案「直接退款」+ 二次确认

`components/refunds/DirectRefundButton.tsx`（新增，客户端组件）。两个循环里已说明的点：

- **两下才退**（与 `RefundCancelButton` 同一理由：退钱不可逆，不接受误触）；
  第一下把按钮换成确认区，确认区**必须说清金额与后果**（退多少、退完之后这一单会怎样），
  而不是只问一句「确定吗」；
- **成功 / 「已全额退款」都走 `router.refresh()`**，不做本地状态镜像——订单变成 `refunded` 后
  服务端给的 `canDirectRefund` 随之变假、按钮自己消失。其余失败（例如已开始服务）
  **不刷新**：页面没有过期，是这件事本身不能做。
- 按钮文案「直接退款」是**短标签**，完整表述（「尚未开始服务，可全额退款，不需客服审核」）
  在确认区与退款页空态里。这是刻意的：ActionRow 一行放不下完整表述，
  而短标签旁边就是「申请退款」（已开始服务那条路），两者的区别由点击后的确认区说清。

## D11 · `DirectRefundOutcome` 的失败原因分开表达

`not-found` / `already-refunded` / `not-eligible` 三种，因为它们**要说给用户听的话不一样**：

| 结果 | 服务层 | 文案 |
|---|---|---|
| `not-found` | 与「不是本人」合成同一个 404 | 「订单不存在」 |
| `already-refunded` | 400 | 「该订单已全额退款，无需重复操作」 |
| `not-eligible` 且 `status === "serving"` | 400 | 「护航已开始服务，退款需通过售后申请，请联系客服」 |
| `not-eligible` 其余 | 400 | 「该订单当前不可直接退款」 |

「已开始服务」与「这单现在退不了」对用户是两件不同的事：前者**还有路可走**（走售后找客服），
后者没有。合成一句会让人以为没救了。

归属校验在**事务之前**（事务只回答「这件事在数据上此刻成不成立」，它不知道也不该知道「谁在问」），
且查不到与不是本人一律同一个 404，不泄露存在性。

## D12 · 连带修正的三个既有测试文件（**都是测试内的前置条件，不是业务规则改动**）

D6 让 `paid` / `accepted` 不能再申请退款，三个既有测试文件因此踩到了空前置。
改法一律是**换一张走申请路径的单 / 把订单推到能申请的状态**，没有一处放宽断言：

| 文件 | 原因 | 改法 |
|---|---|---|
| `tests/refunds.test.mjs` | 整个文件是「申请」路径的测试，却拿 `paid` / `accepted` 当可申请订单 | 可申请的两档改为 `serving` / `completed`；新增一段断言 paid / accepted **被接口拒绝且不留记录**；纯函数用例把这两档翻成 `false`；新增一条「两集合不相交、并集恰好四档」 |
| `tests/staffComplaintCrossRole.test.mjs` | `ORDER_FOR_REFUND` 是 `ord-seed-1001-11`（**已接单**），「用户提交退款」这一步走不通了 | 换成 `ord-seed-1001-10`（**护航中**、无预置退款记录），并注明为什么必须换 |
| `tests/staffReleaseHistory.test.mjs` | 用例要一条「进行中的退款申请」挂在**同一张单**上，而两次取消之后订单回到了**已付款** | 在申请之前补**第三次接单 + 打手点击开始服务**（走真实链路，不往 store 里塞记录），把订单推到护航中；这两步不产生退出历史，「退出过两次就是两条」的断言不受影响 |
| `tests/refunds.test.mjs` 的「预置数据自洽」 | 判据 `isOrderRefundable` 会否掉两条存量申请 | 判据改为 `hasRefundPath`（D7），并注明判的是「还有没有路可走」而不是「还能不能再申请」 |

---

# 五、待产品追认项（`REFERRAL`，不阻塞本轮）

**不是 OPEN**：本轮的实现与验收都不依赖这两条的答案，因此**没有**因此停工。
但它们确实需要一个产品结论，`03-delivery.md` 与 `04-acceptance.md` 都如实登记。

| # | 事项 | 现状 | 为什么需要裁定 |
|---|---|---|---|
| R1 | **存量「待审核」申请挂在已付款 / 已接单订单上时，用户点「直接退款」之后那条申请怎么办** | `directRefundOrder` **不碰**它：既不作废、也不标通过，它仍是 `pending`（用例钉住） | 「作废它」与「追认它」是两条**新的财务规则**（一条会改退款状态机，一条会牵扯二次出款）。本轮只做 D6 规定的全额退款，不替它作决定。今天它无害：订单已 `refunded`，**管理员**在既有审核界面看到它会自行处置 |
| R2 | **同上的「已拒绝」记录**（`ord-seed-1001-01`） | 同样原样不动，且不阻挡直接退款（前置只看状态与已退金额） | 同上。R1 / R2 是同一条规则的两半 |

两条的**验收影响**：人工验收时若点到这两张预置单，会看到「订单已退款 + 退款记录仍是原状态」。
这是**有意的**，不是数据错乱。

### 五.1 两处**更正**（2026-09-25 复核后追加，不改上面的裁定内容）

1. **能批准退款申请的不是客服，是管理员。** 上面 R1 原文写的是「客服在既有审核界面看到它
   会自行处置」，**这句话是错的**，已就地改正为「管理员」。事实依据：客服端在
   `app/api/staff/refunds/[id]/` 下只有 `start-review` / `reject`，**没有 `approve`**；
   `lib/constants/staff.ts` 的 `staffRefundAllowedActions` 里也没有 `canApprove`；
   `api-contract.md` 明写「客服端没有 `approve`」。**只有管理员能批准**。
   这改变了这件事的性质：它是一条**管理员点的资金动作**，不是客服的。
   （因此 R1 的裁定依据完全不变，变的只是「谁在按那个按钮」。）

2. **R1 / R2 同时是一道「真实支付接入前」的硬门禁**，不只是「待追认的存量」。
   今天无害这一结论经过逐行核实（**三条**独立事实）：`adminRefundTransaction` 调用的
   `applyOrderRefund` 对已是 `refunded` 的订单**先返回 `changed: false`**，
   既不重复累计 `refundedAmount`、也不刷新 `refundedAt`；`applyRefundReview`
   **只写退款记录，一行订单代码都不碰**；该路径**不发通知、不生成 Earning**。
   所以**今天不会有二次出款**。但 `approve` 这件事的语义就是**出款**：
   一旦接上真实支付通道，这条路径就是实打实的第二次出款。
   因此它的正确状态不是「已知且接受」，而是
   **「Mock 阶段可接受 / 真实支付接入前必须关闭」**——请把它排进支付接入轮的门禁。

---

# 六、中间状态历史

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-24 | `PLANNED` | `cmd_p0-12.md` 已读取，`01-prompt.md` 原样拷贝入档 |
| 2026-09-24 | `IN_PROGRESS` | Requirement Check 完成（12 项无 OPEN，§一），开始编码 |
| 2026-09-24 | `IN_PROGRESS` | D1–D12 落档；`refundSeed.ts` 自检改用 `hasRefundPath`（D7）后 seed 恢复可构造 |
| 2026-09-24 | `AWAITING_ACCEPTANCE` | 门禁全绿；第一轮 reviewer 返回 **0 BLOCKER / 0 MAJOR / 3 MINOR / 若干 NOTE**，3 条 MINOR 当轮整改完毕（M-1 注释改写、M-2 新增 `amount-invalid` 分支 + 用例、M-3 接口表去重） |
| 2026-09-25 | `AWAITING_ACCEPTANCE` | 第二轮 reviewer 复核整改结果：**0 BLOCKER / 0 MAJOR**——3 条 MINOR 经其逐条独立验证「真实成立、且未引入新问题」，N-2 的「用测试钉住、不加运行时校验」取舍被认可；据其 MINOR 补齐本档案的条目数与门禁读数、追加 §五.1 的两处更正（客服→管理员、R1/R2 兼作支付接入前硬门禁）。门禁在**最终树**上复跑全绿 |
