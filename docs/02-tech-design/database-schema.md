# Logical Data Model & Future Database Constraints

> ⚠️ **本文件现在不是 SQL Schema 设计文档。**
>
> **当前项目没有数据库，也没有 ORM。** 全部数据在进程内存里，dev server 重启即清空（这是预期行为）。
>
> 因此本文件只描述：
> 1. **CURRENT** —— 当前真实的逻辑实体与关系（可从 `lib/types/`、`lib/data/`、`lib/mocks/fixtures/` 验证）；
> 2. **TARGET / TBD** —— 已确认但未实现、以及未确认的领域；
> 3. **Future DB Migration Constraints** —— 迁移到真实数据库时**已经可以确定**的约束。
>
> **本文件不设计 SQL 类型、不设计表名、不设计 FK cascade、不设计 index。**
> **数据库选型（PostgreSQL / MySQL）与 ORM 选型（Prisma / Drizzle）均未确认，禁止自行选定。**

> **2026-09-23 需求重校准说明**：第一部分 CURRENT 继续描述当前源码；第二部分 TARGET 已按需求 V0.3 更新。旧状态机、固定 48h 结算与“客服是唯一完成审核来源”等只能作为 CURRENT/历史事实，不能继续当作未来最终规则。

---

# 第一部分：CURRENT 逻辑实体

## 概览

**26 个 Mock store，26 个仓储。** 统一挂载方式：`lib/data/mockStore.ts` 的 `getMockStore<T>(name, create)`，
挂在 `globalThis.__youmuMockStore__` 上（`PREFIX` 前缀）。

**CURRENT（P0-9 更新）**：`earning`（打手收益）是第 26 个域。
它的特别之处是**没有种子数据**：记录只由完成结算事务写入
（见 §T2），且 P0-9 之前已完成的历史订单**刻意不回填**。

**为什么挂 `globalThis`**：dev 模式热更新会重新执行模块，若存在模块作用域里，每次改文件都会清空联调数据。
挂到 `globalThis` 后，同一 Node 进程内始终是同一个 store。

**预置数据的统一约定**：预置数据在**建仓时**写入**同一个** Map，与运行时新建的数据走同一条查询路径。
**禁止**为预置数据开旁路列表——否则「新数据立刻出现在列表里」这件事验证不了。

---

## 1. User

| 项 | 值 |
|---|---|
| 类型 | `lib/types/user.ts` — `User`(:13)、`UserProfile`(:25) |
| 仓储 | `lib/data/userRepository.ts` → `mockUserRepository` |
| Mock Store | `"user"` → `{ users: Map<string, UserRecord> }` |
| 主键 | `id`（如 `u-1001`） |
| 关键字段 | `id`、`displayId`、`nickname`、`avatarUrl`、`bio` |
| 真值源 | `userRepository`。`/api/auth/mock-login` 与「我的」页共用同一份数据 |

**重要关系**：一名用户可能同时是**老板**与**打手**（`Companion.userId` 指回 User）。
「我的」页与打手工作台读的是同一个 User 记录。

---

## 2. Qualification（用户资格）

| 项 | 值 |
|---|---|
| 类型 | `lib/data/qualificationRepository.ts` — `UserQualificationRecord`(:30) |
| 仓储 | `lib/data/qualificationRepository.ts` → `mockQualificationRepository` |
| Mock Store | `"qualification"` → `{ qualifications: Map<"${userId}:${role}", UserQualificationRecord> }` |
| 主键 | 复合键 `${userId}:${role}` |
| 关键字段 | `userId`、`role`（当前只有 `"companion"`）、`companionId`、`applicationId`、`grantedAt`、`grantedByAdminId` |

**重要设计**：用**列表**而不是单个字段（`listQualificationsByUser`），是为了让「多角色」在读取侧就是成立的——
将来加第二种资格，调用方不需要改签名。

⚠️ **`consumer`（老板）不在这个表里**——它是每个用户的**默认身份**，不需要发放。

---

## 3. Companion（护航 / 陪玩）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/companion.ts` — `Companion`(:34) |
| 仓储 | `lib/data/companionRepository.ts` → `mockCompanionRepository` |
| Mock Store | `"companion"` → `{ companions: Map<string, Companion>; companionIdByUser: Map<userId, companionId> }` |
| 主键 | `id` |
| 关键字段 | `id`、`userId`、`applicationId`、`displayName`、`avatarUrl`、`rankLabel`、`intro`、`gameIds[]`、`regions[]`、`serviceTags[]`、`available`、`unavailableReason`、`enabled`、`removedAt`、`completedOrderCount`、`rating`、`sortOrder`、内嵌 `reviews[]` |

**唯一索引**：`companionIdByUser` —— **一名用户最多关联一条有效护航**。
⚠️ 移除后索引要删掉，否则这位用户再被审核通过时会被自己的历史记录挡住。

**⚠️ 三个状态字段语义不同，不要合并**：

| 字段 | 含义 | 改动来源 |
|---|---|---|
| `enabled` | 资格是否在架 | 后台 `enable` / `disable` |
| `available` | **当前是否允许接新订单** | 后台 `pause` / `resume` |
| `removedAt` | 软删除时间 | 后台 `remove` |

`isCompanionListed` = `enabled && removedAt === null`（`lib/constants/companions.ts:183`）
`isCompanionAcceptingOrders` = `isCompanionListed && available`（`:215`）

---

