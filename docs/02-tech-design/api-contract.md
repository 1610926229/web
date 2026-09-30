# 接口契约（API Contract）

> 状态标签：**CURRENT** / **TARGET**（`NOT IMPLEMENTED`）/ **TBD**（`DO NOT INVENT`）。
>
> CURRENT 部分由扫描 `app/api/**/route.ts` 生成，共 **138 个 route.ts**（`admin` **64** · `staff` 25 · `companion` **12** · 其余为面向用户的接口）。
>
> ⚠️ P0-14 更新：`companion` 由 8 增至 12（订单聊天四件套），总数由 131 增至 135。
>
> ⚠️ P1-1 更新：`admin` 由 62 增至 63（经营首页只读聚合一件），总数由 135 增至 136。
>
> ⚠️ P1-3 更新（**本文档此前漏记，由 P1-5 补记**）：`admin` 由 63 增至 **64**
> —— `/api/admin/aftersales`（售后统一工作台的只读聚合列表），见 §12.8。
> 该路由由 P1-3 交付、并已进 `tests/admin.test.mjs` 的清单，只是本文档没跟上。
> 于是总数 136 → **137**。
>
> ⚠️ P1-5 更新：**137 → 138**，**属于 P1-5 的只有一件**：
> - `/api/rankings/companions`（面向用户，无守卫）：打手三榜的公开读取 —— **P1-5 新增**。
>
> 口径：本行的数字以 `find app/api -name route.ts | wc -l` 的实测为准，**不按增量推算**
> ——推算出来的数正是上一版 136 对不上的原因。

> **2026-09-23 需求重校准说明**：CURRENT 路由数量与现有行为保持不变；第三部分 TARGET 已按 `docs/01-requirements/` V0.3 更新。旧 P0-6/P0-7/P0-8 仅是历史计划编号，未来 Round 需重新分配。

---

# 第一部分：CURRENT API

**守卫列**：`—` 表示无守卫（公开或自行处理）。

---

## 1. 认证（auth）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/auth/mock-login` | — | `lib/auth/session` + `lib/data/userRepository` ⚠️ | 模拟登录，写 Mock 会话 Cookie。由 `ENABLE_MOCK_AUTH` 控制，关闭时 404。可用 `{"userId":"u-1002"}` 切换身份：接口层（自动化 / curl）一直可以，**DEV-1 起用户端也有一个开发环境专用的悬浮面板**（`lib/auth/MockIdentityPanel.tsx`，服务端开关控制、关闭时整块不渲染）。切换 = **替换**当前会话，不是第二套登录态 |
| POST | `/api/auth/logout` | — | `lib/auth/session` | 清除会话 Cookie。`ENABLE_MOCK_AUTH` 关闭时 404 |

⚠️ `/api/auth/mock-login` 的 Route Handler **直接调用 `lib/data/userRepository`**，未经过 service 层。这是 Observed Current，见 §API Conventions 的说明。

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/admin/auth/mock-login` | — | `adminAuth` | 模拟管理员登录。由 `ENABLE_MOCK_ADMIN` 控制 |
| POST | `/api/admin/auth/logout` | — | `adminAuth` | 退出管理端 |
| GET | `/api/admin/auth/session` | `requireAdmin` | `adminAuth`（经守卫） | 当前管理员会话 DTO。**不受 `ENABLE_MOCK_ADMIN` 直接控制**——由开关关闭时 `getSessionAdmin()` 返回 null 间接变成 401 |

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/staff/auth/mock-login` | — | `staffAuth` | 模拟客服登录。由 `ENABLE_MOCK_STAFF` 控制 |
| POST | `/api/staff/auth/logout` | — | `staffAuth` | 退出客服端 |
| GET | `/api/staff/auth/session` | `requireStaff` | `staffAuth`（经守卫） | 当前客服会话 DTO |

**⚠️ 打手端没有自己的 auth 接口。** 打手复用用户会话，见 `architecture-rules.md` §4.2。

---

## 2. 公开读取（home / catalog / companions / agreements / rankings）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/home` | — | `home` | 首页聚合数据（公告 / banner / 快捷入口 / 商品） |
| GET | `/api/catalog/products` | — | `catalog` | 商品列表查询（分类 / 筛选 / 分页），只返回上架商品 |
| GET | `/api/companions` | `requireUser` | `companions` | 陪玩（护航）公开列表，按可用状态 / 游戏 / 关键词筛选 |
| GET | `/api/agreements` | — | `agreements` | 协议列表与正文 |
| GET | `/api/rankings/consumption` | `requireUser` | `rankings` | 消费排行榜 |
| GET | `/api/rankings/companions` | — | `companionRankings` | 打手排行榜（接单榜 / 完成榜 / 收入榜），**公开、游客可读** |

---

## 3. 个人（me / profile / levels）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/me` | `requireUser` | `profile` | 当前用户资料 |
| PATCH | `/api/me` | `requireUser` | `profile` | 编辑资料（昵称 / 头像 / 简介） |
| GET | `/api/me/consumption-level` | `requireUser` | `levels` | 消费等级与累计消费 |
| GET | `/api/me/companion-application` | `requireUser` | `companionApplications` | 我的入驻申请状态 |

---

## 4. 下单与支付（checkout / payment）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/orders/preview` | `requireUser` | `checkout` | 结算预览：校验选择、算金额、返回可用优惠券与陪玩 |
| POST | `/api/orders/pay` | `requireUser` | `checkout` | 创建支付请求（幂等键）。**不产生订单** |
| POST | `/api/payments/mock-confirm` | `requireUser` | `checkout` | 模拟支付确认 → 生成订单 + 支付记录 + 派单。**由 `ENABLE_MOCK_PAYMENT` 控制，关闭时 404** |

**⚠️ 订单是在 `mock-confirm` 里产生的，不是在 `/api/orders/pay`。**
订单初值 `status: "paid"` 由 `lib/services/checkout.ts:316` 的 `buildOrderFromRequest` 写入。

---

## 5. 订单（orders）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/orders` | `requireUser` | `orders` | 我的订单列表（状态 tab / 关键词 / 分页） |
| GET | `/api/orders/[id]` | `requireUser` | `orders` | 订单详情（DTO 裁剪，不含 `clubNetIncome`） |
| POST | `/api/orders/[id]/refunds` | `requireUser` | `refunds` | 对订单发起退款申请（幂等键，**仅 `serving` / `completed`**） |
| POST | `/api/orders/[id]/direct-refund` | `requireUser` | `refunds` | **未开始服务的订单直接全额退款**（`paid` / `accepted`，免审批、幂等、**不读请求体**；P0-12） |
| POST | `/api/orders/[id]/reviews` | `requireUser` | `reviews` | 对已完成订单提交评价（幂等键） |
| GET | `/api/orders/[id]/messages` | `requireUser` | `conversations` | 订单会话消息列表 |
| POST | `/api/orders/[id]/messages` | `requireUser` | `conversations` | 发送消息（幂等键）。`target` 选 `current`（当前履约段）或 `service`（客服段） |

> ⚠️ **订单全额退款后（`TBD-P0-14-1` 裁定，2026-09-27）**：向 `current`（当前履约段）发送返回
> **`400`**，文案 `MESSAGE_ORDER_REFUNDED_MESSAGE`；**向 `service`（客服段）仍然 200 可发**——
> 裁定只谈 assignment，而退款之后恰恰是用户最需要找客服的时候。
> 段落 DTO 的 `isReadOnly` 为 `true`（历史仍可读，`isCurrent` 也仍为 `true`）。
> **判据是 `order.status === "refunded"`，部分退款不影响**（详见 §8 打手侧同款说明）。
| POST | `/api/orders/[id]/messages/read` | `requireUser` | `conversations` | 标记用户侧已读 |

---

## 6. 退款（refunds）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/refunds/[id]` | `requireUser` | `refunds` | 退款详情（含时间轴、可执行动作） |
| POST | `/api/refunds/[id]/cancel` | `requireUser` | `refunds` | 撤销退款申请（仅 `pending` 可撤） |

