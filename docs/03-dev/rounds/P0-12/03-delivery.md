# P0-12 — 交付记录

Round: P0-12 · 未开始服务的订单**免审批直接全额退款**（`paid` / `accepted`）
Status: `AWAITING_ACCEPTANCE`
Delivered At: 2026-09-24
原始指令: `01-prompt.md`（= `docs/03-dev/rounds/cmd_p0-12.md` 原样拷贝）
批次: `docs/03-dev/rounds/cmd_batch_p0-10_to_p-13.md` 的第三站（P0-10 → P0-11 → **P0-12** → P0-13）
Git: 本批次**禁止任何 Git 写操作**，因此本轮交付**未提交**，全部改动留在工作区（见 §十）。

---

## 一、本轮做了什么

`cmd_p0-12.md` 的每一节逐条对照：

| 指令（`cmd_p0-12.md`） | 落点 |
|---|---|
| 前置：`status = paid / accepted` 且**未全额退款** → 直接退款、免审批（`:44-45`） | `lib/constants/refunds.ts` 的 `DIRECT_REFUNDABLE_ORDER_STATUSES` + `canDirectRefund()`；`directRefundOrder` 的**状态与已退金额**双重判据 |
| 退款后订单立刻 `refunded`，钱全额退回 | 复用**既有的唯一**订单写入原语 `applyOrderRefund()`（`lib/data/mockPaymentRepository.ts`）——没有第二份「订单变 refunded」的实现 |
| 金额不可由客户端指定 | 请求体**完全不读**（`route.ts` 里连 `readJsonBody` 都没有 import）；金额取 `order.actualPaidAmount` |
| `accepted` 单退款要给**被退单的打手**发通知 | `REFUND_NOTIFICATION_COMPANION_REFUNDED` + `appendNotification`，与退款**同一原子区段** |
| 派单在退款时关闭，不得再被接单 | 复用 `applyDispatchTimedOut()`（**它因此有了第二位调用方**，见 §1.3） |
| 保留「谁曾实际接下该单」的历史（批次 §历史语义 `:47-51`） | `accepted` 退款**不清** `actualCompanionId`、**不写** `CompanionReleaseRecord`（见 §1.2） |
| 不改订单状态机 | `OrderStatus` 一个枚举值都没加；`paid → refunded` / `accepted → refunded` 是**既有边** |
| 不加第二套 Order / Refund / Notification / Auth | 零新增仓储、零新增 Store；通知复用 `appendNotification` |
| 用户端入口 | `components/refunds/DirectRefundButton.tsx` + `app/(mobile)/orders/[id]/page.tsx` |
| 浏览器出口 | `POST /api/orders/[id]/direct-refund` → `directRefundOrderForUser` → `directRefundOrder` |
| **不做**售后（`serving` / `completed` 的按比例退） | 未实现；那是 P0-13，本文件与事务里**没有任何** `earning*` 依赖（有门禁） |
| **不做**任何 Git 写操作 | 见 §十 |

### 1.1 本轮唯一的**结构性**取舍：把两条退款路径**拆开**，而不是在一个函数里分支

P0-12 之前，`isOrderRefundable()` 一个概念管四档状态。本轮之后它变成**两个互斥集合**：

| 集合 | 状态 | 用户在做的事 | 出口 |
|---|---|---|---|
| `REFUNDABLE_ORDER_STATUSES` | `serving` / `completed` | 向客服**申请**退款，等审核 | `POST /api/orders/[id]/refunds` |
| `DIRECT_REFUNDABLE_ORDER_STATUSES` | `paid` / `accepted` | **当场退掉**这一单 | `POST /api/orders/[id]/direct-refund` |

**这不是「多加了一条路」，而是「同一种订单原本会出现两种互斥的业务结果」被消除**：
如果两档同时可申请、又可直退，用户点哪个按钮就退成什么样——一条当场退钱、一条等审核。
`用户权限表.md:448` 写得更死：「客服不得把『未开始服务直接退款』强行转成人工审批」，
也就是说让这两档走人工审核**本身**就是违规的。因此集合**必须**不相交，
且这条性质由**集合本身**保证（`tests/refunds.test.mjs` 逐档断言交集为空、并集恰好四档），
不靠某一处的 `if` 补丁。

### 1.2 `accepted` 退款**保留** `actualCompanionId` —— 这是本轮最容易被「顺手统一」掉的一处

批次文件 §历史语义（`:47-51`）明文：**不得为代码统一抹平**。三类「清绑定」的事语义不同：

| 事 | 语义 | `actualCompanionId` | `CompanionReleaseRecord` |
|---|---|---|---|
| `companion_cancel` / `staff_reassign` / `companion_disabled` | **换个人接着做** | 清（已有新的人） | **写** |
| **P0-12 直接退款** | **这一单到此为止** | **保留**（谁曾做过是历史事实） | **不写**（没换人） |
| `sweepExpiredDispatches` 超时退款 | 从未有人接过 | 本来就空 | 不写 |

保留绑定有一个**功能性**后果，本轮实测验证过、不是推理：给打手的那条通知
`href` 指向 `/companion/orders/[id]`，而 `getCompanionOrderDetail` 的守卫只看
`order.actualCompanionId === companionId`（**不看订单状态**）。若照 `cancel` 的做法清掉绑定，
这条通知就会变成**点不开的死链接**。生产构建实测该页 **200**（§六）。

**不生成、也不冲正 `Earning`**：这不是「记得不要去建」，而是**结构性**的——
收益只在 `settleOrderCompletion` 里产生，且带 `order.status === "serving"` 守卫；
`paid` / `accepted` 从未进入过 `serving`，因此这一档**不可能**存在 Earning。
用例直接断言退款前后 `Earning` 仓储条数不变。

### 1.3 `applyDispatchTimedOut` 有了**第二位**调用方，标签随之改成中性

`applyDispatchTimedOut()` 一直是**唯一**的「派单关闭」原语，但原先只有一位调用方
（公共池到点清扫），因此展示名写成「已超时关闭」。本轮让「用户直接退款」也能关闭派单，
于是：

