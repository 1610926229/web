# Logical Data Model & Future Database Constraints

> ⚠️ **本文件描述的是逻辑数据模型，不是全量 SQL Schema。**
>
> **当前项目已在迁移中，但尚未迁完。** 绝大多数数据仍在进程内存里，dev server 重启即清空（这是预期行为）。**只有下面点名的少数实体**已经有真正的 PostgreSQL 表。
>
> 因此本文件只描述：
> 1. **CURRENT** —— 当前真实的逻辑实体与关系（可从 `lib/types/`、`lib/data/`、`lib/mocks/fixtures/` 验证）；
> 2. **TARGET / TBD** —— 已确认但未实现、以及未确认的领域；
> 3. **Future DB Migration Constraints** —— 迁移到真实数据库时**已经可以确定**的约束。
>
> **选型已裁定（PROD-1A）**：数据库 `PostgreSQL`，驱动 `node-postgres (pg)`，**不使用 ORM**，结构变更走**版本化 SQL 迁移文件**（`db/migrations/`）。裁定与理由见 `docs/03-dev/rounds/PROD-1A/02-decisions.md`、`tech-stack.md` §11.1。
>
> **已经有真实表结构的实体（仅此两个）：**
>
> | 实体 | 迁移文件 | 仓储实现 |
> |---|---|---|
> | `Favorite`（收藏） | `db/migrations/0001_favorites.sql` | `lib/data/pg/favoriteRepository.ts` |
> | `Suggestion`（反馈） | `db/migrations/0002_suggestions.sql` | `lib/data/pg/suggestionRepository.ts` |
>
> 这两个是 **PROD-1A 的竖切片**，选取标准是「不参与跨域资金事务、有真实读写、能验证唯一约束」。**其余实体仍未迁移**，本文件后续章节对它们仍然只描述逻辑模型。
>
> **⚠️ 对未迁移的实体，本文件依旧不设计 SQL 类型、表名、FK cascade 与 index。** 已迁移的两个例外，其真实 DDL 以 `db/migrations/*.sql` 为准，本文件不重复（避免两份真值源）。

> **2026-09-23 需求重校准说明**：第一部分 CURRENT 继续描述当前源码；第二部分 TARGET 已按需求 V0.3 更新。旧状态机、固定 48h 结算与“客服是唯一完成审核来源”等只能作为 CURRENT/历史事实，不能继续当作未来最终规则。

---

# 第一部分：CURRENT 逻辑实体

## 概览

**28 个 Mock store，28 个仓储。其中 `favorite` / `suggestion` 两个已另有 PostgreSQL 实现，其余 26 个仍只有 Mock 实现。**

统一挂载方式：`lib/data/mockStore.ts` 的 `getMockStore<T>(name, create)`，
挂在 `globalThis.__youmuMockStore__` 上（`PREFIX` 前缀）。

⚠️ **`favorite` 与 `suggestion` 的 Mock 实现并没有被删掉，仍然完整可用**——它们是
`DATA_SOURCE` 未设为 `postgres` 时的默认路径，也是契约对照测试（`tests/pgContract.test.mjs`）
的一半。**「已迁移」不等于「Mock 可以拆」**：在事务闭包完整之前，Mock 仍可能是 active datasource。

**CURRENT（P0-9 更新；计数已于 PROD-1A 校正）**：`earning`（打手收益）在 P0-9 时是第 26 个域，
其后 P1-5 加 `companionAccept`、P1-7 加 `companionService`，现为 28 个域。
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
| 关键字段 | `id`、`userId`、`applicationId`、`displayName`、`avatarUrl`、`rankLabel`、`intro`、`gameIds[]`、`regions[]`、`serviceTags[]`、`available`、`unavailableReason`、`enabled`、`removedAt`、`completedOrderCount`、`sortOrder` |

> ⚠️ **P1-8（`D17`）删掉了这里的三个字段**：`rating`、`reviewCount`、内嵌 `reviews[]`。
> 评分不是护航的属性，而是**读的时候从 `OrderReview` 的 `approved` 记录聚合出来的派生值**
> （口径见 §13.4）。实体上留着它们，就会出现「实体里的分数」与「评价算出来的分数」
> 两个真值，而两者只在没人改动评价时恰好相等。
> 公开 DTO 上仍然有 `rating` / `reviewCount` / `reviews`，但那是**每次读取现算**的，不落库。

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

- ⛔ **「累计」这个词在 P0-15 之后不再成立**（2026-09-28 指令 ①§一 / §九 正式覆盖）：
  一个订单**至多一次实际退款执行**，因此 `refundedAmount` 就是**那一次退的钱**，
  不存在把它「加上第二次」的路径。字段名与加法写法都留着（`applyOrderRefund` 是三条
  退款路径共用的唯一资金写入口），但**「累计」只是历史沿革，不是今天的语义**。
  P0-13 当时写「它是真正的累计值」是对的——那时同一个订单会被退第二次、第三次；
  **那一版规则已被覆盖**。
- 管理员批准退款时**必须**显式传本次退款额，由 `applyOrderRefund` 写入。
  **P0-5.5 已落地**：金额取自**被修改的那张订单**的冻结快照（`order.actualPaidAmount` × 比例），
  不取退款申请上的 `amount` 快照。曾经的缺陷说明见 §9。
- **⚠️ 部分退款本身不得自动把 `Order.status` 改成 `refunded`。**
  `Order.status === "refunded"` 的正式含义是：**该订单已经全额退款。**
  **只有退满才转**（一单一退下「退满」= 这一次的比例是 100%），
  判据单点在 `lib/constants/refunds.ts` 的 `isFullyRefunded`。
- **⚠️ 「出过款」是一个独立于状态与比例的判据**：部分退款**不改 `Order.status`**，
  因此「这一单退过款了吗」不能用 `status === "refunded"` 或 `refundedAmount >= actualPaidAmount`
  回答。唯一定义是 `hasRefundBeenExecuted(order)`（`refundedAmount > 0`）。
  三条出款路径（直接退款 / 售后台审 / 公共池超时）都必须在**计划阶段**用它，
  不能在写入层静默拒掉——那会让调用方拿到一份报了假账的返回清单。
- **⚠️ 计划层要问的是更宽的那一句**：「退款**还能不能再发生**」=
  `isRefundExecutionClosed(order)`（并集，状态判据 ∪ 出过款判据）。
  窄判据答不了 `status === "refunded"` 而 `refundedAmount === 0` 的情形，
  只问窄问题会让计划层放行、存储层拒绝，正是上一条要避免的假账。

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
| 关键字段 | `id`、`orderId`、`state`、`exclusiveCompanionId`、`exclusiveEnteredAt`、`exclusiveDeadlineAt`、`exclusiveTimeoutMinutesSnapshot`、`publicPoolEnteredAt`、`publicTimeoutMinutesSnapshot`、`publicDeadlineAt`、`acceptedByCompanionId`、`acceptedVia` |