> 📌 **直接全额退款**（`paid` / `accepted` 的免审批直退，P0-12）的地址前缀是 `/api/orders/...`，
> 因此登记在 **§5 订单（用户端）**：`POST /api/orders/[id]/direct-refund`。本节不重复列它——
> 同一行出现在两张表里，按文档数接口时会**多算一条**。

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/refunds` | `requireAdmin` | `adminRefunds` | 退款列表（状态 / 关键词筛选） |
| GET | `/api/admin/refunds/[id]` | `requireAdmin` | `adminRefunds` | 退款详情 |
| POST | `/api/admin/refunds/[id]/start-review` | `requireAdmin` | `adminRefunds` | `pending → reviewing` |
| POST | `/api/admin/refunds/[id]/approve` | `requireAdmin` | `adminRefunds` | 审核通过。**按比例算金额、写入 `refundedAmount`，100% 才置订单为 `refunded`；打手收益整笔冲销**。⚠️ **仅 `serving` / `completed` 订单可批**，其余档位 400 且零副作用（`D22`） |
| POST | `/api/admin/refunds/[id]/reject` | `requireAdmin` | `adminRefunds` | 驳回（必填意见） |

**⚠️ `approve` 的退款金额口径 —— P0-15 起为「一次决定」（产品负责人裁定，2026-09-28）**

下面三条是**更早**的口径，现已**作废**，保留在此仅为解释历史：

- ~~人工退款审批只有「拒绝 / 全额退款」两种结果，部分退款尚未实现。~~
  → **已取代（P0-13）**：`approve` 接受**退款比例**，部分退款与全额退款走同一个接口。
- ~~批准时必须把 `order.actualPaidAmount` 作为实际退款金额写入 `order.refundedAmount`。~~
  → **已取代（P0-13）**：本次退多少 = `floor(order.actualPaidAmount × 退款比例)`。
  ⚠️ `refundedAmount` 仍是**累加**写入，但 P0-15 之后**一个订单至多一次退款**，
  因此它在任何真实路径上都只被加过一次。它不是「累计」语义的残留，
  而是 `applyOrderRefund` 这个唯一资金写入口的通用形态（三条退款路径共用）。
- ~~未来部分退款上线后扩展为累计值。~~ → **已落地（P0-13）**，又**被 P0-15 收窄为一次**。
- **曾经的缺陷（P0-5.5 已修复）**：`lib/data/adminRefundTransaction.ts` 调用 `applyOrderRefund` 时**省略了第三个参数**，会出现「已退款但 `refundedAmount` 为 0」。裁定为**修 Bug，不通过隐藏字段规避**——现显式传金额（`adminRefundTransaction.ts:460`）。这条修复在 P0-13 / P0-15 之后仍然有效。
- 金额取自**被修改的那张订单**（`actualPaidAmount` / `companionBaseIncome` 两个冻结快照），不取退款申请上的 `amount` 快照；`applyOrderRefund` 对**已退款**（`status === "refunded"` **或** `refundedAmount >= actualPaidAmount`）的订单短路返回 `changed: false`，因此重复批准不会重复退款、也不刷新 `refundedAt`。
- **P0-15 追加的硬约束**：`createRefundRequest` 在仓储层对同一 `orderId` 只允许一条记录，
  第二次一律返回 `order_already_has_refund`。这**不是界面藏了按钮**——直接请求接口、
  直接调仓储，同样被拒（见 `lib/data/mockRefundRepository.ts`）。
  ⚠️ 这是 P0-15 与 P0-13 在**约束强度**上的分水岭：P0-13 允许「同一订单多条申请，
  按状态判活跃」，P0-15 是「提交过即封死，永久」。

**⚠️ `approve` 的请求体（P0-15 起收敛为**一个**字段）**

请求体只携带**一个退款比例**，**没有任何金额字段**——两个金额一律由服务端按订单冻结快照算
（管理员只输入比例，金额由系统计算）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `refundRatePercent` | 字符串 | 本次退款比例（整数百分比 `0~100`）。**必填**；空字符串或缺失是「没填」，不是「0%」。`0%` 会被服务端按「退款金额为 0」拒绝 |

⚠️ **P0-15 删掉了三个字段**，删的理由不是「暂时不用」：

| 已删除 | 原先的用途 | 为什么删 |
|---|---|---|
| `refundFullRemaining` | 「退满剩余」（P0-14） | 它补的是**多步部分退款**留下的 1~99 分尾差。一个订单只退一次之后 `floor(实付 × 100%) === 实付`，那个概念**自动坍缩成 100%** |
| `responsibility` | 资金责任归属（P0-13） | 责任模型**整体废止**：退款批准即打手收益整笔归零，不再有「谁承担」这一步 |
| `companionLiabilityRatePercent` | 打手责任比例（P0-13） | 随责任归属一起删除 |

**唯一的一条金额公式：**

| 字段 | 值 |
|---|---|
| `refundAmount` | `floor(actualPaidAmount × refundRateBp / 10000)`；`refundRateBp = 10000`（100%）时**恒等于** `actualPaidAmount` |
| `companionReversalAmount` | **恒等于 `companionBaseIncome`（整笔）**，与退款比例无关 |
| 打手最终净收益 | `incomeAmount − reversedAmount`，**恒为 0** |
| 平台最终收入 | `actualPaidAmount − refundAmount`（不再有 `platformBorneAmount` 这个字段） |

⚠️ **为什么删掉「责任归属」而不是留作兼容层**：本仓库无真库、无历史持久化数据，
唯一的历史载体是种子 fixture，迁移成本为零。留一个恒等于 `refundAmount` 的
`platformBorneAmount` 只会造出**第二份真值**——两份账迟早对不上。

⚠️ **为什么删掉「退满剩余」是安全的**：那个机制存在的**唯一**理由是
「按比例只有 101 个离散取值，实付 2990 时有 2890 个金额表达不出来，先部分退过款的单子
可能永远差 1~99 分退不满」。**一单一退之后这个前提消失了**——
一个订单最多退一次，退完就结束，不存在「退不满」。详见 `docs/03-dev/rounds/P0-14/02-decisions.md` §十四
（那是该机制的完整论证，保留为历史）与 `rounds/P0-15/02-decisions.md`。

- **三项决策字段只出现在管理端响应**（`refundRateBp` / `refundAmount` / `companionReversalAmount`）。
  客服与用户只拿得到 `decidedAmount`（本次实退金额），拿不到决策依据——见 D13。
- `GET /api/admin/refunds/[id]` 的响应带 **`orderMoney`**：**订单自身的六个冻结字段直接搬运**，
  `{ originalAmount, couponDiscountAmount, actualPaidAmount, refundedAmount,
    companionBaseIncome, clubNetIncome }`。读取时不重算。
  ⚠️ P0-15 **删掉了三个**（`remainingRefundableAmount` / `reversedSoFarAmount` /
  `companionEarningStatus`）：前两个随「一单一退」失去意义（永远是「没退过 = 实付 / 退过 = 0」
  与「冲回率恒 100%」），第三个是为 D17 的 `withdrawn` 特例准备的，而该特例**不可达**。
  **只给管理端**——它是「这个退款比例是谁的百分之几」的唯一数据来源。
- `approve` 的响应带 `decidedAmount`：**即使确认框已经会显示预计金额，这个字段也必须带**
  （D19）——界面上那个数是页面加载时的数据算的预计值，响应里这个才是**真正写下去**的数。
  成功提示报的是后者。
- **`approve` 只接受 `serving` / `completed` 的订单**（产品裁定 2026-09-27，`P0-13/02-decisions.md` §十三 `D22`）。
  `paid` / `accepted` 的退款路径是用户端**免审批直接全额退款**，不存在「管理员裁定比例」这一步。
  订单档位不合法时返回 **`400` / `BAD_REQUEST`**，`message` 为
  「该订单当前不在售后审批范围内：只有「护航中」「已完成」的订单可以走售后退款审批」，
  **且零副作用**（不写退款、不写 `EarningAdjustment`、不发通知、不写审计）。
  ⚠️ **只拦「通过」**：`start-review` 与 `reject` **不受此限**——P0-12 之前开出的存量申请
  （挂在 `paid` / `accepted` 单上）仍然可以被驳回，那正是它们的应有处置。
  ⚠️ 判据由服务端单点提供（`lib/constants/refunds.ts` 的 `assertRefundApprovalOrderStatus`），
  **读侧与写侧共用**：`GET /api/admin/refunds/[id]` 的 `allowedActions.canApprove`
  与写侧 400 不可能不一致。
- `GET /api/admin/refunds/[id]` 的响应带 **`approveBlockedReason`**（同上裁定）：
  字符串或 `null`。非 `null` 时它是**与 `approve` 的 400 `message` 同一句话**，
  页面直接显示，不自己判断订单状态。
  ⚠️ **只在申请本身未终态时才有值**：终态（已通过 / 已拒绝 / 已撤销）一律为 `null`——
  那时 `canApprove === false` 的原因是「申请已结束」，页面走的是另一句提示
  （`ADMIN_REFUND_TERMINAL_NOTICE`）。两个原因**不得混成一句**。
- **回归测试**：`tests/refundMoneyChain.test.mjs`（公式 / 钳制 / 冲回 / 边界 /
  订单金额快照 / 预览与落库一致）、`tests/adminRefunds.test.mjs`（状态机 / 幂等 / 审计 / 白名单 /
  **订单档位闸与读侧同口径**）。详见 `database-schema.md` §9。
- **回归测试**：`tests/refundMoneyChain.test.mjs`（公式 / 钳制 / 冲回 / 边界 /
  订单金额快照 / 预览与落库一致）、`tests/adminRefunds.test.mjs`（状态机 / 幂等 / 审计 / 白名单）。
  详见 `database-schema.md` §9。

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/refunds` | `requireStaff` | `staffRefunds` | 退款列表 |
| GET | `/api/staff/refunds/[id]` | `requireStaff` | `staffRefunds` | 退款详情 |
| POST | `/api/staff/refunds/[id]/start-review` | `requireStaff` | `staffRefunds` | `pending → reviewing` |
| POST | `/api/staff/refunds/[id]/reject` | `requireStaff` | `staffRefunds` | 驳回 |

**⚠️ 客服端没有 `approve`。** 客服不能批钱。`lib/constants/staffRefunds.ts` 的 `staffRefundAllowedActions` **只有 `canStartReview` 与 `canReject`**。
⚠️ 但真正拦住的是路由层（`app/api/staff/refunds/` 下没有 `approve/` 目录）——若有人往常量里补一个 `canApprove`，**没有任何测试会失败**。

---

## 7. 投诉（complaints）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/complaints` | `requireUser` | `complaints` | 我的投诉列表 |
| POST | `/api/complaints` | `requireUser` | `complaints` | 提交投诉（幂等键） |
| GET | `/api/complaints/[id]` | `requireUser` | `complaints` | 投诉详情 |

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/complaints` | `requireAdmin` | `adminComplaints` | 投诉列表 |
| GET | `/api/admin/complaints/[id]` | `requireAdmin` | `adminComplaints` | 投诉详情 |
| POST | `/api/admin/complaints/[id]/start-processing` | `requireAdmin` | `adminComplaints` | `pending → processing` |
| POST | `/api/admin/complaints/[id]/resolve` | `requireAdmin` | `adminComplaints` | `processing → resolved` |
| POST | `/api/admin/complaints/[id]/close` | `requireAdmin` | `adminComplaints` | → `closed` |

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/complaints` | `requireStaff` | `staffComplaints` | 投诉列表 |
| GET | `/api/staff/complaints/[id]` | `requireStaff` | `staffComplaints` | 投诉详情 |
| POST | `/api/staff/complaints/[id]/start-processing` | `requireStaff` | `staffComplaints` | 同管理端，**共用同一条伪事务** |
| POST | `/api/staff/complaints/[id]/resolve` | `requireStaff` | `staffComplaints` | 同上 |
| POST | `/api/staff/complaints/[id]/close` | `requireStaff` | `staffComplaints` | 同上 |

**客服端三个动作齐全**（与管理端不同，这里没有权限删减）。投诉处理**不改订单、不改退款**。

---