- **刻意不做成两个函数**：「关闭之后就接不了单」这条性质必须只有一处保证；
- `DISPATCH_STATE_LABELS.timed_out` 由 **「已超时关闭」→「已关闭」**，因为对着一张
  `acceptedAt` 有值的派单记录写「超时」是**假话**，而这条谎**可复现**（客服看详情时
  会看到「接单时间有值」与「超时关闭」自相矛盾，无从判断真相）；
- `DispatchState` 枚举**没有扩**（批次 §架构硬约束），两种来路对下游行为完全相同。

⚠️ **连带影响已同步、未静默**（清单见 §八）：`lib/types/dispatch.ts` / `lib/types/staff.ts`
的 `timedOutAt` 字段文档、`StaffOrderDetailPanels.tsx` 的行标签「超时时间」→「关闭时间」、
以及 **P0-10 验收清单的 E4 期望文案**（P0-10 也是本批次未验收的一轮，
若不同步，人工验收会照着**旧文案**去比对而误判为失败）。

### 1.4 幂等靠**状态与已退金额**，不引入幂等键

`cmd_p0-12.md:13` 把前置写成「`status=paid/accepted` 且**未全额退款**」——金额本身就在前置里，
因此判据是**事实**而不是调用方给的一个串：

1. `order.status === "refunded"` → `already-refunded`（**在金额判断之前**：退款时刻要从订单上读，
   不能拿本次请求的 `at` 编一个出来——否则重复点击会**刷新退款时刻**）；
2. `order.refundedAmount >= order.actualPaidAmount` → `already-refunded`（状态还没变但钱退满了）。

第 2 条同时是「退款金额不得超过实付」的实现依据。比幂等键**更强**的地方：它天然覆盖
**不是同一个人点的第二次**——超时清扫、管理员退款都会把订单写成 `refunded`，
用户再点一次同样落回 `already-refunded`。

与**超时自动退款**（EX-REFUND-02）的并发因此是**两道**独立锁：① 派单被关闭后
`sweepExpiredDispatches` 根本不再看它（它只处理开着的池）；② 即使抢在关闭之前，
`applyOrderRefund` 对已 `refunded` 的订单返回 `changed: false`。**两道都删掉**才会重复出款，
用例把两个方向各写了一条。

### 1.5 顺带修正的三处**既有失真**（不是本轮引入的）

| # | 位置 | 原文 | 为什么必须改 |
|---|---|---|---|
| 1 | `DISPATCH_STATE_LABELS.timed_out` | 「已超时关闭」 | §1.3 |
| 2 | `lib/types/dispatch.ts` / `lib/types/staff.ts` 的 `timedOutAt` | 「超时关闭的时刻」 | 字段名是历史名不改，但**文档口径**必须跟上（§1.3） |
| 3 | `lib/mocks/fixtures/refundSeed.ts` 的不变量 2 | 用 `isOrderRefundable` 判 | 见 §1.6 |

### 1.6 `hasRefundPath` —— 本轮**最容易读错**的一处改动，单独说明

`refundSeed.ts` 有一条**构造期自检**：`pending` / `reviewing` 的预置退款，对应订单
「必须是可退款的业务状态」。它原本用 `isOrderRefundable` 判——本轮之后那个词**只指申请那条路**，
于是预置数据里两条**存量**申请（`rf-seed-1001-01` 挂在一张**已接单**的订单上、
`rf-seed-1002-01` 挂在一张**已付款**的订单上）会让 **seed 构造直接抛错**，
**整个应用与测试套件都起不来**（已实测复现，见 `02-decisions.md` D7）。

**修法不是改预置数据**，而是把那条自检**问的问题说准**：它问的是「这一单还能不能退」
（与走哪条路无关），不是「这条申请此刻还能不能再提交一次」。因此新增

```ts
export function hasRefundPath(status: OrderStatus): boolean {
  return isOrderRefundable(status) || canDirectRefund(status);
}
```

⚠️ 它**不是** `isOrderRefundable` 的别名（那个词现在只指申请那条路）。
它是「拆之前那个问题」的**现名**，因此今天**恰好仍等于原来那四档**——
`tests/refunds.test.mjs` 有一条专门断言 `hasRefundPath ≡ (canRequestRefundStatus || canDirectRefund)`
且并集恰好是四档，防止将来有人拿它去当「能不能申请」用（那等于把两条路重新合并）。

**两条存量申请有意保留**：它们是 P0-12 之前留下的**真实业务历史**，删掉等于让预置数据否认历史。
处置方式登记为**待产品追认项 R1 / R2**（§九）。

---

## 二、本轮新增文件（**4** 个代码 / 测试 + **5** 个档案）

| 文件 | 行数 | 说明 |
|---|---|---|
| `lib/data/directRefundTransaction.ts` | 255 | 伪事务 `directRefundOrder`。**整个文件零 `await`**（结构性门禁） |
| `app/api/orders/[id]/direct-refund/route.ts` | 47 | `POST`。`requireUser()` 第一句；**不 import `readJsonBody`**（见文件头 §为什么） |
| `components/refunds/DirectRefundButton.tsx` | 123 | 客户端组件。两下才退；**不认识订单状态类型**（门禁断言它不出现 `status ===` 与 `OrderStatus`） |
| `tests/directRefund.test.mjs` | 824 | **21** 条用例（18 条纯规则 / 服务层 + 3 条 HTTP），见 §四 |
| `docs/03-dev/rounds/P0-12/01-prompt.md` | 51 | 指令原样拷贝 |
| `docs/03-dev/rounds/P0-12/02-decisions.md` | 298 | Requirement Check + **D1–D12** + 待产品追认项 R1 / R2 |
| `docs/03-dev/rounds/P0-12/03-delivery.md` | 本文件 | —— |
| `docs/03-dev/rounds/P0-12/04-acceptance.md` | 见该文件 | 人工验收清单 |
| `docs/03-dev/rounds/P0-12/README.md` | 见该文件 | 本轮索引 |

**零新增仓储、零新增 Mock Store、零新增 `OrderStatus` / `DispatchState` 枚举值。**

---

## 三、本轮修改的文件

