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

---

# 第一部分：CURRENT 逻辑实体

## 概览

**23 个 Mock store，23 个仓储。** 统一挂载方式：`lib/data/mockStore.ts` 的 `getMockStore<T>(name, create)`，
挂在 `globalThis.__youmuMockStore__` 上（`PREFIX` 前缀）。

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

- **当前（只有全额退款）**：`refundedAmount === actualPaidAmount`。
- 管理员批准退款时**必须**把 `actualPaidAmount` 写入 `refundedAmount`。
  **P0-5.5 已落地**：金额取自**被修改的那张订单**（`order.actualPaidAmount`），
  不取退款申请上的 `amount` 快照。曾经的缺陷说明见 §9。
- **未来部分退款上线后**，它扩展为**累计**退款金额。
- **⚠️ 部分退款本身不得自动把 `Order.status` 改成 `refunded`。**
  `Order.status === "refunded"` 的正式含义是：**该订单已经全额退款。**

**⚠️ 状态机：已实现（P0-5.5）**：
`lib/constants/orders.ts:83` 的 `ORDER_TRANSITIONS` + `:100` 的 `canTransitionOrder`
（`allowedOrderActions` 未做，本轮范围外）。`Order` 至此不再缺少声明式状态机。
**转移表本身已由产品负责人正式确认**（2026-09-19），逐行内容见 T3，本轮按原值落地、一字未改。
**⚠️ 本轮只交付中央定义，不接入任何写入路径**：`applyOrderAccepted` / `applyOrderRefund` 行为不变，也没有新增调用点。

**⚠️ 当前运行时的真实迁移只有三条**：`paid → accepted → refunded`。
`accepted → serving`（P0-6）与 `serving → completed`（P0-7）**尚未实现**；
`serving` / `completed` 目前**只存在于种子数据**，`lib/data/` 里没有任何地方写过它们。

**订单写入点（CURRENT，恰好两处）**，都在 `lib/data/mockPaymentRepository.ts`：

| 函数 | 位置 | 写入 |
|---|---|---|
| `applyOrderAccepted` | `:213`（写 `:224`） | `status: "accepted"` |
| `applyOrderRefund` | `:251`（写 `:275`） | `status: "refunded"` |

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
| 关键字段 | `id`、`orderId`、`state`、`exclusiveCompanionId`、`exclusiveEnteredAt`、`exclusiveDeadlineAt` |

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

**⚠️ 新增 P0-6 / P0-7 / P0-8 的通知事件时，幂等键必须是可推导的**（如 `orderId` + 事件类型），
**不得照抄随机 UUID 方案**。见第三部分。

---

## 9. RefundRequest（退款）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/refund.ts` — `RefundRequest`(:33)、`RefundStatus`(:22)、`RefundReasonKey`(:25) |
| 仓储 | `lib/data/refundRepository.ts` → `mockRefundRepository` |
| Mock Store | `"refund"` → `{ refunds: Map; refundIdByKey: Map<"${userId}:${key}", id>; refundIdByOrder: Map<orderId, id> }` |
| 主键 | `id`；另有 `refundNo` |
| 状态 | `"pending"` \| `"reviewing"` \| `"approved"` \| `"rejected"` \| `"cancelled"` |
| 关键字段 | `id`、`refundNo`、`userId`、`orderId`、`status`、`amount`、`reasonKey`、`reasonLabel`、`description`、`evidence[]`、`createdAt`、`updatedAt`、`reviewingAt`、`reviewedAt` |

**唯一索引**：`refundIdByOrder` —— **一单一申请**。
**状态机**：`ADMIN_REFUND_TRANSITIONS`（`lib/constants/adminRefunds.ts:153-159`）：

```
pending    → [reviewing, approved, rejected]
reviewing  → [approved, rejected]
approved   → []
rejected   → []
cancelled  → []
```

**⚠️ 退款有独立状态机，与 `OrderStatus` 无关。**
**唯一例外**：审核通过会联动把订单置为 `refunded`（`adminRefundTransaction.ts:247`）。

**⚠️ 曾经确认的缺陷（产品负责人裁定：修 Bug，不隐藏字段）——已于 P0-5.5 修复**：
`adminRefundTransaction.ts` 调用 `applyOrderRefund` 时**省略了第三个参数**，导致订单被置为 `refunded` 但 **`refundedAmount` 为 0**。
- **正式规则**：管理员批准退款时，**必须**把 `order.actualPaidAmount` 作为实际退款金额写入 `refundedAmount`。
- **修复结果**：`adminRefundTransaction.ts:247` 现显式传 `order.actualPaidAmount`（订单字段，非申请上的 `amount` 快照）；
  `applyOrderRefund` 对已 `refunded` 的订单短路返回 `changed: false`，因此重复批准不重复累计、不刷新 `refundedAt`。
- **当前阶段仍然只有「拒绝 / 全额退款」两种审批结果**，部分退款尚未实现。
- **回归测试要求**：管理员全额退款后，**同时**断言 `Order.status === "refunded"` **且** `refundedAmount === actualPaidAmount`。**不得再出现「已退款但退款金额为 0」。**

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