## 4. CompanionApplication（入驻申请）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/companionApplication.ts` — `CompanionApplication`(:45)；`CompanionApplicationStatus`(:32) |
| 仓储 | `lib/data/companionApplicationRepository.ts` → `mockCompanionApplicationRepository` |
| Mock Store | `"companionApplication"` → `{ applications; applicationIdByUser: Map<userId, id>; applicationIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `id`；另有 `applicationNo` |
| 关键字段 | `id`、`applicationNo`、`userId`、`displayName`、`gameIds[]`、`regions[]`、`serviceTags[]`、`experience`、`introduction`、`contactNote`、`evidence[]`、`status` |

**状态机**：`ADMIN_APPLICATION_TRANSITIONS`（`lib/constants/adminApplications.ts:113`）
**唯一索引**：`applicationIdByUser` —— **一个人最多一条申请**。
**幂等索引**：`applicationIdByKey`。

---

## 5. Catalog —— GameRecord / CategoryRecord / CatalogProductRecord

| 项 | 值 |
|---|---|
| 类型 | `lib/types/catalog.ts`（`GameRecord`、`CategoryRecord`）；`lib/types/product.ts`（`CatalogProductRecord`(:121)、`ProductSpec`） |
| 仓储 | `lib/data/catalogRepository.ts` → `mockCatalogRepository` |
| Mock Store | `"catalog"` → `{ games: Map; categories: Map; products: Map }` |
| 主键 | 各自 `id` |
| 真值源 | **全站只有这一份目录**。首页 / 分类页 / 详情 / 结算 / 后台读的都是它 |

**关系**：`CategoryRecord.gameId` → GameRecord；`CatalogProductRecord.gameId` / `categoryId` → Game / Category。
`categoryId` 可以为 `null`（不进入任何类目列表，仅供调试直链）。

**ProductRecord 关键字段**：`id`、`title`、`subtitle`、`coverUrl`、`gameId`、`categoryId`、`tags[]`、
`detailText`、`detailImages[]`、`sortOrder`、`recommended`、`status`（`"on"` / `"off"`）、
`monthlySales`、`gameTag`、**`companionRateBp`**、`createdAt`、`updatedAt`、`removedAt`。

**⚠️ `companionRateBp` 是分账比例（整数基点，8000 = 80%）**，单位刻意不是 `0.8`——与钱有关的一切都用整数。
界面上的百分比文本在 `toProductDraft()`（`lib/constants/shareRatio.ts`）换算。

**⚠️ 规格（规格）尚未独立成表**：`ProductSpec` 目前内嵌在商品里（`id` / `name` / `price`）。
**TBD — DO NOT INVENT**：是否拆表、拆分后 `specId` 的外键约束如何，未确认。

**软删除**：`removedAt`。移除**不删记录**——用户看过的内容事后要能回答「当时是什么」。

---

## 6. PaymentRequest / Payment / Order —— ⚠️ 三者同属一个仓储

| 项 | 值 |
|---|---|
| 类型 | `lib/types/payment.ts`（`PaymentRequest`(:82)、`Payment`(:111)、`PaymentStatus`(:11)）；`lib/types/order.ts`（`Order`(:58)、`OrderStatus`(:35)） |
| 仓储 | `lib/data/paymentRepository.ts` → `mockPaymentRepository` |
| Mock Store | `"payment"` → `{ paymentRequests: Map; orders: Map; payments: Map; requestIdByKey: Map<"${userId}:${key}", id> }` |

### 6.1 PaymentRequest

主键 `id`；幂等索引 `requestIdByKey`（`${userId}:${idempotencyKey}`）。
状态：`pending` → `success` / `failed` / `cancelled`。
关键字段：`id`、`userId`、`idempotencyKey`、`status`、`createdAt`、`confirmedAt`、
`itemsAmount`、`addonsAmount`、`totalAmount`、`companionRateSnapshot`、`orderId`、`snapshot`。

### 6.2 Order

主键 `id`；另有 `orderNo`。

**`OrderStatus` = `"paid" | "accepted" | "serving" | "completed" | "refunded"`**

**关键字段**：

| 分组 | 字段 |
|---|---|
| 身份 | `id`、`orderNo`、`userId`、`status` |
| 时间 | `createdAt`、`paidAt`、`acceptedAt`、`servingAt`、`completedAt`、`refundedAt` |
| 商品快照 | `productId`、`productTitle`、`productCoverUrl`、`specId`、`specName`、`unitPrice`、`quantity` |
| 履约信息 | `gameName`、`region`、`gameAccountId`、`remark`、`addons[]` |
| **金额域** | `itemsAmount`、`addonsAmount`、`totalAmount`、`originalAmount`、`couponDiscountAmount`、`actualPaidAmount`、**`companionRateSnapshot`**、`companionBaseIncome`、`clubNetIncome`、`refundedAmount` |
| 履约人 | `actualCompanionId`、`companion`（`OrderCompanionSnapshot`） |

**⚠️ 金额域全部在下单那一刻冻结为快照。** 之后改商品配置不影响历史订单。
**⚠️ `Order.companion` 快照只反映实际接单人**（计划 R10：是否同时保留指定打手，**TBD**）。

**`refundedAmount` 的语义 —— 已由产品负责人正式定义（2026-09-19）**：

> `refundedAmount` 表示**该订单累计实际已经退还给用户的金额**。

- **P0-13 起它是真正的累计值**（不再只是「未来会扩展成累计」）：
  每一次批准把它加上**本次**退款额，因此部分退款下 `refundedAmount < actualPaidAmount` 是正常的，
  而 `refundedAmount === actualPaidAmount` 恰恰是「全额退款」的定义。
- 管理员批准退款时**必须**显式传本次退款额，由 `applyOrderRefund` 累计写入。
  **P0-5.5 已落地**：金额取自**被修改的那张订单**的冻结快照（`order.actualPaidAmount` × 比例），
  不取退款申请上的 `amount` 快照。曾经的缺陷说明见 §9。
- **⚠️ 部分退款本身不得自动把 `Order.status` 改成 `refunded`。**
  `Order.status === "refunded"` 的正式含义是：**该订单已经全额退款。**
  **只有累计退满才转**，判据单点在 `lib/constants/refunds.ts` 的 `isFullyRefunded`。

**⚠️ 状态机：已实现（P0-5.5）**：
`lib/constants/orders.ts:83` 的 `ORDER_TRANSITIONS` + `:100` 的 `canTransitionOrder`
（`allowedOrderActions` 未做，本轮范围外）。`Order` 至此不再缺少声明式状态机。
**转移表本身已由产品负责人正式确认**（2026-09-19），逐行内容见 T3，本轮按原值落地、一字未改。
**⚠️ 本轮只交付中央定义，不接入任何写入路径**：`applyOrderAccepted` / `applyOrderRefund` 行为不变，也没有新增调用点。

**⚠️ 当前运行时的真实迁移**分两类，**别把它们混成一张表**：

**（一）由订单生命周期动作产生，共四条**：
`paid → accepted`（打手接单）/ `accepted → paid`（P0-6 打手主动取消接单 + 回公共池）/
`accepted → serving`（P0-7 打手开始服务）/ `paid → refunded`（未开始服务直接全额退款）。

**（二）由退款路径到达，三条**：`accepted → refunded` / `serving → refunded` / `completed → refunded`。
这三条**不经过状态机的动作入口**，而是管理端批准退款申请时由
`lib/data/adminRefundTransaction.ts` 调 `applyOrderRefund` 写入——**该写入器只看「是不是已经 `refunded`」，不校验起始状态**
（`REFUNDABLE_ORDER_STATUSES` = `paid / accepted / serving / completed`，见 `lib/constants/refunds.ts:107`；
`tests/refunds.test.mjs` 与 `tests/adminRefunds.test.mjs` 都跑过这几条）。因此**「退款只可能发生在 `paid`」是错的**。

**尚未实现**：`serving → paid`（封禁回池 / 客服换人，批次明确不做）。
（`serving → completed` **已于 P0-8 落地**，入口是完成材料的通过——人工 approve 与 System 自动通过
两个来源共用同一条业务路径，写入器是 `applyOrderCompletion`。）
⚠️ **不要**照 `ORDER_TRANSITIONS` 逐行对齐上面这一类——中央状态表是**结构许可**，
它允许而运行时仍无入口的边（`serving → paid`）正需要这里分开写。
入口清单以 `docs/02-tech-design/api-contract.md` §8 的 Companion API 清单为准（`orders/**` 下导出 `POST` 的路由恰好三个）。

**TARGET — NOT IMPLEMENTED（2026-09-23）**：结构状态机需扩为 `accepted → paid`、`serving → paid` 的回池路径；对应当前履约绑定在回池时解除，历史由最小退出记录保存。`accepted` 终态直接退款则**保留** `actualCompanionId` 作为历史事实。具体见 T3。

**订单写入点（CURRENT，恰好五处）**，都在 `lib/data/mockPaymentRepository.ts`。
五个都是**同步**写入器，只负责写、不判断这次迁移合不合法（合法性由调用方的伪事务在同一个同步区段里判定）：

| 函数 | 位置 | 写入 | 入口 |
|---|---|---|---|
| `applyOrderAccepted` | `:222`（写 `:241`） | `status: "accepted"` | 打手接单（P0-5 `acceptDispatch`） |
| `applyOrderAcceptanceReleased` | `:273`（写 `:290`） | `status: "paid"` | 打手主动取消接单（P0-6 `cancelAcceptedOrder`） |
| `applyOrderServing` | `:321`（写 `:341`） | `status: "serving"` + `servingAt` | 打手开始服务（P0-7 `startCompanionOrder`） |
| `applyOrderCompletion` | `:373`（写 `:393`） | `status: "completed"` + `completedAt` | 完成材料通过——人工 approve 与 System 自动通过**共用**（P0-8） |
| `applyOrderRefund` | `:412`（写 `:442`） | `status: "refunded"` | 退款（既有） |

⚠️ **新增状态写入必须落在这里**，不得把 `status` 直接写在 `lib/services/` 或路由里——
否则同一张 `Order.status` 就有了两个写入口，违反 `architecture-rules.md` 的唯一真值源。
P0-8 的「完成材料审核通过 → `serving → completed`」已照 `applyOrderServing` 的形状落地为第五个同步写入器
（`Order` 与 `CompletionSubmission` 的一致性由调用方的伪事务在同一同步区段内保证：
`lib/data/completionTransaction.ts` 的 `approveCompletion` 与 `sweepCompletionAutoApprovals`）。

⚠️ **`completedAt` 用 `order.completedAt ?? at` 写入**，不是直接赋值——重复调用不刷新既成事实的时刻
（与 `servingAt` / `refundedAt` 同一写法）。P0-9 的 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt`
冻结**已加在这个写入器里**（`applyOrderCompletion` 的第三个入参 `complaintWindowMinutes`），
因为它正是「订单进入 completed」这一个时刻——见上面 §T3.1。

> 📌 **字段名是 `complaintWindowMinutesSnapshot`**（2026-09-24 更正，reviewer `m4`）。
> 本文件与本段曾写作 `complaintWindowSnapshot`，与产品裁定的名字、实现、
> `lib/types/order.ts` 都不一致。⚠️ `docs/03-dev/rounds/cmd_p0-9.md` 与
> `P0-9/01-prompt.md` 里的旧名**不改**——那两份是原始开发指令的**逐字档案**，按协议原样保存。

**⚠️ 订单初值 `status: "paid"` 不在 `lib/data/`**，而在 `lib/services/checkout.ts:316` 的 `buildOrderFromRequest`。

### 6.3 关系

```
PaymentRequest ──(1:1，支付成功后)──> Order ──(1:1)──> Dispatch
                                       │
                                       ├──(0..1)──> RefundRequest
                                       ├──(0..1)──> Review（一单一评）
                                       ├──(1:1)───> Conversation（订单会话）
                                       └──(0..n)──> Complaint
```

- **`PaymentRequest` 与 `Order` 是两次写**：`/api/orders/pay` 创建请求，`/api/payments/mock-confirm` 才产生订单。
  ⚠️ **两者的创建必须保证一致性**——见第三部分。
- `Order.actualCompanionId` 与 `Dispatch.exclusiveCompanionId` / 接单人**必须保持一致**——见第三部分。

---

## 7. Dispatch（派单）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/dispatch.ts` — `DispatchRecord`(:57)、`DispatchState`(:49) |
| 仓储 | `lib/data/dispatchRepository.ts` → `mockDispatchRepository` |
| Mock Store | `"dispatch"` → `{ dispatches: Map<string, DispatchRecord>; dispatchIdByOrder: Map<orderId, dispatchId> }` |
| 主键 | `id` |
| 状态 | `"exclusive"` \| `"public"` \| `"accepted"` \| `"timed_out"` |
| 关键字段 | `id`、`orderId`、`state`、`exclusiveCompanionId`、`exclusiveEnteredAt`、`exclusiveDeadlineAt`、`publicPoolEnteredAt`、`publicTimeoutMinutesSnapshot`、`publicDeadlineAt`、`acceptedByCompanionId` |

> ⚠️ **上表此前漏列了 public 侧三个字段**（`publicPoolEnteredAt` / `publicTimeoutMinutesSnapshot` /
> `publicDeadlineAt`）与 `acceptedByCompanionId`（P0-6.1 补全）。它们一直是真实字段，
> 只是没写进这一行；而 P0-6.1 的池子排序真值正是 `publicPoolEnteredAt`，
> 一份「查不到这个字段」的数据模型文档会让人以为排序键不存在。

**两组「进入时刻 + 到点时刻」**：`exclusiveEnteredAt` / `exclusiveDeadlineAt`（专属池）与
`publicPoolEnteredAt` / `publicDeadlineAt`（公共池）。**当前**用哪一组由 `state` 决定。

- 池子排序真值 = **当前池**的 `EnteredAt`（ASC，等待最久优先）；⚠️ 不是 `DeadlineAt`
  （`publicPoolTimeoutMinutes` 自 P0-1 起后台可配置，改过后两者顺序会不同），
  也不是 `Order.createdAt`。见 `api-contract.md` §8.1。
- `EnteredAt` 会在**每一次进入该池**时被重写（首次进公共池 / 专属超时转入 / P0-6 取消回池），
  因此它是「这一次等待的开始」，不是「订单的创建时间」。
- `exclusiveCompanionId`（用户**指定**的人）与 `acceptedByCompanionId`（**实际**接单的人）
  **永不互相覆盖**：前者是用户的选择，后者是既成事实。

**唯一索引**：`dispatchIdByOrder` —— **一个订单同时只可能有一条派单记录**。

**⚠️ deadline 目前**不持久化到任何外部存储**——它就是这个 Map 里的一个 ISO 字符串。
惰性推进（有读才清扫），无定时器。见第三部分。

**唯一事务**：`lib/data/companionDispatchTransaction.ts`（`acceptDispatch` / `createDispatchForOrder` / `sweepExpiredDispatches` / `toDispatchProgress`）。

---

## 8. Notification（站内通知）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/notification.ts` — `Notification`(:20)、`NotificationInput`(:46)、`NotificationKind`(:18) |
| 仓储 | `lib/data/notificationRepository.ts` → `mockNotificationRepository` |
| Mock Store | `"notification"` → `{ notifications: Map<string, Notification> }` |
| 主键 | `id` |
| 关键字段 | `id`、`userId`、`kind`（`order` / `refund` / `complaint` / `dispatch` / `system`）、`title`、`summary`、`body`、`createdAt`、`readAt`、`href` |

**⚠️ 本模块的三条重要事实（都是风险，不是规范）**：

1. **`NotificationInput` 没有 `orderId` / `eventType` 字段。** 幂等目前**不靠 id**，靠**业务状态机**（`tests/dispatch.test.mjs:648` 锁定「重复清扫不得重复产生同一业务事件的通知」）。
2. **存在两条写入通道**：同步的 `appendNotification()`（在原子区段内）与异步的 `createNotificationForUser()`（`lib/services/notifications.ts:132`，**生产代码零调用方**，只被测试调用）。
3. **id 用随机 UUID + 冲突重试**（`newNotificationId()`，`mockNotificationRepository.ts:59`），且 `appendNotification` **遇到 id 冲突直接抛错、拒绝覆盖**。

**⚠️ 后续新增订单取消 / 开始服务 / Completion / Earning 等生命周期通知时，幂等键必须是可推导的**（如 `orderId` + 事件类型），
**不得照抄随机 UUID 方案**。见第三部分。

---

## 9. RefundRequest（退款）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/refund.ts` — `RefundRequest`(:83)、`RefundDecision`(:53)、`RefundStatus`(:24)、`RefundResponsibility`(:41)、`RefundReasonKey`(:27) |
| 仓储 | `lib/data/refundRepository.ts` → `mockRefundRepository` |
| Mock Store | `"refund"` → `{ refunds: Map; refundIdByKey: Map<"${userId}:${key}", id>; refundIdsByOrder: Map<orderId, id[]> }` |
| 主键 | `id`；另有 `refundNo` |
| 状态 | `"pending"` \| `"reviewing"` \| `"approved"` \| `"rejected"` \| `"cancelled"` |
| 关键字段 | `id`、`refundNo`、`userId`、`orderId`、`status`、**`amount`（申请时的实付快照）**、**`decision`（本次退款的资金决策，未决策为 `null`）**、`reasonKey`、`reasonLabel`、`description`、`evidence[]`、`createdAt`、`updatedAt`、`reviewingAt`、`reviewedAt`、`reviewedBy`、`reviewedByRole`、`reviewedByName` |

### 9.1 `RefundDecision` —— 一次退款的资金决策（P0-13）

`RefundRequest.decision` 是**值对象**（不单独建表），六项字段回答「这一次退了多少、这笔钱谁承担」+
决策人与时刻：

| 字段 | 类型 | 说明 |
|---|---|---|
| `refundRateBp` | `number` | 本次退款比例（基点 `1..10000`）。**管理员输入的就是比例，不是金额** |
| `refundAmount` | `number` | 分。`floor(Order.actualPaidAmount × refundRateBp / 10000)` |
| `responsibility` | `"platform"` \| `"companion"` \| `"shared"` | 资金责任归属，由**管理员**认定 |
| `companionLiabilityRateBp` | `number \| null` | **只有 `shared` 有值**，其余两种为 `null`（给了就是 400，不静默忽略） |
| `companionReversalAmount` | `number` | 分。**本次**从打手收益冲回的金额（见 §T2.1） |
| `platformBorneAmount` | `number` | 分。`refundAmount − companionReversalAmount`，**用减法构造**，**允许为负** |
| `decidedBy` / `decidedAt` | `string` | 决策管理员 id 与时刻 |

**⚠️ `amount` 与 `decidedAmount` 是两个数。** `amount` 是**申请创建时**订单实付的快照，
回答「这一单本来涉及多少钱」；实退金额是 `decision.refundAmount`。部分退款下两者**不再相等**，
因此必须分开存、分开给，不能拿一个去顶另一个。
对外（列表 / 详情）由 `decidedAmount` 暴露实退额；**六项决策字段只给管理端**（客服 / 用户只拿 `decidedAmount`）。

### 9.2 索引

**`refundIdsByOrder`：`orderId → 申请 id 列表`，P0-13 起由单值改为多值。**

⚠️ 它**不再**表达「一单一申请」。部分退款要求同一单能退第二次（D10），因此：
- 索引回答的是「这一单有哪些申请」，**按创建先后排列**；
- 「同一时刻最多一条进行中」由 `isActiveRefundStatus` **单独**判定——**已通过 / 已拒绝 / 已撤销的记录不再挡**新的申请。
  ⚠️ 判据必须**逐条看过列表里的每一条**，只看最新那一条会放过「前一笔已驳回、后一笔仍在审核」；
- 未来数据库上它是**普通索引**，另加一条「同一 `orderId` 同一时刻最多一条 `pending` / `reviewing`」的部分唯一索引。

**状态机**：`ADMIN_REFUND_TRANSITIONS`（`lib/constants/adminRefunds.ts`）：

```
pending    → [reviewing, approved, rejected]
reviewing  → [approved, rejected]
approved   → []
rejected   → []
cancelled  → []
```

**⚠️ 退款有独立状态机，与 `OrderStatus` 无关。**
**唯一例外**：审核通过会**累计**退款金额，**只有累计退满才**把订单置为 `refunded`（`adminRefundTransaction.ts:460`）。
**部分退款不改订单状态**——订单按原进度继续履约，打手的收益也照常走它自己的生命周期。

**⚠️ 曾经确认的缺陷（产品负责人裁定：修 Bug，不隐藏字段）——已于 P0-5.5 修复，P0-13 后仍然有效**：
`adminRefundTransaction.ts` 调用 `applyOrderRefund` 时**省略了第三个参数**，导致订单被置为 `refunded` 但 **`refundedAmount` 为 0**。
- **正式规则**：管理员批准退款时**必须**显式传本次退款额，由 `applyOrderRefund` **累计**写入 `refundedAmount`
  （P0-13 起该参数的语义由「覆盖成多少」改为「**这一次退多少**」）。
- **修复结果**：`adminRefundTransaction.ts:460` 现显式传 `decision.refundAmount`（服务端按订单快照算出来的数，
  非申请上的 `amount` 快照）；`applyOrderRefund` 对**已退满**（`status === "refunded"` **或**
  `refundedAmount >= actualPaidAmount`）的订单短路返回 `changed: false`，因此重复批准不重复累计、不刷新 `refundedAt`。
  ⚠️ 只看状态是不够的：部分退款**不改状态**，一张已退满的订单若停在原状态上，状态判据会放它再退一次。
- **金额闸**：累计 `refundedAmount + 本次 <= actualPaidAmount`，越界是 400。
- **回归测试要求**：管理员全额退款后，**同时**断言 `Order.status === "refunded"` **且** `refundedAmount === actualPaidAmount`。
  **不得再出现「已退款但退款金额为 0」。** 部分退款的对应断言在 `tests/refundMoneyChain.test.mjs`。

**写入点恰好 3 个业务入口**，审核态迁移收敛到**单一写入器** `applyRefundReview`（`mockRefundRepository.ts:163`）：

| 入口 | 位置 | 写入 |
|---|---|---|
| 创建 | `lib/services/refunds.ts:298` | `status: "pending"` |
| 用户撤销 | `mockRefundRepository.ts:124`（`cancelRefund`） | `status: "cancelled"` |
| 审核迁移 | `mockRefundRepository.ts:183`（`applyRefundReview`） | `reviewing` / `approved` / `rejected` |

---

## 10. Complaint（投诉）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/complaint.ts` — `Complaint`(:26)、`ComplaintStatus`(:15)、`ComplaintTypeKey`(:18) |
| 仓储 | `lib/data/complaintRepository.ts` → `mockComplaintRepository` |
| Mock Store | `"complaint"` → `{ complaints: Map; complaintIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `id`；另有 `complaintNo` |
| 状态 | `"pending"` \| `"processing"` \| `"resolved"` \| `"closed"` |
| 关键字段 | `id`、`complaintNo`、`userId`、`orderId`（**可为 null**）、`orderNo`、`status`、`typeKey`、`typeLabel`、`description`、`evidence[]`、`contact`、`createdAt`、`updatedAt`、`processingAt` |

**状态机**：`ADMIN_COMPLAINT_TRANSITIONS`（`lib/constants/adminComplaints.ts:192-200`）：

```
pending    → [processing, closed]
processing → [resolved, closed]
resolved   → []
closed     → []
```

**⚠️ 投诉处理不改订单、不改退款。** 管理端与客服端共用同一条伪事务 `applyAdminComplaintIntent`。
**⚠️ `orderId` 可为 null** —— 平台服务类投诉不关联订单。

---

## 11. Conversation / Message（会话与消息）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/message.ts` — `OrderMessage`(:22)、`OrderConversationRecord`(:51)、`StaffReadRecord`(:72) |
| 仓储 | `lib/data/messageRepository.ts` → `mockMessageRepository` |
| Mock Store | `"message"` → `{ conversations: Map<orderId, record>; messages: Map; messageIdsByOrder: Map<orderId, id[]>; messageIdByKey: Map<"${orderId}:${senderId}:${key}", id>; staffReads: Map<"${orderId}:${staffId}", record> }` |
| 主键 | `OrderConversationRecord`：`orderId`；`OrderMessage`：`id` |
| 关键字段（消息） | `id`、`orderId`、`userId`、`senderId`、`senderRole`（`user` / `companion` / `customer_service`）、`senderName`、`senderAvatarUrl`、`body`、`createdAt` |

**唯一索引**：一个订单只有一个会话（`conversations` 的键就是 `orderId`）。

**⚠️ 两份独立的已读状态，刻意不合并**：

| 状态 | 位置 | 语义 |
|---|---|---|
| 用户侧已读 | `conversations[orderId].userLastReadAt` | 用户看到的未读角标 |
| 客服侧已读 | `staffReads["${orderId}:${staffId}"]` | 客服工作台的未读 |

键里带 `staffId`，因为两位客服同时值班时，一位读过的会话不该从另一位的工作台上消失。

---

## 12. Coupon / CouponClaim（优惠券与领取记录）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/coupon.ts` — `Coupon`(:45)、`CouponSnapshot`(:24)、`CouponClaim`(:63) |
| 仓储 | `lib/data/couponRepository.ts` → `mockCouponRepository` |
| Mock Store | `"coupon"` → `{ coupons: Map; claims: Map; claimIdByCoupon: Map<"${userId}:${couponId}", id>; claimIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `Coupon.id`、`CouponClaim.id` |

**⚠️ 两个唯一索引**：`claimIdByCoupon`（业务唯一键：同一用户同一券限领一次）与 `claimIdByKey`（通用幂等索引）。
**快照**：`CouponClaim.snapshot` 冻结券的展示信息（名称 / 形式 / 面额 / 门槛 / 有效期），使券定义变更不影响已领取的记录。

**⚠️ 优惠券成本规则（已冻结）**：成本**全部由俱乐部承担**，**不得**减少打手按商品原价算出的理论收入。
因此大额券会让 `clubNetIncome` 为负——**这是允许的业务事实**。

---

## 13. OrderReview（评价）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/review.ts` — `OrderReview`(:35)、`ReviewRating`(:21) |
| 仓储 | `lib/data/reviewRepository.ts` → `mockReviewRepository` |
| Mock Store | `"review"` → `{ reviews: Map; reviewIdByOrder: Map<"${userId}:${orderId}", id>; reviewIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `id` |
| 关键字段 | `id`、`userId`、`orderId`、`orderNo`、`rating`（1–5）、`content`、`evidence[]`、`createdAt`、`productTitle`、`productCoverUrl`、`specName`、`quantity`、`completedAt` |

**唯一索引**：`reviewIdByOrder` —— **一单一评**。
**⚠️ 注意**：`Companion.reviews[]` 是**内嵌在护航记录里的展示用评价**，与本实体的关系未在类型层声明。
**TBD — DO NOT INVENT**：两者是否最终统一为一份数据。

---

## 14. TipRecord（鸡腿 / 打赏记录）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/tip.ts` — `TipRecord`(:1)、`TipPaymentStatus` |
| 仓储 | `lib/data/tipRepository.ts` → `mockTipRepository` |
| Mock Store | `"tip"` → `{ tips: Map<string, TipRecord> }` |
| 主键 | `id` |

**⚠️ 本实体当前是只读的**——`TipRepository` 只有 `queryTips` 与 `countTipsByStatus` 两个查询方法，
没有创建方法。打赏的写入路径尚未建立。**TBD — DO NOT INVENT**：打赏是否走支付流程。

---

## 15. Suggestion（反馈与建议）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/suggestion.ts` — `Suggestion`、`SuggestionStatus`（`submitted` / `replied` / `closed`）、`SuggestionTypeKey` |
| 仓储 | `lib/data/suggestionRepository.ts` → `mockSuggestionRepository` |
| Mock Store | `"suggestion"` → `{ suggestions: Map; suggestionIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `id` |

---

## 16. ConsumptionLevel（消费等级）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/level.ts` — `ConsumptionLevel`、`ConsumptionPrivilege` |
| 仓储 | `lib/data/levelRepository.ts` → `mockLevelRepository`（**只有 `listLevels()`，只读**） |
| Mock Store | `"level"` → `{ levels: Map<string, ConsumptionLevel> }` |
| 关键字段 | `id`、`name`、`thresholdAmount`、`privileges[]`、`sortOrder`、`enabled`、`createdAt`、`updatedAt` |

**⚠️ 消费累计目前按订单状态过滤**（`CONSUMPTION_ORDER_STATUS`）：**已退款（`refunded`）的订单整单不计**，
其余按 `actualPaidAmount` 计入。**P0-9 时未落地**改成「按实退金额扣减」的 TARGET 形式
（`Σ max(0, actualPaidAmount − refundedAmount)`），该 TARGET **仍未实现**。

**⚠️ P0-13 起这里出现一个新的业务空白 —— TBD，禁止自行决定：**

部分退款**不改变订单状态**（订单仍是 `completed`），因此按当前口径，
一张「实付 100 元、已部分退 60 元」的订单在消费累计里仍然算 **100 元**。
这**可能**是对的（用户确实付过 100 元，「累计有效消费」按支付额算），
也**可能**是错的（用户实际只花了 40 元）。
⚠️ 两种解释都说得通，而它直接影响**消费等级**与**周期榜**，
因此必须由产品负责人裁定，**不得**按「哪个更合理」自行选一个。
裁定之前保持现状（不改代码），并把这一条记在 `rounds/P0-13/` 的遗留项里。

**TBD — DO NOT INVENT**：B/A/S 的 3/4/5 档门槛是**固定还是管理员可配**（计划 R6），P1-5 开工前必须定。

---

## 17. Agreement（协议）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/agreement.ts` — `Agreement`、`AgreementType`（`user` / `privacy` / `companion` / `platform` / `version`）、`AgreementSection` |
| 仓储 | `lib/data/agreementRepository.ts` → `mockAgreementRepository` |
| Mock Store | `"agreement"` → `{ agreements: Map<string, Agreement> }` |
| 关键字段 | `id`、`type`、`title`、`sections[]`（`heading` + `paragraphs[]`）、`version`、`updatedAt`、`enabled` |

**⚠️ 协议当前只能改，不能新建**（`app/api/admin/content/agreements` 没有 `POST`）。

---

## 18. Content —— 公告 / Banner / 快捷入口

| 项 | 值 |
|---|---|
| 类型 | `lib/types/content.ts` — `ContentAnnouncementRecord`(:105)、`ContentBannerRecord`(:115)、`QuickEntryRecord`(:124)，共有 `ManagedContentFields`(:88) |
| 仓储 | `lib/data/contentRepository.ts` → `mockContentRepository` |
| Mock Store | `"content"` → `{ announcements: Map; banners: Map; quickEntries: Map }` |
| 共有可管理字段 | `enabled`、`sortOrder`、`createdAt`、`updatedAt`、`removedAt` |

**⚠️ `ManagedContentFields` 抽出来是为了让「后台能改的字段」只有一处定义**——
否则迟早出现「公告能停用、Banner 不能」这种没有理由的差异。

**⚠️ `enabled`（停用，可逆）与 `removedAt`（软移除）不是一回事。**

**⚠️ `QuickEntryRecord.path` 写入前必须过 `validateSafePath()`**（`lib/constants/safePath.ts`），
仓储不替调用方校验，但事务层在写之前一定校验。

---

## 19. PlatformConfig（平台配置）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/platformConfig.ts` — `PlatformConfig`(:37) |
| 仓储 | `lib/data/platformConfigRepository.ts` → `mockPlatformConfigRepository` |
| Mock Store | `"platformConfig"` → `{ config: PlatformConfig }` |
| 主键 | **单例**（不是集合） |
| 关键字段 | `publicPoolTimeoutMinutes`（P0-1）、`completionAutoApprovalMinutes`（P0-8）、`complaintWindowMinutes`（P0-9）、`updatedAt`、`updatedByAdminId` |

**⚠️ 单例且恒不为 null**：没有记录时用预置值，而不是让每个调用方处理「还没有配置」——
那会让「参数缺失」变成一条到处都要判的空值路径。

**⚠️ 改配置不动历史订单**：订单进入需要计时的环节时把自己那一刻的参数值冻结成快照。

**CURRENT（P0-9 落地）**：三项参数都已可配置，且都遵循「进入对应生命周期阶段时冻结快照」的规则——
`publicPoolTimeoutMinutes`（订单进池时冻结到 `Dispatch.publicTimeoutMinutesSnapshot`）、
`completionAutoApprovalMinutes`（提交完成材料时冻结到 `CompletionSubmission.autoApprovalMinutesSnapshot`）、
`complaintWindowMinutes`（订单进入 completed 时冻结到 `Order.complaintWindowMinutesSnapshot`
并算出 `complaintDeadlineAt`）。三项的取值区间**不共用**：前两项 1~1440，投诉窗口 60~10080
（P0-9 `02-decisions.md` D17）。

**TARGET — NOT IMPLEMENTED（V0.3）**：同一个 PlatformConfig 继续作为唯一平台配置真值源，后续仍可扩展
（如 exclusive pool timeout）。新参数一律遵循上面同一条冻结规则；不得新建第二套配置实体。

---

## 20. AdminAccount / StaffAccount（后台账号）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/admin.ts`（`AdminAccount`、`AdminRole`）；`lib/types/staff.ts`（`StaffAccount`、`StaffRole`） |
| 仓储 | `lib/data/adminRepository.ts` → `mockAdminRepository`；`lib/data/staffRepository.ts` → `mockStaffRepository` |
| Mock Store | `"admin"` → `{ admins: Map }`；`"staff"` → `{ staff: Map }` |
| 主键 | 各自 `id`；均有 `username` |

**⚠️ 两套账号是刻意分开的**（不同 Cookie、不同仓储、不同开关）。

**⚠️ 当前无修改密码字段**——两个实体都没有 `password` / `passwordHash`。
**TBD — DO NOT INVENT**：真实认证方案的凭据存储方式。

---

## 21. AdminAuditEntry（管理操作审计）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/adminAudit.ts` — `AdminAuditEntry`(:170)、`AdminAuditAction`(:30)、`AdminAuditTargetType`(:126)、`AdminAuditSnapshot`(:162) |
| 仓储 | `lib/data/adminAuditRepository.ts` → `mockAdminAuditRepository` |
| Mock Store | `"adminAudit"` → `{ audits: Map<string, AdminAuditEntry>; auditIdByOperationId: Map<operationId, auditId> }` |
| 主键 | `id` |
| 关键字段 | `id`、`actorId`、`actorRole`、`actorName`、`action`、`targetType`、`targetId`、`before`、`after`、`operationId`、`createdAt` |

**⚠️ 幂等的落点是 `auditIdByOperationId`。** 同一个 `operationId` 第二次到达时，服务端靠这个索引认出「这件事已经做过了」，
于是**既不再写业务数据，也不再写第二条审计**。

**⚠️ 这是内存扫描，不是数据库唯一索引**——见第三部分。

**⚠️ 用 Map 而不是数组**：插入顺序即发生顺序，`listAudits` 直接按顺序读出。

**⚠️ D4 决策（已确认）**：打手自身的动作**不进 admin 审计**。
**D5（已确认）**：管理端 / 客服在打手域的动作**仍走既有 admin 审计**。

---

## 22. Favorite（收藏）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/favorite.ts` — `Favorite`(:1) |
| 仓储 | `lib/data/favoriteRepository.ts` → `mockFavoriteRepository` |
| Mock Store | `"favorite"` → `{ favorites: Map<"${userId}:${productId}", Favorite> }` |
| 主键 | **复合键** `${userId}:${productId}` |
| 关键字段 | `id`、`userId`、`productId`、`createdAt` |

**⚠️ 复合键本身就是「同一用户同一商品只有一条」的保证**——不靠额外校验。
⚠️ 预置数据重复收藏同一商品会在建仓时**抛错暴露**，而不是留到线上出现两条。

---

## 23. SupportEvidence（凭证，值对象）

出现在 `CompanionApplication.evidence[]`、`RefundRequest.evidence[]`、`Complaint.evidence[]`、
`OrderReview.evidence[]`、`Suggestion.evidence[]`。定义在 `lib/types/evidence.ts`。

**⚠️ 没有独立的 store**——它是内嵌值对象，不是实体。

---

# 第二部分：TARGET — NOT IMPLEMENTED

**以下领域已被规划文档明确确认，但当前代码中大部分尚不存在。**
⚠️ **本节并非全为「不存在」**：`T1`（CompletionSubmission）已于 P0-8 大部分落地、
`T2`（Earning / Settlement）已于 P0-9 落地、`T4`（CompanionReleaseRecord）已于 P0-6 部分落地
——这三节各自在标题下写明了「CURRENT / TARGET」的分界，
**请以各节自己的标注为准，不要以本节的标题为准**。

## T1. CompletionSubmission（完成材料）—— 部分实现

**CURRENT（P0-8 落地）**：本实体已实现（`lib/types/completion.ts`、
`lib/data/completionRepository.ts` → `mockCompletionRepository`、`lib/data/completionTransaction.ts`），
提交 / 人工通过 / 人工驳回 / 到期自动通过四条路径全部可运行。
**TARGET — NOT IMPLEMENTED**：`invalidated` 只有类型占位，**没有任何写入路径**——
封禁回池时作废旧 pending 属 P0-9，见 `api-contract.md` §3.2 末条。

```ts
export type CompletionSubmissionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "invalidated"; // 封禁/回池导致旧材料失效；P0-8 无写入路径，仅保留枚举兼容

export type CompletionSubmissionReviewSource = "staff" | "system" | null;

export type CompletionSubmission = {
  id: string;                          // `cs_${crypto.randomUUID()}`
  orderId: string;
  companionId: string;                 // 只来自 requireCompanion() 会话，不来自请求体
  evidence: SupportEvidence[];         // ⚠️ 落地为复用售后凭证约定（P0-8 D2），
                                       //    不是本表旧稿的 evidenceNames: string[]
  summary: string;                     // 5~50 字（按字符数，Emoji 算 1）
  status: CompletionSubmissionStatus;
  submittedAt: string;

  autoApprovalMinutesSnapshot: number; // 每次进入 pending 时冻结；默认配置 10 分钟
  autoApprovalDeadlineAt: string;

  reviewSource: CompletionSubmissionReviewSource;
  reviewedByStaffId: string | null;    // system 自动通过时必须为 null
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  invalidatedAt: string | null;
};
```

⚠️ **`evidenceNames` → `evidence` 是等价命名调整**：`SupportEvidence`（`lib/types/evidence.ts`）
是仓库既有的凭证结构（`id` / `url` 由服务端生成），复用它是为了不与退款 / 投诉的凭证约定分叉；
本表旧稿的 `evidenceNames: string[]` 只是同义草图。

**已确认业务语义：**

- 只有 `serving` 且操作人是当前 actualCompanion 才能提交。
- 同一订单同时最多 **1 份 pending**；Mock 仓储必须有等价约束，未来数据库使用 partial unique / 条件唯一语义保证。
- rejected 后允许新建下一份 submission；重新提交重新读取当前平台配置并重新计算 deadline。
- 平台配置默认自动审核 **10 分钟**；已经 pending 的 deadline 不被之后的配置修改追溯改变。
- staff approve → approved + Order completed；staff reject → rejected + Order 保持 serving。
- System 到 deadline 后，仅在仍 pending、Order 仍 serving、无投诉/有效售后阻塞时自动 approved + completed；`reviewSource = "system"`，不得伪造 staff 身份。
- Companion 被封禁/移除、或其他已确认回池动作使原履约失效时，属于旧打手的 pending submission 必须进入不可自动通过的失效终态（这里以 `invalidated` 表达）。
- 自动通过/人工通过/驳回/失效必须在同一业务事实竞争下并发安全。

> 字段名属于技术设计；若实现 Round 发现已有仓库命名更合适，可做等价命名调整，但不得改变上面的业务语义。

## T2. Earning / Settlement（打手收益）—— CURRENT（P0-9 落地）

```ts
export type EarningStatus = "frozen" | "available" | "withdrawn" | "reversed";

export type Earning = {
  id: string;
  orderId: string;
  companionId: string;
  incomeAmount: number;      // 来自订单快照
  status: EarningStatus;
  frozenAt: string;
  availableAt: string | null; // = 本单 complaintDeadlineAt，而不是写死 completed + 48h
  withdrawnAt: string | null;
  reversedAmount: number;
  fineAmount: number;        // 自动罚款规则仍未定义；accepted 主动取消当前 P0 不处罚
};
```

**CURRENT（P0-9 落地）**：`lib/types/earning.ts` 声明类型，
`lib/data/mockEarningRepository.ts` 是 Mock Store（`earning` 域，无种子数据），
**唯一写入者**是 `lib/data/earningTransaction.ts` 的两个同步函数：

- `settleOrderCompletion({ orderId, at })` —— 结算一次完成，同时写下「订单 completed + 投诉窗口快照 + 一条 frozen Earning」；
- `sweepMaturedEarnings(at)` —— 到期解冻，挂在读取路径上（与 `sweepCompletionAutoApprovals` 同一条惰性物化机制）。
  真实 Scheduler 上线后必须调用**同一个**函数，不是另写一套。

`withdrawn` / `reversed` 两个取值的写入路径：

- **`reversed` —— P0-13 起可达**：退款冲回累计到 `incomeAmount`（整笔冲销）时写入，
  见 `lib/data/mockEarningRepository.ts` 的 `applyEarningReversal`；
- `withdrawn` 仍然**只有类型占位、没有写入路径**（提现是 TBD，见 api-contract 第四部分）。
  ⚠️ 但它在 P0-13 之后**参与业务判定**：一笔已 `withdrawn` 的收益本轮**不做冲回**（D17），
  因此「没有写入路径」不等于「可以当它不存在」。

**已确认业务语义（P0-9 全部落地）：**

- 订单进入 completed（人工审核或系统自动审核）后，为当时实际履约打手生成一条 frozen Earning；`incomeAmount = Order.companionBaseIncome` 快照。
- Order completed 时冻结 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt`；Earning.availableAt 复用该 deadline。
- deadline 到达且无投诉/有效售后冻结原因后 `frozen → available`（阻塞判据与 P0-8 自动通过**共用** `isCompletionAutoApprovalBlocked` + `readOrderBlockingFacts`）。
- 平台之后修改投诉期不改变已 completed 订单的 deadline。
- 提现、自动罚款、管理员余额调整/会费批扣的账本细节仍不在本实体本轮强行定义。
- `sweepMaturedEarnings()` 同步、幂等、可重复调用；后台 Scheduler 必须复用它。
- **不追溯**：P0-9 之前已完成的历史订单不回填 Earning（那会用历史 `completedAt` 造出一笔「已经该解冻」的钱）。
- **无实际履约打手时不建记录**：没有 `actualCompanionId` 就没有收益可发，如实不建，而不是建一条 `companionId: ""` / 金额 0 的假记录。

### T2.1 退款冲回（P0-13 落地）

**不得修改原始 `Earning.incomeAmount`，不建立余额桶。**
退款通过**独立的冲回记录**表达；净额由服务端算好给出（`lib/types/earning.ts` 的 `CompanionEarningItem`）：

```
netAmount = incomeAmount − reversedAmount     // 即产品裁定里的 netAvailableAmount
```

| 规则 | 内容 |
|---|---|
| 累计字段 | `Earning.reversedAmount` **累加**（不是覆盖）。同一笔收益**允许被多次冲减**（Q2-d） |
| 不变式 | `0 <= reversedAmount <= incomeAmount`。**钳制发生在 `computeRefundDecisionAmounts`**（按「该单剩余可冲回额」），存储层的 `applyEarningReversal` 再夹一次作为最后一道护栏 |
| 状态规则 | `0 < reversedAmount < incomeAmount` → **留在原状态**（`frozen` 仍 `frozen`、`available` 仍 `available`）；**整笔冲完** → `reversed`。⚠️ 部分冲回**绝不能**把 `frozen` 变成 `available`——那等于用一次退款把冻结期提前结束 |
| 已提现 | 收益为 `withdrawn` 时本轮**不冲回**：`companionReversalAmount = 0`，多出来的部分由平台承担（D17，Q3 仍 DEFER） |
| 没有收益时 | 退款发生在 `serving`（尚未结算、还没有 Earning）时，冲回额**记在退款决策上**，待这一单将来结算时由 `settleOrderCompletion` **补记**（D9）。⚠️ 一次都不会结算的单（例如服务中被整单退掉）因此永远不产生冲回，这是正确的 |
| 明细 | 每一次冲回写**恰好一条** `EarningAdjustment`，以 `refundId` 为幂等键：一次退款决策最多冲一次（**重复扣打手的钱**比悬空状态严重得多） |

### T2.2 `EarningAdjustment`（收益调整明细）—— CURRENT（P0-13 落地）

```ts
export type EarningAdjustmentType = "refund_reversal";

export type EarningAdjustment = {
  id: string;            // adj_<uuid>
  earningId: string;
  orderId: string;
  refundId: string;      // 幂等键：一次退款最多一条冲回明细
  type: EarningAdjustmentType;
  amount: number;        // 分，恒为正
  responsibility: RefundResponsibility;
  createdAt: string;
  adminId: string;       // 做出决策的管理员
};
```

| 项 | 值 |
|---|---|
| 类型 | `lib/types/earning.ts` |
| 仓储 | `lib/data/earningRepository.ts` 的 `listAdjustmentsForEarning(earningId)` |
| Mock Store | `"earning"` → `{ adjustments: Map; adjustmentIdByRefund: Map<refundId, adjustmentId> }`（与 `earnings` / `earningIdByOrder` 同一域） |
| 写入 | `appendEarningAdjustment`（同步原语，**只负责写**）；判定与写入必须在同一段无 `await` 的原子区段里 |

**⚠️ 「读用总数、写用明细」：**
`Earning.reversedAmount` 是**读**的入口（页面、合计、列表都用它），
`EarningAdjustment` 是**审计**的入口（「这笔钱是哪一次退款冲掉的、谁批的」）。
因此两者**必须同段落库**——只写其中一个，这条关系就断了。
不变式 `reversedAmount === Σ adjustments.amount` 由 `tests/refundMoneyChain.test.mjs` 持续断言。

**⚠️ 它不等于「钱包 / 会计总账」。** 本轮只建这一种调整类型、只服务退款冲回；
完整的资金总账（提现、罚款、调整、会费批扣）仍未定义。

## T3. Order 状态机表 —— CURRENT 旧实现 + TARGET 新转移

**CURRENT**：P0-5.5 已实现 `ORDER_TRANSITIONS` + `canTransitionOrder`，但表内容仍是 2026-09-19 旧需求基线。它是源码事实，不再是未来“最终不可改”规则。

**TARGET — NOT IMPLEMENTED（2026-09-23）**：

```text
paid      -> accepted | refunded
accepted  -> paid | serving | refunded
serving   -> paid | completed | refunded
completed -> refunded
refunded  -> []
```

状态机之外必须满足的领域 Guard：

| 迁移 | 必须额外满足 |
|---|---|
| `paid → accepted` | Dispatch、deadline、接单资格、禁止自接等现有 Guard |
| `accepted → paid` | 当前 actualCompanion 主动取消（尚未 serving）或已确认的回池动作；记录最小退出历史、通知用户、重新建立 public deadline |
| `accepted → serving` | 当前 actualCompanion 显式开始服务；只写一次 servingAt |
| `accepted → refunded` | 用户未服务直接全额退款；打手收益 0、不建 Earning、通知打手；终态保留 actualCompanionId 历史事实 |
| `serving → paid` | 封禁/客服换人等已确认回池动作；若有旧 pending CompletionSubmission 必须先失效 |
| `serving → completed` | staff 人工 approve，或 System 满足自动审核 deadline + 无阻塞条件 |
| `serving/completed → refunded` | 只能通过合法投诉/售后/退款流程 |

`Order.status = "refunded"` 仍表达**已完成全额退款**；未来部分退款本身不得自动改成 refunded。

### T3.1 Order 的生命周期 deadline 字段 —— CURRENT（P0-9 落地）

两个字段**已实现**（`lib/types/order.ts`），进入 completed 时冻结：

```ts
complaintWindowMinutesSnapshot: number | null;
complaintDeadlineAt: string | null;
```

**CURRENT（P0-9 落地）**：

- 两者由 `lib/data/mockPaymentRepository.ts` 的 `applyOrderCompletion()` 在**同一个写入点**写下，
  `complaintDeadlineAt = completedAt + complaintWindowMinutesSnapshot` —— 这条等式是结构上的，
  不是靠两处各算一遍对齐的；Earning 的 `availableAt` 再**搬**这个值（不重新加分钟数）。
- 结算入口只有 `settleOrderCompletion()`（`lib/data/earningTransaction.ts`），
  P0-8 的两条完成路径（客服人工通过、System 自动通过）都只经它。
- **`null` 有两种含义**，都表示「没有窗口」，**不是**「已关闭」：
  ① 尚未 completed 的在途订单；② P0-9 之前就 completed 的历史订单（**刻意不回填**）。
  `isComplaintWindowClosed()` 对 `null` 返回 false，因此这两类订单的投诉入口与本轮之前完全一致。
- 平台配置后续变更不追溯修改历史订单：判定只看订单自己的 `complaintDeadlineAt`，从不读当前配置。
- 窗口取值 60 ~ 10080 分钟（默认 1440），见 §PlatformConfig 与本轮 `02-decisions.md` D17。

## T4. 最小 CompanionReleaseRecord（履约退出历史）—— 部分实现

**CURRENT（P0-6 落地）**：本实体与 `source = companion_cancel` 这一条路径**已实现**
（`lib/types/companionRelease.ts`、`lib/data/mockCompanionReleaseRepository.ts`，
写入者是 `lib/data/companionOrderTransaction.ts` 的原子区段）。
**TARGET — NOT IMPLEMENTED**：`companion_disabled`（封禁回池）与 `staff_reassign`（客服换人）
两个 `source` 取值只有类型占位，**没有任何写入路径**——它们是 §十四 的 out of scope 项。

P0 明确**不引入复杂 Assignment 聚合**，但回池后必须能回答“谁曾经负责、为什么退出、何时退出、谁触发”。最小逻辑实体：

```ts
export type CompanionReleaseSource =
  | "companion_cancel"
  | "companion_disabled"
  | "staff_reassign";

export type CompanionReleaseRecord = {
  id: string;
  orderId: string;
  companionId: string;
  source: CompanionReleaseSource;
  reason: string | null;       // companion_cancel 时必须非空
  actorId: string | null;      // 打手本人/管理员/客服；system 场景可空
  createdAt: string;
};
```

用途仅限追溯，不承载新的订单状态机：

- accepted 主动取消：写 release → 清当前履约绑定 → `accepted → paid` → Dispatch 回 public → 通知用户；当前 P0 不处罚。
- Companion 封禁 accepted/serving：写 release → 旧 pending completion 失效（如有）→ 清当前履约绑定 → Order 回 paid → public → 通知用户。
- 客服换人：允许直接执行且次数不限。P0 的技术映射有**两条**，都由 `P0-11` 实现并已人工裁定
  （见 `docs/03-dev/rounds/P0-11/02-decisions.md` D-Q2）：
  ① **回 public**——写 release → 清当前履约绑定 → Dispatch 回 public，由新打手正常 accept；
  ② **direct replace**——写 release → 清当前履约绑定 → 同一次同步事务内 `accepted → paid → accepted`，
  新 `actualCompanionId` / `acceptedAt` 指向本次接手，**新打手之后自行点击「开始服务」**。
  两条路径**都不需要管理员批准**，都只写 `CompanionReleaseRecord` 与既有 `Order` / `Dispatch` 字段，
  **不新增聚合、不新增字段、不扩 `OrderStatus`**。
- accepted 用户直接退款是**终态退款而不是回池**，因此保留 Order.actualCompanionId，不使用“清当前履约绑定”的语义。

## T5. AfterSales / Complaint 的 P0 边界

P0 **不要求先造完整 `AfterSalesCase` 新聚合**。可以复用现有 Complaint / Refund 体系 + 已确认的客服回池动作跑通：

- serving 用户退款 → 客服调查 → 管理员最终决定资金；
- completed 在 complaintDeadlineAt 前投诉/退款 → 同样走人工售后；
- 客服决定换人时可直接执行，不需管理员批准；没有固定换人次数上限。

完整 AfterSalesCase 实体与复杂 Assignment 仍可后置，不应为了模型完整阻塞 P0。

⚠️ **「指定新打手」不再属于这一句**：产品已裁定它进入 P0 并由 `P0-11` 实现为
**最小 direct-replace**（复用既有原语与字段，不建聚合）。它后置的只是
「完整的 Assignment / 指定改派**模型**」。裁定原文见
`docs/03-dev/rounds/P0-11/02-decisions.md` D-Q2。

# 第三部分：TBD — DO NOT INVENT

**以下领域既未实现，规则也未确认。禁止自行设计任何结构、字段或约束。**

| 领域 | 状态 |
|---|---|
| **Withdrawal（提现）** | **TBD — DO NOT INVENT**。入口、审核流程、打款渠道、最小金额、与 Earning 的关系全部未定 |
| **Penalty / 自动罚款** | **TBD — DO NOT INVENT**。accepted 主动取消当前 P0 已确认不处罚；管理员人工余额调整/会费批扣已确认“需要”，但余额桶、负余额、账本与失败补偿未定 |
| **User Ban（用户封禁）** | **TBD — DO NOT INVENT**。全仓无对应实体 |
| **复杂 Replacement / Assignment 聚合** | **TBD — DO NOT INVENT**（范围已收窄，见下）。P0 采用 T4 最小退出历史 + 回 public，并由 `P0-11` 追加一条**最小 direct-replace**（复用既有 `CompanionReleaseRecord` / `Order.actualCompanionId` / `Dispatch`，**不新增聚合、不新增字段**）。仍然禁止自行设计的是**完整的 Assignment / 指定改派模型**本身。客服换人权限与不限次数已确认；「指定新打手」这一动作的归属已由产品裁定为 P0（`P0-11/02-decisions.md` D-Q2），**因此本行不再覆盖它** |
| **AfterSalesCase 结构** | **TBD — DO NOT INVENT**（计划 R4：谁触发、什么条件、如何进入售后区） |
| **非普通投诉通道** | **TBD — DO NOT INVENT**（计划 R5） |
| **`ProductSpec` 是否拆表** | **TBD — DO NOT INVENT** |
| **`Companion.reviews[]` 与 `OrderReview` 是否统一** | **TBD — DO NOT INVENT** |
| **`TipRecord` 的写入路径** | **TBD — DO NOT INVENT**。当前仓储只读 |
| **`Order.companion` 是否保留指定打手** | **TBD — DO NOT INVENT**（计划 R10） |
| **打手侧统一「操作史」** | **TBD — DO NOT INVENT**（计划 R7） |
| **消费等级 B/A/S 的 3/4/5 是否可配** | **TBD — DO NOT INVENT**（计划 R6） |
| **数据库选型 / ORM 选型** | **TBD — DO NOT INVENT** |
| **真实认证的凭据存储** | **TBD — DO NOT INVENT**。当前两个账号实体都没有密码字段 |

---

# 第四部分：Future DB Migration Constraints

**以下是迁移到真实数据库时已经可以确定的约束。**
**不涉及选型、不涉及表名、不涉及具体 DDL。**

## C1. ⚠️ 最重要：伪事务必然失效，必须改为数据库事务

**当前全部一致性保证建立在一条 Mock 阶段才成立的前提上**：

> Node 单线程 + 原子区段内无 `await` ⇒ 请求串行化

**换成真实数据库后，每次查询都是 `await`，区段不再原子。**
所有 `lib/data/*Transaction.ts` 的「读—判断—写」必须改为**真正的数据库事务**。

**涉及的全部事务**：

```
adminRefundTransaction        adminComplaintTransaction      adminCatalogTransaction
adminCompanionTransaction     adminContentTransaction        adminAgreementTransaction
adminStaffTransaction         adminPlatformConfigTransaction  companionDispatchTransaction
mockPaymentRepository 的 confirmPaymentRequest
mockRefundRepository 的 applyRefundReview
mockComplaintRepository 的 applyComplaintStatus
```

**⚠️ 这也是「Mock → DB 最大迁移风险」的答案。** 它不是数据迁移问题，是并发模型问题。

## C2. 幂等业务键必须改为数据库唯一约束

**当前幂等靠内存索引扫描。** 迁移时必须落成 unique constraint：

| 当前内存索引 | 语义 | 迁移要求 |
|---|---|---|
| `auditIdByOperationId` | `operationId` 全局唯一 | **Admin operationId 未来不能继续依靠扫描内存** |
| `requestIdByKey` | `${userId}:${idempotencyKey}` | unique |
| `refundIdByKey` / `refundIdByOrder` | 幂等键 + **一单一申请** | 两条 unique |
| `complaintIdByKey` | `${userId}:${idempotencyKey}` | unique |
| `reviewIdByOrder` | **一单一评** | unique |
| `claimIdByCoupon` / `claimIdByKey` | 同券限领一次 + 通用幂等 | 两条 unique |
| `dispatchIdByOrder` | **一个订单一条派单** | unique |
| `companionIdByUser` | **一名用户最多一条有效护航** | ⚠️ **部分唯一索引**（仅未移除的行） |
| `applicationIdByUser` | **一个人最多一条申请** | ⚠️ 语义待确认是否部分唯一 |
| `messageIdByKey` | `${orderId}:${senderId}:${key}` | unique |
| TARGET `pendingCompletionIdByOrder`（等价实现） | **同一订单同时最多 1 个 pending CompletionSubmission** | partial/conditional unique |

**⚠️ 新增实体（Earning / CompletionSubmission）的幂等键必须从一开始就设计成可推导的**（如 `orderId`），
**不得**沿用通知的随机 UUID + 冲突重试方案。

## C3. 跨实体写入必须保证一致性

| 不变量 | 当前位置 | 迁移要求 |
|---|---|---|
| **`actualCompanionId` 与接单人必须一致** | `applyOrderAccepted` + `applyDispatchAccepted` 在同一原子区段 | **必须同一事务** |
| **Payment / Order / Dispatch 创建必须一致** | `confirmPaymentRequest` 的原子区段内回调 `buildOrderFromRequest`，随后 `createDispatchForOrder` | **必须同一事务**（含派单创建） |
| **退款审核通过 → 累计 `refundedAmount`（退满才置订单 `refunded`）+ Earning 冲回与明细 + 退满时关派单发通知 + 审计** | `adminRefundTransaction.approveRefund`（P0-13） | **必须同一事务**。⚠️ 收益冲回与 `EarningAdjustment` 明细**必须同段落库**——只写其中一个，「读用总数、审计用明细」这条关系就断了 |
| **订单结算 → 生成 Earning 时补记此前的退款冲回** | `earningTransaction.settleOrderCompletion` 的 `backfillRefundReversals`（P0-13 D9） | **必须同一事务**（与「建 Earning」同一段同步代码） |
| **完成材料人工/自动通过 → Order `completed` + Earning + 通知 + 审核来源** | TARGET | **必须同一事务**；自动通过不得伪装 staff |
| **accepted 主动取消 → release history + Order 回 paid + Dispatch public + 通知** | TARGET | **必须同一事务** |
| **Companion 封禁/客服换人 → pending completion 失效 + release history + Order 回 paid + Dispatch public + 通知** | TARGET | **必须同一事务** |
| **paid/accepted 直接退款 → Order refunded + refundedAmount + 通知；accepted 不建 Earning** | `directRefundTransaction`（P0-12） | **必须同一事务** |
| **申请通过 → 建护航记录 + 发资格 + 审计** | `adminCompanionTransaction` | **必须同一事务** |

## C4. deadline 必须持久化

**`Dispatch.exclusiveDeadlineAt` 目前只是内存里的一个 ISO 字符串，且推进是惰性的**（有读才清扫）。

**迁移要求**：所有 lifecycle deadline 必须持久化，且**不得**依赖「有人读取」来推进。V0.3 至少包括：Dispatch exclusive/public deadline、CompletionSubmission.autoApprovalDeadlineAt、Order.complaintDeadlineAt。

**⚠️ 生产阻塞项 TD-1**：`sweepExpiredDispatches(now)` / `sweepMaturedEarnings(now)`
目前只在有人读取时被调用。**真实生产不能依赖这一点**——恶意用户静置订单即可让超时退款永不发生、打手收益永不解冻。

**必须在真实支付上线前解决。**

## C5. 调度器必须复用同一个 domain service（硬约束）

接入后台定时调度器时，调度器**必须**调用**同一套**已经存在的同步、幂等、可重复调用的业务入口：

```
sweepExpiredDispatches(now)
sweepCompletionAutoApprovals(now)   ← TARGET
sweepMaturedEarnings(now)            ← TARGET
```

**严禁**在调度器里另写一套超时退款逻辑——那会让两条路径的金额与状态判定迟早分叉。

## C6. 历史金额快照不可被配置变更覆盖

**已冻结的快照字段**（写在订单上，不得随配置变化重算）：

```
originalAmount  couponDiscountAmount  actualPaidAmount
companionRateSnapshot  companionBaseIncome  clubNetIncome
```

**⚠️ `companionRateSnapshot` 来自商品当时的 `companionRateBp`。** 改商品配置**不影响历史订单**。
**⚠️ 生命周期配置同理**——public/exclusive timeout、Completion 自动审核时长、投诉窗口都必须在进入各自计时阶段时冻结 snapshot/deadline；已经进入阶段的历史事实不随后台配置修改漂移。

**⚠️ 迁移后不得引入「实时重算利润」的视图或触发器。**

## C7. 软删除语义必须保留

**全仓统一用 `removedAt`（`string | null`）软删除**，覆盖：`Companion` / `CompanionApplication`（通过状态）/
`CatalogProductRecord` / `CategoryRecord` / `ContentAnnouncementRecord` / `ContentBannerRecord` / `QuickEntryRecord` / `StaffAccount`。

**⚠️ 移除不删记录**——用户看过的内容事后要能回答「当时是什么」。

**⚠️ `enabled`（停用，可逆）与 `removedAt`（软移除）是两个不同概念，不得合并成一个 `isDeleted` 布尔。**

## C8. 时间统一为 ISO 8601 字符串

当前所有时间字段都是 `string`（ISO 8601），不是 `Date`。
**⚠️ 迁移时需决定**：是继续用字符串，还是改用数据库原生时间类型。
**⚠️ 时区策略未确认**——属 **TBD**。

## C9. 金额统一为整数「分」

**迁移时必须保持整数分**，不得改成浮点或数据库的 `DECIMAL` 后引入舍入差异。

**取整点（P0-13 起是两处，两处都一律向下）：**

| 取整点 | 位置 | 取整的是什么 |
|---|---|---|
| 下单时算打手分账基数 | `resolveCompanionBaseIncome` | `floor(分账基数 × 比例 / 10000)` |
| 退款决策算三个金额 | `computeRefundDecisionAmounts`（`lib/constants/refunds.ts`） | `floor`（退款额 / 冲回额）。**平台承担额不取整**，它由 `退款额 − 冲回额` 用**减法构造**——各自取整会让恒等式偶发差 1 分 |

⚠️ 取整**只在服务端**发生。客户端**不做金额算术**——管理端确认框**会显示预计金额**，
但它显示的是**服务端同一批纯函数**（`previewRefundDecisionAmounts()`）算出的结果，
客户端自己**没有任何算符**（`components/**` 里不出现金额运算）。见 `architecture-rules.md` §三 规则 9
与 `rounds/P0-13/02-decisions.md` §十一 D19（D15 原先的「确认框不预览金额」已被 D19 取代）。

## C10. 当前**不是**约束的（不要把它们升级成规范）

- ❌ 表名 / 字段名 / 主键类型（当前用可读字符串 id，未来是否用自增或 UUID **未定**）
- ❌ index 设计（除 C2 列出的唯一约束外）
- ❌ FK cascade 行为
- ❌ 分表 / 分区
- ❌ 读写分离
- ❌ 缓存层

**以上全部属于实现期决策，需先确认数据库与 ORM 选型。**