> ⚠️ 工作区里同时躺着 **P0-10 / P0-11 / P0-12** 三轮的未提交改动（批次禁止 Git 写操作）。
> 下表把「本轮专属」与「与其他轮共享」分开；共享文件上**哪些行属于哪一轮**无法在不写 Git
> 的前提下逐行切分，因此共享文件只说明本轮改了哪一段，不给行数。

### 3.1 本轮专属（11 个，合计 **+409 / −60**）

> 读数为 `git diff --numstat 3fbae62`（批次 baseline），因此**含本轮的全部改动**。

| 文件 | 增/删 | 本轮改了哪一段 |
|---|---|---|
| `lib/services/refunds.ts` | +96/−6 | 新服务入口 `directRefundOrderForUser`（归属校验在事务之前）+ `already-refunded` / `amount-invalid` / `not-eligible` 的文案映射（D11；`amount-invalid` 为 M-2 整改新增） |
| `lib/constants/refunds.ts` | +86/−7 | `DIRECT_REFUNDABLE_ORDER_STATUSES` / `canDirectRefund` / `hasRefundPath`；`REFUNDABLE_ORDER_STATUSES` **缩到两档**；三条失败文案；`REFUND_NOTIFICATION_COMPANION_REFUNDED`（+10 行来自 M-1 / N-4 的注释改写） |
| `app/(mobile)/orders/[id]/refund/page.tsx` | +26 | 新增「该订单可直接全额退款」空态，**排在 `refundSummary` 那一支之前**（D9） |
| `tests/refunds.test.mjs` | +101/−34 | 见 §4.2——本文件从「一条退款路径的测试」改成「**申请**路径的测试」 |
| `tests/staffReleaseHistory.test.mjs` | +23/−3 | 见 §4.3 |
| `lib/services/refundsHttp.ts` | +18/−1 | 新增浏览器出口 `directRefundOrder()` |
| `app/(mobile)/orders/[id]/page.tsx` | +14 | 按服务端 `allowedActions.canDirectRefund` 渲染按钮（**不按状态自己判断**） |
| `lib/data/mockDispatchRepository.ts` | +13/−1 | `applyDispatchTimedOut` 头注释：两位调用方 + 「关闭后就接不了单」只有一处在保证（§1.3） |
| `lib/types/dispatch.ts` | +13/−1 | `timedOutAt` 口径更正（§1.5） |
| `lib/mocks/fixtures/refundSeed.ts` | +12/−5 | 不变量 2 改用 `hasRefundPath`（§1.6），并写明判的是「还有没有路可走」 |
| `tests/staffComplaintCrossRole.test.mjs` | +7/−2 | 见 §4.3 |

⚠️ **`lib/mocks/**` 只动了 `refundSeed.ts` 的**自检判据**，**没有**为验收方便改任何一条预置数据**
（订单、退款记录、打手全部原样）。

### 3.2 与其他轮共享的文件（4 个）

| 文件 | 本轮改了哪一段 |
|---|---|
| `lib/types/order.ts` | `OrderAllowedActions` 新增 `canDirectRefund`（与 `canRequestRefund` 并列）。⚠️ 该文件 P0-11 也改过（`servingAt` 语义） |
| `lib/constants/dispatch.ts` | `DISPATCH_STATE_LABELS.timed_out` 改「已关闭」+ 注释写明两种来路。⚠️ 该文件 P0-11 也改过（3 条新通知常量） |
| `lib/types/staff.ts` | `timedOutAt` 字段文档口径。⚠️ 该文件 P0-10 / P0-11 也改过 |
| `components/staff/StaffOrderDetailPanels.tsx` | 行标签「超时时间」→「关闭时间」。⚠️ 该文件是 **P0-10 的新增文件**（424 → 427 行） |
| `docs/03-dev/rounds/P0-10/04-acceptance.md` | **E4** 的期望文案同步为「已关闭」+ 一条 📌 说明它由 P0-12 同步、E4 的性质未变。⚠️ 该文件属 P0-10，本批次三轮都未验收，不同步会让人照着旧文案误判 |

### 3.3 门禁阶段额外修正的**一个既有测试缺陷**（不属于本轮的 11 个文件，单独登记）

| 文件 | 增/删 | 改了什么 |
|---|---|---|
| `tests/platformConfig.test.mjs` | +10/−1 | 见下：一条**本来就写错**的时间戳断言 |

**这不是 P0-12 引入的缺陷，也不是「为了让测试变绿而放宽断言」。** 事实链：

- 该文件对批次 baseline `3fbae62` 的 diff 在本轮初是**空的**（`git diff --stat 3fbae62 -- tests/platformConfig.test.mjs` 无输出）——它属 **P0-9**；
- 用例「no-op 判据覆盖三个字段」在第 612 行有一次**真的**写入（把 `publicPoolTimeoutMinutes` 改成 45），
  而写入按语义**就要刷新 `updatedAt`**（同文件「每次写入刷新 `updatedByAdminId` 与 `updatedAt`」是它的正面证据；
  实现见 `lib/data/adminPlatformConfigTransaction.ts` 的 `updatedAt: ctx.at`）；
- 但第 631 行仍拿 **612 行之前**取的 `baselineUpdatedAt` 去比对——**它测的其实是「第 612 行那次真写入有没有刷新时间戳」**，
  而那件事本来就该发生。于是这条断言**只在两次写入落在同一毫秒里时才碰巧成立**：
  空闲机器上单跑该文件 35/35 绿，**整库跑法下真的红过一次**（实际差 1ms：`.409Z` vs `.408Z`）。
- 改法：在第 612 行那次写入**之后**重新取一次基线（`afterRealChangeUpdatedAt`），第 631 行改用它。
  **被测命题没变**——仍然断言「no-op 不刷新 `updatedAt`」，只是基线取在了正确的位置，因此不再看毫秒运气。
  它的确定性另有两条与时间分辨率**无关**的断言兜底：`cwSame.changed === false` 与 `countAudits() === 2`。

> ⚠️ 之所以要单独登记：这是**批次 baseline 之外的第一个非本轮文件**，
> 若不写明来路，它会成为批次 §停止条件 里的「无法解释的工作区改动」。

---