> ⚠️ **`acceptedVia` 由 P1-5 §九-F 产品裁定新增**（`"companion"` \| `"staff"` \| `null`）：
> **这一次绑定是谁发起的**。它存在的唯一理由是**把「订单进入 `accepted`」与「产生一次接单事件」
> 分开**——两条路径共用同一个状态迁移函数 `applyDispatchAccepted()`，但从计数的角度看
> **只有打手自己接单算数**（客服直换 / 直接指定**不算**）。因此：
>
> - `applyDispatchAccepted(id, companionId, at, via)` 的 `via` 是**必填第 4 参**——
>   新加的绑定入口**不填就编译不过**（写成可选 + 默认值等于把这条保证交给记性）；
> - 它与 `acceptedByCompanionId` **同生共死**：`applyDispatchToPublic()` 把绑定清空时
>   **必须一并清成 `null`**，否则会出现「没人接、却记着上次是谁发起的」；
> - **`null` 是一种有意义的取值，不是「还没填」**：`deriveLegacyAcceptEvents()` 对
>   `"staff"` 与 `null` **一律不派生**（**fail-closed**，两档方向一致）。
>   产品裁定原文：「如果历史数据无法区分：不得凭空补接单事件。宁可继续保持
>   『存量接单榜是历史下界』。**不要为了让历史数字好看而伪造主动接单行为。**」
>
> 📌 **迁移约束**：将来建真库时这一列必须是 **NOT NULL + 枚举**（取值 `"companion"` / `"staff"`），
> 存量行回填**不得**用「有 `acceptedByCompanionId` 就填 `"companion"`」这种推断——
> 那正是裁定禁止的「凭空补」。存量行应回填**一个明确的『未知』值**（对应今天的 `null`）。

> ⚠️ **上表此前漏列了 public 侧三个字段**（`publicPoolEnteredAt` / `publicTimeoutMinutesSnapshot` /
> `publicDeadlineAt`）与 `acceptedByCompanionId`（P0-6.1 补全）。它们一直是真实字段，
> 只是没写进这一行；而 P0-6.1 的池子排序真值正是 `publicPoolEnteredAt`，
> 一份「查不到这个字段」的数据模型文档会让人以为排序键不存在。
>
> ⚠️ **`exclusiveTimeoutMinutesSnapshot` 由 P1-2 新增**：专属池时长原本是源码常量
> （`EXCLUSIVE_WAIT_MINUTES = 10`，**已在 P1-2 删除**），因此不需要快照——
> 常量不可能在半路被改。改成可配置之后，「这一单当初按几分钟算」就必须记在记录上，
> 否则无法回答「管理员改了配置，为什么这张单的截止时间没变」。

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
| 类型 | `lib/types/refund.ts` — `RefundRequest`、`RefundDecision`、`RefundStatus`、`RefundReasonKey`。⚠️ `RefundResponsibility` **已于 P0-15 删除** |
| 仓储 | `lib/data/refundRepository.ts` → `mockRefundRepository` |
| Mock Store | `"refund"` → `{ refunds: Map; refundIdByKey: Map<"${userId}:${key}", id>; refundIdsByOrder: Map<orderId, id[]> }` |
| 主键 | `id`；另有 `refundNo` |
| 状态 | `"pending"` \| `"reviewing"` \| `"approved"` \| `"rejected"` \| `"cancelled"` |
| 关键字段 | `id`、`refundNo`、`userId`、`orderId`、`status`、**`amount`（申请时的实付快照）**、**`decision`（本次退款的资金决策，未决策为 `null`）**、`reasonKey`、`reasonLabel`、`description`、`evidence[]`、`createdAt`、`updatedAt`、`reviewingAt`、`reviewedAt`、`reviewedBy`、`reviewedByRole`、`reviewedByName` |

### 9.1 `RefundDecision` —— 一次退款的资金决策（P0-13；**P0-15 收敛为三项**）

`RefundRequest.decision` 是**值对象**（不单独建表），现在只有**三**个金额字段 +
决策人与时刻：

| 字段 | 类型 | 说明 |
|---|---|---|
| `refundRateBp` | `number` | 本次退款比例（基点 `1..10000`）。**管理员输入的就是比例，不是金额**。⚠️ **不再是 `number \| null`**：P0-14 那个「退满剩余时为 `null`」的形态随该机制一并删除（见下） |
| `refundAmount` | `number` | 分。**唯一的公式**：`floor(Order.actualPaidAmount × refundRateBp / 10000)`；`refundRateBp === 10000` 时恒等于 `actualPaidAmount` |
| `companionReversalAmount` | `number` | 分。从打手收益冲回的金额。⚠️ **恒等于 `Order.companionBaseIncome`（整笔）**，与退款比例无关——见 §T2.1 |
| `decidedBy` / `decidedAt` | `string` | 决策管理员 id 与时刻 |

**⚠️ P0-15 删除了四个字段**（`refundFullRemaining` / `responsibility` /
`companionLiabilityRateBp` / `platformBorneAmount`），**四个都是真正的删除**，不是弃用：

| 已删除 | 原先用途 | 为什么删 |
|---|---|---|
| `refundFullRemaining` | 「退满剩余」意图（P0-14） | 它存在的**唯一**理由是「按比例只有 101 个离散取值，实付 2990 时有 2890 个金额永远表达不出来，先部分退过款的单子可能永远差 1~99 分退不满」。**一单一退之后这个前提消失了**——一个订单最多退一次，退完就结束，不存在「退不满」。完整论证保留在 `docs/03-dev/rounds/P0-14/02-decisions.md` §十四（那是历史，不是当前规则） |
| `responsibility` | 资金责任归属（P0-13） | 责任模型**整体废止**：退款批准即打手收益整笔归零，不再有「谁承担」这一步——见 §T2.1 与 `EX-REFUND-03` |
| `companionLiabilityRateBp` | `shared` 时的打手责任比例 | 随责任归属一起删除 |
| `platformBorneAmount` | `refundAmount − companionReversalAmount` | ⚠️ **它最危险**：P0-15 之后 `companionReversalAmount` 恒等于整笔冲回，因此它**恒等于 `refundAmount`**。留着一个恒等的第三个数，就是给对账造出**第二份真值**——两份账迟早对不上，而对账的人会以为其中一份是错的。平台最终收入改为**算出来**：`actualPaidAmount − refundAmount` |

⚠️ **不做「保留但弃用」的兼容层**：本仓库无真库、无历史持久化数据，
唯一的历史载体是种子 fixture（`lib/mocks/fixtures/refundSeed.ts`），迁移成本为零。
半吊子的兼容层只会让新写入路径继续看得到那些字段，而「新写入路径不得依赖责任字段」
正是产品裁定的一条。

**⚠️ `amount` 与 `decidedAmount` 是两个数。** `amount` 是**申请创建时**订单实付的快照，
回答「这一单本来涉及多少钱」；实退金额是 `decision.refundAmount`。部分退款下两者**不相等**，
因此必须分开存、分开给，不能拿一个去顶另一个。
对外（列表 / 详情）由 `decidedAmount` 暴露实退额；**三项决策字段只给管理端**（客服 / 用户只拿 `decidedAmount`）。