## 8. 打手（companion）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/dispatches` | `requireCompanion` | `companionDispatch` | 当前打手的两张订单池（专属 + 公共），含 `canAccept` 与 `notice` |
| POST | `/api/companion/dispatches/[id]/accept` | `requireCompanion` | `companionDispatch` | 接单（幂等重放）。所有判定在 `acceptDispatch` 的原子区段内 |
| GET | `/api/companion/orders` | `requireCompanion` | `companionOrders` | 仅返回 `actualCompanionId = 当前打手` 的订单 |
| GET | `/api/companion/orders/[id]` | `requireCompanion` | `companionOrders` | 打手订单详情；非 actualCompanion 统一按不泄露存在性的 404 处理 |
| POST | `/api/companion/orders/[id]/cancel` | `requireCompanion` | `companionOrders` / `companionOrderTransaction` | 仅 `accepted` actualCompanion 可主动取消；请求体含取消原因与幂等标识；成功后 `accepted → paid`、回 public、通知用户、记录最小退出历史；当前 P0 不处罚 |
| POST | `/api/companion/orders/[id]/start` | `requireCompanion` | `companionOrders` | 开始服务（`accepted → serving`），幂等重放 |
| POST | `/api/companion/orders/[id]/completion` | `requireCompanion` | `companionCompletions` | 当前实际打手在 `serving` 提交截图 + 5~50 字说明 |
| GET | `/api/companion/earnings` | `requireCompanion` | `companionEarnings` | 打手收益列表 + 汇总（冻结 / 可提现；**只读**） |
| GET | `/api/companion/conversations` | `requireCompanion` | `companionConversations` | 当前打手的订单聊天列表（一单一行，含未读与合计未读） |
| GET | `/api/companion/conversations/[orderId]` | `requireCompanion` | `companionConversations` | 某一单的聊天详情。⚠️ 地址里是 **orderId 不是会话 id**：打手不该知道内部会话键 |
| POST | `/api/companion/conversations/[orderId]/messages` | `requireCompanion` | `companionConversations` | 发送一条消息（幂等键必填）。发送者身份与落点（**当前那一段**）都由服务端写 |
| POST | `/api/companion/conversations/[orderId]/read` | `requireCompanion` | `companionConversations` | 标记已读。⚠️ 已读**按会话保存**（`companionLastReadAt`），不是按 orderId |

> ⚠️ **订单全额退款后，四个聊天接口的行为（`TBD-P0-14-1` 裁定，2026-09-27）**
> **列表 / 详情 / 已读仍然 200**（历史**保留可查**，列表行带 `isReadOnly: true`、详情 `notice` 换成退款文案），
> **发送返回 `400`**，错误文案 `COMPANION_ORDER_REFUNDED_MESSAGE`。
> **⚠️ 是 400 不是 404**：这段会话确实存在、也确实属于这位打手，只是不能再写。
> 回 404 会让客户端把裁定要求「保留可查」的历史当成「不存在」而藏起来。
> 与被换下的情形（**四个路由全 404**）**不是同一件事**——「这段聊天不再属于你」与
> 「属于你、但不能写了」用两个不同的码回答，正是让客户端分得清。
> **判据是 `order.status === "refunded"`（累计全额退款），不是 `refundedAmount > 0`**：
> 部分退款**不影响**写权限（订单继续履约）。
> ⚠️ 该闸**排在归属 / 段判定之后**——反过来会把「不是你的订单」也答成「已退款」，
> 于是拿别人的订单 id 就能问出那张单退没退款（§2.9 的存在性预言机）。
> 📌 这条**顺序**有用例专门守着（`tests/assignmentConversations.test.mjs` 的「只读 11」：
> 「退款单 + **非本人**发送仍是 404」）——把两个判断调换，**只有那一条会红**，
> 功能测试全绿。改这个函数时别只跑一遍全绿就收工。
> ⚠️ 该闸同时**零副作用**：它排在「确保这一段会话存在」**之前**，
> 因此一次被 400 拒绝的发送**不会**顺手建出一段空会话（与 P0-13 `D22` 同款约定）。

**⚠️ 打手接口 CURRENT 共 12 个**（上表即全部）。本章是打手端 CURRENT 的**唯一真值源**——
`COMPANION_API_MANIFEST` 与磁盘上的 `app/api/companion/**` 都由门禁与本表对齐，
别处不要再列第二份 CURRENT 清单。

⚠️ 上表在 P0-14 从 5 条修正为 12 条：`start` / `completion` / `earnings` 三条
（P0-7 / P0-8 / P0-9）此前只写在第三部分的 TARGET 小节里并标注了「已实现」，
本表没有跟着补——**同一个事实存在两处、其中一处是旧的**，正是本章开头反对的那种分叉。
本轮一并补齐，四个 P0-14 聊天接口列在表尾。

⚠️ 聊天四件套的权限边界与其它接口**不同，必须一起看**：这四条共用一个服务模块
`companionConversations`，读取与写入走**同一条**判据
（`canCompanionAccessConversation`，`lib/constants/conversations.ts`）。
换人 / 回池 / 封禁之后，旧打手在这四条上**一律 404**（与「订单不存在」同形），
新打手拿到的是**新的一段**会话——旧段落的消息他一条也读不到。
详见 `docs/01-requirements/` 与 P0-14 轮的交付报告。

**⚠️ `app/api/companion/**` 的接口清单门禁由 P0-5.5 建立**（管理端有 63 条、客服端有 16 条——⚠️ **这是 P0-5.5 当时的数字**；实测现为管理端 **64**、客服端 **25**，见第 13 节的表。此处的历史数字**保留不改**，只补一句说明，避免读者拿它当现值）：
清单契约（`GET` / `POST`、`requireCompanion()` 为第一动作、引用的服务层函数）由
`tests/companion.test.mjs` 强制，且该文件**扫描磁盘上的真实 route 文件**与清单做双向
`deepEqual`，见 §2.11。

### 8.1 `GET /api/companion/dispatches` 的**返回顺序**（P0-6.1）

**两张池子的顺序是接口契约的一部分，服务端是唯一真值源。**

| 池子 | 排序真值 | 方向 |
|---|---|---|
| 专属池 `exclusive` | `DispatchRecord.exclusiveEnteredAt` | ASC（等待最久优先） |
| 公共池 `public` | `DispatchRecord.publicPoolEnteredAt` | ASC（等待最久优先） |

- **顶部 = 在**当前这个池子**里等得最久的一单**；越往下 = 越晚进入当前池。
- **`EnteredAt` 取「当前池」的那一个**：由 `record.state` 决定
  （`exclusive` 取 `exclusiveEnteredAt`，其余取 `publicPoolEnteredAt`），
  与 `companionDispatchTransaction.currentDeadlineAt` **同形状**。
  ⚠️ 不能按 `exclusiveCompanionId` 取：`public` 记录可以带**非空**的
  `exclusiveCompanionId` / `exclusiveEnteredAt`（用户指定过、对方超时转池），
  那是历史事实，不是当前池。
- **禁止**以 `publicDeadlineAt` / `exclusiveDeadlineAt`（到点时刻）、`Order.createdAt`、
  Map / 数组插入顺序作为排序依据。前者在「公共池时长被后台改过」后与 `EnteredAt` 序**不同**
  （P0-1 起该时长可配置），后者在 P0-6 取消回池后会**倒挂**。
- **重新回池按新时刻**：`cancel` 回 public 会**重写** `publicPoolEnteredAt`
  （见本节上表 `cancel` 一条与 §3.1 共同约束），因此一张很早创建的订单在取消回池后
  按**这次进入**的时刻参与排序。
- **并列**：时刻完全相同时按 **`dispatchId` ASC**（稳定、确定性、与请求顺序无关）。
- **顺序只在服务端算一次**：调用方（页面 / HTTP 测试 / 将来的客户端）**不得再 `.sort(...)`**。
  排序键不进入 DTO——`CompanionPoolItem` 的字段集合**不因此变更**（见 §2.5 DTO 最小化）。
- 回归测试：`tests/companionPoolOrder.test.mjs`。

---

## 9. 入驻申请（companion-applications）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/companion-applications` | `requireUser` | `companionApplications` | 提交入驻申请（幂等键，一人一条） |
| POST | `/api/companion-applications/[id]/withdraw` | `requireUser` | `companionApplications` | 撤回申请 |

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/companion-applications` | `requireAdmin` | `adminCompanionApplications` | 申请列表 |
| GET | `/api/admin/companion-applications/[id]` | `requireAdmin` | `adminCompanionApplications` | 申请详情 |
| POST | `/api/admin/companion-applications/[id]/start-review` | `requireAdmin` | `adminCompanionApplications` | 开始审核 |
| POST | `/api/admin/companion-applications/[id]/approve` | `requireAdmin` | `adminCompanionApplications` | 通过 → 建立护航记录 |
| POST | `/api/admin/companion-applications/[id]/reject` | `requireAdmin` | `adminCompanionApplications` | 驳回 |

**⚠️ 这 5 条**，而 `tests/admin.test.mjs` 的标题写的是「申请审核**四件**」——是文案漂移，清单数组本身是 **64** 条且准确（⚠️ 原文写 63；P1-3 新增 `/api/admin/aftersales` 后实测 64，见 §12.8）。

> ⚠️ **P1-1 之后这处漂移仍未修**：标题里那一串件数是**人工维护的说明文字**，
> 唯一被 `deepEqual` 强制的是下面那个数组。本轮只往标题末尾追加了「+ 经营首页一件」，
> 没有顺手把「四件」改成「五件」——那是与经营首页无关的一处文案订正，
> 混在本轮里会让「这一轮动了什么」变得说不清。**登记为 NOTE，留给下一次有人真的在改这行时一起处理。**

---

## 10. 其余用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/coupons` | `requireUser` | `coupons` | 我的优惠券 / 可领券列表 |
| POST | `/api/coupons/[id]/claim` | `requireUser` | `coupons` | 领券（幂等键，同一券限领一次） |
| GET | `/api/favorites` | `requireUser` | `favorites` | 我的收藏 |
| POST | `/api/favorites` | `requireUser` | `favorites` | 添加收藏（重复添加幂等） |
| GET / DELETE | `/api/favorites/[productId]` | `requireUser` | `favorites` | 查询 / 取消单条收藏 |
| GET | `/api/notifications` | `requireUser` | `notifications` | 站内通知列表 + 未读数 |
| POST | `/api/notifications/[id]/read` | `requireUser` | `notifications` | 标记已读 |
| GET | `/api/tips` | `requireUser` | `tips` | 鸡腿（打赏）记录 |
| GET | `/api/suggestions` | `requireUser` | `suggestions` | 我的反馈列表 |
| POST | `/api/suggestions` | `requireUser` | `suggestions` | 提交反馈（幂等键） |
| GET | `/api/reviews` | `requireUser` | `reviews` | 我的评价（已评 / 待评两个 tab） |
| GET | `/api/service/conversations` | `requireUser` | `conversations` | 客服会话列表 |

---