## 四、本轮修改的测试文件（**4** 个，其中 1 个新增）

| 文件 | 改动 | 为什么这不是「放宽断言」 |
|---|---|---|
| `tests/directRefund.test.mjs`（新） | **21 条**用例 | 见 §4.1 |
| `tests/refunds.test.mjs` | 可申请的两档由四档改为**两档**；翻了两处纯函数期望；新增一条集合不相交断言 | 见 §4.2 |
| `tests/staffComplaintCrossRole.test.mjs` | 换一条订单（`accepted` → `serving`） | 见 §4.3 |
| `tests/staffReleaseHistory.test.mjs` | 申请退款之前补「第三次接单 + 开始服务」 | 见 §4.3 |

### 4.1 `tests/directRefund.test.mjs`（**21** 条）

> 下表的分组与**文件里的分节横幅**逐段对应（`grep "^// ——" tests/directRefund.test.mjs`），
> 因此可以逐条对上。⚠️ 本表早先的一版把分组写错了（各组合计 20、总数写 19，**两边都不等于实际条目数**），
> 2026-09-25 复核时按 `grep -c "^test("` = **21** 与逐条标题重数后改正。

| 组（文件里的分节） | 条 | 钉住的 |
|---|---|---|
| 一 纯规则：两条路径互斥 | **3** | 两个状态集合**互不相交**（逐档），且并集恰好是原来那四档；`paid` / `accepted` 不再可申请——接口与纯函数**同时**拒绝（`REFUND_ORDER_NOT_ALLOWED_MESSAGE`）**且不留下任何记录**；**新增**：直退放行的每一档在 `ORDER_TRANSITIONS` 里**必须真的有 `→ refunded` 的边**（N-2） |
| 二 `paid` 单：退成什么样 | 2 | 直退后订单 / 金额 / 退款时刻 / **派单关闭**四件事**一起**成立，且不产生通知与收益；重复直退时**退款事实一个字节都不变**（含 `refundedAt` **不被刷新**） |
| 三 `accepted` 单：保留历史、通知打手 | 3 | 保留 `actualCompanionId` 与打手快照 + 通知打手 + **不写**履约退出历史；打手**没有账号**时退款照常成功（只是无人可通知）；退款后打手端**仍看得到这一单**（绑定保留 → 通知里的链接是活的） |
| 四 与超时自动退款并发 | 2 | 用户先退 → 超时清扫**不得重复退款、不得重复通知**；超时清扫先退 → 用户再点只得 `already-refunded`，且时刻**仍是清扫写的那个** |
| 五 不属于这两档的一律拒绝 | **3** | `serving` / `completed` / `refunded` 三档都拒绝且**文案分得开**（已开始服务 vs 其它）；**新增**：实付为 0 的订单说的是「**金额异常**」而**不是**「已全额退款」（M-2）；归属（别人的单与不存在的单**同一个 404**，且不泄露「这单存在」） |
| 六 存量数据：P0-12 之前的退款申请 | 2 | 已付款 + 「已拒绝」记录 → **仍可直退**；已接单 + 「待审核」申请 → **不被它阻挡**，且那条申请**原样不动**（R1 / R2） |
| 七 金额与 DTO 边界 | 2 | 退款金额**恒等于订单实付**且**不影响累计消费**；接口返回**恰好四个字段**（key 集合精确相等） |
| 八 接线：页面与接口指向同一处规则 | 1 | 页面按服务端 `canDirectRefund` 渲染（源码里**连状态字面量都不许有**）；退款页的新分支**排在** `refundSummary` 之前；按钮组件不认状态类型 |
| HTTP（守卫矩阵 + 两条正例） | **3** | 未登录 401 / 别人的单 404 / 不存在的单 404 / 方法不匹配 405；**两条正例**（`paid` 与 `accepted` 各一，都是真造一单、真打过去、**回读自证**） |

**合计 21 条 = 离线 18 + HTTP 3。** 前 **18** 条只覆盖**纯规则与服务层及以下**；
`401` / `404` / `405` 这几条规则**只存在于接口层**（服务层的判据里没有「谁在问」），
**原理上测不到**，由最后一组补上。

**两条 HTTP 正例怎么做到可重复跑的**：不碰任何种子订单，而是**用 HTTP 现场造一单**——
`POST /api/orders/pay` → `POST /api/payments/mock-confirm` → `GET /api/companion/dispatches`
→ `POST /api/companion/dispatches/[id]/accept`。拿到真处于 `accepted`、真绑着某位护航的订单
之后再打 `direct-refund`。**「真的退了」不靠接口自述**：`accepted` 那条回读
`GET /api/companion/notifications` 自证通知**真的落到了打手账号上**。

⚠️ **无「静默跳过」出口**：这两条最初也想过「支付通道关着就跳过」，但 P0-11 的同类写法
已经证明那是**假绿**（探测把两个不同的 404 混为一谈，导致零断言通过）。
本轮直接走真链路——通道真关着就在断言上炸出声。

### 4.2 `tests/refunds.test.mjs` 的**重新定位**（不是放宽）

这个文件原本是「退款」的测试。P0-12 之后它**只测申请那条路**，因此：

| 改动 | 说明 |
|---|---|
| 文件头重写 | 明确本文件只覆盖 `serving` / `completed` 的**申请**路径，直退在 `directRefund.test.mjs` |
| 四个订单常量改名 | `FREE_SERVING_ORDER` / `FREE_COMPLETED_ORDER` / `DIRECT_ONLY_PAID_ORDER` / `DIRECT_ONLY_ACCEPTED_ORDER`——名字本身就是「这一档走哪条路」的说明书 |
| 第一条用例改写 | 先跑 serving / completed 四档**全部通过**；再断言 paid / accepted `canRequestRefund:false`、`canDirectRefund:true`、接口拒绝、**且不留下记录**。**断言变多了**，原来那四档一条都没少 |
| `canRequestRefund("paid"/"accepted", false)` | 由 `true` 翻成 `false`——这是本轮**唯一**翻转的两处期望值，翻转本身就是被测行为 |
| 新增一条纯函数用例 | 「两条路径的状态集合不相交，且合起来正好是『还有路可走』的四档」 |
| 「预置数据自洽」 | 判据由 `isOrderRefundable` 改为 `hasRefundPath`（§1.6），并注明判的是「还有没有路可走」 |