### 9.2 索引

**`refundIdsByOrder`：`orderId → 申请 id 列表`，P0-13 起由单值改为多值。**

⚠️ **P0-15 起它重新表达「一单一申请」，而且这次是硬约束。**

| 世代 | 索引形态 | 「能不能再申请」的判据 |
|---|---|---|
| P0-12 之前 | 单值 `orderId → id` | 一条申请，天然一单一申请 |
| P0-13（部分退款） | 多值 `orderId → id[]` | `isActiveRefundStatus`——**已通过 / 已拒绝 / 已撤销的记录不再挡**新的申请 |
| **P0-15（当前）** | **多值仍然保留形态**，但长度恒为 0 或 1 | **列表非空即封死**：`listRefundsForOrderSync(orderId)[0]` 存在就返回 `order_already_has_refund`，**不看状态** |

- 索引回答的是「这一单有哪些申请」，**按创建先后排列**；
- ⚠️ **列表形态是刻意保留的**：将来若真需要「一单多次退款」，改的只是判据这一处，
  而不是索引结构 + 仓储 + 服务层 + DTO 一起动。当前「长度恒为 0 或 1」由写入路径保证，
  **不是由类型保证**——因此写入侧的守卫必须留着，不能因为「反正是单值」就删掉判断。
- ⚠️ **判据不再看状态**，这是 P0-15 与 P0-13 的分水岭：「已驳回」也不再放行第二次申请。
  已通过 / 已拒绝 / 已撤销的记录**同样挡**新的申请。
- 未来数据库上它是一条**唯一索引**（`orderId` 唯一），而不是部分唯一索引——
  约束是「一个订单至多一条退款记录」，与状态无关。

**状态机**：`ADMIN_REFUND_TRANSITIONS`（`lib/constants/adminRefunds.ts`）：

```
pending    → [reviewing, approved, rejected]
reviewing  → [approved, rejected]
approved   → []
rejected   → []
cancelled  → []
```

**⚠️ 退款有独立状态机，与 `OrderStatus` 无关。**
**唯一例外**：审核通过会写入退款金额，**只有比例 100%（`refundAmount === actualPaidAmount`）才**把订单置为 `refunded`。
**部分退款不改订单状态**——订单按原进度继续履约。

⚠️ 但**打手看到的不是订单状态**（P0-15）：部分退款下打手端另有派生的
`displayStatus = "refunded"` / `displayStatusLabel = "已退款"`（`lib/constants/orders.ts`
的 `resolveCompanionDisplayStatus`）。两条线**必须分开**：「这一单履约到哪一步」是事实，
「站在这位打手的位置上该怎么称呼它」是口径。
⚠️ **展示状态不参与任何权限或可写性判断**——聊天的可写性看的是真实订单状态
（`isOrderChatClosed`），因此部分退款**不会**锁掉订单沟通。

**⚠️ 曾经确认的缺陷（产品负责人裁定：修 Bug，不隐藏字段）——已于 P0-5.5 修复，P0-13 后仍然有效**：
`adminRefundTransaction.ts` 调用 `applyOrderRefund` 时**省略了第三个参数**，导致订单被置为 `refunded` 但 **`refundedAmount` 为 0**。
- **正式规则**：管理员批准退款时**必须**显式传本次退款额，由 `applyOrderRefund` **累计**写入 `refundedAmount`
  （P0-13 起该参数的语义由「覆盖成多少」改为「**这一次退多少**」）。
- **修复结果**：`adminRefundTransaction.ts` 现显式传 `decision.refundAmount`（服务端按订单快照算出来的数，
  非申请上的 `amount` 快照）；`applyOrderRefund` 对**已退款**（`status === "refunded"` **或**
  `refundedAmount >= actualPaidAmount`）的订单短路返回 `changed: false`，因此重复批准不重复退款、不刷新 `refundedAt`。
  ⚠️ 只看状态是不够的：部分退款**不改状态**，一张已退满的订单若停在原状态上，状态判据会放它再退一次。
- **金额闸**：`refundedAmount + 本次 <= actualPaidAmount`，越界是 400。
  ⚠️ P0-15 之后「累计」这个词已经名不副实（一单一退，最多加一次），
  但这道闸**必须原样留着**：它挡的是「同一次退款被算了两遍」这类写入侧错误，
  而那条防线不因为业务上只退一次就变得多余。
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

**✅ `Coupon`（模板）这一侧现在有写入了（`P1-6`，2026-09-30）。**
管理端的**创建 / 编辑 / 启用 / 停用**入口齐备：页面在 `app/admin/(console)/coupons/`
（列表 / `new` / `[id]`），接口见 `api-contract.md` §12.9，写入路径是
`lib/data/couponTemplateTransaction.ts` 的三个伪事务。

> ⚠️ **本节此前写着「`Coupon`（模板）这一侧只有读……没有任何写入入口」，
> 那句话在 `P1-6` 交付后与源码相反**，故就地改写（历史 Round 文档只加批注、不重写；
> 本文是技术设计文档，描述的是**当前**源码，因此直接更正）。
> `P1-6` 的状态是 **`AWAITING_ACCEPTANCE`**，尚未 `DONE`。

**⚠️ `Coupon` 实体新增两个时间戳**（`P1-6`）：`createdAt` / `updatedAt`。
列表要按建档时间排、详情页要显示「最近更新」，没有它们排不了也显示不了。
**两者都不进任何用户端 DTO**——券面快照、结算可选券项、订单里的券快照三者的
精确键集合断言继续把它们排除在外（`tests/couponCheckoutChain.test.mjs`）。
`updatedAt` 是一个会被当作证据的字段：空保存与重放**都不刷新它**。

**⚠️ 模板只管理满减券**（`formKey === "threshold"`）。`discount` / `gift` 两类
历史模板**可以展示、可以启停，但不能编辑**，也不进结算页的可选列表——
它们的 `thresholdAmount` / `discountAmount` 在 DTO 里是 **`null` 而不是 `0`**
（「满 0 减 0」会伪造出一张处处可用的券的外观）。

**⚠️ 没有硬删除**：模板的生命周期终点是 `enabled = false`，`Coupon` 表上**不存在**
`DELETE`，也不存在 `Coupon.remove` 这一类审计动作。

⚠️ **不要把它与 `CouponClaim` 那一侧混为一谈**：`CouponClaim` **有**真实的写入路径
（用户自助领取 `claimCouponForUser` ＋ 管理员发放 `POST /api/admin/coupons/grant`；
发放页现在的地址是 `/admin/coupons/grant`——`/admin/coupons` 这个**页面**在 `P1-6`
变成了模板列表，见 `api-contract.md` §12.9），并且
**`Coupon.enabled` 只决定「当前」能否核销，不追溯已发出的 `CouponClaim.snapshot`**
（`P1-4` 已实现，由 `resolveCouponClaimGate()` 单一判定 + 测试钉住）。
「模板能不能改」与「券能不能核销」是**两件事**，改动前先分清是哪一侧。