## 11. 客服工作台（staff）—— 25 条

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/conversations` | `requireStaff` | `staffConversations` | 全部订单会话 |
| GET | `/api/staff/conversations/[orderId]` | `requireStaff` | `staffConversations` | 单个会话详情 |
| POST | `/api/staff/conversations/[orderId]/messages` | `requireStaff` | `staffConversations` | 客服发消息 |
| POST | `/api/staff/conversations/[orderId]/read` | `requireStaff` | `staffConversations` | 标记客服侧已读（按 `staffId` 独立） |
| GET | `/api/staff/orders` | `requireStaff` | `staffOrders` | 全量订单查询（状态 / 游戏 / 日期 / 关键词筛选，P0-10） |
| GET | `/api/staff/orders/[id]` | `requireStaff` | `staffOrders` | 订单只读详情（P0-10） |
| POST | `/api/staff/orders/[id]/release` | `requireStaff` | `staffOrderActions` | 退回公共池。`reason` 必填，`accepted` / `serving` 均可（P0-11） |
| POST | `/api/staff/orders/[id]/replace` | `requireStaff` | `staffOrderActions` | 指定新护航（direct replace）。不再需要管理员批准（P0-11） |
| GET | `/api/staff/orders/[id]/replace-candidates` | `requireStaff` | `staffOrderActions` | 换人候选名单。服务端已按资格筛过（P0-11） |

完成材料 4 条见 §3.2，投诉 5 条见 §7，退款 4 条见 §6，auth 3 条见 §1。

**⚠️ 客服侧已读与用户侧已读是两份独立状态**，刻意不合并：
客服读完一个会话不能把用户的未读角标清零，反之亦然。键里带 `staffId`，因为两位客服同时值班时，一位读过的会话不该从另一位的工作台上消失。

**⚠️ 客服端订单段的五个地址分成两组，写的那三个写的不是「订单记录」**（P0-10 开只读两个，
P0-11 开处置三个）：

- **两个只读**（`/api/staff/orders` · `/api/staff/orders/[id]`）——一个写方法都没有。
- **三个处置**——改的是这一单**当前的履约绑定**（退回公共池 / 指定新护航），
  **不改金额、不改商品、不写退款、不动护航收益**，也不引入 `OrderStatus` 之外的新状态：
  退回落到 `paid`，换人落到 `accepted`。因此 §`staffOrderActions` 里**没有任何
  `refundRepository` / `earningRepository` 依赖**（有测试门禁钉住这一条）。
  资金最终划拨仍然留在管理员侧（理由见 §6）。

唯一的例外是两个**读取路径上的惰性物化**（`sweepExpiredDispatches` /
`sweepCompletionAutoApprovals`），`/api/staff/orders` 与 `/api/staff/orders/[id]` 各调用一次。
它们是幂等的、与业务动作无关的既有惯例（`adminOrders` / `orders` / `companionOrders` /
`staffCompletions` 挂在同一处，**同一个函数，不是第二套实现**），作用是让这一页显示的
派单与完成材料状态与业务事实一致——不挂的话客服会对着一条 `publicDeadlineAt` 早已过去的
「等待接单」去催一个不存在的接单。**它们不是客服可以触发的东西**：客服没有任何输入能
决定物化哪一个、物化几次。

⚠️ **但 P0-11 起客服**确实**有一条能间接改变完成材料状态的动作**：退回公共池 / 换人会让
该单 `pending` 的完成材料转成 `invalidated`（`invalidatePendingCompletionForOrder()`，
与惰性物化**不是一回事**——它由业务动作触发、且只作用于一单）。因此「客服侧完全不能写」
这句话在 P0-11 之后不再成立；准确的说法是**客服不能改订单的金额与状态机之外的字段**。

**⚠️ 客服端订单 DTO 与管理端是两份字段表**（`StaffOrderListItem` / `StaffOrderDetail` vs
`AdminOrderListItem` / `AdminOrderDetail`）：客服侧**刻意不含**平台净收入、分账比例、
护航收益、游戏账号与备注。客服看的是「用户侧的钱」（应付 / 实付 / 已退），不是「分账与平台的账」。

---

## 12. 管理后台（admin）—— 71 条

> ⚠️ **本节的数字 = `find app/api/admin -name route.ts | wc -l` 的实测值**。
> 下面的小节只逐条列出**成组**的路由；订单 / 退款 / 投诉 / 申请等分散在 §5 / §6 / §7 / §9。
> 因此**各小节括号里的条数之和 ≠ 本行总数**，这是编排方式，不是漏记。

### 12.1 订单 / 退款 / 投诉 / 申请

见 §5 / §6 / §7 / §9 中的管理端部分（`requireAdmin`）。订单管理端**只读**：

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/orders` | `requireAdmin` | `adminOrders` | 订单列表（状态 / 游戏 / 日期筛选） |
| GET | `/api/admin/orders/[id]` | `requireAdmin` | `adminOrders` | 订单详情 |

### 12.2 护航管理（7 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET | `/api/admin/companions` | `requireAdmin` | `adminCompanions` |
| GET / PATCH | `/api/admin/companions/[id]` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/enable` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/disable` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/pause` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/resume` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/remove` | `requireAdmin` | `adminCompanions` |

**⚠️ `pause` / `resume` 改的是 `available`（当前能不能接新单），`enable` / `disable` 改的是 `enabled`（资格在不在架），`remove` 是软删除（写 `removedAt`）。三者语义不同，不要合并。**

### 12.3 商品与类目（11 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET / POST | `/api/admin/products` | `requireAdmin` | `adminProducts` |
| GET / PATCH | `/api/admin/products/[id]` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/publish` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/unpublish` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/remove` | `requireAdmin` | `adminProducts` |
| GET / POST | `/api/admin/categories` | `requireAdmin` | `adminCategories` |
| GET / PATCH | `/api/admin/categories/[id]` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/enable` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/disable` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/remove` | `requireAdmin` | `adminCategories` |

### 12.4 运营内容（15 条）

四类内容同构：**协议（agreements）/ 公告（announcements）/ Banner（banners）/ 快捷入口（quick-entries）**。

| 模式 | Method | Guard | Service |
|---|---|---|---|
| `GET` 列表 | GET | `requireAdmin` | `adminAgreements` / `adminAnnouncements` / `adminBanners` / `adminQuickEntries` |
| `POST` 新建 | POST | `requireAdmin` | 同上（协议无新建） |
| `GET / PATCH` 单条 | GET, PATCH | `requireAdmin` | 同上 |
| `/enable` `/disable` `/remove` | POST | `requireAdmin` | 同上 |

具体路径：`/api/admin/content/{agreements,announcements,banners,quick-entries}`。

### 12.5 客服账号（5 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET / POST | `/api/admin/staff` | `requireAdmin` | `adminStaff` |
| GET / PATCH | `/api/admin/staff/[id]` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/enable` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/disable` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/remove` | `requireAdmin` | `adminStaff` |

### 12.6 平台配置（1 条）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET / PATCH | `/api/admin/platform-config` | `requireAdmin` | `adminPlatformConfig` | 专属池超时 / 公共池超时 / 完成材料自动审核 / 投诉窗口（单例，无 `[id]`，只有 GET 与 PATCH） |

### 12.7 经营首页（1 条，P1-1）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/dashboard` | `requireAdmin` | `adminDashboard` | 今日订单 / 今日 GMV / 今日退款 + 三类待办数 |

### 12.8 售后工作台（1 条，P1-3）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/aftersales` | `requireAdmin` | `adminAftersales` | 退款 + 投诉混合待办列表（三视图）。**只有列表这一个地址**：详情由服务端组件直接调服务，处置动作仍只在 `/api/admin/refunds/**` 与 `/api/admin/complaints/**` 上 |

> 📌 **本小节是 P1-5 补记的**：该路由由 **P1-3** 交付（见 `tests/admin.test.mjs` 的清单注释），
> 但在本文档里一直只出现在第 13 节的门禁计数里、没有对应小节，导致 §12 的标题数（旧写 63）
> 与实测数（64）长期对不上。P1-5 **没有改这个路由的任何代码**，只是把文档补到与源码一致。

**⚠️ 只有这一个地址，也只有 `GET`**：经营首页是**只读聚合**——它不做审批、不退款、
不换人、不改任何申请状态，因此没有 POST / PATCH / DELETE。
明细与处置都在各自的模块页里，首页只负责聚合、展示与跳转。

**返回的是 `AdminDashboardDTO`，不是一个「数据集合」**（`businessDate`、`metrics`、
`pending` 三个键，金额单位为**分**）。它**不返回** `Order[]`、用户对象、游戏账号、
`remark`、`companionRateSnapshot` 或任何分账字段——精确键由
`tests/adminDashboard.test.mjs`（经营 24 / 25）钉住。

**⚠️ 业务日由服务端算**（`beijingDateKey(new Date().toISOString())`，
与订单列表的日期筛选**同一个口径**）并随 DTO 下发，浏览器**不参与任何时间计算**。
因此「页面按本地时区算今天、服务端按 UTC+8 算今天」这种不一致在本结构下不可能发生。

**⚠️ 口径**（详见 `docs/03-dev/rounds/P1-1/02-decisions.md` D1–D4）：

| 指标 | 口径 | 明确**不是** |
|---|---|---|
| 今日订单数 | 今天 `paidAt` 的订单数（不按状态过滤） | 支付尝试数 / 预览数；今天退款也不剔除 |
| 今日 GMV | 今天成功支付订单的 `actualPaidAmount` 之和 | 原价；分账 / 平台净收入；**退款不倒扣** |
| 今日退款金额 | 今天**实际执行**的退款之和，按**退款发生时刻**归属。**三条执行路径**：用户直接退款 + 售后审核通过 + **公共池超时自动退款**；**两个取数通道**见下 | `Order.refundedAmount`（累计值，跨日会重复计） |
| 三类待办 | 仅统计**仍需要管理员动作**的既有状态（申请 / 退款：待审核 + 审核中；投诉：待处理 + 处理中） | 终态记录；**不新增任何业务状态** |

**退款的两个取数通道**（`applyOrderRefund` 全仓只有三个调用方，其中两个**不写**
`RefundRequest`）：① **售后审核通过**——逐条 `RefundRequest.decision.refundAmount` 按
`decidedAt` 归属；② **用户直接退款 + 公共池超时自动退款**——只能从订单侧发现
（`order.refundedAt`），增量为 `actualPaidAmount − Σ 该订单已通过退款的 refundAmount`
（差额为 0 说明整单是售后退满的，第 ① 类已计过）。**全程不读 `Order.refundedAmount`**。
完整口径表见 `docs/03-dev/rounds/P1-1/02-decisions.md` D4。