**⚠️ 消费累计目前按订单状态过滤**（`CONSUMPTION_ORDER_STATUS`）。
**TARGET（NOT IMPLEMENTED）**：P0-9 会改为「按实付在支付成功时累计，退款按实退金额扣减」——
即 `Σ max(0, actualPaidAmount − refundedAmount)`，并删除 `CONSUMPTION_ORDER_STATUS`。

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
| 关键字段 | `publicPoolTimeoutMinutes`、`updatedAt`、`updatedByAdminId` |

**⚠️ 单例且恒不为 null**：没有记录时用预置值，而不是让每个调用方处理「还没有配置」——
那会让「参数缺失」变成一条到处都要判的空值路径。

**⚠️ 改配置不动历史订单**：订单进入需要计时的环节时把自己那一刻的参数值冻结成快照。

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

**以下领域已被规划文档明确确认，但当前代码中不存在。**

## T1. CompletionSubmission（完成材料）—— P0-7

```ts
export type CompletionSubmissionStatus = "pending" | "approved" | "rejected";

export type CompletionSubmission = {
  id: string;
  orderId: string;
  companionId: string;
  evidenceNames: string[];
  summary: string;            // 5~50 字
  status: CompletionSubmissionStatus;
  submittedAt: string;
  reviewedByStaffId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
};
```

**已确认的业务语义**：

- 只有 `serving` 状态的订单可提交，且只有当前打手可提交。
- **审核驳回 → `Order` 保持 `serving`，可再次提交**（新记录，旧的保留为历史）。
- 审核通过 → 订单变 `completed`。
- 计划新增 `"completion"` store 名，以及 `AdminAuditTargetType` 的 `"completion"`、
  `AdminAuditAction` 的 `"completion.approve"` / `"completion.reject"`。

**⚠️ 尚未实现，且计划中未包含 UI 页面**——打手端「进行中的订单」页面尚未定义。见 `api-contract.md` §3.1。

**⚠️ 不要自行补齐字段。** 以上是规划文档已确认的部分，未列出的字段（如是否要多个附件、是否要驳回次数上限）**属于 TBD**。

## T2. Earning / Settlement（打手收益）—— P0-8

```ts
export type EarningStatus = "frozen" | "available" | "withdrawn" | "reversed";

export type Earning = {
  id: string;
  orderId: string;
  companionId: string;
  incomeAmount: number;      // 来自订单快照
  status: EarningStatus;
  frozenAt: string;
  availableAt: string | null; // 冻结到期 = 订单完成时刻 + 48h
  withdrawnAt: string | null;
  reversedAmount: number;    // 冲正累计（部分退款）
  fineAmount: number;        // ⚠️ 恒为 0，本轮无扣款操作
};
```

**已确认的业务语义**：

- 订单完成 → 生成一条 `frozen` Earning，`incomeAmount` **等于订单的 `companionBaseIncome` 快照**（不重算）。
- `availableAt = 完成时刻 + 48h`。
- `fineAmount` **恒为 0**，且仓储里**没有任何可以减少 `incomeAmount` 的方法**。
- **本批次不提供提现。** 收益只推进到 `available` 为止。
- `sweepMaturedEarnings()` **同步、幂等、可重复调用**；后台调度器必须复用它。
- 资金四类：总收入 = Σ`incomeAmount`；冻结 = Σ`status==="frozen"`；可提现 = Σ`status==="available"`；**罚款 = 恒 0**。

**⚠️ 幂等键必须是 `orderId`（或 `orderId` + 事件类型）**，不得照抄通知的随机 UUID 方案。

## T3. Order 状态机表 —— `lib/constants/orders.ts`（**P0-5.5 已实现**）

**CURRENT**：`ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]>` + `canTransitionOrder`
（`lib/constants/orders.ts:83` / `:100`），形态与 `lib/constants/adminRefunds.ts:153-166` 一致。
`allowedOrderActions` **未做**，不在本轮范围内。

### 转移表 —— **已由产品负责人正式确认**（2026-09-19），逐行即为最终内容

```ts
Order 主状态固定为：

paid      -> accepted | refunded
accepted  -> serving  | refunded
serving   -> completed | refunded
completed -> refunded
refunded  -> []
```

**⚠️ 这张表只表达「这种状态迁移在结构上是否允许」，它不能代替具体领域 Guard。**

以下三种迁移虽然结构上允许，但**仍必须**通过各自的业务校验：

| 迁移 | 状态机之外**仍然必须**满足的条件 |
|---|---|
| `paid → accepted` | Dispatch、deadline、接单资格、并发等条件（见 `acceptDispatch` 的原子区段） |
| `serving → completed` | 完成材料**已提交且客服审核通过**（P0-7） |
| `completed → refunded` | **只能通过合法的投诉 / 售后 / 退款流程进入**——不得因为状态机允许就提供任意按钮 |