**⚠️ 将来做真 DB 时必须守住的一条**：`Coupon` 与 `CouponClaim` 是**两张表**，
`CouponClaim.snapshot` 是**值拷贝**，不是外键到 `Coupon` 的引用。
因此模板的 `UPDATE` **不得**带上会打到 `CouponClaim` 的级联
（不写 `ON UPDATE CASCADE`、不建「改模板顺带更新所有 Claim」的触发器）——
§4 的「不追溯」在数据层就是这条约束，级联会静默推翻它。

---

## 13. OrderReview（评价）

| 项 | 值 |
|---|---|
| 类型 | `lib/types/review.ts` — `OrderReview`、`ReviewRating`、`ReviewDimension`、`ReviewStatus` |
| 仓储 | `lib/data/reviewRepository.ts` → `mockReviewRepository` |
| Mock Store | `"review"` → `{ reviews: Map; reviewIdByOrder: Map<"${userId}:${orderId}", id>; reviewIdByKey: Map<"${userId}:${key}", id> }` |
| 主键 | `id` |
| 关键字段 | `id`、`userId`、`orderId`、`orderNo`、**`productId`**、`specId`、**`productReview`**、**`companionReview`**、`evidence[]`、**`status`**、**`rejectReason`**、**`hideReason`**、**`reviewedBy`**、**`reviewedByName`**、**`reviewedAt`**、`createdAt`、`updatedAt`、`productTitle`、`productCoverUrl`、`specName`、`quantity`、`completedAt`、`companion` |

**唯一索引**：`reviewIdByOrder` —— **一单一评**（`R1`）。
**幂等索引**：`reviewIdByKey` —— 同一个 `idempotencyKey` 只建一条（键的作用域是 `userId`）。

### 13.1 双维度（`D1`–`D3`、P1-8）

一份评价最多包含**两个维度**，各自是一个 `ReviewDimension | null`：

```
productReview:   { rating: 1–5; content: string | null } | null
companionReview: { rating: 1–5; content: string | null } | null
```

- 两条**互不派生**（`D2`）：不存在「一边为空时从另一边复制」的写法——
  那会让「商品 4 星、打手未评」被悄悄变成「商品 4 星、打手 4 星」。
- 至少一个非 `null`（`D3`）；**星级必填、正文可选**；未评的那个维度**恒为 `null`**，
  不是 `{rating: 0}` 或空对象——「没评」与「评了 0 分」是两件事。
- 提交后**不能再补**另一个维度：本条评价的唯一写入口 `createReviewForOrder` 只在
  首次提交时接受两个维度；唯一的后续写入口 `resubmitReviewForUser` 也要求
  「至少一个有效维度」，且**不提供**「加上缺失的那一维」的语义。
- **打手维度评的是最终实际履约打手**（`D4`）：快照写进 `companion`（`OrderCompanionSnapshot`），
  聚合身份取 `companion.id`。⚠️ **不是** `exclusiveCompanionId`，也不是「所有曾 `serving` 的人」。
  A→B 换人后**只评 B**（`D5`），不存在多人评价。

### 13.2 `productId`：聚合身份（`R4`）

`productId` 是**本轮新增**的字段（`C5` 的整改）。它与三个快照字段的分工是硬性的：

| 字段 | 是什么 | 用途 |
|---|---|---|
| `productId` | **聚合身份** —— 这条评价计入哪件商品 | 平均分 / 评价数的分组键 |
| `productTitle` / `productCoverUrl` / `specName` | **下单那一刻的快照** | 历史展示：商品改名、下架、换封面之后，这条评价仍然显示当时的名字 |
| `companion`（含 `id` / `name` / `avatarUrl`） | 打手侧的同两份 | 打手侧聚合身份取 `.id`，名字是快照 |

⚠️ **两者不可互相替代**：用快照反推身份，商品改名就会整批评价漂到别的对象上；
用身份替代展示，历史评价会显示今天的名字，与用户当时看到的不符。

### 13.3 审核状态（`D7`–`D12`）

```
pending    → [approved, rejected]     新提交一律 pending
approved   → [hidden]
rejected   → [pending]                作者重新提交（同一条记录，D9）
hidden     → [approved]               恢复公开（D11）
```

- **四个状态 `pending | approved | rejected | hidden`**，定义在 `lib/constants/reviews.ts`
  的 `REVIEW_STATUS_TRANSITIONS` / `canTransitionReviewStatus`。
  ⚠️ **不得复用 `Order.status`**：订单的 `completed` / `refunded` 说的是钱与服务，
  评价的 `approved` / `hidden` 说的是话能不能被看见，两者没有映射关系（`D20`）。
- **审核是发布闸门，不是数据删除**（`R2`）：四个动作只写 `status` 与原因字段，
  内容、`evidence`、`createdAt`、`updatedAt` 一个都不动（`D12`，有断言逐字段比对）。
- **`reject` / `hide` 必须写原因**（非空、`REVIEW_REASON_MAX_LENGTH = 200`）；
  `approve` / `unhide` **不读**原因。四个动作**全部**写一条 `AdminAudit`（`D22`），
  `action` 分别是 `review.approve` / `review.reject` / `review.hide` / `review.unhide`。
- **`updatedAt` 不随审核变化**：它记的是**作者最后一次改内容**的时刻，
  不是「最后一次被管理员点过的时刻」——后者看 `reviewedAt`。

### 13.4 聚合口径（`D14`、`D15`、`R3`）

| 规则 | 取值 |
|---|---|
| 计入哪些 | **只有 `approved`**。`pending` 不计、`rejected` 不计、`hidden` **立刻扣掉**、`hidden → approved` **立刻加回** |
| 分组键 | 商品侧按 `productId`；打手侧按 `companion.id`（`R4`） |
| 平均分 | 1 位小数；无 `approved` 评价时为 **`null`**，展示为「暂无评分」（**不是 `0.0`**） |
| `reviewCount` | 数的是**维度**，不是评价条数：一条同时评了两项的评价对商品侧 +1、对打手侧 +1；只评商品的评价对打手侧 **+0** |
| 最近评价 | 最多 **3** 条，按 `createdAt` 倒序；超出时 `reviewsTruncated = true`，展示「仅显示最近 3 条评价」 |

**⚠️ 商品侧与打手侧必须同源**（`R3`）：唯一入口是
`lib/services/reviewAggregates.ts` 的 `loadReviewAggregate` / `loadReviewStatsFor`，
纯函数部分在 `lib/constants/reviews.ts` 的 `buildReviewAggregate()`。
两个页面各自实现一遍「查评价 → 滤状态 → 算平均 → 脱敏」**是不允许的**——
两套实现都能看起来正常，差别只在有没有人点进那一条被隐藏的评价。

### 13.5 静态评分数据已退出业务真值（`D17`）