**⚠️ 待办卡与列表的一致性（R6 裁定）**：三张待办卡上的数字**必须**等于点进去的列表条数。
实现上是**同源**的——卡上的数直接取三个列表服务在 `status=open` 下的 `total`
（不是「各算一遍、恰好相等」）。详见 §2.11。

---

### 12.9 优惠券（7 条，P1-4 发券 + P1-6 模板）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/coupon-templates` | `requireAdmin` | `adminCouponTemplates` | 模板列表（关键词 / 启用状态筛选 + 分页）。**含已停用券与历史券** |
| POST | `/api/admin/coupon-templates` | `requireAdmin` | `adminCouponTemplates` | 新建满减券模板 |
| GET | `/api/admin/coupon-templates/[id]` | `requireAdmin` | `adminCouponTemplates` | 模板详情（含只在后台可见的时间戳与领取数） |
| PATCH | `/api/admin/coupon-templates/[id]` | `requireAdmin` | `adminCouponTemplates` | 编辑（名称 / 门槛 / 面额 / 有效期 / 启用状态，一次保存） |
| POST | `/api/admin/coupon-templates/[id]/enable` | `requireAdmin` | `adminCouponTemplates` | **窄写入**：只改 `enabled` |
| POST | `/api/admin/coupon-templates/[id]/disable` | `requireAdmin` | `adminCouponTemplates` | **窄写入**：只改 `enabled` |
| GET | `/api/admin/coupons` | `requireAdmin` | `adminCoupons` | 可发放的模板（**已启用 ∧ 参与结算**） |
| GET | `/api/admin/coupons/grant-targets` | `requireAdmin` | `adminCoupons` | 按关键词找用户；空关键词返回空列表 |
| POST | `/api/admin/coupons/grant` | `requireAdmin` | `adminCoupons` | 向指定用户发放一张券 |

> 📌 **后三条（`/api/admin/coupons` 系列）是 P1-4 交付的，但一直没有出现在本文档里**——
> `tests/admin.test.mjs` 的清单数组收着它们，本文档的 §12 却没有对应小节，
> 于是 §12 的标题数长期比实测少 3。**P1-6 没有改这三条路由的任何代码**，
> 只是把文档补到与源码一致（同 §12.8 对 P1-3 的处理）。

**⚠️ 六个模板接口的读与写都是 Admin only。** 与用户端接口不同，模板里有
**已停用券、已过期券与历史折扣 / 无门槛券**——视野比用户端只看得见「现在能领的券」宽得多，
因此**读也必须有管理权限**（匿名 401、有会话无权限 403）。

**⚠️ 没有第三个窄写入地址，更没有删除地址。** 启停只有 `enable` / `disable` 两个，
且**列表页是只读的**：这两条窄写入的调用方是**详情页**（见 `P1-6/02-decisions.md` D2）。
模板的生命周期终点是 `enabled=false`，**不存在硬删除**（`P1-6` §6 明文；
`tests/adminCouponTemplates.test.mjs` 直接枚举该目录断言恰好四个文件）。

**⚠️ 路径为什么不是 `/api/admin/coupons`（复数）**：那个地址已经被 **P1-4 的发券**
占用了，而它管的是 `CouponClaim`（发到某个人手里的券），与模板的增删改是两件事。
模板用 `coupon-templates` 这个**独立主键**，两者在 URL 上就不共用命名空间。

# 第二部分：API Conventions

**以下约定在当前仓库中已经稳定，新增接口必须遵守。**

## 2.1 四个守卫

| 守卫 | 位置 | 读取 | 未登录 | 已登录但无权限 |
|---|---|---|---|---|
| `requireUser()` | `lib/api/route.ts` | 用户 Cookie | 401 `UNAUTHORIZED` | — |
| `requireAdmin()` | `lib/api/adminRoute.ts` | 管理 Cookie | 401 `UNAUTHORIZED` | 403 `FORBIDDEN` |
| `requireStaff()` | `lib/api/staffRoute.ts` | 客服 Cookie | 401 `UNAUTHORIZED` | 403 `FORBIDDEN` |
| `requireCompanion()` | `lib/api/companionRoute.ts` | 用户 Cookie + `resolveCompanionAccess()` | 401（由 `requireUser()` 给出） | 403 `FORBIDDEN`（两种情形分开表达） |

**规则**：

1. **每个接口必须自己调用守卫，而且必须是第一步。** 页面上的隐藏按钮、侧栏里的禁用项**不构成保护**——接口可以被直接请求。
2. **四个守卫并列，不合并成参数化函数。** 理由见 `architecture-rules.md` §4.2。
3. **「我是谁」只能由服务端会话决定**，不接受请求体或查询参数里的任何用户标识。

## 2.2 401 / 403 / 404 语义

| 状态 | 含义 | 客户端处置 |
|---|---|---|
| **401 `UNAUTHORIZED`** | 未登录 / 会话失效 | 去登录页 |
| **403 `FORBIDDEN`** | 已登录，但没有该权限（换账号也没用） | 换账号 |
| **404 `NOT_FOUND`** | 资源不存在；**或用于刻意隐藏存在性**；**或功能未启用** | 视场景 |

**两个刻意使用 404 的场景**：

1. **不泄露资源存在性**——如「其他打手访问不属于他的订单」返回 404 而不是 403。
2. **Mock 开关关闭**——`mock-login` / `mock-confirm` / `debug/reset` 在开关关闭时返回 **404 而不是 403**：功能不存在，而不是「你没权限」。

**⚠️ 两种拒绝的文案策略**：管理端与客服端给**同一套、不含具体原因的提示**——区分「你不是管理员」与「你的账号被停用了」，等于给出一个可以探测账号状态的接口。
**打手端是例外**：「不是护航」与「资格已下架」分开表达，因为这两件事对使用者的下一步动作完全不同（去入驻 vs 找管理员），且不构成账号探测（这位用户自己本来就知道）。

## 2.3 响应信封

```ts
// 成功
{ data: T }

// 失败
{ error: { code: ApiErrorCode; message: string } }
```

`ApiErrorCode`（`lib/types/common.ts`）= `BAD_REQUEST` | `UNAUTHORIZED` | `FORBIDDEN` | `NOT_FOUND` | `SERVER_ERROR` | `NETWORK_ERROR`。

**⚠️ `NETWORK_ERROR` 只在浏览器侧产生**，不参与 HTTP 状态映射（`STATUS_BY_CODE` 里为 0）。

**状态码由 `code` 推导**（`lib/api/ApiError.ts` 的 `STATUS_BY_CODE`），少数刻意区分的场合显式传入。
**⚠️ 缺了这层映射就会出现「业务校验失败却回 500」**：客户端拿到的 `code` 是 `BAD_REQUEST`、状态码却是 500，重试策略与日志都会把它当成服务端故障。

Route Handler 侧统一用 `ok()` / `fail()` / `toApiError()`。
**非 `ApiError` 一律归一成 `SERVER_ERROR`，不把内部异常信息暴露给客户端。**

## 2.4 请求体校验

用 `readJsonBody(request)`（`lib/api/route.ts`）：解析失败或不是对象（含数组）→ 抛 `BAD_REQUEST`。
字段级校验在 **`lib/constants/*.ts`** 里做（如 `validateGameAccount`、`validateComplaintText`），返回校验结果供 service 抛 `ApiError`。

**CURRENT 没有 validation 框架。** 引入需先说明手写校验在哪类输入上已失控，见 `tech-stack.md` §十。

## 2.5 DTO 最小化 —— 硬约束

**接口从不返回仓储记录整体，一律显式挑字段。**

**已明确执行的四条**：

| 接口 | 刻意不返回 |
|---|---|
| `/api/admin/auth/session` | 密码、密钥、`enabled`、`lastLoginAt` |
| `/api/companion/dispatches`（池卡片） | `gameAccountId`、`remark`、`userId`、金额明细 |
| `/api/orders/[id]`（用户侧订单） | `clubNetIncome` |
| `/api/staff/orders`、`/api/staff/orders/[id]`（客服侧订单，P0-10） | `clubNetIncome`、`companionRateSnapshot`、`companionBaseIncome`、`gameAccountId`、`remark`、内部 `userId` |
| 聊天三端（`/api/orders/[id]/messages`、`/api/companion/conversations/**`、`/api/staff/conversations/[orderId]`，P0-14） | `conversationId`、`assignmentKey`、`assignmentSeq`（**内部履约键**）。消息在三端**各有一个显式转换点**（用户端 `toMessageView()` · 打手端 `toCompanionChatMessage()` · 客服端 `toStaffConversationMessage()`），三端形状不同、**故意不共用函数**——因此这里**没有**「改一处三端一起变」的兜底，新增出站路径必须自己再挑一次字段 |
| `/api/orders/[id]/messages`（用户侧聊天，P0-14） | 另加 `companionId`、`companionLastReadAt`：用户的段落 DTO 不带打手 id，也不带打手的已读游标 |
| `/api/companion/conversations/**`（打手侧聊天，P0-14） | 另加：**别的段落**。打手只取得到「当前那一段」，旧段落的消息在服务层就被判掉（不是靠页面不显示） |
| `/api/admin/dashboard`（经营首页，P1-1） | 整个 `Order` / `RefundRequest` / `Complaint` 记录：`userId`、`gameAccountId`、`remark`、`companionRateSnapshot`、`companionBaseIncome`、`clubNetIncome`、`platformNetIncome`、`refundedAmount`、`actualPaidAmount`、`totalAmount`。**只出六个聚合数与一个业务日**——这一条比其它几条更严：它不是「少挑了字段」，而是**根本不返回集合**，因此将来给订单加任何字段都不会流出去 |

**理由**：字段是**显式挑出来的**，因此将来给实体加字段**不会自动顺着接口流出去**。

## 2.6 金额单位

**一律整数「分」**（`number`）。
**只在服务端计算**，`*Http.ts` 与 `components/` 不做金额算术。
**公式必须复用** `lib/constants/orderAmount.ts`。

## 2.7 时间格式

**ISO 8601 字符串**（`string`），不是 `Date` 对象。
需要「同一时刻」语义的地方（如清扫 + 剩余时间），**由调用方传入 `at`**，不在函数内取 `new Date()`。

## 2.8 幂等（idempotency）

**四种机制并存，按场景选择**：

