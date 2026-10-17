# P1-1 Decisions

> 本文件记录 **Requirement Check 的结论**与**本轮的口径裁决**。
> 没有任何 `Status: OPEN` —— 因此本轮**不进入 `CLARIFYING`**，直接 `READY`。

---

## §一、Requirement Check（`development-workflow.md` §七 的 12 项）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 产品规则是否完整 | ✅ 三项经营口径由本轮指令 §三 逐条定义（见 §三 的「权威来源」表）；待办口径由 §五 定义 |
| 2 | 前置状态是否明确 | ✅ 不适用——**本轮无状态迁移**，只读既有记录。订单 / 退款 / 投诉 / 申请的状态机一律不动 |
| 3 | 成功状态是否明确 | ✅ 「返回一份满足 `AdminDashboardDTO` 的只读快照」；Admin 会话下 `200` |
| 4 | 失败状态是否明确 | ✅ 未登录 `401`、非 admin 会话 `403`（复用 `requireAdmin()`）；取数故障由现有错误信封与 `error.tsx` 承担 |
| 5 | 权限是否明确 | ✅ §十一 五行矩阵；**复用现有 Admin auth**，即 `lib/api/adminRoute.ts requireAdmin()` 与 `app/admin/(console)/layout.tsx` 的重定向，**不建第二套身份系统** |
| 6 | 金额是否明确 | ✅ 见 §三·D3–D6：整数分、`actualPaidAmount`、按事件归属、不倒扣 |
| 7 | 幂等是否明确 | ✅ 不适用——**纯读**。没有写入、没有幂等键、没有可重放的副作用 |
| 8 | 并发是否明确 | ✅ 不适用——只读快照；同一秒并发读同一份 store 不会互相影响。**不引入任何新的一致性要求** |
| 9 | 通知是否明确 | ✅ 不适用——本轮不产生任何通知 |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ✅ **无**。见 §四 的三处「本以为要问、查证后不必问」 |
| 11 | 与现有架构规范是否冲突 | ✅ 无冲突，且**刻意贴齐** `architecture-rules.md`：页面不碰 store、Route 不写统计、不建第二套仓储、不复制业务规则（见 §六） |
| 12 | 是否与已有业务代码事实冲突 | ⚠️ **有一处需要改口径的既有事实**：`ADMIN_OVERVIEW_NOTICE` 明文说本页「只汇总入驻申请与护航规模，订单、退款与投诉在各自的页面里查看」。P1-1 之后**这句话不再成立**，必须跟着事实改（该常量自己的注释就写着「这句话必须跟着事实改」）。处置见 §五 |

---

## §二、Requirement Check 的文档侧结论