`Companion` / `Product` **实体上不再有** `rating` / `reviewCount` / `reviews` 字段
（历史文档表格里那三项已删除；`rating` 与 `reviewCount` 只作为**公开 DTO 的派生字段**
存在，由聚合在读取时算出）。种子里的假分数（`rating = 4.8` / `reviewCount = 3`）一并移除，
改为在 `lib/mocks/fixtures/reviewSeed.ts` 里种 **11 条真实的 `OrderReview`**
（9 `approved` / 1 `pending` / 1 `hidden`，各自用 `build()` 保证不变量）。

⚠️ **`Companion.reviews[]` 与 `OrderReview` 的 TBD 已消解**：不再是两套并列的展示数据——
展示面的一切都来自 `OrderReview`，且 `Companion.reviews[]` 这个**实体字段已删除**。
（历史上那句「内嵌在护航记录里的展示用评价」描述的是旧模型。）

### 13.6 迁移约束（`R5`）

⚠️ **存量旧评价数据不得"猜"着迁移。** 只有当 `productId`、最终实际打手、
以及星级·正文能够**从 `orderId` 唯一确定**时才迁移。**禁止**把旧模型里那份
合一的 `rating` / `content` 在无裁定的情况下同时复制进 `productReview` 与 `companionReview`
——那会凭空造出「用户给打手也打了分」的事实。

⚠️ 本仓库当前的存量数据**全部是 Mock 预置**，因此按 `R5` 的末句处理：
**重建为符合新模型的真实 fixture**（即 `reviewSeed.ts`），
不为兼容一份演示数据而在长期数据模型里留兼容字段。

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

**⚠️ 消费累计口径已于 P1-7 冻结并落地 —— 上面两段 TBD 均已作废。**

- **`F1`**：金额改为**净留存** `Σ max(0, actualPaidAmount − refundedAmount)`。
  实现只有一处：`lib/constants/levels.ts` 的 `effectiveSpendOf()`，
  `sumEffectiveSpend()`（累计）与 `sumSpendWithinRange()`（最近 30 天）都消费它。
  **P0-9 记下的那个 TARGET 至此实现。**
- **P0-13 的空白已裁定**（`P1-7` 产品裁定）：部分退款**立即降低**累计消费。
  「实付 100 元、已部分退 60 元」的订单算 **40 元**。
  订单状态仍是 `completed`，因此它**仍在**「常玩游戏」里计一次（退款不删除行为历史）。
- **状态过滤仍保留** `CONSUMPTION_ORDER_STATUS = "completed"`：已**全额**退款的订单整单不计。
  这与净额公式**等价而不矛盾**——全额退款意味着 `refundedAmount ≥ actualPaidAmount`，
  其净留存本来就必然为 0。

⚠️ **同时确立的总规则 `R1`**：「钱」与「行为历史」分开。
消费金额类（累计消费 / 最近 30 天 / 消费等级 / 消费排行榜）随退款**实时**变化；
行为历史类（累计订单数 / 常玩游戏频次 / 常用打手服务频次）**不因退款而抹掉**。

裁定原文见 `docs/03-dev/rounds/P1-7/02-decisions.md` §五（`D1`–`D12`）与 §六（`R1`/`R2`）。

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
| 关键字段 | `exclusivePoolTimeoutMinutes`（P1-2）、`publicPoolTimeoutMinutes`（P0-1）、`completionAutoApprovalMinutes`（P0-8）、`complaintWindowMinutes`（P0-9）、`updatedAt`、`updatedByAdminId` |

**⚠️ 单例且恒不为 null**：没有记录时用预置值，而不是让每个调用方处理「还没有配置」——
那会让「参数缺失」变成一条到处都要判的空值路径。

**⚠️ 改配置不动历史订单**：订单进入需要计时的环节时把自己那一刻的参数值冻结成快照。

**CURRENT（P1-2 落地）**：**四项**参数都已可配置，且都遵循「进入对应生命周期阶段时冻结快照」的规则——
`exclusivePoolTimeoutMinutes`（P1-2，派单进入 `exclusive` 时冻结到 `Dispatch.exclusiveTimeoutMinutesSnapshot`
并算出 `exclusiveDeadlineAt`）、`publicPoolTimeoutMinutes`（订单进池时冻结到
`Dispatch.publicTimeoutMinutesSnapshot`）、`completionAutoApprovalMinutes`（提交完成材料时冻结到
`CompletionSubmission.autoApprovalMinutesSnapshot`）、`complaintWindowMinutes`（订单进入 completed 时冻结到
`Order.complaintWindowMinutesSnapshot` 并算出 `complaintDeadlineAt`）。四项的取值区间**不共用**：
专属池 / 公共池 / 完成材料 1~1440，投诉窗口 60~10080（P0-9 `02-decisions.md` D17）。
专属池与公共池**今天恰好同区间**，但仍是两个字段各自的校验函数与错误文案，不合并。

**⚠️ 单例记录上没有 `id` 字段**：它是**唯一**的一份配置，加一个 id 会让「配置可以有多条」这句话
在类型上成立。审计要按对象查历史，用的是常量 `PLATFORM_CONFIG_ID`（`lib/constants/platformConfig.ts`）。

**TARGET — NOT IMPLEMENTED（V0.3）**：同一个 PlatformConfig 继续作为唯一平台配置真值源，
后续仍可扩展。新参数一律遵循上面同一条冻结规则；**不得新建第二套配置实体**。

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

`withdrawn` / `reversed` 两个取值的写入路径——**今天两个都是零**：

- **`reversed` —— P0-15 起不可达**（P0-13 起曾可达）。产品裁定：退款批准后
  「处理对象应当仍是 `Earning.status = frozen`」，因此整笔冲销**不改状态**，
  收益**停在 `frozen`**。见 `lib/data/mockEarningRepository.ts` 的 `applyEarningReversal`
  与 `rounds/P0-15/02-decisions.md` §二 Q5。
  ⚠️ 保留这个取值而不是删掉，与 `withdrawn` 同一条理由：它是这张表在完整设计里的取值，
  删除等于宣称这张表没有这个状态。
- `withdrawn` 仍然**只有类型占位、没有写入路径**（提现是 TBD，见 api-contract 第四部分）。
  ⚠️ **P0-15 起它也不再参与任何业务判定**：P0-13 那条「已 `withdrawn` 的收益本轮不做冲回」（D17）
  **已删除**，同时删掉的还有退款决策里为它准备的那个分支。理由见 §T2.1「已提现」一行——
  这个状态在当前业务路径上**不可达**，而**为不可达的状态写分支，本身就是一种设计**，
  产品裁定明确不做 withdrawn 追偿。
  ⚠️ 类型上**仍然留着这个取值**（`database-schema.md` T2 的字段设计），
  但**「留在类型上」与「代码里为它写分支」是两件事**：前者是「这张表将来会有这个状态」，
  后者是「现在就按它会发生来处理」。

**已确认业务语义（P0-9 全部落地）：**