| 机制 | 实现位置 | 用于 |
|---|---|---|
| **幂等键索引** | 各 store 的 `${userId}:${idempotencyKey}` → 记录 id | 用户侧创建类接口（支付请求 / 退款 / 投诉 / 评价 / 反馈 / 领券 / 消息） |
| **业务唯一键索引** | 如 `${userId}:${orderId}`（一单一评）、`orderId` → 退款申请 id **列表**（`refundIdsByOrder`，**P0-13 起为多值**） | 天然唯一的业务关系。⚠️ 「一单一退款」**不再是这条索引的含义**：部分退款要求同一单能退第二次，因此它现在回答的是「这一单有哪些申请」，而「同一时刻最多一条进行中」由 `isActiveRefundStatus` 单独判定 |
| **`operationId` 重放** | `lib/data/adminWriteSupport.ts` 的 `takeReplay` / `takeReplayForAction` / `takeCreateReplay` | 管理端 / 客服端写操作 |
| **状态本身即判据** | 动作伪事务的原子区段内先判「结果状态是否已经成立」 | **只有结果状态可作判据的推进类动作**：`acceptDispatch`（P0-5）/ `startCompanionOrder`（P0-7）/ `approveCompletion` · `rejectCompletion`（P0-8）。**有没有请求体不是判据**——`rejectCompletion` 带 `reviewNote`，但重放判据仍是「这份材料是否已经是 `rejected`」 |

**⚠️ 选哪种，先问「这个动作有没有天然的状态判据」。** 有（「这一单已经是我的 `serving` 了吗」）就用第四种——
它不引入需要客户端生成、传输、保存的键，因此也不需要一条「键必填」的校验规则；没有（用户侧创建类，
同一用户可能合法地连提两次）才需要幂等键。

**⚠️ 幂等的关键性质**：**同一个幂等键第二次到达时，既不重复写业务数据，也不写第二条审计。**
**⚠️ 状态判据式的重放还要求**：不刷新已经写入的时间戳（`start` 的 `servingAt`、`completion` 通过后的
`completedAt`、以及审核结果首次落地的 `reviewedAt` 都必须停在第一次那一刻——三处都写成
`xxx ?? at`；`rejectCompletion` 的重放**不覆盖**第一次的驳回原因）。
**⚠️ 第四种机制的一个已知边界**：完成材料的 `applyCompletionReview` 只按调用方给的目标状态写入，
**它自己不校验起始状态**——合法性由伪事务在调用它之前判定。因此「作废一份 pending」这类新动作
（P0-9 的封禁回池）**不能**图省事复用它，那会写出状态机不允许的边，并且会让
「同一订单最多一份 pending」的索引与记录状态脱钩。
**⚠️ 实现细节（Observed Current，不是规范）**：`operationId` 重放是靠**扫描内存中的审计条目**（`auditIdByOperationId` Map），**不是数据库唯一索引**。映射到真实数据库时必须改为 unique constraint，见 `database-schema.md`。

## 2.9 资源归属

**归属判定必须在服务端做，且只在 service / 事务里做一次。**

- 用户侧：查询一律带 `userId`，不是「查出来再比对」。
- 打手侧：`order.actualCompanionId` 决定谁能操作；非归属者的访问按 **404**（不泄露存在性）处理。
- 客服侧：客服的已读状态**按 `staffId` 独立**。

## 2.10 Mock API 开关

五个开关见 `tech-stack.md` §六。**关键行为**：

- 关闭时对应接口返回 **404**（不是 403）：功能不存在。
- 开关用**动态 key** 读 env，避免被构建期内联。
- **三个登录开关互不影响**：「用户 Cookie 不能获得管理权限」「管理 Cookie 不能冒充普通用户」在开关层面也不会串。

**调试参数**（`ENABLE_MOCK_DEBUG` 控制）：`mockError` / `mockEmpty` / `mockDelay`，由 `lib/api/client.ts` 的 `withMockParams` 透传，`lib/mocks/debug.ts` 读取。**Mock 层移除时一并删除**。

### 2.10.1 调试接口（`POST /api/debug/reset`，DEV-2 新增）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/debug/reset` | `ENABLE_MOCK_DEBUG`（关闭时 404） | `lib/services/mockStores` → `lib/data/mockStore` | **把当前进程的全部 Mock 存储丢回预置**，返回 `{"data":{"reset":[...被丢弃的 store 名]}}`。**测试专用，不是业务接口** |

⚠️ **`ENABLE_MOCK_DEBUG` 的语义在 DEV-2 之后不再只是「读侧调试参数」**：它还控制一个
**会写（清空）内存存储**的接口。三条边界必须一起读：

1. **未开启时 404**，与其余 Mock 开关同一取舍；正式部署不设置该变量。
2. **在开启的环境里它是破坏性的**——任何能访问该服务的人都能清空 Mock 数据。
   数据本身是一次性内存数据、无真实用户数据，但**这个开关不能开在任何有真实数据的部署上**。
3. **接真实后端时必须删除这条路由**（连同 `lib/services/mockStores.ts`），
   真实测试该用独立测试库，而不是给线上服务开一个清库接口。

它没有 `requireAdmin()`：调用方是 24 个 HTTP 测试文件的模块加载期（各自身份不同），
而其唯一实际边界是 `ENABLE_MOCK_DEBUG` 开关本身。完整论证见
`app/api/debug/reset/route.ts` 的头部注释与 `docs/03-dev/rounds/DEV-2/02-decisions.md` §四。

## 2.11 接口清单门禁

**新增后台 / 客服 / 打手接口时，必须同批扩充清单数组**：

| 门禁 | 位置 | 当前条数 |
|---|---|---|
| 管理端 | `tests/admin.test.mjs` | 71（P1-1 扩充：+1 经营首页 `GET /api/admin/dashboard`；P1-3 扩充：+1 售后工作台 `GET /api/admin/aftersales`；**P1-6 扩充：+4 券模板**。⚠️ P1-4 的 **3 条发券路由此前一直没有同步到本文档、也没进本行的累计数**，P1-6 一并补记，因此本行从 64 直接跳到 71 而不是 68） |
| 客服端 | `tests/staff.test.mjs` | 25（P0-10 扩充：+2 全量订单查询；P0-11 扩充：+3 订单处置） |
| 打手端 | `tests/`（P0-5.5 建立，扫描 `app/api/companion/**`；P0-6 / P0-7 / P0-8 / P0-9 / P0-14 扩充） | 12 |

**打手端门禁：已确认建立（产品裁定 2026-09-19），属 P0-5.5，本轮落地。**
建立与 Admin / Staff 类似的 Companion API route manifest / route gate，扫描 `app/api/companion/**` 并与预期清单比对：

- 清单**逐条列出**（不是只断言数量）。**P0-14 起共十二条**：`GET /api/companion/dispatches`、`POST /api/companion/dispatches/[id]/accept`（P0-5.5），`GET /api/companion/orders`、`GET /api/companion/orders/[id]`、`POST /api/companion/orders/[id]/cancel`（P0-6），`POST /api/companion/orders/[id]/start`（P0-7），`POST /api/companion/orders/[id]/completion`（P0-8），`GET /api/companion/earnings`（P0-9），`GET /api/companion/conversations`、`GET /api/companion/conversations/[orderId]`、`POST /api/companion/conversations/[orderId]/messages`、`POST /api/companion/conversations/[orderId]/read`（P0-14）；
  其中 P0-14 的四条共用一个服务模块且共用一条判据（见 §8 的说明）——单看「地址不同」看不出这一点，因此清单里的 `service` 字段四条都指向 `companionConversations`，这正是「读取与写入不许各判一次」在门禁上的体现；
- 每个路由**导出的 HTTP 方法**要与清单一致（多一个方法也要现形），第一动作必须是 `requireCompanion()`，且不出现其它身份的守卫；引用的服务层函数也要与清单一致；
- 同时 `orders/**` 下的 `POST` 写入口**恰好三个**（`cancel` / `start` / `completion`）且集合逐字相等——门禁按「导出 `POST` 的文件集合」判定，因此把接口改名成 `begin` / `serve` / `submit` 也绕不过去；
- **不得**把**尚未实现**的 TARGET 路由登记进清单。这条由「清单与实际路由**逐字相等** + 数量**恰好**」两条断言共同强制：`app/api/companion/**` 下多出任何一个 `route.ts`（当前最可能的是提现入口 `/companion/withdrawals`——它的入口 / 流程 / 渠道 / 最小金额全部仍是 TBD，见第四部分）都会让数量断言失败，因此**不需要**为每个未来路径各写一条具名负向断言。⚠️ 该机制的前提是**数量断言与清单长度同批更新**——只改清单不改数量，就等于把门禁关掉；
- **P0-9 新增的负向约束**：`earnings` 是**只读**接口，`app/api/companion/earnings/route.ts` 只允许导出 `GET`。收益的任何写入（生成 / 解冻）都发生在服务端伪事务里，接口层没有写入入口——因此「打手自己把自己的收益改成可提现」在结构上不存在；
- 另一条只属于 `start` 的门禁：**它的接口不读请求体**（这个动作没有原因、没有幂等键，幂等判据是状态本身）。一旦有人给它加上 `readJsonBody`，一个空体 POST 就会变成 400，等于发明了一条服务端文档里没有的必填体规则；
- **「不读请求体」不是 `start` 独有**：`POST /api/staff/completions/[id]/approve`（P0-8）同样不读体（通过没有原因，幂等判据是状态本身）。**反例是 `reject`**——它必须读 `reviewNote` 且必填。判据是「这个动作有没有必须由人填写的输入」，不是「它属不属于推进类动作」；
- **未来真正新增 Companion 订单接口时同步扩充清单**；
- **新增、删除、误改路径时测试必须失败**；
- **沿用现有 tests 的源码扫描 / 路由门禁方式，不新建测试框架**；文件名遵循仓库现有命名风格，不为了名字本身新增抽象。

**`tests/companion.test.mjs` 已于 P0-5.5 建立，P0-6 扩充至 5 条路由 / 7 条用例，P0-7 扩充至 6 条路由 / 8 条用例，P0-8 扩充至 7 条路由 / 8 条用例，P0-9 扩充至 8 条路由**（全绿）；上列清单即该文件里的 `COMPANION_API_MANIFEST`，「第一动作必须是 `requireCompanion()`」由位置断言强制（比较前先剥掉 import，否则该断言恒为真）。

---