| 文档 | 结论 |
|---|---|
| `docs/01-requirements/超哥电竞_用户权限表.md` §8 | ✅ 管理员定位「平台规则 + 经营配置 + 人员权限 + **最终资金权** + 监督」；§8.3 明文「查看全平台订单 / 查看资金快照」、§8.4「平台资金相关最终管理权限」⇒ **Admin 看经营金额有权威依据**，无需新增权限语义 |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` `EX-INFRA-04` | ✅ 「**核心业务成功，派生统计失败**」：派生统计**只能靠事件重放/重算/补偿**，**禁止为了统计失败回滚真实资金事实**。本轮 Dashboard 是**纯派生读**，不参与任何写入 ⇒ 与这条原则方向一致（也说明「今日退款」必须从**事件**算，不能从累计值算，见 §三·D5） |
| `…特殊情况与异常处理表.md` §21 核心原则 1 | ✅ 「支付/退款/提现等资金事实优先于派生统计」——同上 |
| `docs/02-tech-design/architecture-rules.md` | ✅ 分层、唯一真值源、金额规则全部遵守；**没有为 Dashboard 新增任何规则** |
| `docs/03-dev/总需求进度表.md` | ⚠️ 本轮交付后需同步（见 §七） |
| `docs/03-dev/需求功能点进度表.md` | ✅ **本轮正好是该表的第 6 项 P1 推荐**：「管理后台『今日』口径统计（今日订单数 / 成交额 / 退款金额 / 待处理事项汇总）」，其备注写明「当前概览页 7 张卡**全是累计**，运营看不到当天」。本轮 4 个 `NOT_IMPLEMENTED` / `PARTIAL` 行（今日订单数 / 今日成交额 / 今日退款金额 / 待处理事项）因此落地 |
| 当前 `/admin` | ✅ 已读：`app/admin/(console)/(overview)/page.tsx` + `lib/services/adminConsole.ts`（只读聚合服务，**并发读骨架可照抄**）+ `components/admin/AdminMetricCards.tsx` |
| Admin Order / Refund / Complaint / Application 的 repository | ✅ 只读能力齐备：`queryOrdersForAdmin` / `listAllOrders`、`queryRefundsForAdmin`、`queryComplaintsForAdmin`、`countApplicationsByStatus` |
| 当前 auth | ✅ `requireAdmin()` 一处定义；`canEnterAdminConsole(role)` 是全站唯一的「是不是管理员」判断 |

**⇒ 无一处理论上需要用户裁定的阻塞问题，不进入 `CLARIFYING`。**

---

## §三、口径裁决（D1–D8）

> 本轮的指令 §二 写明「**优先采用权威需求已有口径**；若没有更明确的冲突定义，
> 本轮统一采用下面的产品口径」。逐条查证后：**权威需求对这三项经营指标没有任何更明确的定义**
> （`grep GMV / 成交额 / 营业额 / 经营` 在 `docs/01-requirements/` 只有角色描述，没有口径），
> 因此**全部采用本轮指令 §三 给出的口径**，并由我把它们落成可执行规则。

### D1 · 今日订单数 = 今日 `paidAt` 落在当前业务日的**已形成订单**数

- 判据：`isOnBusinessDate(order.paidAt, businessDate)`，**用显式 `paidAt`**。
- **不用 `createdAt`**：指令 §3.1 明确「优先使用明确的 `paidAt`」，而本模型**确实有** `paidAt`
  （`lib/types/order.ts:67`）。查证结果：订单在**支付成功那一刻**才生成
  （`lib/data/mockPaymentRepository.ts` 的 `confirmPaymentRequest` 仅当 `status === "success"`
  才 `buildOrder(request)` 写入），因此 `createdAt` 与 `paidAt` 在本模型下**语义等价**——
  既然显式字段存在，就用显式字段，并把「等价」这件事**只作为注释**写下，不作为实现依据。
- **「成功形成的订单」= `getPaymentRepository().listAllOrders()` 里的每一条**：这是订单仓储
  的唯一真值源。支付请求（`PaymentRequest`）、支付失败与取消**不在订单仓储里**，
  因此「不得统计 preview / payment attempt」是**结构性成立**的，不是靠过滤条件成立。
- ⚠️ **不含**任何状态过滤：一张今天支付、随后今天全额退款的订单，**今天仍然计入订单数**
  （它确实成功形成过）。这与 D4 的「GMV 不倒扣」是同一条原则。

### D2 · 业务日边界 = **北京时间（固定 UTC+8）**，且与 `formatDateTime` 同一份实现

- 项目当前业务时区就是固定 UTC+8（`lib/utils/format.ts` 的 `BEIJING_OFFSET_MINUTES = 8 * 60`），
  与指令 §四 的前提一致。
- 实现方式：**先算出业务日键**，再用**同一个键**去归属每一笔事件：

  ```text
  businessDate = beijingDateKey(now)                     // "YYYY-MM-DD"，北京时间
  某事件是否今日 = beijingDateKey(事件时刻) === businessDate
  ```

  `beijingDateKey()` 是**本轮新增的纯函数**，实现是 `formatDateTime(iso).slice(0, 10)` ——
  **直接复用项目里唯一的那份时区实现**（`formatDateTime` 刻意不用 `Intl`，
  固定偏移、任何环境结果相同）。
- **为什么不另写一套毫秒边界**：`lib/constants/rankingPeriods.ts` 里已有 `beijingDayStart()`
  这类毫秒边界工具，但这里**刻意不引入第二种「今天」的算法**——业务日归属在本项目里
  已经有既定口径：管理端订单列表的日期筛选走 `orderBeijingDate()`（= `formatDateTime(...).slice(0,10)`，
  `lib/constants/orderFilters.ts:91`）。用日期键就与那份口径**天然一致**，
  不会出现「按 `formatDateTime` 显示 09-27、却被另一套边界算到 09-26」。
- **浏览器一侧不参与任何时间计算**：`businessDate` 由**服务端**算好放进 DTO，
  页面只把它当字符串展示。指令 §四 的「不得浏览器算一套、Service 算另一套」
  因此是**结构性成立**的（客户端根本没有时间输入）。

### D3 · 今日 GMV = 今日支付成功订单的 `actualPaidAmount` 之和（整数分）

- 判据：与 D1 **同一批订单**（同一个 `isOnBusinessDate(paidAt, businessDate)` 谓词），
  金额取 **`actualPaidAmount`**。
- **不用 `originalAmount` / `totalAmount`**：`actualPaidAmount` 是「用户实付」，是分账的起点
  （`lib/types/order.ts:125` 的 TSDoc）。原价 ≠ 实付（有优惠 / 加价）时用实付 —— 这条由
  `tests/adminDashboard.test.mjs` 显式用「原价 ≠ 实付」的构造订单守着。
- **退款不倒扣**：GMV 只累加，不减今日退款、也不因订单后来被退款而回滚。今日退款单独成指标（D5）。
- **不用打手收益 / 平台收入代替**：GMV 是成交规模，不是平台收入。
- 单位：**整数分**（与全仓一致），只在展示层 `formatYuan()` 转元。

### D4 · 今日退款金额 = 按**退款事件时刻**归属的、当日实际执行的退款额之和

这是本轮**最容易做错**的一项，因此把规则写全：

- **归属按事件时刻，不按原订单日期**：一张 9/26 支付的订单在 9/27 退款 ¥30，
  则 9/26 的 GMV 不动，9/27 的今日退款 = ¥30。
- **两个来源，必须都算**（这是本模型的事实，不是取舍）：

  | 来源 | 事件时刻 | 金额 |
  |---|---|---|
  | 售后审核通过（`RefundRequest`，状态 `approved`） | `decision.decidedAt` | `decision.refundAmount`（**逐事件**，同一订单可以有**多条**） |
  | 直接全额退款（`directRefundOrder`） | `order.refundedAt` | 该次退款**实际退出去的增量**（见下） |

- **⚠️ 直接退款不写任何 `RefundRequest` 记录**（P0-12 起就是如此：它只写订单字段、关派单、发通知），
  因此**只看退款仓储会漏掉整整一类退款**。反过来，**`order.refundedAt` 也不能单独用**：
  售后链路退满时同样会写它（`applyOrderRefund` 在「退满」那一刻写 `refundedAt`）。
  两条来源必须**互补**，判据是「这张单有没有已通过的退款申请」：

  ```text
  已通过退款申请的金额和 approvedSum(order) = Σ decision.refundAmount（该订单全部 approved 记录）
  若 order.refundedAt 落在今日：
      直接退款增量 = actualPaidAmount − approvedSum(order)
      该增量 > 0  ⇒  这是一次「直接退款」，计入今日
      该增量 = 0  ⇒  整单是售后退满的，**已在上面按事件算过**，这里不重复计
  ```

- **为什么这样算就等于「这一次退了多少」**：`directRefundOrder` 退的是**剩余可退额**
  （`actualPaidAmount − refundedAmount`），退完订单进 `refunded`。因此
  「订单实付 − 售后已通过的金额」正好是**那次直接退款退掉的增量**；
  若此前有部分退款（无论发生在哪一天），它已经被那一天的「按事件累加」算过了，
  在这里被减掉，**不重复**。
- **明令禁止的做法**（指令 §3.3 明文）：**不得用 `Order.refundedAmount` 累计值统计**。
  它是累计快照，跨日多次退款时会重复计数。本实现**完全不读它**（除展示层的排序/筛选语境之外
  本文件一行都不用它）。
- **同一订单多次部分退款**：每条 `RefundRequest` 各带 `decision.refundAmount` 与 `decidedAt`，
  逐事件累加；同日多次部分退款自然累加，跨日的各归各日。

### D5 · 待办 = 「尚未终结且仍需 Admin 动作」的计数，**不发明任何新状态**

| 卡片 | 计数口径 | 为什么 |
|---|---|---|
| 待处理申请 | `CompanionApplicationStatus` 的 **`pending` + `reviewing`** | 二者都还需要管理员动作；`approved` / `rejected` / `withdrawn` 是终态（`withdrawn` 是**用户自己**撤的，不是待办） |
| 待处理退款 | `RefundStatus` 的 **`pending` + `reviewing`** | 同上；`approved` / `rejected` / `cancelled` 都不再需要管理员动作 |
| 待处理投诉 | `ComplaintStatus` 的 **`pending` + `processing`** | 同上；`resolved` / `closed` 是终态 |

⚠️ **上面这张表的口径没有变，但下面两条实现描述已在验收前被 R6 裁定推翻，见 §八。**
保留原文是为了让「当时是怎么想的」可查，**不是因为它还是对的**：

- **状态取值全部来自既有枚举**，本轮**没有新增、也没有重定义**任何状态（指令 §5.4 明令）。
  → ✅ 这一条**仍然成立**，R6 之后依然如此。
- ~~三个计数都是**仓储真值**：申请走 `countApplicationsByStatus()`，退款 / 投诉走
  `queryRefundsForAdmin({status:null})` / `queryComplaintsForAdmin({status:null,type:null})`
  后按上面的**纯函数**过滤——过滤规则写在常量层（`lib/constants/adminDashboard.ts`）。~~
  → ❌ **已被 R6 取代（§八）**。两个问题：
  (1) 过滤规则写在首页常量文件里，等于与各列表模块的筛选**各写一份**——这正是
  「卡上 2/4/3、点进去 1/3/1」的病根；(2) 按 `status:null` 取回全量再自己数，
  会与列表服务**多一层可能分叉的过滤**（退款列表会丢掉订单查不到的记录）。
  现在的做法：状态集合各自定义在**领域常量文件**里，计数直接取列表服务的 `total`。
- **只加这三类**：指令 §5.4 允许「权威需求已明确属于 Admin 的事项」。查证后没有第四类
  既权威又已实现的 Admin 待办（提现 / 会费批扣 / 人工调余额都**未实现**，属 §十三 明确不做），
  因此**不加**。

### D6 · DTO 字段名：`pending.refunds`（不是示例里的 `aftersales`）

- 指令 §八 给出的是**示例**，并明写「**具体字段按现有项目命名风格调整**」。
- 本项目**没有「售后」这个聚合实体**：`lib/constants/admin.ts` 的既有注释明确写着
  「退款与投诉是**两个模块**，不是一个『售后』模块」。把「退款申请计数」命名成 `aftersales`
  会与这条已登记的判断冲突，并让后来人以为存在一个售后实体。
- 因此取 **`refunds`**（与页面标题「退款审核」、仓储 `RefundRepository`、既有
  `lib/services/adminRefunds.ts` 同名同源）。这是一个**登记过的命名偏离**，
  行为与指令 §5.2 的要求完全一致（统计尚未终结且仍需 Admin 处理的退款）。
- 其余字段名**逐字采用指令示例**：`businessDate` / `metrics.todayOrderCount` /
  `todayGmvAmount` / `todayRefundAmount` / `pending.applications` / `pending.complaints`，
  后缀 `Amount` 也与仓内既有风格一致（`actualPaidAmount` / `refundedAmount`）。

### D7 · 保留既有 7 张「全量累计」卡，另立「今日经营 / 当前待办」两段

- 既有概览的 7 张卡（申请 4 + 护航规模 3）是**真实仓储计数 + 真实筛选链接**，
  且已有测试守着。本轮**不删**：它们回答的是「全量的分布」，与「今天怎么样」是两个问题。
- 页面结构因此是：**今日经营（3 卡）→ 当前待办（3 卡）→ 快捷入口 → 申请与护航规模（既有 7 卡）**，
  既有那一段的标题补上「（全量累计）」把口径说清楚，避免读者把两类数字混为一谈。
- 指令 §九 的要求是「**至少**」这三段，**没有要求删除既有内容**；`01-prompt.md` §十三
  「明确不做」里也没有「移除既有卡片」。**删除已验证过的既有能力不在本轮授权范围内。**

### D8 · 「今日」的取数不从页面发起第二次时间计算，也不新增仓储

- 一次 `Promise.all` 并发读四个既有仓储（订单 / 退款 / 投诉 / 申请计数），
  聚合与所有判定都在服务层与常量层的**纯函数**里完成。
- **不建第二套 `OrderRepository` / `RefundRepository`**（指令 §七 明令），
  统一走 `getPaymentRepository()` / `getRefundRepository()` / `getComplaintRepository()` /
  `getCompanionApplicationRepository()`。
- **不在 Route Handler 写统计逻辑**：Route 只有三行——`requireAdmin()` → 取 `searchParams`
  → 调服务层。统计逻辑一行都不在 `app/api/**` 里。

---

## §四、三处「本以为要问、查证后不必问」

按协议 §八「用代码就能回答的问题去问用户，是在浪费用户的时间」，以下三处我**先查证再动手**：

1. **「今日订单数要不要按状态过滤？」** —— 不需要新裁定。
   `EX-INFRA-04` 与 §21 原则 1 已经定了「资金事实优先于派生统计」，
   而指令 §3.2 又明说「GMV 是成交规模指标，退款单独体现」。两条一起读只有一个答案：
   **成功支付过就计入，退款不倒扣**（D1/D3）。
2. **「业务日边界用 UTC+8 还是别的？」** —— 项目当前就是固定 UTC+8，
   而且**已有唯一实现** `formatDateTime` / `orderBeijingDate`。复用即可（D2）。
3. **「待办要不要算 `reviewing` / `processing`？」** —— 指令 §5.2 已经写了判据
   （「尚未终结且仍需 Admin 处理」，并点名排除 `approved`/`rejected`/`closed`），
   按状态机逐格判断即可，无需再问（D5）。

---

## §五、与既有文档/常量的一处**必须同步的**事实（已处置）

`lib/constants/admin.ts` 的 `ADMIN_OVERVIEW_NOTICE` 原文：

> 「数字从本地 Mock 仓储实时聚合，不是写死的展示值；**本页只汇总入驻申请与护航规模，
> 订单、退款与投诉在各自的页面里查看。**」

该常量自己的注释就写着「**这句话必须跟着事实改**——说『属于后续阶段』会让人以为
侧栏里那三个入口是摆设」。P1-1 之后本页**确实**汇总了今日订单、今日 GMV、今日退款与待办，
因此：

- **改这句话**（新文案见 `03-delivery.md` §2.2），保留「数据来自实时聚合、不是写死展示值」这半句；
- `需求功能点进度表.md` 里那几行**正是拿这句话当 `NOT_IMPLEMENTED` 的证据**
  （「`ADMIN_OVERVIEW_NOTICE` 明确『本页只汇总入驻申请与护航规模』」）⇒ 该证据在本轮**失效**，
  对应行必须同步更新（见 §七）。
- 这是**既有文档跟着事实改**，不是新增规则：旧文案本身没有冻结任何业务规则，
  它只是一句会过期的事实描述。

---

## §六、明确**不**做的事（与指令 §六 / §十三 对齐）

- **不做任何写入**：不审批、不退款、不换人、不封禁、不改商品、不改申请状态。
  Dashboard 的三个动词只有「聚合 / 展示 / 跳转」，点卡片进入**既有**管理页处理。
- **不复制业务动作**：没有「一键通过」这类入口，也没有任何**会改数据**的按钮。
- **不新增业务状态**、**不重定义角色**、**不建第二套管理员身份**。
- **不做**：趋势图、DAU、留存、复购、LTV、用户画像、打手画像、WebSocket 实时 Dashboard、
  数据仓库、真数据库、Scheduler、提现、钱包、会员、P0-14 retention、新售后处置规则。
- **不动 P0-14 的任何实现、测试或状态**（P0-14 仍停在 `AWAITING_ACCEPTANCE`）。

---

## §七、本轮之后需要同步的文档（交付时执行）

| 文档 | 同步内容 |
|---|---|
| `docs/02-tech-design/api-contract.md` | 新增 `GET /api/admin/dashboard`，接口计数 +1 |
| `docs/03-dev/总需求进度表.md` | 新增 P1-1 行（🟣 待验收），注明与 `需求功能点进度表.md` 第 6 项 P1 推荐的对应关系 |
| `docs/03-dev/需求功能点进度表.md` | 今日订单数 / 今日成交额 / 今日退款金额 / 待处理事项四行的状态与证据更新（**不写 ✅**——全局进度的 ✅ 只在 Round `DONE` 之后才写，协议 §十八） |

---

## §八、R6 正式裁定与它的落地（验收前 fix · 2026-09-27）

### 裁定原文

> **R6 · Dashboard 数量必须与点击后的列表一致。**
> 新增查询别名 `status=open`。`open` 仅是查询层虚拟值：不是领域状态、不写入
> store/database、不进入业务状态机。Dashboard 三张待办卡统一跳转对应 `?status=open`。
> 每个领域必须建立唯一状态集合/纯函数，例如 `OPEN_APPLICATION_STATUSES`、
> `OPEN_REFUND_STATUSES`、`OPEN_COMPLAINT_STATUSES`。Dashboard 计数与列表
> `status=open` 必须复用同一份定义，**禁止复制第二套**。真实单状态过滤继续兼容；
> 非法 status 保持既有契约；open 与搜索/分页/其它已有筛选可组合。

（全文见 `cmd_p1-1.md` §六，已逐字留存在 `01-prompt.md`。）

### 被推翻的是什么

裁定推翻的是**我在交付过程中对一条审查意见（M2）的处置**，不是某个实现细节。

当时的事实是：首页卡片按 `PENDING_*_STATUSES` 自己数，链接写死单值 `?status=pending`，
于是**卡片 3 条、点进去 0 条**（投诉），卡片 2 条、点进去 1 条（申请）。
我的处置是「保留这个不一致，在卡片提示文案里说明『列表默认只筛待审核一档』」，
并把它登记成一条后续事项。

**那个处置是错的。** 它把一个用户会当场看到的功能缺陷，写成了一段只有读了提示文案
才成立的免责声明。裁定给出的判据更简单也更硬：**卡片上的数就是点进去能看到多少条**，
做不到就改到做到。

### 落地后的形态

| 关注点 | 落地位置 | 形态 |
|---|---|---|
| 入驻申请的「未终结」 | `lib/constants/adminApplications.ts` | `OPEN_APPLICATION_STATUSES = ["pending","reviewing"]` |
| 退款的「未终结」 | `lib/constants/refunds.ts` | `OPEN_REFUND_STATUSES`，**就是既有的 `ACTIVE_REFUND_STATUSES` 那个数组对象本身** |
| 投诉的「未终结」 | `lib/constants/complaints.ts` | `OPEN_COMPLAINT_STATUSES = ["pending","processing"]` |
| 虚拟值 → 真实状态集合 | 各领域的 `*StatusesForFilter()` | `"all"` → `null`（不限）；`"open"` → 该领域集合；其余 → `[值]` |
| 三张卡的计数 | `lib/services/adminDashboard.ts` | 直接取三个列表服务在 `status=open` 下的 `total` |
| 三张卡的链接 | `lib/constants/adminDashboard.ts` | 一律 `?status=open`（申请那条由 `ADMIN_APPLICATION_LIST_HREF("open")` 生成） |

### 几个刻意的选择

- **`OPEN_REFUND_STATUSES` 不新写一份，而是指向 `ACTIVE_REFUND_STATUSES`。**
  退款域在 P1-1 之前就已经有 `ACTIVE_REFUND_STATUSES`，被 8 处业务路径在用
  （订单阻断、退款重申拦截、评价、客服完工校验……）。若「待处理」另写一份内容相同的表，
  「列表里能重申退款、首页却说没有待办」这类分叉会重新长出来。测试用
  `assert.equal`（**引用相等**）而不是 `deepEqual` 钉住这一点。
- **`isUnresolvedComplaintStatus()` 改成读 `OPEN_COMPLAINT_STATUSES`。**
  投诉域此前也有一个「未解决」判据，同样在用。让两个名字背后是同一个集合，
  比让它们「内容恰好相同」可靠。
- **仓储契约从 `status: Status | null` 改成 `statuses: readonly Status[] | null`。**
  这样 `open` / `all` 在**类型上**就进不了数据层——「虚拟值不落库」这句话因此有一个
  可执行的形态，而不是靠自觉。测试里另有一条源码级断言：**六个数据层文件**
  （三个仓储接口 + 三个 Mock 实现）里不得出现字符串 `"open"` / `"all"`。
- **计数改为「取列表服务的 `total`」而不是「按状态集合再数一遍」。**
  除了同源之外，它还消掉了一处更隐蔽的分叉：退款列表在服务层会丢掉**订单查不到的**
  退款（`row.order !== undefined`）。自己数会把这一条算进卡片却不出现在列表里。
  代价（每个列表的整页取数也要跑一遍）已登记为迁移项。
- **`AdminApplicationTable` 的筛选角标改用 `applicationCountForFilter()`。**
  改动的直接起因是 `tsc` 报错（`counts[item]` 里的 `item` 现在可能是 `"open"`），
  但它是**真缺陷**：不修的话筛选栏会显示「待处理（）」——`counts["open"]` 是 `undefined`，
  不报错、只是安静地少一个数。现在它显示的是「待审核 + 审核中」的和，与卡片同一个数。

### 兼容性

- **单状态筛选语义不变**：`?status=pending` 仍然只筛 `pending`，**没有**被悄悄扩成 `open`。
- **非法 status 契约不变**（仍是 400 + 同一句话），只是那句枚举里多了一个合法值 `open`。
- **staff 端不认识 `open`**：`readStaffRefundStatusFilter` / `readStaffComplaintStatusFilter`
  的联合类型里没有它，因此客服端传 `open` 照旧 400。共享的是**服务层解析**，
  不是**筛选联合**，这一点在改动时刻意核对过。
- **`open` 可与关键词 / 分页组合**：`open` 只决定状态集合，与关键词、排序、分页正交。

### 红绿验证（这次的测试不是「写完就绿」）

把 `refundStatusesForFilter("open")` 临时改成 `["pending"]` 后重跑：

- 第一轮（只有「相等」类断言时）：**43–47 全部照旧通过**，只有定义类的经营 19 失败。
  → 说明当时的「相等」断言是**平凡的**：预置数据里没有 `reviewing` 的退款，
  `open` 与 `pending` 恰好数出同一个值。
- 补上「把一条退款从 `pending` 推进到 `reviewing`，并要求 `open` 严格多于 `pending`」
  之后：**经营 44 失败**，符合预期。这条断言现在是这次 fix 的守门人。

教训记在这里：**「两个数相等」在数据恰好相等时是恒真式。**
判断一致性必须让数据**动一下**，或者要求一个**严格不等**作为对照。

### 落地之后的第二轮只读审查（R6 fix 自身的 review）

R6 改动做完后另跑了一轮 `reviewer-agent` 只读复审，结论 **0 BLOCKER · 1 MAJOR · 4 MINOR · 4 NOTE**，
全部处置完毕。此处只记与**口径**有关的那一条 MAJOR：

> `lib/services/staffConversations.ts` 的 `countPendingPlatformWork()` 里**还留着第二份
> 「未处理」状态集合**（`=== "pending" || === "reviewing"`、`=== "pending" || === "processing"`）。

它正是本次裁定要消灭的形态——而且就藏在刚动过的那个函数里。今天三处取值相同，
所以**当前不会出错**；但产品只要把某个新状态并入「待处理」，首页卡片会算上它、
客服工作台不会，**且没有任何测试会失败**（那两行此前没有任何测试钉住）。

处置：判据改为 `OPEN_REFUND_STATUSES.includes(...)` 与 `isUnresolvedComplaintStatus(...)`
（后者同样指向 `OPEN_COMPLAINT_STATUSES`），并补了一条用例——**正例**（断言 `4` / `3`，
只数 `pending` 的实现会得到 `3` / `1`）+ **源码探针**（该文件里不得再出现
`"reviewing"` / `"processing"` 字面量）。红绿验证：把实现变异回字面量后，
**只有探针变红**（计数断言不变红，因为今天两种写法取值相同）——这恰好说明
「第二份定义回来」这件事只能靠源码探针挡住。

⇒ 由此确立一条本项目的**判据唯一性**原则：**一个业务问题只允许有一个判据落点**；
若某个数字需要出现在多处（首页卡片、工作台、列表），那几处必须**引用**同一个集合或谓词，
而不是各写一份「内容恰好相同」的字面量。