- 订单进入 completed（人工审核或系统自动审核）后，为当时实际履约打手生成一条 frozen Earning；`incomeAmount = Order.companionBaseIncome` 快照。
- Order completed 时冻结 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt`；Earning.availableAt 复用该 deadline。
- deadline 到达且无投诉/有效售后冻结原因后 `frozen → available`（阻塞判据与 P0-8 自动通过**共用** `isCompletionAutoApprovalBlocked` + `readOrderBlockingFacts`）。
  > ⚠️ **P0-15 补齐：这里不止「到期 + 无阻塞」两条。** 完整判据是**三条同时成立**——
  > ① `availableAt` 已到 ② 无阻塞 ③ **净额未被冲光**（`!isEarningFullyReversed`）。
  > 第 ③ 条是 P0-15 加的：退款批准后收益**停在 `frozen`**（见本文件 T2.1 与 Q5 裁定），
  > 于是「被退款冲光」与「正常冻结中」**共用同一个状态**，只靠前两条会把一笔
  > 净额为 0 的收益放行成「可提现」。唯一真值源：`lib/data/earningTransaction.ts`
  > 的 `sweepMaturedEarnings`。**顺带**：`frozen` 的逐条说明不再由状态单独决定，
  > 走 `earningHintFor({ status, netAmount })`。
- 平台之后修改投诉期不改变已 completed 订单的 deadline。
- 提现、自动罚款、管理员余额调整/会费批扣的账本细节仍不在本实体本轮强行定义。
- `sweepMaturedEarnings()` 同步、幂等、可重复调用；后台 Scheduler 必须复用它。
- **不追溯**：P0-9 之前已完成的历史订单不回填 Earning（那会用历史 `completedAt` 造出一笔「已经该解冻」的钱）。
- **无实际履约打手时不建记录**：没有 `actualCompanionId` 就没有收益可发，如实不建，而不是建一条 `companionId: ""` / 金额 0 的假记录。

### T2.1 退款冲回（P0-13 落地；**P0-15 收敛为「整笔一次」**）

**不得修改原始 `Earning.incomeAmount`，不建立余额桶。**
退款通过**独立的冲回记录**表达；净额由服务端算好给出（`lib/types/earning.ts` 的 `CompanionEarningItem`）：

```
netAmount = incomeAmount − reversedAmount     // 即产品裁定里的 netAvailableAmount
```

| 规则 | 内容 |
|---|---|
| 冲回额 | **恒等于 `incomeAmount`（整笔）**，与退款比例无关。`refundRateBp` 是 1000（10%）还是 10000（100%），冲回的都是全额 |
| 累计字段 | `Earning.reversedAmount` 仍是**累加**语义（`applyEarningReversal` 加法写入），但 P0-15 之后**已经没有能让它停在中途的路径**——「半冲」只可能来自写坏的数据 |
| 不变式 | `0 <= reversedAmount <= incomeAmount`。⚠️ 原先还需要服务端的「剩余可冲回额」钳制配合（P0-13 `02-decisions.md` §十一 D4），**现在不需要了**：冲回额就是 `incomeAmount` 本身，构造上不可能越界。存储层的 `applyEarningReversal` 护栏**保留**，它挡的是写入侧错误 |
| 状态规则 | 退款批准 → **状态不变，仍是 `frozen`**（P0-15 产品裁定，`rounds/P0-15/02-decisions.md` §二 Q5）。净额归零**不**改状态：这笔钱永远不会变成可提现，「冻结中」正是这个事实。⚠️ 早先本轮写的 D8（「整笔冲销 → `reversed`」）**已被该裁定推翻**。⚠️ 与 P0-13 那条「部分冲回留在原状态」（Q2-c）方向相同、理由不同：Q2-c 的理由是「把部分冲回写成 `reversed` 会让打手以为白干了」，那条理由的前提在新规则下反转（他确实白干了） |
| 状态不改，那靠什么挡住释放 | **净额闸**：`sweepMaturedEarnings` 的判据里多一条 `!isEarningFullyReversed(earning)`。没有它，一笔已经归零的收益会在 `availableAt` 到点后被写成 `available`（状态是 `frozen`、时间也到了，前四条判据全都放行）。存储层的 `applyEarningRelease` 用同一个函数再拦一道——指令 ②§六 要求「不得只依赖上层读取到的旧状态」 |
| 已提现 | **不可达，不写分支**。正常业务设计保证收益在退款结算之前根本到不了可提现阶段：只有 `completed` 订单才有 Earning 且创建即 `frozen`，它唯一的出口 `sweepMaturedEarnings` 的判据里含「无有效退款」，而可批准的申请本身就构成阻塞；批准后收益当场归零，**永不经过 `available`**（归零后连净额闸也过不去）。完整的结构性论证写在 `lib/data/adminRefundTransaction.ts` 第 ④ 步。⚠️ 原先 D17 那条「收益已提现 → 冲回 0、平台承担全部」的特例**已随本轮删除**——它是一条**设计**，而产品裁定明确不做 withdrawn 追偿 |
| 没有收益时 | 退款发生在 `serving`（尚未结算、还没有 Earning）时，冲回额**记在退款决策上**，待这一单将来结算时由 `settleOrderCompletion` **补记**（D9）。⚠️ 一次都不会结算的单（例如服务中被整单退掉）因此永远不产生冲回，这是正确的——打手本来也没挣到钱 |
| 明细 | 每一次冲回写**恰好一条** `EarningAdjustment`，以 `refundId` 为幂等键：一次退款决策最多冲一次（**重复扣打手的钱**比悬空状态严重得多）。P0-15 起「恰好一条」有了第二重保证：一个订单至多一次退款 |

### T2.2 `EarningAdjustment`（收益调整明细）—— CURRENT（P0-13 落地）

```ts
export type EarningAdjustmentType = "refund_reversal";