⚠️ **判据**：把本轮实现整体回滚，这个文件会**立刻变红**——四档常量、`canDirectRefund`、
`hasRefundPath` 每一个字面都只可能由本轮引入。

### 4.3 两处**空前置**的修复（都是测试自己的前置，不是业务规则改动）

P0-12 让 `paid` / `accepted` 不能再申请退款，两个既有测试文件因此踩到了**走不通的前置**。
改法一律是**换一张单 / 把订单推到能申请的状态**，没有一处放宽断言：

| 文件 | 原因 | 改法 |
|---|---|---|
| `tests/staffComplaintCrossRole.test.mjs` | `ORDER_FOR_REFUND` 原为 `ord-seed-1001-11`（**已接单**），「用户提交退款」这一步走不通了 | 换成 `ord-seed-1001-10`（**护航中**、无预置退款记录），并在常量上注明为什么必须换 |
| `tests/staffReleaseHistory.test.mjs` | 用例要一条进行中的申请挂在**同一张单**上，而两次取消之后订单回到了**已付款** | 在申请之前补**第三次接单 + 打手点击开始服务**（走**真实链路**，不往 store 里塞记录）。这两步**不产生退出历史**，因此「退出过两次就是两条」的断言不受影响 |

---

## 五、本轮**刻意不做**的事

| 不做 | 归属 |
|---|---|
| `serving` / `completed` 的售后与**按比例退款**（含打手 Earning 的资金联动） | **P0-13**。本轮的代码与测试里**没有任何** `earning*` 依赖（有门禁） |
| 作废 / 追认退款记录（R1 / R2） | **产品未裁定**，自行决定就是发明财务规则。见 §九 |
| 退款后给**下单用户**发一条通知 | 需求三处（PR-02 / BF-26 A / EX-REFUND-07）都只写了「通知已接单打手」；退款结果在用户自己的订单页上可见。**加了就是发明需求** |
| 扩 `OrderStatus` / `DispatchState` | 批次 §架构硬约束；既有边已够用 |
| 第二套 Order / Refund / Notification / Auth | 永久约束 |
| 真 Scheduler | 上线前阻塞项，非本轮遗漏 |
| 顺手把 `applyDispatchTimedOut` 改成两个函数 | §1.3——那会让「关闭后接不了单」有两个保证处 |

---

## 六、门禁结果（2026-09-25，**最终树**）

> ⚠️ 本表的读数取自**全部整改之后**的树（第二轮 reviewer 指出：早先一版的读数取自整改**之前**，
> 少了 M-2 与 N-2 新增的 2 条用例）。下表为上表复跑所得。

命令按 `cmd_p0-12.md` 与批次文件规定的顺序执行。

| # | 门禁 | 命令 | 读数 |
|---|---|---|---|
| 1 | targeted tests | `node --import ./tests/alias-hook.mjs --test tests/directRefund.test.mjs` | **21 条 / pass 18 / fail 0 / skip 3**（不带 `APP_BASE_URL` 时；3 条 HTTP 跳过） |
| 2 | 全量测试（离线） | `pnpm test` | **1346 用例 / pass 1200 / fail 0 / skip 146** |
| 3 | 类型 | `next typegen && pnpm typecheck` | **exit 0** |
| 4 | lint | `pnpm lint` | **0 error / 0 warning** |
| 5 | 构建 | `pnpm build` | **exit 0**（Turbopack，全部路由已产出） |
| 6 | **生产 HTTP 全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **1346 / pass 1346 / fail 0 / skipped 0** |
| 7 | reviewer | 只读复核（两轮） | **0 BLOCKER / 0 MAJOR**，见 §七 |

> 第 6 行是本轮**最重要的一行**：`skipped 0` 意味着 146 条 HTTP 用例全部**真的跑过**——
> 本轮的 3 条（守卫矩阵 + **两条正例**）包含在内。
> 服务进程：`next start -p 3105`。⚠️ 启动**前**先 `netstat -ano | grep :3105` 确认端口上没有
> 上一次遗留的进程（本轮真的撞上过：上一轮的 PID 还在，`TaskStop` 没杀干净），
> 确认 `PORT 3105 FREE` 之后才起新进程——否则对着旧进程测会得到**旧代码的读数**。
>
> ⚠️ 第 6 行读数是**离线全量（第 2 行）的镜像 + 146 条 HTTP**。第 2 行 skip 的 146 条
> 与第 6 行多出来的 146 条**是同一批**，因此 1346 = 1200 + 146 逐条对得上。

### 6.1 端到端实测（生产构建，人工 `curl` 复核）

> ⏱️ 下表读数取自 **2026-09-24** 的生产构建（即**整改之前**那一版）。
> 整改只动了①注释、②`amount-invalid` 守卫（对 `actualPaidAmount > 0` 的订单，求值路径与改前**逐字节相同**）、
> ③文档——**都不影响下表的任何一条**。同一批流程已由**最终树**上的两条 HTTP 正例复跑覆盖
> （见 §六 第 6 行，`1346 / pass 1346 / fail 0 / skipped 0`）。

| 步骤 | 读数 |
|---|---|
| `POST /api/companion/dispatches/[id]/accept` | **200** |
| `POST /api/orders/[id]/direct-refund` | **200** `{"data":{"orderId":"ord_354d7c0b-…","orderNo":"YM20260924861343","refundedAmount":2990,"refundedAt":"2026-09-24T16:26:49.863Z"}}` |
| `GET /companion/orders/[id]`（**通知里的链接**） | **200**，页面含订单号 → **保留绑定确实让通知不成为死链接**（§1.2） |
| `GET /orders/[id]`（用户端） | **200**，含「已退款」；**不含**「申请退款」、**不含**直接退款按钮（按钮已随 `canDirectRefund` 变假而消失） |
| `GET /orders/[id]` **退款前** | 含「**直接退款**」按钮；**不含**「申请退款」 |
| `GET /orders/[id]/refund` **退款前** | **200**，含「该订单可直接全额退款」空态与「订单当前状态：已付款」 |