## 2.12 列表筛选的**虚拟值** `open`（P1-1 R6 裁定）

三个管理端列表支持一个**查询层虚拟筛选值** `status=open`，含义是该领域**尚未终结**的状态集合：

| 接口 | `open` 等价于 | 集合定义处 |
|---|---|---|
| `GET /api/admin/companion-applications` | `pending` + `reviewing` | `lib/constants/adminApplications.ts` `OPEN_APPLICATION_STATUSES` |
| `GET /api/admin/refunds` | `pending` + `reviewing` | `lib/constants/refunds.ts` `OPEN_REFUND_STATUSES`（**与既有的 `ACTIVE_REFUND_STATUSES` 是同一个数组**） |
| `GET /api/admin/complaints` | `pending` + `processing` | `lib/constants/complaints.ts` `OPEN_COMPLAINT_STATUSES` |

**硬约束**：

- **`open` 不是领域状态**：它**不写入** store / database、**不进入**任何业务状态机、
  不出现在任何 DTO 的 `status` 字段里。它只在**查询层**存在，由各领域的
  `*StatusesForFilter()` 展开成上面那个真实状态集合。
- **数据层看不到它**：仓储的筛选契约是 `statuses: readonly <领域状态>[] | null`，
  `"open"` / `"all"` 在**类型上**就传不进去（`tests/adminDashboard.test.mjs` 经营 22
  另有一条源码级断言：三个仓储文件里不得出现这两个字符串）。
- **只有管理端有它**：客服端的 `readStaffRefundStatusFilter()` /
  `readStaffComplaintStatusFilter()` 仍然**拒绝** `open`（返回 `null` → 400）。
  staff 与管理端共享的是**服务层的解析函数**，不是**筛选联合类型**。
- **与其它筛选正交**：`open` 只决定状态集合，可与 `keyword` / `page` / `pageSize` /
  `gameId` / `type` 组合。`total` 仍是**分页前**的匹配条数。
- **单值语义不变**：`?status=pending` 依旧**只**筛 `pending`，没有被悄悄放宽成 `open`。
  非法值的契约也不变（仍是 400 + 同一句枚举提示，只是枚举里多了 `open`）。

**为什么需要它**：经营首页（`GET /api/admin/dashboard`）的三张待办卡要求
「卡上的数 == 点进去的列表条数」。若列表只支持单值精确匹配，卡片数的**集合**
就没法用地址栏表达，点进去必然更少（实测过卡 3、点进去 0）。现在卡片上的数
**直接取这三个列表服务在 `status=open` 下的 `total`**，三张卡一律跳 `?status=open`。

**测试**：`tests/adminDashboard.test.mjs` 经营 18–23（定义唯一性 / 虚拟值边界）、
43–47（卡片 == 列表、单状态兼容、`open` + 关键词/分页、`all` 与 `open` 的区别）。

---

# 第三部分：TARGET API

**以下能力已由 2026-09-23 V0.3 需求确认，尚未实现的一律标注 `TARGET — NOT IMPLEMENTED`；旧 P0-6/P0-7/P0-8 编号不再作为执行顺序真值。**

## 3.1 Companion 我的订单、主动取消与开始服务

> ⚠️ **本节四条全部已实现**：`GET /api/companion/orders`、`GET /api/companion/orders/[id]`、
> `POST /api/companion/orders/[id]/cancel`（P0-6）与 `POST /api/companion/orders/[id]/start`（P0-7）。
> 它们属 CURRENT，清单**只在 §8 列出一次**，本节不重复——同一份文档里放两张 CURRENT 表，
> 迟早会有一张先改、另一张被当成还没实现。

### TARGET — NOT IMPLEMENTED

（无。`start` 已于 P0-7 落地，见 §8；后续阶段是 §3.2 的 CompletionSubmission。）

**共同约束（四条 CURRENT 接口都适用）：**

- `exclusiveCompanionId` 不授予我的订单详情/动作权限；资源归属看 `actualCompanionId`。
- `cancel` 只允许 `accepted`；`serving` 后没有普通主动取消入口。
- `cancel` 回 public 时必须重新冻结 `publicPoolEnteredAt / publicTimeoutMinutesSnapshot / publicDeadlineAt`，并清除“当前履约绑定”；历史由最小退出记录保留。
- `start` 只有 `accepted` 合法，且不存在任何根据时间 / 备注 / 聊天自动进入 serving 的路径。
- 幂等/并发下只允许一次真实状态推进，不重复通知、不刷新已经成功写入的时间。
  两条接口的重放判据不同：`cancel` 用幂等键，`start` 用**状态本身**（已经是 `serving` 且归本人）。
- 新增 Companion API 落地时必须同步扩充 `tests/companion.test.mjs` 的 manifest；未实现前不得预登记（见第二部分末的负向门禁）。

**打手端页面入口**：`/companion/orders`、`/companion/orders/[id]`（P0-6 已实现）。

同一个详情页继续承载 `accepted` 的“开始服务”（**P0-7 已落地**）和 `serving` 的“提交完成材料”（**P0-8 已落地**，见 §3.2），不得为后续阶段复制第二套订单详情。

## 3.2 CompletionSubmission：人工审核 + 10 分钟默认自动审核

> ⚠️ **本节五条已于 P0-8 全部实现**（`POST /api/companion/orders/[id]/completion`、
> `GET /api/staff/completions`、`GET /api/staff/completions/[id]`、
> `POST /api/staff/completions/[id]/approve`、`POST /api/staff/completions/[id]/reject`），
> 因此它们属 **CURRENT**。
>
> **下表不是第二份清单**——**条数的唯一真值源是 §2.11 的门禁**（客服端 25 条见
> `tests/staff.test.mjs`，打手端 **8** 条见 `tests/companion.test.mjs` 的 `COMPANION_API_MANIFEST`）。
> 保留这张表是为了记录这五条的**契约形状**（Guard / Service / 语义），
> 它是本文件里唯一一处写出「哪条路由归哪个服务模块」的地方；**增删路由时改的是清单数组，
> 不是这张表**。§3.1 能直接删表，是因为那四条打手路由在 §2.11 里已逐条列出。
>
> 本节剩下的 TARGET 只有最后一条（封禁回池时作废 pending），见下方标注。

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/companion/orders/[id]/completion` | `requireCompanion` | `companionCompletions` | 当前实际打手在 `serving` 提交截图 + 5~50 字说明 |
| GET | `/api/staff/completions` | `requireStaff` | `staffCompletions` | 待审列表 |
| GET | `/api/staff/completions/[id]` | `requireStaff` | `staffCompletions` | 详情 |
| POST | `/api/staff/completions/[id]/approve` | `requireStaff` | `staffCompletions` | 人工通过 → Order `completed`；**不读请求体** |
| POST | `/api/staff/completions/[id]/reject` | `requireStaff` | `staffCompletions` | 驳回 → Order 保持 `serving`；允许重新提交；**读 `reviewNote` 且必填** |

**已确认约束：**

- 同一订单同时最多 **1 份 `pending`**；已有 pending 时重复提交必须拒绝/幂等，不创建第二份。
- 自动审核配置默认 **10 分钟**，后台可修改。
- 每次 submission 进入 pending 时冻结 `autoApprovalMinutesSnapshot` 与 `autoApprovalDeadlineAt`；后台之后改配置不追溯改变该份材料。
- rejected 后重新提交时重新读取当前配置并重新计时。
- `sweepCompletionAutoApprovals(at)`（P0-8 落地名，同步、幂等）只在：仍 pending、Order 仍 serving、deadline 已到、无投诉/有效售后阻塞、尚未被人工处理时自动通过。它挂在读取路径上做惰性物化（与 `sweepExpiredDispatches` 同形），真实 Scheduler 上线后必须复用**同一个**函数。
- 自动通过与客服通过都产生 `Order.status = completed`，但必须记录审核来源为 System，**不得伪装成 Staff**。
- **TARGET（P0-9）：** Companion 被封禁/移除导致订单回池时，其旧 pending CompletionSubmission 必须先作废并退出自动审核资格。⚠️ 实现时注意 `applyCompletionReview` **不校验起始状态**，且「同一订单最多一份 pending」的索引只在它内部清除——见 §2.8 的已记录边界。
- 人工通过、自动通过、人工驳回、封禁作废之间必须并发安全；先成功的一方决定事实，后续动作安全失败/no-op。

## 3.3 用户退款：未服务直接全额退款，已服务进入售后

**按 Order 状态分流，`paid` / `accepted` 已于 P0-12 落地（CURRENT），`serving` / `completed` 的售后链路仍是 TARGET：**

| Order.status | 行为 | 状态 |
|---|---|---|
| `paid` | 直接全额退款成功；不需要客服/管理员审批 | ✅ **CURRENT**（P0-12） |
| `accepted` | 直接全额退款成功；打手收益为 0，不生成 Earning；通知已接单打手；终态保留 `actualCompanionId` 历史事实 | ✅ **CURRENT**（P0-12） |
| `serving` | 创建退款申请 → 客服调查 → 管理员最终决定资金 | ✅ **CURRENT**（P0-13）：按比例退款、责任归属认定、Earning 冲回全部落地；退款时还没有收益的单（护航中）在**结算时补记**冲回（D9） |
| `completed` | 仅在本单 `complaintDeadlineAt` 前按投诉/售后规则处理 | 🟡 **同上** |
| `refunded` | 不允许再次退款，幂等返回既有结果或业务拒绝 | ✅ **CURRENT** |

### ⚠️ 与原文的一处**有意偏离**（P0-12，2026-09-24）

本节原文要求「**复用 CURRENT `POST /api/orders/[id]/refunds` 作为用户退款入口，不新增第二套 Refund 系统**」。
P0-12 落地时**新增了一个路由** `POST /api/orders/[id]/direct-refund`，因此必须说明清楚：

- **没有**新增第二套 Refund 系统：仓储、状态机、`applyOrderRefund` 原语、通知设施**全部复用**，
  零新增 Repository / Mock Store / `RefundStatus`；
- 分出独立路由的理由是**两条路回答两个不同的问题**：一条是「**审不审**这笔申请」（写
  `RefundRequest` 的状态与审核人，请求体里有原因 / 说明 / 凭证 / 幂等键，订单一动不动），
  一条是「**当场把这一单退掉**」（没有申请、没有审核人、没有请求体，订单立刻 `refunded`）。
  合成一个接口就只能靠「请求体里有没有 `reasonKey`」来分辨意图——那是把「走哪条业务路径」
  变成一个**可被伪造的字段**；
- 两条路的**订单状态集合不相交**（`REFUNDABLE_ORDER_STATUSES` = `serving` / `completed`；
  `DIRECT_REFUNDABLE_ORDER_STATUSES` = `paid` / `accepted`），因此**不存在**同一张单两条路都能走的情形。
  这条互斥由**集合本身**保证，并有断言钉住（`tests/refunds.test.mjs`）；
- 权限依据：`01-requirements/用户权限表.md:448` 明文「**客服不得把「未开始服务直接退款」强行转成人工审批**」，
  因此让这两档走人工审核**本身**就是违规的——两条路**必须**分开。

**核对方式**：本节的每一条都可在 `lib/constants/refunds.ts`（两个状态集合）、
`lib/data/directRefundTransaction.ts`（直退伪事务）、`lib/data/adminRefundTransaction.ts`（审核那条，**一字未改**）
与 `tests/directRefund.test.mjs`（21 条）中逐条对照。

## 3.4 平台生命周期配置

`/api/admin/platform-config` 继续复用，**不新增第二个平台配置系统**。四个字段**均已实现**（P0-1 / P0-8 / P0-9 / P1-2），全部按同一条**快照**规则：

| 字段 | 默认 / 区间 | 进入哪一阶段时冻结 | 冻结落点 |
|---|---|---|---|
| `exclusivePoolTimeoutMinutes`（P1-2） | 10 / 1~1440 | 派单进入 `exclusive` | `Dispatch.exclusiveTimeoutMinutesSnapshot` + `exclusiveDeadlineAt` |
| `publicPoolTimeoutMinutes` | 60 / 1~1440 | 派单进入 `public`（**每次**进入都重新冻结） | `Dispatch.publicTimeoutMinutesSnapshot` + `publicDeadlineAt` |
| `completionAutoApprovalMinutes` | 10 / 1~1440 | 完成材料进入 `pending` | `CompletionSubmission.autoApprovalMinutesSnapshot` + `autoApprovalDeadlineAt` |
| `complaintWindowMinutes` | 1440 / 60~10080 | 订单进入 `completed` | `Order.complaintWindowMinutesSnapshot` + `complaintDeadlineAt` |

口径：**`PlatformConfig` 是未来生命周期事件的模板；对象上已经生成的 snapshot / deadline 才是历史事实。** 因此

- 任何「按当前配置重算旧对象截止时间」的实现都是缺陷（等于把已经承诺给用户的规则事后改掉）；
- 禁止批量改写旧快照、禁止用配置覆盖历史生命周期事实；
- PATCH 只带要改的字段（不是整份替换），必须走既有 Admin 守卫、校验、审计与平台配置事务（`lib/data/adminPlatformConfigTransaction.ts`，**唯一**写入口）；修改配置只影响**此后**进入对应阶段的对象。

**TARGET — NOT IMPLEMENTED（V0.3）**：以上快照目前只活在内存 store 里，进程重启即丢。迁移到真实 DB 时，快照字段必须与对象同表持久化（见 `database-schema.md` §迁移要求）。

## 3.5 Companion 封禁 / 移除的订单联动

**复用 CURRENT 管理端 Companion disable/remove 动作，不新增“封禁订单”第二套接口。TARGET 事务副作用：**

- 当前打手存在 `accepted` / `serving` 订单时，解除当前履约并重新进入 public；
- 通知用户；
- 若有其 pending CompletionSubmission，先作废并退出自动审核资格；
- 记录最小退出历史；
- 封禁动作本身不自动退款。

## 3.6 客服直接换人（P0 最小实现）

产品权限已确认：**客服可以直接执行换人，不需要管理员批准，且不设置固定换人次数上限；退款资金仍由管理员最终决定。**

为避免提前引入复杂 Assignment 聚合，P0 技术映射采用“解除当前履约 → 回 public → 由新打手重新接单”的最小路径，并保留最小退出历史。客服动作的最终 URL/DTO 在对应 Round 按现有 `staff` 路由命名冻结后写入 manifest；**在真实路由出现前不得把猜测路径登记为 CURRENT。**

## 3.7 Earning / Settlement

**状态：CURRENT（P0-9 落地）。**

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/earnings` | `requireCompanion` | `companionEarnings` | 打手收益列表 + 汇总（冻结 / 可提现；只读） |