export type EarningAdjustment = {
  id: string;            // adj_<uuid>
  earningId: string;
  orderId: string;
  refundId: string;      // 幂等键：一次退款最多一条冲回明细
  type: EarningAdjustmentType;
  amount: number;        // 分，恒为正。P0-15 起恒等于该收益的 incomeAmount
  createdAt: string;
  adminId: string;       // 做出决策的管理员
};
```

⚠️ **`responsibility: RefundResponsibility` 已于 P0-15 删除**（`lib/types/earning.ts`）。
它原先记的是「这一次冲回是按谁的责认定的」——责任模型整体废止之后，这个字段
既无来源也无读者。（上面代码块里已删掉该行；留这段说明是为了让查旧代码的人
知道它不是漏掉，而是**故意不在**。）

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

> 📌 **2026-09-29 更正（P1-5 期间核对源码时发现，上面这一句今天已不成立；只批注，不改写原文）**：
> **三条 `source` 全部有写入路径**，没有任何一条停留在「类型占位」。
> 实测（`grep -rn 'source: "' lib/data/` 与 `lib/constants/dispatch.ts:347`）：
> - `companion_cancel` → `cancelAcceptedOrder()`（P0-6）；
> - `staff_reassign` → `lib/data/companionOrderTransaction.ts` **两个分支**：
>   `releaseOrderByStaff()`（客服退回公共池，`reassign = null`）与
>   `replaceOrderCompanionByStaff()`（客服**直接换人**，`reassign` 非空）；
> - `companion_disabled` → `releaseOrdersForCompanion()`（封禁时的事务内清扫，P0-11）。
>
> 也就是说：本实体**整体已落地**，不是「部分实现」。上方那句话是 P0-6 时期的快照，
> 在 P0-11 之后没有跟着更新——**这正是本文件下方 T4 正文已经写对、而这一句没写对**的地方。
> 裁定见 `rounds/P0-11/02-decisions.md` D-Q2。⚠️ §十四 的 out of scope 项指的是
> **完整的 Assignment 聚合**，不是这三个取值本身。

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

## T4b. 接单事件 CompanionAcceptEvent（接单历史）—— **已实现（P1-5）**

**CURRENT（P1-5 落地；§九-F 裁定后收窄）**：`lib/types/companionAccept.ts`、
`lib/data/mockCompanionAcceptRepository.ts`（**只增不改**的 `Map`），
同步写原语 `appendCompanionAccept()`，写入者是原子区段：

| 写入者 | 是否写事件 | 为什么 |
|---|---|---|
| `lib/data/companionDispatchTransaction.ts`（打手**自己** `acceptDispatch`） | ✅ 写 | 这是裁定里唯一该计入接单榜的动作 |
| `lib/data/companionOrderTransaction.ts`（**客服直换 / 直接指定**） | ❌ **不写** | 裁定：「即使底层为了订单状态迁移复用了 `applyDispatchAccepted()`，也不得因为复用了同一个状态迁移函数，就把 Staff assignment 当成 Companion accept event」 |

⚠️ **首版曾让客服直换也写一条**（第一轮 review 的 M1），**该处置已被裁定推翻**——
见 `DispatchRecord.acceptedVia` 上方那段与 `rounds/P1-5/03-delivery.md` §6.5。

```ts
export type CompanionAcceptEvent = {
  id: string;            // `acc_<uuid>`，写入器当场生成并确认未被占用
  dispatchId: string;    // ⚠️ 不是唯一键：换人复用同一条派单记录
  orderId: string;
  companionId: string;   // **实际接单**的人；换人后可与 Order.actualCompanionId 不同
  acceptedAt: string;
};
```

**它为什么必须是一张独立的只增表**：`DispatchRecord.acceptedByCompanionId` 是一个**当前状态**
字段，只有**一个**；而客服改派复用同一条派单记录并覆盖它，加上 `dispatchIdByOrder`
保证一单只有一行派单记录。因此「这一单上先后有几个人接过」**在现模型里读不出来**。
产品裁定要求接单榜统计**成功的接单事件次数**（`A → B → A ⇒ A=2、B=1`）且
「取消 / 换人 / 退款 / 未完成**不回写**历史」——一条只增不改的历史是这句话唯一的落点。
这与 T4 是**同一个理由的两处应用**：T4 记「谁**走**了」，本表记「谁**来**了」。

**未来 DB 迁移约束**：

| 事项 | 要求 |
|---|---|
| 表 | `companion_accept_event`，**只增不改**：没有 UPDATE / DELETE 路径，没有软删除字段 |
| 索引 | `(companion_id, accepted_at)` 普通索引——榜单按打手聚合、按周期切时间 |
| ⚠️ 唯一约束 | **不得**在 `dispatch_id` 上建唯一索引：一张单先后有多位接单人是**正常业务** |
| 写入事务 | 必须与「派单变 `accepted` + 订单变 `accepted` + 发通知」**同一个事务**——分开写会出现「接单成功了但没有历史」，而那种不一致**事后无法从任何字段补回来** |
| ⚠️ 迁移期数据 | 迁移当刻已存在的 `state = accepted` 派单记录只有**最后一次**可考据，因此**存量期的接单榜数字是下界**（只少不多）。这是**数据可获得性**限制，不是口径妥协——P1-5 的读取侧用 `DerivedAcceptEvent` 把这一次读出来（按 `dispatchId` 整体去重，**不写回表**） |
| ⚠️ §九-F 裁定后的**收窄** | 派生**只认** `DispatchRecord.acceptedVia === "companion"`：`"staff"`（客服直换）与 `null`（**认不出来源**）**一律不派生**（fail-closed）。裁定原文：「`deriveLegacyAcceptEvents()` 不得把能够识别为 Staff direct replacement / Staff direct assignment 的历史绑定记录推导成 `CompanionAcceptEvent`。如果历史数据无法区分：**不得凭空补接单事件**。宁可继续保持『存量接单榜是历史下界』。**不要为了让历史数字好看而伪造主动接单行为。**」<br>📌 因此存量榜**只会更低、不会更高**，这是**有意选的保守方向**；真实事件表（`companion_accept_event`）不受影响——**裁定不影响新数据，只影响「读旧数据时猜不猜」** |

## T4c. 服务事件 CompanionServiceEvent（真实服务历史）—— **已实现（P1-7）**

**CURRENT（P1-7 落地）**：`lib/types/companionService.ts`、
`lib/data/mockCompanionServiceRepository.ts`（**只增不改**的 `Map` + 去重索引），
同步写原语 `appendCompanionService()`，写入者是原子区段。

```ts
export type CompanionServiceEvent = {
  id: string;               // `svc_<uuid>`，写入器当场生成并确认未被占用
  orderId: string;
  companionId: string;
  dispatchId: string | null;
  servingAt: string;        // 这一位打手**真实开始服务**的时刻
  companionName: string;    // 当时的历史公开快照（不随后续改名而变）
  companionAvatarUrl: string;
};
```

**它为什么必须是一张独立的只增表**：`Order.servingAt` 只保留**当前/最终**那位打手，
打手被换走（客服直换 / 封禁释放）时它被**清成 `null`**（`mockPaymentRepository.ts` 的
`applyOrderAcceptanceReleased`）。而 `DispatchRecord` 一单只有一行、`CompanionReleaseRecord`
记的是「谁**走**了」、`CompanionAcceptEvent` 记的是「谁接的单」——
**没有一处**能回答「这一单上先后有哪几位打手真实开始过服务、各是什么时候」。
P1-7 `D7` 的产品裁定是「常用打手按**真实进入过 `serving`** 的次数统计，一单换人 A、B 各计 1 次」，
这句话在旧模型里**读不出来**。这与 T4 / T4b 是同一个理由的第三处应用。

**写入者唯一**：`lib/data/companionOrderTransaction.ts` 的 `startCompanionOrder`
（`accepted → serving`），且必须在**无 `await` 的原子区段内**与订单状态推进同一段完成——
分开写会出现「订单已经在护航中、服务历史里却没有这一次服务」。

**去重键**：`(orderId, companionId, servingAt)`。同一打手在**不同时刻**两次开始服务
（A 服务 → 被换走 → 又被换回服务）会留下**两条**，那是两次真实服务，合并会让人数算少。

> ⚠️ **术语（2026-10-02 产品裁定，`rounds/P1-7/02-decisions.md` §8.1）**：这个三元组
> **是**「本轮服务事件的去重语义」，**不是**一张正式的 Assignment identity。
> 本表**不保存** `assignmentKey` / `seq`，**不得**把三元组称作「Assignment identity」。
> 本轮 `D10` 附加要求第 3 条已被**正式收窄**：跨「聊天 assignment / release / service event」
> 的统一身份模型，**只有在项目正式建立 Assignment 聚合时**才一起迁移；
> 本轮**不提前创造**半填充的 `assignmentId`。

**存量数据（`D10`，fail-closed）**：**不 backfill、不猜**。读取侧的
`deriveLegacyServiceEvents()` 只对 `servingAt` 与 `actualCompanionId` **都非空**的订单派生
**一条**（即「仍然写在订单上的那一次」），**不按订单状态过滤**——服务过、后来全额退款的
订单其 `servingAt` / `actualCompanionId` 都还在，照常派生。被换过人的订单，
旧打手的那次服务在存量数据里已经**不可考**，因此合并结果是一个**下界**（只少不多）。

**未来 DB 迁移约束**：

| 事项 | 要求 |
|---|---|
| 表 | `companion_service_event`，**只增不改**：没有 UPDATE / DELETE 路径，没有软删除字段。**取消 / 换人 / 封禁释放 / 退款都不回写、不删除**已经真实发生过的服务 |
| 索引 | `(companion_id, serving_at)` 普通索引——面板按打手聚合、取「最近一次」 |
| ⚠️ 唯一约束 | `(order_id, companion_id, serving_at)` 可建**唯一约束**——它正是「**同一服务段只记一次**」这条规则（即上文三元组去重语义，**不是** Assignment identity），在 DB 层应当由约束保证而不是靠应用层查重 |
| 写入事务 | 必须与「订单 `accepted → serving`（含 `servingAt`）」**同一个事务** |
| ⚠️ 迁移期数据 | 只有**当前/最终**那一位打手的服务可考据，因此存量期的「常用打手」是**下界**（只少不多）。这是**数据可获得性**限制，不是口径妥协 |

---

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
| **`Companion.reviews[]` 与 `OrderReview` 是否统一** | ✅ **已裁定并落地（P1-8）**：统一到 `OrderReview` 一个真值源，`Companion.reviews[]` 这个实体字段**已删除**。口径见 §13.4 / §13.5 |
| **`TipRecord` 的写入路径** | **TBD — DO NOT INVENT**。当前仓储只读 |
| **`Order.companion` 是否保留指定打手** | **TBD — DO NOT INVENT**（计划 R10） |
| **打手侧统一「操作史」** | **TBD — DO NOT INVENT**（计划 R7） |
| **消费等级 B/A/S 的 3/4/5 是否可配** | **TBD — DO NOT INVENT**（计划 R6） |
| ~~**数据库选型 / ORM 选型**~~ | ✅ **已裁定并已开建（PROD-1A）**：`PostgreSQL` + `node-postgres (pg)`，**不使用 ORM**。见文件头与 `tech-stack.md` §11.1 |
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

> **⚠️ PROD-1A 之后本项仍然完全开放，不要误读为「已经解决」。**
> PROD-1A 只做了一件事与它相关：让「跨实体原子写入」在数据库侧有了可用手段
> （`lib/data/pg/executor.ts` 的 `withTransaction(tx => …)`，`tx` 本身就是一个 `PgQueryable`）。
> **调度器本身一行都没有**，三条 sweep 今天**依旧挂在读取路径上惰性触发**。
>
> 落地时的两条硬约束（`tech-stack.md` §11.1 + 下面 C5）：
> 1. 调度器必须调用**同一批**函数，不得另写推进逻辑；
> 2. 只有在这些 sweep 涉及的**全部参与实体都迁入 PostgreSQL**之后，才允许把该业务链切到数据库——
>    在那之前，「一半写 PostgreSQL、一半写 Mock store」是**明令禁止**的。
>
> 该阻塞项同时登记在 `docs/03-dev/总需求进度表.md` 的 `🔴 PRODUCTION_BLOCKER` 行里（那是唯一真值源）。

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

## C8. 时间统一为 ISO 8601 字符串 —— ✅ 已裁定（PROD-1A）

当前所有时间字段都是 `string`（ISO 8601），不是 `Date`。

**裁定：列类型用 `timestamptz`，在驱动层统一转成 ISO 字符串。** 时区策略不再是 TBD。

| 决定 | 内容 |
|---|---|
| 列类型 | `timestamptz`（`timestamp with time zone`）。**不是 `timestamp`，不是 `text`** |
| 内部存储 | UTC。`timestamptz` 不存时区，存的是一个时间点，显示时按会话时区渲染——因此它天然没有「同一时刻两条记录比较不等」的问题 |
| 驱动层转换 | `lib/data/pg/pool.ts` 模块级注册一次：`pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, v => new Date(v).toISOString())`，**1184 全局返回 ISO 字符串** |
| 仓储边界 | **零改动**。写进去是 ISO 字符串，读出来还是同一个 ISO 字符串——`lib/types/**` 里 `createdAt: string` 的声明不需要动 |
| 字符串比较 | **原样成立**。ISO 8601 在 UTC（`Z`）下的**字典序等于时间序**，因此既有的 `a.createdAt > b.createdAt` 排序、以及「时间相同再按 id 兜底」的分页 tie-break 全部继续有效 |
| 代价 | 一次模块级全局覆盖。这是**故意选全局**的：只在某处局部改会让同一列在不同调用点呈现不同类型 |

**⚠️ 刻意不注册 `timestamp`（OID 1114）。** 只注册 `timestamptz`，于是若哪天有迁移误用了无时区的 `timestamp` 列，读出来会是驱动默认的 `Date` 对象、而不是字符串，仓储的 `string` 声明与排序会立刻炸掉——**这是一个特性**：宁可让错误的列类型大声失败，也不要两边悄悄不一致。新增表一律写 `timestamptz`。

**已证**：`tests/pgFoundation.test.mjs` 有一条往返用例，把预置数据里的 ISO 字符串写进 `timestamptz` 再读回来，逐字节相同；`tests/pgContract.test.mjs` 进一步证明 Mock 与 PostgreSQL 在同一份数据上的 `createdAt` 逐字段一致。

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

- ❌ 表名 / 字段名（除已迁移的两个实体外，命名仍按实现期决定）
- ⚠️ 主键类型：**已迁移的两个实体用可读字符串 id**（`text COLLATE "C"`），这是**当前约定而非全局规范**——其余实体用自增还是 UUID 仍未定，等各自迁移时再定
- ❌ index 设计（除 C2 列出的唯一约束外）
- ❌ FK cascade 行为
- ❌ 分表 / 分区
- ❌ 读写分离
- ❌ 缓存层

**选型已不再是阻塞**（PostgreSQL + `pg` + 无 ORM，见 C8 上方与文件头）。上述各项**仍是实现期决策**，在各自实体迁移时按需确定；决定时须遵守 `tech-stack.md` §11.1 的三条结构性约束（`pg` 只在 `lib/data/pg/**`、结构变更走版本化迁移、跨域事务闭包完整才能切数据源）。