---

## 七、reviewer 结论与整改

本轮共两轮只读复核（均为 `reviewer-agent`，**只读、不修改任何文件**）。

> ⚠️ **归档诚实性声明**：第二轮的完整报告被下面的 §7.2 逐条吸收。
> 但**第一轮报告的原文没有归档**（它只存在于当时的会话里，事后未落盘，
> 因此本节**不复述**它的原话）。§7.1 记录的是**我据其整改了什么**，
> 而 §7.2 里第二轮对**同样这三条**的逐条独立验证，才是它们的档案支撑——
> 也就是说：这三条的性质与整改正确性有独立证据，**第一轮的措辞没有**。

### 7.1 第一轮（2026-09-24）：0 BLOCKER / 0 MAJOR / 3 MINOR

3 条 MINOR 当轮全部整改完毕：

| # | 性质 | 整改 |
|---|---|---|
| **M-1** | `hasRefundPath(status)` 的名字暗示它能回答「这一刻能不能退」，但它**入参没有 `hasRefundRecord`**，因此对一张已有退款记录的 `serving` 单也返回 `true`——是**语义漂移** | 改写它的文档注释：明说这个限制，点名正确判据（`canRequestRefund` / `canDirectRefund` / 服务端 `allowedActions`）。**代码一行未改**——它的实现本来就对，错的是「别人会怎么读它」 |
| **M-2** | **真缺陷**：`order.refundedAmount >= order.actualPaidAmount` 对 `actualPaidAmount === 0` 的订单算成 `0 >= 0` 成立 → 返回 `already-refunded` → 用户得到「**该订单已全额退款**」，而订单其实还停在 `paid`、一分钱没退。**那是一句假话** | 新增 `amount-invalid` 分支 + 在 `>=` **之前**插入 `actualPaidAmount <= 0` 守卫；服务层映射到申请路径**同一句**文案 `REFUND_AMOUNT_INVALID_MESSAGE`。另加一条用例（直接构造坏数据） |
| **M-3** | `POST /api/orders/[id]/direct-refund` 被**同时**登记在 `api-contract.md` 的 §5 与 §6 两张表里，按文档数接口会**多算一条** | 删掉 §6 那一行，换成一条指向 §5 的 📌 说明并解释为什么不能重复登记 |

第一轮另有 NOTE 若干，其中**N-2／N-3** 两条被本轮吸收：

- **N-2（直退路径不调 `canTransitionOrder`）**：reviewer 判定「行为正确、可选」。**处置是刻意不加运行时校验**——
  理由见 §7.3。
- **N-3**：reviewer 披露 `api-contract.md` 与 `03-delivery.md` 在它复核**期间**被改过（文档是移动靶），
  并要求 **Coordinator 自己读最终 diff**，不要只信 agent 报告。**该要求在第二轮落实**，见 §7.4。

### 7.2 第二轮（2026-09-25）：**0 BLOCKER / 0 MAJOR** / 3 MINOR / 6 NOTE

复核对象是**整改之后**的树。它自己跑过：`tests/directRefund.test.mjs`（离线 18 pass / 3 skip）、
`tests/platformConfig.test.mjs`（35 pass）、**全量离线 1346 / pass 1200 / fail 0 / skip 146**，
另外把 21 条直退用例对着**正在运行的 dev 服务**跑了 HTTP 组，**21/21 pass / skipped 0**。

**它对 M-1 / M-2 / M-3 的独立结论：三条都真实成立、整改正确、且未引入新问题。**

| 条 | 它的独立验证（不是复述我的结论） |
|---|---|
| M-2 守卫顺序 | 逐行确认 `:193`（`refunded`）→ `:200`（`actualPaidAmount <= 0`）→ `:208`（`>=`），并确认「凡 `actualPaidAmount > 0` 的订单，`:208` 的求值路径与改前**逐字节相同**」，因此**没有**引入新漏判 |
| M-2 用例**不是空转** | 从数据构造链验证：新订单 `refundedAmount` 恒为 0，删掉 `:200` 会让 `0 >= 0` 成立 → 服务层抛的是**另一句**文案，而 `expectApiError` 同时断言 `.code` 与 `.message`，**两支 code 相同、只有 message 能区分**，因此断言必红；把守卫挪到 `>=` 之后同样必红 |
| M-1 是否真有人误用 | **grep 全仓逐个调用点判过**：只有 `refundSeed.ts:71` 与 `tests/refunds.test.mjs`，都是该函数定义的那个问题；**没有任何** `app/` / `components/` / route handler 拿它把守 UI |
| M-3 是否恰好一次 | **自己数了** `find app/api -name route.ts \| wc -l` = **131**，且分面 `admin 62 / staff 25 / companion 8` 与页头逐项相符；接口表里作为**登记行**只出现一次（`:91`） |
| 原子性 | 全文零 `await`（`grep` 只命中注释）；标注区段内三个写入原语**都是同步函数**（逐个读过签名） |
| 权限 | 路由第一步 `requireUser()`；归属在事务**之前**判；「别人的单」与「不存在的单」**同一个 404 且 message 逐字相同**（HTTP 实跑）；`directRefundOrderForUser` 全仓**只有这一个**调用点 |
| 幂等两道锁 | `sweepExpiredDispatches` 只处理 `isOpenPool`（`exclusive` / `public`），已关闭的派单不再成为退款候选——两道锁都在代码里看到，用例两个方向都钉了 |
| 测试真实性 | 逐条读过 21 条，未发现空转；并特别指出 `accepted` 用例**刻意不用**服务层 DTO 的 `dispatchClosed` 做断言（那是恒假的假绿灯），改用 `dispatchOf()` 读库 |
| 它**没发现问题**的维度 | 需求对齐（BF-26 A / PR-02 / EX-REFUND-07 逐项）、DTO 隐私、金额、状态机、架构分层、单一真值源、通知不覆盖、测试隔离、需求未越界（未提前实现部分退款 / 比例公式 / Earning 冲正） |

**它的 3 条 MINOR 全部是档案问题，已全部整改**（不是代码问题）：