**已确认目标语义（P0-9 全部落地）：**

- Order completed → 为当时实际履约打手生成 frozen Earning，金额取订单 `companionBaseIncome` 快照；
- 解冻时点不再硬编码 `completedAt + 48h`，而是消费本单冻结的 `complaintDeadlineAt`；
- deadline 到达且无投诉/售后冻结原因后 `frozen → available`；
  > ⚠️ **P0-15 补齐：这里不止两条。** 完整判据是**三条同时成立**——
  > ① `availableAt` 已到（`isEarningMatured`）② 无结算阻塞（`!isCompletionAutoApprovalBlocked`）
  > ③ **净额未被冲光**（`!isEarningFullyReversed`）。第 ③ 条是 P0-15 加的：
  > 退款批准后收益**停在 `frozen`**，它不会再解冻，所以时间这条永远不会替它放行。
  > 唯一真值源见 `lib/data/earningTransaction.ts` 的 `sweepMaturedEarnings`。
- `sweepMaturedEarnings(now)` 同步、幂等、可重复调用；Scheduler 必须复用它；
- 提现、自动罚款、余额桶细节仍按 TBD 处理。

**实现要点（可据此核对，落点在 `lib/data/earningTransaction.ts` 与 `lib/services/companionEarnings.ts`）：**

- **结算只有一个入口**：`settleOrderCompletion()` 一次写完「订单 → completed + 冻结 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt` + 生成 frozen Earning」。P0-8 的两条完成路径（客服人工通过、System 到期自动通过）都只调用它，不允许任何一处自己再算一次 deadline 或再建一条收益；
- **金额不重算**：`incomeAmount` 直接搬 `Order.companionBaseIncome`（下单时的分账快照），不查商品现价、不查当前分账比例；
- **`availableAt` = 本单 `complaintDeadlineAt`**，不另加一次分钟数；
- **不追溯**：P0-9 之前已完成的历史订单**不回填**窗口与收益（回填等于用今天的配置去改历史订单，或用历史 `completedAt` 凭空造出一笔「早该解冻」的钱）；
- **接口只读**：`GET` 是唯一导出方法，收益写入没有 HTTP 入口；
- **DTO 隐私**：打手收益 DTO 不含 `clubNetIncome` / `companionId` / `reversedAmount` / `fineAmount` / `withdrawnAt`。
  > ⛔ **上面这行里的 `reversedAmount` 已经不成立**（P0-13 起含，见 `lib/types/earning.ts:226`
  > 「⚠️ **P0-13 起含 `reversedAmount`**」）。它不再是一个「恒为初始值」的字段：
  > 一笔被冲回的收益若只给原金额，打手会以为那笔钱还能全提，而页面上一句解释都没有，
  > 所以原值 / 冲回额 / 净额三个数一起给。
  > **其余四个字段的排除今天仍然成立**（`clubNetIncome` / `companionId` / `fineAmount` / `withdrawnAt`）。

## 3.8 计划存在但本次不提前实现

- 优惠券正式核销、B/A/S 并发、提现、管理员余额调整/会费批扣账本细节等继续按各自后续需求处理。
- 完整 AfterSalesCase 聚合不是 P0 必需条件；P0 可复用现有 Complaint / Refund + 最小回池动作，禁止为了“模型漂亮”先造复杂系统。

# 第四部分：TBD — DO NOT INVENT

**以下接口/能力既未实现，规则也未确认。禁止自行设计。**

| 能力 | 状态 |
|---|---|
| **提现 API** | **TBD — DO NOT INVENT**。入口、审核流程、打款渠道、最小金额全部未定 |
| **自动罚款 / 余额扣减 API** | **TBD — DO NOT INVENT**。accepted 主动取消当前 P0 明确不处罚；管理员人工余额调整/会费批扣仅确认业务需要，账本/API 细节未冻结 |
| **结算 / 对账 API** | **TBD — DO NOT INVENT** |
| **复杂 Replacement / Assignment 聚合 API** | **TBD — DO NOT INVENT**。P0 已确认客服直接换人、次数不限，并采用最小“回 public + 退出历史”路径；复杂指定改派/统一 Assignment 模型仍未确认 |
| **用户封禁 API** | **TBD — DO NOT INVENT** |
| **打手侧统一「操作史」查询 API** | **TBD — DO NOT INVENT**（计划 R7） |
| **「服务异常」触发与售后区** | **TBD — DO NOT INVENT**（计划 R4） |
| **「非普通投诉通道」** | **TBD — DO NOT INVENT**（计划 R5） |
| ~~**管理端优惠券模板管理 API**~~ | ✅ **已实现（`P1-6`，2026-09-30）——本行已作废，不再是缺口。** 六个模板路由见 §12.9（列表 / 新建 / 详情 / 编辑 / 启用 / 停用），三条发券路由一并补录在同处。<br>📌 **本行原文写的「NOT IMPLEMENTED / DO NOT INVENT / `ADMIN_NAV_ITEMS` 无对应条目」在 `P1-6` 交付后已与源码相反**，保留删除线只为让此前读过它的人找得到出处。<br>⚠️ **该行当初列出的四项「未冻结的规则」已由 `P1-6/01-prompt.md` §1–§7 全部冻结并实现**：字段清单（§2 六字段）、权限粒度（Admin only，读也是）、审计（复用既有 `AdminAudit`，四个动作）、追溯口径（§4 不追溯 + §5 两层语义）。<br>⚠️ **当初那条「已经定死的边界」依然有效，且 `P1-6` 没有推翻它**：**`Coupon.enabled` 只决定「当前」能否核销，不追溯已经发出去的 `CouponClaim.snapshot`**——判定仍由 `resolveCouponClaimGate()` 这**一个**前置函数实现，账户页与结算页**共用**；`P1-6` 的编辑事务只写 `Coupon`，一个字节都不碰 `CouponClaim`（`tests/adminCouponTemplates.test.mjs` 的 §4 三组端到端用例钉住）。<br>📌 登记来源：`docs/03-dev/rounds/P1-4/04-acceptance.md` §八 8.3；交付记录见 `docs/03-dev/rounds/P1-6/`。**本轮状态 `AWAITING_ACCEPTANCE`，尚未 `DONE`。** |