**⚠️ 与部分退款的关系（已确认）**：
`Order.status = "refunded"` 表达**该订单已经全额退款**。
未来实现部分退款时，**部分退款本身不得自动把 `Order.status` 改成 `refunded`**。

**落地形态**：`Record<OrderStatus, readonly OrderStatus[]>` + 派生 `canTransitionOrder` / `allowedOrderActions`，
形态照抄 `lib/constants/adminRefunds.ts:153-166`。
**P0-5.5 已落地前两者（Round `P0-5.5`）；`allowedOrderActions` 尚无需求，不属本轮。**

## T4. AfterSalesCase（售后）—— P1-2 / P1-4

**已确认**：`OrderStatus` **不含**售后状态。售后是**独立实体**，P0 阶段不产生（超时自动退款不进售后）。
**⚠️ 结构未定义**——属 TBD，见第三部分。

---

# 第三部分：TBD — DO NOT INVENT

**以下领域既未实现，规则也未确认。禁止自行设计任何结构、字段或约束。**

| 领域 | 状态 |
|---|---|
| **Withdrawal（提现）** | **TBD — DO NOT INVENT**。入口、审核流程、打款渠道、最小金额、与 Earning 的关系全部未定 |
| **Penalty / 罚款** | **TBD — DO NOT INVENT**。`Earning.fineAmount` 恒为 0，已知「本轮无扣款操作」，但**未来是否有、怎么扣、扣到哪**未定 |
| **User Ban（用户封禁）** | **TBD — DO NOT INVENT**。全仓无对应实体 |
| **Replacement / Assignment（换人 / 改派）** | **TBD — DO NOT INVENT**。全仓无对应实体。⚠️ 与 `Dispatch.exclusiveCompanionId` 的关系未定 |
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

**⚠️ 新增实体（Earning / CompletionSubmission）的幂等键必须从一开始就设计成可推导的**（如 `orderId`），
**不得**沿用通知的随机 UUID + 冲突重试方案。

## C3. 跨实体写入必须保证一致性

| 不变量 | 当前位置 | 迁移要求 |
|---|---|---|
| **`actualCompanionId` 与接单人必须一致** | `applyOrderAccepted` + `applyDispatchAccepted` 在同一原子区段 | **必须同一事务** |
| **Payment / Order / Dispatch 创建必须一致** | `confirmPaymentRequest` 的原子区段内回调 `buildOrderFromRequest`，随后 `createDispatchForOrder` | **必须同一事务**（含派单创建） |
| **退款审核通过 → 订单置 `refunded`** | `adminRefundTransaction.approveRefund` | **必须同一事务** |
| **完成审核通过 → 订单置 `completed` + 建立 Earning + 通知 + 审计** | TARGET（P0-7） | **必须同一事务** |
| **申请通过 → 建护航记录 + 发资格 + 审计** | `adminCompanionTransaction` | **必须同一事务** |

## C4. deadline 必须持久化

**`Dispatch.exclusiveDeadlineAt` 目前只是内存里的一个 ISO 字符串，且推进是惰性的**（有读才清扫）。

**迁移要求**：deadline 必须持久化，且**不得**依赖「有人读取」来推进。

**⚠️ 生产阻塞项 TD-1**：`sweepExpiredDispatches(now)` / `sweepMaturedEarnings(now)`
目前只在有人读取时被调用。**真实生产不能依赖这一点**——恶意用户静置订单即可让超时退款永不发生、打手收益永不解冻。

**必须在真实支付上线前解决。**

## C5. 调度器必须复用同一个 domain service（硬约束）

接入后台定时调度器时，调度器**必须**调用**同一套**已经存在的同步、幂等、可重复调用的业务入口：

```
sweepExpiredDispatches(now)
sweepMaturedEarnings(now)     ← TARGET，随 P0-8 落地
```

**严禁**在调度器里另写一套超时退款逻辑——那会让两条路径的金额与状态判定迟早分叉。

## C6. 历史金额快照不可被配置变更覆盖

**已冻结的快照字段**（写在订单上，不得随配置变化重算）：

```
originalAmount  couponDiscountAmount  actualPaidAmount
companionRateSnapshot  companionBaseIncome  clubNetIncome
```

**⚠️ `companionRateSnapshot` 来自商品当时的 `companionRateBp`。** 改商品配置**不影响历史订单**。
**⚠️ `PlatformConfig.publicPoolTimeoutMinutes` 同理**——订单进入计时环节时冻结自己那一刻的值。

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
`Math.floor` 的取整点只有一处（`resolveCompanionBaseIncome`）。

## C10. 当前**不是**约束的（不要把它们升级成规范）

- ❌ 表名 / 字段名 / 主键类型（当前用可读字符串 id，未来是否用自增或 UUID **未定**）
- ❌ index 设计（除 C2 列出的唯一约束外）
- ❌ FK cascade 行为
- ❌ 分表 / 分区
- ❌ 读写分离
- ❌ 缓存层

**以上全部属于实现期决策，需先确认数据库与 ORM 选型。**