| # | 它的结论 | 整改 |
|---|---|---|
| MINOR-1 | 条目数与门禁读数在三份档案里**都已过期**（实测 21 条，文档写 19 条），且 `04-acceptance.md` §六 的「全绿」读数取自**整改之前**的树 | §4.1 按 `grep -c "^test("` 重数并**改正了一版错误的分组表**；§二 / §四 / §六 / `04-acceptance.md` §六 / `README.md` 全部改为实测值，并**在最终树上复跑门禁**后填数 |
| MINOR-2 | §七 是空占位，而 `04-acceptance.md` 正向它索引 → **两轮的整改在档案里没有任何记录**（它 grep 过 `M-1/M-2/M-3/N-1/N-2/整改`，P0-12 目录内 0 命中） | **本节**即为整改；M-1 的整改**只是一句注释**，它的沿革现在有了档案支撑 |
| MINOR-3 | `02-decisions.md:4` 的 Status（`IN_PROGRESS`）与 `README.md`（`AWAITING_ACCEPTANCE`）不一致 | `02-decisions.md` 头部同步为 `AWAITING_ACCEPTANCE` 并注明「记录时点的状态是 `IN_PROGRESS`」，§六 补两行沿革 |

**6 条 NOTE 的处置**（登记见 §九）：NOTE-1 → **§五.1**（并纠正了一处事实错误，见 §7.5）；
NOTE-2 → §九 m5；NOTE-3 → §九 m6（**可选**，未做）；NOTE-4 → **已改**（注释精确化）；
NOTE-5 / NOTE-6 → §九 m7 / m8（**仅登记，不建议改**，它的判断我同意）。

**它明确列出「无法判断」的三项**（照实登记，不粉饰）：
① 生产构建下的全量 HTTP 读数它**没有复现**（它只跑了 dev 服务上的 3 条直退 HTTP 用例）
→ 该项**由我在最终树上复跑**，见 §六；
② E 段的人工验收测试架构覆盖不了（Node 不剥 JSX），**必须由用户本人验**；
③ R1 / R2 的产品裁定属产品，它只给技术侧判断。

### 7.3 N-2 为什么**不加**运行时校验（第二轮认可了该取舍）

`ORDER_TRANSITIONS` 里 `paid` / `accepted` **本来就有** `→ refunded` 的边，因此加一句
`canTransitionOrder(...)` 今天**永远返回 `true`**——那是纯粹的第二份判断，不产生任何保护，
却把「这一档能不能直退」变成**两个真值源**（状态表 + 状态集合），正是仓库明文反对的写法
（`lib/constants/dispatch.ts:9`：「同一件事在两处各写了一遍」）。

真正的失败场景只有一个：**有人把 `DIRECT_REFUNDABLE_ORDER_STATUSES` 放宽到一档没有 `→ refunded` 边的状态**——
它与任何请求输入无关，是**两个常量之间的关系**。处置因此是**在测试里钉住**：
`tests/directRefund.test.mjs` 断言集合里每一档在 `ORDER_TRANSITIONS` 里都真的有那条边，
并反向断言「状态表有边 ≠ 可以直退」（`serving` 有边但 `canDirectRefund` 为 `false`），
防止有人反过来拿状态表替换集合。**第二轮同意：「没有这样的输入」，取舍成立。**

### 7.4 N-3 的落实：Coordinator 自己读了最终 diff

不依赖任何 agent 报告，我本人核对了：接口表里 `direct-refund` **恰好一次**（§5，`:91`），
§6 是 📌 而不是行；`find app/api -name route.ts | wc -l` = **131**，与页眉**一致**；
`git diff --stat 3fbae62 -- tests/platformConfig.test.mjs` 在本轮初**为空**（证明 §3.3 那条不是本轮引入）；
守卫顺序 `:193 → :200 → :208`；`case "amount-invalid"` 用的是与申请路径**同一个常量**。

### 7.5 一处**事实错误**（第二轮发现，已改）

我在 R1 里写「**客服**在既有审核界面看到它会自行处置」——**这是错的**。
能批准退款申请的**只有管理员**：客服端在 `app/api/staff/refunds/[id]/` 下只有 `start-review` / `reject`，
**没有 `approve`**；`staffRefundAllowedActions` 里也没有 `canApprove`。
已就地改正并追加 `02-decisions.md` §五.1。**R1 / R2 的裁定依据不变**，变的只是「谁在按那个按钮」——
而且这**加强了** NOTE-1 的结论：它是一条**管理员点的资金动作**，不是客服的。

---

## 八、与文档的同步

| 文档 | 改了什么 | 为什么必须改 |
|---|---|---|
| `lib/types/dispatch.ts` / `lib/types/staff.ts` | `timedOutAt` 口径由「超时关闭的时刻」改为「**派单关闭的时刻**」 | §1.3：这个字段现在有两种来路，写「超时」就是假话 |
| `components/staff/StaffOrderDetailPanels.tsx` | 行标签「超时时间」→「关闭时间」 | 同上；客服是这张面板的读者 |
| `docs/03-dev/rounds/P0-10/04-acceptance.md` | E4 的期望文案同步 + 一条 📌 说明 | P0-10 未验收；不同步会让人照着**旧文案**误判 |
| `docs/02-tech-design/database-schema.md` | 见 §8.1 | —— |

### 8.1 `database-schema.md` 的两处：一处**收窄**、一处**必须改**

> P0-11 的 Q2 裁定（2026-09-24）已经说明：`database-schema.md` 中旧的
> `TBD — DO NOT INVENT` **已被该最新产品决策覆盖，应同步更新技术文档**。
> P0-12 在这一段上**继续**做同一件事，不是新增改动。

| 位置 | 改动 | 性质 |
|---|---|---|
| `paid` / `accepted` 的退款路径 | 由「一条（待审核）」改为**两条互斥**（待审核 / 免审批直退） | **口径更正**：原文描述的是 P0-12 之前的模型 |
| 历史绑定 | 明文写出「**直接退款保留 `actualCompanionId`**，与 cancel / re-assign 的清空**相反**」 | **补充**：批次 §历史语义 的规则此前只写在批次文件里，逻辑数据模型里看不出来 |

---

## 九、MINOR / NOTE / 待追认（交付方自己登记，不藏）

| # | 事项 | 处置 |
|---|---|---|
| **R1** | 用户的订单上挂着一条**待审核**申请（存量数据）时，他仍可直接退款；那条申请 `directRefundOrder` **不碰**（用例钉住它原样不动） | **待产品追认**。作废它 / 追认它都是**新的财务规则**（一条要改退款状态机，一条牵扯二次出款），本轮不替它决定。今天它无害：订单已 `refunded`，**管理员**（不是客服——只有管理员能批准）在既有审核界面看到它会自行处置。⚠️ **它同时是「真实支付接入前必须关闭」的硬门禁**，不是「已知且接受」，见 `02-decisions.md` §五.1 |
| **R2** | 同上，「**已拒绝**」记录也不阻挡直接退款，且原样不动 | **待产品追认**，与 R1 是同一条规则的两半；**同样是支付接入前的硬门禁** |
| m1 | 派单记录**缺失**时（数据异常）退款**照常完成**，事务结果里如实反映「没关到派单」 | **有意**：用户的钱优先于内部记账。让用户拿不回钱来为一个内部记录的缺失买单，比「少关一条派单」糟糕得多。依据是既有的 `approveRefund`（P0-5.5）同样不关派单、由 `sweepExpiredDispatches` 事后自愈 |
| m2 | 打手的资料**没有关联用户账号**（预置 Mock 打手 `cp-1..cp-4` 的 `userId` 为 `null`）时，**没有收件人**，因此不发通知 | **不是缺陷**：不存在能收信的地址。真实路径必然带 `userId`（接单的人必须先是登录用户）。⚠️ **人工验收要知道这一点**：验收「通知打手」那条用例必须用**有账号**的打手（`u-1022`/`cp-10` 或 `u-1023`/`cp-11`） |
| m3 | 订单详情页按钮文案是短的「**直接退款**」，而退款页空态用的是完整表述「该订单可直接全额退款」 | **NOTE**（措辞不统一）。ActionRow 一行放不下完整表述，而短标签旁边就是「申请退款」（已开始服务那条路），两者的区别由**点击后的确认区**说清。若产品要求统一措辞，改 `DirectRefundButton.tsx` 一处即可 |
| n1 | **门禁阶段发现的既有测试缺陷**：`tests/platformConfig.test.mjs` 有一条只在同一毫秒内才成立的时间戳断言（整库跑法下真实红过一次） | **已修**，来路与证据链见 **§3.3**。⚠️ 它属 P0-9，**不是本轮引入**，单独登记是为了让它不成为「无法解释的工作区改动」 |
| m4 | `hasRefundPath` 的存在本身是一个**风险点** | 已登记的**读法**写在函数注释与用例里（它不是 `isOrderRefundable` 的别名）。若将来有人拿它去当「能不能申请」用，等于把两条路重新合并——用例里那一条并集断言就是为此 |
| m5 | 两条退款路径**判的字段不同**：申请路径守 `order.totalAmount`，直退路径守 `order.actualPaidAmount`（退款额也各取各的） | **NOTE，不在本轮修**。今天两者**恒等**（`lib/types/order.ts:108`：当前没有优惠券，`originalAmount === totalAmount === actualPaidAmount`），因此**没有可复现的错误**。将来券落地时，申请路径那条守 `totalAmount` 的判断会成为可退「未实付部分」的口子——**那是申请路径的既有问题，不是本轮引入**。登记在此，免得将来把它算到 P0-12 头上 |
| m6 | `hasRefundPath` 的纪律**目前只在注释里**：没有任何机制能阻止将来有人拿它把守 UI（第二轮已逐个调用点确认**今天零误用**） | **可选，本轮刻意不做**。候选做法：在 `tests/refunds.test.mjs` 加一条源码扫描断言（「`hasRefundPath` 只允许出现在 `lib/constants/refunds.ts` 与 `lib/mocks/fixtures/refundSeed.ts`」）。不做它的理由：它是第二轮明确标为「可选项、不是缺陷」的加固项，而它会把本已收口的门禁重新打开一轮；**它是否要做，留给用户一并裁定** |
| m7 | `amount-invalid` 守卫排在**资格判断之前**：一张**实付为 0 的 `serving` / `completed` 单**会得到「订单金额异常」，而不是「护航已开始服务」 | **仅登记，不建议改**（第二轮的判断，我同意）：两者都是 400、都不写数据，且今日不可达（券未上线，UI 也不会给这两档直退入口）。把它挪到资格判断**之后**，反而会让「实付为 0」这一异常在更多状态上**绕过**金额守卫 |
| m8 | **`refunded` 分支会遮蔽金额分支**：一张经**超时自动退款**变成 `refunded`、而 `actualPaidAmount === 0` 的订单，用户再点会得到「该订单已全额退款」 | **可辩护的设计，仅登记**：与 M-2 修掉的那种「假话」**不同**——状态确实是终态、确实无需再退（不存在「以为退过、其实没退」）。且 D2 明确要求状态判断必须在金额之前（退款时刻要从**订单上**读，不能拿本次请求的 `at` 编一个出来） |

---

## 十、本轮的 Git 状态

**本批次（P0-10 → P0-13）禁止任何 Git 写操作。** 因此：

- 本轮交付**没有提交**，全部改动留在工作区；`HEAD` 仍是批次的 baseline
  `3fbae6263794bda316b2b48dac03efd7f62afa01`（= `3fbae62`）；
- ⚠️ 本轮改动与 **P0-10 / P0-11** 的改动叠在同一个工作区里，三轮都没有提交。
  这不是「本轮改了 P0-10 的文件就说明 P0-10 有问题」——批次协议要求的正是「累积工作区」；
- 上面的「新增 / 修改文件」两张表来自 `git status --short` 与 `git diff --numstat 3fbae62`
  在 2026-09-24 的读数；
- `README.md` 的 `Git Commit:` 字段**留空**——它只能由用户本人在提交后填写
  （「DONE 双门槛」第二条）。Claude **无权**自行标记 `DONE`。
